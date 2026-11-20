import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import Stripe from 'stripe';
import { storage, InMemoryStorageRepository } from '../src/server/storage';
import { SqliteStorageRepository } from '../src/server/storage/sqliteStorage';
import { billingService } from '../src/server/services/billingService';
import { apiRouter, validateAndGetMediaTokenSecret } from '../src/server/routes/api';
import {
  isForbiddenProductionOriginHostname,
  isLoopbackHostname,
  isProductionEnvironment,
  isUnspecifiedIpv6Hostname,
  resolveEnvironmentSecurity,
  validateMediaTokenSecret,
} from '../src/server/config/environment';
import { validateBillingConfiguration } from '../scripts/validate-env';

function buildSignedWebhookRequest(
  stripeHelper: Stripe,
  secret: string,
  eventPayload: Record<string, any>
): { rawBody: Buffer; payloadStr: string; signature: string } {
  const payloadStr = JSON.stringify(eventPayload);
  const signature = stripeHelper.webhooks.generateTestHeaderString({
    payload: payloadStr,
    secret,
  });
  return { rawBody: Buffer.from(payloadStr, 'utf-8'), payloadStr, signature };
}

export async function runStripeOriginAndRefundLifecycleTests() {
  console.log('\n======================================================');
  console.log('--- CHECKOUT ORIGIN SECURITY & STRIPE REFUND SUITE ---');
  console.log('Redirect Allowlist, Signed Test Webhooks & Refund Lifecycle');
  console.log('======================================================\n');

  const prevEnv = {
    NODE_ENV: process.env.NODE_ENV,
    VIDEORISK_TEST_RUN: process.env.VIDEORISK_TEST_RUN,
    APP_BASE_URL: process.env.APP_BASE_URL,
    APP_URL: process.env.APP_URL,
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    ALLOW_SIMULATION_WEBHOOK: process.env.ALLOW_SIMULATION_WEBHOOK,
    PAYMENT_MODE: process.env.PAYMENT_MODE,
  };

  const restoreEnv = () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    billingService.reconfigure();
  };

  const app = express();
  app.use(express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }));
  app.use('/api', apiRouter);

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  const webhookSecret = 'whsec_test_signing_secret_1234567890abcdef';
  const realStripeHmac = new Stripe('sk_test_dummy_hmac_helper_1234567890', {
    apiVersion: '2025-02-24.acacia' as any,
  });

  const capturedCheckoutParams: any[] = [];
  const capturedPortalParams: any[] = [];
  const sessionRegistry = new Map<string, any>();

  const mockStripeSdk: any = {
    webhooks: {
      constructEvent: (payload: Buffer | string, sig: string, secret: string) =>
        realStripeHmac.webhooks.constructEvent(payload, sig, secret),
    },
    checkout: {
      sessions: {
        create: async (params: any) => {
          capturedCheckoutParams.push(params);
          const id = `cs_test_${Date.now()}_${capturedCheckoutParams.length}`;
          return {
            id,
            url: `https://checkout.stripe.com/c/pay/${id}`,
            livemode: false,
          };
        },
        retrieve: async (id: string) => {
          return sessionRegistry.get(id) || null;
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params: any) => {
          capturedPortalParams.push(params);
          return {
            id: `bps_test_${Date.now()}`,
            url: `https://billing.stripe.com/p/session/test_${Date.now()}`,
          };
        },
      },
    },
  };

  const tempSqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_refund_sqlite_'));

  try {
    billingService.setStripeClientForTest(mockStripeSdk);
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key_1234567890abcdef';
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    delete process.env.ALLOW_SIMULATION_WEBHOOK;

    // ------------------------------------------------------------------------
    // 1. CHECKOUT REDIRECT ORIGIN SECURITY & PORTAL RETURN URL HARDENING
    // ------------------------------------------------------------------------
    console.log('[1. Checkout Redirect Origin Security (Server Allowlist & Fail-Closed)]');

    const originUser = await storage.users.createUser(
      `origin_sec_${Date.now()}@videorisk.test`,
      'hash_orig',
      'salt_orig',
      10,
      'free'
    );
    const originToken = await storage.users.createSession(originUser.id);

    process.env.APP_BASE_URL = 'https://videorisk.com';
    process.env.ALLOWED_ORIGINS = 'https://app.videorisk.com,https://studio.videorisk.com';

    // 1.1 Trusted Origin header succeeds & produces exact success_url/cancel_url
    capturedCheckoutParams.length = 0;
    const validOriginRes = await fetch(`${baseUrl}/billing/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${originToken}`,
        Origin: 'https://app.videorisk.com',
      },
      body: JSON.stringify({ planId: 'pro' }),
    });
    assert.strictEqual(validOriginRes.status, 200, '1.1 Allowlisted Origin permitted');
    assert.strictEqual(
      capturedCheckoutParams[0].success_url,
      'https://app.videorisk.com/?checkout_status=success&session_id={CHECKOUT_SESSION_ID}',
      '1.1a success_url anchored to validated allowlisted origin'
    );
    assert.strictEqual(
      capturedCheckoutParams[0].cancel_url,
      'https://app.videorisk.com/?checkout_status=canceled',
      '1.1b cancel_url anchored to validated allowlisted origin'
    );

    // 1.2 Host header spoofing when Origin is omitted MUST NOT poison Stripe redirect URLs
    capturedCheckoutParams.length = 0;
    const spoofedHostRes = await fetch(`${baseUrl}/billing/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${originToken}`,
        Host: 'evil-phish.com',
        'X-Forwarded-Host': 'evil-phish.com',
      },
      body: JSON.stringify({ planId: 'pro' }),
    });
    assert.strictEqual(spoofedHostRes.status, 200, '1.2 Omitted Origin falls back safely to server canonical APP_BASE_URL');
    assert.strictEqual(
      capturedCheckoutParams[0].success_url,
      'https://videorisk.com/?checkout_status=success&session_id={CHECKOUT_SESSION_ID}',
      '1.2a Spoofed Host & X-Forwarded-Host ignored completely'
    );
    assert.ok(!capturedCheckoutParams[0].success_url.includes('evil-phish.com'), '1.2b Untrusted host never appears in success_url');

    // 1.3 Untrusted Origin header / lookalike / userinfo / protocol-relative / malformed / insecure schemes rejected (400)
    const maliciousHeaderOrigins = [
      { label: 'external origin', val: 'https://attacker.evil.com' },
      { label: 'lookalike suffix', val: 'https://videorisk.com.evil.com' },
      { label: 'lookalike prefix', val: 'https://evil-videorisk.com' },
      { label: 'userinfo @ spoofing', val: 'https://videorisk.com@evil.com' },
      { label: 'protocol-relative //', val: '//evil.com' },
      { label: 'backslash smuggling', val: 'https://videorisk.com\\@evil.com' },
      { label: 'malformed URL', val: 'not-a-valid-url' },
      { label: 'javascript scheme', val: 'javascript:alert(1)' },
      { label: 'insecure http non-localhost', val: 'http://videorisk.com' },
    ];

    for (const testCase of maliciousHeaderOrigins) {
      const r = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${originToken}`,
          Origin: testCase.val,
        },
        body: JSON.stringify({ planId: 'pro' }),
      });
      assert.strictEqual(r.status, 400, `1.3 Rejects ${testCase.label} in Origin header (${testCase.val})`);

      const rBody = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${originToken}`,
        },
        body: JSON.stringify({ planId: 'pro', originUrl: testCase.val }),
      });
      assert.strictEqual(rBody.status, 400, `1.3b Rejects ${testCase.label} in body originUrl (${testCase.val})`);
    }

    // 1.4 Production fail-closed when APP_BASE_URL is missing or insecure/malformed (requires VIDEORISK_TEST_RUN unset)
    process.env.NODE_ENV = 'production';
    delete process.env.VIDEORISK_TEST_RUN;
    delete process.env.APP_BASE_URL;
    delete process.env.APP_URL;
    delete process.env.PUBLIC_APP_URL;

    const prodMissingOriginRes = await fetch(`${baseUrl}/billing/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${originToken}`,
      },
      body: JSON.stringify({ planId: 'pro' }),
    });
    assert.strictEqual(prodMissingOriginRes.status, 500, '1.4 Production missing APP_BASE_URL fails closed with HTTP 500');

    process.env.APP_BASE_URL = 'http://videorisk.com';
    const prodHttpBaseRes = await fetch(`${baseUrl}/billing/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${originToken}`,
      },
      body: JSON.stringify({ planId: 'pro' }),
    });
    assert.strictEqual(prodHttpBaseRes.status, 500, '1.4a Production non-HTTPS APP_BASE_URL fails closed with HTTP 500');

    // Portal fail-closed in production without APP_BASE_URL
    delete process.env.APP_BASE_URL;
    assert.throws(
      () => billingService.validatePortalReturnUrl('https://videorisk.com/pricing'),
      (err: any) => err.statusCode === 500,
      '1.4b Customer Portal validation fails closed in production when APP_BASE_URL missing'
    );

    // 1.5 validate-env.ts checks APP_BASE_URL and ALLOWED_ORIGINS
    const badBaseEnv = validateBillingConfiguration('production', {
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_mock1234567890',
      STRIPE_WEBHOOK_SECRET: 'whsec_mock1234567890abcdef',
      STRIPE_PRICE_CREATOR: 'price_c',
      STRIPE_PRICE_PRO: 'price_p',
      STRIPE_PRICE_AGENCY: 'price_a',
      STRIPE_PRICE_AUDIT_ONCE: 'price_o',
      APP_BASE_URL: 'http://videorisk.com',
      ALLOWED_ORIGINS: 'https://videorisk.com@evil.com',
    });
    assert.strictEqual(badBaseEnv.valid, false, '1.5 validate-env rejects non-HTTPS APP_BASE_URL and @ in ALLOWED_ORIGINS in production');
    assert.ok(badBaseEnv.issues.some(i => i.variable === 'APP_BASE_URL' && i.type === 'ERROR'), '1.5a Reports ERROR for insecure APP_BASE_URL');
    assert.ok(badBaseEnv.issues.some(i => i.variable === 'ALLOWED_ORIGINS' && i.type === 'ERROR'), '1.5b Reports ERROR for unsafe ALLOWED_ORIGINS');

    // Restore valid configured production base + test env flag
    process.env.APP_BASE_URL = 'https://videorisk.com';
    process.env.NODE_ENV = 'test';
    process.env.VIDEORISK_TEST_RUN = 'true';
    console.log('  ✅ PASS: Checkout redirect origin allowlist & Host-spoofing fail-closed protection verified');

    // ------------------------------------------------------------------------
    // 2. STRIPE TEST MODE LIFECYCLE (REAL HMAC SIGNATURE + IDEMPOTENCY)
    // ------------------------------------------------------------------------
    console.log('\n[2. Stripe Test Mode Lifecycle (Signed Webhooks, Upgrades, Renewals, Past-Due)]');

    // 2.1 Invalid / unsigned webhook in production/test HMAC mode rejected with HTTP 400
    process.env.NODE_ENV = 'production';
    const forgedPayload = Buffer.from(JSON.stringify({ id: 'evt_forged', type: 'checkout.session.completed', data: { object: {} } }));
    const missingSigRes = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: forgedPayload,
    });
    assert.strictEqual(missingSigRes.status, 400, '2.1 Missing stripe-signature header rejected with HTTP 400');

    const badSigRes = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 't=12345,v1=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: forgedPayload,
    });
    assert.strictEqual(badSigRes.status, 400, '2.1a Forged stripe-signature rejected with HTTP 400');
    process.env.NODE_ENV = 'test';

    const lifecycleUser = await storage.users.createUser(
      `lifecycle_${Date.now()}@videorisk.test`,
      'hash_lc',
      'salt_lc',
      10,
      'free'
    );
    const lifecycleToken = await storage.users.createSession(lifecycleUser.id);
    const cusId = `cus_life_${Date.now()}`;
    const subId = `sub_life_${Date.now()}`;

    // 2.2 Signed one-time audit_once checkout (+60 credits, keeps free plan)
    const auditSessionId = `cs_audit_${Date.now()}`;
    const auditPi = `pi_audit_${Date.now()}`;
    const signedAudit = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_audit_complete_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: auditSessionId,
          client_reference_id: lifecycleUser.id,
          customer: cusId,
          payment_intent: auditPi,
          payment_status: 'paid',
          amount_total: 2900,
          currency: 'usd',
          metadata: { userId: lifecycleUser.id, planId: 'audit_once' },
        },
      },
    });
    const auditWebhookRes = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signedAudit.signature,
      },
      body: signedAudit.payloadStr,
    });
    assert.strictEqual(auditWebhookRes.status, 200, '2.2 Signed audit_once checkout webhook accepted (HTTP 200)');
    const userAfterAudit = await storage.users.getUser(lifecycleUser.id);
    assert.strictEqual(userAfterAudit?.creditsRemaining, 70, '2.2a Initial 10 + 60 audit_once = 70 credits');
    assert.strictEqual(userAfterAudit?.plan, 'free', '2.2b One-time audit_once keeps base plan free');

    // 2.3 Signed Pro subscription checkout (+75 credits -> 145) + duplicate replay idempotency
    const proSessionId = `cs_pro_${Date.now()}`;
    const proPi = `pi_pro_${Date.now()}`;
    const proEvtPayload = {
      id: `evt_pro_complete_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: proSessionId,
          client_reference_id: lifecycleUser.id,
          customer: cusId,
          subscription: subId,
          payment_intent: proPi,
          payment_status: 'paid',
          amount_total: 1900,
          currency: 'usd',
          metadata: { userId: lifecycleUser.id, planId: 'pro' },
        },
      },
    };
    const signedPro = buildSignedWebhookRequest(realStripeHmac, webhookSecret, proEvtPayload);
    const proRes1 = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedPro.signature },
      body: signedPro.payloadStr,
    });
    assert.strictEqual(proRes1.status, 200);
    assert.strictEqual((await storage.users.getUser(lifecycleUser.id))?.creditsRemaining, 145, '2.3 Pro checkout adds 75 credits (145 total)');
    assert.strictEqual((await storage.users.getUser(lifecycleUser.id))?.plan, 'pro', '2.3a Plan updated to pro');
    assert.strictEqual((await storage.users.getUser(lifecycleUser.id))?.subscriptionStatus, 'active', '2.3b Subscription status active');

    // Replay same event -> idempotent
    const proResReplay = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedPro.signature },
      body: signedPro.payloadStr,
    });
    const proReplayJson = await proResReplay.json();
    assert.strictEqual(proReplayJson.alreadyProcessed, true, '2.3c Duplicate webhook flagged alreadyProcessed');
    assert.strictEqual((await storage.users.getUser(lifecycleUser.id))?.creditsRemaining, 145, '2.3d Duplicate webhook grants 0 extra credits');

    // 2.4 Upgrade Pro -> Agency via customer.subscription.updated & ignore stale out-of-order downgrade
    const upgradeTs = Math.floor(Date.now() / 1000) + 10;
    const signedUpgrade = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_upgrade_agency_${Date.now()}`,
      created: upgradeTs,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: cusId,
          status: 'active',
          current_period_end: upgradeTs + 30 * 86400,
          items: { data: [{ price: { id: 'price_agency' } }] },
        },
      },
    });
    await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedUpgrade.signature },
      body: signedUpgrade.payloadStr,
    });
    assert.strictEqual((await storage.users.getUser(lifecycleUser.id))?.plan, 'agency', '2.4 Upgrade Pro -> Agency reflected');

    const staleDowngrade = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_stale_creator_${Date.now()}`,
      created: upgradeTs - 300,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: cusId,
          status: 'active',
          current_period_end: upgradeTs + 30 * 86400,
          items: { data: [{ price: { id: 'price_creator' } }] },
        },
      },
    });
    await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': staleDowngrade.signature },
      body: staleDowngrade.payloadStr,
    });
    assert.strictEqual((await storage.users.getUser(lifecycleUser.id))?.plan, 'agency', '2.4a Stale out-of-order subscription event ignored');

    // 2.5 invoice.paid renewal on creator downgrade (+30 credits) -> 175
    const signedCreatorDowngrade = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_downgrade_creator_${Date.now()}`,
      created: upgradeTs + 20,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: cusId,
          status: 'active',
          current_period_end: upgradeTs + 30 * 86400,
          items: { data: [{ price: { id: 'price_creator' } }] },
        },
      },
    });
    await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedCreatorDowngrade.signature },
      body: signedCreatorDowngrade.payloadStr,
    });
    assert.strictEqual((await storage.users.getUser(lifecycleUser.id))?.plan, 'creator', '2.5 Newer downgrade to creator accepted');

    const renewInvoiceId = `in_renew_${Date.now()}`;
    const renewPi = `pi_renew_${Date.now()}`;
    const renewChargeId = `ch_renew_${Date.now()}`;
    const signedRenewal = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_inv_renew_${Date.now()}`,
      created: upgradeTs + 30,
      type: 'invoice.paid',
      data: {
        object: {
          id: renewInvoiceId,
          customer: cusId,
          subscription: subId,
          payment_intent: renewPi,
          charge: renewChargeId,
          amount_paid: 900,
          currency: 'usd',
          billing_reason: 'subscription_cycle',
          lines: { data: [{ price: { id: 'price_creator' } }] },
        },
      },
    });
    await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedRenewal.signature },
      body: signedRenewal.payloadStr,
    });
    assert.strictEqual((await storage.users.getUser(lifecycleUser.id))?.creditsRemaining, 175, '2.5a invoice.paid renewal grants +30 creator credits');

    // 2.6 invoice.payment_failed -> past_due + Customer Portal session creation
    const signedPastDue = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_inv_fail_${Date.now()}`,
      created: upgradeTs + 40,
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: `in_fail_${Date.now()}`,
          customer: cusId,
          subscription: subId,
        },
      },
    });
    await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedPastDue.signature },
      body: signedPastDue.payloadStr,
    });
    assert.strictEqual((await storage.users.getUser(lifecycleUser.id))?.subscriptionStatus, 'past_due', '2.6 invoice.payment_failed transitions status to past_due');

    capturedPortalParams.length = 0;
    const portalRes = await fetch(`${baseUrl}/billing/create-portal-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${lifecycleToken}`,
      },
      body: JSON.stringify({ returnUrl: 'https://videorisk.com/pricing' }),
    });
    assert.strictEqual(portalRes.status, 200, '2.6a Authorized Customer Portal created');
    assert.strictEqual(capturedPortalParams[0].return_url, 'https://videorisk.com/pricing', '2.6b Portal return_url matches validated origin');
    console.log('  ✅ PASS: Signed webhook verification, checkout idempotency, upgrades, renewals & portal verified');

    // ------------------------------------------------------------------------
    // 3. STRIPE REFUND LIFECYCLE (FULL, PARTIAL, FAILED, DUPLICATE, OUT-OF-ORDER)
    // ------------------------------------------------------------------------
    console.log('\n[3. Stripe Refund Lifecycle (SQLite Persistence, Non-Destructive Credits & Separation)]');

    // 3.1 Partial refund (50% of 900c creator renewal -> Math.floor(30 * 450 / 900) = 15 credits reversed, sub remains past_due/active)
    const partialRefundId = `re_partial_${Date.now()}`;
    const signedPartialRefund = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_partial_ref_${Date.now()}`,
      created: upgradeTs + 50,
      type: 'charge.refunded',
      data: {
        object: {
          id: renewChargeId,
          payment_intent: renewPi,
          invoice: renewInvoiceId,
          customer: cusId,
          amount: 900,
          amount_refunded: 450,
          refunded: false,
          refunds: {
            data: [{ id: partialRefundId, amount: 450, status: 'succeeded' }],
          },
        },
      },
    });
    const partialRefRes = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedPartialRefund.signature },
      body: signedPartialRefund.payloadStr,
    });
    assert.strictEqual(partialRefRes.status, 200);
    const afterPartialUser = await storage.users.getUser(lifecycleUser.id);
    assert.strictEqual(afterPartialUser?.creditsRemaining, 160, '3.1 Partial 50% refund deducts proportional 15 credits (175 -> 160)');
    assert.strictEqual(afterPartialUser?.plan, 'creator', '3.1a Partial refund preserves plan');
    assert.notStrictEqual(afterPartialUser?.subscriptionStatus, 'canceled', '3.1b Partial refund does not cancel subscription');

    // 3.2 Full refund on one-time audit_once (deducts 60 credits, preserves creator subscription)
    const auditChargeId = `ch_audit_${Date.now()}`;
    const auditFullRefundId = `re_audit_full_${Date.now()}`;
    const signedAuditFullRefund = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_audit_full_ref_${Date.now()}`,
      created: upgradeTs + 60,
      type: 'charge.refunded',
      data: {
        object: {
          id: auditChargeId,
          payment_intent: auditPi,
          customer: cusId,
          amount: 2900,
          amount_refunded: 2900,
          refunded: true,
          refunds: {
            data: [{ id: auditFullRefundId, amount: 2900, status: 'succeeded' }],
          },
        },
      },
    });
    await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedAuditFullRefund.signature },
      body: signedAuditFullRefund.payloadStr,
    });
    const afterAuditRefundUser = await storage.users.getUser(lifecycleUser.id);
    assert.strictEqual(afterAuditRefundUser?.creditsRemaining, 100, '3.2 Full audit_once refund reverses 60 credits (160 -> 100)');
    assert.strictEqual(afterAuditRefundUser?.plan, 'creator', '3.2a Refunding one-time purchase preserves active subscription plan');

    // 3.3 Failed refund (`refund.failed` and `refund.updated` status='failed') performs 0 credit/plan changes
    const failedRefundId = `re_failed_${Date.now()}`;
    const signedFailedRefund = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_ref_failed_${Date.now()}`,
      created: upgradeTs + 70,
      type: 'refund.failed',
      data: {
        object: {
          id: failedRefundId,
          charge: auditChargeId,
          payment_intent: auditPi,
          amount: 2900,
          status: 'failed',
          failure_reason: 'expired_or_canceled_card',
        },
      },
    });
    await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedFailedRefund.signature },
      body: signedFailedRefund.payloadStr,
    });
    assert.strictEqual((await storage.users.getUser(lifecycleUser.id))?.creditsRemaining, 100, '3.3 Failed refund leaves credits untouched');
    assert.strictEqual((await storage.users.getUser(lifecycleUser.id))?.plan, 'creator', '3.3a Failed refund leaves plan untouched');

    // 3.4 Duplicate refund across two DIFFERENT webhook event types (`refund.created` then `charge.refunded` carrying same refund ID)
    const dedupUser = await storage.users.createUser(
      `refund_dedup_${Date.now()}@videorisk.test`,
      'hash_rd',
      'salt_rd',
      10,
      'free'
    );
    const dedupCus = `cus_dedup_${Date.now()}`;
    const dedupSub = `sub_dedup_${Date.now()}`;
    const dedupPi = `pi_dedup_${Date.now()}`;
    const dedupCh = `ch_dedup_${Date.now()}`;
    const dedupRefId = `re_dedup_${Date.now()}`;

    const signedDedupCheckout = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_dedup_checkout_${Date.now()}`,
      created: upgradeTs + 80,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_dedup_${Date.now()}`,
          client_reference_id: dedupUser.id,
          customer: dedupCus,
          subscription: dedupSub,
          payment_intent: dedupPi,
          payment_status: 'paid',
          amount_total: 1900,
          currency: 'usd',
          metadata: { userId: dedupUser.id, planId: 'pro' },
        },
      },
    });
    await billingService.handleWebhook(signedDedupCheckout.rawBody, signedDedupCheckout.signature);
    assert.strictEqual((await storage.users.getUser(dedupUser.id))?.creditsRemaining, 85, '3.4 Pro granted +75 (85 total)');

    // User spends 50 credits (85 -> 35) before full refund arrives
    await storage.users.deductCredits(dedupUser.id, 50);
    assert.strictEqual((await storage.users.getUser(dedupUser.id))?.creditsRemaining, 35);

    // Event A: refund.created (partial/full amount 1900 == amountTotal)
    const { rawBody: rbRefCreated, signature: sigRefCreated } = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_ref_created_${Date.now()}`,
      created: upgradeTs + 85,
      type: 'refund.created',
      data: {
        object: {
          id: dedupRefId,
          charge: dedupCh,
          payment_intent: dedupPi,
          amount: 1900,
          status: 'succeeded',
        },
      },
    });
    await billingService.handleWebhook(rbRefCreated, sigRefCreated);
    const afterFullSpentUser = await storage.users.getUser(dedupUser.id);
    assert.strictEqual(afterFullSpentUser?.creditsRemaining, 0, '3.4a Credits clamped cleanly at 0 (never negative debt)');
    assert.strictEqual(afterFullSpentUser?.subscriptionStatus, 'canceled', '3.4b Full refund cancels subscription');
    assert.strictEqual(afterFullSpentUser?.plan, 'free', '3.4c Plan downgraded to free on full subscription refund');

    // Event B: charge.refunded with DIFFERENT event.id referencing the SAME dedupRefId
    const { rawBody: rbChgRef, signature: sigChgRef } = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_chg_ref_dup_${Date.now()}`,
      created: upgradeTs + 86,
      type: 'charge.refunded',
      data: {
        object: {
          id: dedupCh,
          payment_intent: dedupPi,
          customer: dedupCus,
          amount: 1900,
          amount_refunded: 1900,
          refunded: true,
          refunds: { data: [{ id: dedupRefId, amount: 1900, status: 'succeeded' }] },
        },
      },
    });
    await billingService.handleWebhook(rbChgRef, sigChgRef);
    assert.strictEqual((await storage.users.getUser(dedupUser.id))?.creditsRemaining, 0, '3.4d Second event for same refund_id causes zero extra deductions');

    // 3.5 Verify SqliteStorageRepository isolated DB tables directly (ledger separation + unrecoveredCredits + out-of-order refund-before-checkout)
    const sqliteDbPath = path.join(tempSqliteDir, 'refund_isolation.db');
    const sqliteRepo = new SqliteStorageRepository(sqliteDbPath);
    const rawSqliteDb = (sqliteRepo as any).db;

    const sqlUser = await sqliteRepo.users.createUser(
      `sql_refund_${Date.now()}@videorisk.test`,
      'hash_sq',
      'salt_sq',
      15,
      'free'
    );
    const oooPi = `pi_ooo_${Date.now()}`;
    const oooCh = `ch_ooo_${Date.now()}`;
    const oooRef = `re_ooo_${Date.now()}`;

    await sqliteRepo.runTransaction(async (state) => {
      // Simulate charge.refunded arriving BEFORE checkout.session.completed (out-of-order)
      (billingService as any).processRefundWebhook(state, {
        id: `evt_ooo_refund_${Date.now()}`,
        created: Math.floor(Date.now() / 1000),
        type: 'charge.refunded',
        data: {
          object: {
            id: oooCh,
            payment_intent: oooPi,
            amount: 2900,
            amount_refunded: 2900,
            refunded: true,
            metadata: { userId: sqlUser.id, planId: 'audit_once' },
            refunds: { data: [{ id: oooRef, amount: 2900, status: 'succeeded' }] },
          },
        },
      });
    });

    // Verify out-of-order flag protects checkout.session.completed even in direct SQLite DB queries
    let priorFullDetected = false;
    await sqliteRepo.runTransaction(async (state) => {
      priorFullDetected = (billingService as any).hasSucceededFullRefund(state, { paymentIntentId: oooPi });
      if (priorFullDetected) {
        (billingService as any).upsertStripePayment(state, {
          id: `pay_ooo_${Date.now()}`,
          userId: sqlUser.id,
          paymentIntentId: oooPi,
          chargeId: oooCh,
          planId: 'audit_once',
          creditsGranted: 0,
          amountTotal: 2900,
          status: 'refunded',
        });
      }
    });
    assert.strictEqual(priorFullDetected, true, '3.5 SQLite stripe_refunds query detects out-of-order full refund');

    const sqlPaymentRows = rawSqliteDb.prepare('SELECT * FROM stripe_payments WHERE payment_intent_id = ?').all(oooPi);
    const sqlRefundRows = rawSqliteDb.prepare('SELECT * FROM stripe_refunds WHERE refund_id = ?').all(oooRef);
    const sqlLedgerRows = rawSqliteDb.prepare('SELECT * FROM credit_transactions WHERE user_id = ?').all(sqlUser.id) as any[];
    assert.strictEqual(sqlPaymentRows.length, 1, '3.5a Persisted 1 row in SQLite stripe_payments');
    assert.strictEqual(sqlPaymentRows[0].status, 'refunded', '3.5b Payment marked refunded immediately');
    assert.strictEqual(sqlRefundRows.length, 1, '3.5c Persisted 1 row in SQLite stripe_refunds');
    const sqlLedgerTypes = sqlLedgerRows.map((r) => r.type);
    assert.ok(sqlLedgerTypes.includes('STRIPE_PAYMENT_REFUND'), '3.5d Credit ledger uses STRIPE_PAYMENT_REFUND (strictly distinct from SCAN_REFUND)');
    assert.ok(!sqlLedgerTypes.includes('SCAN_REFUND'), '3.5e Out-of-order Stripe refund never emits SCAN_REFUND');

    // Also verify credit_transactions on main test storage recorded STRIPE_PARTIAL_REFUND, STRIPE_PAYMENT_REFUND, STRIPE_REFUND_FAILED & unrecoveredCredits
    const mainDb = (storage as any).db;
    if (mainDb && typeof mainDb.prepare === 'function') {
      const dedupLedger = mainDb
        .prepare('SELECT * FROM credit_transactions WHERE user_id = ? AND type = ?')
        .all(dedupUser.id, 'STRIPE_PAYMENT_REFUND') as any[];
      assert.strictEqual(dedupLedger.length, 1, '3.6 Exactly 1 STRIPE_PAYMENT_REFUND row after duplicate webhook attempts');
      const parsedMeta = JSON.parse(dedupLedger[0].metadata_json);
      assert.strictEqual(parsedMeta.unrecoveredCredits, 40, '3.6a Audit metadata records 40 unrecoveredCredits safely without negative balance');
      assert.strictEqual(parsedMeta.actualCreditsDeducted, 35, '3.6b Audit metadata records 35 actualCreditsDeducted');

      const lifecycleLedgerTypes = (mainDb
        .prepare('SELECT type FROM credit_transactions WHERE user_id = ?')
        .all(lifecycleUser.id) as any[])
        .map((r) => r.type);
      assert.ok(lifecycleLedgerTypes.includes('STRIPE_PARTIAL_REFUND'), '3.6c Records STRIPE_PARTIAL_REFUND');
      assert.ok(lifecycleLedgerTypes.includes('STRIPE_PAYMENT_REFUND'), '3.6d Records STRIPE_PAYMENT_REFUND');
      assert.ok(lifecycleLedgerTypes.includes('STRIPE_REFUND_FAILED'), '3.6e Records STRIPE_REFUND_FAILED');
      assert.ok(!lifecycleLedgerTypes.includes('SCAN_REFUND'), '3.6f Stripe billing refunds strictly never emit SCAN_REFUND');
    }

    // 3.7 Cross-check InMemoryStorageRepository parity for out-of-order refund
    const memStorePath = path.join(tempSqliteDir, 'mem_refund_parity.json');
    const memRepo = new InMemoryStorageRepository(memStorePath);
    const memUser = await memRepo.users.createUser(`mem_ref_${Date.now()}@videorisk.test`, 'h', 's', 50, 'free');
    await memRepo.runTransaction(async (state) => {
      (billingService as any).upsertStripePayment(state, {
        id: 'pay_mem_1',
        userId: memUser.id,
        paymentIntentId: 'pi_mem_1',
        chargeId: 'ch_mem_1',
        planId: 'audit_once',
        creditsGranted: 60,
        amountTotal: 2900,
        status: 'paid',
      });
      memUser.creditsRemaining = 110;
      (billingService as any).processRefundWebhook(state, {
        id: 'evt_mem_refund_1',
        created: Math.floor(Date.now() / 1000),
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_mem_1',
            payment_intent: 'pi_mem_1',
            amount: 2900,
            amount_refunded: 2900,
            refunded: true,
            refunds: { data: [{ id: 're_mem_1', amount: 2900, status: 'succeeded' }] },
          },
        },
      });
    });
    assert.strictEqual((await memRepo.users.getUser(memUser.id))?.creditsRemaining, 50, '3.7 InMemoryStorageRepository refund parity verified');

    console.log('  ✅ PASS: Stripe refund lifecycle (full, partial, failed, duplicate, spent-balance clamp & out-of-order) verified');
    console.log('  [Boundary Notice] Live external Stripe Test Mode API / Stripe CLI dashboard events: NOT VERIFIED (verified with mocked Stripe SDK & real Stripe HMAC signatures).');

    // ------------------------------------------------------------------------
    // 4. COMPREHENSIVE REFUND RECONCILIATION MATRIX, NON-STRING ORIGIN & ROLLBACK
    // ------------------------------------------------------------------------
    console.log('\n[4. Extended Refund Reconciliation Matrix, Non-String Origin & Tx Rollback Parity]');

    // 4.1 Non-string originUrl payloads rejected HTTP 400 + direct billingService malicious originUrl rejection
    for (const nonStringVal of [['https://evil.com'], 123, { url: 'https://evil.com' }]) {
      const badTypeRes = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${originToken}`,
        },
        body: JSON.stringify({ planId: 'pro', originUrl: nonStringVal }),
      });
      assert.strictEqual(badTypeRes.status, 400, `4.1 Non-string originUrl (${JSON.stringify(nonStringVal)}) fails closed with HTTP 400`);
    }

    await assert.rejects(
      () => billingService.createCheckoutSession({
        userId: originUser.id,
        planId: 'pro',
        originUrl: 'https://evil.example.com',
      }),
      (err: any) => err.statusCode === 400,
      '4.1a Direct billingService.createCheckoutSession rejects untrusted originUrl'
    );

    // 4.2 Run full refund lifecycle matrix across BOTH SqliteStorageRepository and InMemoryStorageRepository
    const runExtendedRefundMatrix = async (
      backendLabel: string,
      repo: SqliteStorageRepository | InMemoryStorageRepository,
      inspectState: () => Promise<{
        getRefund: (refundId: string) => any;
        getPaymentByIntent: (pi: string) => any;
        getWebhook: (evtId: string) => any;
        countCreditTxs: (userId: string) => number;
      }>
    ) => {
      let seq = 1;
      const nextTs = () => Math.floor(Date.now() / 1000) + seq++ * 10;
      billingService.setStorageForTest(repo);
      try {
        // A. Partial refund BEFORE checkout.session.completed (unrelated balance preserved + net deduction + replay idempotency)
        const userA = await repo.users.createUser(`${backendLabel}_caseA_${Date.now()}@videorisk.test`, 'h', 's', 10, 'free');
        const piA = `pi_${backendLabel}_ooo_part_${Date.now()}`;
        const refA = `re_${backendLabel}_ooo_part_${Date.now()}`;
        const evtRefA = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_ooo_part_ref`,
          created: nextTs(),
          type: 'refund.created',
          data: {
            object: {
              id: refA,
              payment_intent: piA,
              amount: 950,
              status: 'succeeded',
              metadata: { userId: userA.id, planId: 'pro' },
            },
          },
        });
        await billingService.handleWebhook(evtRefA.rawBody, evtRefA.signature);
        assert.strictEqual((await repo.users.getUser(userA.id))?.creditsRemaining, 10, `${backendLabel} 4.2A Pre-checkout partial refund leaves pre-existing credits untouched`);

        const evtChkA = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_ooo_part_chk`,
          created: nextTs(),
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_${backendLabel}_ooo_part`,
              client_reference_id: userA.id,
              customer: `cus_${backendLabel}_A`,
              subscription: `sub_${backendLabel}_A`,
              payment_intent: piA,
              payment_status: 'paid',
              amount_total: 1900,
              currency: 'usd',
              metadata: { userId: userA.id, planId: 'pro' },
            },
          },
        });
        await billingService.handleWebhook(evtChkA.rawBody, evtChkA.signature);
        // pro = 75 credits; 950/1900 * 75 = floor(37.5) = 37 clawed back => 10 + 75 - 37 = 48
        assert.strictEqual((await repo.users.getUser(userA.id))?.creditsRemaining, 48, `${backendLabel} 4.2A Checkout reconciles prior partial refund atomically (10 + 75 - 37 = 48)`);
        const snapA = await inspectState();
        assert.strictEqual(snapA.getPaymentByIntent(piA)?.status, 'partially_refunded', `${backendLabel} 4.2A Payment marked partially_refunded`);
        assert.strictEqual(snapA.getRefund(refA)?.reconciled, true, `${backendLabel} 4.2A Out-of-order refund marked reconciled=true`);
        assert.strictEqual(snapA.getRefund(refA)?.creditsAdjusted, 37, `${backendLabel} 4.2A Out-of-order refund records creditsAdjusted=37`);

        // Replay both webhooks -> idempotent
        const replayChkA = await billingService.handleWebhook(evtChkA.rawBody, evtChkA.signature);
        const replayRefA = await billingService.handleWebhook(evtRefA.rawBody, evtRefA.signature);
        assert.strictEqual(replayChkA.alreadyProcessed, true, `${backendLabel} 4.2A Replay checkout idempotent`);
        assert.strictEqual(replayRefA.alreadyProcessed, true, `${backendLabel} 4.2A Replay refund idempotent`);
        assert.strictEqual((await repo.users.getUser(userA.id))?.creditsRemaining, 48, `${backendLabel} 4.2A Balance unchanged after replays`);

        // B. Sequential 3-part partial refunds completing full refund (634 + 633 + 633 = 1900c on 75 credits -> exact BigInt cumulative reversal)
        const userB = await repo.users.createUser(`${backendLabel}_caseB_${Date.now()}@videorisk.test`, 'h', 's', 10, 'free');
        const piB = `pi_${backendLabel}_seq_${Date.now()}`;
        const subB = `sub_${backendLabel}_seq_${Date.now()}`;
        const chkB = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_seq_chk`,
          created: nextTs(),
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_${backendLabel}_seq`,
              client_reference_id: userB.id,
              customer: `cus_${backendLabel}_B`,
              subscription: subB,
              payment_intent: piB,
              payment_status: 'paid',
              amount_total: 1900,
              currency: 'usd',
              metadata: { userId: userB.id, planId: 'pro' },
            },
          },
        });
        await billingService.handleWebhook(chkB.rawBody, chkB.signature);
        assert.strictEqual((await repo.users.getUser(userB.id))?.creditsRemaining, 85);

        const splits = [
          { cents: 634, cum: 634, expectedCredits: 60, refundedFlag: false, expectedStatus: 'partially_refunded', expectedPlan: 'pro' },
          { cents: 633, cum: 1267, expectedCredits: 35, refundedFlag: false, expectedStatus: 'partially_refunded', expectedPlan: 'pro' },
          { cents: 633, cum: 1900, expectedCredits: 10, refundedFlag: true, expectedStatus: 'refunded', expectedPlan: 'free' },
        ];
        for (let idx = 0; idx < splits.length; idx++) {
          const sp = splits[idx];
          const refEvt = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_seq_ref_${idx}`,
            created: nextTs(),
            type: 'charge.refunded',
            data: {
              object: {
                id: `ch_${backendLabel}_seq`,
                payment_intent: piB,
                customer: `cus_${backendLabel}_B`,
                amount: 1900,
                amount_refunded: sp.cum,
                refunded: sp.refundedFlag,
                refunds: { data: [{ id: `re_${backendLabel}_seq_${idx}`, amount: sp.cents, status: 'succeeded' }] },
              },
            },
          });
          await billingService.handleWebhook(refEvt.rawBody, refEvt.signature);
          const uB = await repo.users.getUser(userB.id);
          assert.strictEqual(uB?.creditsRemaining, sp.expectedCredits, `${backendLabel} 4.2B Split ${idx + 1} balance=${sp.expectedCredits}`);
          assert.strictEqual(uB?.plan, sp.expectedPlan, `${backendLabel} 4.2B Split ${idx + 1} plan=${sp.expectedPlan}`);
          const snapB = await inspectState();
          assert.strictEqual(snapB.getPaymentByIntent(piB)?.status, sp.expectedStatus, `${backendLabel} 4.2B Split ${idx + 1} payment=${sp.expectedStatus}`);
        }
        assert.strictEqual((await repo.users.getUser(userB.id))?.subscriptionStatus, 'canceled', `${backendLabel} 4.2B Final split completing 100% cancels sub`);

        // C. Full refund BEFORE checkout.session.completed
        const userC = await repo.users.createUser(`${backendLabel}_caseC_${Date.now()}@videorisk.test`, 'h', 's', 20, 'free');
        const piC = `pi_${backendLabel}_ooofull_${Date.now()}`;
        const evtRefC = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_ooofull_ref`,
          created: nextTs(),
          type: 'charge.refunded',
          data: {
            object: {
              id: `ch_${backendLabel}_ooofull`,
              payment_intent: piC,
              amount: 2900,
              amount_refunded: 2900,
              refunded: true,
              metadata: { userId: userC.id, planId: 'audit_once' },
              refunds: { data: [{ id: `re_${backendLabel}_ooofull`, amount: 2900, status: 'succeeded' }] },
            },
          },
        });
        await billingService.handleWebhook(evtRefC.rawBody, evtRefC.signature);
        assert.strictEqual((await repo.users.getUser(userC.id))?.creditsRemaining, 20);

        const evtChkC = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_ooofull_chk`,
          created: nextTs(),
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_${backendLabel}_ooofull`,
              client_reference_id: userC.id,
              payment_intent: piC,
              payment_status: 'paid',
              amount_total: 2900,
              currency: 'usd',
              metadata: { userId: userC.id, planId: 'audit_once' },
            },
          },
        });
        await billingService.handleWebhook(evtChkC.rawBody, evtChkC.signature);
        assert.strictEqual((await repo.users.getUser(userC.id))?.creditsRemaining, 20, `${backendLabel} 4.2C Out-of-order full refund blocks checkout credit grant`);
        assert.strictEqual((await inspectState()).getPaymentByIntent(piC)?.status, 'refunded', `${backendLabel} 4.2C Payment immediately marked refunded`);

        // D. Out-of-order partial & full refund BEFORE invoice.paid renewal + no cross-renewal subscription collision
        const userD = await repo.users.createUser(`${backendLabel}_caseD_${Date.now()}@videorisk.test`, 'h', 's', 10, 'free');
        const cusD = `cus_${backendLabel}_D`;
        const subD = `sub_${backendLabel}_D`;
        const piD1 = `pi_${backendLabel}_D1`;
        const chkD1 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_D1_chk`,
          created: nextTs(),
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_${backendLabel}_D1`,
              client_reference_id: userD.id,
              customer: cusD,
              subscription: subD,
              payment_intent: piD1,
              payment_status: 'paid',
              amount_total: 900,
              currency: 'usd',
              metadata: { userId: userD.id, planId: 'creator' },
            },
          },
        });
        await billingService.handleWebhook(chkD1.rawBody, chkD1.signature);
        assert.strictEqual((await repo.users.getUser(userD.id))?.creditsRemaining, 40);

        // Partial refund for future renewal invoice inD2 arrives BEFORE invoice.paid (must NOT touch initial checkout piD1!)
        const piD2 = `pi_${backendLabel}_D2`;
        const inD2 = `in_${backendLabel}_D2`;
        const refD2 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_D2_ref`,
          created: nextTs(),
          type: 'refund.created',
          data: {
            object: {
              id: `re_${backendLabel}_D2`,
              payment_intent: piD2,
              invoice: inD2,
              customer: cusD,
              amount: 450,
              status: 'succeeded',
              metadata: { subscriptionId: subD, planId: 'creator' },
            },
          },
        });
        await billingService.handleWebhook(refD2.rawBody, refD2.signature);
        assert.strictEqual((await repo.users.getUser(userD.id))?.creditsRemaining, 40, `${backendLabel} 4.2D Out-of-order renewal refund does not collide with prior invoice`);
        assert.strictEqual((await inspectState()).getPaymentByIntent(piD1)?.status, 'paid', `${backendLabel} 4.2D Earlier payment piD1 stays paid`);

        // Now renewal invoice.paid inD2 arrives (+30 - 15 = +15 -> 55 credits)
        const invPaidD2 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_D2_inv`,
          created: nextTs(),
          type: 'invoice.paid',
          data: {
            object: {
              id: inD2,
              customer: cusD,
              subscription: subD,
              payment_intent: piD2,
              charge: `ch_${backendLabel}_D2`,
              amount_paid: 900,
              currency: 'usd',
              billing_reason: 'subscription_cycle',
              lines: { data: [{ price: { id: 'price_creator' } }] },
            },
          },
        });
        await billingService.handleWebhook(invPaidD2.rawBody, invPaidD2.signature);
        assert.strictEqual((await repo.users.getUser(userD.id))?.creditsRemaining, 55, `${backendLabel} 4.2D Renewal invoice.paid reconciles partial refund (+30 - 15 = 55)`);

        // Full refund before invoice.paid renewal inD3
        const piD3 = `pi_${backendLabel}_D3`;
        const inD3 = `in_${backendLabel}_D3`;
        const refD3 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_D3_ref`,
          created: nextTs(),
          type: 'charge.refunded',
          data: {
            object: {
              id: `ch_${backendLabel}_D3`,
              payment_intent: piD3,
              invoice: inD3,
              customer: cusD,
              amount: 900,
              amount_refunded: 900,
              refunded: true,
              metadata: { subscriptionId: subD, planId: 'creator' },
              refunds: { data: [{ id: `re_${backendLabel}_D3`, amount: 900, status: 'succeeded' }] },
            },
          },
        });
        await billingService.handleWebhook(refD3.rawBody, refD3.signature);

        const invPaidD3 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_D3_inv`,
          created: nextTs(),
          type: 'invoice.paid',
          data: {
            object: {
              id: inD3,
              customer: cusD,
              subscription: subD,
              payment_intent: piD3,
              charge: `ch_${backendLabel}_D3`,
              amount_paid: 900,
              currency: 'usd',
              billing_reason: 'subscription_cycle',
              lines: { data: [{ price: { id: 'price_creator' } }] },
            },
          },
        });
        await billingService.handleWebhook(invPaidD3.rawBody, invPaidD3.signature);
        assert.strictEqual((await repo.users.getUser(userD.id))?.creditsRemaining, 55, `${backendLabel} 4.2D Out-of-order full renewal refund grants 0 credits`);
        assert.strictEqual((await repo.users.getUser(userD.id))?.plan, 'free', `${backendLabel} 4.2D Out-of-order full renewal refund cancels sub to free`);

        // E. Out-of-order full refund BEFORE verifyAndSynchronizeSession()
        const userE = await repo.users.createUser(`${backendLabel}_caseE_${Date.now()}@videorisk.test`, 'h', 's', 12, 'free');
        const piE = `pi_${backendLabel}_sync_ooo`;
        const csE = `cs_${backendLabel}_sync_ooo`;
        sessionRegistry.set(csE, {
          id: csE,
          client_reference_id: userE.id,
          payment_status: 'paid',
          payment_intent: piE,
          amount_total: 2900,
          currency: 'usd',
          metadata: { userId: userE.id, planId: 'audit_once' },
        });
        const refE = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_E_ref`,
          created: nextTs(),
          type: 'charge.refunded',
          data: {
            object: {
              id: `ch_${backendLabel}_E`,
              payment_intent: piE,
              amount: 2900,
              amount_refunded: 2900,
              refunded: true,
              metadata: { userId: userE.id, planId: 'audit_once' },
              refunds: { data: [{ id: `re_${backendLabel}_E`, amount: 2900, status: 'succeeded' }] },
            },
          },
        });
        await billingService.handleWebhook(refE.rawBody, refE.signature);
        await billingService.verifyAndSynchronizeSession(csE, userE.id);
        assert.strictEqual((await repo.users.getUser(userE.id))?.creditsRemaining, 12, `${backendLabel} 4.2E verifyAndSynchronizeSession respects prior full refund`);
        assert.strictEqual((await inspectState()).getPaymentByIntent(piE)?.status, 'refunded', `${backendLabel} 4.2E Sync payment marked refunded`);

        // F. Strict refund status allowlist: pending, requires_action, failed, canceled, null, missing, unknown
        const userF = await repo.users.createUser(`${backendLabel}_caseF_${Date.now()}@videorisk.test`, 'h', 's', 10, 'free');
        const piF = `pi_${backendLabel}_status_${Date.now()}`;
        const chkF = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_F_chk`,
          created: nextTs(),
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_${backendLabel}_F`,
              client_reference_id: userF.id,
              payment_intent: piF,
              payment_status: 'paid',
              amount_total: 1900,
              currency: 'usd',
              metadata: { userId: userF.id, planId: 'pro' },
            },
          },
        });
        await billingService.handleWebhook(chkF.rawBody, chkF.signature);
        assert.strictEqual((await repo.users.getUser(userF.id))?.creditsRemaining, 85);

        const nonSucceededCases: Array<{ suffix: string; statusVal: any; expectedPersisted: string; expectedRaw?: string }> = [
          { suffix: 'pending', statusVal: 'pending', expectedPersisted: 'pending' },
          { suffix: 'req_act', statusVal: 'requires_action', expectedPersisted: 'requires_action' },
          { suffix: 'failed', statusVal: 'failed', expectedPersisted: 'failed' },
          { suffix: 'canceled', statusVal: 'canceled', expectedPersisted: 'canceled' },
          { suffix: 'null', statusVal: null, expectedPersisted: 'unknown', expectedRaw: 'null' },
          { suffix: 'missing', statusVal: undefined, expectedPersisted: 'unknown', expectedRaw: 'missing' },
          { suffix: 'bogus', statusVal: 'weird_custom_state', expectedPersisted: 'unknown', expectedRaw: 'weird_custom_state' },
        ];
        for (const nc of nonSucceededCases) {
          const rid = `re_${backendLabel}_F_${nc.suffix}`;
          const obj: any = {
            id: rid,
            payment_intent: piF,
            amount: 1900,
          };
          if (nc.statusVal !== undefined) obj.status = nc.statusVal;
          const ev = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_F_${nc.suffix}`,
            created: nextTs(),
            type: 'refund.updated',
            data: { object: obj },
          });
          await billingService.handleWebhook(ev.rawBody, ev.signature);
          const rec = (await inspectState()).getRefund(rid);
          assert.strictEqual(rec?.status, nc.expectedPersisted, `${backendLabel} 4.2F Status '${String(nc.statusVal)}' stored as '${nc.expectedPersisted}'`);
          if (nc.expectedRaw) {
            assert.strictEqual(rec?.rawStatus, nc.expectedRaw, `${backendLabel} 4.2F rawStatus='${nc.expectedRaw}' preserved`);
          }
          assert.strictEqual((await repo.users.getUser(userF.id))?.creditsRemaining, 85, `${backendLabel} 4.2F Zero credit deduction for status='${String(nc.statusVal)}'`);
          assert.strictEqual((await repo.users.getUser(userF.id))?.plan, 'pro', `${backendLabel} 4.2F Plan stays pro for status='${String(nc.statusVal)}'`);
        }

        // G. Bounds: amount <= 0 and > 100% cap
        for (const badAmt of [0, -500]) {
          const evBadAmt = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_F_amt_${badAmt}`,
            created: nextTs(),
            type: 'refund.created',
            data: {
              object: {
                id: `re_${backendLabel}_F_amt_${badAmt}`,
                payment_intent: piF,
                amount: badAmt,
                status: 'succeeded',
              },
            },
          });
          await billingService.handleWebhook(evBadAmt.rawBody, evBadAmt.signature);
          assert.strictEqual((await repo.users.getUser(userF.id))?.creditsRemaining, 85, `${backendLabel} 4.2G Rejects refund amount=${badAmt} safely`);
        }

        const evOverAmt = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_F_over`,
          created: nextTs(),
          type: 'refund.created',
          data: {
            object: {
              id: `re_${backendLabel}_F_over`,
              payment_intent: piF,
              amount: 5000,
              status: 'succeeded',
            },
          },
        });
        await billingService.handleWebhook(evOverAmt.rawBody, evOverAmt.signature);
        assert.strictEqual((await repo.users.getUser(userF.id))?.creditsRemaining, 10, `${backendLabel} 4.2G Over-100% refund capped at 75 granted credits (pre-existing 10 preserved)`);

        // H. Transaction Atomicity & Mid-Transaction Rollback Test
        const userH = await repo.users.createUser(`${backendLabel}_caseH_${Date.now()}@videorisk.test`, 'h', 's', 10, 'free');
        const piH = `pi_${backendLabel}_rollback_${Date.now()}`;
        const chkH = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_${backendLabel}_H_chk`,
          created: nextTs(),
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_${backendLabel}_H`,
              client_reference_id: userH.id,
              customer: `cus_${backendLabel}_H`,
              subscription: `sub_${backendLabel}_H`,
              payment_intent: piH,
              payment_status: 'paid',
              amount_total: 1900,
              currency: 'usd',
              metadata: { userId: userH.id, planId: 'pro' },
            },
          },
        });
        await billingService.handleWebhook(chkH.rawBody, chkH.signature);
        const baselineTxCount = (await inspectState()).countCreditTxs(userH.id);
        assert.strictEqual((await repo.users.getUser(userH.id))?.creditsRemaining, 85);

        const rollbackEvtId = `evt_${backendLabel}_H_rollback_ref`;
        const rollbackRefId = `re_${backendLabel}_H_rollback`;
        await assert.rejects(
          () => repo.runTransaction(async (state) => {
            (billingService as any).processRefundWebhook(state, {
              id: rollbackEvtId,
              created: nextTs(),
              type: 'refund.created',
              data: {
                object: {
                  id: rollbackRefId,
                  payment_intent: piH,
                  amount: 1900,
                  status: 'succeeded',
                },
              },
            });
            throw new Error('SIMULATED_MID_TX_CRASH');
          }),
          /SIMULATED_MID_TX_CRASH/,
          `${backendLabel} 4.2H Mid-transaction crash propagates error`
        );

        const afterRollbackSnap = await inspectState();
        assert.strictEqual((await repo.users.getUser(userH.id))?.creditsRemaining, 85, `${backendLabel} 4.2H Rollback preserves user credits=85`);
        assert.strictEqual((await repo.users.getUser(userH.id))?.plan, 'pro', `${backendLabel} 4.2H Rollback preserves plan=pro`);
        assert.strictEqual(afterRollbackSnap.getPaymentByIntent(piH)?.status, 'paid', `${backendLabel} 4.2H Rollback preserves payment status=paid`);
        assert.strictEqual(afterRollbackSnap.getRefund(rollbackRefId), undefined, `${backendLabel} 4.2H Rollback leaves 0 partial refund rows`);
        assert.strictEqual(afterRollbackSnap.getWebhook(rollbackEvtId), undefined, `${backendLabel} 4.2H Rollback leaves 0 webhook_events rows`);
        assert.strictEqual(afterRollbackSnap.countCreditTxs(userH.id), baselineTxCount, `${backendLabel} 4.2H Rollback leaves 0 credit_transactions rows`);

        // Retry after rollback succeeds cleanly
        const retryH = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: rollbackEvtId,
          created: nextTs(),
          type: 'refund.created',
          data: {
            object: {
              id: rollbackRefId,
              payment_intent: piH,
              amount: 1900,
              status: 'succeeded',
            },
          },
        });
        const retryRes = await billingService.handleWebhook(retryH.rawBody, retryH.signature);
        assert.strictEqual(retryRes.alreadyProcessed, false, `${backendLabel} 4.2H Retry after rollback processes cleanly`);
        assert.strictEqual((await repo.users.getUser(userH.id))?.creditsRemaining, 10, `${backendLabel} 4.2H Retry deducts 75 credits cleanly`);
        assert.strictEqual((await repo.users.getUser(userH.id))?.plan, 'free', `${backendLabel} 4.2H Retry downgrades plan to free`);

        // I. Workstream A4 — Monotonic & Out-of-Order Refund Webhook Protection (12 Scenarios across SQLite & InMemory)
        // Helper to provision a paid Pro user (85 credits = 10 initial + 75 Pro, $19.00 = 1900 cents)
        const setupPaidProUser = async (suffix: string) => {
          const u = await repo.users.createUser(`${backendLabel}_mono_${suffix}_${Date.now()}@videorisk.test`, 'h', 's', 10, 'free');
          const pi = `pi_${backendLabel}_mono_${suffix}_${Date.now()}`;
          const chg = `ch_${backendLabel}_mono_${suffix}_${Date.now()}`;
          const sub = `sub_${backendLabel}_mono_${suffix}_${Date.now()}`;
          const chk = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_mono_chk_${suffix}_${Date.now()}`,
            created: nextTs(),
            type: 'checkout.session.completed',
            data: {
              object: {
                id: `cs_${backendLabel}_mono_${suffix}`,
                client_reference_id: u.id,
                customer: `cus_${backendLabel}_mono_${suffix}`,
                subscription: sub,
                payment_intent: pi,
                payment_status: 'paid',
                amount_total: 1900,
                currency: 'usd',
                metadata: { userId: u.id, planId: 'pro' },
              },
            },
          });
          await billingService.handleWebhook(chk.rawBody, chk.signature);
          return { user: u, pi, chg, sub };
        };

        // Scenarios 1–6: pending -> succeeded -> stale [pending, requires_action, failed, canceled, unknown/missing] -> duplicate succeeded (distinct event.id)
        const staleTransitions: Array<{ label: string; statusVal: any; evtType?: string }> = [
          { label: 'stale_pending', statusVal: 'pending' },
          { label: 'stale_requires_action', statusVal: 'requires_action' },
          { label: 'stale_failed', statusVal: 'failed', evtType: 'refund.failed' },
          { label: 'stale_canceled', statusVal: 'canceled' },
          { label: 'stale_unknown', statusVal: 'unexpected_gateway_status' },
          { label: 'stale_missing_status', statusVal: undefined },
        ];

        for (const stCase of staleTransitions) {
          const { user: uI, pi: piI, chg: chgI } = await setupPaidProUser(stCase.label);
          const refI = `re_${backendLabel}_${stCase.label}_${Date.now()}`;
          const tsBase = nextTs();
          const tsPending = tsBase;
          const tsSucceeded = tsBase + 20;
          const tsStale = tsBase + 5; // Older than succeeded, arrives AFTER succeeded

          // 1) Legitimate initial pending event
          const evPending = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_${stCase.label}_1_pend`,
            created: tsPending,
            type: 'refund.created',
            data: { object: { id: refI, payment_intent: piI, charge: chgI, amount: 1900, status: 'pending' } },
          });
          await billingService.handleWebhook(evPending.rawBody, evPending.signature);
          assert.strictEqual((await inspectState()).getRefund(refI)?.status, 'pending', `${backendLabel} A4.${stCase.label}: initial pending recorded`);
          assert.strictEqual((await repo.users.getUser(uI.id))?.creditsRemaining, 85, `${backendLabel} A4.${stCase.label}: pending does not deduct credits`);

          // 2) Succeeded event arrives
          const evSucc = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_${stCase.label}_2_succ`,
            created: tsSucceeded,
            type: 'refund.updated',
            data: { object: { id: refI, payment_intent: piI, charge: chgI, amount: 1900, status: 'succeeded' } },
          });
          await billingService.handleWebhook(evSucc.rawBody, evSucc.signature);
          const txCountAfterSucc = (await inspectState()).countCreditTxs(uI.id);
          assert.strictEqual((await repo.users.getUser(uI.id))?.creditsRemaining, 10, `${backendLabel} A4.${stCase.label}: succeeded deducts 75 credits`);
          assert.strictEqual((await repo.users.getUser(uI.id))?.plan, 'free', `${backendLabel} A4.${stCase.label}: succeeded revokes plan`);

          // 3) Stale non-success event arrives later with DIFFERENT event.id
          const evStale = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_${stCase.label}_3_stale`,
            created: tsStale,
            type: stCase.evtType || 'refund.updated',
            data: {
              object: {
                id: refI,
                payment_intent: piI,
                charge: chgI,
                amount: 1900,
                ...(stCase.statusVal !== undefined ? { status: stCase.statusVal } : {}),
              },
            },
          });
          await billingService.handleWebhook(evStale.rawBody, evStale.signature);

          const snapAfterStale = await inspectState();
          const refundAfterStale = snapAfterStale.getRefund(refI);
          assert.strictEqual(refundAfterStale?.status, 'succeeded', `${backendLabel} A4.${stCase.label}: refund stays succeeded`);
          assert.strictEqual(refundAfterStale?.creditsAdjusted, 75, `${backendLabel} A4.${stCase.label}: creditsAdjusted preserved at 75`);
          assert.strictEqual(refundAfterStale?.reconciled, true, `${backendLabel} A4.${stCase.label}: reconciled stays true`);
          assert.strictEqual((await repo.users.getUser(uI.id))?.creditsRemaining, 10, `${backendLabel} A4.${stCase.label}: creditsRemaining unchanged`);
          assert.strictEqual(snapAfterStale.countCreditTxs(uI.id), txCountAfterSucc, `${backendLabel} A4.${stCase.label}: zero spurious credit_transactions (no STRIPE_REFUND_FAILED)`);

          // 4) Subsequent succeeded event with DIFFERENT event.id does NOT double-deduct
          const evDupSucc = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_${stCase.label}_4_dupsucc`,
            created: tsSucceeded + 10,
            type: 'refund.updated',
            data: { object: { id: refI, payment_intent: piI, charge: chgI, amount: 1900, status: 'succeeded' } },
          });
          await billingService.handleWebhook(evDupSucc.rawBody, evDupSucc.signature);
          assert.strictEqual((await repo.users.getUser(uI.id))?.creditsRemaining, 10, `${backendLabel} A4.${stCase.label}: subsequent succeeded with different event.id does not double-deduct`);
          assert.strictEqual((await inspectState()).countCreditTxs(uI.id), txCountAfterSucc, `${backendLabel} A4.${stCase.label}: tx count unchanged after duplicate succeeded`);
        }

        // Scenario 7: charge.refunded carrying already-processed Refund ID (+ mixed new partial refund)
        {
          const { user: uChg, pi: piChg, chg: chgId } = await setupPaidProUser('charge_refunded_dedup');
          const ref1 = `re_${backendLabel}_chg_1_${Date.now()}`;
          const ref2 = `re_${backendLabel}_chg_2_${Date.now()}`;

          // Process 50% partial refund first
          const evP1 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_chg_p1`,
            created: nextTs(),
            type: 'refund.created',
            data: { object: { id: ref1, payment_intent: piChg, charge: chgId, amount: 950, status: 'succeeded' } },
          });
          await billingService.handleWebhook(evP1.rawBody, evP1.signature);
          assert.strictEqual((await repo.users.getUser(uChg.id))?.creditsRemaining, 48, `${backendLabel} A4.7: 50% partial deducts 37 via BigInt floor (85 -> 48)`);

          // Duplicate charge.refunded containing ONLY ref1 with different event.id
          const evChgDup = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_chg_dup_only_ref1`,
            created: nextTs(),
            type: 'charge.refunded',
            data: {
              object: {
                id: chgId,
                payment_intent: piChg,
                amount: 1900,
                amount_refunded: 950,
                refunded: false,
                refunds: { data: [{ id: ref1, amount: 950, status: 'succeeded' }] },
              },
            },
          });
          await billingService.handleWebhook(evChgDup.rawBody, evChgDup.signature);
          assert.strictEqual((await repo.users.getUser(uChg.id))?.creditsRemaining, 48, `${backendLabel} A4.7: charge.refunded with existing ref1 does not re-deduct`);

          // Now charge.refunded carrying BOTH already-processed ref1 AND new ref2 completing 100%
          const evChgMixed = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_chg_mixed`,
            created: nextTs(),
            type: 'charge.refunded',
            data: {
              object: {
                id: chgId,
                payment_intent: piChg,
                amount: 1900,
                amount_refunded: 1900,
                refunded: true,
                refunds: {
                  data: [
                    { id: ref1, amount: 950, status: 'succeeded' },
                    { id: ref2, amount: 950, status: 'succeeded' },
                  ],
                },
              },
            },
          });
          await billingService.handleWebhook(evChgMixed.rawBody, evChgMixed.signature);
          assert.strictEqual((await repo.users.getUser(uChg.id))?.creditsRemaining, 10, `${backendLabel} A4.7: mixed charge.refunded only deducts net remaining 38 credits (48 -> 10)`);
          assert.strictEqual((await repo.users.getUser(uChg.id))?.plan, 'free', `${backendLabel} A4.7: full cumulative refund revokes plan`);
        }

        // Scenarios 8 & 9: Out-of-order timestamps + Equal timestamps (same event.created) + missing timestamp protection
        {
          const { user: uTs, pi: piTs } = await setupPaidProUser('timestamps');
          const refTs = `re_${backendLabel}_ts_${Date.now()}`;
          const fixedTs = nextTs() + 100;

          // Succeeded at fixedTs
          const evSuccSameTs = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_ts_succ`,
            created: fixedTs,
            type: 'refund.updated',
            data: { object: { id: refTs, payment_intent: piTs, amount: 1900, status: 'succeeded' } },
          });
          await billingService.handleWebhook(evSuccSameTs.rawBody, evSuccSameTs.signature);
          const txBeforeSameTs = (await inspectState()).countCreditTxs(uTs.id);

          // Same timestamp (created === fixedTs) pending & failed & missing-timestamp unknown
          for (const sameCase of [
            { id: 'same_pending', status: 'pending', created: fixedTs },
            { id: 'same_failed', status: 'failed', created: fixedTs },
            { id: 'future_pending', status: 'pending', created: fixedTs + 50 }, // Even with clock skew, succeeded is terminal
            { id: 'no_ts_unknown', status: undefined, created: 0 },
          ]) {
            const ev = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
              id: `evt_${backendLabel}_ts_${sameCase.id}`,
              created: sameCase.created,
              type: 'refund.updated',
              data: {
                object: {
                  id: refTs,
                  payment_intent: piTs,
                  amount: 1900,
                  ...(sameCase.status ? { status: sameCase.status } : {}),
                },
              },
            });
            await billingService.handleWebhook(ev.rawBody, ev.signature);
          }

          const snapTs = await inspectState();
          assert.strictEqual(snapTs.getRefund(refTs)?.status, 'succeeded', `${backendLabel} A4.8/9: succeeded preserved across equal/skewed/missing timestamps`);
          assert.strictEqual(snapTs.getRefund(refTs)?.creditsAdjusted, 75, `${backendLabel} A4.8/9: creditsAdjusted=75 preserved`);
          assert.strictEqual(snapTs.getRefund(refTs)?.reconciled, true, `${backendLabel} A4.8/9: reconciled=true preserved`);
          assert.strictEqual((await repo.users.getUser(uTs.id))?.creditsRemaining, 10, `${backendLabel} A4.8/9: balance=10 preserved`);
          assert.strictEqual(snapTs.countCreditTxs(uTs.id), txBeforeSameTs, `${backendLabel} A4.8/9: no extra tx recorded`);

          // Non-succeeded out-of-order: failed at T+10 must not regress to pending at T+5
          const refFailOrder = `re_${backendLabel}_fail_ooo_${Date.now()}`;
          const evFailNewer = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_fail_newer`,
            created: fixedTs + 10,
            type: 'refund.failed',
            data: { object: { id: refFailOrder, payment_intent: piTs, amount: 500, status: 'failed', failure_reason: 'expired_or_canceled_card' } },
          });
          await billingService.handleWebhook(evFailNewer.rawBody, evFailNewer.signature);

          const evPendOlder = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_pend_older`,
            created: fixedTs + 5,
            type: 'refund.created',
            data: { object: { id: refFailOrder, payment_intent: piTs, amount: 500, status: 'pending' } },
          });
          await billingService.handleWebhook(evPendOlder.rawBody, evPendOlder.signature);
          assert.strictEqual((await inspectState()).getRefund(refFailOrder)?.status, 'failed', `${backendLabel} A4.8: newer failed cannot regress to older pending`);
        }

        // Scenario 10: Transaction rollback followed by retry + stale protection post-retry
        {
          const { user: uRb, pi: piRb } = await setupPaidProUser('rb_retry');
          const refRb = `re_${backendLabel}_rb_retry_${Date.now()}`;
          const evtRb = `evt_${backendLabel}_rb_retry`;
          const tsRb = nextTs();

          await assert.rejects(
            () => repo.runTransaction(async (state) => {
              (billingService as any).processRefundWebhook(state, {
                id: evtRb,
                created: tsRb + 10,
                type: 'refund.updated',
                data: { object: { id: refRb, payment_intent: piRb, amount: 1900, status: 'succeeded' } },
              });
              throw new Error('SIMULATED_REFUND_ROLLBACK');
            }),
            /SIMULATED_REFUND_ROLLBACK/
          );
          assert.strictEqual((await repo.users.getUser(uRb.id))?.creditsRemaining, 85, `${backendLabel} A4.10: rollback leaves balance intact`);
          assert.strictEqual((await inspectState()).getRefund(refRb), undefined, `${backendLabel} A4.10: rollback leaves no refund row`);

          // Retry succeeds cleanly
          const retryEv = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: evtRb,
            created: tsRb + 10,
            type: 'refund.updated',
            data: { object: { id: refRb, payment_intent: piRb, amount: 1900, status: 'succeeded' } },
          });
          await billingService.handleWebhook(retryEv.rawBody, retryEv.signature);
          assert.strictEqual((await repo.users.getUser(uRb.id))?.creditsRemaining, 10, `${backendLabel} A4.10: retry after rollback deducts 75`);

          // Late stale pending after rollback+retry must be ignored
          const staleAfterRb = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `${evtRb}_stale_pend`,
            created: tsRb,
            type: 'refund.created',
            data: { object: { id: refRb, payment_intent: piRb, amount: 1900, status: 'pending' } },
          });
          await billingService.handleWebhook(staleAfterRb.rawBody, staleAfterRb.signature);
          const snapRb = await inspectState();
          assert.strictEqual(snapRb.getRefund(refRb)?.status, 'succeeded', `${backendLabel} A4.10: stays succeeded post-retry`);
          assert.strictEqual(snapRb.getRefund(refRb)?.creditsAdjusted, 75, `${backendLabel} A4.10: creditsAdjusted stays 75 post-retry`);
        }

        // Scenario 11 & 12: Sequential partial refunds completing full refund + late pending event
        {
          const { user: uSeq, pi: piSeq } = await setupPaidProUser('seq_partial');
          const rPart1 = `re_${backendLabel}_seq_p1_${Date.now()}`;
          const rPart2 = `re_${backendLabel}_seq_p2_${Date.now()}`;
          const t0 = nextTs();

          const evS1 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_seq_1`,
            created: t0 + 1,
            type: 'refund.updated',
            data: { object: { id: rPart1, payment_intent: piSeq, amount: 760, status: 'succeeded' } }, // 40% => 30 credits
          });
          await billingService.handleWebhook(evS1.rawBody, evS1.signature);
          assert.strictEqual((await repo.users.getUser(uSeq.id))?.creditsRemaining, 55, `${backendLabel} A4.11: 40% partial deducts 30 (85 -> 55)`);
          assert.strictEqual((await inspectState()).getPaymentByIntent(piSeq)?.status, 'partially_refunded', `${backendLabel} A4.11: payment is partially_refunded`);

          const evS2 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_${backendLabel}_seq_2`,
            created: t0 + 2,
            type: 'refund.updated',
            data: { object: { id: rPart2, payment_intent: piSeq, amount: 1140, status: 'succeeded' } }, // +60% => remaining 45 credits
          });
          await billingService.handleWebhook(evS2.rawBody, evS2.signature);
          const txAfterFullSeq = (await inspectState()).countCreditTxs(uSeq.id);
          assert.strictEqual((await repo.users.getUser(uSeq.id))?.creditsRemaining, 10, `${backendLabel} A4.11: 40%+60% deducts total 75 (55 -> 10)`);
          assert.strictEqual((await repo.users.getUser(uSeq.id))?.plan, 'free', `${backendLabel} A4.11: cumulative full refund revokes plan`);
          assert.strictEqual((await inspectState()).getPaymentByIntent(piSeq)?.status, 'refunded', `${backendLabel} A4.11: payment is refunded`);

          // Late stale pending events for BOTH rPart1 and rPart2
          for (const [idx, refId] of [rPart1, rPart2].entries()) {
            const evLatePend = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
              id: `evt_${backendLabel}_seq_late_pend_${idx}`,
              created: t0,
              type: 'refund.created',
              data: { object: { id: refId, payment_intent: piSeq, amount: idx === 0 ? 760 : 1140, status: 'pending' } },
            });
            await billingService.handleWebhook(evLatePend.rawBody, evLatePend.signature);
          }

          const snapSeq = await inspectState();
          assert.strictEqual(snapSeq.getRefund(rPart1)?.status, 'succeeded', `${backendLabel} A4.11/12: rPart1 stays succeeded`);
          assert.strictEqual(snapSeq.getRefund(rPart1)?.creditsAdjusted, 30, `${backendLabel} A4.11/12: rPart1 creditsAdjusted stays 30`);
          assert.strictEqual(snapSeq.getRefund(rPart1)?.reconciled, true, `${backendLabel} A4.11/12: rPart1 reconciled stays true`);
          assert.strictEqual(snapSeq.getRefund(rPart2)?.status, 'succeeded', `${backendLabel} A4.11/12: rPart2 stays succeeded`);
          assert.strictEqual(snapSeq.getRefund(rPart2)?.creditsAdjusted, 45, `${backendLabel} A4.11/12: rPart2 creditsAdjusted stays 45`);
          assert.strictEqual(snapSeq.getRefund(rPart2)?.reconciled, true, `${backendLabel} A4.11/12: rPart2 reconciled stays true`);
          assert.strictEqual(snapSeq.countCreditTxs(uSeq.id), txAfterFullSeq, `${backendLabel} A4.11/12: zero extra credit transactions`);
        }
      } finally {
        billingService.setStorageForTest(null);
      }
    };

    const matrixSqliteRepo = new SqliteStorageRepository(path.join(tempSqliteDir, 'refund_matrix.db'));
    await runExtendedRefundMatrix('sqlite', matrixSqliteRepo, async () => {
      const db = (matrixSqliteRepo as any).db;
      return {
        getRefund: (refundId: string) => {
          const r = db.prepare('SELECT * FROM stripe_refunds WHERE refund_id = ?').get(refundId) as any;
          if (!r) return undefined;
          return {
            refundId: r.refund_id,
            status: r.status,
            rawStatus: r.raw_status || undefined,
            reconciled: Boolean(r.reconciled),
            creditsAdjusted: Number(r.credits_adjusted || 0),
            lastEventCreated: r.last_event_created !== null && r.last_event_created !== undefined ? Number(r.last_event_created) : undefined,
          };
        },
        getPaymentByIntent: (pi: string) => db.prepare('SELECT * FROM stripe_payments WHERE payment_intent_id = ?').get(pi),
        getWebhook: (evtId: string) => db.prepare('SELECT * FROM webhook_events WHERE event_id = ?').get(evtId),
        countCreditTxs: (userId: string) => Number((db.prepare('SELECT COUNT(*) as c FROM credit_transactions WHERE user_id = ?').get(userId) as any).c),
      };
    });

    const matrixMemRepo = new InMemoryStorageRepository(path.join(tempSqliteDir, 'refund_matrix_mem.json'));
    await runExtendedRefundMatrix('inmemory', matrixMemRepo, async () => {
      const st = (matrixMemRepo as any).state;
      return {
        getRefund: (refundId: string) => st.stripeRefunds[refundId],
        getPaymentByIntent: (pi: string) => Object.values(st.stripePayments || {}).find((p: any) => p.paymentIntentId === pi),
        getWebhook: (evtId: string) => st.webhookEvents[evtId],
        countCreditTxs: (userId: string) => (st.creditTransactions || []).filter((t: any) => t.userId === userId).length,
      };
    });

    console.log('  ✅ PASS: 20-case refund matrix, 12-scenario monotonic out-of-order protection, & SQLite/InMemory parity verified');

    // =========================================================================
    // PART B2: SQLITE RESTART PERSISTENCE & CONCURRENT WEBHOOK RACE PROTECTION
    // =========================================================================
    console.log('\n[B2. SQLite Restart Persistence & Concurrent Refund Webhook Ordering]');

    const restartDbPath = path.join(tempSqliteDir, 'refund_restart_persist.db');
    let persistUserId = '';
    let persistPi = '';
    const persistRef = `re_restart_${Date.now()}`;
    const persistBaseTs = 1800000000;

    {
      const repo1 = new SqliteStorageRepository(restartDbPath);
      billingService.setStorageForTest(repo1);
      try {
        const u = await repo1.users.createUser(`restart_${Date.now()}@videorisk.test`, 'hash', 'salt', 10, 'free');
        persistUserId = u.id;
        persistPi = `pi_restart_${Date.now()}`;
        const payEv = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_restart_pay_${Date.now()}`,
          created: persistBaseTs,
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_restart_${Date.now()}`,
              payment_status: 'paid',
              payment_intent: persistPi,
              amount_total: 1900,
              currency: 'usd',
              metadata: { userId: u.id, planId: 'pro' },
            },
          },
        });
        await billingService.handleWebhook(payEv.rawBody, payEv.signature);

        const sucEv = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_restart_suc_${Date.now()}`,
          created: persistBaseTs + 20,
          type: 'refund.updated',
          data: { object: { id: persistRef, payment_intent: persistPi, amount: 1900, status: 'succeeded' } },
        });
        await billingService.handleWebhook(sucEv.rawBody, sucEv.signature);
        assert.strictEqual((await repo1.users.getUser(u.id))?.creditsRemaining, 10, 'B2.1 Pre-restart succeeded refund deducted 75 credits (85 -> 10)');
      } finally {
        billingService.setStorageForTest(null);
        (repo1 as any).db.close();
      }
    }

    // Reopen fresh SqliteStorageRepository instance from disk (simulating process restart)
    {
      const repo2 = new SqliteStorageRepository(restartDbPath);
      billingService.setStorageForTest(repo2);
      try {
        const stalePendingAfterRestart = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_restart_stale_pending_${Date.now()}`,
          created: persistBaseTs + 5,
          type: 'refund.created',
          data: { object: { id: persistRef, payment_intent: persistPi, amount: 1900, status: 'pending' } },
        });
        await billingService.handleWebhook(stalePendingAfterRestart.rawBody, stalePendingAfterRestart.signature);

        const staleFailedAfterRestart = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_restart_stale_failed_${Date.now()}`,
          created: persistBaseTs + 10,
          type: 'refund.failed',
          data: { object: { id: persistRef, payment_intent: persistPi, amount: 1900, status: 'failed' } },
        });
        await billingService.handleWebhook(staleFailedAfterRestart.rawBody, staleFailedAfterRestart.signature);

        const db2 = (repo2 as any).db;
        const row = db2.prepare('SELECT * FROM stripe_refunds WHERE refund_id = ?').get(persistRef) as any;
        assert.strictEqual(row.status, 'succeeded', 'B2.2 Persisted succeeded status survives DB restart and blocks older pending/failed');
        assert.strictEqual(Number(row.last_event_created), persistBaseTs + 20, 'B2.3 Persisted last_event_created survives DB restart');
        assert.strictEqual(Number(row.credits_adjusted), 75, 'B2.4 Persisted credits_adjusted remains 75');
        assert.strictEqual(Boolean(row.reconciled), true, 'B2.5 Persisted reconciled remains true');
        assert.strictEqual((await repo2.users.getUser(persistUserId))?.creditsRemaining, 10, 'B2.6 User balance unchanged across restart stale events');

        // Concurrent Promise.all race: pending (T+5), succeeded (T+20), duplicate succeeded (T+21, new event.id), failed (T+10)
        const raceUser = await repo2.users.createUser(`race_${Date.now()}@videorisk.test`, 'hash', 'salt', 10, 'free');
        const racePi = `pi_race_${Date.now()}`;
        const racePay = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
          id: `evt_race_pay_${Date.now()}`,
          created: persistBaseTs,
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_race_${Date.now()}`,
              payment_status: 'paid',
              payment_intent: racePi,
              amount_total: 1900,
              currency: 'usd',
              metadata: { userId: raceUser.id, planId: 'pro' },
            },
          },
        });
        await billingService.handleWebhook(racePay.rawBody, racePay.signature);

        const raceRef = `re_race_${Date.now()}`;
        const racePayloads = [
          buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_race_pend_${Date.now()}`,
            created: persistBaseTs + 5,
            type: 'refund.created',
            data: { object: { id: raceRef, payment_intent: racePi, amount: 1900, status: 'pending' } },
          }),
          buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_race_suc1_${Date.now()}`,
            created: persistBaseTs + 20,
            type: 'refund.updated',
            data: { object: { id: raceRef, payment_intent: racePi, amount: 1900, status: 'succeeded' } },
          }),
          buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_race_suc2_${Date.now()}`,
            created: persistBaseTs + 21,
            type: 'refund.updated',
            data: { object: { id: raceRef, payment_intent: racePi, amount: 1900, status: 'succeeded' } },
          }),
          buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
            id: `evt_race_fail_${Date.now()}`,
            created: persistBaseTs + 10,
            type: 'refund.failed',
            data: { object: { id: raceRef, payment_intent: racePi, amount: 1900, status: 'failed' } },
          }),
        ];

        await Promise.all(racePayloads.map(p => billingService.handleWebhook(p.rawBody, p.signature)));

        const raceRow = db2.prepare('SELECT * FROM stripe_refunds WHERE refund_id = ?').get(raceRef) as any;
        const raceTxCount = Number((db2.prepare("SELECT COUNT(*) as c FROM credit_transactions WHERE user_id = ? AND type = 'STRIPE_PAYMENT_REFUND'").get(raceUser.id) as any).c);
        assert.strictEqual(raceRow.status, 'succeeded', 'B2.7 Concurrent race settles deterministically at terminal succeeded');
        assert.strictEqual(Number(raceRow.credits_adjusted), 75, 'B2.8 Concurrent race deducts credits exactly once (75)');
        assert.strictEqual(raceTxCount, 1, 'B2.9 Concurrent race records exactly 1 STRIPE_PAYMENT_REFUND ledger row');
        assert.strictEqual((await repo2.users.getUser(raceUser.id))?.creditsRemaining, 10, 'B2.10 Concurrent race leaves exact balance 10');
      } finally {
        billingService.setStorageForTest(null);
        (repo2 as any).db.close();
      }
    }

    console.log('  ✅ PASS: SQLite restart persistence & concurrent refund webhook race protection verified');

    // =========================================================================
    // PART C: WS4 SUBSCRIPTION ORDERING, MULTI-SUB ISOLATION, CANCEL_AT_PERIOD_END,
    // INVOICE.PAYMENT_ACTION_REQUIRED & RENEWAL DEDUP (MOCKED SDK / REAL HMAC)
    // =========================================================================
    console.log('\n[C. WS4 Subscription Event Ordering, Multi-Sub Isolation & Renewal Dedup (Mocked Webhook Signatures)]');

    const ws4DbPath = path.join(tempSqliteDir, 'ws4_sub_lifecycle.db');
    const ws4Repo1 = new SqliteStorageRepository(ws4DbPath);
    billingService.setStorageForTest(ws4Repo1);
    const ws4BaseTs = 1900000000;

    let subUserAId = '';
    try {
      const subUserA = await ws4Repo1.users.createUser(`ws4_sub_a_${Date.now()}@videorisk.test`, 'hash', 'salt', 10, 'free');
      subUserAId = subUserA.id;
      const subOldId = `sub_old_${Date.now()}`;
      const subNewId = `sub_new_${Date.now()}`;

      // C.1 Activate sub_old via checkout.session.completed (creator plan -> +25 credits = 35)
      const evCheckoutOld = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_ws4_co_old_${Date.now()}`,
        created: ws4BaseTs,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_ws4_old_${Date.now()}`,
            payment_status: 'paid',
            payment_intent: `pi_ws4_old_${Date.now()}`,
            subscription: subOldId,
            customer: `cus_ws4_${subUserA.id}`,
            amount_total: 900,
            currency: 'usd',
            metadata: { userId: subUserA.id, planId: 'creator' },
          },
        },
      });
      await billingService.handleWebhook(evCheckoutOld.rawBody, evCheckoutOld.signature);
      assert.strictEqual((await ws4Repo1.users.getUser(subUserA.id))?.plan, 'creator', 'C.1 Initial subscription sets plan=creator');

      // C.2 Cancel_at_period_end persisted while keeping plan active until period end
      const evCancelAtPeriodEnd = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_ws4_cap_${Date.now()}`,
        created: ws4BaseTs + 10,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: subOldId,
            customer: `cus_ws4_${subUserA.id}`,
            status: 'active',
            cancel_at_period_end: true,
            current_period_end: ws4BaseTs + 86400,
            metadata: { userId: subUserA.id, planId: 'creator' },
          },
        },
      });
      await billingService.handleWebhook(evCancelAtPeriodEnd.rawBody, evCancelAtPeriodEnd.signature);
      const subOldAfterCap = await ws4Repo1.billing.getSubscription(subOldId);
      assert.strictEqual(subOldAfterCap?.cancelAtPeriodEnd, true, 'C.2a cancelAtPeriodEnd=true persisted in SQLite');
      assert.strictEqual(subOldAfterCap?.lastEventCreated, ws4BaseTs + 10, 'C.2b lastEventCreated updated monotonically');
      assert.strictEqual((await ws4Repo1.users.getUser(subUserA.id))?.plan, 'creator', 'C.2c Plan remains active before period end');

      // C.3 Invoice renewal dedup across different event IDs with SAME invoice.id
      const renewalInvId = `in_ws4_renewal_${Date.now()}`;
      const evRen1 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_ws4_ren_1_${Date.now()}`,
        created: ws4BaseTs + 20,
        type: 'invoice.paid',
        data: {
          object: {
            id: renewalInvId,
            subscription: subOldId,
            customer: `cus_ws4_${subUserA.id}`,
            billing_reason: 'subscription_cycle',
            amount_paid: 900,
            currency: 'usd',
          },
        },
      });
      const evRen2 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_ws4_ren_2_${Date.now()}`,
        created: ws4BaseTs + 21,
        type: 'invoice.paid',
        data: {
          object: {
            id: renewalInvId, // Same invoice ID delivered under new event ID
            subscription: subOldId,
            customer: `cus_ws4_${subUserA.id}`,
            billing_reason: 'subscription_cycle',
            amount_paid: 900,
            currency: 'usd',
          },
        },
      });
      await billingService.handleWebhook(evRen1.rawBody, evRen1.signature);
      const balAfterRen1 = (await ws4Repo1.users.getUser(subUserA.id))!.creditsRemaining;
      assert.strictEqual(balAfterRen1, 70, 'C.3a First subscription_cycle invoice grants +30 creator credits (40 -> 70)');
      await billingService.handleWebhook(evRen2.rawBody, evRen2.signature);
      assert.strictEqual((await ws4Repo1.users.getUser(subUserA.id))?.creditsRemaining, 70, 'C.3b Duplicate invoice.id under new event.id does NOT double-credit');

      // C.4 Out-of-order subscription transition: newer deleted (T+50) followed by older active updated (T+30) -> deleted wins!
      const evDelNewer = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_ws4_del_newer_${Date.now()}`,
        created: ws4BaseTs + 50,
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: subOldId,
            customer: `cus_ws4_${subUserA.id}`,
            status: 'canceled',
            metadata: { userId: subUserA.id, planId: 'creator' },
          },
        },
      });
      const evUpdStale = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_ws4_upd_stale_${Date.now()}`,
        created: ws4BaseTs + 30,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: subOldId,
            customer: `cus_ws4_${subUserA.id}`,
            status: 'active',
            metadata: { userId: subUserA.id, planId: 'creator' },
          },
        },
      });
      await billingService.handleWebhook(evDelNewer.rawBody, evDelNewer.signature);
      await billingService.handleWebhook(evUpdStale.rawBody, evUpdStale.signature);
      assert.strictEqual((await ws4Repo1.billing.getSubscription(subOldId))?.status, 'canceled', 'C.4a Newer subscription.deleted survives older subscription.updated');
      assert.strictEqual((await ws4Repo1.users.getUser(subUserA.id))?.plan, 'free', 'C.4b User downgraded to free after stale update ignored');

      // C.5 Same-second tie-breaker: updated active at T+60 followed by deleted at T+60 -> canceled; plus payment_action_required -> incomplete
      const evSub2Co = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_ws4_co_new_${Date.now()}`,
        created: ws4BaseTs + 55,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_ws4_new_${Date.now()}`,
            payment_status: 'paid',
            payment_intent: `pi_ws4_new_${Date.now()}`,
            subscription: subNewId,
            customer: `cus_ws4_${subUserA.id}`,
            amount_total: 1900,
            currency: 'usd',
            metadata: { userId: subUserA.id, planId: 'pro' },
          },
        },
      });
      await billingService.handleWebhook(evSub2Co.rawBody, evSub2Co.signature);
      assert.strictEqual((await ws4Repo1.users.getUser(subUserA.id))?.plan, 'pro', 'C.5a New subscription activates pro plan');

      // C.6 Multi-subscription isolation: re-deliver canceled/failed event for subOldId MUST NOT downgrade active pro subNewId!
      const evOldSubFail = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_ws4_old_fail_${Date.now()}`,
        created: ws4BaseTs + 70,
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: `in_ws4_old_fail_${Date.now()}`,
            subscription: subOldId,
            customer: `cus_ws4_${subUserA.id}`,
          },
        },
      });
      await billingService.handleWebhook(evOldSubFail.rawBody, evOldSubFail.signature);
      const userAfterOldSubFail = await ws4Repo1.users.getUser(subUserA.id);
      assert.strictEqual(userAfterOldSubFail?.plan, 'pro', 'C.6a Failure on old subscription does NOT downgrade active pro subscription');
      assert.strictEqual(userAfterOldSubFail?.subscriptionId, subNewId, 'C.6b Primary subscriptionId preserved on subNewId');
      assert.strictEqual(userAfterOldSubFail?.subscriptionStatus, 'active', 'C.6c Active status preserved');

      // C.7 invoice.payment_action_required updates active subscription to 'incomplete' and persists lastEventCreated
      const evActionReq = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_ws4_act_req_${Date.now()}`,
        created: ws4BaseTs + 80,
        type: 'invoice.payment_action_required',
        data: {
          object: {
            id: `in_ws4_act_req_${Date.now()}`,
            subscription: subNewId,
            customer: `cus_ws4_${subUserA.id}`,
          },
        },
      });
      await billingService.handleWebhook(evActionReq.rawBody, evActionReq.signature);
      const subNewAfterAction = await ws4Repo1.billing.getSubscription(subNewId);
      assert.strictEqual(subNewAfterAction?.status, 'incomplete', 'C.7a invoice.payment_action_required transitions sub to incomplete');
      assert.strictEqual(subNewAfterAction?.lastEventCreated, ws4BaseTs + 80, 'C.7b invoice.payment_action_required persists lastEventCreated');

      // Same-second terminal canceled tie-breaker at T+90
      const evSameSecActive = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_ws4_same_sec_act_${Date.now()}`,
        created: ws4BaseTs + 90,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: subNewId,
            customer: `cus_ws4_${subUserA.id}`,
            status: 'active',
            metadata: { userId: subUserA.id, planId: 'pro' },
          },
        },
      });
      const evSameSecCanceled = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_ws4_same_sec_del_${Date.now()}`,
        created: ws4BaseTs + 90,
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: subNewId,
            customer: `cus_ws4_${subUserA.id}`,
            status: 'canceled',
            metadata: { userId: subUserA.id, planId: 'pro' },
          },
        },
      });
      await billingService.handleWebhook(evSameSecCanceled.rawBody, evSameSecCanceled.signature);
      await billingService.handleWebhook(evSameSecActive.rawBody, evSameSecActive.signature);
      assert.strictEqual((await ws4Repo1.billing.getSubscription(subNewId))?.status, 'canceled', 'C.8 Same-second terminal canceled wins over active update at identical created timestamp');
    } finally {
      billingService.setStorageForTest(null);
      (ws4Repo1 as any).db.close();
    }

    // Reopen SQLite DB from disk to confirm Migration 9 columns survived persistence cleanly
    const ws4Repo2 = new SqliteStorageRepository(ws4DbPath);
    try {
      const subs = await ws4Repo2.billing.getSubscriptionsByUserId(subUserAId);
      assert.ok(subs.length === 2, 'C.9a Both subscriptions persisted cleanly across SQLite restart');
      assert.ok(subs.every(s => typeof s.lastEventCreated === 'number' && s.lastEventCreated > 0), 'C.9b last_event_created survives SQLite restart');
      assert.ok(subs.some(s => s.cancelAtPeriodEnd === true), 'C.9c cancel_at_period_end survives SQLite restart');
    } finally {
      (ws4Repo2 as any).db.close();
    }

    console.log('  ✅ PASS: WS4 subscription event ordering, multi-sub isolation, cancel_at_period_end, & renewal dedup verified');

    // ------------------------------------------------------------------------
    // 5. TASK A: CANONICAL PRODUCTION PREDICATE, CONFLICT DETECTION & LIVE ORIGIN HARDENING
    // ------------------------------------------------------------------------
    console.log('\n[5. Task A: Canonical Production Predicate, Conflict Detection & Live-Payment Origin Hardening]');

    const savedStripeEnv = {
      STRIPE_PRICE_CREATOR: process.env.STRIPE_PRICE_CREATOR,
      STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
      STRIPE_PRICE_AGENCY: process.env.STRIPE_PRICE_AGENCY,
      STRIPE_PRICE_AUDIT_ONCE: process.env.STRIPE_PRICE_AUDIT_ONCE,
      MEDIA_TOKEN_SECRET: process.env.MEDIA_TOKEN_SECRET,
      PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER,
    };

    try {
      const taskAUser = await storage.users.createUser(
        `task_a_canonical_${Date.now()}@videorisk.test`,
        'hash_a',
        'salt_a',
        10,
        'free'
      );
      const taskAToken = await storage.users.createSession(taskAUser.id);

      // 5.1 NODE_ENV=production + PAYMENT_MODE=test -> conflict rejected
      const conflictProdTest = resolveEnvironmentSecurity({
        NODE_ENV: 'production',
        PAYMENT_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_12345678901234567890',
      });
      assert.strictEqual(conflictProdTest.isProduction, true, '5.1a NODE_ENV=production keeps canonical isProduction=true');
      assert.strictEqual(conflictProdTest.hasConflict, true, '5.1b NODE_ENV=production + PAYMENT_MODE=test flags conflict');
      assert.ok(conflictProdTest.conflicts.some(c => c.code === 'PROD_TEST_MODE_CONFLICT'), '5.1c Reports PROD_TEST_MODE_CONFLICT');

      const valProdTest = validateBillingConfiguration('production', {
        NODE_ENV: 'production',
        PAYMENT_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_live_mock1234567890abcdef',
        STRIPE_WEBHOOK_SECRET: 'whsec_mock1234567890abcdef',
        STRIPE_PRICE_CREATOR: 'price_c',
        STRIPE_PRICE_PRO: 'price_p',
        STRIPE_PRICE_AGENCY: 'price_a',
        STRIPE_PRICE_AUDIT_ONCE: 'price_o',
        APP_BASE_URL: 'https://videorisk.com',
      });
      assert.strictEqual(valProdTest.valid, false, '5.1d validateBillingConfiguration rejects NODE_ENV=production + PAYMENT_MODE=test');

      process.env.NODE_ENV = 'production';
      process.env.PAYMENT_MODE = 'test';
      process.env.STRIPE_SECRET_KEY = 'sk_live_mock1234567890abcdef';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock1234567890abcdef';
      process.env.APP_BASE_URL = 'https://videorisk.com';
      const readinessProdTest = await (await fetch(`${baseUrl}/health/readiness`)).json();
      assert.strictEqual(readinessProdTest.checks.billing.status, 'degraded', '5.1e Readiness degraded on NODE_ENV=production + PAYMENT_MODE=test');
      assert.strictEqual(readinessProdTest.checks.billing.details.checkoutAvailable, false, '5.1f Checkout disabled on conflict');
      const checkoutProdTestRes = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${taskAToken}` },
        body: JSON.stringify({ planId: 'pro' }),
      });
      assert.strictEqual(checkoutProdTestRes.status, 500, '5.1g Checkout fails closed with 500 on conflict');

      // 5.2 NODE_ENV=production + PAYMENT_MODE=live with valid HTTPS config -> valid & trusted HTTPS origin works
      const validProdLiveEnv = {
        NODE_ENV: 'production',
        PAYMENT_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_mock1234567890abcdef',
        STRIPE_WEBHOOK_SECRET: 'whsec_mock1234567890abcdef',
        STRIPE_PRICE_CREATOR: 'price_c_live',
        STRIPE_PRICE_PRO: 'price_p_live',
        STRIPE_PRICE_AGENCY: 'price_a_live',
        STRIPE_PRICE_AUDIT_ONCE: 'price_o_live',
        APP_BASE_URL: 'https://videorisk.com',
        ALLOWED_ORIGINS: 'https://app.videorisk.com',
        MEDIA_TOKEN_SECRET: 'vr_prod_media_token_secret_0123456789abcdef_strong',
      };
      const prodLiveSec = resolveEnvironmentSecurity(validProdLiveEnv);
      assert.strictEqual(prodLiveSec.isProduction, true, '5.2a Canonical isProduction=true');
      assert.strictEqual(prodLiveSec.hasConflict, false, '5.2b Valid production live env has zero conflicts');
      assert.strictEqual(validateBillingConfiguration('production', validProdLiveEnv).valid, true, '5.2c validateBillingConfiguration passes');

      process.env.NODE_ENV = 'production';
      process.env.PAYMENT_MODE = 'live';
      process.env.STRIPE_SECRET_KEY = 'sk_live_mock1234567890abcdef';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock1234567890abcdef';
      process.env.STRIPE_PRICE_CREATOR = 'price_c_live';
      process.env.STRIPE_PRICE_PRO = 'price_p_live';
      process.env.STRIPE_PRICE_AGENCY = 'price_a_live';
      process.env.STRIPE_PRICE_AUDIT_ONCE = 'price_o_live';
      process.env.APP_BASE_URL = 'https://videorisk.com';
      process.env.ALLOWED_ORIGINS = 'https://app.videorisk.com,http://insecure.videorisk.com,https://localhost:3000';

      const trustedLiveOrigins = billingService.getTrustedOrigins();
      assert.deepStrictEqual(
        trustedLiveOrigins.sort(),
        ['https://app.videorisk.com', 'https://videorisk.com'],
        '5.2d getTrustedOrigins excludes insecure HTTP and localhost even when listed in ALLOWED_ORIGINS'
      );

      capturedCheckoutParams.length = 0;
      const validLiveCheckoutRes = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${taskAToken}`,
          Origin: 'https://app.videorisk.com',
        },
        body: JSON.stringify({ planId: 'pro' }),
      });
      assert.strictEqual(validLiveCheckoutRes.status, 200, '5.2e Trusted HTTPS Origin succeeds in live production mode');
      assert.strictEqual(
        capturedCheckoutParams[0].success_url,
        'https://app.videorisk.com/?checkout_status=success&session_id={CHECKOUT_SESSION_ID}',
        '5.2f success_url strictly HTTPS trusted origin'
      );

      // 5.3 NODE_ENV=development + PAYMENT_MODE=live -> canonical isProduction=true, localhost/http/missing/sim forbidden!
      process.env.NODE_ENV = 'development';
      process.env.PAYMENT_MODE = 'live';
      assert.strictEqual(isProductionEnvironment(process.env), true, '5.3a PAYMENT_MODE=live elevates canonical predicate even with NODE_ENV=development');
      assert.strictEqual(billingService.isProductionMode(), true, '5.3b BillingService uses canonical production predicate');

      const devLiveTrusted = billingService.getTrustedOrigins();
      assert.ok(!devLiveTrusted.some(o => o.includes('localhost') || o.includes('127.0.0.1') || o.startsWith('http://')), '5.3c No localhost/HTTP origins allowed in PAYMENT_MODE=live');

      for (const forbiddenOrigin of ['http://localhost:3000', 'https://localhost:3000', 'http://127.0.0.1:3000', 'http://videorisk.com', 'https://attacker.com', 'https://videorisk.com.evil.com']) {
        const resHeader = await fetch(`${baseUrl}/billing/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${taskAToken}`, Origin: forbiddenOrigin },
          body: JSON.stringify({ planId: 'pro' }),
        });
        assert.strictEqual(resHeader.status, 400, `5.3d/6/7/8 Rejects Origin header ${forbiddenOrigin} in live mode`);

        const resBody = await fetch(`${baseUrl}/billing/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${taskAToken}` },
          body: JSON.stringify({ planId: 'pro', originUrl: forbiddenOrigin }),
        });
        assert.strictEqual(resBody.status, 400, `5.3e/6/7/8 Rejects body.originUrl ${forbiddenOrigin} in live mode`);

        assert.throws(
          () => billingService.validatePortalReturnUrl(`${forbiddenOrigin}/pricing`),
          (err: any) => err.statusCode === 400,
          `5.3f/6/7/8 Portal returnUrl rejects ${forbiddenOrigin} in live mode`
        );
      }

      // Simulation session-status disabled in NODE_ENV=development + PAYMENT_MODE=live
      const simInLiveRes = await fetch(`${baseUrl}/billing/session-status?sessionId=sim_1&plan=pro&mode=simulation`, {
        headers: { Authorization: `Bearer ${taskAToken}` },
      });
      assert.strictEqual(simInLiveRes.status, 403, '5.3g Simulation checkout completion blocked (403) when PAYMENT_MODE=live');

      // Missing MEDIA_TOKEN_SECRET throws fatal error when PAYMENT_MODE=live even in NODE_ENV=development
      delete process.env.MEDIA_TOKEN_SECRET;
      assert.throws(
        () => validateAndGetMediaTokenSecret(process.env),
        /MEDIA_TOKEN_SECRET/,
        '5.3h MEDIA_TOKEN_SECRET enforced when PAYMENT_MODE=live'
      );

      // Missing APP_BASE_URL fails closed 500 when PAYMENT_MODE=live
      delete process.env.APP_BASE_URL;
      const devLiveMissingBaseRes = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${taskAToken}` },
        body: JSON.stringify({ planId: 'pro' }),
      });
      assert.strictEqual(devLiveMissingBaseRes.status, 500, '5.3i Missing APP_BASE_URL fails closed 500 in PAYMENT_MODE=live');

      const valDevLive = validateBillingConfiguration('development', {
        NODE_ENV: 'development',
        PAYMENT_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_mock1234567890abcdef',
        STRIPE_WEBHOOK_SECRET: 'whsec_mock1234567890abcdef',
        STRIPE_PRICE_CREATOR: 'price_c_live',
        STRIPE_PRICE_PRO: 'price_p_live',
        STRIPE_PRICE_AGENCY: 'price_a_live',
        STRIPE_PRICE_AUDIT_ONCE: 'price_o_live',
        APP_BASE_URL: 'https://localhost:3000',
      });
      assert.strictEqual(valDevLive.valid, false, '5.3j validateBillingConfiguration rejects development+live conflict and localhost APP_BASE_URL');

      // 5.4 NODE_ENV=development + PAYMENT_MODE=test -> valid dev behavior, localhost allowed
      process.env.NODE_ENV = 'development';
      process.env.PAYMENT_MODE = 'test';
      process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key_1234567890abcdef';
      process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
      process.env.APP_BASE_URL = 'http://localhost:3000';
      assert.strictEqual(isProductionEnvironment(process.env), false, '5.4a Dev+test keeps isProduction=false');
      assert.strictEqual(resolveEnvironmentSecurity(process.env).hasConflict, false, '5.4b Dev+test has no conflicts');
      assert.ok(billingService.getTrustedOrigins().includes('http://localhost:3000'), '5.4c Dev+test permits http://localhost:3000');
      assert.strictEqual(
        validateBillingConfiguration('test', {
          NODE_ENV: 'test',
          PAYMENT_MODE: 'test',
          STRIPE_SECRET_KEY: 'sk_test_12345678901234567890',
          STRIPE_WEBHOOK_SECRET: 'whsec_mock1234567890abcdef',
          APP_BASE_URL: 'http://localhost:3000',
        }).valid,
        true,
        '5.4d validateBillingConfiguration allows test/dev localhost'
      );

      // 5.5 Conflicting keys & VIDEORISK_TEST_RUN cannot bypass production rules
      assert.strictEqual(
        resolveEnvironmentSecurity({ NODE_ENV: 'development', PAYMENT_MODE: 'test', STRIPE_SECRET_KEY: 'sk_live_12345678901234567890' }).isProduction,
        true,
        '5.5a Live key activates production security rules immediately'
      );
      assert.ok(
        resolveEnvironmentSecurity({ NODE_ENV: 'development', PAYMENT_MODE: 'test', STRIPE_SECRET_KEY: 'sk_live_12345678901234567890' }).conflicts.some(c => c.code === 'LIVE_KEY_IN_DEV_OR_TEST'),
        '5.5b Flags LIVE_KEY_IN_DEV_OR_TEST'
      );
      assert.ok(
        resolveEnvironmentSecurity({ PAYMENT_MODE: 'staging' as any }).conflicts.some(c => c.code === 'INVALID_PAYMENT_MODE'),
        '5.5c Flags unrecognized PAYMENT_MODE'
      );
      process.env.NODE_ENV = 'production';
      process.env.PAYMENT_MODE = 'live';
      process.env.VIDEORISK_TEST_RUN = 'true';
      process.env.STRIPE_SECRET_KEY = 'sk_live_mock1234567890abcdef';
      delete process.env.APP_BASE_URL;
      const bypassAttemptRes = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${taskAToken}`, Origin: 'http://localhost:3000' },
        body: JSON.stringify({ planId: 'pro' }),
      });
      assert.strictEqual(bypassAttemptRes.status, 500, '5.5d VIDEORISK_TEST_RUN=true does NOT bypass missing APP_BASE_URL in production');

      // 5.10 Checkout origin mismatch between Origin header & body.originUrl + Host header spoofing
      process.env.APP_BASE_URL = 'https://videorisk.com';
      process.env.ALLOWED_ORIGINS = 'https://app.videorisk.com';
      const mismatchRes = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${taskAToken}`,
          Origin: 'https://videorisk.com',
        },
        body: JSON.stringify({ planId: 'pro', originUrl: 'https://app.videorisk.com' }),
      });
      assert.strictEqual(mismatchRes.status, 400, '5.10a Mismatched Origin header vs body.originUrl rejected with 400');

      capturedCheckoutParams.length = 0;
      const spoofedProdRes = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${taskAToken}`,
          Host: 'phish.attacker.com',
          'X-Forwarded-Host': 'phish.attacker.com',
        },
        body: JSON.stringify({ planId: 'pro' }),
      });
      assert.strictEqual(spoofedProdRes.status, 200, '5.10b Server canonical origin used when client omits Origin');
      assert.strictEqual(
        capturedCheckoutParams[0].success_url,
        'https://videorisk.com/?checkout_status=success&session_id={CHECKOUT_SESSION_ID}',
        '5.10c Host & X-Forwarded-Host headers never influence Stripe redirect URLs'
      );

      // 5.11 APP_BASE_URL=https://localhost:3000 rejected in production (fails closed 500 + validate-env ERROR)
      process.env.APP_BASE_URL = 'https://localhost:3000';
      const localhostBaseRes = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${taskAToken}` },
        body: JSON.stringify({ planId: 'pro' }),
      });
      assert.strictEqual(localhostBaseRes.status, 500, '5.11a Localhost APP_BASE_URL fails closed with 500 in production');
      assert.strictEqual(
        validateBillingConfiguration('production', {
          NODE_ENV: 'production',
          PAYMENT_MODE: 'live',
          STRIPE_SECRET_KEY: 'sk_live_mock1234567890abcdef',
          STRIPE_WEBHOOK_SECRET: 'whsec_mock1234567890abcdef',
          STRIPE_PRICE_CREATOR: 'price_c_live',
          STRIPE_PRICE_PRO: 'price_p_live',
          STRIPE_PRICE_AGENCY: 'price_a_live',
          STRIPE_PRICE_AUDIT_ONCE: 'price_o_live',
          APP_BASE_URL: 'https://localhost:3000',
        }).valid,
        false,
        '5.11b validate-env rejects https://localhost:3000 in production'
      );

      console.log('  ✅ PASS: All 11 Canonical Production Predicate & Live-Payment Origin Hardening cases verified');

      // ------------------------------------------------------------------------
      // 6. TASK A1 & A2: COMPLETE LOOPBACK BOUNDARIES & MEDIA_TOKEN_SECRET PARITY
      // ------------------------------------------------------------------------
      console.log('\n[6. Task A1 & A2: IPv4/IPv6 Loopback Boundaries & MEDIA_TOKEN_SECRET Parity]');

      // 6.1 IPv4 loopback range 127.0.0.0/8 & boundary cases
      for (const lbIpv4 of ['127.0.0.0', '127.0.0.1', '127.0.0.2', '127.1.2.3', '127.255.255.254', '127.255.255.255']) {
        assert.strictEqual(isLoopbackHostname(lbIpv4), true, `6.1 IPv4 loopback ${lbIpv4} detected as loopback`);
      }
      for (const nonLbIpv4 of ['126.255.255.255', '128.0.0.0', '127.0.0.1.evil.com', '127.0.0', '127.0.0.256', '127.0.0.01']) {
        assert.strictEqual(isLoopbackHostname(nonLbIpv4), false, `6.1b Non-loopback/invalid IPv4 ${nonLbIpv4} returns false`);
      }

      // 6.2 IPv6 loopback representations
      for (const lbIpv6 of [
        '::1',
        '[::1]',
        '0:0:0:0:0:0:0:1',
        '0000:0000:0000:0000:0000:0000:0000:0001',
        '[0:0:0:0:0:0:0:1]',
        '::0:1',
      ]) {
        assert.strictEqual(isLoopbackHostname(lbIpv6), true, `6.2 IPv6 loopback ${lbIpv6} detected as loopback`);
      }

      // 6.3 IPv4-mapped IPv6 loopback (both dotted and WHATWG canonical hex forms)
      for (const mappedLb of [
        '::ffff:127.0.0.1',
        '[::ffff:127.0.0.1]',
        '::ffff:127.0.0.2',
        '::ffff:127.255.255.254',
        '::ffff:7f00:1',
        '[::ffff:7f00:1]',
        '::FFFF:7F00:0001',
        '0:0:0:0:0:ffff:127.1.2.3',
        '0000:0000:0000:0000:0000:ffff:7f01:0203',
        '::127.0.0.1',
      ]) {
        assert.strictEqual(isLoopbackHostname(mappedLb), true, `6.3 IPv4-mapped IPv6 loopback ${mappedLb} detected as loopback`);
      }
      for (const mappedNonLb of ['::ffff:126.255.255.255', '::ffff:128.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.1.1', '::ffff:8.8.8.8']) {
        assert.strictEqual(isLoopbackHostname(mappedNonLb), false, `6.3b IPv4-mapped IPv6 non-loopback ${mappedNonLb} returns false`);
      }

      // 6.4 Localhost casing, subdomains, trailing dot vs lookalike domains
      for (const lh of ['localhost', 'LOCALHOST', 'sub.localhost', 'API.LOCALHOST', 'localhost.', 'sub.localhost.']) {
        assert.strictEqual(isLoopbackHostname(lh), true, `6.4 Localhost variant ${lh} detected`);
      }
      for (const lookalike of ['localhost.evil.com', 'notlocalhost', 'my-localhost.org']) {
        assert.strictEqual(isLoopbackHostname(lookalike), false, `6.4b Lookalike ${lookalike} rejected`);
      }

      // 6.5 Non-loopback private & public IPv4/IPv6 addresses + invalid hostnames / malformed inputs
      for (const privateOrPublic of [
        '10.0.0.1',
        '172.16.0.1',
        '192.168.1.1',
        '169.254.1.1',
        'fc00::1',
        'fd00::1',
        'fe80::1',
        '8.8.8.8',
        '1.1.1.1',
        '2001:4860:4860::8888',
        '2606:4700:4700::1111',
      ]) {
        assert.strictEqual(isLoopbackHostname(privateOrPublic), false, `6.5 Non-loopback IP ${privateOrPublic} returns false`);
      }
      for (const malformed of ['', '   ', '[::1', '::1]', ':::', '127.0.0.1:3000', '127.0.0.1/evil', 'user@127.0.0.1', 'http://[::1']) {
        assert.strictEqual(isLoopbackHostname(malformed), false, `6.5b Invalid hostname '${malformed}' returns false`);
      }

      // 6.6 End-to-end production rejection of expanded loopback origins (Trusted Origins, Checkout, Portal, validate-env)
      process.env.NODE_ENV = 'production';
      process.env.PAYMENT_MODE = 'live';
      process.env.STRIPE_SECRET_KEY = 'sk_live_mock1234567890abcdef';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock1234567890abcdef';
      process.env.APP_BASE_URL = 'https://videorisk.com';
      process.env.ALLOWED_ORIGINS = 'https://app.videorisk.com,https://127.0.0.2:3000,https://[::ffff:127.0.0.1]:3000,https://[0:0:0:0:0:0:0:1]:3000';
      const trustedExpanded = billingService.getTrustedOrigins();
      assert.deepStrictEqual(
        trustedExpanded.sort(),
        ['https://app.videorisk.com', 'https://videorisk.com'],
        '6.6a getTrustedOrigins strips 127.0.0.2, ::ffff:127.0.0.1, and 0:0:0:0:0:0:0:1 in production'
      );

      for (const expandedLoopbackOrigin of [
        'https://127.0.0.2:3000',
        'https://127.1.2.3',
        'https://[::1]:3000',
        'https://[0:0:0:0:0:0:0:1]:3000',
        'https://[::ffff:127.0.0.1]:3000',
      ]) {
        const hdrRej = await fetch(`${baseUrl}/billing/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${taskAToken}`, Origin: expandedLoopbackOrigin },
          body: JSON.stringify({ planId: 'pro' }),
        });
        assert.strictEqual(hdrRej.status, 400, `6.6b Checkout rejects expanded loopback Origin ${expandedLoopbackOrigin}`);

        assert.throws(
          () => billingService.validatePortalReturnUrl(`${expandedLoopbackOrigin}/pricing`),
          (err: any) => err.statusCode === 400,
          `6.6c Portal returnUrl rejects expanded loopback ${expandedLoopbackOrigin}`
        );

        const envLoopbackCheck = validateBillingConfiguration('production', {
          ...validProdLiveEnv,
          APP_BASE_URL: expandedLoopbackOrigin,
        });
        assert.strictEqual(envLoopbackCheck.valid, false, `6.6d validate-env rejects ${expandedLoopbackOrigin} in production`);
      }

      // 6.7 Task A2 runtime + readiness + validate-env consistency for MEDIA_TOKEN_SECRET
      delete process.env.MEDIA_TOKEN_SECRET;
      assert.strictEqual(validateMediaTokenSecret(undefined, true).valid, false, '6.7a Canonical validator rejects missing secret in prod');
      assert.throws(() => validateAndGetMediaTokenSecret(process.env), /MEDIA_TOKEN_SECRET/, '6.7b Runtime rejects missing secret in prod');
      const readinessMissingMedia = await fetch(`${baseUrl}/health/readiness`);
      assert.strictEqual(readinessMissingMedia.status, 503, '6.7c Readiness returns 503 when MEDIA_TOKEN_SECRET missing in prod');
      const readinessMissingJson = await readinessMissingMedia.json();
      assert.strictEqual(readinessMissingJson.checks?.mediaSecurity?.status, 'unhealthy', '6.7d Readiness marks mediaSecurity unhealthy');

      const invalidMediaSentinel = 'short_BAD_SENTINEL_123';
      process.env.MEDIA_TOKEN_SECRET = invalidMediaSentinel;
      assert.strictEqual(validateMediaTokenSecret(invalidMediaSentinel, true).valid, false, '6.7e Canonical validator rejects short secret in prod');
      let caughtRuntimeMsg = '';
      try {
        validateAndGetMediaTokenSecret(process.env);
      } catch (e: any) {
        caughtRuntimeMsg = String(e?.message || '');
      }
      assert.ok(caughtRuntimeMsg.includes('MEDIA_TOKEN_SECRET'), '6.7f Runtime rejects invalid/short secret in prod');
      assert.ok(!caughtRuntimeMsg.includes(invalidMediaSentinel), '6.7g Runtime error never leaks secret value');
      const readinessInvalidJson = await (await fetch(`${baseUrl}/health/readiness`)).json();
      assert.strictEqual(readinessInvalidJson.checks?.mediaSecurity?.status, 'unhealthy', '6.7h Readiness marks short secret unhealthy');

      process.env.MEDIA_TOKEN_SECRET = 'vr_prod_media_token_secret_0123456789abcdef_strong';
      assert.strictEqual(
        validateAndGetMediaTokenSecret(process.env),
        'vr_prod_media_token_secret_0123456789abcdef_strong',
        '6.7i Runtime accepts valid strong MEDIA_TOKEN_SECRET in prod'
      );
      const readinessValidJson = await (await fetch(`${baseUrl}/health/readiness`)).json();
      assert.strictEqual(readinessValidJson.checks?.mediaSecurity?.status, 'healthy', '6.7j Readiness marks mediaSecurity healthy with valid secret');

      process.env.NODE_ENV = 'development';
      process.env.PAYMENT_MODE = 'test';
      process.env.STRIPE_SECRET_KEY = 'sk_test_12345678901234567890';
      delete process.env.MEDIA_TOKEN_SECRET;
      assert.ok(validateAndGetMediaTokenSecret(process.env).length >= 32, '6.7k Development fallback secret works when unset');

      // 6.8 Group B: IPv6 Unspecified Address :: (helper accuracy + production-origin call-site rejection)
      for (const unspecHost of [
        '::',
        '[::]',
        '0:0:0:0:0:0:0:0',
        '0000:0000:0000:0000:0000:0000:0000:0000',
        '[0:0:0:0:0:0:0:0]',
        '::0',
        '[::0]',
        '0::0',
        '::%lo0',
        '[::%lo0]',
        '::0.0.0.0',
        new URL('https://[::]:3000').hostname,
        new URL('https://[0:0:0:0:0:0:0:0]:8443').hostname,
      ]) {
        assert.strictEqual(isUnspecifiedIpv6Hostname(unspecHost), true, `6.8a IPv6 unspecified variant '${unspecHost}' detected`);
        assert.strictEqual(isLoopbackHostname(unspecHost), false, `6.8b '${unspecHost}' is NOT falsely classified as loopback`);
        assert.strictEqual(isForbiddenProductionOriginHostname(unspecHost), true, `6.8c '${unspecHost}' is forbidden as a production origin host`);
      }

      // Preserve existing semantics for ::1, valid public IPv6, IPv4 0.0.0.0, and malformed IPv6
      assert.strictEqual(isLoopbackHostname('::1'), true, '6.8d ::1 remains loopback');
      assert.strictEqual(isUnspecifiedIpv6Hostname('::1'), false, '6.8e ::1 is not unspecified');
      assert.strictEqual(isForbiddenProductionOriginHostname('::1'), true, '6.8f ::1 remains forbidden in prod');
      assert.strictEqual(isLoopbackHostname('0.0.0.0'), true, '6.8g IPv4 0.0.0.0 behavior preserved');
      assert.strictEqual(isUnspecifiedIpv6Hostname('0.0.0.0'), false, '6.8h IPv4 0.0.0.0 is distinct from IPv6 ::');
      assert.strictEqual(isForbiddenProductionOriginHostname('0.0.0.0'), true, '6.8i IPv4 0.0.0.0 remains forbidden in prod');
      for (const validNonLoopbackV6 of ['2001:4860:4860::8888', '[2001:4860:4860::8888]', '2606:4700:4700::1111']) {
        assert.strictEqual(isLoopbackHostname(validNonLoopbackV6), false, `6.8j Non-loopback IPv6 ${validNonLoopbackV6}`);
        assert.strictEqual(isUnspecifiedIpv6Hostname(validNonLoopbackV6), false, `6.8k Non-unspecified IPv6 ${validNonLoopbackV6}`);
        assert.strictEqual(isForbiddenProductionOriginHostname(validNonLoopbackV6), false, `6.8l Public IPv6 ${validNonLoopbackV6} allowed`);
      }
      for (const badV6 of [':::', '[::', '::]', '::% ', '1:2:3', 'gggg::1', '::0::0']) {
        assert.strictEqual(isLoopbackHostname(badV6), false, `6.8m Malformed IPv6 '${badV6}' safely rejected (loopback)`);
        assert.strictEqual(isUnspecifiedIpv6Hostname(badV6), false, `6.8n Malformed IPv6 '${badV6}' safely rejected (unspecified)`);
      }

      // Verify actual production-origin call sites reject https://[::] variants
      process.env.NODE_ENV = 'production';
      process.env.PAYMENT_MODE = 'live';
      process.env.STRIPE_SECRET_KEY = 'sk_live_mock1234567890abcdef';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock1234567890abcdef';
      process.env.MEDIA_TOKEN_SECRET = 'vr_prod_media_token_secret_0123456789abcdef_strong';
      process.env.APP_BASE_URL = 'https://videorisk.com';
      process.env.ALLOWED_ORIGINS = 'https://app.videorisk.com,https://[::]:3000,https://[0:0:0:0:0:0:0:0]';
      assert.deepStrictEqual(
        billingService.getTrustedOrigins().sort(),
        ['https://app.videorisk.com', 'https://videorisk.com'],
        '6.8o getTrustedOrigins strips https://[::]:3000 and https://[0:0:0:0:0:0:0:0] in production'
      );

      for (const unspecOrigin of ['https://[::]', 'https://[::]:3000', 'https://[0:0:0:0:0:0:0:0]', 'https://[::0]']) {
        process.env.APP_BASE_URL = 'https://videorisk.com';

        const hdrRes = await fetch(`${baseUrl}/billing/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${taskAToken}`, Origin: unspecOrigin },
          body: JSON.stringify({ planId: 'pro' }),
        });
        assert.strictEqual(hdrRes.status, 400, `6.8p Checkout rejects unspecified IPv6 Origin ${unspecOrigin}`);

        assert.throws(
          () => billingService.validatePortalReturnUrl(`${unspecOrigin}/pricing`),
          (err: any) => err.statusCode === 400,
          `6.8q Portal returnUrl rejects unspecified IPv6 ${unspecOrigin}`
        );

        const envUnspecCheck = validateBillingConfiguration('production', {
          ...validProdLiveEnv,
          APP_BASE_URL: unspecOrigin,
        });
        assert.strictEqual(envUnspecCheck.valid, false, `6.8r validate-env rejects APP_BASE_URL=${unspecOrigin} in production`);

        const allowedUnspecCheck = validateBillingConfiguration('production', {
          ...validProdLiveEnv,
          ALLOWED_ORIGINS: unspecOrigin,
        });
        assert.strictEqual(allowedUnspecCheck.valid, false, `6.8s validate-env rejects ALLOWED_ORIGINS=${unspecOrigin} in production`);

        process.env.APP_BASE_URL = unspecOrigin;
        const readinessUnspecJson = await (await fetch(`${baseUrl}/health/readiness`)).json();
        assert.strictEqual(
          readinessUnspecJson.checks?.billing?.details?.originConfiguredValid,
          false,
          `6.8t Readiness marks APP_BASE_URL=${unspecOrigin} invalid in production`
        );

        const baseRejectRes = await fetch(`${baseUrl}/billing/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${taskAToken}` },
          body: JSON.stringify({ planId: 'pro' }),
        });
        assert.strictEqual(baseRejectRes.status, 500, `6.8u Checkout fails closed when APP_BASE_URL=${unspecOrigin} in production`);
      }

      console.log('  ✅ PASS: All Task A1 loopback + Group B :: boundaries & Task A2 MEDIA_TOKEN_SECRET runtime/readiness/validator parity cases verified');
    } finally {
      for (const [k, v] of Object.entries(savedStripeEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      restoreEnv();
    }

    // ------------------------------------------------------------------------
    // 7. TARGETED REMEDIATION: UNKNOWN & MISSING PRICE ID ESCALATION HARDENING
    // ------------------------------------------------------------------------
    console.log('\n[7. Targeted Remediation — Unknown & Missing Stripe Price ID Entitlement Hardening]');
    const sec7DbPath = path.join(tempSqliteDir, `sec7_price_escalation_${Date.now()}.db`);
    const sec7Repo = new SqliteStorageRepository(sec7DbPath);
    billingService.setStorageForTest(sec7Repo);
    billingService.setStripeClientForTest(mockStripeSdk);
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key_1234567890abcdef';
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.STRIPE_PRICE_CREATOR = 'price_sec7_creator';
    process.env.STRIPE_PRICE_PRO = 'price_sec7_pro';
    process.env.STRIPE_PRICE_AGENCY = 'price_sec7_agency';
    const sec7Ts = Math.floor(Date.now() / 1000);

    try {
      // 7.1 Recognized Price ID maps to exact plan
      const recUser = await sec7Repo.users.createUser(`sec7_rec_${Date.now()}@videorisk.test`, 'h', 's', 10, 'free');
      const recSubId = `sub_sec7_rec_${Date.now()}`;
      const evRecognized = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_rec_${Date.now()}`,
        created: sec7Ts,
        type: 'customer.subscription.created',
        data: {
          object: {
            id: recSubId,
            customer: `cus_sec7_rec_${Date.now()}`,
            status: 'active',
            current_period_end: sec7Ts + 30 * 86400,
            metadata: { userId: recUser.id },
            items: { data: [{ price: { id: 'price_sec7_creator' } }] },
          },
        },
      });
      await billingService.handleWebhook(evRecognized.rawBody, evRecognized.signature);
      assert.strictEqual((await sec7Repo.users.getUser(recUser.id))?.plan, 'creator', '7.1 Recognized configured Price ID maps to creator');

      // 7.2 Unknown Price ID + invalid metadata does NOT grant Pro or credits + records admin diagnostic
      const freeUser = await sec7Repo.users.createUser(`sec7_free_${Date.now()}@videorisk.test`, 'h', 's', 10, 'free');
      const unkSubId = `sub_sec7_unk_${Date.now()}`;
      const unkEventId = `evt_sec7_unk_${Date.now()}`;
      const evUnknown = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: unkEventId,
        created: sec7Ts,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: unkSubId,
            customer: `cus_sec7_unk_${Date.now()}`,
            status: 'active',
            current_period_end: sec7Ts + 30 * 86400,
            metadata: { userId: freeUser.id, planId: 'agency' },
            items: { data: [{ price: { id: 'price_unmapped_attacker_123' } }] },
          },
        },
      });
      await billingService.handleWebhook(evUnknown.rawBody, evUnknown.signature);
      const freeUserAfterUnk = await sec7Repo.users.getUser(freeUser.id);
      assert.strictEqual(freeUserAfterUnk?.plan, 'free', '7.2a Unknown Price ID + agency metadata does NOT grant paid plan');
      assert.strictEqual(freeUserAfterUnk?.creditsRemaining, 10, '7.2b Unknown Price ID does NOT create additional credits');
      assert.strictEqual((await sec7Repo.billing.getCreditTransactions(freeUser.id)).length, 1, '7.2c Credit ledger unchanged (only INITIAL_GRANT)');
      assert.strictEqual(await sec7Repo.billing.getSubscription(unkSubId), null, '7.2d No subscription record created for unknown Price ID');

      // Verify persisted webhook diagnostic payload for administrators
      const diagRow = (sec7Repo as any).db.prepare('SELECT payload_json FROM webhook_events WHERE event_id = ?').get(unkEventId) as any;
      const diagPayload = JSON.parse(diagRow.payload_json);
      assert.strictEqual(diagPayload.outcome, 'rejected_unmapped_price', '7.2e Diagnostic outcome persisted in webhook_events');
      assert.strictEqual(diagPayload.diagnostic?.priceId, 'price_unmapped_attacker_123', '7.2f Offending Price ID persisted in diagnostic');

      // 7.3 Repeated delivery of identical invalid event is idempotent and leaves state unchanged
      const replayRes = await billingService.handleWebhook(evUnknown.rawBody, evUnknown.signature);
      assert.strictEqual(replayRes.alreadyProcessed, true, '7.3a Replayed invalid event returns alreadyProcessed=true');
      assert.strictEqual((await sec7Repo.users.getUser(freeUser.id))?.plan, 'free', '7.3b Replay keeps plan=free');
      assert.strictEqual((await sec7Repo.users.getUser(freeUser.id))?.creditsRemaining, 10, '7.3c Replay keeps credits=10');

      // 7.4 Subsequent valid subscription event still works cleanly
      const evSubsequentValid = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_valid_next_${Date.now()}`,
        created: sec7Ts + 10,
        type: 'customer.subscription.created',
        data: {
          object: {
            id: unkSubId,
            customer: `cus_sec7_unk_${Date.now()}`,
            status: 'active',
            current_period_end: sec7Ts + 30 * 86400,
            metadata: { userId: freeUser.id },
            items: { data: [{ price: { id: 'price_sec7_pro' } }] },
          },
        },
      });
      await billingService.handleWebhook(evSubsequentValid.rawBody, evSubsequentValid.signature);
      assert.strictEqual((await sec7Repo.users.getUser(freeUser.id))?.plan, 'pro', '7.4 Subsequent valid event activates pro cleanly');

      // 7.5 Invalid subscription event does NOT overwrite existing valid subscription entitlement
      const evBadUpdate = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_bad_overwrite_${Date.now()}`,
        created: sec7Ts + 20,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: unkSubId,
            customer: `cus_sec7_unk_${Date.now()}`,
            status: 'canceled',
            metadata: { userId: freeUser.id, planId: 'creator' },
            items: { data: [{ price: { id: 'price_bogus_overwrite' } }] },
          },
        },
      });
      await billingService.handleWebhook(evBadUpdate.rawBody, evBadUpdate.signature);
      assert.strictEqual((await sec7Repo.users.getUser(freeUser.id))?.plan, 'pro', '7.5a Invalid event does not overwrite existing valid pro entitlement');
      assert.strictEqual((await sec7Repo.billing.getSubscription(unkSubId))?.status, 'active', '7.5b Existing active subscription status preserved');

      // 7.6 Existing user plan + missing Price ID cannot manufacture a new subscription entitlement
      const existingPlanUser = await sec7Repo.users.createUser(`sec7_exist_${Date.now()}@videorisk.test`, 'h', 's', 50, 'pro');
      const manufacturedSubId = `sub_sec7_mfg_${Date.now()}`;
      const evMissingPriceExistingUser = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_missing_mfg_${Date.now()}`,
        created: sec7Ts,
        type: 'customer.subscription.created',
        data: {
          object: {
            id: manufacturedSubId,
            customer: `cus_sec7_mfg_${Date.now()}`,
            status: 'active',
            metadata: { userId: existingPlanUser.id, planId: 'agency' },
          },
        },
      });
      await billingService.handleWebhook(evMissingPriceExistingUser.rawBody, evMissingPriceExistingUser.signature);
      assert.strictEqual(await sec7Repo.billing.getSubscription(manufacturedSubId), null, '7.6a Existing user.plan + missing Price ID cannot manufacture subscription');
      assert.strictEqual((await sec7Repo.users.getUser(existingPlanUser.id))?.creditsRemaining, 50, '7.6b No credits manufactured');

      // 7.7 Test A — Existing active -> past_due with missing Price ID & missing current_period_end
      const testAUser = await sec7Repo.users.createUser(`sec7_testA_${Date.now()}@videorisk.test`, 'h', 's', 20, 'free');
      const testACus = `cus_sec7_A_${Date.now()}`;
      const testASub = `sub_sec7_A_${Date.now()}`;
      const testAPeriodEndSec = sec7Ts + 2 * 86400; // Future period end within 7-day grace window
      const testAPeriodEndIso = new Date(testAPeriodEndSec * 1000).toISOString();
      const evAInit = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_A_init_${Date.now()}`,
        created: sec7Ts,
        type: 'customer.subscription.created',
        data: {
          object: {
            id: testASub,
            customer: testACus,
            status: 'active',
            current_period_end: testAPeriodEndSec,
            metadata: { userId: testAUser.id },
            items: { data: [{ price: { id: 'price_sec7_pro' } }] },
          },
        },
      });
      await billingService.handleWebhook(evAInit.rawBody, evAInit.signature);

      const evTestAPastDue = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_A_past_due_${Date.now()}`,
        created: sec7Ts + 5,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: testASub,
            customer: testACus,
            status: 'past_due',
            // Intentionally NO items / Price ID and NO current_period_end
          },
        },
      });
      await billingService.handleWebhook(evTestAPastDue.rawBody, evTestAPastDue.signature);
      const testASubAfter = await sec7Repo.billing.getSubscription(testASub);
      const testAUserAfter = await sec7Repo.users.getUser(testAUser.id);
      assert.strictEqual(testASubAfter?.status, 'past_due', '7.7a Test A: status transitions to past_due');
      assert.strictEqual(testASubAfter?.currentPeriodEnd, testAPeriodEndIso, '7.7b Test A: original currentPeriodEnd preserved (never wiped to undefined/null)');
      assert.strictEqual(testASubAfter?.planId, 'pro', '7.7c Test A: existing authorized plan preserved');
      assert.strictEqual(testAUserAfter?.subscriptionStatus, 'past_due', '7.7d Test A: user subscriptionStatus updated to past_due');
      assert.strictEqual(testAUserAfter?.plan, 'pro', '7.7e Test A: entitlement retained under past_due grace rule using preserved currentPeriodEnd');
      assert.strictEqual(testAUserAfter?.creditsRemaining, 20, '7.7f Test A: credits unchanged');

      // Also verify Test A2: past_due within 7-day grace AFTER period_end (-2 days) preserves period_end & stays entitled,
      // while period_end > 7 days ago (-10 days) transitions to unentitled free plan.
      const testA2User = await sec7Repo.users.createUser(`sec7_testA2_${Date.now()}@videorisk.test`, 'h', 's', 15, 'free');
      const testA2Sub = `sub_sec7_A2_${Date.now()}`;
      const testA2GraceSec = sec7Ts - 2 * 86400; // 2 days past period end -> within 7-day grace
      const testA2GraceIso = new Date(testA2GraceSec * 1000).toISOString();
      const evA2Init = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_A2_init_${Date.now()}`,
        created: sec7Ts,
        type: 'customer.subscription.created',
        data: {
          object: {
            id: testA2Sub,
            customer: `cus_sec7_A2_${Date.now()}`,
            status: 'active',
            current_period_end: testA2GraceSec,
            metadata: { userId: testA2User.id },
            items: { data: [{ price: { id: 'price_sec7_creator' } }] },
          },
        },
      });
      await billingService.handleWebhook(evA2Init.rawBody, evA2Init.signature);
      const evA2PastDue = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_A2_past_due_${Date.now()}`,
        created: sec7Ts + 5,
        type: 'customer.subscription.updated',
        data: { object: { id: testA2Sub, status: 'past_due' } },
      });
      await billingService.handleWebhook(evA2PastDue.rawBody, evA2PastDue.signature);
      assert.strictEqual((await sec7Repo.billing.getSubscription(testA2Sub))?.currentPeriodEnd, testA2GraceIso, '7.7g Test A2: past-periodEnd (-2d) preserved cleanly');
      assert.strictEqual((await sec7Repo.users.getUser(testA2User.id))?.plan, 'creator', '7.7h Test A2: 7-day grace window keeps creator entitlement');

      // 7.8 Test B — Existing active -> canceled with missing Price ID & missing current_period_end
      const testBUser = await sec7Repo.users.createUser(`sec7_testB_${Date.now()}@videorisk.test`, 'h', 's', 30, 'free');
      const testBCus = `cus_sec7_B_${Date.now()}`;
      const testBSub = `sub_sec7_B_${Date.now()}`;
      const testBPeriodEndSec = sec7Ts + 10 * 86400; // Future prepaid period end
      const testBPeriodEndIso = new Date(testBPeriodEndSec * 1000).toISOString();
      const evBInit = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_B_init_${Date.now()}`,
        created: sec7Ts,
        type: 'customer.subscription.created',
        data: {
          object: {
            id: testBSub,
            customer: testBCus,
            status: 'active',
            current_period_end: testBPeriodEndSec,
            metadata: { userId: testBUser.id },
            items: { data: [{ price: { id: 'price_sec7_agency' } }] },
          },
        },
      });
      await billingService.handleWebhook(evBInit.rawBody, evBInit.signature);

      const evBCancel = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_B_cancel_${Date.now()}`,
        created: sec7Ts + 5,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: testBSub,
            customer: testBCus,
            status: 'canceled',
            // Intentionally NO Price ID and NO current_period_end
          },
        },
      });
      await billingService.handleWebhook(evBCancel.rawBody, evBCancel.signature);
      const testBSubAfter = await sec7Repo.billing.getSubscription(testBSub);
      const testBUserAfter = await sec7Repo.users.getUser(testBUser.id);
      assert.strictEqual(testBSubAfter?.status, 'canceled', '7.8a Test B: status transitions to canceled');
      assert.strictEqual(testBSubAfter?.currentPeriodEnd, testBPeriodEndIso, '7.8b Test B: original currentPeriodEnd preserved on canceled transition');
      assert.strictEqual(testBUserAfter?.subscriptionStatus, 'canceled', '7.8c Test B: user subscriptionStatus updated to canceled');
      assert.strictEqual(testBUserAfter?.plan, 'agency', '7.8d Test B: prepaid agency entitlement retained until preserved currentPeriodEnd');

      // 7.9 Test C — Existing authorized subscription + missing Price ID + incoming valid current_period_end uses NEW value
      const testCNewPeriodEndSec = sec7Ts + 45 * 86400;
      const testCNewPeriodEndIso = new Date(testCNewPeriodEndSec * 1000).toISOString();
      const evCUpdatePeriodEnd = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_C_new_period_${Date.now()}`,
        created: sec7Ts + 10,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: testASub,
            customer: testACus,
            status: 'active',
            current_period_end: testCNewPeriodEndSec,
            // Intentionally NO Price ID, WITH incoming valid current_period_end
          },
        },
      });
      await billingService.handleWebhook(evCUpdatePeriodEnd.rawBody, evCUpdatePeriodEnd.signature);
      const testASubAfterNewEnd = await sec7Repo.billing.getSubscription(testASub);
      assert.strictEqual(testASubAfterNewEnd?.currentPeriodEnd, testCNewPeriodEndIso, '7.9a Test C: incoming valid current_period_end overrides preserved period end');
      assert.strictEqual(testASubAfterNewEnd?.status, 'active', '7.9b Test C: status updated to active');
      assert.strictEqual((await sec7Repo.users.getUser(testAUser.id))?.plan, 'pro', '7.9c Test C: plan entitlement active');

      // 7.10 Test D & E & F — Unknown Price ID rejected, Missing Price ID on unauthorized sub rejected, and Idempotency preserves period end & credits
      const replayPastDue = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: JSON.parse(evTestAPastDue.rawBody.toString('utf8')).id,
        created: sec7Ts + 5,
        type: 'customer.subscription.updated',
        data: { object: { id: testASub, customer: testACus, status: 'past_due' } },
      });
      const idempRes = await billingService.handleWebhook(replayPastDue.rawBody, replayPastDue.signature);
      assert.strictEqual(idempRes.alreadyProcessed, true, '7.10a Test F: repeated missing-Price-ID event returns alreadyProcessed=true');
      assert.strictEqual((await sec7Repo.billing.getSubscription(testASub))?.currentPeriodEnd, testCNewPeriodEndIso, '7.10b Test F: replay does not revert or wipe currentPeriodEnd');
      assert.strictEqual((await sec7Repo.billing.getSubscription(testASub))?.status, 'active', '7.10c Test F: replay does not overwrite active status');
      assert.strictEqual((await sec7Repo.users.getUser(testAUser.id))?.creditsRemaining, 20, '7.10d Test F: replay grants 0 additional credits');

      // Test E extra: Missing Price ID on an EXPIRED/UNENTITLED existing subscription must NOT inherit or preserve entitlement
      const expiredSubUser = await sec7Repo.users.createUser(`sec7_exp_${Date.now()}@videorisk.test`, 'h', 's', 10, 'free');
      const expiredSubId = `sub_sec7_exp_${Date.now()}`;
      const expiredPastSec = sec7Ts - 20 * 86400; // 20 days past -> canceled & unentitled
      const evExpiredInit = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_exp_init_${Date.now()}`,
        created: sec7Ts,
        type: 'customer.subscription.created',
        data: {
          object: {
            id: expiredSubId,
            customer: `cus_sec7_exp_${Date.now()}`,
            status: 'canceled',
            current_period_end: expiredPastSec,
            metadata: { userId: expiredSubUser.id },
            items: { data: [{ price: { id: 'price_sec7_pro' } }] },
          },
        },
      });
      await billingService.handleWebhook(evExpiredInit.rawBody, evExpiredInit.signature);
      assert.strictEqual((await sec7Repo.users.getUser(expiredSubUser.id))?.plan, 'free', '7.10e Precondition: expired canceled sub is free');
      const evExpiredMissingPriceReactivate = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
        id: `evt_sec7_exp_reactivate_${Date.now()}`,
        created: sec7Ts + 5,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: expiredSubId,
            status: 'active',
            metadata: { userId: expiredSubUser.id, planId: 'pro' },
          },
        },
      });
      await billingService.handleWebhook(evExpiredMissingPriceReactivate.rawBody, evExpiredMissingPriceReactivate.signature);
      assert.strictEqual((await sec7Repo.users.getUser(expiredSubUser.id))?.plan, 'free', '7.10f Test E: unentitled/expired sub + missing Price ID cannot manufacture active entitlement');
      assert.strictEqual((await sec7Repo.billing.getSubscription(expiredSubId))?.status, 'canceled', '7.10g Test E: expired canceled sub remains canceled');
      console.log('  ✅ PASS: All signed Stripe unknown/missing Price ID & period-end preservation regression tests (Tests A–F) verified');
    } finally {
      billingService.setStorageForTest(null);
      (sec7Repo as any).db.close();
      delete process.env.STRIPE_PRICE_CREATOR;
      delete process.env.STRIPE_PRICE_PRO;
      delete process.env.STRIPE_PRICE_AGENCY;
    }

    console.log('\n======================================================');
    console.log('🎉 ALL CHECKOUT ORIGIN & STRIPE REFUND TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    billingService.setStorageForTest(null);
    server.close();
    restoreEnv();
    try {
      fs.rmSync(tempSqliteDir, { recursive: true, force: true });
    } catch {}
  }
}

if (process.argv[1]?.includes('stripe_origin_and_refund_lifecycle.test.ts')) {
  runStripeOriginAndRefundLifecycleTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ STRIPE ORIGIN & REFUND TEST FAILED:', err);
      process.exit(1);
    });
}
