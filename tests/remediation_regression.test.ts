import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { execFile } from 'child_process';
import {
  videoProcessor,
  VideoProcessingError,
  calculateOcrSamplingTimestamps,
  validateTesseractTsv
} from '../src/server/pipeline/videoProcessor';
import { thumbnailInspector } from '../src/server/pipeline/thumbnailInspector';
import { mediaInspector, MediaInspectionError } from '../src/server/pipeline/mediaInspector';
import os from 'os';
import { SpeechTranscriptionAdapter, speechTranscriptionAdapter, audioProcessor } from '../src/server/pipeline/audioProcessor';
import { policyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { billingService } from '../src/server/services/billingService';
import { JobOrchestrator, mapVideoOcrDetectorReport } from '../src/server/pipeline/jobOrchestrator';
import { validateStripeWebhookSecret } from '../scripts/validate-env';
import { apiRouter } from '../src/server/routes/api';
import { InMemoryStorageRepository, storage } from '../src/server/storage';
import { MediaMetadata, VideoOcrResult } from '../src/types';

const execFileAsync = promisify(execFile);

export async function runRemediationRegressionTests() {
  console.log('\n======================================================');
  console.log('--- PHASE 4–6 REMEDIATION TARGETED REGRESSION TESTS ---');
  console.log('Fixes A–F: Evidence Coverage, Strict TSV, Whisper Identity,');
  console.log('Missing Confidence, Extraction Diagnostics & Orchestrator Path');
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
          fs.rmSync(f, { recursive: true, force: true });
        }
      } catch {}
    }
    try {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  };

  try {
    // -------------------------------------------------------------------------
    // 1. FIX A: EVIDENCE-BASED TIMELINE COVERAGE & 4-CELL MATRIX TESTS
    // -------------------------------------------------------------------------
    console.log('[1. Fix A — Evidence-Based Timeline Coverage & 4-Cell Matrix Verification]');

    // Create a 3-second test video with text overlay appearing between 0.5s and 2.5s
    const dummyVideoPath = path.resolve(testDir, 'dummy_ocr.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', "testsrc=size=320x240:rate=10:duration=3,drawtext=text='VERIFY OCR':fontsize=32:fontcolor=yellow:box=1:boxcolor=black@0.95:boxborderw=8:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,0.5,2.5)'",
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

    // 1.1 Real 3s video execution separates discrete sampling from unverified continuous interval coverage
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
    assert.strictEqual(ocr3s.timelineCoverageStatus, 'NOT_VERIFIED', '1.10a Discrete still-frame sampling marks temporal interval coverage NOT_VERIFIED');
    assert.strictEqual(ocr3s.timelineCoverageRatio, null, '1.10b Continuous timelineCoverageRatio is null (never synthesized from duration/framesTargeted)');
    assert.deepStrictEqual(ocr3s.plannedTimestamps?.length, 3, '1.10c plannedTimestamps records 3 targeted sample timestamps');
    assert.deepStrictEqual(ocr3s.extractedTimestamps?.length, 3, '1.10d extractedTimestamps records 3 extracted sample timestamps');
    assert.deepStrictEqual(ocr3s.succeededTimestamps?.length, 3, '1.10e succeededTimestamps records 3 OCR-verified sample timestamps');
    assert.ok(ocr3s.limitations.includes('not verified'), '1.10f Limitations explicitly note temporal interval coverage between still frames is not verified');

    // 1.2 COMPLETE 4-CELL SAMPLING MATRIX (Standard 10m/30m: 15 samples; Deep 10m/30m: 30 samples)
    console.log('  Testing complete 4-cell sampling matrix...');
    const tsStandard10m = calculateOcrSamplingTimestamps(600, 15);
    assert.strictEqual(tsStandard10m.length, 15, '1.11 Cell 1: Standard 10m produces exactly 15 timestamps');
    assert.strictEqual(tsStandard10m[0], 0, '1.12 Cell 1: Starts at 0s');
    assert.ok(tsStandard10m[tsStandard10m.length - 1] >= 590 && tsStandard10m[tsStandard10m.length - 1] <= 600, '1.13 Cell 1: Reaches end of 600s');

    const tsStandard30m = calculateOcrSamplingTimestamps(1800, 15);
    assert.strictEqual(tsStandard30m.length, 15, '1.14 Cell 2: Standard 30m produces exactly 15 timestamps');
    assert.strictEqual(tsStandard30m[0], 0, '1.15 Cell 2: Starts at 0s');
    assert.ok(tsStandard30m[tsStandard30m.length - 1] >= 1780 && tsStandard30m[tsStandard30m.length - 1] <= 1800, '1.16 Cell 2: Reaches end of 1800s');

    const tsDeep10m = calculateOcrSamplingTimestamps(600, 30);
    assert.strictEqual(tsDeep10m.length, 30, '1.17 Cell 3: Deep 10m produces exactly 30 timestamps');
    assert.strictEqual(tsDeep10m[0], 0, '1.18 Cell 3: Starts at 0s');
    assert.ok(tsDeep10m[tsDeep10m.length - 1] >= 590 && tsDeep10m[tsDeep10m.length - 1] <= 600, '1.19 Cell 3: Reaches end of 600s');

    const tsDeep30m = calculateOcrSamplingTimestamps(1800, 30);
    assert.strictEqual(tsDeep30m.length, 30, '1.20 Cell 4: Deep 30m produces exactly 30 timestamps');
    assert.strictEqual(tsDeep30m[0], 0, '1.21 Cell 4: Starts at 0s');
    assert.ok(tsDeep30m[tsDeep30m.length - 1] >= 1780 && tsDeep30m[tsDeep30m.length - 1] <= 1800, '1.22 Cell 4: Reaches end of 1800s');

    const tsStandard10m_2 = calculateOcrSamplingTimestamps(600, 15);
    assert.deepStrictEqual(tsStandard10m, tsStandard10m_2, '1.23 Sampling is completely deterministic');
    assert.strictEqual(new Set(tsStandard10m).size, 15, '1.24 All timestamps in 10m are unique');
    assert.strictEqual(new Set(tsDeep30m).size, 30, '1.25 All timestamps in Deep 30m are unique');

    const tsShort = calculateOcrSamplingTimestamps(0.8, 15);
    assert.deepStrictEqual(tsShort, [0], '1.26 Media under 1s yields single timestamp [0]');

    // 1.3 SPARSE SAMPLING ACROSS LONG TIMELINE NEVER FABRICATES TEMPORAL COVERAGE
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
    const sparseOcr = await videoProcessor.performVideoOcr(dummyVideoPath, sparseMeta, { timestamps: [0.5, 2.5] });
    assert.deepStrictEqual(sparseOcr.plannedTimestamps, [0.5, 2.5], '1.27a Planned timestamps accurately preserved');
    assert.deepStrictEqual(sparseOcr.extractedTimestamps, [0.5, 2.5], '1.27b Extracted timestamps accurately preserved');
    assert.deepStrictEqual(sparseOcr.succeededTimestamps, [0.5, 2.5], '1.27c Succeeded timestamps accurately preserved');
    assert.strictEqual(sparseOcr.samplingCoverageRatio, 1.0, '1.27d Discrete sample fulfillment is 2/2 = 1.0');
    assert.strictEqual(sparseOcr.timelineCoverageStatus, 'NOT_VERIFIED', '1.28a Sparse still samples do NOT claim verified timeline coverage');
    assert.strictEqual(sparseOcr.timelineCoverageRatio, null, '1.28b timelineCoverageRatio remains null (no synthetic duration/framesTargeted window)');

    console.log('  ✅ PASS: Evidence-based discrete sampling & unverified continuous interval separation verified');

    // -------------------------------------------------------------------------
    // 2. FIX B: OCR FAILURE CLASSIFICATION & STRICT TESSERACT TSV VALIDATION
    // -------------------------------------------------------------------------
    console.log('\n[2. Fix B — OCR Failure Classification & Strict 12-Column Tesseract TSV Validation]');

    // Test 2.1: Missing Tesseract executable reports UNAVAILABLE
    process.env.TESSERACT_PATH = '/path/to/missing/tesseract';
    const missingTessRes = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, { maxFrames: 3 });
    assert.strictEqual(missingTessRes.status, 'ANALYSIS_UNAVAILABLE', '2.1 Missing Tesseract reports ANALYSIS_UNAVAILABLE');
    assert.notStrictEqual(missingTessRes.status, 'NO_SIGNAL_DETECTED', '2.2 Missing Tesseract CANNOT report NO_SIGNAL_DETECTED');
    assert.strictEqual(missingTessRes.timelineCoverageStatus, 'NOT_VERIFIED', '2.2a Unavailable OCR leaves timelineCoverageStatus NOT_VERIFIED');
    assert.strictEqual(missingTessRes.timelineCoverageRatio, null, '2.2b Unavailable OCR leaves timelineCoverageRatio null');
    assert.strictEqual(missingTessRes.ocrExecutionSuccessRatio, null, '2.2c Unattempted OCR leaves ocrExecutionSuccessRatio null');

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
    assert.strictEqual(failingOcrRes.ocrExecutionSuccessRatio, 0, '2.7 Success ratio is strictly 0 when all attempted OCR fails');

    // Test 2.3: Mock partial OCR binary (fails on frame 1)
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
    assert.ok(typeof partialOcrRes.ocrExecutionSuccessRatio === 'number' && partialOcrRes.ocrExecutionSuccessRatio < 1.0, '2.10 Success ratio is under 100%');
    assert.strictEqual(partialOcrRes.framesExtractionFailed, 0, '2.11 OCR failure is NOT counted as extraction failure');

    // Test 2.3a: Non-executable Tesseract & Tesseract Timeout must fail honestly, never NO_SIGNAL_DETECTED
    const nonExecOcrScript = path.resolve(testDir, 'non_exec_ocr.sh');
    fs.writeFileSync(nonExecOcrScript, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    generatedFiles.push(nonExecOcrScript);
    process.env.TESSERACT_PATH = nonExecOcrScript;
    const nonExecOcrRes = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, { maxFrames: 2 });
    assert.strictEqual(nonExecOcrRes.executionStatus, 'FAILED', '2.11-ne Non-executable Tesseract reports FAILED executionStatus');
    assert.strictEqual(nonExecOcrRes.status, 'INSUFFICIENT_EVIDENCE', '2.11-ne Non-executable Tesseract returns INSUFFICIENT_EVIDENCE');
    assert.notStrictEqual(nonExecOcrRes.status, 'NO_SIGNAL_DETECTED', '2.11-ne Non-executable Tesseract never claims NO_SIGNAL_DETECTED');
    assert.strictEqual(nonExecOcrRes.framesSucceeded, 0, '2.11-ne Non-executable Tesseract records 0 succeeded frames');

    const timeoutOcrScript = path.resolve(testDir, 'timeout_ocr.sh');
    fs.writeFileSync(timeoutOcrScript, '#!/bin/sh\nsleep 2\nexit 0\n', { mode: 0o755 });
    generatedFiles.push(timeoutOcrScript);
    process.env.TESSERACT_PATH = timeoutOcrScript;
    const timeoutOcrRes = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, { maxFrames: 2, timeoutMs: 120 });
    assert.strictEqual(timeoutOcrRes.executionStatus, 'FAILED', '2.11-to Timeout Tesseract reports FAILED executionStatus');
    assert.notStrictEqual(timeoutOcrRes.status, 'NO_SIGNAL_DETECTED', '2.11-to Timeout Tesseract never claims NO_SIGNAL_DETECTED');
    assert.strictEqual(timeoutOcrRes.framesSucceeded, 0, '2.11-to Timeout Tesseract records 0 succeeded frames');

    // Test 2.3b: Malformed TSV returned with exit code 0 must be counted as framesOcrFailed, NEVER NO_SIGNAL_DETECTED
    const malformedTsvOcrScript = path.resolve(testDir, 'malformed_tsv_ocr.sh');
    fs.writeFileSync(malformedTsvOcrScript, `#!/bin/sh
printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n"
printf "5\\t1\\t1\\t1\\t1\\t1\\t10abc\\t10\\t50\\t20\\t90xyz\\tSAMPLE\\n"
`, { mode: 0o755 });
    generatedFiles.push(malformedTsvOcrScript);
    process.env.TESSERACT_PATH = malformedTsvOcrScript;
    const malformedTsvRes = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, { maxFrames: 3 });
    assert.strictEqual(malformedTsvRes.framesOcrFailed, 3, '2.11a Malformed TSV counted as framesOcrFailed');
    assert.strictEqual(malformedTsvRes.framesSucceeded, 0, '2.11b Malformed TSV never counted as framesSucceeded');
    assert.notStrictEqual(malformedTsvRes.status, 'NO_SIGNAL_DETECTED', '2.11c Malformed TSV never falsely claims NO_SIGNAL_DETECTED');

    // Test 2.4: Strict Canonical 12-Column TSV Schema Validation
    const canonicalHeader = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

    assert.strictEqual(validateTesseractTsv('').isValid, false, '2.12 Empty TSV is rejected');

    const headerOnlyRes = validateTesseractTsv(`${canonicalHeader}\n`);
    assert.strictEqual(headerOnlyRes.isValid, false, '2.13 Header-only TSV without data rows is rejected');
    assert.ok(headerOnlyRes.error?.includes('missing data lines'), '2.14 Documents missing data lines');

    assert.strictEqual(validateTesseractTsv('foo\tbar\tbaz\n1\t2\t3').isValid, false, '2.15 Header lacking required columns is rejected');

    // Reordered, duplicate, or extra header columns must be rejected
    const reorderedHeader = 'page_num\tlevel\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t95\tSAMPLE\n';
    assert.strictEqual(validateTesseractTsv(reorderedHeader).isValid, false, '2.15a Reordered canonical header columns rejected');

    const extraHeader = `${canonicalHeader}\textra_col\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t95\tSAMPLE\tfoo\n`;
    assert.strictEqual(validateTesseractTsv(extraHeader).isValid, false, '2.15b Extra column in header rejected');

    const duplicateHeader = 'level\tlevel\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t95\tSAMPLE\n';
    assert.strictEqual(validateTesseractTsv(duplicateHeader).isValid, false, '2.15c Duplicate column in header rejected');

    // Row column count mismatch (< 12 and > 12)
    assert.strictEqual(validateTesseractTsv(`${canonicalHeader}\n5\t1\t1\t1`).isValid, false, '2.16 Row with fewer than 12 columns rejected');
    assert.strictEqual(validateTesseractTsv(`${canonicalHeader}\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t95\tSAMPLE\tEXTRA`).isValid, false, '2.16a Row with extra (> 12) columns rejected');

    // Trailing non-numeric junk (previously bypassed parseInt/parseFloat)
    assert.strictEqual(validateTesseractTsv(`${canonicalHeader}\n5\t1\t1\t1\t1\t1\t10abc\t10\t50\t20\t95\tSAMPLE\n`).isValid, false, '2.17a Trailing junk in geometry (10abc) rejected');
    assert.strictEqual(validateTesseractTsv(`${canonicalHeader}\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t90xyz\tSAMPLE\n`).isValid, false, '2.17b Trailing junk in confidence (90xyz) rejected');
    assert.strictEqual(validateTesseractTsv(`${canonicalHeader}\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t12.5invalid\tSAMPLE\n`).isValid, false, '2.17c Partial float junk (12.5invalid) rejected');

    // Decimals for integer geometry fields must be rejected
    assert.strictEqual(validateTesseractTsv(`${canonicalHeader}\n5\t1\t1\t1\t1\t1\t10.5\t10\t50\t20\t95\tSAMPLE\n`).isValid, false, '2.17d Decimal in integer geometry rejected');
    assert.strictEqual(validateTesseractTsv(`${canonicalHeader}\n5\t1\t1\t1\t1\t1\tINVALID_NUM\t10\t50\t20\t95\tSAMPLE\n`).isValid, false, '2.17e Non-numeric geometry rejected');

    // Invalid hierarchy level (0 or 6) and page_num = 0 rejected
    assert.strictEqual(validateTesseractTsv(`${canonicalHeader}\n0\t1\t0\t0\t0\t0\t0\t0\t640\t360\t-1\t\n`).isValid, false, '2.17f Hierarchy level 0 rejected');
    assert.strictEqual(validateTesseractTsv(`${canonicalHeader}\n6\t1\t0\t0\t0\t0\t0\t0\t640\t360\t-1\t\n`).isValid, false, '2.17g Hierarchy level 6 rejected');

    // Out-of-bounds confidence
    assert.strictEqual(validateTesseractTsv(`${canonicalHeader}\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t150\tSAMPLE\n`).isValid, false, '2.18 Confidence above 100 rejected');
    assert.strictEqual(validateTesseractTsv(`${canonicalHeader}\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t-5\tSAMPLE\n`).isValid, false, '2.19 Confidence below -1 rejected');

    // Valid blank image TSV (level=1 page row, conf=-1, empty text field with exact 12 columns)
    const validTsvNoText = `${canonicalHeader}\n1\t1\t0\t0\t0\t0\t0\t0\t640\t360\t-1\t\n`;
    const validNoTextRes = validateTesseractTsv(validTsvNoText);
    assert.strictEqual(validNoTextRes.isValid, true, '2.20 Valid blank image TSV accepted');
    assert.strictEqual(validNoTextRes.words.length, 0, '2.21 Zero words parsed from blank image');

    // Valid TSV with decimal confidence (real Tesseract emits e.g. 95.123456) and text
    const validTsvWithText = `${canonicalHeader}\n5\t1\t1\t1\t1\t1\t10\t10\t50\t20\t95.125\tSAMPLE\n`;
    const validWithTextRes = validateTesseractTsv(validTsvWithText);
    assert.strictEqual(validWithTextRes.isValid, true, '2.22 Valid text TSV with float confidence accepted');
    assert.strictEqual(validWithTextRes.words.length, 1, '2.23 One word extracted');
    assert.strictEqual(validWithTextRes.words[0], 'SAMPLE', '2.24 Extracted word is SAMPLE');

    delete process.env.TESSERACT_PATH;
    console.log('  ✅ PASS: Strict 12-column Tesseract TSV schema & failure isolation verified');

    // -------------------------------------------------------------------------
    // 3. FIX C: WHISPER RUNTIME IDENTITY & MODEL HEADER VERIFICATION
    // -------------------------------------------------------------------------
    console.log('\n[3. Fix C — Whisper STT Runtime Identity & Model Verification]');

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

    // 3.5 Arbitrary binary exiting 0 (even when named "whisper_fake.sh") MUST be rejected (no basename guessing)
    const spoofedBasenameBin = path.resolve(testDir, 'whisper_fake_stt.sh');
    fs.writeFileSync(spoofedBasenameBin, `#!/bin/sh\necho "Arbitrary Utility v1.0.0"\nexit 0\n`, { mode: 0o755 });
    generatedFiles.push(spoofedBasenameBin);

    process.env.WHISPER_PATH = spoofedBasenameBin;
    const arbitraryValidation = await stt.validateRuntime();
    assert.strictEqual(arbitraryValidation.status, 'ERROR', '3.6 Basename-spoofed binary without CLI identity rejected as ERROR');
    assert.strictEqual(arbitraryValidation.runtimeType, 'unconfigured', '3.6a Unknown runtime does not fall back to generic whisper_cli');

    // Binary mentioning "whisper" without runtime-specific CLI flags MUST also be rejected
    const weakBannerBin = path.resolve(testDir, 'weak_banner.sh');
    fs.writeFileSync(weakBannerBin, `#!/bin/sh\necho "not actually whisper cli flags here"\nexit 0\n`, { mode: 0o755 });
    generatedFiles.push(weakBannerBin);
    process.env.WHISPER_PATH = weakBannerBin;
    assert.strictEqual((await stt.validateRuntime()).status, 'ERROR', '3.6b Binary lacking runtime flag contract rejected');

    // 3.6 whisper_cpp runtime identity without configured model
    const mockWhisperCpp = path.resolve(testDir, 'mock_whisper_cpp.sh');
    fs.writeFileSync(
      mockWhisperCpp,
      `#!/bin/sh\nif [ "$1" = "--help" ] || [ "$1" = "--version" ]; then\n  echo "whisper.cpp main: -m FNAME, --model FNAME -f FNAME, --file FNAME --output-json"\n  exit 0\nfi\nexit 0\n`,
      { mode: 0o755 }
    );
    generatedFiles.push(mockWhisperCpp);

    process.env.WHISPER_PATH = mockWhisperCpp;
    delete process.env.WHISPER_MODEL_PATH;
    const whisperCppNoModel = await stt.validateRuntime();
    assert.strictEqual(whisperCppNoModel.runtimeType, 'whisper_cpp', '3.7 Correctly identifies whisper_cpp runtime via flags & banner');
    assert.strictEqual(whisperCppNoModel.status, 'MISSING_MODEL', '3.8 whisper_cpp without model reports MISSING_MODEL');

    // 3.7 Model file exists but is empty (0 bytes)
    const emptyModel = path.resolve(testDir, 'empty_whisper_model.bin');
    fs.writeFileSync(emptyModel, '');
    generatedFiles.push(emptyModel);

    process.env.WHISPER_MODEL_PATH = emptyModel;
    const emptyModelValidation = await stt.validateRuntime();
    assert.strictEqual(emptyModelValidation.status, 'MISSING_MODEL', '3.9 Empty (0-byte) model reports MISSING_MODEL');
    assert.ok(emptyModelValidation.details?.includes('empty file (0 bytes)'), '3.10 Documents empty model file');

    // 3.7b Arbitrary non-empty text/garbage file MUST NOT pass model format validation
    const fakeTextModel = path.resolve(testDir, 'fake_text_model.bin');
    fs.writeFileSync(fakeTextModel, 'FAKE_MODEL_WEIGHTS_BINARY_DATA');
    generatedFiles.push(fakeTextModel);
    process.env.WHISPER_MODEL_PATH = fakeTextModel;
    const fakeModelValidation = await stt.validateRuntime();
    assert.strictEqual(fakeModelValidation.status, 'ERROR', '3.10a Arbitrary non-GGML/GGUF file rejected by whisper_cpp model check');
    assert.strictEqual(fakeModelValidation.modelFound, false, '3.10b Invalid model format does not set modelFound=true');

    // 3.8 Valid GGML/GGUF binary header model file and whisper_cpp runtime -> READY
    const validModel = path.resolve(testDir, 'valid_whisper_model.bin');
    fs.writeFileSync(validModel, Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(64, 0x01)]));
    generatedFiles.push(validModel);

    process.env.WHISPER_MODEL_PATH = validModel;
    const readyValidation = await stt.validateRuntime();
    assert.strictEqual(readyValidation.status, 'READY', '3.11 whisper_cpp with valid GGUF model header reports READY');
    assert.strictEqual(readyValidation.modelFound, true, '3.11a modelFound is true for valid header');

    // 3.8b openai_whisper explicit contract verification + invalid PyTorch model rejection
    const mockOpenAiWhisper = path.resolve(testDir, 'mock_openai_whisper.sh');
    fs.writeFileSync(
      mockOpenAiWhisper,
      `#!/bin/sh\nif [ "$1" = "--help" ] || [ "$1" = "--version" ]; then\n  echo "usage: whisper [-h] [--model MODEL] [--output_format {txt,vtt,srt,tsv,json,all}]"\n  exit 0\nfi\nexit 0\n`,
      { mode: 0o755 }
    );
    generatedFiles.push(mockOpenAiWhisper);
    process.env.WHISPER_PATH = mockOpenAiWhisper;
    delete process.env.WHISPER_MODEL_PATH;
    const openAiReady = await stt.validateRuntime();
    assert.strictEqual(openAiReady.runtimeType, 'openai_whisper', '3.11b Recognizes openai_whisper contract explicitly');
    assert.strictEqual(openAiReady.status, 'READY', '3.11c openai_whisper reports READY');

    process.env.WHISPER_MODEL_PATH = fakeTextModel;
    const openAiBadModel = await stt.validateRuntime();
    assert.strictEqual(openAiBadModel.status, 'ERROR', '3.11d openai_whisper rejects corrupt/non-PyTorch WHISPER_MODEL_PATH');

    const validPtModel = path.resolve(testDir, 'base.pt');
    fs.writeFileSync(validPtModel, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x02)]));
    generatedFiles.push(validPtModel);
    process.env.WHISPER_MODEL_PATH = validPtModel;
    assert.strictEqual((await stt.validateRuntime()).status, 'READY', '3.11e openai_whisper accepts valid PyTorch ZIP checkpoint header');

    // 3.9 Enforce preflight before transcribe()
    process.env.WHISPER_PATH = mockWhisperCpp;
    process.env.WHISPER_MODEL_PATH = emptyModel;
    const preflightBlocked = await stt.transcribe(dummyVideoPath, 10);
    assert.strictEqual(preflightBlocked.status, 'ANALYSIS_UNAVAILABLE', '3.12 Preflight blocks transcription when runtime not READY');
    assert.ok(preflightBlocked.failureReason?.includes('empty file'), '3.13 Explains model failure in failureReason');

    // 3.10 verifyRuntimeCompatibility() diagnostic contract coverage
    delete process.env.WHISPER_PATH;
    delete process.env.LOCAL_STT_PATH;
    delete process.env.WHISPER_MODEL_PATH;
    assert.strictEqual((await stt.verifyRuntimeCompatibility()).diagnosticCode, 'UNCONFIGURED', '3.14 Compatibility probe: UNCONFIGURED');

    process.env.WHISPER_PATH = '/usr/local/bin/nonexistent_whisper_compat';
    assert.strictEqual((await stt.verifyRuntimeCompatibility()).diagnosticCode, 'BINARY_NOT_FOUND', '3.15 Compatibility probe: BINARY_NOT_FOUND');

    process.env.WHISPER_PATH = nonExecPath;
    assert.strictEqual((await stt.verifyRuntimeCompatibility()).diagnosticCode, 'BINARY_NOT_EXECUTABLE', '3.16 Compatibility probe: BINARY_NOT_EXECUTABLE');

    const failProbeBin = path.resolve(testDir, 'whisper_fail_probe.sh');
    fs.writeFileSync(failProbeBin, `#!/bin/sh\necho "segfault during probe" >&2\nexit 2\n`, { mode: 0o755 });
    generatedFiles.push(failProbeBin);
    process.env.WHISPER_PATH = failProbeBin;
    assert.strictEqual((await stt.verifyRuntimeCompatibility()).diagnosticCode, 'IDENTITY_PROBE_FAILED', '3.17 Compatibility probe: IDENTITY_PROBE_FAILED');

    process.env.WHISPER_PATH = spoofedBasenameBin;
    assert.strictEqual((await stt.verifyRuntimeCompatibility()).diagnosticCode, 'IDENTITY_CONTRACT_MISMATCH', '3.18 Compatibility probe: IDENTITY_CONTRACT_MISMATCH');

    process.env.WHISPER_PATH = mockWhisperCpp;
    delete process.env.WHISPER_MODEL_PATH;
    assert.strictEqual((await stt.verifyRuntimeCompatibility()).diagnosticCode, 'MODEL_NOT_CONFIGURED', '3.19 Compatibility probe: MODEL_NOT_CONFIGURED');

    process.env.WHISPER_MODEL_PATH = '/path/to/missing_ggml.bin';
    assert.strictEqual((await stt.verifyRuntimeCompatibility()).diagnosticCode, 'MODEL_NOT_FOUND', '3.20 Compatibility probe: MODEL_NOT_FOUND');

    const unreadableModel = path.resolve(testDir, 'unreadable_model.bin');
    fs.writeFileSync(unreadableModel, Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(64, 0x01)]), { mode: 0o644 });
    generatedFiles.push(unreadableModel);
    fs.chmodSync(unreadableModel, 0o000);
    try {
      process.env.WHISPER_MODEL_PATH = unreadableModel;
      assert.strictEqual((await stt.verifyRuntimeCompatibility()).diagnosticCode, 'MODEL_NOT_READABLE', '3.21 Compatibility probe: MODEL_NOT_READABLE');
    } finally {
      fs.chmodSync(unreadableModel, 0o644);
    }

    process.env.WHISPER_MODEL_PATH = fakeTextModel;
    assert.strictEqual((await stt.verifyRuntimeCompatibility()).diagnosticCode, 'MODEL_INCOMPATIBLE', '3.22 Compatibility probe: header MODEL_INCOMPATIBLE');

    // Runtime execution tests for whisper_cpp contract (fail closed if -of is omitted)
    const compatWhisperCppBin = path.resolve(testDir, 'compat_whisper_cpp.sh');
    fs.writeFileSync(
      compatWhisperCppBin,
      `#!/bin/sh
if [ "$1" = "--help" ] || [ "$1" = "--version" ]; then
  echo "whisper.cpp main: -m FNAME, --model FNAME -f FNAME, --file FNAME --output-json"
  exit 0
fi
OUT_PREFIX=""
PREV=""
for arg in "$@"; do
  if [ "$PREV" = "-of" ]; then OUT_PREFIX="$arg"; fi
  PREV="$arg"
done
if [ -z "$OUT_PREFIX" ]; then
  echo "error: missing required -of output prefix argument" >&2
  exit 2
fi
case "\${COMPAT_MODE:-pass}" in
  timeout)
    sleep 2
    exit 0
    ;;
  bad_model)
    echo "error: failed to initialize whisper context: invalid model magic" >&2
    exit 1
    ;;
  runtime_init)
    echo "error while loading shared libraries: libwhisper.so.1: cannot open shared object file" >&2
    exit 127
    ;;
  fail_exit)
    echo "runtime crash" >&2
    exit 3
    ;;
  empty)
    echo '{"transcription":[]}' > "\${OUT_PREFIX}.json"
    exit 0
    ;;
  pass)
    echo '{"transcription":[{"timestamps":{"from":"00:00:00,000","to":"00:00:01,000"},"text":" hello compat test"}]}' > "\${OUT_PREFIX}.json"
    exit 0
    ;;
  noisy)
    echo '{"transcription":[{"timestamps":{"from":"00:00:00,000","to":"00:00:01,000"},"text":" hello compat test extra garbage unrelated noise words"}]}' > "\${OUT_PREFIX}.json"
    exit 0
    ;;
esac
`,
      { mode: 0o755 }
    );
    generatedFiles.push(compatWhisperCppBin);

    // Helper to build a valid 16kHz mono 16-bit PCM WAV header + PCM payload for mock CLI contract tests
    const writeTestPcmWav = (wavPath: string, sampleRate: number, amplitude: number) => {
      const numSamples = Math.floor(sampleRate * 0.5);
      const dataSize = numSamples * 2;
      const buf = Buffer.alloc(44 + dataSize);
      buf.write('RIFF', 0, 'ascii');
      buf.writeUInt32LE(36 + dataSize, 4);
      buf.write('WAVE', 8, 'ascii');
      buf.write('fmt ', 12, 'ascii');
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(1, 20);
      buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(sampleRate, 24);
      buf.writeUInt32LE(sampleRate * 2, 28);
      buf.writeUInt16LE(2, 32);
      buf.writeUInt16LE(16, 34);
      buf.write('data', 36, 'ascii');
      buf.writeUInt32LE(dataSize, 40);
      for (let i = 0; i < numSamples; i++) {
        const val = amplitude > 0 ? Math.round(Math.sin((2 * Math.PI * 300 * i) / sampleRate) * amplitude * 32767) : 0;
        buf.writeInt16LE(val, 44 + i * 2);
      }
      fs.writeFileSync(wavPath, buf);
      generatedFiles.push(wavPath);
    };

    const mockSpeechWav = path.resolve(testDir, 'mock_speech_16k.wav');
    writeTestPcmWav(mockSpeechWav, 16000, 0.25);

    const silentWav = path.resolve(testDir, 'silent_16k.wav');
    writeTestPcmWav(silentWav, 16000, 0);

    const wrongRateWav = path.resolve(testDir, 'wrong_rate_8k.wav');
    writeTestPcmWav(wrongRateWav, 8000, 0.25);

    process.env.WHISPER_PATH = compatWhisperCppBin;
    process.env.WHISPER_MODEL_PATH = validModel;
    delete process.env.WHISPER_COMPAT_AUDIO_PATH;
    delete process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT;
    delete process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE;
    stt.clearCompatibilityCache();

    // 3.23a Fails closed with SPEECH_FIXTURE_NOT_FOUND when no audio fixture is configured (no sine-tone fabrication)
    const missingFixtureRes = await stt.verifyRuntimeCompatibility();
    assert.strictEqual(missingFixtureRes.compatible, false, '3.23a No speech fixture fails closed');
    assert.strictEqual(missingFixtureRes.diagnosticCode, 'SPEECH_FIXTURE_NOT_FOUND', '3.23b Reports SPEECH_FIXTURE_NOT_FOUND without synthetic fallback');
    assert.strictEqual(missingFixtureRes.runtimeExecutionStatus, 'UNVERIFIED', '3.23b1 Missing fixture keeps runtimeExecutionStatus UNVERIFIED');
    assert.strictEqual(missingFixtureRes.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_UNVERIFIED', '3.23b2 Missing fixture keeps speechTranscriptStatus UNVERIFIED');

    // 3.23c Rejects silent or wrong-sample-rate WAV fixtures
    const silentFixtureRes = await stt.verifyRuntimeCompatibility({ audioFixturePath: silentWav });
    assert.strictEqual(silentFixtureRes.diagnosticCode, 'SPEECH_FIXTURE_INVALID', '3.23c Silent WAV rejected as SPEECH_FIXTURE_INVALID');
    assert.strictEqual(silentFixtureRes.runtimeExecutionStatus, 'FAILED', '3.23c1 Invalid fixture marks runtimeExecutionStatus FAILED');
    const wrongRateRes = await stt.verifyRuntimeCompatibility({ audioFixturePath: wrongRateWav });
    assert.strictEqual(wrongRateRes.diagnosticCode, 'SPEECH_FIXTURE_INVALID', '3.23d Non-16kHz WAV rejected as SPEECH_FIXTURE_INVALID');

    process.env.COMPAT_MODE = 'timeout';
    const compatTimeout = await stt.verifyRuntimeCompatibility({ timeoutMs: 120, audioFixturePath: mockSpeechWav });
    assert.strictEqual(compatTimeout.compatible, false);
    assert.strictEqual(compatTimeout.diagnosticCode, 'TRANSCRIPTION_TIMEOUT', '3.23 Compatibility probe: TRANSCRIPTION_TIMEOUT');
    assert.strictEqual(compatTimeout.runtimeExecutionStatus, 'FAILED', '3.23t Timeout marks runtimeExecutionStatus FAILED');

    process.env.COMPAT_MODE = 'bad_model';
    const compatBadModel = await stt.verifyRuntimeCompatibility({ audioFixturePath: mockSpeechWav });
    assert.strictEqual(compatBadModel.diagnosticCode, 'MODEL_INCOMPATIBLE', '3.24 Compatibility probe: runtime MODEL_INCOMPATIBLE');

    process.env.COMPAT_MODE = 'runtime_init';
    const compatRuntimeInit = await stt.verifyRuntimeCompatibility({ audioFixturePath: mockSpeechWav });
    assert.strictEqual(compatRuntimeInit.diagnosticCode, 'RUNTIME_INIT_FAILED', '3.24b Compatibility probe: RUNTIME_INIT_FAILED on shared lib load error');

    process.env.COMPAT_MODE = 'fail_exit';
    const compatFailExit = await stt.verifyRuntimeCompatibility({ audioFixturePath: mockSpeechWav });
    assert.strictEqual(compatFailExit.diagnosticCode, 'TRANSCRIPTION_FAILED', '3.25 Compatibility probe: TRANSCRIPTION_FAILED');

    process.env.COMPAT_MODE = 'empty';
    const compatEmpty = await stt.verifyRuntimeCompatibility({ audioFixturePath: mockSpeechWav });
    assert.strictEqual(compatEmpty.diagnosticCode, 'EMPTY_TRANSCRIPTION_OUTPUT', '3.26 Compatibility probe: EMPTY_TRANSCRIPTION_OUTPUT');

    process.env.COMPAT_MODE = 'pass';
    // Runtime execution WITHOUT expectedTranscript -> RUNTIME_EXECUTION_VERIFIED + SPEECH_TRANSCRIPT_UNVERIFIED
    const runtimeOnlyCpp = await stt.verifyRuntimeCompatibility({ audioFixturePath: mockSpeechWav });
    assert.strictEqual(runtimeOnlyCpp.compatible, true, '3.26a1 Runtime execution without expected transcript succeeds');
    assert.strictEqual(runtimeOnlyCpp.runtimeExecutionStatus, 'RUNTIME_EXECUTION_VERIFIED', '3.26a2 Marks runtimeExecutionStatus RUNTIME_EXECUTION_VERIFIED');
    assert.strictEqual(runtimeOnlyCpp.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_UNVERIFIED', '3.26a3 Keeps speechTranscriptStatus SPEECH_TRANSCRIPT_UNVERIFIED when no reference provided');
    assert.strictEqual(runtimeOnlyCpp.transcriptComparison?.compared, false, '3.26a4 transcriptComparison.compared is false');

    // Empty / punctuation-only expectedTranscript -> fails closed as SPEECH_TRANSCRIPT_FAILED
    const compatEmptyRef = await stt.verifyRuntimeCompatibility({
      audioFixturePath: mockSpeechWav,
      expectedTranscript: '!!! ---   '
    });
    assert.strictEqual(compatEmptyRef.compatible, false, '3.26a5 Punctuation-only expected transcript fails closed');
    assert.strictEqual(compatEmptyRef.runtimeExecutionStatus, 'RUNTIME_EXECUTION_VERIFIED', '3.26a6 Runtime execution succeeded even though reference failed');
    assert.strictEqual(compatEmptyRef.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_FAILED', '3.26a7 Punctuation-only expected transcript yields SPEECH_TRANSCRIPT_FAILED');
    assert.strictEqual(compatEmptyRef.transcriptComparison?.expectedTokenCount, 0, '3.26a8 Records expectedTokenCount=0');

    const compatBlankRef = await stt.verifyRuntimeCompatibility({
      audioFixturePath: mockSpeechWav,
      expectedTranscript: ''
    });
    assert.strictEqual(compatBlankRef.compatible, false, '3.26a9 Explicit empty expected transcript fails closed');
    assert.strictEqual(compatBlankRef.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_FAILED', '3.26a10 Explicit empty expected transcript yields SPEECH_TRANSCRIPT_FAILED');

    const compatMismatch = await stt.verifyRuntimeCompatibility({
      audioFixturePath: mockSpeechWav,
      expectedTranscript: 'completely unrelated reference phrase'
    });
    assert.strictEqual(compatMismatch.compatible, false, '3.26b Completely incorrect transcript fails closed');
    assert.strictEqual(compatMismatch.diagnosticCode, 'TRANSCRIPTION_FAILED', '3.26c Mismatch classifies as TRANSCRIPTION_FAILED');
    assert.strictEqual(compatMismatch.runtimeExecutionStatus, 'RUNTIME_EXECUTION_VERIFIED', '3.26c1 Preserves RUNTIME_EXECUTION_VERIFIED alongside transcript failure');
    assert.strictEqual(compatMismatch.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_FAILED', '3.26c2 Sets SPEECH_TRANSCRIPT_FAILED on mismatch');
    assert.strictEqual(compatMismatch.referenceMatched, false, '3.26d Records referenceMatched=false');
    assert.strictEqual(compatMismatch.transcriptComparison?.passed, false, '3.26d1 transcriptComparison.passed=false');
    assert.strictEqual(compatMismatch.transcriptComparison?.matchedTokenCount, 0, '3.26d2 Records 0 matched tokens');

    const compatMissingWords = await stt.verifyRuntimeCompatibility({
      audioFixturePath: mockSpeechWav,
      expectedTranscript: 'hello compat test missing expected words'
    });
    assert.strictEqual(compatMissingWords.compatible, false, '3.26e Missing expected words fail closed');
    assert.strictEqual(compatMissingWords.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_FAILED', '3.26e1 Missing expected words set SPEECH_TRANSCRIPT_FAILED');

    const compatWordOrderMismatch = await stt.verifyRuntimeCompatibility({
      audioFixturePath: mockSpeechWav,
      expectedTranscript: 'test compat hello'
    });
    assert.strictEqual(compatWordOrderMismatch.compatible, false, '3.26f Major word-order mismatch fails closed');

    process.env.COMPAT_MODE = 'noisy';
    const compatNoisyWords = await stt.verifyRuntimeCompatibility({
      audioFixturePath: mockSpeechWav,
      expectedTranscript: 'hello compat test'
    });
    assert.strictEqual(compatNoisyWords.compatible, false, '3.26g Excessive unexpected words fail closed');
    assert.ok((compatNoisyWords.transcriptComparison?.precision ?? 1) < 0.8, '3.26g1 Records failing precision < 0.80');

    process.env.COMPAT_MODE = 'pass';
    const compatPunctPass = await stt.verifyRuntimeCompatibility({
      audioFixturePath: mockSpeechWav,
      expectedTranscript: 'Hello,   COMPAT\n  test!'
    });
    assert.strictEqual(compatPunctPass.compatible, true, '3.26h Punctuation/casing/whitespace differences tolerated');
    assert.strictEqual(compatPunctPass.referenceMatched, true, '3.26i Records referenceMatched=true on normalized match');
    assert.strictEqual(compatPunctPass.runtimeExecutionStatus, 'RUNTIME_EXECUTION_VERIFIED', '3.26i1 Sets RUNTIME_EXECUTION_VERIFIED');
    assert.strictEqual(compatPunctPass.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_VERIFIED', '3.26i2 Sets SPEECH_TRANSCRIPT_VERIFIED');
    assert.strictEqual(compatPunctPass.transcriptComparison?.recall, 1, '3.26i3 Records recall=1');
    assert.strictEqual(compatPunctPass.transcriptComparison?.precision, 1, '3.26i4 Records precision=1');
    assert.strictEqual(compatPunctPass.transcriptComparison?.score, 1, '3.26i5 Records score=1');

    // Synthetic/mock fixture guard: CANNOT grant SPEECH_TRANSCRIPT_VERIFIED
    const compatSyntheticGuard = await stt.verifyRuntimeCompatibility({
      audioFixturePath: mockSpeechWav,
      expectedTranscript: 'hello compat test',
      isSyntheticFixture: true
    });
    assert.strictEqual(compatSyntheticGuard.compatible, true, '3.26j1 Synthetic fixture still passes runtime execution check');
    assert.strictEqual(compatSyntheticGuard.runtimeExecutionStatus, 'RUNTIME_EXECUTION_VERIFIED', '3.26j2 Sets RUNTIME_EXECUTION_VERIFIED');
    assert.strictEqual(compatSyntheticGuard.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_UNVERIFIED', '3.26j3 Synthetic fixture NEVER receives SPEECH_TRANSCRIPT_VERIFIED');
    assert.strictEqual(compatSyntheticGuard.transcriptComparison?.passed, false, '3.26j4 transcriptComparison.passed=false for synthetic fixture');

    const compatPassCpp = await stt.verifyRuntimeCompatibility({
      audioFixturePath: mockSpeechWav,
      expectedTranscript: 'hello compat test'
    });
    assert.strictEqual(compatPassCpp.compatible, true, '3.27 whisper_cpp compatibility passes with JSON transcript');
    assert.strictEqual(compatPassCpp.diagnosticCode, 'VERIFICATION_PASSED', '3.28 whisper_cpp reports VERIFICATION_PASSED');
    assert.strictEqual(compatPassCpp.transcriptText, 'hello compat test', '3.29 whisper_cpp extracts non-empty transcriptText');
    assert.strictEqual(compatPassCpp.segmentsCount, 1, '3.30 whisper_cpp records segment count');
    assert.strictEqual(compatPassCpp.referenceMatched, true, '3.30a Reference transcript match verified');
    assert.strictEqual(compatPassCpp.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_VERIFIED', '3.30a1 SPEECH_TRANSCRIPT_VERIFIED set');

    // Cached initializeRuntime() hit & fingerprint invalidation when model changes
    stt.clearCompatibilityCache();
    const initCold = await stt.initializeRuntime({ audioFixturePath: mockSpeechWav, expectedTranscript: 'hello compat test' });
    assert.strictEqual(initCold.compatible, true, '3.30b Cold initializeRuntime succeeds');
    assert.strictEqual(initCold.fromCache, false, '3.30c Cold run has fromCache=false');
    const initWarm = await stt.initializeRuntime({ audioFixturePath: mockSpeechWav, expectedTranscript: 'hello compat test' });
    assert.strictEqual(initWarm.compatible, true, '3.30d Warm initializeRuntime succeeds');
    assert.strictEqual(initWarm.fromCache, true, '3.30e Warm run served from cache (fromCache=true)');

    // WHISPER_VERIFY_COMPATIBILITY=true with missing fixture refuses silent bypass in transcribe()
    const prevVerifyCompat = process.env.WHISPER_VERIFY_COMPATIBILITY;
    try {
      process.env.WHISPER_VERIFY_COMPATIBILITY = 'true';
      delete process.env.WHISPER_COMPAT_AUDIO_PATH;
      stt.clearCompatibilityCache();
      const missingFixtureTranscribe = await stt.transcribe(dummyVideoPath, 10);
      assert.strictEqual(missingFixtureTranscribe.status, 'ANALYSIS_UNAVAILABLE', '3.30f1 WHISPER_VERIFY_COMPATIBILITY=true without fixture fails closed');
      assert.strictEqual(missingFixtureTranscribe.diagnosticCode, 'SPEECH_FIXTURE_NOT_FOUND', '3.30f2 Reports SPEECH_FIXTURE_NOT_FOUND without silent bypass');
      assert.strictEqual(missingFixtureTranscribe.compatibilityVerified, false, '3.30f3 compatibilityVerified=false');
    } finally {
      if (prevVerifyCompat === undefined) delete process.env.WHISPER_VERIFY_COMPATIBILITY;
      else process.env.WHISPER_VERIFY_COMPATIBILITY = prevVerifyCompat;
    }

    // Transcribe preflight compatibility gating + recovery after fix
    process.env.COMPAT_MODE = 'runtime_init';
    stt.clearCompatibilityCache();
    const blockedTranscribe = await stt.transcribe(dummyVideoPath, 10, {
      verifyCompatibility: true,
      audioFixturePath: mockSpeechWav
    });
    assert.strictEqual(blockedTranscribe.status, 'ANALYSIS_UNAVAILABLE', '3.30f transcribe blocks on failed compatibility init');
    assert.strictEqual(blockedTranscribe.diagnosticCode, 'RUNTIME_INIT_FAILED', '3.30g Preserves RUNTIME_INIT_FAILED diagnosticCode');
    assert.strictEqual(blockedTranscribe.compatibilityVerified, false, '3.30h Records compatibilityVerified=false');

    process.env.COMPAT_MODE = 'pass';
    const recoveredTranscribe = await stt.transcribe(dummyVideoPath, 10, {
      verifyCompatibility: true,
      audioFixturePath: mockSpeechWav,
      forceRefreshCompatibility: true
    });
    assert.strictEqual(recoveredTranscribe.compatibilityVerified, true, '3.30i transcribe succeeds and records compatibilityVerified=true once runtime issue is fixed');
    assert.strictEqual(recoveredTranscribe.runtimeExecutionStatus, 'RUNTIME_EXECUTION_VERIFIED', '3.30i1 Records runtimeExecutionStatus=RUNTIME_EXECUTION_VERIFIED');
    assert.strictEqual(recoveredTranscribe.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_UNVERIFIED', '3.30i2 Records speechTranscriptStatus=SPEECH_TRANSCRIPT_UNVERIFIED without expectedTranscript');

    delete process.env.COMPAT_MODE;

    // Runtime execution pass test for openai_whisper contract (fail closed if --output_dir is omitted)
    const compatOpenAiBin = path.resolve(testDir, 'compat_openai_whisper.sh');
    fs.writeFileSync(
      compatOpenAiBin,
      `#!/bin/sh
if [ "$1" = "--help" ] || [ "$1" = "--version" ]; then
  echo "usage: whisper [-h] [--model MODEL] [--output_format {txt,vtt,srt,tsv,json,all}]"
  exit 0
fi
AUDIO="$1"
OUT_DIR=""
PREV=""
for arg in "$@"; do
  if [ "$PREV" = "--output_dir" ]; then OUT_DIR="$arg"; fi
  PREV="$arg"
done
if [ -z "$OUT_DIR" ]; then
  echo "error: missing required --output_dir argument" >&2
  exit 2
fi
BASE=$(basename "$AUDIO" .wav)
BASE_MP4=$(basename "$AUDIO" .mp4)
OUT_NAME="$BASE"
if [ "$BASE" = "$AUDIO" ] || [ -n "$(echo "$AUDIO" | grep '\\.mp4$')" ]; then
  OUT_NAME="$BASE_MP4"
fi
echo '{"text":"openai whisper test","segments":[{"start":0,"end":1.1,"text":"openai whisper test"}]}' > "\${OUT_DIR}/\${OUT_NAME}.json"
exit 0
`,
      { mode: 0o755 }
    );
    generatedFiles.push(compatOpenAiBin);

    process.env.WHISPER_PATH = compatOpenAiBin;
    process.env.WHISPER_MODEL_PATH = validPtModel;
    stt.clearCompatibilityCache();
    const compatPassOpenAi = await stt.verifyRuntimeCompatibility({ audioFixturePath: mockSpeechWav });
    assert.strictEqual(compatPassOpenAi.compatible, true, '3.31 openai_whisper compatibility passes with JSON output_dir artifact');
    assert.strictEqual(compatPassOpenAi.diagnosticCode, 'VERIFICATION_PASSED', '3.32 openai_whisper reports VERIFICATION_PASSED');
    assert.strictEqual(compatPassOpenAi.runtimeExecutionStatus, 'RUNTIME_EXECUTION_VERIFIED', '3.32a openai_whisper sets RUNTIME_EXECUTION_VERIFIED');
    assert.strictEqual(compatPassOpenAi.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_UNVERIFIED', '3.32b openai_whisper without expectedTranscript stays SPEECH_TRANSCRIPT_UNVERIFIED');
    assert.strictEqual(compatPassOpenAi.transcriptText, 'openai whisper test', '3.33 openai_whisper parses direct text output');

    delete process.env.WHISPER_PATH;
    delete process.env.WHISPER_MODEL_PATH;
    delete process.env.WHISPER_COMPAT_AUDIO_PATH;
    delete process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT;
    delete process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE;
    stt.clearCompatibilityCache();
    console.log('  [Boundary Notice] Real Whisper binary+model human speech transcription: NOT VERIFIED in container (no Whisper binary/model or TTS/speech WAV installed; verified via mocked whisper_cpp/openai_whisper CLI contracts).');
    console.log('  ✅ PASS: Whisper STT strict runtime identity, model header & two-tier compatibility verification complete');

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
    // 5. FIX D: DETECTOR REPORT CONFIDENCE MUST PRESERVE MISSING EVIDENCE
    // -------------------------------------------------------------------------
    console.log('\n[5. Fix D — Video OCR Detector Report Confidence & Missing Evidence Preservation]');

    // 5.1 Empty detected frames -> confidence is undefined (NOT 0, 0.85, or 0.90)
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
      timelineCoverageStatus: 'NOT_VERIFIED',
      timelineCoverageRatio: null,
      samplingCoverageRatio: 1.0,
      ocrExecutionSuccessRatio: 1.0
    };

    const emptyReport = mapVideoOcrDetectorReport(emptyOcrResult, meta3s, 'standard');
    assert.strictEqual(emptyReport.confidence, undefined, '5.1 Missing confidence when no frames detected remains undefined (NOT 0 or 0.85)');
    assert.strictEqual(emptyReport.details?.ocrExecutionSuccessRatio, 1.0, '5.2 Preserves OCR execution success ratio');
    assert.strictEqual(emptyReport.details?.timelineCoverageRatio, null, '5.2a Detector report details preserve timelineCoverageRatio = null');
    assert.strictEqual(emptyReport.details?.timelineCoverageStatus, 'NOT_VERIFIED', '5.2b Detector report details preserve timelineCoverageStatus = NOT_VERIFIED');

    // 5.2 Genuine confidence > 0 preserved when present
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

    // 5.3 Actual measured confidence = 0 is preserved strictly as 0 (distinct from missing)
    const explicitZeroConfResult: VideoOcrResult = {
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
    const explicitZeroConfReport = mapVideoOcrDetectorReport(explicitZeroConfResult, meta3s, 'standard');
    assert.strictEqual(explicitZeroConfReport.confidence, 0, '5.4 Actual confidence = 0 preserved distinctly as numeric 0');

    // 5.4 Frame present WITHOUT numeric confidence -> confidence remains undefined (unavailable)
    const missingFrameConfResult: VideoOcrResult = {
      allExtractedText: ['SAMPLE'],
      detectedFrames: [{
        timestamp: 1.0,
        frameIndex: 0,
        frameFile: 'frame_000.png',
        text: 'SAMPLE',
        confidence: null,
        boundingBoxes: []
      }],
      totalCandidateFrames: 15,
      framesInspected: 15,
      coverageRatio: 1.0,
      executionDurationMs: 100,
      status: 'DETECTED',
      limitations: 'Sample without confidence'
    };
    const missingFrameConfReport = mapVideoOcrDetectorReport(missingFrameConfResult, meta3s, 'standard');
    assert.strictEqual(missingFrameConfReport.confidence, undefined, '5.4a Missing frame confidence remains undefined (never coerced to 0 or 0.85)');

    // 5.4b PolicyIntelligence timeline keeps missing OCR frame confidence null/UNKNOWN rather than 0% or 85%
    const partialTimeline = policyIntelligenceEngine.generateEvidenceTimeline({
      scanId: 'scan_missing_conf',
      metadata: meta3s,
      scanMode: 'standard',
      audioResult: {
        hasVoiceover: false,
        voiceoverRatio: 0,
        silenceRatio: 1,
        hasMusicDetected: null,
        segments: [],
        transcriptSummary: 'None',
        advertiserSpeechFlags: []
      },
      videoResult: {
        scenesCount: 1,
        framesSampled: 3,
        hasSlideshowPattern: false,
        repeatedFootageSegments: [],
        templateRepetitions: [],
        averagePacingSeconds: 3,
        tempFramesDir: '',
        videoOcr: missingFrameConfResult
      },
      thumbnailProvided: false
    });
    const missingConfItem = partialTimeline.find(t => t.type === 'video_text_overlay');
    assert.ok(missingConfItem, '5.4b Timeline item generated for detected text without confidence');
    assert.strictEqual(missingConfItem!.confidence, null, '5.4c EvidenceItem confidence is null when unavailable');
    assert.strictEqual(missingConfItem!.confidenceLevel, 'UNKNOWN', '5.4d ConfidenceLevel is UNKNOWN when unavailable');
    assert.ok(missingConfItem!.details.includes('Confidence: unavailable'), '5.4e Details text states Confidence: unavailable');

    // 5.5 Zero vs null ratio preservation check in details
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
      ocrExecutionSuccessRatio: null
    };
    const zeroReport = mapVideoOcrDetectorReport(zeroOcrResult, meta3s, 'standard');
    assert.strictEqual(zeroReport.details?.framesExtracted, 0, '5.5 Zero frames extracted preserved');
    assert.strictEqual(zeroReport.details?.ocrExecutionSuccessRatio, null, '5.6 Unattempted OCR preserves null success ratio');

    console.log('  ✅ PASS: 3-state confidence preservation (missing vs 0 vs >0) & zero-value accounting verified');

    // -------------------------------------------------------------------------
    // 6. SHARED STRIPE WEBHOOK SECRET VALIDATION & BILLING SEPARATION
    // -------------------------------------------------------------------------
    console.log('\n[6. Shared Stripe Webhook Secret Validation & Billing Separation]');

    const validWhsec = 'whsec_abcdef1234567890abcdef1234567890';
    const invalidArbitrary = 'arbitrary_secret_value_12345';
    const shortWhsec = 'whsec_short';

    assert.strictEqual(validateStripeWebhookSecret(validWhsec).isValid, true, '6.1 Standard whsec_ passes shared validation');
    assert.strictEqual(validateStripeWebhookSecret(invalidArbitrary).isValid, false, '6.2 Non-whsec string rejected by shared validator');
    assert.strictEqual(validateStripeWebhookSecret(shortWhsec).isValid, false, '6.3 Short whsec rejected by shared validator');
    assert.strictEqual(validateStripeWebhookSecret('').isValid, false, '6.4 Empty secret rejected');
    assert.strictEqual(validateStripeWebhookSecret(null).isValid, false, '6.5 Null secret rejected');

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

    const readinessLayer = (apiRouter as any).stack.find((layer: any) =>
      layer.route && layer.route.path === '/health/readiness'
    );
    assert.ok(readinessLayer, '7.1 /health/readiness route handler exists in apiRouter');
    const readinessHandler = readinessLayer.route.stack[0].handle;

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

    const currentReadiness = await invokeReadiness();
    assert.ok(currentReadiness.body !== null, '7.2 Readiness endpoint returns JSON payload');
    assert.ok(currentReadiness.body.checks?.database, '7.3 Database check is included in readiness probe');
    assert.ok(currentReadiness.body.checks?.storage, '7.4 Storage writeability check is included');
    assert.ok(currentReadiness.body.checks?.billing, '7.5 Billing check is included');
    assert.ok(currentReadiness.body.checks?.whisperStt, '7.5b Optional whisperStt check is exposed in readiness payload');
    assert.strictEqual(currentReadiness.body.checks?.whisperStt?.details?.diagnosticCode, 'UNCONFIGURED', '7.5c Unconfigured whisperStt reports UNCONFIGURED honestly');
    assert.strictEqual(currentReadiness.body.checks?.whisperStt?.details?.compatibilityStatus, 'UNCONFIGURED', '7.5d Unconfigured whisperStt marks compatibilityStatus UNCONFIGURED');
    assert.strictEqual(currentReadiness.body.checks?.storage?.status, 'healthy', '7.6 Upload storage directory writeability probe succeeds');

    const prevWhisperPathReadiness = process.env.WHISPER_PATH;
    const prevWhisperModelReadiness = process.env.WHISPER_MODEL_PATH;
    const prevWhisperAudioReadiness = process.env.WHISPER_COMPAT_AUDIO_PATH;
    const prevWhisperExpectedReadiness = process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT;
    const prevWhisperVerifyReadiness = process.env.WHISPER_VERIFY_COMPATIBILITY;
    const prevWhisperSyntheticReadiness = process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE;
    try {
      process.env.WHISPER_PATH = '/secret/host/dir/nonexistent_whisper_readiness';
      const degradedWhisperReadiness = await invokeReadiness();
      assert.strictEqual(degradedWhisperReadiness.statusCode, 200, '7.6b Degraded optional Whisper STT does not bring down core readiness');
      assert.strictEqual(degradedWhisperReadiness.body.checks?.whisperStt?.status, 'degraded', '7.6c Invalid WHISPER_PATH surfaces degraded whisperStt check');
      assert.strictEqual(degradedWhisperReadiness.body.checks?.whisperStt?.details?.diagnosticCode, 'BINARY_NOT_FOUND', '7.6d Surfaces BINARY_NOT_FOUND diagnostic code');
      assert.strictEqual(degradedWhisperReadiness.body.checks?.whisperStt?.details?.compatibilityStatus, 'FAILED', '7.6e Failed preflight sets compatibilityStatus FAILED');
      assert.strictEqual(degradedWhisperReadiness.body.checks?.whisperStt?.details?.binaryStatus, 'MISSING_EXECUTABLE', '7.6e1 Exposes binaryStatus MISSING_EXECUTABLE');
      assert.ok(!String(degradedWhisperReadiness.body.checks?.whisperStt?.details?.failureReason || '').includes('/secret/host/dir'), '7.6e2 failureReason sanitizes full host filesystem directory paths');

      // Configured READY preflight without speech fixture -> UNVERIFIED (and degraded when WHISPER_VERIFY_COMPATIBILITY=true)
      process.env.WHISPER_PATH = compatWhisperCppBin;
      process.env.WHISPER_MODEL_PATH = validModel;
      delete process.env.WHISPER_COMPAT_AUDIO_PATH;
      delete process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT;
      delete process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE;
      delete process.env.WHISPER_VERIFY_COMPATIBILITY;
      speechTranscriptionAdapter.clearCompatibilityCache();
      const unverifiedReadiness = await invokeReadiness();
      assert.strictEqual(unverifiedReadiness.body.checks?.whisperStt?.details?.compatibilityStatus, 'UNVERIFIED', '7.6f Missing fixture marks compatibilityStatus UNVERIFIED');
      assert.strictEqual(unverifiedReadiness.body.checks?.whisperStt?.details?.runtimeExecutionStatus, 'UNVERIFIED', '7.6f1 runtimeExecutionStatus is UNVERIFIED');
      assert.strictEqual(unverifiedReadiness.body.checks?.whisperStt?.details?.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_UNVERIFIED', '7.6f2 speechTranscriptStatus is SPEECH_TRANSCRIPT_UNVERIFIED');
      assert.strictEqual(unverifiedReadiness.body.checks?.whisperStt?.details?.compatibilityVerified, false, '7.6g Missing fixture marks compatibilityVerified false');

      process.env.WHISPER_VERIFY_COMPATIBILITY = 'true';
      const requiredMissingFixtureReadiness = await invokeReadiness();
      assert.strictEqual(requiredMissingFixtureReadiness.body.checks?.whisperStt?.status, 'degraded', '7.6h WHISPER_VERIFY_COMPATIBILITY=true with missing fixture marks whisperStt degraded');
      assert.strictEqual(requiredMissingFixtureReadiness.body.checks?.whisperStt?.details?.compatibilityRequired, true, '7.6i Marks compatibilityRequired=true');

      // Configured + WAV fixture WITHOUT expected transcript -> RUNTIME_EXECUTION_VERIFIED (NOT 'VERIFIED') + SPEECH_TRANSCRIPT_UNVERIFIED
      process.env.WHISPER_COMPAT_AUDIO_PATH = mockSpeechWav;
      process.env.COMPAT_MODE = 'pass';
      speechTranscriptionAdapter.clearCompatibilityCache();
      const runtimeOnlyReadiness = await invokeReadiness();
      assert.strictEqual(runtimeOnlyReadiness.body.checks?.whisperStt?.status, 'healthy', '7.6j Runtime-only verified Whisper runtime is healthy');
      assert.strictEqual(runtimeOnlyReadiness.body.checks?.whisperStt?.details?.runtimeExecutionStatus, 'RUNTIME_EXECUTION_VERIFIED', '7.6k1 Marks runtimeExecutionStatus RUNTIME_EXECUTION_VERIFIED');
      assert.strictEqual(runtimeOnlyReadiness.body.checks?.whisperStt?.details?.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_UNVERIFIED', '7.6k2 Keeps speechTranscriptStatus SPEECH_TRANSCRIPT_UNVERIFIED');
      assert.strictEqual(runtimeOnlyReadiness.body.checks?.whisperStt?.details?.compatibilityStatus, 'RUNTIME_EXECUTION_VERIFIED', '7.6k3 Never emits ambiguous VERIFIED without transcript match');
      assert.strictEqual(runtimeOnlyReadiness.body.checks?.whisperStt?.details?.runtimeExecutionVerified, true, '7.6k4 runtimeExecutionVerified=true');
      assert.strictEqual(runtimeOnlyReadiness.body.checks?.whisperStt?.details?.speechTranscriptVerified, false, '7.6k5 speechTranscriptVerified=false');
      assert.strictEqual(runtimeOnlyReadiness.body.checks?.whisperStt?.details?.compatibilityVerified, false, '7.6l compatibilityVerified remains false without speech transcript verification');
      assert.ok(runtimeOnlyReadiness.body.checks?.whisperStt?.details?.lastVerification?.timestamp, '7.6l1 lastVerification timestamp exposed');

      // Configured + WAV fixture WITH matching expected transcript -> SPEECH_TRANSCRIPT_VERIFIED
      process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT = 'hello compat test';
      speechTranscriptionAdapter.clearCompatibilityCache();
      const speechVerifiedReadiness = await invokeReadiness();
      assert.strictEqual(speechVerifiedReadiness.body.checks?.whisperStt?.status, 'healthy', '7.6l2 Speech-verified Whisper runtime is healthy');
      assert.strictEqual(speechVerifiedReadiness.body.checks?.whisperStt?.details?.compatibilityStatus, 'SPEECH_TRANSCRIPT_VERIFIED', '7.6l3 compatibilityStatus is SPEECH_TRANSCRIPT_VERIFIED');
      assert.strictEqual(speechVerifiedReadiness.body.checks?.whisperStt?.details?.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_VERIFIED', '7.6l4 speechTranscriptStatus is SPEECH_TRANSCRIPT_VERIFIED');
      assert.strictEqual(speechVerifiedReadiness.body.checks?.whisperStt?.details?.compatibilityVerified, true, '7.6l5 compatibilityVerified=true when both runtime and transcript verified');
      assert.strictEqual(speechVerifiedReadiness.body.checks?.whisperStt?.details?.transcriptComparison?.passed, true, '7.6l6 Exposes transcriptComparison metrics');

      // Synthetic fixture flag blocks SPEECH_TRANSCRIPT_VERIFIED on readiness even with matching expected transcript
      process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE = 'true';
      speechTranscriptionAdapter.clearCompatibilityCache();
      const syntheticReadiness = await invokeReadiness();
      assert.strictEqual(syntheticReadiness.body.checks?.whisperStt?.details?.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_UNVERIFIED', '7.6l7 Synthetic fixture cannot emit SPEECH_TRANSCRIPT_VERIFIED');
      assert.strictEqual(syntheticReadiness.body.checks?.whisperStt?.details?.compatibilityStatus, 'RUNTIME_EXECUTION_VERIFIED', '7.6l8 compatibilityStatus capped at RUNTIME_EXECUTION_VERIFIED');
      assert.strictEqual(syntheticReadiness.body.checks?.whisperStt?.details?.compatibilityVerified, false, '7.6l9 compatibilityVerified=false for synthetic fixture');
      delete process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE;

      // Transcript mismatch -> runtimeExecutionStatus=RUNTIME_EXECUTION_VERIFIED, speechTranscriptStatus=SPEECH_TRANSCRIPT_FAILED, degraded
      process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT = 'completely different words';
      speechTranscriptionAdapter.clearCompatibilityCache();
      const mismatchReadiness = await invokeReadiness();
      assert.strictEqual(mismatchReadiness.body.checks?.whisperStt?.status, 'degraded', '7.6m1 Transcript mismatch marks whisperStt degraded');
      assert.strictEqual(mismatchReadiness.body.checks?.whisperStt?.details?.runtimeExecutionStatus, 'RUNTIME_EXECUTION_VERIFIED', '7.6m2 runtimeExecutionStatus stays RUNTIME_EXECUTION_VERIFIED');
      assert.strictEqual(mismatchReadiness.body.checks?.whisperStt?.details?.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_FAILED', '7.6m3 speechTranscriptStatus is SPEECH_TRANSCRIPT_FAILED');
      assert.strictEqual(mismatchReadiness.body.checks?.whisperStt?.details?.compatibilityStatus, 'FAILED', '7.6m4 compatibilityStatus is FAILED');
      delete process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT;

      process.env.COMPAT_MODE = 'bad_model';
      speechTranscriptionAdapter.clearCompatibilityCache();
      const failedCompatReadiness = await invokeReadiness();
      assert.strictEqual(failedCompatReadiness.body.checks?.whisperStt?.status, 'degraded', '7.6m Incompatible Whisper runtime is degraded');
      assert.strictEqual(failedCompatReadiness.body.checks?.whisperStt?.details?.compatibilityStatus, 'FAILED', '7.6n Marks compatibilityStatus FAILED');
    } finally {
      delete process.env.COMPAT_MODE;
      speechTranscriptionAdapter.clearCompatibilityCache();
      if (prevWhisperPathReadiness === undefined) delete process.env.WHISPER_PATH;
      else process.env.WHISPER_PATH = prevWhisperPathReadiness;
      if (prevWhisperModelReadiness === undefined) delete process.env.WHISPER_MODEL_PATH;
      else process.env.WHISPER_MODEL_PATH = prevWhisperModelReadiness;
      if (prevWhisperAudioReadiness === undefined) delete process.env.WHISPER_COMPAT_AUDIO_PATH;
      else process.env.WHISPER_COMPAT_AUDIO_PATH = prevWhisperAudioReadiness;
      if (prevWhisperExpectedReadiness === undefined) delete process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT;
      else process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT = prevWhisperExpectedReadiness;
      if (prevWhisperVerifyReadiness === undefined) delete process.env.WHISPER_VERIFY_COMPATIBILITY;
      else process.env.WHISPER_VERIFY_COMPATIBILITY = prevWhisperVerifyReadiness;
      if (prevWhisperSyntheticReadiness === undefined) delete process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE;
      else process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE = prevWhisperSyntheticReadiness;
    }

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

    try {
      process.env.NODE_ENV = 'production';
      const prodPersistentReadiness = await invokeReadiness();
      assert.strictEqual(prodPersistentReadiness.body.checks.database.status, 'healthy', '7.12 Persistent DB check is healthy in production');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }

    console.log('  ✅ PASS: Actual production readiness route (/api/health/readiness) verified');

    // -------------------------------------------------------------------------
    // 8. FIX E: EXTRACTION FAILURE DIAGNOSTICS & ACCOUNTING INVARIANTS
    // -------------------------------------------------------------------------
    console.log('\n[8. Fix E — Extraction Failure Diagnostics & Accounting Invariants]');

    // 8.1 Corrupt media file triggers real FFmpeg NON_ZERO_EXIT diagnostics
    const corruptVideoPath = path.resolve(testDir, 'corrupt_video.mp4');
    fs.writeFileSync(corruptVideoPath, 'NOT_A_REAL_MP4_STREAM_CORRUPT_HEADER');
    generatedFiles.push(corruptVideoPath);

    process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    const corruptExtractionRes = await videoProcessor.performVideoOcr(corruptVideoPath, meta3s, { maxFrames: 3 });
    assert.strictEqual(corruptExtractionRes.status, 'ANALYSIS_UNAVAILABLE', '8.1 Corrupt video returns ANALYSIS_UNAVAILABLE');
    assert.strictEqual(corruptExtractionRes.framesTargeted, 3, '8.2 framesTargeted is 3');
    assert.strictEqual(corruptExtractionRes.framesExtracted, 0, '8.3 framesExtracted is 0');
    assert.strictEqual(corruptExtractionRes.framesExtractionFailed, 3, '8.4 All 3 extraction attempts recorded as framesExtractionFailed');
    assert.strictEqual(corruptExtractionRes.framesAttempted, 0, '8.5 Failed extractions NOT counted as OCR attempts');
    assert.strictEqual(corruptExtractionRes.framesSkipped, 0, '8.6 Failed extractions NOT counted as skipped frames');
    assert.strictEqual(corruptExtractionRes.ocrExecutionSuccessRatio, null, '8.7 ocrExecutionSuccessRatio is null when framesAttempted === 0');
    assert.ok(corruptExtractionRes.extractionErrors && corruptExtractionRes.extractionErrors.length === 3, '8.8 Bounded extractionErrors records 3 diagnostics');
    assert.ok(corruptExtractionRes.extractionErrors!.every(e => e.category === 'NON_ZERO_EXIT'), '8.9 Categorizes real FFmpeg failure as NON_ZERO_EXIT');

    // 8.2 Controlled FFmpeg wrapper exercising ALL failure categories: TIMEOUT, NON_ZERO_EXIT, MISSING_OUTPUT, EMPTY_OUTPUT + valid frame
    const validSamplePng = path.resolve(testDir, 'valid_sample.png');
    await execFileAsync('ffmpeg', ['-y', '-ss', '0', '-i', dummyVideoPath, '-vframes', '1', validSamplePng]);
    generatedFiles.push(validSamplePng);

    const mockFfmpegScript = path.resolve(testDir, 'mock_ffmpeg_ext.sh');
    fs.writeFileSync(mockFfmpegScript, `#!/bin/sh
OUT=""
TS=""
PREV=""
for arg in "$@"; do
  if [ "$PREV" = "-ss" ]; then
    TS="$arg"
  fi
  PREV="$arg"
  OUT="$arg"
done
case "$TS" in
  0)
    cp "${validSamplePng}" "$OUT"
    exit 0
    ;;
  0.5)
    sleep 2
    exit 0
    ;;
  1)
    echo "moov atom not found" >&2
    exit 1
    ;;
  1.5)
    exit 0
    ;;
  2)
    : > "$OUT"
    exit 0
    ;;
  *)
    cp "${validSamplePng}" "$OUT"
    exit 0
    ;;
esac
`, { mode: 0o755 });
    generatedFiles.push(mockFfmpegScript);

    const prevFfmpegPath = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = mockFfmpegScript;
    const ocrFramesRoot = path.resolve(process.cwd(), 'uploads', 'ocr_frames');
    const existingOcrDirs = new Set(fs.existsSync(ocrFramesRoot) ? fs.readdirSync(ocrFramesRoot) : []);
    const assertNoOcrDirLeak = (stepLabel: string) => {
      if (!fs.existsSync(ocrFramesRoot)) return;
      const afterDirs = fs.readdirSync(ocrFramesRoot);
      const leaked = afterDirs.filter(d => !existingOcrDirs.has(d));
      assert.strictEqual(leaked.length, 0, `${stepLabel}: Zero temp ocr_frames directories leaked (found ${leaked.join(', ')})`);
    };

    try {
      const diagRes = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, {
        timestamps: [0, 0.5, 1, 1.5, 2],
        perFrameTimeoutMs: 150,
        timeoutMs: 30000
      });

      assert.strictEqual(diagRes.framesTargeted, 5, '8.10 5 timestamps targeted');
      assert.strictEqual(diagRes.framesExtracted, 1, '8.11 Only frame at t=0 extracted');
      assert.strictEqual(diagRes.framesExtractionFailed, 4, '8.12 Remaining 4 failed extraction');
      assert.strictEqual(diagRes.framesAttempted, 1, '8.13 Only extracted frame attempted by OCR');
      assert.strictEqual(diagRes.framesSucceeded, 1, '8.14 OCR succeeded on the 1 extracted frame');
      assert.strictEqual(diagRes.framesOcrFailed, 0, '8.15 Zero OCR errors');
      assert.strictEqual(diagRes.framesSkipped, 0, '8.16 Zero skipped frames when all 5 extraction attempts ran');
      assert.strictEqual(diagRes.samplingCoverageRatio, 0.2, '8.17 Sampling fulfillment is 1/5 = 0.2');
      assert.strictEqual(diagRes.ocrExecutionSuccessRatio, 1.0, '8.18 OCR execution ratio on attempted frame is 1/1 = 1.0');
      assert.strictEqual(diagRes.timelineCoverageRatio, null, '8.19 Timeline coverage ratio remains null');
      assertNoOcrDirLeak('8.19b');

      const cats = diagRes.extractionErrors?.map(e => e.category) || [];
      assert.ok(cats.includes('TIMEOUT'), '8.20 Distinguishes TIMEOUT extraction failure');
      assert.ok(cats.includes('NON_ZERO_EXIT'), '8.21 Distinguishes NON_ZERO_EXIT extraction failure');
      assert.ok(cats.includes('MISSING_OUTPUT'), '8.22 Distinguishes MISSING_OUTPUT extraction failure');
      assert.ok(cats.includes('EMPTY_OUTPUT'), '8.23 Distinguishes EMPTY_OUTPUT (0-byte) extraction failure');
      // 8.3 MISSING_EXECUTABLE (ENOENT) breaks fast and preserves strict accounting invariant
      process.env.FFMPEG_PATH = '/path/to/missing/ffmpeg_binary_does_not_exist';
      const missingFfmpegRes = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, { maxFrames: 3 });
      assert.strictEqual(missingFfmpegRes.status, 'ANALYSIS_UNAVAILABLE', '8.25 Missing FFmpeg binary returns ANALYSIS_UNAVAILABLE');
      assert.strictEqual(missingFfmpegRes.framesExtractionFailed, 1, '8.26 Missing FFmpeg breaks fast after 1 attempt');
      assert.strictEqual(missingFfmpegRes.framesSkipped, 2, '8.27 Remaining 2 frames accurately recorded as framesSkipped');
      assert.strictEqual(
        (missingFfmpegRes.framesAttempted || 0) + (missingFfmpegRes.framesExtractionFailed || 0) + (missingFfmpegRes.framesSkipped || 0),
        missingFfmpegRes.framesTargeted,
        '8.28 Strict accounting invariant holds on MISSING_EXECUTABLE'
      );
      assert.strictEqual(missingFfmpegRes.extractionErrors?.[0]?.category, 'MISSING_EXECUTABLE', '8.29 Categorizes ENOENT strictly as MISSING_EXECUTABLE');
      assertNoOcrDirLeak('8.29b');

      // 8.4 NON_EXECUTABLE (EACCES) breaks fast and distinguishes permission errors
      const nonExecFfmpeg = path.resolve(testDir, 'non_exec_ffmpeg.sh');
      fs.writeFileSync(nonExecFfmpeg, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      generatedFiles.push(nonExecFfmpeg);
      process.env.FFMPEG_PATH = nonExecFfmpeg;
      const nonExecFfmpegRes = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, { maxFrames: 3 });
      assert.strictEqual(nonExecFfmpegRes.status, 'ANALYSIS_UNAVAILABLE', '8.30 Non-executable FFmpeg returns ANALYSIS_UNAVAILABLE');
      assert.strictEqual(nonExecFfmpegRes.extractionErrors?.[0]?.category, 'NON_EXECUTABLE', '8.31 Categorizes EACCES strictly as NON_EXECUTABLE');
      assert.strictEqual(
        (nonExecFfmpegRes.framesAttempted || 0) + (nonExecFfmpegRes.framesExtractionFailed || 0) + (nonExecFfmpegRes.framesSkipped || 0),
        nonExecFfmpegRes.framesTargeted,
        '8.32 Strict accounting invariant holds on NON_EXECUTABLE'
      );
      assertNoOcrDirLeak('8.32b');
    } finally {
      if (prevFfmpegPath === undefined) {
        delete process.env.FFMPEG_PATH;
      } else {
        process.env.FFMPEG_PATH = prevFfmpegPath;
      }
      delete process.env.TESSERACT_PATH;
    }

    console.log('  ✅ PASS: Extraction failure categorization (MISSING_EXECUTABLE/NON_EXECUTABLE/TIMEOUT/NON_ZERO_EXIT/MISSING_OUTPUT/EMPTY_OUTPUT), temp cleanup & invariants verified');

    // -------------------------------------------------------------------------
    // 9. FIX F: REAL PRODUCTION SAMPLING PATH THROUGH JobOrchestrator
    // -------------------------------------------------------------------------
    console.log('\n[9. Fix F — Real Production Sampling Path Through JobOrchestrator]');

    const capturedOcrCalls: Array<{
      mode: 'standard' | 'deep';
      durationSeconds: number;
      maxFrames?: number;
      sampleIntervalSeconds?: number;
      resolvedTimestamps: number[];
    }> = [];

    const makeOrchestratorTestStorage = async (scanMode: 'standard' | 'deep', durationSeconds: number) => {
      const memStorePath = path.resolve(testDir, `mem_fix_f_${scanMode}_${durationSeconds}_${Date.now()}.json`);
      generatedFiles.push(memStorePath);
      const memStorage = new InMemoryStorageRepository(memStorePath);
      const user = await memStorage.users.createUser(
        `orch_${scanMode}_${durationSeconds}@videorisk.test`,
        'hash',
        'salt',
        1000,
        'agency'
      );
      const scan = await memStorage.scans.createScan({
        id: `scan_fix_f_${scanMode}_${durationSeconds}_${Date.now()}`,
        userId: user.id,
        videoFilename: 'dummy_ocr.mp4',
        videoPath: dummyVideoPath,
        videoTitle: `Orchestrator ${scanMode} ${durationSeconds}s`,
        scanMode,
        status: 'QUEUED',
        currentStage: 'Upload',
        completedStages: ['Upload'],
        creditsUsed: 0,
        createdAt: new Date().toISOString()
      });
      return { memStorage, scan };
    };

    const runOrchestratorPathCase = async (scanMode: 'standard' | 'deep', simulatedDuration: number) => {
      const { memStorage, scan } = await makeOrchestratorTestStorage(scanMode, simulatedDuration);
      const customMeta: MediaMetadata = {
        ...meta3s,
        durationSeconds: simulatedDuration
      };

      const orchestrator = new JobOrchestrator(memStorage, false, {
        mediaInspector: {
          inspect: async () => customMeta
        },
        audioProcessor: {
          analyzeAudio: async () => ({
            hasVoiceover: false,
            voiceoverRatio: 0,
            silenceRatio: 1,
            hasMusicDetected: null,
            segments: [],
            transcriptSummary: 'No audio track',
            advertiserSpeechFlags: [],
            detectors: {}
          })
        },
        videoProcessor: {
          analyzeVideo: async (_p, m, sm) => videoProcessor.analyzeVideo(dummyVideoPath, { ...m, durationSeconds: 3.0 }, sm),
          performVideoOcr: async (p, m, opts) => {
            const planned = calculateOcrSamplingTimestamps(m.durationSeconds, opts?.maxFrames, opts?.sampleIntervalSeconds);
            capturedOcrCalls.push({
              mode: scanMode,
              durationSeconds: m.durationSeconds,
              maxFrames: opts?.maxFrames,
              sampleIntervalSeconds: opts?.sampleIntervalSeconds,
              resolvedTimestamps: planned
            });
            // Execute real Tesseract OCR on actual dummyVideoPath frames using planned count parity check
            const realOcr = await videoProcessor.performVideoOcr(p, meta3s, { maxFrames: opts?.maxFrames });
            return {
              ...realOcr,
              plannedTimestamps: planned,
              totalCandidateFrames: planned.length,
              framesTargeted: planned.length
            };
          },
          cleanupFrames: (dir) => videoProcessor.cleanupFrames(dir)
        }
      });

      const job = await memStorage.queue.claimNextJob((orchestrator as any).workerId, 60000);
      assert.ok(job, 'Queue job claimed for orchestrator execution');
      await orchestrator.executeJob(job!);
      const savedScan = await memStorage.scans.getScan(scan.id);
      const savedReport = await memStorage.scans.getReport(scan.id);
      return { savedScan, savedReport };
    };

    process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    try {
      // Standard 10m (600s) -> maxFrames=15, full timeline [0..~599.9]
      const std10m = await runOrchestratorPathCase('standard', 600);
      assert.strictEqual(std10m.savedScan?.status, 'COMPLETED', '9.1 Orchestrator completes standard 10m scan');
      assert.ok(std10m.savedReport?.detectors?.video_ocr, '9.2 Final RiskReport contains detectors.video_ocr');
      assert.strictEqual(std10m.savedReport?.detectors?.video_ocr?.details?.framesTargeted, 15, '9.3 Standard 10m targeted 15 frames via orchestrator');
      assert.strictEqual(std10m.savedReport?.detectors?.video_ocr?.details?.timelineCoverageRatio, null, '9.4 Persisted report keeps timelineCoverageRatio = null');
      assert.strictEqual(std10m.savedReport?.detectors?.video_ocr?.details?.timelineCoverageStatus, 'NOT_VERIFIED', '9.5 Persisted report marks timelineCoverageStatus NOT_VERIFIED');
      assert.ok(typeof std10m.savedReport?.detectors?.video_ocr?.confidence === 'number' && std10m.savedReport!.detectors!.video_ocr!.confidence! > 0, '9.6 Real Tesseract confidence preserved in persisted report');

      // Deep 30m (1800s) -> maxFrames=30, full timeline [0..~1799.9]
      const deep30m = await runOrchestratorPathCase('deep', 1800);
      assert.strictEqual(deep30m.savedScan?.status, 'COMPLETED', '9.7 Orchestrator completes deep 30m scan');
      assert.strictEqual(deep30m.savedReport?.detectors?.video_ocr?.details?.framesTargeted, 30, '9.8 Deep 30m targeted 30 frames via orchestrator');

      const stdCall = capturedOcrCalls.find(c => c.mode === 'standard' && c.durationSeconds === 600);
      const deepCall = capturedOcrCalls.find(c => c.mode === 'deep' && c.durationSeconds === 1800);
      assert.ok(stdCall && stdCall.maxFrames === 15 && stdCall.sampleIntervalSeconds === undefined, '9.9 Orchestrator passes maxFrames=15 with no fixed sampleIntervalSeconds override in standard mode');
      assert.ok(deepCall && deepCall.maxFrames === 30 && deepCall.sampleIntervalSeconds === undefined, '9.10 Orchestrator passes maxFrames=30 with no fixed sampleIntervalSeconds override in deep mode');
      assert.strictEqual(stdCall!.resolvedTimestamps[0], 0, '9.11 Standard orchestrator plan starts at 0s');
      assert.ok(stdCall!.resolvedTimestamps[14] >= 590, '9.12 Standard orchestrator plan reaches end of 600s timeline (not trapped at t=0)');
      assert.strictEqual(deepCall!.resolvedTimestamps[0], 0, '9.13 Deep orchestrator plan starts at 0s');
      assert.ok(deepCall!.resolvedTimestamps[29] >= 1780, '9.14 Deep orchestrator plan reaches end of 1800s timeline');
    } finally {
      delete process.env.TESSERACT_PATH;
    }

    console.log('  ✅ PASS: Production JobOrchestrator OCR sampling plan & end-to-end report persistence verified');

    // -------------------------------------------------------------------------
    // 10. FIX F (REAL MP4 E2E): ACTUAL 10-MIN (600s) & 30-MIN (1800s) 4-CELL MATRIX
    // -------------------------------------------------------------------------
    console.log('\n[10. Fix F (Real Media E2E) — Real 10m (600s) & 30m (1800s) 4-Case Pipeline]');

    const real10mPath = path.resolve(testDir, 'real_10m_600s.mp4');
    const real30mPath = path.resolve(testDir, 'real_30m_1800s.mp4');

    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', "color=c=navy:s=320x240:r=1:d=600,drawtext=text='AUDIT 10M SAMPLE':fontsize=26:fontcolor=yellow:box=1:boxcolor=black@0.95:boxborderw=6:x=(w-text_w)/2:y=(h-text_h)/2",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-g', '15',
      real10mPath
    ]);
    generatedFiles.push(real10mPath);

    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', "color=c=navy:s=320x240:r=1:d=1800,drawtext=text='AUDIT 30M SAMPLE':fontsize=26:fontcolor=yellow:box=1:boxcolor=black@0.95:boxborderw=6:x=(w-text_w)/2:y=(h-text_h)/2",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-g', '15',
      real30mPath
    ]);
    generatedFiles.push(real30mPath);

    const inspected10m = await mediaInspector.inspect(real10mPath, 'real_10m_600s.mp4');
    const inspected30m = await mediaInspector.inspect(real30mPath, 'real_30m_1800s.mp4');
    assert.ok(inspected10m.durationSeconds >= 599 && inspected10m.durationSeconds <= 601, `10.1 Real 10m fixture duration verified via FFprobe: ${inspected10m.durationSeconds}s`);
    assert.ok(inspected30m.durationSeconds >= 1799 && inspected30m.durationSeconds <= 1801, `10.2 Real 30m fixture duration verified via FFprobe: ${inspected30m.durationSeconds}s`);

    const runRealPipelineCell = async (
      label: string,
      filePath: string,
      filename: string,
      scanMode: 'standard' | 'deep',
      expectedMaxFrames: number,
      expectedMinDuration: number
    ) => {
      const storePath = path.resolve(testDir, `mem_real_${label}_${Date.now()}.json`);
      generatedFiles.push(storePath);
      const cellStorage = new InMemoryStorageRepository(storePath);
      const user = await cellStorage.users.createUser(
        `real_${label}_${Date.now()}@videorisk.test`,
        'hash',
        'salt',
        200,
        'agency'
      );
      const scan = await cellStorage.scans.createScan({
        id: `scan_real_${label}_${Date.now()}`,
        userId: user.id,
        videoFilename: filename,
        videoPath: filePath,
        videoTitle: `Real E2E ${label}`,
        scanMode,
        status: 'QUEUED',
        currentStage: 'Upload',
        completedStages: ['Upload'],
        creditsUsed: 0,
        createdAt: new Date().toISOString()
      });

      // Unmocked production JobOrchestrator: uses real mediaInspector, proxyGenerator, audioProcessor, videoProcessor (FFmpeg + Tesseract), and policyIntelligenceEngine
      const orchestrator = new JobOrchestrator(cellStorage, false);
      const job = await cellStorage.queue.claimNextJob((orchestrator as any).workerId, 120000);
      assert.ok(job, `${label}: Queue job claimed`);
      await orchestrator.executeJob(job!);

      const savedScan = await cellStorage.scans.getScan(scan.id);
      const savedReport = await cellStorage.scans.getReport(scan.id);
      assert.strictEqual(savedScan?.status, 'COMPLETED', `${label}: Scan completed with real binaries`);
      assert.ok((savedScan?.metadata?.durationSeconds || 0) >= expectedMinDuration, `${label}: Persisted duration reflects real media`);

      const ocrReport = savedReport?.detectors?.video_ocr;
      assert.ok(ocrReport, `${label}: video_ocr detector report persisted`);
      const details = ocrReport!.details as any;
      assert.strictEqual(details.framesTargeted, expectedMaxFrames, `${label}: Targeted exactly ${expectedMaxFrames} frames`);
      assert.strictEqual(details.framesExtracted, expectedMaxFrames, `${label}: Extracted all ${expectedMaxFrames} frames via FFmpeg`);
      assert.strictEqual(details.framesSucceeded, expectedMaxFrames, `${label}: Evaluated all ${expectedMaxFrames} frames via Tesseract`);
      assert.strictEqual(details.timelineCoverageRatio, null, `${label}: timelineCoverageRatio remains null`);
      assert.strictEqual(details.timelineCoverageStatus, 'NOT_VERIFIED', `${label}: timelineCoverageStatus remains NOT_VERIFIED`);

      const planned: number[] = details.plannedTimestamps || [];
      const extracted: number[] = details.extractedTimestamps || [];
      const succeeded: number[] = details.succeededTimestamps || [];
      assert.strictEqual(planned.length, expectedMaxFrames, `${label}: plannedTimestamps count matches`);
      assert.deepStrictEqual(extracted, planned, `${label}: extractedTimestamps match plannedTimestamps`);
      assert.deepStrictEqual(succeeded, planned, `${label}: succeededTimestamps match plannedTimestamps`);
      assert.strictEqual(new Set(planned).size, expectedMaxFrames, `${label}: all timestamps unique`);
      assert.strictEqual(planned[0], 0, `${label}: first sample starts at 0s`);
      assert.ok(planned[planned.length - 1] >= expectedMinDuration - 10 && planned[planned.length - 1] <= (savedScan?.metadata?.durationSeconds || expectedMinDuration), `${label}: final sample reaches near EOF within duration`);
      for (let idx = 1; idx < planned.length; idx++) {
        assert.ok(planned[idx] > planned[idx - 1], `${label}: timestamps strictly ascending at idx=${idx}`);
      }
    };

    process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    try {
      await runRealPipelineCell('10m_standard', real10mPath, 'real_10m_600s.mp4', 'standard', 15, 599);
      await runRealPipelineCell('10m_deep', real10mPath, 'real_10m_600s.mp4', 'deep', 30, 599);
      await runRealPipelineCell('30m_standard', real30mPath, 'real_30m_1800s.mp4', 'standard', 15, 1799);
      await runRealPipelineCell('30m_deep', real30mPath, 'real_30m_1800s.mp4', 'deep', 30, 1799);
      assertNoOcrDirLeak('10.e2e_ocr_frames');
    } finally {
      delete process.env.TESSERACT_PATH;
    }

    console.log('  [Boundary Notice] 10m/30m E2E fixtures use synthetic FFmpeg lavfi/drawtext MP4s; verifies real container probing, frame extraction, sampling matrix, OCR execution & temp cleanup, not general real-world video moderation accuracy.');
    console.log('  ✅ PASS: All 4 real MP4 E2E sampling runs (10m/30m x standard/deep) verified with real FFmpeg, FFprobe & Tesseract');

    // -------------------------------------------------------------------------
    // 11. FFPROBE (MediaInspector) & FFMPEG (VideoProcessor.analyzeVideo) DIAGNOSTICS
    // -------------------------------------------------------------------------
    console.log('\n[11. FFprobe (MediaInspector) & analyzeVideo FFmpeg Failure Diagnostics & Cleanup]');

    const prevFfprobeDiag = process.env.FFPROBE_PATH;
    const prevFfmpegDiag = process.env.FFMPEG_PATH;

    try {
      // 11.1 MediaInspector.inspect failure categories
      await assert.rejects(
        () => mediaInspector.inspect(path.join(testDir, 'does_not_exist.mp4'), 'does_not_exist.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'INVALID_INPUT_PATH',
        '11.1a Non-existent file classified INVALID_INPUT_PATH'
      );

      await assert.rejects(
        () => mediaInspector.inspect(testDir, 'testDir'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'INVALID_INPUT_PATH',
        '11.1b Directory path classified INVALID_INPUT_PATH'
      );

      process.env.FFPROBE_PATH = '/nonexistent/binary/ffprobe_missing';
      await assert.rejects(
        () => mediaInspector.inspect(dummyVideoPath, 'dummy_ocr.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'MISSING_EXECUTABLE',
        '11.1c Missing ffprobe classified MISSING_EXECUTABLE'
      );

      const nonExecFfprobe = path.resolve(testDir, 'non_exec_ffprobe.sh');
      fs.writeFileSync(nonExecFfprobe, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      generatedFiles.push(nonExecFfprobe);
      process.env.FFPROBE_PATH = nonExecFfprobe;
      await assert.rejects(
        () => mediaInspector.inspect(dummyVideoPath, 'dummy_ocr.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'NON_EXECUTABLE',
        '11.1d Non-executable ffprobe classified NON_EXECUTABLE'
      );

      const mockFfprobeDiag = path.resolve(testDir, 'mock_ffprobe_diag.sh');
      fs.writeFileSync(
        mockFfprobeDiag,
        `#!/bin/sh
case "\${PROBE_MODE:-empty}" in
  empty)
    exit 0
    ;;
  bad_json)
    echo "{not_valid_json"
    exit 0
    ;;
  no_streams)
    echo '{"format":{"duration":"5.0"},"streams":[]}'
    exit 0
    ;;
  term)
    kill -TERM $$
    ;;
  kill)
    kill -KILL $$
    ;;
esac
`,
        { mode: 0o755 }
      );
      generatedFiles.push(mockFfprobeDiag);
      process.env.FFPROBE_PATH = mockFfprobeDiag;

      process.env.PROBE_MODE = 'empty';
      await assert.rejects(
        () => mediaInspector.inspect(dummyVideoPath, 'dummy_ocr.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'EMPTY_OUTPUT',
        '11.1e Empty ffprobe output classified EMPTY_OUTPUT'
      );

      process.env.PROBE_MODE = 'bad_json';
      await assert.rejects(
        () => mediaInspector.inspect(dummyVideoPath, 'dummy_ocr.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'INVALID_OUTPUT',
        '11.1f Malformed ffprobe JSON classified INVALID_OUTPUT'
      );

      process.env.PROBE_MODE = 'no_streams';
      await assert.rejects(
        () => mediaInspector.inspect(dummyVideoPath, 'dummy_ocr.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'NO_MEDIA_STREAMS',
        '11.1g Missing container streams classified NO_MEDIA_STREAMS'
      );

      process.env.PROBE_MODE = 'term';
      await assert.rejects(
        () => mediaInspector.inspect(dummyVideoPath, 'dummy_ocr.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'TIMEOUT',
        '11.1h SIGTERM ffprobe classified TIMEOUT'
      );

      process.env.PROBE_MODE = 'kill';
      await assert.rejects(
        () => mediaInspector.inspect(dummyVideoPath, 'dummy_ocr.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'PROCESS_TERMINATED',
        '11.1i SIGKILL ffprobe classified PROCESS_TERMINATED'
      );
      delete process.env.PROBE_MODE;

      // Real ffprobe on corrupt media -> NON_ZERO_EXIT
      delete process.env.FFPROBE_PATH;
      await assert.rejects(
        () => mediaInspector.inspect(corruptVideoPath, 'corrupt_video.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'NON_ZERO_EXIT',
        '11.1j Corrupt media with real ffprobe classified NON_ZERO_EXIT'
      );

      // 11.2 VideoProcessor.analyzeVideo failure diagnostics & guaranteed tempFramesDir cleanup
      const framesRoot = path.resolve(process.cwd(), 'uploads', 'frames');
      const existingFrameDirs = new Set(fs.existsSync(framesRoot) ? fs.readdirSync(framesRoot) : []);
      const assertNoFrameDirLeak = (stepLabel: string) => {
        if (!fs.existsSync(framesRoot)) return;
        const afterDirs = fs.readdirSync(framesRoot);
        const leaked = afterDirs.filter(d => !existingFrameDirs.has(d));
        assert.strictEqual(leaked.length, 0, `${stepLabel}: Zero temp frame directories leaked (found ${leaked.join(', ')})`);
      };

      await assert.rejects(
        () => videoProcessor.analyzeVideo(path.join(testDir, 'missing_video.mp4'), meta3s, 'standard'),
        (err: any) => err instanceof VideoProcessingError && err.category === 'INVALID_INPUT',
        '11.2a Missing video path classified INVALID_INPUT'
      );
      assertNoFrameDirLeak('11.2a');

      process.env.FFMPEG_PATH = '/nonexistent/binary/ffmpeg_missing';
      await assert.rejects(
        () => videoProcessor.analyzeVideo(dummyVideoPath, meta3s, 'standard'),
        (err: any) => err instanceof VideoProcessingError && err.category === 'MISSING_EXECUTABLE',
        '11.2b Missing ffmpeg classified MISSING_EXECUTABLE'
      );
      assertNoFrameDirLeak('11.2b');

      const nonExecFfmpegAnalyze = path.resolve(testDir, 'non_exec_ffmpeg_analyze.sh');
      fs.writeFileSync(nonExecFfmpegAnalyze, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      generatedFiles.push(nonExecFfmpegAnalyze);
      process.env.FFMPEG_PATH = nonExecFfmpegAnalyze;
      await assert.rejects(
        () => videoProcessor.analyzeVideo(dummyVideoPath, meta3s, 'standard'),
        (err: any) => err instanceof VideoProcessingError && err.category === 'NON_EXECUTABLE',
        '11.2c Non-executable ffmpeg classified NON_EXECUTABLE'
      );
      assertNoFrameDirLeak('11.2c');

      const mockFfmpegAnalyze = path.resolve(testDir, 'mock_ffmpeg_analyze.sh');
      fs.writeFileSync(
        mockFfmpegAnalyze,
        `#!/bin/sh
LAST_ARG=""
IS_RAW=0
for arg in "$@"; do
  if [ "$arg" = "rawvideo" ]; then IS_RAW=1; fi
  LAST_ARG="$arg"
done
case "\${ANALYZE_MODE:-bad_raw}" in
  term)
    kill -TERM $$
    ;;
  kill)
    kill -KILL $$
    ;;
  bad_raw)
    if [ "$IS_RAW" = "1" ]; then
      printf "CORRUPT_NOT_192_MULTIPLES"
      exit 0
    fi
    OUT_DIR=$(dirname "$LAST_ARG")
    cp "${validSamplePng}" "$OUT_DIR/frame_001.jpg"
    exit 0
    ;;
esac
`,
        { mode: 0o755 }
      );
      generatedFiles.push(mockFfmpegAnalyze);
      process.env.FFMPEG_PATH = mockFfmpegAnalyze;

      process.env.ANALYZE_MODE = 'term';
      await assert.rejects(
        () => videoProcessor.analyzeVideo(dummyVideoPath, meta3s, 'standard'),
        (err: any) => err instanceof VideoProcessingError && err.category === 'TIMEOUT',
        '11.2d SIGTERM ffmpeg classified TIMEOUT'
      );
      assertNoFrameDirLeak('11.2d');

      process.env.ANALYZE_MODE = 'kill';
      await assert.rejects(
        () => videoProcessor.analyzeVideo(dummyVideoPath, meta3s, 'standard'),
        (err: any) => err instanceof VideoProcessingError && err.category === 'PROCESS_TERMINATED',
        '11.2e SIGKILL ffmpeg classified PROCESS_TERMINATED'
      );
      assertNoFrameDirLeak('11.2e');

      process.env.ANALYZE_MODE = 'bad_raw';
      await assert.rejects(
        () => videoProcessor.analyzeVideo(dummyVideoPath, meta3s, 'standard'),
        (err: any) => err instanceof VideoProcessingError && err.category === 'INVALID_OUTPUT',
        '11.2f Truncated rawvideo RGB stream classified INVALID_OUTPUT'
      );
      assertNoFrameDirLeak('11.2f');
      delete process.env.ANALYZE_MODE;

      // Real ffmpeg on corrupt video -> NON_ZERO_EXIT & clean temp dir
      delete process.env.FFMPEG_PATH;
      await assert.rejects(
        () => videoProcessor.analyzeVideo(corruptVideoPath, meta3s, 'standard'),
        (err: any) => err instanceof VideoProcessingError && err.category === 'NON_ZERO_EXIT',
        '11.2g Real ffmpeg on corrupt video classified NON_ZERO_EXIT'
      );
      assertNoFrameDirLeak('11.2g');
    } finally {
      delete process.env.PROBE_MODE;
      delete process.env.ANALYZE_MODE;
      if (prevFfprobeDiag === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = prevFfprobeDiag;
      if (prevFfmpegDiag === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = prevFfmpegDiag;
    }

    console.log('  ✅ PASS: FFprobe & analyzeVideo FFmpeg failure diagnostics and temp cleanup verified');

    // -------------------------------------------------------------------------
    // 12. WORKSTREAM 2 & 3: WHISPER TEMP DIR ISOLATION + MEDIA EDGE CASES
    // -------------------------------------------------------------------------
    console.log('\n[12. WS2 Whisper Output Isolation / Cleanup & WS3 Additional Media Edge Cases]');

    const cwdBeforeWhisper = new Set(fs.readdirSync(process.cwd()));
    const tmpBeforeWhisper = new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('vr_whisper_')));

    const prevWs2Path = process.env.WHISPER_PATH;
    const prevWs2Model = process.env.WHISPER_MODEL_PATH;
    const prevWs2Compat = process.env.WHISPER_VERIFY_COMPATIBILITY;
    try {
      process.env.WHISPER_VERIFY_COMPATIBILITY = 'false';

      // 12.1 whisper_cpp file output isolation, cleanup & parallel safety
      process.env.WHISPER_PATH = compatWhisperCppBin;
      process.env.WHISPER_MODEL_PATH = validModel;
      process.env.COMPAT_MODE = 'pass';
      const cppTxSingle = await stt.transcribe(dummyVideoPath, 3.0);
      assert.strictEqual(cppTxSingle.status, 'DETECTED', '12.1 whisper_cpp transcribe reads isolated -of JSON file');
      assert.strictEqual(cppTxSingle.transcriptText, 'hello compat test', '12.2 whisper_cpp transcribe extracts text cleanly');
      assert.strictEqual(cppTxSingle.segments?.length, 1, '12.3 whisper_cpp transcribe parses timestamps into segment');

      // Parallel calls should never collide or leave files in cwd/tmpdir
      const parallelCpp = await Promise.all([
        stt.transcribe(dummyVideoPath, 3.0),
        stt.transcribe(dummyVideoPath, 3.0),
        stt.transcribe(dummyVideoPath, 3.0)
      ]);
      assert.ok(parallelCpp.every(r => r.status === 'DETECTED' && r.transcriptText === 'hello compat test'), '12.4 Parallel whisper_cpp transcribe calls isolate temp dirs without collision');

      // Failure mode cleanup
      process.env.COMPAT_MODE = 'fail_exit';
      const failedCppTx = await stt.transcribe(dummyVideoPath, 3.0);
      assert.strictEqual(failedCppTx.status, 'ANALYSIS_UNAVAILABLE', '12.5 Failed whisper_cpp transcribe returns ANALYSIS_UNAVAILABLE');
      delete process.env.COMPAT_MODE;

      // 12.2 openai_whisper --output_dir isolation + parallel safety
      process.env.WHISPER_PATH = compatOpenAiBin;
      process.env.WHISPER_MODEL_PATH = validPtModel;
      const parallelOpenAi = await Promise.all([
        stt.transcribe(dummyVideoPath, 3.0),
        stt.transcribe(dummyVideoPath, 3.0)
      ]);
      assert.ok(parallelOpenAi.every(r => r.status === 'DETECTED' && r.transcriptText === 'openai whisper test'), '12.6 Parallel openai_whisper transcribe calls isolate --output_dir cleanly');

      const cwdAfterWhisper = fs.readdirSync(process.cwd()).filter(n => !cwdBeforeWhisper.has(n));
      assert.strictEqual(cwdAfterWhisper.length, 0, `12.7 Zero artifacts created in repository root during Whisper calls (found: ${cwdAfterWhisper.join(', ')})`);
      assert.strictEqual(fs.existsSync(path.resolve(process.cwd(), '.json')), false, '12.8 Repository root .json artifact must never be created');

      const tmpAfterWhisper = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('vr_whisper_') && !tmpBeforeWhisper.has(n));
      assert.strictEqual(tmpAfterWhisper.length, 0, `12.9 Zero leftover vr_whisper_* temp dirs in os.tmpdir() (found: ${tmpAfterWhisper.join(', ')})`);
    } finally {
      delete process.env.COMPAT_MODE;
      if (prevWs2Path === undefined) delete process.env.WHISPER_PATH;
      else process.env.WHISPER_PATH = prevWs2Path;
      if (prevWs2Model === undefined) delete process.env.WHISPER_MODEL_PATH;
      else process.env.WHISPER_MODEL_PATH = prevWs2Model;
      if (prevWs2Compat === undefined) delete process.env.WHISPER_VERIFY_COMPATIBILITY;
      else process.env.WHISPER_VERIFY_COMPATIBILITY = prevWs2Compat;
    }

    // 12.10-12.18 Additional MediaInspector / VideoProcessor / AudioProcessor / Tesseract edge cases
    const zeroBytePath = path.resolve(testDir, 'zero_byte.mp4');
    fs.writeFileSync(zeroBytePath, Buffer.alloc(0));
    generatedFiles.push(zeroBytePath);
    await assert.rejects(
      () => mediaInspector.inspect(zeroBytePath, 'zero_byte.mp4'),
      (err: any) => err instanceof MediaInspectionError && err.category === 'INVALID_MEDIA_METADATA',
      '12.10 Zero-byte file rejected cleanly as INVALID_MEDIA_METADATA'
    );

    const badDurationFfprobe = path.resolve(testDir, 'mock_ffprobe_bad_dur.sh');
    fs.writeFileSync(
      badDurationFfprobe,
      `#!/bin/sh
if [ "\${BAD_DUR_MODE:-zero}" = "zero" ]; then
  echo '{"format":{"duration":"0"},"streams":[{"codec_type":"video","codec_name":"h264","width":320,"height":240,"r_frame_rate":"30/1"}]}'
else
  echo '{"format":{"duration":"N/A"},"streams":[{"codec_type":"video","codec_name":"h264","width":320,"height":240,"r_frame_rate":"30/1"}]}'
fi
`,
      { mode: 0o755 }
    );
    generatedFiles.push(badDurationFfprobe);

    const prevFfprobeEdge = process.env.FFPROBE_PATH;
    try {
      process.env.FFPROBE_PATH = badDurationFfprobe;
      process.env.BAD_DUR_MODE = 'zero';
      await assert.rejects(
        () => mediaInspector.inspect(dummyVideoPath, 'dummy_ocr.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'INVALID_MEDIA_METADATA',
        '12.11 Zero-duration container rejected cleanly as INVALID_MEDIA_METADATA'
      );
      process.env.BAD_DUR_MODE = 'na';
      await assert.rejects(
        () => mediaInspector.inspect(dummyVideoPath, 'dummy_ocr.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'INVALID_MEDIA_METADATA',
        '12.12 Non-numeric N/A duration metadata rejected cleanly as INVALID_MEDIA_METADATA'
      );
    } finally {
      delete process.env.BAD_DUR_MODE;
      if (prevFfprobeEdge === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = prevFfprobeEdge;
    }

    // Audio-only container & video-only container handling
    const audioOnlyPath = path.resolve(testDir, 'audio_only.mp4');
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:a', 'aac', audioOnlyPath
    ]);
    generatedFiles.push(audioOnlyPath);

    const audioOnlyMeta = await mediaInspector.inspect(audioOnlyPath, 'audio_only.mp4');
    assert.strictEqual(audioOnlyMeta.hasAudio, true, '12.13 Audio-only container reports hasAudio=true');
    assert.strictEqual(audioOnlyMeta.width, 0, '12.14 Audio-only container reports width=0');

    process.env.TESSERACT_PATH = '/usr/bin/tesseract';
    const audioOnlyOcr = await videoProcessor.performVideoOcr(audioOnlyPath, audioOnlyMeta);
    assert.strictEqual(audioOnlyOcr.status, 'NOT_PROVIDED', '12.15 Audio-only OCR safely returns NOT_PROVIDED');
    const audioOnlyVid = await videoProcessor.analyzeVideo(audioOnlyPath, audioOnlyMeta, 'standard');
    assert.strictEqual(audioOnlyVid.framesSampled, 0, '12.16 Audio-only analyzeVideo samples 0 video frames');

    const videoOnlyAudioRes = await audioProcessor.analyzeAudio(dummyVideoPath, meta3s);
    assert.strictEqual(videoOnlyAudioRes.speechAnalysisStatus, 'NOT_PROVIDED', '12.17 Video-only container safely returns NOT_PROVIDED for audio');

    // Long-duration sampling bounds (10 hours = 36000s)
    const longStd = calculateOcrSamplingTimestamps(36000, 15);
    const longDeep = calculateOcrSamplingTimestamps(36000, 30);
    assert.strictEqual(longStd.length, 15, '12.18 Long-duration standard sampling bounded to 15');
    assert.strictEqual(longDeep.length, 30, '12.19 Long-duration deep sampling bounded to 30');
    assert.ok(longDeep[0] === 0 && longDeep[29] < 36000 && new Set(longDeep).size === 30, '12.20 Long-duration samples unique & within [0, duration)');

    // Corrupt image frame submitted to real /usr/bin/tesseract must count as framesOcrFailed > 0 (never NO_SIGNAL_DETECTED)
    const corruptFramePath = path.resolve(testDir, 'corrupt_frame.png');
    fs.writeFileSync(corruptFramePath, 'NOT_A_VALID_PNG_IMAGE_PAYLOAD');
    generatedFiles.push(corruptFramePath);

    const corruptFrameFfmpeg = path.resolve(testDir, 'corrupt_frame_ffmpeg.sh');
    fs.writeFileSync(
      corruptFrameFfmpeg,
      `#!/bin/sh
OUT=""
for arg in "$@"; do OUT="$arg"; done
cp "${corruptFramePath}" "$OUT"
exit 0
`,
      { mode: 0o755 }
    );
    generatedFiles.push(corruptFrameFfmpeg);

    const prevFfmpegCorrupt = process.env.FFMPEG_PATH;
    try {
      process.env.FFMPEG_PATH = corruptFrameFfmpeg;
      const corruptImgOcr = await videoProcessor.performVideoOcr(dummyVideoPath, meta3s, { maxFrames: 2 });
      assert.strictEqual(corruptImgOcr.framesOcrFailed, 2, '12.21 Invalid PNG submitted to real Tesseract increments framesOcrFailed=2');
      assert.strictEqual(corruptImgOcr.framesSucceeded, 0, '12.22 Invalid PNG never increments framesSucceeded');
      assert.strictEqual(corruptImgOcr.status, 'INSUFFICIENT_EVIDENCE', '12.23 All-failed OCR returns INSUFFICIENT_EVIDENCE (never NO_SIGNAL_DETECTED)');
    } finally {
      if (prevFfmpegCorrupt === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = prevFfmpegCorrupt;
      delete process.env.TESSERACT_PATH;
    }

    console.log('  ✅ PASS: WS2 Whisper isolation/cleanup & WS3 edge cases verified');

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
