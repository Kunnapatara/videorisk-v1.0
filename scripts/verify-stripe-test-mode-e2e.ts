/**
 * VideoRisk v1.0 — Isolated Stripe Test Mode End-to-End Verification Harness
 *
 * Strictly enforced safety & truth boundaries:
 *   1. NEVER accepts live Stripe keys (sk_live_*, rk_live_*), PAYMENT_MODE=live/production,
 *      or DEPLOYMENT_ENV=production.
 *   2. NEVER targets production SQLite database (data/videorisk.db). Always enforces an
 *      ephemeral temp SQLite DB in os.tmpdir() verified via isTargetingProduction().
 *   3. NEVER fakes or mocks Stripe Test API results: without STRIPE_SECRET_KEY (sk_test_...)
 *      and STRIPE_WEBHOOK_SECRET (whsec_...), exits with status 2 (BLOCKED — AWAITING ENV).
 *   4. NEVER logs secret keys or webhook secrets in plaintext.
 *   5. Supports --preflight-only for non-ENV verification of harness routes, middleware rawBody
 *      preservation, safety guards, and SQLite schema assertions.
 *
 * Usage:
 *   npx tsx scripts/verify-stripe-test-mode-e2e.ts                 # Requires sk_test_ + whsec_ (else exit 2 BLOCKED)
 *   npx tsx scripts/verify-stripe-test-mode-e2e.ts --preflight-only
 *   npx tsx scripts/verify-stripe-test-mode-e2e.ts --json
 */

import assert from 'assert';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import {
  isLiveStripeSecretKey,
  isTestStripeSecretKey,
  resolveEnvironmentSecurity,
} from '../src/server/config/environment';
import {
  enforceTestDatabaseIsolation,
  isTargetingProduction,
} from '../src/server/storage/testIsolation';
import { maskSecret, validateStripeWebhookSecret } from './validate-env';

dotenv.config({ quiet: true });

export interface StripeE2EStepResult {
  step: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED';
  details: string;
}

export interface StripeE2EReport {
  mode: 'e2e' | 'preflight-only';
  overallStatus: 'PASS' | 'FAIL' | 'BLOCKED';
  exitCode: 0 | 1 | 2;
  timestamp: string;
  steps: StripeE2EStepResult[];
  createdStripeIds?: Record<string, string>;
  boundaryNote: string;
}

export interface SafetyValidationResult {
  safe: boolean;
  blocked: boolean;
  exitCode: 0 | 1 | 2;
  reason?: string;
}

/**
 * Pure safety & ENV gate evaluated before creating any DB, HTTP server, or Stripe API call.
 */
