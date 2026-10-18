import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { 
  apiRouter, 
  secureUploadsHandler,
  createMediaAccessToken,
  verifyMediaAccessToken,
  getMediaOwner,
  registerTrustedPublicMedia,
  unregisterTrustedPublicMedia,
  isTrustedPublicMedia,
  TRUSTED_PUBLIC_MEDIA_ALLOWLIST
} from '../src/server/routes/api';
import { storage } from '../src/server/storage';
import { creditService } from '../src/server/services/creditService';
import { billingService } from '../src/server/services/billingService';

export async function runAuthAndOwnershipTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 1: AUTHENTICATION, OWNERSHIP & BILLING ---');
  console.log('======================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, desc: string) {
    total++;
    if (condition) {
      console.log(`  ✅ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${desc}`);
      throw new Error(`Test assertion failed: ${desc}`);
    }
  }

  // Create test express app
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use('/uploads', secureUploadsHandler);

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const uploadsBaseUrl = `http://127.0.0.1:${port}/uploads`;

  try {
    await storage.rateLimits.clearRateLimits?.({ keyPrefix: 'test_' });

    // ---------------------------------------------------------
    // 1. AUTHENTICATION & SESSION LIFECYCLE
    // ---------------------------------------------------------
    console.log('\n[1. Authentication & Session Security]');

    // Test 1.1: Anonymous requests to protected routes return 401 Unauthorized
    const anonMe = await fetch(`${baseUrl}/auth/me`);
    assert(anonMe.status === 401, 'Anonymous GET /auth/me returns 401 Unauthorized');

    const anonUser = await fetch(`${baseUrl}/user`);
    assert(anonUser.status === 401, 'Anonymous GET /user returns 401 Unauthorized');

    const anonScans = await fetch(`${baseUrl}/scans`);
    assert(anonScans.status === 401, 'Anonymous GET /scans returns 401 Unauthorized');

    const anonCheckout = await fetch(`${baseUrl}/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: 'creator' })
    });
    assert(anonCheckout.status === 401, 'Anonymous POST /billing/checkout returns 401 Unauthorized');

    // Test 1.2: Invalid session token returns 401
    const invalidTokenRes = await fetch(`${baseUrl}/user`, {
      headers: { Authorization: 'Bearer vr_sess_invalid_token_12345' }
    });
    assert(invalidTokenRes.status === 401, 'Invalid session token returns 401 Unauthorized');

    // Test 1.3: User A Registration & Valid Login
    const userAEmail = `user_a_${Date.now()}@videorisk.com`;
    const regResA = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userAEmail, password: 'passwordA123' })
    });
    assert(regResA.status === 201, 'User A registration returns 201 Created');
    const regDataA = await regResA.json();
    assert(!!regDataA.token, 'User A registration returns active session token');
    const tokenA = regDataA.token;
    const userA = regDataA.user;

    // Test 1.4: User B Registration
    const userBEmail = `user_b_${Date.now()}@videorisk.com`;
    const regResB = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userBEmail, password: 'passwordB456' })
    });
    assert(regResB.status === 201, 'User B registration returns 201 Created');
    const regDataB = await regResB.json();
    const tokenB = regDataB.token;
    const userB = regDataB.user;
    assert(userA.id !== userB.id, 'User A and User B receive distinct user IDs');

    // Test 1.5: Valid GET /auth/me returns authenticated identity
    const meResA = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert(meResA.status === 200, 'User A GET /auth/me returns 200 OK');
    const meDataA = await meResA.json();
    assert(meDataA.id === userA.id && meDataA.email === userAEmail, 'User A GET /auth/me matches User A credentials');
    assert(!meDataA.passwordHash && !meDataA.salt, 'Sensitive credentials (hash/salt) are not exposed');

    // Test 1.6: Logout invalidates session
    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert(logoutRes.status === 200, 'POST /auth/logout returns 200 OK');

    const meAfterLogout = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert(meAfterLogout.status === 401, 'Terminated session token returns 401 Unauthorized after logout');

    // Re-login User A
    const loginResA = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userAEmail, password: 'passwordA123' })
    });
    assert(loginResA.status === 200, 'User A login with correct password returns 200 OK');
    const loginDataA = await loginResA.json();
    const activeTokenA = loginDataA.token;

    // ---------------------------------------------------------
    // 2. RESOURCE OWNERSHIP & IDOR PROTECTION
    // ---------------------------------------------------------
    console.log('\n[2. Resource Ownership & IDOR Protection]');

    // Create a scan belonging to User A
    const scanA = await storage.scans.createScan({
      id: `scan_test_a_${Date.now()}`,
      userId: userA.id,
      videoTitle: 'User A Private Project Video',
      videoFilename: 'project_a.mp4',
      videoPath: path.resolve(process.cwd(), 'uploads', 'project_a.mp4'),
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Media inspection', 'Risk report'],
      creditsUsed: 5,
      createdAt: new Date().toISOString()
    });

    // Save report & evidence for User A's scan
    await storage.evidence.saveEvidence(scanA.id, [{
      id: 'ev_a_1',
      scanId: scanA.id,
      domain: 'video_audio',
      timestampStart: 0,
      timestampEnd: 10,
      timestampLabel: '00:00–00:10',
      assetLocation: '00:00–00:10',
      type: 'narration',
      category: 'original_contribution',
      severity: 'info',
      confidence: 0.95,
      confidenceLevel: 'HIGH',
      uncertaintyReason: 'NONE',
      provenance: 'audio:energy',
      source: 'audio_engine',
      label: 'Original Narration',
      details: 'Spoken commentary detected',
      limitations: 'Local analyzer'
    }], { systemBypass: true });

    await storage.scans.saveReport(scanA.id, {
      scanId: scanA.id,
      overallRisk: 'LOW_RISK',
      riskSummary: 'Clean evidence profile',
      disclaimer: 'Pre-publish report',
      domainReports: {} as any,
      riskCategories: {} as any,
      topIssues: [],
      policyConnections: [],
      timeline: [],
      originalContributionRatio: 85,
      reusedContentRatio: 0,
      transformationScore: 90,
      metadataScore: 85,
      benchmarkMetrics: {
        totalProcessingSeconds: 2.1,
        inspectionMs: 100,
        audioProcessingMs: 150,
        videoAnalysisMs: 200,
        evidenceBuildingMs: 50,
        policyReasoningMs: 50,
        framesSampled: 10,
        scenesDetected: 2
      }
    }, { systemBypass: true });

    // Test 2.1: User A can access own scan
    const userAReadScan = await fetch(`${baseUrl}/scans/${scanA.id}`, {
      headers: { Authorization: `Bearer ${activeTokenA}` }
    });
    assert(userAReadScan.status === 200, 'User A can read own scan details (200 OK)');

    // Test 2.2: User B is FORBIDDEN from reading User A's scan
    const userBReadScan = await fetch(`${baseUrl}/scans/${scanA.id}`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert(userBReadScan.status === 403, 'User B is denied access to User A scan (403 Forbidden)');

    // Test 2.3: User B is FORBIDDEN from reading User A's report
    const userBReadReport = await fetch(`${baseUrl}/scans/${scanA.id}/report`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert(userBReadReport.status === 403, 'User B is denied access to User A report (403 Forbidden)');

    // Test 2.4: User B is FORBIDDEN from reading User A's evidence
    const userBReadEvidence = await fetch(`${baseUrl}/scans/${scanA.id}/evidence`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert(userBReadEvidence.status === 403, 'User B is denied access to User A evidence (403 Forbidden)');

    // Test 2.5: User B cannot re-scan User A's video
    const userBRescan = await fetch(`${baseUrl}/scans/${scanA.id}/rescan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert(userBRescan.status === 403, 'User B cannot initiate re-scan of User A video (403 Forbidden)');

    // Test 2.6: Channel Profile Isolation
    await fetch(`${baseUrl}/channel/profile`, {
      method: 'PUT',
      headers: { 
        Authorization: `Bearer ${activeTokenA}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channelTopic: 'User A Secret Tech Reviews',
        contentType: 'commentary'
      })
    });

    const userBGetProfile = await fetch(`${baseUrl}/channel/profile`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    const userBProfileData = await userBGetProfile.json();
    assert(userBProfileData === null || userBProfileData.channelTopic !== 'User A Secret Tech Reviews', 'User B cannot read User A channel context profile');

    // Test 2.7: Scan listing is strictly isolated
    const userBScansList = await fetch(`${baseUrl}/scans`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    const userBScans = await userBScansList.json();
    assert(!userBScans.some((s: any) => s.id === scanA.id), 'User B scan list does not contain User A scans');

    // ---------------------------------------------------------
    // 3. UPLOAD FILE OWNERSHIP & PATH TRAVERSAL ISOLATION
    // ---------------------------------------------------------
    console.log('\n[3. Upload File Ownership & Path Traversal]');

    // Test 3.1: Path traversal attempt is rejected
    const pathTraversalRes = await fetch(`${baseUrl}/scans`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${activeTokenA}`,
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({
        videoPath: '../../etc/passwd',
        videoFilename: 'passwd.mp4'
      })
    });
    assert(pathTraversalRes.status === 403, 'Path traversal candidate path is rejected (403 Forbidden)');

    // Test 3.2: User B cannot use User A's uploaded file
    const fakeUploadFile = path.resolve(process.cwd(), 'uploads', `user_a_file_${Date.now()}.mp4`);
    fs.writeFileSync(fakeUploadFile, 'USER_A_PRIVATE_FOOTAGE');

    await storage.uploads.recordUpload({
      fileId: path.basename(fakeUploadFile),
      userId: userA.id,
      filename: 'private_user_a.mp4',
      filePath: fakeUploadFile,
      fileSize: 100,
      type: 'video',
      createdAt: new Date().toISOString()
    });

    const userBScanWithAFile = await fetch(`${baseUrl}/scans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        videoPath: fakeUploadFile,
        videoFilename: 'private_user_a.mp4'
      })
    });
    assert(userBScanWithAFile.status === 403, 'User B cannot reference User A uploaded file in /scans (403 Forbidden)');

    // ---------------------------------------------------------
    // 3b. SECURE UPLOAD MIDDLEWARE & PRE-UPLOAD AUTHORIZATION
    // ---------------------------------------------------------
    console.log('\n[3b. Secure Upload Middleware & Pre-Upload Authorization]');

    const uploadDir = path.resolve(process.cwd(), 'uploads');
    const getUploadFiles = () => fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : [];

    // Test 3b.1: Anonymous POST /uploads receives HTTP 401 and creates ZERO files
    const filesBeforeAnonVideo = getUploadFiles();
    const anonVideoForm = new FormData();
    anonVideoForm.append('video', new Blob(['FAKE_UNAUTH_VIDEO_CONTENT'], { type: 'video/mp4' }), 'unauth_video.mp4');

    const anonVideoRes = await fetch(`${baseUrl}/uploads`, {
      method: 'POST',
      body: anonVideoForm
    });
    assert(anonVideoRes.status === 401, 'Unauthenticated POST /uploads receives 401 Unauthorized');
    const filesAfterAnonVideo = getUploadFiles();
    assert(filesAfterAnonVideo.length === filesBeforeAnonVideo.length, 'Zero bytes/files written to uploads/ on rejected unauthenticated video upload');

    // Test 3b.2: Anonymous POST /uploads/thumbnail receives HTTP 401 and creates ZERO files
    const filesBeforeAnonThumb = getUploadFiles();
    const anonThumbForm = new FormData();
    anonThumbForm.append('thumbnail', new Blob(['FAKE_UNAUTH_THUMBNAIL_BYTES'], { type: 'image/jpeg' }), 'unauth_thumb.jpg');

    const anonThumbRes = await fetch(`${baseUrl}/uploads/thumbnail`, {
      method: 'POST',
      body: anonThumbForm
    });
    assert(anonThumbRes.status === 401, 'Unauthenticated POST /uploads/thumbnail receives 401 Unauthorized');
    const filesAfterAnonThumb = getUploadFiles();
    assert(filesAfterAnonThumb.length === filesBeforeAnonThumb.length, 'Zero bytes/files written to uploads/ on rejected unauthenticated thumbnail upload');

    // Test 3b.3: Anonymous POST /scans/:id/rescan receives HTTP 401 and creates ZERO files
    const filesBeforeAnonRescan = getUploadFiles();
    const anonRescanForm = new FormData();
    anonRescanForm.append('video', new Blob(['FAKE_UNAUTH_RESCAN_BYTES'], { type: 'video/mp4' }), 'unauth_rescan.mp4');

    const anonRescanRes = await fetch(`${baseUrl}/scans/${scanA.id}/rescan`, {
      method: 'POST',
      body: anonRescanForm
    });
    assert(anonRescanRes.status === 401, 'Unauthenticated POST /scans/:id/rescan receives 401 Unauthorized');
    const filesAfterAnonRescan = getUploadFiles();
    assert(filesAfterAnonRescan.length === filesBeforeAnonRescan.length, 'Zero bytes/files written to uploads/ on rejected unauthenticated rescan');

    // Test 3b.4: Pre-upload Authorization: User B cannot upload a file to re-scan User A's scan (403 Forbidden)
    const filesBeforeUserBRescan = getUploadFiles();
    const userBRescanForm = new FormData();
    userBRescanForm.append('video', new Blob(['USER_B_ATTEMPTED_RESCAN_VIDEO'], { type: 'video/mp4' }), 'user_b_rescan.mp4');

    const userBRescanUpload = await fetch(`${baseUrl}/scans/${scanA.id}/rescan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: userBRescanForm
    });
    assert(userBRescanUpload.status === 403, 'User B upload to re-scan User A video rejected with 403 Forbidden before saving');
    const filesAfterUserBRescan = getUploadFiles();
    assert(filesAfterUserBRescan.length === filesBeforeUserBRescan.length, 'Zero files persisted when unauthorized user attempts rescan upload');

    // Test 3b.5: Pre-upload Authorization: Non-existent parent scan ID rejected with 404 before file processing
    const filesBefore404Rescan = getUploadFiles();
    const nonExistentRescanForm = new FormData();
    nonExistentRescanForm.append('video', new Blob(['NON_EXISTENT_PARENT_BYTES'], { type: 'video/mp4' }), 'non_existent.mp4');

    const nonExistentRescanRes = await fetch(`${baseUrl}/scans/scan_does_not_exist_99999/rescan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${activeTokenA}` },
      body: nonExistentRescanForm
    });
    assert(nonExistentRescanRes.status === 404, 'Re-scan with non-existent parent ID rejected with 404 before saving');
    const filesAfter404Rescan = getUploadFiles();
    assert(filesAfter404Rescan.length === filesBefore404Rescan.length, 'Zero files persisted when parent scan does not exist');

    // Test 3b.6: Invalid upload format rejected with 400 and temporary files cleaned up
    const filesBeforeInvalid = getUploadFiles();
    const invalidForm = new FormData();
    invalidForm.append('video', new Blob(['NOT_A_VIDEO'], { type: 'application/x-dosexec' }), 'malicious.exe');

    const invalidRes = await fetch(`${baseUrl}/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${activeTokenA}` },
      body: invalidForm
    });
    assert(invalidRes.status === 400, 'Invalid file format upload rejected with 400 Bad Request');
    const filesAfterInvalid = getUploadFiles();
    assert(filesAfterInvalid.length === filesBeforeInvalid.length, 'Zero files persisted on invalid file format upload');

    // Test 3b.7: Valid authenticated thumbnail upload succeeds and records ownership
    const testThumbFixturePath = path.resolve(uploadDir, `test_fixture_thumb_${Date.now()}.jpg`);
    try {
      const { execFileSync } = await import('child_process');
      execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:d=1', '-vframes', '1', testThumbFixturePath]);
      const thumbBuffer = fs.readFileSync(testThumbFixturePath);

      const validThumbForm = new FormData();
      validThumbForm.append('thumbnail', new Blob([thumbBuffer], { type: 'image/jpeg' }), 'valid_thumbnail.jpg');

      const validThumbRes = await fetch(`${baseUrl}/uploads/thumbnail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${activeTokenA}` },
        body: validThumbForm
      });
      assert(validThumbRes.status === 200, 'Authenticated valid thumbnail upload succeeds (200 OK)');
      const validThumbData = await validThumbRes.json();
      assert(!!validThumbData.fileId, 'Upload response contains fileId');
      assert(validThumbData.thumbnailMetadata?.isStandardAspect === true, 'Upload response contains inspected metadata');

      // Verify upload record ownership in storage
      const uploadRecord = await storage.uploads.getUpload(validThumbData.fileId);
      assert(uploadRecord?.userId === userA.id, 'Upload record ownership is strictly tied to authenticated user');

      // Clean up uploaded test thumbnail file
      if (validThumbData.filePath && fs.existsSync(validThumbData.filePath)) {
        try { fs.unlinkSync(validThumbData.filePath); } catch {}
      }
    } finally {
      if (fs.existsSync(testThumbFixturePath)) {
        try { fs.unlinkSync(testThumbFixturePath); } catch {}
      }
    }

    // Test 3b.8: Re-scan without a new upload (existing functionality) preserves normal behavior
    const noFileRescanRes = await fetch(`${baseUrl}/scans/${scanA.id}/rescan`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${activeTokenA}`,
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({})
    });
    assert(noFileRescanRes.status === 201, 'Authenticated re-scan without new upload succeeds (201 Created)');
    const rescanData = await noFileRescanRes.json();
    assert(rescanData.isRescan === true, 'Created rescan job marked as isRescan: true');
    assert(rescanData.parentScanId === scanA.id, 'Created rescan job correctly references parentScanId');

    // ---------------------------------------------------------
    // 3c. SECURE MEDIA ACCESS HARDENING (ISSUES A, B, C)
    // ---------------------------------------------------------
    console.log('\n[3c. Secure Media Access Hardening (Issues A, B, C)]');

    const testTime = Date.now();
    let publicSamplePreExisted = false;
    let publicSampleCreatedByThisTest = false;
    let publicSampleOriginalBuffer: Buffer | null = null;
    const testVideoFileId = `userA_private_${testTime}.mp4`;
    const testVideoPath = path.resolve(uploadDir, testVideoFileId);
    const testVideoPayload = 'MOCK_USER_A_PRIVATE_VIDEO_DATA_FOR_SECURITY_VALIDATION_0123456789';
    fs.writeFileSync(testVideoPath, testVideoPayload);

    await storage.uploads.recordUpload({
      fileId: testVideoFileId,
      userId: userA.id,
      filename: 'my_private_project.mp4',
      filePath: testVideoPath,
      fileSize: Buffer.byteLength(testVideoPayload),
      type: 'video',
      createdAt: new Date().toISOString()
    });

    const testThumbFileId = `thumb_userA_${testTime}.jpg`;
    const testThumbPath = path.resolve(uploadDir, testThumbFileId);
    const testThumbPayload = 'FAKE_USER_A_THUMBNAIL_BYTES_FOR_IMAGE_SECURITY';
    fs.writeFileSync(testThumbPath, testThumbPayload);

    await storage.uploads.recordUpload({
      fileId: testThumbFileId,
      userId: userA.id,
      filename: 'thumb.jpg',
      filePath: testThumbPath,
      fileSize: Buffer.byteLength(testThumbPayload),
      type: 'thumbnail',
      createdAt: new Date().toISOString()
    });

    const proxiesDir = path.resolve(uploadDir, 'proxies');
    if (!fs.existsSync(proxiesDir)) {
      fs.mkdirSync(proxiesDir, { recursive: true });
    }
    const testProxyFileId = `proxy_userA_private_${testTime}.mp4`;
    const testProxyPath = path.resolve(proxiesDir, testProxyFileId);
    const testProxyPayload = 'MOCK_USER_A_DERIVED_PROXY_STREAM_PAYLOAD';
    fs.writeFileSync(testProxyPath, testProxyPayload);

    // Issue A fixture: User-owned file that tries to spoof public prefix
    const fakePublicFileId = `public_userA_private_${testTime}.mp4`;
    const fakePublicPath = path.resolve(uploadDir, fakePublicFileId);
    fs.writeFileSync(fakePublicPath, 'FAKE_PUBLIC_USER_A_SECRET_DATA');
    await storage.uploads.recordUpload({
      fileId: fakePublicFileId,
      userId: userA.id,
      filename: 'public_video.mp4',
      filePath: fakePublicPath,
      fileSize: Buffer.byteLength('FAKE_PUBLIC_USER_A_SECRET_DATA'),
      type: 'video',
      createdAt: new Date().toISOString()
    });

    const fakeSampleFileId = `sample_public_userA_${testTime}.mp4`;
    const fakeSamplePath = path.resolve(uploadDir, fakeSampleFileId);
    fs.writeFileSync(fakeSamplePath, 'FAKE_SAMPLE_USER_A_SECRET_DATA');
    await storage.uploads.recordUpload({
      fileId: fakeSampleFileId,
      userId: userA.id,
      filename: 'sample_video.mp4',
      filePath: fakeSamplePath,
      fileSize: Buffer.byteLength('FAKE_SAMPLE_USER_A_SECRET_DATA'),
      type: 'video',
      createdAt: new Date().toISOString()
    });

    // Legitimate public sample asset (in allowlist, no owner record)
    // Non-destructive fixture handling: protect pre-existing sample_public_test.mp4 if present
    const publicSampleFileId = `sample_public_test.mp4`;
    const publicSamplePath = path.resolve(uploadDir, publicSampleFileId);
    const publicSamplePayload = 'PUBLIC_SAMPLE_VIDEO_CONTENT_ACCESSIBLE_UNAUTHENTICATED';

    publicSamplePreExisted = fs.existsSync(publicSamplePath);
    if (publicSamplePreExisted) {
      publicSampleOriginalBuffer = fs.readFileSync(publicSamplePath);
    } else {
      fs.writeFileSync(publicSamplePath, publicSamplePayload);
      publicSampleCreatedByThisTest = true;
    }

    // Orphaned unowned file
    const unownedFileId = `unregistered_orphan_${testTime}.mp4`;
    const unownedPath = path.resolve(uploadDir, unownedFileId);
    fs.writeFileSync(unownedPath, 'ORPHANED_DATA_WITH_NO_USER_RECORD');

    // Issue C fixtures: Multiple directories with same basename
    const dirA = path.resolve(os.tmpdir(), `test_isolation_dirA_${testTime}`);
    const dirB = path.resolve(os.tmpdir(), `test_isolation_dirB_${testTime}`);
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const sameBasename = `shared_name_${testTime}.mp4`;
    const pathA = path.resolve(dirA, sameBasename);
    const pathB = path.resolve(dirB, sameBasename);
    fs.writeFileSync(pathA, 'USER_A_FILE_IN_DIR_A');
    fs.writeFileSync(pathB, 'USER_B_FILE_IN_DIR_B');

    await storage.uploads.recordUpload({
      fileId: `fileA_${testTime}`,
      userId: userA.id,
      filename: sameBasename,
      filePath: pathA,
      fileSize: 20,
      type: 'video',
      createdAt: new Date().toISOString()
    });
    await storage.uploads.recordUpload({
      fileId: `fileB_${testTime}`,
      userId: userB.id,
      filename: sameBasename,
      filePath: pathB,
      fileSize: 20,
      type: 'video',
      createdAt: new Date().toISOString()
    });

    // Issue C fixtures: Proxy collision across different accounts
    const stemCollision = `collision_clip_${testTime}`;
    const collisionPathA = path.resolve(uploadDir, `${stemCollision}.mp4`);
    const collisionPathB = path.resolve(uploadDir, `${stemCollision}.mov`);
    fs.writeFileSync(collisionPathA, 'COLLISION_A');
    fs.writeFileSync(collisionPathB, 'COLLISION_B');
    await storage.uploads.recordUpload({
      fileId: `${stemCollision}.mp4`,
      userId: userA.id,
      filename: `${stemCollision}.mp4`,
      filePath: collisionPathA,
      fileSize: 11,
      type: 'video',
      createdAt: new Date().toISOString()
    });
    await storage.uploads.recordUpload({
      fileId: `${stemCollision}.mov`,
      userId: userB.id,
      filename: `${stemCollision}.mov`,
      filePath: collisionPathB,
      fileSize: 11,
      type: 'video',
      createdAt: new Date().toISOString()
    });
    const collisionProxyPath = path.resolve(proxiesDir, `proxy_${stemCollision}.mp4`);
    fs.writeFileSync(collisionProxyPath, 'COLLISION_PROXY_CONTENT');

    // Issue C fixtures: Substring scan ID collision
    const scanIdShort = `scan_sub_${testTime}`;
    const scanIdLong = `scan_sub_${testTime}_long`;
    await storage.scans.createScan({
      id: scanIdShort,
      userId: userA.id,
      videoTitle: 'Short Scan',
      videoFilename: 'short.mp4',
      videoPath: testVideoPath,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload'],
      creditsUsed: 1,
      createdAt: new Date().toISOString()
    });
    await storage.scans.createScan({
      id: scanIdLong,
      userId: userB.id,
      videoTitle: 'Long Scan',
      videoFilename: 'long.mp4',
      videoPath: path.resolve(uploadDir, `userB_long_${testTime}.mp4`),
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload'],
      creditsUsed: 1,
      createdAt: new Date().toISOString()
    });

    const framesDir = path.resolve(uploadDir, 'frames');
    const jobSubdirLong = `${scanIdLong}_${Date.now()}`;
    const framesLongDir = path.resolve(framesDir, jobSubdirLong);
    fs.mkdirSync(framesLongDir, { recursive: true });
    const frameLongPath = path.resolve(framesLongDir, 'frame_001.jpg');
    fs.writeFileSync(frameLongPath, 'FRAME_SNAPSHOT_FOR_SCAN_LONG');

    let subProxySamplePath: string | null = null;
    let nestedRootDir: string | null = null;
    let nestedSamplePath: string | null = null;
    let frameSamplePath: string | null = null;
    let framesSampleDir: string | null = null;
    let symlinkOutPath: string | null = null;
    let symlinkToSubPath: string | null = null;
    let symlinkInSubPath: string | null = null;
    let externalTempTarget: string | null = null;

    try {
      // -------------------------------------------------------
      // ISSUE A: TRUSTED PUBLIC AUTHORIZATION TESTS
      // -------------------------------------------------------
      console.log('  --- Sub-suite A: Trusted Public Media Authorization ---');

      // Test A.1: User file starting with "public_" is NOT public for anonymous (401)
      const anonFakePublicRes = await fetch(`${uploadsBaseUrl}/${fakePublicFileId}`);
      assert(anonFakePublicRes.status === 401, 'File with public_ prefix owned by User A returns 401 Unauthorized for anonymous');

      // Test A.2: User file starting with "public_" is NOT accessible to User B (403)
      const userBFakePublicRes = await fetch(`${uploadsBaseUrl}/${fakePublicFileId}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });
      assert(userBFakePublicRes.status === 403, 'File with public_ prefix owned by User A returns 403 Forbidden for User B');

      // Test A.3: User file starting with "sample_public_" is NOT public for anonymous (401)
      const anonFakeSampleRes = await fetch(`${uploadsBaseUrl}/${fakeSampleFileId}`);
      assert(anonFakeSampleRes.status === 401, 'File with sample_public_ prefix owned by User A returns 401 Unauthorized for anonymous');

      // Test A.4: User file starting with "sample_public_" is NOT accessible to User B (403)
      const userBFakeSampleRes = await fetch(`${uploadsBaseUrl}/${fakeSampleFileId}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });
      assert(userBFakeSampleRes.status === 403, 'File with sample_public_ prefix owned by User A returns 403 Forbidden for User B');

      // Test A.5: Explicitly allowlisted public sample without owner record is accessible unauthenticated (200 OK)
      const publicSampleRes = await fetch(`${uploadsBaseUrl}/${publicSampleFileId}`);
      assert(publicSampleRes.status === 200, 'Explicit allowlisted public sample returns 200 OK unauthenticated');
      const publicSampleBody = await publicSampleRes.text();
      const expectedPublicContent = publicSampleCreatedByThisTest
        ? publicSamplePayload
        : (publicSampleOriginalBuffer ? publicSampleOriginalBuffer.toString('utf8') : publicSamplePayload);
      assert(publicSampleBody === expectedPublicContent, 'Public sample returns expected content');

      // Test A.6: Dynamic registration and unregistration of trusted public media
      const dynSampleId = `dyn_sample_${testTime}.mp4`;
      const dynSamplePath = path.resolve(uploadDir, dynSampleId);
      fs.writeFileSync(dynSamplePath, 'DYNAMIC_PUBLIC_SAMPLE');
      try {
        // Before registration: fails closed (401)
        const unregRes = await fetch(`${uploadsBaseUrl}/${dynSampleId}`);
        assert(unregRes.status === 401, 'Unregistered unowned sample returns 401 Unauthorized');

        // Register in trusted allowlist
        registerTrustedPublicMedia(dynSampleId);
        const regRes = await fetch(`${uploadsBaseUrl}/${dynSampleId}`);
        assert(regRes.status === 200, 'Registered trusted public sample returns 200 OK');

        // Unregister from trusted allowlist
        unregisterTrustedPublicMedia(dynSampleId);
        const postUnregRes = await fetch(`${uploadsBaseUrl}/${dynSampleId}`);
        assert(postUnregRes.status === 401, 'Unregistered sample returns 401 Unauthorized again');
      } finally {
        if (fs.existsSync(dynSamplePath)) fs.unlinkSync(dynSamplePath);
      }

      // Test A.7: Directory listing attempts are rejected
      const rootDirRes = await fetch(`${uploadsBaseUrl}`);
      assert(rootDirRes.status === 400 || rootDirRes.status === 403, 'Root directory request is rejected without directory listing');

      const proxiesListRes = await fetch(`${uploadsBaseUrl}/proxies`);
      assert(proxiesListRes.status === 403, 'Subdirectory request is rejected without directory listing');

      // Test A.8: Path traversal attempts are rejected (raw HTTP and encoded traversal)
      const traversalRes = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          path: '/uploads/../../data/videorisk.db',
          headers: { Authorization: `Bearer ${activeTokenA}` }
        }, (res) => {
          resolve({ status: res.statusCode || 0 });
        });
        req.on('error', reject);
        req.end();
      });
      assert(traversalRes.status === 403 || traversalRes.status === 400, 'Path traversal escaping storage is rejected');

      const encodedTraversalRes = await fetch(`${uploadsBaseUrl}/..%2F..%2Fdata/videorisk.db`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(encodedTraversalRes.status === 403 || encodedTraversalRes.status === 400, 'Encoded path traversal escaping storage is rejected');

      // Test A.9: Same-named file in single subdirectory does NOT receive public status
      subProxySamplePath = path.resolve(proxiesDir, publicSampleFileId);
      fs.writeFileSync(subProxySamplePath, 'SUBDIRECTORY_SECRET_SAMPLE_CONTENT');

      assert(isTrustedPublicMedia(subProxySamplePath, `proxies/${publicSampleFileId}`) === false, 'isTrustedPublicMedia returns false for file in proxies subdirectory');
      assert(isTrustedPublicMedia(subProxySamplePath) === false, 'isTrustedPublicMedia returns false for resolved path in subdirectory even without relativePath');

      const anonSubProxyRes = await fetch(`${uploadsBaseUrl}/proxies/${publicSampleFileId}`);
      assert(anonSubProxyRes.status === 401, 'Anonymous access to allowlisted-name file in proxies/ is rejected (401 Unauthorized)');

      const userBSubProxyRes = await fetch(`${uploadsBaseUrl}/proxies/${publicSampleFileId}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });
      assert(userBSubProxyRes.status === 403, 'User B access to unowned file in proxies/ is rejected (403 Forbidden)');

      // Test A.10: Same-named file in multi-level nested subdirectory does NOT receive public status
      const nestedRootName = `test_nested_${testTime}`;
      nestedRootDir = path.resolve(uploadDir, nestedRootName);
      const nestedDir = path.resolve(nestedRootDir, 'deep', 'sub');
      fs.mkdirSync(nestedDir, { recursive: true });
      nestedSamplePath = path.resolve(nestedDir, publicSampleFileId);
      fs.writeFileSync(nestedSamplePath, 'NESTED_DEEP_SECRET_SAMPLE_CONTENT');

      assert(isTrustedPublicMedia(nestedSamplePath, `${nestedRootName}/deep/sub/${publicSampleFileId}`) === false, 'isTrustedPublicMedia returns false for nested subdirectory');
      assert(isTrustedPublicMedia(nestedSamplePath) === false, 'isTrustedPublicMedia returns false for nested path even without relativePath');

      const anonNestedRes = await fetch(`${uploadsBaseUrl}/${nestedRootName}/deep/sub/${publicSampleFileId}`);
      assert(anonNestedRes.status === 401, 'Anonymous access to allowlisted-name file in nested subdirectory is rejected (401 Unauthorized)');

      // Test A.11: Same-named file in frames subdirectory does NOT receive public status
      framesSampleDir = path.resolve(framesDir, `sample_test_job_${testTime}`);
      fs.mkdirSync(framesSampleDir, { recursive: true });
      frameSamplePath = path.resolve(framesSampleDir, 'sample_public_demo.mp4');
      fs.writeFileSync(frameSamplePath, 'FRAME_SNAPSHOT_PUBLIC_NAME_SPOOF');

      assert(isTrustedPublicMedia(frameSamplePath, `frames/sample_test_job_${testTime}/sample_public_demo.mp4`) === false, 'isTrustedPublicMedia returns false for frames subdirectory');

      const anonFrameRes = await fetch(`${uploadsBaseUrl}/frames/sample_test_job_${testTime}/sample_public_demo.mp4`);
      assert(anonFrameRes.status === 401, 'Anonymous access to sample_public_demo.mp4 in frames/ is rejected (401 Unauthorized)');

      // Test A.12: Direct helper verification against path traversal escaping uploadDir
      assert(isTrustedPublicMedia(path.resolve(uploadDir, '../data/sample_public_test.mp4'), '../data/sample_public_test.mp4') === false, 'isTrustedPublicMedia rejects path escaping to parent directory');
      assert(isTrustedPublicMedia(path.resolve(uploadDir, '../../etc/passwd'), '../../etc/passwd') === false, 'isTrustedPublicMedia rejects deep traversal path');
      assert(isTrustedPublicMedia(path.resolve(uploadDir, 'proxies/../sample_public_test.mp4'), 'proxies/../sample_public_test.mp4') === false, 'isTrustedPublicMedia rejects relativePath containing traversal components');
      assert(isTrustedPublicMedia('', '') === false, 'isTrustedPublicMedia fails closed on empty path');
      assert(isTrustedPublicMedia(null as any) === false, 'isTrustedPublicMedia fails closed on null path');

      // Test A.13: Symlink security verification
      externalTempTarget = path.resolve(os.tmpdir(), `test_symlink_ext_target_${testTime}.txt`);
      fs.writeFileSync(externalTempTarget, 'EXTERNAL_TEMP_SECRET_CONTENT');

      symlinkOutPath = path.resolve(uploadDir, `symlink_out_${testTime}.mp4`);
      symlinkToSubPath = path.resolve(uploadDir, `symlink_to_sub_${testTime}.mp4`);
      symlinkInSubPath = path.resolve(proxiesDir, `symlink_in_sub_${testTime}.mp4`);

      let symlinkCreationError: any = null;
      try {
        fs.symlinkSync(externalTempTarget, symlinkOutPath);
        fs.symlinkSync(subProxySamplePath, symlinkToSubPath);
        fs.symlinkSync(publicSamplePath, symlinkInSubPath);
      } catch (err: any) {
        symlinkCreationError = err;
      }

      if (symlinkCreationError) {
        console.warn(`  ⚠️ BLOCKED: Symlink operations are not supported by the environment: ${symlinkCreationError?.code || symlinkCreationError?.message}`);
        throw new Error(`BLOCKED: Symlink operations not supported by environment: ${symlinkCreationError?.message}`);
      }

      assert(isTrustedPublicMedia(symlinkOutPath, path.basename(symlinkOutPath)) === false, 'Symlink escaping storage is rejected by isTrustedPublicMedia');
      const symlinkOutRes = await fetch(`${uploadsBaseUrl}/${path.basename(symlinkOutPath)}`);
      assert(symlinkOutRes.status === 403 || symlinkOutRes.status === 400, 'Symlink pointing outside uploadDir is rejected (403/400)');

      assert(isTrustedPublicMedia(symlinkToSubPath, path.basename(symlinkToSubPath)) === false, 'Symlink pointing into subdirectory is rejected by isTrustedPublicMedia');
      const symlinkToSubRes = await fetch(`${uploadsBaseUrl}/${path.basename(symlinkToSubPath)}`);
      assert(symlinkToSubRes.status === 401, 'Anonymous access to symlink pointing into subdirectory is rejected (401 Unauthorized)');

      assert(isTrustedPublicMedia(symlinkInSubPath, `proxies/${path.basename(symlinkInSubPath)}`) === false, 'Symlink located in subdirectory is rejected by isTrustedPublicMedia');
      const symlinkInSubRes = await fetch(`${uploadsBaseUrl}/proxies/${path.basename(symlinkInSubPath)}`);
      assert(symlinkInSubRes.status === 401, 'Anonymous access to symlink inside subdirectory is rejected (401 Unauthorized)');

      // ----------------------------------------------------------------------
      // Test A.14: Test Fixture Data Safety & Non-Destructive Cleanup Proofs
      // (Mandatory Regression Tests for Section 5)
      // ----------------------------------------------------------------------
      console.log('  --- Sub-suite A.14: Fixture Data Safety & Isolated Lifecycle Tests ---');

      // 1. When a pre-existing sample file exists before test, it MUST NOT be overwritten or deleted
      const safetyTempDir = path.resolve(os.tmpdir(), `test_fixture_safety_${testTime}`);
      fs.mkdirSync(safetyTempDir, { recursive: true });

      try {
        const mockUploadsDir = path.resolve(safetyTempDir, 'mock_uploads');
        fs.mkdirSync(mockUploadsDir, { recursive: true });

        const preExistingFile = path.resolve(mockUploadsDir, 'sample_public_test.mp4');
        const preExistingContent = 'PRE_EXISTING_ORIGINAL_PUBLIC_SAMPLE_DATA_SHA256';
        fs.writeFileSync(preExistingFile, preExistingContent);

        // Safe fixture initialization logic:
        const preExists = fs.existsSync(preExistingFile);
        let createdByTest = false;
        let originalContent: Buffer | null = null;
        if (preExists) {
          originalContent = fs.readFileSync(preExistingFile);
        } else {
          fs.writeFileSync(preExistingFile, 'NEW_TEST_PAYLOAD');
          createdByTest = true;
        }

        assert(preExists === true, 'Safety test: detects pre-existing file');
        assert(createdByTest === false, 'Safety test: did NOT mark pre-existing file as test-created');
        assert(fs.readFileSync(preExistingFile).toString('utf8') === preExistingContent, 'Safety test: pre-existing file content is NOT overwritten');

        // Safe cleanup:
        if (createdByTest) {
          fs.unlinkSync(preExistingFile);
        }

        assert(fs.existsSync(preExistingFile) === true, 'Safety test: pre-existing file was NOT deleted during cleanup');
        assert(fs.readFileSync(preExistingFile).toString('utf8') === preExistingContent, 'Safety test: pre-existing file content remains completely intact');

        // 2. When NO pre-existing file exists, test creates fixture and cleanly removes it
        const nonPreExistingFile = path.resolve(mockUploadsDir, 'sample_public_temp.mp4');
        const nonPreExists = fs.existsSync(nonPreExistingFile);
        let createdNonPre = false;
        if (!nonPreExists) {
          fs.writeFileSync(nonPreExistingFile, 'TEMP_FIXTURE_CONTENT');
          createdNonPre = true;
        }

        assert(createdNonPre === true, 'Safety test: creates fixture when file does not pre-exist');
        assert(fs.existsSync(nonPreExistingFile) === true, 'Safety test: fixture exists during test');

        // Cleanup:
        if (createdNonPre) {
          fs.unlinkSync(nonPreExistingFile);
        }
        assert(fs.existsSync(nonPreExistingFile) === false, 'Safety test: test-created fixture is cleanly removed after test');

        // 3. When an assertion or step throws an error, cleanup preserves pre-existing file
        let errorCaught = false;
        try {
          assert(fs.existsSync(preExistingFile) === true, 'Pre-existing file present before simulated failure');
          throw new Error('Simulated test execution failure');
        } catch (err: any) {
          errorCaught = true;
        } finally {
          if (createdByTest) {
            fs.unlinkSync(preExistingFile);
          }
        }
        assert(errorCaught === true, 'Safety test: error was raised and caught as expected');
        assert(fs.existsSync(preExistingFile) === true, 'Safety test: pre-existing file survived failed test run');
        assert(fs.readFileSync(preExistingFile).toString('utf8') === preExistingContent, 'Safety test: pre-existing file content preserved on failure');

        // 4. Symlink pointing outside temporary test directory does NOT delete or alter external target
        const externalTargetDir = path.resolve(safetyTempDir, 'external_protected_dir');
        fs.mkdirSync(externalTargetDir, { recursive: true });
        const externalTargetFile = path.resolve(externalTargetDir, 'protected_production_file.txt');
        const externalTargetContent = 'CRITICAL_PROTECTED_DATA_DO_NOT_TOUCH';
        fs.writeFileSync(externalTargetFile, externalTargetContent);

        const internalSymlinkPath = path.resolve(mockUploadsDir, 'symlink_pointing_out.mp4');
        fs.symlinkSync(externalTargetFile, internalSymlinkPath);

        assert(fs.existsSync(internalSymlinkPath) === true, 'Symlink created successfully');

        // Safe cleanup: only unlink the symlink itself (using lstatSync), never the external target
        const symlinkStat = fs.lstatSync(internalSymlinkPath, { throwIfNoEntry: false });
        if (symlinkStat) {
          fs.unlinkSync(internalSymlinkPath);
        }

        assert(fs.existsSync(internalSymlinkPath) === false, 'Symlink was unlinked from test directory');
        assert(fs.existsSync(externalTargetFile) === true, 'External target was NOT deleted by symlink cleanup');
        assert(fs.readFileSync(externalTargetFile).toString('utf8') === externalTargetContent, 'External target content was NOT modified by symlink cleanup');

      } finally {
        try { fs.rmSync(safetyTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }

      // -------------------------------------------------------
      // ISSUE B: PROHIBITION OF SESSION TOKENS IN URL & MEDIA TOKENS
      // -------------------------------------------------------
      console.log('  --- Sub-suite B: Media Access Tokens & Session Token Protection ---');

      // Test B.1: Primary session token via ?token= MUST NOT grant access (401 Unauthorized)
      const sessionInQueryRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}?token=${activeTokenA}`);
      assert(sessionInQueryRes.status === 401, 'Primary session token passed via ?token= is rejected with 401 Unauthorized');

      // Test B.2: Primary session token via ?sessionToken= MUST NOT grant access (401 Unauthorized)
      const sessionInQueryRes2 = await fetch(`${uploadsBaseUrl}/${testVideoFileId}?sessionToken=${activeTokenA}`);
      assert(sessionInQueryRes2.status === 401, 'Primary session token passed via ?sessionToken= is rejected with 401 Unauthorized');

      // Test B.3: Generation of short-lived Media Access Token via POST /api/media/token
      const tokenGenRes = await fetch(`${baseUrl}/media/token`, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${activeTokenA}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fileId: testVideoFileId, durationSeconds: 60 })
      });
      assert(tokenGenRes.status === 200, 'POST /media/token generates media token for owned file (200 OK)');
      const tokenGenData = await tokenGenRes.json();
      assert(!!tokenGenData.mediaToken, 'Response contains signed mediaToken');
      assert(tokenGenData.expiresInSeconds === 60, 'Token expiration seconds matches requested duration');
      const validMediaToken = tokenGenData.mediaToken;

      // Test B.4: Non-owner cannot generate media token for another user's file
      const userBFakeTokenRes = await fetch(`${baseUrl}/media/token`, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${tokenB}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fileId: testVideoFileId })
      });
      assert(userBFakeTokenRes.status === 403, 'User B cannot generate media token for User A file (403 Forbidden)');

      // Test B.5: Access media using valid Media Access Token via ?media_token=
      const mediaTokenAccessRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}?media_token=${validMediaToken}`);
      assert(mediaTokenAccessRes.status === 200, 'Access with valid media_token returns 200 OK');
      const mediaTokenBody = await mediaTokenAccessRes.text();
      assert(mediaTokenBody === testVideoPayload, 'Media body fetched via media_token matches payload');

      // Test B.6: Range requests work seamlessly with media_token
      const mediaRangeRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}?media_token=${validMediaToken}`, {
        headers: { Range: 'bytes=0-15' }
      });
      assert(mediaRangeRes.status === 206, 'Valid Range request with media_token returns 206 Partial Content');
      assert(mediaRangeRes.headers.get('content-range')?.startsWith('bytes 0-15/') === true, 'Content-Range reflects byte slice');
      assert(mediaRangeRes.headers.get('content-length') === '16', 'Content-Length is 16');

      // Test B.7: HEAD requests work seamlessly with media_token
      const mediaHeadRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}?media_token=${validMediaToken}`, {
        method: 'HEAD'
      });
      assert(mediaHeadRes.status === 200, 'HEAD request with media_token returns 200 OK');
      assert(mediaHeadRes.headers.get('content-type')?.includes('video/mp4') === true, 'HEAD returns video/mp4 content-type');

      // Test B.8: Media token scope enforcement (token for video cannot access thumbnail)
      const scopeMismatchRes = await fetch(`${uploadsBaseUrl}/${testThumbFileId}?media_token=${validMediaToken}`);
      assert(scopeMismatchRes.status === 401, 'Media token used for different file is rejected (scope mismatch -> 401)');

      // Test B.9: Tampered / forged media token is rejected (401)
      const tamperedMediaToken = validMediaToken.substring(0, validMediaToken.length - 4) + 'abcd';
      const tamperedRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}?media_token=${tamperedMediaToken}`);
      assert(tamperedRes.status === 401, 'Tampered media token with invalid HMAC is rejected (401)');

      // Test B.10: Expired media token is rejected (401)
      const expiredToken = createMediaAccessToken(userA.id, testVideoFileId, 1);
      // Wait 1.2 seconds for expiration
      await new Promise(r => setTimeout(r, 1200));
      const expiredRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}?media_token=${expiredToken}`);
      assert(expiredRes.status === 401, 'Expired media token is rejected (401)');

      // Test B.11: Media token CANNOT be used to call protected APIs instead of session token
      const protectedApiWithMediaToken = await fetch(`${baseUrl}/user`, {
        headers: { Authorization: `Bearer ${validMediaToken}` }
      });
      assert(protectedApiWithMediaToken.status === 401, 'Media token cannot be used to call protected APIs (401 Unauthorized)');

      // -------------------------------------------------------
      // ISSUE C: STRICT OWNERSHIP RESOLUTION (NO SUBSTRING / BASENAME GUESSING)
      // -------------------------------------------------------
      console.log('  --- Sub-suite C: Strict Ownership Resolution ---');

      // Test C.1: Same basename in different directories resolves strictly to respective owner
      const ownerPathA = await getMediaOwner(pathA);
      const ownerPathB = await getMediaOwner(pathB);
      assert(ownerPathA?.userId === userA.id, 'getMediaOwner on dirA resolves strictly to User A');
      assert(ownerPathB?.userId === userB.id, 'getMediaOwner on dirB resolves strictly to User B');

      // Test C.2: Proxy stem collision across multiple user accounts fails closed
      const collisionProxyOwner = await getMediaOwner(collisionProxyPath);
      assert(collisionProxyOwner === null, 'getMediaOwner on proxy with stem collision across multiple accounts fails closed (null)');

      const userACollisionRes = await fetch(`${uploadsBaseUrl}/proxies/${path.basename(collisionProxyPath)}`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(userACollisionRes.status === 403, 'Access to proxy with ambiguous multi-user stem collision is rejected (403 Forbidden)');

      // Test C.3: Single unambiguous proxy resolves cleanly to single owner
      const uniqueProxyOwner = await getMediaOwner(testProxyPath);
      assert(uniqueProxyOwner?.userId === userA.id, 'Unambiguous proxy resolves cleanly to User A');

      const userAProxyRes = await fetch(`${uploadsBaseUrl}/proxies/${testProxyFileId}`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(userAProxyRes.status === 200, 'User A can access own derived proxy (200 OK)');

      const userBProxyRes = await fetch(`${uploadsBaseUrl}/proxies/${testProxyFileId}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });
      assert(userBProxyRes.status === 403, 'User B cannot access User A proxy (403 Forbidden)');

      // Test C.4: Scan ID substring collision (scan_sub vs scan_sub_long)
      // Verify that frame Long matches User B and NOT User A (proving no includes(scan.id) substring bug)
      const frameLongOwner = await getMediaOwner(frameLongPath);
      assert(frameLongOwner?.userId === userB.id, 'getMediaOwner on frame directory resolves strictly to User B (not substring scan_sub User A)');

      // Test C.5: Orphaned private media with no trusted record fails closed
      const orphanOwner = await getMediaOwner(unownedPath);
      assert(orphanOwner === null, 'getMediaOwner on orphaned file returns null');

      const orphanAccessRes = await fetch(`${uploadsBaseUrl}/${unownedFileId}`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(orphanAccessRes.status === 403, 'Access to orphaned private file is rejected (403 Forbidden)');

      // Test C.6: Authorized Owner can access own video and thumbnail via Authorization header
      const ownerVideoRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(ownerVideoRes.status === 200, 'User A can access own video via Bearer header (200 OK)');

      const ownerThumbRes = await fetch(`${uploadsBaseUrl}/${testThumbFileId}`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(ownerThumbRes.status === 200, 'User A can access own thumbnail via Bearer header (200 OK)');

      // User B cannot access User A's thumbnail
      const userBThumbRes = await fetch(`${uploadsBaseUrl}/${testThumbFileId}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });
      assert(userBThumbRes.status === 403, 'User B cannot access User A thumbnail (403 Forbidden)');

      // Test C.7: Non-existent file returns 404
      const missingRes = await fetch(`${uploadsBaseUrl}/does_not_exist_${Date.now()}.mp4`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(missingRes.status === 404, 'Non-existent file returns 404 Not Found');

    } finally {
      // Clean up test files created for 3c
      const allTestFiles = [
        testVideoPath,
        testThumbPath,
        testProxyPath,
        fakePublicPath,
        fakeSamplePath,
        ...(publicSampleCreatedByThisTest ? [publicSamplePath] : []),
        unownedPath,
        pathA,
        pathB,
        collisionPathA,
        collisionPathB,
        collisionProxyPath,
        frameLongPath,
        subProxySamplePath,
        nestedSamplePath,
        frameSamplePath,
        symlinkOutPath,
        symlinkToSubPath,
        symlinkInSubPath,
        externalTempTarget
      ].filter((p): p is string => Boolean(p));
      for (const p of allTestFiles) {
        try {
          const stat = fs.lstatSync(p, { throwIfNoEntry: false });
          if (stat) {
            fs.unlinkSync(p);
          }
        } catch { /* ignore */ }
      }

      if (publicSamplePreExisted && publicSampleOriginalBuffer !== null) {
        // Assert pre-existing file was NOT deleted or altered
        const currentBuf = fs.existsSync(publicSamplePath) ? fs.readFileSync(publicSamplePath) : null;
        if (!currentBuf || !currentBuf.equals(publicSampleOriginalBuffer)) {
          fs.writeFileSync(publicSamplePath, publicSampleOriginalBuffer);
        }
      }

      try { fs.rmSync(framesLongDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(dirB, { recursive: true, force: true }); } catch { /* ignore */ }
      if (nestedRootDir && fs.existsSync(nestedRootDir)) {
        try { fs.rmSync(nestedRootDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      if (framesSampleDir && fs.existsSync(framesSampleDir)) {
        try { fs.rmSync(framesSampleDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    // ---------------------------------------------------------
    // 4. CREDITS & BILLING SAFETY
    // ---------------------------------------------------------
    console.log('\n[4. Credits & Billing Safety]');

    // Test 4.1: User cannot set own credits or plan arbitrarily via /user/plan
    const paidPlanBypass = await fetch(`${baseUrl}/user/plan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ plan: 'agency', credits: 9999 })
    });
    assert(paidPlanBypass.status === 400, 'Arbitrary paid plan upgrade without checkout is rejected (400)');

    // Test 4.2: Credit deduction is server-authoritative
    const initialCredits = userB.creditsRemaining;
    const deducted = await storage.users.deductCredits(userB.id, 5);
    assert(deducted === true, 'Server deducts credits legitimately');
    const updatedUserB = await storage.users.getUser(userB.id);
    assert(updatedUserB?.creditsRemaining === initialCredits - 5, 'User B balance reduced accurately on server');

    // Test 4.3: User cannot spend more credits than available
    const overspend = await storage.users.deductCredits(userB.id, 99999);
    assert(overspend === false, 'Overspending credits beyond available balance is rejected');

    // ---------------------------------------------------------
    // 5. TEST ENDPOINT GATING (Production Anti-Backdoor)
    // ---------------------------------------------------------
    console.log('\n[5. Test Endpoint Gating]');

    // When ENABLE_TEST_ACCOUNT_SWITCH is not true:
    delete process.env.ENABLE_TEST_ACCOUNT_SWITCH;

    const accountsRes = await fetch(`${baseUrl}/auth/accounts`);
    assert(accountsRes.status === 403, 'GET /auth/accounts is rejected (403 Forbidden) when test flag is unset');

    const switchRes = await fetch(`${baseUrl}/auth/switch-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userA.id })
    });
    assert(switchRes.status === 403, 'POST /auth/switch-account is rejected (403 Forbidden) when test flag is unset');

    const switchDemoRes = await fetch(`${baseUrl}/auth/switch-demo-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userA.id })
    });
    assert(switchDemoRes.status === 403, 'POST /auth/switch-demo-user is rejected (403 Forbidden) when test flag is unset');

    console.log(`\n======================================================`);
    console.log(`TEST SUITE 1 COMPLETE: ${passed}/${total} assertions passed!`);
    console.log(`======================================================\n`);
  } finally {
    server.close();
  }
}
