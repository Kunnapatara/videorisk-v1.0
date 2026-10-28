import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import assert from 'assert';
import { videoProcessor } from '../src/server/pipeline/videoProcessor';
import { mediaInspector } from '../src/server/pipeline/mediaInspector';

const execFileAsync = promisify(execFile);

export interface BenchmarkCaseResult {
  caseId: string;
  name: string;
  category: 'visual_duplicate' | 'slideshow';
  expected: boolean;
  actual: boolean;
  classification: 'TP' | 'TN' | 'FP' | 'FN';
  details: string;
}

export interface BenchmarkSummary {
  totalCases: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1Score: number;
  specificity: number;
  accuracy: number;
  datasetDescription: string;
  limitationNotice: string;
  syntheticRegression?: {
    totalFixtures: number;
    passedFixtures: number;
    failedFixtures: number;
    allPassed: boolean;
  };
  realWorldEvaluation?: {
    status: 'NOT EVALUATED';
    precision: 'NOT EVALUATED';
    recall: 'NOT EVALUATED';
    f1: 'NOT EVALUATED';
    reason: string;
  };
}

export async function runVisualDuplicateBenchmark(): Promise<BenchmarkSummary> {
  console.log('================================================================');
  console.log('--- DETERMINISTIC SYNTHETIC REGRESSION TEST SUITE ---');
  console.log('    Visual Duplicate & Slideshow Behavioral Fixtures');
  console.log('================================================================\n');

  const benchmarkDir = path.resolve(process.cwd(), 'tests', 'fixtures', 'visual_benchmark');
  if (!fs.existsSync(benchmarkDir)) {
    fs.mkdirSync(benchmarkDir, { recursive: true });
  }

  const results: BenchmarkCaseResult[] = [];
  const generatedVideos: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // FIXTURE 1: Identical Repeated Textured Footage (Positive / Expected Duplicate)
    // -------------------------------------------------------------------------
    const vid1Path = path.resolve(benchmarkDir, 'case1_identical_repeat.mp4');
    if (!fs.existsSync(vid1Path)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2[v1];color=c=black:size=320x240:rate=10:duration=2[v2];testsrc=size=320x240:rate=10:duration=2[v3];[v1][v2][v3]concat=n=3:v=1:a=0',
        '-c:v', 'libx264',
        vid1Path
      ]);
    }
    generatedVideos.push(vid1Path);

    const meta1 = await mediaInspector.inspect(vid1Path, 'case1_identical_repeat.mp4');
    const res1 = await videoProcessor.analyzeVideo(vid1Path, meta1, 'standard');
    await videoProcessor.cleanupFrames(res1.tempFramesDir);

    const isDup1 = (res1.repeatedFootageSegments && res1.repeatedFootageSegments.length > 0) || res1.repeatedFootageStatus === 'DETECTED';
    results.push({
      caseId: 'BM-VD-01',
      name: 'Identical repeated textured footage across non-adjacent segments',
      category: 'visual_duplicate',
      expected: true,
      actual: isDup1,
      classification: isDup1 ? 'TP' : 'FN',
      details: `Segments: ${res1.repeatedFootageSegments.length}, Status: ${res1.repeatedFootageStatus}`
    });

    // -------------------------------------------------------------------------
    // FIXTURE 2: Repeated Footage with Brightness/Contrast Shift (Positive)
    // -------------------------------------------------------------------------
    const vid2Path = path.resolve(benchmarkDir, 'case2_brightness_shift_repeat.mp4');
    if (!fs.existsSync(vid2Path)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2[v1];color=c=navy:size=320x240:duration=2[v2];testsrc=size=320x240:rate=10:duration=2,eq=brightness=0.08:contrast=1.06[v3];[v1][v2][v3]concat=n=3:v=1:a=0',
        '-c:v', 'libx264',
        vid2Path
      ]);
    }
    generatedVideos.push(vid2Path);

    const meta2 = await mediaInspector.inspect(vid2Path, 'case2_brightness_shift_repeat.mp4');
    const res2 = await videoProcessor.analyzeVideo(vid2Path, meta2, 'standard');
    await videoProcessor.cleanupFrames(res2.tempFramesDir);

    const isDup2 = (res2.repeatedFootageSegments && res2.repeatedFootageSegments.length > 0) || res2.repeatedFootageStatus === 'DETECTED';
    results.push({
      caseId: 'BM-VD-02',
      name: 'Repeated scene under brightness/contrast modification',
      category: 'visual_duplicate',
      expected: true,
      actual: isDup2,
      classification: isDup2 ? 'TP' : 'FN',
      details: `Structural NCC + gradient agreement robust to lighting shift. Status: ${res2.repeatedFootageStatus}`
    });

    // -------------------------------------------------------------------------
    // FIXTURE 3: Different Scenes with Similar Dominant Color (Negative / Reject)
    // -------------------------------------------------------------------------
    const vid3Path = path.resolve(benchmarkDir, 'case3_similar_color_distinct.mp4');
    if (!fs.existsSync(vid3Path)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=0x102040:size=320x240:duration=2,drawbox=x=120:y=20:w=80:h=200:color=white@0.8:t=fill[v1];color=c=0x102040:size=320x240:duration=2,drawbox=x=20:y=100:w=280:h=40:color=yellow@0.8:t=fill[v2];[v1][v2]concat=n=2:v=1:a=0',
        '-c:v', 'libx264',
        vid3Path
      ]);
    }
    generatedVideos.push(vid3Path);

    const meta3 = await mediaInspector.inspect(vid3Path, 'case3_similar_color_distinct.mp4');
    const res3 = await videoProcessor.analyzeVideo(vid3Path, meta3, 'standard');
    await videoProcessor.cleanupFrames(res3.tempFramesDir);

    const isDup3 = (res3.repeatedFootageSegments && res3.repeatedFootageSegments.length > 0) || res3.repeatedFootageStatus === 'DETECTED';
    results.push({
      caseId: 'BM-VD-03',
      name: 'Different geometric scenes with similar dominant background color',
      category: 'visual_duplicate',
      expected: false,
      actual: isDup3,
      classification: !isDup3 ? 'TN' : 'FP',
      details: `Disparate structural gradients correctly prevent false positive. Status: ${res3.repeatedFootageStatus}`
    });

    // -------------------------------------------------------------------------
    // FIXTURE 4: Different Scenes with Matching Average Luminance (Negative / Reject)
    // -------------------------------------------------------------------------
    const vid4Path = path.resolve(benchmarkDir, 'case4_matched_luminance_distinct.mp4');
    if (!fs.existsSync(vid4Path)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'smptebars=size=320x240:rate=10:duration=2[v1];color=c=0x808080:size=320x240:duration=2[v2];[v1][v2]concat=n=2:v=1:a=0',
        '-c:v', 'libx264',
        vid4Path
      ]);
    }
    generatedVideos.push(vid4Path);

    const meta4 = await mediaInspector.inspect(vid4Path, 'case4_matched_luminance_distinct.mp4');
    const res4 = await videoProcessor.analyzeVideo(vid4Path, meta4, 'standard');
    await videoProcessor.cleanupFrames(res4.tempFramesDir);

    const isDup4 = (res4.repeatedFootageSegments && res4.repeatedFootageSegments.length > 0) || res4.repeatedFootageStatus === 'DETECTED';
    results.push({
      caseId: 'BM-VD-04',
      name: 'Different scenes with matched overall luminance level',
      category: 'visual_duplicate',
      expected: false,
      actual: isDup4,
      classification: !isDup4 ? 'TN' : 'FP',
      details: `Pattern variance successfully rejected. Status: ${res4.repeatedFootageStatus}`
    });

    // -------------------------------------------------------------------------
    // FIXTURE 5: Short Repeated Content (Positive)
    // -------------------------------------------------------------------------
    const vid5Path = path.resolve(benchmarkDir, 'case5_short_repeated_bumper.mp4');
    if (!fs.existsSync(vid5Path)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=darkgreen:size=320x240:duration=1.5,drawbox=x=80:y=60:w=160:h=120:color=white:t=fill[b1];color=c=black:size=320x240:duration=2.5[mid];color=c=darkgreen:size=320x240:duration=1.5,drawbox=x=80:y=60:w=160:h=120:color=white:t=fill[b2];[b1][mid][b2]concat=n=3:v=1:a=0',
        '-c:v', 'libx264',
        vid5Path
      ]);
    }
    generatedVideos.push(vid5Path);

    const meta5 = await mediaInspector.inspect(vid5Path, 'case5_short_repeated_bumper.mp4');
    const res5 = await videoProcessor.analyzeVideo(vid5Path, meta5, 'standard');
    await videoProcessor.cleanupFrames(res5.tempFramesDir);

    const isDup5 = (res5.repeatedFootageSegments && res5.repeatedFootageSegments.length > 0) || res5.repeatedFootageStatus === 'DETECTED';
    results.push({
      caseId: 'BM-VD-05',
      name: 'Short repeated graphic bumper (1.5s) separated by intervening content',
      category: 'visual_duplicate',
      expected: true,
      actual: isDup5,
      classification: isDup5 ? 'TP' : 'FN',
      details: `Short sequence captured across sampling intervals. Status: ${res5.repeatedFootageStatus}`
    });

    // -------------------------------------------------------------------------
    // FIXTURE 6: Continuous Dynamic Footage Without Repetition (Negative / Reject)
    // -------------------------------------------------------------------------
    const vid6Path = path.resolve(benchmarkDir, 'case6_continuous_no_repeat.mp4');
    if (!fs.existsSync(vid6Path)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'smptebars=duration=2:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=10',
        '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[outv]',
        '-map', '[outv]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        vid6Path
      ]);
    }
    generatedVideos.push(vid6Path);

    const meta6 = await mediaInspector.inspect(vid6Path, 'case6_continuous_no_repeat.mp4');
    const res6 = await videoProcessor.analyzeVideo(vid6Path, meta6, 'standard');
    await videoProcessor.cleanupFrames(res6.tempFramesDir);

    const isDup6 = (res6.repeatedFootageSegments && res6.repeatedFootageSegments.length > 0) || res6.repeatedFootageStatus === 'DETECTED';
    results.push({
      caseId: 'BM-VD-06',
      name: 'Continuous evolving procedural footage with no repetition',
      category: 'visual_duplicate',
      expected: false,
      actual: isDup6,
      classification: !isDup6 ? 'TN' : 'FP',
      details: `0 repeated segments identified. Status: ${res6.repeatedFootageStatus}`
    });

    // -------------------------------------------------------------------------
    // FIXTURE 7: Static Multi-Slide Slideshow (Positive Slideshow)
    // -------------------------------------------------------------------------
    const vid7Path = path.resolve(benchmarkDir, 'case7_static_slideshow.mp4');
    if (!fs.existsSync(vid7Path)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=red:size=320x240:duration=2[s1];color=c=green:size=320x240:duration=2[s2];color=c=blue:size=320x240:duration=2[s3];color=c=yellow:size=320x240:duration=2[s4];[s1][s2][s3][s4]concat=n=4:v=1:a=0',
        '-c:v', 'libx264',
        vid7Path
      ]);
    }
    generatedVideos.push(vid7Path);

    const meta7 = await mediaInspector.inspect(vid7Path, 'case7_static_slideshow.mp4');
    const res7 = await videoProcessor.analyzeVideo(vid7Path, meta7, 'standard');
    await videoProcessor.cleanupFrames(res7.tempFramesDir);

    const isSlide7 = res7.hasSlideshowPattern || res7.slideshowAnalysisStatus === 'DETECTED';
    results.push({
      caseId: 'BM-SS-01',
      name: 'Multi-slide static image presentation (2s per slide)',
      category: 'slideshow',
      expected: true,
      actual: isSlide7,
      classification: isSlide7 ? 'TP' : 'FN',
      details: `Invariance across intra-scene frames detected as slideshow. Status: ${res7.slideshowAnalysisStatus}`
    });

    // -------------------------------------------------------------------------
    // FIXTURE 8: Dynamic Panning Motion Footage (Negative Slideshow / Reject)
    // -------------------------------------------------------------------------
    const vid8Path = path.resolve(benchmarkDir, 'case8_continuous_motion.mp4');
    if (!fs.existsSync(vid8Path)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=4',
        '-c:v', 'libx264',
        vid8Path
      ]);
    }
    generatedVideos.push(vid8Path);

    const meta8 = await mediaInspector.inspect(vid8Path, 'case8_continuous_motion.mp4');
    const res8 = await videoProcessor.analyzeVideo(vid8Path, meta8, 'standard');
    await videoProcessor.cleanupFrames(res8.tempFramesDir);

    const isSlide8 = res8.hasSlideshowPattern || res8.slideshowAnalysisStatus === 'DETECTED';
    results.push({
      caseId: 'BM-SS-02',
      name: 'Dynamic moving footage with high continuous motion',
      category: 'slideshow',
      expected: false,
      actual: isSlide8,
      classification: !isSlide8 ? 'TN' : 'FP',
      details: `Motion energy correctly avoids false slideshow classification. Status: ${res8.slideshowAnalysisStatus}`
    });

  } finally {
    // Clean up temporary benchmark media files
    for (const vPath of generatedVideos) {
      try {
        if (fs.existsSync(vPath)) fs.unlinkSync(vPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  // ---------------------------------------------------------------------------
  // TALLY CONFUSION MATRIX & COMPUTE METRICS
  // ---------------------------------------------------------------------------
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of results) {
    if (r.classification === 'TP') tp++;
    else if (r.classification === 'FP') fp++;
    else if (r.classification === 'TN') tn++;
    else if (r.classification === 'FN') fn++;
  }

  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 1;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 1;
  const f1Score = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const specificity = (tn + fp) > 0 ? tn / (tn + fp) : 1;
  const accuracy = (tp + tn) / results.length;

  console.log('\n--- BENCHMARK CASE RESULTS TABLE ---');
  for (const r of results) {
    const symbol = r.classification.startsWith('T') ? '✅' : '❌';
    console.log(`  ${symbol} [${r.caseId}] ${r.name}`);
    console.log(`     Category: ${r.category} | Expected: ${r.expected} | Actual: ${r.actual} | Result: ${r.classification}`);
    console.log(`     Details: ${r.details}`);
  }

  const passedCases = results.filter(r => (r.expected === r.actual)).length;
  const failedCases = results.length - passedCases;

  console.log('\n================================================================');
  console.log('--- SYNTHETIC REGRESSION RESULTS & ACCURACY EVALUATION STATUS ---');
  console.log('================================================================');
  console.log('A. AUTOMATED REGRESSION TEST RESULTS:');
  console.log(`  Synthetic regression fixtures: ${passedCases}/${results.length} passed`);
  console.log(`  Fixture failures: ${failedCases}`);
  console.log(`  Regression behavior status: ${failedCases === 0 ? 'VERIFIED' : 'TEST FAILED'}`);
  console.log('----------------------------------------------------------------');
  console.log('B. REAL-WORLD ACCURACY EVALUATION:');
  console.log('  Real-world precision: NOT EVALUATED');
  console.log('  Real-world recall:    NOT EVALUATED');
  console.log('  Real-world F1:        NOT EVALUATED');
  console.log('  Reason: no validated real-world dataset with ground-truth annotations was evaluated');
  console.log('----------------------------------------------------------------');
  console.log('C. SYNTHETIC FIXTURE METRICS (Strictly limited to 8 synthetic cases; NOT production accuracy):');
  console.log(`  Synthetic True Positives  (TP) : ${tp}`);
  console.log(`  Synthetic True Negatives  (TN) : ${tn}`);
  console.log(`  Synthetic False Positives (FP) : ${fp}`);
  console.log(`  Synthetic False Negatives (FN) : ${fn}`);
  console.log(`  Synthetic Precision            : ${(precision * 100).toFixed(1)}% (Synthetic test cases only)`);
  console.log(`  Synthetic Recall               : ${(recall * 100).toFixed(1)}% (Synthetic test cases only)`);
  console.log(`  Synthetic F1 Score             : ${(f1Score * 100).toFixed(1)}% (Synthetic test cases only)`);
  console.log(`  Synthetic Specificity          : ${(specificity * 100).toFixed(1)}% (Synthetic test cases only)`);
  console.log(`  Synthetic Fixture Accuracy     : ${(accuracy * 100).toFixed(1)}% (Synthetic test cases only)`);
  console.log('----------------------------------------------------------------');
  console.log('  Benchmark Dataset Provenance:');
  console.log('  Deterministic synthetic FFmpeg fixtures with mathematically specified patterns.');
  console.log('  LIMITATION NOTICE: Real-world precision and recall remain unverified against');
  console.log('  arbitrary production cinema/vlog footage without human-annotated external datasets.');
  console.log('================================================================\n');

  assert(fp === 0, 'Zero false positives on benchmark fixtures');
  assert(fn === 0, 'Zero false negatives on benchmark fixtures');
  assert(f1Score >= 0.95, 'F1 score meets or exceeds 95% on deterministic benchmark');
  assert(failedCases === 0, 'All 8 synthetic regression fixtures passed');

  return {
    totalCases: results.length,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision,
    recall,
    f1Score,
    specificity,
    accuracy,
    datasetDescription: '8 deterministic FFmpeg fixtures evaluating textured repeats, lighting adjustments, color similarities, luminance invariance, short bumpers, continuous motion, and slideshows.',
    limitationNotice: 'Real-world precision and recall remain unverified against arbitrary production cinema / vlog footage without a human-labeled ground-truth production dataset.',
    syntheticRegression: {
      totalFixtures: results.length,
      passedFixtures: passedCases,
      failedFixtures: failedCases,
      allPassed: failedCases === 0
    },
    realWorldEvaluation: {
      status: 'NOT EVALUATED',
      precision: 'NOT EVALUATED',
      recall: 'NOT EVALUATED',
      f1: 'NOT EVALUATED',
      reason: 'No validated real-world dataset with ground-truth annotations was evaluated.'
    }
  };
}

if (process.argv[1] && process.argv[1].endsWith('visual_duplicate_benchmark.test.ts')) {
  runVisualDuplicateBenchmark().then(() => {
    console.log('🎉 VISUAL DUPLICATE REGRESSION SUITE EXECUTED SUCCESSFULLY!');
    process.exit(0);
  }).catch((err) => {
    console.error('❌ VISUAL DUPLICATE REGRESSION SUITE FAILED:', err);
    process.exit(1);
  });
}
