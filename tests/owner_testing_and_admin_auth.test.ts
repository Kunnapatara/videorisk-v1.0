import assert from 'assert';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { enforceTestDatabaseIsolation, verifyStorageTestDatabase } from '../src/server/storage/testIsolation';

process.env.VIDEORISK_TEST_RUN = 'true';
const testDbResolution = enforceTestDatabaseIsolation();

function createValidTestMp4(filePath: string, durationSec: number = 2) {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=blue:s=320x240:d=${durationSec}`,
      '-f', 'lavfi',
      '-i', `sine=frequency=440:duration=${durationSec}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-shortest',
      filePath,
    ],
    { stdio: 'pipe' }
  );
}

export async function runOwnerTestingAndAdminAuthTests() {
  console.log('\n======================================================');
  console.log('--- SUITE 27: OWNER IDENTITY, ADMIN AUTH & OWNER TESTING ---');
  console.log('======================================================\n');

  process.env.VIDEORISK_TEST_RUN = 'true';
  enforceTestDatabaseIsolation();

  const { storage, InMemoryStorageRepository } = await import('../src/server/storage');
  verifyStorageTestDatabase((storage as any).dbPath, testDbResolution.resolvedPath);

  const { apiRouter, isAdminUser, sanitizeUser } = await import('../src/server/routes/api');
  const {
    getConfiguredOwnerUserId,
    isAuthorizedAdminUser,
    isValidInternalUserId,
    isVerifiedOwnerUser,
  } = await import('../src/server/services/ownerAuth');
  const { JobOrchestrator, jobOrchestrator: singletonOrchestrator } = await import('../src/server/pipeline/jobOrchestrator');
  const { validateBillingConfiguration } = await import('../scripts/validate-env');
  const singletonWasRunning = Boolean((singletonOrchestrator as any).isWorkerRunning);
  singletonOrchestrator.stopWorker();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_owner_test_'));
  const uploadDir = path.resolve(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const createdFiles: string[] = [];

  const prevEnv = {
    OWNER_USER_ID: process.env.OWNER_USER_ID,
    ADMIN_USER_IDS: process.env.ADMIN_USER_IDS,
    ADMIN_EMAILS: process.env.ADMIN_EMAILS,
    UPLOAD_USER_RATE_LIMIT: process.env.UPLOAD_USER_RATE_LIMIT,
    UPLOAD_IP_RATE_LIMIT: process.env.UPLOAD_IP_RATE_LIMIT,
  };

  const restoreEnv = () => {
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  };

  // Raise upload rate limit only for isolated test execution
  process.env.UPLOAD_USER_RATE_LIMIT = '100';
  process.env.UPLOAD_IP_RATE_LIMIT = '100';

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const ownerEmail = `owner_${suffix}@videorisk.test`;
    const ownerPassword = 'OwnerTestPassword!2026';
    const ownerSalt = crypto.randomBytes(16).toString('hex');
    const ownerHash = crypto.scryptSync(ownerPassword, ownerSalt, 64).toString('hex');

    // Create Free-plan owner account with exact 10 initial credits (mirroring real owner state)
    const ownerUser = await storage.users.createUser(ownerEmail, ownerHash, ownerSalt, 10, 'free');
    const customerEmail = `customer_${suffix}@videorisk.test`;
    const customerPassword = 'CustomerTestPassword!2026';
    const customerSalt = crypto.randomBytes(16).toString('hex');
    const customerHash = crypto.scryptSync(customerPassword, customerSalt, 64).toString('hex');
    const customerUser = await storage.users.createUser(customerEmail, customerHash, customerSalt, 2, 'free');

    const explicitAdminEmail = `explicit_admin_${suffix}@videorisk.test`;
    const explicitAdminUser = await storage.users.createUser(explicitAdminEmail, customerHash, customerSalt, 10, 'free');
    const explicitAdminToken = await storage.users.createSession(explicitAdminUser.id);

    // -------------------------------------------------------------------------
    // 1. FAIL-CLOSED OWNER & ADMIN AUTH UNIT + VALIDATOR CHECKS
    // -------------------------------------------------------------------------
    console.log('[1. Owner Identity, Fail-Closed Auth & Email-Only Rejection]');
    delete process.env.OWNER_USER_ID;
    delete process.env.ADMIN_USER_IDS;
    delete process.env.ADMIN_EMAILS;

    assert.strictEqual(getConfiguredOwnerUserId(process.env), null, 'Unset OWNER_USER_ID must fail closed to null');
    assert.strictEqual(isVerifiedOwnerUser(ownerUser, process.env), false, 'Owner check fails closed when OWNER_USER_ID unset');
    assert.strictEqual(isAuthorizedAdminUser(ownerUser, process.env), false, 'Admin check fails closed when unset');

    // Email address supplied as User ID must be rejected
    assert.strictEqual(isValidInternalUserId(ownerEmail), false, 'Email address rejected as internal User ID');
    assert.strictEqual(getConfiguredOwnerUserId({ OWNER_USER_ID: ownerEmail }), null, 'Email in OWNER_USER_ID fails closed');
    assert.strictEqual(
      isVerifiedOwnerUser({ id: ownerUser.id }, { OWNER_USER_ID: ownerEmail }),
      false,
      'OWNER_USER_ID containing email never authorizes'
    );
    assert.strictEqual(
      isAuthorizedAdminUser({ id: ownerEmail }, { ADMIN_USER_IDS: ownerEmail }),
      false,
      'ADMIN_USER_IDS containing email never authorizes'
    );
    assert.strictEqual(
      isAdminUser(ownerUser, { ADMIN_EMAILS: ownerEmail }),
      false,
      'ADMIN_EMAILS matching alone must NEVER grant Admin privileges'
    );

    // Validate-env rejects email addresses in OWNER_USER_ID / ADMIN_USER_IDS
    const badEnvOwner = validateBillingConfiguration('ci', {
      OWNER_USER_ID: 'kunnapatara@gmail.com',
      ADMIN_USER_IDS: 'admin@example.com',
    });
    assert.strictEqual(badEnvOwner.valid, false, 'validateBillingConfiguration rejects email in OWNER_USER_ID / ADMIN_USER_IDS');

    // -------------------------------------------------------------------------
    // 2. OWNER AUTHENTICATION, IDENTITY VERIFICATION & CREDIT PRESERVATION
    // -------------------------------------------------------------------------
    console.log('\n[2. Owner Authentication & Free Account / 10-Credit Preservation]');
    process.env.OWNER_USER_ID = ownerUser.id;
    assert.strictEqual(isVerifiedOwnerUser(ownerUser, process.env), true, 'Exact OWNER_USER_ID matches owner');
    assert.strictEqual(isVerifiedOwnerUser(customerUser, process.env), false, 'Different User ID rejected');
    // Email-only match with different ID must fail
    assert.strictEqual(
      isVerifiedOwnerUser({ id: customerUser.id }, { OWNER_USER_ID: ownerUser.id }),
      false,
      'Same email / wrong ID fails owner check'
    );

    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
    });
    assert.strictEqual(loginRes.status, 200, 'Owner logs in cleanly');
    const loginBody = await loginRes.json();
    const ownerToken = loginBody.token as string;
    assert.strictEqual(loginBody.user.id, ownerUser.id, 'Authenticated identity matches internal User ID');
    assert.strictEqual(loginBody.user.plan, 'free', 'Owner preserves Free plan');
    assert.strictEqual(loginBody.user.creditsRemaining, 10, 'Owner preserves existing 10 credits');
    assert.strictEqual(loginBody.user.ownerTestingMode, true, 'Server confirms ownerTestingMode=true');
    assert.strictEqual(loginBody.user.passwordHash, undefined, 'Password hash never exposed');
    assert.strictEqual(loginBody.user.salt, undefined, 'Salt never exposed');

    // Verify /api/user & /api/billing/summary reflect server-verified ownerTestingMode
    const meRes = await fetch(`${baseUrl}/user`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.strictEqual(meRes.status, 200);
    const meBody = await meRes.json();
    assert.strictEqual(meBody.ownerTestingMode, true);
    assert.strictEqual(meBody.plan, 'free');
    assert.strictEqual(meBody.creditsRemaining, 10);

    // Log in customer too
    const custLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: customerEmail, password: customerPassword }),
    });
    assert.strictEqual(custLoginRes.status, 200);
    const custLoginBody = await custLoginRes.json();
    const customerToken = custLoginBody.token as string;
    assert.strictEqual(custLoginBody.user.ownerTestingMode, false, 'Normal customer never receives ownerTestingMode');

    // -------------------------------------------------------------------------
    // 3. ADMIN AUTHORIZATION TESTS (401 / 403 / 200)
    // -------------------------------------------------------------------------
    console.log('\n[3. Admin Authorization Enforcement (401 / 403 / 200)]');
    // Unauthenticated -> 401
    assert.strictEqual((await fetch(`${baseUrl}/analytics/funnel`)).status, 401);
    assert.strictEqual((await fetch(`${baseUrl}/analytics/events`)).status, 401);

    // Ordinary customer -> 403
    assert.strictEqual(
      (await fetch(`${baseUrl}/analytics/funnel`, { headers: { Authorization: `Bearer ${customerToken}` } })).status,
      403
    );
    assert.strictEqual(
      (await fetch(`${baseUrl}/analytics/events`, { headers: { Authorization: `Bearer ${customerToken}` } })).status,
      403
    );

    // Email-only ADMIN_EMAILS set for customer/explicitAdmin must STILL return 403
    process.env.ADMIN_EMAILS = `${customerEmail},${explicitAdminEmail}`;
    assert.strictEqual(
      (await fetch(`${baseUrl}/analytics/funnel`, { headers: { Authorization: `Bearer ${customerToken}` } })).status,
      403,
      'ADMIN_EMAILS matching alone must return 403 for customer'
    );
    assert.strictEqual(
      (await fetch(`${baseUrl}/analytics/funnel`, { headers: { Authorization: `Bearer ${explicitAdminToken}` } })).status,
      403,
      'ADMIN_EMAILS matching alone must return 403 even for intended admin'
    );
    delete process.env.ADMIN_EMAILS;

    // Configured OWNER_USER_ID receives authorized Admin access (200)
    const ownerAdminFunnel = await fetch(`${baseUrl}/analytics/funnel`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.strictEqual(ownerAdminFunnel.status, 200, 'Configured OWNER_USER_ID receives 200 on /api/analytics/funnel');
    const ownerAdminEvents = await fetch(`${baseUrl}/analytics/events`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.strictEqual(ownerAdminEvents.status, 200, 'Configured OWNER_USER_ID receives 200 on /api/analytics/events');

    // Configured ADMIN_USER_IDS receives authorized Admin access (200)
    process.env.ADMIN_USER_IDS = explicitAdminUser.id;
    assert.strictEqual(
      (await fetch(`${baseUrl}/analytics/funnel`, { headers: { Authorization: `Bearer ${explicitAdminToken}` } })).status,
      200,
      'Explicit ADMIN_USER_IDS receives 200'
    );

    // Missing/invalid OWNER_USER_ID fails closed for owner too
    delete process.env.OWNER_USER_ID;
    assert.strictEqual(
      (await fetch(`${baseUrl}/analytics/funnel`, { headers: { Authorization: `Bearer ${ownerToken}` } })).status,
      403,
      'Owner loses Admin access when OWNER_USER_ID is unset (fail closed)'
    );
    assert.strictEqual(
      (await (await fetch(`${baseUrl}/user`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json()).ownerTestingMode,
      false,
      'OwnerTestingMode disables immediately when OWNER_USER_ID is unset'
    );
    process.env.OWNER_USER_ID = ownerUser.id;

    // -------------------------------------------------------------------------
    // 4. OWNER TESTING MODE: STANDARD, DEEP, DEMO, RE-SCAN, FAILURE, RETRY
    // -------------------------------------------------------------------------
    console.log('\n[4. Unlimited-Credit Owner Testing Mode Execution & Ledger Preservation]');
    const sampleMp4 = path.join(uploadDir, `owner_sample_${suffix}.mp4`);
    createValidTestMp4(sampleMp4, 2);
    createdFiles.push(sampleMp4);

    // Record upload owned by ownerUser
    const sampleSize = fs.statSync(sampleMp4).size;
    await storage.uploads.recordUpload({
      fileId: path.basename(sampleMp4),
      userId: ownerUser.id,
      filename: 'owner_sample.mp4',
      filePath: sampleMp4,
      fileSize: sampleSize,
      type: 'video',
      createdAt: new Date().toISOString(),
    });

    // Clear any leftover active/retryable rows from previous aborted runs in videorisk_test.db
    (storage as any).db.prepare(`DELETE FROM job_queue WHERE status IN ('QUEUED', 'RETRYABLE', 'RUNNING')`).run();

    // Dedicated worker with autoStart=false for deterministic job execution
    const orchestrator = new JobOrchestrator(storage, false);

    // 4a. Standard Scan via POST /api/scans -> creditsUsed=0, completes cleanly, 10 credits untouched
    const stdCreateRes = await fetch(`${baseUrl}/scans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        videoPath: sampleMp4,
        videoFilename: 'owner_sample.mp4',
        videoTitle: 'Owner Standard Scan Test',
        scanMode: 'standard',
      }),
    });
    assert.strictEqual(stdCreateRes.status, 201, 'Owner Standard Scan created cleanly');
    const stdScanJob = await stdCreateRes.json();
    assert.strictEqual(stdScanJob.creditsUsed, 0, 'Standard scan creditsUsed is 0 in Owner Testing Mode');

    const orchestratorWorkerId = (orchestrator as any).workerId;
    const stdQueueJob = await storage.queue.claimNextJob(orchestratorWorkerId, 60000);
    assert(stdQueueJob && stdQueueJob.scanId === stdScanJob.id);
    await orchestrator.executeJob(stdQueueJob);

    const stdCompleted = await storage.scans.getScan(stdScanJob.id);
    assert.strictEqual(stdCompleted?.status, 'COMPLETED', 'Owner Standard Scan completes pipeline');
    assert.strictEqual(stdCompleted?.creditsUsed, 0);
    assert.strictEqual(stdCompleted?.creditsDeducted, 0);
    const stdReport = await storage.scans.getReport(stdScanJob.id);
    assert(stdReport && stdReport.scanId === stdScanJob.id, 'Standard scan report generated');

    // 4b. Deep Scan via POST /api/scans -> creditsUsed=0, completes cleanly
    const deepCreateRes = await fetch(`${baseUrl}/scans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        videoPath: sampleMp4,
        videoFilename: 'owner_sample.mp4',
        videoTitle: 'Owner Deep Scan Test',
        scanMode: 'deep',
      }),
    });
    assert.strictEqual(deepCreateRes.status, 201, 'Owner Deep Scan created cleanly');
    const deepScanJob = await deepCreateRes.json();
    assert.strictEqual(deepScanJob.creditsUsed, 0);

    const deepQueueJob = await storage.queue.claimNextJob(orchestratorWorkerId, 60000);
    assert(deepQueueJob && deepQueueJob.scanId === deepScanJob.id);
    await orchestrator.executeJob(deepQueueJob);
    const deepCompleted = await storage.scans.getScan(deepScanJob.id);
    assert.strictEqual(deepCompleted?.status, 'COMPLETED', 'Owner Deep Scan completes pipeline');
    assert.strictEqual(deepCompleted?.creditsUsed, 0);
    assert.strictEqual(deepCompleted?.creditsDeducted, 0);

    // 4c. Demo Scan via POST /api/scans/demo (Deep Mode) -> creditsUsed=0
    const demoCreateRes = await fetch(`${baseUrl}/scans/demo`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        demoType: 'problematic',
        scanMode: 'deep',
      }),
    });
    assert.strictEqual(demoCreateRes.status, 201, 'Owner Demo Scan created cleanly');
    const demoScanJob = await demoCreateRes.json();
    assert.strictEqual(demoScanJob.creditsUsed, 0);
    if (demoScanJob.videoPath) createdFiles.push(demoScanJob.videoPath);

    const demoQueueJob = await storage.queue.claimNextJob(orchestratorWorkerId, 60000);
    assert(demoQueueJob && demoQueueJob.scanId === demoScanJob.id);
    await orchestrator.executeJob(demoQueueJob);
    const demoCompleted = await storage.scans.getScan(demoScanJob.id);
    assert.strictEqual(demoCompleted?.status, 'COMPLETED');
    assert.strictEqual(demoCompleted?.creditsDeducted, 0);

    // 4d. Re-scan & Comparison via POST /api/scans/:id/rescan -> creditsUsed=0 & comparison saved
    const revisedMp4 = path.join(uploadDir, `owner_revised_${suffix}.mp4`);
    createValidTestMp4(revisedMp4, 2);
    createdFiles.push(revisedMp4);
    await storage.uploads.recordUpload({
      fileId: path.basename(revisedMp4),
      userId: ownerUser.id,
      filename: 'owner_revised.mp4',
      filePath: revisedMp4,
      fileSize: fs.statSync(revisedMp4).size,
      type: 'video',
      createdAt: new Date().toISOString(),
    });

    const rescanRes = await fetch(`${baseUrl}/scans/${stdScanJob.id}/rescan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        videoPath: revisedMp4,
        videoFilename: 'owner_revised.mp4',
      }),
    });
    assert.strictEqual(rescanRes.status, 201, 'Owner Re-scan created cleanly');
    const rescanJob = await rescanRes.json();
    assert.strictEqual(rescanJob.creditsUsed, 0);

    const rescanQueueJob = await storage.queue.claimNextJob(orchestratorWorkerId, 60000);
    assert(rescanQueueJob && rescanQueueJob.scanId === rescanJob.id);
    await orchestrator.executeJob(rescanQueueJob);
    const rescanCompleted = await storage.scans.getScan(rescanJob.id);
    assert.strictEqual(rescanCompleted?.status, 'COMPLETED');
    assert.strictEqual(rescanCompleted?.creditsDeducted, 0);
    const compRes = await fetch(`${baseUrl}/scans/${rescanJob.id}/comparison`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.strictEqual(compRes.status, 200, 'Re-scan comparison available for owner');

    // 4e. Owner Scan even when duration/mode exceeds remaining credits (simulate 0-credit owner account in isolated InMemory & SQLite)
    const zeroCreditOwner = await storage.users.createUser(`zero_owner_${suffix}@videorisk.test`, ownerHash, ownerSalt, 0, 'free');
    const zeroOwnerToken = await storage.users.createSession(zeroCreditOwner.id);
    process.env.OWNER_USER_ID = zeroCreditOwner.id;
    const zeroOwnerSample = path.join(uploadDir, `zero_owner_sample_${suffix}.mp4`);
    createValidTestMp4(zeroOwnerSample, 2);
    createdFiles.push(zeroOwnerSample);
    await storage.uploads.recordUpload({
      fileId: path.basename(zeroOwnerSample),
      userId: zeroCreditOwner.id,
      filename: 'zero_owner_sample.mp4',
      filePath: zeroOwnerSample,
      fileSize: fs.statSync(zeroOwnerSample).size,
      type: 'video',
      createdAt: new Date().toISOString(),
    });
    const zeroOwnerScanRes = await fetch(`${baseUrl}/scans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${zeroOwnerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        videoPath: zeroOwnerSample,
        videoFilename: 'zero_owner_sample.mp4',
        scanMode: 'deep',
      }),
    });
    assert.strictEqual(zeroOwnerScanRes.status, 201, 'Owner with 0 credits still allowed Deep Scan in Owner Testing Mode');
    const zeroOwnerScan = await zeroOwnerScanRes.json();
    const zeroOwnerQ = await storage.queue.claimNextJob(orchestratorWorkerId, 60000);
    assert(zeroOwnerQ && zeroOwnerQ.scanId === zeroOwnerScan.id);
    await orchestrator.executeJob(zeroOwnerQ);
    const zeroOwnerUserAfter = await storage.users.getUser(zeroCreditOwner.id);
    assert.strictEqual(zeroOwnerUserAfter?.creditsRemaining, 0, 'Owner credits remain 0 (never negative or inflated)');
    process.env.OWNER_USER_ID = ownerUser.id;

    // 4f. Failed Owner Scan (terminal MediaInspectionError via corrupt video file)
    const corruptMp4 = path.join(uploadDir, `owner_corrupt_${suffix}.mp4`);
    fs.writeFileSync(corruptMp4, 'NOT_A_VALID_MP4_CONTAINER');
    createdFiles.push(corruptMp4);
    await storage.uploads.recordUpload({
      fileId: path.basename(corruptMp4),
      userId: ownerUser.id,
      filename: 'owner_corrupt.mp4',
      filePath: corruptMp4,
      fileSize: fs.statSync(corruptMp4).size,
      type: 'video',
      createdAt: new Date().toISOString(),
    });

    const failScanId = `scan_owner_fail_${suffix}`;
    await storage.scans.createScan({
      id: failScanId,
      userId: ownerUser.id,
      videoTitle: 'Corrupt Owner Video',
      videoFilename: 'owner_corrupt.mp4',
      videoPath: corruptMp4,
      scanMode: 'deep',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
    });
    const failQ = await storage.queue.claimNextJob(orchestratorWorkerId, 60000);
    assert(failQ && failQ.scanId === failScanId);
    await orchestrator.executeJob(failQ);
    const failedOwnerScan = await storage.scans.getScan(failScanId);
    assert.strictEqual(failedOwnerScan?.status, 'FAILED');
    assert.strictEqual(failedOwnerScan?.creditsRefunded, false, 'No fake refund on failed owner testing scan');
    assert.strictEqual(failedOwnerScan?.creditsRefundedAmount, 0);

    // 4g. Retried Owner Scan (attempt 1 transient fail -> retry -> attempt 2 success) -> 0 deductions
    const { audioProcessor: realAudioProcessor } = await import('../src/server/pipeline/audioProcessor');
    let retryAttemptCount = 0;
    const retryOrchestrator = new JobOrchestrator(storage, false, {
      audioProcessor: {
        analyzeAudio: async (videoPath, mediaMetadata, durationSeconds) => {
          retryAttemptCount++;
          if (retryAttemptCount === 1) {
            throw new Error('Simulated transient pipeline failure for retry test');
          }
          return realAudioProcessor.analyzeAudio(videoPath, mediaMetadata, durationSeconds);
        },
      },
    });
    const retryScanId = `scan_owner_retry_${suffix}`;
    await storage.scans.createScan({
      id: retryScanId,
      userId: ownerUser.id,
      videoTitle: 'Retry Owner Video',
      videoFilename: 'owner_sample.mp4',
      videoPath: sampleMp4,
      scanMode: 'deep',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
    });
    const retryWorkerId = (retryOrchestrator as any).workerId;
    const retryQ1 = await storage.queue.claimNextJob(retryWorkerId, 60000);
    assert(retryQ1 && retryQ1.scanId === retryScanId);
    await retryOrchestrator.executeJob(retryQ1);
    const afterAttempt1 = await storage.scans.getScan(retryScanId);
    assert.strictEqual(afterAttempt1?.status, 'QUEUED', 'Attempt 1 transitions back to QUEUED for retry');

    // Make job immediately runnable for deterministic attempt 2
    (storage as any).db.prepare(`UPDATE job_queue SET run_at = ? WHERE scan_id = ?`).run(new Date(Date.now() - 1000).toISOString(), retryScanId);
    const retryQ2 = await storage.queue.claimNextJob(retryWorkerId, 60000);
    assert(retryQ2 && retryQ2.scanId === retryScanId);
    await retryOrchestrator.executeJob(retryQ2);
    const afterAttempt2 = await storage.scans.getScan(retryScanId);
    assert.strictEqual(afterAttempt2?.status, 'COMPLETED', 'Attempt 2 completes successfully');

    // Verify owner final state & Credit Activity Ledger integrity
    const ownerAfterAll = await storage.users.getUser(ownerUser.id);
    assert.strictEqual(ownerAfterAll?.plan, 'free', 'Owner Free plan untouched');
    assert.strictEqual(ownerAfterAll?.creditsRemaining, 10, 'Owner 10 credits completely untouched after all test runs');
    assert.strictEqual(ownerAfterAll?.creditsUsedTotal, 0, 'Owner creditsUsedTotal remains 0');
    const ownerLedger = await storage.billing.getCreditTransactions(ownerUser.id);
    assert.strictEqual(ownerLedger.length, 1, 'Owner ledger has ONLY the original INITIAL_GRANT transaction');
    assert.strictEqual(ownerLedger[0].type, 'INITIAL_GRANT');
    assert.strictEqual(ownerLedger[0].delta, 10);

    // 4h. Verify InMemoryStorageRepository parity (no deduction & no fake hintAmount refund)
    const memEnv = { ...process.env };
    const memRepoWithEnv = new InMemoryStorageRepository(path.join(tempDir, 'owner_mem2.json'), memEnv);
    const memOwner2 = await memRepoWithEnv.users.createUser(`mem_owner2_${suffix}@videorisk.test`, ownerHash, ownerSalt, 10, 'free');
    await memRepoWithEnv.users.updateUser(memOwner2.id, { plan: 'free' });
    // Create matching owner ID in memRepoWithEnv by forcing env to memOwner2.id
    memEnv.OWNER_USER_ID = memOwner2.id;
    await memRepoWithEnv.scans.createScan({
      id: 'mem_owner_scan_1',
      userId: memOwner2.id,
      videoTitle: 'Mem Owner Scan',
      videoFilename: 'mem.mp4',
      videoPath: sampleMp4,
      scanMode: 'deep',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
    });
    const memDeductOk = await memRepoWithEnv.scans.deductScanCredits('mem_owner_scan_1', memOwner2.id, 10, { systemBypass: true });
    assert.strictEqual(memDeductOk, true);
    const memRefundRes = await memRepoWithEnv.scans.refundScanCredits('mem_owner_scan_1', 10, { systemBypass: true });
    assert.strictEqual(memRefundRes.refunded, false, 'InMemory owner testing scan never issues fake refund');
    assert.strictEqual((await memRepoWithEnv.users.getUser(memOwner2.id))?.creditsRemaining, 10);

    // -------------------------------------------------------------------------
    // 5. NORMAL CUSTOMER ISOLATION & SPOOFING PROTECTION
    // -------------------------------------------------------------------------
    console.log('\n[5. Normal Customer Credit Deduction, Exhaustion Blocking & Spoofing Defense]');
    const custMp4 = path.join(uploadDir, `cust_sample_${suffix}.mp4`);
    createValidTestMp4(custMp4, 2);
    createdFiles.push(custMp4);
    await storage.uploads.recordUpload({
      fileId: path.basename(custMp4),
      userId: customerUser.id,
      filename: 'cust_sample.mp4',
      filePath: custMp4,
      fileSize: fs.statSync(custMp4).size,
      type: 'video',
      createdAt: new Date().toISOString(),
    });

    // Spoofing attempts by customer via body flags, query params, and headers MUST NOT bypass credit deduction
    const spoofDeepRes = await fetch(`${baseUrl}/scans?ownerTestingMode=true&isOwner=1`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
        'x-owner-testing': 'true',
      },
      body: JSON.stringify({
        videoPath: custMp4,
        videoFilename: 'cust_sample.mp4',
        videoTitle: 'Customer Spoof Attempt',
        scanMode: 'deep',
        isOwner: true,
        ownerTestingMode: true,
        creditsUsed: 0,
      }),
    });
    assert.strictEqual(spoofDeepRes.status, 201, 'Customer with 2 credits can run 2-credit deep scan');
    const spoofDeepJob = await spoofDeepRes.json();
    assert.strictEqual(spoofDeepJob.creditsUsed, 2, 'Customer scan MUST charge 2 credits despite spoofed body/query/header flags');

    const custQ = await storage.queue.claimNextJob(orchestratorWorkerId, 60000);
    assert(custQ && custQ.scanId === spoofDeepJob.id);
    await orchestrator.executeJob(custQ);

    const custAfter = await storage.users.getUser(customerUser.id);
    assert.strictEqual(custAfter?.creditsRemaining, 0, 'Customer credits deducted from 2 -> 0');
    assert.strictEqual(custAfter?.creditsUsedTotal, 2);
    const custLedger = await storage.billing.getCreditTransactions(customerUser.id);
    assert(custLedger.some((tx) => tx.type === 'SCAN_DEDUCTION' && tx.delta === -2), 'Customer ledger recorded SCAN_DEDUCTION');

    // Attempted userId spoofing -> 403
    const spoofOwnerIdRes = await fetch(`${baseUrl}/scans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: ownerUser.id,
        videoPath: custMp4,
        videoFilename: 'cust_sample.mp4',
        scanMode: 'standard',
      }),
    });
    assert.strictEqual(spoofOwnerIdRes.status, 403, 'Spoofing owner userId in body rejected with 403');

    // Now customer has 0 credits -> Standard, Demo, and Re-scan ALL blocked with 402
    const exhaustedScanRes = await fetch(`${baseUrl}/scans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        videoPath: custMp4,
        videoFilename: 'cust_sample.mp4',
        scanMode: 'standard',
        isOwner: true,
        ownerTestingMode: true,
      }),
    });
    assert.strictEqual(exhaustedScanRes.status, 402, 'Exhausted customer blocked with 402 on POST /api/scans');

    const exhaustedDemoRes = await fetch(`${baseUrl}/scans/demo`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ demoType: 'problematic', scanMode: 'standard', ownerTestingMode: true }),
    });
    assert.strictEqual(exhaustedDemoRes.status, 402, 'Exhausted customer blocked with 402 on POST /api/scans/demo');

    const exhaustedRescanRes = await fetch(`${baseUrl}/scans/${spoofDeepJob.id}/rescan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ videoPath: custMp4, videoFilename: 'cust_sample.mp4', ownerTestingMode: true }),
    });
    assert.strictEqual(exhaustedRescanRes.status, 402, 'Exhausted customer blocked with 402 on POST /api/scans/:id/rescan');

    // Verify sanitizeUser never trusts injected client properties on user object
    const spoofedSafeUser = sanitizeUser({ ...customerUser, ownerTestingMode: true } as any, process.env);
    assert.strictEqual(spoofedSafeUser.ownerTestingMode, false, 'sanitizeUser overwrites spoofed ownerTestingMode');

    console.log('\n✅ ALL OWNER IDENTITY, ADMIN AUTH & OWNER TESTING MODE TESTS PASSED!');
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
  process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('tests', 'owner_testing_and_admin_auth.test.ts'));
if (isDirectExecution) {
  runOwnerTestingAndAdminAuthTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ OWNER TESTING & ADMIN AUTH TEST FAILED:', err);
      process.exit(1);
    });
}
