import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import type { Server } from 'http';
import { apiRouter, getClientIp, parsePositiveInt, configureTrustProxy } from '../src/server/routes/api';
import { storage } from '../src/server/storage';

function assert(condition: boolean, desc: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${desc}`);
  } else {
    console.error(`  ❌ FAIL: ${desc}`);
    throw new Error(`Test assertion failed: ${desc}`);
  }
}

export async function runRateLimitingAndAbuseProtectionTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 12: ROUTE-LEVEL RATE LIMITING & ABUSE PROTECTION ---');
  console.log('======================================================\n');

  // ---------------------------------------------------------
  // 1. Storage Concurrency & Atomic Quota Protection
  // ---------------------------------------------------------
  console.log('[1. Storage Concurrency & Atomic Quota Protection]');

  const testKey = `concurrent_test_${Date.now()}`;
  const action = 'burst_attempt';
  const limit = 5;
  const windowSec = 60;

  // Fire 15 simultaneous requests across async promises
  const burstPromises = Array.from({ length: 15 }, () =>
    storage.rateLimits.checkRateLimit(testKey, action, limit, windowSec)
  );

  const results = await Promise.all(burstPromises);
  const allowedCount = results.filter(r => r === true).length;
  const blockedCount = results.filter(r => r === false).length;

  assert(allowedCount === limit, `Exactly ${limit} simultaneous requests allowed under concurrency (got ${allowedCount})`);
  assert(blockedCount === 10, `Remaining 10 concurrent requests cleanly rejected (got ${blockedCount})`);

  // Verify consumeRateLimit interface returns accurate counts and retryAfter
  const consumeBlocked = await storage.rateLimits.consumeRateLimit(testKey, action, limit, windowSec);
  assert(consumeBlocked.allowed === false, 'consumeRateLimit reports allowed: false when quota exhausted');
  assert(consumeBlocked.retryAfter > 0 && consumeBlocked.retryAfter <= windowSec, `Valid retryAfter computed (${consumeBlocked.retryAfter}s)`);

  // Verify root storage and passwordReset delegations
  const rootAllowed = await storage.checkRateLimit(`test_root_${Date.now()}`, 'root_action', 1, 60);
  assert(rootAllowed === true, 'Root storage.checkRateLimit() interface is functional');

  const pwResetAllowed = await storage.passwordReset.checkRateLimit(`test_pw_${Date.now()}`, 'pw_action', 1, 60);
  assert(pwResetAllowed === true, 'storage.passwordReset.checkRateLimit() backward compatibility preserved');

  // ---------------------------------------------------------
  // 2. Test Data Isolation & Targeted Cleanup Protection
  // ---------------------------------------------------------
  console.log('\n[2. Test Data Isolation & Targeted Cleanup Protection]');

  // Insert a mock production rate-limit record that should NEVER be wiped by tests
  const prodRecordKey = `prod_customer_${Date.now()}`;
  await storage.rateLimits.checkRateLimit(prodRecordKey, 'customer_action', 10, 3600);

  // Run test-scoped cleanup
  await storage.rateLimits.clearRateLimits?.({ keyPrefix: 'test_' });

  // Verify the unrelated production record is still intact
  const prodCheck = await storage.rateLimits.consumeRateLimit(prodRecordKey, 'customer_action', 10, 3600);
  assert(prodCheck.count === 2, 'Unrelated/production rate-limit record was NOT erased by test cleanup');

  // Verify production safety gate: unconstrained clear in production environment throws error
  const origNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    let threw = false;
    try {
      await storage.rateLimits.clearRateLimits?.();
    } catch {
      threw = true;
    }
    assert(threw === true, 'Unscoped clearRateLimits() is strictly rejected in production environment');
  } finally {
    process.env.NODE_ENV = origNodeEnv;
  }

  // ---------------------------------------------------------
  // 3. Environment Variable Parsing Safety
  // ---------------------------------------------------------
  console.log('\n[3. Environment Variable Parsing Safety]');

  assert(parsePositiveInt('15', 10) === 15, 'Valid string parsed as positive integer');
  assert(parsePositiveInt(undefined, 10) === 10, 'Undefined falls back to safe default');
  assert(parsePositiveInt('invalid', 10) === 10, 'NaN string falls back to safe default');
  assert(parsePositiveInt('-5', 10) === 10, 'Negative integer falls back to safe default');
  assert(parsePositiveInt('0', 10) === 10, 'Zero integer falls back to safe default (cannot disable limits)');

  // ---------------------------------------------------------
  // 4. Express App Setup with Trust Proxy Configuration
  // ---------------------------------------------------------
  console.log('\n[4. Express App Setup & Trusted Proxy Validation]');

  // Test configureTrustProxy utility
  const proxyTestApp1 = express();
  configureTrustProxy(proxyTestApp1, undefined);
  assert(proxyTestApp1.get('trust proxy') === false, 'Default TRUST_PROXY is false');

  const proxyTestApp2 = express();
  configureTrustProxy(proxyTestApp2, '1');
  assert(proxyTestApp2.get('trust proxy') === 1, 'TRUST_PROXY=1 configures 1 hop');

  const proxyTestApp3 = express();
  configureTrustProxy(proxyTestApp3, 'malformed-value-xyz');
  assert(proxyTestApp3.get('trust proxy') === false, 'Malformed TRUST_PROXY fails safe to false');

  const app = express();
  app.set('trust proxy', true); // Trust proxy enabled in test harness to evaluate simulated client IPs
  app.use(express.json());
  app.use('/api', apiRouter);

  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // ---------------------------------------------------------
    // 5. Login Rate Limiting (IP-Based Brute-Force Protection)
    // ---------------------------------------------------------
    console.log('\n[5. Login IP-Based Brute-Force Protection]');

    const originalLoginLimit = process.env.AUTH_LOGIN_RATE_LIMIT;
    const originalLoginWindow = process.env.AUTH_LOGIN_RATE_WINDOW;
    process.env.AUTH_LOGIN_RATE_LIMIT = '3';
    process.env.AUTH_LOGIN_RATE_WINDOW = '60';

    const loginAttackerIp = `192.0.2.${Math.floor(Math.random() * 200) + 10}`;

    // Attempt 1-3 from attacker IP
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': loginAttackerIp },
        body: JSON.stringify({ email: `target_${Date.now()}_${i}@videorisk.com`, password: `wrong_${i}` })
      });
      assert(res.status === 401 || res.status === 400, `Login attempt ${i} reaches auth check (HTTP ${res.status})`);
    }

    // Attempt 4 from same IP must be rejected with HTTP 429 and Retry-After header
    const blockedLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': loginAttackerIp },
      body: JSON.stringify({ email: `target_${Date.now()}_4@videorisk.com`, password: 'wrong_password' })
    });
    assert(blockedLoginRes.status === 429, 'Attempt 4 triggers HTTP 429 Too Many Requests');
    const retryAfterIp = blockedLoginRes.headers.get('Retry-After');
    assert(!!retryAfterIp && parseInt(retryAfterIp, 10) > 0, `Retry-After header present and positive (${retryAfterIp}s)`);
    const blockedLoginBody = await blockedLoginRes.json();
    assert(blockedLoginBody.error.includes('Too many login attempts'), 'Returns informative rate-limit message');

    // Attempt from a distinct IP must NOT be blocked
    const cleanIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;
    const cleanLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': cleanIp },
      body: JSON.stringify({ email: `other_${Date.now()}@videorisk.com`, password: 'wrong_password' })
    });
    assert(cleanLoginRes.status === 401, 'Unrelated client IP is NOT blocked (IP rate limit isolation verified)');

    // Restore login env vars
    if (originalLoginLimit !== undefined) process.env.AUTH_LOGIN_RATE_LIMIT = originalLoginLimit;
    else delete process.env.AUTH_LOGIN_RATE_LIMIT;
    if (originalLoginWindow !== undefined) process.env.AUTH_LOGIN_RATE_WINDOW = originalLoginWindow;
    else delete process.env.AUTH_LOGIN_RATE_WINDOW;

    // ---------------------------------------------------------
    // 6. Login Rate Limiting (Account Identifier Distributed Protection)
    // ---------------------------------------------------------
    console.log('\n[6. Login Account Identifier Distributed Protection]');

    const originalAcctLimit = process.env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT;
    const originalAcctWindow = process.env.AUTH_LOGIN_ACCOUNT_RATE_WINDOW;
    process.env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT = '2';
    process.env.AUTH_LOGIN_ACCOUNT_RATE_WINDOW = '60';

    const targetAccount = `victim_${Date.now()}@videorisk.com`;

    // Attempt 1: from IP 1
    const ip1 = `192.0.2.11`;
    const res1 = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip1 },
      body: JSON.stringify({ email: targetAccount, password: 'wrong_password_1' })
    });
    assert(res1.status === 401, 'Account attack from IP 1 reaches auth check (HTTP 401)');

    // Attempt 2: from IP 2 (different IP targeting same account, uppercase/padded email to test normalization)
    const ip2 = `192.0.2.22`;
    const res2 = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip2 },
      body: JSON.stringify({ email: `  ${targetAccount.toUpperCase()}  `, password: 'wrong_password_2' })
    });
    assert(res2.status === 401, 'Normalized account attack from IP 2 reaches auth check (HTTP 401)');

    // Attempt 3: from IP 3 (different IP targeting same account -> should be blocked by account quota of 2)
    const ip3 = `192.0.2.33`;
    const res3 = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip3 },
      body: JSON.stringify({ email: targetAccount, password: 'wrong_password_3' })
    });
    assert(res3.status === 429, 'Distributed attack from IP 3 blocked by account quota with HTTP 429');
    const retryAfterAcct = res3.headers.get('Retry-After');
    assert(!!retryAfterAcct && parseInt(retryAfterAcct, 10) > 0, `Account block includes valid Retry-After (${retryAfterAcct}s)`);

    // Independent account from IP 3 must NOT be blocked (account limit isolation)
    const resDifferentAcct = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip3 },
      body: JSON.stringify({ email: `independent_${Date.now()}@videorisk.com`, password: 'wrong_password' })
    });
    assert(resDifferentAcct.status === 401, 'Different account from IP 3 is NOT blocked by victim account limit');

    // Restore account env vars
    if (originalAcctLimit !== undefined) process.env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT = originalAcctLimit;
    else delete process.env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT;
    if (originalAcctWindow !== undefined) process.env.AUTH_LOGIN_ACCOUNT_RATE_WINDOW = originalAcctWindow;
    else delete process.env.AUTH_LOGIN_ACCOUNT_RATE_WINDOW;

    // ---------------------------------------------------------
    // 7. Malformed Request & Generic Credential Security
    // ---------------------------------------------------------
    console.log('\n[7. Malformed Request & Generic Credential Security]');

    const malformedRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 12345 }) // malformed payload
    });
    assert(malformedRes.status === 400, 'Malformed login request returns HTTP 400 Bad Request');

    const unknownAccountRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `nonexistent_${Date.now()}@videorisk.com`, password: 'anyPassword123' })
    });
    const unknownBody = await unknownAccountRes.json();
    assert(unknownAccountRes.status === 401, 'Non-existent account returns generic 401 Unauthorized');
    assert(unknownBody.error === 'Invalid email or password.', 'Generic error does not reveal account existence');

    // ---------------------------------------------------------
    // 8. Registration Rate Limiting & Retry-After
    // ---------------------------------------------------------
    console.log('\n[8. Registration Rate Limiting & Retry-After]');

    const originalRegLimit = process.env.AUTH_REGISTER_RATE_LIMIT;
    const originalRegWindow = process.env.AUTH_REGISTER_RATE_WINDOW;
    process.env.AUTH_REGISTER_RATE_LIMIT = '2';
    process.env.AUTH_REGISTER_RATE_WINDOW = '60';

    const regSpammerIp = `203.0.113.${Math.floor(Math.random() * 200) + 10}`;

    // Registration 1 & 2 succeed
    for (let i = 1; i <= 2; i++) {
      const regRes = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': regSpammerIp },
        body: JSON.stringify({ email: `spammer_${Date.now()}_${i}@videorisk.com`, password: 'strongPassword123' })
      });
      assert(regRes.status === 201, `Registration ${i} succeeded with 201 Created`);
    }

    // Registration 3 from same IP must be rate-limited
    const blockedRegRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': regSpammerIp },
      body: JSON.stringify({ email: `spammer_blocked_${Date.now()}@videorisk.com`, password: 'strongPassword123' })
    });
    assert(blockedRegRes.status === 429, 'Registration 3 blocked with HTTP 429 Too Many Requests');
    const retryAfterReg = blockedRegRes.headers.get('Retry-After');
    assert(!!retryAfterReg && parseInt(retryAfterReg, 10) > 0, `Registration block returns valid Retry-After (${retryAfterReg}s)`);
    const blockedRegBody = await blockedRegRes.json();
    assert(blockedRegBody.error.includes('Too many registration attempts'), 'Returns informative registration rate-limit message');

    // Restore registration env vars
    if (originalRegLimit !== undefined) process.env.AUTH_REGISTER_RATE_LIMIT = originalRegLimit;
    else delete process.env.AUTH_REGISTER_RATE_LIMIT;
    if (originalRegWindow !== undefined) process.env.AUTH_REGISTER_RATE_WINDOW = originalRegWindow;
    else delete process.env.AUTH_REGISTER_RATE_WINDOW;

    // ---------------------------------------------------------
    // 9. Video Upload Rate Limiting (User Quota & Separate IP Quota)
    // ---------------------------------------------------------
    console.log('\n[9. Video Upload Rate Limiting (User & IP Quotas)]');

    // Test 9.1: Unauthenticated request receives 401 before upload rate limiting runs
    const unauthRes = await fetch(`${baseUrl}/uploads`, {
      method: 'POST'
    });
    assert(unauthRes.status === 401, 'Unauthenticated POST /uploads returns 401 Unauthorized (requireAuthMiddleware runs first)');

    // Register User 1
    const uploader1Email = `uploader1_${Date.now()}@videorisk.com`;
    const uploader1Reg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uploader1Email, password: 'uploaderPassword123' })
    });
    const uploader1Token = (await uploader1Reg.json()).token;

    // Helper to count files in uploads directory
    const uploadsDir = path.resolve(process.cwd(), 'uploads');
    const getUploadsFileCount = () => {
      if (!fs.existsSync(uploadsDir)) return 0;
      return fs.readdirSync(uploadsDir).length;
    };

    // Helper to send multipart upload
    const sendMultipartUpload = async (token: string, filename: string, content: Buffer, ip?: string) => {
      const boundary = `----WebKitFormBoundary${crypto.randomBytes(8).toString('hex')}`;
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([header, content, footer]);

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      };
      if (ip) headers['x-forwarded-for'] = ip;

      return fetch(`${baseUrl}/uploads`, {
        method: 'POST',
        headers,
        body
      });
    };

    const dummyMp4 = Buffer.from('fake mp4 video content for testing upload pipeline');

    // Test User Upload Quota
    const originalUploadLimit = process.env.UPLOAD_RATE_LIMIT;
    const originalUploadWindow = process.env.UPLOAD_RATE_WINDOW;
    process.env.UPLOAD_RATE_LIMIT = '2';
    process.env.UPLOAD_RATE_WINDOW = '60';

    const uploadIp1 = `198.51.100.77`;

    // Upload 1 & 2 succeed/reach pipeline
    const up1 = await sendMultipartUpload(uploader1Token, 'test_vid1.mp4', dummyMp4, uploadIp1);
    assert(up1.status === 200 || up1.status === 400, `User upload 1 processed (HTTP ${up1.status})`);

    const up2 = await sendMultipartUpload(uploader1Token, 'test_vid2.mp4', dummyMp4, uploadIp1);
    assert(up2.status === 200 || up2.status === 400, `User upload 2 processed (HTTP ${up2.status})`);

    const filesBeforeBlockedUpload = getUploadsFileCount();

    // Upload 3 exceeds User quota -> HTTP 429 with Retry-After
    const up3 = await sendMultipartUpload(uploader1Token, 'test_vid3.mp4', dummyMp4, uploadIp1);
    assert(up3.status === 429, 'User upload 3 rejected with HTTP 429 Too Many Requests');
    const retryAfterUp = up3.headers.get('Retry-After');
    assert(!!retryAfterUp && parseInt(retryAfterUp, 10) > 0, `Upload 429 returns Retry-After header (${retryAfterUp}s)`);
    const up3Body = await up3.json();
    assert(up3Body.error.includes('Upload rate limit exceeded'), 'Upload error message verified');

    // Verify Multer did NOT write file to disk on 429
    const filesAfterBlockedUpload = getUploadsFileCount();
    assert(
      filesAfterBlockedUpload === filesBeforeBlockedUpload,
      `Multer did NOT write file to disk on 429 (file count unchanged: ${filesBeforeBlockedUpload})`
    );

    // Test Separate IP Upload Quota (prevents multi-account sybil attacks from same IP)
    const originalUploadIpLimit = process.env.UPLOAD_IP_RATE_LIMIT;
    process.env.UPLOAD_IP_RATE_LIMIT = '2';

    // Register User 2 on the same IP
    const uploader2Email = `uploader2_${Date.now()}@videorisk.com`;
    const uploader2Reg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uploader2Email, password: 'uploaderPassword123' })
    });
    const uploader2Token = (await uploader2Reg.json()).token;

    // User 2 tries to upload from uploadIp1 (which already consumed 2 slots from User 1)
    const upUser2 = await sendMultipartUpload(uploader2Token, 'test_vid_sybil.mp4', dummyMp4, uploadIp1);
    assert(upUser2.status === 429, 'Separate IP upload quota blocks 2nd account from same exhausted IP (HTTP 429)');
    const upUser2Body = await upUser2.json();
    assert(upUser2Body.error.includes('Upload rate limit exceeded'), 'IP upload rate limit message verified');

    // Restore upload env vars
    if (originalUploadLimit !== undefined) process.env.UPLOAD_RATE_LIMIT = originalUploadLimit;
    else delete process.env.UPLOAD_RATE_LIMIT;
    if (originalUploadWindow !== undefined) process.env.UPLOAD_RATE_WINDOW = originalUploadWindow;
    else delete process.env.UPLOAD_RATE_WINDOW;
    if (originalUploadIpLimit !== undefined) process.env.UPLOAD_IP_RATE_LIMIT = originalUploadIpLimit;
    else delete process.env.UPLOAD_IP_RATE_LIMIT;

    // ---------------------------------------------------------
    // 10. Untrusted X-Forwarded-For Protection (Proxy Security)
    // ---------------------------------------------------------
    console.log('\n[10. Untrusted Proxy Protection & Client IP Semantics]');

    // Create an un-proxied app with trust proxy: false
    const untrustedApp = express();
    untrustedApp.set('trust proxy', false);
    untrustedApp.use('/test-ip', (req, res) => {
      res.json({ ip: getClientIp(req) });
    });
    const untrustedServer: Server = await new Promise(resolve => {
      const s = untrustedApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const untrustedPort = (untrustedServer.address() as any).port;

    try {
      // Send spoofed X-Forwarded-For
      const spoofedRes = await fetch(`http://127.0.0.1:${untrustedPort}/test-ip`, {
        headers: { 'x-forwarded-for': '203.0.113.199' }
      });
      const spoofedData = await spoofedRes.json();
      assert(
        spoofedData.ip !== '203.0.113.199',
        `Arbitrary X-Forwarded-For is NOT trusted when trust proxy is disabled (got ${spoofedData.ip}, not spoofed IP)`
      );
    } finally {
      untrustedServer.close();
    }

    console.log('\n======================================================');
    console.log('TEST SUITE 12 COMPLETE: All Rate Limiting & Abuse Protection assertions passed!');
    console.log('======================================================');
  } finally {
    server.close();
  }
}
