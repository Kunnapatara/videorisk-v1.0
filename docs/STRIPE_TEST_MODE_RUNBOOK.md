# VideoRisk v1.0 — Stripe Test Mode End-to-End Verification Runbook (Staging WS4)

> **Verification Boundary & Status Taxonomy:**
> This project strictly enforces the following verification status labels and prohibits claiming `SYNTHETIC TEST PASS` as `REAL STRIPE DELIVERY VERIFIED`:
> - **`PASS`** — Deterministic offline/CI safety guard, schema, route, or API session-creation check passed.
> - **`SYNTHETIC TEST PASS`** — Category 1 test passed using Stripe Test APIs + locally crafted HMAC events (`stripe.webhooks.generateTestHeaderString()`). **Does NOT prove real Stripe Checkout completion or genuine Stripe webhook delivery.**
> - **`REAL STRIPE DELIVERY VERIFIED`** — Category 2 end-to-end verification completed: actual Stripe Test Mode Checkout payment (`status=complete`, `payment_status=paid`, `livemode=false`) + genuine Stripe-delivered webhook (`evt_...` via `stripe listen` or staging endpoint) + full SQLite correlation (`users`, `subscriptions`, `stripe_payments`, `credit_transactions`).
> - **`BLOCKED`** — Real external credentials (`STRIPE_SECRET_KEY=sk_test_...`, `STRIPE_WEBHOOK_SECRET=whsec_...`), browser Checkout completion, or `stripe listen` delivery unavailable in the current environment (`exitCode=2`).
> - **`NOT VERIFIED`** — Not executed yet in the specified category.
>
> In isolated CI/container environments without `sk_test_...`, `whsec_...`, browser checkout, and Stripe CLI, **Real Checkout Completion** and **Real Stripe Webhook Delivery** remain **`BLOCKED` / `NOT VERIFIED`**.

---

## 1. Prerequisites & Required Staging Environment Variables

VideoRisk separates runtime build/security hardening from billing mode via `DEPLOYMENT_ENV`:

- `DEPLOYMENT_ENV=staging` permits `NODE_ENV=production` + `PAYMENT_MODE=test` + `STRIPE_SECRET_KEY=sk_test_...` so the built app (`npm run build && npm start`) runs with production hardening (static `dist/`, no Vite dev middleware, no demo account seeding, no `devResetToken` response field, strict HTTPS origins, required `MEDIA_TOKEN_SECRET`, cryptographic webhook verification, and zero simulation fallback) while using Stripe Test Mode credentials.
- `DEPLOYMENT_ENV=staging` **rejects** live keys (`sk_live_...` / `rk_live_...`), `PAYMENT_MODE=live`, and cannot override platform production flags such as `VERCEL_ENV=production`, `RAILWAY_ENVIRONMENT=production`, or `RENDER_ENV=production`.
- `DEPLOYMENT_ENV=production` (or live payment signals) **requires** `sk_live_...` / `rk_live_...` and **rejects** `sk_test_...`.

Configure the following in your staging environment (never commit real keys or `.env` files to Git):

```bash
NODE_ENV=production
DEPLOYMENT_ENV=staging
APP_BASE_URL=https://staging.example.com
PAYMENT_PROVIDER=stripe
PAYMENT_MODE=test

# Strong >=32 character secret for media access token signing
MEDIA_TOKEN_SECRET=replace_with_at_least_32_char_random_hex_secret

# Real Stripe Test Mode credentials (sk_test_... / whsec_...)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Recommended for staging so customer.subscription.created/updated webhooks map prices cleanly without rejected_unmapped_price
STRIPE_PRICE_AUDIT_ONCE=price_...
STRIPE_PRICE_CREATOR=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_AGENCY=price_...
```

> **Note on `STRIPE_PRICE_*`:** `POST /api/billing/checkout` falls back to inline `price_data` if `STRIPE_PRICE_*` vars are omitted in staging, which works for `checkout.session.completed` (via `session.metadata.planId`). However, configuring pre-created Stripe Test Mode `STRIPE_PRICE_CREATOR`, `STRIPE_PRICE_PRO`, and `STRIPE_PRICE_AGENCY` IDs is strongly recommended so subsequent `customer.subscription.created` / `updated` webhooks resolve the exact plan without `rejected_unmapped_price`.

