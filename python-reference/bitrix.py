"""
All communication with the Bitrix24 REST API lives here.

HOW BITRIX24 INBOUND WEBHOOKS WORK
    An inbound webhook is a URL like
        https://portal.bitrix24.in/rest/1/abc123/
    where `1` is the user the calls run as and `abc123` is a secret token.
    You call a REST method by appending its name plus `.json`:
        POST https://portal.bitrix24.in/rest/1/abc123/crm.deal.get.json
        body: {"id": 42}

WHY THE HTTP STATUS CODE IS NOT ENOUGH
    Bitrix24 reports many errors as JSON inside the response body, sometimes with
    HTTP 200 and sometimes with 400/401:
        {"error": "NOT_FOUND", "error_description": "Not found"}
    A successful call instead returns {"result": ..., "time": {...}}.
    So we always parse the body and check for an `error` key, whatever the status.

ERROR TYPES (the rest of the app decides what to do with each one)
    BitrixError               base class, so callers can catch "any Bitrix problem"
    ├── BitrixUnavailableError  network down, timeout, 5xx HTML page: we never got an answer
    └── BitrixAPIError          Bitrix answered, but with an error
        └── DealNotFoundError   the specific "this deal doesn't exist" case
"""

import asyncio
import logging
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- errors


class BitrixError(Exception):
    """Base class for every Bitrix24 failure."""


class BitrixUnavailableError(BitrixError):
    """We could not get a usable response: connection refused, timeout, 5xx HTML, etc."""


class BitrixAPIError(BitrixError):
    """Bitrix24 responded, but the JSON body contained an `error` key."""

    def __init__(self, method: str, code: str, description: str):
        self.method = method
        self.code = code
        self.description = description
        super().__init__(f"{method} failed: {code or 'ERROR'}: {description}")


class DealNotFoundError(BitrixAPIError):
    """crm.deal.get said the deal doesn't exist (or we can't see it)."""


# --------------------------------------------------------------------------- data


@dataclass
class ContactInfo:
    """The parts of a Bitrix24 contact that Razorpay's `customer` object needs."""

    name: str | None
    email: str | None
    phone: str | None


@dataclass
class DealInfo:
    """A trimmed-down deal holding only the fields this service uses.

    WHY a dataclass instead of passing the raw dict around: the raw Bitrix dict
    has ~50 keys, all strings, with inconsistent empty values ("", None, "0").
    We clean it up once, here, and the rest of the code gets proper types.
    """

    id: str
    title: str
    amount: Decimal | None  # None means "no usable amount on the deal"
    currency: str
    category_id: str  # pipeline ID; "0" is the default pipeline
    contact: ContactInfo | None


# --------------------------------------------------------------------------- client


