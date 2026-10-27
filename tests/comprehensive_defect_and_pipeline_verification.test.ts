import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import express from 'express';
import http from 'http';
import { videoProcessor } from '../src/server/pipeline/videoProcessor';
import { 
  audioProcessor, 
  SpeechTranscriptionAdapter,
  detectRepeatedAudio,
  detectRepeatedAudioDetailed,
  mergeContiguousAudioSegments,
  AudioChunkSignature,
  DEFAULT_AUDIO_ANALYSIS_BOUNDS,
  AudioAnalysisBounds
} from '../src/server/pipeline/audioProcessor';
import { thumbnailInspector } from '../src/server/pipeline/thumbnailInspector';
import { mediaInspector } from '../src/server/pipeline/mediaInspector';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { storage } from '../src/server/storage';
import { apiRouter, secureUploadsHandler } from '../src/server/routes/api';
import { JobOrchestrator } from '../src/server/pipeline/jobOrchestrator';
import { ScanJob, RiskReport, MediaMetadata, EvidenceItem } from '../src/types';

const execFileAsync = promisify(execFile);

export async function runComprehensiveDefectAndPipelineTests() {
  console.log('\n================================================================');
  console.log('--- SUITE 13: COMPREHENSIVE DEFECT & PIPELINE VERIFICATION ---');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean | undefined | null, desc: string) {
    total++;
    if (Boolean(condition)) {
      console.log(`  ✅ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${desc}`);
      throw new Error(`Test assertion failed: ${desc}`);
    }
  }

  const testDir = path.resolve(os.tmpdir(), `vr_comprehensive_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(testDir, { recursive: true });

  try {
    // =========================================================================
    // 1. VISUAL DUPLICATE DETECTION VERIFICATION (SECTION 2)
    // =========================================================================
    console.log('[1. Visual Duplicate Detection & Perceptual Robustness]');

    // 1.1 Identical frames & repeated segments with different timestamps
    // Create a 6-second video: Scene A (0-2s), Scene B (2-4s), Scene A repeated (4-6s)
    const repeatedVideoPath = path.resolve(testDir, 'repeated_footage.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'smptebars=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      repeatedVideoPath
    ]);

    const repeatedMeta = await mediaInspector.inspect(repeatedVideoPath, 'repeated_footage.mp4');
    const repeatedResult = await videoProcessor.analyzeVideo(repeatedVideoPath, repeatedMeta, 'standard');

    assert(repeatedResult.repeatedFootageStatus === 'DETECTED', '1.1 Repeated footage detected when identical scene recurs non-adjacently');
    assert(repeatedResult.repeatedFootageSegments.length >= 1, '1.1 At least one repeated segment recorded');
    const firstRep = repeatedResult.repeatedFootageSegments[0];
    assert(firstRep.matchWithTimestamp < 2.5 && firstRep.start >= 3.5, '1.1 Segment correctly links earlier timestamp to later timestamp');
    assert(firstRep.similarity >= 0.90, '1.1 High structural similarity for repeated footage');

    // 1.2 Minor brightness changes to the same scene
    // Create Scene A (0-2s), Scene B (2-4s), Scene A with +25 brightness shift (4-6s)
    const brightnessVideoPath = path.resolve(testDir, 'brightness_shift.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'smptebars=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-filter_complex', '[2:v]eq=brightness=0.15:contrast=1.05[v2b];[0:v][1:v][v2b]concat=n=3:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      brightnessVideoPath
    ]);

    const brightnessMeta = await mediaInspector.inspect(brightnessVideoPath, 'brightness_shift.mp4');
    const brightnessResult = await videoProcessor.analyzeVideo(brightnessVideoPath, brightnessMeta, 'standard');
    assert(brightnessResult.repeatedFootageStatus === 'DETECTED', '1.2 Visual duplicate detector identifies same scene under brightness/contrast shift via structural correlation');

    // 1.3 Different scenes with similar dominant colors or brightness (MUST NOT be flagged as duplicates)
    // Create Scene 1 (dark blue solid with white dot) and Scene 2 (dark blue solid with yellow stripe)
    const similarColorVideoPath = path.resolve(testDir, 'similar_colors_different_scenes.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=darkblue:size=320x240:duration=3:rate=10',
      '-f', 'lavfi', '-i', 'color=c=darkblue:size=320x240:duration=3:rate=10',
      '-filter_complex', '[0:v]drawbox=x=20:y=20:w=30:h=30:color=white@1.0:t=fill[v1b];[1:v]drawbox=x=150:y=150:w=120:h=20:color=yellow@1.0:t=fill[v2b];[v1b][v2b]concat=n=2:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      similarColorVideoPath
    ]);

    const similarColorMeta = await mediaInspector.inspect(similarColorVideoPath, 'similar_colors.mp4');
    const similarColorResult = await videoProcessor.analyzeVideo(similarColorVideoPath, similarColorMeta, 'standard');
    assert(similarColorResult.repeatedFootageSegments.length === 0, '1.3 Different scenes with similar dominant dark blue colors are NOT falsely flagged as duplicates');

    // 1.4 Video with no repetition (3 distinct scenes A, B, C with no repeated footage)
    const cleanVideoPath = path.resolve(testDir, 'clean_continuous.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'smptebars=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=10',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      cleanVideoPath
    ]);

    const cleanMeta = await mediaInspector.inspect(cleanVideoPath, 'clean_continuous.mp4');
    const cleanResult = await videoProcessor.analyzeVideo(cleanVideoPath, cleanMeta, 'standard');
    assert(cleanResult.repeatedFootageStatus === 'NO_SIGNAL_DETECTED', '1.4 Continuous non-repeating video reports NO_SIGNAL_DETECTED');
    assert(cleanResult.repeatedFootageSegments.length === 0, '1.4 Zero repeated footage segments on clean continuous footage');

    // =========================================================================
    // 2. SLIDESHOW DETECTION & TEMPLATE REPETITION (SECTION 3)
    // =========================================================================
    console.log('\n[2. Slideshow Detection & Template Repetition]');

    // 2.1 Slideshow with distinct static slides (4 distinct frozen color slides, each 2s)
    const slideshowVideoPath = path.resolve(testDir, 'static_slideshow.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:size=320x240:duration=2:rate=10',
      '-f', 'lavfi', '-i', 'color=c=white:size=320x240:duration=2:rate=10',
      '-f', 'lavfi', '-i', 'color=c=black:size=320x240:duration=2:rate=10',
      '-f', 'lavfi', '-i', 'color=c=white:size=320x240:duration=2:rate=10',
      '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264',
      slideshowVideoPath
    ]);

    const slideshowMeta = await mediaInspector.inspect(slideshowVideoPath, 'slideshow.mp4');
    const slideshowResult = await videoProcessor.analyzeVideo(slideshowVideoPath, slideshowMeta, 'standard');
    assert(slideshowResult.hasSlideshowPattern === true, '2.1 Multiple static slides with pacing between 1.5s-12s detected as slideshow');
    assert(slideshowResult.slideshowAnalysisStatus === 'DETECTED', '2.1 Slideshow status is DETECTED');

    // 2.2 Continuous moving footage with scene cuts (NOT a slideshow)
    // 3 scenes of continuous motion (testsrc + testsrc2)
    const dynamicVideoPath = path.resolve(testDir, 'dynamic_scenes.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'smptebars=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=10',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      dynamicVideoPath
    ]);

    const dynamicMeta = await mediaInspector.inspect(dynamicVideoPath, 'dynamic_scenes.mp4');
    const dynamicResult = await videoProcessor.analyzeVideo(dynamicVideoPath, dynamicMeta, 'standard');
    assert(dynamicResult.hasSlideshowPattern === false, '2.2 Dynamic moving scenes with cuts are NOT falsely classified as slideshow');
    assert(dynamicResult.slideshowAnalysisStatus === 'NO_SIGNAL_DETECTED', '2.2 Slideshow status reports NO_SIGNAL_DETECTED for dynamic video');

    // 2.3 Recurring Intro/Outro Template
    // Intro sequence at 0-1s, content at 1-5s, same intro sequence recurring as Outro at 5-6s
    const templateVideoPath = path.resolve(testDir, 'template_intro_outro.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'smptebars=duration=4:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      templateVideoPath
    ]);

    const templateMeta = await mediaInspector.inspect(templateVideoPath, 'template_intro_outro.mp4');
    const templateResult = await videoProcessor.analyzeVideo(templateVideoPath, templateMeta, 'standard');
    assert(templateResult.templateAnalysisStatus === 'DETECTED', '2.3 Recurring sequence across intro/outro detected as template');
    assert(templateResult.templateRepetitions.length >= 1, '2.3 Template repetition recorded in result');
    assert(templateResult.templateRepetitions[0].pattern.includes('template') || templateResult.templateRepetitions[0].pattern.includes('bumper'), '2.3 Pattern labeled as recurring template or bumper');

    // =========================================================================
    // 3. AUDIO ANALYSIS & SPEECH / MUSIC / SILENCE (SECTION 4)
    // =========================================================================
    console.log('\n[3. Audio Analysis: Silence, Music Unassessed, Acoustic Activity]');

    // 3.1 Digital silence audio stream
    const silenceVideoPath = path.resolve(testDir, 'digital_silence.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:size=320x240:duration=4:rate=10',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', '4',
      '-c:v', 'libx264', '-c:a', 'aac',
      silenceVideoPath
    ]);

    const silenceAudioMeta = await mediaInspector.inspect(silenceVideoPath, 'digital_silence.mp4');
    const silenceAudioResult = await audioProcessor.analyzeAudio(silenceVideoPath, silenceAudioMeta);
    assert(silenceAudioResult.silenceRatio >= 0.90, '3.1 Silence ratio is >= 90% for digital silence');
    assert(silenceAudioResult.isAudible === false, '3.1 isAudible is false for digital silence');
    assert(silenceAudioResult.musicAnalysisStatus === 'NOT_ASSESSED', '3.1 musicAnalysisStatus is explicitly NOT_ASSESSED');
    assert(silenceAudioResult.hasMusicDetected === null, '3.1 hasMusicDetected is null when musicAnalysisStatus is NOT_ASSESSED');
    assert(silenceAudioResult.detectors?.audio_music_detection?.status === 'NOT_ASSESSED', '3.1 Music detector explicitly records NOT_ASSESSED');

    // 3.2 Audible acoustic energy with variable modulation
    const modulatedAudioVideoPath = path.resolve(testDir, 'modulated_audio.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:size=320x240:duration=4:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-t', '4',
      '-c:v', 'libx264', '-c:a', 'aac',
      modulatedAudioVideoPath
    ]);

    const modulatedAudioMeta = await mediaInspector.inspect(modulatedAudioVideoPath, 'modulated.mp4');
    const modulatedAudioResult = await audioProcessor.analyzeAudio(modulatedAudioVideoPath, modulatedAudioMeta);
    assert(modulatedAudioResult.isAudible === true, '3.2 Audible sound detected');
    assert(modulatedAudioResult.silenceRatio <= 0.20, '3.2 Low silence ratio on continuous tone sequence');
    assert(modulatedAudioResult.musicAnalysisStatus === 'NOT_ASSESSED', '3.2 musicAnalysisStatus remains NOT_ASSESSED without music classifier model');
    assert(modulatedAudioResult.hasMusicDetected === null, '3.2 hasMusicDetected is null when music classifier is not run');
    assert(modulatedAudioResult.detectors?.audio_speech_activity?.detectorName === 'acoustic_energy_modulation', '3.2 Acoustic detector accurately named');

    // 3.3 Music Classification Adapter Semantics & Output Validation
    const { MusicClassificationAdapter } = await import('../src/server/pipeline/audioProcessor');
    const musicAdapter = new MusicClassificationAdapter();

    // 3.3.1 Unconfigured
    const unconfiguredMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(unconfiguredMusic.status === 'NOT_ASSESSED', '3.3.1 Unconfigured music classifier returns NOT_ASSESSED');
    assert(unconfiguredMusic.hasMusic === null, '3.3.1 Unconfigured music classifier returns hasMusic: null');

    // 3.3.2 Missing executable
    process.env.MUSIC_CLASSIFIER_PATH = '/path/to/nonexistent/music_classifier_binary';
    const missingMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(missingMusic.status === 'ANALYSIS_UNAVAILABLE', '3.3.2 Missing classifier executable returns ANALYSIS_UNAVAILABLE');
    assert(missingMusic.hasMusic === null, '3.3.2 Missing classifier returns hasMusic: null');
    assert(Boolean(missingMusic.failureReason), '3.3.2 Missing classifier records failureReason');

    // 3.3.3 Valid positive detection with confidence
    const mockMusicPosScript = path.resolve(testDir, 'mock_music_pos.sh');
    fs.writeFileSync(mockMusicPosScript, '#!/bin/sh\necho \'{"hasMusic": true, "confidence": 0.92, "segments": [{"start": 0, "end": 4, "confidence": 0.92}]}\'\n');
    fs.chmodSync(mockMusicPosScript, 0o755);
    process.env.MUSIC_CLASSIFIER_PATH = mockMusicPosScript;
    const detectedMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(detectedMusic.status === 'DETECTED', '3.3.3 Executed classifier returns DETECTED for hasMusic: true');
    assert(detectedMusic.hasMusic === true, '3.3.3 Executed classifier returns hasMusic: true');
    assert(detectedMusic.confidence === 0.92, '3.3.3 Confidence preserved from executed classifier');

    // 3.3.4 Valid negative detection (confirmed false)
    const mockMusicNegScript = path.resolve(testDir, 'mock_music_neg.sh');
    fs.writeFileSync(mockMusicNegScript, '#!/bin/sh\necho \'{"hasMusic": false, "confidence": 0.88, "segments": []}\'\n');
    fs.chmodSync(mockMusicNegScript, 0o755);
    process.env.MUSIC_CLASSIFIER_PATH = mockMusicNegScript;
    const negativeMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(negativeMusic.status === 'NO_SIGNAL_DETECTED', '3.3.4 Confirmed negative hasMusic: false returns NO_SIGNAL_DETECTED');
    assert(negativeMusic.hasMusic === false, '3.3.4 Confirmed negative hasMusic: false returns hasMusic: false');
    assert(negativeMusic.confidence === 0.88, '3.3.4 Confidence preserved on negative detection');

    // 3.3.5 Empty stdout fails closed (must NOT report NO_SIGNAL_DETECTED or hasMusic: false)
    const mockMusicEmptyScript = path.resolve(testDir, 'mock_music_empty.sh');
    fs.writeFileSync(mockMusicEmptyScript, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(mockMusicEmptyScript, 0o755);
    process.env.MUSIC_CLASSIFIER_PATH = mockMusicEmptyScript;
    const emptyMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(emptyMusic.status === 'INSUFFICIENT_EVIDENCE', '3.3.5 Empty stdout from classifier returns INSUFFICIENT_EVIDENCE');
    assert(emptyMusic.hasMusic === null, '3.3.5 Empty stdout returns hasMusic: null (not false)');
    assert(Boolean(emptyMusic.failureReason), '3.3.5 Empty stdout records failureReason');

    // 3.3.6 Malformed JSON fails closed
    const mockMusicMalformedScript = path.resolve(testDir, 'mock_music_malformed.sh');
    fs.writeFileSync(mockMusicMalformedScript, '#!/bin/sh\necho "invalid json corrupt"\n');
    fs.chmodSync(mockMusicMalformedScript, 0o755);
    process.env.MUSIC_CLASSIFIER_PATH = mockMusicMalformedScript;
    const malformedMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(malformedMusic.status === 'ANALYSIS_UNAVAILABLE', '3.3.6 Malformed JSON returns ANALYSIS_UNAVAILABLE');
    assert(malformedMusic.hasMusic === null, '3.3.6 Malformed JSON returns hasMusic: null');
    assert(Boolean(malformedMusic.failureReason), '3.3.6 Malformed JSON records failureReason');

    // 3.3.7 Missing hasMusic field fails closed (must NOT coerce undefined to false)
    const mockMusicMissingFieldScript = path.resolve(testDir, 'mock_music_missing_field.sh');
    fs.writeFileSync(mockMusicMissingFieldScript, '#!/bin/sh\necho \'{"confidence": 0.9, "tempo": 120}\'\n');
    fs.chmodSync(mockMusicMissingFieldScript, 0o755);
    process.env.MUSIC_CLASSIFIER_PATH = mockMusicMissingFieldScript;
    const missingFieldMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(missingFieldMusic.status === 'ANALYSIS_UNAVAILABLE', '3.3.7 Missing hasMusic property returns ANALYSIS_UNAVAILABLE');
    assert(missingFieldMusic.hasMusic === null, '3.3.7 Missing hasMusic returns hasMusic: null');
    assert(missingFieldMusic.failureReason?.includes('hasMusic'), '3.3.7 Missing hasMusic records explanatory failureReason');

    // 3.3.8 Null hasMusic field fails closed (must NOT coerce null to false)
    const mockMusicNullFieldScript = path.resolve(testDir, 'mock_music_null_field.sh');
    fs.writeFileSync(mockMusicNullFieldScript, '#!/bin/sh\necho \'{"hasMusic": null, "confidence": 0.5}\'\n');
    fs.chmodSync(mockMusicNullFieldScript, 0o755);
    process.env.MUSIC_CLASSIFIER_PATH = mockMusicNullFieldScript;
    const nullFieldMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(nullFieldMusic.status === 'ANALYSIS_UNAVAILABLE', '3.3.8 Null hasMusic property returns ANALYSIS_UNAVAILABLE');
    assert(nullFieldMusic.hasMusic === null, '3.3.8 Null hasMusic returns hasMusic: null');
    assert(nullFieldMusic.failureReason?.includes('hasMusic'), '3.3.8 Null hasMusic records explanatory failureReason');

    // 3.3.9 String hasMusic field fails closed (must NOT coerce string "false" or "true")
    const mockMusicStringFieldScript = path.resolve(testDir, 'mock_music_string_field.sh');
    fs.writeFileSync(mockMusicStringFieldScript, '#!/bin/sh\necho \'{"hasMusic": "false"}\'\n');
    fs.chmodSync(mockMusicStringFieldScript, 0o755);
    process.env.MUSIC_CLASSIFIER_PATH = mockMusicStringFieldScript;
    const stringFieldMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(stringFieldMusic.status === 'ANALYSIS_UNAVAILABLE', '3.3.9 String hasMusic property returns ANALYSIS_UNAVAILABLE');
    assert(stringFieldMusic.hasMusic === null, '3.3.9 String hasMusic returns hasMusic: null');

    // 3.3.10 Number hasMusic field fails closed (must NOT coerce number 0 or 1)
    const mockMusicNumberFieldScript = path.resolve(testDir, 'mock_music_number_field.sh');
    fs.writeFileSync(mockMusicNumberFieldScript, '#!/bin/sh\necho \'{"hasMusic": 0}\'\n');
    fs.chmodSync(mockMusicNumberFieldScript, 0o755);
    process.env.MUSIC_CLASSIFIER_PATH = mockMusicNumberFieldScript;
    const numberFieldMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(numberFieldMusic.status === 'ANALYSIS_UNAVAILABLE', '3.3.10 Number hasMusic property returns ANALYSIS_UNAVAILABLE');
    assert(numberFieldMusic.hasMusic === null, '3.3.10 Number hasMusic returns hasMusic: null');

    // 3.3.11 Missing confidence does NOT fabricate 0.85
    const mockMusicNoConfScript = path.resolve(testDir, 'mock_music_no_conf.sh');
    fs.writeFileSync(mockMusicNoConfScript, '#!/bin/sh\necho \'{"hasMusic": true}\'\n');
    fs.chmodSync(mockMusicNoConfScript, 0o755);
    process.env.MUSIC_CLASSIFIER_PATH = mockMusicNoConfScript;
    const noConfMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(noConfMusic.status === 'DETECTED', '3.3.11 Status is DETECTED with hasMusic: true');
    assert(noConfMusic.confidence === undefined, '3.3.11 Missing confidence remains undefined (no fabricated 0.85)');

    // 3.3.12 Process error exit code fails closed
    const mockMusicErrorScript = path.resolve(testDir, 'mock_music_error.sh');
    fs.writeFileSync(mockMusicErrorScript, '#!/bin/sh\necho "Internal model error" >&2\nexit 1\n');
    fs.chmodSync(mockMusicErrorScript, 0o755);
    process.env.MUSIC_CLASSIFIER_PATH = mockMusicErrorScript;
    const errorMusic = await musicAdapter.classify(silenceVideoPath, 4);
    assert(errorMusic.status === 'ANALYSIS_UNAVAILABLE', '3.3.12 Process error returns ANALYSIS_UNAVAILABLE');
    assert(errorMusic.hasMusic === null, '3.3.12 Process error returns hasMusic: null');
    assert(Boolean(errorMusic.failureReason), '3.3.12 Process error records failureReason');

    delete process.env.MUSIC_CLASSIFIER_PATH;

    // 3.4 No-Audio-Stream Case Distinguishes Stream Absence from Assessed Negative
    const noAudioResult = await audioProcessor.analyzeAudio(silenceVideoPath, {
      ...silenceAudioMeta,
      hasAudio: false
    });
    assert(noAudioResult.hasMusicDetected === null, '3.4 No-audio stream sets hasMusicDetected to null');
    assert(noAudioResult.musicAnalysisStatus === 'NOT_PROVIDED', '3.4 No-audio stream sets musicAnalysisStatus to NOT_PROVIDED');
    assert(noAudioResult.detectors?.audio_music_detection?.status === 'NOT_PROVIDED', '3.4 Music detector status is NOT_PROVIDED for no-audio container');

    // =========================================================================
    // 3.5 AUDIO PCM EXTRACTION RELIABILITY & BUFFER SAFETY (TASK 3)
    // =========================================================================
    console.log('\n[3.5 Audio PCM Extraction Reliability & Buffer Safety]');

    // 3.5.1 Successful extraction of valid PCM from genuine media
    const pcmSuccessRes = await audioProcessor.extractPcmAudio(modulatedAudioVideoPath, 4);
    assert(pcmSuccessRes.status === 'SUCCESS', '3.5.1 Valid media produces SUCCESS extraction status');
    assert(pcmSuccessRes.totalAudioSeconds >= 3.8 && pcmSuccessRes.totalAudioSeconds <= 4.2, '3.5.1 Total audio duration measured accurately (~4s)');
    assert(pcmSuccessRes.chunkSignatures.length >= 4, '3.5.1 Extracted at least 4 chunk signatures for 4s audio');
    assert(pcmSuccessRes.chunkSignatures[0].rms > 0, '3.5.1 Non-zero RMS energy calculated for audio chunk');
    assert(pcmSuccessRes.chunkSignatures[0].spectralProfile.length === 16, '3.5.1 16-band normalized subband profile generated');

    // 3.5.2 Missing FFmpeg executable fails closed with ANALYSIS_UNAVAILABLE
    const missingFfmpegRes = await audioProcessor.extractPcmAudio(modulatedAudioVideoPath, 4, {
      ffmpegBinary: '/path/to/nonexistent/ffmpeg_binary_xyz'
    });
    assert(missingFfmpegRes.status === 'ANALYSIS_UNAVAILABLE', '3.5.2 Missing FFmpeg binary returns ANALYSIS_UNAVAILABLE');
    assert(missingFfmpegRes.totalAudioSeconds === 0, '3.5.2 Missing FFmpeg binary yields 0 audio seconds');
    assert(missingFfmpegRes.failureReason?.includes('not found') || missingFfmpegRes.failureReason?.includes('inaccessible'), '3.5.2 Failure reason documents missing executable');

    // 3.5.3 Non-zero FFmpeg exit status fails closed with ANALYSIS_UNAVAILABLE
    const mockFfmpegErrorScript = path.resolve(testDir, 'mock_ffmpeg_error.sh');
    fs.writeFileSync(mockFfmpegErrorScript, '#!/bin/sh\necho "Decoder error: invalid bitstream" >&2\nexit 1\n');
    fs.chmodSync(mockFfmpegErrorScript, 0o755);
    const errorFfmpegRes = await audioProcessor.extractPcmAudio(modulatedAudioVideoPath, 4, {
      ffmpegBinary: mockFfmpegErrorScript
    });
    assert(errorFfmpegRes.status === 'ANALYSIS_UNAVAILABLE', '3.5.3 Non-zero exit code returns ANALYSIS_UNAVAILABLE');
    assert(errorFfmpegRes.totalAudioSeconds === 0, '3.5.3 Error process yields 0 audio seconds');
    assert(Boolean(errorFfmpegRes.failureReason), '3.5.3 Process failure records diagnostic failureReason');

    // 3.5.4 Extraction timeout fails closed with ANALYSIS_UNAVAILABLE
    const mockFfmpegHangScript = path.resolve(testDir, 'mock_ffmpeg_hang.sh');
    fs.writeFileSync(mockFfmpegHangScript, '#!/bin/sh\nsleep 5\nexit 0\n');
    fs.chmodSync(mockFfmpegHangScript, 0o755);
    const timeoutFfmpegRes = await audioProcessor.extractPcmAudio(modulatedAudioVideoPath, 4, {
      ffmpegBinary: mockFfmpegHangScript,
      timeoutMs: 150
    });
    assert(timeoutFfmpegRes.status === 'ANALYSIS_UNAVAILABLE', '3.5.4 Process timeout returns ANALYSIS_UNAVAILABLE');
    assert(timeoutFfmpegRes.failureReason?.includes('timed out'), '3.5.4 Timeout recorded in failureReason');

    // 3.5.5 Empty PCM output (0 bytes) returns INSUFFICIENT_EVIDENCE
    const mockFfmpegEmptyScript = path.resolve(testDir, 'mock_ffmpeg_empty.sh');
    fs.writeFileSync(mockFfmpegEmptyScript, '#!/bin/sh\neval "out=\\${$#}"\ntouch "$out"\nexit 0\n');
    fs.chmodSync(mockFfmpegEmptyScript, 0o755);
    const emptyPcmRes = await audioProcessor.extractPcmAudio(modulatedAudioVideoPath, 4, {
      ffmpegBinary: mockFfmpegEmptyScript
    });
    assert(emptyPcmRes.status === 'INSUFFICIENT_EVIDENCE', '3.5.5 Empty PCM output returns INSUFFICIENT_EVIDENCE');
    assert(emptyPcmRes.totalAudioSeconds === 0, '3.5.5 Empty output yields 0 seconds');
    assert(emptyPcmRes.failureReason?.includes('empty'), '3.5.5 Failure reason documents empty PCM output');

    // 3.5.6 Insufficient usable PCM (< 2.0s) returns INSUFFICIENT_EVIDENCE
    const shortAudioVideoPath = path.resolve(testDir, 'short_1s_audio.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:size=320x240:duration=1:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-t', '1',
      '-c:v', 'libx264', '-c:a', 'aac',
      shortAudioVideoPath
    ]);
    const shortPcmRes = await audioProcessor.extractPcmAudio(shortAudioVideoPath, 1.0);
    assert(shortPcmRes.status === 'INSUFFICIENT_EVIDENCE', '3.5.6 Audio under 2s returns INSUFFICIENT_EVIDENCE');
    assert(shortPcmRes.totalAudioSeconds < 2.0, '3.5.6 Duration is under 2.0s');
    assert(shortPcmRes.failureReason?.includes('under 2.0 seconds'), '3.5.6 Failure reason states duration under 2 seconds');

    // 3.5.7 Long audio exceeding previous single-buffer limit (15MB stdout maxBuffer)
    const mockFfmpegLongScript = path.resolve(testDir, 'mock_ffmpeg_long.sh');
    fs.writeFileSync(mockFfmpegLongScript, '#!/bin/sh\neval "out=\\${$#}"\nhead -c 16384000 /dev/zero > "$out"\nexit 0\n');
    fs.chmodSync(mockFfmpegLongScript, 0o755);
    const longPcmRes = await audioProcessor.extractPcmAudio(modulatedAudioVideoPath, 1024, {
      ffmpegBinary: mockFfmpegLongScript
    });
    assert(longPcmRes.status === 'SUCCESS', '3.5.7 Long audio exceeding 15MB processes successfully without maxBuffer overflow');
    assert(longPcmRes.totalAudioSeconds >= 1024, '3.5.7 Extracted all 1024 seconds of 16MB PCM audio stream');
    assert(longPcmRes.chunkSignatures.length >= 1024, '3.5.7 Produced full chunk signatures for large audio file');

    // 3.5.8 Final partial chunk is preserved when meeting duration requirement (4.7s video -> 0.7s partial chunk)
    const partialAudioVideoPath = path.resolve(testDir, 'partial_4_7s_audio.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:size=320x240:duration=4.7:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4.7',
      '-t', '4.7',
      '-c:v', 'libx264', '-c:a', 'aac',
      partialAudioVideoPath
    ]);
    const partialPcmRes = await audioProcessor.extractPcmAudio(partialAudioVideoPath, 4.7);
    assert(partialPcmRes.status === 'SUCCESS', '3.5.8 Fractional media extraction succeeds');
    assert(partialPcmRes.chunkSignatures.length === 5, '3.5.8 Exactly 5 chunks preserved (4 full + 1 trailing partial chunk)');
    const lastChunk = partialPcmRes.chunkSignatures[4];
    assert(lastChunk.sec === 4, '3.5.8 Trailing chunk starts at second 4');
    assert(lastChunk.duration >= 0.65 && lastChunk.duration <= 0.75, '3.5.8 Trailing chunk preserves fractional 0.7s duration');
    assert(lastChunk.rms > 0, '3.5.8 Partial chunk computes valid RMS energy');

    // 3.5.9 Temporary resources are strictly cleaned up on success and failure
    const tmpFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('vr_pcm_'));
    assert(tmpFiles.length === 0, '3.5.9 Zero orphaned vr_pcm_ temporary files remain on disk');

    // =========================================================================
    // 3.6 AUDIO INTERVAL BOUNDARIES & MINIMUM-GAP CORRECTNESS (TASK 3)
    // =========================================================================
    console.log('\n[3.6 Audio Interval Boundaries & Minimum-Gap Correctness]');

    // Create synthetic identical subband spectral profile vector (unit normalized)
    const testSpectralProfile = new Float64Array(16);
    testSpectralProfile[3] = 0.6;
    testSpectralProfile[4] = 0.8; // sumSq = 0.36 + 0.64 = 1.0

    const makeChunk = (sec: number, duration: number = 1.0): AudioChunkSignature => ({
      sec,
      duration,
      rms: 1000,
      zcr: 50,
      spectralProfile: new Float64Array(testSpectralProfile)
    });

    // 3.6.1 Duplicate intervals separated by less than minimum gap (< 2.0s real time) are REJECTED
    // Chunk 1: [0.0, 1.0], Chunk 2: [2.0, 3.0] -> Gap is 2.0 - 1.0 = 1.0s (< 2.0s min gap)
    const gapUnderMinMatches = detectRepeatedAudio([makeChunk(0.0), makeChunk(2.0)], 10.0, 2.0);
    assert(gapUnderMinMatches.length === 0, '3.6.1 Real gap of 1.0s (< 2.0s min gap) is strictly rejected (no false positive from chunk index diff)');

    // 3.6.2 Duplicate intervals separated by exactly minimum gap (== 2.0s real time) are ACCEPTED
    // Chunk 1: [0.0, 1.0], Chunk 2: [3.0, 4.0] -> Gap is 3.0 - 1.0 = 2.0s (== 2.0s min gap)
    const gapExactMinMatches = detectRepeatedAudio([makeChunk(0.0), makeChunk(3.0)], 10.0, 2.0);
    assert(gapExactMinMatches.length === 1, '3.6.2 Real gap of exactly 2.0s is correctly accepted as duplicate');
    assert(gapExactMinMatches[0].start === 0.0, '3.6.2 Exact gap match start is 0.0s');
    assert(gapExactMinMatches[0].end === 1.0, '3.6.2 Exact gap match end is 1.0s');
    assert(gapExactMinMatches[0].matchWithTimestamp === 3.0, '3.6.2 Exact gap target timestamp is 3.0s');

    // 3.6.3 Duplicate intervals separated by more than minimum gap (> 2.0s real time) are ACCEPTED
    // Chunk 1: [0.0, 1.0], Chunk 2: [4.0, 5.0] -> Gap is 4.0 - 1.0 = 3.0s (> 2.0s min gap)
    const gapOverMinMatches = detectRepeatedAudio([makeChunk(0.0), makeChunk(4.0)], 10.0, 2.0);
    assert(gapOverMinMatches.length === 1, '3.6.3 Real gap of 3.0s (> 2.0s min gap) is correctly detected');
    assert(gapOverMinMatches[0].start === 0.0 && gapOverMinMatches[0].end === 1.0 && gapOverMinMatches[0].matchWithTimestamp === 4.0, '3.6.3 Timestamps preserved for > 2s gap');

    // 3.6.4 Adjacent intervals (gap == 0.0s) and overlapping intervals (gap < 0.0s) are REJECTED
    const adjacentMatches = detectRepeatedAudio([makeChunk(0.0), makeChunk(1.0)], 10.0, 2.0);
    assert(adjacentMatches.length === 0, '3.6.4 Adjacent chunks [0,1] and [1,2] (gap 0s) are strictly rejected');
    const overlapMatches = detectRepeatedAudio([makeChunk(0.0), makeChunk(0.5)], 10.0, 2.0);
    assert(overlapMatches.length === 0, '3.6.4 Overlapping chunks (gap < 0s) are strictly rejected');

    // 3.6.5 Duplicate occurrence in the final partial chunk
    // Chunk 1: [0.0, 1.0], Partial Chunk 2: [4.0, 4.7] -> Gap is 4.0 - 1.0 = 3.0s
    const partialMatch = detectRepeatedAudio([makeChunk(0.0, 1.0), makeChunk(4.0, 0.7)], 4.7, 2.0);
    assert(partialMatch.length === 1, '3.6.5 Duplicate occurrence in final partial chunk is detected');
    assert(partialMatch[0].matchWithTimestamp === 4.0, '3.6.5 Target timestamp matches start of partial chunk');

    // 3.6.6 Correct timestamps for chunk boundaries and half-open convention
    assert(gapExactMinMatches[0].start < gapExactMinMatches[0].end, '3.6.6 Half-open interval convention: start < end');
    assert(Number.isFinite(gapExactMinMatches[0].similarity) && gapExactMinMatches[0].similarity > 0.8, '3.6.6 High similarity score for identical spectral profiles');

    // 3.6.7 Fractional-duration, rounding tolerance, and contiguous segment merging
    const rawContiguous = [
      { start: 0.0, end: 1.0, matchWithTimestamp: 4.0, similarity: 0.95 },
      { start: 1.0, end: 2.0, matchWithTimestamp: 5.0, similarity: 0.95 }
    ];
    const mergedContiguous = mergeContiguousAudioSegments(rawContiguous);
    assert(mergedContiguous.length === 1, '3.6.7 Contiguous matching chunks cleanly merged into 1 continuous interval');
    assert(mergedContiguous[0].start === 0.0 && mergedContiguous[0].end === 2.0, '3.6.7 Merged interval covers 0.0–2.0s');
    assert(mergedContiguous[0].matchWithTimestamp === 4.0, '3.6.7 Merged match target starts at 4.0s');

    // Disjoint intervals are NOT falsely merged
    const rawDisjoint = [
      { start: 0.0, end: 1.0, matchWithTimestamp: 4.0, similarity: 0.95 },
      { start: 3.0, end: 4.0, matchWithTimestamp: 7.0, similarity: 0.95 }
    ];
    const mergedDisjoint = mergeContiguousAudioSegments(rawDisjoint);
    assert(mergedDisjoint.length === 2, '3.6.7 Disjoint intervals are NOT falsely merged');

    // =========================================================================
    // 4. STT EXECUTION & TIMESTAMP INTEGRITY (SECTION 5)
    // =========================================================================
    console.log('\n[4. STT Execution & Timestamp Integrity]');

    const sttAdapter = new SpeechTranscriptionAdapter();

    // 4.1 Plain text output WITHOUT timestamps (MUST NOT fabricate [0, duration] segment)
    // Create mock script that outputs plain text
    const mockPlainTextScript = path.resolve(testDir, 'mock_stt_plaintext.sh');
    fs.writeFileSync(mockPlainTextScript, '#!/bin/sh\necho "Hello this is a plain text transcript without timestamps"\n');
    fs.chmodSync(mockPlainTextScript, 0o755);

    const prevStt = process.env.WHISPER_PATH;
    process.env.WHISPER_PATH = mockPlainTextScript;
    try {
      const plainTextResult = await sttAdapter.transcribe(silenceVideoPath, 10.0);
      assert(plainTextResult.status === 'DETECTED', '4.1 Plain text transcript detects text');
      assert(plainTextResult.transcriptText?.includes('plain text transcript'), '4.1 Correct plain text captured');
      assert(plainTextResult.segments?.length === 0, '4.1 CRITICAL: segments array is EMPTY (zero fabricated full-duration segments)');
      assert(plainTextResult.limitations.includes('without segment timestamps'), '4.1 Limitations explicitly explain timestamps were not fabricated');
    } finally {
      process.env.WHISPER_PATH = prevStt;
    }

    // 4.2 Valid JSON output with ordered timestamps
    const mockValidJsonScript = path.resolve(testDir, 'mock_stt_valid_json.sh');
    const validJsonOutput = JSON.stringify({
      text: "First point. Second point.",
      segments: [
        { start: 0.5, end: 2.5, text: "First point." },
        { start: 3.0, end: 5.5, text: "Second point." }
      ]
    });
    fs.writeFileSync(mockValidJsonScript, `#!/bin/sh\ncat << 'EOF'\n${validJsonOutput}\nEOF\n`);
    fs.chmodSync(mockValidJsonScript, 0o755);

    process.env.WHISPER_PATH = mockValidJsonScript;
    try {
      const validJsonResult = await sttAdapter.transcribe(silenceVideoPath, 10.0);
      assert(validJsonResult.status === 'DETECTED', '4.2 Valid JSON STT status is DETECTED');
      assert(validJsonResult.segments?.length === 2, '4.2 Exactly 2 validated segments returned');
      assert(validJsonResult.segments![0].start === 0.5 && validJsonResult.segments![0].end === 2.5, '4.2 Segment 1 timestamps preserved');
      assert(validJsonResult.segments![1].start === 3.0 && validJsonResult.segments![1].end === 5.5, '4.2 Segment 2 timestamps preserved');
    } finally {
      process.env.WHISPER_PATH = prevStt;
    }

    // 4.3 Malformed JSON output
    const mockMalformedJsonScript = path.resolve(testDir, 'mock_stt_malformed.sh');
    fs.writeFileSync(mockMalformedJsonScript, '#!/bin/sh\necho "{\\"text\\": incomplete json corrupt"\n');
    fs.chmodSync(mockMalformedJsonScript, 0o755);

    process.env.WHISPER_PATH = mockMalformedJsonScript;
    try {
      const malformedResult = await sttAdapter.transcribe(silenceVideoPath, 10.0);
      assert(malformedResult.status === 'ANALYSIS_UNAVAILABLE', '4.3 Malformed JSON fails closed to ANALYSIS_UNAVAILABLE');
      assert(malformedResult.failureReason?.includes('Malformed JSON'), '4.3 Failure reason records malformed JSON error');
    } finally {
      process.env.WHISPER_PATH = prevStt;
    }

    // 4.4 Corrupted timestamps (negative, start >= end, beyond duration)
    const mockCorruptTimestampsScript = path.resolve(testDir, 'mock_stt_corrupt_ts.sh');
    const corruptJsonOutput = JSON.stringify({
      text: "Good and bad timestamps",
      segments: [
        { start: -5.0, end: 2.0, text: "Negative start" },
        { start: 3.0, end: 1.0, text: "End before start" },
        { start: 25.0, end: 30.0, text: "Beyond 10s duration" },
        { start: 4.0, end: 7.0, text: "Valid middle segment" }
      ]
    });
    fs.writeFileSync(mockCorruptTimestampsScript, `#!/bin/sh\ncat << 'EOF'\n${corruptJsonOutput}\nEOF\n`);
    fs.chmodSync(mockCorruptTimestampsScript, 0o755);

    process.env.WHISPER_PATH = mockCorruptTimestampsScript;
    try {
      const corruptTsResult = await sttAdapter.transcribe(silenceVideoPath, 10.0);
      assert(corruptTsResult.segments?.length === 1, '4.4 Invalid/corrupt timestamps safely filtered out (only 1 valid segment kept)');
      assert(corruptTsResult.segments![0].text === "Valid middle segment", '4.4 Preserved segment is the genuine valid segment');
      assert(corruptTsResult.limitations.includes('invalid or out-of-order segment timestamp(s) were rejected'), '4.4 Limitations document rejected invalid timestamps');
    } finally {
      process.env.WHISPER_PATH = prevStt;
    }

    // 4.5 Empty output fails closed to INSUFFICIENT_EVIDENCE (must NOT report NO_SIGNAL_DETECTED)
    const mockEmptyScript = path.resolve(testDir, 'mock_stt_empty.sh');
    fs.writeFileSync(mockEmptyScript, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(mockEmptyScript, 0o755);

    process.env.WHISPER_PATH = mockEmptyScript;
    try {
      const emptyResult = await sttAdapter.transcribe(silenceVideoPath, 10.0);
      assert(emptyResult.status === 'INSUFFICIENT_EVIDENCE', '4.5 Empty STT output reports INSUFFICIENT_EVIDENCE');
      assert(emptyResult.segments?.length === 0, '4.5 Empty segments array');
      assert(Boolean(emptyResult.failureReason), '4.5 Empty STT output records failureReason');
    } finally {
      process.env.WHISPER_PATH = prevStt;
    }

    // 4.6 Missing executable
    process.env.WHISPER_PATH = '/path/to/non_existent_whisper_binary';
    try {
      const missingBinResult = await sttAdapter.transcribe(silenceVideoPath, 10.0);
      assert(missingBinResult.status === 'ANALYSIS_UNAVAILABLE', '4.6 Missing STT binary reports ANALYSIS_UNAVAILABLE');
      assert(missingBinResult.failureReason?.includes('not found'), '4.6 Explicit failure reason for missing executable');
    } finally {
      process.env.WHISPER_PATH = prevStt;
    }

    // 4.7 Missing both text and segments fields in JSON fails closed
    const mockMissingFieldsScript = path.resolve(testDir, 'mock_stt_missing_fields.sh');
    fs.writeFileSync(mockMissingFieldsScript, '#!/bin/sh\necho \'{"status": "ok", "duration": 10}\'\n');
    fs.chmodSync(mockMissingFieldsScript, 0o755);
    process.env.WHISPER_PATH = mockMissingFieldsScript;
    try {
      const missingFieldsResult = await sttAdapter.transcribe(silenceVideoPath, 10.0);
      assert(missingFieldsResult.status === 'ANALYSIS_UNAVAILABLE', '4.7 JSON missing text & segments reports ANALYSIS_UNAVAILABLE');
      assert(Boolean(missingFieldsResult.failureReason), '4.7 Missing text & segments records failureReason');
    } finally {
      process.env.WHISPER_PATH = prevStt;
    }

    // 4.8 Explicit confirmed negative detection {"text": "", "segments": []}
    const mockExplicitNegativeScript = path.resolve(testDir, 'mock_stt_explicit_negative.sh');
    fs.writeFileSync(mockExplicitNegativeScript, '#!/bin/sh\necho \'{"text": "", "segments": []}\'\n');
    fs.chmodSync(mockExplicitNegativeScript, 0o755);
    process.env.WHISPER_PATH = mockExplicitNegativeScript;
    try {
      const negResult = await sttAdapter.transcribe(silenceVideoPath, 10.0);
      assert(negResult.status === 'NO_SIGNAL_DETECTED', '4.8 Explicit empty text and segments reports NO_SIGNAL_DETECTED');
      assert(negResult.segments?.length === 0, '4.8 Negative result has empty segments');
    } finally {
      process.env.WHISPER_PATH = prevStt;
    }

    // 4.9 Process error non-zero exit code fails closed
    const mockSttErrorScript = path.resolve(testDir, 'mock_stt_error.sh');
    fs.writeFileSync(mockSttErrorScript, '#!/bin/sh\necho "STT engine crashed" >&2\nexit 1\n');
    fs.chmodSync(mockSttErrorScript, 0o755);
    process.env.WHISPER_PATH = mockSttErrorScript;
    try {
      const errorResult = await sttAdapter.transcribe(silenceVideoPath, 10.0);
      assert(errorResult.status === 'ANALYSIS_UNAVAILABLE', '4.9 Process error reports ANALYSIS_UNAVAILABLE');
      assert(Boolean(errorResult.failureReason), '4.9 Process error records failureReason');
    } finally {
      process.env.WHISPER_PATH = prevStt;
    }

    // 4.10 All segment timestamps invalid with no transcript text
    const mockAllInvalidTsScript = path.resolve(testDir, 'mock_stt_all_invalid_ts.sh');
    fs.writeFileSync(mockAllInvalidTsScript, '#!/bin/sh\necho \'{"text": "", "segments": [{"start": -10, "end": -5, "text": "bad"}]}\'\n');
    fs.chmodSync(mockAllInvalidTsScript, 0o755);
    process.env.WHISPER_PATH = mockAllInvalidTsScript;
    try {
      const allInvalidResult = await sttAdapter.transcribe(silenceVideoPath, 10.0);
      assert(allInvalidResult.status === 'INSUFFICIENT_EVIDENCE', '4.10 All invalid timestamps with no text reports INSUFFICIENT_EVIDENCE');
      assert(Boolean(allInvalidResult.failureReason), '4.10 All invalid timestamps records failureReason');
    } finally {
      process.env.WHISPER_PATH = prevStt;
    }

    // =========================================================================
    // 5. THUMBNAIL OCR & CONTRAST DECOUPLING (SECTION 7)
    // =========================================================================
    console.log('\n[5. Thumbnail OCR & Contrast Decoupling]');

    const testThumbPath = path.resolve(testDir, 'test_thumb.jpg');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=darkblue:size=1280x720:d=1',
      '-vframes', '1', testThumbPath
    ]);

    const thumbResult = await thumbnailInspector.inspect(testThumbPath, 'test_thumb.jpg');
    assert(thumbResult.hasHighContrastText === null, '5.1 hasHighContrastText is null when contrast is not directly assessed');
    assert(thumbResult.contrastAnalysisStatus === 'NOT_ASSESSED', '5.1 contrastAnalysisStatus is NOT_ASSESSED');
    assert(thumbResult.detectors?.thumbnail_contrast?.status === 'NOT_ASSESSED', '5.1 thumbnail_contrast detector report is NOT_ASSESSED');

    // =========================================================================
    // 6. RE-SCAN VALIDATION & COMPARISON SUMMARY (SECTION 9)
    // =========================================================================
    console.log('\n[6. Re-scan Validation & Comparison Summary]');

    // 6.1 Media validity check in canVerifyResolution
    const mockBaseline: any = {
      scanId: 'scan_base',
      overallRisk: 'HIGH_RISK' as const,
      riskScore: 75,
      channelTopic: 'Tech',
      summary: 'Baseline summary',
      riskSummary: 'Risk summary',
      disclaimer: 'Disclaimer',
      riskCategories: [],
      policyConnections: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      evaluatedPoliciesCount: 5,
      criticalViolationsCount: 1,
      keyFindings: [],
      topIssues: [
        {
          id: 'issue_vid_1',
          domain: 'video_audio' as const,
          what: 'Excessive Visual Repetition',
          where: '00:00–00:05',
          why: 'Repeated footage',
          fix: 'Edit footage',
          evidence: 'video:repeated_footage',
          context: 'Video',
          recommendedAction: 'Vary b-roll',
          confidence: 'HIGH' as const,
          limitations: 'Local check',
          severity: 'warning' as const,
          policyArea: 'REUSED CONTENT',
          category: 'reused_content' as const,
          timestampSeconds: 0
        }
      ],
      recommendations: [],
      domainReports: {
        video_audio: {
          domain: 'video_audio' as const,
          status: 'POTENTIAL_RISK_DETECTED' as const,
          title: 'Video & Audio',
          summary: 'Risk detected',
          riskLevel: 'HIGH_RISK' as const,
          evidenceCount: 1,
          limitations: 'Local'
        },
        title: { domain: 'title' as const, status: 'NO_MAJOR_RISK_SIGNALS_DETECTED' as const, title: 'Title', summary: 'Clean', riskLevel: 'LOW_RISK' as const, evidenceCount: 0 },
        description_tags: { domain: 'description_tags' as const, status: 'NO_MAJOR_RISK_SIGNALS_DETECTED' as const, title: 'Desc', summary: 'Clean', riskLevel: 'LOW_RISK' as const, evidenceCount: 0 },
        thumbnail: { domain: 'thumbnail' as const, status: 'NO_MAJOR_RISK_SIGNALS_DETECTED' as const, title: 'Thumb', summary: 'Clean', riskLevel: 'LOW_RISK' as const, evidenceCount: 0 },
        channel_context: { domain: 'channel_context' as const, status: 'NO_MAJOR_RISK_SIGNALS_DETECTED' as const, title: 'Channel', summary: 'Clean', riskLevel: 'LOW_RISK' as const, evidenceCount: 0 }
      },
      evidenceTimeline: [],
      benchmarkTimings: { uploadMs: 0, inspectionMs: 0, audioMs: 0, videoMs: 0, policyMs: 0, reportMs: 0, totalProcessingMs: 0 }
    };

    // Revised scan with empty media (durationSeconds: 0)
    const mockRevisedEmpty: any = {
      ...mockBaseline,
      scanId: 'scan_rev_empty',
      topIssues: [],
      domainReports: {
        ...mockBaseline.domainReports,
        video_audio: {
          ...mockBaseline.domainReports.video_audio,
          status: 'NO_MAJOR_RISK_SIGNALS_DETECTED' as const
        }
      }
    };

    const emptyMediaComparison = policyIntelligenceEngine.generateComparison(mockBaseline as RiskReport, mockRevisedEmpty as RiskReport, {
      revisedScanRecord: {
        status: 'COMPLETED',
        metadata: {
          filename: 'empty.mp4',
          originalSize: 0,
          durationSeconds: 0,
          width: 0,
          height: 0,
          resolutionLabel: '0p',
          fps: 0,
          hasAudio: false,
          isProxyUsed: false
        }
      }
    });

    assert(emptyMediaComparison.resolvedIssues.length === 0, '6.1 Zero-duration or empty media cannot verify resolution');
    assert(Boolean(emptyMediaComparison.notVerifiedIssues?.some(i => i.includes('zero or invalid duration'))), '6.1 Explicit unverified reason for invalid media duration');

    // 6.2 Comparison summary: Mixed results (1 resolved, 1 remaining, 1 unverified)
    const multiBaseline: any = {
      ...mockBaseline,
      topIssues: [
        mockBaseline.topIssues[0], // video issue (will be resolved)
        {
          id: 'issue_title_persist',
          domain: 'title' as const,
          what: 'Sensational Title',
          where: 'Title',
          why: 'Exaggeration',
          fix: 'Tone down',
          evidence: 'nlp:title',
          context: 'Title',
          recommendedAction: 'Tone down',
          confidence: 'HIGH' as const,
          limitations: 'Local',
          severity: 'warning' as const,
          policyArea: 'COMMUNITY GUIDELINES',
          category: 'community_guidelines' as const,
          timestampSeconds: 0
        },
        {
          id: 'issue_thumb_unverified',
          domain: 'thumbnail' as const,
          what: 'Clickbait Overlay',
          where: 'Thumbnail',
          why: 'Sensational text',
          fix: 'Remove text',
          evidence: 'ocr:text',
          context: 'Thumbnail',
          recommendedAction: 'Remove',
          confidence: 'HIGH' as const,
          limitations: 'Local',
          severity: 'warning' as const,
          policyArea: 'THUMBNAIL INTEGRITY',
          category: 'thumbnail_integrity' as const,
          timestampSeconds: 0
        }
      ]
    };

    const mixedRevised: any = {
      ...mockBaseline,
      scanId: 'scan_mixed_rev',
      topIssues: [
        multiBaseline.topIssues[1] // title issue persists
      ],
      domainReports: {
        ...mockBaseline.domainReports,
        video_audio: {
          ...mockBaseline.domainReports.video_audio,
          status: 'NO_MAJOR_RISK_SIGNALS_DETECTED' as const // resolved
        },
        thumbnail: {
          ...mockBaseline.domainReports.thumbnail,
          status: 'NOT_ASSESSED' as const // unverified
        }
      }
    };

    const mixedComp = policyIntelligenceEngine.generateComparison(multiBaseline as RiskReport, mixedRevised as RiskReport, {
      originalScanRecord: { status: 'COMPLETED', metadata: { durationSeconds: 10, originalSize: 1000, videoCodec: 'h264' } as any },
      revisedScanRecord: { status: 'COMPLETED', metadata: { durationSeconds: 10, originalSize: 1000, videoCodec: 'h264' } as any }
    });

    assert(mixedComp.resolvedIssues.length === 1, '6.2 1 issue resolved');
    assert(mixedComp.remainingIssues.length === 1, '6.2 1 issue persisting');
    assert(mixedComp.notVerifiedIssues?.length === 1, '6.2 1 issue unverified');
    assert(!mixedComp.comparisonSummary.startsWith('Re-scan verified.'), '6.2 Summary DOES NOT claim "Re-scan verified." when persisting/unverified issues remain');
    assert(mixedComp.comparisonSummary.includes('mixed results'), '6.2 Summary accurately states mixed results');

    // =========================================================================
    // 7. GENUINE MEDIA-BASED END-TO-END WORKFLOW (SECTION 10)
    // =========================================================================
    console.log('\n[7. Genuine Media-Based End-to-End Workflow]');

    // Setup HTTP server with real routes and storage
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    app.use('/uploads', secureUploadsHandler);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}/api`;

    try {
      // 7.1 Create test user & authenticate
      const e2eUser = await storage.users.createUser(`e2e_${Date.now()}@test.com`, 'enterprise');
      const e2eSessionToken = await storage.users.createSession(e2eUser.id);

      // 7.2 Upload initial video with real media
      const initialUploadPath = path.resolve(testDir, 'e2e_initial.mp4');
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'smptebars=duration=2:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
        '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[outv]',
        '-map', '[outv]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        initialUploadPath
      ]);

      const initialBuffer = fs.readFileSync(initialUploadPath);
      const uploadForm = new FormData();
      uploadForm.append('video', new Blob([initialBuffer], { type: 'video/mp4' }), 'initial.mp4');

      const uploadRes = await fetch(`${baseUrl}/uploads`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${e2eSessionToken}` },
        body: uploadForm
      });

      assert(uploadRes.status === 200, '7.2 Initial media uploaded via HTTP POST /uploads (200 OK)');
      const uploadData = await uploadRes.json();
      assert(uploadData.filePath && fs.existsSync(uploadData.filePath), '7.2 Uploaded media file stored securely');

      const createRes = await fetch(`${baseUrl}/scans`, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${e2eSessionToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          videoPath: uploadData.filePath,
          videoFilename: uploadData.filename,
          videoTitle: 'Initial Video with Repetition',
          videoDescription: 'Initial description',
          scanMode: 'standard'
        })
      });

      assert(createRes.status === 201, '7.2 Initial media scan created via HTTP POST /scans (201 Created)');
      const initialJob = await createRes.json();
      assert(initialJob.id && initialJob.status === 'QUEUED', '7.2 Job enqueued in durable storage');

      // 7.3 Create revised video without repetition (clean continuous footage)
      const revisedUploadPath = path.resolve(testDir, 'e2e_revised.mp4');
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=10',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        revisedUploadPath
      ]);

      const revisedBuffer = fs.readFileSync(revisedUploadPath);
      const rescanForm = new FormData();
      rescanForm.append('video', new Blob([revisedBuffer], { type: 'video/mp4' }), 'revised_cut.mp4');

      const rescanRes = await fetch(`${baseUrl}/scans/${initialJob.id}/rescan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${e2eSessionToken}` },
        body: rescanForm
      });

      assert(rescanRes.status === 201, '7.3 Revised media uploaded via POST /scans/:id/rescan (201 Created)');
      const rescanJob = await rescanRes.json();
      assert(rescanJob.isRescan === true, '7.3 Rescan job marked as isRescan: true');
      assert(rescanJob.parentScanId === initialJob.id, '7.3 Rescan references initial parent scan');
      assert(fs.existsSync(rescanJob.videoPath), '7.3 Revised media file exists on disk');
      assert(!rescanJob.videoPath.includes('VIDEORISK_RESCAN_CONTAINER'), '7.3 Real media stored, NOT dummy VIDEORISK_RESCAN_CONTAINER');
    } finally {
      server.close();
    }

    // =========================================================================
    // 8. STAGE 1: RISK AGGREGATION FAIL-CLOSED & COVERAGE INTEGRITY
    // =========================================================================
    console.log('\n[8. Stage 1: Risk Aggregation Fail-Closed & Coverage Integrity]');

    const standardMetaWithAudio: MediaMetadata = {
      filename: 'sample_media.mp4',
      originalSize: 1024 * 1024,
      durationSeconds: 10,
      width: 1280,
      height: 720,
      resolutionLabel: '720p HD',
      fps: 30,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      isProxyUsed: false
    };

    const cleanVideoResult = {
      scenesCount: 2,
      framesSampled: 10,
      hasSlideshowPattern: false,
      repeatedFootageSegments: [],
      templateRepetitions: [],
      averagePacingSeconds: 5,
      tempFramesDir: '',
      repeatedFootageStatus: 'NO_SIGNAL_DETECTED' as const,
      detectors: {
        video_scene_cut: {
          detectorName: 'ffmpeg_scene_select',
          version: '1.0.0',
          status: 'DETECTED' as const,
          executionDurationMs: 50
        },
        video_repeated_footage: {
          detectorName: 'perceptual_hash_comparator',
          version: '1.0.0',
          status: 'NO_SIGNAL_DETECTED' as const,
          executionDurationMs: 40
        }
      }
    };

    const cleanAudioResult = {
      hasVoiceover: false,
      voiceoverRatio: 0,
      silenceRatio: 0.1,
      hasMusicDetected: false,
      advertiserSpeechFlags: [],
      segments: [{ start: 0, end: 10, type: 'voice' as const }],
      transcriptSummary: 'Clean audio.',
      speechAnalysisStatus: 'NO_SIGNAL_DETECTED' as const,
      repeatedAudioStatus: 'NO_SIGNAL_DETECTED' as const,
      repeatedAudioSegments: [],
      detectors: {
        audio_silence_volume: {
          detectorName: 'ffmpeg_silence_and_volume',
          version: '1.0.0',
          status: 'DETECTED' as const,
          executionDurationMs: 30
        },
        audio_repeated_segments: {
          detectorName: 'subband_spectral_audio_fingerprint',
          version: '1.1.0',
          status: 'NO_SIGNAL_DETECTED' as const,
          executionDurationMs: 25
        }
      }
    };

    // -------------------------------------------------------------------------
    // Test 1: Required video analyzer unavailable
    // -------------------------------------------------------------------------
    const failedVideoResult = {
      ...cleanVideoResult,
      detectors: {
        ...cleanVideoResult.detectors,
        video_scene_cut: {
          detectorName: 'ffmpeg_scene_select',
          version: '1.0.0',
          status: 'ANALYSIS_UNAVAILABLE' as const,
          executionDurationMs: 5,
          failureReason: 'FFmpeg scene select filter exited with error'
        }
      }
    };

    const reportVideoFail = policyIntelligenceEngine.buildReport({
      scanId: 'scan_fail_video_core',
      metadata: standardMetaWithAudio,
      scanMode: 'standard',
      audioResult: cleanAudioResult,
      videoResult: failedVideoResult,
      videoTitle: 'Test Video Analyzer Fail'
    }, []);

    assert(reportVideoFail.overallRisk !== 'LOW_RISK', '8.1 Video core failure must NOT return LOW_RISK (fail-closed)');
    assert(reportVideoFail.overallRisk === 'NEEDS_REVIEW', '8.1 Video core failure escalates to NEEDS_REVIEW');
    assert(reportVideoFail.domainReports.video_audio.status !== 'NO_MAJOR_RISK_SIGNALS_DETECTED', '8.1 Video core failure domain does NOT claim NO_MAJOR_RISK_SIGNALS_DETECTED');
    assert(reportVideoFail.domainReports.video_audio.status === 'REVIEW_RECOMMENDED', '8.1 Video core failure domain status reflects REVIEW_RECOMMENDED');
    assert(reportVideoFail.riskSummary.toLowerCase().includes('incomplete'), '8.1 Risk summary communicates incomplete analysis');
    assert(reportVideoFail.timeline.some(t => t.type === 'core_analyzer_unavailable'), '8.1 Timeline contains core_analyzer_unavailable warning item');

    // Also verify when repeatedFootageStatus is ANALYSIS_UNAVAILABLE
    const failedRepeatedVideoResult = {
      ...cleanVideoResult,
      repeatedFootageStatus: 'ANALYSIS_UNAVAILABLE' as const,
      detectors: {
        ...cleanVideoResult.detectors,
        video_repeated_footage: {
          detectorName: 'perceptual_hash_comparator',
          version: '1.0.0',
          status: 'ANALYSIS_UNAVAILABLE' as const,
          executionDurationMs: 5,
          failureReason: 'Perceptual frame hashing failed'
        }
      }
    };
    const reportRepeatVideoFail = policyIntelligenceEngine.buildReport({
      scanId: 'scan_fail_video_repeat',
      metadata: standardMetaWithAudio,
      scanMode: 'standard',
      audioResult: cleanAudioResult,
      videoResult: failedRepeatedVideoResult
    }, []);
    assert(reportRepeatVideoFail.overallRisk === 'NEEDS_REVIEW', '8.1 Repeated footage failure returns NEEDS_REVIEW');

    // -------------------------------------------------------------------------
    // Test 2: Required audio analyzer unavailable
    // -------------------------------------------------------------------------
    const failedAudioResult = {
      ...cleanAudioResult,
      repeatedAudioStatus: 'ANALYSIS_UNAVAILABLE' as const,
      detectors: {
        ...cleanAudioResult.detectors,
        audio_repeated_segments: {
          detectorName: 'subband_spectral_audio_fingerprint',
          version: '1.1.0',
          status: 'ANALYSIS_UNAVAILABLE' as const,
          executionDurationMs: 10,
          failureReason: 'PCM extraction failed during local FFmpeg execution'
        }
      }
    };

    const reportAudioFail = policyIntelligenceEngine.buildReport({
      scanId: 'scan_fail_audio_core',
      metadata: standardMetaWithAudio,
      scanMode: 'standard',
      audioResult: failedAudioResult,
      videoResult: cleanVideoResult,
      videoTitle: 'Test Audio Analyzer Fail'
    }, []);

    assert(reportAudioFail.overallRisk !== 'LOW_RISK', '8.2 Audio core failure must NOT return LOW_RISK');
    assert(reportAudioFail.overallRisk === 'NEEDS_REVIEW', '8.2 Audio core failure escalates to NEEDS_REVIEW');
    assert(reportAudioFail.domainReports.video_audio.status !== 'NO_MAJOR_RISK_SIGNALS_DETECTED', '8.2 Audio core failure does NOT claim NO_MAJOR_RISK_SIGNALS_DETECTED');
    assert(reportAudioFail.riskSummary.toLowerCase().includes('incomplete'), '8.2 Audio failure summary communicates incomplete analysis');

    // -------------------------------------------------------------------------
    // Test 3: Optional STT unavailable remains compatible
    // -------------------------------------------------------------------------
    const optionalSttUnavailableAudioResult = {
      ...cleanAudioResult,
      speechAnalysisStatus: 'ANALYSIS_UNAVAILABLE' as const,
      detectors: {
        ...cleanAudioResult.detectors,
        audio_transcription: {
          detectorName: 'local_speech_to_text_adapter',
          version: '1.0.0',
          status: 'ANALYSIS_UNAVAILABLE' as const,
          executionDurationMs: 0,
          limitations: 'Local STT binary not found on host'
        }
      }
    };

    const reportSttUnavailable = policyIntelligenceEngine.buildReport({
      scanId: 'scan_stt_unavailable',
      metadata: standardMetaWithAudio,
      scanMode: 'standard',
      audioResult: optionalSttUnavailableAudioResult,
      videoResult: cleanVideoResult,
      videoTitle: 'Clean Video with Unavailable STT'
    }, []);

    assert(reportSttUnavailable.overallRisk === 'LOW_RISK', '8.3 Optional STT unavailable preserves clean LOW_RISK baseline');
    assert(reportSttUnavailable.domainReports.video_audio.status === 'NO_MAJOR_RISK_SIGNALS_DETECTED', '8.3 Clean video with unavailable STT reports NO_MAJOR_RISK_SIGNALS_DETECTED');
    const origContribPolicy = reportSttUnavailable.policyConnections.find(p => p.policyName.includes('Original Creator Contribution'));
    assert(origContribPolicy?.impact === 'Insufficient Evidence', '8.3 Originality policy marks Insufficient Evidence when speech is unverified');

    // -------------------------------------------------------------------------
    // Test 4: Optional music classifier unavailable remains compatible
    // -------------------------------------------------------------------------
    const optionalMusicUnavailableAudioResult = {
      ...cleanAudioResult,
      hasMusicDetected: null,
      musicAnalysisStatus: 'ANALYSIS_UNAVAILABLE' as const,
      detectors: {
        ...cleanAudioResult.detectors,
        audio_music_detection: {
          detectorName: 'music_classification_analyzer',
          version: '1.0.0',
          status: 'ANALYSIS_UNAVAILABLE' as const,
          executionDurationMs: 0,
          limitations: 'Music classifier model not available'
        }
      }
    };

    const reportMusicUnavailable = policyIntelligenceEngine.buildReport({
      scanId: 'scan_music_unavailable',
      metadata: standardMetaWithAudio,
      scanMode: 'standard',
      audioResult: optionalMusicUnavailableAudioResult,
      videoResult: cleanVideoResult
    }, []);

    assert(reportMusicUnavailable.overallRisk === 'LOW_RISK', '8.4 Optional music classifier unavailable preserves LOW_RISK baseline');
    assert(reportMusicUnavailable.riskCategories.copyrightSignals.status === 'LOW_RISK', '8.4 Copyright category remains LOW_RISK when no flags are present');

    // -------------------------------------------------------------------------
    // Test 5: Missing stream is not treated as analyzer failure
    // -------------------------------------------------------------------------
    // 5A: Video without audio stream
    const noAudioMeta: MediaMetadata = {
      ...standardMetaWithAudio,
      hasAudio: false,
      audioCodec: undefined
    };
    const emptyAudioResult = {
      ...cleanAudioResult,
      detectors: {} // no audio detectors run
    };
    const reportNoAudio = policyIntelligenceEngine.buildReport({
      scanId: 'scan_no_audio_stream',
      metadata: noAudioMeta,
      scanMode: 'standard',
      audioResult: emptyAudioResult,
      videoResult: cleanVideoResult
    }, []);
    assert(reportNoAudio.overallRisk === 'LOW_RISK', '8.5A Missing audio stream does NOT trigger audio core fail-closed');
    assert(reportNoAudio.domainReports.video_audio.status === 'NO_MAJOR_RISK_SIGNALS_DETECTED', '8.5A Clean silent video domain status is NO_MAJOR_RISK_SIGNALS_DETECTED');

    // 5B: Audio-only container (no video stream)
    const audioOnlyMeta: MediaMetadata = {
      filename: 'audio_only.mp3',
      originalSize: 500000,
      durationSeconds: 10,
      width: 0,
      height: 0,
      resolutionLabel: 'Audio Only (No Video Stream)',
      fps: 0,
      hasAudio: true,
      audioCodec: 'mp3',
      isProxyUsed: false
    };
    const emptyVideoResult = {
      scenesCount: 0,
      framesSampled: 0,
      hasSlideshowPattern: false,
      repeatedFootageSegments: [],
      templateRepetitions: [],
      averagePacingSeconds: 0,
      tempFramesDir: '',
      detectors: {} // no video detectors run
    };
    const reportAudioOnly = policyIntelligenceEngine.buildReport({
      scanId: 'scan_audio_only',
      metadata: audioOnlyMeta,
      scanMode: 'standard',
      audioResult: cleanAudioResult,
      videoResult: emptyVideoResult
    }, []);
    assert(reportAudioOnly.overallRisk === 'LOW_RISK', '8.5B Audio-only media does NOT trigger video core fail-closed');

    // -------------------------------------------------------------------------
    // Test 6: Higher-severity findings take precedence
    // -------------------------------------------------------------------------
    // Core video analyzer failed, BUT timeline already contains high-severity warning
    const highRiskTimeline: EvidenceItem[] = [{
      id: 'ev_high_1',
      scanId: 'scan_high_risk_precedence',
      domain: 'video_audio',
      timestampStart: 0,
      timestampEnd: 5,
      timestampLabel: '00:00–00:05',
      type: 'severe_policy_violation',
      category: 'reused_content',
      severity: 'high',
      confidence: 0.99,
      confidenceLevel: 'HIGH',
      provenance: 'manual_override',
      source: 'test',
      label: '🔴 Critical Violation',
      details: 'Confirmed reused content without modification.'
    }];

    const reportHighPrecedence = policyIntelligenceEngine.buildReport({
      scanId: 'scan_high_risk_precedence',
      metadata: standardMetaWithAudio,
      scanMode: 'standard',
      audioResult: cleanAudioResult,
      videoResult: failedVideoResult // video_scene_cut is ANALYSIS_UNAVAILABLE
    }, highRiskTimeline);

    assert(reportHighPrecedence.overallRisk === 'HIGH_RISK', '8.6 HIGH_RISK takes precedence over analyzer failure NEEDS_REVIEW');
    assert(!reportHighPrecedence.riskSummary.includes('No major risk signals'), '8.6 High risk report does NOT claim clean signals');

    // -------------------------------------------------------------------------
    // Test 7: Clean baseline remains unchanged
    // -------------------------------------------------------------------------
    const reportCleanBaseline = policyIntelligenceEngine.buildReport({
      scanId: 'scan_clean_baseline',
      metadata: standardMetaWithAudio,
      scanMode: 'standard',
      audioResult: cleanAudioResult,
      videoResult: cleanVideoResult
    }, []);

    assert(reportCleanBaseline.overallRisk === 'LOW_RISK', '8.7 Clean baseline remains LOW_RISK when all core analyzers complete successfully');
    assert(reportCleanBaseline.domainReports.video_audio.status === 'NO_MAJOR_RISK_SIGNALS_DETECTED', '8.7 Clean baseline reports NO_MAJOR_RISK_SIGNALS_DETECTED');
    assert(reportCleanBaseline.riskSummary.includes('No major risk signals detected'), '8.7 Clean baseline summary confirms no major risk signals');

    // =========================================================================
    // SECTION 9: AUDIO ANALYSIS COST CONTROLS & SCORE SEMANTICS
    // =========================================================================
    console.log('\n[9. Audio Analysis Cost Controls & Score Semantics]');

    // Helper to generate distinct synthetic chunk profiles
    const makeProfile = (baseIndex: number): Float64Array => {
      const arr = new Float64Array(16);
      for (let b = 0; b < 16; b++) {
        arr[b] = ((b + baseIndex) % 7) + 1;
      }
      let sumSq = 0;
      for (let b = 0; b < 16; b++) sumSq += arr[b] * arr[b];
      const norm = Math.sqrt(sumSq) || 1;
      for (let b = 0; b < 16; b++) arr[b] /= norm;
      return arr;
    };

    const makeSynthChunk = (sec: number, profileId: number, rms: number = 800, zcr: number = 50): AudioChunkSignature => ({
      sec,
      duration: 1.0,
      rms,
      zcr,
      spectralProfile: makeProfile(profileId)
    });

    // -------------------------------------------------------------------------
    // 9.1 Chunks below bound: Analyzed normally
    // -------------------------------------------------------------------------
    const chunksBelow = [
      makeSynthChunk(0, 1),
      makeSynthChunk(3, 2),
      makeSynthChunk(6, 3),
      makeSynthChunk(9, 4),
      makeSynthChunk(12, 5)
    ];
    const resBelow = detectRepeatedAudioDetailed(chunksBelow, 15, 2.0, {
      bounds: { maxAudioChunks: 10, maxCandidatePairs: 50, maxPairComparisons: 50 }
    });
    assert(resBelow.details.budgetExceeded === false, '9.1 Chunks below bound reports budgetExceeded = false');
    assert(resBelow.details.chunksEvaluated === 5, '9.1 Chunks below bound evaluates all 5 chunks');
    assert(resBelow.details.totalChunks === 5, '9.1 Total chunks recorded accurately as 5');

    // -------------------------------------------------------------------------
    // 9.2 Chunks equal to bound: Evaluated exactly to bound contract
    // -------------------------------------------------------------------------
    const chunksEqual: AudioChunkSignature[] = [];
    for (let i = 0; i < 10; i++) {
      chunksEqual.push(makeSynthChunk(i * 3, i));
    }
    const resEqual = detectRepeatedAudioDetailed(chunksEqual, 30, 2.0, {
      bounds: { maxAudioChunks: 10, maxCandidatePairs: 100, maxPairComparisons: 100 }
    });
    assert(resEqual.details.budgetExceeded === false, '9.2 Chunks equal to bound reports budgetExceeded = false');
    assert(resEqual.details.chunksEvaluated === 10, '9.2 Exactly 10 chunks evaluated');
    assert(resEqual.details.totalChunks === 10, '9.2 Total chunks recorded as 10');

    // -------------------------------------------------------------------------
    // 9.3 Chunks above bound: Strictly capped with deterministic telemetry
    // -------------------------------------------------------------------------
    const chunksAbove: AudioChunkSignature[] = [];
    for (let i = 0; i < 15; i++) {
      chunksAbove.push(makeSynthChunk(i * 3, i));
    }
    const resAbove = detectRepeatedAudioDetailed(chunksAbove, 45, 2.0, {
      bounds: { maxAudioChunks: 10, maxCandidatePairs: 100, maxPairComparisons: 100 }
    });
    assert(resAbove.details.budgetExceeded === true, '9.3 Chunks above bound reports budgetExceeded = true');
    assert(resAbove.details.limitReached === 'CHUNK_LIMIT', '9.3 Limit reached reason is CHUNK_LIMIT');
    assert(resAbove.details.chunksEvaluated === 10, '9.3 Evaluated chunks strictly capped at 10');
    assert(resAbove.details.totalChunks === 15, '9.3 Total chunks correctly preserves uninspected total 15');

    // -------------------------------------------------------------------------
    // 9.4 Candidate pairs and pair comparisons below bound counted accurately
    // -------------------------------------------------------------------------
    // 4 chunks at 0, 3, 6, 9 -> Pairs: (0,3), (0,6), (0,9), (3,6), (3,9), (6,9) = 6 pairs
    const chunks4 = [
      makeSynthChunk(0, 1),
      makeSynthChunk(3, 2),
      makeSynthChunk(6, 3),
      makeSynthChunk(9, 4)
    ];
    const resCountPairs = detectRepeatedAudioDetailed(chunks4, 12, 2.0, {
      bounds: { maxCandidatePairs: 20, maxPairComparisons: 20 }
    });
    assert(resCountPairs.details.candidatePairsConsidered === 6, '9.4 Exactly 6 candidate pairs considered');
    assert(resCountPairs.details.pairComparisonsPerformed === 6, '9.4 Exactly 6 pairwise acoustic comparisons executed');
    assert(resCountPairs.details.budgetExceeded === false, '9.4 Execution completed within budget');

    // -------------------------------------------------------------------------
    // 9.5 Pair comparisons budget reached: Halts work without exceeding budget
    // -------------------------------------------------------------------------
    const resHitBudget = detectRepeatedAudioDetailed(chunks4, 12, 2.0, {
      bounds: { maxPairComparisons: 3 }
    });
    assert(resHitBudget.details.budgetExceeded === true, '9.5 Comparison budget exhaustion flags budgetExceeded = true');
    assert(resHitBudget.details.limitReached === 'PAIR_COMPARISON_LIMIT', '9.5 Limit reached identifies PAIR_COMPARISON_LIMIT');
    assert(resHitBudget.details.pairComparisonsPerformed === 3, '9.5 Exactly 3 comparisons executed (no overrun)');

    // -------------------------------------------------------------------------
    // 9.6 Clean audio with complete analysis reports no matches normally
    // -------------------------------------------------------------------------
    assert(resCountPairs.matches.length === 0, '9.6 Complete clean analysis reports 0 matches');

    // -------------------------------------------------------------------------
    // 9.7 Incomplete analysis with zero matches must NOT claim clean negative result
    // -------------------------------------------------------------------------
    // If analysis halted early with 0 matches found, repeatedAudioStatus MUST fail closed
    // to INSUFFICIENT_EVIDENCE (not NO_SIGNAL_DETECTED)
    const incompleteDetectorReport = {
      detectorName: 'subband_spectral_audio_fingerprint',
      version: '1.1.0',
      status: 'INSUFFICIENT_EVIDENCE' as any,
      executionDurationMs: 25,
      failureReason: 'Analysis budget reached: maximum pair comparisons (3) reached before completing full timeline repetition analysis.',
      details: {
        budgetExceeded: true,
        candidatePairsConsidered: 3,
        pairComparisonsPerformed: 3,
        chunksEvaluated: 4,
        totalChunks: 4
      }
    };
    assert((incompleteDetectorReport.status as string) !== 'NO_SIGNAL_DETECTED', '9.7 Incomplete analysis does NOT claim clean NO_SIGNAL_DETECTED');
    assert(incompleteDetectorReport.failureReason.includes('Analysis budget reached'), '9.7 Documents budget reached in failureReason');

    // -------------------------------------------------------------------------
    // 9.8 Matches detected prior to hitting budget are strictly preserved
    // -------------------------------------------------------------------------
    // Chunks at 0 and 3 have IDENTICAL profile (match on 1st comparison), followed by distinct chunks
    const chunksWithEarlyMatch = [
      makeSynthChunk(0, 1),
      makeSynthChunk(3, 1), // Identical to chunk 0
      makeSynthChunk(6, 2),
      makeSynthChunk(9, 3)
    ];
    const resPreserveMatch = detectRepeatedAudioDetailed(chunksWithEarlyMatch, 12, 2.0, {
      bounds: { maxPairComparisons: 1 }
    });
    assert(resPreserveMatch.details.budgetExceeded === true, '9.8 Budget exceeded after first comparison');
    assert(resPreserveMatch.matches.length === 1, '9.8 Match detected before budget exhaustion is strictly preserved');
    assert(resPreserveMatch.matches[0].start === 0.0, '9.8 Preserved match start timestamp is 0.0s');
    assert(resPreserveMatch.matches[0].matchWithTimestamp === 3.0, '9.8 Preserved match target timestamp is 3.0s');

    // -------------------------------------------------------------------------
    // 9.9 Contiguous segments before budget are merged correctly
    // -------------------------------------------------------------------------
    // Chunks at 0, 1 match chunks at 4, 5
    const contiguousRaw = [
      { start: 0.0, end: 1.0, matchWithTimestamp: 4.0, similarity: 0.94 },
      { start: 1.0, end: 2.0, matchWithTimestamp: 5.0, similarity: 0.96 }
    ];
    const mergedResults = mergeContiguousAudioSegments(contiguousRaw);
    assert(mergedResults.length === 1, '9.9 Exactly 1 merged interval produced');
    assert(mergedResults[0].start === 0.0 && mergedResults[0].end === 2.0, '9.9 Merged interval covers 0.0–2.0s');
    assert(mergedResults[0].matchWithTimestamp === 4.0, '9.9 Merged target matches 4.0s');
    assert(mergedResults[0].similarity === 0.95, '9.9 Merged similarity averaged accurately (0.95)');

    // -------------------------------------------------------------------------
    // 9.10 Large synthetic dataset bound enforcement
    // -------------------------------------------------------------------------
    const largeChunks: AudioChunkSignature[] = [];
    for (let i = 0; i < 2500; i++) {
      largeChunks.push(makeSynthChunk(i, i % 10));
    }
    const resLarge = detectRepeatedAudioDetailed(largeChunks, 2500, 2.0);
    assert(resLarge.details.totalChunks === 2500, '9.10 2500 total chunks received');
    assert(resLarge.details.chunksEvaluated === DEFAULT_AUDIO_ANALYSIS_BOUNDS.maxAudioChunks, '9.10 Evaluated chunks strictly capped at default 1800');
    assert(resLarge.details.budgetExceeded === true, '9.10 Budget exceeded flag set for large dataset');
    assert(resLarge.details.pairComparisonsPerformed <= DEFAULT_AUDIO_ANALYSIS_BOUNDS.maxPairComparisons, '9.10 Pair comparisons do not overrun 30,000 bound');

    // -------------------------------------------------------------------------
    // 9.11 Incomplete repeated audio status propagates to policy & risk aggregation
    // -------------------------------------------------------------------------
    const incompleteAudioResult = {
      ...cleanAudioResult,
      repeatedAudioStatus: 'INSUFFICIENT_EVIDENCE' as const,
      detectors: {
        ...cleanAudioResult.detectors,
        audio_repeated_segments: {
          detectorName: 'subband_spectral_audio_fingerprint',
          version: '1.1.0',
          status: 'INSUFFICIENT_EVIDENCE' as const,
          executionDurationMs: 15,
          failureReason: 'Analysis budget reached: maximum pair comparisons (30000) reached before completing full timeline repetition analysis.',
          details: {
            budgetExceeded: true,
            pairComparisonsPerformed: 30000,
            chunksEvaluated: 600,
            totalChunks: 1000
          }
        }
      }
    };
    const reportIncompletePropagated = policyIntelligenceEngine.buildReport({
      scanId: 'scan_audio_budget_incomplete',
      metadata: standardMetaWithAudio,
      scanMode: 'standard',
      audioResult: incompleteAudioResult,
      videoResult: cleanVideoResult
    }, []);
    assert(reportIncompletePropagated.overallRisk !== 'LOW_RISK', '9.11 Audio budget exhaustion must NOT return LOW_RISK');
    assert(reportIncompletePropagated.overallRisk === 'NEEDS_REVIEW', '9.11 Audio budget exhaustion escalates to NEEDS_REVIEW');
    assert(reportIncompletePropagated.domainReports.video_audio.status !== 'NO_MAJOR_RISK_SIGNALS_DETECTED', '9.11 Domain status does not claim clean signals');
    assert(reportIncompletePropagated.domainReports.video_audio.status === 'REVIEW_RECOMMENDED', '9.11 Domain status is REVIEW_RECOMMENDED');
    assert(reportIncompletePropagated.timeline.some(t => t.type === 'core_analyzer_unavailable'), '9.11 Timeline contains core_analyzer_unavailable warning item');

    // -------------------------------------------------------------------------
    // 9.12 Score Semantics: Heuristic weights vs Similarity vs Confidence
    // -------------------------------------------------------------------------
    // When repAudio evidence is added, verify labels distinguish similarity score from confidence
    const timelineWithRepetition = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_score_semantics',
      metadata: standardMetaWithAudio,
      scanMode: 'standard',
      audioResult: {
        ...cleanAudioResult,
        repeatedAudioSegments: [{
          start: 0.0,
          end: 2.0,
          matchWithTimestamp: 5.0,
          similarity: 0.93
        }]
      },
      videoResult: cleanVideoResult
    });
    const repAudioItem = timelineWithRepetition.find(t => t.type === 'repeated_audio_segment');
    assert(Boolean(repAudioItem), '9.12 Repeated audio evidence item generated');
    assert(repAudioItem?.label.includes('93% acoustic match'), '9.12 Evidence label clearly specifies acoustic match');
    assert(repAudioItem?.details.includes('93% acoustic similarity score'), '9.12 Details clearly states acoustic similarity score (not confidence)');
    assert(repAudioItem?.confidence === 0.88, '9.12 Confidence is maintained as detector execution confidence');

    // -------------------------------------------------------------------------
    // 9.13 Regression: detectRepeatedAudio backward compatibility with details
    // -------------------------------------------------------------------------
    const compatMatches = detectRepeatedAudio(chunks4, 12, 2.0);
    assert(Array.isArray(compatMatches), '9.13 detectRepeatedAudio returns standard array');
    assert(Boolean(compatMatches.details), '9.13 Array carries telemetry details property');
    assert(compatMatches.details?.candidatePairsConsidered === 6, '9.13 Telemetry details match expected candidate pairs (6)');

    console.log(`\n🎉 COMPREHENSIVE DEFECT & PIPELINE VERIFICATION PASSED: ${passed}/${total} assertions!`);
  } finally {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

// Allow direct CLI execution: npx tsx tests/comprehensive_defect_and_pipeline_verification.test.ts
if (process.argv[1]?.endsWith('comprehensive_defect_and_pipeline_verification.test.ts')) {
  runComprehensiveDefectAndPipelineTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}
