import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import type { RiskReport } from '../src/types';
import { enforceTestDatabaseIsolation, verifyStorageTestDatabase } from '../src/server/storage/testIsolation';

process.env.VIDEORISK_TEST_RUN = 'true';
const testDbResolution = enforceTestDatabaseIsolation();

function makeDomainTestReport(scanId: string, riskSummary: string): RiskReport {
  return {
    scanId,
    overallRisk: 'LOW_RISK',
    riskSummary,
    disclaimer: 'Test disclaimer',
    domainReports: {
      video_audio: {
        domain: 'video_audio',
        domainLabel: 'Video & Audio',
        status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: 'ok',
        findingsCount: 0,
        confidence: 'MEDIUM',
        limitations: 'None',
      },
      title: {
        domain: 'title',
        domainLabel: 'Title',
        status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: 'ok',
        findingsCount: 0,
        confidence: 'MEDIUM',
        limitations: 'None',
      },
      description_tags: {
        domain: 'description_tags',
        domainLabel: 'Description & Tags',
        status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: 'ok',
        findingsCount: 0,
        confidence: 'MEDIUM',
        limitations: 'None',
      },
      thumbnail: {
        domain: 'thumbnail',
        domainLabel: 'Thumbnail',
        status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: 'ok',
        findingsCount: 0,
        confidence: 'MEDIUM',
        limitations: 'None',
      },
      channel_context: {
        domain: 'channel_context',
        domainLabel: 'Channel Context',
        status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: 'ok',
        findingsCount: 0,
        confidence: 'MEDIUM',
        limitations: 'None',
      },
    },
    riskCategories: {
      yppMonetization: { status: 'LOW_RISK', score: 10, label: 'Original', explanation: 'ok' },
      videoMonetization: { status: 'LOW_RISK', score: 10, label: 'Low', explanation: 'ok' },
      advertiserFriendly: { status: 'LOW_RISK', score: 10, label: 'Low', explanation: 'ok' },
      copyrightSignals: { status: 'LOW_RISK', score: 10, label: 'Low', explanation: 'ok' },
    },
    topIssues: [],
    policyConnections: [],
    timeline: [],
    reusedContentRatio: 0,
    metadataScore: 10,
    benchmarkMetrics: {
      totalProcessingSeconds: 1,
      inspectionMs: 100,
      audioProcessingMs: 100,
      videoAnalysisMs: 100,
      evidenceBuildingMs: 50,
      policyReasoningMs: 50,
      framesSampled: 1,
      scenesDetected: 1,
    },
  };
}