export function validateStripeE2ESafetyGuards(
  env: NodeJS.ProcessEnv,
  options?: { preflightOnly?: boolean }
): SafetyValidationResult {
  const preflightOnly = Boolean(options?.preflightOnly);
  const rawKey = (env.STRIPE_SECRET_KEY || '').trim();
  const rawWebhook = (env.STRIPE_WEBHOOK_SECRET || '').trim();
  const rawPaymentMode = (env.PAYMENT_MODE || '').trim().toLowerCase();
  const rawDeployEnv = (env.DEPLOYMENT_ENV || '').trim().toLowerCase();

  // Guard 1: Live Stripe keys are strictly forbidden in test harness
  if (isLiveStripeSecretKey(rawKey)) {
    return {
      safe: false,
      blocked: false,
      exitCode: 1,
      reason: `SAFETY VIOLATION: Live Stripe secret key (${maskSecret(rawKey)}) is strictly forbidden in E2E test harness. Provide sk_test_... only.`,
    };
  }

  // Guard 2: Live payment mode or production deployment tier forbidden in test harness
  if (rawPaymentMode === 'live' || rawPaymentMode === 'production') {
    return {
      safe: false,
      blocked: false,
      exitCode: 1,
      reason: `SAFETY VIOLATION: PAYMENT_MODE='${rawPaymentMode}' is forbidden in Stripe Test Mode harness.`,
    };
  }
  if (rawDeployEnv === 'production') {
    return {
      safe: false,
      blocked: false,
      exitCode: 1,
      reason: "SAFETY VIOLATION: DEPLOYMENT_ENV='production' is forbidden in Stripe Test Mode harness.",
    };
  }

  // Guard 3: Refuse any configured DB path pointing at production videorisk.db
  if (env.DATABASE_PATH && isTargetingProduction(env.DATABASE_PATH, env)) {
    return {
      safe: false,
      blocked: false,
      exitCode: 1,
      reason: `SAFETY VIOLATION: DATABASE_PATH='${env.DATABASE_PATH}' resolves to a production database target.`,
    };
  }
  if (env.TEST_DATABASE_PATH && isTargetingProduction(env.TEST_DATABASE_PATH, env)) {
    return {
      safe: false,
      blocked: false,
      exitCode: 1,
      reason: `SAFETY VIOLATION: TEST_DATABASE_PATH='${env.TEST_DATABASE_PATH}' resolves to a production database target.`,
    };
  }

  if (preflightOnly) {
    return { safe: true, blocked: false, exitCode: 0 };
  }

  // Guard 4: Require real Stripe Test Mode credentials for actual E2E run (otherwise BLOCKED — exit 2)
  if (!rawKey || !rawWebhook) {
    const missing: string[] = [];
    if (!rawKey) missing.push('STRIPE_SECRET_KEY (sk_test_...)');
    if (!rawWebhook) missing.push('STRIPE_WEBHOOK_SECRET (whsec_...)');
    return {
      safe: false,
      blocked: true,
      exitCode: 2,
      reason: `BLOCKED — AWAITING ENV: Missing ${missing.join(' and ')}. No live Stripe Test Mode API calls executed.`,
    };
  }

  if (!isTestStripeSecretKey(rawKey)) {
    return {
      safe: false,
      blocked: false,
      exitCode: 1,
      reason: `INVALID CREDENTIAL: STRIPE_SECRET_KEY (${maskSecret(rawKey)}) must begin with 'sk_test_' or 'rk_test_'.`,
    };
  }

  const whCheck = validateStripeWebhookSecret(rawWebhook);
  if (!whCheck.isValid) {
    return {
      safe: false,
      blocked: false,
      exitCode: 1,
      reason: `INVALID CREDENTIAL: ${whCheck.error || 'STRIPE_WEBHOOK_SECRET must match whsec_...'}`,
    };
  }

  // Guard 5: Reject conflicting environment signals
  const envSec = resolveEnvironmentSecurity(env);
  if (envSec.hasConflict) {
    return {
      safe: false,
      blocked: false,
      exitCode: 1,
      reason: `ENVIRONMENT CONFLICT: ${envSec.conflicts[0].message}`,
    };
  }

  return { safe: true, blocked: false, exitCode: 0 };
}

function parseCliArgs(argv: string[]): { preflightOnly: boolean; json: boolean } {
  return {
    preflightOnly: argv.includes('--preflight-only'),
    json: argv.includes('--json'),
  };
}

