import assert from 'assert';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { DatabaseSync } from 'node:sqlite';
import Stripe from 'stripe';
import {
  evaluateRealCheckoutWebhookRow,
  findVerifiedRealCheckoutWebhook,
  isGenuineStripeWebhookEventId,
  parseStripeHarnessCliArgs,
  runStripeTestModeE2E,
  validateStripeE2ESafetyGuards,
} from '../scripts/verify-stripe-test-mode-e2e';

const execFileAsync = promisify(execFile);

export async function runStripeTestModeE2EHarnessTests() {
  console.log('\n======================================================');
  console.log('--- STRIPE TEST MODE E2E HARNESS & SAFETY GUARD TESTS ---');
  console.log('======================================================\n');

  // 1. Live Stripe keys must be refused (exitCode 1 FAIL)
  console.log('[1. Live Stripe Keys & Production Target Safety Guards]');
  const liveSk = validateStripeE2ESafetyGuards({
    STRIPE_SECRET_KEY: 'sk_live_FAKE_PREFIX_FOR_UNIT_TEST_ONLY_0000000000',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret_1234567890abcdef',
  });
  assert.strictEqual(liveSk.safe, false, '1.1 Live sk_live_ refused');
  assert.strictEqual(liveSk.blocked, false, '1.2 Refusal is FAIL not BLOCKED');
  assert.strictEqual(liveSk.exitCode, 1, '1.3 Exit code 1');
  assert.ok(!liveSk.reason?.includes('0000000000'), '1.4 Secret value masked in safety message');

  const liveRk = validateStripeE2ESafetyGuards({
    STRIPE_SECRET_KEY: 'rk_live_FAKE_PREFIX_FOR_UNIT_TEST_ONLY_0000000000',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret_1234567890abcdef',
  });
  assert.strictEqual(liveRk.safe, false, '1.5 Live rk_live_ refused');
  assert.strictEqual(liveRk.exitCode, 1, '1.6 Exit code 1');

  const livePaymentMode = validateStripeE2ESafetyGuards({
    PAYMENT_MODE: 'live',
    STRIPE_SECRET_KEY: 'sk_test_1234567890abcdefghij',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret_1234567890abcdef',
  });
  assert.strictEqual(livePaymentMode.safe, false, '1.7 PAYMENT_MODE=live refused');
  assert.strictEqual(livePaymentMode.exitCode, 1, '1.8 Exit code 1');

  const prodDeployEnv = validateStripeE2ESafetyGuards({
    DEPLOYMENT_ENV: 'production',
    STRIPE_SECRET_KEY: 'sk_test_1234567890abcdefghij',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret_1234567890abcdef',
  });
  assert.strictEqual(prodDeployEnv.safe, false, '1.9 DEPLOYMENT_ENV=production refused');
  assert.strictEqual(prodDeployEnv.exitCode, 1, '1.10 Exit code 1');

  const prodDbGuard = validateStripeE2ESafetyGuards({
    DATABASE_PATH: 'data/videorisk.db',
  }, { preflightOnly: true });
  assert.strictEqual(prodDbGuard.safe, false, '1.11 Production DATABASE_PATH refused even in preflightOnly');
  assert.strictEqual(prodDbGuard.exitCode, 1, '1.12 Exit code 1');
  console.log('  ✅ PASS: All live-key, prod-ENV, and prod-DB guards fail closed');

  // 2. Missing Stripe credentials returns cleanly BLOCKED — AWAITING ENV (exitCode 2)
  console.log('\n[2. Missing Stripe Credentials -> Clean BLOCKED (exit 2), Zero Mock Pass]');
  const missingCreds = validateStripeE2ESafetyGuards({
    NODE_ENV: 'test',
    DEPLOYMENT_ENV: 'test',
  });
  assert.strictEqual(missingCreds.safe, false, '2.1 Missing creds not safe to execute E2E');
  assert.strictEqual(missingCreds.blocked, true, '2.2 Classified as BLOCKED');
  assert.strictEqual(missingCreds.exitCode, 2, '2.3 Exit code 2 for BLOCKED');
  assert.ok(missingCreds.reason?.includes('BLOCKED — AWAITING ENV'), '2.4 Clear awaiting ENV reason');

  const blockedReport = await runStripeTestModeE2E({
    preflightOnly: false,
    env: { NODE_ENV: 'test', DEPLOYMENT_ENV: 'test' },
  });
  assert.strictEqual(blockedReport.overallStatus, 'BLOCKED', '2.5 E2E returns BLOCKED without credentials');
  assert.strictEqual(blockedReport.exitCode, 2, '2.6 E2E report exitCode=2');

  // Verify actual CLI exit code 2 via subprocess without Stripe ENV
  const cleanChildEnv = { ...process.env };
  delete cleanChildEnv.STRIPE_SECRET_KEY;
  delete cleanChildEnv.STRIPE_WEBHOOK_SECRET;
  delete cleanChildEnv.DATABASE_PATH;
  delete cleanChildEnv.TEST_DATABASE_PATH;
  let subprocessExitCode = 0;
  let subprocessStdout = '';
  try {
    const res = await execFileAsync('npx', ['tsx', 'scripts/verify-stripe-test-mode-e2e.ts'], {
      cwd: process.cwd(),
      env: cleanChildEnv,
      timeout: 20000,
    });
    subprocessStdout = res.stdout;
  } catch (err: any) {
    subprocessExitCode = err?.code ?? 1;
    subprocessStdout = `${err?.stdout || ''}\n${err?.stderr || ''}`;
  }
  assert.strictEqual(subprocessExitCode, 2, `2.7 CLI exited with code 2 when creds absent (got ${subprocessExitCode})`);
  assert.ok(subprocessStdout.includes('BLOCKED — AWAITING ENV'), '2.8 CLI outputs BLOCKED — AWAITING ENV');
  console.log('  ✅ PASS: Missing Stripe ENV cleanly exits 2 (BLOCKED — AWAITING ENV)');

  // 3. --preflight-only verifies routes, rawBody middleware, and isolated temp SQLite schema
  console.log('\n[3. Preflight-Only Verification (Routes, rawBody Middleware & Isolated Temp DB)]');
  const preflightExec = await execFileAsync(
    'npx',
    ['tsx', 'scripts/verify-stripe-test-mode-e2e.ts', '--preflight-only', '--json'],
    {
      cwd: process.cwd(),
      env: cleanChildEnv,
      timeout: 30000,
    }
  );
  const rawOut = preflightExec.stdout.trim();
  const jsonStart = rawOut.startsWith('{')
    ? 0
    : (rawOut.lastIndexOf('\n{') >= 0 ? rawOut.lastIndexOf('\n{') + 1 : rawOut.indexOf('{'));
  assert.ok(jsonStart >= 0, `Expected JSON object in --json output, got: ${rawOut}`);
  const preflightReport = JSON.parse(rawOut.slice(jsonStart));
  assert.strictEqual(preflightReport.overallStatus, 'PASS', `3.1 Preflight PASS (got ${preflightReport.overallStatus}: ${preflightReport.boundaryNote})`);
  assert.strictEqual(preflightReport.exitCode, 0, '3.2 Preflight exitCode=0');
  assert.strictEqual(preflightReport.testCategory, 'PREFLIGHT_ONLY', '3.3 Preflight category explicitly labeled');
  assert.strictEqual(preflightReport.realCheckoutCompletionVerified, false, '3.4 Preflight never claims real checkout');
  assert.strictEqual(preflightReport.realStripeWebhookDeliveryVerified, false, '3.5 Preflight never claims real webhook delivery');
  assert.strictEqual(preflightReport.syntheticWebhookTestsStatus, 'NOT_RUN', '3.6 Preflight does not run synthetic webhook tests');
  assert.ok(preflightReport.steps.some((s: any) => s.step.includes('Preflight Route') && s.status === 'PASS'), '3.7 SQLite schema & route step passed');
  console.log('  ✅ PASS: --preflight-only verified isolated DB schema, rawBody server & readiness');

  // 4. Category 1 (synthetic-api) vs Category 2 (real-checkout) separation & fail-closed contracts
  console.log('\n[4. Category 1 (Synthetic API) vs Category 2 (Real Checkout-to-Webhook) Boundaries]');
  const parsedDefault = parseStripeHarnessCliArgs([]);
  assert.strictEqual(parsedDefault.mode, 'synthetic-api', '4.1 Default mode is Category 1 synthetic-api');

  const parsedReal = parseStripeHarnessCliArgs([
    '--mode=real-checkout',
    '--session-id=cs_test_123',
    '--listen-port=3000',
    '--wait-seconds=60',
    '--db-path=/tmp/vr_test.db',
    '--json',
  ]);
  assert.strictEqual(parsedReal.mode, 'real-checkout', '4.2 Parses --mode=real-checkout');
  assert.strictEqual(parsedReal.sessionId, 'cs_test_123', '4.3 Parses --session-id');
  assert.strictEqual(parsedReal.listenPort, 3000, '4.4 Parses --listen-port');
  assert.strictEqual(parsedReal.waitSeconds, 60, '4.5 Parses --wait-seconds');
  assert.strictEqual(parsedReal.dbPath, '/tmp/vr_test.db', '4.6 Parses --db-path');
  assert.strictEqual(parsedReal.json, true, '4.7 Parses --json');

  const cat1Blocked = await runStripeTestModeE2E({
    mode: 'synthetic-api',
    env: { NODE_ENV: 'test', DEPLOYMENT_ENV: 'test' },
  });
  assert.strictEqual(cat1Blocked.overallStatus, 'BLOCKED', '4.8 Category 1 blocked without Stripe ENV');
  assert.strictEqual(cat1Blocked.exitCode, 2, '4.9 Category 1 exitCode=2 when blocked');
  assert.strictEqual(cat1Blocked.testCategory, 'CATEGORY_1_AUTOMATED_API_AND_SYNTHETIC_WEBHOOK', '4.10 Category 1 label enforced');
  assert.strictEqual(cat1Blocked.realCheckoutCompletionVerified, false, '4.11 Category 1 cannot verify real checkout');
  assert.strictEqual(cat1Blocked.realStripeWebhookDeliveryVerified, false, '4.12 Category 1 cannot verify real webhook');

  const cat2Blocked = await runStripeTestModeE2E({
    mode: 'real-checkout',
    env: { NODE_ENV: 'test', DEPLOYMENT_ENV: 'test' },
  });
  assert.strictEqual(cat2Blocked.overallStatus, 'BLOCKED', '4.13 Category 2 blocked without Stripe ENV');
  assert.strictEqual(cat2Blocked.exitCode, 2, '4.14 Category 2 exitCode=2 when blocked');
  assert.strictEqual(cat2Blocked.testCategory, 'CATEGORY_2_REAL_CHECKOUT_TO_WEBHOOK', '4.15 Category 2 label enforced');
  assert.strictEqual(cat2Blocked.realCheckoutCompletionVerified, false, '4.16 Category 2 never falsifies real checkout');
  assert.strictEqual(cat2Blocked.realStripeWebhookDeliveryVerified, false, '4.17 Category 2 never falsifies real webhook');
  assert.strictEqual(cat2Blocked.syntheticWebhookTestsStatus, 'NOT_RUN', '4.18 Category 2 never substitutes synthetic webhook tests');

  const invalidSessionReport = await runStripeTestModeE2E({
    mode: 'real-checkout',
    sessionId: 'cs_live_fake_invalid_prefix',
    env: {
      NODE_ENV: 'test',
      DEPLOYMENT_ENV: 'test',
      PAYMENT_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_1234567890abcdefghij',
      STRIPE_WEBHOOK_SECRET: 'whsec_testsecret1234567890abcdef',
    },
  });
  assert.strictEqual(invalidSessionReport.overallStatus, 'FAIL', '4.19 Category 2 rejects non-cs_test_ session ID');
  assert.strictEqual(invalidSessionReport.exitCode, 1, '4.20 Invalid session ID exits with code 1');
  assert.strictEqual(invalidSessionReport.realCheckoutCompletionVerified, false, '4.21 Rejected session leaves real checkout unverified');
  assert.strictEqual(invalidSessionReport.realStripeWebhookDeliveryVerified, false, '4.22 Rejected session leaves real webhook unverified');
  assert.strictEqual(invalidSessionReport.verificationMatrix.realCheckoutCompletion, 'FAIL', '4.23 Matrix marks realCheckoutCompletion FAIL');
  assert.ok(
    invalidSessionReport.steps.some((s) => s.step.includes('Prefix Validation') && s.status === 'FAIL'),
    '4.23b Executed session prefix validation step'
  );

  const cat2ProdDbGuard = await runStripeTestModeE2E({
    mode: 'real-checkout',
    dbPath: 'data/videorisk.db',
    env: {
      NODE_ENV: 'test',
      DEPLOYMENT_ENV: 'test',
      PAYMENT_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_1234567890abcdefghij',
      STRIPE_WEBHOOK_SECRET: 'whsec_testsecret1234567890abcdef',
    },
  });
  assert.strictEqual(cat2ProdDbGuard.overallStatus, 'FAIL', '4.24 Category 2 refuses production videorisk.db target');
  assert.strictEqual(cat2ProdDbGuard.exitCode, 1, '4.25 Category 2 prod DB guard exits 1');
  assert.ok(cat2ProdDbGuard.steps.some((s) => s.details.includes('SAFETY VIOLATION')), '4.26 Reports SAFETY VIOLATION');

  let realSubprocessExitCode = 0;
  let realSubprocessStdout = '';
  try {
    const res = await execFileAsync('npx', ['tsx', 'scripts/verify-stripe-test-mode-e2e.ts', '--mode=real-checkout'], {
      cwd: process.cwd(),
      env: cleanChildEnv,
      timeout: 20000,
    });
    realSubprocessStdout = res.stdout;
  } catch (err: any) {
    realSubprocessExitCode = err?.code ?? 1;
    realSubprocessStdout = `${err?.stdout || ''}\n${err?.stderr || ''}`;
  }
  assert.strictEqual(realSubprocessExitCode, 2, `4.27 Category 2 CLI exited with code 2 when creds absent (got ${realSubprocessExitCode})`);
  assert.ok(realSubprocessStdout.includes('BLOCKED — AWAITING ENV'), '4.28 Category 2 CLI outputs BLOCKED — AWAITING ENV');
  console.log('  ✅ PASS: Category 1 vs Category 2 boundaries and fail-closed guards enforced');

  // 5. Stripe Webhook-to-Checkout Session Correlation & Anti-Spoofing Regression Tests
  console.log('\n[5. Stripe Webhook-to-Checkout Session Correlation Regression Tests]');
  const corrWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_stripe_corr_test_'));
  const corrDbPath = path.join(corrWorkDir, 'webhook_correlation.db');
  const testDb = new DatabaseSync(corrDbPath);
  try {
    testDb.exec(`
      CREATE TABLE webhook_events (
        event_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event_type TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        user_id TEXT,
        credits_granted INTEGER,
        plan_granted TEXT,
        payload_json TEXT NOT NULL
      );
    `);

    const insertWebhook = testDb.prepare(`
      INSERT OR REPLACE INTO webhook_events (
        event_id, provider, event_type, processed_at, user_id, credits_granted, plan_granted, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const target = {
      sessionId: 'cs_test_a1TargetCheckoutSession999',
      ownerUserId: 'user_corr_01',
      customerId: 'cus_TargetCustomer01',
      subscriptionId: 'sub_TargetSub01',
    };

    const insertRow = (eventId: string, overrides: Record<string, any> = {}, userId = target.ownerUserId) => {
      const payload = {
        eventId,
        provider: 'stripe',
        eventType: 'checkout.session.completed',
        processedAt: new Date().toISOString(),
        userId,
        creditsGranted: 150,
        planGranted: 'pro',
        sessionId: target.sessionId,
        dataObjectId: target.sessionId,
        customerId: target.customerId,
        subscriptionId: target.subscriptionId,
        livemode: false,
        signatureVerified: true,
        ...overrides,
      };
      insertWebhook.run(
        eventId,
        'stripe',
        'checkout.session.completed',
        payload.processedAt,
        userId,
        150,
        'pro',
        JSON.stringify(payload)
      );
    };

    // 5.1 Genuine matching Checkout Session event is accepted
    assert.strictEqual(isGenuineStripeWebhookEventId('evt_1RealStripeEvent0001'), true, '5.1a Genuine Stripe evt_ ID recognized');
    assert.strictEqual(isGenuineStripeWebhookEventId('evt_synth_12345678901234'), false, '5.1b evt_synth_ rejected');
    assert.strictEqual(isGenuineStripeWebhookEventId('evt_test_12345678901234'), false, '5.1c evt_test_ rejected');

    insertRow('evt_1RealStripeEvent0001');
    const validLookup = findVerifiedRealCheckoutWebhook(testDb, target);
    assert.ok(validLookup.matched, '5.1d Matching genuine Checkout Session webhook accepted');
    assert.strictEqual(validLookup.matched.event_id, 'evt_1RealStripeEvent0001', '5.1e Returned expected genuine event_id');
    testDb.exec('DELETE FROM webhook_events');

    // 5.2 Same user_id but DIFFERENT Checkout Session must be REJECTED (even if customerId/subscriptionId match or differ)
    insertRow('evt_1DifferentSessionSameUser01', {
      sessionId: 'cs_test_otherSessionSameUser888',
      dataObjectId: 'cs_test_otherSessionSameUser888',
    });
    const diffSessionLookup = findVerifiedRealCheckoutWebhook(testDb, target);
    assert.strictEqual(diffSessionLookup.matched, null, '5.2a Same user different Checkout Session rejected');
    assert.ok(
      diffSessionLookup.rejections.some((r) => r.reason.includes('different Checkout Session') && r.claimsTargetSession === false),
      '5.2b Rejection explicitly reports different Checkout Session and claimsTargetSession=false'
    );
    testDb.exec('DELETE FROM webhook_events');

    // 5.3 Synthetic event using evt_ prefix must be REJECTED
    insertRow('evt_synth_RealPrefixSpoof01', { isSynthetic: true });
    insertRow('evt_test_HarnessEvent0002', {});
    insertRow('evt_1RealLookingIdButSynth03', { isSynthetic: true });
    const synthLookup = findVerifiedRealCheckoutWebhook(testDb, target);
    assert.strictEqual(synthLookup.matched, null, '5.3a Synthetic events using evt_ prefix rejected');
    assert.strictEqual(synthLookup.rejections.length, 3, '5.3b All 3 synthetic evt_ variants rejected');
    assert.ok(
      synthLookup.rejections.every((r) => r.claimsTargetSession === true),
      '5.3c Spoofed events targeting sessionId are flagged claimsTargetSession=true to fail closed'
    );
    testDb.exec('DELETE FROM webhook_events');

    // 5.4 Mismatched Customer ID must be REJECTED
    insertRow('evt_1WrongCustomerEvent0004', { customerId: 'cus_DifferentCustomer99' });
    const wrongCustLookup = findVerifiedRealCheckoutWebhook(testDb, target);
    assert.strictEqual(wrongCustLookup.matched, null, '5.4a Mismatched customerId rejected');
    assert.ok(
      wrongCustLookup.rejections[0]?.reason.includes('customerId'),
      '5.4b Rejection reason cites customerId mismatch'
    );
    testDb.exec('DELETE FROM webhook_events');

    // 5.5 Mismatched Subscription ID must be REJECTED (and subscriptionId on one-time session rejected)
    insertRow('evt_1WrongSubEvent0005', { subscriptionId: 'sub_DifferentSub99' });
    const wrongSubLookup = findVerifiedRealCheckoutWebhook(testDb, target);
    assert.strictEqual(wrongSubLookup.matched, null, '5.5a Mismatched subscriptionId rejected');
    assert.ok(
      wrongSubLookup.rejections[0]?.reason.includes('subscriptionId'),
      '5.5b Rejection reason cites subscriptionId mismatch'
    );
    const missingSubEval = evaluateRealCheckoutWebhookRow(
      {
        event_id: 'evt_1MissingSubEvent0005b',
        provider: 'stripe',
        event_type: 'checkout.session.completed',
        user_id: target.ownerUserId,
        payload_json: JSON.stringify({
          sessionId: target.sessionId,
          dataObjectId: target.sessionId,
          customerId: target.customerId,
          livemode: false,
          signatureVerified: true,
        }),
      },
      target
    );
    assert.strictEqual(missingSubEval.valid, false, '5.5c Missing subscriptionId for subscription session rejected');
    testDb.exec('DELETE FROM webhook_events');

    // 5.6 livemode=true (or omitted) must be REJECTED
    insertRow('evt_1LiveModeEvent0006', { livemode: true });
    insertRow('evt_1MissingLivemode0006b', { livemode: undefined });
    const liveLookup = findVerifiedRealCheckoutWebhook(testDb, target);
    assert.strictEqual(liveLookup.matched, null, '5.6a livemode=true and missing livemode rejected');
    assert.ok(
      liveLookup.rejections.some((r) => r.reason.includes('livemode=true')),
      '5.6b Explicit livemode=true rejection reason surfaced'
    );
    testDb.exec('DELETE FROM webhook_events');

    // 5.7 Missing signature verification proof (signatureVerified=false or omitted) must be REJECTED
    insertRow('evt_1UnsignedEvent0007', { signatureVerified: false });
    insertRow('evt_1OmittedSigEvent0007b', { signatureVerified: undefined });
    const unsignedLookup = findVerifiedRealCheckoutWebhook(testDb, target);
    assert.strictEqual(unsignedLookup.matched, null, '5.7a Unsigned / unverified webhook events rejected');
    assert.ok(
      unsignedLookup.rejections.every((r) => r.reason.includes('signature verification')),
      '5.7b Signature verification rejection reason surfaced'
    );
    testDb.exec('DELETE FROM webhook_events');

    // 5.8 End-to-end BillingService persistence verification (real Stripe signature vs ALLOW_SIMULATION_WEBHOOK)
    const savedEnvBilling = {
      VIDEORISK_TEST_RUN: process.env.VIDEORISK_TEST_RUN,
      TEST_DATABASE_PATH: process.env.TEST_DATABASE_PATH,
      DATABASE_PATH: process.env.DATABASE_PATH,
      DATA_DIR: process.env.DATA_DIR,
      NODE_ENV: process.env.NODE_ENV,
      DEPLOYMENT_ENV: process.env.DEPLOYMENT_ENV,
      PAYMENT_MODE: process.env.PAYMENT_MODE,
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
      ALLOW_SIMULATION_WEBHOOK: process.env.ALLOW_SIMULATION_WEBHOOK,
    };

    try {
      const billingDbPath = path.join(corrWorkDir, 'billing_webhook_persistence.db');
      const webhookSecret = 'whsec_test_correlation_regression_secret_123456';
      process.env.VIDEORISK_TEST_RUN = 'true';
      process.env.TEST_DATABASE_PATH = billingDbPath;
      process.env.DATABASE_PATH = billingDbPath;
      process.env.DATA_DIR = corrWorkDir;
      process.env.NODE_ENV = 'test';
      process.env.DEPLOYMENT_ENV = 'test';
      process.env.PAYMENT_MODE = 'test';
      process.env.STRIPE_SECRET_KEY = 'sk_test_1234567890correlationregressiontest';
      process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;

      const { SqliteStorageRepository } = await import('../src/server/storage/sqliteStorage');
      const { billingService } = await import('../src/server/services/billingService');
      const isolatedRepo = new SqliteStorageRepository(billingDbPath, process.env);
      billingService.setStorageForTest(isolatedRepo);
      billingService.reconfigure();

      try {
        const regUser = await isolatedRepo.users.createUser(
          'webhook_persist_01@example.test',
          'hash_not_used',
          'salt_not_used',
          0,
          'free'
        );

        // (a) Signed genuine-format webhook event via stripe.webhooks.generateTestHeaderString
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
          apiVersion: '2025-02-24.acacia' as any,
          typescript: true,
        });
        const signedSessionId = 'cs_test_a1BillingPersistSigned01';
        const signedEventPayload = JSON.stringify({
          id: 'evt_1BillingPersistSigned01',
          object: 'event',
          api_version: '2025-02-24.acacia',
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          type: 'checkout.session.completed',
          data: {
            object: {
              id: signedSessionId,
              object: 'checkout.session',
              client_reference_id: regUser.id,
              customer: 'cus_PersistSigned01',
              subscription: 'sub_PersistSigned01',
              payment_status: 'paid',
              status: 'complete',
              livemode: false,
              amount_total: 1900,
              currency: 'usd',
              metadata: { userId: regUser.id, planId: 'pro' },
            },
          },
        });
        const validHeader = stripe.webhooks.generateTestHeaderString({
          payload: signedEventPayload,
          secret: webhookSecret,
        });
        await billingService.handleWebhook(Buffer.from(signedEventPayload, 'utf8'), validHeader);

        const signedLookup = findVerifiedRealCheckoutWebhook(isolatedRepo.db, {
          sessionId: signedSessionId,
          ownerUserId: regUser.id,
          customerId: 'cus_PersistSigned01',
          subscriptionId: 'sub_PersistSigned01',
        });
        assert.ok(signedLookup.matched, '5.8a BillingService persists signatureVerified=true & correlation metadata for signed webhook');
        assert.strictEqual(signedLookup.matched.event_id, 'evt_1BillingPersistSigned01', '5.8b Matched persisted evt_ ID');

        // (b) Unsigned simulation-fallback webhook event (ALLOW_SIMULATION_WEBHOOK=true, no signature) MUST NOT pass real webhook lookup
        process.env.ALLOW_SIMULATION_WEBHOOK = 'true';
        const unsignedSessionId = 'cs_test_a1BillingPersistUnsigned02';
        const unsignedEventPayload = JSON.stringify({
          id: 'evt_1BillingPersistUnsigned02',
          object: 'event',
          created: Math.floor(Date.now() / 1000),
          livemode: false,
          type: 'checkout.session.completed',
          data: {
            object: {
              id: unsignedSessionId,
              object: 'checkout.session',
              client_reference_id: regUser.id,
              customer: 'cus_PersistUnsigned02',
              subscription: 'sub_PersistUnsigned02',
              payment_status: 'paid',
              status: 'complete',
              livemode: false,
              amount_total: 1900,
              currency: 'usd',
              metadata: { userId: regUser.id, planId: 'pro' },
            },
          },
        });
        await billingService.handleWebhook(Buffer.from(unsignedEventPayload, 'utf8'), '');

        const unsignedBillingLookup = findVerifiedRealCheckoutWebhook(isolatedRepo.db, {
          sessionId: unsignedSessionId,
          ownerUserId: regUser.id,
          customerId: 'cus_PersistUnsigned02',
          subscriptionId: 'sub_PersistUnsigned02',
        });
        assert.strictEqual(unsignedBillingLookup.matched, null, '5.8c Simulation-fallback webhook without signature verification is REJECTED');
        assert.ok(
          unsignedBillingLookup.rejections.some((r) => r.eventId === 'evt_1BillingPersistUnsigned02' && r.reason.includes('signature verification')),
          '5.8d Rejection explicitly cites missing signature verification'
        );
      } finally {
        billingService.setStorageForTest(null);
        await isolatedRepo.close().catch(() => {});
      }
    } finally {
      for (const [k, v] of Object.entries(savedEnvBilling)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    console.log('  ✅ PASS: All 7 Stripe Webhook-to-Checkout Session correlation & anti-spoofing tests passed');
  } finally {
    try { testDb.close(); } catch { /* ignore */ }
    fs.rmSync(corrWorkDir, { recursive: true, force: true });
  }

  console.log('\n======================================================');
  console.log('🎉 ALL STRIPE TEST MODE E2E HARNESS TESTS PASSED!');
  console.log('======================================================\n');
}

runStripeTestModeE2EHarnessTests().catch((err) => {
  console.error('\n❌ STRIPE TEST MODE E2E HARNESS TESTS FAILED:', err);
  process.exit(1);
});

