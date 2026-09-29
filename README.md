# Bitrix24 ↔ Razorpay Payment Links

A small Node.js service that connects Bitrix24 CRM deals with Razorpay payment links.

- **Flow 1: create a link.** Bitrix24 sends a deal ID. The service reads the deal's amount and contact, creates a Razorpay payment link, saves the link on the deal, and posts a timeline comment.
- **Flow 2: payment updates.** Razorpay calls the service when a link is paid, partly paid, expires, is cancelled, or a payment attempt fails. The service posts a timeline comment on the right deal, and can move the deal to *Won*.
- **Recurring pipeline: yearly renewal links.** For 1-year subscriptions, the reminder stages (1 month, 15 days, 5 days before renewal) share **one link per year**, valid until paid. A paid renewal moves the deal back to *Active* ([details](#recurring-pipeline-yearly-renewal-links)).

Every problem (no amount, Razorpay rejected the request, Bitrix unreachable…) ends up as a **timeline comment on the deal**, so the sales team sees it inside the CRM rather than only in server logs.

**Where it runs:** in production on **AWS Lambda**, with a DynamoDB table as its memory ([Deploying to AWS Lambda](#deploying-to-aws-lambda)). The same code also runs as a normal Node.js server, which is how you develop and test it on your own computer.

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
9. [Recurring pipeline: yearly renewal links](#recurring-pipeline-yearly-renewal-links)
10. [How it works](#how-it-works)
11. [API reference](#api-reference)
12. [Deploying to AWS Lambda](#deploying-to-aws-lambda)
13. [Going live](#going-live)
14. [Running on your own server instead](#running-on-your-own-server-instead)
15. [Known limitations and open checks](#known-limitations-and-open-checks)
16. [Troubleshooting](#troubleshooting)
17. [Project structure](#project-structure)

---

## Requirements

- **Node.js 24** (`node --version`). The local server also runs on Node 22, but AWS Lambda uses Node 24.
- A **Bitrix24** portal where you can create webhooks and custom fields (admin rights)
- A **Razorpay** account. Everything here uses **Test Mode** unless stated otherwise, so no real money moves.
- For deploying: an **AWS account**, plus the **AWS CLI** and **SAM CLI** ([setup](#one-time-setup))
- **ngrok** (free account), only for receiving Razorpay webhooks on your own computer while testing locally

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
| `npm test` | Run the automated tests (about 200, a few seconds, no real accounts needed). |
| `npm run typecheck` | Check TypeScript types without building. |
| `npm run build:lambda` | Pack the code for AWS Lambda into one file, `dist-lambda/lambda.js`. |
| `npm run deploy` | Build for Lambda and deploy to AWS (after the [first deploy](#first-deploy)). |
| `npm run build` | Compile to JavaScript in `dist/`, for [running on your own server](#running-on-your-own-server-instead). |
| `npm start` | Run the compiled service on your own server (after `npm run build`). |
| `npm run list-fields` | List the deal's custom `UF_CRM_…` fields. Only needs `BITRIX_WEBHOOK_URL`. Add `-- --all` for every field. |
| `npm run list-pipelines` | List the deal pipelines with their IDs and stage IDs (e.g. `Recurring` = 6, `Active` = `C6:NEW`). Only needs `BITRIX_WEBHOOK_URL`. |
| `npm run check-setup [-- <dealId>]` | Read-only check of the whole setup, plus an optional dry run for one deal. |
| `npm run send-webhook -- <event> <dealId>` | Send a fake, correctly signed Razorpay webhook to the running service ([details](#testing-without-a-razorpay-payment)). |

## Configuration

All settings come from environment variables, usually through a `.env` file in the project folder. `.env` is in `.gitignore`: **never commit it**. Real environment variables take priority over `.env`.

On **AWS Lambda** there is no `.env` file: you give the same values once during the [first deploy](#first-deploy), and AWS stores them as the function's settings. Keep your local `.env` matching them, because `npm run check-setup`, `list-fields` and `send-webhook` read `.env`.

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
| `DYNAMODB_TABLE` | on Lambda only | set by the deploy | A DynamoDB table name. When set, everything above that says "remembered" is kept in DynamoDB instead of the two files. The deploy sets it automatically; leave it empty on your computer. |
| `RECURRING_CATEGORY_ID` | no | `6` | The Recurring pipeline's ID (`npm run list-pipelines`). Switches on the [yearly renewal links](#recurring-pipeline-yearly-renewal-links). Empty = off. On Lambda it's the `RecurringCategoryId` deploy setting. |
| `RECURRING_ACTIVE_STAGE_ID` | no | `C6:NEW` | The stage a Recurring deal goes back to after its renewal is paid. Empty = the pipeline's first stage, `C<id>:NEW`. |
| `PORT` | no | `8000` | HTTP port (your own server only) |

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

1. Make sure `INBOUND_API_TOKEN` is set: on Lambda it's asked for during the deploy; locally, set it in `.env` and restart the service. The URL below becomes public.
2. Put the rule's URL, with your token filled in, straight onto the **clipboard**. Run this from the project folder (Windows), replacing the address with your public one: on Lambda, the `FunctionUrl` from the deploy, without its final `/`.
   ```bash
   node -e "const t=require('node:util').parseEnv(require('fs').readFileSync('.env','utf8')).INBOUND_API_TOKEN; process.stdout.write('https://<your public address>/payment-links?deal_id=&token='+t)" | clip
   ```
   The clipboard route matters: **copying a long line from the terminal can add line breaks** where the terminal wrapped it, and a URL with line breaks silently never reaches the service. It also keeps the token off the screen.
3. In **CRM → Deals**, open **Automation rules** (top right of the Kanban view).
4. In the **Payment Link** column, click **Add**, search for **webhook**, and add **Outbound webhook**. (Not *Track inbound webhook*: that's a trigger, which works the other way round.)
5. In the rule's settings:
   - **Execution:** change *Wait / 1 day* to **Immediately**.
   - **Handler:** click in the box, **Ctrl+A**, **Delete**, then **Ctrl+V**. Click right after `deal_id=`, click **•••** next to the box, and choose **Deal → ID**. Bitrix shows the inserted field as `{{ID}}`. That's correct, as long as it was inserted with •••, not typed.
   - **Condition:** leave empty.
6. Click **Save** on the rule, then **Save** on the automation rules page.

Moving a deal into that stage now creates its link within seconds. The link appears in the deal's fields, with a timeline comment. If the deal's current link is already paid, no new link is created, and a comment says so. The rule only runs when a deal **enters** the stage: to retry, move the deal out and back in.

The service accepts the deal ID from the `?deal_id=` query string (what this rule sends), from a JSON body (`{"deal_id": 54}`), or from Bitrix's business-process format (`document_id[2]=DEAL_54`).

If nothing happens, check the logs ([Checking it works](#checking-it-works)). No `POST /payment-links` line at all means Bitrix never reached the service: the Handler address is wrong, has a line break, or wasn't saved. When testing locally, the service must also be running, and ngrok too.

---

## Recurring pipeline: yearly renewal links

The client sells **1-year subscriptions**. A second pipeline, **Recurring**, reminds customers before each renewal:

```
Active  ──►  1 month  ──►  15 days  ──►  5 days        (paid → back to Active)
(waiting)    └──────── renewal reminders ────────┘
```

This has its **own logic and its own address**, `POST /recurring/payment-links`, separate from the Deals pipeline's `/payment-links`, whose rules stay exactly as described above.

### The rules

- **One link per subscription year.** The three reminders of a year all use the **same link**, so the customer never gets three different ones.
- **The link never expires.** It stays valid until it's paid.
- **Every new year gets a new link:** year 1, year 2, year 3…
- **The amount** is the Amount of the deal **in the Recurring pipeline**, set there by the team, not the original sale's amount.

Each time a reminder stage is entered, the service looks at the deal's saved link (its *Razorpay Link ID* field):

| The deal's saved link is… | What happens | Comment on the deal |
|---|---|---|
| none | **creates this year's link**, saves it on the deal | "Renewal payment link created (2026) … 1 month left" |
| this year's, unpaid | **the same link again**, nothing new in Razorpay | "Renewal reminder (15 days left) … Same link as before" |
| this year's, paid | nothing to charge | "This year's renewal is already paid" |
| this year's, cancelled or expired (e.g. cancelled by hand) | a new link for this year | "Renewal payment link created …" |
| last year's, paid | **a new link** for the new year | "Renewal payment link created (2027) …" |
| last year's, still unpaid | **cancels it**, then creates this year's | "… Last year's unpaid link was cancelled" |

**How "this year" is decided:** a link belongs to the year it was created in. One created **less than about 6 months ago** is this year's. The reminders of a year are at most a month apart and renewals are 12 months apart, so this needs no extra date field.

**The receipt number** (`reference_id`) is `<deal ID>-<year>`, e.g. `66-2026`, and the link's notes also carry `subscription_year`.

**When the renewal is paid**, the usual "Payment successful" comment is posted, and the deal is **moved back to Active** to wait for next year's reminders. Recurring deals are never moved to *Won*, whatever `MOVE_DEAL_TO_WON` says. If the move fails, a comment asks for it to be done by hand.

The same safety rules as the Deals pipeline apply:
- **Deals outside the Recurring pipeline are refused**, with a comment.
- If the current link can't be checked or cancelled, **no new link** is made.
- A link that can't be saved on the deal is cancelled.
- Two requests for one deal at the same moment: the second is refused.

### Setting it up

1. **The pipeline in Bitrix24:** CRM → Deals → settings (gear) → **Pipelines and tunnels** → **Add pipeline**. Name it `Recurring`, with the in-progress stages **`Active`**, **`1 month`**, **`15 days`**, **`5 days`**, in that order.
   - Deals wait in **Active**. The team (or Bitrix automation) moves them to *1 month*, *15 days* and *5 days* at the right times before the renewal date. The service only reacts when a deal **enters** a reminder stage.
   - Optionally, a **tunnel** from the Deals pipeline's *Deal won* to *Active* copies every won deal into Recurring. Check that the copy's Amount is the renewal price.
   - Make sure the *Razorpay Payment Link* and *Razorpay Link ID* fields are visible on Recurring deals (**Select field** on the deal card).
2. **Its ID:** run `npm run list-pipelines`. You'll see e.g. `Pipeline ID 6: "Recurring"` and `Active (C6:NEW)`.
3. **Tell the service:** put `RECURRING_CATEGORY_ID=6` in `.env`. On AWS, set the `RecurringCategoryId` deploy setting to `6` ([changing a setting](#changing-a-setting-eg-new-razorpay-keys)).
4. **Three automation rules**, one per reminder stage. In **Automation rules**, switch to the **Recurring** pipeline, then add an **Outbound webhook** on each of *1 month*, *15 days* and *5 days*, set up [like the Deals rule](#creating-links-automatically-from-a-deal-stage) (Execution **Immediately**, one-line Handler, `{{ID}}` inserted with •••). The only difference is the address and a `days=` value:
   ```
   https://<your public address>/recurring/payment-links?deal_id={{ID}}&days=30&token=<token>   ← on "1 month"
   https://<your public address>/recurring/payment-links?deal_id={{ID}}&days=15&token=<token>   ← on "15 days"
   https://<your public address>/recurring/payment-links?deal_id={{ID}}&days=5&token=<token>    ← on "5 days"
   ```
5. **Sending the link to the customer** (email, SMS, WhatsApp) stays a Bitrix robot on each reminder stage, inserting the *Razorpay Payment Link* field. The field holds the same link all year, so every reminder carries the right one. Put that robot **after** the Outbound webhook, with a short delay (e.g. 1 minute), so the link is already saved when the first reminder of a year goes out.

### Trying it

With a test Recurring deal that has an Amount (Razorpay test mode):

1. Move it to **1 month** → the link fields fill, with receipt `<id>-<year>`, and the comment "Renewal payment link created".
2. Move it to **15 days** → comment "Same link as before", and no new link in the Razorpay dashboard.
3. Pay the link with `success@razorpay` → "Payment successful", then "back in Active until next year's reminders". The deal is in **Active**.
4. Move it to **5 days** → "This year's renewal is already paid".

The "next year" cases can't be tried live without waiting a year. They're covered by the automated tests, which move a fake clock 12 months ahead (`tests/recurringLinks.test.ts`).

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
5. **Save the link** on the deal (`crm.deal.update`: link URL and `plink_…` ID). If saving fails, the new link is **cancelled** so it can't be paid without the CRM knowing. If even that cancel fails, the link is recorded as "unresolved" (in `data/unresolved_links.json`, or DynamoDB on Lambda), and no new link is created for that deal until it's dealt with.
6. **Comment** on the deal's timeline (`crm.timeline.comment.add`).

Two requests for the same deal at the same time (a double click, or a rule firing twice) are refused with `409 ALREADY_IN_PROGRESS`. A per-deal lock makes sure of that. On Lambda the lock lives in DynamoDB, so it works even when the two requests reach two different copies of the function. It runs out by itself after a minute if it's never released.

### Flow 2: payment updates (`POST /webhooks/razorpay`)

1. **Verify the signature** before anything else: HMAC-SHA256 of the **raw** request body with `RAZORPAY_WEBHOOK_SECRET`, compared in constant time. A mismatch gets HTTP 400 and nothing else happens. The raw bytes matter: parsing the JSON and re-serialising it would change the spacing and break the signature.
2. **Parse** the event. Events not on the list are answered `ignored`.
3. **Skip duplicates.** Razorpay may deliver an event more than once. Each `X-Razorpay-Event-Id` is remembered, and a repeat is answered `duplicate`. On your own server it's remembered in `data/processed_events.json`, which survives restarts. On Lambda it's remembered in DynamoDB, which every copy of the function shares, and handled IDs are kept 7 days (Razorpay resends for up to 24 hours).
   - An event only counts as processed once its Bitrix work has finished. A repeat that arrives while the first delivery is still being processed gets HTTP 409, so Razorpay retries it later.
   - An event whose processing never finished (e.g. the process or Lambda copy was stopped) is processed again when resent. On Lambda that's possible after 5 minutes, when its "processing" claim runs out.
   - If the storage itself can't be reached, the answer is `503 STORAGE_UNAVAILABLE`, and Razorpay resends later.
4. **Do the Bitrix work, and answer Razorpay.** The order differs:
   - **Your own server** answers HTTP 200 **immediately**, then does the Bitrix work in the background. Razorpay retries anything that isn't a quick 2xx, so a slow or broken CRM must never delay the answer. Failures are logged instead.
   - **AWS Lambda** does the Bitrix work **first**, then answers. Lambda freezes the function the moment it answers, so background work might never finish. If Bitrix is slow and Razorpay gives up waiting, its resend is recognised by step 3, so the comment is still posted only once.
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
| `POST /recurring/payment-links` | Renewal reminder for a Recurring-pipeline deal ([details](#post-recurringpayment-links)) | `INBOUND_API_TOKEN` if set |
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
| 503 | `STORAGE_UNAVAILABLE` | The service's own storage (DynamoDB on Lambda) couldn't be reached. No link is created, because a double click can't be ruled out. Try again in a minute. |
| 500 | `INTERNAL_ERROR` | A bug; details are in the server log |

### `POST /recurring/payment-links`

Takes `deal_id` (query string, JSON or form, as above) and `days`, which must be `30`, `15` or `5`: the reminder, meaning 1 month, 15 days or 5 days left.

| HTTP | `status` / `error_code` | Meaning |
|---|---|---|
| 201 | `created` | This year's link was just created |
| 200 | `reminded` | This year's unpaid link already existed: the same link again |
| 200 | `already_paid` | This year's renewal is paid; nothing to do |
| 400 | `BAD_REQUEST` | Missing or invalid `deal_id`, or `days` not 30/15/5 |
| 404 | `NOT_FOUND` | Renewal links are switched off (`RECURRING_CATEGORY_ID` not set) |
| 422 | `NOT_RECURRING_DEAL` | The deal isn't in the Recurring pipeline (commented on the deal) |

The other errors (401, 404 `DEAL_NOT_FOUND`, 409, 422 `INVALID_AMOUNT`, 502, 503) mean the same as for `/payment-links`. A successful reply looks like the `/payment-links` one, plus `days_left`, with `status` as above.

### `POST /webhooks/razorpay`

| HTTP | Body | Meaning |
|---|---|---|
| 200 | `{"status":"accepted"}` | Valid and new. On your own server it's being processed in the background; on Lambda it has already been processed. |
| 200 | `{"status":"duplicate"}` | Already processed |
| 200 | `{"status":"ignored"}` | An event we don't handle, or a payload we can't read |
| 409 | `ALREADY_IN_PROGRESS` | The same event is still being processed; Razorpay retries later |
| 503 | `STORAGE_UNAVAILABLE` | The duplicate check couldn't reach its storage; Razorpay retries later |
| 400 | `INVALID_SIGNATURE` | Signature missing or wrong |

---

## Deploying to AWS Lambda

In production the service runs on **AWS Lambda**: there's no server to keep running. AWS starts a copy of the code whenever a request arrives, and you pay only for that time, which at this volume is at or near AWS's free allowance.

```
Bitrix automation rule ─┐                         ┌─► Bitrix24 REST API
                        ├─► Function URL (HTTPS) ─► Lambda ─┼─► Razorpay API
Razorpay webhooks ──────┘                         └─► DynamoDB table (what the service remembers)
```

`template.yaml` describes everything AWS creates, as one **stack** named `bitrix24-razorpay`:
- **the Lambda function** (Node 24, Mumbai region `ap-south-1`);
- **its Function URL**: a permanent public HTTPS address, which replaces ngrok;
- **a DynamoDB table** holding the duplicate records, unresolved links and deal locks. It is kept even if the stack is deleted, and it has 35 days of point-in-time recovery;
- **a log group** in CloudWatch, keeping 30 days of logs;
- **a permission (role)** letting the function use that table only.

**Three things work differently on Lambda**, and the code switches them on automatically in `src/lambda.ts`:
- Webhooks are processed **before** answering Razorpay ([why](#flow-2-payment-updates-post-webhooksrazorpay)).
- Everything the service remembers lives in **DynamoDB**, not in files: Lambda has no permanent disk and may run several copies at once.
- The double-click lock is in DynamoDB too, so separate copies see each other's locks.

### One-time setup

**1. A deploy user in AWS.** Don't deploy with the account's root login, because root access keys control the whole account. Log in to the AWS Console as root once, then:
1. Set the region (top right) to **Asia Pacific (Mumbai)**.
2. Go to **IAM → Users → Create user**, e.g. `bitrix24-razorpay-deployer`. Leave console access **off**.
3. Choose **Attach policies directly** and tick:
   - `AWSCloudFormationFullAccess`
   - `AWSLambda_FullAccess`
   - `AmazonDynamoDBFullAccess`
   - `IAMFullAccess`
   - `AmazonS3FullAccess`
   - `CloudWatchLogsFullAccess`

   Then **Create user**.
4. Open the user → **Security credentials** → **Create access key** → *Command Line Interface (CLI)* → **Download .csv file**. The secret is shown only once; keep the file private.

It's also a good idea to switch on **MFA** for the root login and stop using it day to day.

**2. The tools**, on your computer:
```bash
winget install Amazon.AWSCLI
winget install Amazon.SAM-CLI
```
Then close VS Code (or your terminal app) **completely** and reopen it, so the new commands are found.

**3. Log in with the deploy user's keys:**
```bash
aws configure                 # access key ID, secret, region ap-south-1, output json
aws sts get-caller-identity   # the Arn must end in user/<your deploy user>, not root
```
If `aws configure` asks about setting up AWS tools for AI coding agents, answer `n`.

### First deploy

```bash
npm test                 # make sure everything passes first
npm run build:lambda     # packs the code into dist-lambda/lambda.js
sam deploy --guided
```

Don't run `sam build`: `npm run build:lambda` has already built the code. `sam deploy --guided` asks these questions:

| It asks | Answer |
|---|---|
| Stack Name | `bitrix24-razorpay` |
| AWS Region | `ap-south-1` |
| BitrixWebhookUrl, BitrixPaymentLinkField, BitrixPaymentIdField, RazorpayKeyId, RazorpayKeySecret, RazorpayWebhookSecret, InboundApiToken | the same values as in your `.env`. `InboundApiToken` is **required** here, at least 16 characters. |
| MoveDealToWon, RazorpayAcceptPartial, PaymentLinkExpireDays | **Enter** for the defaults, or your choice |
| RecurringCategoryId | the Recurring pipeline's ID (e.g. `6`), or **Enter** to leave the renewal links off |
| Confirm changes before deploy | `y` |
| Allow SAM CLI IAM role creation | `Y` |
| Disable rollback | `N` |
| PaymentLinksFunction has no authentication. Is this okay? | `y`. Bitrix and Razorpay can't log in to AWS; the token and Razorpay's signature protect the service instead. |
| Save arguments to configuration file | `Y`. The answers go into `samconfig.toml`, which is git-ignored because it contains secrets. |
| SAM configuration file / environment | **Enter**, **Enter** |
| Deploy this changeset? | `y` |

**Secret values are invisible while you type or paste them.** Nothing appears, not even dots; that's normal. Paste **once**, then press Enter. If you're unsure, press Ctrl+C and start again: nothing is created until the last question.

The first deploy also creates a small helper stack, `aws-sam-cli-managed-default`, which SAM uses to upload the code. When the deploy finishes, it prints **Outputs**:

| Output | What it's for |
|---|---|
| `FunctionUrl` | the service's address, e.g. `https://abc123….lambda-url.ap-south-1.on.aws/` |
| `RazorpayWebhookUrl` | the same address plus `webhooks/razorpay`: paste it into Razorpay |
| `TableName` | the DynamoDB table |
| `Logs` | the CloudWatch log group |

### Point Bitrix and Razorpay at it

1. **Bitrix automation rule:** set its Handler to `<FunctionUrl without the final />/payment-links?deal_id={{ID}}&token=…` ([how](#creating-links-automatically-from-a-deal-stage), including the clipboard step).
2. **Razorpay webhook:** set its URL to the `RazorpayWebhookUrl` output. Keep the secret you gave as `RazorpayWebhookSecret`, and the five events.
3. Stop any local `npm run dev` and ngrok. They're no longer needed.

### Checking it works

```bash
curl.exe https://<FunctionUrl>/health        # {"status":"ok"}
aws logs tail /aws/lambda/bitrix24-razorpay-payment-links --follow --region ap-south-1
```

The second command shows the logs live; press Ctrl+C to stop. Then move a test deal into *Payment Link* and pay its link with `success@razorpay`. The log shows `POST /payment-links -> 201`, then `POST /webhooks/razorpay -> 200`, and the deal gets both comments.

You can also read the logs in the AWS Console: **CloudWatch → Log groups → `/aws/lambda/bitrix24-razorpay-payment-links`**. The first request after a quiet period includes a short start-up (`Init Duration`, about half a second).

### Updating the code

```bash
npm test
npm run deploy     # = npm run build:lambda + sam deploy, using the saved answers
```

It shows what will change and asks for confirmation. Commit to git first, so GitHub always matches what's running.

### Changing a setting (e.g. new Razorpay keys)

Run `npm run build:lambda`, then `sam deploy --guided` again, and give the new values. The answers are saved over the old ones in `samconfig.toml`. Saving a changed setting makes AWS start fresh copies of the function, so the new values apply straight away. Update your local `.env` to match.

### Removing it

`sam delete --stack-name bitrix24-razorpay --region ap-south-1` removes the function, URL, role and logs. The **DynamoDB table is kept** on purpose, since it may hold unresolved links; delete it in the DynamoDB console once you're sure.

---

## Going live

The code is identical in test and live mode. **Only the settings change:**

| What | Test mode | Live mode |
|---|---|---|
| `RazorpayKeyId` / `RazorpayKeySecret` | `rzp_test_…` keys | `rzp_live_…` keys (Dashboard with **Test Mode off** → API Keys; needs an activated account) |
| Razorpay webhook | added in Test Mode | added **again** in Live Mode (same `RazorpayWebhookUrl`), with its **own** secret |
| `RazorpayWebhookSecret` | test webhook's secret | live webhook's secret |
| Public address | the Lambda `FunctionUrl` | the same (nothing to change in Bitrix) |
| Payments | `success@razorpay`, test cards | real money |

Steps:

1. Create the **live** API keys, then the **live** webhook, with a new secret and the same five events.
2. Run `npm run build:lambda`, then `sam deploy --guided`, entering the live `RazorpayKeyId`, `RazorpayKeySecret` and `RazorpayWebhookSecret` ([changing a setting](#changing-a-setting-eg-new-razorpay-keys)). If `InboundApiToken` has ever been shared (e.g. in a screenshot), give a new one now too, and update the Bitrix rule's `token=`.
3. Put the same live values in your local `.env`, then run `npm run check-setup`. It should say `Razorpay mode: LIVE (real money!)`.
4. Decide on **`MoveDealToWon`**.
5. **Test data:** deals still hold `plink_…` IDs from test mode. With live keys Razorpay doesn't know those IDs; the service notices and ignores them. You can also clear the fields. Old test records in DynamoDB don't need clearing: they don't clash with live ones and expire by themselves.
6. Make one small real payment end to end (a ₹1 deal), then refund it from the Razorpay dashboard.

## Running on your own server instead

The same code also runs as a normal, always-on Node.js server, if you ever move away from Lambda:

```bash
npm ci
npm run build
npm start
```

- **Run it under a process manager** (pm2, systemd, a container restart policy, Windows Service…) so it restarts after a crash or reboot.
- **HTTPS is required.** Razorpay only calls HTTPS webhook URLs. Put the service behind a reverse proxy (nginx, Caddy, a cloud load balancer) or a platform that provides HTTPS.
- **Keep the `data/` folder** between deploys and restarts. It holds the duplicate-protection records and any unresolved links. Alternatively, set `DYNAMODB_TABLE` to use DynamoDB here too.
- **Run a single instance** when using the `data/` files: the duplicate protection, the double-click lock and the unresolved-links record then live in one process and its local files. With `DYNAMODB_TABLE` set, all three are in DynamoDB, so several instances can run side by side.
- **Shutdown:** on stop (Ctrl+C / SIGTERM) the service stops accepting requests, finishes webhook work already in progress, saves its records, then exits. That takes at most 10 seconds.
- **Monitoring:** point your uptime monitor at `GET /health`.

---

## Known limitations and open checks

**Verified with real Razorpay (test mode) and a real Bitrix24 portal:**
- Creating links, including the amount in paise, the customer details, and saving the link on the deal
- The `54-2` reference retry
- Cancelling the previous unpaid link
- A real successful payment arriving by webhook, and its comment
- The **Outbound webhook** automation rule on the *Payment Link* stage creating links automatically
- The `409 ALREADY_PAID` refusal when a deal whose link is paid re-enters the stage
- A deal re-entering the stage: its unpaid link is cancelled and a new one created
- A real **failed payment** (Netbanking → Failure): Razorpay copies the link's notes onto the payment, so the deal is found directly (`found via payment.notes`), and the comment includes the bank's reason
- A real **cancelled** webhook and its comment

**Verified on AWS Lambda** (test mode):
- The automation rule calling the Function URL, the link created and saved on the deal
- A real payment (`success@razorpay`) arriving by webhook, and its comment
- The token check, and the signature check with the webhook secret entered during the deploy
- Duplicate protection with the **real DynamoDB table**: a signed test webhook sent twice was answered `accepted`, then `duplicate`
- **Recurring pipeline**, on a test deal:
  - *1 month* created this year's link (`<id>-2026`);
  - *15 days* reused the **same** link;
  - payment with `success@razorpay` moved the deal back to *Active*;
  - *5 days* reported "already paid".

  The "next year" cases (a new link after 12 months, cancelling last year's unpaid link) are covered by automated tests with a moved clock, since they can't be tried live without waiting a year.

**Not yet verified against the real Razorpay:**
1. **Razorpay's Resend button.** Duplicate protection is verified (above, and by automated tests), but a resend from the Razorpay dashboard hasn't been tried.
2. **Razorpay's wording for "this link ID doesn't exist"** was assumed. If it differs, that case stops with an error instead of going ahead: safe, but it would need a fix.

**Limitations:**
- **Two-decimal currencies only.** Amounts are multiplied by 100. That's right for INR and most currencies, but not for zero-decimal (JPY) or three-decimal (KWD, BHD) ones.
- **Your own server with the `data/` files: single instance only** (see [Running on your own server instead](#running-on-your-own-server-instead)). Lambda uses DynamoDB and has no such limit.
- **Only the link in the deal's field is cancelled** when a new link is created. Links that were replaced before this feature existed must be cancelled by hand in the dashboard.
- **Failed Bitrix work isn't retried later.** If Bitrix is down when a webhook arrives, the service still answers 200, since resending wouldn't help if Bitrix stays down. The comment is then lost, and the failure is only in the log.
- **On Lambda, the webhook comment is posted before the answer.** If Bitrix takes longer than Razorpay is willing to wait, Razorpay records a failed delivery and resends. The resend is recognised as a duplicate, so no double comment.

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
| Every test file fails with `Vitest failed to find the runner` | You ran `npx vitest` from a terminal whose path starts with a lowercase `c:\` (a vitest bug on Windows). Use `npm test`, which corrects the drive letter first. |
| **AWS:** moving a deal to *Payment Link* does nothing, and the logs show **no** `POST /payment-links` | Bitrix never reached the service. The rule's Handler still has an old address, **contains a line break** (copied from a wrapped terminal line; use the [clipboard step](#creating-links-automatically-from-a-deal-stage)), or wasn't saved (there are two Save buttons). Then move the deal out of the stage and back in. |
| **AWS:** logs show `POST /payment-links -> 400` | The address arrived, but the deal ID didn't. Re-insert it with **•••** → **Deal → ID** instead of typing `{{ID}}`. |
| **AWS:** logs show `-> 401` | The `token=` in the rule's URL doesn't match the `InboundApiToken` given at deploy time. |
| Recurring rule: `POST /recurring/payment-links -> 404` | Renewal links are off: `RecurringCategoryId` wasn't set at deploy time (or `RECURRING_CATEGORY_ID` locally). |
| Recurring rule: `-> 400` | The `days=` in the rule's URL isn't `30`, `15` or `5`, or the deal ID wasn't inserted with •••. |
| Comment "This deal isn't in the Recurring pipeline" | A recurring rule was added to the wrong pipeline, or `RecurringCategoryId` is the wrong ID. Check with `npm run list-pipelines`. |
| A Recurring deal wasn't moved back to Active after paying | Look for the comment "could not be moved to Active automatically" and its reason. If the Active stage isn't the pipeline's first stage, set `RECURRING_ACTIVE_STAGE_ID`. |
| `'aws'` / `'sam'` is not recognized | Close VS Code or the terminal app completely and reopen it after installing. |
| `sam deploy --guided` seems frozen at a secret question | It isn't: secret answers are invisible while you type or paste. Paste once and press Enter. |
| Deploy fails with `AccessDenied` / `not authorized to perform` | The deploy user is missing one of the six policies in [One-time setup](#one-time-setup). |
| Deploy fails: parameter "failed to satisfy constraint" | A value doesn't have the expected form: e.g. the token is shorter than 16 characters, a field name doesn't start with `UF_CRM_`, or the key ID doesn't start with `rzp_test_`/`rzp_live_`. |
| Lambda logs: `DYNAMODB_TABLE is not set` | The function was deployed without the template. Deploy with `sam deploy`, which sets it automatically. |
| The Function URL answers `403 Forbidden` / `AccessDeniedException` | The URL's public-access permission is missing. It's normally created by the template; redeploy, and report it if it persists. |
| Service refuses to start: `Could not read data/unresolved_links.json` | The file is damaged. Check the Razorpay dashboard for any link it might list, cancel it if needed, then delete the file. |

The service logs one line per request (`[http] …`) and one per important step (`[payment-links] …`, `[webhook] …`). Secrets and the `?token=` value are never logged. On Lambda the logs are in CloudWatch ([Checking it works](#checking-it-works)).

## Project structure

```
src/
  lambda.ts          entry point on AWS Lambda: wraps the Express app, Lambda-only settings
  main.ts            entry point on your computer / own server: starts the server, graceful shutdown
  app.ts             Express routes only
  config.ts          settings from environment variables, validated with zod
  bitrix.ts          Bitrix24 REST calls and error handling
  razorpay.ts        Razorpay API calls, paise conversion, error handling
  paymentLinks.ts    flow 1: create a link for a deal (+ the file-based unresolved-links store)
  recurringLinks.ts  the Recurring pipeline: one renewal link per year, reused by all reminders
  webhookHandler.ts  flow 2: signature, duplicates, finding the deal, comment text (+ the file-based event store)
  storage.ts         the three things the service remembers, as contracts (+ the in-memory deal lock)
  dynamoStorage.ts   the DynamoDB versions of those contracts, used on Lambda
  createStorage.ts   picks files or DynamoDB (DYNAMODB_TABLE)
  models.ts          request/response shapes and webhook schemas (zod)
scripts/
  listFields.ts      npm run list-fields
  listPipelines.ts   npm run list-pipelines
  checkSetup.ts      npm run check-setup
  sendTestWebhook.ts npm run send-webhook
  buildLambda.mjs    npm run build:lambda
  test.mjs           npm test (fixes the Windows drive-letter issue, then runs vitest)
tests/               automated tests (vitest) against fake Bitrix24, Razorpay and DynamoDB
template.yaml        what AWS creates: function, URL, table, logs, permission (SAM)
.env.example         every setting, with placeholder values

Created on your computer, git-ignored:
.env                 your settings and secrets
data/                the local service's records; keep it between restarts
dist-lambda/         the built Lambda code (npm run build:lambda)
samconfig.toml       your sam deploy answers, including secrets
```