export async function runLaunchBlockersPhase1Tests(): Promise<void> {
  console.log('\n======================================================');
  console.log('PHASE 1 LAUNCH BLOCKERS VERIFICATION SUITE (TASKS 1-5)');
  console.log('======================================================');

  const { storage, createStorage } = await import('../src/server/storage');
  verifyStorageTestDatabase((storage as any).dbPath, testDbResolution.resolvedPath);

  const { apiRouter, sanitizeUser } = await import('../src/server/routes/api');
  const { createServerApp } = await import('../server');
  const { executePermanentAccountDeletion } = await import('../src/server/services/accountDeletionService');
  const { RetentionService } = await import('../src/server/services/retentionService');
  const { resolveRetentionConfiguration } = await import('../src/server/config/environment');
  const { jobOrchestrator: singletonOrchestrator } = await import('../src/server/pipeline/jobOrchestrator');

  const singletonWasRunning = (singletonOrchestrator as any).isRunning;
  singletonOrchestrator.stopWorker();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videorisk-launch-blockers-'));
  const uploadDir = path.resolve(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const proxiesDir = path.join(uploadDir, 'proxies');
  const framesDir = path.join(uploadDir, 'frames');
  if (!fs.existsSync(proxiesDir)) fs.mkdirSync(proxiesDir, { recursive: true });
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

  const createdFiles: string[] = [];
  const createdDirs: string[] = [];

  const origOwnerUserId = process.env.OWNER_USER_ID;
  const origAdminUserIds = process.env.ADMIN_USER_IDS;
  const origAdminEmails = process.env.ADMIN_EMAILS;
  const origTrustProxy = process.env.TRUST_PROXY;
  const origMediaSecret = process.env.MEDIA_TOKEN_SECRET;

  const restoreEnv = () => {
    const restoreVar = (key: string, val: string | undefined) => {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    };
    restoreVar('OWNER_USER_ID', origOwnerUserId);
    restoreVar('ADMIN_USER_IDS', origAdminUserIds);
    restoreVar('ADMIN_EMAILS', origAdminEmails);
    restoreVar('TRUST_PROXY', origTrustProxy);
    restoreVar('MEDIA_TOKEN_SECRET', origMediaSecret);
  };

  // Start lightweight API test server
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  const suffix = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  try {
    // =========================================================================
    // TASK 1: Protect GET /api/operational/metrics with requireAdmin
    // =========================================================================
    console.log('\n[Task 1] Verifying GET /api/operational/metrics admin-only enforcement...');

    const ownerUser = await storage.users.createUser(`lb_owner_${suffix}@example.com`, 'h', 's', 10, 'free');
    const adminUser = await storage.users.createUser(`lb_admin_${suffix}@example.com`, 'h', 's', 10, 'free');
    const normalUser = await storage.users.createUser(`lb_customer_${suffix}@example.com`, 'h', 's', 10, 'creator');
    const emailOnlyAdmin = await storage.users.createUser(`lb_emailonly_${suffix}@example.com`, 'h', 's', 10, 'free');

    const ownerToken = await storage.users.createSession(ownerUser.id);
    const adminToken = await storage.users.createSession(adminUser.id);
    const normalToken = await storage.users.createSession(normalUser.id);
    const emailOnlyToken = await storage.users.createSession(emailOnlyAdmin.id);

    process.env.OWNER_USER_ID = ownerUser.id;
    process.env.ADMIN_USER_IDS = adminUser.id;
    process.env.ADMIN_EMAILS = emailOnlyAdmin.email;

    const unauthMetrics = await fetch(`${baseUrl}/operational/metrics`);
    assert.strictEqual(unauthMetrics.status, 401, 'Unauthenticated GET /api/operational/metrics returns 401');

    const customerMetrics = await fetch(`${baseUrl}/operational/metrics`, {
      headers: { Authorization: `Bearer ${normalToken}` },
    });
    assert.strictEqual(customerMetrics.status, 403, 'Ordinary user receives 403 on GET /api/operational/metrics');

    const emailAdminMetrics = await fetch(`${baseUrl}/operational/metrics`, {
      headers: { Authorization: `Bearer ${emailOnlyToken}` },
    });
    assert.strictEqual(emailAdminMetrics.status, 403, 'ADMIN_EMAILS-only user receives 403 on GET /api/operational/metrics');

    const ownerMetricsRes = await fetch(`${baseUrl}/operational/metrics`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.strictEqual(ownerMetricsRes.status, 200, 'Verified owner receives 200 on GET /api/operational/metrics');
    const metricsPayload = await ownerMetricsRes.json();

    assert.strictEqual(typeof metricsPayload.totalScans, 'number');
    assert.strictEqual(typeof metricsPayload.completedScans, 'number');
    assert.strictEqual(typeof metricsPayload.failedScans, 'number');
    assert.strictEqual(typeof metricsPayload.averageProcessingSeconds, 'number');
    assert.strictEqual(typeof metricsPayload.totalDurationSecondsScanned, 'number');
    assert.strictEqual(typeof metricsPayload.estimatedComputeCostUsd, 'number');
    assert.strictEqual(typeof metricsPayload.estimatedStorageCostUsd, 'number');
    assert.ok(metricsPayload.measuredStageAveragesMs && typeof metricsPayload.measuredStageAveragesMs.inspection === 'number');
    const serializedMetrics = JSON.stringify(metricsPayload);
    assert(!serializedMetrics.includes(normalUser.email), 'Metrics payload exposes no tenant email');
    assert(!serializedMetrics.includes(normalUser.id), 'Metrics payload exposes no tenant userId');

    const adminMetricsRes = await fetch(`${baseUrl}/operational/metrics`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(adminMetricsRes.status, 200, 'Explicit ADMIN_USER_IDS admin receives 200 on GET /api/operational/metrics');

    delete process.env.OWNER_USER_ID;
    const unsetOwnerMetrics = await fetch(`${baseUrl}/operational/metrics`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.strictEqual(unsetOwnerMetrics.status, 403, 'Owner fails closed (403) if OWNER_USER_ID is unset');
    process.env.OWNER_USER_ID = ownerUser.id;
    console.log('  ✅ Task 1 passed: GET /api/operational/metrics strictly enforces requireAdmin & preserves schema');

    // =========================================================================
    // TASK 2: Verify HTTP Security Headers in server.ts
    // =========================================================================
    console.log('\n[Task 2] Verifying Helmet HTTP Security Headers & HTTPS-only HSTS...');
    const secServerBundle = await createServerApp({
      env: {
        ...process.env,
        NODE_ENV: 'development',
        TRUST_PROXY: '1',
        MEDIA_TOKEN_SECRET: process.env.MEDIA_TOKEN_SECRET || 'test-media-token-secret-at-least-32-chars!!',
      },
      createViteServerFn: async () => ({
        middlewares: (_req, res) => {
          res.status(200).setHeader('Content-Type', 'text/html').send('<!doctype html><html><body>ok</body></html>');
        },
      }),
    });
    const secServer = secServerBundle.app.listen(0);
    const secPort = (secServer.address() as any).port;

    try {
      // Plain HTTP request in dev/preview mode -> security headers present, AI Studio framing permitted, HSTS absent
      const httpHtmlRes = await fetch(`http://127.0.0.1:${secPort}/`);
      assert.strictEqual(httpHtmlRes.status, 200);
      const csp = httpHtmlRes.headers.get('content-security-policy') || '';
      assert.ok(csp.includes("default-src 'self'"), 'CSP includes default-src self');
      assert.ok(csp.includes("media-src 'self' blob:"), 'CSP permits media-src self and blob:');
      assert.ok(csp.includes("img-src 'self' data: blob:"), 'CSP permits img-src self, data:, and blob:');
      assert.ok(csp.includes('https://checkout.stripe.com'), 'CSP form-action permits Stripe Checkout redirects');
      assert.ok(csp.includes("frame-ancestors 'self' https://aistudio.google.com"), 'Dev/preview CSP permits AI Studio iframe framing');
      assert.strictEqual(httpHtmlRes.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options is nosniff');
      assert.strictEqual(httpHtmlRes.headers.get('x-frame-options'), null, 'X-Frame-Options omitted in dev/preview so AI Studio iframe is not blocked');
      assert.strictEqual(httpHtmlRes.headers.get('strict-transport-security'), null, 'HSTS must NOT be sent over plain HTTP');

      // API health check over HTTP
      const httpApiRes = await fetch(`http://127.0.0.1:${secPort}/api/health`);
      assert.strictEqual(httpApiRes.status, 200);
      assert.strictEqual(httpApiRes.headers.get('x-content-type-options'), 'nosniff');

      // Proxied HTTPS request -> HSTS IS sent
      const httpsProxyRes = await fetch(`http://127.0.0.1:${secPort}/api/health`, {
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      assert.strictEqual(httpsProxyRes.status, 200);
      const hsts = httpsProxyRes.headers.get('strict-transport-security') || '';
      assert.ok(hsts.includes('max-age=31536000'), 'HSTS enabled on HTTPS requests');
    } finally {
      secServer.close();
      await secServerBundle.closeViteServer?.();
    }

    // Standalone production mode -> strict X-Frame-Options: SAMEORIGIN & frame-ancestors 'self'
    const prodSecBundle = await createServerApp({
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'production',
        APP_BASE_URL: 'https://videorisk.com',
        TRUST_PROXY: '1',
        MEDIA_TOKEN_SECRET: process.env.MEDIA_TOKEN_SECRET || 'test-media-token-secret-at-least-32-chars!!',
      },
    });
    const prodSecServer = prodSecBundle.app.listen(0);
    const prodSecPort = (prodSecServer.address() as any).port;
    try {
      const prodApiRes = await fetch(`http://127.0.0.1:${prodSecPort}/api/health`, {
        headers: { Host: 'videorisk.com', 'X-Forwarded-Proto': 'https' },
      });
      assert.strictEqual(prodApiRes.status, 200);
      const prodCsp = prodApiRes.headers.get('content-security-policy') || '';
      assert.ok(prodCsp.includes("frame-ancestors 'self'"), 'Standalone production enforces frame-ancestors self');
      assert.ok(!prodCsp.includes('aistudio.google.com'), 'Standalone production does not include AI Studio frame ancestor');
      assert.strictEqual(prodApiRes.headers.get('x-frame-options'), 'SAMEORIGIN', 'Standalone production sends X-Frame-Options SAMEORIGIN');
      assert.strictEqual(prodApiRes.headers.get('x-content-type-options'), 'nosniff');
      assert.ok((prodApiRes.headers.get('strict-transport-security') || '').includes('max-age=31536000'));
    } finally {
      prodSecServer.close();
      await prodSecBundle.closeViteServer?.();
    }
    console.log('  ✅ Task 2 passed: CSP, X-Content-Type-Options, AI Studio preview framing, standalone SAMEORIGIN, and conditional HTTPS HSTS verified');

    // =========================================================================
    // TASK 3: Terms of Service & Privacy Policy UI + Links + Disclosures
    // =========================================================================
    console.log('\n[Task 3] Verifying Terms of Service & Privacy Policy pages and links...');
    const tosSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/TermsOfServiceView.tsx'), 'utf-8');
    const privSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/PrivacyPolicyView.tsx'), 'utf-8');
    const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
    const authModalSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/AuthModal.tsx'), 'utf-8');

    assert.ok(tosSrc.includes('Terms of Service') && tosSrc.includes('NOT legal advice') && tosSrc.includes('PENDING'), 'Terms includes scope, disclaimers, and explicit placeholders');
    assert.ok(privSrc.includes('Privacy Policy') && privSrc.includes('MEDIA_RETENTION_HOURS') && privSrc.includes('PENDING'), 'Privacy includes collection, processing, configurable retention, and placeholders');
    assert.ok(appSrc.includes('/terms') && appSrc.includes('/privacy') && appSrc.includes('TermsOfServiceView') && appSrc.includes('PrivacyPolicyView'), 'App integrates /terms and /privacy routes and footer links');
    assert.ok(authModalSrc.includes('/terms') && authModalSrc.includes('/privacy') && authModalSrc.includes('/api/auth/account'), 'AuthModal links Terms/Privacy and wires account deletion');
    console.log('  ✅ Task 3 passed: Terms of Service & Privacy Policy views, links, and non-fabricated placeholders verified');

    // =========================================================================
    // TASK 4: Permanent User Account Deletion (DELETE /api/auth/account)
    // =========================================================================
    console.log('\n[Task 4] Verifying DELETE /api/auth/account, consistency, shared media & billing archive...');

    // 4a. Unauthenticated
    const unauthDel = await fetch(`${baseUrl}/auth/account`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, confirmation: 'DELETE' }),
    });
    assert.strictEqual(unauthDel.status, 401, 'Unauthenticated account deletion rejected with 401');

    // 4b. Protected owner/admin accounts blocked (403)
    const ownerDel = await fetch(`${baseUrl}/auth/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, confirmation: 'DELETE' }),
    });
    assert.strictEqual(ownerDel.status, 403, 'Protected owner account cannot be deleted');

    const adminDel = await fetch(`${baseUrl}/auth/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, confirmation: 'DELETE' }),
    });
    assert.strictEqual(adminDel.status, 403, 'Protected admin account cannot be deleted');

    // 4c. Confirmation guard & wrong password guard
    const pwSalt = crypto.randomBytes(16).toString('hex');
    const pwHash = crypto.scryptSync('CorrectPass123!', pwSalt, 64).toString('hex');
    const victimUser = await storage.users.createUser(`lb_victim_${suffix}@example.com`, pwHash, pwSalt, 25, 'creator');
    const victimToken1 = await storage.users.createSession(victimUser.id);
    const victimToken2 = await storage.users.createSession(victimUser.id);

    const otherUser = await storage.users.createUser(`lb_other_${suffix}@example.com`, 'h', 's', 20, 'pro');

    const missingConfirmRes = await fetch(`${baseUrl}/auth/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${victimToken1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, confirmation: 'NOPE' }),
    });
    assert.strictEqual(missingConfirmRes.status, 400, 'Missing/invalid explicit confirmation rejected with 400');

    const wrongPwRes = await fetch(`${baseUrl}/auth/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${victimToken1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, confirmation: 'DELETE', password: 'WrongPassword!' }),
    });
    assert.strictEqual(wrongPwRes.status, 401, 'Wrong supplied password rejected with 401');

    // Create rich data & files for victimUser + a shared video with otherUser
    const victimVideo = path.join(uploadDir, `lb_victim_vid_${suffix}.mp4`);
    const victimProxy = path.join(proxiesDir, `proxy_lb_victim_vid_${suffix}.mp4`);
    const victimThumb = path.join(uploadDir, `lb_victim_thumb_${suffix}.jpg`);
    const sharedVideo = path.join(uploadDir, `lb_shared_vid_${suffix}.mp4`);
    fs.writeFileSync(victimVideo, 'victim-video-bytes');
    fs.writeFileSync(victimProxy, 'victim-proxy-bytes');
    fs.writeFileSync(victimThumb, 'victim-thumb-bytes');
    fs.writeFileSync(sharedVideo, 'shared-video-bytes');
    createdFiles.push(victimVideo, victimProxy, victimThumb, sharedVideo);

    const victimScanId = `scan_victim_${suffix}`;
    const victimSharedScanId = `scan_victim_shared_${suffix}`;
    const otherScanId = `scan_other_${suffix}`;

    await storage.uploads.recordUpload({
      fileId: path.basename(victimVideo),
      userId: victimUser.id,
      filename: 'victim.mp4',
      filePath: victimVideo,
      fileSize: 18,
      type: 'video',
      createdAt: new Date().toISOString(),
    });
    await storage.uploads.recordUpload({
      fileId: `shared_${path.basename(sharedVideo)}`,
      userId: otherUser.id,
      filename: 'shared.mp4',
      filePath: sharedVideo,
      fileSize: 18,
      type: 'video',
      createdAt: new Date().toISOString(),
    });

    await storage.scans.createScan({
      id: victimScanId,
      userId: victimUser.id,
      videoTitle: 'Victim Private Video',
      videoFilename: 'victim.mp4',
      videoPath: victimVideo,
      proxyPath: victimProxy,
      thumbnailPath: victimThumb,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 2,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await storage.scans.createScan({
      id: victimSharedScanId,
      userId: victimUser.id,
      videoTitle: 'Victim Shared Reference',
      videoFilename: 'shared.mp4',
      videoPath: sharedVideo,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 1,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    await storage.scans.createScan({
      id: otherScanId,
      userId: otherUser.id,
      videoTitle: 'Other User Shared Video',
      videoFilename: 'shared.mp4',
      videoPath: sharedVideo,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 1,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    await storage.scans.saveReport(victimScanId, makeDomainTestReport(victimScanId, 'Test report'), { systemBypass: true });

    await storage.channelProfiles.saveProfile(victimUser.id, { channelTopic: 'Testing Privacy Deletion' });
    await storage.passwordReset.createResetToken(victimUser.id, `hash_${suffix}`, new Date(Date.now() + 600000).toISOString());
    await storage.billing.markEventProcessed({
      eventId: `evt_victim_${suffix}`,
      provider: 'stripe',
      eventType: 'checkout.session.completed',
      processedAt: new Date().toISOString(),
      userId: victimUser.id,
      creditsGranted: 25,
    });
    await storage.billing.saveSubscription({
      id: `sub_victim_${suffix}`,
      userId: victimUser.id,
      planId: 'creator',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await storage.billing.recordCreditTransaction({
      id: `ctx_victim_${suffix}`,
      userId: victimUser.id,
      delta: 25,
      balanceAfter: 25,
      type: 'PLAN_PURCHASE',
      referenceId: `evt_victim_${suffix}`,
      createdAt: new Date().toISOString(),
    });
    await storage.analytics.recordEvent({
      id: `ae_victim_${suffix}`,
      eventName: 'user_registered',
      userId: victimUser.id,
      anonymousId: null,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      properties: { registrationMethod: 'email_password' },
    });

    // 4d. Active RUNNING job blocks account deletion (409)
    const activeScanId = `scan_running_${suffix}`;
    await storage.scans.createScan({
      id: activeScanId,
      userId: victimUser.id,
      videoTitle: 'Running Job Scan',
      videoFilename: 'victim.mp4',
      videoPath: victimVideo,
      scanMode: 'standard',
      status: 'PROCESSING_VIDEO',
      currentStage: 'Scene analysis',
      completedStages: ['Upload'],
      creditsUsed: 1,
      createdAt: new Date().toISOString(),
    });
    await storage.queue.claimNextJob('test_worker_1', 60000);
    const activeJobBlockedRes = await fetch(`${baseUrl}/auth/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${victimToken1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, confirmation: 'DELETE' }),
    });
    assert.strictEqual(activeJobBlockedRes.status, 409, 'Account deletion blocked with 409 while scan job is RUNNING');
    await storage.scans.deleteScan(activeScanId);

    // 4e. Partial failure test: unlink failure preserves user & marks affected scan CLEANUP_PENDING
    const partialUnlinkResult = await executePermanentAccountDeletion(victimUser, {
      storage,
      uploadDir,
      env: process.env,
      unlinkFn: (target) => {
        if (path.resolve(target) === path.resolve(victimVideo)) {
          throw new Error('EACCES: simulated unlink permission error');
        }
        fs.unlinkSync(target);
      },
    });
    assert.strictEqual(partialUnlinkResult.ok, false);
    assert.strictEqual(partialUnlinkResult.statusCode, 500);
    assert.ok(await storage.users.getUser(victimUser.id), 'User record preserved on partial filesystem failure');
    assert.strictEqual((await storage.scans.getScan(victimScanId))?.status, 'CLEANUP_PENDING', 'Affected scan marked CLEANUP_PENDING on file failure');

    // Recreate any files unlinked prior to simulated error so HTTP deletion deletes clean set
    if (!fs.existsSync(victimProxy)) fs.writeFileSync(victimProxy, 'victim-proxy-bytes');
    if (!fs.existsSync(victimThumb)) fs.writeFileSync(victimThumb, 'victim-thumb-bytes');
    await storage.scans.updateScan(victimScanId, { status: 'COMPLETED', error: undefined }, { systemBypass: true });

    // 4f. Full successful HTTP account deletion
    const delAccountRes = await fetch(`${baseUrl}/auth/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${victimToken1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, confirmation: 'DELETE', password: 'CorrectPass123!' }),
    });
    assert.strictEqual(delAccountRes.status, 200, 'Authenticated owner receives 200 on DELETE /api/auth/account');
    const delPayload = await delAccountRes.json();
    assert.strictEqual(delPayload.success, true);
    assert.strictEqual(delPayload.deletedUserId, victimUser.id);
    assert.ok(typeof delPayload.anonymizedSubjectId === 'string' && delPayload.anonymizedSubjectId.startsWith('deleted_'));
    assert.ok(delPayload.archivedBillingRecords >= 2, 'Billing records archived under anonymized subject ID');

    // Verify all personal data, sessions, scans, reports, profile, and unshared media are gone
    assert.strictEqual(await storage.users.getUser(victimUser.id), null, 'User record removed');
    assert.strictEqual(await storage.users.getUserByEmail(victimUser.email), null, 'User email lookup returns null');
    assert.strictEqual(await storage.users.getUserBySession(victimToken1), null, 'Primary session revoked');
    assert.strictEqual(await storage.users.getUserBySession(victimToken2), null, 'Secondary session revoked');
    assert.strictEqual((await storage.scans.getAllScans(victimUser.id)).length, 0, 'All user scans deleted');
    assert.strictEqual(await storage.scans.getReport(victimScanId), null, 'Deleted user report removed');
    assert.strictEqual(await storage.channelProfiles.getProfile(victimUser.id), null, 'Channel profile removed');
    assert.strictEqual(fs.existsSync(victimVideo), false, 'Victim unshared video removed from disk');
    assert.strictEqual(fs.existsSync(victimProxy), false, 'Victim proxy removed from disk');
    assert.strictEqual(fs.existsSync(victimThumb), false, 'Victim thumbnail removed from disk');

    // Shared media and otherUser data MUST be preserved
    assert.strictEqual(fs.existsSync(sharedVideo), true, 'Shared media referenced by other user is PRESERVED');
    assert.ok(await storage.scans.getScan(otherScanId), 'Other user scan unaffected');

    // Verify anonymized billing archive exists with NO email or raw victim userId
    const archiveRecords = await storage.getBillingAuditArchive!(delPayload.anonymizedSubjectId);
    assert.ok(archiveRecords.length >= 2, 'Billing audit archive persisted');
    const archiveStr = JSON.stringify(archiveRecords);
    assert(!archiveStr.includes(victimUser.email), 'Billing audit archive contains no user email');
    assert(!archiveStr.includes(victimUser.id), 'Billing audit archive contains no raw userId');

    // Repeat request with revoked token -> 401
    const repeatDelRes = await fetch(`${baseUrl}/auth/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${victimToken1}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, confirmation: 'DELETE' }),
    });
    assert.strictEqual(repeatDelRes.status, 401, 'Subsequent call with revoked session gets 401');

    // DB failure after file deletion recovery verification
    const failDbUser = await storage.users.createUser(`lb_db_fail_${suffix}@example.com`, 'h', 's', 10, 'free');
    const failDbVid = path.join(uploadDir, `lb_dbfail_vid_${suffix}.mp4`);
    fs.writeFileSync(failDbVid, 'dbfail-bytes');
    createdFiles.push(failDbVid);
    const failDbScanId = `scan_dbfail_${suffix}`;
    await storage.scans.createScan({
      id: failDbScanId,
      userId: failDbUser.id,
      videoTitle: 'DB Failure Test',
      videoFilename: 'dbfail.mp4',
      videoPath: failDbVid,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 1,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    const dbFailResult = await executePermanentAccountDeletion(failDbUser, {
      storage,
      uploadDir,
      env: process.env,
      failDbDeletionForTest: true,
    });
    assert.strictEqual(dbFailResult.ok, false);
    assert.strictEqual(dbFailResult.statusCode, 500);
    assert.strictEqual(fs.existsSync(failDbVid), false, 'Media removed before DB error');
    const pendingDbFailScan = await storage.scans.getScan(failDbScanId);
    assert.strictEqual(pendingDbFailScan?.status, 'CLEANUP_PENDING', 'Scan transitioned to CLEANUP_PENDING on DB failure');
    assert.strictEqual((pendingDbFailScan?.metadata as any)?.mediaCleaned, true);

    // Memory storage parity check
    const memStore = createStorage(path.join(tempDir, 'mem_store.json'), { ...process.env, STORAGE_ENGINE: 'memory' });
    const memUser = await memStore.users.createUser(`mem_${suffix}@example.com`, 'h', 's', 10, 'free');
    await memStore.billing.recordCreditTransaction({
      id: `mem_ctx_${suffix}`,
      userId: memUser.id,
      delta: 10,
      balanceAfter: 10,
      type: 'INITIAL_GRANT',
      createdAt: new Date().toISOString(),
    });
    const memDelRes = await memStore.users.deleteAccount(memUser.id);
    assert.strictEqual(memDelRes.deleted, true, 'InMemoryStorageRepository deleteAccount parity');
    assert.strictEqual(await memStore.users.getUser(memUser.id), null);
    assert.ok((await memStore.getBillingAuditArchive!(memDelRes.anonymizedSubjectId)).length >= 1);

    console.log('  ✅ Task 4 passed: Account deletion guards, media safety, billing anonymization, and recovery verified');

    // =========================================================================
    // TASK 5: Automated Retention & Orphaned Media Cleanup Service
    // =========================================================================
    console.log('\n[Task 5] Verifying automated retention cleanup, reconciliation, overlap lock, and restart safety...');

    const defaultRetentionCfg = resolveRetentionConfiguration({});
    assert.strictEqual(defaultRetentionCfg.mediaRetentionHours, 168);
    assert.strictEqual(defaultRetentionCfg.tempArtifactRetentionHours, 24);
    assert.strictEqual(defaultRetentionCfg.approvalStatus, 'CONFIGURABLE_DEFAULT_REQUIRES_OWNER_APPROVAL');

    // Use isolated storage + uploadDir for clean deterministic retention test
    const retDbPath = path.join(tempDir, 'retention_test.db');
    const retUploadDir = path.join(tempDir, 'ret_uploads');
    const retProxiesDir = path.join(retUploadDir, 'proxies');
    const retFramesDir = path.join(retUploadDir, 'frames');
    fs.mkdirSync(retProxiesDir, { recursive: true });
    fs.mkdirSync(retFramesDir, { recursive: true });
    createdDirs.push(retUploadDir);

    const retStorage = createStorage(retDbPath, { STORAGE_ENGINE: 'sqlite' });
    const retUser = await retStorage.users.createUser(`ret_${suffix}@example.com`, 'h', 's', 20, 'creator');

    const baseNow = Date.now();
    const tenDaysAgo = new Date(baseNow - 10 * 24 * 3600 * 1000).toISOString();
    const oneHourAgo = new Date(baseNow - 1 * 3600 * 1000).toISOString();

    const expiredVid = path.join(retUploadDir, 'expired_video.mp4');
    const expiredProxy = path.join(retProxiesDir, 'proxy_expired_video.mp4');
    const expiredThumb = path.join(retUploadDir, 'expired_thumb.jpg');
    const activeVid = path.join(retUploadDir, 'recent_video.mp4');
    const sharedActiveVid = path.join(retUploadDir, 'shared_across_scans.mp4');
    const staleTmpFile = path.join(retUploadDir, '.probe_stale.tmp');
    const staleFrameSubdir = path.join(retFramesDir, 'old_orphan_scan_123');
    const staleFrameFile = path.join(staleFrameSubdir, 'frame_001.jpg');

    fs.mkdirSync(staleFrameSubdir, { recursive: true });
    fs.writeFileSync(expiredVid, 'expired-video');
    fs.writeFileSync(expiredProxy, 'expired-proxy');
    fs.writeFileSync(expiredThumb, 'expired-thumb');
    fs.writeFileSync(activeVid, 'active-video');
    fs.writeFileSync(sharedActiveVid, 'shared-video');
    fs.writeFileSync(staleTmpFile, 'tmp-bytes');
    fs.writeFileSync(staleFrameFile, 'frame-bytes');

    // Backdate mtimes for temporary artifacts beyond 24h
    const staleMtime = new Date(baseNow - 48 * 3600 * 1000);
    fs.utimesSync(staleTmpFile, staleMtime, staleMtime);
    fs.utimesSync(staleFrameFile, staleMtime, staleMtime);

    // Expired scan with report + evidence + expired shared media
    const expiredScanId = 'scan_ret_expired';
    await retStorage.scans.createScan({
      id: expiredScanId,
      userId: retUser.id,
      videoTitle: 'Expired Scan',
      videoFilename: 'expired_video.mp4',
      videoPath: expiredVid,
      proxyPath: expiredProxy,
      thumbnailPath: expiredThumb,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 2,
      createdAt: tenDaysAgo,
      completedAt: tenDaysAgo,
    });
    await retStorage.scans.saveReport(expiredScanId, makeDomainTestReport(expiredScanId, 'Retained report after raw media expiration'), { systemBypass: true });
    await retStorage.evidence.saveEvidence(expiredScanId, [{
      id: 'ev_ret_1',
      scanId: expiredScanId,
      domain: 'video_audio',
      timestampStart: 0,
      timestampEnd: 5,
      timestampLabel: '00:00',
      type: 'narration',
      category: 'original_contribution',
      severity: 'info',
      confidenceLevel: 'HIGH',
      provenance: 'test',
      source: 'test',
      label: 'Evidence retained',
      details: 'Must stay intact when raw media expires.',
    }], { systemBypass: true });

    // Aged scan sharing media with a recent unexpired scan -> shared file MUST survive
    await retStorage.scans.createScan({
      id: 'scan_ret_old_shared',
      userId: retUser.id,
      videoTitle: 'Old Shared',
      videoFilename: 'shared_across_scans.mp4',
      videoPath: sharedActiveVid,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 1,
      createdAt: tenDaysAgo,
      completedAt: tenDaysAgo,
    });
    await retStorage.scans.createScan({
      id: 'scan_ret_new_shared',
      userId: retUser.id,
      videoTitle: 'New Shared',
      videoFilename: 'shared_across_scans.mp4',
      videoPath: sharedActiveVid,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 1,
      createdAt: oneHourAgo,
      completedAt: oneHourAgo,
    });

    // Recent scan -> media preserved
    await retStorage.scans.createScan({
      id: 'scan_ret_recent',
      userId: retUser.id,
      videoTitle: 'Recent Active',
      videoFilename: 'recent_video.mp4',
      videoPath: activeVid,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 1,
      createdAt: oneHourAgo,
      completedAt: oneHourAgo,
    });

    // Pending scan left over prior to restart
    const pendingVid = path.join(retUploadDir, 'pending_cleanup.mp4');
    fs.writeFileSync(pendingVid, 'pending-cleanup');
    await retStorage.scans.createScan({
      id: 'scan_ret_pending',
      userId: retUser.id,
      videoTitle: 'Pending Cleanup',
      videoFilename: 'pending_cleanup.mp4',
      videoPath: pendingVid,
      scanMode: 'standard',
      status: 'CLEANUP_PENDING',
      currentStage: 'Risk report',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: oneHourAgo,
    });

    const retentionEnv = {
      ...process.env,
      MEDIA_RETENTION_HOURS: '168',
      TEMP_ARTIFACT_RETENTION_HOURS: '24',
    };

    // First sweep: simulate unlink error on pendingVid so it stays CLEANUP_PENDING across restart
    const failingRetService = new RetentionService({
      storage: retStorage,
      uploadDir: retUploadDir,
      env: retentionEnv,
      nowFn: () => baseNow,
      unlinkFn: (target) => {
        if (path.resolve(target) === path.resolve(pendingVid)) {
          throw new Error('EBUSY: simulated temporary file lock');
        }
        fs.unlinkSync(target);
      },
    });

    const sweep1 = await failingRetService.runCleanupSweep();
    assert.strictEqual(sweep1.executed, true);
    assert.ok(sweep1.errors >= 1, 'Sweep records simulated partial unlink error safely');
    assert.strictEqual(fs.existsSync(expiredVid), false, 'Expired scan video deleted');
    assert.strictEqual(fs.existsSync(expiredProxy), false, 'Expired scan proxy deleted');
    assert.strictEqual(fs.existsSync(expiredThumb), false, 'Expired scan thumbnail deleted');
    assert.strictEqual(fs.existsSync(activeVid), true, 'Unexpired scan video preserved');
    assert.strictEqual(fs.existsSync(sharedActiveVid), true, 'Shared video referenced by unexpired scan preserved');
    assert.strictEqual(fs.existsSync(staleTmpFile), false, 'Expired .tmp artifact cleaned up');
    assert.strictEqual(fs.existsSync(staleFrameFile), false, 'Expired temp frame cleaned up');
    assert.strictEqual(fs.existsSync(pendingVid), true, 'Locked pending file remained on disk for retry');
    assert.ok(await retStorage.scans.getScan(expiredScanId), 'Expired scan metadata row retained');
    assert.ok(await retStorage.scans.getReport(expiredScanId), 'Expired scan report retained');
    assert.strictEqual((await retStorage.evidence.getEvidence(expiredScanId)).length, 1, 'Expired scan evidence retained');
    assert.strictEqual((await retStorage.scans.getScan(expiredScanId))?.videoPath, '', 'Expired scan videoPath cleared');
    assert.strictEqual(((await retStorage.scans.getScan(expiredScanId))?.metadata as any)?.mediaExpired, true);
    assert.ok(await retStorage.scans.getScan('scan_ret_pending'), 'Failed CLEANUP_PENDING scan preserved for retry');

    // Simulate restart recovery: reopen SQLite DB and instantiate fresh RetentionService without failing unlink
    await retStorage.close?.();
    const restartedStorage = createStorage(retDbPath, { STORAGE_ENGINE: 'sqlite' });
    const restartedRetService = new RetentionService({
      storage: restartedStorage,
      uploadDir: retUploadDir,
      env: retentionEnv,
      nowFn: () => baseNow,
    });

    const sweep2 = await restartedRetService.runCleanupSweep();
    assert.strictEqual(sweep2.executed, true);
    assert.strictEqual(sweep2.errors, 0, 'Restarted recovery sweep succeeds cleanly');
    assert.strictEqual(sweep2.pendingScansPurged, 1, 'CLEANUP_PENDING scan reconciled and purged after restart');
    assert.strictEqual(fs.existsSync(pendingVid), false, 'Pending file removed on retry');
    assert.strictEqual(await restartedStorage.scans.getScan('scan_ret_pending'), null, 'Pending scan record removed after retry');

    // Overlap guard verification
    let releaseBlocker!: () => void;
    const blockerPromise = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const slowStorage = {
      ...restartedStorage,
      scans: {
        ...restartedStorage.scans,
        getAllScans: async () => {
          await blockerPromise;
          return [];
        },
      },
    };
    const overlapService = new RetentionService({ storage: slowStorage as any, uploadDir: retUploadDir, env: retentionEnv });
    const firstRunPromise = overlapService.runCleanupSweep();
    const concurrentRunResult = await overlapService.runCleanupSweep();
    assert.strictEqual(concurrentRunResult.executed, false);
    assert.strictEqual(concurrentRunResult.skippedOverlap, true, 'Concurrent sweep safely skipped via overlap lock');
    releaseBlocker();
    const firstRunResult = await firstRunPromise;
    assert.strictEqual(firstRunResult.executed, true);

    await restartedStorage.close?.();
    console.log('  ✅ Task 5 passed: Expiration, report preservation, partial failure recovery, restart reconciliation, and overlap lock verified');

    console.log('\n🎉 ALL PHASE 1 LAUNCH BLOCKERS VERIFICATION TESTS PASSED!');
  } finally {
    restoreEnv();
    if (singletonWasRunning) {
      singletonOrchestrator.startWorker();
    }
    server.close();
    for (const f of createdFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('tests', 'launch_blockers_phase1.test.ts'));
if (isDirectExecution) {
  runLaunchBlockersPhase1Tests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ PHASE 1 LAUNCH BLOCKERS VERIFICATION FAILED:', err);
      process.exit(1);
    });
}
