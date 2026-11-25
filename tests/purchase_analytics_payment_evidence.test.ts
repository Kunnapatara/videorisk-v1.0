import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Stripe from 'stripe';
import { enforceTestDatabaseIsolation } from '../src/server/storage/testIsolation';
import { SqliteStorageRepository } from '../src/server/storage/sqliteStorage';
import { BillingService } from '../src/server/services/billingService';
import { analyticsService } from '../src/server/services/analyticsService';

function signStripeEvent(realStripe: Stripe, secret: string, payloadObj: Record<string, any>) {
  const payloadStr = JSON.stringify(payloadObj);
  const signature = realStripe.webhooks.generateTestHeaderString({
    payload: payloadStr,
    secret,
  });
  return { payloadBuf: Buffer.from(payloadStr, 'utf-8'), signature };
}

export async function runPurchaseAnalyticsPaymentEvidenceTests(): Promise<void> {
  process.env.VIDEORISK_TEST_RUN = 'true';
  enforceTestDatabaseIsolation();

  console.log('\n======================================================');
  console.log('SUITE 29: PURCHASE ANALYTICS PAYMENT EVIDENCE');
  console.log('Checkout, Invoices, Upgrades, Unpaid, Idempotency, OOO, Refunds');
  console.log('======================================================');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videorisk-purchase-evidence-'));
  const dbPath = path.join(tempDir, 'purchase_evidence.db');
  const repo = new SqliteStorageRepository(dbPath, {
    NODE_ENV: 'test',
    VIDEORISK_TEST_RUN: 'true',
  });

  const savedEnv = {
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRICE_CREATOR: process.env.STRIPE_PRICE_CREATOR,
    STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
    STRIPE_PRICE_AGENCY: process.env.STRIPE_PRICE_AGENCY,
    STRIPE_PRICE_AUDIT_ONCE: process.env.STRIPE_PRICE_AUDIT_ONCE,
    APP_BASE_URL: process.env.APP_BASE_URL,
    ALLOW_SIMULATION_WEBHOOK: process.env.ALLOW_SIMULATION_WEBHOOK,
  };

  const webhookSecret = 'whsec_test_purchase_evidence_1234567890';
  const realStripeHmac = new Stripe('sk_test_purchase_evidence_hmac_1234567890', {
    apiVersion: '2025-02-24.acacia' as any,
    typescript: true,
  });

  const sessionRegistry = new Map<string, any>();
  const mockStripeClient: any = {
    webhooks: {
      constructEvent: (rawBody: Buffer, sig: string, secret: string) =>
        realStripeHmac.webhooks.constructEvent(rawBody, sig, secret),
    },
    checkout: {
      sessions: {
        retrieve: async (sessionId: string) => {
          const s = sessionRegistry.get(sessionId);
          if (!s) throw new Error(`Mock session not found: ${sessionId}`);
          return s;
        },
      },
    },
  };

  process.env.STRIPE_SECRET_KEY = 'sk_test_purchase_evidence_key_1234567890';
  process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
  process.env.STRIPE_PRICE_CREATOR = 'price_creator';
  process.env.STRIPE_PRICE_PRO = 'price_pro';
  process.env.STRIPE_PRICE_AGENCY = 'price_agency';
  process.env.STRIPE_PRICE_AUDIT_ONCE = 'price_audit_once';
  process.env.APP_BASE_URL = 'http://localhost:3000';
  process.env.ALLOW_SIMULATION_WEBHOOK = 'false';

  const billing = new BillingService();
  billing.setStorageForTest(repo);
  billing.setStripeClientForTest(mockStripeClient);

  const nowSec = Math.floor(Date.now() / 1000);

  const sendWebhook = async (eventObj: Record<string, any>) => {
    const signed = signStripeEvent(realStripeHmac, webhookSecret, eventObj);
    return billing.handleWebhook(signed.payloadBuf, signed.signature);
  };

  const getPurchases = async (userId: string) => {
    return analyticsService.queryEvents({ userId, eventName: 'purchase_completed', order: 'asc' }, repo);
  };

  try {
    // -------------------------------------------------------------------------
    // 1. subscription.created / subscription.updated NEVER emit purchase_completed
    // -------------------------------------------------------------------------
    console.log('\n[1. Subscription Lifecycle Events Without Payment Evidence]');
    const subOnlyUser = await repo.users.createUser('subonly@videorisk.test', 'hash', 'salt', 10, 'free');
    const subOnlyId = 'sub_only_001';
    const cusOnlyId = 'cus_only_001';

    await sendWebhook({
      id: 'evt_sub_created_active',
      created: nowSec + 1,
      type: 'customer.subscription.created',
      data: {
        object: {
          id: subOnlyId,
          customer: cusOnlyId,
          status: 'active',
          current_period_end: nowSec + 86400 * 30,
          metadata: { userId: subOnlyUser.id },
          items: { data: [{ price: { id: 'price_creator' } }] },
        },
      },
    });

    let updatedUser = await repo.users.getUser(subOnlyUser.id);
    assert.strictEqual(updatedUser?.plan, 'creator', 'Subscription created syncs user plan entitlement');
    assert.strictEqual((await getPurchases(subOnlyUser.id)).total, 0, 'customer.subscription.created must NEVER emit purchase_completed');

    // Status transitions trialing -> past_due -> active without payment invoice
    await sendWebhook({
      id: 'evt_sub_upd_trialing',
      created: nowSec + 2,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subOnlyId,
          customer: cusOnlyId,
          status: 'trialing',
          current_period_end: nowSec + 86400 * 30,
          items: { data: [{ price: { id: 'price_creator' } }] },
        },
      },
    });
    await sendWebhook({
      id: 'evt_sub_upd_active_again',
      created: nowSec + 3,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subOnlyId,
          customer: cusOnlyId,
          status: 'active',
          current_period_end: nowSec + 86400 * 30,
          items: { data: [{ price: { id: 'price_creator' } }] },
        },
      },
    });
    assert.strictEqual((await getPurchases(subOnlyUser.id)).total, 0, 'Status transition to active must NOT emit purchase_completed');

    // Plan upgrade via customer.subscription.updated (creator -> agency, status='active') WITHOUT paid invoice
    await sendWebhook({
      id: 'evt_sub_upd_upgrade_unpaid',
      created: nowSec + 4,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subOnlyId,
          customer: cusOnlyId,
          status: 'active',
          current_period_end: nowSec + 86400 * 30,
          items: { data: [{ price: { id: 'price_agency' } }] },
        },
      },
    });
    updatedUser = await repo.users.getUser(subOnlyUser.id);
    assert.strictEqual(updatedUser?.plan, 'agency', 'Subscription state synced to agency');
    assert.strictEqual(updatedUser?.creditsRemaining, 10, 'Subscription update does not grant extra credits');
    assert.strictEqual(
      (await getPurchases(subOnlyUser.id)).total,
      0,
      'Plan upgrade via customer.subscription.updated with status=active must NOT emit purchase_completed'
    );

    // Replay with distinct event ID
    await sendWebhook({
      id: 'evt_sub_upd_upgrade_unpaid_replay',
      created: nowSec + 5,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subOnlyId,
          customer: cusOnlyId,
          status: 'active',
          current_period_end: nowSec + 86400 * 30,
          items: { data: [{ price: { id: 'price_agency' } }] },
        },
      },
    });
    assert.strictEqual((await getPurchases(subOnlyUser.id)).total, 0);
    console.log('  ✅ PASS: Subscription created/updated sync entitlements cleanly without emitting purchase_completed');

    // -------------------------------------------------------------------------
    // 2. Unpaid / Incomplete / Pending Checkouts & Invoices Rejected
    // -------------------------------------------------------------------------
    console.log('\n[2. Unpaid, Incomplete, Failed & $0 Payments Rejected]');
    const unpaidUser = await repo.users.createUser('unpaid@videorisk.test', 'hash', 'salt', 10, 'free');

    // Unpaid / open / expired / processing checkouts via webhook
    const badCheckouts = [
      { id: 'cs_bad_unpaid', status: 'complete', payment_status: 'unpaid' },
      { id: 'cs_bad_open', status: 'open', payment_status: 'paid' },
      { id: 'cs_bad_expired', status: 'expired', payment_status: 'paid' },
      {
        id: 'cs_bad_pi_processing',
        status: 'complete',
        payment_status: 'paid',
        payment_intent: { id: 'pi_bad_proc', status: 'processing' },
      },
      {
        id: 'cs_bad_pi_failed',
        status: 'complete',
        payment_status: 'paid',
        payment_intent: { id: 'pi_bad_fail', status: 'requires_payment_method' },
      },
    ];

    for (let i = 0; i < badCheckouts.length; i++) {
      const s = badCheckouts[i];
      sessionRegistry.set(s.id, {
        ...s,
        client_reference_id: unpaidUser.id,
        amount_total: 2900,
        currency: 'usd',
        metadata: { userId: unpaidUser.id, planId: 'pro' },
        livemode: false,
      });

      const syncRes = await billing.verifyAndSynchronizeSession(s.id, unpaidUser.id);
      assert.strictEqual(syncRes.entitlementActive, false, `verifyAndSynchronizeSession rejects ${s.id}`);

      await sendWebhook({
        id: `evt_bad_cs_${i}`,
        created: nowSec + 10 + i,
        type: 'checkout.session.completed',
        data: { object: sessionRegistry.get(s.id) },
      });
    }

    let unpaidUserAfter = await repo.users.getUser(unpaidUser.id);
    assert.strictEqual(unpaidUserAfter?.plan, 'free');
    assert.strictEqual(unpaidUserAfter?.creditsRemaining, 10);
    assert.strictEqual((await getPurchases(unpaidUser.id)).total, 0);

    // Seed an active subscription for unpaidUser to test bad invoice.paid & failure payloads
    await sendWebhook({
      id: 'evt_unpaid_user_sub_seed',
      created: nowSec + 20,
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_bad_inv_001',
          customer: 'cus_bad_inv_001',
          status: 'active',
          current_period_end: nowSec + 86400 * 30,
          metadata: { userId: unpaidUser.id },
          items: { data: [{ price: { id: 'price_pro' } }] },
        },
      },
    });

    const badInvoices = [
      { id: 'in_bad_paid_false', paid: false, status: 'open', amount_paid: 0, amount_due: 2900 },
      { id: 'in_bad_status_open', paid: true, status: 'open', amount_paid: 2900, amount_due: 2900 },
      { id: 'in_bad_status_draft', paid: true, status: 'draft', amount_paid: 2900, amount_due: 2900 },
      { id: 'in_bad_status_uncollectible', status: 'uncollectible', amount_paid: 0, amount_due: 2900 },
      { id: 'in_bad_amount_zero_due', paid: true, status: 'paid', amount_paid: 0, amount_due: 2900 },
      {
        id: 'in_bad_pi_action',
        paid: true,
        status: 'paid',
        amount_paid: 2900,
        payment_intent: { id: 'pi_in_act', status: 'requires_action' },
      },
      {
        id: 'in_bad_charge_pending',
        paid: true,
        status: 'paid',
        amount_paid: 2900,
        charge: { id: 'ch_in_pend', status: 'pending' },
      },
    ];

    for (let i = 0; i < badInvoices.length; i++) {
      await sendWebhook({
        id: `evt_bad_inv_${i}`,
        created: nowSec + 30 + i,
        type: 'invoice.paid',
        data: {
          object: {
            subscription: 'sub_bad_inv_001',
            customer: 'cus_bad_inv_001',
            billing_reason: 'subscription_cycle',
            currency: 'usd',
            lines: { data: [{ price: { id: 'price_pro' }, amount: badInvoices[i].amount_paid }] },
            ...badInvoices[i],
          },
        },
      });
    }

    // Payment failed and action required webhooks
    await sendWebhook({
      id: 'evt_inv_pay_failed',
      created: nowSec + 50,
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_fail_001', subscription: 'sub_bad_inv_001', customer: 'cus_bad_inv_001' } },
    });
    await sendWebhook({
      id: 'evt_inv_pay_action_req',
      created: nowSec + 51,
      type: 'invoice.payment_action_required',
      data: { object: { id: 'in_act_001', subscription: 'sub_bad_inv_001', customer: 'cus_bad_inv_001' } },
    });

    unpaidUserAfter = await repo.users.getUser(unpaidUser.id);
    assert.strictEqual(unpaidUserAfter?.creditsRemaining, 10, 'Unpaid/pending/failed invoices must not grant renewal credits');
    assert.strictEqual((await getPurchases(unpaidUser.id)).total, 0, 'Unpaid/pending/failed events emit 0 purchase_completed');

    // $0 paid invoice (e.g., 100% coupon / $0 amount_due & amount_paid) must NOT emit purchase_completed
    await sendWebhook({
      id: 'evt_zero_inv_cycle',
      created: nowSec + 52,
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_zero_amount',
          subscription: 'sub_bad_inv_001',
          customer: 'cus_bad_inv_001',
          billing_reason: 'subscription_cycle',
          paid: true,
          status: 'paid',
          amount_paid: 0,
          amount_due: 0,
          currency: 'usd',
          lines: { data: [{ price: { id: 'price_pro' }, amount: 0 }] },
        },
      },
    });
    assert.strictEqual((await getPurchases(unpaidUser.id)).total, 0, '$0 invoice must NOT emit purchase_completed');
    console.log('  ✅ PASS: All unpaid, incomplete, pending, failed, and $0 payments withheld purchase_completed');

    // -------------------------------------------------------------------------
    // 3. Authoritative Checkout, Renewal, Upgrade, Downgrade & Idempotency
    // -------------------------------------------------------------------------
    console.log('\n[3. Verified Checkout, Renewal, Upgrade, Downgrade & Duplicate Delivery]');
    const buyer = await repo.users.createUser('buyer@videorisk.test', 'hash', 'salt', 10, 'free');
    const subId = 'sub_buyer_001';
    const cusId = 'cus_buyer_001';

    // 3A. Initial subscription checkout via session sync + webhook race
    const initSession = {
      id: 'cs_buyer_init_pro',
      client_reference_id: buyer.id,
      customer: cusId,
      subscription: subId,
      payment_intent: { id: 'pi_buyer_init_pro', status: 'succeeded' },
      invoice: 'in_buyer_init_pro',
      payment_status: 'paid',
      status: 'complete',
      amount_total: 2900,
      currency: 'usd',
      metadata: { userId: buyer.id, planId: 'pro' },
      livemode: false,
    };
    sessionRegistry.set(initSession.id, initSession);

    const syncInit = await billing.verifyAndSynchronizeSession(initSession.id, buyer.id);
    assert.strictEqual(syncInit.entitlementActive, true);
    await sendWebhook({
      id: 'evt_buyer_init_cs',
      created: nowSec + 100,
      type: 'checkout.session.completed',
      data: { object: initSession },
    });
    // Initial invoice.paid (billing_reason='subscription_create') must NOT emit a duplicate purchase
    await sendWebhook({
      id: 'evt_buyer_init_inv',
      created: nowSec + 101,
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_buyer_init_pro',
          customer: cusId,
          subscription: subId,
          payment_intent: 'pi_buyer_init_pro',
          charge: 'ch_buyer_init_pro',
          billing_reason: 'subscription_create',
          paid: true,
          status: 'paid',
          amount_paid: 2900,
          currency: 'usd',
          lines: { data: [{ price: { id: 'price_pro' }, amount: 2900 }] },
        },
      },
    });

    let buyerPurchases = await getPurchases(buyer.id);
    assert.strictEqual(buyerPurchases.total, 1, 'Initial checkout sync + webhook + initial invoice produces 1 purchase_completed');
    assert.strictEqual(buyerPurchases.events[0].properties.purchaseType, 'subscription_purchase');
    assert.strictEqual(buyerPurchases.events[0].properties.planId, 'pro');
    assert.strictEqual(buyerPurchases.events[0].properties.amountMinorUnits, 2900);
    assert.strictEqual((await repo.users.getUser(buyer.id))?.creditsRemaining, 85, '10 starter + 75 pro = 85');

    // 3B. One-time credit purchase (audit_once) + duplicate delivery with new event ID
    const auditSession = {
      id: 'cs_buyer_audit_once',
      client_reference_id: buyer.id,
      customer: cusId,
      payment_intent: { id: 'pi_buyer_audit_once', status: 'succeeded' },
      payment_status: 'paid',
      status: 'complete',
      amount_total: 999,
      currency: 'usd',
      metadata: { userId: buyer.id, planId: 'audit_once' },
    };
    await sendWebhook({
      id: 'evt_buyer_audit_1',
      created: nowSec + 110,
      type: 'checkout.session.completed',
      data: { object: auditSession },
    });
    // Exact event retry + distinct event retry for same session
    await sendWebhook({
      id: 'evt_buyer_audit_1',
      created: nowSec + 110,
      type: 'checkout.session.completed',
      data: { object: auditSession },
    });
    await sendWebhook({
      id: 'evt_buyer_audit_2_distinct',
      created: nowSec + 111,
      type: 'checkout.session.completed',
      data: { object: auditSession },
    });

    buyerPurchases = await getPurchases(buyer.id);
    assert.strictEqual(buyerPurchases.total, 2);
    assert.strictEqual(buyerPurchases.events[1].properties.purchaseType, 'credit_purchase');
    assert.strictEqual(buyerPurchases.events[1].properties.planId, 'audit_once');
    assert.strictEqual((await repo.users.getUser(buyer.id))?.creditsRemaining, 145, '85 + 60 audit_once = 145');

    // 3C. Subscription renewal (invoice.paid billing_reason='subscription_cycle') + duplicate delivery
    const renewalInvoice = {
      id: 'in_buyer_renew_1',
      customer: cusId,
      subscription: subId,
      payment_intent: 'pi_buyer_renew_1',
      charge: 'ch_buyer_renew_1',
      billing_reason: 'subscription_cycle',
      paid: true,
      status: 'paid',
      amount_paid: 2900,
      currency: 'usd',
      lines: { data: [{ price: { id: 'price_pro' }, amount: 2900 }] },
    };
    await sendWebhook({
      id: 'evt_buyer_renew_1',
      created: nowSec + 120,
      type: 'invoice.paid',
      data: { object: renewalInvoice },
    });
    // Duplicate same event ID AND distinct event ID for same invoice ID
    await sendWebhook({
      id: 'evt_buyer_renew_1',
      created: nowSec + 120,
      type: 'invoice.paid',
      data: { object: renewalInvoice },
    });
    await sendWebhook({
      id: 'evt_buyer_renew_1_dup_evt',
      created: nowSec + 121,
      type: 'invoice.paid',
      data: { object: renewalInvoice },
    });

    buyerPurchases = await getPurchases(buyer.id);
    assert.strictEqual(buyerPurchases.total, 3);
    assert.strictEqual(buyerPurchases.events[2].properties.purchaseType, 'subscription_renewal');
    assert.strictEqual(buyerPurchases.events[2].properties.planId, 'pro');
    assert.strictEqual(buyerPurchases.events[2].properties.purchaseRef, 'in_buyer_renew_1');
    assert.strictEqual((await repo.users.getUser(buyer.id))?.creditsRemaining, 220, '145 + 75 renewal = 220');

    // 3D. Plan upgrade: customer.subscription.updated (pro -> agency) emits 0; paid invoice.paid (subscription_update) emits plan_upgrade once
    await sendWebhook({
      id: 'evt_buyer_sub_upd_agency',
      created: nowSec + 130,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: cusId,
          status: 'active',
          current_period_end: nowSec + 86400 * 30,
          items: { data: [{ price: { id: 'price_agency' } }] },
        },
      },
    });
    assert.strictEqual((await getPurchases(buyer.id)).total, 3, 'customer.subscription.updated for upgrade emits 0 purchases');

    const upgradeInvoice = {
      id: 'in_buyer_upgrade_1',
      customer: cusId,
      subscription: subId,
      payment_intent: 'pi_buyer_upgrade_1',
      charge: 'ch_buyer_upgrade_1',
      billing_reason: 'subscription_update',
      paid: true,
      status: 'paid',
      amount_paid: 7000,
      currency: 'usd',
      lines: {
        data: [
          { price: { id: 'price_pro' }, amount: -2900 },
          { price: { id: 'price_agency' }, amount: 9900 },
        ],
      },
    };
    await sendWebhook({
      id: 'evt_buyer_upgrade_inv_1',
      created: nowSec + 135,
      type: 'invoice.paid',
      data: { object: upgradeInvoice },
    });
    // Distinct event ID retry on same upgrade invoice must not duplicate
    await sendWebhook({
      id: 'evt_buyer_upgrade_inv_1_retry',
      created: nowSec + 136,
      type: 'invoice.paid',
      data: { object: upgradeInvoice },
    });

    buyerPurchases = await getPurchases(buyer.id);
    assert.strictEqual(buyerPurchases.total, 4);
    assert.strictEqual(buyerPurchases.events[3].properties.purchaseType, 'plan_upgrade');
    assert.strictEqual(buyerPurchases.events[3].properties.planId, 'agency');
    assert.strictEqual(buyerPurchases.events[3].properties.previousPlanId, 'pro');
    assert.strictEqual(buyerPurchases.events[3].properties.amountMinorUnits, 7000);
    assert.strictEqual(buyerPurchases.events[3].properties.purchaseRef, 'in_buyer_upgrade_1');

    // 3E. Plan downgrade (agency -> creator) must NOT emit plan_upgrade
    await sendWebhook({
      id: 'evt_buyer_sub_downgrade',
      created: nowSec + 140,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: cusId,
          status: 'active',
          current_period_end: nowSec + 86400 * 30,
          items: { data: [{ price: { id: 'price_creator' } }] },
        },
      },
    });
    await sendWebhook({
      id: 'evt_buyer_inv_downgrade',
      created: nowSec + 141,
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_buyer_downgrade_1',
          customer: cusId,
          subscription: subId,
          billing_reason: 'subscription_update',
          paid: true,
          status: 'paid',
          amount_paid: 0,
          currency: 'usd',
          lines: { data: [{ price: { id: 'price_creator' }, amount: 0 }] },
        },
      },
    });
    assert.strictEqual((await getPurchases(buyer.id)).total, 4, 'Downgrade emits 0 purchases');
    console.log('  ✅ PASS: Verified checkout, renewal, upgrade, downgrade & duplicate webhook idempotency');

    // -------------------------------------------------------------------------
    // 4. Out-of-Order Events Remain Safe
    // -------------------------------------------------------------------------
    console.log('\n[4. Out-of-Order Event Safety]');
    const oooUser = await repo.users.createUser('ooo_order@videorisk.test', 'hash', 'salt', 10, 'free');
    const oooSubId = 'sub_ooo_order_001';
    const oooCusId = 'cus_ooo_order_001';

    // Initial paid checkout for pro
    await sendWebhook({
      id: 'evt_ooo_init_cs',
      created: nowSec + 200,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_ooo_init_pro',
          client_reference_id: oooUser.id,
          customer: oooCusId,
          subscription: oooSubId,
          payment_intent: 'pi_ooo_init_pro',
          payment_status: 'paid',
          status: 'complete',
          amount_total: 2900,
          currency: 'usd',
          metadata: { userId: oooUser.id, planId: 'pro' },
        },
      },
    });

    // Upgrade invoice.paid arrives BEFORE customer.subscription.updated
    await sendWebhook({
      id: 'evt_ooo_upgrade_inv_first',
      created: nowSec + 220,
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_ooo_upgrade_1',
          customer: oooCusId,
          subscription: oooSubId,
          payment_intent: 'pi_ooo_upgrade_1',
          charge: 'ch_ooo_upgrade_1',
          billing_reason: 'subscription_update',
          paid: true,
          status: 'paid',
          amount_paid: 7000,
          currency: 'usd',
          lines: { data: [{ price: { id: 'price_agency' }, amount: 7000 }] },
        },
      },
    });

    // Delayed older customer.subscription.updated arrives AFTER invoice.paid
    await sendWebhook({
      id: 'evt_ooo_sub_upd_stale',
      created: nowSec + 210,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: oooSubId,
          customer: oooCusId,
          status: 'active',
          current_period_end: nowSec + 86400 * 30,
          items: { data: [{ price: { id: 'price_pro' } }] },
        },
      },
    });

    // Newer customer.subscription.updated arrives confirming agency
    await sendWebhook({
      id: 'evt_ooo_sub_upd_late',
      created: nowSec + 225,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: oooSubId,
          customer: oooCusId,
          status: 'active',
          current_period_end: nowSec + 86400 * 30,
          items: { data: [{ price: { id: 'price_agency' } }] },
        },
      },
    });

    const oooUserAfter = await repo.users.getUser(oooUser.id);
    assert.strictEqual(oooUserAfter?.plan, 'agency', 'Stale subscription.updated must not revert upgraded plan');
    const oooPurchases = await getPurchases(oooUser.id);
    assert.strictEqual(oooPurchases.total, 2, 'Initial subscription_purchase + out-of-order plan_upgrade = 2');
    assert.strictEqual(oooPurchases.events[1].properties.purchaseType, 'plan_upgrade');
    assert.strictEqual(oooPurchases.events[1].properties.previousPlanId, 'pro');
    assert.strictEqual(oooPurchases.events[1].properties.planId, 'agency');

    // Out-of-order full refund BEFORE renewal invoice.paid blocks credits & renewal purchase_completed
    await sendWebhook({
      id: 'evt_ooo_pre_refund_renew',
      created: nowSec + 230,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_ooo_pre_ref',
          payment_intent: 'pi_ooo_pre_ref',
          invoice: 'in_ooo_pre_ref',
          amount: 9900,
          amount_refunded: 9900,
          refunds: { data: [{ id: 're_ooo_pre_ref', amount: 9900, status: 'succeeded' }] },
        },
      },
    });
    await sendWebhook({
      id: 'evt_ooo_renew_after_refund',
      created: nowSec + 235,
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_ooo_pre_ref',
          customer: oooCusId,
          subscription: oooSubId,
          payment_intent: 'pi_ooo_pre_ref',
          charge: 'ch_ooo_pre_ref',
          billing_reason: 'subscription_cycle',
          paid: true,
          status: 'paid',
          amount_paid: 9900,
          currency: 'usd',
          lines: { data: [{ price: { id: 'price_agency' }, amount: 9900 }] },
        },
      },
    });
    assert.strictEqual((await getPurchases(oooUser.id)).total, 2, 'Pre-refunded invoice must NOT emit purchase_completed');
    console.log('  ✅ PASS: Out-of-order invoice.paid, stale subscription.updated & pre-refund protection verified');

    // -------------------------------------------------------------------------
    // 5. Refund Reconciliation Remains Unchanged & Correct
    // -------------------------------------------------------------------------
    console.log('\n[5. Refund Reconciliation Integrity]');
    const refUser = await repo.users.createUser('refund@videorisk.test', 'hash', 'salt', 10, 'free');

    await sendWebhook({
      id: 'evt_ref_buy_audit',
      created: nowSec + 300,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_ref_audit',
          client_reference_id: refUser.id,
          customer: 'cus_ref_001',
          payment_intent: 'pi_ref_audit',
          payment_status: 'paid',
          status: 'complete',
          amount_total: 1000,
          currency: 'usd',
          metadata: { userId: refUser.id, planId: 'audit_once' },
        },
      },
    });
    assert.strictEqual((await repo.users.getUser(refUser.id))?.creditsRemaining, 70);
    assert.strictEqual((await getPurchases(refUser.id)).total, 1);

    // 50% partial refund -> deducts 30 credits
    await sendWebhook({
      id: 'evt_ref_partial_1',
      created: nowSec + 310,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_ref_audit',
          payment_intent: 'pi_ref_audit',
          amount: 1000,
          amount_refunded: 500,
          refunds: { data: [{ id: 're_ref_1', amount: 500, status: 'succeeded' }] },
        },
      },
    });
    assert.strictEqual((await repo.users.getUser(refUser.id))?.creditsRemaining, 40);

    // Remaining 50% refund -> deducts remaining 30 credits
    await sendWebhook({
      id: 'evt_ref_partial_2',
      created: nowSec + 320,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_ref_audit',
          payment_intent: 'pi_ref_audit',
          amount: 1000,
          amount_refunded: 1000,
          refunds: {
            data: [
              { id: 're_ref_1', amount: 500, status: 'succeeded' },
              { id: 're_ref_2', amount: 500, status: 'succeeded' },
            ],
          },
        },
      },
    });
    assert.strictEqual((await repo.users.getUser(refUser.id))?.creditsRemaining, 10, 'Cumulative full refund restores starter balance');
    assert.strictEqual((await getPurchases(refUser.id)).total, 1, 'Refunds never emit extra purchase_completed events');
    console.log('  ✅ PASS: Partial & full refund credit clawback preserved without spurious purchase analytics');

    console.log('\n======================================================');
    console.log('✅ ALL PURCHASE ANALYTICS PAYMENT EVIDENCE TESTS PASSED');
    console.log('======================================================');
  } finally {
    billing.setStorageForTest(null);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    billing.reconfigure();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPurchaseAnalyticsPaymentEvidenceTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ PURCHASE ANALYTICS PAYMENT EVIDENCE TEST FAILED:', err);
      process.exit(1);
    });
}
