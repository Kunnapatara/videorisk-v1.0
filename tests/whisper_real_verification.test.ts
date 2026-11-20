import assert from 'assert';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { enforceTestDatabaseIsolation } from '../src/server/storage/testIsolation';

process.env.VIDEORISK_TEST_RUN = 'true';
enforceTestDatabaseIsolation();

const execFileAsync = promisify(execFile);

interface WerBreakdown {
  referenceWords: string[];
  hypothesisWords: string[];
  substitutions: number;
  deletions: number;
  insertions: number;
  editDistance: number;
  wer: number;
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function computeWordErrorRate(reference: string, hypothesis: string): WerBreakdown {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  const m = ref.length;
  const n = hyp.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  const op: Array<Array<'eq' | 'sub' | 'del' | 'ins'>> = Array.from({ length: m + 1 }, () =>
    new Array<'eq' | 'sub' | 'del' | 'ins'>(n + 1).fill('eq')
  );

  for (let i = 1; i <= m; i++) {
    dp[i][0] = i;
    op[i][0] = 'del';
  }
  for (let j = 1; j <= n; j++) {
    dp[0][j] = j;
    op[0][j] = 'ins';
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
        op[i][j] = 'eq';
      } else {
        const subCost = dp[i - 1][j - 1] + 1;
        const delCost = dp[i - 1][j] + 1;
        const insCost = dp[i][j - 1] + 1;
        if (subCost <= delCost && subCost <= insCost) {
          dp[i][j] = subCost;
          op[i][j] = 'sub';
        } else if (delCost <= insCost) {
          dp[i][j] = delCost;
          op[i][j] = 'del';
        } else {
          dp[i][j] = insCost;
          op[i][j] = 'ins';
        }
      }
    }
  }

  let i = m;
  let j = n;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (i > 0 || j > 0) {
    const step = op[i][j];
    if (step === 'eq') {
      i--;
      j--;
    } else if (step === 'sub') {
      substitutions++;
      i--;
      j--;
    } else if (step === 'del') {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }

  const editDistance = dp[m][n];
  const wer = m === 0 ? (n === 0 ? 0 : 1) : parseFloat((editDistance / m).toFixed(4));
  return {
    referenceWords: ref,
    hypothesisWords: hyp,
    substitutions,
    deletions,
    insertions,
    editDistance,
    wer,
  };
}

