import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import express from 'express';
import { Server } from 'http';
import { apiRouter } from '../src/server/routes/api';
import { storage } from '../src/server/storage';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✅ PASS: ${message}`);
}

export async function runPasswordRecoveryTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 8: SECURE PASSWORD RECOVERY ---');
  console.log('======================================================');

  // Set up ephemeral express app for API testing
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(apiRouter);

  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Isolate client IP for test run so shared database rate limits don't interfere
    const testClientIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;

    // ---------------------------------------------------------
    // 1. Setup Test User Account
    // ---------------------------------------------------------
    console.log('\n[1. Account Setup & Initial Session]');
    const testEmail = `recovery_test_${Date.now()}@videorisk.com`;
    const initialPassword = 'initialPassword123';

    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': testClientIp },
      body: JSON.stringify({ email: testEmail, password: initialPassword })
    });
    assert(regRes.status === 201, 'Test user registered successfully');
    const regData = await regRes.json();
    const activeSessionToken = regData.token;

    // Verify session works
    const meResBefore = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${activeSessionToken}`, 'x-forwarded-for': testClientIp }
    });
    assert(meResBefore.status === 200, 'Initial session token is valid and authenticated');

    // ---------------------------------------------------------
    // 2. Non-Enumerating Password Reset Request
    // ---------------------------------------------------------
    console.log('\n[2. Non-Enumerating Reset Requests]');
    // Unknown email
    const unknownEmailRes = await fetch(`${baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': testClientIp },
      body: JSON.stringify({ email: 'nonexistent_user@videorisk.com' })
    });
    assert(unknownEmailRes.status === 200, 'Unknown email request returns 200 OK (Non-enumerating)');
    const unknownData = await unknownEmailRes.json();
    assert(
      unknownData.message === 'If an account exists with that email address, password reset instructions have been generated.',
      'Message does not reveal whether the email exists'
    );
    assert(!unknownData.devResetToken, 'No reset token generated for non-existent email');
    assert(!unknownData.devToken, 'Legacy devToken field absent for non-existent email');

    // Registered email
    const validResetRes = await fetch(`${baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': testClientIp },
      body: JSON.stringify({ email: testEmail })
    });
    assert(validResetRes.status === 200, 'Registered email request returns 200 OK');
    const validResetData = await validResetRes.json();
    assert(
      validResetData.message === 'If an account exists with that email address, password reset instructions have been generated.',
      'Registered email returns identical non-enumerating message'
    );
    assert(validResetData.devToken === undefined, 'Legacy devToken field removed in favor of devResetToken');
    assert(typeof validResetData.devResetToken === 'string', 'Development testing token provided via devResetToken in test environment');
    const resetToken = validResetData.devResetToken;

    // Verify token hash was stored, NOT the raw token
    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const storedReset = await storage.passwordReset.getResetToken(tokenHash);
    assert(storedReset !== null, 'Reset record retrieved via token hash');
    assert(storedReset?.usedAt === null, 'Token starts in un-used state');
    assert(new Date(storedReset!.expiresAt) > new Date(), 'Token expiration timestamp is in the future (~1h)');

    // ---------------------------------------------------------
    // 3. Confirm Password Reset & Session Invalidation
    // ---------------------------------------------------------
    console.log('\n[3. Token Verification, Password Update & Session Invalidation]');
    const newPassword = 'brandNewPassword999';

    // Attempt reset with invalid/tampered token
    const invalidTokenRes = await fetch(`${baseUrl}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': testClientIp },
      body: JSON.stringify({ token: 'completely_fabricated_token', newPassword })
    });
    assert(invalidTokenRes.status === 400, 'Invalid reset token rejected with 400 Bad Request');

    // Attempt reset with weak password (< 8 chars)
    const weakPassRes = await fetch(`${baseUrl}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': testClientIp },
      body: JSON.stringify({ token: resetToken, newPassword: 'short' })
    });
    assert(weakPassRes.status === 400, 'Password under 8 characters rejected with 400 Bad Request');

    // Successful password reset
    const successResetRes = await fetch(`${baseUrl}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': testClientIp },
      body: JSON.stringify({ token: resetToken, newPassword })
    });
    assert(successResetRes.status === 200, 'Valid reset token updates password successfully (200 OK)');

    // Verify single-use: token cannot be reused
    const reuseTokenRes = await fetch(`${baseUrl}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': testClientIp },
      body: JSON.stringify({ token: resetToken, newPassword: 'anotherPassword123' })
    });
    assert(reuseTokenRes.status === 400, 'Re-using the same reset token is rejected (Single-use enforcement)');

    // Verify previous session was revoked
    const meResAfter = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${activeSessionToken}`, 'x-forwarded-for': testClientIp }
    });
    assert(meResAfter.status === 401, 'Previous active session token revoked upon password reset');

    // Verify old password no longer works
    const oldLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': testClientIp },
      body: JSON.stringify({ email: testEmail, password: initialPassword })
    });
    assert(oldLoginRes.status === 401, 'Old password fails authentication');

    // Verify login with new password succeeds
    const newLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': testClientIp },
      body: JSON.stringify({ email: testEmail, password: newPassword })
    });
    assert(newLoginRes.status === 200, 'Sign in with new password succeeds (200 OK)');
    const newLoginData = await newLoginRes.json();
    assert(typeof newLoginData.token === 'string', 'Received new active session token');

    // ---------------------------------------------------------
    // 4. Rate Limiting Enforcement
    // ---------------------------------------------------------
    console.log('\n[4. Rate Limiting Protection]');
    // Rate limit check: attempt 6 reset requests quickly from simulated client IP
    const limitPromises = [];
    for (let i = 0; i < 6; i++) {
      limitPromises.push(
        fetch(`${baseUrl}/auth/forgot-password`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-forwarded-for': '203.0.113.42'
          },
          body: JSON.stringify({ email: testEmail })
        })
      );
    }
    const limitResponses = await Promise.all(limitPromises);
    const hasRateLimited = limitResponses.some(r => r.status === 429);
    assert(hasRateLimited, 'Exceeding request threshold triggers 429 Too Many Requests');

    // ---------------------------------------------------------
    // 5. Standardized 8-Char Password Policy & Compatibility
    // ---------------------------------------------------------
    console.log('\n[5. Standardized Password Security Policy (8-Char Minimum)]');
    const policyIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;

    // 5.1 Registration rejects < 8 characters (6 and 7 chars)
    for (const shortPwd of ['abc123', 'seven77']) {
      const shortReg = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': policyIp },
        body: JSON.stringify({ email: `short_${Date.now()}_${shortPwd.length}@videorisk.com`, password: shortPwd })
      });
      assert(shortReg.status === 400, `Registration rejects ${shortPwd.length}-char password with 400`);
      const errBody = await shortReg.json();
      assert(errBody.error === 'Password must be at least 8 characters long.', 'Registration returns standardized 8-char policy error');
    }

    // 5.2 Registration accepts exactly 8 characters
    const exact8Email = `exact8_${Date.now()}@videorisk.com`;
    const okReg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': policyIp },
      body: JSON.stringify({ email: exact8Email, password: 'exact8ch' })
    });
    assert(okReg.status === 201, 'Registration accepts 8-character password (201)');

    // 5.3 Password reset enforces identical 8-character minimum
    const fpRes = await fetch(`${baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': policyIp },
      body: JSON.stringify({ email: exact8Email })
    });
    const fpData = await fpRes.json();
    const shortReset = await fetch(`${baseUrl}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': policyIp },
      body: JSON.stringify({ token: fpData.devResetToken, newPassword: 'seven77' })
    });
    assert(shortReset.status === 400, 'Reset password rejects 7-char password with 400');

    const okReset = await fetch(`${baseUrl}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': policyIp },
      body: JSON.stringify({ token: fpData.devResetToken, newPassword: 'new8char' })
    });
    assert(okReset.status === 200, 'Reset password accepts 8-char password (200)');

    // 5.4 Existing pre-policy account with shorter password hash remains usable via login
    const legacyEmail = `legacy_user_${Date.now()}@videorisk.com`;
    const legacySalt = crypto.randomBytes(16).toString('hex');
    const legacyPass = 'pro123'; // 6 chars pre-existing hash
    const legacyHash = crypto.scryptSync(legacyPass, legacySalt, 64).toString('hex');
    await storage.users.createUser(legacyEmail, legacyHash, legacySalt, 10, 'free');

    const legacyLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': policyIp },
      body: JSON.stringify({ email: legacyEmail, password: legacyPass })
    });
    assert(legacyLogin.status === 200, 'Existing pre-policy account remains able to sign in without forced reset');

    // 5.5 Frontend AuthModal & metadata capability accuracy assertions
    const authModalSource = fs.readFileSync(path.resolve(process.cwd(), 'src/components/AuthModal.tsx'), 'utf8');
    assert(authModalSource.includes('Password (min 8 characters)'), 'AuthModal register label matches 8-character policy');
    assert(!authModalSource.includes('minLength={6}'), 'AuthModal no longer uses minLength={6}');
    assert(authModalSource.includes('password.length < 8'), 'AuthModal enforces 8-character register check client-side');

    const metadataJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'metadata.json'), 'utf8'));
    assert(
      Array.isArray(metadataJson.majorCapabilities) &&
      !metadataJson.majorCapabilities.includes('MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API'),
      'metadata.json no longer advertises unimplemented Gemini server-side API capability'
    );

    console.log('======================================================');
    console.log('TEST SUITE 8 COMPLETE: All Password Recovery & Policy assertions passed!');
    console.log('======================================================');
  } finally {
    server.close();
  }
}
