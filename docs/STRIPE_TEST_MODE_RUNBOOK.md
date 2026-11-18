# VideoRisk v1.0 — Stripe Test Mode End-to-End Verification Runbook (Staging WS4)

> **Verification Boundary Statement:**
> The automated test suite (`npm run test:billing`) exercises real Stripe HMAC webhook signature verification (`Stripe.webhooks.generateTestHeaderString` / `webhooks.constructEvent`) and real SQLite database transactions against **mocked Stripe SDK responses**. Live Stripe Test Mode API calls (`sk_test_...`) and Stripe CLI webhooks are **NOT VERIFIED** in isolated environments without Stripe Test credentials.
> You MUST complete this runbook in an authorized staging environment before claiming real Stripe Test Mode E2E verification.

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

# Optional pre-created Stripe Test Mode Price IDs (if omitted in staging, dynamic test line items are used)
STRIPE_PRICE_AUDIT_ONCE=price_...
STRIPE_PRICE_CREATOR=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_AGENCY=price_...
```

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

## 3. End-to-End Verification Checklist (Stripe Test Mode)

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
