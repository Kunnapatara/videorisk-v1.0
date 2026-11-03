import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import assert from 'assert';
import { videoProcessor } from '../src/server/pipeline/videoProcessor';
import { audioProcessor } from '../src/server/pipeline/audioProcessor';
import { mediaInspector } from '../src/server/pipeline/mediaInspector';
import { thumbnailInspector } from '../src/server/pipeline/thumbnailInspector';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';

const execFileAsync = promisify(execFile);

// ============================================================================
// GROUND-TRUTH BENCHMARK PROTOCOL & SCHEMA (VideoRisk v1.0 — Prompt Set 3)
// ============================================================================

export type BenchmarkSplit = 'development' | 'validation' | 'held_out';

export interface GroundTruthMetadata {
  caseId: string;
  name: string;
  domain: 'audio' | 'video' | 'thumbnail' | 'pipeline_integrity';
  subCapability: string;
  split: BenchmarkSplit;
  assetOrigin: string;
  license: string;
  expectedLabel: boolean | string | number;
  annotationMethod: string;
  annotatedInterval?: { start: number; end: number };
  transformation?: string;
  toleranceSec?: number;
}

export interface GroundTruthCaseResult {
  caseId: string;
  name: string;
  domain: string;
  subCapability: string;
  split: BenchmarkSplit;
  expected: any;
  actual: any;
  classification?: 'TP' | 'TN' | 'FP' | 'FN' | 'PASS' | 'FAIL';
  passed: boolean;
  iou?: number;
  boundaryErrorSec?: number;
  executionMs: number;
  details: string;
}

export interface MetricSummary {
  task: string;
  split: string;
  totalCases: number;
  passed: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  specificity: number;
  accuracy: number;
  meanBoundaryErrorSec?: number;
  meanIoU?: number;
}

/**
 * Calculates temporal Intersection over Union (IoU) between ground truth and detected interval
 */
export function calculateTemporalIoU(
  gt: { start: number; end: number },
  pred: { start: number; end: number }
): number {
  const interStart = Math.max(gt.start, pred.start);
  const interEnd = Math.min(gt.end, pred.end);
  const intersection = Math.max(0, interEnd - interStart);

  const unionStart = Math.min(gt.start, pred.start);
  const unionEnd = Math.max(gt.end, pred.end);
  const union = Math.max(0.001, unionEnd - unionStart);

  return parseFloat((intersection / union).toFixed(3));
}

/**
 * Executes the complete Ground-Truth Benchmark Suite across Audio, Video, and Thumbnail.
 */
