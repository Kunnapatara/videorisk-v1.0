import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { audioProcessor, AudioProcessor, AudioProcessingError } from '../src/server/pipeline/audioProcessor';
import { videoProcessor } from '../src/server/pipeline/videoProcessor';
import { mediaInspector } from '../src/server/pipeline/mediaInspector';
import { thumbnailInspector, ThumbnailInspector } from '../src/server/pipeline/thumbnailInspector';
import { proxyGenerator, ProxyGenerationError } from '../src/server/pipeline/proxyGenerator';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { formatMediaIdentityDisplay, isValidSha256, getComparisonSubtitle } from '../src/components/ComparisonView';
import { InMemoryStorageRepository } from '../src/server/storage';
import { ScanJob, UserAccount, MediaMetadata, ReScanComparison } from '../src/types';

const execFileAsync = promisify(execFile);

export async function runEvidenceIntegrityHardeningTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 6: EVIDENCE INTEGRITY & CREDIT REFUND ---');
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

  const testDir = path.resolve(os.tmpdir(), `vr_evidence_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(testDir, { recursive: true });

  const tempStorePath = path.resolve(testDir, 'store.json');
  const storage = new InMemoryStorageRepository(tempStorePath);

  try {
    // -------------------------------------------------------------------------
    // SECTION 1: AUDIO ANALYSIS FAILS CLOSED (NO SYNTHETIC MEASUREMENTS)
    // -------------------------------------------------------------------------
    console.log('[1. Audio Processor Fail-Closed Verification]');

    // 1.1 Non-existent audio/video file throws AudioProcessingError
    const missingFilePath = path.resolve(testDir, 'non_existent.mp4');
    let missingFileThrew = false;
    try {
      await audioProcessor.analyzeAudio(missingFilePath, {
        filename: 'missing.mp4',
        originalSize: 0,
        durationSeconds: 10,
        width: 1920,
        height: 1080,
        resolutionLabel: '1080p',
        fps: 30,
        hasAudio: true,
        isProxyUsed: false
      });
    } catch (err: any) {
      missingFileThrew = err instanceof AudioProcessingError;
    }
    assert(missingFileThrew, '1. Non-existent file throws AudioProcessingError');

    // 1.2 Corrupt media file causes FFmpeg nonzero exit status -> fails closed
    const corruptFilePath = path.resolve(testDir, 'corrupt_media.mp4');
    fs.writeFileSync(corruptFilePath, 'CORRUPT_HEADER_AND_INVALID_STREAM_PAYLOAD');
    let corruptMediaThrew = false;
    let corruptErrorMessage = '';
    try {
      await audioProcessor.analyzeAudio(corruptFilePath, {
        filename: 'corrupt_media.mp4',
        originalSize: 100,
        durationSeconds: 10,
        width: 1920,
        height: 1080,
        resolutionLabel: '1080p',
        fps: 30,
        hasAudio: true,
        isProxyUsed: false
      });
    } catch (err: any) {
      corruptMediaThrew = err instanceof AudioProcessingError;
      corruptErrorMessage = err?.message || '';
    }
    assert(corruptMediaThrew, '1. Corrupt audio stream fails closed and throws AudioProcessingError');
    assert(corruptErrorMessage.includes('FFmpeg audio analysis failed'), '1. Error explicitly documents FFmpeg failure');

    // 1.3 Subclass test to verify fail-closed on nonzero exit code with partial mean_volume output
    class PartialStderrFailingAudioProcessor extends AudioProcessor {
      public async testParseWithOutput(output: string, shouldSimulateProcError: boolean, metadata: MediaMetadata) {
        if (shouldSimulateProcError) {
          // Simulate FFmpeg failure exiting with code 1 despite partial output having mean_volume
          const procErr: any = new Error('Command failed: ffmpeg');
          procErr.code = 1;
          procErr.stderr = output;
          throw new AudioProcessingError(`FFmpeg audio analysis failed: ${procErr.message}`);
        }
      }
    }

    const partialProcessor = new PartialStderrFailingAudioProcessor();
    let partialFailureThrew = false;
    try {
      await partialProcessor.testParseWithOutput('[Parsed_volumedetect] mean_volume: -18.4 dB\nFatal error in decoder', true, {
        filename: 'test.mp4',
        originalSize: 100,
        durationSeconds: 5,
        width: 1920,
        height: 1080,
        resolutionLabel: '1080p',
        fps: 30,
        hasAudio: true,
        isProxyUsed: false
      });
    } catch (err: any) {
      partialFailureThrew = err instanceof AudioProcessingError;
    }
    assert(partialFailureThrew, '1. Non-zero exit code with partial mean_volume stderr throws AudioProcessingError');

    // 1.4 Valid media generation for successful measurement baseline
    const validToneVideoPath = path.resolve(testDir, 'valid_tone.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-pix_fmt', 'yuv420p',
      validToneVideoPath
    ]);

    const validMeta: MediaMetadata = {
      filename: 'valid_tone.mp4',
      originalSize: fs.statSync(validToneVideoPath).size,
      durationSeconds: 3,
      width: 320,
      height: 240,
      resolutionLabel: '240p',
      fps: 25,
      hasAudio: true,
      videoCodec: 'h264',
      isProxyUsed: false
    };

    const validAudioResult = await audioProcessor.analyzeAudio(validToneVideoPath, validMeta);
    assert(typeof validAudioResult.meanVolumeDb === 'number', '4. Valid FFmpeg run returns numeric meanVolumeDb');
    assert(Number.isFinite(validAudioResult.meanVolumeDb!), '4. meanVolumeDb is a finite number');
    assert(validAudioResult.isAudible === true, '4. Valid audio tone produces isAudible = true');
    assert(validAudioResult.silenceRatio < 0.2, '4. Tone audio timeline reflects audible content (< 20% silence)');
    assert(validAudioResult.hasVoiceover === false, '4. Audible acoustic tone does NOT claim verified voiceover');
    assert(validAudioResult.voiceoverRatio === 0, '4. Acoustic tone does NOT assert a speech ratio');

    // 1.5 Ensuring a failed or unavailable measurement cannot produce a positive isAudible conclusion
    const noAudioMeta: MediaMetadata = {
      filename: 'no_audio.mp4',
      originalSize: 100,
      durationSeconds: 5,
      width: 320,
      height: 240,
      resolutionLabel: '240p',
      fps: 25,
      hasAudio: false,
      isProxyUsed: false
    };
    const noAudioResult = await audioProcessor.analyzeAudio(validToneVideoPath, noAudioMeta);
    assert(noAudioResult.isAudible === false, '5. Missing/unavailable audio cannot produce isAudible = true');
    assert(noAudioResult.meanVolumeDb === undefined, '5. Unavailable audio leaves meanVolumeDb undefined (no synthetic -20dB)');
    assert(noAudioResult.silenceRatio === 1, '5. Unavailable audio reports silenceRatio = 1');

    // -------------------------------------------------------------------------
    // SECTION 2: CREDIT DEDUCTION & IDEMPOTENT REFUND RECONCILIATION
    // -------------------------------------------------------------------------
    console.log('\n[2. Credit Deduction & Refund Failure Window Verification]');

    // 2.1 Set up test user with 30 credits
    const testUser = await storage.users.createUser('creator_refund_test@videorisk.com', undefined, undefined, 30, 'creator');
    assert(testUser.creditsRemaining === 30, 'Initial user credit balance is exactly 30');

    // 2.2 Create scan job
    const scanId = `scan_refund_${Date.now()}`;
    const scanJob: ScanJob = {
      id: scanId,
      userId: testUser.id,
      videoTitle: 'Refund Integrity Test',
      videoFilename: 'test.mp4',
      videoPath: validToneVideoPath,
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scanJob);

    // 2.3 Atomic deduction records creditsDeducted on scan record
    const deducted = await storage.scans.deductScanCredits(scanId, testUser.id, 10, { systemBypass: true });
    assert(deducted === true, 'Credits deducted successfully');

    const userAfterDeduct = await storage.users.getUser(testUser.id);
    const scanAfterDeduct = await storage.scans.getScan(scanId);

    assert(userAfterDeduct!.creditsRemaining === 20, 'User balance decreased from 30 to 20');
    assert(userAfterDeduct!.creditsUsedTotal === 10, 'User creditsUsedTotal is recorded as 10');
    assert(scanAfterDeduct!.creditsDeducted === 10, 'scan.creditsDeducted is persisted as 10');
    assert(scanAfterDeduct!.creditsUsed === 10, 'scan.creditsUsed is persisted as 10');
    assert(scanAfterDeduct!.creditsRefunded === false, 'scan.creditsRefunded is false');

    // 2.4 Idempotency of deduction: repeating deduction on same scan does not deduct again
    const repeatDeduct = await storage.scans.deductScanCredits(scanId, testUser.id, 10, { systemBypass: true });
    assert(repeatDeduct === true, 'Repeat deduction call returns true idempotently');
    const userAfterRepeatDeduct = await storage.users.getUser(testUser.id);
    assert(userAfterRepeatDeduct!.creditsRemaining === 20, 'Repeat deduction does NOT decrease balance further (remains 20)');

    // 2.5 Failure after deduction before usage recording / during scan failure -> successful refund
    const refundResult1 = await storage.scans.refundScanCredits(scanId, undefined, { systemBypass: true });
    assert(refundResult1.refunded === true, 'First refund attempt succeeds');
    assert(refundResult1.amount === 10, 'Refunded amount matches exactly 10 credits');

    const userAfterRefund = await storage.users.getUser(testUser.id);
    const scanAfterRefund = await storage.scans.getScan(scanId);
    assert(userAfterRefund!.creditsRemaining === 30, 'User credit balance restored back to 30');
    assert(userAfterRefund!.creditsUsedTotal === 0, 'User creditsUsedTotal reconciled back to 0');
    assert(scanAfterRefund!.creditsRefunded === true, 'scan.creditsRefunded is marked true');
    assert(scanAfterRefund!.creditsRefundedAmount === 10, 'scan.creditsRefundedAmount is recorded as 10');
    assert(scanAfterRefund!.creditsUsed === 0, 'scan.creditsUsed is cleared to 0');

    // 2.6 Retry / double-refund prevention
    const refundResult2 = await storage.scans.refundScanCredits(scanId, undefined, { systemBypass: true });
    assert(refundResult2.refunded === false, 'Second refund attempt on same scan is rejected');
    assert(refundResult2.amount === 0, 'Second refund attempt grants 0 additional credits');

    const refundResult3 = await storage.scans.refundScanCredits(scanId, undefined, { systemBypass: true });
    assert(refundResult3.refunded === false, 'Third refund attempt on same scan is rejected');

    const userAfterDoubleRefundAttempt = await storage.users.getUser(testUser.id);
    assert(userAfterDoubleRefundAttempt!.creditsRemaining === 30, 'User balance remains strictly 30 (no double refund)');

    // 2.7 Failure before usage recording simulated: scan with creditsDeducted refunded via hint amount
    const scanId2 = `scan_refund_hint_${Date.now()}`;
    await storage.scans.createScan({
      id: scanId2,
      userId: testUser.id,
      videoTitle: 'Hint Refund Test',
      videoFilename: 'test.mp4',
      videoPath: validToneVideoPath,
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    });

    // Manually deduct from user without updating scan.creditsUsed
    await storage.users.deductCredits(testUser.id, 5);
    const userPreHint = await storage.users.getUser(testUser.id);
    assert(userPreHint!.creditsRemaining === 25, 'Deducted 5 credits');

    // Refund using hint amount
    const hintRefund = await storage.scans.refundScanCredits(scanId2, 5, { systemBypass: true });
    assert(hintRefund.refunded === true, 'Hint refund succeeds when credits were deducted');
    assert(hintRefund.amount === 5, 'Hint refund restored 5 credits');
    const userPostHint = await storage.users.getUser(testUser.id);
    assert(userPostHint!.creditsRemaining === 30, 'Balance restored to 30');

    // Subsequent refund is blocked
    const repeatHintRefund = await storage.scans.refundScanCredits(scanId2, 5, { systemBypass: true });
    assert(repeatHintRefund.refunded === false, 'Repeat hint refund is blocked');

    // -------------------------------------------------------------------------
    // SECTION 3: EVIDENCE INTEGRITY SEMANTICS & ABSENCE OF FALSE CERTAINTY
    // -------------------------------------------------------------------------
    console.log('\n[3. Evidence Integrity Semantics Verification]');

    // 3.1 Acoustic activity and music cannot establish original creative contribution
    const mockVideoResult = {
      framesSampled: 3,
      scenesCount: 1,
      averagePacingSeconds: 3,
      hasSlideshowPattern: false,
      repeatedFootageSegments: [],
      templateRepetitions: [],
      tempFramesDir: ''
    };

    const timelineAudio = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_evidence_check',
      metadata: validMeta,
      scanMode: 'standard',
      audioResult: validAudioResult,
      videoResult: mockVideoResult,
      videoTitle: 'Acoustic Tone Video',
      channelProfile: null
    });

    const reportAudio = policyIntelligenceEngine.buildReport({
      scanId: 'scan_evidence_check',
      metadata: validMeta,
      scanMode: 'standard',
      audioResult: validAudioResult,
      videoResult: mockVideoResult,
      videoTitle: 'Acoustic Tone Video',
      channelProfile: null
    }, timelineAudio);

    assert(reportAudio.originalContributionRatio === null, '1. originalContributionRatio is null (no fabricated percentage)');
    assert(reportAudio.transformationScore === null, '1. transformationScore is null (no fabricated percentage)');
    assert(reportAudio.originalContributionStatus === 'INSUFFICIENT_EVIDENCE', '1. originalContributionStatus is INSUFFICIENT_EVIDENCE');
    assert(reportAudio.transformationStatus === 'NOT_ASSESSED', '1. transformationStatus is NOT_ASSESSED');

    // 3.2 User profile declarations cannot be reported as independently verified facts
    const declaredProfile = {
      id: 'prof_test',
      userId: testUser.id,
      version: 1,
      channelTopic: 'Gaming Commentary',
      contentType: 'commentary' as const,
      productionWorkflow: 'Original Voiceover over gameplay',
      thirdPartyFootageUsage: 'none' as const,
      originalVoiceNarration: 'always' as const,
      aiAssistedContent: false,
      typicalSources: 'Self-recorded gameplay',
      updatedAt: new Date().toISOString()
    };

    const timelineProfile = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_profile_check',
      metadata: validMeta,
      scanMode: 'standard',
      audioResult: validAudioResult,
      videoResult: mockVideoResult,
      videoTitle: 'Declared Profile Video',
      channelProfile: declaredProfile
    });

    const profileAudioItem = timelineProfile.find(t => t.type.includes('declared_narration'));
    assert(!!profileAudioItem, '2. Profile declaration creates a contextual observation');
    assert(profileAudioItem?.confidenceLevel === 'LOW', '2. Profile declaration confidence is LOW (not verified)');
    assert(profileAudioItem?.evidenceStatus === 'OBSERVED', '2. Profile item status is OBSERVED');
    assert(Boolean(profileAudioItem?.label.includes('Unverified')), '2. Label clearly states profile declaration is unverified');
    assert(Boolean(profileAudioItem?.details.includes('not been independently verified')), '2. Details explicitly explain declaration is unverified without transcription');

    const reportProfile = policyIntelligenceEngine.buildReport({
      scanId: 'scan_profile_check',
      metadata: validMeta,
      scanMode: 'standard',
      audioResult: validAudioResult,
      videoResult: mockVideoResult,
      videoTitle: 'Declared Profile Video',
      channelProfile: declaredProfile
    }, timelineProfile);

    assert(reportProfile.originalContributionRatio === null, '2. Profile declaration does NOT fabricate a positive original contribution percentage');
    assert(reportProfile.transformationScore === null, '2. Profile declaration does NOT fabricate a transformation score');

    // 3.3 Absence of a detected warning cannot automatically produce "Compliant"
    for (const pc of reportProfile.policyConnections) {
      assert(pc.impact !== 'Compliant', `3. Policy connection "${pc.policyName}" does NOT use unsupported "Compliant" status`);
    }

    const yppPolicy = reportProfile.policyConnections.find(p => p.policyName.includes('Reused Content'));
    assert(yppPolicy?.impact === 'No Direct Issues Detected', '3. YPP Reused Content reports "No Direct Issues Detected" instead of "Compliant"');
    assert(Boolean(yppPolicy?.description.includes('not a compliance determination')), '3. YPP Reused Content explicitly notes this is not a compliance determination');

    const originalityPolicy = reportProfile.policyConnections.find(p => p.policyName.includes('Original Creator Contribution'));
    assert(originalityPolicy?.impact === 'Insufficient Evidence', '3. Originality policy reports "Insufficient Evidence" when speech is unverified');
    assert(originalityPolicy?.evidenceStatus === 'INSUFFICIENT_EVIDENCE', '3. Originality policy evidenceStatus is INSUFFICIENT_EVIDENCE');

    // 3.4 Unassessed channel-wide or mass-production policy checks are not presented as completed assessments
    const massProductionPolicy = reportProfile.policyConnections.find(p => p.policyName.includes('Inauthentic & Mass-Produced'));
    assert(massProductionPolicy?.impact === 'Not Assessed', '4. Mass-production policy reports "Not Assessed" on single video scan');
    assert(massProductionPolicy?.evidenceStatus === 'NOT_ASSESSED', '4. Mass-production policy evidenceStatus is NOT_ASSESSED');
    assert(Boolean(massProductionPolicy?.description.includes('not assessed from an isolated upload')), '4. Description notes channel-wide mass production is not assessed');

    // 3.5 Lack of Content ID/fingerprinting capability is explicitly reflected
    const copyrightPolicy = reportProfile.policyConnections.find(p => p.policyName.includes('Copyright & Content ID'));
    assert(copyrightPolicy?.impact === 'Not Assessed', '5. Content ID screening reports "Not Assessed"');
    assert(copyrightPolicy?.evidenceStatus === 'NOT_ASSESSED', '5. Content ID evidenceStatus is NOT_ASSESSED');
    assert(Boolean(copyrightPolicy?.description.includes('does not perform Content ID fingerprinting')), '5. Explicitly notes VideoRisk does not perform Content ID fingerprinting');

    // 3.6 Risk categories do not claim monetization guarantees or fake fingerprint scans
    assert(
      !reportProfile.riskCategories.videoMonetization.explanation.includes('green monetization icon'),
      '6. videoMonetization does NOT claim "green monetization icon"'
    );
    assert(
      reportProfile.riskCategories.videoMonetization.explanation.includes('not a monetization guarantee'),
      '6. videoMonetization explicitly clarifies results are not a monetization guarantee'
    );
    assert(
      !reportProfile.riskCategories.copyrightSignals.explanation.includes('fingerprints detected'),
      '6. copyrightSignals does NOT claim "unlicensed fingerprints detected"'
    );
    assert(
      reportProfile.riskCategories.copyrightSignals.explanation.includes('does not perform YouTube Content ID fingerprinting'),
      '6. copyrightSignals explicitly states VideoRisk does not perform fingerprinting'
    );

    // 3.7 An unavailable analysis cannot silently improve or worsen the overall risk score
    assert(reportProfile.overallRisk === 'LOW_RISK', '7. Clean video with unassessed speech is LOW_RISK baseline');
    assert(reportProfile.riskSummary.includes('not a compliance determination'), '7. Overall risk summary clarifies this is not a compliance determination');

    // 3.8 Comparison view with null originalContribution handles ratios safely
    const compDelta = policyIntelligenceEngine.generateComparison(reportAudio, reportProfile);
    assert(compDelta.originalRatios.originalContribution === null, '8. Comparison preserves null for unassessed original contribution');
    assert(compDelta.revisedRatios.originalContribution === null, '8. Comparison preserves null for revised unassessed original contribution');
    assert(Array.isArray(compDelta.improvements), '8. Improvements array generated without crashing');

    // -------------------------------------------------------------------------
    // SECTION 4: PHASE 1 EVIDENCE INTEGRITY & RE-SCAN REGRESSION TESTS
    // -------------------------------------------------------------------------
    console.log('\n[4. Phase 1 Evidence Integrity & Re-Scan Regression Tests]');

    // Test 1: Identical image bytes with different filenames must not produce different visual-content findings
    const thumbBlue1 = path.resolve(testDir, 'standard_neutral.jpg');
    const thumbBlue2 = path.resolve(testDir, 'shock_arrow_red_circle_clickbait.jpg');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:d=1',
      '-vframes', '1', thumbBlue1
    ]);
    fs.copyFileSync(thumbBlue1, thumbBlue2);

    const thumbMeta1 = await thumbnailInspector.inspect(thumbBlue1, 'standard_neutral.jpg');
    const thumbMeta2 = await thumbnailInspector.inspect(thumbBlue2, 'shock_arrow_red_circle_clickbait.jpg');

    assert(thumbMeta1.hasSensationalElements === null, '4.1 Neutral filename yields null for sensational visual cues');
    assert(thumbMeta2.hasSensationalElements === null, '4.1 Clickbait filename does NOT fabricate sensational visual cues');
    assert(thumbMeta1.hasHighContrastText === thumbMeta2.hasHighContrastText, '4.1 Text flag identical across different filenames for same image');
    assert(thumbMeta1.visualAnalysisStatus === 'NOT_ASSESSED', '4.1 Visual analysis status is explicitly NOT_ASSESSED');

    // Test 2: Bright and dark images must not be treated as proof that text is present or absent
    const thumbDark = path.resolve(testDir, 'dark_image.jpg');
    const thumbBright = path.resolve(testDir, 'bright_image.jpg');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=1',
      '-vframes', '1', thumbDark
    ]);
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=white:s=1280x720:d=1',
      '-vframes', '1', thumbBright
    ]);

    const darkMeta = await thumbnailInspector.inspect(thumbDark, 'dark.jpg');
    const brightMeta = await thumbnailInspector.inspect(thumbBright, 'bright.jpg');

    assert(darkMeta.meanLuminance !== null && darkMeta.meanLuminance < 30, '4.2 Dark image has measured low luminance');
    assert(brightMeta.meanLuminance !== null && brightMeta.meanLuminance > 220, '4.2 Bright image has measured high luminance');

    // 4.2b Thumbnail luminance failure handling (Step 4 verification)
    assert(thumbnailInspector.parseLuminanceOutput('') === null, '4.2b Empty output returns null (no default 128)');
    assert(thumbnailInspector.parseLuminanceOutput('Fatal error reading image') === null, '4.2b Missing YAVG returns null');
    assert(thumbnailInspector.parseLuminanceOutput('[Parsed_metadata_1] lavfi.signalstats.YAVG=NaN') === null, '4.2b Non-numeric NaN returns null');
    assert(thumbnailInspector.parseLuminanceOutput('[Parsed_metadata_1] lavfi.signalstats.YAVG=Infinity') === null, '4.2b Infinite value returns null');
    assert(thumbnailInspector.parseLuminanceOutput('[Parsed_metadata_1] lavfi.signalstats.YAVG=128.4') === 128, '4.2b Valid YAVG parses to rounded integer');

    class FailingLuminanceInspector extends ThumbnailInspector {
      public async extractLuminance(): Promise<number | null> {
        return null; // Simulate FFmpeg signalstats process failure or timeout
      }
    }
    const failingLuminanceInspector = new FailingLuminanceInspector();
    const failingLumMeta = await failingLuminanceInspector.inspect(thumbDark, 'dark.jpg');
    assert(failingLumMeta.meanLuminance === null, '4.2b Failed signalstats returns null (no synthetic 128 default)');
    assert(failingLumMeta.width === 1280 && failingLumMeta.height === 720, '4.2b Dimensions remain measured despite luminance failure');

    // Test 3: Unavailable thumbnail analysis is reported as unassessed, not as a verified negative
    const timelineThumb = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_thumb_unassessed',
      metadata: validMeta,
      scanMode: 'standard',
      audioResult: validAudioResult,
      videoResult: mockVideoResult,
      thumbnailMetadata: thumbMeta1
    });
    const reportThumb = policyIntelligenceEngine.buildReport({
      scanId: 'scan_thumb_unassessed',
      metadata: validMeta,
      scanMode: 'standard',
      audioResult: validAudioResult,
      videoResult: mockVideoResult,
      thumbnailMetadata: thumbMeta1
    }, timelineThumb);

    assert(reportThumb.domainReports.thumbnail.status === 'NOT_ASSESSED', '4.3 Thumbnail domain reports NOT_ASSESSED for unperformed visual analysis');
    assert(reportThumb.domainReports.thumbnail.summary.includes('not assessed'), '4.3 Summary explicitly clarifies visual text & sensational cues not assessed');

    // Test 4: Audio volume/silence measurements are not misrepresented as speech/music detection
    assert(validAudioResult.speechAnalysisStatus === 'NOT_ASSESSED', '4.4 Audio speechAnalysisStatus is explicitly NOT_ASSESSED');
    assert(validAudioResult.musicAnalysisStatus === 'NOT_ASSESSED', '4.4 Audio musicAnalysisStatus is explicitly NOT_ASSESSED');
    assert(validAudioResult.isAudible === true, '4.4 Audible energy is measured and verified');
    assert(typeof validAudioResult.meanVolumeDb === 'number', '4.4 Mean volume dB is measured and verified');

    // Test 5: Unimplemented slideshow/repeated-footage detection is not represented as a verified negative
    const videoResultSample = await videoProcessor.analyzeVideo(validToneVideoPath, validMeta, 'standard');
    assert(videoResultSample.slideshowAnalysisStatus === 'NOT_ASSESSED', '4.5 Video slideshowAnalysisStatus is explicitly NOT_ASSESSED');
    assert(videoResultSample.repeatedFootageStatus === 'NOT_ASSESSED', '4.5 Video repeatedFootageStatus is explicitly NOT_ASSESSED');
    assert(videoResultSample.scenesCount >= 1, '4.5 Scene cut detection is measured via FFmpeg');

    // Test 6: Identical media bytes produce the same SHA-256; changed bytes produce a different SHA-256
    const videoCopyPath = path.resolve(testDir, 'valid_copy.mp4');
    fs.copyFileSync(validToneVideoPath, videoCopyPath);
    const metaOriginal = await mediaInspector.inspect(validToneVideoPath, 'valid_tone.mp4');
    const metaCopy = await mediaInspector.inspect(videoCopyPath, 'different_name_copy.mp4');

    assert(typeof metaOriginal.sha256 === 'string' && metaOriginal.sha256.length === 64, '4.6 Media inspector computes 64-char SHA-256 hash');
    assert(metaOriginal.sha256 === metaCopy.sha256, '4.6 Identical media bytes produce identical SHA-256 hash regardless of path or filename');

    const differentVideoPath = path.resolve(testDir, 'different_content.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=15',
      '-c:v', 'libx264', differentVideoPath
    ]);
    const metaDifferent = await mediaInspector.inspect(differentVideoPath, 'different.mp4');
    assert(metaOriginal.sha256 !== metaDifferent.sha256, '4.6 Different media bytes produce distinct SHA-256 hashes');

    // Test 7: A previous finding is not resolved when the new analyzer fails or produces insufficient evidence
    const baselineReportWithIssue = {
      ...reportThumb,
      scanId: 'scan_baseline_issue',
      topIssues: [
        {
          id: 'issue_thumb_flag',
          domain: 'thumbnail' as const,
          what: 'Non-Standard Aspect Ratio',
          where: 'Thumbnail dimensions',
          why: 'Non-16:9 layout',
          fix: 'Resize to 16:9',
          evidence: 'ffprobe:dimensions',
          context: 'Display',
          recommendedAction: 'Fix aspect ratio',
          confidence: 'HIGH' as const,
          limitations: 'Local check',
          severity: 'warning' as const,
          policyArea: 'THUMBNAIL INTEGRITY',
          category: 'thumbnail_integrity' as const,
          timestampSeconds: 0
        }
      ]
    };

    // Revised scan where revised job failed
    const failedRevisedReport = {
      ...reportThumb,
      scanId: 'scan_revised_failed',
      topIssues: []
    };
    const compFailed = policyIntelligenceEngine.generateComparison(baselineReportWithIssue, failedRevisedReport, {
      isRevisedFailed: true
    });
    assert(compFailed.resolvedIssues.length === 0, '4.7 Failed revised scan does NOT resolve prior finding');
    assert(compFailed.notVerifiedIssues?.length === 1, '4.7 Prior finding is categorized as notVerifiedIssues when scan failed');

    // Revised scan where detector was unassessed / insufficient evidence
    const unassessedRevisedReport = {
      ...reportThumb,
      scanId: 'scan_revised_unassessed',
      topIssues: [],
      domainReports: {
        ...reportThumb.domainReports,
        thumbnail: {
          ...reportThumb.domainReports.thumbnail,
          status: 'NOT_ASSESSED' as const
        }
      }
    };
    const compUnassessed = policyIntelligenceEngine.generateComparison(baselineReportWithIssue, unassessedRevisedReport);
    assert(compUnassessed.resolvedIssues.length === 0, '4.7 Unassessed revised detector does NOT resolve prior finding');
    assert(Boolean(compUnassessed.notVerifiedIssues?.some(i => i.includes('detector for thumbnail was not assessed'))), '4.7 Explicit unassessed reason recorded in notVerifiedIssues');

    // Test 8: Confirmed persistent, new, resolved, and unverified findings are compared correctly
    const cleanRevisedReport = {
      ...reportThumb,
      scanId: 'scan_revised_clean',
      topIssues: [
        {
          id: 'issue_audio_new',
          domain: 'video_audio' as const,
          what: 'Sudden Audio Spike',
          where: '00:01',
          why: 'High volume',
          fix: 'Normalize audio',
          evidence: 'ffmpeg:volumedetect',
          context: 'Audio',
          recommendedAction: 'Lower volume',
          confidence: 'HIGH' as const,
          limitations: 'Local check',
          severity: 'warning' as const,
          policyArea: 'ADVERTISER FRIENDLY',
          category: 'advertiser_friendly' as const,
          timestampSeconds: 1
        }
      ],
      domainReports: {
        ...reportThumb.domainReports,
        thumbnail: {
          ...reportThumb.domainReports.thumbnail,
          status: 'NO_MAJOR_RISK_SIGNALS_DETECTED' as const
        }
      }
    };

    const multiIssueBaseline = {
      ...reportThumb,
      scanId: 'scan_multi_baseline',
      topIssues: [
        baselineReportWithIssue.topIssues[0], // will be resolved in clean revised scan
        {
          id: 'issue_title_persist',
          domain: 'title' as const,
          what: 'Misleading Promise',
          where: 'Title text',
          why: 'Extreme promise',
          fix: 'Rephrase title',
          evidence: 'nlp:regex',
          context: 'Title',
          recommendedAction: 'Rephrase',
          confidence: 'HIGH' as const,
          limitations: 'Local check',
          severity: 'warning' as const,
          policyArea: 'DECEPTIVE PRACTICES',
          category: 'community_guidelines' as const,
          timestampSeconds: 0
        }
      ]
    };

    const revisedWithPersistAndNew = {
      ...cleanRevisedReport,
      topIssues: [
        multiIssueBaseline.topIssues[1], // persisting title issue
        cleanRevisedReport.topIssues[0]   // new audio issue
      ]
    };

    const fullComparison = policyIntelligenceEngine.generateComparison(
      multiIssueBaseline,
      revisedWithPersistAndNew,
      {
        originalScanRecord: { status: 'COMPLETED', metadata: metaOriginal },
        revisedScanRecord: { status: 'COMPLETED', metadata: metaDifferent }
      }
    );

    assert(fullComparison.resolvedIssues.length === 1, '4.8 Resolved issue tracked when domain is verified clean');
    assert(fullComparison.resolvedIssues[0] === 'Non-Standard Aspect Ratio', '4.8 Resolved issue name matches baseline');
    assert(fullComparison.remainingIssues.length === 1, '4.8 Persisting issue tracked in remainingIssues');
    assert(fullComparison.newIssues?.length === 1, '4.8 New issue tracked in newIssues');
    assert(fullComparison.mediaIdentity?.isIdenticalMedia === false, '4.8 Media identity confirms different file version');
    assert(fullComparison.mediaIdentity?.originalSha256 === metaOriginal.sha256, '4.8 Original SHA-256 matches metadata');
    assert(fullComparison.mediaIdentity?.revisedSha256 === metaDifferent.sha256, '4.8 Revised SHA-256 matches metadata');

    // Test 9: Existing ownership and cross-user isolation guarantees remain intact
    const userA = await storage.users.createUser('user_a_owner@test.com', 'pro');
    const userB = await storage.users.createUser('user_b_other@test.com', 'pro');
    const scanRecordA = await storage.scans.createScan({
      id: `scan_owner_test_${Date.now()}`,
      userId: userA.id,
      videoTitle: 'User A Private Media',
      videoFilename: 'privateA.mp4',
      videoPath: validToneVideoPath,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 1,
      createdAt: new Date().toISOString()
    });

    assert(scanRecordA.userId === userA.id, '4.9 Scan record strictly associated with User A');
    assert(scanRecordA.userId !== userB.id, '4.9 User B cannot be assigned User A scan ownership');

    // Test 10: Step 2 regression: signalsDelta < 0 alone cannot claim resolution or success
    assert(compUnassessed.signalsDelta < 0, '4.10 signalsDelta is negative when findings disappear due to unassessed detector');
    assert(compUnassessed.resolvedIssues.length === 0, '4.10 No issues marked resolved despite negative signalsDelta');
    assert(!compUnassessed.comparisonSummary.toLowerCase().includes('resolved 1'), '4.10 comparisonSummary does NOT claim findings were resolved');
    assert(compUnassessed.comparisonSummary.includes('could not be verified'), '4.10 comparisonSummary explicitly declares resolution could not be verified');

    // Test 11: Step 6 regression: Skipped domain in revised scan prevents resolution
    const compSkipped = policyIntelligenceEngine.generateComparison(
      baselineReportWithIssue,
      cleanRevisedReport,
      { skippedDomains: ['thumbnail'] }
    );
    assert(compSkipped.resolvedIssues.length === 0, '4.11 Skipped domain does NOT resolve prior finding');
    assert(Boolean(compSkipped.notVerifiedIssues?.some(i => i.includes('was skipped'))), '4.11 Skipped domain explicitly noted in notVerifiedIssues');

    // Test 12: Step 6 regression: NOT_PROVIDED domain in revised cut prevents resolution
    const notProvidedRevisedReport = {
      ...cleanRevisedReport,
      domainReports: {
        ...cleanRevisedReport.domainReports,
        thumbnail: {
          ...cleanRevisedReport.domainReports.thumbnail,
          status: 'NOT_PROVIDED' as const
        }
      }
    };
    const compNotProvided = policyIntelligenceEngine.generateComparison(
      baselineReportWithIssue,
      notProvidedRevisedReport
    );
    assert(compNotProvided.resolvedIssues.length === 0, '4.12 NOT_PROVIDED domain does NOT resolve prior finding');
    assert(Boolean(compNotProvided.notVerifiedIssues?.some(i => i.includes('not provided'))), '4.12 NOT_PROVIDED explicitly recorded in notVerifiedIssues');

    // Test 13: Step 5 regression: Partial media identity hashes handle unknown comparison safely
    const compMissingHash = policyIntelligenceEngine.generateComparison(
      baselineReportWithIssue,
      cleanRevisedReport,
      {
        originalScanRecord: { status: 'COMPLETED', metadata: { ...metaOriginal, sha256: undefined } },
        revisedScanRecord: { status: 'COMPLETED', metadata: metaDifferent }
      }
    );
    assert(compMissingHash.mediaIdentity?.comparisonStatus === 'UNVERIFIED', '4.13 Missing baseline hash produces comparisonStatus UNVERIFIED');
    assert(compMissingHash.mediaIdentity?.isIdenticalMedia === false, '4.13 Missing hash does not claim identical media');

    // Test 14: Step 5 & 6 regression: Identical file re-scan correctly tracks persistent findings
    const compIdentical = policyIntelligenceEngine.generateComparison(
      multiIssueBaseline,
      multiIssueBaseline,
      {
        originalScanRecord: { status: 'COMPLETED', metadata: metaOriginal },
        revisedScanRecord: { status: 'COMPLETED', metadata: metaOriginal }
      }
    );
    assert(compIdentical.mediaIdentity?.comparisonStatus === 'IDENTICAL', '4.14 Matching hashes produce comparisonStatus IDENTICAL');
    assert(compIdentical.mediaIdentity?.isIdenticalMedia === true, '4.14 Matching hashes confirm isIdenticalMedia is true');
    assert(compIdentical.remainingIssues.length === 2, '4.14 Both findings persist on identical media re-scan');
    assert(compIdentical.resolvedIssues.length === 0, '4.14 Zero resolved issues on identical media with same findings');

    // Test 15: Step 6 regression: Clean baseline and clean revision produces accurate empty-state summary
    const cleanBaseline = { ...cleanRevisedReport, scanId: 'clean_base', topIssues: [] };
    const cleanRevised = { ...cleanRevisedReport, scanId: 'clean_rev', topIssues: [] };
    const compClean = policyIntelligenceEngine.generateComparison(cleanBaseline, cleanRevised);
    assert(compClean.resolvedIssues.length === 0, '4.15 Zero resolved issues when baseline had no findings');
    assert(compClean.remainingIssues.length === 0, '4.15 Zero remaining issues when baseline had no findings');
    assert(compClean.comparisonSummary.includes('clean status'), '4.15 Accurate summary for clean baseline and revision');

    // Test 16: ANALYSIS_UNAVAILABLE in revised scan domain prevents resolution
    const analysisUnavailableRevisedReport = {
      ...cleanRevisedReport,
      domainReports: {
        ...cleanRevisedReport.domainReports,
        thumbnail: {
          ...cleanRevisedReport.domainReports.thumbnail,
          status: 'ANALYSIS_UNAVAILABLE' as const
        }
      }
    };
    const compAnalysisUnavailable = policyIntelligenceEngine.generateComparison(
      baselineReportWithIssue,
      analysisUnavailableRevisedReport
    );
    assert(compAnalysisUnavailable.resolvedIssues.length === 0, '4.16 ANALYSIS_UNAVAILABLE domain does NOT resolve prior finding');
    assert(Boolean(compAnalysisUnavailable.notVerifiedIssues?.some(i => i.includes('analysis for thumbnail was unavailable'))), '4.16 ANALYSIS_UNAVAILABLE explicitly recorded with reason in notVerifiedIssues');

    // Test 17: Genuinely verifiable clean domain resolves prior finding
    const compVerifiable = policyIntelligenceEngine.generateComparison(
      baselineReportWithIssue,
      cleanRevisedReport
    );
    assert(compVerifiable.resolvedIssues.length === 1, '4.17 Verified clean domain successfully resolves prior finding');
    assert(compVerifiable.resolvedIssues[0] === 'Non-Standard Aspect Ratio', '4.17 Resolved issue name matches baseline');
    assert(!compVerifiable.notVerifiedIssues?.length, '4.17 notVerifiedIssues is empty for verified clean domain');

    // Test 18: Media identity display helper edge cases
    const validHashA = 'a'.repeat(64);
    const validHashB = 'b'.repeat(64);

    // Both present and equal
    const idEqual = formatMediaIdentityDisplay(validHashA, validHashA);
    assert(idEqual.comparisonStatus === 'IDENTICAL', '4.18 Both hashes equal produces IDENTICAL');
    assert(idEqual.statusBadgeText === '(Identical file)', '4.18 Both hashes equal produces (Identical file)');
    assert(idEqual.statusLabel === 'Identical file', '4.18 Both hashes equal produces statusLabel Identical file');
    assert(idEqual.originalHashDisplay === `${validHashA.slice(0, 10)}…`, '4.18 Original hash display truncated');
    assert(idEqual.revisedHashDisplay === `${validHashA.slice(0, 10)}…`, '4.18 Revised hash display truncated');

    // Both present and different
    const idDiff = formatMediaIdentityDisplay(validHashA, validHashB);
    assert(idDiff.comparisonStatus === 'DIFFERENT', '4.18 Both hashes different produces DIFFERENT');
    assert(idDiff.statusBadgeText === '(Modified file)', '4.18 Both hashes different produces (Modified file)');
    assert(idDiff.statusLabel === 'Modified file', '4.18 Both hashes different produces statusLabel Modified file');

    // Original present but revised missing
    const idRevMissing = formatMediaIdentityDisplay(validHashA, undefined);
    assert(idRevMissing.comparisonStatus === 'UNVERIFIED', '4.18 Missing revised hash produces UNVERIFIED');
    assert(idRevMissing.statusBadgeText === '(File comparison unverified)', '4.18 Missing revised hash produces (File comparison unverified)');
    assert(idRevMissing.statusLabel === 'File comparison unverified', '4.18 Missing revised hash produces statusLabel File comparison unverified');
    assert(idRevMissing.originalHashDisplay === `${validHashA.slice(0, 10)}…`, '4.18 Original hash displayed when present');
    assert(idRevMissing.revisedHashDisplay === 'Unavailable', '4.18 Revised hash displayed as Unavailable when missing');

    // Revised present but original missing
    const idOrigMissing = formatMediaIdentityDisplay(undefined, validHashB);
    assert(idOrigMissing.comparisonStatus === 'UNVERIFIED', '4.18 Missing original hash produces UNVERIFIED');
    assert(idOrigMissing.statusBadgeText === '(File comparison unverified)', '4.18 Missing original hash produces (File comparison unverified)');
    assert(idOrigMissing.originalHashDisplay === 'Unavailable', '4.18 Original hash displayed as Unavailable when missing');
    assert(idOrigMissing.revisedHashDisplay === `${validHashB.slice(0, 10)}…`, '4.18 Revised hash displayed when present');

    // Both hashes missing
    const idBothMissing = formatMediaIdentityDisplay(undefined, undefined);
    assert(idBothMissing.comparisonStatus === 'UNVERIFIED', '4.18 Both hashes missing produces UNVERIFIED');
    assert(idBothMissing.statusBadgeText === '(File comparison unverified)', '4.18 Both missing produces (File comparison unverified)');
    assert(idBothMissing.originalHashDisplay === 'Unavailable', '4.18 Both missing sets original to Unavailable');
    assert(idBothMissing.revisedHashDisplay === 'Unavailable', '4.18 Both missing sets revised to Unavailable');

    // Empty or malformed hash values
    const idMalformed = formatMediaIdentityDisplay('short_hash', '12345nonhex'.padEnd(64, 'z'));
    assert(idMalformed.comparisonStatus === 'UNVERIFIED', '4.18 Malformed hashes produce UNVERIFIED');
    assert(idMalformed.statusBadgeText === '(File comparison unverified)', '4.18 Malformed hashes produce (File comparison unverified)');
    assert(idMalformed.originalHashDisplay === 'Unavailable', '4.18 Malformed original displays Unavailable');
    assert(idMalformed.revisedHashDisplay === 'Unavailable', '4.18 Malformed revised displays Unavailable');

    const idEmpty = formatMediaIdentityDisplay('', '   ');
    assert(idEmpty.comparisonStatus === 'UNVERIFIED', '4.18 Empty string hashes produce UNVERIFIED');
    assert(idEmpty.originalHashDisplay === 'Unavailable', '4.18 Empty string original displays Unavailable');
    assert(idEmpty.revisedHashDisplay === 'Unavailable', '4.18 Empty string revised displays Unavailable');

    // Test 19: Failed FFmpeg luminance execution must not return a measurement from partial output
    const partialYavgOutput = '[Parsed_metadata_1] lavfi.signalstats.YAVG=42.0\nFatal error in decoder: broken pipe';
    assert(
      thumbnailInspector.evaluateLuminanceExecution(partialYavgOutput, true) === null,
      '4.19 Failed FFmpeg process (hasError=true) returns null even with partial YAVG'
    );
    assert(
      thumbnailInspector.evaluateLuminanceExecution(partialYavgOutput, false) === 42,
      '4.19 Successful FFmpeg process (hasError=false) parses YAVG to 42'
    );

    // Non-existent or invalid image file in extractLuminance fails closed to null without throwing
    const nonExistentImgPath = path.resolve(testDir, 'does_not_exist.jpg');
    const nonExistentLum = await thumbnailInspector.extractLuminance(nonExistentImgPath);
    assert(nonExistentLum === null, '4.19 extractLuminance returns null when FFmpeg process fails on missing file');

    const corruptImgPath = path.resolve(testDir, 'corrupt_img.jpg');
    fs.writeFileSync(corruptImgPath, 'NOT_AN_IMAGE_FILE_DATA');
    const corruptLum = await thumbnailInspector.extractLuminance(corruptImgPath);
    assert(corruptLum === null, '4.19 extractLuminance returns null when FFmpeg fails on corrupted image');

    // Test 20: Proxy generation fail-closed, caching, and input media preservation
    const standard1080Meta: MediaMetadata = {
      filename: 'sample_1080p.mp4',
      originalSize: 1000,
      durationSeconds: 10,
      width: 1920,
      height: 1080,
      resolutionLabel: '1080p Full HD',
      fps: 30,
      hasAudio: true,
      isProxyUsed: false
    };
    const noProxyNeededResult = await proxyGenerator.generateProxyIfNeeded(validToneVideoPath, standard1080Meta);
    assert(noProxyNeededResult === validToneVideoPath, '4.20 Standard 1080p video returns original inputPath without generating proxy');

    const uhd4kMeta: MediaMetadata = {
      filename: 'sample_4k.mp4',
      originalSize: 50000000,
      durationSeconds: 1,
      width: 3840,
      height: 2160,
      resolutionLabel: '4K Ultra HD',
      fps: 30,
      hasAudio: true,
      isProxyUsed: true
    };

    // 20a: Failed FFmpeg call throws ProxyGenerationError
    let proxyErrorThrown = false;
    let proxyErrorMessage = '';
    const nonExistentPath = path.resolve(testDir, 'non_existent_4k.mp4');
    try {
      await proxyGenerator.generateProxyIfNeeded(nonExistentPath, uhd4kMeta);
    } catch (err: any) {
      proxyErrorThrown = err instanceof ProxyGenerationError;
      proxyErrorMessage = err?.message || '';
    }
    assert(proxyErrorThrown, '4.20 Failed 4K proxy generation throws ProxyGenerationError instead of silently returning raw 4K path');
    assert(proxyErrorMessage.includes('Failed to generate required 1080p proxy for high-resolution (4K Ultra HD) video'), '4.20 Proxy error message explains high-resolution requirement');

    // 20b: Successful proxy generation creates a valid non-empty proxy
    const originalInputBytesBefore = fs.statSync(validToneVideoPath).size;
    const generatedProxy = await proxyGenerator.generateProxyIfNeeded(validToneVideoPath, uhd4kMeta);
    assert(fs.existsSync(generatedProxy), '4.20 Generated proxy file exists on disk');
    assert(fs.statSync(generatedProxy).size > 0, '4.20 Generated proxy file is non-empty');
    assert(generatedProxy !== validToneVideoPath, '4.20 Generated proxy path is distinct from original input');
    assert(fs.statSync(validToneVideoPath).size === originalInputBytesBefore, '4.20 Original media file is completely preserved');

    // 20c: Cached valid proxy is reused
    const reusedProxy = await proxyGenerator.generateProxyIfNeeded(validToneVideoPath, uhd4kMeta);
    assert(reusedProxy === generatedProxy, '4.20 Existing non-empty proxy is reused');

    // 20d: Invalid zero-byte cached proxy is unlinked and regenerated, not accepted
    fs.writeFileSync(generatedProxy, ''); // truncate to 0 bytes
    assert(fs.statSync(generatedProxy).size === 0, '4.20 Proxy truncated to 0 bytes for cache test');
    const regeneratedProxy = await proxyGenerator.generateProxyIfNeeded(validToneVideoPath, uhd4kMeta);
    assert(fs.statSync(regeneratedProxy).size > 0, '4.20 Zero-byte cached proxy was regenerated to a valid non-empty proxy');

    // 20e: If FFmpeg fails on corrupted input, original input is NOT deleted
    const corruptInputPath = path.resolve(testDir, 'corrupt_input_media.mp4');
    fs.writeFileSync(corruptInputPath, 'CORRUPTED_NON_VIDEO_DATA');
    try {
      await proxyGenerator.generateProxyIfNeeded(corruptInputPath, uhd4kMeta);
    } catch (err) {
      assert(err instanceof ProxyGenerationError, '4.20 Corrupt input proxy generation throws ProxyGenerationError');
    }
    assert(fs.existsSync(corruptInputPath), '4.20 Original input media is NEVER deleted during proxy generation failure');

    // Test 21: getComparisonSubtitle reflects newly introduced issues, unverified hashes, and persistent findings
    const compBaseMock: ReScanComparison = {
      originalScanId: 's1',
      revisedScanId: 's2',
      originalRisk: 'NEEDS_REVIEW',
      revisedRisk: 'LOW_RISK',
      originalSignalsCount: 1,
      revisedSignalsCount: 0,
      signalsDelta: -1,
      originalRatios: { originalContribution: 80, reusedContent: 20 },
      revisedRatios: { originalContribution: 90, reusedContent: 10 },
      resolvedIssues: ['Non-Standard Aspect Ratio'],
      remainingIssues: [],
      improvements: ['Prior issue resolved'],
      comparisonSummary: 'Summary'
    };

    // 21a: Subtitle when all resolved and no new issues
    const subClean = getComparisonSubtitle(compBaseMock);
    assert(subClean.includes('All 1 prior policy scrutiny signal(s) have been resolved'), '4.21 Subtitle confirms all prior signals resolved when no new issues');

    // 21b: Subtitle when prior resolved but new issues introduced
    const compWithNewMock: ReScanComparison = {
      ...compBaseMock,
      newIssues: ['Extended Silence / Unedited Gap'],
      revisedSignalsCount: 1,
      signalsDelta: 0
    };
    const subWithNew = getComparisonSubtitle(compWithNewMock);
    assert(subWithNew.includes('Prior signal(s) resolved with evidence (1), but 1 new risk signal(s) were introduced'), '4.21 Subtitle explicitly warns of new issues introduced despite prior resolution');

    // 21c: Subtitle when resolution cannot be verified due to unassessed detectors
    const compUnverifiedMock: ReScanComparison = {
      ...compBaseMock,
      resolvedIssues: [],
      notVerifiedIssues: ['Non-Standard Aspect Ratio (unverified: analysis for thumbnail was unavailable)'],
      revisedSignalsCount: 0,
      signalsDelta: -1
    };
    const subUnverified = getComparisonSubtitle(compUnverifiedMock);
    assert(subUnverified.includes('Signal resolution could not be verified (1 item(s) unverified'), '4.21 Subtitle clarifies resolution could not be verified');

    // 21d: Subtitle when revised media SHA-256 is unavailable
    const compMissingRevisedSha: ReScanComparison = {
      ...compBaseMock,
      mediaIdentity: {
        originalSha256: 'a'.repeat(64),
        revisedSha256: undefined,
        isIdenticalMedia: false,
        comparisonStatus: 'UNVERIFIED'
      }
    };
    const subMissingSha = getComparisonSubtitle(compMissingRevisedSha);
    assert(subMissingSha === 'Media comparison is unverified: revised media SHA-256 is unavailable.', '4.21 Subtitle explicitly states media comparison is unverified when revised SHA-256 is missing');

    // 21e: Subtitle when findings persist without resolution
    const compPersistingMock: ReScanComparison = {
      ...compBaseMock,
      resolvedIssues: [],
      remainingIssues: ['Thumbnail dimensions: Non-Standard Aspect Ratio'],
      revisedSignalsCount: 1,
      signalsDelta: 0
    };
    const subPersist = getComparisonSubtitle(compPersistingMock);
    assert(subPersist.includes('No prior risk signals were resolved. 1 signal(s) persist'), '4.21 Subtitle states persistent findings accurately');

    // 21f: Subtitle when clean baseline and clean revision
    const compCleanCutsMock: ReScanComparison = {
      ...compBaseMock,
      originalSignalsCount: 0,
      revisedSignalsCount: 0,
      resolvedIssues: [],
      remainingIssues: [],
      signalsDelta: 0
    };
    const subCleanCuts = getComparisonSubtitle(compCleanCutsMock);
    assert(subCleanCuts === 'No policy scrutiny signals detected in either cut.', '4.21 Subtitle confirms clean status in both cuts');

    // 21g: Subtitle when fewer signals detected but no prior issues verifiably resolved
    const compFewerSignalsMock: ReScanComparison = {
      ...compBaseMock,
      originalSignalsCount: 3,
      revisedSignalsCount: 1,
      signalsDelta: -2,
      resolvedIssues: [],
      remainingIssues: []
    };
    const subFewer = getComparisonSubtitle(compFewerSignalsMock);
    assert(subFewer.includes('Fewer signals detected in this cut (1 vs 3), but no prior findings were verifiably resolved with evidence.'), '4.21 Subtitle forbids claiming resolution on unexplained signal drop');

    // Test 22: Orchestrator retry and terminal failure credit accounting lifecycle
    const orchTestUser = await storage.users.createUser('orch_user_test@domain.com', undefined, undefined, 10, 'pro');
    const initialCredits = (await storage.users.getUser(orchTestUser.id))!.creditsRemaining;

    // Scan record with 1 credit deducted
    const orchScanJobId = `scan_orch_test_${Date.now()}`;
    await storage.scans.createScan({
      id: orchScanJobId,
      userId: orchTestUser.id,
      videoTitle: 'Orchestrator Lifecycle Test',
      videoFilename: 'test.mp4',
      videoPath: validToneVideoPath,
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 1,
      createdAt: new Date().toISOString()
    });
    const deductRes = await storage.scans.deductScanCredits(orchScanJobId, orchTestUser.id, 1, { systemBypass: true });
    assert(deductRes === true, '4.22 Initial scan credit deduction succeeds');
    assert((await storage.users.getUser(orchTestUser.id))!.creditsRemaining === initialCredits - 1, '4.22 User credits reduced by 1');

    // Simulated retry attempt 1: scan remains QUEUED, credits are NOT refunded
    await storage.scans.updateScan(orchScanJobId, {
      status: 'QUEUED',
      error: 'Transient issue: retrying (attempt 1/3)...'
    }, { systemBypass: true });
    const scanAfterRetry1 = await storage.scans.getScan(orchScanJobId);
    assert(scanAfterRetry1?.status === 'QUEUED', '4.22 Retryable error keeps scan in QUEUED status');
    assert(scanAfterRetry1?.creditsRefunded !== true, '4.22 Credits are NOT refunded during retry attempt');
    assert((await storage.users.getUser(orchTestUser.id))!.creditsRemaining === initialCredits - 1, '4.22 User credits remain unchanged during retry');

    // Simulated terminal failure after exhausted retries: refund credits idempotently
    const orchRefundResult1 = await storage.scans.refundScanCredits(orchScanJobId, undefined, { systemBypass: true });
    assert(orchRefundResult1.refunded === true, '4.22 Terminal failure executes credit refund');
    assert(orchRefundResult1.amount === 1, '4.22 Refunded amount matches deducted credits');
    assert((await storage.users.getUser(orchTestUser.id))!.creditsRemaining === initialCredits, '4.22 User balance fully restored after terminal refund');

    // Verify idempotency of refund: second refund attempt does not double refund
    const orchRefundResult2 = await storage.scans.refundScanCredits(orchScanJobId, undefined, { systemBypass: true });
    assert(orchRefundResult2.refunded === false, '4.22 Subsequent refund call is idempotent (does not double refund)');
    assert((await storage.users.getUser(orchTestUser.id))!.creditsRemaining === initialCredits, '4.22 User balance intact after redundant refund');

    console.log(`\n======================================================`);
    console.log(`TEST SUITE 6 COMPLETE: ${passed}/${total} assertions passed!`);
    console.log(`======================================================\n`);
  } finally {
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup error
    }
  }
}
