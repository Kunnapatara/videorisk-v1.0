import assert from 'assert';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
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
  const jsonStart = rawOut.indexOf('{');
  assert.ok(jsonStart >= 0, `Expected JSON object in --json output, got: ${rawOut}`);
  const preflightReport = JSON.parse(rawOut.slice(jsonStart));
  assert.strictEqual(preflightReport.overallStatus, 'PASS', `3.1 Preflight PASS (got ${preflightReport.overallStatus}: ${preflightReport.boundaryNote})`);
  assert.strictEqual(preflightReport.exitCode, 0, '3.2 Preflight exitCode=0');
  assert.ok(preflightReport.steps.some((s: any) => s.step.includes('Preflight Route') && s.status === 'PASS'), '3.3 SQLite schema & route step passed');
  console.log('  ✅ PASS: --preflight-only verified isolated DB schema, rawBody server & readiness');

  console.log('\n======================================================');
  console.log('🎉 ALL STRIPE TEST MODE E2E HARNESS TESTS PASSED!');
  console.log('======================================================\n');
}

runStripeTestModeE2EHarnessTests().catch((err) => {
  console.error('\n❌ STRIPE TEST MODE E2E HARNESS TESTS FAILED:', err);
  process.exit(1);
});
