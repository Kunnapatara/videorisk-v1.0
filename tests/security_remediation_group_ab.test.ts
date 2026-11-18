import assert from 'assert';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import { Server } from 'http';
import os from 'os';
import path from 'path';
import { enforceTestDatabaseIsolation } from '../src/server/storage/testIsolation';

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

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

export async function runGroupABSecurityRemediationTests(): Promise<void> {
  console.log('\n======================================================');
  console.log('--- GROUP A & B SECURITY REMEDIATION REGRESSION ------');
  console.log('Canonical Prod Gates, Zero Demo Seeding, Whisper, Reset');
  console.log('======================================================');

  const trackedKeys = [
    'NODE_ENV',
    'PAYMENT_MODE',
    'STRIPE_SECRET_KEY',
    'ENABLE_DEV_RESET_TOKEN',
    'WHISPER_PATH',
    'LOCAL_STT_PATH',
    'WHISPER_MODEL_PATH',
    'WHISPER_COMPAT_AUDIO_PATH',
    'WHISPER_VERIFY_COMPATIBILITY',
    'SMTP_HOST',
    'SMTP_USER',
  ];
  const initialEnv = snapshotEnv(trackedKeys);
  const tempDirs: string[] = [];

  try {
    const { isProductionEnvironment } = await import('../src/server/config/environment');
    const { InMemoryStorageRepository } = await import('../src/server/storage/index');
    const { SqliteStorageRepository } = await import('../src/server/storage/sqliteStorage');
    const {
      SpeechTranscriptionAdapter,
      shouldEnforceWhisperCompatibility,
    } = await import('../src/server/pipeline/audioProcessor');
    const { policyIntelligenceEngine } = await import('../src/server/intelligence/policyIntelligence');
    const { apiRouter } = await import('../src/server/routes/api');
    const { storage } = await import('../src/server/storage');

    // =========================================================================
    // GROUP A2: Prevent demo/default account seeding & fallback in Prod Mode
    // =========================================================================
    console.log('\n[Group A2: Storage Demo/Default Account Seeding & Fallback Isolation]');

    const liveDevEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'development',
      PAYMENT_MODE: 'live',
      STRIPE_SECRET_KEY: 'sk_live_test_placeholder_000000',
    };
    assert.strictEqual(
      isProductionEnvironment(liveDevEnv),
      true,
      'A2.0 Canonical predicate treats NODE_ENV=development + PAYMENT_MODE=live + sk_live as Production Mode'
    );

    // 1. SQLite empty temp DB under NODE_ENV=development + PAYMENT_MODE=live + sk_live_<placeholder>
    const sqliteProdTmpDir = makeTempDir('vr_a2_sqlite_');
    tempDirs.push(sqliteProdTmpDir);
    const sqliteLiveDevPath = path.join(sqliteProdTmpDir, 'empty_live_dev.db');
    const sqliteLiveDev = new SqliteStorageRepository(sqliteLiveDevPath, liveDevEnv);
    try {
      const users = await sqliteLiveDev.users.listUsers();
      assert.strictEqual(users.length, 0, 'A2.1a Empty SQLite DB seeds 0 demo accounts under dev+live payment config');
      assert.strictEqual(
        await sqliteLiveDev.users.getUserByEmail('creator@videorisk.com'),
        null,
        'A2.1b creator@videorisk.com is NOT seeded in dev+live payment config'
      );
      assert.strictEqual(
        await sqliteLiveDev.users.getUserByEmail('pro@videorisk.com'),
        null,
        'A2.1c pro@videorisk.com is NOT seeded in dev+live payment config'
      );
      assert.strictEqual(
        await sqliteLiveDev.users.getUserByEmail('free@videorisk.com'),
        null,
        'A2.1d free@videorisk.com is NOT seeded in dev+live payment config'
      );

      await assert.rejects(
        async () => await sqliteLiveDev.users.getOrCreateDefaultUser(),
        /disabled in production/i,
        'A2.1e SqliteStorageRepository.getOrCreateDefaultUser() fails closed under dev+live payment config'
      );
      assert.strictEqual(
        (await sqliteLiveDev.users.listUsers()).length,
        0,
        'A2.1f Failed getOrCreateDefaultUser() does not create any fallback user'
      );

      await assert.rejects(
        async () => await sqliteLiveDev.rateLimits.clearRateLimits?.(),
        /production environment/i,
        'A2.1g Sqlite unfiltered clearRateLimits() rejected under dev+live payment config'
      );
      await assert.rejects(
        async () => await sqliteLiveDev.rateLimits.clearTestRateLimits?.('test_'),
        /production environment/i,
        'A2.1h Sqlite clearTestRateLimits() rejected under dev+live payment config'
      );

      // Normal production account registration still works cleanly
      const prodRegSalt = crypto.randomBytes(16).toString('hex');
      const prodRegHash = crypto.scryptSync('StrongPass123!', prodRegSalt, 64).toString('hex');
      const createdProdUser = await sqliteLiveDev.users.createUser(
        'real_prod_creator@example.com',
        prodRegHash,
        prodRegSalt,
        10,
        'free'
      );
      assert.strictEqual(
        createdProdUser.email,
        'real_prod_creator@example.com',
        'A2.1i Normal user creation remains functional in Production Mode'
      );
    } finally {
      await sqliteLiveDev.close();
    }

    // Re-open existing DB in production mode -> legitimate user preserved, still no demo accounts seeded
    const sqliteProdReopened = new SqliteStorageRepository(sqliteLiveDevPath, {
      ...process.env,
      NODE_ENV: 'production',
    });
    try {
      const preservedUsers = await sqliteProdReopened.users.listUsers();
      assert.strictEqual(preservedUsers.length, 1, 'A2.2a Existing legitimate user record preserved on restart');
      assert.strictEqual(
        preservedUsers[0].email,
        'real_prod_creator@example.com',
        'A2.2b Legitimate user record intact'
      );
    } finally {
      await sqliteProdReopened.close();
    }

    // 2. Empty SQLite DB under NODE_ENV=production -> 0 demo users, blocked fallback
    const sqlitePureProdPath = path.join(sqliteProdTmpDir, 'empty_prod.db');
    const sqlitePureProd = new SqliteStorageRepository(sqlitePureProdPath, {
      ...process.env,
      NODE_ENV: 'production',
    });
    try {
      assert.strictEqual((await sqlitePureProd.users.listUsers()).length, 0, 'A2.3a NODE_ENV=production seeds 0 users');
      await assert.rejects(
        async () => await sqlitePureProd.users.getOrCreateDefaultUser(),
        /disabled in production/i,
        'A2.3b NODE_ENV=production blocks getOrCreateDefaultUser()'
      );
    } finally {
      await sqlitePureProd.close();
    }

    // 3. InMemoryStorageRepository under dev+live payment config -> 0 demo users, blocked fallback
    const memLiveDevPath = path.join(sqliteProdTmpDir, 'mem_live_dev.json');
    const memLiveDev = new InMemoryStorageRepository(memLiveDevPath, liveDevEnv);
    assert.strictEqual((await memLiveDev.users.listUsers()).length, 0, 'A2.4a InMemory storage seeds 0 demo accounts under dev+live payment config');
    await assert.rejects(
      async () => await memLiveDev.users.getOrCreateDefaultUser(),
      /disabled in production/i,
      'A2.4b InMemory getOrCreateDefaultUser() fails closed under dev+live payment config'
    );
    await assert.rejects(
      async () => await memLiveDev.rateLimits.clearTestRateLimits?.('test_'),
      /production environment/i,
      'A2.4c InMemory clearTestRateLimits() rejected under dev+live payment config'
    );

    // 4. Normal Development & Test environments continue to seed expected demo fixtures
    const sqliteNormalDevPath = path.join(sqliteProdTmpDir, 'normal_dev.db');
    const sqliteNormalDev = new SqliteStorageRepository(sqliteNormalDevPath, {
      ...process.env,
      NODE_ENV: 'development',
      PAYMENT_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_placeholder_000000',
    });
    try {
      const devUsers = await sqliteNormalDev.users.listUsers();
      assert.strictEqual(devUsers.length, 3, 'A2.5a Normal development environment seeds 3 demo accounts');
      assert(await sqliteNormalDev.users.getUserByEmail('creator@videorisk.com') !== null, 'A2.5b creator@videorisk.com seeded in dev');
      assert(await sqliteNormalDev.users.getUserByEmail('pro@videorisk.com') !== null, 'A2.5c pro@videorisk.com seeded in dev');
      assert(await sqliteNormalDev.users.getUserByEmail('free@videorisk.com') !== null, 'A2.5d free@videorisk.com seeded in dev');
    } finally {
      await sqliteNormalDev.close();
    }

    const sqliteNormalTestPath = path.join(sqliteProdTmpDir, 'normal_test.db');
    const sqliteNormalTest = new SqliteStorageRepository(sqliteNormalTestPath, {
      ...process.env,
      NODE_ENV: 'test',
      PAYMENT_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_placeholder_000000',
    });
    try {
      const testUsers = await sqliteNormalTest.users.listUsers();
      assert.strictEqual(testUsers.length, 3, 'A2.6 Normal test environment preserves 3 seeded test fixtures');
    } finally {
      await sqliteNormalTest.close();
    }

    // 5. policyIntelligence test-fixture bypass is blocked when live payment activates prod mode even under NODE_ENV=test
    process.env.NODE_ENV = 'test';
    process.env.PAYMENT_MODE = 'live';
    process.env.STRIPE_SECRET_KEY = 'sk_live_test_placeholder_000000';
    assert.throws(
      () =>
        policyIntelligenceEngine.generateComparisonForLegacyTestFixture(
          { scanId: 'o', overallScore: 10, domainBreakdown: {} } as any,
          { scanId: 'r', overallScore: 10, domainBreakdown: {} } as any
        ),
      /forbidden in production/i,
      'A2.7 policyIntelligence legacy test fixture helper blocked when PAYMENT_MODE=live even if NODE_ENV=test'
    );
    restoreEnv(initialEnv);

    // =========================================================================
    // GROUP A3: Whisper Compatibility Verification Enforcement
    // =========================================================================
    console.log('\n[Group A3: Whisper Compatibility Verification Predicate & Execution]');

    assert.strictEqual(
      shouldEnforceWhisperCompatibility(
        { modelConfigured: true },
        { NODE_ENV: 'production' }
      ),
      true,
      'A3.1 Normal production enforces Whisper compatibility verification'
    );
    assert.strictEqual(
      shouldEnforceWhisperCompatibility(
        { modelConfigured: true },
        {
          NODE_ENV: 'development',
          PAYMENT_MODE: 'live',
          STRIPE_SECRET_KEY: 'sk_live_test_placeholder_000000',
        }
      ),
      true,
      'A3.2 NODE_ENV=development + PAYMENT_MODE=live enforces Whisper compatibility verification'
    );
    assert.strictEqual(
      shouldEnforceWhisperCompatibility(
        { modelConfigured: false },
        {
          NODE_ENV: 'development',
          STRIPE_SECRET_KEY: 'sk_live_test_placeholder_000000',
        }
      ),
      true,
      'A3.3 NODE_ENV=development + sk_live_ key enforces Whisper compatibility verification'
    );
    assert.strictEqual(
      shouldEnforceWhisperCompatibility(
        { modelConfigured: true },
        { NODE_ENV: 'development', PAYMENT_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_placeholder_000000' }
      ),
      false,
      'A3.4 Normal development without fixture or flag does not force compatibility check'
    );
    assert.strictEqual(
      shouldEnforceWhisperCompatibility(
        { modelConfigured: true },
        { NODE_ENV: 'test' }
      ),
      false,
      'A3.5 Test environment without fixture or flag does not force compatibility check'
    );
    assert.strictEqual(
      shouldEnforceWhisperCompatibility(
        { modelConfigured: false },
        { NODE_ENV: 'test', WHISPER_VERIFY_COMPATIBILITY: 'true' }
      ),
      true,
      'A3.6 Explicit WHISPER_VERIFY_COMPATIBILITY=true enforces compatibility in test env'
    );
    assert.strictEqual(
      shouldEnforceWhisperCompatibility(
        { modelConfigured: true },
        { NODE_ENV: 'production', WHISPER_VERIFY_COMPATIBILITY: 'false' }
      ),
      false,
      'A3.7 Explicit WHISPER_VERIFY_COMPATIBILITY=false remains respected'
    );

    // Local stub Whisper binary/model execution check (zero network, no downloads)
    const whisperTmpDir = makeTempDir('vr_a3_whisper_');
    tempDirs.push(whisperTmpDir);
    const stubBinPath = path.join(whisperTmpDir, 'whisper-cli');
    fs.writeFileSync(
      stubBinPath,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'if (args.includes("--help") || args.includes("-h")) {',
        '  console.log("usage: whisper-cli -m MODEL -f FILE --output-json -of PREFIX");',
        '  process.exit(0);',
        '}',
        'console.log(JSON.stringify({ text: "local stub speech", transcription: [{ timestamps: { from: "00:00:00,000", to: "00:00:01,500" }, text: "local stub speech" }] }));',
      ].join('\n'),
      'utf8'
    );
    fs.chmodSync(stubBinPath, 0o755);

    const stubModelPath = path.join(whisperTmpDir, 'ggml-tiny.bin');
    // Minimal ggml header + padding (>= 64 bytes)
    const modelHeader = Buffer.alloc(128);
    modelHeader.write('lmgg', 0, 'ascii');
    fs.writeFileSync(stubModelPath, modelHeader);

    const dummyWavPath = path.join(whisperTmpDir, 'sample.wav');
    fs.writeFileSync(dummyWavPath, Buffer.alloc(64));

    process.env.WHISPER_PATH = stubBinPath;
    process.env.WHISPER_MODEL_PATH = stubModelPath;
    delete process.env.WHISPER_COMPAT_AUDIO_PATH;
    delete process.env.WHISPER_VERIFY_COMPATIBILITY;

    const adapter = new SpeechTranscriptionAdapter();

    // Under NODE_ENV=development + PAYMENT_MODE=live, missing compat fixture MUST fail closed with SPEECH_FIXTURE_NOT_FOUND
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_MODE = 'live';
    process.env.STRIPE_SECRET_KEY = 'sk_live_test_placeholder_000000';
    adapter.clearCompatibilityCache();
    const liveDevTx = await adapter.transcribe(dummyWavPath, 2);
    assert.strictEqual(liveDevTx.status, 'ANALYSIS_UNAVAILABLE', 'A3.8a transcribe() fails closed under dev+live payment when compat fixture is absent');
    assert.strictEqual(liveDevTx.diagnosticCode, 'SPEECH_FIXTURE_NOT_FOUND', 'A3.8b diagnosticCode confirms compatibility verification ran under dev+live payment');

    // Under NODE_ENV=production, missing compat fixture MUST fail closed identically
    process.env.NODE_ENV = 'production';
    delete process.env.PAYMENT_MODE;
    delete process.env.STRIPE_SECRET_KEY;
    adapter.clearCompatibilityCache();
    const prodTx = await adapter.transcribe(dummyWavPath, 2);
    assert.strictEqual(prodTx.status, 'ANALYSIS_UNAVAILABLE', 'A3.9a transcribe() fails closed under NODE_ENV=production when compat fixture is absent');
    assert.strictEqual(prodTx.diagnosticCode, 'SPEECH_FIXTURE_NOT_FOUND', 'A3.9b diagnosticCode confirms compatibility verification ran under production');

    // Under normal NODE_ENV=development (and NODE_ENV=test), preflight-ready runtime proceeds without forcing missing fixture failure
    process.env.NODE_ENV = 'development';
    adapter.clearCompatibilityCache();
    const devTx = await adapter.transcribe(dummyWavPath, 2);
    assert.strictEqual(devTx.status, 'DETECTED', 'A3.10 Normal dev transcribe() preserves unblocked local execution');

    process.env.NODE_ENV = 'test';
    adapter.clearCompatibilityCache();
    const testTx = await adapter.transcribe(dummyWavPath, 2);
    assert.strictEqual(testTx.status, 'DETECTED', 'A3.11 Normal test transcribe() preserves unblocked local execution');

    restoreEnv(initialEnv);

    // =========================================================================
    // GROUP B: Eliminate Production Password Reset Token Disclosure
    // =========================================================================
    console.log('\n[Group B: Password Reset Token Disclosure Protection]');

    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(apiRouter);

    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const uniqueSuffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const testEmail = `sec_b_reset_${uniqueSuffix}@example.com`;
      const pass1 = 'InitialStrongPass123!';
      const pass2 = 'RotatedStrongPass456!';
      const pass3 = 'FinalStrongPass789!';
      const ipSeed = Math.floor(Math.random() * 150) + 20;
      const setupIp = `198.51.100.${ipSeed}`;

      const regRes = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': setupIp },
        body: JSON.stringify({ email: testEmail, password: pass1 }),
      });
      assert.strictEqual(regRes.status, 201, 'B.0 Test user registered for password reset matrix');
      const regJson = await regRes.json();
      const initialSessionToken = regJson.token as string;
      const userId = regJson.user.id as string;

      const callForgot = async (email: string, ip: string) => {
        const res = await fetch(`${baseUrl}/auth/forgot-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({ email }),
        });
        const rawText = await res.text();
        const json = JSON.parse(rawText);
        return { status: res.status, headers: res.headers, rawText, json };
      };

      const expectedNonEnumMsg =
        'If an account exists with that email address, password reset instructions have been generated.';

      // 1. Production (NODE_ENV=production), ENABLE_DEV_RESET_TOKEN unset -> NEVER exposed
      process.env.NODE_ENV = 'production';
      delete process.env.PAYMENT_MODE;
      delete process.env.STRIPE_SECRET_KEY;
      delete process.env.ENABLE_DEV_RESET_TOKEN;
      const prodUnsetReg = await callForgot(testEmail, `198.51.100.${ipSeed + 1}`);
      const prodUnsetUnk = await callForgot(`unknown_${uniqueSuffix}@example.com`, `198.51.100.${ipSeed + 1}`);
      assert.strictEqual(prodUnsetReg.status, 200, 'B.1a Prod (unset) returns 200');
      assert.strictEqual(prodUnsetReg.json.devToken, undefined, 'B.1b Prod (unset) NEVER returns devToken');
      assert.strictEqual(Object.keys(prodUnsetReg.json).sort().join(','), 'message,success', 'B.1c Prod (unset) returns only {success, message}');
      assert.strictEqual(prodUnsetReg.json.message, expectedNonEnumMsg, 'B.1d Prod registered msg matches non-enumerating message');
      assert.strictEqual(prodUnsetUnk.json.message, prodUnsetReg.json.message, 'B.1e Prod registered vs unknown email messages are identical');

      // 2. Production (NODE_ENV=production), ENABLE_DEV_RESET_TOKEN=true -> NEVER exposed
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_DEV_RESET_TOKEN = 'true';
      const prodOverride = await callForgot(testEmail, `198.51.100.${ipSeed + 2}`);
      assert.strictEqual(prodOverride.status, 200, 'B.2a Prod (ENABLE_DEV_RESET_TOKEN=true) returns 200');
      assert.strictEqual(prodOverride.json.devToken, undefined, 'B.2b ENABLE_DEV_RESET_TOKEN=true does NOT expose devToken in NODE_ENV=production');
      assert.strictEqual(Object.keys(prodOverride.json).sort().join(','), 'message,success', 'B.2c No alternate token fields exposed in response');

      // 3. Canonical Production via NODE_ENV=development + PAYMENT_MODE=live + sk_live + ENABLE_DEV_RESET_TOKEN=true -> NEVER exposed
      process.env.NODE_ENV = 'development';
      process.env.PAYMENT_MODE = 'live';
      process.env.STRIPE_SECRET_KEY = 'sk_live_test_placeholder_000000';
      process.env.ENABLE_DEV_RESET_TOKEN = 'true';
      const liveDevOverride = await callForgot(testEmail, `198.51.100.${ipSeed + 3}`);
      assert.strictEqual(liveDevOverride.status, 200, 'B.3a Dev+live payment returns 200');
      assert.strictEqual(
        liveDevOverride.json.devToken,
        undefined,
        'B.3b ENABLE_DEV_RESET_TOKEN=true does NOT expose devToken when PAYMENT_MODE=live + NODE_ENV=development'
      );

      // 4. Development (NODE_ENV=development, no live payment), ENABLE_DEV_RESET_TOKEN=true -> Allowed under dev policy
      process.env.NODE_ENV = 'development';
      delete process.env.PAYMENT_MODE;
      delete process.env.STRIPE_SECRET_KEY;
      process.env.ENABLE_DEV_RESET_TOKEN = 'true';
      const devAllowed = await callForgot(testEmail, `198.51.100.${ipSeed + 4}`);
      assert.strictEqual(devAllowed.status, 200, 'B.4a Development returns 200');
      assert.strictEqual(typeof devAllowed.json.devToken, 'string', 'B.4b Development exposes devToken under existing dev policy');
      assert.strictEqual(devAllowed.json.devToken.length, 64, 'B.4c Development devToken has expected 32-byte hex format');

      // Verify non-enumeration for unknown email even in development
      const devUnknown = await callForgot(`nonexistent_${uniqueSuffix}@example.com`, `198.51.100.${ipSeed + 4}`);
      assert.strictEqual(devUnknown.json.devToken, undefined, 'B.4d Unknown email never exposes devToken');

      // Complete password reset using devAllowed token, verify session revocation & single-use
      const devResetConfirm = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `198.51.100.${ipSeed + 4}` },
        body: JSON.stringify({ token: devAllowed.json.devToken, newPassword: pass2 }),
      });
      assert.strictEqual(devResetConfirm.status, 200, 'B.4e Development reset token completes /auth/reset-password');

      const oldSessCheck = await fetch(`${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${initialSessionToken}` },
      });
      assert.strictEqual(oldSessCheck.status, 401, 'B.4f Prior session revoked after password reset');

      const reuseRes = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `198.51.100.${ipSeed + 4}` },
        body: JSON.stringify({ token: devAllowed.json.devToken, newPassword: pass3 }),
      });
      assert.strictEqual(reuseRes.status, 400, 'B.4g Reusing already-used reset token fails with 400');

      // 5. Test (NODE_ENV=test), ENABLE_DEV_RESET_TOKEN=true -> Allowed under test policy
      process.env.NODE_ENV = 'test';
      delete process.env.PAYMENT_MODE;
      delete process.env.STRIPE_SECRET_KEY;
      process.env.ENABLE_DEV_RESET_TOKEN = 'true';
      const testAllowed = await callForgot(testEmail, `198.51.100.${ipSeed + 5}`);
      assert.strictEqual(testAllowed.status, 200, 'B.5a Test env returns 200');
      assert.strictEqual(typeof testAllowed.json.devToken, 'string', 'B.5b Test env exposes devToken under existing test policy');

      const testResetConfirm = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `198.51.100.${ipSeed + 5}` },
        body: JSON.stringify({ token: testAllowed.json.devToken, newPassword: pass3 }),
      });
      assert.strictEqual(testResetConfirm.status, 200, 'B.5c Test reset token completes /auth/reset-password');

      // Verify login with pass3 works, pass2 rejected
      const badLogin = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `198.51.100.${ipSeed + 6}` },
        body: JSON.stringify({ email: testEmail, password: pass2 }),
      });
      assert.strictEqual(badLogin.status, 401, 'B.5d Old password rejected after reset');

      const goodLogin = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `198.51.100.${ipSeed + 6}` },
        body: JSON.stringify({ email: testEmail, password: pass3 }),
      });
      assert.strictEqual(goodLogin.status, 200, 'B.5e New password succeeds authentication');

      // 6. Expired token & invalid token rejection
      const expiredRawToken = crypto.randomBytes(32).toString('hex');
      const expiredTokenHash = crypto.createHash('sha256').update(expiredRawToken).digest('hex');
      await storage.passwordReset.createResetToken(
        userId,
        expiredTokenHash,
        new Date(Date.now() - 60_000).toISOString()
      );
      const expiredRes = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `198.51.100.${ipSeed + 7}` },
        body: JSON.stringify({ token: expiredRawToken, newPassword: 'AnotherValidPass1!' }),
      });
      assert.strictEqual(expiredRes.status, 400, 'B.6a Expired password reset token rejected with 400');

      const invalidRes = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `198.51.100.${ipSeed + 7}` },
        body: JSON.stringify({ token: 'fabricated_invalid_reset_token', newPassword: 'AnotherValidPass1!' }),
      });
      assert.strictEqual(invalidRes.status, 400, 'B.6b Invalid password reset token rejected with 400');

      // 7. Rate limiting enforced on /auth/forgot-password even in Production Mode
      process.env.NODE_ENV = 'production';
      const rlIp = `203.0.113.${ipSeed}`;
      await storage.rateLimits.clearRateLimits?.({ key: rlIp });
      const rlStatuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await callForgot(testEmail, rlIp);
        rlStatuses.push(r.status);
      }
      assert(rlStatuses.slice(0, 5).every((s) => s === 200), 'B.7a First 5 forgot-password requests succeed');
      assert.strictEqual(rlStatuses[5], 429, 'B.7b 6th forgot-password request throttled with 429');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      restoreEnv(initialEnv);
    }

    console.log('\n======================================================');
    console.log('✅ ALL GROUP A & B SECURITY REMEDIATION TESTS PASSED!');
    console.log('======================================================');
  } finally {
    restoreEnv(initialEnv);
    for (const dir of tempDirs) {
      cleanupTempDir(dir);
    }
  }
}

if (process.argv[1]?.includes('security_remediation_group_ab.test.ts')) {
  runGroupABSecurityRemediationTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ GROUP A & B SECURITY REMEDIATION TEST FAILED:', err);
      process.exit(1);
    });
}
