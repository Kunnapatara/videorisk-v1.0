import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { apiRouter, secureUploadsHandler } from '../src/server/routes/api';
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
    // 3c. PRIVATE UPLOAD ASSET ACCESS CONTROL & STREAMING SECURITY
    // ---------------------------------------------------------
    console.log('\n[3c. Private Upload Asset Access Control & Streaming Security]');

    const testTime = Date.now();
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

    const publicSampleFileId = `sample_public_demo_${testTime}.mp4`;
    const publicSamplePath = path.resolve(uploadDir, publicSampleFileId);
    const publicSamplePayload = 'PUBLIC_SAMPLE_VIDEO_CONTENT_ACCESSIBLE_UNAUTHENTICATED';
    fs.writeFileSync(publicSamplePath, publicSamplePayload);

    const unownedFileId = `unregistered_orphan_${testTime}.mp4`;
    const unownedPath = path.resolve(uploadDir, unownedFileId);
    fs.writeFileSync(unownedPath, 'ORPHANED_DATA_WITH_NO_USER_RECORD');

    try {
      // Test 3c.1: Anonymous GET /uploads/:fileId receives 401 Unauthorized
      const anonUploadsRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}`);
      assert(anonUploadsRes.status === 401, 'Anonymous request to /uploads/:fileId returns 401 Unauthorized');

      // Test 3c.2: Anonymous GET /api/uploads/:fileId receives 401 Unauthorized
      const anonApiUploadsRes = await fetch(`${baseUrl}/uploads/${testVideoFileId}`);
      assert(anonApiUploadsRes.status === 401, 'Anonymous request to /api/uploads/:fileId returns 401 Unauthorized');

      // Test 3c.3: Cross-user access (IDOR): User B cannot access User A's private video via /uploads
      const userBUploadsRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });
      assert(userBUploadsRes.status === 403, 'User B access to User A private video on /uploads returns 403 Forbidden');

      // Test 3c.4: Cross-user access (IDOR): User B cannot access User A's private video via /api/uploads
      const userBApiUploadsRes = await fetch(`${baseUrl}/uploads/${testVideoFileId}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });
      assert(userBApiUploadsRes.status === 403, 'User B access to User A private video on /api/uploads returns 403 Forbidden');

      // Test 3c.5: Authorized Owner access: User A receives 200 OK with secure headers and full body
      const userAUploadsRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(userAUploadsRes.status === 200, 'User A access to own video returns 200 OK');
      assert(userAUploadsRes.headers.get('content-type')?.includes('video/mp4') === true, 'Response Content-Type is video/mp4');
      assert(userAUploadsRes.headers.get('x-content-type-options') === 'nosniff', 'Response includes X-Content-Type-Options: nosniff');
      assert(userAUploadsRes.headers.get('cache-control')?.includes('private') === true, 'Response includes private Cache-Control header');
      assert(userAUploadsRes.headers.get('accept-ranges') === 'bytes', 'Response includes Accept-Ranges: bytes');
      const fetchedBody = await userAUploadsRes.text();
      assert(fetchedBody === testVideoPayload, 'Fetched video content matches original uploaded payload');

      // Test 3c.6: Query token authentication (for HTML5 <video> / <img> elements)
      const userAQueryAuthRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}?token=${activeTokenA}`);
      assert(userAQueryAuthRes.status === 200, 'User A access via ?token= session query parameter returns 200 OK');
      const queryAuthBody = await userAQueryAuthRes.text();
      assert(queryAuthBody === testVideoPayload, 'Content delivered via query token authentication matches payload');

      // Test 3c.7: Range request (HTTP 206 Partial Content)
      const rangeRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}`, {
        headers: { 
          Authorization: `Bearer ${activeTokenA}`,
          Range: 'bytes=0-15'
        }
      });
      assert(rangeRes.status === 206, 'Valid Range header returns 206 Partial Content');
      assert(rangeRes.headers.get('content-range')?.startsWith('bytes 0-15/') === true, 'Content-Range header indicates bytes 0-15');
      assert(rangeRes.headers.get('content-length') === '16', 'Content-Length matches range chunk size (16)');
      const rangeBody = await rangeRes.text();
      assert(rangeBody === testVideoPayload.substring(0, 16), 'Range response body matches requested byte slice');

      // Test 3c.8: Unsatisfiable Range request returns 416 Range Not Satisfiable
      const badRangeRes = await fetch(`${uploadsBaseUrl}/${testVideoFileId}`, {
        headers: { 
          Authorization: `Bearer ${activeTokenA}`,
          Range: 'bytes=99999-999999'
        }
      });
      assert(badRangeRes.status === 416, 'Unsatisfiable byte range returns 416 Range Not Satisfiable');
      assert(!!badRangeRes.headers.get('content-range'), '416 response includes Content-Range header');

      // Test 3c.9: Path Traversal attempts escaping storage root are blocked (403 Forbidden)
      const traversalRes = await fetch(`${uploadsBaseUrl}/../../data/videorisk.db`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(traversalRes.status === 403 || traversalRes.status === 400 || traversalRes.status === 404, 'Path traversal escaping upload directory is rejected');

      const encodedTraversalRes = await fetch(`${uploadsBaseUrl}/%2e%2e/%2e%2e/data/videorisk.db`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(encodedTraversalRes.status === 403 || encodedTraversalRes.status === 400 || encodedTraversalRes.status === 404, 'Encoded path traversal is rejected');

      // Test 3c.10: Directory listing attempts are rejected
      const dirListRes = await fetch(`${uploadsBaseUrl}`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(dirListRes.status === 400 || dirListRes.status === 403, 'Root directory request is rejected without directory listing');

      const proxiesDirRes = await fetch(`${uploadsBaseUrl}/proxies`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(proxiesDirRes.status === 403, 'Subdirectory request is rejected without directory listing');

      // Test 3c.11: Thumbnail ownership protection
      const userBThumbRes = await fetch(`${uploadsBaseUrl}/${testThumbFileId}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });
      assert(userBThumbRes.status === 403, 'User B access to User A thumbnail returns 403 Forbidden');

      const userAThumbRes = await fetch(`${uploadsBaseUrl}/${testThumbFileId}`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(userAThumbRes.status === 200, 'User A access to own thumbnail returns 200 OK');
      assert(userAThumbRes.headers.get('content-type')?.includes('image/jpeg') === true, 'Thumbnail content-type is image/jpeg');

      // Test 3c.12: Proxy artifact ownership protection
      const userBProxyRes = await fetch(`${uploadsBaseUrl}/proxies/${testProxyFileId}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });
      assert(userBProxyRes.status === 403, 'User B access to User A proxy returns 403 Forbidden');

      const userAProxyRes = await fetch(`${uploadsBaseUrl}/proxies/${testProxyFileId}`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(userAProxyRes.status === 200, 'User A access to own proxy returns 200 OK');

      // Test 3c.13: Non-existent file returns 404
      const missingFileRes = await fetch(`${uploadsBaseUrl}/does_not_exist_${Date.now()}.mp4`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(missingFileRes.status === 404, 'Request for non-existent file returns 404 Not Found');

      // Test 3c.14: Untracked file in uploads fails closed (403 Forbidden)
      const orphanRes = await fetch(`${uploadsBaseUrl}/${unownedFileId}`, {
        headers: { Authorization: `Bearer ${activeTokenA}` }
      });
      assert(orphanRes.status === 403, 'Untracked media asset in uploads directory fails closed (403 Forbidden)');

      // Test 3c.15: Public sample asset without owner is accessible unauthenticated
      const publicRes = await fetch(`${uploadsBaseUrl}/${publicSampleFileId}`);
      assert(publicRes.status === 200, 'Explicit public sample asset allows unauthenticated access (200 OK)');
      const publicBody = await publicRes.text();
      assert(publicBody === publicSamplePayload, 'Public sample asset returns expected content');
    } finally {
      // Clean up test files created for 3c
      for (const p of [testVideoPath, testThumbPath, testProxyPath, publicSamplePath, unownedPath]) {
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch { /* ignore */ }
        }
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
