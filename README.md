# Bitrix24 ↔ Razorpay Payment Links

A small Node.js service that connects Bitrix24 CRM deals with Razorpay payment links.

- **Flow 1: create a link.** Bitrix24 sends a deal ID. The service reads the deal's amount and contact, creates a Razorpay payment link, saves the link on the deal, and posts a timeline comment.
- **Flow 2: payment updates.** Razorpay calls the service when a link is paid, partly paid, expires, is cancelled, or a payment attempt fails. The service posts a timeline comment on the right deal, and can move the deal to *Won*.

Every problem (no amount, Razorpay rejected the request, Bitrix unreachable…) ends up as a **timeline comment on the deal**, so the sales team sees it inside the CRM rather than only in server logs.

```
Flow 1   Bitrix24 deal ──► POST /payment-links ──► Razorpay: create link
                                   │
                                   └──► Bitrix24: save link on deal + timeline comment

Flow 2   Customer pays ──► Razorpay ──► POST /webhooks/razorpay ──► Bitrix24: timeline comment
```

## Contents

1. [Requirements](#requirements)
2. [Quick start](#quick-start)
3. [Commands](#commands)
4. [Configuration](#configuration)
5. [Setting up Bitrix24](#setting-up-bitrix24)
6. [Setting up Razorpay (test mode)](#setting-up-razorpay-test-mode)
7. [Testing locally with ngrok](#testing-locally-with-ngrok)
8. [Creating links automatically from a deal stage](#creating-links-automatically-from-a-deal-stage)
9. [How it works](#how-it-works)
10. [API reference](#api-reference)
11. [Going live](#going-live)
12. [Running in production](#running-in-production)
13. [Known limitations and open checks](#known-limitations-and-open-checks)
14. [Troubleshooting](#troubleshooting)
15. [Project structure](#project-structure)

---

## Requirements

- **Node.js 22 or newer** (`node --version`)
- A **Bitrix24** portal where you can create webhooks and custom fields (admin rights)
- A **Razorpay** account. Everything here uses **Test Mode**, so no real money moves.
- **ngrok** (free account), only for receiving Razorpay webhooks on your own computer

## Quick start

```bash
npm install
copy .env.example .env      # Windows cmd   (macOS/Linux/Git Bash: cp .env.example .env)
```

1. Put your Bitrix24 webhook URL into `.env` ([how to get it](#1-create-an-inbound-webhook)).
2. Create the two custom deal fields, then find their API names:
   ```bash
   npm run list-fields
   ```
3. Fill in the rest of `.env` ([Configuration](#configuration)).
4. Check everything, without changing anything anywhere:
   ```bash
   npm run check-setup            # config, Bitrix24 connection, custom fields, Razorpay keys
   npm run check-setup -- 54      # also a dry run for deal 54: shows the exact request for Razorpay
   ```
5. Start the service:
   ```bash
   npm run dev                    # http://localhost:8000, restarts when you save a file
   ```
6. Create a test link for a deal:
   ```bash
   curl.exe -X POST "http://localhost:8000/payment-links?deal_id=54"
   ```
   (In PowerShell, plain `curl` is a different command, so use `curl.exe`.)

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the service for development. Restarts when a source file changes. **Does not reload `.env`**: restart it yourself after editing `.env`. |
| `npm test` | Run the automated tests (about 150, a couple of seconds, no real accounts needed). |
| `npm run typecheck` | Check TypeScript types without building. |
| `npm run build` | Compile to JavaScript in `dist/`. |
| `npm start` | Run the compiled service (after `npm run build`). Use this in production. |
| `npm run list-fields` | List the deal's custom `UF_CRM_…` fields. Only needs `BITRIX_WEBHOOK_URL`. Add `-- --all` for every field. |
| `npm run check-setup [-- <dealId>]` | Read-only check of the whole setup, plus an optional dry run for one deal. |
| `npm run send-webhook -- <event> <dealId>` | Send a fake, correctly signed Razorpay webhook to the running service ([details](#testing-without-a-razorpay-payment)). |

## Configuration

All settings come from environment variables, usually through a `.env` file in the project folder. `.env` is in `.gitignore`: **never commit it**. Real environment variables take priority over `.env`.

The service checks every value at startup and refuses to start, with a list of problems, if something is missing or wrong.

| Variable | Required | Example | What it is |
|---|---|---|---|
| `BITRIX_WEBHOOK_URL` | yes | `https://yourcompany.bitrix24.in/rest/1/abc123/` | Bitrix24 inbound webhook. The last part is a secret token, so treat the whole URL as a password. |
| `BITRIX_PAYMENT_LINK_FIELD` | yes | `UF_CRM_1790231396690` | API name of the deal field that receives the link URL |
| `BITRIX_PAYMENT_ID_FIELD` | yes | `UF_CRM_1790231425631` | API name of the deal field that receives the Razorpay link ID (`plink_…`) |
| `RAZORPAY_KEY_ID` | yes | `rzp_test_…` | Razorpay API key ID (`rzp_live_…` in live mode) |
| `RAZORPAY_KEY_SECRET` | yes | | Razorpay API key secret |
| `RAZORPAY_WEBHOOK_SECRET` | yes | | The secret you type when creating the webhook in Razorpay. Must match exactly. |
| `MOVE_DEAL_TO_WON` | no | `false` | `true`: move the deal to its pipeline's *Won* stage when the link is fully paid |
| `INBOUND_API_TOKEN` | no, but **set it before going public** | long random string | If set, `/payment-links` and `/bitrix/deal-fields` require `?token=<value>` or an `X-Api-Token` header |
| `RAZORPAY_ACCEPT_PARTIAL` | no | `false` | Let customers pay in parts. Needed for `payment_link.partially_paid` events. |
| `PAYMENT_LINK_EXPIRE_DAYS` | no | `7` | Links expire after this many days. Empty means they never expire, so `payment_link.expired` never happens. |
| `PROCESSED_EVENTS_PATH` | no | `data/processed_events.json` | Where processed webhook IDs are remembered (duplicate protection) |
| `UNRESOLVED_LINKS_PATH` | no | `data/unresolved_links.json` | Where links that were created but couldn't be saved or cancelled are remembered |
| `PORT` | no | `8000` | HTTP port |

To generate a random value for `RAZORPAY_WEBHOOK_SECRET` or `INBOUND_API_TOKEN`:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

---

## Setting up Bitrix24

### 1. Create an inbound webhook

The service talks to Bitrix24 through an **inbound webhook**: a URL with a built-in secret that lets it call the REST API.

1. In Bitrix24 go to **Applications → Developer resources → Other → Inbound webhook**.
2. Under **Assign permissions**, click **+ select** and add **CRM (crm)**. This is the only permission needed.
3. Click **Create**, and copy the URL shown under *Webhook to call REST API*, e.g. `https://yourcompany.bitrix24.in/rest/28/p3r4…/`.
4. Put it in `.env` as `BITRIX_WEBHOOK_URL`.

The calls run **as the user who created the webhook**, so that user must be able to see and edit the deals involved.

**Keep the URL secret.** Anyone who has it can read and change your CRM. If it's ever exposed (in a screenshot, chat or commit), open the webhook and click **Generate new**, then update `.env`.

### 2. Create the two custom deal fields

The service stores the link and the Razorpay link ID on the deal.

1. Open any deal in **CRM → Deals**.
2. At the bottom of the **About deal** block, click **Create field**. (If you don't see it: hover over the block title → **Edit**, or the **⋯** menu → **Create field**.)
3. Create two fields:

   | Name (your choice) | Type | Multiple | Required |
   |---|---|---|---|
   | Razorpay Payment Link | **String** (or Link) | No | No |
   | Razorpay Link ID | **String** | No | No |

   Leave **Required** off, otherwise Bitrix may refuse to save deals that don't have a link yet.
4. Click the small **Save** inside the field box. You can cancel the deal itself: the fields are kept, and they apply to every deal.

### 3. Find the fields' API names

Bitrix shows your labels ("Razorpay Payment Link"), but the API uses generated names:

```bash
npm run list-fields
```

Copy the two `UF_CRM_…` names into `BITRIX_PAYMENT_LINK_FIELD` and `BITRIX_PAYMENT_ID_FIELD`.

### Finding a deal's ID

Open the deal. The address bar shows `…/crm/deal/details/54/`, so the ID is **54**. In the **List** view you can also add an **ID** column (gear icon on the column headers).

### Required fields on your deals

If your deals have required fields (for example *Purpose*), Bitrix may refuse the service's update on a deal where they're empty. The service then **cancels** the link it just created and explains why in a timeline comment. Fill in the required field and try again.

---

## Setting up Razorpay (test mode)

### API keys

1. In the Razorpay Dashboard, switch on **Test Mode** (toggle at the top).
2. Go to **Account & Settings → API Keys → Generate Test Key**.
3. Copy the **Key ID** (`rzp_test_…`) into `RAZORPAY_KEY_ID` and the **Key Secret** into `RAZORPAY_KEY_SECRET`.

Razorpay shows the secret **only once**. If you lose it, click **Regenerate Test Key** and update **both** values.

Check them with `npm run check-setup`. The *Razorpay* section should say `[OK] API keys work`.

### The webhook

Razorpay needs a public HTTPS address to call. For local testing, that's an ngrok address ([next section](#testing-locally-with-ngrok)); in production it's your server's address.

1. With **Test Mode** on: **Account & Settings → Webhooks → + Add New Webhook**.
2. **Webhook URL:** `https://<your public address>/webhooks/razorpay`
3. **Secret:** exactly the value of `RAZORPAY_WEBHOOK_SECRET` in your `.env`.
4. **Active events:** tick these five:
   - `payment_link.paid`
   - `payment_link.partially_paid`
   - `payment_link.expired`
   - `payment_link.cancelled`
   - `payment.failed`
5. Save.

Test mode and live mode have **separate** webhook lists, so you'll add the webhook again for live mode.

---

## Testing locally with ngrok

Your service runs at `localhost:8000`, which only exists on your computer. Razorpay needs to reach it from the internet. **ngrok** gives it a temporary public HTTPS address that forwards to your machine.

### 1. Install and connect ngrok (once)

```bash
winget install ngrok.ngrok
ngrok update                                   # winget may install an old version; ngrok refuses old agents
ngrok config add-authtoken <your authtoken>    # from dashboard.ngrok.com, "Your Authtoken"
```

If the `ngrok` command is **not recognized** right after installing, close VS Code (or your terminal app) **completely** and reopen it. Terminals keep the PATH they had when the app started.

### 2. Run the service and the tunnel

```bash
# terminal 1
npm run dev

# terminal 2
ngrok http 8000
```

Copy the `Forwarding https://….ngrok-free.dev` address.

### 3. Check the tunnel before involving Razorpay

```bash
npm run send-webhook -- other 54 --url https://<your-ngrok-address>
```

Expect `HTTP 200 {"status":"ignored"}`. That proves ngrok reaches your service and the webhook secret matches.

### 4. Add the Razorpay webhook

Follow [The webhook](#the-webhook) with URL `https://<your-ngrok-address>/webhooks/razorpay`.

The free ngrok address **changes every time you restart ngrok**. Update the webhook URL in Razorpay when it does.

### 5. Make test payments

Create a link (`curl.exe -X POST "http://localhost:8000/payment-links?deal_id=54"`), open its `short_url`, enter any mobile number and email, then:

| To test | Pay with | Expected comment on the deal |
|---|---|---|
| Success | UPI ID **`success@razorpay`** | "Razorpay: Payment successful" |
| Failure | UPI ID **`failure@razorpay`**, or **Netbanking** → any bank → **Failure** on the fake bank page | "Razorpay: Payment attempt failed" |
| Duplicate protection | Razorpay → Webhooks → a delivery → **Resend** | no second comment; the log says `Duplicate` |
| Cancellation | Razorpay → Payment Links → cancel a link | "Razorpay: Payment link cancelled" |

Each webhook also appears in the ngrok window. **A 400 there means the secret in Razorpay doesn't match `.env`.** For more test methods (cards, wallets), see Razorpay's *Test Card Details* documentation.

### Testing without a Razorpay payment

`send-webhook` sends a fake webhook, built and signed exactly like Razorpay's, to the running service. It posts **real comments** on the deal you name. The deal needs a payment link created by the service first: the fake event uses that saved link, because the service ignores events for any other link.

```bash
npm run send-webhook -- paid 54 --amount 11.80
npm run send-webhook -- partial 54
npm run send-webhook -- expired 54
npm run send-webhook -- cancelled 54
npm run send-webhook -- failed 54
npm run send-webhook -- paid 54 --twice            # second send must be answered "duplicate"
npm run send-webhook -- paid 54 --bad-signature    # must be rejected with HTTP 400
npm run send-webhook -- other 54                   # an event we don't handle: "ignored"
```

The script checks the answers and exits with code 1 if anything is unexpected. By default it targets `http://localhost:PORT`; `--url` accepts a server address or the full webhook URL.

---

## Creating links automatically from a deal stage

Instead of calling the service by hand, let Bitrix24 call it when a deal enters a stage, e.g. your **Payment Link** stage.

1. Set `INBOUND_API_TOKEN` in `.env` first, and restart the service. The URL below becomes public.
2. In **CRM → Deals**, open **Automation rules** (top right of the Kanban view).
3. In the **Payment Link** column, click **Add** and choose the **Webhook** rule (under *Other*; some versions call it *Outgoing webhook*).
4. Set the URL to:
   ```
   https://<your public address>/payment-links?deal_id={{ID}}&token=<your INBOUND_API_TOKEN>
   ```
   Use the rule's **…** / insert-field button to insert the deal's **ID** in place of `{{ID}}`.
5. Save.

Moving a deal into that stage now creates its link. The link appears in the deal's field, with a timeline comment.

The service accepts the deal ID from the `?deal_id=` query string, from a JSON body (`{"deal_id": 54}`), or from Bitrix's business-process format (`document_id[2]=DEAL_54`). That last one means it still finds the deal if the rule sends its own document data. This automation rule hasn't been tried on a real portal yet; see [open checks](#known-limitations-and-open-checks).

---

## How it works

### Flow 1: creating a link (`POST /payment-links`)

1. **Load the deal** (`crm.deal.get`): amount, currency, title, pipeline, plus the linked contact's name, first email and first phone (`crm.contact.get`). If the contact fails to load, the service continues without it.
2. **Check the amount.** Missing, zero or negative stops here, with a comment on the deal. Amounts are converted to paise with exact decimal arithmetic (`big.js`), never floating point: `1.005` becomes `101` paise, not `100`.
3. **Handle the deal's previous link**, if its *Razorpay Link ID* field has one:
   - **unpaid**: cancel it first, so the customer never has two payable links;
   - **paid or partly paid**: **refuse** to create a new link, and comment, so the customer isn't asked to pay twice. For a genuine second payment, clear the deal's *Razorpay Link ID* field and try again.
   - **expired or cancelled**: nothing to do.
   - If the old link can't be checked or cancelled, the service stops. No new link is created.
4. **Create the link** in Razorpay:
   - `reference_id` = the deal ID, or `54-2`, `54-3`… while earlier ones are still in use. The customer sees it as *RECEIPT*.
   - `notes.bitrix_deal_id` = the deal ID.
   - Razorpay's own SMS/email is switched off, because you send the link yourselves.
5. **Save the link** on the deal (`crm.deal.update`: link URL and `plink_…` ID). If saving fails, the new link is **cancelled** so it can't be paid without the CRM knowing. If even that cancel fails, the link is recorded in `data/unresolved_links.json`, and no new link is created for that deal until it's dealt with.
6. **Comment** on the deal's timeline (`crm.timeline.comment.add`).

Two requests for the same deal at the same time (a double click, or a rule firing twice) are refused with `409 ALREADY_IN_PROGRESS`.

### Flow 2: payment updates (`POST /webhooks/razorpay`)

1. **Verify the signature** before anything else: HMAC-SHA256 of the **raw** request body with `RAZORPAY_WEBHOOK_SECRET`, compared in constant time. A mismatch gets HTTP 400 and nothing else happens. The raw bytes matter: parsing the JSON and re-serialising it would change the spacing and break the signature.
2. **Parse** the event. Events not on the list are answered `ignored`.
3. **Skip duplicates.** Razorpay may deliver an event more than once. Each `X-Razorpay-Event-Id` is remembered in `data/processed_events.json`, which survives restarts, and a repeat is answered `duplicate`.
4. **Answer HTTP 200 immediately**, then do the Bitrix work in the background. Razorpay retries anything that isn't a quick 2xx, so a slow or broken CRM must never delay the answer. Failures are logged instead.
5. **Find the deal** from `notes.bitrix_deal_id`: on the payment link, on the payment, on the order, or, as a last resort for `payment.failed`, by fetching the order from Razorpay. The note is only a claim: the service then **checks that the event's link is the one saved in that deal's Link ID field** (or one it created but couldn't save). For `payment.failed`, which names no link, the payment's order must be the order of that link. Notes copied onto another link or payment, and links created by hand in the dashboard, are never matched to a deal, even if their reference looks like a deal ID. Payments that match no deal (e.g. your website's checkout) are skipped.
6. **Comment** on the deal:

   | Event | Comment |
   |---|---|
   | `payment_link.paid` | Payment successful: amount, payment ID, method, link. Optionally moves the deal to *Won*. |
   | `payment_link.partially_paid` | Partial payment received: paid so far vs. still due |
   | `payment_link.expired` | Link expired unpaid (or with how much was paid) |
   | `payment_link.cancelled` | Link cancelled |
   | `payment.failed` | Payment attempt failed, with the bank's reason. **Not final**: the customer can retry on the same link. |

**Moving to *Won*** uses the deal's own pipeline: `WON` in the default pipeline, `C3:WON` in pipeline 3, and so on. If the move fails, the payment comment is still posted, plus a second comment asking to move the deal by hand.

Comments are plain text without emoji, because some Bitrix24 installations can't store emoji.

### Why a payment can't end up on the wrong deal

- The deal ID is attached to the link **when it's created**, from the deal that asked for it.
- Webhooks are **signed**. A forged or modified webhook (e.g. with a different deal ID) fails the signature check.
- The `bitrix_deal_id` note is only used to find the deal (whole numbers only), and is acted on only if the event's link is the one the service saved on that deal. Anyone can write notes, so a note alone proves nothing.

---

## API reference

| Method & path | Purpose | Auth |
|---|---|---|
| `GET /health` | `{"status":"ok"}` if the process is up. Doesn't call Bitrix or Razorpay. | none |
| `POST /payment-links` | Create a link for a deal (flow 1) | `INBOUND_API_TOKEN` if set |
| `POST /webhooks/razorpay` | Razorpay webhooks (flow 2) | Razorpay signature |
| `GET /bitrix/deal-fields` | Custom deal fields and their labels (`?all=true` for every field) | `INBOUND_API_TOKEN` if set |

### `POST /payment-links`

The deal ID can be sent in the query string (`?deal_id=54`), as JSON (`{"deal_id": 54}`), or as Bitrix business-process form data (`document_id[2]=DEAL_54`).

**201 Created:**

```json
{
  "status": "created",
  "deal_id": "54",
  "payment_link_id": "plink_TfnfXvmFwEBz35",
  "short_url": "https://rzp.io/rzp/dQoOGtL",
  "reference_id": "54",
  "amount": 1180,
  "amount_display": "₹11.80",
  "currency": "INR",
  "deal_updated": true,
  "cancelled_previous_link_id": "plink_…"
}
```

`amount` is in paise. `cancelled_previous_link_id` is only present if an earlier unpaid link was cancelled.

**Errors** always look like `{"status":"error","error_code":"…","message":"…","deal_id":"54"}`. The same message is posted on the deal as a timeline comment, except where the table says otherwise:

| HTTP | `error_code` | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Missing or invalid deal ID, or malformed JSON (no comment: there's no valid deal) |
| 401 | `UNAUTHORIZED` | Missing or wrong token (no comment) |
| 404 | `DEAL_NOT_FOUND` | No such deal, or the webhook user can't see it (no comment: there's no deal) |
| 409 | `ALREADY_IN_PROGRESS` | A link for this deal is being created right now (no comment; the first request comments) |
| 409 | `ALREADY_PAID` | The deal's current link is already paid or partly paid |
| 422 | `INVALID_AMOUNT` | No amount, zero, negative, or less than 1 paisa |
| 502 | `RAZORPAY_REJECTED` | Razorpay refused (bad email/phone, wrong API keys…) with Razorpay's reason |
| 502 | `RAZORPAY_UNAVAILABLE` | Razorpay couldn't be reached. **A link may still have been created**, so check the dashboard before retrying. |
| 502 | `BITRIX_ERROR` | Bitrix24 answered with an error |
| 503 | `BITRIX_UNAVAILABLE` | Bitrix24 couldn't be reached |
| 500 | `INTERNAL_ERROR` | A bug; details are in the server log |

### `POST /webhooks/razorpay`

| HTTP | Body | Meaning |
|---|---|---|
| 200 | `{"status":"accepted"}` | Valid and new; processing in the background |
| 200 | `{"status":"duplicate"}` | Already processed |
| 200 | `{"status":"ignored"}` | An event we don't handle, or a payload we can't read |
| 400 | `INVALID_SIGNATURE` | Signature missing or wrong |

---

## Going live

The code is identical in test and live mode. **Only the settings change:**

| What | Test mode | Live mode |
|---|---|---|
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | `rzp_test_…` keys | `rzp_live_…` keys (Dashboard with **Test Mode off** → API Keys; needs an activated account) |
| Razorpay webhook | added in Test Mode | added **again** in Live Mode, with its own secret |
| `RAZORPAY_WEBHOOK_SECRET` | test webhook's secret | live webhook's secret |
| Public address | ngrok | your server's permanent HTTPS address |
| Payments | `success@razorpay`, test cards | real money |

Also before going live:

- **Set `INBOUND_API_TOKEN`**, and add `&token=…` to the Bitrix automation rule URL.
- Decide on **`MOVE_DEAL_TO_WON`**.
- **Clear the test data** from the old test links:
  - Deals still hold `plink_…` IDs from test mode. With live keys, Razorpay doesn't know those IDs; the service notices and ignores them. You can also clear the fields.
  - Delete `data/processed_events.json` and `data/unresolved_links.json` when switching modes.
- Run `npm run check-setup`. It should report `Razorpay mode: LIVE (real money!)`.
- Make one small real payment end to end, and refund it from the Razorpay dashboard.

## Running in production

```bash
npm ci
npm run build
npm start
```

- **Run it under a process manager** (pm2, systemd, a container restart policy, Windows Service…) so it restarts after a crash or reboot.
- **HTTPS is required.** Razorpay only calls HTTPS webhook URLs. Put the service behind a reverse proxy (nginx, Caddy, a cloud load balancer) or a platform that provides HTTPS.
- **Keep the `data/` folder** between deploys and restarts. It holds the duplicate-protection records and any unresolved links.
- **Run a single instance.** The duplicate protection, the double-click lock and the unresolved-links record live in one process and its local files. To run several instances, move them into a shared database or Redis first.
- **Shutdown:** on stop (Ctrl+C / SIGTERM) the service stops accepting requests, finishes webhook work already in progress, saves its records, then exits. That takes at most 10 seconds.
- **Monitoring:** point your uptime monitor at `GET /health`.

---

## Known limitations and open checks

**Verified with real Razorpay (test mode) and a real Bitrix24 portal:**
- Creating links, including the amount in paise, the customer details, and saving the link on the deal
- The `54-2` reference retry
- Cancelling the previous unpaid link
- A real successful payment arriving by webhook, and its comment

**Not yet verified with a real payment:**
1. **`payment.failed` with a real payload.** A real failure webhook may not include our `bitrix_deal_id` note. The service then fetches the order from Razorpay. If neither has it, the failure is logged but **no comment appears** (it's never put on a wrong deal). Test with `failure@razorpay` and check which source the log line `payment.failed -> deal 54 (found via …)` names.
2. **Resend / duplicate, cancelled comment, and the `409 ALREADY_PAID` refusal.** Covered by automated tests against a fake Razorpay, but not yet tried against the real one.
3. **The Bitrix24 automation rule** calling `/payment-links`. Its exact request format hasn't been seen yet; the service accepts all three known formats.
4. **Razorpay's wording for "this link ID doesn't exist"** was assumed. If it differs, that case stops with an error instead of going ahead: safe, but it would need a fix.

**Limitations:**
- **Two-decimal currencies only.** Amounts are multiplied by 100. That's right for INR and most currencies, but not for zero-decimal (JPY) or three-decimal (KWD, BHD) ones.
- **Single instance only** (see [Running in production](#running-in-production)).
- **Only the link in the deal's field is cancelled** when a new link is created. Links that were replaced before this feature existed must be cancelled by hand in the dashboard.
- **Webhook processing isn't retried.** Razorpay gets its 200 straight away, so if Bitrix is down at that moment the comment is lost, and the failure is only in the log.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Service won't start: `Invalid configuration…` | The message lists each bad variable. Fix `.env` and start again. |
| `[FAIL] Razorpay HTTP 401 … Authentication failed` | Wrong key ID/secret, the secret is still the placeholder from `.env.example`, or test and live keys are mixed. Regenerate the key and update **both** values. |
| Bitrix `403 Forbidden` or `insufficient_scope` | The webhook URL is incomplete, or it lacks the **CRM** permission. |
| `… does not exist on deals. Run: npm run list-fields` | The `UF_CRM_` name in `.env` is wrong, or you pasted the label instead of the API name. |
| Webhook shows **400** in ngrok / Razorpay | The webhook secret in Razorpay doesn't match `RAZORPAY_WEBHOOK_SECRET`. |
| Nothing arrives at all | ngrok isn't running, the ngrok address changed (update it in Razorpay), or the events aren't ticked on the webhook. |
| `'ngrok' is not recognized` | Reopen VS Code / the terminal app completely after installing. |
| `ngrok-agent version "3.3.1" is too old` | `ngrok update` |
| Comment "The customer has already paid …" | Working as intended (`ALREADY_PAID`). For a genuine second payment, clear the deal's *Razorpay Link ID* field. |
| Comment "… could not be saved to the deal, so it was cancelled" | Usually a required deal field is empty (e.g. *Purpose*). Fill it in and retry. |
| Changed `.env` but nothing changed | Restart `npm run dev`; it doesn't reload `.env`. |
| Service refuses to start: `Could not read data/unresolved_links.json` | The file is damaged. Check the Razorpay dashboard for any link it might list, cancel it if needed, then delete the file. |

The service logs one line per request (`[http] …`) and one per important step (`[payment-links] …`, `[webhook] …`). Secrets and the `?token=` value are never logged.

## Project structure

```
src/
  main.ts            entry point: loads config, starts the server, graceful shutdown
  app.ts             Express routes only
  config.ts          settings from environment variables, validated with zod
  bitrix.ts          Bitrix24 REST calls and error handling
  razorpay.ts        Razorpay API calls, paise conversion, error handling
  paymentLinks.ts    flow 1: create a link for a deal
  webhookHandler.ts  flow 2: signature, duplicates, finding the deal, comment text
  models.ts          request/response shapes and webhook schemas (zod)
scripts/
  listFields.ts      npm run list-fields
  checkSetup.ts      npm run check-setup
  sendTestWebhook.ts npm run send-webhook
tests/               automated tests (vitest) against fake Bitrix24 and Razorpay servers
data/                created at runtime; keep it between restarts (git-ignored)
.env.example         every setting, with placeholder values
```
