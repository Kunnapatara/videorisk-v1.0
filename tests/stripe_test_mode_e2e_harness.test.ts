import assert from 'assert';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
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

  console.log('\n======================================================');
  console.log('🎉 ALL STRIPE TEST MODE E2E HARNESS TESTS PASSED!');
  console.log('======================================================\n');
}

runStripeTestModeE2EHarnessTests().catch((err) => {
  console.error('\n❌ STRIPE TEST MODE E2E HARNESS TESTS FAILED:', err);
  process.exit(1);
});
