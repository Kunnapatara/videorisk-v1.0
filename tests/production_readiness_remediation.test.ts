import assert from 'assert';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import { Server } from 'http';
import path from 'path';
import Stripe from 'stripe';
import { enforceTestDatabaseIsolation } from '../src/server/storage/testIsolation';
import { validateIccProfileStructure } from '../src/server/pipeline/videoProcessor';

process.env.VIDEORISK_TEST_RUN = 'true';
enforceTestDatabaseIsolation();

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of keys) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [key, val] of Object.entries(snap)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

export async function runProductionReadinessTests(): Promise<void> {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 25: PRODUCTION READINESS REMEDIATION ---');
  console.log('Tasks A–E: SMTP Email, devResetToken, Staging, Prod Build & ICC');
  console.log('======================================================');

  const trackedKeys = [
    'NODE_ENV',
    'DEPLOYMENT_ENV',
    'PAYMENT_MODE',
    'PAYMENT_PROVIDER',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_CREATOR',
    'STRIPE_PRICE_PRO',
    'STRIPE_PRICE_AGENCY',
    'STRIPE_PRICE_AUDIT_ONCE',
    'APP_BASE_URL',
    'ALLOWED_ORIGINS',
    'MEDIA_TOKEN_SECRET',
    'ENABLE_DEV_RESET_TOKEN',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_FROM',
    'EMAIL_FROM',
    'VERCEL_ENV',
    'RAILWAY_ENVIRONMENT',
    'RENDER_ENV',
  ];
  const initialEnv = snapshotEnv(trackedKeys);

  const { resolveEnvironmentSecurity, isProductionEnvironment } = await import('../src/server/config/environment');
  const { validateBillingConfiguration } = await import('../scripts/validate-env');
  const { emailService, resolveSmtpConfiguration } = await import('../src/server/services/emailService');
  const { billingService } = await import('../src/server/services/billingService');
  const { apiRouter } = await import('../src/server/routes/api');
  const { storage } = await import('../src/server/storage');

  const app = express();
  app.set('trust proxy', true);
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use('/api', apiRouter);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // =========================================================================
    // TASK A & B: Real SMTP Password Reset Delivery + devResetToken Contract
    // =========================================================================
    console.log('\n[Task A & B: Password Reset SMTP Delivery & Contract]');

    for (const testIp of [
      '203.0.113.101',
      '203.0.113.102',
      '203.0.113.103',
      '203.0.113.104',
      '203.0.113.105',
      '203.0.113.106',
    ]) {
      await storage.rateLimits.clearRateLimits?.({ key: testIp });
    }

    const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const testEmail = `readiness_reset_${suffix}@example.com`;
    const initialPass = 'InitialReadinessPass123!';
    const updatedPass = 'UpdatedReadinessPass456!';
    const regIp = `198.51.100.${Math.floor(Math.random() * 150) + 20}`;

    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': regIp },
      body: JSON.stringify({ email: testEmail, password: initialPass }),
    });
    assert.strictEqual(regRes.status, 201, 'A.0 Test user registered for password reset suite');
    const regData = await regRes.json();
    const userId = regData.user.id as string;

    // 1. Mocked nodemailer-compatible transport captures email in Production (no devResetToken returned!)
    const sentEmails: Array<{
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    }> = [];
    const loggedConsoleLines: string[] = [];
    const origConsoleLog = console.log;
    const origConsoleError = console.error;
    console.log = (...args: any[]) => {
      loggedConsoleLines.push(args.map(String).join(' '));
      origConsoleLog(...args);
    };
    console.error = (...args: any[]) => {
      loggedConsoleLines.push(args.map(String).join(' '));
      origConsoleError(...args);
    };

    try {
      const secretSmtpPass = 'ultra_secret_smtp_password_987654';
      const secretSmtpUser = 'apikey_user_confidential';

      process.env.NODE_ENV = 'production';
      process.env.DEPLOYMENT_ENV = 'production';
      process.env.APP_BASE_URL = 'https://app.videorisk.com';
      process.env.SMTP_HOST = 'smtp.example.org';
      process.env.SMTP_PORT = '587';
      process.env.SMTP_SECURE = 'false';
      process.env.SMTP_USER = secretSmtpUser;
      process.env.SMTP_PASS = secretSmtpPass;
      process.env.SMTP_FROM = 'VideoRisk Support <support@videorisk.com>';
      process.env.ENABLE_DEV_RESET_TOKEN = 'true';

      emailService.setTransportFactoryForTest((_cfg) => ({
        sendMail: async (mail) => {
          sentEmails.push(mail);
          return {
            messageId: `<msg_${Date.now()}@smtp.example.org>`,
            accepted: [mail.to],
            rejected: [],
          };
        },
      }));

      // Existing account: email dispatched with real token, HTTP API returns non-enumerating 200 with NO token
      const prodExistingRes = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.101' },
        body: JSON.stringify({ email: testEmail }),
      });
      assert.strictEqual(prodExistingRes.status, 200, 'A.1a Existing account returns 200');
      const prodExistingBody = await prodExistingRes.json();
      assert.strictEqual(prodExistingBody.devResetToken, undefined, 'A.1b Production NEVER returns devResetToken');
      assert.strictEqual(prodExistingBody.devToken, undefined, 'A.1c Production NEVER returns devToken');
      assert.strictEqual(sentEmails.length, 1, 'A.1d Exactly 1 SMTP email dispatched for existing account');

      const mail = sentEmails[0];
      assert.strictEqual(mail.to, testEmail, 'A.1e Recipient matches account email');
      assert.ok(mail.subject.includes('VideoRisk'), 'A.1f Subject identifies VideoRisk');
      assert.ok(mail.text.includes('VideoRisk') && mail.html.includes('VideoRisk'), 'A.1g Body identifies VideoRisk');
      assert.ok(mail.text.includes('https://app.videorisk.com/?resetToken='), 'A.1h Email includes reset URL with configured origin');
      assert.ok(/1\s*hour/i.test(mail.text) && /1\s*hour/i.test(mail.html), 'A.1i Email clearly specifies 1 hour expiry');
      assert.ok(/did not request/i.test(mail.text) && /safely ignore/i.test(mail.text), 'A.1j Email warns to ignore if not requested');
      assert.ok(!mail.text.includes(secretSmtpPass) && !mail.text.includes(initialPass), 'A.1k Email contains zero secrets/passwords');

      // Extract token from email link and confirm end-to-end reset works!
      const urlMatch = mail.text.match(/https:\/\/app\.videorisk\.com\/\?resetToken=([a-f0-9]{64})/i);
      assert.ok(urlMatch && urlMatch[1], 'A.1l Email reset link contains valid 64-hex token');
      const emailedResetToken = decodeURIComponent(urlMatch[1]);

      // Non-existing account: identical HTTP response & zero SMTP calls
      const prodUnknownRes = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.102' },
        body: JSON.stringify({ email: `nonexistent_${suffix}@example.com` }),
      });
      assert.strictEqual(prodUnknownRes.status, 200, 'A.2a Non-existing account returns 200');
      const prodUnknownBody = await prodUnknownRes.json();
      assert.deepStrictEqual(prodUnknownBody, prodExistingBody, 'A.2b Non-existing & existing account responses are byte-identical');
      assert.strictEqual(sentEmails.length, 1, 'A.2c Unknown account triggers zero SMTP dispatches');

      // SMTP transport failure: must NOT reveal error/token/credentials and response remains identical
      emailService.setTransportFactoryForTest(() => ({
        sendMail: async () => {
          throw new Error(`AUTH FAILED for ${secretSmtpUser} pass=${secretSmtpPass} resetToken=${emailedResetToken}`);
        },
      }));
      const smtpFailRes = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.103' },
        body: JSON.stringify({ email: testEmail }),
      });
      assert.strictEqual(smtpFailRes.status, 200, 'A.3a SMTP failure returns identical non-enumerating 200 response');
      const smtpFailBody = await smtpFailRes.json();
      assert.deepStrictEqual(smtpFailBody, prodExistingBody, 'A.3b SMTP failure response identical to success response');

      // Missing SMTP config: identical non-enumerating 200 response
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
      emailService.setTransportFactoryForTest(null);
      const missingSmtpRes = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.104' },
        body: JSON.stringify({ email: testEmail }),
      });
      assert.strictEqual(missingSmtpRes.status, 200, 'A.4a Missing SMTP config handles gracefully with 200');
      assert.deepStrictEqual(await missingSmtpRes.json(), prodExistingBody, 'A.4b Missing SMTP response identical to normal response');

      // Partial SMTP auth config rejected cleanly by resolveSmtpConfiguration
      const partialSmtp = resolveSmtpConfiguration({
        SMTP_HOST: 'smtp.example.org',
        SMTP_USER: 'only_user_no_pass',
        SMTP_FROM: 'VideoRisk <support@videorisk.com>',
      });
      assert.strictEqual(partialSmtp.configured, false, 'A.4c Partial SMTP auth (user without pass) marked unconfigured');
      assert.strictEqual(partialSmtp.reason, 'SMTP_AUTH_INCOMPLETE', 'A.4d Partial SMTP auth reports SMTP_AUTH_INCOMPLETE');

      // Verify zero credential/token leakage in console logs during dispatch & error
      const combinedLogs = loggedConsoleLines.join('\n');
      assert.ok(!combinedLogs.includes(secretSmtpPass), 'A.5a Logs never expose SMTP_PASS');
      assert.ok(!combinedLogs.includes(secretSmtpUser), 'A.5b Logs never expose SMTP_USER');
      assert.ok(!combinedLogs.includes(emailedResetToken), 'A.5c Logs never expose raw reset token');
      assert.ok(!combinedLogs.includes(`?resetToken=${emailedResetToken}`), 'A.5d Logs never expose raw reset link');

      // Complete password reset using emailed token & verify single-use + login
      const confirmEmailReset = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.105' },
        body: JSON.stringify({ token: emailedResetToken, newPassword: updatedPass }),
      });
      assert.strictEqual(confirmEmailReset.status, 200, 'A.6a Reset token delivered via email resets password cleanly');

      const reuseEmailReset = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.105' },
        body: JSON.stringify({ token: emailedResetToken, newPassword: 'AnotherPass789!' }),
      });
      assert.strictEqual(reuseEmailReset.status, 400, 'A.6b Emailed reset token is strictly single-use');

      // Verify AuthModal frontend contract aligns with backend devResetToken field
      const authModalSource = fs.readFileSync(path.resolve(process.cwd(), 'src/components/AuthModal.tsx'), 'utf8');
      assert.ok(authModalSource.includes('data.devResetToken'), 'B.1a Frontend AuthModal reads data.devResetToken');
      assert.ok(!authModalSource.includes('data.devToken'), 'B.1b Frontend AuthModal does not reference legacy devToken');

      process.env.NODE_ENV = 'test';
      delete process.env.DEPLOYMENT_ENV;
      const devForgotRes = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.106' },
        body: JSON.stringify({ email: testEmail }),
      });
      const devForgotJson = await devForgotRes.json();
      assert.strictEqual(devForgotRes.status, 200, 'B.2a Test/dev forgot-password returns 200');
      assert.strictEqual(typeof devForgotJson.devResetToken, 'string', 'B.2b Backend returns devResetToken matching AuthModal');
      assert.strictEqual(devForgotJson.devToken, undefined, 'B.2c Backend omits legacy devToken');
    } finally {
      console.log = origConsoleLog;
      console.error = origConsoleError;
      emailService.setTransportFactoryForTest(null);
      restoreEnv(initialEnv);
    }

    // =========================================================================
    // TASK C: Staging vs Production Environment Design & Runbook Alignment
    // =========================================================================
    console.log('\n[Task C: DEPLOYMENT_ENV=staging vs production & Runbook Alignment]');

    const validStagingEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      DEPLOYMENT_ENV: 'staging',
      PAYMENT_MODE: 'test',
      PAYMENT_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_stagingKey1234567890abcdef',
      STRIPE_WEBHOOK_SECRET: 'whsec_stagingSecret1234567890abcdef',
      APP_BASE_URL: 'https://staging.videorisk.com',
      MEDIA_TOKEN_SECRET: 'vr_staging_media_secret_0123456789abcdef_strong',
    };

    const stagingSec = resolveEnvironmentSecurity(validStagingEnv);
    assert.strictEqual(stagingSec.isProduction, true, 'C.1a Staging activates runtime production hardening (no Vite, no demo seeding, strong media secret)');
    assert.strictEqual(stagingSec.isStaging, true, 'C.1b Staging flag is true');
    assert.strictEqual(stagingSec.requiresLivePayments, false, 'C.1c Staging does NOT require live Stripe keys');
    assert.strictEqual(stagingSec.hasConflict, false, 'C.1d Valid staging config has zero conflicts');
    assert.strictEqual(validateBillingConfiguration('staging', validStagingEnv).valid, true, 'C.1e validateBillingConfiguration(--mode=staging) passes');
    assert.strictEqual(validateBillingConfiguration('production', validStagingEnv).valid, false, 'C.1f Staging config is rejected when evaluated as --mode=production');

    // SMTP consistency in validateBillingConfiguration: unset -> warning only (non-blocking), invalid -> error, zero secret leakage
    const stagingNoSmtp = validateBillingConfiguration('staging', validStagingEnv);
    assert.ok(
      stagingNoSmtp.issues.some((i) => i.variable === 'SMTP_HOST' && i.type === 'WARNING'),
      'C.1g Unset SMTP_HOST in staging emits non-blocking WARNING'
    );
    const stagingBadSmtpAuth = validateBillingConfiguration('staging', {
      ...validStagingEnv,
      SMTP_HOST: 'smtp.example.org',
      SMTP_USER: 'secret_smtp_user_leak_guard',
      SMTP_FROM: 'VideoRisk <no-reply@videorisk.com>',
    });
    assert.strictEqual(stagingBadSmtpAuth.valid, false, 'C.1h Incomplete SMTP auth in staging fails validation');
    assert.ok(
      !JSON.stringify(stagingBadSmtpAuth.issues).includes('secret_smtp_user_leak_guard'),
      'C.1i SMTP validation errors never disclose credential values'
    );
    const stagingValidSmtp = validateBillingConfiguration('staging', {
      ...validStagingEnv,
      SMTP_HOST: 'smtp.example.org',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'smtp_user',
      SMTP_PASS: 'smtp_pass',
      SMTP_FROM: 'VideoRisk <no-reply@videorisk.com>',
    });
    assert.strictEqual(stagingValidSmtp.valid, true, 'C.1j Valid SMTP settings pass staging configuration validation');

    // Staging rejects live Stripe key & PAYMENT_MODE=live & platform production flags
    const stagingWithLiveKey = resolveEnvironmentSecurity({
      ...validStagingEnv,
      STRIPE_SECRET_KEY: 'sk_live_forbidden_in_staging_1234567890',
    });
    assert.strictEqual(stagingWithLiveKey.hasConflict, true, 'C.2a Staging rejects sk_live_ key');
    assert.ok(stagingWithLiveKey.conflicts.some((c) => c.code === 'LIVE_KEY_IN_STAGING'), 'C.2b Reports LIVE_KEY_IN_STAGING');
    assert.strictEqual(
      validateBillingConfiguration('staging', {
        ...validStagingEnv,
        STRIPE_SECRET_KEY: 'sk_live_forbidden_in_staging_1234567890',
      }).valid,
      false,
      'C.2c validateBillingConfiguration rejects sk_live_ in staging'
    );

    const stagingWithPlatformProd = resolveEnvironmentSecurity({
      ...validStagingEnv,
      VERCEL_ENV: 'production',
    });
    assert.strictEqual(stagingWithPlatformProd.hasConflict, true, 'C.2d DEPLOYMENT_ENV=staging cannot override VERCEL_ENV=production');
    assert.ok(stagingWithPlatformProd.conflicts.some((c) => c.code === 'STAGING_PLATFORM_PROD_CONFLICT'), 'C.2e Reports STAGING_PLATFORM_PROD_CONFLICT');
    assert.strictEqual(stagingWithPlatformProd.requiresLivePayments, true, 'C.2f Escalates requiresLivePayments when platform production detected');

    // Staging + PAYMENT_MODE=simulation rejected; Production + sk_test_ rejected; Dev/Prod contradiction rejected
    assert.strictEqual(
      resolveEnvironmentSecurity({ ...validStagingEnv, PAYMENT_MODE: 'simulation' }).hasConflict,
      true,
      'C.3a Staging forbids PAYMENT_MODE=simulation'
    );
    assert.strictEqual(
      resolveEnvironmentSecurity({
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'production',
        STRIPE_SECRET_KEY: 'sk_test_wrong_tier_1234567890abcdef',
      }).hasConflict,
      true,
      'C.3b Production forbids sk_test_ key'
    );
    assert.strictEqual(
      resolveEnvironmentSecurity({
        NODE_ENV: 'development',
        DEPLOYMENT_ENV: 'production',
        STRIPE_SECRET_KEY: 'sk_live_1234567890abcdef',
      }).hasConflict,
      true,
      'C.3c DEPLOYMENT_ENV=production + NODE_ENV=development rejected'
    );

    // Live Staging HTTP Readiness + Checkout + Webhook + Simulation Block
    process.env.NODE_ENV = 'production';
    process.env.DEPLOYMENT_ENV = 'staging';
    process.env.PAYMENT_MODE = 'test';
    process.env.PAYMENT_PROVIDER = 'stripe';
    process.env.STRIPE_SECRET_KEY = 'sk_test_stagingKey1234567890abcdef';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stagingSecret1234567890abcdef';
    process.env.APP_BASE_URL = 'https://staging.videorisk.com';
    process.env.MEDIA_TOKEN_SECRET = 'vr_staging_media_secret_0123456789abcdef_strong';

    const authToken = await storage.users.createSession(userId);
    let capturedCheckoutArgs: any = null;
    billingService.setStripeClientForTest({
      checkout: {
        sessions: {
          create: async (params: any) => {
            capturedCheckoutArgs = params;
            return { id: 'cs_test_staging_123', url: 'https://checkout.stripe.com/c/pay/cs_test_staging_123', livemode: false };
          },
        },
      },
      webhooks: {
        constructEvent: (rawBody: Buffer, sig: string, secret: string) =>
          Stripe.webhooks.constructEvent(rawBody, sig, secret),
      },
    } as any);

    try {
      const stagingReadiness = await (await fetch(`${baseUrl}/health/readiness`)).json();
      assert.strictEqual(stagingReadiness.checks.billing.status, 'healthy', 'C.4a Staging readiness reports billing healthy with sk_test_');
      assert.strictEqual(stagingReadiness.checks.billing.details.isStagingMode, true, 'C.4b Readiness details mark isStagingMode=true');
      assert.strictEqual(stagingReadiness.checks.billing.details.checkoutAvailable, true, 'C.4c Staging checkout available');

      const stagingCheckoutRes = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ planId: 'pro' }),
      });
      assert.strictEqual(stagingCheckoutRes.status, 200, 'C.4d Staging checkout succeeds with mocked Stripe test client');
      const stagingCheckoutJson = await stagingCheckoutRes.json();
      assert.strictEqual(stagingCheckoutJson.mode, 'test', 'C.4e Staging checkout reports mode=test');
      assert.strictEqual(
        capturedCheckoutArgs.success_url,
        'https://staging.videorisk.com/?checkout_status=success&session_id={CHECKOUT_SESSION_ID}',
        'C.4f Staging checkout enforces HTTPS non-localhost origin'
      );

      // Simulation mode still strictly forbidden in staging
      const stagingSimRes = await fetch(`${baseUrl}/billing/session-status?sessionId=sim_1&plan=pro&mode=simulation`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.strictEqual(stagingSimRes.status, 403, 'C.4g Staging blocks mode=simulation (403)');

      // Webhook signature check enforced in staging
      const badSigWebhook = await fetch(`${baseUrl}/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1700000000,v1=invalid' },
        body: JSON.stringify({ id: 'evt_bad_staging', type: 'checkout.session.completed' }),
      });
      assert.strictEqual(badSigWebhook.status, 400, 'C.4h Staging rejects invalid webhook signature (400)');

      // Unconfigured Stripe in staging fails closed on readiness & checkout
      billingService.setStripeClientForTest(null);
      delete process.env.STRIPE_SECRET_KEY;
      const missingStripeReadiness = await (await fetch(`${baseUrl}/health/readiness`)).json();
      assert.strictEqual(missingStripeReadiness.checks.billing.status, 'degraded', 'C.4i Missing Stripe config degrades readiness in staging');
      const missingStripeCheckout = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ planId: 'pro' }),
      });
      assert.strictEqual(missingStripeCheckout.status, 500, 'C.4j Missing Stripe fails closed (500) in staging checkout');

      // Runbook verification: real backend endpoints match STRIPE_TEST_MODE_RUNBOOK.md
      const runbookPath = path.resolve(process.cwd(), 'docs/STRIPE_TEST_MODE_RUNBOOK.md');
      const runbookText = fs.readFileSync(runbookPath, 'utf8');
      assert.ok(runbookText.includes('DEPLOYMENT_ENV=staging'), 'C.5a Runbook specifies DEPLOYMENT_ENV=staging');
      assert.ok(runbookText.includes('/api/billing/webhook'), 'C.5b Runbook uses real /api/billing/webhook route');
      assert.ok(runbookText.includes('/api/billing/checkout'), 'C.5c Runbook uses real /api/billing/checkout route');
      assert.ok(runbookText.includes('/api/billing/session-status'), 'C.5d Runbook uses real /api/billing/session-status route');
      assert.ok(runbookText.includes('/api/billing/create-portal-session'), 'C.5e Runbook uses real /api/billing/create-portal-session route');
      assert.ok(!runbookText.includes('/api/webhooks/stripe'), 'C.5f Runbook no longer contains dead /api/webhooks/stripe route');
      assert.ok(!runbookText.includes('/api/billing/create-checkout-session'), 'C.5g Runbook no longer contains dead /api/billing/create-checkout-session route');
      assert.ok(!runbookText.includes('/api/billing/verify-session'), 'C.5h Runbook no longer contains dead /api/billing/verify-session route');

      // Verify apiRouter actually defines those exact routes
      const routePaths = apiRouter.stack
        .filter((layer: any) => layer.route?.path)
        .map((layer: any) => `/api${layer.route.path}`);
      for (const expectedRoute of [
        '/api/billing/webhook',
        '/api/billing/checkout',
        '/api/billing/session-status',
        '/api/billing/create-portal-session',
      ]) {
        assert.ok(routePaths.includes(expectedRoute), `C.5i Mounted router defines ${expectedRoute}`);
      }
    } finally {
      billingService.setStripeClientForTest(null);
      billingService.reconfigure();
    }

    // =========================================================================
    // TASK E: Complete ICC Profile Structural Validation
    // =========================================================================
    console.log('\n[Task E: Complete ICC Profile Tag Alignment, Shared Ranges & Overlaps]');

    const buildIccTwoTag = (opts: {
      tag0Offset?: number;
      tag0Size?: number;
      tag1Offset?: number;
      tag1Size?: number;
      tagCount?: number;
      tag1Sig?: string;
    }): Buffer => {
      const tagTableEnd = 128 + 4 + 2 * 12; // 156 (4-byte aligned)
      const totalLen = tagTableEnd + 64;
      const buf = Buffer.alloc(totalLen);
      buf.writeUInt32BE(totalLen, 0);
      buf.write('none', 4, 'ascii');
      buf.writeUInt32BE(0x02400000, 8);
      buf.write('mntr', 12, 'ascii');
      buf.write('RGB ', 16, 'ascii');
      buf.write('XYZ ', 20, 'ascii');
      buf.writeUInt16BE(2026, 24);
      buf.writeUInt16BE(1, 26);
      buf.writeUInt16BE(1, 28);
      buf.write('acsp', 36, 'ascii');
      buf.writeInt32BE(Math.round(0.9642 * 65536), 68);
      buf.writeInt32BE(Math.round(1.0 * 65536), 72);
      buf.writeInt32BE(Math.round(0.8249 * 65536), 76);
      buf.writeUInt32BE(opts.tagCount ?? 2, 128);
      buf.write('rTRC', 132, 'ascii');
      buf.writeUInt32BE(opts.tag0Offset ?? 156, 136);
      buf.writeUInt32BE(opts.tag0Size ?? 20, 140);
      buf.write(opts.tag1Sig ?? 'gTRC', 144, 'ascii');
      buf.writeUInt32BE(opts.tag1Offset ?? 180, 148);
      buf.writeUInt32BE(opts.tag1Size ?? 20, 152);
      return buf;
    };

    assert.strictEqual(validateIccProfileStructure(buildIccTwoTag({})).valid, true, 'E.1 Valid aligned non-overlapping two-tag ICC profile accepted');
    assert.strictEqual(
      validateIccProfileStructure(buildIccTwoTag({ tag0Offset: 156, tag0Size: 20, tag1Offset: 156, tag1Size: 20 })).valid,
      true,
      'E.2 Valid exact shared tag-data range accepted'
    );

    for (const [label, opts, regex] of [
      ['partial_crossing_overlap', { tag0Offset: 156, tag0Size: 20, tag1Offset: 168, tag1Size: 20 }, /overlapping ICC tag data/i],
      ['partial_subset_overlap', { tag0Offset: 156, tag0Size: 24, tag1Offset: 160, tag1Size: 12 }, /overlapping ICC tag data/i],
      ['same_offset_diff_size', { tag0Offset: 156, tag0Size: 20, tag1Offset: 156, tag1Size: 16 }, /overlapping ICC tag data/i],
      ['unaligned_offset_mod2', { tag0Offset: 156, tag0Size: 16, tag1Offset: 174, tag1Size: 12 }, /Unaligned ICC tag offset/i],
      ['unaligned_offset_mod1', { tag0Offset: 156, tag0Size: 16, tag1Offset: 177, tag1Size: 12 }, /Unaligned ICC tag offset/i],
      ['oob_offset', { tag1Offset: 5000, tag1Size: 12 }, /Out-of-bounds/i],
      ['oob_size', { tag1Offset: 184, tag1Size: 60 }, /Out-of-bounds/i],
      ['overlap_tag_table', { tag0Offset: 132, tag0Size: 20 }, /Out-of-bounds/i],
      ['overlap_header', { tag0Offset: 64, tag0Size: 20 }, /Out-of-bounds/i],
      ['zero_tag_count', { tagCount: 0 }, /tag count/i],
      ['truncated_tag_table', { tagCount: 50 }, /Truncated ICC profile tag table/i],
    ] as Array<[string, any, RegExp]>) {
      const res = validateIccProfileStructure(buildIccTwoTag(opts));
      assert.strictEqual(res.valid, false, `E.3 Rejects ${label}`);
      assert.ok(regex.test(res.reason || ''), `E.4 Reason for ${label} matches ${regex}`);
    }

    assert.strictEqual(
      validateIccProfileStructure(buildIccTwoTag({}).subarray(0, 120)).valid,
      false,
      'E.5 Rejects truncated ICC profile < 128 bytes'
    );

    const gsDir = '/usr/share/color/icc/ghostscript';
    if (fs.existsSync(gsDir)) {
      const gsFiles = fs.readdirSync(gsDir).filter((f) => f.endsWith('.icc'));
      assert.ok(gsFiles.length > 0, 'E.6 Ghostscript ICC fixtures exist');
      for (const f of gsFiles) {
        const res = validateIccProfileStructure(fs.readFileSync(path.join(gsDir, f)));
        assert.strictEqual(res.valid, true, `E.7 Ghostscript profile '${f}' passes (${res.reason || 'ok'})`);
      }
    }

    console.log('\n======================================================');
    console.log('✅ ALL SUITE 25 PRODUCTION READINESS TESTS PASSED!');
    console.log('======================================================');
  } finally {
    restoreEnv(initialEnv);
    billingService.setStripeClientForTest(null);
    billingService.reconfigure();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

if (process.argv[1]?.includes('production_readiness_remediation.test.ts')) {
  runProductionReadinessTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ SUITE 25 FAILED:', err);
      process.exit(1);
    });
}
