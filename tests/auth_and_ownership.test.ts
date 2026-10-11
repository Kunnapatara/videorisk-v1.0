import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { apiRouter } from '../src/server/routes/api';
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

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
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
    }]);

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
    });

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
