"""
Application settings, loaded from environment variables (and a local `.env` file).

WHY pydantic-settings?
    Secrets like API keys must never live in source code. pydantic-settings reads
    them from the environment, validates their types (e.g. "true" -> True), and
    fails loudly at startup if a required one is missing. Failing at startup is far
    better than failing on the first real payment.

Variable names are case-insensitive: the field `bitrix_webhook_url` is filled
from the env var `BITRIX_WEBHOOK_URL`.
"""

from functools import lru_cache

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Values in real environment variables win over values in .env, so in
        # production you can skip the file entirely and set env vars directly.
        env_file=".env",
        env_file_encoding="utf-8",
        # Ignore unrelated variables in .env instead of raising an error.
        extra="ignore",
    )

    # ---------------------------------------------------------------- Bitrix24
    # The inbound webhook base URL, e.g. https://portal.bitrix24.in/rest/1/abc123/
    # The secret token is embedded in the URL itself, so treat this like a password.
    bitrix_webhook_url: str

    # API names of the two custom deal fields we write to (e.g. UF_CRM_1234567890).
    # Run `uv run list_fields.py` to discover these for your portal.
    bitrix_payment_link_field: str
    bitrix_payment_id_field: str

    # ---------------------------------------------------------------- Razorpay
    # Test keys start with rzp_test_, live keys with rzp_live_.
    razorpay_key_id: str
    # SecretStr hides the value in logs and reprs: printing settings shows '**********'.
    # Call .get_secret_value() at the one place you actually need the raw string.
    razorpay_key_secret: SecretStr
    # Set when you create the webhook in the Razorpay dashboard. Used to prove
    # that an incoming webhook really came from Razorpay.
    razorpay_webhook_secret: SecretStr

    # ---------------------------------------------------------------- Behaviour
    # When a link is fully paid, also move the deal to the "Won" stage.
    move_deal_to_won: bool = False

    # Optional shared secret for POST /payment-links. Without it, anyone who finds
    # your URL could create payment links for your deals. If set, callers must send
    # it as ?token=... (easy to add to a Bitrix24 robot URL).
    inbound_api_token: SecretStr | None = None

    # Allow customers to pay in instalments. Razorpay only sends the
    # payment_link.partially_paid event when this is enabled on the link.
    razorpay_accept_partial: bool = False

    # Link expiry in days. Razorpay only sends payment_link.expired when the
    # link has an expiry time. Leave empty for links that never expire.
    payment_link_expire_days: int | None = None

    # Where we remember which webhook events we've already processed (idempotency).
    processed_events_path: str = "data/processed_events.json"

    @field_validator("bitrix_webhook_url")
    @classmethod
    def ensure_trailing_slash(cls, url: str) -> str:
        # We build method URLs as f"{base}{method}.json". Without the trailing
        # slash we'd get ".../abc123crm.deal.get.json", a confusing 404.
        return url if url.endswith("/") else url + "/"

    @field_validator("inbound_api_token", "payment_link_expire_days", mode="before")
    @classmethod
    def empty_string_is_none(cls, value):
        # `.env.example` lists optional variables as `NAME=` (empty). Treat an
        # empty string as "not set" instead of failing to parse "" as an int.
        return None if value == "" else value


@lru_cache
def get_settings() -> Settings:
    """Return the settings, building them once and then reusing them.

    WHY lru_cache: reading and validating the environment on every request is
    wasteful. This works like a lazily created singleton, and tests can reset it
    with get_settings.cache_clear().
    """
    return Settings()
