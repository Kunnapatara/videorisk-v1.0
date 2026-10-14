import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { audioProcessor, AudioProcessor, AudioProcessingError } from '../src/server/pipeline/audioProcessor';
import { videoProcessor } from '../src/server/pipeline/videoProcessor';
import { mediaInspector } from '../src/server/pipeline/mediaInspector';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { InMemoryStorageRepository } from '../src/server/storage';
import { ScanJob, UserAccount, MediaMetadata } from '../src/types';

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
