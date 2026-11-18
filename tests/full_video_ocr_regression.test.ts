import assert from 'assert';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  videoProcessor,
  validateTesseractTsv,
  validatePngFrameFile,
  sanitizeOcrDiagnostic,
  defaultMonotonicNowMs,
  MAX_OCR_PNG_ICCP_INFLATED_BYTES
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
    // H. LANGUAGE HANDLING (English, Pure Thai & Mixed Thai/English — MUST EXECUTE IN CI)
    // -------------------------------------------------------------------------
    console.log('\n[H. Language Handling (English, Thai & Mixed Thai/English)]');
    const resolveRequiredThaiTtfFont = (fcListStdout: string): string => {
      const candidates = fcListStdout
        .split(/\r?\n/)
        .map(l => l.split(':')[0].trim())
        .filter(f => f.endsWith('.ttf') && fs.existsSync(f));
      if (candidates.length === 0) {
        throw new Error('Thai TTF font missing: install fonts-thai-tlwg (or Noto Thai) for FFmpeg drawtext Thai OCR verification.');
      }
      const preferred = candidates.find(f => /(?:Garuda|Loma|Waree|NotoSansThai-Regular)\.ttf$/i.test(f));
      return preferred || candidates[0];
    };

    assert.throws(
      () => resolveRequiredThaiTtfFont(''),
      /Thai TTF font missing/,
      'H.0 Negative guard: missing Thai font throws explicit failure instead of skipping'
    );

    const { stdout: fcOut } = await execFileAsync('fc-list', [':lang=th', 'file']);
    const thaiFontFile = resolveRequiredThaiTtfFont(fcOut);
    assert.ok(thaiFontFile && fs.existsSync(thaiFontFile), 'H.0b Thai TTF font present and readable on host');

    // Pure Thai text overlay OCR
    const pureThaiVideo = path.resolve(testDir, 'pure_thai_text.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=#111827:s=640x360:rate=10:duration=2,drawtext=fontfile=${thaiFontFile}:text='ทดสอบ':fontsize=54:fontcolor=white:box=1:boxcolor=black@0.95:boxborderw=12:x=(w-text_w)/2:y=(h-text_h)/2`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      pureThaiVideo
    ]);
    const pureThaiRes = await videoProcessor.performVideoOcr(pureThaiVideo, baseMeta('pure_thai_text.mp4', 2.0), {
      timestamps: [1],
      languages: 'tha'
    });
    assert.strictEqual(pureThaiRes.status, 'DETECTED', 'H.1 Pure Thai overlay detected with tha');
    assert.ok(pureThaiRes.allExtractedText.some(t => /[\u0E00-\u0E7F]/.test(t)), `H.2 Recognized Thai Unicode script (got: ${JSON.stringify(pureThaiRes.allExtractedText)})`);

    // Mixed Thai + English text overlay OCR
    const thaiMixedVideo = path.resolve(testDir, 'thai_mixed_text.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=#111827:s=640x360:rate=10:duration=2,drawtext=fontfile=${thaiFontFile}:text='ทดสอบ POLICY':fontsize=48:fontcolor=white:box=1:boxcolor=black@0.95:boxborderw=12:x=(w-text_w)/2:y=(h-text_h)/2`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      thaiMixedVideo
    ]);
    const thaiMixedRes = await videoProcessor.performVideoOcr(thaiMixedVideo, baseMeta('thai_mixed_text.mp4', 2.0), {
      timestamps: [1],
      languages: 'eng+tha'
    });
    assert.strictEqual(thaiMixedRes.status, 'DETECTED', 'H.3 Mixed Thai+English overlay detected with eng+tha');
    const mixedJoined = thaiMixedRes.allExtractedText.join(' ');
    assert.ok(/POLICY/.test(mixedJoined), `H.4 Mixed script OCR extracted English token POLICY (got: ${mixedJoined})`);
    assert.ok(/[\u0E00-\u0E7F]/.test(mixedJoined), `H.5 Mixed script OCR extracted Thai Unicode glyphs (got: ${mixedJoined})`);
    console.log(`  ✅ PASS: English, Pure Thai & Mixed Thai/English (${path.basename(thaiFontFile)}) OCR verified`);

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

    // Full PNG Integrity Contract helpers & additional edge vectors (D2.14–D2.23)
    const pngCrc32 = (b: Buffer): number => {
      let c = 0xffffffff;
      for (let i = 0; i < b.length; i++) {
        c ^= b[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
      }
      return (c ^ 0xffffffff) >>> 0;
    };
    const mkPngChunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(pngCrc32(body), 0);
      return Buffer.concat([len, body, crc]);
    };
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const mkIhdr = (w: number, h: number, bitDepth = 8, colorType = 2, interlace = 0): Buffer => {
      const d = Buffer.alloc(13);
      d.writeUInt32BE(w, 0);
      d.writeUInt32BE(h, 4);
      d[8] = bitDepth;
      d[9] = colorType;
      d[10] = 0;
      d[11] = 0;
      d[12] = interlace;
      return d;
    };

    // D2.14 Corrupt IDAT CRC-32 in valid PNG -> PNG_CRC_FAILURE
    const badIdatCrcBytes = Buffer.from(validBytes);
    // Find IDAT chunk offset (after signature + IHDR = 33, advance through chunks until IDAT)
    {
      let pOff = 33;
      while (pOff + 12 <= badIdatCrcBytes.length) {
        const cLen = badIdatCrcBytes.readUInt32BE(pOff);
        const cType = badIdatCrcBytes.subarray(pOff + 4, pOff + 8).toString('ascii');
        if (cType === 'IDAT') {
          badIdatCrcBytes[pOff + 8 + cLen] ^= 0xff; // Flip IDAT CRC byte
          break;
        }
        pOff += 12 + cLen;
      }
    }
    const badIdatCrcFile = path.resolve(testDir, 'bad_idat_crc.png');
    fs.writeFileSync(badIdatCrcFile, badIdatCrcBytes);
    const badIdatCrcRes = validatePngFrameFile(badIdatCrcFile);
    assert.strictEqual(badIdatCrcRes.valid, false, 'D2.14a Rejects IDAT CRC-32 mismatch');
    assert.strictEqual(badIdatCrcRes.errorClass, 'PNG_CRC_FAILURE', 'D2.14b Classifies IDAT CRC mismatch as PNG_CRC_FAILURE');

    // D2.15 Trailing bytes after IEND -> INVALID_PNG_STRUCTURE
    const trailingBytesFile = path.resolve(testDir, 'trailing_after_iend.png');
    fs.writeFileSync(trailingBytesFile, Buffer.concat([validBytes, Buffer.from('JUNK_TRAILER')]));
    const trailingRes = validatePngFrameFile(trailingBytesFile);
    assert.strictEqual(trailingRes.valid, false, 'D2.15a Rejects trailing bytes after IEND');
    assert.strictEqual(trailingRes.errorClass, 'INVALID_PNG_STRUCTURE', 'D2.15b Classifies trailing bytes as INVALID_PNG_STRUCTURE');

    // D2.16 Non-contiguous IDAT chunks -> INVALID_PNG_STRUCTURE
    const smallRaw = Buffer.from([0, 10, 20, 30, 0, 40, 50, 60]); // 2x1 RGB: 2 scanlines? Wait: 1x2 RGB = 2*(1+3)=8 bytes
    const nonContigIdatFile = path.resolve(testDir, 'non_contig_idat.png');
    const compFull = zlib.deflateSync(smallRaw);
    const splitAt = Math.max(1, Math.floor(compFull.length / 2));
    fs.writeFileSync(
      nonContigIdatFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 2, 8, 2)),
        mkPngChunk('IDAT', compFull.subarray(0, splitAt)),
        mkPngChunk('tEXt', Buffer.from('Comment\0split')),
        mkPngChunk('IDAT', compFull.subarray(splitAt)),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    const nonContigRes = validatePngFrameFile(nonContigIdatFile);
    assert.strictEqual(nonContigRes.valid, false, 'D2.16a Rejects non-contiguous IDAT chunks');
    assert.strictEqual(nonContigRes.errorClass, 'INVALID_PNG_STRUCTURE', 'D2.16b Classifies non-contiguous IDAT as INVALID_PNG_STRUCTURE');

    // D2.17 Corrupt zlib IDAT payload (with valid CRC!) -> PNG_DECOMPRESSION_FAILURE
    const corruptZlibFile = path.resolve(testDir, 'corrupt_zlib_valid_crc.png');
    fs.writeFileSync(
      corruptZlibFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 2, 8, 2)),
        mkPngChunk('IDAT', Buffer.from('NOT_VALID_ZLIB_STREAM')),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    const corruptZlibRes = validatePngFrameFile(corruptZlibFile);
    assert.strictEqual(corruptZlibRes.valid, false, 'D2.17a Rejects corrupt zlib stream even with valid chunk CRC');
    assert.strictEqual(corruptZlibRes.errorClass, 'PNG_DECOMPRESSION_FAILURE', 'D2.17b Classifies corrupt zlib as PNG_DECOMPRESSION_FAILURE');

    // D2.18 Decompression bomb (1x1 RGB expects 4 bytes; zlib expands to 64 KB) -> PNG_DECOMPRESSION_FAILURE
    const bombFile = path.resolve(testDir, 'zlib_bomb.png');
    fs.writeFileSync(
      bombFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('IDAT', zlib.deflateSync(Buffer.alloc(65536))),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    const bombRes = validatePngFrameFile(bombFile);
    assert.strictEqual(bombRes.valid, false, 'D2.18a Rejects zlib decompression bomb exceeding IHDR expected length');
    assert.strictEqual(bombRes.errorClass, 'PNG_DECOMPRESSION_FAILURE', 'D2.18b Classifies decompression bomb as PNG_DECOMPRESSION_FAILURE');

    // D2.19 Invalid scanline filter byte (>4) inside valid compressed IDAT -> PNG_DECOMPRESSION_FAILURE
    const badFilterFile = path.resolve(testDir, 'bad_filter_byte.png');
    fs.writeFileSync(
      badFilterFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('IDAT', zlib.deflateSync(Buffer.from([9, 100, 110, 120]))),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    const badFilterRes = validatePngFrameFile(badFilterFile);
    assert.strictEqual(badFilterRes.valid, false, 'D2.19a Rejects invalid scanline filter byte > 4');
    assert.strictEqual(badFilterRes.errorClass, 'PNG_DECOMPRESSION_FAILURE', 'D2.19b Classifies invalid scanline filter byte as PNG_DECOMPRESSION_FAILURE');

    // D2.20 Indexed PNG (colorType=3) without required PLTE chunk -> INVALID_PNG_STRUCTURE
    const missingPlteFile = path.resolve(testDir, 'missing_plte.png');
    fs.writeFileSync(
      missingPlteFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 3)),
        mkPngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0]))),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    const missingPlteRes = validatePngFrameFile(missingPlteFile);
    assert.strictEqual(missingPlteRes.valid, false, 'D2.20a Rejects indexed PNG without PLTE');
    assert.strictEqual(missingPlteRes.errorClass, 'INVALID_PNG_STRUCTURE', 'D2.20b Classifies missing PLTE as INVALID_PNG_STRUCTURE');

    // D2.21 Valid Adam7 interlaced PNG generated cleanly by FFmpeg passes Full PNG validation
    const adam7Probe = path.resolve(testDir, 'adam7_valid.png');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=white:s=33x17:d=1',
      '-vframes', '1', '-pred', 'none', '-vf', 'format=rgb24', '-interlace', '1', adam7Probe
    ]).catch(async () => {
      // Fallback: synthesize exact spec-valid 3x3 Adam7 RGB PNG
      // Passes for 3x3: P1(0,0,8,8):1x1(4B), P2:0, P3:0, P4(0,2,4,4):1x1(4B)? No: w=3,h=3 -> P1(0,0)=1x1(4B); P4(0,2):startCol=2<3->1x1(4B); P5(2,0):startRow=2,cols 0,2 -> passW=1,passH=1(4B); wait P5 colInc=2 so cols 0,2 => passW=2 (1+6=7B); P6(0,1,2,2): passW=1, passH=2 => 2*(1+3)=8B; P7(1,0,2,1): startRow=1,cols 0..2 => passW=3,passH=1 => 1+9=10B. Total = 4+4+7+8+10 = 33B
      fs.writeFileSync(
        adam7Probe,
        Buffer.concat([
          PNG_SIG,
          mkPngChunk('IHDR', mkIhdr(3, 3, 8, 2, 1)),
          mkPngChunk('IDAT', zlib.deflateSync(Buffer.alloc(33))),
          mkPngChunk('IEND', Buffer.alloc(0))
        ])
      );
    });
    const adam7Res = validatePngFrameFile(adam7Probe);
    assert.strictEqual(adam7Res.valid, true, `D2.21 Valid Adam7 interlaced PNG accepted (${adam7Res.reason || 'ok'})`);

    // D2.22 Pipeline rejection on corrupt-CRC IDAT sets PNG_CRC_FAILURE and NEVER invokes Tesseract
    if (fs.existsSync(tesseractInvokeLog)) fs.unlinkSync(tesseractInvokeLog);
    const badCrcFfmpeg = path.resolve(testDir, 'ffmpeg_bad_idat_crc.sh');
    fs.writeFileSync(badCrcFfmpeg, `#!/bin/sh
OUT=""
for arg in "$@"; do OUT="$arg"; done
cp "${badIdatCrcFile}" "$OUT"
exit 0
`, { mode: 0o755 });
    process.env.FFMPEG_PATH = badCrcFfmpeg;
    process.env.TESSERACT_PATH = spyTessScript;
    const crcFailPipelineRes = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), { timestamps: [1] });
    assert.strictEqual(crcFailPipelineRes.status, 'ANALYSIS_UNAVAILABLE', 'D2.22a Bad IDAT CRC rejected as ANALYSIS_UNAVAILABLE');
    assert.strictEqual(crcFailPipelineRes.failureClassification, 'OCR_INPUT_FAILURE', 'D2.22b Pipeline failureClassification is OCR_INPUT_FAILURE');
    assert.strictEqual(crcFailPipelineRes.extractionErrors?.[0]?.classification, 'PNG_CRC_FAILURE', 'D2.22c Frame error classification is PNG_CRC_FAILURE');
    assert.strictEqual(fs.existsSync(tesseractInvokeLog), false, 'D2.22d Tesseract never invoked on corrupt PNG CRC');

    delete process.env.FFMPEG_PATH;
    process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    assertNoTempOcrDirLeak('D2.full_integrity.cleanup');

    // C1: Unknown critical chunks vs known critical & unknown ancillary chunks
    const mkChunkRawType = (rawTypeBytes: number[], data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const body = Buffer.concat([Buffer.from(rawTypeBytes), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(pngCrc32(body), 0);
      return Buffer.concat([len, body, crc]);
    };

    const valid1x1RgbIdat = zlib.deflateSync(Buffer.from([0, 10, 20, 30]));
    const unknownCritFile = path.resolve(testDir, 'c1_unknown_critical.png');
    fs.writeFileSync(
      unknownCritFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('FAKE', Buffer.from([1, 2, 3, 4])),
        mkPngChunk('IDAT', valid1x1RgbIdat),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    const unknownCritRes = validatePngFrameFile(unknownCritFile);
    assert.strictEqual(unknownCritRes.valid, false, 'D2.23a Rejects unknown critical chunk FAKE');
    assert.strictEqual(unknownCritRes.errorClass, 'INVALID_PNG_STRUCTURE', 'D2.23b Unknown critical chunk classified as INVALID_PNG_STRUCTURE');

    const unknownAncillaryFile = path.resolve(testDir, 'c1_unknown_ancillary.png');
    fs.writeFileSync(
      unknownAncillaryFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('tESt', Buffer.from('ancillary-ok')),
        mkPngChunk('IDAT', valid1x1RgbIdat),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(unknownAncillaryFile).valid, true, 'D2.25 Allows valid unknown ancillary chunk tESt before IDAT');

    // PLTE after IDAT and PLTE on grayscale colorType 0
    const plteAfterIdatFile = path.resolve(testDir, 'c1_plte_after_idat.png');
    fs.writeFileSync(
      plteAfterIdatFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('IDAT', valid1x1RgbIdat),
        mkPngChunk('PLTE', Buffer.from([255, 0, 0])),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(plteAfterIdatFile).valid, false, 'D2.26a Rejects PLTE after IDAT');

    const plteOnGrayFile = path.resolve(testDir, 'c1_plte_grayscale.png');
    fs.writeFileSync(
      plteOnGrayFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 0)),
        mkPngChunk('PLTE', Buffer.from([255, 0, 0])),
        mkPngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 42]))),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(plteOnGrayFile).valid, false, 'D2.26b Rejects PLTE on grayscale colorType 0');

    // C2: Reserved chunk-type bit & chunk-type encoding validation
    const validTextChunkFile = path.resolve(testDir, 'c2_valid_reserved_bit.png');
    fs.writeFileSync(
      validTextChunkFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('tEXt', Buffer.from('Software\0VideoRisk')),
        mkPngChunk('IDAT', valid1x1RgbIdat),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(validTextChunkFile).valid, true, 'D2.27 Accepts valid uppercase 3rd char chunk type (tEXt)');

    for (const badReserved of ['tExt', 'IDaT', 'plte', 'ABcD']) {
      const badReservedFile = path.resolve(testDir, `c2_bad_reserved_${badReserved}.png`);
      const payload = badReserved === 'IDaT' ? valid1x1RgbIdat : Buffer.from('test');
      fs.writeFileSync(
        badReservedFile,
        Buffer.concat([
          PNG_SIG,
          mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
          mkPngChunk(badReserved, payload),
          ...(badReserved === 'IDaT' ? [] : [mkPngChunk('IDAT', valid1x1RgbIdat)]),
          mkPngChunk('IEND', Buffer.alloc(0))
        ])
      );
      const r = validatePngFrameFile(badReservedFile);
      assert.strictEqual(r.valid, false, `D2.28a Rejects lowercase reserved bit in '${badReserved}'`);
      assert.strictEqual(r.errorClass, 'INVALID_PNG_STRUCTURE', `D2.28b '${badReserved}' classified as INVALID_PNG_STRUCTURE`);
    }

    const safeToCopyAncillaryFile = path.resolve(testDir, 'c2_valid_safe_to_copy_ancillary.png');
    fs.writeFileSync(
      safeToCopyAncillaryFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('plTe', Buffer.from('safe-to-copy')),
        mkPngChunk('IDAT', valid1x1RgbIdat),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(safeToCopyAncillaryFile).valid, true, "D2.28c Accepts unknown ancillary 'plTe' (uppercase 3rd byte, lowercase safe-to-copy 4th byte)");

    // Non-ASCII high-bit byte chunk type (must NOT bypass via .toString('ascii') masking!)
    const nonAsciiChunkFile = path.resolve(testDir, 'c2_non_ascii_highbit.png');
    fs.writeFileSync(
      nonAsciiChunkFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkChunkRawType([0x74, 0x45 | 0x80, 0x58, 0x74], Buffer.from('highbit')),
        mkPngChunk('IDAT', valid1x1RgbIdat),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(nonAsciiChunkFile).valid, false, 'D2.29 Rejects non-ASCII high-bit byte in chunk type');

    // Numeric / punctuation chars in chunk type
    for (const [label, rawBytes] of [
      ['digit', [0x31, 0x44, 0x41, 0x54]],
      ['hyphen', [0x74, 0x2d, 0x58, 0x74]],
      ['underscore', [0x74, 0x5f, 0x58, 0x74]],
      ['space', [0x74, 0x20, 0x58, 0x74]]
    ] as Array<[string, number[]]>) {
      const malformedTagFile = path.resolve(testDir, `c2_malformed_${label}.png`);
      fs.writeFileSync(
        malformedTagFile,
        Buffer.concat([
          PNG_SIG,
          mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
          mkChunkRawType(rawBytes, Buffer.from('bad')),
          mkPngChunk('IDAT', valid1x1RgbIdat),
          mkPngChunk('IEND', Buffer.alloc(0))
        ])
      );
      assert.strictEqual(validatePngFrameFile(malformedTagFile).valid, false, `D2.30 Rejects ${label} in chunk type`);
    }

    // C3: Strict complete zlib stream consumption (reject trailing bytes inside concatenated IDAT)
    const trail1ByteFile = path.resolve(testDir, 'c3_trailing_1byte.png');
    fs.writeFileSync(
      trail1ByteFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('IDAT', Buffer.concat([valid1x1RgbIdat, Buffer.from([0x00])])),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    const trail1Res = validatePngFrameFile(trail1ByteFile);
    assert.strictEqual(trail1Res.valid, false, 'D2.32a Rejects 1 trailing byte after valid zlib stream');
    assert.strictEqual(trail1Res.errorClass, 'PNG_DECOMPRESSION_FAILURE', 'D2.32b 1 trailing byte classified as PNG_DECOMPRESSION_FAILURE');

    const trailMultiFile = path.resolve(testDir, 'c3_trailing_multi_and_double_stream.png');
    fs.writeFileSync(
      trailMultiFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('IDAT', Buffer.concat([valid1x1RgbIdat, valid1x1RgbIdat])),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    const trailMultiRes = validatePngFrameFile(trailMultiFile);
    assert.strictEqual(trailMultiRes.valid, false, 'D2.33a Rejects trailing bytes / concatenated second zlib stream in IDAT');
    assert.strictEqual(trailMultiRes.errorClass, 'PNG_DECOMPRESSION_FAILURE', 'D2.33b Trailing second stream classified as PNG_DECOMPRESSION_FAILURE');

    const truncZlibFile = path.resolve(testDir, 'c3_truncated_zlib.png');
    fs.writeFileSync(
      truncZlibFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('IDAT', valid1x1RgbIdat.subarray(0, valid1x1RgbIdat.length - 2)),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    const truncZlibRes = validatePngFrameFile(truncZlibFile);
    assert.strictEqual(truncZlibRes.valid, false, 'D2.34a Rejects truncated zlib stream inside IDAT');
    assert.strictEqual(truncZlibRes.errorClass, 'PNG_DECOMPRESSION_FAILURE', 'D2.34b Truncated zlib classified as PNG_DECOMPRESSION_FAILURE');

    const multiIdatValidFile = path.resolve(testDir, 'c3_multi_idat_valid.png');
    const splitZlibAt = Math.floor(valid1x1RgbIdat.length / 2);
    fs.writeFileSync(
      multiIdatValidFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('IDAT', valid1x1RgbIdat.subarray(0, splitZlibAt)),
        mkPngChunk('IDAT', valid1x1RgbIdat.subarray(splitZlibAt)),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(multiIdatValidFile).valid, true, 'D2.35 Accepts multiple contiguous IDAT chunks forming 1 valid zlib stream');

    const multiIdatTrailingFile = path.resolve(testDir, 'c3_multi_idat_trailing.png');
    fs.writeFileSync(
      multiIdatTrailingFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('IDAT', valid1x1RgbIdat.subarray(0, splitZlibAt)),
        mkPngChunk('IDAT', Buffer.concat([valid1x1RgbIdat.subarray(splitZlibAt), Buffer.from([0xff])])),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(multiIdatTrailingFile).valid, false, 'D2.36 Rejects trailing byte in final chunk of multi-IDAT zlib stream');

    // C4: PLTE, tRNS, ancillary chunk semantics, and indexed-color pixel bounds after unfiltering
    const validIndexedTrnsFile = path.resolve(testDir, 'c4_valid_indexed_trns.png');
    fs.writeFileSync(
      validIndexedTrnsFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(2, 1, 8, 3)),
        mkPngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])),
        mkPngChunk('tRNS', Buffer.from([255, 128])),
        // Sub filter: pixel0 = 0 (filt 0), pixel1 = 1 (filt 1 -> 0 + 1 = 1 < 2 entries)
        mkPngChunk('IDAT', zlib.deflateSync(Buffer.from([1, 0, 1]))),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(validIndexedTrnsFile).valid, true, 'D2.37a Accepts valid indexed PNG with PLTE, tRNS, and unfiltered indices in bounds');

    // tRNS forbidden on RGBA (colorType=6) and wrong lengths on 0/2/3
    const badTrnsRgbaFile = path.resolve(testDir, 'c4_bad_trns_rgba.png');
    fs.writeFileSync(
      badTrnsRgbaFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 6)),
        mkPngChunk('tRNS', Buffer.from([0, 0])),
        mkPngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 10, 20, 30, 255]))),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(badTrnsRgbaFile).valid, false, 'D2.38a Rejects tRNS on RGBA colorType 6');

    const badTrnsOverflowFile = path.resolve(testDir, 'c4_bad_trns_overflow.png');
    fs.writeFileSync(
      badTrnsOverflowFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 3)),
        mkPngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])),
        mkPngChunk('tRNS', Buffer.from([255, 255, 255])), // 3 entries > 2 PLTE entries
        mkPngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0]))),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(badTrnsOverflowFile).valid, false, 'D2.38b Rejects tRNS exceeding PLTE entry count');

    const badTrnsGrayLenFile = path.resolve(testDir, 'c4_bad_trns_gray_len.png');
    fs.writeFileSync(
      badTrnsGrayLenFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 0)),
        mkPngChunk('tRNS', Buffer.from([0, 1, 2])), // expected 2
        mkPngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 42]))),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(badTrnsGrayLenFile).valid, false, 'D2.38c Rejects malformed tRNS length for grayscale');

    // Indexed PNG out-of-range pixel AFTER Sub unfiltering ([filter=1, 1, 1] -> pixel1 = 1+1 = 2 >= 2 PLTE entries!)
    const badIdxSubUnfilterFile = path.resolve(testDir, 'c4_indexed_oob_after_sub.png');
    fs.writeFileSync(
      badIdxSubUnfilterFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(2, 1, 8, 3)),
        mkPngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])),
        mkPngChunk('IDAT', zlib.deflateSync(Buffer.from([1, 1, 1]))),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    const badIdxRes = validatePngFrameFile(badIdxSubUnfilterFile);
    assert.strictEqual(badIdxRes.valid, false, 'D2.39a Rejects indexed PNG whose unfiltered pixel index exceeds PLTE size');
    assert.strictEqual(badIdxRes.errorClass, 'INVALID_PNG_STRUCTURE', 'D2.39b Out-of-range palette index classified as INVALID_PNG_STRUCTURE');

    // Sub-byte 4-bit indexed PNG out-of-range check
    const badIdx4BitFile = path.resolve(testDir, 'c4_indexed_4bit_oob.png');
    fs.writeFileSync(
      badIdx4BitFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(2, 1, 4, 3)),
        mkPngChunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])), // max valid index 1
        mkPngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0x05]))), // pixel0=0, pixel1=5 >= 2
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(badIdx4BitFile).valid, false, 'D2.39c Rejects out-of-range 4-bit indexed pixel nibble');

    // Bad ancillary semantics (sRGB intent > 3, bKGD index out of palette range)
    const badSrgbIntentFile = path.resolve(testDir, 'c4_bad_srgb_intent.png');
    fs.writeFileSync(
      badSrgbIntentFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 2)),
        mkPngChunk('sRGB', Buffer.from([9])),
        mkPngChunk('IDAT', valid1x1RgbIdat),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(badSrgbIntentFile).valid, false, 'D2.40 Rejects invalid sRGB rendering intent');

    // Pipeline isolation check: trailing zlib byte & unknown critical chunk never reach Tesseract
    if (fs.existsSync(tesseractInvokeLog)) fs.unlinkSync(tesseractInvokeLog);
    const trailZlibFfmpeg = path.resolve(testDir, 'ffmpeg_trail_zlib.sh');
    fs.writeFileSync(trailZlibFfmpeg, `#!/bin/sh
OUT=""
for arg in "$@"; do OUT="$arg"; done
cp "${trail1ByteFile}" "$OUT"
exit 0
`, { mode: 0o755 });
    process.env.FFMPEG_PATH = trailZlibFfmpeg;
    process.env.TESSERACT_PATH = spyTessScript;
    const trailPipelineRes = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), { timestamps: [1] });
    assert.strictEqual(trailPipelineRes.status, 'ANALYSIS_UNAVAILABLE', 'D2.42a Trailing zlib PNG rejected as ANALYSIS_UNAVAILABLE');
    assert.strictEqual(trailPipelineRes.failureClassification, 'OCR_INPUT_FAILURE', 'D2.42b Pipeline classifies trailing zlib as OCR_INPUT_FAILURE');
    assert.strictEqual(trailPipelineRes.extractionErrors?.[0]?.classification, 'PNG_DECOMPRESSION_FAILURE', 'D2.42c Frame error classified as PNG_DECOMPRESSION_FAILURE');
    assert.strictEqual(fs.existsSync(tesseractInvokeLog), false, 'D2.42d Tesseract never invoked on trailing-zlib PNG');

    delete process.env.FFMPEG_PATH;
    process.env.TESSERACT_PATH = '/usr/bin/tesseract';

    // -------------------------------------------------------------------------
    // C4.1 – C4.6: Full PNG Semantic Validation (tRNS, sBIT, gAMA, iCCP, bKGD, Mutual Exclusion)
    // -------------------------------------------------------------------------
    const mkCustomPng = (
      name: string,
      ihdr: { w: number; h: number; bd: number; ct: number },
      extraChunks: Array<{ type: string; data: Buffer }>,
      idatRawScanlines: Buffer
    ) => {
      const p = path.resolve(testDir, name);
      fs.writeFileSync(
        p,
        Buffer.concat([
          PNG_SIG,
          mkPngChunk('IHDR', mkIhdr(ihdr.w, ihdr.h, ihdr.bd, ihdr.ct)),
          ...extraChunks.map((c) => mkPngChunk(c.type, c.data)),
          mkPngChunk('IDAT', zlib.deflateSync(idatRawScanlines)),
          mkPngChunk('IEND', Buffer.alloc(0))
        ])
      );
      return p;
    };

    const u16be = (vals: number[]): Buffer => {
      const out = Buffer.alloc(vals.length * 2);
      vals.forEach((v, i) => out.writeUInt16BE(v, i * 2));
      return out;
    };

    // C4.1 tRNS sample bit-depth bounds, forbidden alpha types, ordering, duplicates
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c41_gray4_trns_max.png', { w: 1, h: 1, bd: 4, ct: 0 }, [{ type: 'tRNS', data: u16be([15]) }], Buffer.from([0, 0x10]))).valid,
      true,
      'D2.43a tRNS grayscale 4-bit legal max 15 accepted'
    );
    const trnsGray4Oob = validatePngFrameFile(
      mkCustomPng('c41_gray4_trns_oob.png', { w: 1, h: 1, bd: 4, ct: 0 }, [{ type: 'tRNS', data: u16be([16]) }], Buffer.from([0, 0x10]))
    );
    assert.strictEqual(trnsGray4Oob.valid, false, 'D2.43b tRNS grayscale 4-bit 16 rejected');
    assert.strictEqual(trnsGray4Oob.errorClass, 'INVALID_PNG_STRUCTURE');

    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c41_gray16_trns_max.png', { w: 1, h: 1, bd: 16, ct: 0 }, [{ type: 'tRNS', data: u16be([65535]) }], Buffer.from([0, 0, 0]))).valid,
      true,
      'D2.43c tRNS grayscale 16-bit max 65535 accepted'
    );
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c41_rgb8_trns_max.png', { w: 1, h: 1, bd: 8, ct: 2 }, [{ type: 'tRNS', data: u16be([0, 255, 128]) }], Buffer.from([0, 1, 2, 3]))).valid,
      true,
      'D2.43d tRNS RGB 8-bit legal max 255 accepted'
    );
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c41_rgb8_trns_oob.png', { w: 1, h: 1, bd: 8, ct: 2 }, [{ type: 'tRNS', data: u16be([0, 256, 0]) }], Buffer.from([0, 1, 2, 3]))).valid,
      false,
      'D2.43e tRNS RGB 8-bit sample 256 rejected'
    );
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c41_gray_alpha_trns.png', { w: 1, h: 1, bd: 8, ct: 4 }, [{ type: 'tRNS', data: u16be([0]) }], Buffer.from([0, 10, 255]))).valid,
      false,
      'D2.43f tRNS forbidden on grayscale+alpha colorType 4'
    );
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c41_dup_trns.png',
          { w: 1, h: 1, bd: 8, ct: 3 },
          [
            { type: 'PLTE', data: Buffer.from([0, 0, 0, 255, 255, 255]) },
            { type: 'tRNS', data: Buffer.from([255]) },
            { type: 'tRNS', data: Buffer.from([128]) }
          ],
          Buffer.from([0, 0])
        )
      ).valid,
      false,
      'D2.43g Duplicate tRNS rejected'
    );
    const trnsAfterIdatFile = path.resolve(testDir, 'c41_trns_after_idat.png');
    fs.writeFileSync(
      trnsAfterIdatFile,
      Buffer.concat([
        PNG_SIG,
        mkPngChunk('IHDR', mkIhdr(1, 1, 8, 0)),
        mkPngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 42]))),
        mkPngChunk('tRNS', u16be([0])),
        mkPngChunk('IEND', Buffer.alloc(0))
      ])
    );
    assert.strictEqual(validatePngFrameFile(trnsAfterIdatFile).valid, false, 'D2.43h tRNS after IDAT rejected');

    // C4.2 sBIT across all supported colorTypes (0, 2, 3, 4, 6)
    const sbitValidCases: Array<{ ct: number; bd: number; sbit: number[]; raw: number[]; extra?: Array<{ type: string; data: Buffer }> }> = [
      { ct: 0, bd: 4, sbit: [4], raw: [0, 0x10] },
      { ct: 2, bd: 8, sbit: [5, 6, 5], raw: [0, 1, 2, 3] },
      { ct: 3, bd: 4, sbit: [8, 8, 8], raw: [0, 0x00], extra: [{ type: 'PLTE', data: Buffer.from([0, 0, 0]) }] },
      { ct: 4, bd: 8, sbit: [8, 1], raw: [0, 10, 255] },
      { ct: 6, bd: 16, sbit: [12, 12, 12, 16], raw: [0, 0, 1, 0, 2, 0, 3, 0, 4] }
    ];
    for (const sc of sbitValidCases) {
      const res = validatePngFrameFile(
        mkCustomPng(
          `c42_sbit_valid_ct${sc.ct}_bd${sc.bd}.png`,
          { w: 1, h: 1, bd: sc.bd, ct: sc.ct },
          [{ type: 'sBIT', data: Buffer.from(sc.sbit) }, ...(sc.extra || [])],
          Buffer.from(sc.raw)
        )
      );
      assert.strictEqual(res.valid, true, `D2.44a Valid sBIT accepted for colorType=${sc.ct}, bitDepth=${sc.bd}`);
    }
    for (const badSbit of [
      { label: 'zero_gray', ct: 0, bd: 8, sbit: [0], raw: [0, 42] },
      { label: 'oob_gray4', ct: 0, bd: 4, sbit: [5], raw: [0, 0x10] },
      { label: 'wrong_len_gray', ct: 0, bd: 8, sbit: [8, 8], raw: [0, 42] },
      { label: 'zero_rgb', ct: 2, bd: 8, sbit: [8, 0, 8], raw: [0, 1, 2, 3] },
      { label: 'oob_rgb', ct: 2, bd: 8, sbit: [8, 9, 8], raw: [0, 1, 2, 3] },
      { label: 'oob_indexed_plte8', ct: 3, bd: 4, sbit: [8, 9, 8], raw: [0, 0x00], extra: [{ type: 'PLTE', data: Buffer.from([0, 0, 0]) }] },
      { label: 'oob_grayalpha', ct: 4, bd: 8, sbit: [8, 9], raw: [0, 10, 255] },
      { label: 'oob_rgba', ct: 6, bd: 8, sbit: [8, 8, 8, 9], raw: [0, 1, 2, 3, 255] },
      { label: 'wrong_len_rgba', ct: 6, bd: 8, sbit: [8, 8, 8], raw: [0, 1, 2, 3, 255] }
    ]) {
      const res = validatePngFrameFile(
        mkCustomPng(
          `c42_sbit_bad_${badSbit.label}.png`,
          { w: 1, h: 1, bd: badSbit.bd, ct: badSbit.ct },
          [{ type: 'sBIT', data: Buffer.from(badSbit.sbit) }, ...(badSbit.extra || [])],
          Buffer.from(badSbit.raw)
        )
      );
      assert.strictEqual(res.valid, false, `D2.44b Invalid sBIT rejected (${badSbit.label})`);
      assert.strictEqual(res.errorClass, 'INVALID_PNG_STRUCTURE');
    }
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c42_sbit_after_plte.png',
          { w: 1, h: 1, bd: 8, ct: 3 },
          [
            { type: 'PLTE', data: Buffer.from([0, 0, 0]) },
            { type: 'sBIT', data: Buffer.from([8, 8, 8]) }
          ],
          Buffer.from([0, 0])
        )
      ).valid,
      false,
      'D2.44c sBIT after PLTE rejected'
    );

    // C4.3 gAMA
    const mkGama = (val: number): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(val >>> 0, 0);
      return b;
    };
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c43_gama_std.png', { w: 1, h: 1, bd: 8, ct: 2 }, [{ type: 'gAMA', data: mkGama(45455) }], Buffer.from([0, 1, 2, 3]))).valid,
      true,
      'D2.45a Valid gAMA 45455 accepted'
    );
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c43_gama_1.png', { w: 1, h: 1, bd: 8, ct: 2 }, [{ type: 'gAMA', data: mkGama(1) }], Buffer.from([0, 1, 2, 3]))).valid,
      true,
      'D2.45b Valid small nonzero gAMA 1 accepted without arbitrary range restriction'
    );
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c43_gama_maxu32.png', { w: 1, h: 1, bd: 8, ct: 2 }, [{ type: 'gAMA', data: mkGama(0xffffffff) }], Buffer.from([0, 1, 2, 3]))).valid,
      true,
      'D2.45c Valid large uint32 gAMA accepted'
    );
    const gamaZero = validatePngFrameFile(
      mkCustomPng('c43_gama_zero.png', { w: 1, h: 1, bd: 8, ct: 2 }, [{ type: 'gAMA', data: mkGama(0) }], Buffer.from([0, 1, 2, 3]))
    );
    assert.strictEqual(gamaZero.valid, false, 'D2.45d Zero gAMA rejected');
    assert.strictEqual(gamaZero.errorClass, 'INVALID_PNG_STRUCTURE');
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c43_gama_badlen.png', { w: 1, h: 1, bd: 8, ct: 2 }, [{ type: 'gAMA', data: Buffer.from([0, 1, 2]) }], Buffer.from([0, 1, 2, 3]))).valid,
      false,
      'D2.45e Invalid gAMA length rejected'
    );

    // C4.4 iCCP (profile name, NUL terminator, compression method, compressed stream, output limit, trailing data, ICC structure, ordering)
    // Provenance & License: Deterministic, spec-compliant ICC.1-2001-04 (v2.4.0) sRGB Display ('mntr', 'RGB ', 'XYZ ')
    // profile synthesized directly from the public ICC.1 specification for VideoRisk PNG iCCP validation tests (MIT-compatible test fixture).
    const buildGenuineDeterministicSrgbIccProfile = (): Buffer => {
      const s15Fixed16 = (val: number): number => Math.round(val * 65536);
      const pad4 = (buf: Buffer): Buffer => {
        const rem = buf.length % 4;
        return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
      };
      const mkXyzTag = (x: number, y: number, z: number): Buffer => {
        const b = Buffer.alloc(20);
        b.write('XYZ ', 0, 'ascii');
        b.writeUInt32BE(0, 4);
        b.writeInt32BE(s15Fixed16(x), 8);
        b.writeInt32BE(s15Fixed16(y), 12);
        b.writeInt32BE(s15Fixed16(z), 16);
        return b;
      };
      const mkCurvGammaTag = (gammaFixed8_8: number): Buffer => {
        const b = Buffer.alloc(14);
        b.write('curv', 0, 'ascii');
        b.writeUInt32BE(0, 4);
        b.writeUInt32BE(1, 8); // 1-entry gamma curve
        b.writeUInt16BE(gammaFixed8_8, 12); // e.g., 2.2 -> 0x0233
        return b;
      };
      const mkTextTag = (text: string): Buffer => {
        const str = Buffer.from(text + '\0', 'ascii');
        const b = Buffer.alloc(8 + str.length);
        b.write('text', 0, 'ascii');
        b.writeUInt32BE(0, 4);
        str.copy(b, 8);
        return b;
      };
      const mkDescTag = (desc: string): Buffer => {
        const asciiBuf = Buffer.from(desc + '\0', 'ascii');
        // ICC v2 'desc' (textDescriptionType): 4-byte sig + 4-byte reserved + 4-byte asciiLen + ascii + 8-byte unicode header + 69-byte scriptcode
        const b = Buffer.alloc(12 + asciiBuf.length + 8 + 69);
        b.write('desc', 0, 'ascii');
        b.writeUInt32BE(0, 4);
        b.writeUInt32BE(asciiBuf.length, 8);
        asciiBuf.copy(b, 12);
        return b;
      };

      const trcTag = mkCurvGammaTag(0x0233); // gamma ~2.2
      const tagEntries: Array<{ sig: string; data: Buffer; sharedWith?: string }> = [
        { sig: 'desc', data: mkDescTag('VideoRisk Test sRGB IEC61966-2.1') },
        { sig: 'cprt', data: mkTextTag('VideoRisk Test Fixture (ICC.1-2001-04)') },
        { sig: 'wtpt', data: mkXyzTag(0.9505, 1.0000, 1.0890) },
        { sig: 'rXYZ', data: mkXyzTag(0.4361, 0.2225, 0.0139) },
        { sig: 'gXYZ', data: mkXyzTag(0.3851, 0.7169, 0.0971) },
        { sig: 'bXYZ', data: mkXyzTag(0.1431, 0.0606, 0.7141) },
        { sig: 'rTRC', data: trcTag },
        { sig: 'gTRC', data: trcTag, sharedWith: 'rTRC' },
        { sig: 'bTRC', data: trcTag, sharedWith: 'rTRC' },
      ];

      const headerSize = 128;
      const tagTableSize = 4 + tagEntries.length * 12;
      let cursor = headerSize + tagTableSize;
      const offsets = new Map<string, { offset: number; size: number }>();
      const dataChunks: Buffer[] = [];

      for (const entry of tagEntries) {
        if (entry.sharedWith && offsets.has(entry.sharedWith)) {
          offsets.set(entry.sig, offsets.get(entry.sharedWith)!);
          continue;
        }
        const padded = pad4(entry.data);
        offsets.set(entry.sig, { offset: cursor, size: entry.data.length });
        dataChunks.push(padded);
        cursor += padded.length;
      }

      const header = Buffer.alloc(headerSize);
      header.writeUInt32BE(cursor, 0); // Profile size
      header.write('none', 4, 'ascii'); // Preferred CMM type
      header.writeUInt32BE(0x02400000, 8); // ICC v2.4.0
      header.write('mntr', 12, 'ascii'); // Display device class
      header.write('RGB ', 16, 'ascii'); // Data colour space
      header.write('XYZ ', 20, 'ascii'); // PCS
      // Creation date/time: 2026-01-01 00:00:00 UTC
      header.writeUInt16BE(2026, 24);
      header.writeUInt16BE(1, 26);
      header.writeUInt16BE(1, 28);
      header.writeUInt16BE(0, 30);
      header.writeUInt16BE(0, 32);
      header.writeUInt16BE(0, 34);
      header.write('acsp', 36, 'ascii'); // Mandatory ICC profile file signature
      header.writeUInt32BE(0, 40); // Primary platform
      header.writeUInt32BE(0, 44); // Profile flags
      header.writeUInt32BE(0, 64); // Rendering intent: 0 (Perceptual)
      // PCS illuminant D50
      header.writeInt32BE(s15Fixed16(0.9642), 68);
      header.writeInt32BE(s15Fixed16(1.0000), 72);
      header.writeInt32BE(s15Fixed16(0.8249), 76);

      const tagTable = Buffer.alloc(tagTableSize);
      tagTable.writeUInt32BE(tagEntries.length, 0);
      tagEntries.forEach((entry, idx) => {
        const rec = offsets.get(entry.sig)!;
        const pos = 4 + idx * 12;
        tagTable.write(entry.sig, pos, 'ascii');
        tagTable.writeUInt32BE(rec.offset, pos + 4);
        tagTable.writeUInt32BE(rec.size, pos + 8);
      });

      return Buffer.concat([header, tagTable, ...dataChunks]);
    };

    const sampleIccProfile = buildGenuineDeterministicSrgbIccProfile();
    const compressedIccProfile = zlib.deflateSync(sampleIccProfile);
    const mkIccpPayload = (nameBuf: Buffer, method: number | null, compressedStream: Buffer, withNul = true): Buffer => {
      const parts: Buffer[] = [nameBuf];
      if (withNul) parts.push(Buffer.from([0x00]));
      if (method !== null) parts.push(Buffer.from([method]));
      parts.push(compressedStream);
      return Buffer.concat(parts);
    };

    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_valid.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('sRGB IEC61966-2.1'), 0, compressedIccProfile) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      true,
      'D2.46a Valid genuine ICC.1 profile inside iCCP chunk accepted'
    );
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_missing_nul.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: Buffer.concat([Buffer.from('ProfileNoNul'), compressedIccProfile]) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.46b iCCP without NUL terminator rejected'
    );
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_empty_name.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: mkIccpPayload(Buffer.alloc(0), 0, compressedIccProfile) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.46c iCCP with empty name rejected'
    );
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_80char_name.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: mkIccpPayload(Buffer.alloc(80, 0x41), 0, compressedIccProfile) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.46d iCCP name > 79 chars rejected'
    );
    for (const [nameLabel, badName] of [
      ['leading_space', Buffer.from(' LeadingSpace')],
      ['trailing_space', Buffer.from('TrailingSpace ')],
      ['double_space', Buffer.from('Double  Space')],
      ['control_char', Buffer.from('Ctrl\x07Name')],
      ['del_char', Buffer.from('Del\x7fName')],
      ['nbsp_0xa0', Buffer.from([0x41, 0xa0, 0x42])]
    ] as Array<[string, Buffer]>) {
      assert.strictEqual(
        validatePngFrameFile(
          mkCustomPng(
            `c44_iccp_badname_${nameLabel}.png`,
            { w: 1, h: 1, bd: 8, ct: 2 },
            [{ type: 'iCCP', data: mkIccpPayload(badName, 0, compressedIccProfile) }],
            Buffer.from([0, 1, 2, 3])
          )
        ).valid,
        false,
        `D2.46e iCCP invalid name (${nameLabel}) rejected`
      );
    }
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_bad_method.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('Profile'), 1, compressedIccProfile) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.46f iCCP unsupported compression method 1 rejected'
    );
    const iccpTruncRes = validatePngFrameFile(
      mkCustomPng(
        'c44_iccp_trunc_zlib.png',
        { w: 1, h: 1, bd: 8, ct: 2 },
        [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('Profile'), 0, compressedIccProfile.subarray(0, compressedIccProfile.length - 3)) }],
        Buffer.from([0, 1, 2, 3])
      )
    );
    assert.strictEqual(iccpTruncRes.valid, false, 'D2.46g iCCP truncated compressed stream rejected');
    assert.strictEqual(iccpTruncRes.errorClass, 'PNG_DECOMPRESSION_FAILURE');

    const iccpTrailRes = validatePngFrameFile(
      mkCustomPng(
        'c44_iccp_trailing_bytes.png',
        { w: 1, h: 1, bd: 8, ct: 2 },
        [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('Profile'), 0, Buffer.concat([compressedIccProfile, Buffer.from([0x00])])) }],
        Buffer.from([0, 1, 2, 3])
      )
    );
    assert.strictEqual(iccpTrailRes.valid, false, 'D2.46h iCCP trailing byte after zlib stream rejected');
    assert.strictEqual(iccpTrailRes.errorClass, 'PNG_DECOMPRESSION_FAILURE');

    const iccpBombRes = validatePngFrameFile(
      mkCustomPng(
        'c44_iccp_bomb.png',
        { w: 1, h: 1, bd: 8, ct: 2 },
        [
          {
            type: 'iCCP',
            data: mkIccpPayload(
              Buffer.from('BombProfile'),
              0,
              zlib.deflateSync(Buffer.alloc(MAX_OCR_PNG_ICCP_INFLATED_BYTES + 1))
            )
          }
        ],
        Buffer.from([0, 1, 2, 3])
      )
    );
    assert.strictEqual(iccpBombRes.valid, false, 'D2.46i iCCP excessive decompressed output rejected');
    assert.strictEqual(iccpBombRes.errorClass, 'PNG_DECOMPRESSION_FAILURE');

    // Group C2: Structural ICC profile validation regressions inside valid zlib iCCP streams
    const fakeAsciiIcc = Buffer.from('00000080test_icc_profile_payload_videorisk');
    const badShortIccRes = validatePngFrameFile(
      mkCustomPng(
        'c44_iccp_fake_short.png',
        { w: 1, h: 1, bd: 8, ct: 2 },
        [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('FakeShort'), 0, zlib.deflateSync(fakeAsciiIcc)) }],
        Buffer.from([0, 1, 2, 3])
      )
    );
    assert.strictEqual(badShortIccRes.valid, false, 'D2.46j Fake short ASCII ICC payload (<128 bytes) rejected');
    assert.strictEqual(badShortIccRes.errorClass, 'INVALID_PNG_STRUCTURE');

    const sizeMismatchLarge = Buffer.from(sampleIccProfile);
    sizeMismatchLarge.writeUInt32BE(sampleIccProfile.length + 100, 0);
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_size_mismatch_large.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('SizeMismatch'), 0, zlib.deflateSync(sizeMismatchLarge)) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.46k ICC profile with declared size > actual payload length rejected'
    );

    const sizeMismatchSmall = Buffer.from(sampleIccProfile);
    sizeMismatchSmall.writeUInt32BE(132, 0);
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_size_mismatch_small.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('SizeSmall'), 0, zlib.deflateSync(sizeMismatchSmall)) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.46l ICC profile with declared size < actual payload length rejected'
    );

    const truncatedIccPayload = sampleIccProfile.subarray(0, sampleIccProfile.length - 16);
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_truncated_icc.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('TruncICC'), 0, zlib.deflateSync(truncatedIccPayload)) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.46m Truncated ICC profile inside valid zlib stream rejected'
    );

    const badMagicIcc = Buffer.from(sampleIccProfile);
    badMagicIcc.write('fake', 36, 'ascii');
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_bad_acsp.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('BadMagic'), 0, zlib.deflateSync(badMagicIcc)) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.46n ICC profile without acsp signature at byte 36 rejected'
    );

    const badClassIcc = Buffer.from(sampleIccProfile);
    badClassIcc.write('xxxx', 12, 'ascii');
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_bad_class.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('BadClass'), 0, zlib.deflateSync(badClassIcc)) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.46o ICC profile with invalid device/profile class rejected'
    );

    const badTagOobIcc = Buffer.from(sampleIccProfile);
    // Point first tag data offset + size beyond profile length
    badTagOobIcc.writeUInt32BE(sampleIccProfile.length + 64, 132 + 8);
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_oob_tag.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('OobTag'), 0, zlib.deflateSync(badTagOobIcc)) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.46p ICC profile with out-of-bounds tag entry rejected'
    );

    const badIlluminantIcc = Buffer.from(sampleIccProfile);
    badIlluminantIcc.writeInt32BE(0, 68);
    badIlluminantIcc.writeInt32BE(0, 72);
    badIlluminantIcc.writeInt32BE(0, 76);
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c44_iccp_bad_illuminant.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [{ type: 'iCCP', data: mkIccpPayload(Buffer.from('BadIllum'), 0, zlib.deflateSync(badIlluminantIcc)) }],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.46q ICC profile with zeroed PCS illuminant rejected'
    );

    // C4.5 bKGD across colorTypes 0, 2, 3, 4, 6 with boundary checks
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c45_bkgd_gray4_ok.png', { w: 1, h: 1, bd: 4, ct: 0 }, [{ type: 'bKGD', data: u16be([15]) }], Buffer.from([0, 0x10]))).valid,
      true,
      'D2.47a bKGD grayscale 4-bit legal max 15 accepted'
    );
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c45_bkgd_gray4_oob.png', { w: 1, h: 1, bd: 4, ct: 0 }, [{ type: 'bKGD', data: u16be([16]) }], Buffer.from([0, 0x10]))).valid,
      false,
      'D2.47b bKGD grayscale 4-bit 16 rejected'
    );
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c45_bkgd_grayalpha8_ok.png', { w: 1, h: 1, bd: 8, ct: 4 }, [{ type: 'bKGD', data: u16be([255]) }], Buffer.from([0, 10, 255]))).valid,
      true,
      'D2.47c bKGD gray+alpha 8-bit legal max 255 accepted'
    );
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c45_bkgd_grayalpha8_oob.png', { w: 1, h: 1, bd: 8, ct: 4 }, [{ type: 'bKGD', data: u16be([256]) }], Buffer.from([0, 10, 255]))).valid,
      false,
      'D2.47d bKGD gray+alpha 8-bit 256 rejected'
    );
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c45_bkgd_rgb8_ok.png', { w: 1, h: 1, bd: 8, ct: 2 }, [{ type: 'bKGD', data: u16be([255, 128, 0]) }], Buffer.from([0, 1, 2, 3]))).valid,
      true,
      'D2.47e bKGD RGB 8-bit legal max 255 accepted'
    );
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c45_bkgd_rgb8_oob.png', { w: 1, h: 1, bd: 8, ct: 2 }, [{ type: 'bKGD', data: u16be([0, 0, 256]) }], Buffer.from([0, 1, 2, 3]))).valid,
      false,
      'D2.47f bKGD RGB 8-bit 256 rejected'
    );
    assert.strictEqual(
      validatePngFrameFile(mkCustomPng('c45_bkgd_rgba16_ok.png', { w: 1, h: 1, bd: 16, ct: 6 }, [{ type: 'bKGD', data: u16be([65535, 0, 65535]) }], Buffer.from([0, 0, 1, 0, 2, 0, 3, 0, 4]))).valid,
      true,
      'D2.47g bKGD RGBA 16-bit max 65535 accepted'
    );
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c45_bkgd_idx_ok.png',
          { w: 1, h: 1, bd: 8, ct: 3 },
          [
            { type: 'PLTE', data: Buffer.from([0, 0, 0, 255, 255, 255]) },
            { type: 'bKGD', data: Buffer.from([1]) }
          ],
          Buffer.from([0, 0])
        )
      ).valid,
      true,
      'D2.47h bKGD indexed boundary index (1 < 2) accepted'
    );
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c45_bkgd_idx_oob.png',
          { w: 1, h: 1, bd: 8, ct: 3 },
          [
            { type: 'PLTE', data: Buffer.from([0, 0, 0, 255, 255, 255]) },
            { type: 'bKGD', data: Buffer.from([2]) }
          ],
          Buffer.from([0, 0])
        )
      ).valid,
      false,
      'D2.47i bKGD indexed out-of-range index (2 >= 2) rejected'
    );
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c45_bkgd_before_plte.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [
            { type: 'bKGD', data: u16be([0, 0, 0]) },
            { type: 'PLTE', data: Buffer.from([0, 0, 0]) }
          ],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.47j bKGD before optional PLTE rejected'
    );

    // C4.6 Mutual Exclusion (iCCP vs sRGB in both orders) + valid sRGB+gAMA+cHRM coexistence
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c46_iccp_then_srgb.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [
            { type: 'iCCP', data: mkIccpPayload(Buffer.from('Profile'), 0, compressedIccProfile) },
            { type: 'sRGB', data: Buffer.from([0]) }
          ],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.48a iCCP followed by sRGB rejected'
    );
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c46_srgb_then_iccp.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [
            { type: 'sRGB', data: Buffer.from([0]) },
            { type: 'iCCP', data: mkIccpPayload(Buffer.from('Profile'), 0, compressedIccProfile) }
          ],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      false,
      'D2.48b sRGB followed by iCCP rejected'
    );
    assert.strictEqual(
      validatePngFrameFile(
        mkCustomPng(
          'c46_srgb_gama_chrm_valid.png',
          { w: 1, h: 1, bd: 8, ct: 2 },
          [
            { type: 'sRGB', data: Buffer.from([0]) },
            { type: 'gAMA', data: mkGama(45455) },
            { type: 'cHRM', data: Buffer.alloc(32, 1) }
          ],
          Buffer.from([0, 1, 2, 3])
        )
      ).valid,
      true,
      'D2.48c sRGB + gAMA + cHRM legal PNG spec coexistence accepted'
    );

    assertNoTempOcrDirLeak('D2.c1_c4.cleanup');
    console.log('  ✅ PASS: Full PNG integrity (C1-C4 & C4.1-C4.6 semantic validation: tRNS, sBIT, gAMA, iCCP, bKGD, mutual exclusion) verified');

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
    // J2. TASK B: MONOTONIC CLOCK TIMEOUT & WALL-CLOCK JUMP RESILIENCE
    // -------------------------------------------------------------------------
    console.log('\n[J2. Monotonic Clock Timeout & Wall-Clock Jump Resilience]');

    // J2.1 Verify defaultMonotonicNowMs uses monotonic clock
    assert.ok(typeof defaultMonotonicNowMs() === 'number' && defaultMonotonicNowMs() > 0, 'J2.1 defaultMonotonicNowMs returns positive monotonic reading');

    // J2.2 Date.now() jumping backward (-1 hour) and forward (+1 hour) mid-execution does NOT distort timeout/budget!
    const origDateNow = Date.now;
    let dateJumpCallCount = 0;
    const spyFastFfmpeg = path.resolve(testDir, 'j2_spy_fast_ffmpeg.sh');
    fs.writeFileSync(spyFastFfmpeg, `#!/bin/sh
OUT=""
for arg in "$@"; do OUT="$arg"; done
cp "${validPngProbe}" "$OUT"
exit 0
`, { mode: 0o755 });
    const j2FastTess = path.resolve(testDir, 'j2_fast_tess.sh');
    fs.writeFileSync(j2FastTess, `#!/bin/sh
printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n"
printf "5\\t1\\t1\\t1\\t1\\t1\\t10\\t10\\t80\\t24\\t94\\tMONOTONIC_OK\\n"
`, { mode: 0o755 });

    try {
      process.env.FFMPEG_PATH = spyFastFfmpeg;
      process.env.TESSERACT_PATH = j2FastTess;

      // Forward +1 hour jump during execution MUST NOT trigger false timeout
      dateJumpCallCount = 0;
      (Date as any).now = () => {
        dateJumpCallCount++;
        return origDateNow() + (dateJumpCallCount > 2 ? 3600_000 : 0);
      };
      const forwardJumpRes = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), {
        timestamps: [0, 1],
        timeoutMs: 10000,
        perFrameTimeoutMs: 5000
      });
      assert.strictEqual(forwardJumpRes.status, 'DETECTED', 'J2.2a Forward Date.now() jump (+1h) does NOT trigger false timeout');
      assert.strictEqual(forwardJumpRes.framesSucceeded, 2, 'J2.2b All 2 frames succeed cleanly despite +1h wall-clock jump');

      // Backward -1 hour jump during hanging FFmpeg MUST still enforce real 200ms monotonic timeout
      (Date as any).now = () => origDateNow() - 3600_000;
      process.env.FFMPEG_PATH = j2HangFfmpeg;
      const monoBeforeHang = defaultMonotonicNowMs();
      const backwardJumpTimeoutRes = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), {
        timestamps: [0, 1],
        timeoutMs: 200,
        perFrameTimeoutMs: 10000
      });
      const monoHangElapsed = defaultMonotonicNowMs() - monoBeforeHang;
      assert.ok(monoHangElapsed < 1500, `J2.3a Backward Date.now() jump (-1h) did NOT bypass 200ms monotonic timeout (elapsed=${Math.round(monoHangElapsed)}ms)`);
      assert.strictEqual(backwardJumpTimeoutRes.executionStatus, 'FAILED', 'J2.3b Timeout triggered cleanly on monotonic clock');
      assert.strictEqual(backwardJumpTimeoutRes.failureClassification, 'OCR_TIMEOUT', 'J2.3c Timeout classified as OCR_TIMEOUT');
    } finally {
      (Date as any).now = origDateNow;
      delete process.env.FFMPEG_PATH;
      process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    }
    assertNoTempOcrDirLeak('J2.walljump.cleanup');

    // J2.4 Injected mock monotonic clock advancing past budget mid-pipeline stops loop before next frame
    const mockAdvFfmpegLog = path.resolve(testDir, 'j2_mock_ffmpeg.log');
    const mockAdvFfmpeg = path.resolve(testDir, 'j2_mock_ffmpeg.sh');
    fs.writeFileSync(mockAdvFfmpeg, `#!/bin/sh
OUT=""
for arg in "$@"; do OUT="$arg"; done
echo "CALL" >> "${mockAdvFfmpegLog}"
cp "${validPngProbe}" "$OUT"
exit 0
`, { mode: 0o755 });
    const mockAdvTess = path.resolve(testDir, 'j2_mock_tess.sh');
    const mockAdvTessLog = path.resolve(testDir, 'j2_mock_tess.log');
    fs.writeFileSync(mockAdvTess, `#!/bin/sh
echo "TESS" >> "${mockAdvTessLog}"
printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n"
printf "5\\t1\\t1\\t1\\t1\\t1\\t10\\t10\\t80\\t24\\t94\\tSTEP_OK\\n"
`, { mode: 0o755 });

    // Advance mock clock deterministically between frame extraction checks & OCR loop
    let clockReads = 0;
    const steppingClock = () => {
      clockReads++;
      // Read 1: startMonoMs = 1000; Read 2..3 (extract 0,1,2 within budget): 1050,1100,1150;
      // Read 4: remainingBeforeOcr for frame 0 -> 1200 (800ms left); Read 5: remainingBeforeOcr for frame 1 -> 2500 (> deadline 2000!)
      if (clockReads === 1) return 1000;
      if (clockReads <= 4) return 1000 + (clockReads - 1) * 50;
      if (clockReads === 5) return 1200;
      return 2500;
    };

    try {
      process.env.FFMPEG_PATH = mockAdvFfmpeg;
      process.env.TESSERACT_PATH = mockAdvTess;
      const mockClockRes = await videoProcessor.performVideoOcr(posVideo, baseMeta('pos_text.mp4', 3.0), {
        timestamps: [0, 1, 2],
        timeoutMs: 1000,
        monotonicNowMs: steppingClock
      });
      assert.strictEqual(mockClockRes.framesExtracted, 3, 'J2.4a All 3 frames extracted while mock clock < deadline');
      assert.strictEqual(mockClockRes.framesAttempted, 1, 'J2.4b Stopped after frame 0 when mock monotonic clock crossed deadline');
      assert.strictEqual(mockClockRes.framesSkipped, 2, 'J2.4c Remaining 2 frames accounted in framesSkipped');
      assert.strictEqual(mockClockRes.executionStatus, 'PARTIAL', 'J2.4d Partial status reflects mid-OCR budget exhaustion');
      assert.strictEqual(mockClockRes.failureClassification, 'OCR_TIMEOUT', 'J2.4e Classification is OCR_TIMEOUT');
      assert.strictEqual(fs.readFileSync(mockAdvTessLog, 'utf8').trim().split('\n').length, 1, 'J2.4f Only 1 Tesseract process launched');
    } finally {
      delete process.env.FFMPEG_PATH;
      process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    }
    assertNoTempOcrDirLeak('J2.mockclock.cleanup');
    console.log('  ✅ PASS: Monotonic clock timeout & wall-clock jump resilience verified');

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