Validate staging configuration fail-closed before building or starting the server:

```bash
npm run validate:env -- --mode=staging
```

Build and start the production Node 22 bundle (no `tsx` dev dependency needed at runtime):

```bash
npm run build
npm start
```

Confirm billing & runtime readiness via HTTP:

```bash
curl -s http://localhost:3000/api/health/readiness | jq '.checks.billing'
```

Expected: `"status": "healthy"`, `"isStagingMode": true`, `"requiresLivePayments": false`, `"checkoutAvailable": true`, `"webhooksAvailable": true`.

---

## 2. Stripe Webhook Tunnel Setup (`stripe listen`)

With the built VideoRisk server running (`npm start`), forward Stripe Test Mode events to the real webhook route `/api/billing/webhook`:

```bash
stripe login
stripe listen --forward-to http://localhost:3000/api/billing/webhook
```

Copy the temporary webhook signing secret (`whsec_...`) output by `stripe listen` into `STRIPE_WEBHOOK_SECRET` and restart the server (`npm start`).

---

## 3. End-to-End Verification Checklist (Category 2: Real Stripe Test Mode)

### Case 1: Invalid / Tampered Webhook Signature (Must Reject 400)
```bash
curl -i -X POST http://localhost:3000/api/billing/webhook \
  -H "Content-Type: application/json" \
  -H "stripe-signature: t=1700000000,v1=invalid_signature" \
  -d '{"id":"evt_invalid","type":"checkout.session.completed"}'
```
- **Expected:** HTTP `400`, zero database mutations.

### Case 2: Checkout Session Creation & Paid Fulfillment
1. Authenticate a test user (`POST /api/auth/register` or `/api/auth/login`) and call `POST /api/billing/checkout` with `{ "planId": "pro" }` (and `Authorization: Bearer <token>`).
2. Complete checkout in the returned Stripe Test Mode URL using test card `4242 4242 4242 4242`.
3. Observe Stripe CLI forwarding `checkout.session.completed` to `POST /api/billing/webhook` -> HTTP `200`.
4. Verify `GET /api/billing/session-status?sessionId=<cs_test_...>` (authenticated) returns `status: "complete"`, `paymentStatus: "paid"`, `entitlementActive: true`, `livemode: false`.
5. Note: `GET /api/billing/session-status?...&mode=simulation` MUST return `403 Forbidden` in staging.
6. Confirm SQLite state:
   ```bash
   sqlite3 data/videorisk.db "SELECT id, plan, credits_remaining, subscription_id, subscription_status FROM users;"
   sqlite3 data/videorisk.db "SELECT id, plan_id, status, last_event_created, cancel_at_period_end FROM subscriptions;"
   sqlite3 data/videorisk.db "SELECT id, status, credits_granted, amount_total FROM stripe_payments;"
   ```

### Case 3: Subscription Renewal (`invoice.paid`) & Duplicate Invoice Protection
Trigger or wait for a billing cycle event (`invoice.paid` with `billing_reason=subscription_cycle`), then replay the exact invoice webhook event:
- Confirm `credits_remaining` increments **once** per unique `invoice.id`.
- Confirm `credit_transactions` contains a single `SUBSCRIPTION_RENEWAL` entry referencing the invoice ID.

### Case 4: Payment Action Required (`invoice.payment_action_required`) & Failed Payment (`invoice.payment_failed`)
Test SCA / 3DS card (`4000 0025 0000 3155`) or failing card (`4000 0000 0000 0002`):
- Confirm `invoice.payment_action_required` sets subscription status to `incomplete`.
- Confirm `invoice.payment_failed` sets subscription status to `past_due`.
- Confirm `subscriptions.last_event_created` strictly matches the latest Stripe `event.created` Unix timestamp.

### Case 5: Cancel at Period End & Immediate Cancellation (`customer.subscription.updated` / `deleted`)
1. Open Stripe Customer Portal via `POST /api/billing/create-portal-session` (with `{ "returnUrl": "https://staging.example.com/?view=pricing" }`) and schedule cancel at period end.
2. Confirm `subscriptions.cancel_at_period_end = 1` while `plan` remains active through `current_period_end`.
3. Cancel subscription immediately in Stripe Dashboard (`customer.subscription.deleted`).
4. Confirm `subscriptions.status = 'canceled'` and `users.plan = 'free'` (unless the user holds a second independent active subscription).