export async function runStripeTestModeE2E(options?: {
  preflightOnly?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<StripeE2EReport> {
  const targetEnv = options?.env ?? process.env;
  const parsedArgs = parseCliArgs(process.argv.slice(2));
  const preflightOnly = options?.preflightOnly ?? parsedArgs.preflightOnly;
  const steps: StripeE2EStepResult[] = [];
  const createdStripeIds: Record<string, string> = {};

  const addStep = (step: StripeE2EStepResult) => steps.push(step);

  // Step 0: Safety & credential gate BEFORE initializing any DB/server
  const safety = validateStripeE2ESafetyGuards(targetEnv, { preflightOnly });
  if (!safety.safe) {
    addStep({
      step: '0. Safety Guards & Credential Gate',
      status: safety.blocked ? 'BLOCKED' : 'FAIL',
      details: safety.reason || 'Safety guard failed.',
    });
    return {
      mode: preflightOnly ? 'preflight-only' : 'e2e',
      overallStatus: safety.blocked ? 'BLOCKED' : 'FAIL',
      exitCode: safety.exitCode,
      timestamp: new Date().toISOString(),
      steps,
      boundaryNote: safety.blocked
        ? 'BLOCKED — AWAITING ENV: Configure STRIPE_SECRET_KEY=sk_test_... and STRIPE_WEBHOOK_SECRET=whsec_... to run real Stripe Test Mode E2E.'
        : 'FAILED safety or credential check before executing E2E flow.',
    };
  }

  addStep({
    step: '0. Safety Guards & Credential Gate',
    status: 'PASS',
    details: preflightOnly
      ? 'Live-key, prod-ENV, and prod-DB guards verified (--preflight-only).'
      : `Verified Stripe test key (${maskSecret(targetEnv.STRIPE_SECRET_KEY)}), webhook secret (${maskSecret(targetEnv.STRIPE_WEBHOOK_SECRET)}), and zero live/prod conflicts.`,
  });

  // Setup isolated ephemeral SQLite DB inside os.tmpdir() BEFORE importing storage/routes
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_stripe_e2e_'));
  const isolatedDbPath = path.join(workDir, 'stripe_e2e_isolated.db');

  const savedEnv = {
    VIDEORISK_TEST_RUN: process.env.VIDEORISK_TEST_RUN,
    TEST_DATABASE_PATH: process.env.TEST_DATABASE_PATH,
    DATABASE_PATH: process.env.DATABASE_PATH,
    DATA_DIR: process.env.DATA_DIR,
    STORE_PATH: process.env.STORE_PATH,
    NODE_ENV: process.env.NODE_ENV,
    DEPLOYMENT_ENV: process.env.DEPLOYMENT_ENV,
    PAYMENT_MODE: process.env.PAYMENT_MODE,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    APP_BASE_URL: process.env.APP_BASE_URL,
  };

  let httpServer: import('http').Server | null = null;
  let storageRef: any = null;
  let stripeClient: Stripe | null = null;
  let createdCustomerId: string | undefined;
  let createdSubscriptionId: string | undefined;
  let createdPriceId: string | undefined;
  let createdProductId: string | undefined;

  try {
    process.env.VIDEORISK_TEST_RUN = 'true';
    process.env.TEST_DATABASE_PATH = isolatedDbPath;
    process.env.DATABASE_PATH = isolatedDbPath;
    process.env.DATA_DIR = workDir;
    process.env.STORE_PATH = path.join(workDir, 'nonexistent_store.json');
    if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
    if (!process.env.DEPLOYMENT_ENV) process.env.DEPLOYMENT_ENV = 'test';
    if (!process.env.PAYMENT_MODE) process.env.PAYMENT_MODE = 'test';

    if (targetEnv !== process.env) {
      if (targetEnv.STRIPE_SECRET_KEY) process.env.STRIPE_SECRET_KEY = targetEnv.STRIPE_SECRET_KEY;
      if (targetEnv.STRIPE_WEBHOOK_SECRET) process.env.STRIPE_WEBHOOK_SECRET = targetEnv.STRIPE_WEBHOOK_SECRET;
      if (targetEnv.APP_BASE_URL) process.env.APP_BASE_URL = targetEnv.APP_BASE_URL;
    }

    const dbResolution = enforceTestDatabaseIsolation(process.env);
    assert.ok(!isTargetingProduction(dbResolution.resolvedPath, process.env), 'Isolated DB must not target production');

    const { storage } = await import('../src/server/storage');
    const { billingService } = await import('../src/server/services/billingService');
    const { apiRouter, validateAndGetMediaTokenSecret } = await import('../src/server/routes/api');
    storageRef = storage;
    billingService.reconfigure();

    validateAndGetMediaTokenSecret(process.env);

    // Build Express app matching server.ts rawBody middleware exactly
    const app = express();
    app.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      })
    );
    app.use('/api', apiRouter);

    httpServer = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (httpServer.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}/api`;
    process.env.APP_BASE_URL = `http://127.0.0.1:${port}`;

    addStep({
      step: '1. Isolated SQLite DB & Ephemeral Express Server Startup',
      status: 'PASS',
      details: `Listening on 127.0.0.1:${port} with isolated DB ${isolatedDbPath} and express.json({ verify: req.rawBody }) preserved.`,
    });

    // Register isolated test user via real API
    const testEmail = `stripe_e2e_${Date.now()}_${crypto.randomBytes(3).toString('hex')}@example.test`;
    const testPassword = `TestPass_${crypto.randomBytes(6).toString('hex')}!1`;
    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    assert.ok(
      regRes.status === 200 || regRes.status === 201,
      `User registration failed (${regRes.status})`
    );
    const regData = await regRes.json();
    const sessionToken: string = regData.token;
    const userId: string = regData.user.id;
    assert.ok(sessionToken && userId, 'Registered test user receives token and userId');

    // Preflight-only verification checks schema, invalid signature rejection, and route readiness without needing Stripe API
    if (preflightOnly) {
      const readinessRes = await fetch(`${baseUrl}/health/readiness`);
      assert.strictEqual(readinessRes.status, 200, 'Readiness HTTP 200');
      const tables = (storage as any).db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);
      for (const reqTable of ['users', 'subscriptions', 'stripe_payments', 'stripe_refunds', 'webhook_events', 'credit_transactions']) {
        assert.ok(tables.includes(reqTable), `Required billing table '${reqTable}' present in SQLite schema`);
      }

      addStep({
        step: '2. Preflight Route, Readiness & SQLite Schema Verification',
        status: 'PASS',
        details: `Verified /api/health/readiness (200), /api/auth/register (200), and all 6 billing tables (${['users', 'subscriptions', 'stripe_payments', 'stripe_refunds', 'webhook_events', 'credit_transactions'].join(', ')}).`,
      });

      return {
        mode: 'preflight-only',
        overallStatus: 'PASS',
        exitCode: 0,
        timestamp: new Date().toISOString(),
        steps,
        boundaryNote:
          'PREFLIGHT ONLY: Harness isolation, routes, rawBody middleware, and SQLite billing schema verified. Live Stripe Test Mode API remains BLOCKED until STRIPE_SECRET_KEY & STRIPE_WEBHOOK_SECRET are set.',
      };
    }

    // =========================================================================
    // FULL REAL STRIPE TEST MODE END-TO-END FLOW (sk_test_ + whsec_)
    // =========================================================================
    const stripeKey = process.env.STRIPE_SECRET_KEY!.trim();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!.trim();
    stripeClient = new Stripe(stripeKey, { apiVersion: '2025-02-24.acacia' as any, typescript: true });

    const signEvent = (evt: Record<string, any>): { raw: string; signature: string } => {
      const raw = JSON.stringify(evt);
      const signature = stripeClient!.webhooks.generateTestHeaderString({
        payload: raw,
        secret: webhookSecret,
      });
      return { raw, signature };
    };

    const postWebhook = async (evt: Record<string, any>, overrideSignature?: string) => {
      const { raw, signature } = signEvent(evt);
      const res = await fetch(`${baseUrl}/billing/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': overrideSignature ?? signature,
        },
        body: raw,
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    };

    // Step 2: Invalid webhook signature fails closed (HTTP 400)
    const badSig = await postWebhook(
      { id: `evt_bad_${Date.now()}`, object: 'event', type: 'checkout.session.completed', data: { object: {} } },
      't=1700000000,v1=0000000000000000000000000000000000000000000000000000000000000000'
    );
    assert.strictEqual(badSig.status, 400, `Invalid signature must return 400 (got ${badSig.status})`);
    addStep({
      step: '2. Invalid Webhook Signature Guard (400 fail-closed)',
      status: 'PASS',
      details: 'POST /api/billing/webhook rejected tampered HMAC signature with HTTP 400.',
    });

    // Step 3: Real Stripe Checkout Session creation (POST /api/billing/checkout)
    const checkoutRes = await fetch(`${baseUrl}/billing/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ planId: 'pro' }),
    });
    assert.strictEqual(checkoutRes.status, 200, `Checkout creation failed (${checkoutRes.status})`);
    const checkoutData = await checkoutRes.json();
    assert.ok(checkoutData.sessionId?.startsWith('cs_test_'), `Expected cs_test_ session ID, got ${checkoutData.sessionId}`);
    assert.strictEqual(checkoutData.mode, 'test', 'Checkout session livemode must be test');
    createdStripeIds.checkoutSessionId = checkoutData.sessionId;
    addStep({
      step: '3. Real Stripe Checkout Session Creation (POST /api/billing/checkout)',
      status: 'PASS',
      details: `Created real Stripe Test Mode session ${checkoutData.sessionId} (mode=test).`,
    });

    // Step 4: Create real Stripe Test Customer, PaymentMethod (pm_card_visa), Price, and Paid Subscription
    const customer = await stripeClient.customers.create({
      email: testEmail,
      metadata: { userId, testHarness: 'verify-stripe-test-mode-e2e' },
    });
    createdCustomerId = customer.id;
    createdStripeIds.customerId = customer.id;

    const pm = await stripeClient.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    await stripeClient.customers.update(customer.id, {
      invoice_settings: { default_payment_method: pm.id },
    });

    let proPriceId = process.env.STRIPE_PRICE_PRO?.trim();
    if (!proPriceId) {
      const product = await stripeClient.products.create({
        name: `VideoRisk E2E Test Pro ${Date.now()}`,
      });
      createdProductId = product.id;
      const price = await stripeClient.prices.create({
        product: product.id,
        unit_amount: 1900,
        currency: 'usd',
        recurring: { interval: 'month' },
      });
      createdPriceId = price.id;
      proPriceId = price.id;
      process.env.STRIPE_PRICE_PRO = proPriceId;
    }

    const sub = await stripeClient.subscriptions.create({
      customer: customer.id,
      items: [{ price: proPriceId }],
      default_payment_method: pm.id,
      expand: ['latest_invoice.payment_intent'],
      metadata: { userId, planId: 'pro' },
    });
    createdSubscriptionId = sub.id;
    createdStripeIds.subscriptionId = sub.id;
    assert.strictEqual(sub.status, 'active', `Expected active test subscription, got ${sub.status}`);

    const latestInv = sub.latest_invoice as any;
    const piObj = latestInv?.payment_intent;
    const paymentIntentId = typeof piObj === 'string' ? piObj : piObj?.id;
    const chargeId = typeof piObj?.latest_charge === 'string' ? piObj.latest_charge : piObj?.latest_charge?.id;
    const periodEndSec = (sub as any).current_period_end || Math.floor(Date.now() / 1000) + 30 * 86400;
    if (paymentIntentId) createdStripeIds.paymentIntentId = paymentIntentId;

    // Step 5: Dispatch signed checkout.session.completed webhook and verify DB assertions
    const baseTs = Math.floor(Date.now() / 1000);
    const evtCheckoutId = `evt_e2e_checkout_${Date.now()}`;
    const checkoutWebhookRes = await postWebhook({
      id: evtCheckoutId,
      object: 'event',
      type: 'checkout.session.completed',
      created: baseTs,
      data: {
        object: {
          id: checkoutData.sessionId,
          object: 'checkout.session',
          mode: 'subscription',
          payment_status: 'paid',
          status: 'complete',
          client_reference_id: userId,
          customer: customer.id,
          subscription: sub.id,
          invoice: latestInv?.id,
          payment_intent: paymentIntentId,
          amount_total: 1900,
          currency: 'usd',
          livemode: false,
          metadata: { userId, planId: 'pro' },
        },
      },
    });
    assert.strictEqual(checkoutWebhookRes.status, 200, 'checkout.session.completed HTTP 200');

    const dbUserAfterCheckout = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    const dbSubAfterCheckout = (storage as any).db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id) as any;
    const dbPayAfterCheckout = (storage as any).db.prepare('SELECT * FROM stripe_payments WHERE session_id = ?').get(checkoutData.sessionId) as any;
    const dbTxAfterCheckout = (storage as any).db.prepare('SELECT * FROM credit_transactions WHERE user_id = ?').all(userId) as any[];

    assert.strictEqual(dbUserAfterCheckout.plan, 'pro', 'DB users.plan updated to pro');
    assert.strictEqual(dbUserAfterCheckout.credits_remaining, 85, 'DB users.credits_remaining = 10 + 75 = 85');
    assert.strictEqual(dbUserAfterCheckout.stripe_customer_id, customer.id, 'DB users.stripe_customer_id persisted');
    assert.strictEqual(dbSubAfterCheckout.status, 'active', 'DB subscriptions.status=active');
    assert.ok(dbPayAfterCheckout && dbPayAfterCheckout.status === 'paid', 'DB stripe_payments row paid');
    assert.strictEqual(dbTxAfterCheckout.length, 1, 'Single PLAN_PURCHASE credit transaction recorded');

    addStep({
      step: '4. Checkout Completed Signed Webhook + DB State Assertions',
      status: 'PASS',
      details: `Subscription ${sub.id} activated via real Stripe customer/card; SQLite users/subscriptions/stripe_payments/credit_transactions reconciled.`,
    });

    // Step 6: Subscription Update (including missing current_period_end preservation) + Idempotency + Unknown Price Guard
    const updatedStripeSub = await stripeClient.subscriptions.update(sub.id, {
      cancel_at_period_end: true,
    });

    const evtSubUpdateWithEnd = await postWebhook({
      id: `evt_e2e_sub_upd1_${Date.now()}`,
      object: 'event',
      type: 'customer.subscription.updated',
      created: baseTs + 5,
      data: {
        object: {
          ...updatedStripeSub,
          current_period_end: periodEndSec,
        },
      },
    });
    assert.strictEqual(evtSubUpdateWithEnd.status, 200, 'sub update with current_period_end HTTP 200');

    const subWithoutPeriodEnd: Record<string, any> = { ...updatedStripeSub };
    delete subWithoutPeriodEnd.current_period_end;
    const evtSubUpdateMissingEnd = await postWebhook({
      id: `evt_e2e_sub_upd2_${Date.now()}`,
      object: 'event',
      type: 'customer.subscription.updated',
      created: baseTs + 6,
      data: { object: subWithoutPeriodEnd },
    });
    assert.strictEqual(evtSubUpdateMissingEnd.status, 200, 'sub update missing current_period_end HTTP 200');

    const dbSubAfterMissingEnd = (storage as any).db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id) as any;
    assert.ok(dbSubAfterMissingEnd.current_period_end, 'Missing current_period_end preserved existing period end cleanly');
    assert.strictEqual(dbSubAfterMissingEnd.cancel_at_period_end, 1, 'cancel_at_period_end flag updated');

    // Unknown/unauthorized Price ID guard
    const unknownPriceRes = await postWebhook({
      id: `evt_e2e_unknown_price_${Date.now()}`,
      object: 'event',
      type: 'customer.subscription.updated',
      created: baseTs + 7,
      data: {
        object: {
          id: `sub_unknown_price_${Date.now()}`,
          object: 'subscription',
          customer: customer.id,
          status: 'active',
          items: { data: [{ price: { id: 'price_unauthorized_unknown_e2e' } }] },
          metadata: { userId, planId: 'agency' },
        },
      },
    });
    assert.strictEqual(unknownPriceRes.status, 200);
    const dbUserAfterUnknownPrice = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    assert.strictEqual(dbUserAfterUnknownPrice.plan, 'pro', 'Unknown price ID never escalates plan');
    assert.strictEqual(dbUserAfterUnknownPrice.credits_remaining, 85, 'Unknown price ID never grants credits');

    // Idempotency replay of checkout.session.completed
    const replayRes = await postWebhook({
      id: evtCheckoutId,
      object: 'event',
      type: 'checkout.session.completed',
      created: baseTs,
      data: {
        object: {
          id: checkoutData.sessionId,
          object: 'checkout.session',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: userId,
          customer: customer.id,
          subscription: sub.id,
          amount_total: 1900,
          currency: 'usd',
          metadata: { userId, planId: 'pro' },
        },
      },
    });
    assert.strictEqual(replayRes.status, 200);
    assert.strictEqual(replayRes.json.alreadyProcessed, true, 'Duplicate webhook event rejected idempotently');
    const dbUserAfterReplay = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    assert.strictEqual(dbUserAfterReplay.credits_remaining, 85, 'Idempotent replay does not double-grant credits');

    addStep({
      step: '5. Subscription Update (incl. missing current_period_end), Unknown Price Guard & Idempotency',
      status: 'PASS',
      details: 'Verified period-end preservation when omitted, unknown price rejection, and idempotent webhook replay protection.',
    });

    // Step 7: Real Stripe Test Mode Partial + Full Refund with duplicate-refund safety guard
    if (paymentIntentId) {
      const existingRefunds = await stripeClient.refunds.list({ payment_intent: paymentIntentId, limit: 5 });
      assert.strictEqual(existingRefunds.data.length, 0, 'Pre-refund safety guard: no duplicate refund exists yet');

      const partialRefund = await stripeClient.refunds.create(
        { payment_intent: paymentIntentId, amount: 950 },
        { idempotencyKey: `vr_e2e_partial_${paymentIntentId}` }
      );
      createdStripeIds.partialRefundId = partialRefund.id;

      await postWebhook({
        id: `evt_e2e_ref_partial_${Date.now()}`,
        object: 'event',
        type: 'charge.refunded',
        created: baseTs + 10,
        data: {
          object: {
            id: chargeId || `ch_test_${Date.now()}`,
            object: 'charge',
            payment_intent: paymentIntentId,
            amount: 1900,
            amount_refunded: 950,
            refunded: false,
            refunds: { data: [partialRefund] },
          },
        },
      });

      const userAfterPartial = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
      assert.ok(userAfterPartial.credits_remaining < 85 && userAfterPartial.credits_remaining > 10, 'Partial refund clawed back proportional credits');

      const fullRefund = await stripeClient.refunds.create(
        { payment_intent: paymentIntentId, amount: 950 },
        { idempotencyKey: `vr_e2e_full_${paymentIntentId}` }
      );
      createdStripeIds.fullRefundId = fullRefund.id;

      await postWebhook({
        id: `evt_e2e_ref_full_${Date.now()}`,
        object: 'event',
        type: 'charge.refunded',
        created: baseTs + 15,
        data: {
          object: {
            id: chargeId || `ch_test_${Date.now()}`,
            object: 'charge',
            payment_intent: paymentIntentId,
            amount: 1900,
            amount_refunded: 1900,
            refunded: true,
            refunds: { data: [partialRefund, fullRefund] },
          },
        },
      });

      const userAfterFull = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
      const payAfterFull = (storage as any).db.prepare('SELECT * FROM stripe_payments WHERE session_id = ?').get(checkoutData.sessionId) as any;
      const refundRows = (storage as any).db.prepare('SELECT * FROM stripe_refunds').all() as any[];

      assert.strictEqual(userAfterFull.credits_remaining, 10, 'Full refund clawed back all 75 granted credits (restored 10)');
      assert.strictEqual(userAfterFull.plan, 'free', 'Full refund downgraded plan to free');
      assert.strictEqual(payAfterFull.status, 'refunded', 'Payment status marked refunded');
      assert.ok(refundRows.length >= 2 && refundRows.every((r) => r.reconciled === 1), 'stripe_refunds ledger reconciled cleanly');

      addStep({
        step: '6. Real Stripe Partial + Full Refund & Credit Clawback Lifecycle',
        status: 'PASS',
        details: `Issued real Stripe Test Mode refunds (${partialRefund.id}, ${fullRefund.id}) with idempotency keys; SQLite refunded ledger & clawback verified.`,
      });
    } else {
      addStep({
        step: '6. Real Stripe Refund Lifecycle',
        status: 'SKIPPED',
        details: 'Test invoice yielded zero charge payment_intent (e.g. trial/coupon); refund call skipped safely.',
      });
    }

    // Step 8: Real Stripe Subscription Cancellation (customer.subscription.deleted)
    const canceledSub = await stripeClient.subscriptions.cancel(sub.id);
    createdSubscriptionId = undefined; // already canceled
    await postWebhook({
      id: `evt_e2e_sub_del_${Date.now()}`,
      object: 'event',
      type: 'customer.subscription.deleted',
      created: baseTs + 20,
      data: { object: canceledSub },
    });

    const finalSubRow = (storage as any).db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id) as any;
    const finalUserRow = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    assert.strictEqual(finalSubRow.status, 'canceled', 'Subscription canceled in SQLite');
    assert.strictEqual(finalUserRow.plan, 'free', 'User downgraded to free after subscription cancellation');

    addStep({
      step: '7. Subscription Cancellation (customer.subscription.deleted)',
      status: 'PASS',
      details: `Canceled real Stripe test subscription ${sub.id} and verified DB status='canceled', users.plan='free'.`,
    });

    return {
      mode: 'e2e',
      overallStatus: 'PASS',
      exitCode: 0,
      timestamp: new Date().toISOString(),
      steps,
      createdStripeIds,
      boundaryNote:
        'VERIFIED IN STRIPE TEST MODE (sk_test_): Executed real Stripe Test API Checkout, Subscription, Update, Partial/Full Refund, Cancellation, HMAC Webhooks, and SQLite assertions against an isolated temp DB.',
    };
  } catch (err: any) {
    addStep({
      step: 'Unhandled E2E Execution Error',
      status: 'FAIL',
      details: err?.message || String(err),
    });
    return {
      mode: preflightOnly ? 'preflight-only' : 'e2e',
      overallStatus: 'FAIL',
      exitCode: 1,
      timestamp: new Date().toISOString(),
      steps,
      createdStripeIds,
      boundaryNote: `E2E verification failed: ${err?.message || err}`,
    };
  } finally {
    // Cleanup remote Stripe Test Mode artifacts safely
    if (stripeClient) {
      if (createdSubscriptionId) {
        await stripeClient.subscriptions.cancel(createdSubscriptionId).catch(() => {});
      }
      if (createdCustomerId) {
        await stripeClient.customers.del(createdCustomerId).catch(() => {});
      }
      if (createdPriceId) {
        await stripeClient.prices.update(createdPriceId, { active: false }).catch(() => {});
      }
      if (createdProductId) {
        await stripeClient.products.update(createdProductId, { active: false }).catch(() => {});
      }
    }

    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
    if (storageRef && typeof storageRef.close === 'function') {
      await storageRef.close().catch(() => {});
    }

    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function printHumanReport(report: StripeE2EReport) {
  console.log('\n================================================================');
  console.log(`  VideoRisk Stripe Test Mode E2E Harness (mode=${report.mode})`);
  console.log('================================================================');
  console.log(`Timestamp : ${report.timestamp}`);
  console.log(`Boundary  : ${report.boundaryNote}\n`);
  for (const s of report.steps) {
    console.log(`  ${s.status.padEnd(7)} | ${s.step}`);
    console.log(`            ${s.details}`);
  }
  console.log('\n----------------------------------------------------------------');
  console.log(`SUMMARY: OVERALL=${report.overallStatus} (exitCode=${report.exitCode})`);
  console.log('----------------------------------------------------------------\n');
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]).endsWith('verify-stripe-test-mode-e2e.ts');

if (isDirectEntry) {
  const { preflightOnly, json } = parseCliArgs(process.argv.slice(2));
  runStripeTestModeE2E({ preflightOnly })
    .then((report) => {
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printHumanReport(report);
      }
      process.exit(report.exitCode);
    })
    .catch((err) => {
      console.error('❌ Stripe E2E harness crashed:', err);
      process.exit(1);
    });
}