export async function runWhisperRealVerificationTests() {
  console.log('\n======================================================');
  console.log('--- REAL WHISPER.CPP & HUMAN SPEECH VERIFICATION -----');
  console.log('No mocks, no stubs, no synthetic TTS audio');
  console.log('======================================================\n');

  const whisperBin = process.env.WHISPER_PATH || '/opt/whisper.cpp/build/bin/whisper-cli';
  const whisperModel = process.env.WHISPER_MODEL_PATH || '/opt/whisper-models/ggml-base.en.bin';
  const manifestPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'speech', 'manifest.json');
  const fixtureWavPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'speech', 'jfk_1961_inaugural_16k.wav');

  if (!fs.existsSync(whisperBin)) {
    throw new Error(`REAL WHISPER VERIFICATION BLOCKED: whisper-cli binary not found at ${whisperBin}`);
  }
  if (!fs.existsSync(whisperModel)) {
    throw new Error(`REAL WHISPER VERIFICATION BLOCKED: GGML model not found at ${whisperModel}`);
  }
  if (!fs.existsSync(fixtureWavPath) || !fs.existsSync(manifestPath)) {
    throw new Error(`REAL WHISPER VERIFICATION BLOCKED: Human speech fixture or manifest missing (${fixtureWavPath})`);
  }

  const {
    audioProcessor,
    speechTranscriptionAdapter,
    canonicalizeSpeechManifestPayload,
  } = await import('../src/server/pipeline/audioProcessor');
  const { apiRouter } = await import('../src/server/routes/api');

  const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const fixtureEntry = manifestData.fixtures?.[0];
  assert.ok(fixtureEntry, 'manifest.json contains verified human speech fixture entry');
  const referenceTranscript: string = fixtureEntry.expectedTranscript;

  const savedEnv: Record<string, string | undefined> = {
    WHISPER_PATH: process.env.WHISPER_PATH,
    LOCAL_STT_PATH: process.env.LOCAL_STT_PATH,
    WHISPER_MODEL_PATH: process.env.WHISPER_MODEL_PATH,
    WHISPER_COMPAT_AUDIO_PATH: process.env.WHISPER_COMPAT_AUDIO_PATH,
    WHISPER_COMPAT_EXPECTED_TRANSCRIPT: process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT,
    WHISPER_COMPAT_SYNTHETIC_FIXTURE: process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE,
    WHISPER_VERIFY_COMPATIBILITY: process.env.WHISPER_VERIFY_COMPATIBILITY,
    WHISPER_SPEECH_MANIFEST_PATH: process.env.WHISPER_SPEECH_MANIFEST_PATH,
    WHISPER_STRICT_PROVENANCE: process.env.WHISPER_STRICT_PROVENANCE,
    WHISPER_TRUSTED_PUBLIC_KEYS: process.env.WHISPER_TRUSTED_PUBLIC_KEYS,
  };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_real_whisper_test_'));

  try {
    process.env.WHISPER_PATH = whisperBin;
    delete process.env.LOCAL_STT_PATH;
    process.env.WHISPER_MODEL_PATH = whisperModel;
    process.env.WHISPER_COMPAT_AUDIO_PATH = fixtureWavPath;
    process.env.WHISPER_SPEECH_MANIFEST_PATH = manifestPath;
    delete process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT;
    delete process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE;
    delete process.env.WHISPER_STRICT_PROVENANCE;
    delete process.env.WHISPER_TRUSTED_PUBLIC_KEYS;
    process.env.WHISPER_VERIFY_COMPATIBILITY = 'true';
    speechTranscriptionAdapter.clearCompatibilityCache();

    // ------------------------------------------------------------------------
    // 1. REAL BINARY & MODEL PREFLIGHT VALIDATION
    // ------------------------------------------------------------------------
    console.log('[1. Real whisper-cli & GGML Model Preflight Validation]');
    const validation = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(validation.status, 'READY', `1.1 Expected READY preflight, got ${validation.status} (${validation.details})`);
    assert.strictEqual(validation.runtimeType, 'whisper_cpp', '1.2 Runtime identity verified as whisper_cpp');
    assert.strictEqual(validation.executableFound, true, '1.3 Executable found');
    assert.strictEqual(validation.isExecutable, true, '1.4 Executable permission verified');
    assert.strictEqual(validation.modelFound, true, '1.5 GGML model header & readability verified');
    console.log(`  Binary : ${validation.executablePath} (${validation.version || 'version-detected'})`);
    console.log(`  Model  : ${validation.modelPath}`);
    console.log('  ✅ PASS: Real whisper-cli preflight READY');

    // ------------------------------------------------------------------------
    // 2. REAL HUMAN SPEECH COMPATIBILITY, PROVENANCE & WER BENCHMARK
    // ------------------------------------------------------------------------
    console.log('\n[2. Real Human Speech WAV Compatibility, Manifest Provenance & WER]');
    const compatRes = await speechTranscriptionAdapter.verifyRuntimeCompatibility({
      audioFixturePath: fixtureWavPath,
      trustedManifestPath: manifestPath,
      useCache: false,
    });
    assert.strictEqual(compatRes.compatible, true, `2.1 Real compatibility verification failed: ${compatRes.details}`);
    assert.strictEqual(compatRes.runtimeExecutionStatus, 'RUNTIME_EXECUTION_VERIFIED', '2.2 Runtime execution verified');
    assert.strictEqual(compatRes.humanSpeechProvenanceStatus, 'VERIFIED_HUMAN_SPEECH', '2.3 Human speech provenance verified');
    assert.strictEqual(compatRes.provenanceTrustTier, 'MAINTAINER_ATTESTED', '2.4 Unsigned checked-in manifest reports MAINTAINER_ATTESTED');
    assert.strictEqual(compatRes.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_VERIFIED', '2.5 Speech transcript verified');
    assert.strictEqual(compatRes.speechTranscriptVerified, true, '2.6 speechTranscriptVerified=true');
    assert.ok(compatRes.transcriptComparison?.passed, '2.7 Ordered token LCS comparison passed');

    const werWav = computeWordErrorRate(referenceTranscript, compatRes.transcriptText || '');
    console.log(`  Fixture    : ${path.basename(fixtureWavPath)} (${fixtureEntry.durationSeconds}s, SHA-256 verified)`);
    console.log(`  Reference  : "${referenceTranscript}"`);
    console.log(`  Transcript : "${compatRes.transcriptText}"`);
    console.log(
      `  Metrics    : recall=${compatRes.transcriptComparison?.recall}, precision=${compatRes.transcriptComparison?.precision}, ` +
        `WER=${(werWav.wer * 100).toFixed(2)}% (S=${werWav.substitutions}, D=${werWav.deletions}, I=${werWav.insertions}, N=${werWav.referenceWords.length}), ` +
        `duration=${compatRes.executionDurationMs}ms`
    );
    assert.ok(werWav.wer <= 0.15, `2.8 Real WAV WER ${(werWav.wer * 100).toFixed(2)}% exceeds max threshold 15%`);
    console.log('  ✅ PASS: Real WAV human speech transcription + WER verified');

    // ------------------------------------------------------------------------
    // 3. STRICT CRYPTOGRAPHIC PROVENANCE (ED25519) WITH REAL WHISPER-CLI
    // ------------------------------------------------------------------------
    console.log('\n[3. Real whisper-cli under WHISPER_STRICT_PROVENANCE=true (Ed25519)]');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signedCopyWav = path.join(workDir, path.basename(fixtureWavPath));
    fs.copyFileSync(fixtureWavPath, signedCopyWav);

    const unsignedCopy = JSON.parse(JSON.stringify(manifestData));
    delete unsignedCopy.signature;
    const payloadBuf = Buffer.from(canonicalizeSpeechManifestPayload(unsignedCopy), 'utf8');
    const signedManifestObj = {
      ...unsignedCopy,
      signature: {
        algorithm: 'ed25519' as const,
        keyId: 'real-verify-ephemeral-key',
        value: crypto.sign(null, payloadBuf, privateKey).toString('base64'),
        signedAt: new Date().toISOString(),
      },
    };
    const signedManifestPath = path.join(workDir, 'signed_manifest.json');
    fs.writeFileSync(signedManifestPath, JSON.stringify(signedManifestObj, null, 2));

    const strictRes = await speechTranscriptionAdapter.verifyRuntimeCompatibility({
      audioFixturePath: signedCopyWav,
      trustedManifestPath: signedManifestPath,
      trustedPublicKeys: { 'real-verify-ephemeral-key': pubPem },
      strictAttestationMode: true,
      useCache: false,
    });
    assert.strictEqual(strictRes.compatible, true, `3.1 Strict mode real verification failed: ${strictRes.details}`);
    assert.strictEqual(strictRes.provenanceTrustTier, 'CRYPTOGRAPHICALLY_VERIFIED', '3.2 Trust tier is CRYPTOGRAPHICALLY_VERIFIED');
    assert.strictEqual(strictRes.fixtureProvenance?.signatureVerified, true, '3.3 Ed25519 signature verified');
    assert.deepStrictEqual(
      strictRes.verificationStates,
      ['RUNTIME_COMPATIBLE', 'FIXTURE_INTEGRITY_VERIFIED', 'CRYPTOGRAPHICALLY_VERIFIED', 'TRANSCRIPT_VERIFIED'],
      '3.4 Complete verification state chain matched'
    );
    console.log('  ✅ PASS: Strict Ed25519 provenance + real whisper-cli verified');

    // ------------------------------------------------------------------------
    // 4. END-TO-END MP4 -> FFMPEG 16KHZ WAV -> REAL WHISPER-CLI + AUDIOPROCESSOR
    // ------------------------------------------------------------------------
    console.log('\n[4. End-to-End MP4 -> FFmpeg 16kHz WAV -> Real whisper-cli & AudioProcessor]');
    const speechMp4Path = path.join(workDir, 'jfk_real_speech.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=0x111827:s=320x240:d=11',
      '-i', fixtureWavPath,
      '-shortest',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-ar', '44100',
      '-ac', '2',
      speechMp4Path,
    ]);

    const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('vr_whisper_')));

    const mp4Tx = await speechTranscriptionAdapter.transcribe(speechMp4Path, 11.0, {
      verifyCompatibility: true,
      audioFixturePath: fixtureWavPath,
      trustedManifestPath: manifestPath,
      forceRefreshCompatibility: true,
    });
    assert.strictEqual(mp4Tx.status, 'DETECTED', `4.1 MP4 transcription failed: ${mp4Tx.failureReason || mp4Tx.limitations}`);
    assert.ok((mp4Tx.transcriptText || '').length > 0, '4.2 Non-empty transcript from real MP4');
    assert.ok(Array.isArray(mp4Tx.segments) && mp4Tx.segments.length >= 1, '4.3 Timestamped segments populated from whisper-cli JSON');
    for (const seg of mp4Tx.segments || []) {
      assert.ok(seg.start >= 0 && seg.end <= 11.0 && seg.start < seg.end, `4.4 Valid timestamp bounds (${seg.start}..${seg.end})`);
    }
    assert.strictEqual(mp4Tx.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_VERIFIED', '4.5 Speech transcript verification preserved on MP4 transcribe');

    const werMp4 = computeWordErrorRate(referenceTranscript, mp4Tx.transcriptText || '');
    console.log(`  MP4 Output : "${mp4Tx.transcriptText}"`);
    console.log(`  MP4 WER    : ${(werMp4.wer * 100).toFixed(2)}% (segments=${mp4Tx.segments?.length}, duration=${mp4Tx.executionDurationMs}ms)`);
    assert.ok(werMp4.wer <= 0.15, `4.6 Real MP4 WER ${(werMp4.wer * 100).toFixed(2)}% exceeds 15%`);

    // Also run full AudioProcessor.analyzeAudio on the MP4 (FFmpeg silencedetect/volumedetect + PCM + Whisper)
    const audioAnalysis = await audioProcessor.analyzeAudio(speechMp4Path, 11.0);
    assert.strictEqual(audioAnalysis.hasVoiceover, true, '4.7 AudioProcessor detects real voiceover via Whisper');
    assert.strictEqual(audioAnalysis.hasTimestampedVoiceover, true, '4.8 Timestamped voiceover true');
    assert.ok(audioAnalysis.voiceoverRatio > 0.5, `4.9 Voiceover ratio realistic (${audioAnalysis.voiceoverRatio})`);
    assert.strictEqual(audioAnalysis.transcriptionStatus, 'DETECTED', '4.10 AudioProcessor transcriptionStatus=DETECTED');
    assert.strictEqual(audioAnalysis.detectors?.audio_transcription?.status, 'DETECTED', '4.11 Detector report status=DETECTED');

    const tmpAfter = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('vr_whisper_') && !tmpBefore.has(f));
    assert.strictEqual(tmpAfter.length, 0, `4.12 Zero leaked vr_whisper_* temp dirs in os.tmpdir() (found: ${tmpAfter.join(', ')})`);
    console.log('  ✅ PASS: End-to-end MP4 -> FFmpeg -> whisper-cli & temp cleanup verified');

    // ------------------------------------------------------------------------
    // 5. LIVE READINESS ENDPOINT (/api/health/readiness) WITH REAL WHISPER
    // ------------------------------------------------------------------------
    console.log('\n[5. /api/health/readiness Reporting with Real whisper-cli]');
    const app = express();
    app.use('/api', apiRouter);
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address() as any;
      speechTranscriptionAdapter.clearCompatibilityCache();
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/health/readiness`);
      assert.strictEqual(res.status, 200, '5.1 Readiness HTTP 200');
      const body = await res.json();
      const w = body?.checks?.whisperStt;
      assert.strictEqual(w?.status, 'healthy', `5.2 whisperStt healthy (got ${w?.status}: ${w?.message})`);
      assert.strictEqual(w?.details?.runtimeType, 'whisper_cpp', '5.3 runtimeType=whisper_cpp');
      assert.strictEqual(w?.details?.runtimeExecutionStatus, 'RUNTIME_EXECUTION_VERIFIED', '5.4 runtimeExecutionStatus=RUNTIME_EXECUTION_VERIFIED');
      assert.strictEqual(w?.details?.humanSpeechProvenanceStatus, 'VERIFIED_HUMAN_SPEECH', '5.5 humanSpeechProvenanceStatus=VERIFIED_HUMAN_SPEECH');
      assert.strictEqual(w?.details?.provenanceTrustTier, 'MAINTAINER_ATTESTED', '5.6 provenanceTrustTier=MAINTAINER_ATTESTED');
      assert.strictEqual(w?.details?.speechTranscriptStatus, 'SPEECH_TRANSCRIPT_VERIFIED', '5.7 speechTranscriptStatus=SPEECH_TRANSCRIPT_VERIFIED');
      assert.strictEqual(w?.details?.speechTranscriptVerified, true, '5.8 speechTranscriptVerified=true');
      console.log('  ✅ PASS: /api/health/readiness accurately reports verified real Whisper STT');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // ------------------------------------------------------------------------
    // 6. FAIL-CLOSED REAL FAILURE MODES (CORRUPTED AUDIO, MISSING MODEL, TIMEOUT)
    // ------------------------------------------------------------------------
    console.log('\n[6. Real Failure Modes — Corrupted Audio, Missing Model, Timeout]');

    // 6A. Corrupted WAV passed to compatibility & transcribe
    const corruptWavPath = path.join(workDir, 'corrupt_audio.wav');
    fs.writeFileSync(corruptWavPath, Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt_corrupted_truncated_bytes'));
    const corruptCompat = await speechTranscriptionAdapter.verifyRuntimeCompatibility({
      audioFixturePath: corruptWavPath,
      useCache: false,
    });
    assert.strictEqual(corruptCompat.compatible, false, '6.1 Corrupted WAV rejected by verifyRuntimeCompatibility');
    assert.strictEqual(corruptCompat.diagnosticCode, 'SPEECH_FIXTURE_INVALID', '6.2 Corrupted WAV reports SPEECH_FIXTURE_INVALID');

    const corruptMp4Path = path.join(workDir, 'corrupt_media.mp4');
    fs.writeFileSync(corruptMp4Path, Buffer.from('NOT_A_VALID_MP4_CONTAINER_00000000'));
    const corruptTx = await speechTranscriptionAdapter.transcribe(corruptMp4Path, 5.0, {
      verifyCompatibility: false,
    });
    assert.strictEqual(corruptTx.status, 'ANALYSIS_UNAVAILABLE', '6.3 Corrupted MP4 fails closed as ANALYSIS_UNAVAILABLE');
    assert.ok(corruptTx.diagnosticCode && corruptTx.diagnosticCode !== 'READY', `6.4 Corrupted MP4 sets failure diagnosticCode (${corruptTx.diagnosticCode})`);

    // 6B. Missing model path
    process.env.WHISPER_MODEL_PATH = path.join(workDir, 'nonexistent_ggml_model.bin');
    speechTranscriptionAdapter.clearCompatibilityCache();
    const missingModelValidation = await speechTranscriptionAdapter.validateRuntime();
    assert.strictEqual(missingModelValidation.status, 'MISSING_MODEL', '6.5 Missing model status=MISSING_MODEL');
    assert.strictEqual(missingModelValidation.diagnosticCode, 'MODEL_NOT_FOUND', '6.6 Missing model diagnosticCode=MODEL_NOT_FOUND');
    const missingModelTx = await speechTranscriptionAdapter.transcribe(speechMp4Path, 11.0);
    assert.strictEqual(missingModelTx.status, 'ANALYSIS_UNAVAILABLE', '6.7 Missing model fails closed on transcribe()');
    assert.strictEqual(missingModelTx.diagnosticCode, 'MODEL_NOT_FOUND', '6.8 Missing model transcribe diagnosticCode=MODEL_NOT_FOUND');

    // 6C. Real subprocess timeout against real whisper-cli + 142MB model
    process.env.WHISPER_MODEL_PATH = whisperModel;
    speechTranscriptionAdapter.clearCompatibilityCache();
    const timeoutRes = await speechTranscriptionAdapter.verifyRuntimeCompatibility({
      audioFixturePath: fixtureWavPath,
      trustedManifestPath: manifestPath,
      timeoutMs: 1, // 1ms guaranteed smaller than ~290ms model load + 4.8s decode
      useCache: false,
    });
    assert.strictEqual(timeoutRes.compatible, false, '6.9 1ms timeout fails closed against real whisper-cli');
    assert.strictEqual(timeoutRes.diagnosticCode, 'TRANSCRIPTION_TIMEOUT', `6.10 Timeout diagnosticCode=TRANSCRIPTION_TIMEOUT (got ${timeoutRes.diagnosticCode})`);
    assert.strictEqual(timeoutRes.runtimeExecutionStatus, 'FAILED', '6.11 Timeout marks runtimeExecutionStatus=FAILED');
    console.log('  ✅ PASS: All fail-closed real failure modes verified (corrupted audio, missing model, timeout)');

    console.log('\n======================================================');
    console.log('🎉 ALL REAL WHISPER.CPP VERIFICATION CHECKS PASSED!');
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

runWhisperRealVerificationTests().catch((err) => {
  console.error('\n❌ REAL WHISPER VERIFICATION FAILED:', err);
  process.exit(1);
});
