import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import express from 'express';
import { videoProcessor } from '../src/server/pipeline/videoProcessor';
import { mediaInspector } from '../src/server/pipeline/mediaInspector';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { storage } from '../src/server/storage';
import { apiRouter } from '../src/server/routes/api';
import { MediaMetadata, RiskReport, TopIssue, ScanJob } from '../src/types';

const execFileAsync = promisify(execFile);

export async function runEvidenceIntegrityRegressionTests() {
  console.log('\n======================================================');
  console.log('--- SUITE 19: EVIDENCE INTEGRITY & REGRESSION VERIFICATION ---');
  console.log('Adaptive Sampling, Channel Coverage & Re-Scan Integrity');
  console.log('======================================================\n');

  const fixtureDir = path.resolve(process.cwd(), 'uploads', 'test_fixtures_suite19');
  if (!fs.existsSync(fixtureDir)) {
    fs.mkdirSync(fixtureDir, { recursive: true });
  }

  const generatedFiles: string[] = [];
  const createdScanIds: string[] = [];

  const cleanupScans = async () => {
    for (const id of createdScanIds) {
      try {
        await storage.scans.deleteScan(id);
      } catch {
        // ignore
      }
    }
    for (const f of generatedFiles) {
      try {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
        }
      } catch {
        // ignore
      }
    }
    try {
      if (fs.existsSync(fixtureDir)) {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  };

  // Express test app for HTTP endpoints
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // -------------------------------------------------------------------------
    // SECTION 1: ADAPTIVE SAMPLING & BENCHMARK METRIC INTEGRITY
    // -------------------------------------------------------------------------
    console.log('[1. Adaptive Sampling Extraction & Metric Integrity]');

    // 1.1 Generate Synthetic Multi-Cut Video for Adaptive Sampling
    const multiCutVideo = path.resolve(fixtureDir, 'adaptive_multi_cut.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-filter_complex', 'testsrc=size=320x240:rate=10:duration=2[s1];color=c=red:size=320x240:rate=10:duration=1.5[s2];testsrc2=size=320x240:rate=10:duration=2[s3];color=c=blue:size=320x240:rate=10:duration=1.5[s4];testsrc=size=320x240:rate=10:duration=2[s5];[s1][s2][s3][s4][s5]concat=n=5:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      multiCutVideo
    ]);
    generatedFiles.push(multiCutVideo);

    const metaMultiCut = await mediaInspector.inspect(multiCutVideo, 'adaptive_multi_cut.mp4');

    // 1.2 Baseline comparison
    const baseline = await videoProcessor.analyzeVideo(multiCutVideo, metaMultiCut, 'standard');
    await videoProcessor.cleanupFrames(baseline.tempFramesDir);
    assert(baseline.framesSampled > 0, '1.2 Baseline frames sampled > 0');
    assert((baseline.cutTimestamps || []).length >= 3, '1.2 Scene cuts detected in synthetic multi-cut fixture');

    // 1.3 Full actual adaptive extraction (SUCCESS)
    const adaptiveFull = await videoProcessor.analyzeVideoAdaptiveCandidate(multiCutVideo, metaMultiCut, 'standard', {
      windowSeconds: 0.5,
      maxAdditionalFrames: 10
    });
    await videoProcessor.cleanupFrames(adaptiveFull.tempFramesDir);

    assert(adaptiveFull.requestedFramesCount > 0, '1.3 Requested frames count > 0');
    assert(adaptiveFull.actualExtractedFramesCount === adaptiveFull.requestedFramesCount, '1.3 All requested frames extracted on disk');
    assert(adaptiveFull.framesValidatedReadable === adaptiveFull.requestedFramesCount, '1.3 All extracted frames validated readable');
    assert.strictEqual(adaptiveFull.actualAnalyzedFramesCount, 0, '1.3 actualAnalyzedFramesCount is strictly 0 since no perceptual algorithm is implemented');
    assert.strictEqual(adaptiveFull.additionalFramesExtracted, adaptiveFull.framesValidatedReadable, '1.3 additionalFramesExtracted matches framesValidatedReadable');
    assert.strictEqual(adaptiveFull.framesSampled, baseline.framesSampled + adaptiveFull.additionalFramesExtracted, '1.3 framesSampled strictly equals baseline + verified additional frames');
    assert.strictEqual(adaptiveFull.adaptiveExtractionStatus, 'SUCCESS', '1.3 Adaptive extraction status is SUCCESS');
    assert(adaptiveFull.sceneCutCoverageRatio >= 0.80, '1.3 sceneCutCoverageRatio calculated from validated frames achieves >= 80%');
    assert(adaptiveFull.candidateOverheadMs >= 0, '1.3 candidateOverheadMs is non-negative and isolated');
    console.log('  ✅ PASS: 1.1 Full actual adaptive frame extraction, readability validation, and coverage verified');

    // 1.4 Simulated extraction failure (FAILED)
    const adaptiveFailed = await videoProcessor.analyzeVideoAdaptiveCandidate(multiCutVideo, metaMultiCut, 'standard', {
      windowSeconds: 0.5,
      maxAdditionalFrames: 10,
      simulateExtractionFailure: true
    });
    await videoProcessor.cleanupFrames(adaptiveFailed.tempFramesDir);

    assert(adaptiveFailed.requestedFramesCount > 0, '1.4 Candidate timestamps identified');
    assert.strictEqual(adaptiveFailed.actualExtractedFramesCount, 0, '1.4 Zero frames extracted on failure');
    assert.strictEqual(adaptiveFailed.framesValidatedReadable, 0, '1.4 Zero frames validated on failure');
    assert.strictEqual(adaptiveFailed.actualAnalyzedFramesCount, 0, '1.4 Zero frames analyzed on failure');
    assert.strictEqual(adaptiveFailed.additionalFramesExtracted, 0, '1.4 additionalFramesExtracted is 0 on extraction failure');
    assert.strictEqual(adaptiveFailed.framesSampled, baseline.framesSampled, '1.4 framesSampled does NOT increment when extraction fails');
    assert.strictEqual(adaptiveFailed.adaptiveExtractionStatus, 'FAILED', '1.4 Adaptive extraction status is FAILED');
    console.log('  ✅ PASS: 1.2 Extraction failure safely caught: 0 frames counted, status FAILED');

    // 1.5 Simulated corrupt / truncated RGB bytes (<192 bytes)
    const adaptiveCorruptRgb = await videoProcessor.analyzeVideoAdaptiveCandidate(multiCutVideo, metaMultiCut, 'standard', {
      windowSeconds: 0.5,
      maxAdditionalFrames: 10,
      simulateCorruptRgbBytes: true
    });
    await videoProcessor.cleanupFrames(adaptiveCorruptRgb.tempFramesDir);

    assert(adaptiveCorruptRgb.actualExtractedFramesCount > 0, '1.5 Frames extracted on disk');
    assert.strictEqual(adaptiveCorruptRgb.framesValidatedReadable, 0, '1.5 Zero frames validated readable when RGB bytes are corrupt');
    assert.strictEqual(adaptiveCorruptRgb.actualAnalyzedFramesCount, 0, '1.5 Zero frames analyzed');
    assert.strictEqual(adaptiveCorruptRgb.additionalFramesExtracted, 0, '1.5 additionalFramesExtracted is 0 when validation fails');
    assert.strictEqual(adaptiveCorruptRgb.framesSampled, baseline.framesSampled, '1.5 framesSampled does NOT increment for unreadable frames');
    assert.strictEqual(adaptiveCorruptRgb.adaptiveExtractionStatus, 'FAILED', '1.5 Status is FAILED when all extractions fail readability');
    console.log('  ✅ PASS: 1.3 Corrupt RGB bytes (<192 bytes) rejected from sampled frames, status FAILED');

    // 1.6 Simulated partial extraction (PARTIAL)
    const adaptivePartial = await videoProcessor.analyzeVideoAdaptiveCandidate(multiCutVideo, metaMultiCut, 'standard', {
      windowSeconds: 0.5,
      maxAdditionalFrames: 10,
      simulatePartialExtractionCount: 2
    });
    await videoProcessor.cleanupFrames(adaptivePartial.tempFramesDir);

    assert(adaptivePartial.requestedFramesCount > 2, '1.6 Requested frames count > 2');
    assert.strictEqual(adaptivePartial.actualExtractedFramesCount, 2, '1.6 Exactly 2 frames extracted');
    assert.strictEqual(adaptivePartial.framesValidatedReadable, 2, '1.6 Exactly 2 frames validated readable');
    assert.strictEqual(adaptivePartial.actualAnalyzedFramesCount, 0, '1.6 actualAnalyzedFramesCount remains 0');
    assert.strictEqual(adaptivePartial.additionalFramesExtracted, 2, '1.6 additionalFramesExtracted is exactly 2');
    assert.strictEqual(adaptivePartial.framesSampled, baseline.framesSampled + 2, '1.6 framesSampled increments only by verified 2 frames');
    assert.strictEqual(adaptivePartial.adaptiveExtractionStatus, 'PARTIAL', '1.6 Adaptive extraction status is PARTIAL');
    console.log('  ✅ PASS: 1.4 Partial extraction accurately counts only extracted frames, status PARTIAL');

    // 1.6 Continuous video without cuts (SKIPPED_NO_CANDIDATES)
    const continuousVideo = path.resolve(fixtureDir, 'adaptive_continuous.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=size=320x240:rate=10:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      continuousVideo
    ]);
    generatedFiles.push(continuousVideo);
    const metaContinuous = await mediaInspector.inspect(continuousVideo, 'adaptive_continuous.mp4');

    const adaptiveNoCuts = await videoProcessor.analyzeVideoAdaptiveCandidate(continuousVideo, metaContinuous, 'standard');
    await videoProcessor.cleanupFrames(adaptiveNoCuts.tempFramesDir);

    assert.strictEqual(adaptiveNoCuts.requestedFramesCount, 0, '1.7 Zero candidate timestamps for continuous video');
    assert.strictEqual(adaptiveNoCuts.additionalFramesExtracted, 0, '1.7 Zero additional frames for continuous video');
    assert.strictEqual(adaptiveNoCuts.adaptiveExtractionStatus, 'SKIPPED_NO_CANDIDATES', '1.7 Status is SKIPPED_NO_CANDIDATES');
    console.log('  ✅ PASS: 1.5 Continuous video with 0 cuts reports SKIPPED_NO_CANDIDATES without redundant extraction');

    // 1.8 Non-video input (audio-only container)
    const audioOnlyMeta: MediaMetadata = {
      filename: 'audio_only.mp3',
      durationSeconds: 15,
      width: 0,
      height: 0,
      resolutionLabel: 'audio',
      fps: 0,
      hasAudio: true,
      audioCodec: 'mp3',
      isProxyUsed: false,
      originalSize: 10000
    };
    const adaptiveAudio = await videoProcessor.analyzeVideoAdaptiveCandidate(continuousVideo, audioOnlyMeta, 'standard');
    assert.strictEqual(adaptiveAudio.additionalFramesExtracted, 0, '1.8 Zero frames extracted for audio-only container');
    assert.strictEqual(adaptiveAudio.adaptiveExtractionStatus, 'SKIPPED_NO_CANDIDATES', '1.8 Status is SKIPPED_NO_CANDIDATES');
    console.log('  ✅ PASS: 1.6 Audio-only container safely handled with 0 frames added');

    // -------------------------------------------------------------------------
    // SECTION 2: CHANNEL INTELLIGENCE & TENANT ISOLATION REGRESSION
    // -------------------------------------------------------------------------
    console.log('\n[2. Channel Intelligence & Tenant Isolation Regression]');

    // Helper to register users
    const registerUser = async (tag: string) => {
      const email = `reg_${tag}_${Date.now()}@videorisk.com`;
      const res = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'password123' })
      });
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      return { user: data.user, token: data.token };
    };

    const { user: u1, token: t1 } = await registerUser('tenant1');
    const { user: u2, token: t2 } = await registerUser('tenant2');

    // 2.1 Seed scans for User 1
    const s1Id = `scan_reg_u1_1_${Date.now()}`;
    const s2Id = `scan_reg_u1_2_${Date.now()}`;
    createdScanIds.push(s1Id, s2Id);

    const baseScan: Omit<ScanJob, 'id' | 'userId' | 'videoTitle' | 'videoDescription'> = {
      videoFilename: 'demo.mp4',
      videoPath: 'uploads/demo.mp4',
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Media inspection', 'Scene analysis', 'Risk report'],
      creditsUsed: 1,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };

    await storage.scans.createScan({
      ...baseScan,
      id: s1Id,
      userId: u1.id,
      videoTitle: 'Episode 1: Tech Review',
      videoDescription: 'Standard description with channel links and social media information.'
    });
    await storage.scans.saveReport(s1Id, {
      scanId: s1Id,
      overallRisk: 'LOW_RISK',
      originalContributionRatio: null,
      topIssues: []
    } as any, { systemBypass: true } as any);

    await storage.scans.createScan({
      ...baseScan,
      id: s2Id,
      userId: u1.id,
      videoTitle: 'Episode 2: Tech Review',
      videoDescription: 'Standard description with channel links and social media information.'
    });
    await storage.scans.saveReport(s2Id, {
      scanId: s2Id,
      overallRisk: 'LOW_RISK',
      originalContributionRatio: null,
      topIssues: []
    } as any, { systemBypass: true } as any);

    // Seed scan for User 2 (different tenant)
    const s3Id = `scan_reg_u2_1_${Date.now()}`;
    createdScanIds.push(s3Id);
    await storage.scans.createScan({
      ...baseScan,
      id: s3Id,
      userId: u2.id,
      videoTitle: 'Unrelated Solo Video',
      videoDescription: 'Unique user 2 description.'
    });
    await storage.scans.saveReport(s3Id, {
      scanId: s3Id,
      overallRisk: 'LOW_RISK',
      originalContributionRatio: null,
      topIssues: []
    } as any, { systemBypass: true } as any);

    // Fetch patterns for User 1
    const resU1 = await fetch(`${baseUrl}/channel/patterns`, {
      headers: { Authorization: `Bearer ${t1}` }
    });
    assert.strictEqual(resU1.status, 200, '2.1 User 1 patterns endpoint succeeds');
    const dataU1 = await resU1.json();

    assert.strictEqual(dataU1.sampleSize, 2, '2.1 User 1 sample size strictly includes only User 1 completed scans');
    assert(dataU1.patterns.every((p: any) => !p.evidenceReferences.includes(s3Id)), '2.1 User 2 scans never appear in User 1 patterns');

    // Fetch patterns for User 2
    const resU2 = await fetch(`${baseUrl}/channel/patterns`, {
      headers: { Authorization: `Bearer ${t2}` }
    });
    const dataU2 = await resU2.json();
    assert.strictEqual(dataU2.sampleSize, 1, '2.1 User 2 sample size reflects only User 2 scan');
    assert.strictEqual(dataU2.patterns.length, 0, '2.1 User 2 with sampleSize < 2 returns empty patterns');
    console.log('  ✅ PASS: 2.1 Strict tenant isolation between User 1 and User 2 verified');

    // 2.2 Verify Series Title Template is info severity and not flagged as a violation
    const seriesPattern = dataU1.patterns.find((p: any) => p.patternType === 'series_title_template');
    assert(seriesPattern, '2.2 Series title template detected for Episode 1 / Episode 2');
    assert.strictEqual(seriesPattern.severity, 'info', '2.2 Series title pattern is info severity, NOT a violation');
    assert(seriesPattern.explanation.includes('standard episodic series format'), '2.2 Explanation notes standard episodic series format');
    console.log('  ✅ PASS: 2.2 Series title formatting treated as informational without policy violation');

    // 2.3 Verify Repeated Description is info severity
    const descPattern = dataU1.patterns.find((p: any) => p.patternType === 'repeated_description');
    assert(descPattern, '2.3 Repeated description pattern detected');
    assert.strictEqual(descPattern.severity, 'info', '2.3 Repeated description pattern is info severity');
    console.log('  ✅ PASS: 2.3 Repeated description detected as informational observation');

    // 2.4 Verify Coverage Matrix reports NOT_AVAILABLE and INSUFFICIENT_EVIDENCE
    assert.strictEqual(dataU1.coverage.introOutro, 'NOT_AVAILABLE', '2.4 introOutro is NOT_AVAILABLE');
    assert.strictEqual(dataU1.coverage.crossVideoFootage, 'NOT_AVAILABLE', '2.4 crossVideoFootage is NOT_AVAILABLE');
    assert.strictEqual(dataU1.coverage.audioPatterns, 'NOT_AVAILABLE', '2.4 audioPatterns is NOT_AVAILABLE');
    assert.strictEqual(dataU1.coverage.originalContribution, 'INSUFFICIENT_EVIDENCE', '2.4 originalContribution is INSUFFICIENT_EVIDENCE');
    assert(dataU1.mandatoryCoverageStatement.includes('Channel insights are based only on videos uploaded'), '2.4 Mandatory statement present');
    console.log('  ✅ PASS: 2.4 Coverage matrix accurately declares non-persisted capabilities and mandatory disclaimer');

    // -------------------------------------------------------------------------
    // SECTION 3: REPORT GENERATOR & RE-SCAN INTEGRITY
    // -------------------------------------------------------------------------
    console.log('\n[3. Report Generator & Re-Scan Evidence Integrity]');

    const dummyMeta: MediaMetadata = {
      filename: 'sample.mp4',
      durationSeconds: 30,
      width: 1920,
      height: 1080,
      resolutionLabel: '1080p',
      fps: 30,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      isProxyUsed: false,
      originalSize: 5000000,
      sha256: 'a'.repeat(64)
    };

    const baseReport: RiskReport = {
      scanId: 'scan_orig_base',
      overallRisk: 'NEEDS_REVIEW',
      originalContributionRatio: null,
      topIssues: [
        {
          id: 'issue_orig_rep',
          domain: 'video_audio',
          type: 'repeated_visual_footage',
          what: '🟡 Repeated Visual Footage (95% match)',
          where: '00:10–00:18',
          why: 'Visual frames repeat earlier section.',
          fix: 'Trim redundant footage.',
          evidence: 'video:frame_repeat',
          context: 'Repetitive content review',
          recommendedAction: 'Trim or vary repeated visual segments.',
          limitations: 'Detects within-video repetition.',
          confidence: 'HIGH',
          severity: 'warning',
          policyArea: 'REUSED CONTENT',
          category: 'reused_content',
          timestampSeconds: 10
        },
        {
          id: 'issue_orig_sil',
          domain: 'video_audio',
          type: 'extended_silence',
          what: '🟡 Extended Silence / Unedited Gap',
          where: '00:20–00:27',
          why: 'Audio drops below -30dB.',
          fix: 'Check pacing.',
          evidence: 'audio:silencedetect:gap',
          context: 'Dead air review',
          recommendedAction: 'Check audio track pacing.',
          limitations: 'Measures decibel energy.',
          confidence: 'HIGH',
          severity: 'warning',
          policyArea: 'ORIGINAL CONTRIBUTION',
          category: 'original_contribution',
          timestampSeconds: 20
        }
      ],
      domainReports: {
        video_audio: {
          domain: 'video_audio',
          domainLabel: 'Video & Audio',
          status: 'REVIEW_RECOMMENDED',
          summary: 'Issues detected',
          findingsCount: 2,
          confidence: 'HIGH',
          limitations: 'Local media inspection.'
        },
        title: { domain: 'title', domainLabel: 'Title', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean', findingsCount: 0, confidence: 'HIGH', limitations: 'Lexicon check.' },
        description_tags: { domain: 'description_tags', domainLabel: 'Desc', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean', findingsCount: 0, confidence: 'HIGH', limitations: 'Text check.' },
        thumbnail: { domain: 'thumbnail', domainLabel: 'Thumb', status: 'NOT_PROVIDED', summary: 'None', findingsCount: 0, confidence: 'UNKNOWN', limitations: 'Format check.' },
        channel_context: { domain: 'channel_context', domainLabel: 'Profile', status: 'NOT_PROVIDED', summary: 'None', findingsCount: 0, confidence: 'UNKNOWN', limitations: 'Self-reported.' }
      }
    } as any;

    // 3.1 Still Present: matching issue persists when present in revised scan
    const revReportPersisting: RiskReport = {
      ...baseReport,
      scanId: 'scan_rev_persist',
      topIssues: [
        {
          ...baseReport.topIssues[0],
          id: 'issue_rev_newid_same_issue' // ID changed, but same issue!
        }
      ]
    };

    const compPersist = policyIntelligenceEngine.generateComparison(baseReport, revReportPersisting, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'a'.repeat(64) } },
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'b'.repeat(64) } }
    });

    assert(compPersist.remainingIssues.length === 1, '3.1 Issue with changed ID but identical type/location correctly matched as remaining');
    assert(compPersist.remainingIssues[0].includes('Repeated Visual Footage'), '3.1 Persisting issue identified');
    console.log('  ✅ PASS: 3.1 Still Present: Finding ID change matches original issue without false New Issue');

    // 3.2 Genuine New Issue
    const revReportWithNew: RiskReport = {
      ...baseReport,
      scanId: 'scan_rev_new',
      topIssues: [
        ...baseReport.topIssues,
        {
          id: 'issue_brand_new',
          domain: 'title',
          type: 'sensitive_title_term',
          what: '🟡 Title Phrase Scrutiny: "Cure"',
          where: 'Title',
          why: 'Sensational claim term',
          fix: 'Revise title',
          evidence: 'nlp:lexicon',
          context: 'Misleading metadata',
          recommendedAction: 'Revise title',
          limitations: 'Lexicon match',
          confidence: 'HIGH',
          severity: 'warning',
          policyArea: 'METADATA COHERENCE',
          category: 'metadata_coherence',
          timestampSeconds: 0
        }
      ]
    };

    const compNew = policyIntelligenceEngine.generateComparison(baseReport, revReportWithNew);
    assert(compNew.newIssues!.length === 1, '3.2 Brand new issue recognized as new issue');
    assert(compNew.newIssues![0].includes('Title Phrase Scrutiny'), '3.2 New issue matches added finding');
    console.log('  ✅ PASS: 3.2 Genuine New Issue identified and separated from existing issues');

    // 3.3 Detector Unassessed / Incomplete -> NOT VERIFIED (Never falsely Resolved)
    const revReportUnassessed: RiskReport = {
      ...baseReport,
      scanId: 'scan_rev_unassessed',
      topIssues: [], // Report has 0 issues, BUT domain is NOT_ASSESSED!
      domainReports: {
        ...baseReport.domainReports,
        video_audio: {
          domain: 'video_audio',
          domainLabel: 'Video & Audio',
          status: 'NOT_ASSESSED',
          summary: 'Detector not evaluated',
          findingsCount: 0,
          confidence: 'LOW',
          limitations: 'Not evaluated.'
        }
      }
    };

    const compUnassessed = policyIntelligenceEngine.generateComparison(baseReport, revReportUnassessed);
    assert.strictEqual(compUnassessed.resolvedIssues.length, 0, '3.3 Zero issues resolved when detector was NOT_ASSESSED');
    assert(compUnassessed.notVerifiedIssues!.length >= 2, '3.3 Prior issues marked NOT VERIFIED');
    assert(compUnassessed.notVerifiedIssues![0].includes('NOT VERIFIED'), '3.3 NOT VERIFIED reason noted');
    console.log('  ✅ PASS: 3.3 Missing findings on unassessed detector marked NOT VERIFIED (never Resolved)');

    // 3.4 Revised Scan Failed -> NOT VERIFIED
    const compFailed = policyIntelligenceEngine.generateComparison(baseReport, { ...baseReport, topIssues: [] }, {
      isRevisedFailed: true
    });
    assert.strictEqual(compFailed.resolvedIssues.length, 0, '3.4 Failed revised scan cannot resolve any issues');
    assert(compFailed.notVerifiedIssues!.length >= 2, '3.4 All baseline issues marked NOT VERIFIED on failed scan');
    console.log('  ✅ PASS: 3.4 Failed revised scan marks all issues NOT VERIFIED');

    // 3.5 Incomparable media: truncated revised duration shorter than baseline issue timestamp
    const compTruncated = policyIntelligenceEngine.generateComparison(baseReport, {
      ...baseReport,
      topIssues: [],
      domainReports: {
        ...baseReport.domainReports,
        video_audio: { domain: 'video_audio', domainLabel: 'V&A', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean', findingsCount: 0, confidence: 'HIGH', limitations: 'Clean.' }
      }
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'a'.repeat(64) } },
      revisedScanRecord: {
        status: 'COMPLETED',
        metadata: {
          ...dummyMeta,
          durationSeconds: 15, // Shorter than second baseline issue at 20s!
          sha256: 'b'.repeat(64)
        }
      }
    });

    const silenceNotVerified = compTruncated.notVerifiedIssues!.find(i => i.includes('Extended Silence'));
    assert(Boolean(silenceNotVerified), '3.5 Issue at 20s marked NOT VERIFIED when revised video is only 15s');
    assert(silenceNotVerified?.includes('shorter than baseline issue timestamp'), '3.5 Clear reason explaining duration truncation');
    console.log('  ✅ PASS: 3.5 Truncated revised duration prevents false resolution of later issue');

    // 3.6 Revised video has no audio stream when verifying audio issue
    const compNoAudio = policyIntelligenceEngine.generateComparison(baseReport, {
      ...baseReport,
      topIssues: [],
      domainReports: {
        ...baseReport.domainReports,
        video_audio: { domain: 'video_audio', domainLabel: 'V&A', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean', findingsCount: 0, confidence: 'HIGH', limitations: 'Clean.' }
      }
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'a'.repeat(64) } },
      revisedScanRecord: {
        status: 'COMPLETED',
        metadata: {
          ...dummyMeta,
          hasAudio: false,
          audioCodec: undefined,
          sha256: 'c'.repeat(64)
        }
      }
    });

    const audioUnverified = compNoAudio.notVerifiedIssues!.find(i => i.includes('Extended Silence'));
    assert(Boolean(audioUnverified), '3.6 Audio issue cannot be verified as resolved without audio stream');
    assert(audioUnverified?.includes('contains no audio track'), '3.6 Clear reason noting missing audio track');
    console.log('  ✅ PASS: 3.6 Missing audio track in revised scan marks audio issues NOT VERIFIED');

    // 3.7 Byte-for-byte identical media (matching SHA-256) cannot resolve media issues
    const compIdenticalSha = policyIntelligenceEngine.generateComparison(baseReport, {
      ...baseReport,
      topIssues: [], // Falsely cleared issues
      domainReports: {
        ...baseReport.domainReports,
        video_audio: { domain: 'video_audio', domainLabel: 'V&A', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean', findingsCount: 0, confidence: 'HIGH', limitations: 'Clean.' }
      }
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'f'.repeat(64) } },
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'f'.repeat(64) } } // EXACT SAME SHA!
    });

    assert.strictEqual(compIdenticalSha.resolvedIssues.length, 0, '3.7 Media issues cannot be resolved on identical SHA-256 file');
    assert(compIdenticalSha.notVerifiedIssues!.length >= 2, '3.7 Both media issues marked NOT VERIFIED on identical file');
    assert(compIdenticalSha.notVerifiedIssues![0].includes('matching SHA-256'), '3.7 Reason mentions identical SHA-256');
    console.log('  ✅ PASS: 3.7 Byte-for-byte identical media (matching SHA-256) forbids claiming media resolution');

    // 3.8 Verifiable Resolution: Different media file, active detector, clean result
    const compVerifiable = policyIntelligenceEngine.generateComparison(baseReport, {
      ...baseReport,
      topIssues: [], // Clean revision
      domainReports: {
        ...baseReport.domainReports,
        video_audio: { domain: 'video_audio', domainLabel: 'V&A', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean audio/video verified', findingsCount: 0, confidence: 'HIGH', limitations: 'Clean.' }
      }
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'a'.repeat(64) } },
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, durationSeconds: 30, sha256: 'e'.repeat(64) } }
    });

    assert.strictEqual(compVerifiable.resolvedIssues.length, 2, '3.8 Both issues verifiably resolved with genuine evidence');
    assert.strictEqual(compVerifiable.remainingIssues.length, 0, '3.8 Zero remaining issues');
    assert.strictEqual(compVerifiable.notVerifiedIssues?.length || 0, 0, '3.8 Zero unverified issues');
    assert(compVerifiable.comparisonSummary.includes('Re-scan verified. Resolved 2 prior risk signal(s) with evidence'), '3.8 Verified summary generated');
    console.log('  ✅ PASS: 3.8 Verifiable Resolution confirmed with evidence and updated media version');

    // 3.9 Missing and Invalid SHA-256 Hash Handling (Never falsely claims DIFFERENT or IDENTICAL)
    const compMissingSha = policyIntelligenceEngine.generateComparison(baseReport, {
      ...baseReport,
      topIssues: [],
      domainReports: {
        ...baseReport.domainReports,
        video_audio: { domain: 'video_audio', domainLabel: 'V&A', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean', findingsCount: 0, confidence: 'HIGH', limitations: 'Clean.' }
      }
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: undefined } }, // Missing hash!
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'e'.repeat(64) } }
    });
    assert.strictEqual(compMissingSha.mediaIdentity?.comparisonStatus, 'UNVERIFIED', '3.9 Missing hash marked UNVERIFIED');
    assert.strictEqual(compMissingSha.mediaIdentity?.isIdenticalMedia, false, '3.9 Missing hash is not identical');

    const compInvalidSha = policyIntelligenceEngine.generateComparison(baseReport, {
      ...baseReport,
      topIssues: [],
      domainReports: {
        ...baseReport.domainReports,
        video_audio: { domain: 'video_audio', domainLabel: 'V&A', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean', findingsCount: 0, confidence: 'HIGH', limitations: 'Clean.' }
      }
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'short_invalid_hash' } },
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'not_a_valid_sha256' } }
    });
    assert.strictEqual(compInvalidSha.mediaIdentity?.comparisonStatus, 'UNVERIFIED', '3.9 Invalid format hash marked UNVERIFIED');
    console.log('  ✅ PASS: 3.9 Missing and invalid SHA-256 hashes safely declared UNVERIFIED without false claims');

    // 3.10 Timestamp = 0 and Near-Boundary Duration Verification
    const reportWithZeroAndBoundary: RiskReport = {
      ...baseReport,
      topIssues: [
        {
          id: 'issue_intro_zero',
          domain: 'video_audio',
          type: 'repeated_visual_footage',
          what: '🟡 Intro Repetition',
          where: '00:00–00:08',
          why: 'Repeats intro.',
          fix: 'Vary opening.',
          evidence: 'video:frame_repeat',
          context: 'Intro review',
          recommendedAction: 'Trim intro.',
          limitations: 'Local check.',
          confidence: 'HIGH',
          severity: 'warning',
          policyArea: 'REUSED CONTENT',
          category: 'reused_content',
          timestampSeconds: 0 // Timestamp is 0, but span extends to 8s
        },
        {
          id: 'issue_outro_boundary',
          domain: 'video_audio',
          type: 'extended_silence',
          what: '🟡 Outro Dead Air',
          where: '00:27–00:30',
          why: 'Silence at end of 30s video.',
          fix: 'Trim outro.',
          evidence: 'audio:silencedetect:gap',
          context: 'Outro review',
          recommendedAction: 'Trim outro.',
          limitations: 'Decibel check.',
          confidence: 'HIGH',
          severity: 'warning',
          policyArea: 'ORIGINAL CONTRIBUTION',
          category: 'original_contribution',
          timestampSeconds: 27 // Timestamp near duration boundary
        }
      ]
    };

    // Revised video is only 5s: shorter than intro span (8s)
    const compIntroTruncated = policyIntelligenceEngine.generateComparison(reportWithZeroAndBoundary, {
      ...reportWithZeroAndBoundary,
      topIssues: [],
      domainReports: {
        ...reportWithZeroAndBoundary.domainReports,
        video_audio: { domain: 'video_audio', domainLabel: 'V&A', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean', findingsCount: 0, confidence: 'HIGH', limitations: 'Clean.' }
      }
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'a'.repeat(64) } },
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, durationSeconds: 5, sha256: 'b'.repeat(64) } }
    });
    const introNotVerified = compIntroTruncated.notVerifiedIssues!.find(i => i.includes('Intro Repetition'));
    assert(Boolean(introNotVerified), '3.10 Finding with timestamp=0 spanning to 8s rejected when revised video is 5s');
    assert(introNotVerified?.includes('shorter than baseline issue timestamp'), '3.10 Reason notes duration truncation for timestamp=0 range');

    // Revised video has 0 duration
    const compZeroDuration = policyIntelligenceEngine.generateComparison(reportWithZeroAndBoundary, {
      ...reportWithZeroAndBoundary,
      topIssues: [],
      domainReports: {
        ...reportWithZeroAndBoundary.domainReports,
        video_audio: { domain: 'video_audio', domainLabel: 'V&A', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean', findingsCount: 0, confidence: 'HIGH', limitations: 'Clean.' }
      }
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'a'.repeat(64) } },
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, durationSeconds: 0, sha256: 'b'.repeat(64) } }
    });
    assert(compZeroDuration.notVerifiedIssues!.every(i => i.includes('zero or invalid duration')), '3.10 Zero duration rejected with clear reason');
    console.log('  ✅ PASS: 3.10 Timestamp=0 ranges, near-boundary timestamps, and zero duration strictly verified');

    // 3.11 Audio Finding Formats & Visual Stream Verification
    const reportDiverseFindings: RiskReport = {
      ...baseReport,
      topIssues: [
        {
          id: 'issue_audio_pcm',
          domain: 'video_audio',
          type: 'repeated_audio_segment',
          what: 'ℹ️ Repeated Acoustic Pattern',
          where: '00:05–00:12',
          why: 'Acoustic energy repeats.',
          fix: 'Vary audio.',
          evidence: 'Direct measured observation via audio_processor:pcm_energy_zcr', // Doesn't start with 'audio:'
          context: 'Acoustic review',
          recommendedAction: 'Check licensing.',
          limitations: 'Local check.',
          confidence: 'HIGH',
          severity: 'warning',
          policyArea: 'REUSED CONTENT',
          category: 'reused_content',
          timestampSeconds: 5
        },
        {
          id: 'issue_audio_category',
          domain: 'video_audio',
          what: '🟡 Audio Clarity Anomaly',
          where: '00:10',
          why: 'Unusual audio mix.',
          fix: 'Adjust mix.',
          evidence: 'dsp_filter:bandpass', // No 'audio' in evidence string
          context: 'Mix review',
          recommendedAction: 'Adjust mix.',
          limitations: 'Frequency filter.',
          confidence: 'HIGH',
          severity: 'warning',
          policyArea: 'AUDIO QUALITY',
          category: 'audio_clarity' as any, // Testing fallback category handling
          timestampSeconds: 10
        },
        {
          id: 'issue_visual_slideshow',
          domain: 'video_audio',
          type: 'slideshow_pattern_detected',
          what: '🟡 Slideshow Presentation Pattern Detected',
          where: '00:00–00:30',
          why: 'Static stills.',
          fix: 'Add motion.',
          evidence: 'video_processor:intra_scene_invariance_heuristic',
          context: 'Slideshow review',
          recommendedAction: 'Add commentary.',
          limitations: 'Pacing check.',
          confidence: 'HIGH',
          severity: 'warning',
          policyArea: 'INAUTHENTIC PATTERN',
          category: 'inauthentic_pattern',
          timestampSeconds: 0
        }
      ]
    };

    // When revised media has no audio, both audio findings must be NOT VERIFIED
    const compAudioDiverse = policyIntelligenceEngine.generateComparison(reportDiverseFindings, {
      ...reportDiverseFindings,
      topIssues: [],
      domainReports: {
        ...reportDiverseFindings.domainReports,
        video_audio: { domain: 'video_audio', domainLabel: 'V&A', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean', findingsCount: 0, confidence: 'HIGH', limitations: 'Clean.' }
      }
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'a'.repeat(64) } },
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, hasAudio: false, audioCodec: undefined, sha256: 'b'.repeat(64) } }
    });
    const pcmNotVerified = compAudioDiverse.notVerifiedIssues!.find(i => i.includes('Repeated Acoustic Pattern'));
    const catNotVerified = compAudioDiverse.notVerifiedIssues!.find(i => i.includes('Audio Clarity Anomaly'));
    assert(Boolean(pcmNotVerified), '3.11 PCM audio repetition marked NOT VERIFIED without audio stream');
    assert(Boolean(catNotVerified), '3.11 audio_clarity category marked NOT VERIFIED without audio stream');

    // When revised media has no video codec, visual finding must be NOT VERIFIED
    const compVisualNoStream = policyIntelligenceEngine.generateComparison(reportDiverseFindings, {
      ...reportDiverseFindings,
      topIssues: [],
      domainReports: {
        ...reportDiverseFindings.domainReports,
        video_audio: { domain: 'video_audio', domainLabel: 'V&A', status: 'NO_MAJOR_RISK_SIGNALS_DETECTED', summary: 'Clean', findingsCount: 0, confidence: 'HIGH', limitations: 'Clean.' }
      }
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'a'.repeat(64) } },
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, videoCodec: undefined, width: 0, sha256: 'b'.repeat(64) } }
    });
    const slideNotVerified = compVisualNoStream.notVerifiedIssues!.find(i => i.includes('Slideshow Presentation'));
    assert(Boolean(slideNotVerified), '3.11 Visual issue marked NOT VERIFIED when video stream is absent');
    assert(slideNotVerified?.includes('contains no video stream'), '3.11 Reason mentions no video stream');
    console.log('  ✅ PASS: 3.11 Audio finding patterns and visual stream prerequisites comprehensively verified');

    // 3.12 Non-Completed and In-Progress Scan State Verification
    const compProcessing = policyIntelligenceEngine.generateComparison(baseReport, {
      ...baseReport,
      topIssues: []
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'a'.repeat(64) } },
      revisedScanRecord: { status: 'PROCESSING', metadata: { ...dummyMeta, sha256: 'b'.repeat(64) } } // In progress!
    });
    assert.strictEqual(compProcessing.resolvedIssues.length, 0, '3.12 In-progress revised scan cannot resolve issues');
    assert(compProcessing.notVerifiedIssues!.every(i => i.includes('not completed')), '3.12 Mentions not completed');

    const compZeroSize = policyIntelligenceEngine.generateComparison(baseReport, {
      ...baseReport,
      topIssues: []
    }, {
      originalScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'a'.repeat(64) } },
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, originalSize: 0, sha256: 'b'.repeat(64) } } // 0 bytes file
    });
    assert.strictEqual(compZeroSize.resolvedIssues.length, 0, '3.12 Empty (0 byte) file cannot resolve issues');
    assert(compZeroSize.notVerifiedIssues!.every(i => i.includes('empty (0 bytes)')), '3.12 Mentions empty (0 bytes)');
    console.log('  ✅ PASS: 3.12 Incomplete scan states and empty media fail-closed to NOT VERIFIED');

    console.log('\n======================================================');
    console.log('✅ ALL EVIDENCE INTEGRITY & REGRESSION TESTS PASSED');
    console.log('======================================================');
  } finally {
    server.close();
    await cleanupScans();
  }
}

// Auto-run if executed directly via tsx
if (import.meta.url === `file://${process.argv[1]}`) {
  runEvidenceIntegrityRegressionTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Evidence integrity regression tests failed:', err);
      process.exit(1);
    });
}
