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

    delete process.env.WHISPER_PATH;
    delete process.env.WHISPER_MODEL_PATH;
    console.log('  ✅ PASS: Whisper STT strict runtime identity & model header verification complete');

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
    assert.strictEqual(currentReadiness.body.checks?.storage?.status, 'healthy', '7.6 Upload storage directory writeability probe succeeds');

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

      const cats = diagRes.extractionErrors?.map(e => e.category) || [];
      assert.ok(cats.includes('TIMEOUT'), '8.20 Distinguishes TIMEOUT extraction failure');
      assert.ok(cats.includes('NON_ZERO_EXIT'), '8.21 Distinguishes NON_ZERO_EXIT extraction failure');
      assert.ok(cats.includes('MISSING_OUTPUT'), '8.22 Distinguishes MISSING_OUTPUT extraction failure');
      assert.ok(cats.includes('EMPTY_OUTPUT'), '8.23 Distinguishes EMPTY_OUTPUT (0-byte) extraction failure');
      assert.ok(diagRes.failureReason?.includes('FFmpeg extraction failed on 4 frame(s)'), '8.24 failureReason summarizes extraction diagnostics');
    } finally {
      if (prevFfmpegPath === undefined) {
        delete process.env.FFMPEG_PATH;
      } else {
        process.env.FFMPEG_PATH = prevFfmpegPath;
      }
      delete process.env.TESSERACT_PATH;
    }

    console.log('  ✅ PASS: Extraction failure categorization (TIMEOUT/NON_ZERO_EXIT/MISSING_OUTPUT/EMPTY_OUTPUT) & invariants verified');

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
