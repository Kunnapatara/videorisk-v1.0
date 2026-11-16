import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  videoProcessor,
  validateTesseractTsv,
  validatePngFrameFile,
  sanitizeOcrDiagnostic
} from '../src/server/pipeline/videoProcessor';
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
      console.log('  ⚠️  SKIPPED: Thai mixed-script OCR check skipped (no Thai TTF font available for FFmpeg drawtext on this host); English OCR verified.');
    }

    // -------------------------------------------------------------------------
    // D2. STRICT PNG SIGNATURE, IHDR & CHUNK VALIDATION
    // -------------------------------------------------------------------------
    console.log('\n[D2. Strict PNG Signature, IHDR, Dimension & Chunk Validation]');
    const validPngProbe = path.resolve(testDir, 'valid_probe.png');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=#111827:s=640x360:d=1',
      '-vframes', '1', validPngProbe
    ]);
    const validProbeRes = validatePngFrameFile(validPngProbe);
    assert.strictEqual(validProbeRes.valid, true, 'D2.1 Real FFmpeg PNG passes strict PNG validation');
    assert.deepStrictEqual(validProbeRes.dimensions, { width: 640, height: 360 }, 'D2.2 Real FFmpeg PNG reports exact 640x360 dimensions');

    // Non-PNG ASCII payload (previously bypassed header check when isPngHeader was false!)
    const nonPngFile = path.resolve(testDir, 'fake_non_png.png');
    fs.writeFileSync(nonPngFile, 'THIS_IS_PLAIN_TEXT_NOT_A_PNG_FILE_1234567890');
    assert.strictEqual(validatePngFrameFile(nonPngFile).valid, false, 'D2.3 Rejects non-PNG ASCII payload');

    // Fake JPEG bytes
    const jpegSpoofFile = path.resolve(testDir, 'fake_jpeg.png');
    fs.writeFileSync(jpegSpoofFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]));
    assert.strictEqual(validatePngFrameFile(jpegSpoofFile).valid, false, 'D2.4 Rejects JPEG bytes masquerading as .png');

    // Truncated (< 8 byte) and truncated mid-IHDR (20 byte) PNG files
    const shortSigFile = path.resolve(testDir, 'short_sig.png');
    fs.writeFileSync(shortSigFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.strictEqual(validatePngFrameFile(shortSigFile).valid, false, 'D2.5 Rejects <8 byte truncated signature');

    const truncatedIhdrFile = path.resolve(testDir, 'trunc_ihdr.png');
    fs.writeFileSync(truncatedIhdrFile, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d]),
      Buffer.from('IHDR', 'ascii'),
      Buffer.alloc(4)
    ]));
    assert.strictEqual(validatePngFrameFile(truncatedIhdrFile).valid, false, 'D2.6 Rejects truncated IHDR');

    // Corrupt IHDR CRC-32 & missing IDAT/IEND (mutate CRC byte in valid PNG)
    const validBytes = fs.readFileSync(validPngProbe);
    const badCrcBytes = Buffer.from(validBytes);
    badCrcBytes[30] ^= 0xff;
    const badCrcFile = path.resolve(testDir, 'bad_crc.png');
    fs.writeFileSync(badCrcFile, badCrcBytes);
    assert.strictEqual(validatePngFrameFile(badCrcFile).valid, false, 'D2.7 Rejects PNG with corrupted IHDR CRC-32');

    // Valid IHDR + CRC only, missing IDAT & IEND
    const ihdrOnlyFile = path.resolve(testDir, 'ihdr_only.png');
    fs.writeFileSync(ihdrOnlyFile, validBytes.subarray(0, 33));
    assert.strictEqual(validatePngFrameFile(ihdrOnlyFile).valid, false, 'D2.8 Rejects IHDR-only PNG missing IDAT and IEND');

    // Truncated mid-IDAT chunk (remove last 16 bytes including IEND)
    const truncIdatFile = path.resolve(testDir, 'trunc_idat.png');
    fs.writeFileSync(truncIdatFile, validBytes.subarray(0, validBytes.length - 16));
    assert.strictEqual(validatePngFrameFile(truncIdatFile).valid, false, 'D2.9 Rejects PNG truncated before IEND / inside chunk');

    // Directory path rejected safely
    assert.strictEqual(validatePngFrameFile(testDir).valid, false, 'D2.10 Rejects non-regular directory path safely');

    // Pipeline rejection of non-PNG output from FFmpeg (must NEVER reach Tesseract or claim NO_SIGNAL_DETECTED)
    const tesseractInvokeLog = path.resolve(testDir, 'tess_invoked_on_nonpng.log');
    const spyTessScript = path.resolve(testDir, 'spy_tess.sh');
    fs.writeFileSync(spyTessScript, `#!/bin/sh
echo "INVOKED:$1" >> "${tesseractInvokeLog}"
printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n"
printf "5\\t1\\t1\\t1\\t1\\t1\\t10\\t10\\t40\\t20\\t95\\tSHOULD_NOT_RUN\\n"
`, { mode: 0o755 });
    const nonPngFfmpegScript = path.resolve(testDir, 'ffmpeg_non_png.sh');
    fs.writeFileSync(nonPngFfmpegScript, `#!/bin/sh
OUT=""
for arg in "$@"; do OUT="$arg"; done
printf "NOT_A_PNG_HEADER_AT_ALL" > "$OUT"
exit 0
`, { mode: 0o755 });
    process.env.FFMPEG_PATH = nonPngFfmpegScript;
    process.env.TESSERACT_PATH = spyTessScript;
    const nonPngPipelineRes = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), { timestamps: [1] });
    assert.strictEqual(nonPngPipelineRes.status, 'ANALYSIS_UNAVAILABLE', 'D2.11 Non-PNG extracted frame rejected as ANALYSIS_UNAVAILABLE');
    assert.strictEqual(nonPngPipelineRes.extractionErrors?.[0]?.category, 'EMPTY_OUTPUT', 'D2.12 Non-PNG rejection categorized cleanly');
    assert.strictEqual(fs.existsSync(tesseractInvokeLog), false, 'D2.13 Tesseract was NEVER invoked on invalid non-PNG output');
    delete process.env.FFMPEG_PATH;
    process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    assertNoTempOcrDirLeak('D2.cleanup');
    console.log('  ✅ PASS: Strict PNG signature, IHDR, CRC-32, dimension, chunk & pipeline rejection verified');

    // -------------------------------------------------------------------------
    // J. STRICT OVERALL TIMEOUT BUDGET ENFORCEMENT
    // -------------------------------------------------------------------------
    console.log('\n[J. Strict Overall Timeout Budget Enforcement & Cleanup]');

    // J.1 Exhausted overall budget (timeoutMs=0) prevents ANY FFmpeg or Tesseract spawn
    const j1FfmpegLog = path.resolve(testDir, 'j1_ffmpeg.log');
    const j1FfmpegScript = path.resolve(testDir, 'j1_ffmpeg.sh');
    fs.writeFileSync(j1FfmpegScript, `#!/bin/sh
echo "CALLED" >> "${j1FfmpegLog}"
exit 0
`, { mode: 0o755 });
    process.env.FFMPEG_PATH = j1FfmpegScript;
    process.env.TESSERACT_PATH = spyTessScript;
    const j1Res = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), {
      timestamps: [0, 1, 2],
      timeoutMs: 0
    });
    assert.strictEqual(fs.existsSync(j1FfmpegLog), false, 'J.1 Exhausted timeoutMs=0 spawns zero FFmpeg processes');
    assert.strictEqual(fs.existsSync(tesseractInvokeLog), false, 'J.2 Exhausted timeoutMs=0 spawns zero Tesseract processes');
    assert.strictEqual(j1Res.executionStatus, 'FAILED', 'J.3 Exhausted budget returns FAILED executionStatus');
    assert.strictEqual(j1Res.status, 'INSUFFICIENT_EVIDENCE', 'J.4 Exhausted budget returns INSUFFICIENT_EVIDENCE');
    assert.ok(j1Res.failureReason?.includes('budget'), 'J.5 failureReason documents exhausted overall budget');
    assertNoTempOcrDirLeak('J1.cleanup');

    // J.2 Per-frame FFmpeg timeout (10000ms) CANNOT override tight overall deadline (220ms)
    const j2FfmpegCountLog = path.resolve(testDir, 'j2_ffmpeg_count.log');
    const j2HangFfmpeg = path.resolve(testDir, 'j2_hang_ffmpeg.sh');
    fs.writeFileSync(j2HangFfmpeg, `#!/bin/sh
echo "1" >> "${j2FfmpegCountLog}"
sleep 2
exit 0
`, { mode: 0o755 });
    process.env.FFMPEG_PATH = j2HangFfmpeg;
    const j2T0 = Date.now();
    const j2Res = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), {
      timestamps: [0, 1, 2],
      timeoutMs: 220,
      perFrameTimeoutMs: 10000
    });
    const j2Elapsed = Date.now() - j2T0;
    assert.ok(j2Elapsed < 1500, `J.6 FFmpeg capped by remaining overall budget (elapsed=${j2Elapsed}ms, << 10000ms perFrameTimeoutMs)`);
    assert.strictEqual(fs.readFileSync(j2FfmpegCountLog, 'utf8').trim().split('\n').length, 1, 'J.7 Stopped extraction loop after overall budget expired (only 1 FFmpeg launch)');
    assert.strictEqual(j2Res.executionStatus, 'FAILED', 'J.8 Overall timeout during extraction reports FAILED');
    assert.strictEqual(j2Res.framesSkipped, 2, 'J.9 Remaining 2 timestamps accounted as framesSkipped');
    assertNoTempOcrDirLeak('J2.cleanup');

    // J.3 Tesseract CANNOT exceed remaining overall budget & partial execution preserves frame 0 result
    const j3FastFfmpeg = path.resolve(testDir, 'j3_fast_ffmpeg.sh');
    fs.writeFileSync(j3FastFfmpeg, `#!/bin/sh
OUT=""
for arg in "$@"; do OUT="$arg"; done
cp "${validPngProbe}" "$OUT"
exit 0
`, { mode: 0o755 });
    const j3SlowSecondTess = path.resolve(testDir, 'j3_slow_second_tess.sh');
    const j3TessCountLog = path.resolve(testDir, 'j3_tess_count.log');
    fs.writeFileSync(j3SlowSecondTess, `#!/bin/sh
echo "$1" >> "${j3TessCountLog}"
if echo "$1" | grep -q "frame_001"; then
  sleep 2
  exit 0
fi
printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n"
printf "5\\t1\\t1\\t1\\t1\\t1\\t10\\t10\\t80\\t24\\t93\\tFRAME0_OK\\n"
`, { mode: 0o755 });
    process.env.FFMPEG_PATH = j3FastFfmpeg;
    process.env.TESSERACT_PATH = j3SlowSecondTess;
    const j3T0 = Date.now();
    const j3Res = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), {
      timestamps: [0, 1, 2],
      timeoutMs: 260,
      perFrameTimeoutMs: 10000
    });
    const j3Elapsed = Date.now() - j3T0;
    assert.ok(j3Elapsed < 1500, `J.10 Tesseract capped strictly by remaining overall budget (elapsed=${j3Elapsed}ms, << 15000ms)`);
    assert.strictEqual(j3Res.executionStatus, 'PARTIAL', 'J.11 Frame 0 succeeded before frame 1 exhausted overall budget -> PARTIAL');
    assert.strictEqual(j3Res.status, 'DETECTED', 'J.12 Partial execution preserves detected text from frame 0');
    assert.strictEqual(j3Res.framesSucceeded, 1, 'J.13 Exactly 1 frame succeeded');
    assert.strictEqual(j3Res.framesSkipped, 1, 'J.14 Frame 2 was never launched after overall budget expired');
    assert.strictEqual(fs.readFileSync(j3TessCountLog, 'utf8').trim().split('\n').length, 2, 'J.15 Exactly 2 Tesseract invocations (frame 0 & frame 1), frame 2 never started');
    assert.ok(j3Res.failureReason?.includes('Overall OCR execution budget'), 'J.16 Failure reason identifies overall execution budget exhaustion');
    assertNoTempOcrDirLeak('J3.cleanup');

    // J.4 Individual per-frame timeout (120ms) within generous overall budget (10000ms) continues to frame 1
    const j4PerFrameTimeoutFfmpeg = path.resolve(testDir, 'j4_per_frame.sh');
    fs.writeFileSync(j4PerFrameTimeoutFfmpeg, `#!/bin/sh
TS=""
PREV=""
OUT=""
for arg in "$@"; do
  if [ "$PREV" = "-ss" ]; then TS="$arg"; fi
  PREV="$arg"
  OUT="$arg"
done
if [ "$TS" = "0" ]; then
  sleep 2
  exit 0
fi
cp "${validPngProbe}" "$OUT"
exit 0
`, { mode: 0o755 });
    const j4FastTess = path.resolve(testDir, 'j4_fast_tess.sh');
    fs.writeFileSync(j4FastTess, `#!/bin/sh
printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n"
printf "5\\t1\\t1\\t1\\t1\\t1\\t10\\t10\\t80\\t24\\t91\\tFRAME1_OK\\n"
`, { mode: 0o755 });
    process.env.FFMPEG_PATH = j4PerFrameTimeoutFfmpeg;
    process.env.TESSERACT_PATH = j4FastTess;
    const j4Res = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), {
      timestamps: [0, 1],
      perFrameTimeoutMs: 120,
      timeoutMs: 10000
    });
    assert.strictEqual(j4Res.executionStatus, 'PARTIAL', 'J.17 Per-frame timeout on frame 0 still executes frame 1 -> PARTIAL');
    assert.strictEqual(j4Res.status, 'DETECTED', 'J.18 Frame 1 still produces DETECTED');
    assert.strictEqual(j4Res.extractionErrors?.[0]?.category, 'TIMEOUT', 'J.19 Frame 0 categorized as TIMEOUT');
    assert.ok(j4Res.failureReason?.includes('Individual frame timeout'), 'J.20 Failure reason distinguishes individual frame timeout from overall budget');
    assertNoTempOcrDirLeak('J4.cleanup');

    delete process.env.FFMPEG_PATH;
    process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    console.log('  ✅ PASS: Strict overall timeout enforcement & temp cleanup verified');

    // -------------------------------------------------------------------------
    // K. DIAGNOSTICS SANITIZATION (DIRECT + PIPELINE)
    // -------------------------------------------------------------------------
    console.log('\n[K. Diagnostics Sanitization (Unix, Windows, UNC, Secrets, Env, Bounds)]');
    const prevInjectedSecret = process.env.VIDEORISK_OCR_TEST_API_SECRET;
    process.env.VIDEORISK_OCR_TEST_API_SECRET = 'vr_custom_env_secret_987654321';
    try {
      const dirtyInput = [
        'Failed reading /Users/alice/private_vault/video.mp4',
        'Win C:\\Users\\Bob\\Confidential\\clip.mp4',
        'Quoted "D:\\My Private Folder\\bin\\ffmpeg.exe"',
        'UNC \\\\corp-fs01\\restricted\\finance\\raw.mp4 and //10.0.0.8/vault/doc.png',
        'HTTPS https://admin:Passw0rd!@api.service.local/hook and https://public.example.com/ok',
        'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123',
        'Keys sk_live_secret1234567890 AIzaSyDummyKey123456789012 ghp_1234567890abcdef1234',
        'Env STRIPE_SECRET_KEY=sk_test_000111222333 PASSWORD="my_secret_pw" and vr_custom_env_secret_987654321',
        '   extra   whitespace\n\rand   length   padding   ' + 'Z'.repeat(240)
      ].join(' | ');

      const cleaned = sanitizeOcrDiagnostic(dirtyInput, 220);
      assert.ok(!cleaned.includes('/Users/alice/private_vault'), 'K.1 Unix path directory redacted');
      assert.ok(!cleaned.includes('C:\\Users\\Bob'), 'K.2 Windows drive path directory redacted');
      assert.ok(!cleaned.includes('D:\\My Private Folder'), 'K.3 Quoted Windows path directory redacted');
      assert.ok(!cleaned.includes('\\\\corp-fs01\\restricted'), 'K.4 Windows UNC path redacted');
      assert.ok(!cleaned.includes('//10.0.0.8/vault'), 'K.5 Forward-slash UNC path redacted');
      assert.ok(!cleaned.includes('Passw0rd!'), 'K.6 URL credentials redacted');
      assert.ok(!cleaned.includes('eyJhbGciOiJIUzI1NiJ9'), 'K.7 Bearer JWT token redacted');
      assert.ok(!cleaned.includes('sk_live_secret1234567890'), 'K.8 Stripe secret key prefix redacted');
      assert.ok(!cleaned.includes('AIzaSyDummyKey'), 'K.9 Google API key prefix redacted');
      assert.ok(!cleaned.includes('ghp_1234567890'), 'K.10 GitHub token prefix redacted');
      assert.ok(!cleaned.includes('my_secret_pw'), 'K.11 Env/password assignment value redacted');
      assert.ok(!cleaned.includes('vr_custom_env_secret_987654321'), 'K.12 Active secret process.env value redacted');
      assert.ok(!cleaned.includes('\n') && !cleaned.includes('  '), 'K.13 Newlines and excessive whitespace collapsed');
      assert.ok(cleaned.length <= 220, 'K.14 Output bounded within maxLength');

      // Direct path-only check verifying HTTPS URLs are NOT mangled as UNC/Unix paths while paths preserve basenames
      const pathPreservation = sanitizeOcrDiagnostic('Win C:\\Users\\Bob\\clip.mp4 UNC \\\\srv\\share\\dir\\vid.mp4 Unix /home/bob/raw.mp4 OK https://example.com/status', 300);
      assert.ok(pathPreservation.includes('[path]/clip.mp4'), 'K.15 Windows basename preserved after redaction');
      assert.ok(pathPreservation.includes('[unc-path]/vid.mp4'), 'K.16 UNC basename preserved after redaction');
      assert.ok(pathPreservation.includes('[path]/raw.mp4'), 'K.17 Unix basename preserved after redaction');
      assert.ok(pathPreservation.includes('https://example.com/status'), 'K.18 Safe HTTPS URL preserved intact');

      // Pipeline diagnostic check: leaky stderr from FFmpeg must be sanitized across extractionErrors, frameDiagnostics, and failureReason
      const leakyFfmpeg = path.resolve(testDir, 'leaky_ffmpeg.sh');
      fs.writeFileSync(leakyFfmpeg, `#!/bin/sh
echo "Error at C:\\\\Users\\\\SecretUser\\\\video.mp4 and \\\\\\\\filesrv\\\\priv\\\\a.mp4 using Bearer tok_secret_abc12345 sk_live_abc123456789 API_KEY=topsecret_val vr_custom_env_secret_987654321" >&2
exit 1
`, { mode: 0o755 });
      process.env.FFMPEG_PATH = leakyFfmpeg;
      const leakyRes = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), { timestamps: [0] });
      const serializedDiag = JSON.stringify({
        failureReason: leakyRes.failureReason,
        extractionErrors: leakyRes.extractionErrors,
        frameDiagnostics: leakyRes.frameDiagnostics
      });
      assert.strictEqual(leakyRes.extractionErrors?.[0]?.category, 'NON_ZERO_EXIT', 'K.19 Error classification preserved despite sanitization');
      assert.ok(!serializedDiag.includes('C:\\Users\\SecretUser'), 'K.20 Pipeline diagnostics redact Windows path');
      assert.ok(!serializedDiag.includes('\\\\filesrv\\priv'), 'K.21 Pipeline diagnostics redact UNC path');
      assert.ok(!serializedDiag.includes('tok_secret_abc12345'), 'K.22 Pipeline diagnostics redact Bearer token');
      assert.ok(!serializedDiag.includes('sk_live_abc123456789'), 'K.23 Pipeline diagnostics redact Stripe API key');
      assert.ok(!serializedDiag.includes('topsecret_val'), 'K.24 Pipeline diagnostics redact API_KEY= value');
      assert.ok(!serializedDiag.includes('vr_custom_env_secret_987654321'), 'K.25 Pipeline diagnostics redact sensitive process.env secret');
      assert.ok(serializedDiag.includes('code 1'), 'K.26 Exit code remains visible for troubleshooting');

      // Missing TESSERACT_PATH failureReason must not leak private path
      process.env.TESSERACT_PATH = '/Users/private_admin/hidden_bin/tesseract';
      const missingTessPathRes = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), { timestamps: [0] });
      assert.ok(!missingTessPathRes.failureReason?.includes('/Users/private_admin/hidden_bin'), 'K.27 Missing TESSERACT_PATH failureReason redacts private directory');
      assert.ok(missingTessPathRes.failureReason?.includes('tesseract'), 'K.28 Missing TESSERACT_PATH preserves binary basename');
    } finally {
      if (prevInjectedSecret === undefined) delete process.env.VIDEORISK_OCR_TEST_API_SECRET;
      else process.env.VIDEORISK_OCR_TEST_API_SECRET = prevInjectedSecret;
      delete process.env.FFMPEG_PATH;
      process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    }
    assertNoTempOcrDirLeak('I.final');

    console.log('\n======================================================');
    console.log('🎉 ALL FULL-VIDEO OCR REGRESSION SCENARIOS (A–K) PASSED!');
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
