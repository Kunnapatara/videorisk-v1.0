/**
 * VideoRisk v1.0 — Isolated Stripe Test Mode Verification Harness
 *
 * Strictly separates TWO distinct verification categories so synthetic webhook tests
 * can NEVER be misrepresented as Real Stripe Checkout-to-Webhook delivery:
 *
 *   Category 1 (--mode=synthetic-api, default when sk_test_ + whsec_ are set):
 *     - Automated Stripe Test API + Synthetic Webhook Tests (`SYNTHETIC TEST PASS`)
 *     - Creates a real Stripe Checkout Session via POST /api/billing/checkout and verifies
 *       it remains open/unpaid + rejects cross-user access (User B -> 403).
 *     - Exercises real Stripe Test API Customer/PaymentMethod/Subscription/Refund/Cancel calls
 *       and verifies webhook HMAC signature checks, correlation, idempotency, unknown price guards,
 *       and BigInt refund clawbacks using EXPLICITLY LABELED synthetic events signed with
 *       `stripe.webhooks.generateTestHeaderString()`.
 *     - Always reports `realCheckoutCompletionVerified: false` and
 *       `realStripeWebhookDeliveryVerified: false`.
 *
 *   Category 2 (--mode=real-checkout):
 *     - Real Stripe Checkout-to-Webhook Verification (`REAL STRIPE DELIVERY VERIFIED`)
 *     - Requires an actual completed Stripe Test Mode Checkout Session (`status=complete`,
 *       `payment_status=paid`, `livemode=false`) AND a genuine non-synthetic webhook event
 *       delivered by Stripe (via `stripe listen --forward-to` or Staging webhook endpoint) to
 *       `/api/billing/webhook`.
 *     - If Checkout has not been completed or Stripe webhook delivery has not arrived, fails
 *       closed with exit code 2 (`BLOCKED`) — NEVER fabricates synthetic webhooks in Category 2.
 *
 *   Preflight (--preflight-only):
 *     - Offline isolation, safety guards, rawBody middleware, and SQLite billing schema checks.
 *
 * Safety & Truth Boundaries:
 *   1. NEVER accepts live Stripe keys (sk_live_*, rk_live_*), PAYMENT_MODE=live/production,
 *      or DEPLOYMENT_ENV=production.
 *   2. NEVER targets production SQLite database (data/videorisk.db). Always enforces an
 *      ephemeral temp SQLite DB in os.tmpdir() verified via isTargetingProduction().
 *   3. NEVER fakes or mocks Stripe Test API results: without STRIPE_SECRET_KEY (sk_test_...)
 *      and STRIPE_WEBHOOK_SECRET (whsec_...), exits with status 2 (BLOCKED — AWAITING ENV).
 *   4. NEVER logs secret keys or webhook secrets in plaintext.
 *
 * Usage:
 *   npx tsx scripts/verify-stripe-test-mode-e2e.ts --preflight-only
 *   npx tsx scripts/verify-stripe-test-mode-e2e.ts --mode=synthetic-api [--json]
 *   npx tsx scripts/verify-stripe-test-mode-e2e.ts --mode=real-checkout [--listen-port=3000] [--wait-seconds=180] [--json]
 *   npx tsx scripts/verify-stripe-test-mode-e2e.ts --mode=real-checkout --session-id=cs_test_... [--db-path=/tmp/...] [--json]
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

export type StripeHarnessMode = 'synthetic-api' | 'real-checkout' | 'preflight-only';

export type StripeVerificationCategory =
  | 'PREFLIGHT_ONLY'
  | 'CATEGORY_1_AUTOMATED_API_AND_SYNTHETIC_WEBHOOK'
  | 'CATEGORY_2_REAL_CHECKOUT_TO_WEBHOOK';

export type StripeStepStatus =
  | 'PASS'
  | 'SYNTHETIC TEST PASS'
  | 'REAL STRIPE DELIVERY VERIFIED'
  | 'FAIL'
  | 'BLOCKED'
  | 'NOT VERIFIED'
  | 'SKIPPED';

export type StripeOverallStatus =
  | 'PASS'
  | 'SYNTHETIC TEST PASS'
  | 'REAL STRIPE DELIVERY VERIFIED'
  | 'FAIL'
  | 'BLOCKED';

export interface StripeE2EStepResult {
  step: string;
  category: 'PREFLIGHT' | 'STRIPE_TEST_API' | 'SYNTHETIC_WEBHOOK' | 'REAL_CHECKOUT_E2E';
  isSyntheticWebhook: boolean;
  status: StripeStepStatus;
  details: string;
}

export interface StripeVerificationMatrix {
  checkoutSessionCreated: 'PASS' | 'NOT VERIFIED' | 'FAIL' | 'BLOCKED';
  realCheckoutCompletion: 'REAL STRIPE DELIVERY VERIFIED' | 'NOT VERIFIED' | 'BLOCKED' | 'FAIL';
  realStripeWebhookDelivery: 'REAL STRIPE DELIVERY VERIFIED' | 'NOT VERIFIED' | 'BLOCKED' | 'FAIL';
  syntheticWebhookTests: 'SYNTHETIC TEST PASS' | 'NOT VERIFIED' | 'FAIL';
  customerSubscriptionCorrelation: 'PASS' | 'SYNTHETIC TEST PASS' | 'REAL STRIPE DELIVERY VERIFIED' | 'NOT VERIFIED' | 'FAIL';
  subscriptionLifecycle: 'SYNTHETIC TEST PASS' | 'REAL STRIPE DELIVERY VERIFIED' | 'NOT VERIFIED' | 'FAIL';
  refundVerification: 'SYNTHETIC TEST PASS' | 'REAL STRIPE DELIVERY VERIFIED' | 'NOT VERIFIED' | 'SKIPPED' | 'FAIL';
  webhookIdempotency: 'SYNTHETIC TEST PASS' | 'REAL STRIPE DELIVERY VERIFIED' | 'NOT VERIFIED' | 'FAIL';
  crossUserIsolation: 'PASS' | 'NOT VERIFIED' | 'FAIL';
}

export interface StripeE2EReport {
  mode: StripeHarnessMode;
  testCategory: StripeVerificationCategory;
  overallStatus: StripeOverallStatus;
  exitCode: 0 | 1 | 2;
  realCheckoutCompletionVerified: boolean;
  realStripeWebhookDeliveryVerified: boolean;
  syntheticWebhookTestsStatus: 'SYNTHETIC TEST PASS' | 'FAIL' | 'NOT_RUN';
  verificationMatrix: StripeVerificationMatrix;
  timestamp: string;
  steps: StripeE2EStepResult[];
  createdStripeIds?: Record<string, string>;
  checkoutUrl?: string;
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
  options?: { preflightOnly?: boolean; dbPath?: string }
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
  if (options?.dbPath && isTargetingProduction(options.dbPath, env)) {
    return {
      safe: false,
      blocked: false,
      exitCode: 1,
      reason: `SAFETY VIOLATION: Target DB path '${options.dbPath}' resolves to a production database target.`,
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

export interface ParsedStripeCliArgs {
  mode: StripeHarnessMode;
  preflightOnly: boolean;
  json: boolean;
  sessionId?: string;
  dbPath?: string;
  listenPort?: number;
  waitSeconds: number;
}

export function parseStripeHarnessCliArgs(argv: string[]): ParsedStripeCliArgs {
  const preflightOnly = argv.includes('--preflight-only');
  const json = argv.includes('--json');

  let mode: StripeHarnessMode = preflightOnly ? 'preflight-only' : 'synthetic-api';
  let sessionId: string | undefined;
  let dbPath: string | undefined;
  let listenPort: number | undefined;
  let waitSeconds = 0;

  for (const arg of argv) {
    if (arg === '--mode=real-checkout') mode = 'real-checkout';
    else if (arg === '--mode=synthetic-api') mode = 'synthetic-api';
    else if (arg === '--mode=preflight-only') mode = 'preflight-only';
    else if (arg.startsWith('--session-id=')) sessionId = arg.slice('--session-id='.length).trim() || undefined;
    else if (arg.startsWith('--db-path=')) dbPath = arg.slice('--db-path='.length).trim() || undefined;
    else if (arg.startsWith('--listen-port=')) {
      const n = Number.parseInt(arg.slice('--listen-port='.length), 10);
      if (Number.isFinite(n) && n > 0 && n <= 65535) listenPort = n;
    } else if (arg.startsWith('--wait-seconds=')) {
      const n = Number.parseInt(arg.slice('--wait-seconds='.length), 10);
      if (Number.isFinite(n) && n >= 0) waitSeconds = n;
    }
  }

  if (preflightOnly) {
    mode = 'preflight-only';
  }

  return {
    mode,
    preflightOnly: mode === 'preflight-only',
    json,
    sessionId,
    dbPath,
    listenPort,
    waitSeconds,
  };
}

function defaultMatrix(): StripeVerificationMatrix {
  return {
    checkoutSessionCreated: 'NOT VERIFIED',
    realCheckoutCompletion: 'NOT VERIFIED',
    realStripeWebhookDelivery: 'NOT VERIFIED',
    syntheticWebhookTests: 'NOT VERIFIED',
    customerSubscriptionCorrelation: 'NOT VERIFIED',
    subscriptionLifecycle: 'NOT VERIFIED',
    refundVerification: 'NOT VERIFIED',
    webhookIdempotency: 'NOT VERIFIED',
    crossUserIsolation: 'NOT VERIFIED',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runStripeTestModeE2E(options?: {
  mode?: StripeHarnessMode;
  preflightOnly?: boolean;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  dbPath?: string;
  listenPort?: number;
  waitSeconds?: number;
}): Promise<StripeE2EReport> {
  const targetEnv = options?.env ?? process.env;
  const parsedArgs = parseStripeHarnessCliArgs(process.argv.slice(2));
  const mode: StripeHarnessMode = options?.preflightOnly
    ? 'preflight-only'
    : (options?.mode ?? parsedArgs.mode);
  const preflightOnly = mode === 'preflight-only';
  const sessionIdArg = options?.sessionId ?? parsedArgs.sessionId;
  const dbPathArg = options?.dbPath ?? parsedArgs.dbPath;
  const listenPortArg = options?.listenPort ?? parsedArgs.listenPort;
  const waitSeconds = options?.waitSeconds ?? parsedArgs.waitSeconds;

  const testCategory: StripeVerificationCategory =
    mode === 'preflight-only'
      ? 'PREFLIGHT_ONLY'
      : mode === 'real-checkout'
        ? 'CATEGORY_2_REAL_CHECKOUT_TO_WEBHOOK'
        : 'CATEGORY_1_AUTOMATED_API_AND_SYNTHETIC_WEBHOOK';

  const steps: StripeE2EStepResult[] = [];
  const createdStripeIds: Record<string, string> = {};
  const matrix = defaultMatrix();

  const addStep = (step: StripeE2EStepResult) => steps.push(step);

  // Step 0: Safety & credential gate BEFORE initializing any DB/server
  const safety = validateStripeE2ESafetyGuards(targetEnv, { preflightOnly, dbPath: dbPathArg });
  if (!safety.safe) {
    addStep({
      step: '0. Safety Guards & Credential Gate',
      category: 'PREFLIGHT',
      isSyntheticWebhook: false,
      status: safety.blocked ? 'BLOCKED' : 'FAIL',
      details: safety.reason || 'Safety guard failed.',
    });
    return {
      mode,
      testCategory,
      overallStatus: safety.blocked ? 'BLOCKED' : 'FAIL',
      exitCode: safety.exitCode,
      realCheckoutCompletionVerified: false,
      realStripeWebhookDeliveryVerified: false,
      syntheticWebhookTestsStatus: 'NOT_RUN',
      verificationMatrix: {
        ...matrix,
        checkoutSessionCreated: safety.blocked ? 'BLOCKED' : 'FAIL',
        realCheckoutCompletion: safety.blocked ? 'BLOCKED' : 'NOT VERIFIED',
        realStripeWebhookDelivery: safety.blocked ? 'BLOCKED' : 'NOT VERIFIED',
      },
      timestamp: new Date().toISOString(),
      steps,
      boundaryNote: safety.blocked
        ? 'BLOCKED — AWAITING ENV: Configure STRIPE_SECRET_KEY=sk_test_... and STRIPE_WEBHOOK_SECRET=whsec_... to execute Stripe Test Mode verification.'
        : 'FAILED safety or credential check before executing Stripe verification.',
    };
  }

  addStep({
    step: '0. Safety Guards & Credential Gate',
    category: 'PREFLIGHT',
    isSyntheticWebhook: false,
    status: 'PASS',
    details: preflightOnly
      ? 'Live-key, prod-ENV, and prod-DB guards verified (--preflight-only).'
      : `Verified Stripe test key (${maskSecret(targetEnv.STRIPE_SECRET_KEY)}), webhook secret (${maskSecret(targetEnv.STRIPE_WEBHOOK_SECRET)}), and zero live/prod conflicts (mode=${mode}).`,
  });

  // Setup isolated ephemeral SQLite DB inside os.tmpdir() BEFORE importing storage/routes
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_stripe_e2e_'));
  const isolatedDbPath = dbPathArg ? path.resolve(dbPathArg) : path.join(workDir, 'stripe_e2e_isolated.db');

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
  let checkoutUrl: string | undefined;

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

    const listenPort = mode === 'real-checkout' && !sessionIdArg && listenPortArg ? listenPortArg : 0;
    httpServer = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(listenPort, '127.0.0.1', () => resolve(s));
    });
    const port = (httpServer.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}/api`;
    process.env.APP_BASE_URL = `http://127.0.0.1:${port}`;

    addStep({
      step: '1. Isolated SQLite DB & Ephemeral Express Server Startup',
      category: 'PREFLIGHT',
      isSyntheticWebhook: false,
      status: 'PASS',
      details: `Listening on 127.0.0.1:${port} with isolated DB ${isolatedDbPath} and express.json({ verify: req.rawBody }) preserved.`,
    });

    // =========================================================================
    // MODE: PREFLIGHT-ONLY
    // =========================================================================
    if (preflightOnly) {
      const testEmail = `stripe_preflight_${Date.now()}_${crypto.randomBytes(3).toString('hex')}@example.test`;
      const testPassword = `TestPass_${crypto.randomBytes(6).toString('hex')}!1`;
      const regRes = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });
      assert.ok(regRes.status === 200 || regRes.status === 201, `User registration failed (${regRes.status})`);

      const readinessRes = await fetch(`${baseUrl}/health/readiness`);
      assert.strictEqual(readinessRes.status, 200, 'Readiness HTTP 200');
      const tables = (storage as any).db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);
      const requiredTables = ['users', 'subscriptions', 'stripe_payments', 'stripe_refunds', 'webhook_events', 'credit_transactions'];
      for (const reqTable of requiredTables) {
        assert.ok(tables.includes(reqTable), `Required billing table '${reqTable}' present in SQLite schema`);
      }

      // Verify webhook rejects invalid/unsigned payload cleanly with HTTP 400
      const badSigRes = await fetch(`${baseUrl}/billing/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 't=1700000000,v1=0000000000000000000000000000000000000000000000000000000000000000',
        },
        body: JSON.stringify({ id: 'evt_preflight_bad_sig', type: 'checkout.session.completed' }),
      });
      assert.strictEqual(badSigRes.status, 400, `Webhook must reject invalid signature in preflight (got ${badSigRes.status})`);

      addStep({
        step: '2. Preflight Route, Readiness, Webhook Guard & SQLite Schema Verification',
        category: 'PREFLIGHT',
        isSyntheticWebhook: false,
        status: 'PASS',
        details: `Verified /api/health/readiness (200), /api/auth/register, /api/billing/webhook 400 fail-closed guard, and all 6 billing tables (${requiredTables.join(', ')}).`,
      });

      return {
        mode: 'preflight-only',
        testCategory,
        overallStatus: 'PASS',
        exitCode: 0,
        realCheckoutCompletionVerified: false,
        realStripeWebhookDeliveryVerified: false,
        syntheticWebhookTestsStatus: 'NOT_RUN',
        verificationMatrix: matrix,
        timestamp: new Date().toISOString(),
        steps,
        boundaryNote:
          'PREFLIGHT ONLY: Harness isolation, routes, rawBody middleware, and SQLite billing schema verified. Live Stripe Test Mode API, real Checkout completion, and real Stripe webhook delivery remain NOT VERIFIED until sk_test_... + whsec_... are configured.',
      };
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY!.trim();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!.trim();
    stripeClient = new Stripe(stripeKey, { apiVersion: '2025-02-24.acacia' as any, typescript: true });

    // =========================================================================
    // CATEGORY 2: REAL STRIPE CHECKOUT-TO-WEBHOOK VERIFICATION
    // =========================================================================
    if (mode === 'real-checkout') {
      if (sessionIdArg) {
        // Verify an already-completed Checkout Session + DB correlation
        if (!sessionIdArg.startsWith('cs_test_')) {
          addStep({
            step: '2. Real Checkout Session Prefix Validation',
            category: 'REAL_CHECKOUT_E2E',
            isSyntheticWebhook: false,
            status: 'FAIL',
            details: `Refused session ID '${sessionIdArg}': Category 2 Test Mode verification only accepts cs_test_... sessions.`,
          });
          return {
            mode,
            testCategory,
            overallStatus: 'FAIL',
            exitCode: 1,
            realCheckoutCompletionVerified: false,
            realStripeWebhookDeliveryVerified: false,
            syntheticWebhookTestsStatus: 'NOT_RUN',
            verificationMatrix: { ...matrix, realCheckoutCompletion: 'FAIL' },
            timestamp: new Date().toISOString(),
            steps,
            boundaryNote: 'FAILED: Invalid Checkout Session prefix (must be cs_test_...).',
          };
        }

        const session = await stripeClient.checkout.sessions.retrieve(sessionIdArg, {
          expand: ['subscription', 'payment_intent', 'invoice'],
        });
        assert.strictEqual(session.livemode, false, 'Checkout Session must be livemode=false (Test Mode)');
        createdStripeIds.checkoutSessionId = session.id;
        matrix.checkoutSessionCreated = 'PASS';

        if (session.status !== 'complete' || (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required')) {
          addStep({
            step: '2. Real Stripe Checkout Session Completion Check',
            category: 'REAL_CHECKOUT_E2E',
            isSyntheticWebhook: false,
            status: 'BLOCKED',
            details: `Checkout Session ${session.id} is NOT completed yet (status=${session.status}, payment_status=${session.payment_status}). Complete payment in Stripe Checkout URL first.`,
          });
          return {
            mode,
            testCategory,
            overallStatus: 'BLOCKED',
            exitCode: 2,
            realCheckoutCompletionVerified: false,
            realStripeWebhookDeliveryVerified: false,
            syntheticWebhookTestsStatus: 'NOT_RUN',
            verificationMatrix: { ...matrix, realCheckoutCompletion: 'BLOCKED' },
            timestamp: new Date().toISOString(),
            steps,
            createdStripeIds,
            checkoutUrl: session.url || undefined,
            boundaryNote: `BLOCKED — Checkout Session ${session.id} is still '${session.status}' / '${session.payment_status}'. Real Checkout completion is NOT VERIFIED.`,
          };
        }

        matrix.realCheckoutCompletion = 'REAL STRIPE DELIVERY VERIFIED';
        addStep({
          step: '2. Real Stripe Checkout Session Completion Check',
          category: 'REAL_CHECKOUT_E2E',
          isSyntheticWebhook: false,
          status: 'REAL STRIPE DELIVERY VERIFIED',
          details: `Verified real Stripe Checkout Session ${session.id} is status='complete', payment_status='${session.payment_status}', livemode=false.`,
        });

        // Require DB path containing webhook_events from real Stripe webhook delivery
        if (!dbPathArg || !fs.existsSync(isolatedDbPath)) {
          addStep({
            step: '3. Real Stripe Webhook Delivery & SQLite Correlation Check',
            category: 'REAL_CHECKOUT_E2E',
            isSyntheticWebhook: false,
            status: 'BLOCKED',
            details: 'No --db-path SQLite database provided to inspect real Stripe webhook_events and billing table correlation.',
          });
          return {
            mode,
            testCategory,
            overallStatus: 'BLOCKED',
            exitCode: 2,
            realCheckoutCompletionVerified: true,
            realStripeWebhookDeliveryVerified: false,
            syntheticWebhookTestsStatus: 'NOT_RUN',
            verificationMatrix: { ...matrix, realStripeWebhookDelivery: 'BLOCKED' },
            timestamp: new Date().toISOString(),
            steps,
            createdStripeIds,
            boundaryNote: 'BLOCKED — Real Checkout completion confirmed via Stripe API, but --db-path is required to verify genuine Stripe webhook delivery & SQLite correlation.',
          };
        }

        const sessionCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        const sessionSubId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        const ownerUserId = (session.client_reference_id || session.metadata?.userId || '').trim();
        const planId = (session.metadata?.planId || '').trim();

        const webhookRows = (storage as any).db
          .prepare("SELECT * FROM webhook_events WHERE event_type = 'checkout.session.completed' AND event_id LIKE 'evt_%'")
          .all() as any[];
        const matchedRealWebhook = webhookRows.find((w) => {
          try {
            const p = JSON.parse(w.payload_json || '{}');
            return w.user_id === ownerUserId && (!p.isSynthetic);
          } catch {
            return w.user_id === ownerUserId;
          }
        });

        if (!matchedRealWebhook) {
          matrix.realStripeWebhookDelivery = 'BLOCKED';
          addStep({
            step: '3. Real Stripe Webhook Delivery Check',
            category: 'REAL_CHECKOUT_E2E',
            isSyntheticWebhook: false,
            status: 'BLOCKED',
            details: `No genuine Stripe-delivered checkout.session.completed event (evt_...) found in webhook_events for user '${ownerUserId}'.`,
          });
          return {
            mode,
            testCategory,
            overallStatus: 'BLOCKED',
            exitCode: 2,
            realCheckoutCompletionVerified: true,
            realStripeWebhookDeliveryVerified: false,
            syntheticWebhookTestsStatus: 'NOT_RUN',
            verificationMatrix: matrix,
            timestamp: new Date().toISOString(),
            steps,
            createdStripeIds,
            boundaryNote: 'BLOCKED — Real Checkout Session is complete, but real Stripe webhook delivery (evt_... in webhook_events) was not observed.',
          };
        }

        matrix.realStripeWebhookDelivery = 'REAL STRIPE DELIVERY VERIFIED';

        // Strict correlation checks across Stripe API & SQLite
        const dbUser = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(ownerUserId) as any;
        const dbPay = (storage as any).db.prepare('SELECT * FROM stripe_payments WHERE session_id = ?').get(session.id) as any;
        const dbSub = sessionSubId
          ? ((storage as any).db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sessionSubId) as any)
          : null;
        const dbTx = (storage as any).db
          .prepare("SELECT * FROM credit_transactions WHERE user_id = ? AND reference_id = ? AND type = 'PLAN_PURCHASE'")
          .all(ownerUserId, session.id) as any[];

        assert.ok(dbUser, `Correlated user '${ownerUserId}' must exist in SQLite`);
        assert.ok(dbPay && dbPay.session_id === session.id, 'stripe_payments.session_id matches Checkout Session ID');
        assert.strictEqual(dbUser.stripe_customer_id, sessionCustomerId, 'users.stripe_customer_id matches Stripe Customer ID');
        assert.strictEqual(dbPay.customer_id, sessionCustomerId, 'stripe_payments.customer_id matches Stripe Customer ID');
        if (sessionSubId) {
          assert.ok(dbSub && dbSub.id === sessionSubId, 'subscriptions.id matches Stripe Subscription ID');
          assert.strictEqual(dbUser.subscription_id, sessionSubId, 'users.subscription_id matches Stripe Subscription ID');
          assert.strictEqual(dbPay.subscription_id, sessionSubId, 'stripe_payments.subscription_id matches Stripe Subscription ID');
          createdStripeIds.subscriptionId = sessionSubId;
        }
        if (planId && planId !== 'audit_once') {
          assert.strictEqual(dbUser.plan, planId, `users.plan updated to '${planId}'`);
        }
        assert.strictEqual(dbTx.length, 1, 'Exactly 1 PLAN_PURCHASE credit transaction recorded for Checkout Session');
        if (sessionCustomerId) createdStripeIds.customerId = sessionCustomerId;

        matrix.customerSubscriptionCorrelation = 'REAL STRIPE DELIVERY VERIFIED';
        matrix.webhookIdempotency = 'REAL STRIPE DELIVERY VERIFIED';

        addStep({
          step: '3. Real Stripe Webhook Delivery & Full DB Correlation Verified',
          category: 'REAL_CHECKOUT_E2E',
          isSyntheticWebhook: false,
          status: 'REAL STRIPE DELIVERY VERIFIED',
          details: `Verified real webhook ${matchedRealWebhook.event_id}, Checkout Session ${session.id}, Customer ${sessionCustomerId}, Subscription ${sessionSubId || 'one-time'}, and credit ledger.`,
        });

        return {
          mode,
          testCategory,
          overallStatus: 'REAL STRIPE DELIVERY VERIFIED',
          exitCode: 0,
          realCheckoutCompletionVerified: true,
          realStripeWebhookDeliveryVerified: true,
          syntheticWebhookTestsStatus: 'NOT_RUN',
          verificationMatrix: matrix,
          timestamp: new Date().toISOString(),
          steps,
          createdStripeIds,
          boundaryNote:
            'REAL STRIPE DELIVERY VERIFIED: Verified completed Stripe Test Mode Checkout Session, genuine Stripe-delivered webhook event (evt_...), and full SQLite correlation.',
        };
      }

      // Interactive / Listener Category 2 Flow: Create real Checkout Session and wait up to `waitSeconds` for browser Checkout + `stripe listen` webhook
      const userAEmail = `stripe_real_a_${Date.now()}_${crypto.randomBytes(3).toString('hex')}@example.test`;
      const userBEmail = `stripe_real_b_${Date.now()}_${crypto.randomBytes(3).toString('hex')}@example.test`;
      const testPass = `TestPass_${crypto.randomBytes(6).toString('hex')}!1`;

      const regARes = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userAEmail, password: testPass }),
      });
      const regBRes = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userBEmail, password: testPass }),
      });
      assert.ok(regARes.status === 200 || regARes.status === 201, 'User A registration succeeded');
      assert.ok(regBRes.status === 200 || regBRes.status === 201, 'User B registration succeeded');
      const userAData = await regARes.json();
      const userBData = await regBRes.json();

      const checkoutRes = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userAData.token}`,
          Origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ planId: 'pro' }),
      });
      assert.strictEqual(checkoutRes.status, 200, `Checkout creation failed (${checkoutRes.status})`);
      const checkoutData = await checkoutRes.json();
      assert.ok(checkoutData.sessionId?.startsWith('cs_test_'), 'Expected cs_test_ session ID');
      assert.ok(checkoutData.url, 'Expected hosted Stripe Checkout URL');
      checkoutUrl = checkoutData.url;
      createdStripeIds.checkoutSessionId = checkoutData.sessionId;
      matrix.checkoutSessionCreated = 'PASS';

      addStep({
        step: '2. Real Stripe Checkout Session Created for Category 2 E2E',
        category: 'REAL_CHECKOUT_E2E',
        isSyntheticWebhook: false,
        status: 'PASS',
        details: `Created session ${checkoutData.sessionId}. Forward Stripe CLI to http://127.0.0.1:${port}/api/billing/webhook and complete payment in browser.`,
      });

      // Cross-user isolation pre-check (User B cannot access User A's sessionId)
      const userBIsolationRes = await fetch(`${baseUrl}/billing/session-status?sessionId=${encodeURIComponent(checkoutData.sessionId)}`, {
        headers: { Authorization: `Bearer ${userBData.token}` },
      });
      assert.strictEqual(userBIsolationRes.status, 403, `User B must get HTTP 403 on User A session (got ${userBIsolationRes.status})`);
      matrix.crossUserIsolation = 'PASS';

      if (waitSeconds <= 0) {
        addStep({
          step: '3. Real Stripe Checkout Completion & Real Webhook Delivery',
          category: 'REAL_CHECKOUT_E2E',
          isSyntheticWebhook: false,
          status: 'BLOCKED',
          details: `No interactive wait window (--wait-seconds=${waitSeconds}). Real browser payment + stripe listen forwarding did not execute in unattended run.`,
        });
        return {
          mode,
          testCategory,
          overallStatus: 'BLOCKED',
          exitCode: 2,
          realCheckoutCompletionVerified: false,
          realStripeWebhookDeliveryVerified: false,
          syntheticWebhookTestsStatus: 'NOT_RUN',
          verificationMatrix: {
            ...matrix,
            realCheckoutCompletion: 'BLOCKED',
            realStripeWebhookDelivery: 'BLOCKED',
          },
          timestamp: new Date().toISOString(),
          steps,
          createdStripeIds,
          checkoutUrl,
          boundaryNote: `BLOCKED — AWAITING REAL CHECKOUT PAYMENT & WEBHOOK DELIVERY: Run with --listen-port=3000 --wait-seconds=180 while running 'stripe listen --forward-to http://127.0.0.1:3000/api/billing/webhook', then complete Checkout URL using Stripe test card 4242 4242 4242 4242.`,
        };
      }

      // Poll up to waitSeconds for real Checkout completion + real Stripe webhook delivery
      const deadlineMs = Date.now() + waitSeconds * 1000;
      let completedSession: Stripe.Checkout.Session | null = null;
      let deliveredWebhookRow: any = null;

      while (Date.now() < deadlineMs) {
        const s = await stripeClient.checkout.sessions.retrieve(checkoutData.sessionId, {
          expand: ['subscription', 'payment_intent', 'invoice'],
        });
        const isPaid = s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required');
        if (isPaid) {
          completedSession = s;
          const webhookRows = (storage as any).db
            .prepare("SELECT * FROM webhook_events WHERE event_type = 'checkout.session.completed' AND event_id LIKE 'evt_%'")
            .all() as any[];
          deliveredWebhookRow = webhookRows.find((w) => w.user_id === userAData.user.id);
          if (deliveredWebhookRow) break;
        }
        await sleep(2000);
      }

      if (!completedSession || !deliveredWebhookRow) {
        matrix.realCheckoutCompletion = completedSession ? 'REAL STRIPE DELIVERY VERIFIED' : 'BLOCKED';
        matrix.realStripeWebhookDelivery = 'BLOCKED';
        addStep({
          step: '3. Real Stripe Checkout Completion & Real Webhook Delivery Wait',
          category: 'REAL_CHECKOUT_E2E',
          isSyntheticWebhook: false,
          status: 'BLOCKED',
          details: !completedSession
            ? `Timed out after ${waitSeconds}s awaiting real Checkout payment completion for ${checkoutData.sessionId}.`
            : `Checkout ${checkoutData.sessionId} completed, but timed out awaiting genuine Stripe webhook delivery to /api/billing/webhook.`,
        });
        return {
          mode,
          testCategory,
          overallStatus: 'BLOCKED',
          exitCode: 2,
          realCheckoutCompletionVerified: Boolean(completedSession),
          realStripeWebhookDeliveryVerified: false,
          syntheticWebhookTestsStatus: 'NOT_RUN',
          verificationMatrix: matrix,
          timestamp: new Date().toISOString(),
          steps,
          createdStripeIds,
          checkoutUrl,
          boundaryNote: 'BLOCKED — Timed out awaiting real Checkout payment completion and/or real Stripe webhook delivery.',
        };
      }

      matrix.realCheckoutCompletion = 'REAL STRIPE DELIVERY VERIFIED';
      matrix.realStripeWebhookDelivery = 'REAL STRIPE DELIVERY VERIFIED';

      const sessionCustomerId = typeof completedSession.customer === 'string' ? completedSession.customer : completedSession.customer?.id;
      const sessionSubId = typeof completedSession.subscription === 'string' ? completedSession.subscription : completedSession.subscription?.id;
      if (sessionCustomerId) {
        createdCustomerId = sessionCustomerId;
        createdStripeIds.customerId = sessionCustomerId;
      }
      if (sessionSubId) {
        createdSubscriptionId = sessionSubId;
        createdStripeIds.subscriptionId = sessionSubId;
      }

      // Verify full correlation in SQLite
      const dbUserA = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userAData.user.id) as any;
      const dbUserB = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userBData.user.id) as any;
      const dbPay = (storage as any).db.prepare('SELECT * FROM stripe_payments WHERE session_id = ?').get(checkoutData.sessionId) as any;
      const dbSub = sessionSubId
        ? ((storage as any).db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sessionSubId) as any)
        : null;
      const dbTx = (storage as any).db
        .prepare("SELECT * FROM credit_transactions WHERE user_id = ? AND reference_id = ? AND type = 'PLAN_PURCHASE'")
        .all(userAData.user.id, checkoutData.sessionId) as any[];

      assert.strictEqual(dbUserA.plan, 'pro', 'User A plan updated to pro via real webhook');
      assert.strictEqual(dbUserA.credits_remaining, 85, 'User A credits updated to 85 (10 + 75)');
      assert.strictEqual(dbUserA.stripe_customer_id, sessionCustomerId, 'users.stripe_customer_id matches session.customer');
      assert.ok(dbPay && dbPay.session_id === checkoutData.sessionId && dbPay.customer_id === sessionCustomerId, 'stripe_payments correlated');
      if (sessionSubId) {
        assert.strictEqual(dbUserA.subscription_id, sessionSubId, 'users.subscription_id matches session.subscription');
        assert.ok(dbSub && dbSub.status === 'active', 'subscriptions table active');
        assert.strictEqual(dbPay.subscription_id, sessionSubId, 'stripe_payments.subscription_id matches session.subscription');
      }
      assert.strictEqual(dbTx.length, 1, 'Exactly 1 PLAN_PURCHASE transaction recorded');
      assert.strictEqual(dbUserB.plan, 'free', 'User B remains isolated on free plan');
      assert.strictEqual(dbUserB.credits_remaining, 10, 'User B credits remain isolated at 10');

      // Verify session-status sync idempotency after real webhook delivery
      const statusRes = await fetch(`${baseUrl}/billing/session-status?sessionId=${encodeURIComponent(checkoutData.sessionId)}`, {
        headers: { Authorization: `Bearer ${userAData.token}` },
      });
      assert.strictEqual(statusRes.status, 200, 'session-status HTTP 200');
      const statusJson = await statusRes.json();
      assert.strictEqual(statusJson.status, 'complete', 'session-status reports complete');
      assert.strictEqual(statusJson.entitlementActive, true, 'session-status reports entitlementActive=true');
      const dbUserAAfterSync = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userAData.user.id) as any;
      assert.strictEqual(dbUserAAfterSync.credits_remaining, 85, 'session-status sync must not double-grant credits');

      matrix.customerSubscriptionCorrelation = 'REAL STRIPE DELIVERY VERIFIED';
      matrix.webhookIdempotency = 'REAL STRIPE DELIVERY VERIFIED';

      addStep({
        step: '3. Real Checkout Payment, Real Stripe Webhook Delivery & Full DB Correlation Verified',
        category: 'REAL_CHECKOUT_E2E',
        isSyntheticWebhook: false,
        status: 'REAL STRIPE DELIVERY VERIFIED',
        details: `Verified real Checkout ${checkoutData.sessionId}, Stripe webhook ${deliveredWebhookRow.event_id}, Customer ${sessionCustomerId}, Subscription ${sessionSubId || 'n/a'}, idempotency, and User A/B isolation.`,
      });

      return {
        mode,
        testCategory,
        overallStatus: 'REAL STRIPE DELIVERY VERIFIED',
        exitCode: 0,
        realCheckoutCompletionVerified: true,
        realStripeWebhookDeliveryVerified: true,
        syntheticWebhookTestsStatus: 'NOT_RUN',
        verificationMatrix: matrix,
        timestamp: new Date().toISOString(),
        steps,
        createdStripeIds,
        checkoutUrl,
        boundaryNote:
          'REAL STRIPE DELIVERY VERIFIED: Completed live Stripe Test Mode Checkout session, received genuine Stripe-delivered webhook at /api/billing/webhook, and verified full DB & entitlement correlation.',
      };
    }

    // =========================================================================
    // CATEGORY 1: AUTOMATED STRIPE TEST API + SYNTHETIC WEBHOOK TESTS
    // =========================================================================
    // Register User A (purchaser) and User B (isolation target) via real API
    const userAEmail = `stripe_synth_a_${Date.now()}_${crypto.randomBytes(3).toString('hex')}@example.test`;
    const userBEmail = `stripe_synth_b_${Date.now()}_${crypto.randomBytes(3).toString('hex')}@example.test`;
    const testPassword = `TestPass_${crypto.randomBytes(6).toString('hex')}!1`;

    const regARes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userAEmail, password: testPassword }),
    });
    const regBRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userBEmail, password: testPassword }),
    });
    assert.ok(regARes.status === 200 || regARes.status === 201, `User A registration failed (${regARes.status})`);
    assert.ok(regBRes.status === 200 || regBRes.status === 201, `User B registration failed (${regBRes.status})`);
    const regAData = await regARes.json();
    const regBData = await regBRes.json();
    const sessionToken: string = regAData.token;
    const userId: string = regAData.user.id;
    const userBToken: string = regBData.token;
    const userBId: string = regBData.user.id;
    assert.ok(sessionToken && userId && userBToken && userBId, 'Registered User A and User B receive tokens and IDs');

    const signSyntheticEvent = (evt: Record<string, any>): { raw: string; signature: string } => {
      const taggedEvt = {
        ...evt,
        __syntheticTestMarker: 'LOCAL_SYNTHETIC_TEST_EVENT_NOT_STRIPE_DELIVERED',
      };
      const raw = JSON.stringify(taggedEvt);
      const signature = stripeClient!.webhooks.generateTestHeaderString({
        payload: raw,
        secret: webhookSecret,
      });
      return { raw, signature };
    };

    const postSyntheticWebhook = async (evt: Record<string, any>, overrideSignature?: string) => {
      const { raw, signature } = signSyntheticEvent(evt);
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
    const badSig = await postSyntheticWebhook(
      { id: `evt_synth_bad_${Date.now()}`, object: 'event', type: 'checkout.session.completed', data: { object: {} } },
      't=1700000000,v1=0000000000000000000000000000000000000000000000000000000000000000'
    );
    assert.strictEqual(badSig.status, 400, `Invalid signature must return 400 (got ${badSig.status})`);
    addStep({
      step: '2. Invalid Webhook Signature Guard (400 fail-closed)',
      category: 'STRIPE_TEST_API',
      isSyntheticWebhook: false,
      status: 'PASS',
      details: 'POST /api/billing/webhook rejected tampered HMAC signature with HTTP 400.',
    });

    // Step 3: Real Stripe Checkout Session creation (POST /api/billing/checkout) + unpaid boundary + User B 403 isolation
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
    checkoutUrl = checkoutData.url;
    createdStripeIds.checkoutSessionId = checkoutData.sessionId;
    matrix.checkoutSessionCreated = 'PASS';

    // Verify Checkout Session genuinely remains open/unpaid (proving Category 1 does NOT complete Checkout)
    const retrievedUnpaid = await stripeClient.checkout.sessions.retrieve(checkoutData.sessionId);
    assert.strictEqual(retrievedUnpaid.status, 'open', 'Uncompleted Checkout Session remains open on Stripe API');
    assert.strictEqual(retrievedUnpaid.payment_status, 'unpaid', 'Uncompleted Checkout Session remains unpaid');

    // Cross-user isolation: User B must receive HTTP 403 on User A's Checkout Session
    const userBStatusRes = await fetch(
      `${baseUrl}/billing/session-status?sessionId=${encodeURIComponent(checkoutData.sessionId)}`,
      { headers: { Authorization: `Bearer ${userBToken}` } }
    );
    assert.strictEqual(userBStatusRes.status, 403, `Cross-user session access must return HTTP 403 (got ${userBStatusRes.status})`);
    matrix.crossUserIsolation = 'PASS';

    addStep({
      step: '3. Real Stripe Checkout Session Creation & Cross-User Isolation (Unpaid Open Session)',
      category: 'STRIPE_TEST_API',
      isSyntheticWebhook: false,
      status: 'PASS',
      details: `Created real Stripe Test Mode session ${checkoutData.sessionId} (status=open, payment_status=unpaid) and verified User B access rejected with HTTP 403. Real Checkout completion: NOT VERIFIED in Category 1.`,
    });

    // Step 4: Create separate Stripe Test API Customer, PaymentMethod (pm_card_visa), Price, and Paid Subscription
    const customer = await stripeClient.customers.create({
      email: userAEmail,
      metadata: { userId, testHarness: 'verify-stripe-test-mode-e2e-synthetic-api' },
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
        name: `VideoRisk Synthetic API Pro ${Date.now()}`,
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

    // Step 5: [SYNTHETIC TEST EVENT] Locally signed checkout.session.completed webhook + DB correlation assertions
    const baseTs = Math.floor(Date.now() / 1000);
    const evtCheckoutId = `evt_synth_checkout_${Date.now()}`;
    const checkoutWebhookRes = await postSyntheticWebhook({
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
    assert.strictEqual(checkoutWebhookRes.status, 200, 'Synthetic checkout.session.completed HTTP 200');

    const dbUserAfterCheckout = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    const dbUserBAfterCheckout = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userBId) as any;
    const dbSubAfterCheckout = (storage as any).db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id) as any;
    const dbPayAfterCheckout = (storage as any).db.prepare('SELECT * FROM stripe_payments WHERE session_id = ?').get(checkoutData.sessionId) as any;
    const dbTxAfterCheckout = (storage as any).db.prepare('SELECT * FROM credit_transactions WHERE user_id = ?').all(userId) as any[];

    assert.strictEqual(dbUserAfterCheckout.plan, 'pro', 'DB users.plan updated to pro');
    assert.strictEqual(dbUserAfterCheckout.credits_remaining, 85, 'DB users.credits_remaining = 10 + 75 = 85');
    assert.strictEqual(dbUserAfterCheckout.stripe_customer_id, customer.id, 'DB users.stripe_customer_id persisted');
    assert.strictEqual(dbUserAfterCheckout.subscription_id, sub.id, 'DB users.subscription_id persisted');
    assert.strictEqual(dbSubAfterCheckout.status, 'active', 'DB subscriptions.status=active');
    assert.ok(dbPayAfterCheckout && dbPayAfterCheckout.status === 'paid', 'DB stripe_payments row paid');
    assert.strictEqual(dbPayAfterCheckout.customer_id, customer.id, 'DB stripe_payments.customer_id correlated');
    assert.strictEqual(dbPayAfterCheckout.subscription_id, sub.id, 'DB stripe_payments.subscription_id correlated');
    assert.strictEqual(dbTxAfterCheckout.length, 1, 'Single PLAN_PURCHASE credit transaction recorded');
    assert.strictEqual(dbUserBAfterCheckout.plan, 'free', 'User B remains on free plan');
    assert.strictEqual(dbUserBAfterCheckout.credits_remaining, 10, 'User B credits remain 10');

    matrix.customerSubscriptionCorrelation = 'SYNTHETIC TEST PASS';

    addStep({
      step: '4. [SYNTHETIC WEBHOOK] Checkout Completed Payload + DB Correlation Assertions',
      category: 'SYNTHETIC_WEBHOOK',
      isSyntheticWebhook: true,
      status: 'SYNTHETIC TEST PASS',
      details: `[SYNTHETIC EVENT signed locally via generateTestHeaderString] Reconciled Customer ${customer.id}, Subscription ${sub.id}, and SQLite records for User A while isolating User B. NOT real Stripe webhook delivery.`,
    });

    // Step 6: [SYNTHETIC TEST EVENT] Subscription Update (incl. omitted current_period_end) + Unknown Price Guard + Idempotency
    const updatedStripeSub = await stripeClient.subscriptions.update(sub.id, {
      cancel_at_period_end: true,
    });

    const evtSubUpdateWithEnd = await postSyntheticWebhook({
      id: `evt_synth_sub_upd1_${Date.now()}`,
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
    assert.strictEqual(evtSubUpdateWithEnd.status, 200, 'Synthetic sub update with current_period_end HTTP 200');

    const subWithoutPeriodEnd: Record<string, any> = { ...updatedStripeSub };
    delete subWithoutPeriodEnd.current_period_end;
    const evtSubUpdateMissingEnd = await postSyntheticWebhook({
      id: `evt_synth_sub_upd2_${Date.now()}`,
      object: 'event',
      type: 'customer.subscription.updated',
      created: baseTs + 6,
      data: { object: subWithoutPeriodEnd },
    });
    assert.strictEqual(evtSubUpdateMissingEnd.status, 200, 'Synthetic sub update missing current_period_end HTTP 200');

    const dbSubAfterMissingEnd = (storage as any).db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id) as any;
    assert.ok(dbSubAfterMissingEnd.current_period_end, 'Missing current_period_end preserved existing period end cleanly');
    assert.strictEqual(dbSubAfterMissingEnd.cancel_at_period_end, 1, 'cancel_at_period_end flag updated');

    const unknownPriceRes = await postSyntheticWebhook({
      id: `evt_synth_unknown_price_${Date.now()}`,
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

    const replayRes = await postSyntheticWebhook({
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

    matrix.webhookIdempotency = 'SYNTHETIC TEST PASS';

    addStep({
      step: '5. [SYNTHETIC WEBHOOK] Subscription Update, Unknown Price Guard & Idempotent Replay',
      category: 'SYNTHETIC_WEBHOOK',
      isSyntheticWebhook: true,
      status: 'SYNTHETIC TEST PASS',
      details: '[SYNTHETIC EVENT] Verified period-end preservation when omitted, unknown price rejection, and idempotent webhook replay protection.',
    });

    // Step 7: Real Stripe Test Mode Partial + Full Refund + [SYNTHETIC WEBHOOK] charge.refunded
    if (paymentIntentId) {
      const existingRefunds = await stripeClient.refunds.list({ payment_intent: paymentIntentId, limit: 5 });
      assert.strictEqual(existingRefunds.data.length, 0, 'Pre-refund safety guard: no duplicate refund exists yet');

      const partialRefund = await stripeClient.refunds.create(
        { payment_intent: paymentIntentId, amount: 950 },
        { idempotencyKey: `vr_e2e_partial_${paymentIntentId}` }
      );
      createdStripeIds.partialRefundId = partialRefund.id;

      await postSyntheticWebhook({
        id: `evt_synth_ref_partial_${Date.now()}`,
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

      await postSyntheticWebhook({
        id: `evt_synth_ref_full_${Date.now()}`,
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

      matrix.refundVerification = 'SYNTHETIC TEST PASS';

      addStep({
        step: '6. [STRIPE API + SYNTHETIC WEBHOOK] Partial/Full Refund & Credit Clawback',
        category: 'SYNTHETIC_WEBHOOK',
        isSyntheticWebhook: true,
        status: 'SYNTHETIC TEST PASS',
        details: `[SYNTHETIC charge.refunded EVENTS] Issued real Stripe Test Mode refunds (${partialRefund.id}, ${fullRefund.id}) with idempotency keys; reconciled refund ledger & clawback locally.`,
      });
    } else {
      matrix.refundVerification = 'SKIPPED';
      addStep({
        step: '6. Refund Lifecycle',
        category: 'STRIPE_TEST_API',
        isSyntheticWebhook: false,
        status: 'SKIPPED',
        details: 'Test invoice yielded zero charge payment_intent; refund call skipped safely.',
      });
    }

    // Step 8: Real Stripe Subscription Cancellation + [SYNTHETIC WEBHOOK] customer.subscription.deleted
    const canceledSub = await stripeClient.subscriptions.cancel(sub.id);
    createdSubscriptionId = undefined;
    await postSyntheticWebhook({
      id: `evt_synth_sub_del_${Date.now()}`,
      object: 'event',
      type: 'customer.subscription.deleted',
      created: baseTs + 20,
      data: { object: canceledSub },
    });

    const finalSubRow = (storage as any).db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(sub.id) as any;
    const finalUserRow = (storage as any).db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    assert.strictEqual(finalSubRow.status, 'canceled', 'Subscription canceled in SQLite');
    assert.strictEqual(finalUserRow.plan, 'free', 'User downgraded to free after subscription cancellation');

    matrix.subscriptionLifecycle = 'SYNTHETIC TEST PASS';
    matrix.syntheticWebhookTests = 'SYNTHETIC TEST PASS';

    addStep({
      step: '7. [STRIPE API + SYNTHETIC WEBHOOK] Subscription Cancellation (customer.subscription.deleted)',
      category: 'SYNTHETIC_WEBHOOK',
      isSyntheticWebhook: true,
      status: 'SYNTHETIC TEST PASS',
      details: `[SYNTHETIC customer.subscription.deleted EVENT] Canceled real Stripe test subscription ${sub.id} and verified DB status='canceled', users.plan='free'.`,
    });

    return {
      mode: 'synthetic-api',
      testCategory,
      overallStatus: 'SYNTHETIC TEST PASS',
      exitCode: 0,
      realCheckoutCompletionVerified: false,
      realStripeWebhookDeliveryVerified: false,
      syntheticWebhookTestsStatus: 'SYNTHETIC TEST PASS',
      verificationMatrix: matrix,
      timestamp: new Date().toISOString(),
      steps,
      createdStripeIds,
      checkoutUrl,
      boundaryNote:
        'SYNTHETIC TEST PASS (NOT REAL CHECKOUT-TO-WEBHOOK): Executed Stripe Test API calls (Checkout session creation, Customer, Subscription, Refund, Cancel) and locally signed synthetic webhook events (generateTestHeaderString). Real Stripe Checkout completion and real Stripe webhook delivery remain NOT VERIFIED; run --mode=real-checkout with browser payment + stripe listen.',
    };
  } catch (err: any) {
    addStep({
      step: 'Unhandled Harness Execution Error',
      category: 'PREFLIGHT',
      isSyntheticWebhook: false,
      status: 'FAIL',
      details: err?.message || String(err),
    });
    return {
      mode,
      testCategory,
      overallStatus: 'FAIL',
      exitCode: 1,
      realCheckoutCompletionVerified: false,
      realStripeWebhookDeliveryVerified: false,
      syntheticWebhookTestsStatus: mode === 'synthetic-api' ? 'FAIL' : 'NOT_RUN',
      verificationMatrix: matrix,
      timestamp: new Date().toISOString(),
      steps,
      createdStripeIds,
      checkoutUrl,
      boundaryNote: `Stripe harness failed: ${err?.message || err}`,
    };
  } finally {
    // Cleanup remote Stripe Test Mode artifacts safely when created by harness
    if (stripeClient && mode === 'synthetic-api') {
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
  console.log(`  VideoRisk Stripe Test Mode Harness`);
  console.log(`  mode=${report.mode} | category=${report.testCategory}`);
  console.log('================================================================');
  console.log(`Timestamp                  : ${report.timestamp}`);
  console.log(`Real Checkout Completed    : ${report.realCheckoutCompletionVerified ? 'YES' : 'NO (NOT VERIFIED)'}`);
  console.log(`Real Stripe Webhook Recv   : ${report.realStripeWebhookDeliveryVerified ? 'YES' : 'NO (NOT VERIFIED)'}`);
  console.log(`Synthetic Webhook Tests    : ${report.syntheticWebhookTestsStatus}`);
  if (report.checkoutUrl) {
    console.log(`Checkout URL               : ${report.checkoutUrl}`);
  }
  console.log(`Boundary                   : ${report.boundaryNote}\n`);
  for (const s of report.steps) {
    const synthTag = s.isSyntheticWebhook ? '[SYNTHETIC] ' : '';
    console.log(`  ${s.status.padEnd(30)} | ${synthTag}${s.step}`);
    console.log(`                                   ${s.details}`);
  }
  console.log('\n----------------------------------------------------------------');
  console.log(`SUMMARY: OVERALL=${report.overallStatus} (exitCode=${report.exitCode})`);
  console.log('----------------------------------------------------------------\n');
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]).endsWith('verify-stripe-test-mode-e2e.ts');

if (isDirectEntry) {
  const parsed = parseStripeHarnessCliArgs(process.argv.slice(2));
  runStripeTestModeE2E(parsed)
    .then((report) => {
      if (parsed.json) {
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
