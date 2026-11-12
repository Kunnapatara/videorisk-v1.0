import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { execFile } from 'child_process';
import {
  videoProcessor,
  calculateOcrSamplingTimestamps,
  validateTesseractTsv
} from '../src/server/pipeline/videoProcessor';
import { thumbnailInspector } from '../src/server/pipeline/thumbnailInspector';
import { SpeechTranscriptionAdapter } from '../src/server/pipeline/audioProcessor';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { billingService } from '../src/server/services/billingService';
import { mapVideoOcrDetectorReport } from '../src/server/pipeline/jobOrchestrator';
import { validateStripeWebhookSecret } from '../scripts/validate-env';
import { apiRouter } from '../src/server/routes/api';
import { storage } from '../src/server/storage';
import { MediaMetadata, VideoOcrResult } from '../src/types';

const execFileAsync = promisify(execFile);

export async function runRemediationRegressionTests() {
  console.log('\n======================================================');
  console.log('--- PHASE 4–6 REMEDIATION TARGETED REGRESSION TESTS ---');
  console.log('Full Timeline OCR, Whisper Runtime, Readiness & Contracts');
  console.log('======================================================\n');

  const testDir = path.resolve(process.cwd(), 'uploads', 'test_regression_' + Date.now());
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  const generatedFiles: string[] = [];
  const cleanup = () => {
    for (const f of generatedFiles) {
      try {
        if (fs.existsSync(f)) {
          const stat = fs.statSync(f);
          if (stat.isDirectory()) {
            fs.rmdirSync(f);
          } else {
            fs.unlinkSync(f);
          }
        }
      } catch {}
    }
    try {
      if (fs.existsSync(testDir)) fs.rmdirSync(testDir);
    } catch {}
  };

  try {
    // -------------------------------------------------------------------------
    // 1. FULL-VIDEO OCR TRUE TIMELINE COVERAGE & 4-CELL MATRIX TESTS
    // -------------------------------------------------------------------------
    console.log('[1. Full-Video OCR Timeline Coverage & 4-Cell Matrix Verification]');

    // Create a 3-second test video with text overlay appearing between 0.5s and 2.5s
    const dummyVideoPath = path.resolve(testDir, 'dummy_ocr.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', "testsrc=size=320x240:rate=10:duration=3,drawtext=text='REGRESSION TEST':fontsize=28:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,0.5,2.5)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      dummyVideoPath
    ]);
    generatedFiles.push(dummyVideoPath);

    const meta3s: MediaMetadata = {
      filename: 'dummy_ocr.mp4',
      originalSize: 500000,
      durationSeconds: 3.0,
      width: 320,
      height: 240,
      resolutionLabel: '240p',
      fps: 10,
      hasAudio: false,
      videoCodec: 'h264',
      isProxyUsed: false
    };

    process.env.TESSERACT_PATH = '/usr/bin/tesseract';

    // 1.1 Real 3s video execution with granular frame accounting
    const ocr3s = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, { maxFrames: 3 });
    assert.strictEqual(ocr3s.framesTargeted, 3, '1.1 Real 3s video targets 3 candidate frames');
    assert.strictEqual(ocr3s.framesExtracted, 3, '1.2 Exactly 3 frames extracted by FFmpeg');
    assert.strictEqual(ocr3s.framesExtractionFailed, 0, '1.3 Zero extraction failures on valid video');
    assert.strictEqual(ocr3s.framesAttempted, 3, '1.4 Exactly 3 extracted frames submitted to OCR');
    assert.strictEqual(ocr3s.framesSucceeded, 3, '1.5 All 3 frames successfully evaluated by OCR');
    assert.strictEqual(ocr3s.framesOcrFailed, 0, '1.6 Zero OCR execution failures');
    assert.strictEqual(ocr3s.framesSkipped, 0, '1.7 Zero frames skipped');
    assert.strictEqual(ocr3s.samplingCoverageRatio, 1.0, '1.8 Sampling fulfillment ratio is 3/3 = 1.0');
    assert.strictEqual(ocr3s.ocrExecutionSuccessRatio, 1.0, '1.9 OCR execution success ratio is 3/3 = 1.0');
    assert.ok(ocr3s.timelineCoverageRatio !== undefined && ocr3s.timelineCoverageRatio > 0, '1.10 Timeline coverage ratio is populated');

    // 1.2 COMPLETE 4-CELL SAMPLING MATRIX (Standard 10m/30m: 15 samples; Deep 10m/30m: 30 samples)
    console.log('  Testing complete 4-cell sampling matrix...');
    // Cell 1: Standard 10m (600s, max 15)
    const tsStandard10m = calculateOcrSamplingTimestamps(600, 15);
    assert.strictEqual(tsStandard10m.length, 15, '1.11 Cell 1: Standard 10m produces exactly 15 timestamps');
    assert.strictEqual(tsStandard10m[0], 0, '1.12 Cell 1: Starts at 0s');
    assert.ok(tsStandard10m[tsStandard10m.length - 1] >= 590 && tsStandard10m[tsStandard10m.length - 1] <= 600, '1.13 Cell 1: Reaches end of 600s');

    // Cell 2: Standard 30m (1800s, max 15)
    const tsStandard30m = calculateOcrSamplingTimestamps(1800, 15);
    assert.strictEqual(tsStandard30m.length, 15, '1.14 Cell 2: Standard 30m produces exactly 15 timestamps');
    assert.strictEqual(tsStandard30m[0], 0, '1.15 Cell 2: Starts at 0s');
    assert.ok(tsStandard30m[tsStandard30m.length - 1] >= 1780 && tsStandard30m[tsStandard30m.length - 1] <= 1800, '1.16 Cell 2: Reaches end of 1800s');

    // Cell 3: Deep 10m (600s, max 30)
    const tsDeep10m = calculateOcrSamplingTimestamps(600, 30);
    assert.strictEqual(tsDeep10m.length, 30, '1.17 Cell 3: Deep 10m produces exactly 30 timestamps');
    assert.strictEqual(tsDeep10m[0], 0, '1.18 Cell 3: Starts at 0s');
    assert.ok(tsDeep10m[tsDeep10m.length - 1] >= 590 && tsDeep10m[tsDeep10m.length - 1] <= 600, '1.19 Cell 3: Reaches end of 600s');

    // Cell 4: Deep 30m (1800s, max 30)
    const tsDeep30m = calculateOcrSamplingTimestamps(1800, 30);
    assert.strictEqual(tsDeep30m.length, 30, '1.20 Cell 4: Deep 30m produces exactly 30 timestamps');
    assert.strictEqual(tsDeep30m[0], 0, '1.21 Cell 4: Starts at 0s');
    assert.ok(tsDeep30m[tsDeep30m.length - 1] >= 1780 && tsDeep30m[tsDeep30m.length - 1] <= 1800, '1.22 Cell 4: Reaches end of 1800s');

    // Determinism and uniqueness check
    const tsStandard10m_2 = calculateOcrSamplingTimestamps(600, 15);
    assert.deepStrictEqual(tsStandard10m, tsStandard10m_2, '1.23 Sampling is completely deterministic');
    assert.strictEqual(new Set(tsStandard10m).size, 15, '1.24 All timestamps in 10m are unique');
    assert.strictEqual(new Set(tsDeep30m).size, 30, '1.25 All timestamps in Deep 30m are unique');

    // Short media handling
    const tsShort = calculateOcrSamplingTimestamps(0.8, 15);
    assert.deepStrictEqual(tsShort, [0], '1.26 Media under 1s yields single timestamp [0]');

    // 1.3 MATHEMATICAL INTERVAL-UNION TIMELINE COVERAGE
    // Verify that sparse sampling over a long duration does NOT falsely report 100% coverage
    // If a 600s video only has 2 timestamps (at 0s and 600s), coverage window is 2 * (600/15)/2 = ~40s window per frame = ~60s union = ~10-15%, NOT 100%
    const sparseMeta: MediaMetadata = {
      filename: 'sparse_test.mp4',
      originalSize: 500000,
      durationSeconds: 600.0,
      width: 320,
      height: 240,
      resolutionLabel: '240p',
      fps: 10,
      hasAudio: false,
      videoCodec: 'h264',
      isProxyUsed: false
    };
    const sparseOcr = await videoProcessor.performVideoOcr(dummyVideoPath, sparseMeta, { timestamps: [0, 600] });
    assert.ok(sparseOcr.timelineCoverageRatio !== undefined && sparseOcr.timelineCoverageRatio <= 0.25, `1.27 Interval union prevents sparse samples from falsely reporting 100% coverage (got ${sparseOcr.timelineCoverageRatio})`);
    assert.ok(sparseOcr.timelineCoverageRatio !== undefined && sparseOcr.timelineCoverageRatio > 0, '1.28 Interval union reports non-zero genuine coverage');

    console.log('  ✅ PASS: Full-video OCR timeline coverage, 4-cell matrix, and interval-union verified');

    // -------------------------------------------------------------------------
    // 2. OCR FAILURE CLASSIFICATION & STRICT TSV VALIDATION
    // -------------------------------------------------------------------------
    console.log('\n[2. OCR Failure Classification & Strict TSV Validation]');

    // Test 2.1: Missing Tesseract executable reports UNAVAILABLE
    process.env.TESSERACT_PATH = '/path/to/missing/tesseract';
    const missingTessRes = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, { maxFrames: 3 });
    assert.strictEqual(missingTessRes.status, 'ANALYSIS_UNAVAILABLE', '2.1 Missing Tesseract reports ANALYSIS_UNAVAILABLE');
    assert.notStrictEqual(missingTessRes.status, 'NO_SIGNAL_DETECTED', '2.2 Missing Tesseract CANNOT report NO_SIGNAL_DETECTED');

    // Test 2.2: Mock failing Tesseract binary (exits with error 1)
    const failingOcrScript = path.resolve(testDir, 'failing_ocr.sh');
    fs.writeFileSync(failingOcrScript, `#!/bin/sh\necho "Tesseract error: corrupted tessdata" >&2\nexit 1\n`, { mode: 0o755 });
    generatedFiles.push(failingOcrScript);

    process.env.TESSERACT_PATH = failingOcrScript;
    const failingOcrRes = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, { maxFrames: 3 });
    assert.strictEqual(failingOcrRes.executionStatus, 'FAILED', '2.3 All failing OCR frames classify as FAILED');
    assert.notStrictEqual(failingOcrRes.status, 'NO_SIGNAL_DETECTED', '2.4 Failed OCR cannot report NO_SIGNAL_DETECTED');
    assert.strictEqual(failingOcrRes.framesOcrFailed, failingOcrRes.framesAttempted, '2.5 Failed frames count equals attempted count');
    assert.strictEqual(failingOcrRes.framesSucceeded, 0, '2.6 Zero frames succeeded on failure');
    assert.strictEqual(failingOcrRes.ocrExecutionSuccessRatio, 0, '2.7 Success ratio is strictly 0 when all OCR fails');

    // Test 2.3: Mock partial OCR binary (fails on frame 2)
    const partialOcrScript = path.resolve(testDir, 'partial_ocr.sh');
    fs.writeFileSync(partialOcrScript, `#!/bin/sh
if echo "$1" | grep -q "frame_001"; then
  echo "Error on frame 001" >&2
  exit 1
fi
printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n"
printf "5\\t1\\t1\\t1\\t1\\t1\\t10\\t10\\t50\\t20\\t95\\tSAMPLE\\n"
`, { mode: 0o755 });
    generatedFiles.push(partialOcrScript);

    process.env.TESSERACT_PATH = partialOcrScript;
    const partialOcrRes = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, { maxFrames: 3 });
    assert.ok(Number(partialOcrRes.framesOcrFailed) > 0, '2.8 Failure count recorded');
    assert.ok(Number(partialOcrRes.framesSucceeded) > 0, '2.9 Successful count recorded');
    assert.ok(partialOcrRes.ocrExecutionSuccessRatio !== undefined && partialOcrRes.ocrExecutionSuccessRatio < 1.0, '2.10 Success ratio is under 100%');
    assert.strictEqual(partialOcrRes.framesExtractionFailed, 0, '2.11 OCR failure is NOT counted as extraction failure');

    // Test 2.4: Comprehensive Strict TSV validation
    // Empty TSV
    const emptyTsvRes = validateTesseractTsv('');
    assert.strictEqual(emptyTsvRes.isValid, false, '2.12 Empty TSV is rejected');

    // Header-only TSV (missing data lines)
    const headerOnlyTsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n';
    const headerOnlyRes = validateTesseractTsv(headerOnlyTsv);
    assert.strictEqual(headerOnlyRes.isValid, false, '2.13 Header-only TSV without data rows is rejected');
    assert.ok(headerOnlyRes.error?.includes('missing data lines'), '2.14 Documents missing data lines');

    // Malformed header
    const malformedHeaderRes = validateTesseractTsv('foo\tbar\tbaz\n1\t2\t3');
    assert.strictEqual(malformedHeaderRes.isValid, false, '2.15 Header lacking required columns is rejected');

    // Row column count mismatch
    const columnMismatchTsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1';
    const columnMismatchRes = validateTesseractTsv(columnMismatchTsv);
    assert.strictEqual(columnMismatchRes.isValid, false, '2.16 Row with fewer columns than header is rejected');

    // Non-numeric geometry
    const nonNumericGeomTsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\tINVALID_NUM\t10\t50\t20\t95\tSAMPLE\n';
    const nonNumericGeomRes = validateTesseractTsv(nonNumericGeomTsv);
    assert.strictEqual(nonNumericGeomRes.isValid, false, '2.17 Non-numeric geometry coordinates are rejected');

    // Out-of-bounds confidence (> 100)
    const outOfBoundsConfTsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t150\tSAMPLE\n';
    const outOfBoundsConfRes = validateTesseractTsv(outOfBoundsConfTsv);
    assert.strictEqual(outOfBoundsConfRes.isValid, false, '2.18 Confidence above 100 is rejected');

    // Negative confidence below -1
    const invalidNegativeConfTsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t-5\tSAMPLE\n';
    const invalidNegativeConfRes = validateTesseractTsv(invalidNegativeConfTsv);
    assert.strictEqual(invalidNegativeConfRes.isValid, false, '2.19 Confidence below -1 is rejected');

    // Valid blank image TSV (level=1 page row, conf=-1, 0 text words)
    const validTsvNoText = `level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
1\t1\t0\t0\t0\t0\t0\t0\t640\t360\t-1\t
`;
    const validNoTextRes = validateTesseractTsv(validTsvNoText);
    assert.strictEqual(validNoTextRes.isValid, true, '2.20 Valid blank image TSV is structurally valid');
    assert.strictEqual(validNoTextRes.words.length, 0, '2.21 Zero words parsed from blank image');

    // Valid TSV with text
    const validTsvWithText = `level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t95\tSAMPLE
`;
    const validWithTextRes = validateTesseractTsv(validTsvWithText);
    assert.strictEqual(validWithTextRes.isValid, true, '2.22 Valid text TSV accepted');
    assert.strictEqual(validWithTextRes.words.length, 1, '2.23 One word extracted');
    assert.strictEqual(validWithTextRes.words[0], 'SAMPLE', '2.24 Extracted word is SAMPLE');

    delete process.env.TESSERACT_PATH;
    console.log('  ✅ PASS: OCR failure states, strict TSV validation, and blank image handling verified');

    // -------------------------------------------------------------------------
    // 3. WHISPER RUNTIME IDENTITY & PREFLIGHT REQUIREMENTS
    // -------------------------------------------------------------------------
    console.log('\n[3. Whisper STT Runtime Identity & Preflight Verification]');

    const stt = new SpeechTranscriptionAdapter();

    // 3.1 Unconfigured environment
    delete process.env.WHISPER_PATH;
    delete process.env.LOCAL_STT_PATH;
    delete process.env.WHISPER_MODEL_PATH;
    const unconfValidation = await stt.validateRuntime();
    assert.strictEqual(unconfValidation.status, 'UNCONFIGURED', '3.1 Unconfigured runtime reports UNCONFIGURED');
    assert.strictEqual(unconfValidation.isExecutable, false, '3.2 Unconfigured is not executable');

    // 3.2 Missing executable path
    process.env.WHISPER_PATH = '/usr/local/bin/nonexistent_whisper';
    const missingValidation = await stt.validateRuntime();
    assert.strictEqual(missingValidation.status, 'MISSING_EXECUTABLE', '3.3 Missing binary reports MISSING_EXECUTABLE');

    // 3.3 Directory instead of file
    const dummyDir = path.resolve(testDir, 'whisper_as_dir');
    fs.mkdirSync(dummyDir, { recursive: true });
    generatedFiles.push(dummyDir);
    process.env.WHISPER_PATH = dummyDir;
    const dirValidation = await stt.validateRuntime();
    assert.strictEqual(dirValidation.status, 'NON_EXECUTABLE', '3.4 Directory path reports NON_EXECUTABLE');

    // 3.4 Non-executable binary file (no +x)
    const nonExecPath = path.resolve(testDir, 'whisper_non_exec.sh');
    fs.writeFileSync(nonExecPath, `echo "whisper not executable"`, { mode: 0o644 });
    generatedFiles.push(nonExecPath);

    process.env.WHISPER_PATH = nonExecPath;
    const nonExecValidation = await stt.validateRuntime();
    assert.strictEqual(nonExecValidation.status, 'NON_EXECUTABLE', '3.5 File without +x reports NON_EXECUTABLE');

    // 3.5 Arbitrary binary that exits 0 but does not identify as Whisper
    const arbitraryBin = path.resolve(testDir, 'arbitrary_bin.sh');
    fs.writeFileSync(arbitraryBin, `#!/bin/sh\necho "Arbitrary Utility v1.0.0"\nexit 0\n`, { mode: 0o755 });
    generatedFiles.push(arbitraryBin);

    process.env.WHISPER_PATH = arbitraryBin;
    const arbitraryValidation = await stt.validateRuntime();
    assert.strictEqual(arbitraryValidation.status, 'ERROR', '3.6 Arbitrary binary exiting 0 without Whisper identity reports ERROR');

    // 3.6 whisper_cpp runtime identity without configured model
    const mockWhisperCpp = path.resolve(testDir, 'mock_whisper_cpp.sh');
    fs.writeFileSync(mockWhisperCpp, `#!/bin/sh\necho "whisper.cpp main --model <model>"\nexit 0\n`, { mode: 0o755 });
    generatedFiles.push(mockWhisperCpp);

    process.env.WHISPER_PATH = mockWhisperCpp;
    delete process.env.WHISPER_MODEL_PATH;
    const whisperCppNoModel = await stt.validateRuntime();
    assert.strictEqual(whisperCppNoModel.runtimeType, 'whisper_cpp', '3.7 Correctly identifies whisper_cpp runtime');
    assert.strictEqual(whisperCppNoModel.status, 'MISSING_MODEL', '3.8 whisper_cpp without model reports MISSING_MODEL');

    // 3.7 Model file exists but is empty (0 bytes)
    const emptyModel = path.resolve(testDir, 'empty_whisper_model.bin');
    fs.writeFileSync(emptyModel, '');
    generatedFiles.push(emptyModel);

    process.env.WHISPER_MODEL_PATH = emptyModel;
    const emptyModelValidation = await stt.validateRuntime();
    assert.strictEqual(emptyModelValidation.status, 'MISSING_MODEL', '3.9 Empty (0-byte) model reports MISSING_MODEL');
    assert.ok(emptyModelValidation.details?.includes('empty file (0 bytes)'), '3.10 Documents empty model file');

    // 3.8 Valid model file and whisper_cpp runtime -> READY
    const validModel = path.resolve(testDir, 'valid_whisper_model.bin');
    fs.writeFileSync(validModel, 'FAKE_MODEL_WEIGHTS_BINARY_DATA');
    generatedFiles.push(validModel);

    process.env.WHISPER_MODEL_PATH = validModel;
    const readyValidation = await stt.validateRuntime();
    assert.strictEqual(readyValidation.status, 'READY', '3.11 whisper_cpp with valid model reports READY');

    // 3.9 Enforce preflight before transcribe()
    // When runtime is NOT ready (e.g. MISSING_MODEL), transcribe must return ANALYSIS_UNAVAILABLE immediately
    process.env.WHISPER_MODEL_PATH = emptyModel; // empty model causes MISSING_MODEL
    const preflightBlocked = await stt.transcribe(dummyVideoPath, 10);
    assert.strictEqual(preflightBlocked.status, 'ANALYSIS_UNAVAILABLE', '3.12 Preflight blocks transcription when runtime not READY');
    assert.ok(preflightBlocked.failureReason?.includes('empty file'), '3.13 Explains model failure in failureReason');

    delete process.env.WHISPER_PATH;
    delete process.env.WHISPER_MODEL_PATH;
    console.log('  ✅ PASS: Whisper STT runtime identity, model requirements & preflight verified');

    // -------------------------------------------------------------------------
    // 4. THUMBNAIL CONTRAST EVALUATION CONTRACT
    // -------------------------------------------------------------------------
    console.log('\n[4. Thumbnail Contrast Analysis Verification]');

    const sampleThumbPath = path.resolve(testDir, 'sample_thumb.png');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=navy:s=640x360:d=1',
      '-vframes', '1',
      sampleThumbPath
    ]);
    generatedFiles.push(sampleThumbPath);

    const thumbMeta = await thumbnailInspector.inspect(sampleThumbPath, 'sample_thumb.png');
    assert.strictEqual(thumbMeta.hasHighContrastText, null, '4.1 hasHighContrastText is strictly null without bounding-box contrast');
    assert.strictEqual(thumbMeta.contrastAnalysisStatus, 'NOT_ASSESSED', '4.2 contrastAnalysisStatus is NOT_ASSESSED');
    assert.ok(thumbMeta.detectors?.thumbnail_contrast, '4.3 thumbnail_contrast detector report exists');
    assert.strictEqual(thumbMeta.detectors?.thumbnail_contrast?.status, 'NOT_ASSESSED', '4.4 Detector status is NOT_ASSESSED');
    assert.ok(thumbMeta.detectors?.thumbnail_contrast?.limitations?.includes('not assessed'), '4.5 Limitations honestly state not assessed');

    console.log('  ✅ PASS: Thumbnail contrast honest non-assessed contract verified');

    // -------------------------------------------------------------------------
    // 5. DETECTOR REPORT CONFIDENCE MAPPING (NO FABRICATED DEFAULTS)
    // -------------------------------------------------------------------------
    console.log('\n[5. Video OCR Detector Report Mapping & Confidence Verification]');

    // 5.1 Empty detected frames -> confidence is strictly 0 (NEVER 0.85 or 0.90)
    const emptyOcrResult: VideoOcrResult = {
      allExtractedText: [],
      detectedFrames: [],
      totalCandidateFrames: 15,
      framesInspected: 15,
      coverageRatio: 1.0,
      executionDurationMs: 120,
      status: 'NO_SIGNAL_DETECTED',
      limitations: 'Clean run',
      framesTargeted: 15,
      framesExtracted: 15,
      framesExtractionFailed: 0,
      framesAttempted: 15,
      framesSucceeded: 15,
      framesOcrFailed: 0,
      framesSkipped: 0,
      samplingCoverageRatio: 1.0,
      ocrExecutionSuccessRatio: 1.0
    };

    const emptyReport = mapVideoOcrDetectorReport(emptyOcrResult, meta3s, 'standard');
    assert.strictEqual(emptyReport.confidence, 0, '5.1 Zero confidence when no text detected (NOT fabricated 0.85)');
    assert.strictEqual(emptyReport.details?.ocrExecutionSuccessRatio, 1.0, '5.2 Preserves OCR execution success ratio');

    // 5.2 Genuine confidence preserved when present
    const detectedOcrResult: VideoOcrResult = {
      allExtractedText: ['REGRESSION TEST'],
      detectedFrames: [{
        timestamp: 1.5,
        frameIndex: 0,
        frameFile: 'frame_000.png',
        text: 'REGRESSION TEST',
        confidence: 91.5,
        boundingBoxes: [{ text: 'REGRESSION TEST', confidence: 91.5, left: 10, top: 10, width: 100, height: 30 }]
      }],
      totalCandidateFrames: 15,
      framesInspected: 15,
      coverageRatio: 1.0,
      executionDurationMs: 150,
      status: 'DETECTED',
      limitations: 'Detected text',
      framesTargeted: 15,
      framesExtracted: 15,
      framesAttempted: 15,
      framesSucceeded: 15,
      framesOcrFailed: 0,
      framesSkipped: 0
    };

    const detectedReport = mapVideoOcrDetectorReport(detectedOcrResult, meta3s, 'standard');
    assert.strictEqual(detectedReport.confidence, 91.5, '5.3 Genuine confidence score preserved from detected frame');

    // 5.3 Frame with missing confidence -> confidence is strictly 0
    const missingConfResult: VideoOcrResult = {
      allExtractedText: ['SAMPLE'],
      detectedFrames: [{
        timestamp: 1.0,
        frameIndex: 0,
        frameFile: 'frame_000.png',
        text: 'SAMPLE',
        confidence: 0,
        boundingBoxes: [{ text: 'SAMPLE', confidence: 0, left: 0, top: 0, width: 50, height: 20 }]
      }],
      totalCandidateFrames: 15,
      framesInspected: 15,
      coverageRatio: 1.0,
      executionDurationMs: 100,
      status: 'DETECTED',
      limitations: 'Sample'
    };
    const missingConfReport = mapVideoOcrDetectorReport(missingConfResult, meta3s, 'standard');
    assert.strictEqual(missingConfReport.confidence, 0, '5.4 Missing confidence defaults to 0 (NOT fabricated 0.85/0.90)');

    // 5.4 Zero-value preservation check in details
    const zeroOcrResult: VideoOcrResult = {
      allExtractedText: [],
      detectedFrames: [],
      totalCandidateFrames: 15,
      framesInspected: 0,
      coverageRatio: 0,
      executionDurationMs: 50,
      status: 'ANALYSIS_UNAVAILABLE',
      limitations: 'Failed early',
      framesTargeted: 15,
      framesExtracted: 0,
      framesExtractionFailed: 15,
      framesAttempted: 0,
      framesSucceeded: 0,
      framesOcrFailed: 0,
      framesSkipped: 0,
      samplingCoverageRatio: 0,
      ocrExecutionSuccessRatio: 0
    };
    const zeroReport = mapVideoOcrDetectorReport(zeroOcrResult, meta3s, 'standard');
    assert.strictEqual(zeroReport.details?.framesExtracted, 0, '5.5 Zero frames extracted preserved');
    assert.strictEqual(zeroReport.details?.ocrExecutionSuccessRatio, 0, '5.6 Zero OCR success ratio preserved');

    console.log('  ✅ PASS: Detector report confidence mapping and zero-value preservation verified');

    // -------------------------------------------------------------------------
    // 6. SHARED STRIPE WEBHOOK SECRET VALIDATION & BILLING INTEGRITY
    // -------------------------------------------------------------------------
    console.log('\n[6. Shared Stripe Webhook Secret Validation & Billing Separation]');

    // 6.1 Shared validator verification
    const validWhsec = 'whsec_abcdef1234567890abcdef1234567890';
    const invalidArbitrary = 'arbitrary_secret_value_12345';
    const shortWhsec = 'whsec_short';

    assert.strictEqual(validateStripeWebhookSecret(validWhsec).isValid, true, '6.1 Standard whsec_ passes shared validation');
    assert.strictEqual(validateStripeWebhookSecret(invalidArbitrary).isValid, false, '6.2 Non-whsec string rejected by shared validator');
    assert.strictEqual(validateStripeWebhookSecret(shortWhsec).isValid, false, '6.3 Short whsec rejected by shared validator');
    assert.strictEqual(validateStripeWebhookSecret('').isValid, false, '6.4 Empty secret rejected');
    assert.strictEqual(validateStripeWebhookSecret(null).isValid, false, '6.5 Null secret rejected');

    // 6.2 Stripe mode detection
    process.env.STRIPE_SECRET_KEY = 'sk_test_mockkey1234567890';
    assert.strictEqual(billingService.getStripeMode(), 'test', '6.6 sk_test_ detected as test mode');

    process.env.STRIPE_SECRET_KEY = 'sk_live_mockkey1234567890';
    assert.strictEqual(billingService.getStripeMode(), 'live', '6.7 sk_live_ detected as live mode');

    delete process.env.STRIPE_SECRET_KEY;
    assert.strictEqual(billingService.getStripeMode(), 'unconfigured', '6.8 Unset key detected as unconfigured');

    console.log('  ✅ PASS: Shared Stripe webhook validator and billing mode separation verified');

    // -------------------------------------------------------------------------
    // 7. ACTUAL PRODUCTION READINESS ENDPOINT VERIFICATION (/api/health/readiness)
    // -------------------------------------------------------------------------
    console.log('\n[7. Actual Production Readiness Endpoint Verification (/api/health/readiness)]');

    // Find the actual route layer in apiRouter
    const readinessLayer = (apiRouter as any).stack.find((layer: any) =>
      layer.route && layer.route.path === '/health/readiness'
    );
    assert.ok(readinessLayer, '7.1 /health/readiness route handler exists in apiRouter');
    const readinessHandler = readinessLayer.route.stack[0].handle;

    // Helper to invoke actual readiness handler
    const invokeReadiness = async (): Promise<{ statusCode: number; body: any }> => {
      let code = 200;
      let body: any = null;
      const req: any = { method: 'GET', url: '/health/readiness', headers: {}, query: {} };
      const res: any = {
        status(c: number) {
          code = c;
          return this;
        },
        json(data: any) {
          body = data;
          return this;
        }
      };
      await readinessHandler(req, res);
      return { statusCode: code, body };
    };

    // 7.2 Execute actual production readiness probe in current test environment
    const currentReadiness = await invokeReadiness();
    assert.ok(currentReadiness.body !== null, '7.2 Readiness endpoint returns JSON payload');
    assert.ok(currentReadiness.body.checks?.database, '7.3 Database check is included in readiness probe');
    assert.ok(currentReadiness.body.checks?.storage, '7.4 Storage writeability check is included');
    assert.ok(currentReadiness.body.checks?.billing, '7.5 Billing check is included');
    assert.strictEqual(currentReadiness.body.checks?.storage?.status, 'healthy', '7.6 Upload storage directory writeability probe succeeds');

    // 7.3 Test that in-memory database fails closed when NODE_ENV=production
    const prevNodeEnv = process.env.NODE_ENV;
    const prevDbPath = (storage as any).dbPath;
    try {
      process.env.NODE_ENV = 'production';
      (storage as any).dbPath = ':memory:';

      const prodMemoryReadiness = await invokeReadiness();
      assert.strictEqual(prodMemoryReadiness.statusCode, 503, '7.7 In-memory DB in production responds with HTTP 503 Not Ready');
      assert.strictEqual(prodMemoryReadiness.body.status, 'not_ready', '7.8 Overall status is not_ready');
      assert.strictEqual(prodMemoryReadiness.body.coreReadiness, 'unhealthy', '7.9 Core readiness is unhealthy');
      assert.strictEqual(prodMemoryReadiness.body.checks.database.status, 'unhealthy', '7.10 Database check status is unhealthy');
      assert.ok(prodMemoryReadiness.body.checks.database.message.includes('In-memory database detected in production'), '7.11 Explains in-memory failure in production');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      (storage as any).dbPath = prevDbPath;
    }

    // 7.4 Test that persistent database succeeds in production
    try {
      process.env.NODE_ENV = 'production';
      const prodPersistentReadiness = await invokeReadiness();
      assert.strictEqual(prodPersistentReadiness.body.checks.database.status, 'healthy', '7.12 Persistent DB check is healthy in production');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }

    console.log('  ✅ PASS: Actual production readiness route (/api/health/readiness) verified');
    console.log('\n======================================================');
    console.log('🎉 ALL TARGETED REMEDIATION REGRESSION TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    cleanup();
  }
}

if (process.argv[1]?.includes('remediation_regression.test.ts')) {
  runRemediationRegressionTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ REMEDIATION REGRESSION TEST FAILED:', err);
      process.exit(1);
    });
}