class BitrixClient:
    """A thin async wrapper over the Bitrix24 REST API.

    It receives a shared httpx.AsyncClient instead of creating one per call.
    WHY: an AsyncClient keeps a connection pool, so reusing it avoids a new
    TCP+TLS handshake to Bitrix on every request. The FastAPI app creates one
    at startup and closes it at shutdown.
    """

    # Bitrix24 allows roughly 2 requests/second per portal and answers
    # QUERY_LIMIT_EXCEEDED when you go over. That's a "slow down", not a real error.
    RATE_LIMIT_CODE = "QUERY_LIMIT_EXCEEDED"
    RETRY_DELAY_SECONDS = 1.0

    def __init__(self, webhook_url: str, http: httpx.AsyncClient):
        self.webhook_url = webhook_url if webhook_url.endswith("/") else webhook_url + "/"
        self.http = http

    # ------------------------------------------------------------------ core call

    async def _call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Call a Bitrix24 REST method and return its `result` value.

        Retries once, but only for failures where the request provably did not
        take effect:
          * QUERY_LIMIT_EXCEEDED: Bitrix rejected the call outright.
          * ConnectError / ConnectTimeout: the request never reached Bitrix.
        We deliberately do NOT retry a read timeout. For a write such as
        "add comment", Bitrix may have done the work and only the reply was slow,
        so retrying could post the same comment twice.
        """
        url = f"{self.webhook_url}{method}.json"
        attempts = 2

        for attempt in range(1, attempts + 1):
            try:
                response = await self.http.post(url, json=params or {})
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                if attempt < attempts:
                    logger.warning("Bitrix %s: connection failed (%s), retrying", method, exc)
                    await asyncio.sleep(self.RETRY_DELAY_SECONDS)
                    continue
                raise BitrixUnavailableError(f"{method}: cannot connect to Bitrix24: {exc}") from exc
            except httpx.HTTPError as exc:
                # Read timeouts, protocol errors, etc. Not safe to retry (see docstring).
                raise BitrixUnavailableError(f"{method}: request to Bitrix24 failed: {exc}") from exc

            # Parse the body BEFORE looking at the status code; Bitrix puts its
            # error details in the JSON even when the status is 400/401.
            try:
                body = response.json()
            except ValueError:
                # Not JSON at all: usually a proxy/maintenance HTML page or a 502/503.
                raise BitrixUnavailableError(
                    f"{method}: Bitrix24 returned HTTP {response.status_code} "
                    f"with a non-JSON body: {response.text[:200]!r}"
                )

            if not isinstance(body, dict):
                raise BitrixAPIError(method, "UNEXPECTED_RESPONSE", f"Expected a JSON object, got {body!r:.200}")

            if "error" in body:
                code = str(body.get("error") or "")
                description = str(body.get("error_description") or "")
                if code == self.RATE_LIMIT_CODE and attempt < attempts:
                    logger.warning("Bitrix %s: rate limited, retrying in %.1fs", method, self.RETRY_DELAY_SECONDS)
                    await asyncio.sleep(self.RETRY_DELAY_SECONDS)
                    continue
                raise BitrixAPIError(method, code, description)

            if response.status_code >= 400 or "result" not in body:
                # JSON without an `error` key but still unusable. This is rare, but
                # we don't want to hand the caller a silent None.
                raise BitrixAPIError(
                    method, f"HTTP_{response.status_code}", f"Unexpected response: {str(body)[:200]}"
                )

            return body["result"]

        # Unreachable (the loop always returns or raises); kept for type checkers.
        raise BitrixUnavailableError(f"{method}: retries exhausted")

    # ------------------------------------------------------------------ deals

    async def get_deal(self, deal_id: str | int) -> dict[str, Any]:
        """Fetch the raw deal dict via crm.deal.get.

        Converts Bitrix's "not found" errors into DealNotFoundError so callers
        can tell "this deal doesn't exist" apart from "Bitrix is broken".
        """
        try:
            deal = await self._call("crm.deal.get", {"id": deal_id})
        except BitrixAPIError as exc:
            # Depending on portal version, a missing deal comes back as
            # error="NOT_FOUND", or as error="" with description "Not found".
            if exc.code == "NOT_FOUND" or "not found" in exc.description.lower():
                raise DealNotFoundError(exc.method, exc.code or "NOT_FOUND", exc.description) from exc
            raise
        if not deal:
            raise DealNotFoundError("crm.deal.get", "NOT_FOUND", f"Deal {deal_id} returned an empty result")
        return deal

    async def get_contact(self, contact_id: str | int) -> ContactInfo:
        """Fetch a contact and flatten it into the ContactInfo shape.

        WHY flatten: in Bitrix, EMAIL and PHONE are "multi-fields", i.e. lists like
            [{"ID": "7", "VALUE": "a@b.com", "VALUE_TYPE": "WORK"}, ...]
        because a contact can have several. Razorpay wants a single email and a
        single phone, so we take the first non-empty one.
        """
        contact = await self._call("crm.contact.get", {"id": contact_id})

        name = " ".join(part for part in (contact.get("NAME"), contact.get("LAST_NAME")) if part).strip()
        return ContactInfo(
            name=name or None,
            email=_first_multifield_value(contact.get("EMAIL")),
            phone=_first_multifield_value(contact.get("PHONE")),
        )

    async def get_deal_with_contact(self, deal_id: str | int) -> DealInfo:
        """Fetch a deal plus its primary contact, and return a clean DealInfo.

        A failed contact lookup is logged and ignored instead of raised.
        WHY: the contact only pre-fills the customer's details on the Razorpay
        page. A broken contact shouldn't stop us from creating a payment link.
        """
        deal = await self.get_deal(deal_id)

        contact: ContactInfo | None = None
        contact_id = deal.get("CONTACT_ID")
        # Bitrix uses None, "" or "0" for "no contact linked".
        if contact_id and str(contact_id) != "0":
            try:
                contact = await self.get_contact(contact_id)
            except BitrixError as exc:
                logger.warning("Deal %s: could not load contact %s: %s", deal_id, contact_id, exc)

        return DealInfo(
            id=str(deal.get("ID", deal_id)),
            title=deal.get("TITLE") or f"Deal #{deal_id}",
            amount=_parse_amount(deal.get("OPPORTUNITY")),
            currency=(deal.get("CURRENCY_ID") or "INR").upper(),
            category_id=str(deal.get("CATEGORY_ID") or "0"),
            contact=contact,
        )

    async def update_deal(self, deal_id: str | int, fields: dict[str, Any]) -> None:
        """Update deal fields via crm.deal.update (e.g. our two UF_CRM_ custom fields)."""
        await self._call("crm.deal.update", {"id": deal_id, "fields": fields})

    async def move_deal_to_won(self, deal_id: str | int, category_id: str = "0") -> None:
        """Move the deal to its pipeline's "Won" stage.

        WHY the category matters: stage IDs are namespaced by pipeline. The default
        pipeline (category 0) uses plain "WON"; any other pipeline N uses "CN:WON".
        Setting "WON" on a deal in pipeline 3 would fail or put it in the wrong stage.
        """
        stage_id = "WON" if str(category_id) in ("", "0") else f"C{category_id}:WON"
        await self.update_deal(deal_id, {"STAGE_ID": stage_id})

    async def list_deal_fields(self) -> dict[str, Any]:
        """Return the deal field definitions (crm.deal.fields), including custom UF_CRM_ fields."""
        return await self._call("crm.deal.fields")

    # ------------------------------------------------------------------ timeline

    async def add_timeline_comment(self, deal_id: str | int, text: str) -> None:
        """Post a comment on the deal's timeline (the activity feed the sales team sees)."""
        await self._call(
            "crm.timeline.comment.add",
            {"fields": {"ENTITY_ID": deal_id, "ENTITY_TYPE": "deal", "COMMENT": text}},
        )

    async def safe_comment(self, deal_id: str | int, text: str) -> bool:
        """Post a timeline comment and never raise. Returns True if the comment was posted.

        WHY this exists: we use it inside error handlers. If Bitrix itself is the
        thing that's broken, trying to report the error to Bitrix will fail too,
        and that second failure must not crash the handler or hide the first
        error. Logging is the fallback of last resort.
        """
        try:
            await self.add_timeline_comment(deal_id, text)
            return True
        except Exception:
            logger.exception("Could not post timeline comment on deal %s. Comment was: %s", deal_id, text)
            return False


# --------------------------------------------------------------------------- helpers


def _first_multifield_value(values: Any) -> str | None:
    """Return the first non-empty VALUE from a Bitrix multi-field list (EMAIL/PHONE)."""
    if not isinstance(values, list):
        return None
    for item in values:
        value = (item or {}).get("VALUE") if isinstance(item, dict) else None
        if value and str(value).strip():
            return str(value).strip()
    return None


def _parse_amount(raw: Any) -> Decimal | None:
    """Turn Bitrix's OPPORTUNITY (a string like "1500.00", or "" or None) into a Decimal.

    WHY Decimal and not float: floats can't represent most decimal fractions
    exactly (0.1 + 0.2 != 0.3). For money we want exact arithmetic, especially
    before multiplying by 100 to get paise.

    Returns None when there is no parseable amount. Deciding whether zero or a
    negative amount is acceptable is the caller's job, not the parser's.
    """
    if raw is None or str(raw).strip() == "":
        return None
    try:
        amount = Decimal(str(raw).strip())
    except InvalidOperation:
        return None
    return amount if amount.is_finite() else None
