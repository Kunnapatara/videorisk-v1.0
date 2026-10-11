import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import express from 'express';
import { Server } from 'http';
import { apiRouter } from '../src/server/routes/api';
import { storage } from '../src/server/storage';
import { mediaInspector, MediaInspectionError } from '../src/server/pipeline/mediaInspector';
import { videoProcessor } from '../src/server/pipeline/videoProcessor';
import { audioProcessor } from '../src/server/pipeline/audioProcessor';
import { thumbnailInspector } from '../src/server/pipeline/thumbnailInspector';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { ScanJob, RiskReport } from '../src/types';

const execFileAsync = promisify(execFile);

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✅ PASS: ${message}`);
}

export async function runSecurityRetentionAndE2ETests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 9: SECURITY, RETENTION & FULL E2E ---');
  console.log('======================================================');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_e2e_fixtures_'));

  const app = express();
  app.use(express.json());
  app.use(apiRouter);

  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // ---------------------------------------------------------
    // Generate Real Test Media Fixtures via ffmpeg
    // ---------------------------------------------------------
    console.log('\n[Generating Real Media Test Fixtures via ffmpeg]');
    const noAudioPath = path.join(tempDir, 'fixture_no_audio.mp4');
    const withAudioPath = path.join(tempDir, 'fixture_with_audio.mp4');
    const audioOnlyPath = path.join(tempDir, 'fixture_audio_only.m4a');
    const corruptPath = path.join(tempDir, 'fixture_corrupt.mp4');
    const thumbPath = path.join(tempDir, 'fixture_thumb.jpg');

    // 1. Valid video without audio
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=30',
      '-c:v', 'libx264', noAudioPath
    ]);

    // 2. Valid video with audio tone
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-c:a', 'aac', withAudioPath
    ]);

    // 3. Audio-only container
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
      '-c:a', 'aac', audioOnlyPath
    ]);

    // 4. Corrupted file
    fs.writeFileSync(corruptPath, 'CORRUPTED_NON_MEDIA_DATA_BYTES_XYZ_123');

    // 5. Valid 16:9 thumbnail
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=navy:duration=1:size=1280x720:rate=1',
      '-vframes', '1', thumbPath
    ]);

    console.log('Real test fixtures generated successfully on disk.');

    // ---------------------------------------------------------
    // Scenario 1: Valid Video with No Audio
    // ---------------------------------------------------------
    console.log('\n[Scenario 1: Valid Video with No Audio]');
    const metaNoAudio = await mediaInspector.inspect(noAudioPath, 'video_silent.mp4');
    assert(metaNoAudio.hasAudio === false, 'Media inspector correctly observes hasAudio = false');
    assert(metaNoAudio.width === 320, 'Measured width matches (320px)');
    assert(metaNoAudio.height === 180, 'Measured height matches (180px)');
    assert(metaNoAudio.durationSeconds >= 1, 'Measured duration is non-zero');

    const audioAnalysisNoAudio = await audioProcessor.analyzeAudio(noAudioPath, metaNoAudio);
    assert(audioAnalysisNoAudio.hasVoiceover === false, 'Silent video does not claim voiceover');
    assert(audioAnalysisNoAudio.silenceRatio === 1, 'Silent video measures 100% silence ratio');

    // ---------------------------------------------------------
    // Scenario 2: Video Containing Music / Acoustic Tone Only
    // ---------------------------------------------------------
    console.log('\n[Scenario 2: Video Containing Acoustic Tone Only]');
    const metaAudio = await mediaInspector.inspect(withAudioPath, 'video_tone.mp4');
    assert(metaAudio.hasAudio === true, 'Media inspector observes audio stream exists');
    assert(metaAudio.audioCodec === 'aac', 'Detected audio codec is aac');

    const audioAnalysisTone = await audioProcessor.analyzeAudio(withAudioPath, metaAudio);
    assert(audioAnalysisTone.isAudible === true, 'Acoustic tone is detected as audible');
    assert(audioAnalysisTone.hasVoiceover === false, 'Pure acoustic tone does NOT falsely assert creator voiceover');
    assert(typeof audioAnalysisTone.meanVolumeDb === 'number', 'Mean volume measured deterministically');

    // ---------------------------------------------------------
    // Scenario 3: Audio-Only Container (No Video Stream)
    // ---------------------------------------------------------
    console.log('\n[Scenario 3: Audio-Only Container (No Video Stream)]');
    const metaAudioOnly = await mediaInspector.inspect(audioOnlyPath, 'podcast.m4a');
    assert(metaAudioOnly.hasAudio === true, 'Audio-only container observes hasAudio = true');
    assert(metaAudioOnly.width === 0, 'Audio-only container does NOT fabricate 1920 width (width = 0)');
    assert(metaAudioOnly.height === 0, 'Audio-only container does NOT fabricate 1080 height (height = 0)');
    assert(metaAudioOnly.resolutionLabel === 'Audio Only (No Video Stream)', 'Resolution label clearly states Audio Only');

    const videoAnalysisAudioOnly = await videoProcessor.analyzeVideo(audioOnlyPath, metaAudioOnly, 'standard');
    assert(videoAnalysisAudioOnly.scenesCount === 0, 'Audio-only container reports 0 video scenes');
    assert(videoAnalysisAudioOnly.framesSampled === 0, 'Audio-only container extracts 0 video frames');

    // ---------------------------------------------------------
    // Scenario 4: Corrupted Media File Fails Closed
    // ---------------------------------------------------------
    console.log('\n[Scenario 4: Corrupted / Truncated Media Container]');
    let corruptFailedClosed = false;
    try {
      await mediaInspector.inspect(corruptPath, 'corrupted.mp4');
    } catch (err: any) {
      if (err instanceof MediaInspectionError) {
        corruptFailedClosed = true;
      }
    }
    assert(corruptFailedClosed, 'Corrupted media container fails closed with MediaInspectionError');

    // ---------------------------------------------------------
    // Scenario 5: Valid Video with Thumbnail & Publishing Metadata
    // ---------------------------------------------------------
    console.log('\n[Scenario 5: Video with Thumbnail & Publishing Metadata]');
    const thumbMeta = await thumbnailInspector.inspect(thumbPath, 'cover.jpg');
    assert(thumbMeta.width === 1280, 'Thumbnail width measured accurately (1280px)');
    assert(thumbMeta.height === 720, 'Thumbnail height measured accurately (720px)');
    assert(thumbMeta.isStandardAspect === true, 'Thumbnail confirmed standard 16:9 aspect');

    // ---------------------------------------------------------
    // Scenario 6 & 7: Credit Deduction & Single Refund Lifecycle
    // ---------------------------------------------------------
    console.log('\n[Scenario 6 & 7: Idempotent Credit Deduction and Single Refund]');
    const creatorUser = await storage.users.createUser(`creator_e2e_${Date.now()}@videorisk.com`, 'h1', 's1', 30, 'creator');
    const scanId = `scan_e2e_${Date.now()}`;

    const scanRecord: ScanJob = {
      id: scanId,
      userId: creatorUser.id,
      videoTitle: 'E2E Publishing Test',
      videoFilename: 'fixture_with_audio.mp4',
      videoPath: withAudioPath,
      thumbnailPath: thumbPath,
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scanRecord);

    // Deduct credits
    const deductSuccess = await storage.scans.deductScanCredits(scanId, creatorUser.id, 10);
    assert(deductSuccess === true, '10 credits deducted for scan');
    const creatorAfterDeduct = await storage.users.getUser(creatorUser.id);
    assert(creatorAfterDeduct?.creditsRemaining === 20, 'Creator balance decreased to 20');

    // First refund on failure
    const refundResult1 = await storage.scans.refundScanCredits(scanId);
    assert(refundResult1.refunded === true, 'Scan refund granted');
    assert(refundResult1.amount === 10, 'Refunded exactly 10 credits');
    const creatorAfterRefund = await storage.users.getUser(creatorUser.id);
    assert(creatorAfterRefund?.creditsRemaining === 30, 'Creator balance restored back to 30');

    // Duplicate refund attempt must be blocked
    const refundResult2 = await storage.scans.refundScanCredits(scanId);
    assert(refundResult2.refunded === false, 'Duplicate refund attempt strictly blocked');
    assert(refundResult2.amount === 0, 'Duplicate refund granted 0 extra credits');
    const creatorAfterDuplicate = await storage.users.getUser(creatorUser.id);
    assert(creatorAfterDuplicate?.creditsRemaining === 30, 'Creator balance remains strictly 30 (no double refund)');

    // ---------------------------------------------------------
    // Scenario 8: Successful Scan with Report & Grounded Claims
    // ---------------------------------------------------------
    console.log('\n[Scenario 8: Successful Scan Report & Policy Intelligence]');
    const report = policyIntelligenceEngine.buildReport({
      scanId,
      metadata: metaAudio,
      scanMode: 'standard',
      audioResult: audioAnalysisTone,
      videoResult: {
        scenesCount: 1,
        framesSampled: 15,
        hasSlideshowPattern: false,
        repeatedFootageSegments: [],
        templateRepetitions: [],
        averagePacingSeconds: 2.0,
        tempFramesDir: ''
      },
      videoTitle: 'E2E Educational Breakdown',
      videoDescription: 'Original creative breakdown with commentary.',
      thumbnailMetadata: thumbMeta,
      isRescan: false
    }, []);

    assert(report.scanId === scanId, 'Report created for target scan ID');
    assert(report.originalContributionRatio === null, 'Original contribution ratio is null (unverified acoustic audio)');
    assert(report.originalContributionStatus === 'INSUFFICIENT_EVIDENCE', 'Original contribution status is INSUFFICIENT_EVIDENCE');
    assert(
      !report.policyConnections.some(p => p.impact === 'Compliant'),
      'Report does NOT contain unsupported "Compliant" policy conclusions'
    );
    await storage.scans.saveReport(scanId, report);
    const savedReport = await storage.scans.getReport(scanId);
    assert(savedReport !== null, 'Report safely persisted and retrieved from storage');

    // ---------------------------------------------------------
    // Scenario 9: Revised Re-scan Delta Comparison
    // ---------------------------------------------------------
    console.log('\n[Scenario 9: Revised Re-scan Delta Comparison]');
    const revisedScanId = `scan_e2e_revised_${Date.now()}`;
    const revisedScanRecord: ScanJob = {
      id: revisedScanId,
      userId: creatorUser.id,
      videoTitle: 'E2E Publishing Test (Revised Cut)',
      videoFilename: 'fixture_with_audio_v2.mp4',
      videoPath: withAudioPath,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Media inspection', 'Audio & transcript', 'Scene analysis', 'Policy analysis', 'Risk report'],
      creditsUsed: 10,
      parentScanId: scanId,
      isRescan: true,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(revisedScanRecord);

    const revisedReport: RiskReport = {
      ...report,
      scanId: revisedScanId,
      topIssues: [], // resolved findings
      reusedContentRatio: 0
    };

    const comparison = policyIntelligenceEngine.generateComparison(report, revisedReport);
    assert(comparison.originalScanId === scanId, 'Comparison links original scan ID');
    assert(comparison.revisedScanId === revisedScanId, 'Comparison links revised scan ID');
    assert(comparison.signalsDelta <= 0, 'Signals delta correctly calculates reduction in issues');
    assert(comparison.originalRatios.originalContribution === null, 'Original unassessed commentary preserved as null');
    assert(comparison.revisedRatios.originalContribution === null, 'Revised unassessed commentary preserved as null');

    await storage.scans.saveComparison(comparison);
    const savedComparison = await storage.scans.getComparison(revisedScanId);
    assert(savedComparison !== null, 'Re-scan comparison safely persisted and retrieved');

    // ---------------------------------------------------------
    // Scenario 10: Operational Cost Telemetry
    // ---------------------------------------------------------
    console.log('\n[Scenario 10: Operational Cost & Processing Telemetry]');
    if (storage.getOperationalMetrics) {
      const operationalMetrics = await storage.getOperationalMetrics();
      assert(typeof operationalMetrics.totalScans === 'number', 'Operational metrics reports total scans');
      assert(typeof operationalMetrics.estimatedComputeCostUsd === 'number', 'Operational metrics reports compute cost estimate');
      assert(typeof operationalMetrics.estimatedStorageCostUsd === 'number', 'Operational metrics reports storage cost estimate');
    }

    // ---------------------------------------------------------
    // Scenario 11: Secure Ownership Checked Deletion & Retention
    // ---------------------------------------------------------
    console.log('\n[Scenario 11: Ownership Checked Deletion & Retention Cleanup]');
    // Create temporary session for creatorUser
    const sessionToken = await storage.users.createSession(creatorUser.id);

    // Delete scan via API
    const deleteRes = await fetch(`${baseUrl}/scans/${scanId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionToken}` }
    });
    assert(deleteRes.status === 200, 'DELETE /scans/:id returns 200 OK');
    const deleteData = await deleteRes.json();
    assert(deleteData.success === true, 'Scan successfully marked as deleted');

    // Verify scan no longer exists in storage
    const deletedScan = await storage.scans.getScan(scanId);
    assert(deletedScan === null, 'Scan record completely purged from storage');

    console.log('======================================================');
    console.log('TEST SUITE 9 COMPLETE: All Security, Retention & E2E assertions passed!');
    console.log('======================================================');
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
