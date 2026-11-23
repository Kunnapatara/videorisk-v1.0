import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { enforceTestDatabaseIsolation } from '../src/server/storage/testIsolation';

process.env.VIDEORISK_TEST_RUN = 'true';
enforceTestDatabaseIsolation();

function createSyntheticWavFile(filePath: string, durationSec: number = 0.5): void {
  const sampleRate = 16000;
  const numSamples = Math.floor(sampleRate * durationSec);
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
    const val = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    buf.writeInt16LE(val, 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

function writeMockWhisperCli(binPath: string): void {
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('whisper.cpp version: 1.9.6-mock');
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: whisper-cli [options]\\n  -m FNAME  model path\\n  -f FNAME  input WAV\\n  --output-json  output JSON\\n  -of FNAME  output file prefix');
  process.exit(0);
}
const ofIdx = args.indexOf('-of');
const outPrefix = ofIdx >= 0 ? args[ofIdx + 1] : null;
if (outPrefix) {
  fs.writeFileSync(outPrefix + '.json', JSON.stringify({
    transcription: [{ timestamps: { from: '00:00:00,000', to: '00:00:01,000' }, text: 'mock verification speech transcript' }]
  }));
}
process.exit(0);
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  fs.chmodSync(binPath, 0o755);
}

export async function runWhisperModelSha256Tests() {
  console.log('\n======================================================');
  console.log('--- WHISPER MODEL SHA-256 INTEGRITY CONTRACT TESTS ---');
  console.log('======================================================\n');

  const { speechTranscriptionAdapter } = await import('../src/server/pipeline/audioProcessor');
  const { apiRouter } = await import('../src/server/routes/api');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_model_sha256_test_'));
  const savedEnv: Record<string, string | undefined> = {
    WHISPER_PATH: process.env.WHISPER_PATH,
    LOCAL_STT_PATH: process.env.LOCAL_STT_PATH,
    WHISPER_MODEL_PATH: process.env.WHISPER_MODEL_PATH,
    WHISPER_MODEL_SHA256: process.env.WHISPER_MODEL_SHA256,
    WHISPER_REQUIRE_MODEL_SHA256: process.env.WHISPER_REQUIRE_MODEL_SHA256,
    WHISPER_MODEL_MANIFEST_PATH: process.env.WHISPER_MODEL_MANIFEST_PATH,
    WHISPER_COMPAT_AUDIO_PATH: process.env.WHISPER_COMPAT_AUDIO_PATH,
    WHISPER_COMPAT_EXPECTED_TRANSCRIPT: process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT,
    WHISPER_COMPAT_SYNTHETIC_FIXTURE: process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE,
    WHISPER_VERIFY_COMPATIBILITY: process.env.WHISPER_VERIFY_COMPATIBILITY,
    WHISPER_LANGUAGE: process.env.WHISPER_LANGUAGE,
  };

  try {
    const mockBin = path.join(workDir, 'whisper-cli');
    writeMockWhisperCli(mockBin);

    const modelA = path.join(workDir, 'ggml-mock-verified.bin');
    const modelPayload = Buffer.concat([Buffer.from('lmgg', 'ascii'), Buffer.alloc(2048, 0x2a)]);
    fs.writeFileSync(modelA, modelPayload);
    const modelASha256 = crypto.createHash('sha256').update(modelPayload).digest('hex');

    const manifestPath = path.join(workDir, 'whisperModels.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestVersion: '1.0.0',
        models: [
          {
            filename: 'ggml-mock-verified.bin',
            modelName: 'mock-verified',
            format: 'ggml',
            sizeBytes: modelPayload.length,
            expectedSha256: modelASha256,
          },
        ],
      })
    );

    const compatWav = path.join(workDir, 'compat_tone_16k.wav');
    createSyntheticWavFile(compatWav, 0.5);

    const dummyVideo = path.join(workDir, 'dummy_input.mp4');
    fs.writeFileSync(dummyVideo, Buffer.from('NOT_NEEDED_BEFORE_PREFLIGHT'));

    process.env.WHISPER_PATH = mockBin;
    delete process.env.LOCAL_STT_PATH;
    process.env.WHISPER_MODEL_PATH = modelA;
    delete process.env.WHISPER_MODEL_SHA256;
    process.env.WHISPER_MODEL_MANIFEST_PATH = manifestPath;
    process.env.WHISPER_REQUIRE_MODEL_SHA256 = 'true';
    process.env.WHISPER_COMPAT_AUDIO_PATH = compatWav;
    process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE = 'true';
    process.env.WHISPER_VERIFY_COMPATIBILITY = 'false';
    delete process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT;
    speechTranscriptionAdapter.clearCompatibilityCache();

    // Case 1: Model SHA-256 matches trusted manifest
    console.log('[Case 1] Model SHA-256 matches trusted manifest & explicit env');
    const matchManifest = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(matchManifest.status, 'READY', `1.1 Expected READY, got ${matchManifest.status} (${matchManifest.details})`);
    assert.strictEqual(matchManifest.modelSha256Verified, true, '1.2 modelSha256Verified=true');
    assert.strictEqual(matchManifest.modelIntegrityStatus, 'VERIFIED', '1.3 modelIntegrityStatus=VERIFIED');
    assert.strictEqual(matchManifest.modelSha256Source, 'manifest', '1.4 source=manifest');
    assert.strictEqual(matchManifest.modelSha256, modelASha256, '1.5 Computed digest matches file');
    assert.strictEqual(matchManifest.expectedModelSha256, modelASha256, '1.6 Expected digest recorded');

    // Explicit uppercase WHISPER_MODEL_SHA256 overrides manifest cleanly
    process.env.WHISPER_MODEL_SHA256 = modelASha256.toUpperCase();
    const matchEnv = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(matchEnv.status, 'READY', '1.7 Uppercase WHISPER_MODEL_SHA256 accepted & normalized');
    assert.strictEqual(matchEnv.modelSha256Source, 'env', '1.8 source=env takes precedence over manifest');
    assert.strictEqual(matchEnv.modelSha256Verified, true, '1.9 modelSha256Verified=true');
    console.log('  ✅ PASS: Case 1 (Match via manifest and WHISPER_MODEL_SHA256)');

    // Case 2: Model SHA-256 mismatch fails closed
    console.log('\n[Case 2] Model SHA-256 mismatch fails closed');
    process.env.WHISPER_MODEL_SHA256 = 'f'.repeat(64);
    const mismatchRes = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(mismatchRes.status, 'ERROR', '2.1 Status ERROR on mismatch');
    assert.strictEqual(mismatchRes.diagnosticCode, 'MODEL_SHA256_MISMATCH', '2.2 diagnosticCode=MODEL_SHA256_MISMATCH');
    assert.strictEqual(mismatchRes.modelFound, false, '2.3 modelFound=false');
    assert.strictEqual(mismatchRes.modelSha256Verified, false, '2.4 modelSha256Verified=false');
    assert.strictEqual(mismatchRes.modelIntegrityStatus, 'MISMATCH', '2.5 modelIntegrityStatus=MISMATCH');
    const mismatchTx = await speechTranscriptionAdapter.transcribe(dummyVideo, 5.0, { verifyCompatibility: false });
    assert.strictEqual(mismatchTx.status, 'ANALYSIS_UNAVAILABLE', '2.6 transcribe() fails closed');
    assert.strictEqual(mismatchTx.diagnosticCode, 'MODEL_SHA256_MISMATCH', '2.7 transcribe() returns MODEL_SHA256_MISMATCH');
    console.log('  ✅ PASS: Case 2 (Mismatch fails closed)');

    // Case 3: Model file missing
    console.log('\n[Case 3] Missing model file');
    delete process.env.WHISPER_MODEL_SHA256;
    process.env.WHISPER_MODEL_PATH = path.join(workDir, 'does_not_exist.bin');
    const missingModel = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(missingModel.status, 'MISSING_MODEL', '3.1 status=MISSING_MODEL');
    assert.strictEqual(missingModel.diagnosticCode, 'MODEL_NOT_FOUND', '3.2 diagnosticCode=MODEL_NOT_FOUND');
    assert.strictEqual(missingModel.modelSha256Verified, false, '3.3 modelSha256Verified=false');
    assert.strictEqual(missingModel.modelIntegrityStatus, 'MISSING_MODEL', '3.4 modelIntegrityStatus=MISSING_MODEL');
    console.log('  ✅ PASS: Case 3 (Missing model fails closed)');

    // Case 4: Expected SHA-256 missing or invalid
    console.log('\n[Case 4] Expected SHA-256 missing or invalid');
    const unregisteredModel = path.join(workDir, 'unregistered_custom.bin');
    fs.writeFileSync(unregisteredModel, modelPayload);
    process.env.WHISPER_MODEL_PATH = unregisteredModel;
    process.env.WHISPER_REQUIRE_MODEL_SHA256 = 'true';
    const missingExpReq = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(missingExpReq.status, 'ERROR', '4.1 Missing expected hash fails closed when required');
    assert.strictEqual(missingExpReq.diagnosticCode, 'MODEL_EXPECTED_HASH_MISSING', '4.2 diagnosticCode=MODEL_EXPECTED_HASH_MISSING');
    assert.strictEqual(missingExpReq.modelIntegrityStatus, 'MISSING_EXPECTED_HASH', '4.3 modelIntegrityStatus=MISSING_EXPECTED_HASH');
    assert.strictEqual(missingExpReq.modelSha256Verified, false, '4.4 Never marks modelSha256Verified=true');

    delete process.env.WHISPER_REQUIRE_MODEL_SHA256;
    const missingExpOpt = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(missingExpOpt.modelSha256Verified, false, '4.5 Optional mode never falsely claims verified');
    assert.strictEqual(missingExpOpt.modelIntegrityStatus, 'MISSING_EXPECTED_HASH', '4.6 Honest status MISSING_EXPECTED_HASH');

    process.env.WHISPER_MODEL_SHA256 = 'abc123_invalid';
    const invalidExpEnv = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(invalidExpEnv.status, 'ERROR', '4.7 Invalid env SHA-256 fails closed');
    assert.strictEqual(invalidExpEnv.diagnosticCode, 'MODEL_EXPECTED_HASH_INVALID', '4.8 diagnosticCode=MODEL_EXPECTED_HASH_INVALID');
    assert.strictEqual(invalidExpEnv.modelIntegrityStatus, 'INVALID_EXPECTED_HASH', '4.9 modelIntegrityStatus=INVALID_EXPECTED_HASH');

    delete process.env.WHISPER_MODEL_SHA256;
    process.env.WHISPER_MODEL_MANIFEST_PATH = path.join(workDir, 'nonexistent_manifest.json');
    const missingManifestOverride = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(missingManifestOverride.status, 'ERROR', '4.10 Missing explicit manifest fails closed');
    assert.strictEqual(missingManifestOverride.diagnosticCode, 'MODEL_EXPECTED_HASH_INVALID', '4.11 diagnosticCode=MODEL_EXPECTED_HASH_INVALID');
    console.log('  ✅ PASS: Case 4 (Missing/invalid expected hash fails closed)');

    // Case 5: Post-provisioning tampering (same byte size, 1-byte mutation) + /api/health/readiness check
    console.log('\n[Case 5] Post-provisioning tampering (constant byte length) & /api/health/readiness');
    process.env.WHISPER_MODEL_MANIFEST_PATH = manifestPath;
    process.env.WHISPER_MODEL_PATH = modelA;
    process.env.WHISPER_REQUIRE_MODEL_SHA256 = 'true';
    process.env.WHISPER_VERIFY_COMPATIBILITY = 'true';
    speechTranscriptionAdapter.clearCompatibilityCache();

    const preCompat = await speechTranscriptionAdapter.verifyRuntimeCompatibility({ useCache: true });
    assert.strictEqual(preCompat.compatible, true, '5.1 Initial compatibility succeeds & caches');
    assert.strictEqual(preCompat.validation.modelSha256Verified, true, '5.2 modelSha256Verified=true');

    // Mutate byte at offset 512 without changing file size
    const fd = fs.openSync(modelA, 'r+');
    try {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, 512);
      b[0] = b[0] ^ 0x55;
      fs.writeSync(fd, b, 0, 1, 512);
    } finally {
      fs.closeSync(fd);
    }

    const postCompat = await speechTranscriptionAdapter.verifyRuntimeCompatibility({ useCache: true });
    assert.strictEqual(postCompat.compatible, false, '5.3 Post-tamper invalidates cache and fails closed');
    assert.strictEqual(postCompat.diagnosticCode, 'MODEL_SHA256_MISMATCH', '5.4 diagnosticCode=MODEL_SHA256_MISMATCH');

    const app = express();
    app.use('/api', apiRouter);
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address() as any;
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/health/readiness`);
      const body = await res.json();
      assert.strictEqual(body?.checks?.whisperStt?.status, 'degraded', '5.5 Tampered model degrades readiness');
      assert.strictEqual(body?.checks?.whisperStt?.details?.modelStatus, 'MODEL_SHA256_MISMATCH', '5.6 modelStatus=MODEL_SHA256_MISMATCH');
      assert.strictEqual(body?.checks?.whisperStt?.details?.modelSha256Verified, false, '5.7 modelSha256Verified=false');
      assert.strictEqual(body?.checks?.whisperStt?.details?.modelIntegrityStatus, 'MISMATCH', '5.8 modelIntegrityStatus=MISMATCH');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    console.log('  ✅ PASS: Case 5 (Post-provisioning tamper fails closed & surfaces in readiness)');

    // Case 6: Anti-downgrade — ENV/manifest overrides cannot silently bypass or downgrade trusted manifest checksums
    console.log('\n[Case 6] Anti-downgrade protection against conflicting WHISPER_MODEL_SHA256 & manifest overrides');
    const swappedModelA = path.join(workDir, 'ggml-mock-verified.bin');
    const roguePayload = Buffer.concat([Buffer.from('lmgg', 'ascii'), Buffer.alloc(2048, 0x7b)]);
    fs.writeFileSync(swappedModelA, roguePayload);
    const rogueSha256 = crypto.createHash('sha256').update(roguePayload).digest('hex');

    // Attacker replaces file AND tries to pass matching WHISPER_MODEL_SHA256 -> must STILL reject against manifest!
    process.env.WHISPER_MODEL_MANIFEST_PATH = manifestPath;
    process.env.WHISPER_MODEL_PATH = swappedModelA;
    process.env.WHISPER_MODEL_SHA256 = rogueSha256;
    process.env.WHISPER_REQUIRE_MODEL_SHA256 = 'true';
    const overrideConflict = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(overrideConflict.status, 'ERROR', '6.1 Conflicting WHISPER_MODEL_SHA256 rejected even if it matches rogue binary');
    assert.strictEqual(overrideConflict.diagnosticCode, 'MODEL_SHA256_MISMATCH', '6.2 diagnosticCode=MODEL_SHA256_MISMATCH');
    assert.strictEqual(overrideConflict.modelSha256Verified, false, '6.3 modelSha256Verified=false');

    // Attacker tries to override built-in trusted ggml-base.en.bin via custom WHISPER_MODEL_MANIFEST_PATH
    const spoofedBaseModel = path.join(workDir, 'ggml-base.en.bin');
    fs.writeFileSync(spoofedBaseModel, roguePayload);
    const spoofedManifest = path.join(workDir, 'spoofed_models.json');
    fs.writeFileSync(
      spoofedManifest,
      JSON.stringify({
        manifestVersion: '1.0.0',
        models: [
          {
            filename: 'ggml-base.en.bin',
            modelName: 'base.en',
            format: 'ggml',
            sizeBytes: roguePayload.length,
            expectedSha256: rogueSha256,
          },
        ],
      })
    );
    delete process.env.WHISPER_MODEL_SHA256;
    process.env.WHISPER_MODEL_PATH = spoofedBaseModel;
    process.env.WHISPER_MODEL_MANIFEST_PATH = spoofedManifest;
    const builtInConflict = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(builtInConflict.status, 'ERROR', '6.4 Custom manifest cannot spoof built-in ggml-base.en.bin checksum');
    assert.strictEqual(builtInConflict.diagnosticCode, 'MODEL_SHA256_MISMATCH', '6.5 diagnosticCode=MODEL_SHA256_MISMATCH');
    assert.strictEqual(builtInConflict.modelSha256Verified, false, '6.6 modelSha256Verified=false');

    // Compatibility cache cannot bypass requirement toggle on unmanifested model
    const customModel = path.join(workDir, 'custom_cache_model.bin');
    fs.writeFileSync(customModel, roguePayload);
    delete process.env.WHISPER_MODEL_MANIFEST_PATH;
    delete process.env.WHISPER_MODEL_SHA256;
    delete process.env.WHISPER_REQUIRE_MODEL_SHA256;
    process.env.WHISPER_MODEL_PATH = customModel;
    speechTranscriptionAdapter.clearCompatibilityCache();

    const optCompat = await speechTranscriptionAdapter.verifyRuntimeCompatibility({ useCache: true });
    assert.strictEqual(optCompat.compatible, true, '6.7 Optional mode without hash runs compat probe');
    assert.strictEqual(optCompat.validation.modelSha256Verified, false, '6.8 Still never marks verified without expected hash');

    process.env.WHISPER_REQUIRE_MODEL_SHA256 = 'true';
    const reqCompat = await speechTranscriptionAdapter.verifyRuntimeCompatibility({ useCache: true });
    assert.strictEqual(reqCompat.compatible, false, '6.9 Enabling WHISPER_REQUIRE_MODEL_SHA256 bypasses warm compat cache and fails closed');
    assert.strictEqual(reqCompat.diagnosticCode, 'MODEL_EXPECTED_HASH_MISSING', '6.10 diagnosticCode=MODEL_EXPECTED_HASH_MISSING');
    console.log('  ✅ PASS: Case 6 (Anti-downgrade ENV/manifest protection & cache invalidation)');

    // Case 7: Whisper Model Language Capability Consistency & Anti-Overclaim Protection
    console.log('\n[Case 7] Whisper Model Language Capability Consistency (English-only vs Unconfigured vs Multilingual Metadata)');
    const { audioProcessor } = await import('../src/server/pipeline/audioProcessor');

    // 7a. Unconfigured runtime never claims ['en', 'th']
    delete process.env.WHISPER_PATH;
    delete process.env.LOCAL_STT_PATH;
    delete process.env.WHISPER_MODEL_PATH;
    delete process.env.WHISPER_LANGUAGE;
    speechTranscriptionAdapter.clearCompatibilityCache();
    const unconfiguredVal = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(unconfiguredVal.status, 'UNCONFIGURED', '7.1a Status UNCONFIGURED');
    assert.deepStrictEqual(unconfiguredVal.supportedLanguages, [], '7.1b Unconfigured runtime reports empty supportedLanguages=[]');
    assert.strictEqual(unconfiguredVal.thaiSpeechSupported, false, '7.1c Unconfigured runtime never claims thaiSpeechSupported=true');

    // 7b. Built-in whisperModels.json + ggml-base.en.bin must report modelType=english-only, supportedLanguages=['en'], thaiSpeechSupported=false
    const builtInManifest = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'src', 'server', 'config', 'whisperModels.json'), 'utf8')
    );
    const builtInBaseEn = (builtInManifest.models || []).find((m: any) => m.filename === 'ggml-base.en.bin');
    assert.ok(builtInBaseEn, '7.2a Built-in whisperModels.json registers ggml-base.en.bin');
    assert.strictEqual(builtInBaseEn.modelType, 'english-only', '7.2b Built-in registry specifies modelType=english-only');
    assert.deepStrictEqual(builtInBaseEn.supportedLanguages, ['en'], '7.2c Built-in registry restricts supportedLanguages to [en]');
    assert.strictEqual(builtInBaseEn.thaiSpeechSupported, false, '7.2d Built-in registry sets thaiSpeechSupported=false');

    const englishOnlyModel = path.join(workDir, 'ggml-base.en.bin');
    fs.writeFileSync(englishOnlyModel, modelPayload);
    const englishOnlySha = crypto.createHash('sha256').update(modelPayload).digest('hex');
    const enOnlyManifest = path.join(workDir, 'en_only_manifest.json');
    fs.writeFileSync(
      enOnlyManifest,
      JSON.stringify({
        manifestVersion: '1.0.0',
        models: [
          {
            filename: 'ggml-base.en.bin',
            modelName: 'base.en',
            modelType: 'english-only',
            supportedLanguages: ['en'],
            thaiSpeechSupported: false,
            sizeBytes: modelPayload.length,
            expectedSha256: builtInBaseEn.expectedSha256,
          },
          {
            filename: 'ggml-mock-base.en.bin',
            modelName: 'mock-base.en',
            modelType: 'english-only',
            supportedLanguages: ['en'],
            thaiSpeechSupported: false,
            sizeBytes: modelPayload.length,
            expectedSha256: englishOnlySha,
          },
        ],
      })
    );
    const mockEnOnlyModel = path.join(workDir, 'ggml-mock-base.en.bin');
    fs.writeFileSync(mockEnOnlyModel, modelPayload);

    process.env.WHISPER_PATH = mockBin;
    process.env.WHISPER_MODEL_PATH = mockEnOnlyModel;
    process.env.WHISPER_MODEL_MANIFEST_PATH = enOnlyManifest;
    process.env.WHISPER_REQUIRE_MODEL_SHA256 = 'true';
    process.env.WHISPER_VERIFY_COMPATIBILITY = 'false';
    delete process.env.WHISPER_LANGUAGE;
    speechTranscriptionAdapter.clearCompatibilityCache();

    const enVal = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(enVal.status, 'READY', '7.3a English-only verified model READY when WHISPER_LANGUAGE unset');
    assert.strictEqual(enVal.modelName, 'mock-base.en', '7.3b modelName populated');
    assert.strictEqual(enVal.modelType, 'english-only', '7.3c modelType=english-only');
    assert.deepStrictEqual(enVal.supportedLanguages, ['en'], '7.3d supportedLanguages=[en] only (never [en, th])');
    assert.strictEqual(enVal.thaiSpeechSupported, false, '7.3e thaiSpeechSupported=false');
    assert.ok(enVal.languageLimitation?.toLowerCase().includes('not supported'), '7.3f Clear English-only Thai limitation');

    // 7c. WHISPER_LANGUAGE=th on English-only model must FAIL CLOSED (MODEL_INCOMPATIBLE)
    process.env.WHISPER_LANGUAGE = 'th';
    speechTranscriptionAdapter.clearCompatibilityCache();
    const thaiOnEnVal = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(thaiOnEnVal.status, 'ERROR', '7.4a WHISPER_LANGUAGE=th on .en model fails closed');
    assert.strictEqual(thaiOnEnVal.diagnosticCode, 'MODEL_INCOMPATIBLE', '7.4b diagnosticCode=MODEL_INCOMPATIBLE');
    assert.strictEqual(thaiOnEnVal.thaiSpeechSupported, false, '7.4c thaiSpeechSupported remains false');
    const thaiOnEnTx = await speechTranscriptionAdapter.transcribe(dummyVideo, 5.0, { verifyCompatibility: false });
    assert.strictEqual(thaiOnEnTx.status, 'ANALYSIS_UNAVAILABLE', '7.4d transcribe() fails closed for WHISPER_LANGUAGE=th on .en model');
    assert.strictEqual(thaiOnEnTx.diagnosticCode, 'MODEL_INCOMPATIBLE', '7.4e transcribe() diagnosticCode=MODEL_INCOMPATIBLE');

    // 7d. Multilingual filename/metadata claiming ['en', 'th'] MUST NOT claim 'th' without real Thai speech verification
    delete process.env.WHISPER_LANGUAGE;
    const multilingualModel = path.join(workDir, 'ggml-base.bin');
    fs.writeFileSync(multilingualModel, modelPayload);
    const multilingualManifest = path.join(workDir, 'multilingual_manifest.json');
    fs.writeFileSync(
      multilingualManifest,
      JSON.stringify({
        manifestVersion: '1.0.0',
        models: [
          {
            filename: 'ggml-base.bin',
            modelName: 'base',
            modelType: 'multilingual',
            supportedLanguages: ['en', 'th'],
            thaiSpeechSupported: true,
            sizeBytes: modelPayload.length,
            expectedSha256: englishOnlySha,
          },
        ],
      })
    );
    process.env.WHISPER_MODEL_PATH = multilingualModel;
    process.env.WHISPER_MODEL_MANIFEST_PATH = multilingualManifest;
    speechTranscriptionAdapter.clearCompatibilityCache();
    const multiMetaOnly = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(multiMetaOnly.status, 'READY', '7.5a Multilingual model READY');
    assert.strictEqual(multiMetaOnly.modelType, 'multilingual', '7.5b modelType=multilingual');
    assert.deepStrictEqual(multiMetaOnly.supportedLanguages, ['en'], '7.5c Does NOT claim th from filename/metadata alone');
    assert.strictEqual(multiMetaOnly.thaiSpeechSupported, false, '7.5d thaiSpeechSupported=false without verified Thai speech fixture');
    assert.ok(multiMetaOnly.languageLimitation?.includes('NOT claimed from filename or metadata'), '7.5e Explicit anti-metadata-only limitation message');

    // 7e. transcribe() and /api/health/readiness reflect honest English-only capability & limitations
    process.env.WHISPER_MODEL_PATH = mockEnOnlyModel;
    process.env.WHISPER_MODEL_MANIFEST_PATH = enOnlyManifest;
    speechTranscriptionAdapter.clearCompatibilityCache();

    const enTx = await speechTranscriptionAdapter.transcribe(compatWav, 0.5, { verifyCompatibility: false });
    assert.strictEqual(enTx.status, 'DETECTED', '7.6a English-only transcribe() executes cleanly on audio');
    assert.strictEqual(enTx.modelType, 'english-only', '7.6b transcribe() carries modelType=english-only');
    assert.deepStrictEqual(enTx.supportedLanguages, ['en'], '7.6c transcribe() carries supportedLanguages=[en]');
    assert.strictEqual(enTx.thaiSpeechSupported, false, '7.6d transcribe() carries thaiSpeechSupported=false');
    assert.ok(enTx.limitations.includes('Thai'), '7.6e transcribe() limitations surface Thai limitation');

    const audioRes = await audioProcessor.analyzeAudio(compatWav, 0.5);
    assert.deepStrictEqual(audioRes.detectors?.audio_transcription?.details?.supportedLanguages, ['en'], '7.6f Detector details expose supportedLanguages=[en]');
    assert.strictEqual(audioRes.detectors?.audio_transcription?.details?.thaiSpeechSupported, false, '7.6g Detector details expose thaiSpeechSupported=false');

    const appLang = express();
    appLang.use('/api', apiRouter);
    const serverLang = await new Promise<import('http').Server>((resolve) => {
      const s = appLang.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = serverLang.address() as any;
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/health/readiness`);
      const body = await res.json();
      const wsDetails = body?.checks?.whisperStt?.details;
      assert.strictEqual(wsDetails?.modelName, 'mock-base.en', '7.7a Readiness exposes modelName');
      assert.strictEqual(wsDetails?.modelType, 'english-only', '7.7b Readiness exposes modelType=english-only');
      assert.deepStrictEqual(wsDetails?.supportedLanguages, ['en'], '7.7c Readiness exposes supportedLanguages=[en]');
      assert.strictEqual(wsDetails?.thaiSpeechSupported, false, '7.7d Readiness exposes thaiSpeechSupported=false');
      assert.strictEqual(wsDetails?.thaiSpeechVerified, false, '7.7e Readiness exposes thaiSpeechVerified=false');
      assert.strictEqual(wsDetails?.transcriptionLanguage, 'en', '7.7f Readiness exposes transcriptionLanguage=en');
      assert.ok(String(wsDetails?.languageLimitation || '').includes('Thai'), '7.7g Readiness exposes clear Thai limitation');
    } finally {
      await new Promise<void>((resolve) => serverLang.close(() => resolve()));
    }
    console.log('  ✅ PASS: Case 7 (Whisper language capability consistency & anti-overclaim checks)');

    console.log('\n======================================================');
    console.log('🎉 ALL WHISPER MODEL SHA-256 CONTRACT TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    speechTranscriptionAdapter.clearCompatibilityCache();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

runWhisperModelSha256Tests().catch((err) => {
  console.error('\n❌ WHISPER MODEL SHA-256 CONTRACT TESTS FAILED:', err);
  process.exit(1);
});
