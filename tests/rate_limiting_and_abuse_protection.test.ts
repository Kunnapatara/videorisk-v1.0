import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import type { Server } from 'http';
import { apiRouter, getClientIp } from '../src/server/routes/api';
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

  // Verify root storage and passwordReset delegations
  const rootAllowed = await storage.checkRateLimit(`test_root_${Date.now()}`, 'root_action', 1, 60);
  assert(rootAllowed === true, 'Root storage.checkRateLimit() interface is functional');

  const pwResetAllowed = await storage.passwordReset.checkRateLimit(`test_pw_${Date.now()}`, 'pw_action', 1, 60);
  assert(pwResetAllowed === true, 'storage.passwordReset.checkRateLimit() backward compatibility preserved');

  // ---------------------------------------------------------
  // 2. Express Server Setup with Trust Proxy Configuration
  // ---------------------------------------------------------
  console.log('\n[2. Express App Setup & Client IP Semantics]');

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
    // 3. Login Rate Limiting (Brute-Force Abuse Protection)
    // ---------------------------------------------------------
    console.log('\n[3. Login Brute-Force Rate Limiting]');

    const originalLoginLimit = process.env.AUTH_LOGIN_RATE_LIMIT;
    const originalLoginWindow = process.env.AUTH_LOGIN_RATE_WINDOW;
    process.env.AUTH_LOGIN_RATE_LIMIT = '3';
    process.env.AUTH_LOGIN_RATE_WINDOW = '60';

    const loginAttackerIp = `192.0.2.${Math.floor(Math.random() * 200) + 10}`;

    // Attempt 1-3 should proceed to credential check (and fail with 400/401)
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': loginAttackerIp },
        body: JSON.stringify({ email: 'target@videorisk.com', password: `wrong_${i}` })
      });
      assert(res.status === 401 || res.status === 400, `Login attempt ${i} reaches auth check (HTTP ${res.status})`);
    }

    // Attempt 4 from same IP must be rejected by rate limiter with HTTP 429
    const blockedLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': loginAttackerIp },
      body: JSON.stringify({ email: 'target@videorisk.com', password: 'wrong_password' })
    });
    assert(blockedLoginRes.status === 429, 'Attempt 4 triggers HTTP 429 Too Many Requests');
    const blockedLoginBody = await blockedLoginRes.json();
    assert(blockedLoginBody.error.includes('Too many login attempts'), 'Returns informative rate-limit message');

    // Attempt from a distinct IP must NOT be blocked
    const cleanIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;
    const cleanLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': cleanIp },
      body: JSON.stringify({ email: 'target@videorisk.com', password: 'wrong_password' })
    });
    assert(cleanLoginRes.status === 401, 'Unrelated client IP is NOT blocked (IP rate limit isolation verified)');

    // Restore login env vars
    if (originalLoginLimit !== undefined) process.env.AUTH_LOGIN_RATE_LIMIT = originalLoginLimit;
    else delete process.env.AUTH_LOGIN_RATE_LIMIT;
    if (originalLoginWindow !== undefined) process.env.AUTH_LOGIN_RATE_WINDOW = originalLoginWindow;
    else delete process.env.AUTH_LOGIN_RATE_WINDOW;

    // ---------------------------------------------------------
    // 4. Registration Rate Limiting (Account Spam Protection)
    // ---------------------------------------------------------
    console.log('\n[4. Registration Rate Limiting]');

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
    const blockedRegBody = await blockedRegRes.json();
    assert(blockedRegBody.error.includes('Too many registration attempts'), 'Returns informative registration rate-limit message');

    // Restore registration env vars
    if (originalRegLimit !== undefined) process.env.AUTH_REGISTER_RATE_LIMIT = originalRegLimit;
    else delete process.env.AUTH_REGISTER_RATE_LIMIT;
    if (originalRegWindow !== undefined) process.env.AUTH_REGISTER_RATE_WINDOW = originalRegWindow;
    else delete process.env.AUTH_REGISTER_RATE_WINDOW;

    // ---------------------------------------------------------
    // 5. Video Upload Rate Limiting & Storage Protection
    // ---------------------------------------------------------
    console.log('\n[5. Video Upload Rate Limiting & Server Storage Protection]');

    // Test 5.1: Unauthenticated request receives 401 before upload rate limiting runs
    const unauthRes = await fetch(`${baseUrl}/uploads`, {
      method: 'POST'
    });
    assert(unauthRes.status === 401, 'Unauthenticated POST /uploads returns 401 Unauthorized (requireAuthMiddleware runs first)');

    // Register a valid user for upload testing
    const uploaderEmail = `uploader_${Date.now()}@videorisk.com`;
    const uploaderReg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uploaderEmail, password: 'uploaderPassword123' })
    });
    const uploaderData = await uploaderReg.json();
    const uploaderToken = uploaderData.token;

    const originalUploadLimit = process.env.UPLOAD_RATE_LIMIT;
    const originalUploadWindow = process.env.UPLOAD_RATE_WINDOW;
    process.env.UPLOAD_RATE_LIMIT = '2';
    process.env.UPLOAD_RATE_WINDOW = '60';

    // Helper to count files in uploads directory
    const uploadsDir = path.resolve(process.cwd(), 'uploads');
    const getUploadsFileCount = () => {
      if (!fs.existsSync(uploadsDir)) return 0;
      return fs.readdirSync(uploadsDir).length;
    };

    // Helper to send multipart upload
    const sendMultipartUpload = async (token: string, filename: string, content: Buffer) => {
      const boundary = `----WebKitFormBoundary${crypto.randomBytes(8).toString('hex')}`;
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([header, content, footer]);

      return fetch(`${baseUrl}/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body
      });
    };

    const dummyMp4 = Buffer.from('fake mp4 video content for testing upload pipeline');

    // Upload 1: consumes 1 slot
    const upload1 = await sendMultipartUpload(uploaderToken, 'test_vid1.mp4', dummyMp4);
    assert(upload1.status === 200 || upload1.status === 400, `Upload 1 processed by pipeline (HTTP ${upload1.status})`);

    // Upload 2: consumes 2nd slot
    const upload2 = await sendMultipartUpload(uploaderToken, 'test_vid2.mp4', dummyMp4);
    assert(upload2.status === 200 || upload2.status === 400, `Upload 2 processed by pipeline (HTTP ${upload2.status})`);

    const filesBeforeBlockedUpload = getUploadsFileCount();

    // Upload 3: exceeds limit of 2 -> must return HTTP 429
    const upload3 = await sendMultipartUpload(uploaderToken, 'test_vid3.mp4', dummyMp4);
    assert(upload3.status === 429, 'Upload 3 rejected with HTTP 429 Too Many Requests');
    const upload3Body = await upload3.json();
    assert(upload3Body.error.includes('Upload rate limit exceeded'), 'Upload rate limit error message verified');

    // Verify Multer did NOT write file to disk on 429
    const filesAfterBlockedUpload = getUploadsFileCount();
    assert(
      filesAfterBlockedUpload === filesBeforeBlockedUpload,
      `Multer did NOT write file to disk on 429 (file count unchanged: ${filesBeforeBlockedUpload} -> ${filesAfterBlockedUpload})`
    );

    // Restore upload env vars
    if (originalUploadLimit !== undefined) process.env.UPLOAD_RATE_LIMIT = originalUploadLimit;
    else delete process.env.UPLOAD_RATE_LIMIT;
    if (originalUploadWindow !== undefined) process.env.UPLOAD_RATE_WINDOW = originalUploadWindow;
    else delete process.env.UPLOAD_RATE_WINDOW;

    // ---------------------------------------------------------
    // 6. Untrusted X-Forwarded-For Protection (Proxy Security)
    // ---------------------------------------------------------
    console.log('\n[6. Untrusted Proxy Protection & Client IP Semantics]');

    // Create an un-proxied app without trust proxy
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

    console.log('======================================================');
    console.log('TEST SUITE 12 COMPLETE: All Rate Limiting & Abuse Protection assertions passed!');
    console.log('======================================================');
  } finally {
    server.close();
  }
}
