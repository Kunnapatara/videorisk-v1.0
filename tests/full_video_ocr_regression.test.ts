import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { videoProcessor, validateTesseractTsv } from '../src/server/pipeline/videoProcessor';
import { MediaMetadata } from '../src/types';

const execFileAsync = promisify(execFile);

export async function runFullVideoOcrRegressionTests() {
  console.log('\n======================================================');
  console.log('--- FULL-VIDEO OCR TARGETED REGRESSION SUITE (A–I) ---');
  console.log('Real FFmpeg + Real Tesseract + Multi-Stream + Diagnostics + Cleanup');
  console.log('======================================================\n');

  const testDir = path.resolve(process.cwd(), 'uploads', 'test_full_ocr_' + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  const ocrFramesRoot = path.resolve(process.cwd(), 'uploads', 'ocr_frames');
  const baselineOcrDirs = new Set(fs.existsSync(ocrFramesRoot) ? fs.readdirSync(ocrFramesRoot) : []);
  const assertNoTempOcrDirLeak = (label: string) => {
    if (!fs.existsSync(ocrFramesRoot)) return;
    const currentDirs = fs.readdirSync(ocrFramesRoot);
    const leaked = currentDirs.filter(d => !baselineOcrDirs.has(d));
    assert.strictEqual(leaked.length, 0, `${label}: Zero temp ocr_frames directories leaked (found: ${leaked.join(', ')})`);
  };

  const prevTesseract = process.env.TESSERACT_PATH;
  const prevFfmpeg = process.env.FFMPEG_PATH;

  const baseMeta = (filename: string, durationSeconds: number, width = 640, height = 360): MediaMetadata => ({
    filename,
    originalSize: 120000,
    durationSeconds,
    width,
    height,
    resolutionLabel: `${height}p`,
    fps: 10,
    hasAudio: false,
    videoCodec: 'h264',
    isProxyUsed: false
  });

  try {
    process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    delete process.env.FFMPEG_PATH;

    // -------------------------------------------------------------------------
    // A. POSITIVE DETECTION (Real FFmpeg + Real Tesseract + Diagnostics Check)
    // -------------------------------------------------------------------------
    console.log('[A. Positive Detection — Real FFmpeg & Real Tesseract]');
    const posVideo = path.resolve(testDir, 'pos_text.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', "color=c=#111827:s=640x360:rate=10:duration=3,drawtext=text='POLICY AUDIT':fontsize=42:fontcolor=white:box=1:boxcolor=black@0.95:boxborderw=10:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,0.5,2.5)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      posVideo
    ]);
    const posRes = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), {
      maxFrames: 5,
      sampleIntervalSeconds: 1
    });
    assert.strictEqual(posRes.status, 'DETECTED', 'A.1 Visible on-screen text detected');
    assert.ok(posRes.allExtractedText.some(t => t.includes('POLICY') && t.includes('AUDIT')), 'A.2 Recognized text matches overlay');
    assert.ok(posRes.frameDiagnostics && posRes.frameDiagnostics.length === 3, 'A.3 Per-frame diagnostics emitted for all 3 frames');
    assert.strictEqual(posRes.frameDiagnostics![0].recognizedWordCount, 0, 'A.4 Frame @ 0s accurately reports 0 words');
    assert.ok(posRes.frameDiagnostics![1].validWordCount >= 2, 'A.5 Frame @ 1s reports validWordCount >= 2');
    assert.ok(posRes.frameDiagnostics![1].confidenceSummary && posRes.frameDiagnostics![1].confidenceSummary.mean > 0.5, 'A.6 Confidence summary populated cleanly');
    assert.ok(!JSON.stringify(posRes.frameDiagnostics).includes(process.cwd()), 'A.7 Diagnostics never leak absolute workspace paths');
    assertNoTempOcrDirLeak('A.cleanup');
    console.log('  ✅ PASS: Positive detection & safe per-frame diagnostics verified');

    // -------------------------------------------------------------------------
    // B. NEGATIVE DETECTION (Blank & Noisy SMPTE testsrc without text)
    // -------------------------------------------------------------------------
    console.log('\n[B. Negative Detection — Solid Color & Noisy SMPTE testsrc without text]');
    const blankVideo = path.resolve(testDir, 'neg_blank.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=640x360:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blankVideo
    ]);
    const negBlankRes = await videoProcessor.performVideoOcr(blankVideo, baseMeta('neg_blank.mp4', 2.0), { timestamps: [0, 1] });
    assert.strictEqual(negBlankRes.status, 'NO_SIGNAL_DETECTED', 'B.1 Blank video returns NO_SIGNAL_DETECTED');
    assert.strictEqual(negBlankRes.detectedFrames.length, 0, 'B.2 Zero detected frames for blank video');

    const noisyTestsrc = path.resolve(testDir, 'neg_testsrc.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', noisyTestsrc
    ]);
    const negNoisyRes = await videoProcessor.performVideoOcr(noisyTestsrc, baseMeta('neg_testsrc.mp4', 2.0, 320, 240), { timestamps: [0, 1] });
    assert.strictEqual(negNoisyRes.status, 'NO_SIGNAL_DETECTED', 'B.3 Noisy text-free testsrc does NOT produce false positive DETECTED');
    assertNoTempOcrDirLeak('B.cleanup');
    console.log('  ✅ PASS: Negative detection (zero false positives) verified');

    // -------------------------------------------------------------------------
    // C. TEXT OUTSIDE SAMPLED INTERVAL (Honest Temporal Coverage Limitation)
    // -------------------------------------------------------------------------
    console.log('\n[C. Text Outside Sampled Interval — Truthful Coverage Reporting]');
    const outsideVideo = path.resolve(testDir, 'outside_interval.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', "color=c=#111827:s=640x360:rate=10:duration=5,drawtext=text='HIDDEN WINDOW':fontsize=40:fontcolor=white:box=1:boxcolor=black@0.95:boxborderw=10:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,1.1,1.4)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      outsideVideo
    ]);
    const outsideRes = await videoProcessor.performVideoOcr(outsideVideo, baseMeta('outside_interval.mp4', 5.0), {
      timestamps: [0, 2, 4]
    });
    assert.strictEqual(outsideRes.status, 'NO_SIGNAL_DETECTED', 'C.1 Text strictly between [0,2,4] samples is missed at sample points');
    assert.strictEqual(outsideRes.timelineCoverageStatus, 'NOT_VERIFIED', 'C.2 Temporal interval coverage explicitly NOT_VERIFIED');
    assert.strictEqual(outsideRes.timelineCoverageRatio, null, 'C.3 timelineCoverageRatio remains null');
    assert.ok(outsideRes.limitations.toLowerCase().includes('not verified'), 'C.4 Limitations explicitly disclose sampling coverage gap');
    console.log('  ✅ PASS: Text outside sampled interval reports truthful limitation');

    // -------------------------------------------------------------------------
    // D. EXTRACTION FAILURES & MULTI-STREAM PRIMARY SELECTION (-map 0:v:0)
    // -------------------------------------------------------------------------
    console.log('\n[D. Frame Extraction Failures & Multi-Stream Primary Selection]');
    // Multi-stream MP4: stream 0 has text, stream 1 is blank
    const multiStreamVideo = path.resolve(testDir, 'multistream.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', "color=c=#111827:s=640x360:rate=10:duration=2,drawtext=text='PRIMARY STREAM':fontsize=40:fontcolor=white:box=1:boxcolor=black@0.95:boxborderw=10:x=(w-text_w)/2:y=(h-text_h)/2",
      '-f', 'lavfi', '-i', 'color=c=black:s=640x360:rate=10:duration=2',
      '-map', '0:v:0', '-map', '1:v:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      multiStreamVideo
    ]);
    const multiRes = await videoProcessor.performVideoOcr(multiStreamVideo, baseMeta('multistream.mp4', 2.0), { timestamps: [1] });
    assert.strictEqual(multiRes.status, 'DETECTED', 'D.1 Primary video stream 0:v:0 deterministically selected on multi-stream container');
    assert.ok(multiRes.allExtractedText.some(t => t.includes('PRIMARY')), 'D.2 Primary stream text accurately recognized');

    // Corrupt PNG output check (valid PNG signature with 0x0 IHDR)
    const zeroDimFfmpeg = path.resolve(testDir, 'ffmpeg_zero_png.sh');
    fs.writeFileSync(zeroDimFfmpeg, `#!/bin/sh
OUT=""
for arg in "$@"; do OUT="$arg"; done
node -e 'const fs=require("fs"); const b=Buffer.alloc(24); Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(b,0); b.write("IHDR",12); b.writeUInt32BE(0,16); b.writeUInt32BE(0,20); fs.writeFileSync(process.argv[1],b);' "$OUT"
exit 0
`, { mode: 0o755 });
    process.env.FFMPEG_PATH = zeroDimFfmpeg;
    const zeroDimRes = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), { timestamps: [1] });
    assert.strictEqual(zeroDimRes.status, 'ANALYSIS_UNAVAILABLE', 'D.3 Zero-dimension PNG rejected as ANALYSIS_UNAVAILABLE');
    assert.strictEqual(zeroDimRes.extractionErrors?.[0]?.category, 'EMPTY_OUTPUT', 'D.4 Zero-dimension PNG categorized as EMPTY_OUTPUT');
    assertNoTempOcrDirLeak('D.cleanup');
    delete process.env.FFMPEG_PATH;
    console.log('  ✅ PASS: Multi-stream selection & invalid PNG rejection verified');

    // -------------------------------------------------------------------------
    // E. OCR FAILURE & F. PARTIAL SUCCESS
    // -------------------------------------------------------------------------
    console.log('\n[E & F. OCR Failure Diagnostics & Partial Execution]');
    const partialExitTwoScript = path.resolve(testDir, 'ocr_partial_exit2.sh');
    fs.writeFileSync(partialExitTwoScript, `#!/bin/sh
if echo "$1" | grep -q "frame_001"; then
  echo "simulated engine crash" >&2
  exit 2
fi
printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n"
printf "5\\t1\\t1\\t1\\t1\\t1\\t20\\t20\\t120\\t40\\t94.5\\tPARTIAL_OK\\n"
`, { mode: 0o755 });
    process.env.TESSERACT_PATH = partialExitTwoScript;
    const partialRes = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), { timestamps: [0, 1] });
    assert.strictEqual(partialRes.executionStatus, 'PARTIAL', 'F.1 Partial OCR execution status is PARTIAL');
    assert.strictEqual(partialRes.status, 'DETECTED', 'F.2 Partial run with valid text frame returns DETECTED');
    assert.strictEqual(partialRes.framesSucceeded, 1, 'F.3 1 frame succeeded');
    assert.strictEqual(partialRes.framesOcrFailed, 1, 'F.4 1 frame failed');
    assert.strictEqual(partialRes.ocrExecutionSuccessRatio, 0.5, 'F.5 OCR execution ratio 0.5');
    assert.strictEqual(partialRes.frameDiagnostics?.[1]?.tesseractExitCode, 2, 'E.1 Diagnostics capture exact non-zero exit code 2');
    assert.strictEqual(partialRes.frameDiagnostics?.[1]?.failureCategory, 'NON_ZERO_EXIT', 'E.2 Diagnostics categorize exit code 2 as NON_ZERO_EXIT');
    assertNoTempOcrDirLeak('EF.cleanup');
    process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    console.log('  ✅ PASS: OCR failure exit codes & partial execution verified');

    // -------------------------------------------------------------------------
    // G. REPEATED TEXT (Consecutive Dedup + Non-Consecutive Reappearance)
    // -------------------------------------------------------------------------
    console.log('\n[G. Repeated Text — Consecutive Deduplication & Non-Consecutive Reappearance]');
    const repVideo = path.resolve(testDir, 'repeated_text.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', "color=c=#111827:s=640x360:rate=10:duration=4,drawtext=text='SUBSCRIBE':fontsize=42:fontcolor=white:box=1:boxcolor=black@0.95:boxborderw=10:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,0.5,1.5)+between(t,2.5,3.5)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      repVideo
    ]);
    const repRes = await videoProcessor.performVideoOcr(repVideo, baseMeta('repeated_text.mp4', 4.0), {
      timestamps: [0, 1, 2, 3]
    });
    assert.strictEqual(repRes.status, 'DETECTED', 'G.1 Repeated overlay detected');
    assert.strictEqual(repRes.detectedFrames.length, 2, 'G.2 Non-consecutive reappearances at t=1s and t=3s preserved across empty t=2s frame');
    assert.strictEqual(repRes.allExtractedText.length, 1, 'G.3 allExtractedText deduplicates identical phrase across full video');

    // Consecutive identical frames (posVideo has text at both t=1s and t=2s)
    assert.strictEqual(posRes.detectedFrames.length, 1, 'G.4 Consecutive identical frames t=1s and t=2s deduplicated to 1 detectedFrames item');
    assert.strictEqual(validateTesseractTsv('level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t-1\tRAW').recognizedWordCount, 1, 'G.5 validateTesseractTsv tracks recognizedWordCount separately from conf>=0 valid words');
    console.log('  ✅ PASS: Repeated text deduplication & reappearance verified');

    // -------------------------------------------------------------------------
    // H. LANGUAGE HANDLING (English, Thai & Mixed English/Thai when font permits)
    // -------------------------------------------------------------------------
    console.log('\n[H. Language Handling (English & Conditional Thai/Mixed)]');
    let thaiFontFile = '';
    try {
      const { stdout: fcOut } = await execFileAsync('fc-list', [':lang=th', 'file']);
      const candidates = fcOut.split(/\r?\n/).map(l => l.split(':')[0].trim()).filter(f => f.endsWith('.ttf') && fs.existsSync(f));
      if (candidates.length > 0) thaiFontFile = candidates[0];
    } catch { /* no thai font installed */ }

    if (thaiFontFile) {
      const thaiVideo = path.resolve(testDir, 'thai_mixed_text.mp4');
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi',
        '-i', `color=c=#111827:s=640x360:rate=10:duration=2,drawtext=fontfile=${thaiFontFile}:text='ทดสอบ POLICY':fontsize=42:fontcolor=white:box=1:boxcolor=black@0.95:boxborderw=10:x=(w-text_w)/2:y=(h-text_h)/2`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        thaiVideo
      ]);
      const thaiRes = await videoProcessor.performVideoOcr(thaiVideo, baseMeta('thai_mixed_text.mp4', 2.0), {
        timestamps: [1],
        languages: 'eng+tha'
      });
      assert.strictEqual(thaiRes.status, 'DETECTED', 'H.1 Mixed Thai+English overlay detected with eng+tha');
      assert.ok(thaiRes.allExtractedText.some(t => /POLICY/.test(t) || /[\u0E00-\u0E7F]/.test(t)), 'H.2 Recognized mixed Thai/English script');
      console.log(`  ✅ PASS: English + Thai (${path.basename(thaiFontFile)}) OCR verified`);
    } else {
      console.log('  ℹ️  INFO: No Thai TTF font installed for FFmpeg drawtext on this host; English OCR verified and Thai execution skipped cleanly.');
    }
    assertNoTempOcrDirLeak('I.final');

    console.log('\n======================================================');
    console.log('🎉 ALL FULL-VIDEO OCR REGRESSION SCENARIOS (A–I) PASSED!');
    console.log('======================================================\n');
  } finally {
    if (prevTesseract === undefined) delete process.env.TESSERACT_PATH;
    else process.env.TESSERACT_PATH = prevTesseract;
    if (prevFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prevFfmpeg;
    try {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

if (process.argv[1]?.includes('full_video_ocr_regression.test.ts')) {
  runFullVideoOcrRegressionTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ FULL-VIDEO OCR REGRESSION TEST FAILED:', err);
      process.exit(1);
    });
}