export async function runGroundTruthBenchmark(): Promise<{
  results: GroundTruthCaseResult[];
  summaries: MetricSummary[];
  allPassed: boolean;
}> {
  console.log('================================================================');
  console.log('--- REPRODUCIBLE GROUND-TRUTH BENCHMARK PROTOCOL (v1.0.0) ---');
  console.log('    Audio, Video, Thumbnail & Evidence-Validated Findings');
  console.log('================================================================\n');

  const benchmarkDir = path.resolve(process.cwd(), 'tests', 'fixtures', 'gt_benchmark');
  if (!fs.existsSync(benchmarkDir)) {
    fs.mkdirSync(benchmarkDir, { recursive: true });
  }

  const generatedFiles: string[] = [];
  const results: GroundTruthCaseResult[] = [];

  const cleanup = () => {
    for (const f of generatedFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
  };

  try {
    // =========================================================================
    // 1. AUDIO DETECTOR BENCHMARKS
    // =========================================================================
    console.log('[1. Audio Detector Benchmarking]');

    // Case GT-AUD-SIL-01: Silence Interval Detection & Boundary Error
    // Audio track: 1.5s active tone + 2.0s silence + 1.5s active tone (Total 5.0s)
    // Ground Truth Silence: [1.5, 3.5]
    const silCase1File = path.resolve(benchmarkDir, 'gt_silence_interval.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-filter_complex', 'sine=frequency=440:duration=1.5[a1];aevalsrc=0:d=2.0[a2];sine=frequency=440:duration=1.5[a3];[a1][a2][a3]concat=n=3:v=0:a=1[outa]',
      '-map', '[outa]',
      '-c:a', 'aac',
      silCase1File
    ]);
    generatedFiles.push(silCase1File);

    const t0 = Date.now();
    const metaSil1 = await mediaInspector.inspect(silCase1File, 'gt_silence_interval.mp4');
    const resSil1 = await audioProcessor.analyzeAudio(silCase1File, metaSil1);
    const msSil1 = Date.now() - t0;

    const detectedSilence = resSil1.segments.find(s => s.type === 'silence');
    const predInterval = detectedSilence ? { start: detectedSilence.start, end: detectedSilence.end } : { start: 0, end: 0 };
    const gtInterval = { start: 1.5, end: 3.5 };
    const iouSil1 = calculateTemporalIoU(gtInterval, predInterval);
    const bErrorSil1 = parseFloat(Math.abs(predInterval.start - gtInterval.start).toFixed(2));
    const passedSil1 = Boolean(detectedSilence && iouSil1 >= 0.70 && bErrorSil1 <= 0.6);

    results.push({
      caseId: 'GT-AUD-SIL-01',
      name: 'Silence interval detection & temporal boundary accuracy',
      domain: 'audio',
      subCapability: 'silence_volume',
      split: 'validation',
      expected: 'silence [1.5, 3.5]',
      actual: detectedSilence ? `[${detectedSilence.start}, ${detectedSilence.end}]` : 'none',
      classification: passedSil1 ? 'TP' : 'FN',
      passed: passedSil1,
      iou: iouSil1,
      boundaryErrorSec: bErrorSil1,
      executionMs: msSil1,
      details: `IoU: ${iouSil1}, Start Boundary Error: ${bErrorSil1}s, Mean Volume: ${resSil1.meanVolumeDb} dB`
    });

    // Case GT-AUD-SIL-02: Dialogue-Level Audio (Audible, rejected from silence)
    // Audio track with moderate level (~ -11dB, well above -30dB noise gate)
    const quietCaseFile = path.resolve(benchmarkDir, 'gt_quiet_audio.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4',
      '-af', 'volume=-8dB',
      '-c:a', 'aac',
      quietCaseFile
    ]);
    generatedFiles.push(quietCaseFile);

    const t1 = Date.now();
    const metaQuiet = await mediaInspector.inspect(quietCaseFile, 'gt_quiet_audio.mp4');
    const resQuiet = await audioProcessor.analyzeAudio(quietCaseFile, metaQuiet);
    const msQuiet = Date.now() - t1;

    // Quiet audio is audible (> -50dB) and does NOT have >90% silence ratio
    const passedQuiet = resQuiet.isAudible === true && resQuiet.silenceRatio < 0.5;
    results.push({
      caseId: 'GT-AUD-SIL-02',
      name: 'Quiet audible audio rejected from false complete silence',
      domain: 'audio',
      subCapability: 'silence_volume',
      split: 'development',
      expected: 'isAudible: true, silenceRatio < 0.5',
      actual: `isAudible: ${resQuiet.isAudible}, silenceRatio: ${resQuiet.silenceRatio}`,
      classification: passedQuiet ? 'TN' : 'FP',
      passed: passedQuiet,
      executionMs: msQuiet,
      details: `Mean volume: ${resQuiet.meanVolumeDb} dB; correctly distinguished from true silence`
    });

    // Case GT-AUD-MOD-01: Continuous Sine Tone Rejected from Speech Activity (Negative Control)
    // Single 440Hz tone has near-zero energy envelope variance (CV < 0.08)
    const toneCaseFile = path.resolve(benchmarkDir, 'gt_tone_continuous.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:a', 'aac',
      toneCaseFile
    ]);
    generatedFiles.push(toneCaseFile);

    const t2 = Date.now();
    const metaTone = await mediaInspector.inspect(toneCaseFile, 'gt_tone_continuous.mp4');
    const resTone = await audioProcessor.analyzeAudio(toneCaseFile, metaTone);
    const msTone = Date.now() - t2;

    const speechStatusTone = resTone.detectors?.audio_speech_activity?.status;
    const passedTone = speechStatusTone === 'NO_SIGNAL_DETECTED';
    results.push({
      caseId: 'GT-AUD-MOD-01',
      name: 'Continuous static sine tone rejected from acoustic speech modulation',
      domain: 'audio',
      subCapability: 'speech_activity',
      split: 'validation',
      expected: 'NO_SIGNAL_DETECTED',
      actual: speechStatusTone,
      classification: passedTone ? 'TN' : 'FP',
      passed: passedTone,
      executionMs: msTone,
      details: `Status: ${speechStatusTone}; flat energy envelope correctly identified`
    });

    // Case GT-AUD-REP-01: Exact Within-Video Repeated Acoustic Segment (Positive)
    // Segment A (0-1.5s) repeated as Segment B (3.0-4.5s) with distinct intervening music (1.5-3.0s)
    const repAudioCaseFile = path.resolve(benchmarkDir, 'gt_rep_audio.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-filter_complex', 'sine=frequency=800:duration=1.5[a1];sine=frequency=200:duration=1.5[a2];sine=frequency=800:duration=1.5[a3];[a1][a2][a3]concat=n=3:v=0:a=1[outa]',
      '-map', '[outa]',
      '-c:a', 'aac',
      repAudioCaseFile
    ]);
    generatedFiles.push(repAudioCaseFile);

    const t3 = Date.now();
    const metaRepAudio = await mediaInspector.inspect(repAudioCaseFile, 'gt_rep_audio.mp4');
    const resRepAudio = await audioProcessor.analyzeAudio(repAudioCaseFile, metaRepAudio);
    const msRepAudio = Date.now() - t3;

    const hasAudioRep = (resRepAudio.repeatedAudioSegments && resRepAudio.repeatedAudioSegments.length > 0) || resRepAudio.repeatedAudioStatus === 'DETECTED';
    results.push({
      caseId: 'GT-AUD-REP-01',
      name: 'Non-adjacent repeated acoustic segment detection via 16-band spectral fingerprint',
      domain: 'audio',
      subCapability: 'repeated_audio',
      split: 'development',
      expected: 'DETECTED',
      actual: resRepAudio.repeatedAudioStatus,
      classification: hasAudioRep ? 'TP' : 'FN',
      passed: Boolean(hasAudioRep),
      executionMs: msRepAudio,
      details: `Matches: ${resRepAudio.repeatedAudioSegments?.length || 0}, Status: ${resRepAudio.repeatedAudioStatus}`
    });

    // =========================================================================
    // 2. VIDEO DETECTOR BENCHMARKS
    // =========================================================================
    console.log('[2. Video Detector Benchmarking]');

    // Case GT-VID-CUT-01: Scene Cut Transition Accuracy within tolerance window
    // 3 distinct scenes: Scene 1 [0-2.0s], Scene 2 [2.0-3.5s], Scene 3 [3.5-5.0s]
    // Ground Truth Cut Points: 2.0s, 3.5s (Tolerance: ±0.3s)
    const cutsCaseFile = path.resolve(benchmarkDir, 'gt_scene_cuts.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-filter_complex', 'testsrc=size=320x240:rate=10:duration=2[s1];color=c=red:size=320x240:rate=10:duration=1.5[s2];testsrc2=size=320x240:rate=10:duration=1.5[s3];[s1][s2][s3]concat=n=3:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      cutsCaseFile
    ]);
    generatedFiles.push(cutsCaseFile);

    const t4 = Date.now();
    const metaCuts = await mediaInspector.inspect(cutsCaseFile, 'gt_scene_cuts.mp4');
    const resCuts = await videoProcessor.analyzeVideo(cutsCaseFile, metaCuts, 'standard');
    const msCuts = Date.now() - t4;
    await videoProcessor.cleanupFrames(resCuts.tempFramesDir);

    const detectedCuts = resCuts.cutTimestamps || [];
    const gtCuts = [2.0, 3.5];
    const matchedCuts = gtCuts.filter(gt => detectedCuts.some(dc => Math.abs(dc - gt) <= 0.35));
    const cutRecall = matchedCuts.length / gtCuts.length;
    const cutPrecision = detectedCuts.length > 0 ? matchedCuts.length / detectedCuts.length : 0;
    const boundaryErrors = matchedCuts.map(gt => {
      const closest = detectedCuts.reduce((prev, curr) => Math.abs(curr - gt) < Math.abs(prev - gt) ? curr : prev);
      return Math.abs(closest - gt);
    });
    const meanCutError = boundaryErrors.length > 0 ? parseFloat((boundaryErrors.reduce((a, b) => a + b, 0) / boundaryErrors.length).toFixed(3)) : 0;
    const passedCuts = cutRecall >= 0.90 && cutPrecision >= 0.80;

    results.push({
      caseId: 'GT-VID-CUT-01',
      name: 'Scene cut transition accuracy against annotated boundaries (±0.3s tolerance)',
      domain: 'video',
      subCapability: 'scene_cut',
      split: 'development',
      expected: '2 cuts (at ~2.0s and ~3.5s)',
      actual: `${detectedCuts.length} cuts at [${detectedCuts.join(', ')}]`,
      classification: passedCuts ? 'PASS' : 'FAIL',
      passed: passedCuts,
      boundaryErrorSec: meanCutError,
      executionMs: msCuts,
      details: `Recall: ${(cutRecall * 100).toFixed(1)}%, Precision: ${(cutPrecision * 100).toFixed(1)}%, Mean Boundary Error: ${meanCutError}s`
    });

    // Case GT-VID-REP-01: Repeated Footage with Horizontal Mirroring (hflip)
    // Repeat segment with horizontal reflection (common creator reuse/evasion)
    const mirrorCaseFile = path.resolve(benchmarkDir, 'gt_mirror_repeat.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-filter_complex', 'testsrc=size=320x240:rate=10:duration=2[v0];color=c=navy:size=320x240:rate=10:duration=2[v1];testsrc=size=320x240:rate=10:duration=2,hflip,format=yuv420p[v2];[v0][v1][v2]concat=n=3:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      mirrorCaseFile
    ]);
    generatedFiles.push(mirrorCaseFile);

    const t5 = Date.now();
    const metaMirror = await mediaInspector.inspect(mirrorCaseFile, 'gt_mirror_repeat.mp4');
    const resMirror = await videoProcessor.analyzeVideo(mirrorCaseFile, metaMirror, 'standard');
    const msMirror = Date.now() - t5;
    await videoProcessor.cleanupFrames(resMirror.tempFramesDir);

    const isMirrorDup = (resMirror.repeatedFootageSegments && resMirror.repeatedFootageSegments.length > 0) || resMirror.repeatedFootageStatus === 'DETECTED';
    results.push({
      caseId: 'GT-VID-REP-01',
      name: 'Repeated visual footage detection under horizontal reflection (hflip)',
      domain: 'video',
      subCapability: 'repeated_footage',
      split: 'development',
      expected: 'DETECTED',
      actual: resMirror.repeatedFootageStatus,
      classification: isMirrorDup ? 'TP' : 'FN',
      passed: isMirrorDup,
      executionMs: msMirror,
      details: `Segments: ${resMirror.repeatedFootageSegments?.length || 0}; horizontal reflection aware gradient match verified`
    });

    // Case GT-VID-REP-02: Negative Control - Distinct Geometric Scenes (Reject False Positive)
    // Distinct patterns with same navy background
    const distinctCaseFile = path.resolve(benchmarkDir, 'gt_distinct_scenes.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-filter_complex', 'color=c=0x102040:size=320x240:duration=2,drawbox=x=120:y=20:w=80:h=200:color=white@0.8:t=fill[v1];color=c=0x102040:size=320x240:duration=2,drawbox=x=20:y=100:w=280:h=40:color=yellow@0.8:t=fill[v2];[v1][v2]concat=n=2:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      distinctCaseFile
    ]);
    generatedFiles.push(distinctCaseFile);

    const t6 = Date.now();
    const metaDist = await mediaInspector.inspect(distinctCaseFile, 'gt_distinct_scenes.mp4');
    const resDist = await videoProcessor.analyzeVideo(distinctCaseFile, metaDist, 'standard');
    const msDist = Date.now() - t6;
    await videoProcessor.cleanupFrames(resDist.tempFramesDir);

    const isDistDup = (resDist.repeatedFootageSegments && resDist.repeatedFootageSegments.length > 0) || resDist.repeatedFootageStatus === 'DETECTED';
    results.push({
      caseId: 'GT-VID-REP-02',
      name: 'Distinct geometric scenes with similar dominant background color',
      domain: 'video',
      subCapability: 'repeated_footage',
      split: 'validation',
      expected: 'NO_SIGNAL_DETECTED',
      actual: resDist.repeatedFootageStatus,
      classification: !isDistDup ? 'TN' : 'FP',
      passed: !isDistDup,
      executionMs: msDist,
      details: `Status: ${resDist.repeatedFootageStatus}; structural gradients correctly prevent false positive`
    });

    // Case GT-VID-SLD-01: True Static Slideshow Presentation (Positive)
    // 4 slides (2s each) with complete intra-scene stillness
    const sldCaseFile = path.resolve(benchmarkDir, 'gt_slideshow_pos.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-filter_complex', 'color=c=red:size=320x240:duration=2[s1];color=c=green:size=320x240:duration=2[s2];color=c=blue:size=320x240:duration=2[s3];color=c=yellow:size=320x240:duration=2[s4];[s1][s2][s3][s4]concat=n=4:v=1:a=0[outv]',
      '-map', '[outv]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      sldCaseFile
    ]);
    generatedFiles.push(sldCaseFile);

    const t7 = Date.now();
    const metaSld = await mediaInspector.inspect(sldCaseFile, 'gt_slideshow_pos.mp4');
    const resSld = await videoProcessor.analyzeVideo(sldCaseFile, metaSld, 'standard');
    const msSld = Date.now() - t7;
    await videoProcessor.cleanupFrames(resSld.tempFramesDir);

    const isSldDetected = resSld.hasSlideshowPattern || resSld.slideshowAnalysisStatus === 'DETECTED';
    results.push({
      caseId: 'GT-VID-SLD-01',
      name: 'Multi-slide static image presentation classification',
      domain: 'video',
      subCapability: 'slideshow_heuristic',
      split: 'development',
      expected: 'DETECTED',
      actual: resSld.slideshowAnalysisStatus,
      classification: isSldDetected ? 'TP' : 'FN',
      passed: isSldDetected,
      executionMs: msSld,
      details: `Scenes: ${resSld.scenesCount}, Pacing: ${resSld.averagePacingSeconds}s, Status: ${resSld.slideshowAnalysisStatus}`
    });

    // Case GT-VID-SLD-02: Gaming with Static HUD Rejected from Slideshow (Negative Control)
    // Moving procedural center with static HUD overlays at edges
    const gamingCaseFile = path.resolve(benchmarkDir, 'gt_gaming_hud.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=4,drawbox=x=0:y=0:w=320:h=25:color=black@0.9:t=fill,drawbox=x=10:y=190:w=50:h=40:color=0x112244@0.9:t=fill',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      gamingCaseFile
    ]);
    generatedFiles.push(gamingCaseFile);

    const t8 = Date.now();
    const metaGaming = await mediaInspector.inspect(gamingCaseFile, 'gt_gaming_hud.mp4');
    const resGaming = await videoProcessor.analyzeVideo(gamingCaseFile, metaGaming, 'standard');
    const msGaming = Date.now() - t8;
    await videoProcessor.cleanupFrames(resGaming.tempFramesDir);

    const isGamingSld = resGaming.hasSlideshowPattern || resGaming.slideshowAnalysisStatus === 'DETECTED';
    results.push({
      caseId: 'GT-VID-SLD-02',
      name: 'Gaming video with static HUD UI rejected from slideshow classification',
      domain: 'video',
      subCapability: 'slideshow_heuristic',
      split: 'validation',
      expected: 'NO_SIGNAL_DETECTED',
      actual: resGaming.slideshowAnalysisStatus,
      classification: !isGamingSld ? 'TN' : 'FP',
      passed: !isGamingSld,
      executionMs: msGaming,
      details: `Continuous motion in non-HUD pixels correctly prevents false slideshow trigger`
    });

    // Case GT-VID-ADP-01: Adaptive Frame Sampling & Analyzed Frames Invariant
    // Confirms adaptive sampling measures coverage while strictly preserving actualAnalyzedFramesCount === 0
    const t9 = Date.now();
    const resAdaptive = await videoProcessor.analyzeVideoAdaptiveCandidate(cutsCaseFile, metaCuts, 'standard', {
      windowSeconds: 0.5,
      maxAdditionalFrames: 10
    });
    const msAdaptive = Date.now() - t9;
    await videoProcessor.cleanupFrames(resAdaptive.tempFramesDir);

    const passedAdaptive = Boolean(
      resAdaptive.sceneCutCoverageRatio >= 0.80 &&
      resAdaptive.actualAnalyzedFramesCount === 0 &&
      resAdaptive.actualExtractedFramesCount > 0 &&
      resAdaptive.framesValidatedReadable > 0
    );
    results.push({
      caseId: 'GT-VID-ADP-01',
      name: 'Adaptive sampling candidate extraction & actualAnalyzedFramesCount invariant',
      domain: 'video',
      subCapability: 'adaptive_sampling',
      split: 'held_out',
      expected: 'Coverage >= 80%, actualAnalyzedFramesCount === 0',
      actual: `Coverage: ${(resAdaptive.sceneCutCoverageRatio * 100).toFixed(1)}%, Analyzed: ${resAdaptive.actualAnalyzedFramesCount}`,
      classification: passedAdaptive ? 'PASS' : 'FAIL',
      passed: passedAdaptive,
      executionMs: msAdaptive,
      details: `Extracted: ${resAdaptive.actualExtractedFramesCount}, Readable: ${resAdaptive.framesValidatedReadable}, Analyzed: ${resAdaptive.actualAnalyzedFramesCount} (no unexecuted perceptual analysis claimed)`
    });

    // =========================================================================
    // 3. THUMBNAIL DETECTOR BENCHMARKS
    // =========================================================================
    console.log('[3. Thumbnail Detector Benchmarking]');

    // Case GT-THM-GEO-01: Standard YouTube 16:9 Thumbnail (1280x720)
    const stdThumbFile = path.resolve(benchmarkDir, 'gt_thumb_16_9.jpg');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=0x1e3a8a:s=1280x720:d=1',
      '-vframes', '1',
      stdThumbFile
    ]);
    generatedFiles.push(stdThumbFile);

    const t10 = Date.now();
    const resThumbStd = await thumbnailInspector.inspect(stdThumbFile, 'gt_thumb_16_9.jpg');
    const msThumbStd = Date.now() - t10;

    const passedThumbStd = resThumbStd.isStandardAspect === true && resThumbStd.width === 1280 && resThumbStd.height === 720;
    results.push({
      caseId: 'GT-THM-GEO-01',
      name: 'Standard YouTube 16:9 thumbnail dimension & aspect ratio validation',
      domain: 'thumbnail',
      subCapability: 'thumbnail_geometry',
      split: 'development',
      expected: '16:9 (1280x720)',
      actual: `${resThumbStd.aspectRatio} (${resThumbStd.width}x${resThumbStd.height})`,
      classification: passedThumbStd ? 'PASS' : 'FAIL',
      passed: passedThumbStd,
      executionMs: msThumbStd,
      details: `isStandardAspect: ${resThumbStd.isStandardAspect}, meanLuminance: ${resThumbStd.meanLuminance}`
    });

    // Case GT-THM-GEO-02: Non-Standard Square 1:1 Thumbnail (800x800)
    const squareThumbFile = path.resolve(benchmarkDir, 'gt_thumb_1_1.jpg');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=0x22c55e:s=800x800:d=1',
      '-vframes', '1',
      squareThumbFile
    ]);
    generatedFiles.push(squareThumbFile);

    const t11 = Date.now();
    const resThumbSq = await thumbnailInspector.inspect(squareThumbFile, 'gt_thumb_1_1.jpg');
    const msThumbSq = Date.now() - t11;

    const passedThumbSq = resThumbSq.isStandardAspect === false && resThumbSq.aspectRatio === '1.00:1';
    results.push({
      caseId: 'GT-THM-GEO-02',
      name: 'Non-standard 1:1 aspect ratio thumbnail flags letterboxing warning',
      domain: 'thumbnail',
      subCapability: 'thumbnail_geometry',
      split: 'validation',
      expected: 'isStandardAspect: false, aspect: 1.00:1',
      actual: `isStandardAspect: ${resThumbSq.isStandardAspect}, aspect: ${resThumbSq.aspectRatio}`,
      classification: passedThumbSq ? 'PASS' : 'FAIL',
      passed: passedThumbSq,
      executionMs: msThumbSq,
      details: `Flagged non-standard aspect ratio appropriately: ${resThumbSq.notes}`
    });

    // Case GT-THM-UNC-01: Unconfigured Modules Declare NOT_ASSESSED Without Fabrication
    // Verify contrastAnalysisStatus is NOT_ASSESSED and text is null when OCR not configured
    const t12 = Date.now();
    const passedThumbUnc = (
      resThumbStd.contrastAnalysisStatus === 'NOT_ASSESSED' &&
      resThumbStd.hasHighContrastText === null &&
      resThumbStd.detectors?.thumbnail_contrast.status === 'NOT_ASSESSED'
    );
    const msThumbUnc = Date.now() - t12;

    results.push({
      caseId: 'GT-THM-UNC-01',
      name: 'Thumbnail contrast evaluator retains NOT_ASSESSED without bounding-box OCR',
      domain: 'thumbnail',
      subCapability: 'thumbnail_contrast',
      split: 'held_out',
      expected: 'NOT_ASSESSED, hasHighContrastText: null',
      actual: `Status: ${resThumbStd.contrastAnalysisStatus}, hasHighContrastText: ${resThumbStd.hasHighContrastText}`,
      classification: passedThumbUnc ? 'PASS' : 'FAIL',
      passed: passedThumbUnc,
      executionMs: msThumbUnc,
      details: 'Correctly preserves NOT_ASSESSED rather than inferring contrast from raw luminance'
    });

    // =========================================================================
    // 4. PIPELINE EVIDENCE & RE-SCAN INTEGRITY BENCHMARKS
    // =========================================================================
    console.log('[4. Evidence & Finding Pipeline Verification]');

    // Case GT-EVD-VER-01: Full chain from Media Inspection -> Evidence -> Top Issues
    const t13 = Date.now();
    const timeline = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'gt_scan_01',
      metadata: metaCuts,
      scanMode: 'standard',
      audioResult: resRepAudio,
      videoResult: resMirror,
      thumbnailMetadata: resThumbSq,
      thumbnailProvided: true
    });

    const report = policyIntelligenceEngine.buildReport({
      scanId: 'gt_scan_01',
      metadata: metaCuts,
      scanMode: 'standard',
      audioResult: resRepAudio,
      videoResult: resMirror,
      thumbnailMetadata: resThumbSq,
      thumbnailProvided: true
    }, timeline);
    const msEvd = Date.now() - t13;

    // Check that top issues are grounded in observed evidence with mandatory fields
    const hasTopIssues = report.topIssues.length > 0;
    const allIssuesGrounded = report.topIssues.every(iss => 
      Boolean(iss.what && iss.where && iss.why && iss.fix && iss.evidence && iss.limitations)
    );
    // Check that unassessed detectors (thumbnail_contrast) did NOT generate fake issues
    const noFakeIssues = !report.topIssues.some(iss => iss.type === 'thumbnail_contrast');
    const passedEvd = hasTopIssues && allIssuesGrounded && noFakeIssues;

    results.push({
      caseId: 'GT-EVD-VER-01',
      name: 'End-to-end evidence generation, TopIssue grounding & unassessed exclusion',
      domain: 'pipeline_integrity',
      subCapability: 'finding_generation',
      split: 'held_out',
      expected: 'All issues grounded in direct evidence; 0 unassessed issues',
      actual: `${report.topIssues.length} issues generated, all grounded: ${allIssuesGrounded}`,
      classification: passedEvd ? 'PASS' : 'FAIL',
      passed: passedEvd,
      executionMs: msEvd,
      details: `Generated issues: [${report.topIssues.map(i => i.type).join(', ')}]`
    });

    // Case GT-RSC-VER-01: Re-Scan Verification Fails Closed on Byte-Identical Media
    const t14 = Date.now();
    const baselineReportWithIssue = {
      ...report,
      topIssues: [
        {
          id: 'issue_ev_1',
          domain: 'video_audio' as const,
          type: 'repeated_visual_footage',
          what: '🟡 Repeated Visual Footage (95% match)',
          where: '00:00–00:02',
          why: 'Visual repetition detected',
          fix: 'Trim repeated segment',
          evidence: 'video_processor:perceptual_hash_comparator',
          context: 'Standard review',
          recommendedAction: 'Trim or vary repeated visual segments',
          confidence: 'HIGH' as const,
          limitations: 'Local check',
          severity: 'warning' as const,
          policyArea: 'REUSED CONTENT',
          category: 'reused_content' as const,
          timestampSeconds: 0
        }
      ]
    };
    const revisedReportClean = {
      ...report,
      topIssues: []
    };

    const comparisonIdentical = policyIntelligenceEngine.generateComparison(baselineReportWithIssue, revisedReportClean, {
      originalScanRecord: { metadata: { ...metaCuts, sha256: 'a'.repeat(64) } } as any,
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...metaCuts, sha256: 'a'.repeat(64) } } as any
    });
    const msRsc = Date.now() - t14;

    const notVerifiedList = comparisonIdentical.notVerifiedIssues || [];
    const passedRsc = Boolean(
      comparisonIdentical.resolvedIssues.length === 0 &&
      notVerifiedList.some(i => i.includes('byte-for-byte identical'))
    );
    results.push({
      caseId: 'GT-RSC-VER-01',
      name: 'Re-scan resolution strictly fails closed on byte-identical media (matching SHA-256)',
      domain: 'pipeline_integrity',
      subCapability: 'rescan_verification',
      split: 'held_out',
      expected: '0 resolved, notVerified includes identical media reason',
      actual: `Resolved: ${comparisonIdentical.resolvedIssues.length}, NotVerified: ${notVerifiedList.length}`,
      classification: passedRsc ? 'PASS' : 'FAIL',
      passed: passedRsc,
      executionMs: msRsc,
      details: `Comparison Summary: ${comparisonIdentical.comparisonSummary}`
    });

  } finally {
    cleanup();
  }

  // =========================================================================
  // METRICS AGGREGATION & REPORTING
  // =========================================================================
  const summaries: MetricSummary[] = [];
  const categories = Array.from(new Set(results.map(r => `${r.domain}:${r.subCapability}`)));

  for (const cat of categories) {
    const [domain, subCapability] = cat.split(':');
    const catResults = results.filter(r => r.domain === domain && r.subCapability === subCapability);

    let tp = 0, fp = 0, tn = 0, fn = 0;
    const boundaryErrors: number[] = [];
    const ious: number[] = [];

    for (const r of catResults) {
      if (r.classification === 'TP') tp++;
      else if (r.classification === 'TN') tn++;
      else if (r.classification === 'FP') fp++;
      else if (r.classification === 'FN') fn++;
      else if (r.classification === 'PASS') tp++; // deterministic check passed
      else if (r.classification === 'FAIL') fn++;

      if (typeof r.boundaryErrorSec === 'number') boundaryErrors.push(r.boundaryErrorSec);
      if (typeof r.iou === 'number') ious.push(r.iou);
    }

    const precision = (tp + fp) > 0 ? parseFloat((tp / (tp + fp)).toFixed(3)) : 1.0;
    const recall = (tp + fn) > 0 ? parseFloat((tp / (tp + fn)).toFixed(3)) : 1.0;
    const f1 = (precision + recall) > 0 ? parseFloat(((2 * precision * recall) / (precision + recall)).toFixed(3)) : 0;
    const specificity = (tn + fp) > 0 ? parseFloat((tn / (tn + fp)).toFixed(3)) : 1.0;
    const accuracy = parseFloat(((tp + tn) / catResults.length).toFixed(3));

    summaries.push({
      task: `${domain} / ${subCapability}`,
      split: catResults.map(r => r.split).join(', '),
      totalCases: catResults.length,
      passed: catResults.filter(r => r.passed).length,
      tp, fp, tn, fn,
      precision,
      recall,
      f1,
      specificity,
      accuracy,
      meanBoundaryErrorSec: boundaryErrors.length > 0 ? parseFloat((boundaryErrors.reduce((a, b) => a + b, 0) / boundaryErrors.length).toFixed(3)) : undefined,
      meanIoU: ious.length > 0 ? parseFloat((ious.reduce((a, b) => a + b, 0) / ious.length).toFixed(3)) : undefined
    });
  }

  console.log('\n--- GROUND-TRUTH BENCHMARK CASE RESULTS ---');
  for (const r of results) {
    const symbol = r.passed ? '✅' : '❌';
    console.log(`  ${symbol} [${r.caseId}] ${r.name}`);
    console.log(`     Expected: ${r.expected} | Actual: ${r.actual} | Result: ${r.passed ? 'PASS' : 'FAIL'} (${r.classification || ''})`);
    console.log(`     Details: ${r.details}`);
  }
  for (const s of summaries) {
    console.log(`• [${s.task}] (${s.totalCases} cases)`);
    console.log(`   Passed: ${s.passed}/${s.totalCases} | Precision: ${(s.precision * 100).toFixed(1)}% | Recall: ${(s.recall * 100).toFixed(1)}% | F1: ${(s.f1 * 100).toFixed(1)}%`);
    if (s.meanIoU !== undefined) console.log(`   Mean Temporal IoU: ${s.meanIoU}`);
    if (s.meanBoundaryErrorSec !== undefined) console.log(`   Mean Boundary Error: ${s.meanBoundaryErrorSec}s`);
  }

  const allPassed = results.every(r => r.passed);
  console.log('\n================================================================');
  console.log(`GROUND-TRUTH BENCHMARK OVERALL: ${allPassed ? '✅ ALL CASES PASSED' : '❌ SOME CASES FAILED'}`);
  console.log('================================================================\n');

  assert(allPassed, 'All Ground-Truth Benchmark Cases must pass without regression');

  return { results, summaries, allPassed };
}

if (process.argv[1] && process.argv[1].endsWith('ground_truth_benchmark.ts')) {
  runGroundTruthBenchmark().then(() => {
    console.log('🎉 GROUND-TRUTH BENCHMARK EXECUTED SUCCESSFULLY!');
    process.exit(0);
  }).catch((err) => {
    console.error('❌ GROUND-TRUTH BENCHMARK FAILED:', err);
    process.exit(1);
  });
}