### Case 6: Partial & Full Refund Lifecycle (`charge.refunded` / `refund.created` / `refund.updated`)
1. Issue a **50% partial refund** in Stripe Dashboard on the Pro payment:
   - Confirm proportional credits deducted via exact integer-cent math, payment status `'partially_refunded'`, plan remains active.
2. Issue the **remaining 50% refund** (100% cumulative):
   - Confirm remaining credits clawed back cleanly, payment status `'refunded'`, subscription `'canceled'`, user downgraded to `'free'`.
3. Inspect refund ledger:
   ```bash
   sqlite3 data/videorisk.db "SELECT refund_id, status, reconciled, amount_refunded, credits_adjusted, last_event_created FROM stripe_refunds;"
   sqlite3 data/videorisk.db "SELECT type, delta, balance_after, reference_id FROM credit_transactions ORDER BY rowid DESC LIMIT 10;"
   ```

---

## 4. Sign-Off Evidence Record

Record before signing off staging Stripe verification:
- Stripe CLI / Test Mode Event IDs (`evt_...`)
- Checkout Session (`cs_test_...`), Subscription (`sub_...`), Invoice (`in_...`), Charge/Refund (`re_...`) IDs
- SQLite row snapshots before and after each transition

---

## 5. Automated Verification Harness (`scripts/verify-stripe-test-mode-e2e.ts`)

The repository includes an isolated, non-destructive verification harness (`scripts/verify-stripe-test-mode-e2e.ts`) that strictly separates **Category 1 (Synthetic Webhook + API)** from **Category 2 (Real Checkout-to-Webhook)**:

```bash
# Offline preflight only (verifies safety guards, rawBody server middleware, auth & SQLite billing schema; exit 0 PASS)
npm run verify:stripe:e2e -- --preflight-only --json

# Category 1: Automated Stripe Test API + Explicitly Labeled Synthetic Webhook Tests (SYNTHETIC TEST PASS)
# - Creates Checkout Session via POST /api/billing/checkout, checks open/unpaid state & User B 403 isolation
# - Exercises Stripe Test API Customer/PaymentMethod/Subscription/Refund/Cancel calls
# - Signs synthetic events locally with generateTestHeaderString()
# - Always reports realCheckoutCompletionVerified=false and realStripeWebhookDeliveryVerified=false
STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
  npm run verify:stripe:e2e -- --mode=synthetic-api

# Category 2A: Real Stripe Checkout-to-Webhook Verification with interactive wait window (REAL STRIPE DELIVERY VERIFIED)
# Terminal 1: stripe listen --forward-to http://127.0.0.1:3000/api/billing/webhook
# Terminal 2:
STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
  npm run verify:stripe:e2e -- --mode=real-checkout --listen-port=3000 --wait-seconds=180
# Complete the printed Checkout URL with Stripe test card 4242 4242 4242 4242.

# Category 2B: Verify an already-completed staging Checkout Session + SQLite DB correlation
STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
  npm run verify:stripe:e2e -- --mode=real-checkout --session-id=cs_test_... --db-path=/tmp/staging_verify.db

# CI-safe safety-guard & harness contract test suite (enforced in .github/workflows/ci.yml)
npm run test:stripe:harness
```

Safety guarantees enforced before any execution:
- Refuses `sk_live_...` / `rk_live_...`, `PAYMENT_MODE=live`, `PAYMENT_MODE=production`, and `DEPLOYMENT_ENV=production` (exit `1`).
- Always runs against a dedicated ephemeral SQLite database inside `os.tmpdir()` (refuses `data/videorisk.db`, exit `1`).
- Exits cleanly with code `2` (`BLOCKED — AWAITING ENV`) when `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` are absent — never claims mocked or synthetic behavior as `REAL STRIPE DELIVERY VERIFIED`.
- In `--mode=real-checkout`, exits with code `2` (`BLOCKED`) if real Checkout has not completed (`status=complete`, `payment_status=paid`) or if genuine `evt_...` webhook delivery has not arrived — never fabricates synthetic webhooks.
