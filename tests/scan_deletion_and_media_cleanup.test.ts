import assert from 'assert';
import path from 'path';
import fs from 'fs';
import express from 'express';
import { apiRouter } from '../src/server/routes/api';
import { storage } from '../src/server/storage';
import { validateBillingConfiguration, maskSecret, INTENDED_PLANS } from '../scripts/validate-env';
import { ScanJob } from '../src/types';

export async function runScanDeletionAndMediaCleanupTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 11: SCAN DELETION & BILLING VALIDATION ---');
  console.log('======================================================');

  const tempDir = path.resolve(process.cwd(), `tmp_cleanup_test_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const tempUploads = path.resolve(process.cwd(), 'uploads');
  const tempProxies = path.resolve(tempUploads, 'proxies');
  fs.mkdirSync(tempProxies, { recursive: true });

  const app = express();
  app.use(express.json());
  app.use(apiRouter);

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // ---------------------------------------------------------
    // Setup test users
    // ---------------------------------------------------------
    const userA = await storage.users.createUser(
      `user_a_${Date.now()}@example.com`,
      'hashA',
      undefined,
      30,
      'creator'
    );
    const sessionTokenA = await storage.users.createSession(userA.id);

    const userB = await storage.users.createUser(
      `user_b_${Date.now()}@example.com`,
      'hashB',
      undefined,
      30,
      'creator'
    );
    const sessionTokenB = await storage.users.createSession(userB.id);

    // ---------------------------------------------------------
    // Test 1: Successful deletion removes unshared media & proxy & purges DB
    // ---------------------------------------------------------
    console.log('[Test 1: Successful Deletion & File Cleanup]');
    const fileA1 = path.join(tempUploads, `test_video_a1_${Date.now()}.mp4`);
    const proxyA1 = path.join(tempProxies, `proxy_test_video_a1_${Date.now()}.mp4`);
    const thumbA1 = path.join(tempUploads, `thumb_a1_${Date.now()}.jpg`);
    fs.writeFileSync(fileA1, 'MOCK_VIDEO_DATA_A1');
    fs.writeFileSync(proxyA1, 'MOCK_PROXY_DATA_A1');
    fs.writeFileSync(thumbA1, 'MOCK_THUMB_DATA_A1');

    const scanId1 = `scan_test1_${Date.now()}`;
    await storage.scans.createScan({
      id: scanId1,
      userId: userA.id,
      videoTitle: 'Test Video 1',
      videoFilename: 'test1.mp4',
      videoPath: fileA1,
      proxyPath: proxyA1,
      thumbnailPath: thumbA1,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Media inspection', 'Risk report'],
      creditsUsed: 10,
      createdAt: new Date().toISOString(),
    });

    const delRes1 = await fetch(`${baseUrl}/scans/${scanId1}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionTokenA}` },
    });
    if (delRes1.status !== 200) {
      const errText = await delRes1.text();
      console.error(`DELETE failed with status ${delRes1.status}:`, errText);
    }
    assert.strictEqual(delRes1.status, 200, 'DELETE /scans/:id returns 200 OK');
    const delData1 = await delRes1.json();
    assert.strictEqual(delData1.success, true, 'Scan deleted successfully');
    assert.strictEqual(delData1.deletedScanId, scanId1, 'Deleted scan ID matches');
    assert(delData1.filesRemoved >= 2, 'Files were removed from disk');

    assert(!fs.existsSync(fileA1), 'Original video file removed from disk');
    assert(!fs.existsSync(proxyA1), 'Proxy file removed from disk');
    assert(!fs.existsSync(thumbA1), 'Thumbnail file removed from disk');

    const scanInDb1 = await storage.scans.getScan(scanId1);
    assert.strictEqual(scanInDb1, null, 'Scan record completely purged from database');
    console.log('  ✅ PASS: Unshared media, proxy, and thumbnail files safely removed; DB purged.');

    // ---------------------------------------------------------
    // Test 2: Missing files handled idempotently
    // ---------------------------------------------------------
    console.log('[Test 2: Missing Files Idempotency]');
    const missingFilePath = path.join(tempUploads, `missing_${Date.now()}.mp4`);
    const scanId2 = `scan_test2_${Date.now()}`;
    await storage.scans.createScan({
      id: scanId2,
      userId: userA.id,
      videoTitle: 'Missing File Video',
      videoFilename: 'missing.mp4',
      videoPath: missingFilePath,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
    });

    const delRes2 = await fetch(`${baseUrl}/scans/${scanId2}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionTokenA}` },
    });
    assert.strictEqual(delRes2.status, 200, 'DELETE succeeds when media file is already absent');
    const delData2 = await delRes2.json();
    assert.strictEqual(delData2.success, true, 'Returns success: true for missing files');
    console.log('  ✅ PASS: Missing media files handled idempotently without error.');

    // ---------------------------------------------------------
    // Test 3: Ownership violation blocked
    // ---------------------------------------------------------
    console.log('[Test 3: Ownership Enforcement]');
    const fileUserA = path.join(tempUploads, `userA_private_${Date.now()}.mp4`);
    fs.writeFileSync(fileUserA, 'USER_A_PRIVATE_MEDIA');
    const scanId3 = `scan_test3_${Date.now()}`;
    await storage.scans.createScan({
      id: scanId3,
      userId: userA.id,
      videoTitle: 'User A Private Scan',
      videoFilename: 'private.mp4',
      videoPath: fileUserA,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
    });

    // User B tries to delete User A's scan
    const delRes3 = await fetch(`${baseUrl}/scans/${scanId3}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionTokenB}` },
    });
    assert.strictEqual(delRes3.status, 403, 'User B cannot delete User A scan (403 Forbidden)');
    assert(fs.existsSync(fileUserA), 'File remains untouched on disk after unauthorized attempt');
    const scanStillExists = await storage.scans.getScan(scanId3);
    assert(scanStillExists !== null, 'Scan record preserved in DB after unauthorized attempt');
    console.log('  ✅ PASS: Ownership violation strictly returns 403; files and DB preserved.');

    // ---------------------------------------------------------
    // Test 4: Active Running Job Protection
    // ---------------------------------------------------------
    console.log('[Test 4: Active Running Job Protection]');
    const fileRunning = path.join(tempUploads, `running_${Date.now()}.mp4`);
    fs.writeFileSync(fileRunning, 'RUNNING_VIDEO_DATA');
    const scanId4 = `scan_running_${Date.now()}`;
    await storage.scans.createScan({
      id: scanId4,
      userId: userA.id,
      videoTitle: 'Actively Running Scan',
      videoFilename: 'running.mp4',
      videoPath: fileRunning,
      scanMode: 'standard',
      status: 'PROCESSING_VIDEO',
      currentStage: 'Scene analysis',
      completedStages: ['Upload', 'Media inspection'],
      creditsUsed: 10,
      createdAt: new Date().toISOString(),
    });
    // Add active job in queue and ensure it is claimed as RUNNING
    await storage.queue.enqueueJob(scanId4);
    let claimedJob: any = null;
    for (let i = 0; i < 10; i++) {
      const next = await storage.queue.claimNextJob('test_worker', 60000);
      if (!next) break;
      if (next.scanId === scanId4) {
        claimedJob = next;
        break;
      }
    }
    assert(claimedJob !== null && claimedJob.scanId === scanId4, 'Job claimed and marked RUNNING');

    const delRes4 = await fetch(`${baseUrl}/scans/${scanId4}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionTokenA}` },
    });
    assert.strictEqual(delRes4.status, 409, 'Cannot delete scan while actively running (409 Conflict)');
    assert(fs.existsSync(fileRunning), 'Active job media file is protected on disk');
    console.log('  ✅ PASS: Active running job blocks scan deletion with 409 Conflict.');

    // Complete the running job so it cleanups
    await storage.queue.completeJob(claimedJob.id, 'test_worker', claimedJob.leaseToken!);

    // ---------------------------------------------------------
    // Test 5: Unsafe path rejection (directory traversal)
    // ---------------------------------------------------------
    console.log('[Test 5: Unsafe Path Traversal Rejection]');
    const scanId5 = `scan_traversal_${Date.now()}`;
    await storage.scans.createScan({
      id: scanId5,
      userId: userA.id,
      videoTitle: 'Malicious Traversal Scan',
      videoFilename: 'passwd.mp4',
      videoPath: path.resolve(tempDir, '../../../etc/passwd'),
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
    });

    const delRes5 = await fetch(`${baseUrl}/scans/${scanId5}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionTokenA}` },
    });
    assert.strictEqual(delRes5.status, 400, 'Unsafe path rejected with 400 Bad Request');
    console.log('  ✅ PASS: Directory traversal path rejected before any deletion.');

    // ---------------------------------------------------------
    // Test 6: Duplicate deletion requests
    // ---------------------------------------------------------
    console.log('[Test 6: Duplicate Deletion Returns 404]');
    const delRes6 = await fetch(`${baseUrl}/scans/${scanId1}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionTokenA}` },
    });
    assert.strictEqual(delRes6.status, 404, 'Second delete returns 404 Not Found');
    console.log('  ✅ PASS: Duplicate deletion request returns 404 Not Found.');

    // ---------------------------------------------------------
    // Test 7: Protection against deleting shared files across scans
    // ---------------------------------------------------------
    console.log('[Test 7: Protection for Shared Media Files Across Scans]');
    const sharedFile = path.join(tempUploads, `shared_media_${Date.now()}.mp4`);
    fs.writeFileSync(sharedFile, 'SHARED_VIDEO_DATA');

    const scanParentId = `scan_parent_${Date.now()}`;
    const scanChildId = `scan_child_${Date.now()}`;

    // Scan A (original) uses sharedFile
    await storage.scans.createScan({
      id: scanParentId,
      userId: userA.id,
      videoTitle: 'Original Scan',
      videoFilename: 'original.mp4',
      videoPath: sharedFile,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 10,
      createdAt: new Date().toISOString(),
    });

    // Scan B (re-scan) also references sharedFile
    await storage.scans.createScan({
      id: scanChildId,
      userId: userA.id,
      videoTitle: 'Re-Scan referencing same video',
      videoFilename: 'rescan.mp4',
      videoPath: sharedFile,
      parentScanId: scanParentId,
      isRescan: true,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 10,
      createdAt: new Date().toISOString(),
    });

    // Delete Scan A
    const delParentRes = await fetch(`${baseUrl}/scans/${scanParentId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionTokenA}` },
    });
    assert.strictEqual(delParentRes.status, 200, 'Parent scan deleted');

    // Crucial assertion: shared file MUST NOT have been unlinked!
    assert(fs.existsSync(sharedFile), 'Shared file remains intact on disk because Scan B still references it');
    const parentInDb = await storage.scans.getScan(scanParentId);
    assert.strictEqual(parentInDb, null, 'Parent scan removed from DB');
    const childInDb = await storage.scans.getScan(scanChildId);
    assert(childInDb !== null, 'Child scan remains intact in DB');

    // Now delete Scan B
    const delChildRes = await fetch(`${baseUrl}/scans/${scanChildId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionTokenA}` },
    });
    assert.strictEqual(delChildRes.status, 200, 'Child scan deleted');
    assert(!fs.existsSync(sharedFile), 'Shared file is now deleted once no other scan references it');
    console.log('  ✅ PASS: Shared media files preserved until all dependent scans are removed.');

    // ---------------------------------------------------------
    // Test 8: Cleanup failure keeps DB record in CLEANUP_PENDING state
    // ---------------------------------------------------------
    console.log('[Test 8: Cleanup Failure Handling & Recoverable State]');
    const failScanFile = path.join(tempUploads, `fail_cleanup_${Date.now()}.mp4`);
    fs.writeFileSync(failScanFile, 'FAIL_CLEANUP_DATA');

    const scanFailId = `scan_fail_${Date.now()}`;
    await storage.scans.createScan({
      id: scanFailId,
      userId: userA.id,
      videoTitle: 'Fail Cleanup Video',
      videoFilename: 'fail.mp4',
      videoPath: failScanFile,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload'],
      creditsUsed: 10,
      createdAt: new Date().toISOString(),
    });

    // Mock fs.unlinkSync to throw an EACCES / EBUSY error on this specific file
    const originalUnlinkSync = fs.unlinkSync;
    fs.unlinkSync = ((targetPath: fs.PathLike) => {
      if (String(targetPath) === failScanFile) {
        const err: any = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return originalUnlinkSync(targetPath);
    }) as any;

    try {
      const delFailRes = await fetch(`${baseUrl}/scans/${scanFailId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${sessionTokenA}` },
      });
      if (delFailRes.status !== 500) {
        const t = await delFailRes.text();
        console.error('Test 8 unexpected status:', delFailRes.status, t);
      }
      assert.strictEqual(delFailRes.status, 500, 'Deletion returns 500 when filesystem cleanup fails');
      const failJson = await delFailRes.json();
      assert(!failJson.error.includes('/'), 'Error message does not leak raw filesystem path');

      // Crucial: Scan record must NOT be deleted from DB!
      const preservedScan = await storage.scans.getScan(scanFailId);
      assert(preservedScan !== null, 'Scan record preserved in database for recovery');
      assert.strictEqual(preservedScan?.status, 'CLEANUP_PENDING', 'Scan transitioned to CLEANUP_PENDING');
      assert(fs.existsSync(failScanFile), 'File remains on disk pending recovery');
      console.log('  ✅ PASS: Filesystem cleanup failure preserves DB record with CLEANUP_PENDING status.');
    } finally {
      // Restore original unlinkSync
      fs.unlinkSync = originalUnlinkSync;
      // Clean up the file
      if (fs.existsSync(failScanFile)) fs.unlinkSync(failScanFile);
      await storage.scans.deleteScan(scanFailId);
    }

    // ---------------------------------------------------------
    // Test 9: Billing Environment Configuration Validator Unit Tests
    // ---------------------------------------------------------
    console.log('\n[Test 9: Billing Configuration Validation Engine]');

    // 9a. Production mode missing STRIPE_SECRET_KEY
    const prodMissingRes = validateBillingConfiguration('production', {
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: '',
    });
    assert.strictEqual(prodMissingRes.valid, false, 'Production mode invalid when key is missing');
    assert(prodMissingRes.issues.some(i => i.variable === 'STRIPE_SECRET_KEY' && i.type === 'ERROR'), 'Reports ERROR for missing key');

    // 9b. Contradictory configuration: Test key in production mode
    const prodWithTestKey = validateBillingConfiguration('production', {
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_test_1234567890abcdef',
      STRIPE_WEBHOOK_SECRET: 'whsec_abcdef123456',
      STRIPE_PRICE_CREATOR: 'price_creator_test',
      STRIPE_PRICE_PRO: 'price_pro_test',
      STRIPE_PRICE_AGENCY: 'price_agency_test',
      STRIPE_PRICE_AUDIT_ONCE: 'price_audit_test',
    });
    assert.strictEqual(prodWithTestKey.valid, false, 'Contradictory test key in production rejected');
    assert(prodWithTestKey.issues.some(i => i.message.includes('Contradictory environment configuration')), 'Identifies test key in production');

    // 9c. Accidental live key in test mode
    const testWithLiveKey = validateBillingConfiguration('test', {
      NODE_ENV: 'test',
      STRIPE_SECRET_KEY: 'sk_live_1234567890abcdef',
    });
    assert.strictEqual(testWithLiveKey.valid, false, 'Live key in test mode rejected');
    assert(testWithLiveKey.issues.some(i => i.message.includes('Accidental live key')), 'Warns about live key in test mode');

    // 9d. Valid production configuration
    const prodValidRes = validateBillingConfiguration('production', {
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_prodkey123456789',
      STRIPE_WEBHOOK_SECRET: 'whsec_prodwebhook123456789',
      STRIPE_PRICE_CREATOR: 'price_creator_123',
      STRIPE_PRICE_PRO: 'price_pro_123',
      STRIPE_PRICE_AGENCY: 'price_agency_123',
      STRIPE_PRICE_AUDIT_ONCE: 'price_audit_123',
    });
    assert.strictEqual(prodValidRes.valid, true, 'Valid production billing configuration passes');
    assert.strictEqual(prodValidRes.errorsCount, 0, 'Zero errors in valid configuration');

    // 9e. Secret masking verifies no full secrets printed
    const masked = maskSecret('sk_live_998877665544332211');
    assert(!masked.includes('998877665544332211'), 'Full secret is never revealed');
    assert(masked.startsWith('sk_live_'), 'Masked string preserves prefix');
    assert(masked.includes('...'), 'Masked string contains ellipsis');

    // 9f. Intended plans and pricing integrity verified
    assert.strictEqual(INTENDED_PLANS.length, 5, '5 intended plans mapped');
    const creatorPlan = INTENDED_PLANS.find(p => p.id === 'creator');
    assert.strictEqual(creatorPlan?.priceUsd, 9, 'Creator is $9');
    assert.strictEqual(creatorPlan?.credits, 30, 'Creator is 30 credits');
    const proPlan = INTENDED_PLANS.find(p => p.id === 'pro');
    assert.strictEqual(proPlan?.priceUsd, 19, 'Pro is $19');
    assert.strictEqual(proPlan?.credits, 75, 'Pro is 75 credits');
    const agencyPlan = INTENDED_PLANS.find(p => p.id === 'agency');
    assert.strictEqual(agencyPlan?.priceUsd, 99, 'Agency is $99');
    assert.strictEqual(agencyPlan?.credits, 600, 'Agency is 600 credits');
    const auditPlan = INTENDED_PLANS.find(p => p.id === 'audit_once');
    assert.strictEqual(auditPlan?.priceUsd, 29, 'Audit is $29');
    assert.strictEqual(auditPlan?.credits, 60, 'Audit is 60 credits');
    console.log('  ✅ PASS: Billing validator accurately detects errors, malformations, and masks credentials.');

    console.log('======================================================');
    console.log('TEST SUITE 11 COMPLETE: All Deletion & Billing assertions passed!');
    console.log('======================================================');
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('scan_deletion_and_media_cleanup.test.ts')) {
  runScanDeletionAndMediaCleanupTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
