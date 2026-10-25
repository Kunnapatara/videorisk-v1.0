import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { mediaInspector } from '../src/server/pipeline/mediaInspector';
import { thumbnailInspector, ThumbnailInspectionError, ThumbnailOcrAdapter } from '../src/server/pipeline/thumbnailInspector';
import { audioProcessor, AudioProcessingError, SpeechTranscriptionAdapter } from '../src/server/pipeline/audioProcessor';
import { videoProcessor, VideoProcessingError } from '../src/server/pipeline/videoProcessor';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { contextAnalyzer } from '../src/server/intelligence/contextAnalyzer';
import { ChannelContextProfile, MediaMetadata } from '../src/types';

const execFileAsync = promisify(execFile);

export async function runProductCapabilitiesTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 2: PRODUCT CAPABILITIES & PIPELINE ---');
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

  const testDir = path.resolve(process.cwd(), 'uploads', 'test_media');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  const validVideoPath = path.join(testDir, 'synth_with_audio.mp4');
  const silentVideoPath = path.join(testDir, 'synth_silent.mp4');
  const validThumbPath = path.join(testDir, 'synth_thumb_16x9.jpg');
  const nonStandardThumbPath = path.join(testDir, 'synth_thumb_square.jpg');
  const corruptFilePath = path.join(testDir, 'corrupt_media.mp4');

  try {
    // ---------------------------------------------------------
    // GENERATE SYNTHETIC TEST ASSETS WITH REAL FFMPEG
    // ---------------------------------------------------------
    console.log('[Generating real synthetic media assets with ffmpeg/lavfi...]');

    // 1. Synthetic video with audio tone (2 seconds, 640x360)
    if (!fs.existsSync(validVideoPath)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        validVideoPath
      ], { timeout: 20000 });
    }

    // 2. Synthetic silent video (2 seconds, 640x360)
    if (!fs.existsSync(silentVideoPath)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=25',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        silentVideoPath
      ], { timeout: 20000 });
    }

    // 3. Synthetic standard 16:9 thumbnail (1280x720 JPEG)
    if (!fs.existsSync(validThumbPath)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=navy:s=1280x720:d=1',
        '-frames:v', '1',
        validThumbPath
      ], { timeout: 15000 });
    }

    // 4. Synthetic non-standard square thumbnail (600x600 JPEG)
    if (!fs.existsSync(nonStandardThumbPath)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=red:s=600x600:d=1',
        '-frames:v', '1',
        nonStandardThumbPath
      ], { timeout: 15000 });
    }

    // 5. Synthetic multi-scene video (3 seconds, 3 distinct colors/scenes)
    const multiSceneVideoPath = path.join(testDir, 'synth_multi_scene.mp4');
    if (!fs.existsSync(multiSceneVideoPath)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1[v1];color=c=blue:s=320x240:d=1[v2];color=c=green:s=320x240:d=1[v3];[v1][v2][v3]concat=n=3:v=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        multiSceneVideoPath
      ], { timeout: 20000 });
    }

    // 6. Synthetic static video (2 seconds, single continuous color)
    const staticVideoPath = path.join(testDir, 'synth_static.mp4');
    if (!fs.existsSync(staticVideoPath)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:d=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        staticVideoPath
      ], { timeout: 20000 });
    }

    // 7. Synthetic 30-second continuous static video (single scene >= 30s)
    const static30sVideoPath = path.join(testDir, 'synth_static_30s.mp4');
    if (!fs.existsSync(static30sVideoPath)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=navy:s=160x120:d=30',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        static30sVideoPath
      ], { timeout: 25000 });
    }

    // 8. Corrupt file
    fs.writeFileSync(corruptFilePath, 'THIS_IS_NOT_A_VALID_MEDIA_STREAM_DATA_HEADER');

    // ---------------------------------------------------------
    // 1. REAL MEDIA INSPECTION PIPELINE
    // ---------------------------------------------------------
    console.log('\n[1. Real Media Inspection Pipeline]');

    const metaWithAudio = await mediaInspector.inspect(validVideoPath, 'synth_with_audio.mp4');
    assert(metaWithAudio.hasAudio === true, 'Real video with audio correctly detects audio stream');
    assert(metaWithAudio.durationSeconds >= 1.9, 'Real video duration measured accurately (~2s)');
    assert(metaWithAudio.width === 640 && metaWithAudio.height === 360, 'Real video dimensions measured accurately (640x360)');

    const metaSilent = await mediaInspector.inspect(silentVideoPath, 'synth_silent.mp4');
    assert(metaSilent.hasAudio === false, 'Real video without audio correctly reports hasAudio = false');

    let corruptHandled = false;
    try {
      await mediaInspector.inspect(corruptFilePath, 'corrupt.mp4');
    } catch {
      corruptHandled = true;
    }
    assert(corruptHandled === true, 'Corrupt media file is safely rejected with error');

    // ---------------------------------------------------------
    // 2. THUMBNAIL ANALYSIS PIPELINE
    // ---------------------------------------------------------
    console.log('\n[2. Thumbnail Analysis Pipeline]');

    const validThumbMeta = await thumbnailInspector.inspect(validThumbPath, 'synth_thumb_16x9.jpg');
    assert(validThumbMeta.width === 1280 && validThumbMeta.height === 720, 'Thumbnail dimensions extracted accurately (1280x720)');
    assert(validThumbMeta.isStandardAspect === true, '1280x720 thumbnail confirmed as standard 16:9 aspect');
    assert(typeof validThumbMeta.meanLuminance === 'number', 'Deterministic mean luminance computed from image signal');

    const squareThumbMeta = await thumbnailInspector.inspect(nonStandardThumbPath, 'synth_thumb_square.jpg');
    assert(squareThumbMeta.isStandardAspect === false, 'Square thumbnail correctly flagged as non-standard aspect ratio');
    const squareNotes = squareThumbMeta.notes || '';
    assert(squareNotes.includes('16:9') || squareNotes.includes('aspect'), 'Helpful recommendation provided for non-standard image aspect');

    let corruptThumbHandled = false;
    try {
      await thumbnailInspector.inspect(corruptFilePath, 'corrupt.jpg');
    } catch (err: any) {
      corruptThumbHandled = true;
    }
    assert(corruptThumbHandled === true, 'Corrupt image input is safely caught and rejected');

    // ---------------------------------------------------------
    // 3. REAL VIDEO SCENE ANALYSIS & PIPELINE INTEGRITY
    // ---------------------------------------------------------
    console.log('\n[3. Real Video Scene Analysis Pipeline]');

    // 3.1 Multi-scene video with distinct scene changes
    const metaMulti = await mediaInspector.inspect(multiSceneVideoPath, 'synth_multi_scene.mp4');
    const videoResMulti = await videoProcessor.analyzeVideo(multiSceneVideoPath, metaMulti, 'standard');
    assert(videoResMulti.scenesCount === 3, 'Multi-scene video detects exactly 3 scenes from real cut transitions');
    assert(videoResMulti.framesSampled >= 1, 'Sampled frames count is measured and distinct from scene count');
    assert(videoResMulti.averagePacingSeconds >= 0.8 && videoResMulti.averagePacingSeconds <= 1.2, 'Average pacing computed accurately from real scene cut intervals (~1.0s)');
    assert(videoResMulti.hasSlideshowPattern === false, 'Dynamic scene cuts do not falsely trigger slideshow pattern');
    assert(fs.existsSync(videoResMulti.tempFramesDir), 'Temporary frames directory created during scene analysis');
    await videoProcessor.cleanupFrames(videoResMulti.tempFramesDir);
    assert(!fs.existsSync(videoResMulti.tempFramesDir), 'Temporary frames directory safely cleaned up');

    // 3.2 Continuous static video (no scene cuts)
    const metaStatic = await mediaInspector.inspect(staticVideoPath, 'synth_static.mp4');
    const videoResStatic = await videoProcessor.analyzeVideo(staticVideoPath, metaStatic, 'standard');
    assert(videoResStatic.scenesCount === 1, 'Continuous static video correctly reports 1 scene (0 cuts detected)');
    assert(videoResStatic.averagePacingSeconds >= 1.8 && videoResStatic.averagePacingSeconds <= 2.2, 'Static video pacing reflects continuous duration without artificial cut inflation');
    assert(videoResStatic.framesSampled >= 1, 'Static video frames sampled reflects actual extracted frames');
    await videoProcessor.cleanupFrames(videoResStatic.tempFramesDir);
    assert(!fs.existsSync(videoResStatic.tempFramesDir), 'Static video temporary frames safely cleaned up');

    // 3.3 Fail closed on corrupt media: throws clear error without returning mock/fallback data
    let videoCorruptThrown = false;
    let videoCorruptError: any = null;
    try {
      await videoProcessor.analyzeVideo(corruptFilePath, metaSilent, 'standard');
    } catch (err: any) {
      videoCorruptThrown = true;
      videoCorruptError = err;
    }
    assert(videoCorruptThrown === true, 'Corrupt media file causes analyzeVideo to fail closed and throw error');
    assert(videoCorruptError instanceof VideoProcessingError, 'Thrown error is an instance of VideoProcessingError');
    assert(!videoCorruptError.scenesCount, 'No mock or fallback analysis result returned on corrupt file');

    // 3.4 Fail closed on missing file
    let missingVideoThrown = false;
    try {
      await videoProcessor.analyzeVideo(path.join(testDir, 'does_not_exist.mp4'), metaSilent, 'standard');
    } catch (err: any) {
      missingVideoThrown = true;
    }
    assert(missingVideoThrown === true, 'Non-existent video file safely throws VideoProcessingError');

    // ---------------------------------------------------------
    // 4. CONTEXT INTELLIGENCE & CHANNEL PROFILE
    // ---------------------------------------------------------
    console.log('\n[4. Context Intelligence]');

    const mockProfile: ChannelContextProfile = {
      id: 'cp_test_1',
      userId: 'user_test',
      version: 1,
      channelTopic: 'Automotive Engineering & Crash Safety',
      contentType: 'educational',
      productionWorkflow: 'Original technical narration and CAD model animations',
      thirdPartyFootageUsage: 'fair_use_commentary',
      originalVoiceNarration: 'always',
      aiAssistedContent: true,
      aiDisclosureDetails: 'CAD simulations assisted by generative physics tooling',
      typicalSources: 'NHTSA crash records and public technical papers',
      updatedAt: new Date().toISOString()
    };

    // 3.1 Context interpretation with Profile
    const contextWithProfile = contextAnalyzer.interpretContext({
      videoTitle: 'How Modern Crumple Zones Save Lives (Crash Analysis)',
      videoDescription: 'Technical breakdown of automotive crumple zone physics.',
      channelProfile: mockProfile,
      hasAudio: true,
      hasVoiceover: true,
      voiceoverRatio: 75,
      durationSeconds: 120
    });
    assert(contextWithProfile.primaryContext === 'educational', 'Profile contentType grounds primary context as educational');
    assert(contextWithProfile.contextConfidence === 'HIGH', 'Grounding in channel profile provides HIGH confidence');

    // 3.2 Context interpretation WITHOUT Profile (Honest limitation message)
    const contextWithoutProfile = contextAnalyzer.interpretContext({
      videoTitle: 'Vlog and Random Thoughts',
      hasAudio: true,
      hasVoiceover: false,
      voiceoverRatio: 0,
      durationSeconds: 120
    });
    assert(contextWithoutProfile.uncertaintyReason === 'AMBIGUOUS_CONTEXT', 'Missing profile and generic title honestly declares AMBIGUOUS_CONTEXT');

    // ---------------------------------------------------------
    // 5. PUBLISHING RISK REPORT & EVIDENCE TIMELINE
    // ---------------------------------------------------------
    console.log('\n[5. Publishing Risk Report Generation]');

    const audioRes = await audioProcessor.analyzeAudio(validVideoPath, metaWithAudio);
    const videoRes = await videoProcessor.analyzeVideo(validVideoPath, metaWithAudio, 'standard');

    const timeline = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_cap_1',
      metadata: metaWithAudio,
      scanMode: 'standard',
      audioResult: audioRes,
      videoResult: videoRes,
      videoTitle: 'How Modern Crumple Zones Save Lives',
      videoDescription: 'Check out our technical breakdown at http://store.example.com promo code CRASH50',
      thumbnailMetadata: squareThumbMeta,
      channelProfile: mockProfile
    });

    assert(timeline.length > 0, 'Evidence timeline contains generated evidence signals');
    assert(timeline.some(t => t.domain === 'thumbnail'), 'Timeline includes Thumbnail domain evidence findings');
    assert(timeline.some(t => t.domain === 'channel_context'), 'Timeline includes Channel Context declaration evidence');

    const report = policyIntelligenceEngine.buildReport({
      scanId: 'scan_cap_1',
      metadata: metaWithAudio,
      scanMode: 'standard',
      audioResult: audioRes,
      videoResult: videoRes,
      videoTitle: 'How Modern Crumple Zones Save Lives',
      videoDescription: 'Check out our technical breakdown at http://store.example.com promo code CRASH50',
      thumbnailMetadata: squareThumbMeta,
      channelProfile: mockProfile
    }, timeline);

    assert(report.scanId === 'scan_cap_1', 'Report tied to scan ID');
    assert(['LOW_RISK', 'NEEDS_REVIEW', 'HIGH_RISK'].includes(report.overallRisk), 'Overall risk level calculated');
    assert(!!report.domainReports.video_audio, 'Report contains video_audio domain scorecard');
    assert(!!report.domainReports.thumbnail, 'Report contains thumbnail domain scorecard');
    assert(!!report.domainReports.channel_context, 'Report contains channel_context domain scorecard');
    assert(report.domainReports.thumbnail.status === 'REVIEW_RECOMMENDED', 'Square thumbnail triggers REVIEW_RECOMMENDED status');
    assert(report.policyConnections.length >= 3, 'Policy connections map to YPP, Originality, and Disclosures');

    // ---------------------------------------------------------
    // 6. RE-SCAN COMPARISON DELTA
    // ---------------------------------------------------------
    console.log('\n[6. Re-scan Comparison Delta]');

    const revisedReport = {
      ...report,
      overallRisk: 'LOW_RISK' as const,
      originalContributionRatio: 95,
      reusedContentRatio: 0,
      topIssues: []
    };

    const comparison = policyIntelligenceEngine.generateComparison(report, revisedReport);
    assert(comparison.originalScanId === report.scanId, 'Comparison links original scan ID');
    assert(comparison.revisedRisk === 'LOW_RISK', 'Comparison delta captures risk reduction');
    assert(typeof comparison.comparisonSummary === 'string', 'Summary recorded in comparison delta');
    assert(typeof comparison.signalsDelta === 'number', 'Numerical signals delta recorded in comparison');

    // ---------------------------------------------------------
    // 7. EVIDENCE INTEGRITY & GROUNDED RISK CLAIMS
    // ---------------------------------------------------------
    console.log('\n[7. Evidence Integrity & Grounded Risk Claims Verification]');

    // 7.1 Music-only / acoustic audio is not automatically reported as verified creator narration
    const audioResSynth = await audioProcessor.analyzeAudio(validVideoPath, metaWithAudio);
    assert(audioResSynth.hasVoiceover === false, '1. Pure acoustic audio / tone is not automatically reported as verified creator narration');
    assert(audioResSynth.voiceoverRatio === 0, '1. Unverified audio does not assert a verified speech ratio');

    const videoResTemp = await videoProcessor.analyzeVideo(validVideoPath, metaWithAudio, 'standard');
    await videoProcessor.cleanupFrames(videoResTemp.tempFramesDir);

    const timelineAudio = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_audio_check',
      metadata: metaWithAudio,
      scanMode: 'standard',
      audioResult: audioResSynth,
      videoResult: videoResTemp,
      videoTitle: 'Acoustic Track Demo',
      channelProfile: null // No profile to ensure no user-declared assumption
    });

    assert(
      !timelineAudio.some(t => t.type === 'original_narration' || t.label.includes('Original Voice Narration Detected')),
      '1. Timeline does not claim verified creator narration for pure acoustic energy'
    );

    // 7.2 Acoustic activity without reliable speech evidence does not produce a high-confidence narration claim
    const acousticItems = timelineAudio.filter(t => t.domain === 'video_audio' && t.type.includes('acoustic'));
    assert(acousticItems.length > 0, '2. Acoustic audio activity is reported as a measurable observation');
    for (const item of acousticItems) {
      assert(item.confidenceLevel !== 'HIGH', '2. Acoustic activity does not claim HIGH confidence narration');
      assert(item.confidence <= 0.75, '2. Confidence score reflects unverified speech limitation (<= 0.75)');
      assert(Boolean(item.limitations?.includes('transcript') || item.limitations?.includes('verify speech')), '2. Limitations explicitly state speech is unverified without transcript analysis');
    }

    // 7.3 A static video lasting at least 30 seconds is not automatically classified as a slideshow
    const metaStatic30s = await mediaInspector.inspect(static30sVideoPath, 'synth_static_30s.mp4');
    const videoResStatic30s = await videoProcessor.analyzeVideo(static30sVideoPath, metaStatic30s, 'standard');
    assert(videoResStatic30s.hasSlideshowPattern === false, '3. Static video lasting 30s is NOT classified as a slideshow');
    assert(videoResStatic30s.scenesCount === 1, '3. Single continuous shot correctly detected (1 scene)');
    await videoProcessor.cleanupFrames(videoResStatic30s.tempFramesDir);

    const timelineStatic30s = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_static_30s',
      metadata: metaStatic30s,
      scanMode: 'standard',
      audioResult: audioResSynth,
      videoResult: videoResStatic30s,
      videoTitle: '30s Continuous Shot',
      channelProfile: null
    });
    assert(
      !timelineStatic30s.some(t => t.category === 'inauthentic_pattern' || t.label.includes('Slideshow Pattern')),
      '3. Timeline does not assert inauthentic pattern or slideshow for 30s static video'
    );

    // 7.4 A video with scene cuts is not automatically classified as inauthentic or mass-produced content
    const timelineMultiScene = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_multi_cuts',
      metadata: metaMulti,
      scanMode: 'standard',
      audioResult: audioResSynth,
      videoResult: videoResMulti,
      videoTitle: 'Multi Scene Video',
      channelProfile: null
    });
    assert(
      !timelineMultiScene.some(t => t.category === 'inauthentic_pattern'),
      '4. Video with scene cuts is not classified as inauthentic or mass-produced content'
    );
    const pacingItem = timelineMultiScene.find(t => t.type === 'scene_pacing_observation');
    assert(!!pacingItem, '4. Scene transitions are reported as an informative pacing observation');
    assert(pacingItem?.severity === 'info', '4. Pacing observation severity is strictly info (not a violation/warning)');

    // 7.5 Low estimated narration does not fabricate a reused-content finding for an arbitrary video interval
    const audioResSilent = await audioProcessor.analyzeAudio(silentVideoPath, metaSilent);
    const timelineSilent = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_silent_check',
      metadata: metaSilent,
      scanMode: 'standard',
      audioResult: audioResSilent,
      videoResult: videoResMulti,
      videoTitle: 'Silent Video Check',
      channelProfile: null
    });
    assert(
      !timelineSilent.some(t => t.category === 'reused_content' && t.severity !== 'info'),
      '5. Silent video / low narration does not fabricate reused-content findings'
    );
    assert(
      !timelineSilent.some(t => t.type === 'third_party_material'),
      '5. No arbitrary [20%, 50%] third-party material interval is fabricated'
    );

    const reportSilent = policyIntelligenceEngine.buildReport({
      scanId: 'scan_silent_check',
      metadata: metaSilent,
      scanMode: 'standard',
      audioResult: audioResSilent,
      videoResult: videoResMulti,
      videoTitle: 'Silent Video Check',
      channelProfile: null
    }, timelineSilent);
    assert(reportSilent.reusedContentRatio === 0, '5. Reused content ratio is 0% when no direct evidence of third-party material exists');

    // 7.6 A finding that cannot be verified is clearly distinguished from a confirmed observation
    const silentItem = timelineSilent.find(t => t.type === 'silent_audio_track');
    assert(!!silentItem, '6. Absence of audio is recorded with measured provenance');
    assert(silentItem?.severity === 'info', '6. Absence of audio is not marked as high severity policy violation');
    assert(reportSilent.domainReports.video_audio.limitations.includes('does not verify speech content'), '6. Limitations explicitly distinguish measurable signals from unverified conclusions');
    assert(reportSilent.domainReports.video_audio.limitations.includes('Content ID'), '6. Limitations explicitly declare VideoRisk does not query private Content ID databases');

    // ---------------------------------------------------------
    // 8. ADVANCED MEDIA INTELLIGENCE CAPABILITIES VERIFICATION
    // ---------------------------------------------------------
    console.log('\n[8. Advanced Media Intelligence Capabilities]');

    // 8.1 Within-video repeated footage detection
    const repeatedVideoPath = path.join(testDir, 'synth_repeated_footage.mp4');
    if (!fs.existsSync(repeatedVideoPath)) {
      // 6 seconds: 0-2s red (Scene 1), 2-4s blue (Scene 2), 4-6s red (Scene 1 repeated)
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=2[v1];color=c=blue:s=320x240:d=2[v2];color=c=red:s=320x240:d=2[v3];[v1][v2][v3]concat=n=3:v=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        repeatedVideoPath
      ], { timeout: 25000 });
    }

    const metaRepeated = await mediaInspector.inspect(repeatedVideoPath, 'synth_repeated_footage.mp4');
    const videoResRepeated = await videoProcessor.analyzeVideo(repeatedVideoPath, metaRepeated, 'standard');

    assert(videoResRepeated.repeatedFootageSegments.length >= 1, '8.1 Within-video repeated footage detected from perceptual frame comparison');
    assert(videoResRepeated.repeatedFootageStatus === 'DETECTED', '8.1 Repeated footage status is explicitly DETECTED');
    const firstRep = videoResRepeated.repeatedFootageSegments[0];
    assert(firstRep.similarity >= 0.95, '8.1 Exact repeated visual segment has high similarity (>= 95%)');
    assert(firstRep.matchWithTimestamp <= 2.0 && firstRep.start >= 3.0, '8.1 Repeated segment maps second occurrence to first scene timestamp');

    const timelineRepeated = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_rep_check',
      metadata: metaRepeated,
      scanMode: 'standard',
      audioResult: audioResSynth,
      videoResult: videoResRepeated,
      videoTitle: 'Repeated Footage Demo',
      channelProfile: null
    });
    assert(
      timelineRepeated.some(t => t.type === 'repeated_visual_footage' && t.category === 'reused_content'),
      '8.1 Timeline includes verified repeated_visual_footage evidence item'
    );

    const reportRepeated = policyIntelligenceEngine.buildReport({
      scanId: 'scan_rep_check',
      metadata: metaRepeated,
      scanMode: 'standard',
      audioResult: audioResSynth,
      videoResult: videoResRepeated,
      videoTitle: 'Repeated Footage Demo',
      channelProfile: null
    }, timelineRepeated);
    assert(reportRepeated.reusedContentRatio > 0, '8.1 Report reusedContentRatio is measured from actual repeated footage duration');
    await videoProcessor.cleanupFrames(videoResRepeated.tempFramesDir);

    // 8.2 Distinct scenes without repetition (NO_SIGNAL_DETECTED)
    const distinctVideoPath = path.join(testDir, 'synth_distinct_scenes.mp4');
    if (!fs.existsSync(distinctVideoPath)) {
      // 6 seconds: 0-2s red, 2-4s green, 4-6s blue (3 distinct scenes, zero repeats)
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=2[v1];color=c=green:s=320x240:d=2[v2];color=c=blue:s=320x240:d=2[v3];[v1][v2][v3]concat=n=3:v=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        distinctVideoPath
      ], { timeout: 25000 });
    }

    const metaDistinct = await mediaInspector.inspect(distinctVideoPath, 'synth_distinct_scenes.mp4');
    const videoResDistinct = await videoProcessor.analyzeVideo(distinctVideoPath, metaDistinct, 'standard');
    assert(videoResDistinct.repeatedFootageSegments.length === 0, '8.2 Distinct scenes video detects 0 repeated segments');
    assert(videoResDistinct.repeatedFootageStatus === 'NO_SIGNAL_DETECTED', '8.2 Distinct scenes video sets repeatedFootageStatus to NO_SIGNAL_DETECTED');
    await videoProcessor.cleanupFrames(videoResDistinct.tempFramesDir);

    // 8.3 Slideshow Presentation Pattern Heuristic
    const slideshowVideoPath = path.join(testDir, 'synth_slideshow.mp4');
    if (!fs.existsSync(slideshowVideoPath)) {
      // 10 seconds: 4 distinct slide colors, each static for 2.5s with cuts
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=2.5[s1];color=c=green:s=320x240:d=2.5[s2];color=c=blue:s=320x240:d=2.5[s3];color=c=yellow:s=320x240:d=2.5[s4];[s1][s2][s3][s4]concat=n=4:v=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        slideshowVideoPath
      ], { timeout: 25000 });
    }

    const metaSlideshow = await mediaInspector.inspect(slideshowVideoPath, 'synth_slideshow.mp4');
    const videoResSlideshow = await videoProcessor.analyzeVideo(slideshowVideoPath, metaSlideshow, 'deep');
    assert(videoResSlideshow.scenesCount >= 3, '8.3 Slideshow video detects cut transitions between slides');
    assert(videoResSlideshow.hasSlideshowPattern === true, '8.3 Slideshow video triggers hasSlideshowPattern = true based on static intra-scene frames');
    assert(videoResSlideshow.slideshowAnalysisStatus === 'DETECTED', '8.3 Slideshow status is explicitly DETECTED');

    const timelineSlideshow = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_slide_check',
      metadata: metaSlideshow,
      scanMode: 'deep',
      audioResult: audioResSynth,
      videoResult: videoResSlideshow,
      videoTitle: 'Photo Slideshow Presentation',
      channelProfile: null
    });
    assert(
      timelineSlideshow.some(t => t.type === 'slideshow_pattern_detected'),
      '8.3 Timeline records slideshow_pattern_detected evidence item'
    );
    await videoProcessor.cleanupFrames(videoResSlideshow.tempFramesDir);

    // 8.4 Within-video repeated audio detection
    const repeatedAudioVideoPath = path.join(testDir, 'synth_repeated_audio.mp4');
    if (!fs.existsSync(repeatedAudioVideoPath)) {
      // 6 seconds: 0-2s 1000Hz, 2-4s 440Hz, 4-6s 1000Hz repeated
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=6',
        '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2[a1];sine=frequency=440:duration=2[a2];sine=frequency=1000:duration=2[a3];[a1][a2][a3]concat=n=3:v=0:a=1',
        '-c:v', 'libx264', '-c:a', 'aac',
        repeatedAudioVideoPath
      ], { timeout: 25000 });
    }

    const metaRepAudio = await mediaInspector.inspect(repeatedAudioVideoPath, 'synth_repeated_audio.mp4');
    const audioResRep = await audioProcessor.analyzeAudio(repeatedAudioVideoPath, metaRepAudio);
    assert(Boolean(audioResRep.repeatedAudioSegments && audioResRep.repeatedAudioSegments.length >= 1), '8.4 Within-video repeated audio segments detected');
    assert(audioResRep.repeatedAudioStatus === 'DETECTED', '8.4 Repeated audio status is explicitly DETECTED');

    // 8.5 Speech Transcription Adapter
    const sttAdapter = new SpeechTranscriptionAdapter();
    const unconfiguredStt = await sttAdapter.transcribe(validVideoPath, 2);
    assert(unconfiguredStt.status === 'NOT_ASSESSED', '8.5 Unconfigured STT returns NOT_ASSESSED');
    assert(unconfiguredStt.limitations.includes('WHISPER_PATH'), '8.5 Unconfigured STT explicitly documents missing environment setup');

    process.env.WHISPER_PATH = '/path/to/nonexistent/whisper_binary';
    const missingStt = await sttAdapter.transcribe(validVideoPath, 2);
    assert(missingStt.status === 'ANALYSIS_UNAVAILABLE', '8.5 Invalid STT executable path returns ANALYSIS_UNAVAILABLE');
    assert(Boolean(missingStt.failureReason), '8.5 Missing STT executable documents failure reason');
    delete process.env.WHISPER_PATH;

    // 8.6 Thumbnail OCR Adapter
    const ocrAdapter = new ThumbnailOcrAdapter();
    const unconfiguredOcr = await ocrAdapter.extractText(validThumbPath, 1280, 720);
    assert(unconfiguredOcr.status === 'NOT_ASSESSED', '8.6 Unconfigured OCR returns NOT_ASSESSED');
    assert(unconfiguredOcr.limitations.includes('TESSERACT_PATH'), '8.6 Unconfigured OCR explicitly documents missing engine');

    process.env.TESSERACT_PATH = '/path/to/nonexistent/tesseract_binary';
    const missingOcr = await ocrAdapter.extractText(validThumbPath, 1280, 720);
    assert(missingOcr.status === 'ANALYSIS_UNAVAILABLE', '8.6 Invalid OCR path returns ANALYSIS_UNAVAILABLE');
    delete process.env.TESSERACT_PATH;

    // 8.7 Re-scan Comparison with Known Video Changes
    // Scenario A: Issue RESOLVED (Original has repeated footage, revised replaces it with distinct scenes)
    const timelineDistinct = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_revised_clean',
      metadata: metaDistinct,
      scanMode: 'standard',
      audioResult: audioResSynth,
      videoResult: videoResDistinct,
      videoTitle: 'Revised Clean Video',
      channelProfile: null
    });
    const reportDistinct = policyIntelligenceEngine.buildReport({
      scanId: 'scan_revised_clean',
      metadata: metaDistinct,
      scanMode: 'standard',
      audioResult: audioResSynth,
      videoResult: videoResDistinct,
      videoTitle: 'Revised Clean Video',
      channelProfile: null
    }, timelineDistinct);

    const compResolved = policyIntelligenceEngine.generateComparison(reportRepeated, reportDistinct);
    assert(compResolved.resolvedIssues.length >= 1, '8.7 Re-scan comparison identifies resolved issues with evidence');
    assert(
      compResolved.resolvedIssues.some(i => i.includes('Repeated Visual Footage')),
      '8.7 Repeated footage issue is marked RESOLVED when revised video contains distinct scenes'
    );
    assert(compResolved.revisedRatios.reusedContent < compResolved.originalRatios.reusedContent, '8.7 Reused content ratio decreases in revised re-scan');

    // Scenario B: Issue STILL PRESENT (Revised video also contains repeated footage)
    const compPersisting = policyIntelligenceEngine.generateComparison(reportRepeated, reportRepeated);
    assert(
      compPersisting.remainingIssues.some(i => i.includes('Repeated Visual Footage')),
      '8.7 Repeated footage issue is marked as remaining/persisting when still present in revised video'
    );

    // Scenario C: NEW issue detected in revised video
    const timelineWithNewIssue = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_with_new_issue',
      metadata: metaDistinct,
      scanMode: 'standard',
      audioResult: audioResSynth,
      videoResult: videoResDistinct,
      videoTitle: '100% CURE GUARANTEED - INSANE SECRETS',
      videoDescription: 'Promo code BUYNOW without disclosure',
      channelProfile: null
    });
    const reportWithNewIssue = policyIntelligenceEngine.buildReport({
      scanId: 'scan_with_new_issue',
      metadata: metaDistinct,
      scanMode: 'standard',
      audioResult: audioResSynth,
      videoResult: videoResDistinct,
      videoTitle: '100% CURE GUARANTEED - INSANE SECRETS',
      videoDescription: 'Promo code BUYNOW without disclosure',
      channelProfile: null
    }, timelineWithNewIssue);

    const compNewIssue = policyIntelligenceEngine.generateComparison(reportDistinct, reportWithNewIssue);
    assert(Boolean(compNewIssue.newIssues && compNewIssue.newIssues.length >= 1), '8.7 Newly introduced policy findings are marked as NEW issues');

    // Scenario D: NOT VERIFIED when detector analysis was unavailable or skipped
    const compUnverified = policyIntelligenceEngine.generateComparison(reportRepeated, reportDistinct, {
      skippedDomains: ['video_audio']
    });
    assert(
      Boolean(compUnverified.notVerifiedIssues && compUnverified.notVerifiedIssues.length >= 1),
      '8.7 Issue resolution is marked NOT VERIFIED when the detector domain was skipped'
    );

    // 8.8 Evidence-Based Risk Scoring & Real Benchmark Metrics
    assert(typeof reportRepeated.riskCategories.yppMonetization.score === 'number', '8.8 YPP category score is a numeric value');
    assert(typeof reportRepeated.riskCategories.copyrightSignals.score === 'number', '8.8 Copyright signals score is a numeric value');
    assert(Boolean(reportRepeated.detectors && Object.keys(reportRepeated.detectors).length >= 2), '8.8 Report contains structured detector execution metadata');
    assert(typeof reportRepeated.benchmarkMetrics.totalProcessingSeconds === 'number', '8.8 Report benchmarkMetrics totalProcessingSeconds is measured');

    console.log(`\n======================================================`);
    console.log(`TEST SUITE 2 COMPLETE: ${passed}/${total} assertions passed!`);
    console.log(`======================================================\n`);
  } finally {
    // Clean up temporary synthetic media files
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}
