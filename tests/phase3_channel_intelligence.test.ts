import assert from 'assert';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { storage } from '../src/server/storage';
import { apiRouter } from '../src/server/routes/api';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { ScanJob, RiskReport, ChannelPatternsResponse } from '../src/types';

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

    console.log('\n======================================================');
    console.log('✅ ALL PHASE 3 CHANNEL INTELLIGENCE TESTS PASSED');
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
