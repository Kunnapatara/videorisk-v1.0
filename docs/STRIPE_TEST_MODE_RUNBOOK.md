# VideoRisk v1.0 — Stripe Test Mode End-to-End Verification Runbook (WS4)

> **Verification Boundary Statement:**
> The automated test suite (`npm run test:billing`) exercises real Stripe HMAC webhook signature verification (`Stripe.webhooks.generateTestHeaderString` / `webhooks.constructEvent`) and real SQLite database transactions against **mocked Stripe SDK responses**. Live Stripe Test Mode API calls (`sk_test_...`) and Stripe CLI webhooks are **BLOCKED** in isolated environments without Stripe Test credentials.
> You MUST complete this runbook in an authorized staging environment before claiming `LIVE_E2E_VERIFIED` for Stripe billing.

---

## 1. Prerequisites & Required Environment Variables

Configure the following in a staging `.env` file (never commit secrets or test keys into Git):

```bash
NODE_ENV=production
APP_BASE_URL=https://staging.example.com
PAYMENT_PROVIDER=stripe

# Live Stripe Test Mode credentials (sk_test_... / whsec_...)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Stripe Price IDs created in your Stripe Test Mode Dashboard
STRIPE_PRICE_AUDIT_ONCE=price_...
STRIPE_PRICE_CREATOR=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_AGENCY=price_...
```

Validate configuration fail-closed before starting the server:

```bash
npx tsx scripts/validate-env.ts --mode=production
```

Confirm billing readiness via HTTP:

```bash
curl -s http://localhost:3000/api/health/readiness | jq '.checks.billing'
```

Expected: `"status": "healthy"`, `"checkoutAvailable": true`, `"webhooksAvailable": true`.

---

## 2. Stripe Webhook Tunnel Setup (`stripe listen`)

Start the VideoRisk server (`npm run dev` or `npm start`) and forward Stripe Test Mode events to `/api/webhooks/stripe`:

```bash
stripe login
stripe listen --forward-to http://localhost:3000/api/webhooks/stripe
```

Copy the temporary webhook signing secret (`whsec_...`) output by `stripe listen` into `STRIPE_WEBHOOK_SECRET` and restart the server.

---

## 3. End-to-End Verification Checklist (Stripe Test Mode)

### Case 1: Invalid / Tampered Webhook Signature (Must Reject 400)
```bash
curl -i -X POST http://localhost:3000/api/webhooks/stripe \
  -H "Content-Type: application/json" \
  -H "stripe-signature: t=1700000000,v1=invalid_signature" \
  -d '{"id":"evt_invalid","type":"checkout.session.completed"}'
```
- **Expected:** HTTP `400`, zero database mutations.

### Case 2: Checkout Session Creation & Paid Fulfillment
1. Authenticate a test user and call `POST /api/billing/create-checkout-session` with `{ "planId": "pro" }`.
2. Complete checkout in the returned Stripe Test Mode URL using test card `4242 4242 4242 4242`.
3. Observe Stripe CLI forwarding `checkout.session.completed` -> HTTP `200`.
4. Verify `/api/billing/verify-session?sessionId=<cs_test_...>` returns `status: "complete"`, `entitlementActive: true`.
5. Confirm SQLite state:
   ```bash
   sqlite3 data/videorisk.db "SELECT id, plan, credits_remaining, subscription_id, subscription_status FROM users;"
   sqlite3 data/videorisk.db "SELECT id, plan_id, status, last_event_created, cancel_at_period_end FROM subscriptions;"
   sqlite3 data/videorisk.db "SELECT id, status, credits_granted, amount_total FROM stripe_payments;"
   ```

### Case 3: Subscription Renewal (`invoice.paid`) & Duplicate Invoice Protection
Trigger or wait for a billing cycle event (`invoice.paid` with `billing_reason=subscription_cycle`), then replay the exact invoice with a new webhook event via `stripe trigger invoice.paid` (or re-send in Dashboard):
- Confirm `credits_remaining` increments **once** per unique `invoice.id`.
- Confirm `credit_transactions` contains a single `STRIPE_RENEWAL` entry for `inv_paid_<invoice_id>`.

### Case 4: Payment Action Required (`invoice.payment_action_required`) & Failed Payment (`invoice.payment_failed`)
Test SCA / 3DS card (`4000 0025 0000 3155`) or failing card (`4000 0000 0000 0002`):
- Confirm `invoice.payment_action_required` sets subscription status to `incomplete`.
- Confirm `invoice.payment_failed` sets subscription status to `past_due`.
- Confirm `subscriptions.last_event_created` strictly matches the latest Stripe `event.created` Unix timestamp.

### Case 5: Cancel at Period End & Immediate Cancellation (`customer.subscription.updated` / `deleted`)
1. Toggle cancel at period end in Stripe Customer Portal (`POST /api/billing/create-portal-session`).
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
   sqlite3 data/videorisk.db "SELECT type, delta, balance_after, reference_id FROM credit_transactions ORDER BY id DESC LIMIT 10;"
   ```

---

## 4. Sign-Off Evidence Record

Record before releasing billing changes:
- Stripe CLI / Test Mode Event IDs (`evt_...`)
- Checkout Session (`cs_test_...`), Subscription (`sub_...`), Invoice (`in_...`), Charge/Refund (`re_...`) IDs
- SQLite row snapshots before and after each transition
