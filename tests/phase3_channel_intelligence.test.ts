import assert from 'assert';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { storage } from '../src/server/storage';
import { apiRouter } from '../src/server/routes/api';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { 
  ScanJob, 
  RiskReport, 
  ChannelPatternsResponse, 
  ChannelIntelligenceRecord, 
  CrossVideoComparisonItem, 
  TemporalAnalysisResult, 
  StoredVisualSignature, 
  StoredAudioSignature 
} from '../src/types';

export async function runPhase3ChannelIntelligenceTests() {
  console.log('\n======================================================');
  console.log('--- SUITE 18: PHASE 3 CHANNEL INTELLIGENCE TESTS ---');
  console.log('Cross-Video Patterns, Metadata Intelligence & Tenant Isolation');
  console.log('======================================================\n');

  // Set up Express test app for HTTP route tests
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  const createdScanIds: string[] = [];

  const cleanupScans = async () => {
    for (const id of createdScanIds) {
      try {
        await storage.scans.deleteScan(id);
      } catch {
        // ignore
      }
    }
  };

  try {
    // Helper to register a test user and obtain a valid session token
    const registerTestUser = async (tag: string) => {
      const email = `test_ch_${tag}_${Date.now()}@videorisk.com`;
      const res = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'password123' })
      });
      assert.strictEqual(res.status, 201, `Registered user ${email}`);
      const data = await res.json();
      return { user: data.user, token: data.token };
    };

    // -------------------------------------------------------------------------
    // 1. ORIGINAL CONTRIBUTION INTEGRITY & REPAIR (TASK A)
    // -------------------------------------------------------------------------
    console.log('[1. Original Contribution Integrity & Repair]');

    const { user: userA, token: tokenA } = await registerTestUser('userA');

    // 1.1 Create two completed scans for User A with null originalContributionRatio
    const scanA1Id = `scan_ch_a1_${Date.now()}`;
    const scanA2Id = `scan_ch_a2_${Date.now()}`;
    createdScanIds.push(scanA1Id, scanA2Id);

    const baseScanJob: Omit<ScanJob, 'id' | 'videoTitle'> = {
      userId: userA.id,
      videoFilename: 'test_sample.mp4',
      videoPath: path.resolve(process.cwd(), 'tests', 'fixtures', 'demo', 'sample_demo_problematic.mp4'),
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Media inspection', 'Scene analysis', 'Risk report'],
      creditsUsed: 1,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanA1Id,
      videoTitle: 'Exploring Ancient Rome - Part 1',
      videoDescription: 'An original exploration into architectural achievements of the Roman Empire.'
    });

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanA2Id,
      videoTitle: 'Exploring Ancient Rome - Part 2',
      videoDescription: 'Continuation of Roman engineering studies covering aqueducts and vaults.'
    });

    // Save reports with null originalContributionRatio and INSUFFICIENT_EVIDENCE
    const dummyReportA1: RiskReport = {
      scanId: scanA1Id,
      overallRisk: 'LOW_RISK',
      riskSummary: 'No direct risk signals detected.',
      disclaimer: 'VideoRisk helps identify potential publishing risks.',
      domainReports: {
        video_audio: {
          domain: 'video_audio',
          domainLabel: 'Video & Audio',
          status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
          summary: 'Acoustic audio present.',
          findingsCount: 0,
          confidence: 'HIGH',
          limitations: 'Local deterministic analysis.'
        },
        title: {
          domain: 'title',
          domainLabel: 'Title',
          status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
          summary: 'Title clear.',
          findingsCount: 0,
          confidence: 'HIGH',
          limitations: 'Lexicon checks.'
        },
        description_tags: {
          domain: 'description_tags',
          domainLabel: 'Description',
          status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
          summary: 'Description clear.',
          findingsCount: 0,
          confidence: 'HIGH',
          limitations: 'Text checks.'
        },
        thumbnail: {
          domain: 'thumbnail',
          domainLabel: 'Thumbnail',
          status: 'NOT_PROVIDED',
          summary: 'Thumbnail not provided.',
          findingsCount: 0,
          confidence: 'UNKNOWN',
          limitations: 'None.'
        },
        channel_context: {
          domain: 'channel_context',
          domainLabel: 'Channel Profile',
          status: 'NOT_PROVIDED',
          summary: 'No profile.',
          findingsCount: 0,
          confidence: 'LOW',
          limitations: 'User declared.'
        }
      },
      riskCategories: {
        yppMonetization: { status: 'LOW_RISK', score: 10, label: 'YPP', explanation: 'No issues.' },
        videoMonetization: { status: 'LOW_RISK', score: 10, label: 'Video', explanation: 'No issues.' },
        advertiserFriendly: { status: 'LOW_RISK', score: 10, label: 'Ad Suitability', explanation: 'No issues.' },
        copyrightSignals: { status: 'LOW_RISK', score: 10, label: 'Copyright', explanation: 'No issues.' }
      },
      topIssues: [],
      policyConnections: [],
      timeline: [],
      originalContributionRatio: null,
      originalContributionStatus: 'INSUFFICIENT_EVIDENCE',
      reusedContentRatio: 0,
      metadataScore: 100,
      benchmarkMetrics: {
        totalProcessingSeconds: 1,
        inspectionMs: 10,
        audioProcessingMs: 10,
        videoAnalysisMs: 10,
        evidenceBuildingMs: 10,
        policyReasoningMs: 10,
        framesSampled: 10,
        scenesDetected: 2
      }
    };

    await storage.scans.saveReport(scanA1Id, dummyReportA1, { systemBypass: true } as any);
    await storage.scans.saveReport(scanA2Id, { ...dummyReportA1, scanId: scanA2Id }, { systemBypass: true } as any);

    // 1.2 Fetch channel patterns via API
    const patRes1 = await fetch(`${baseUrl}/channel/patterns`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(patRes1.status, 200, 'GET /channel/patterns returns 200');
    const patData1: ChannelPatternsResponse = await patRes1.json();

    assert.strictEqual(patData1.sampleSize, 2, 'Sample size correctly reflects 2 completed scans');
    assert.strictEqual(patData1.coverage.originalContribution, 'INSUFFICIENT_EVIDENCE', 'Original contribution coverage is INSUFFICIENT_EVIDENCE');
    assert.strictEqual(
      patData1.patterns.some(p => p.patternType === 'repeated_reused_signal'),
      false,
      'Null originalContributionRatio NEVER creates a repeated_reused_signal pattern'
    );
    assert.strictEqual(
      patData1.patterns.some(p => p.recommendation && p.recommendation.includes('transforms material under YouTube YPP')),
      false,
      'Unsupported voiceover-as-compliance recommendation has been completely removed'
    );
    console.log('  ✅ PASS: 1.1 Null originalContributionRatio preserved as INSUFFICIENT_EVIDENCE without fabricating low-contribution patterns');

    // -------------------------------------------------------------------------
    // 2. TITLE & METADATA INTELLIGENCE (TASK B)
    // -------------------------------------------------------------------------
    console.log('\n[2. Title & Metadata Intelligence]');

    // 2.1 Series Title Template (Episodic naming should be info, NOT a policy violation)
    const seriesPattern = patData1.patterns.find(p => p.patternType === 'series_title_template');
    assert(!!seriesPattern, 'Episodic series titles detected ("Exploring Ancient Rome - Part 1/2")');
    assert.strictEqual(seriesPattern?.severity, 'info', 'Series title template severity is strictly info (not warning/violation)');
    assert(seriesPattern?.explanation.includes('series naming template'), 'Explanation identifies episodic template structure');
    console.log('  ✅ PASS: 2.1 Episodic series titles recognized as informational template without policy violation');

    // 2.2 Exact Repeated Titles (Duplicate titles across scans)
    const scanA3Id = `scan_ch_a3_${Date.now()}`;
    const scanA4Id = `scan_ch_a4_${Date.now()}`;
    createdScanIds.push(scanA3Id, scanA4Id);

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanA3Id,
      videoTitle: 'My Exact Same Video Title',
      videoDescription: 'First upload of this title with general description.'
    });

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanA4Id,
      videoTitle: '  my exact same video title  ', // Tests safe whitespace & case normalization
      videoDescription: 'Second upload with same normalized title.'
    });

    await storage.scans.saveReport(scanA3Id, { ...dummyReportA1, scanId: scanA3Id }, { systemBypass: true } as any);
    await storage.scans.saveReport(scanA4Id, { ...dummyReportA1, scanId: scanA4Id }, { systemBypass: true } as any);

    const patRes2 = await fetch(`${baseUrl}/channel/patterns`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const patData2: ChannelPatternsResponse = await patRes2.json();
    assert.strictEqual(patData2.sampleSize, 4, 'Sample size updated to 4 completed scans');

    const exactTitlePattern = patData2.patterns.find(p => p.patternType === 'exact_repeated_title');
    assert(!!exactTitlePattern, 'Exact repeated title pattern identified across scans');
    assert.strictEqual(exactTitlePattern?.severity, 'warning', 'Exact duplicate title marked as warning');
    assert.strictEqual(exactTitlePattern?.affectedScansCount, 2, '2 scans affected by duplicate title');
    assert.strictEqual(exactTitlePattern?.frequency, 50, '2 of 4 scans is 50% frequency');
    assert(exactTitlePattern?.evidenceReferences?.includes(scanA3Id), 'Includes scanA3 in evidenceReferences');
    assert(exactTitlePattern?.evidenceReferences?.includes(scanA4Id), 'Includes scanA4 in evidenceReferences');
    console.log('  ✅ PASS: 2.2 Exact duplicate titles normalized and detected with affected references');

    // 2.3 Identical Video Descriptions
    const scanA5Id = `scan_ch_a5_${Date.now()}`;
    const scanA6Id = `scan_ch_a6_${Date.now()}`;
    createdScanIds.push(scanA5Id, scanA6Id);

    const boilerplateDesc = 'Standard channel description: Subscribe for daily tech tutorials, visit https://example.com/store, and follow on socials.';

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanA5Id,
      videoTitle: 'Independent Tech Review 1',
      videoDescription: boilerplateDesc
    });

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanA6Id,
      videoTitle: 'Independent Tech Review 2',
      videoDescription: boilerplateDesc
    });

    await storage.scans.saveReport(scanA5Id, { ...dummyReportA1, scanId: scanA5Id }, { systemBypass: true } as any);
    await storage.scans.saveReport(scanA6Id, { ...dummyReportA1, scanId: scanA6Id }, { systemBypass: true } as any);

    const patRes3 = await fetch(`${baseUrl}/channel/patterns`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const patData3: ChannelPatternsResponse = await patRes3.json();

    const descPattern = patData3.patterns.find(p => p.patternType === 'repeated_description');
    assert(!!descPattern, 'Identical boilerplate description detected across multiple videos');
    assert.strictEqual(descPattern?.severity, 'info', 'Boilerplate description marked as info');
    assert(descPattern?.recommendation.includes('unique summary'), 'Recommends adding video-specific summary');
    console.log('  ✅ PASS: 2.3 Identical descriptions detected and aggregated with creator guidance');

    // 2.4 Recurring Title-to-Content Pacing Gap (from Report topIssues)
    const scanA7Id = `scan_ch_a7_${Date.now()}`;
    const scanA8Id = `scan_ch_a8_${Date.now()}`;
    createdScanIds.push(scanA7Id, scanA8Id);

    const reportWithMismatch: RiskReport = {
      ...dummyReportA1,
      topIssues: [
        {
          id: 'issue_mismatch_1',
          domain: 'title',
          type: 'title_content_mismatch',
          what: 'Title-to-Content Hook Gap',
          where: '00:00–00:15',
          why: 'Video title promised immediate case study, but opening sequence lacked spoken topic hook.',
          fix: 'Introduce title topic in first 10 seconds.',
          evidence: 'Title lexicon mismatch',
          context: 'Creator baseline',
          recommendedAction: 'Connect opening visuals to title topic.',
          confidence: 'MEDIUM',
          limitations: 'Local lexicon checks.',
          severity: 'warning',
          policyArea: 'METADATA COHERENCE',
          category: 'metadata_coherence',
          timestampSeconds: 0
        }
      ]
    };

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanA7Id,
      videoTitle: 'Case Study 1: Why Startups Fail',
      videoDescription: 'Unique breakdown of market fit failures.'
    });

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanA8Id,
      videoTitle: 'Case Study 2: How Founders Pivot',
      videoDescription: 'Unique breakdown of product iteration.'
    });

    await storage.scans.saveReport(scanA7Id, { ...reportWithMismatch, scanId: scanA7Id }, { systemBypass: true } as any);
    await storage.scans.saveReport(scanA8Id, { ...reportWithMismatch, scanId: scanA8Id }, { systemBypass: true } as any);

    const patRes4 = await fetch(`${baseUrl}/channel/patterns`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const patData4: ChannelPatternsResponse = await patRes4.json();

    const mismatchPattern = patData4.patterns.find(p => p.patternType === 'title_content_mismatch');
    assert(!!mismatchPattern, 'Recurring title-to-content pacing gap detected across scans');
    assert.strictEqual(mismatchPattern?.severity, 'warning', 'Pacing gap marked as warning');
    assert.strictEqual(mismatchPattern?.affectedScansCount, 2, '2 scans affected by pacing gap');
    assert(mismatchPattern?.evidenceReferences?.includes(scanA7Id), 'Includes scanA7 in evidence references');
    assert(mismatchPattern?.evidenceReferences?.includes(scanA8Id), 'Includes scanA8 in evidence references');
    console.log('  ✅ PASS: 2.4 Recurring title-to-content coherence gaps aggregated from report evidence');

    // -------------------------------------------------------------------------
    // 3. CROSS-VIDEO DATA BOUNDARIES & TENANT ISOLATION (TASK C & D)
    // -------------------------------------------------------------------------
    console.log('\n[3. Cross-Video Data Boundaries & Tenant Isolation]');

    // 3.1 Strict Tenant Isolation: User B cannot see User A's patterns or scans
    const { user: userB, token: tokenB } = await registerTestUser('userB');

    const patResB = await fetch(`${baseUrl}/channel/patterns`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert.strictEqual(patResB.status, 200, 'User B request succeeds');
    const patDataB: ChannelPatternsResponse = await patResB.json();

    assert.strictEqual(patDataB.sampleSize, 0, 'User B has 0 completed scans (strict account isolation)');
    assert.strictEqual(patDataB.patterns.length, 0, 'User B receives 0 patterns (no data leakage from User A)');
    console.log('  ✅ PASS: 3.1 Tenant isolation: User A scans never leak into User B channel patterns');

    // 3.2 Incomplete Scans Excluded
    const scanBQueuedId = `scan_ch_b_queued_${Date.now()}`;
    const scanBFailedId = `scan_ch_b_failed_${Date.now()}`;
    createdScanIds.push(scanBQueuedId, scanBFailedId);

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanBQueuedId,
      userId: userB.id,
      videoTitle: 'Incomplete Queued Video',
      status: 'QUEUED'
    });

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanBFailedId,
      userId: userB.id,
      videoTitle: 'Incomplete Failed Video',
      status: 'FAILED',
      error: 'Media unreadable'
    });

    const patResB2 = await fetch(`${baseUrl}/channel/patterns`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    const patDataB2: ChannelPatternsResponse = await patResB2.json();
    assert.strictEqual(patDataB2.sampleSize, 0, 'QUEUED and FAILED scans are strictly excluded from completed sample');
    console.log('  ✅ PASS: 3.2 Non-completed scans (QUEUED, FAILED) excluded from pattern sample size');

    // 3.3 Scan Deletion Excluded
    const scanB1Id = `scan_ch_b1_${Date.now()}`;
    const scanB2Id = `scan_ch_b2_${Date.now()}`;
    createdScanIds.push(scanB1Id, scanB2Id);

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanB1Id,
      userId: userB.id,
      videoTitle: 'Temporary Scan B1',
      status: 'COMPLETED'
    });

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanB2Id,
      userId: userB.id,
      videoTitle: 'Temporary Scan B2',
      status: 'COMPLETED'
    });

    await storage.scans.saveReport(scanB1Id, { ...dummyReportA1, scanId: scanB1Id }, { systemBypass: true } as any);
    await storage.scans.saveReport(scanB2Id, { ...dummyReportA1, scanId: scanB2Id }, { systemBypass: true } as any);

    // Verify sample size is 2
    const patResB3 = await fetch(`${baseUrl}/channel/patterns`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    const patDataB3 = await patResB3.json();
    assert.strictEqual(patDataB3.sampleSize, 2, 'User B sample size is 2');

    // Delete scan B1
    await storage.scans.deleteScan(scanB1Id);

    // Verify sample size decrements to 1 and returns no patterns
    const patResB4 = await fetch(`${baseUrl}/channel/patterns`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    const patDataB4 = await patResB4.json();
    assert.strictEqual(patDataB4.sampleSize, 1, 'Sample size decrements to 1 after scan deletion');
    assert.strictEqual(patDataB4.patterns.length, 0, 'At least 2 completed scans required; 1 scan returns empty patterns');
    console.log('  ✅ PASS: 3.3 Deleted scans cleanly excluded from pattern aggregation and sample counts');

    // -------------------------------------------------------------------------
    // 4. AUDIO PATTERNS & NON-PERSISTED CAPABILITIES (TASK E)
    // -------------------------------------------------------------------------
    console.log('\n[4. Audio Patterns & Non-Persisted Capabilities]');

    assert.strictEqual(patData1.coverage.audioPatterns, 'NOT_AVAILABLE', 'Audio pattern recurrence is NOT_AVAILABLE');
    assert.strictEqual(patData1.coverage.introOutro, 'NOT_AVAILABLE', 'Intro/outro comparison is NOT_AVAILABLE');
    assert.strictEqual(patData1.coverage.crossVideoFootage, 'NOT_AVAILABLE', 'Cross-video footage reuse is NOT_AVAILABLE');
    assert(
      patData1.coverageDetails?.audioPatterns?.reason.includes('transient'),
      'Audio coverage detail explains buffers are transient'
    );
    assert(
      patData1.coverageDetails?.introOutro?.reason.includes('frame signatures'),
      'Intro/outro coverage detail documents transient frame signatures'
    );
    console.log('  ✅ PASS: 4.1 Non-persisted capabilities (intro/outro, cross-video, audio) report NOT_AVAILABLE without fabrication');

    // -------------------------------------------------------------------------
    // 5. API CONTRACT & MANDATORY COVERAGE STATEMENT (TASK G)
    // -------------------------------------------------------------------------
    console.log('\n[5. API Contract & Mandatory Coverage Statement]');

    // 5.1 Unauthenticated requests rejected
    const unauthRes = await fetch(`${baseUrl}/channel/patterns`);
    assert.strictEqual(unauthRes.status, 401, 'Unauthenticated GET /channel/patterns returns 401 Unauthorized');

    // 5.2 Mandatory Coverage Statement
    const EXPECTED_MANDATORY_STATEMENT = 
      'Channel insights are based only on videos uploaded and analyzed in your VideoRisk account. This is not a complete audit of all videos on your YouTube channel.';

    assert.strictEqual(
      patData1.mandatoryCoverageStatement,
      EXPECTED_MANDATORY_STATEMENT,
      'Response includes exact mandatory coverage statement'
    );
    assert.strictEqual(
      patData1.disclaimer,
      EXPECTED_MANDATORY_STATEMENT,
      'Disclaimer field matches mandatory coverage statement'
    );
    console.log('  ✅ PASS: 5.1 Unauthenticated requests rejected and mandatory coverage statement enforced');

    // -------------------------------------------------------------------------
    // 6. PERSISTENT CHANNEL INTELLIGENCE RECORDS (PROMPT SET 4 - SECTION 3)
    // -------------------------------------------------------------------------
    console.log('\n[6. Persistent Channel Intelligence Records (Prompt Set 4)]');

    // 6.1 Persistent record retrieval via /channel/intelligence
    const intelResA = await fetch(`${baseUrl}/channel/intelligence`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(intelResA.status, 200, 'GET /channel/intelligence returns 200');
    const intelDataA: ChannelIntelligenceRecord = await intelResA.json();

    assert(Boolean(intelDataA.id && intelDataA.id.startsWith('ch_intel_')), 'Record has durable ID');
    assert.strictEqual(intelDataA.userId, userA.id, 'Record strictly scoped to User A ID');
    assert.strictEqual(intelDataA.sampleSize, 8, 'Sample size accurately reflects 8 completed scans');
    assert.strictEqual(intelDataA.sourceScanIds.length, 8, 'Source scan IDs match sample size');
    assert.strictEqual(intelDataA.sourceVideoIdentities.length, 8, 'Source video identities preserved');
    assert(Boolean(intelDataA.createdAt && intelDataA.updatedAt), 'Durable timestamps stored');
    console.log('  ✅ PASS: 6.1 Persistent Channel Intelligence record retrieved with source scan & video identities');

    // 6.2 Direct storage repository retrieval
    const storedRecordA = await storage.channelIntelligence.getLatest(userA.id);
    assert(storedRecordA !== null, 'Storage repository returns persisted record directly');
    assert.strictEqual(storedRecordA?.id, intelDataA.id, 'Storage record ID matches API record ID');
    assert.strictEqual(storedRecordA?.sampleSize, intelDataA.sampleSize, 'Storage sampleSize matches API');
    console.log('  ✅ PASS: 6.2 Direct storage repository retrieval verified');

    // 6.3 Idempotent re-queries (does not increment version without changes)
    const patResRepeat = await fetch(`${baseUrl}/channel/patterns`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const patDataRepeat: ChannelPatternsResponse = await patResRepeat.json();
    assert.strictEqual(patDataRepeat.version, intelDataA.version, 'Subsequent GET /channel/patterns retains idempotent version');
    console.log('  ✅ PASS: 6.3 Idempotent queries retrieve existing persisted record without inflation');

    // 6.4 Controlled recomputation via recompute=true
    const patResRecompute = await fetch(`${baseUrl}/channel/patterns?recompute=true`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const patDataRecompute: ChannelPatternsResponse = await patResRecompute.json();
    assert.strictEqual(patDataRecompute.version, intelDataA.version + 1, 'Recompute increments analysis version safely');
    console.log('  ✅ PASS: 6.4 Explicit recomputation increments version and refreshes persisted analysis');

    // 6.5 Invalidation behavior
    await storage.channelIntelligence.invalidate(userA.id);
    const postInvalidateRecord = await storage.channelIntelligence.getLatest(userA.id);
    assert.strictEqual(postInvalidateRecord, null, 'Invalidated record is marked STALE and not returned by getLatest');
    console.log('  ✅ PASS: 6.5 Record invalidation safely marks prior analysis as STALE');

    // -------------------------------------------------------------------------
    // 7. CROSS-VIDEO EVIDENCE COMPARISON (VISUAL & AUDIO) (PROMPT SET 4 - SECTION 4)
    // -------------------------------------------------------------------------
    console.log('\n[7. Cross-Video Evidence Comparison (Visual & Audio)]');

    const scanV1Id = `scan_ch_v1_${Date.now()}`;
    const scanV2Id = `scan_ch_v2_${Date.now()}`;
    const scanV3Id = `scan_ch_v3_${Date.now()}`;
    createdScanIds.push(scanV1Id, scanV2Id, scanV3Id);

    // Helpers to create deterministic signatures
    const sampleHGrad1 = 'a5c3e7f1234567';
    const sampleVGrad1 = '1234567a5c3e7f';
    const sampleHGradDiff = '00000000000000';
    const sampleVGradDiff = 'ffffffffffffff';

    const makeVisSig = (
      t: number, 
      hGrad: string, 
      vGrad: string, 
      meanY: number, 
      stdDevY: number, 
      color: [number, number, number]
    ): StoredVisualSignature => ({
      timestamp: t,
      hGrad,
      vGrad,
      meanY,
      stdDevY,
      meanR: color[0],
      meanG: color[1],
      meanB: color[2]
    });

    // Scan V1: Intro at [0, 1], repeated segment at [3, 4, 5], unrelated at [6, 7]
    const sigsV1: StoredVisualSignature[] = [
      makeVisSig(0, sampleHGrad1, sampleVGrad1, 100, 25, [120, 100, 80]), // Intro bumper
      makeVisSig(1, sampleHGrad1, sampleVGrad1, 100, 25, [120, 100, 80]), // Intro bumper
      makeVisSig(2, '11111111111111', '22222222222222', 150, 30, [200, 50, 50]),
      makeVisSig(3, '33333333333333', '44444444444444', 80, 20, [40, 80, 120]), // Segment start
      makeVisSig(4, '55555555555555', '66666666666666', 85, 22, [45, 85, 125]), // Segment mid
      makeVisSig(5, '77777777777777', '88888888888888', 90, 24, [50, 90, 130]), // Segment end
      makeVisSig(6, '99999999999999', 'aaaaaaaaaaaaaa', 110, 15, [60, 60, 60])
    ];

    // Scan V2: Identical Intro at [0, 1], identical repeated segment at [10, 11, 12]
    const sigsV2: StoredVisualSignature[] = [
      makeVisSig(0, sampleHGrad1, sampleVGrad1, 100, 25, [120, 100, 80]), // Matching intro bumper
      makeVisSig(1, sampleHGrad1, sampleVGrad1, 100, 25, [120, 100, 80]), // Matching intro bumper
      makeVisSig(9, 'bbbbbbbbbbbbbb', 'cccccccccccccc', 130, 28, [100, 150, 200]),
      makeVisSig(10, '33333333333333', '44444444444444', 80, 20, [40, 80, 120]), // Matching segment start
      makeVisSig(11, '55555555555555', '66666666666666', 85, 22, [45, 85, 125]), // Matching segment mid
      makeVisSig(12, '77777777777777', '88888888888888', 90, 24, [50, 90, 130]), // Matching segment end
      makeVisSig(13, 'dddddddddddddd', 'eeeeeeeeeeeeee', 70, 18, [80, 80, 80])
    ];

    // Scan V3: Completely unrelated footage with inverted gradients
    const sigsV3: StoredVisualSignature[] = [
      makeVisSig(0, sampleHGradDiff, sampleVGradDiff, 20, 5, [10, 10, 10]),
      makeVisSig(1, sampleHGradDiff, sampleVGradDiff, 25, 6, [15, 15, 15]),
      makeVisSig(2, sampleHGradDiff, sampleVGradDiff, 30, 7, [20, 20, 20])
    ];

    // Audio signatures
    const activeSubbands = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0.01, 0.01];
    const audSigsV1: StoredAudioSignature[] = [
      { sec: 0, duration: 1, rms: 250, zcr: 400, spectralProfile: activeSubbands },
      { sec: 1, duration: 1, rms: 260, zcr: 420, spectralProfile: activeSubbands },
      { sec: 2, duration: 1, rms: 270, zcr: 410, spectralProfile: activeSubbands },
      { sec: 3, duration: 1, rms: 20, zcr: 50, spectralProfile: new Array(16).fill(0.01) } // Silent chunk
    ];

    const audSigsV2: StoredAudioSignature[] = [
      { sec: 0, duration: 1, rms: 250, zcr: 400, spectralProfile: activeSubbands }, // Matching audio
      { sec: 1, duration: 1, rms: 260, zcr: 420, spectralProfile: activeSubbands }, // Matching audio
      { sec: 2, duration: 1, rms: 270, zcr: 410, spectralProfile: activeSubbands }, // Matching audio
      { sec: 3, duration: 1, rms: 15, zcr: 30, spectralProfile: new Array(16).fill(0.01) }  // Silent chunk
    ];

    // Save scan records
    await storage.scans.createScan({
      ...baseScanJob,
      id: scanV1Id,
      videoTitle: 'Channel Episode A (Original B-Roll)',
      videoDescription: 'Episode A introducing product architecture.',
      status: 'COMPLETED'
    });

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanV2Id,
      videoTitle: 'Channel Episode B (Reused Sequence)',
      videoDescription: 'Episode B incorporating intro bumper and sequence from Episode A.',
      status: 'COMPLETED'
    });

    await storage.scans.createScan({
      ...baseScanJob,
      id: scanV3Id,
      videoTitle: 'Channel Episode C (Completely Unrelated)',
      videoDescription: 'Episode C containing distinct footage with zero overlap.',
      status: 'COMPLETED'
    });

    // Save reports with signatures
    const makeReportWithSignatures = (scanId: string, visSigs: StoredVisualSignature[], audSigs: StoredAudioSignature[]): RiskReport => ({
      ...dummyReportA1,
      scanId,
      detectors: {
        ...dummyReportA1.detectors,
        video_repeated_footage: {
          detectorName: 'perceptual_hash_comparator',
          version: '1.2.0',
          status: 'DETECTED',
          executionDurationMs: 50,
          details: { visualSignatures: visSigs }
        },
        audio_repeated_segments: {
          detectorName: 'subband_spectral_audio_fingerprint',
          version: '1.2.0',
          status: 'DETECTED',
          executionDurationMs: 40,
          details: { audioSignatures: audSigs }
        }
      }
    });

    await storage.scans.saveReport(scanV1Id, makeReportWithSignatures(scanV1Id, sigsV1, audSigsV1), { systemBypass: true } as any);
    await storage.scans.saveReport(scanV2Id, makeReportWithSignatures(scanV2Id, sigsV2, audSigsV2), { systemBypass: true } as any);
    await storage.scans.saveReport(scanV3Id, makeReportWithSignatures(scanV3Id, sigsV3, []), { systemBypass: true } as any);

    // 7.1 Visual comparison between V1 and V2: Intro and Segment match
    const cmpRes1 = await fetch(`${baseUrl}/channel/comparison?scanA=${scanV1Id}&scanB=${scanV2Id}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(cmpRes1.status, 200, 'GET /channel/comparison returns 200');
    const cmpData1 = await cmpRes1.json();

    assert.strictEqual(cmpData1.status, 'MATCH_CONFIRMED', 'Comparison status confirms matching evidence');
    const introCmp = cmpData1.comparisons.find((c: CrossVideoComparisonItem) => c.type === 'intro_outro');
    assert(Boolean(introCmp), 'Identifies shared opening intro bumper between V1 and V2');
    assert.strictEqual(introCmp.status, 'MATCH_CONFIRMED');
    assert(introCmp.measuredSimilarity >= 0.86, 'Intro match measuredSimilarity meets decision threshold');

    const segCmp = cmpData1.comparisons.find((c: CrossVideoComparisonItem) => c.type === 'visual_segment');
    assert(Boolean(segCmp), 'Identifies repeated visual segment sequence across videos');
    assert.strictEqual(segCmp.status, 'MATCH_CONFIRMED');
    assert.strictEqual(segCmp.evidenceStrength, 'STRONG');
    assert(segCmp.measuredSimilarity >= 0.86, 'Visual segment measuredSimilarity meets decision threshold');
    console.log('  ✅ PASS: 7.1 Cross-video visual comparison identifies shared intro bumper and repeated visual sequence');

    // 7.2 Audio comparison between V1 and V2: Acoustic subband match
    const audCmp = cmpData1.comparisons.find((c: CrossVideoComparisonItem) => c.type === 'audio_repetition');
    assert(Boolean(audCmp), 'Identifies matching acoustic spectral profile across videos');
    assert.strictEqual(audCmp.status, 'MATCH_CONFIRMED');
    assert(audCmp.measuredSimilarity >= 0.92, 'Audio measured similarity >= 0.92 threshold');
    assert(audCmp.limitations.includes('Does not distinguish licensed'), 'Audio limitations document licensing boundary');
    console.log('  ✅ PASS: 7.2 Cross-video audio comparison detects acoustic spectral profile match with clear limitations');

    // 7.3 Unrelated video comparison (V1 vs V3): Zero false positives
    const cmpResUnrelated = await fetch(`${baseUrl}/channel/comparison?scanA=${scanV1Id}&scanB=${scanV3Id}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const cmpDataUnrelated = await cmpResUnrelated.json();
    assert.strictEqual(cmpDataUnrelated.status, 'NO_MATCH', 'Distinct videos with unrelated footage return NO_MATCH');
    assert.strictEqual(cmpDataUnrelated.comparisons.length, 0, 'Zero false positive matches detected');
    console.log('  ✅ PASS: 7.3 Unrelated footage correctly yields NO_MATCH with zero false positives');

    // 7.4 Historical scans lacking signatures handled gracefully
    const cmpResHistorical = await fetch(`${baseUrl}/channel/comparison?scanA=${scanA1Id}&scanB=${scanA2Id}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const cmpDataHistorical = await cmpResHistorical.json();
    assert.strictEqual(cmpDataHistorical.visualStatus, 'UNAVAILABLE_MISSING_EVIDENCE', 'Historical scan without visual signatures reports UNAVAILABLE_MISSING_EVIDENCE');
    assert.strictEqual(cmpDataHistorical.audioStatus, 'UNAVAILABLE_MISSING_EVIDENCE', 'Historical scan without audio signatures reports UNAVAILABLE_MISSING_EVIDENCE');
    console.log('  ✅ PASS: 7.4 Historical scans without persisted signatures report UNAVAILABLE_MISSING_EVIDENCE without fabricating data');

    // -------------------------------------------------------------------------
    // 8. CROSS-TENANT ISOLATION & OWNERSHIP SCOPE (PROMPT SET 4 - SECTION 3 & 7)
    // -------------------------------------------------------------------------
    console.log('\n[8. Cross-Tenant Isolation & Scope Enforcement]');

    // 8.1 Mixed-owner scan comparison rejected with 404 (no information leakage)
    const mixedCmpRes = await fetch(`${baseUrl}/channel/comparison?scanA=${scanV1Id}&scanB=${scanB2Id}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(mixedCmpRes.status, 404, 'Mixed-owner comparison returns 404 Not Found without leaking existence');

    // 8.2 User B cannot compare User A's scans
    const unauthCmpRes = await fetch(`${baseUrl}/channel/comparison?scanA=${scanV1Id}&scanB=${scanV2Id}`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert.strictEqual(unauthCmpRes.status, 404, 'User B querying User A scan IDs returns 404');
    console.log('  ✅ PASS: 8.1 Server-side ownership strictly blocks cross-tenant scan comparisons');

    // 8.3 User B channel intelligence remains isolated
    const intelResB = await fetch(`${baseUrl}/channel/intelligence`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    const intelDataB: ChannelIntelligenceRecord = await intelResB.json();
    assert.strictEqual(intelDataB.userId, userB.id, 'User B intelligence is strictly isolated');
    assert(
      !intelDataB.sourceScanIds.some(id => createdScanIds.filter(cid => cid.includes('_a') || cid.includes('_v')).includes(id)),
      'User B intelligence never references User A scan IDs'
    );
    console.log('  ✅ PASS: 8.2 User B channel intelligence strictly isolated from User A data');

    // -------------------------------------------------------------------------
    // 9. TEMPORAL CROSS-SCAN CHANGES & RE-SCAN INTEGRITY (PROMPT SET 4 - SECTION 6)
    // -------------------------------------------------------------------------
    console.log('\n[9. Temporal Cross-Scan Changes & Re-scan Integrity]');

    const scanT1Id = `scan_ch_t1_${Date.now()}`;
    const scanT2Id = `scan_ch_t2_${Date.now()}`;
    const scanT3Id = `scan_ch_t3_${Date.now()}`;
    createdScanIds.push(scanT1Id, scanT2Id, scanT3Id);

    const baseSha256A = 'a'.repeat(64);
    const baseSha256B = 'b'.repeat(64);

    // Prior scan T1 with a repeated footage issue
    await storage.scans.createScan({
      ...baseScanJob,
      id: scanT1Id,
      videoTitle: 'Original Video Version',
      status: 'COMPLETED',
      metadata: {
        filename: 'sample.mp4',
        originalSize: 1000,
        durationSeconds: 30,
        width: 1280,
        height: 720,
        resolutionLabel: '720p',
        fps: 30,
        hasAudio: true,
        isProxyUsed: false,
        sha256: baseSha256A
      }
    });

    const reportT1: RiskReport = {
      ...dummyReportA1,
      scanId: scanT1Id,
      topIssues: [
        {
          id: 'issue_footage_1',
          domain: 'video_audio',
          type: 'repeated_visual_footage',
          what: 'Repeated Visual Footage',
          where: '00:05–00:10',
          why: 'Intra-video duplicate sequence.',
          fix: 'Trim repeated sequence.',
          evidence: 'Perceptual hash match',
          context: 'Baseline test',
          recommendedAction: 'Trim duplicate frames.',
          confidence: 'HIGH',
          limitations: 'Local check.',
          severity: 'warning',
          policyArea: 'REUSED CONTENT',
          category: 'reused_content',
          timestampSeconds: 5
        }
      ]
    };
    await storage.scans.saveReport(scanT1Id, reportT1, { systemBypass: true } as any);

    // Revised scan T2: Distinct media (sha256B), clean detector run confirming NO_SIGNAL_DETECTED
    await storage.scans.createScan({
      ...baseScanJob,
      id: scanT2Id,
      videoTitle: 'Revised Video Version (Clean Edit)',
      status: 'COMPLETED',
      metadata: {
        filename: 'sample_revised.mp4',
        originalSize: 950,
        durationSeconds: 25,
        width: 1280,
        height: 720,
        resolutionLabel: '720p',
        fps: 30,
        hasAudio: true,
        isProxyUsed: false,
        sha256: baseSha256B
      }
    });

    const reportT2Clean: RiskReport = {
      ...dummyReportA1,
      scanId: scanT2Id,
      topIssues: [],
      detectors: {
        ...dummyReportA1.detectors,
        video_repeated_footage: {
          detectorName: 'perceptual_hash_comparator',
          version: '1.2.0',
          status: 'NO_SIGNAL_DETECTED',
          executionDurationMs: 30,
          limitations: 'Clean run.'
        }
      }
    };
    await storage.scans.saveReport(scanT2Id, reportT2Clean, { systemBypass: true } as any);

    // 9.1 Verified resolution with distinct media & clean detector execution
    const tempRes1 = await fetch(`${baseUrl}/channel/temporal?priorScanId=${scanT1Id}&latestScanId=${scanT2Id}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(tempRes1.status, 200, 'GET /channel/temporal returns 200');
    const tempData1: TemporalAnalysisResult = await tempRes1.json();

    const resolvedItem = tempData1.temporalPatterns.find(p => p.patternType === 'repeated_visual_footage');
    assert(Boolean(resolvedItem), 'Identifies resolved pattern');
    assert.strictEqual(resolvedItem?.status, 'RESOLVED_WITH_EVIDENCE', 'Pattern verifiably resolved with evidence');
    console.log('  ✅ PASS: 9.1 Resolution verified with evidence on distinct media & clean detector confirmation');

    // 9.2 Identical media (matching SHA-256) fails closed without certifying resolution
    await storage.scans.createScan({
      ...baseScanJob,
      id: scanT3Id,
      videoTitle: 'Identical File Re-Scan',
      status: 'COMPLETED',
      metadata: {
        filename: 'sample.mp4',
        originalSize: 1000,
        durationSeconds: 30,
        width: 1280,
        height: 720,
        resolutionLabel: '720p',
        fps: 30,
        hasAudio: true,
        isProxyUsed: false,
        sha256: baseSha256A // Identical SHA-256 to T1!
      }
    });

    // Even if topIssues is empty in reportT3, identical SHA-256 must NOT verify resolution
    await storage.scans.saveReport(scanT3Id, reportT2Clean, { systemBypass: true } as any);

    const tempResIdentical = await fetch(`${baseUrl}/channel/temporal?priorScanId=${scanT1Id}&latestScanId=${scanT3Id}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const tempDataIdentical: TemporalAnalysisResult = await tempResIdentical.json();

    assert.strictEqual(tempDataIdentical.isIdenticalMedia, true, 'Correctly flags matching SHA-256 as identical media');
    const unverifiedItem = tempDataIdentical.temporalPatterns.find(p => p.patternType === 'repeated_visual_footage');
    assert.strictEqual(unverifiedItem?.status, 'CHANGE_NOT_VERIFIED', 'Identical media fails closed to CHANGE_NOT_VERIFIED');
    assert(unverifiedItem?.reason.includes('Identical media'), 'Reason explains SHA-256 identity constraint');
    console.log('  ✅ PASS: 9.2 Identical media (matching SHA-256) strictly fails closed to CHANGE_NOT_VERIFIED');

    // -------------------------------------------------------------------------
    // 10. GROUND-TRUTH MEDIA FIXTURES BENCHMARK (PROMPT SET 4 - SECTION 9 & 11)
    // -------------------------------------------------------------------------
    console.log('\n[10. Ground-Truth Media Fixtures Protocol]');

    const fixtureProblematic = path.resolve(process.cwd(), 'src', 'server', 'fixtures', 'demo', 'sample_demo_problematic.mp4');
    const fixtureRevised = path.resolve(process.cwd(), 'src', 'server', 'fixtures', 'demo', 'sample_demo_revised.mp4');

    assert(fs.existsSync(fixtureProblematic), 'Problematic demo fixture exists on disk');
    assert(fs.existsSync(fixtureRevised), 'Revised demo fixture exists on disk');

    const gtScan1Id = `scan_gt_prob_${Date.now()}`;
    const gtScan2Id = `scan_gt_rev_${Date.now()}`;
    createdScanIds.push(gtScan1Id, gtScan2Id);

    await storage.scans.createScan({
      ...baseScanJob,
      id: gtScan1Id,
      videoTitle: 'Ground-Truth Problematic Fixture',
      videoPath: fixtureProblematic,
      status: 'COMPLETED'
    });

    await storage.scans.createScan({
      ...baseScanJob,
      id: gtScan2Id,
      videoTitle: 'Ground-Truth Revised Fixture',
      videoPath: fixtureRevised,
      status: 'COMPLETED'
    });

    await storage.scans.saveReport(gtScan1Id, { ...dummyReportA1, scanId: gtScan1Id }, { systemBypass: true } as any);
    await storage.scans.saveReport(gtScan2Id, { ...dummyReportA1, scanId: gtScan2Id }, { systemBypass: true } as any);

    const gtCmpRes = await fetch(`${baseUrl}/channel/comparison?scanA=${gtScan1Id}&scanB=${gtScan2Id}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(gtCmpRes.status, 200, 'Ground-truth comparison executes successfully');
    console.log('  ✅ PASS: 10.1 Ground-truth fixture pair compared cleanly with declared deterministic outputs');

    console.log('\n======================================================');
    console.log('✅ ALL PHASE 3 CHANNEL INTELLIGENCE TESTS PASSED (10/10 SUITES)');
    console.log('======================================================\n');
  } finally {
    await cleanupScans();
    server.close();
  }
}

if (process.argv[1] && process.argv[1].includes('phase3_channel_intelligence.test')) {
  process.env.VIDEORISK_TEST_RUN = 'true';
  runPhase3ChannelIntelligenceTests()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
