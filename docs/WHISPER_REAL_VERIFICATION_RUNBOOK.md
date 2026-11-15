# VideoRisk v1.0 — Real Whisper Binary, Model & Human Speech Verification Runbook (WS5 & WS2)

> **Verification Boundary Statement:**
> CI and local tests (`npm run test:regression`, `npm run test:phase4-6`) validate CLI contract parsing, FFmpeg MP4-to-16kHz-WAV transcoding, SHA-256 TOCTOU integrity, Ed25519 manifest signatures, and ordered-token LCS comparison using isolated mock executables and synthetic test WAV files.
> **Actual speech recognition quality and native `whisper.cpp` execution remain `NOT_VERIFIED` inside ephemeral CI/build containers lacking `whisper.cpp` + real human speech audio.**
> Follow this runbook on the target production or staging host to achieve `CRYPTOGRAPHICALLY_VERIFIED` + `TRANSCRIPT_VERIFIED`.

---

## 1. Install `whisper.cpp` Binary & Download Verified Model

### Option A: Build `whisper.cpp` (`whisper-cli`)
```bash
git clone https://github.com/ggml-org/whisper.cpp.git /opt/whisper.cpp
cmake -B /opt/whisper.cpp/build -S /opt/whisper.cpp
cmake --build /opt/whisper.cpp/build -j --config Release
# Binary path: /opt/whisper.cpp/build/bin/whisper-cli
/opt/whisper.cpp/build/bin/whisper-cli --help
```

### Download & Verify GGML Model (e.g. `ggml-base.en.bin`)
```bash
mkdir -p /opt/whisper-models
bash /opt/whisper.cpp/models/download-ggml-model.sh base.en /opt/whisper-models
sha256sum /opt/whisper-models/ggml-base.en.bin
# Compare SHA-256 against official whisper.cpp release checksums before trusting!
```

---

## 2. Prepare Real Human Speech Fixture (16kHz Mono 16-bit PCM WAV)

> Never register synthetic tones, TTS, or unreviewed recordings as human speech.

Convert a human-spoken reference recording (with known verbatim transcript) to 16kHz mono PCM WAV:

```bash
mkdir -p tests/fixtures/speech
ffmpeg -y -i raw_human_speech.wav -vn -ac 1 -ar 16000 -c:a pcm_s16le tests/fixtures/speech/whisper_speech_16k.wav
sha256sum tests/fixtures/speech/whisper_speech_16k.wav
```

Verify audio container format:

```bash
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 tests/fixtures/speech/whisper_speech_16k.wav
# Expected output: pcm_s16le,16000,1
```

---

## 3. Generate Ed25519 Attestation Keys & Sign `manifest.json` (Option B — Strict Mode)

### Step A: Generate an Ed25519 Maintainer Signing Keypair (keep private key OFFLINE)
```bash
node -e "
const crypto = require('crypto');
const fs = require('fs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync('/tmp/whisper_manifest_private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync('/tmp/whisper_manifest_public.pem', publicKey.export({ type: 'spki', format: 'pem' }));
console.log('Generated ephemeral Ed25519 keys in /tmp (move private key offline before production use).');
"
```

### Step B: Author `tests/fixtures/speech/manifest.json`
Fill `sha256`, `expectedTranscript`, `transcriptReviewEvidence`, `verifiedBy`, `verifiedAt` (strict ISO-8601), `verificationMethod`, and `hashAlgorithm: "sha256"`:

```json
{
  "manifestVersion": "1.0.0",
  "description": "Production verified human speech fixture manifest",
  "fixtures": [
    {
      "fixtureId": "human_speech_en_01",
      "relativePath": "whisper_speech_16k.wav",
      "sha256": "<64-char-hex-sha256>",
      "sourceDescription": "Clean human studio voice recording (English)",
      "recordingOrigin": "HUMAN_SPEECH_RECORDING",
      "humanSpeechVerificationStatus": "VERIFIED_HUMAN_SPEECH",
      "expectedTranscript": "Exact verbatim human reviewed spoken phrase",
      "transcriptLanguage": "en",
      "transcriptReviewEvidence": "Manually auditioned and transcribed verbatim by maintainer",
      "verificationMetadata": {
        "verifiedBy": "<maintainer-id>",
        "verifiedAt": "2026-11-15T12:00:00Z",
        "verificationMethod": "manual_human_audit",
        "hashAlgorithm": "sha256"
      }
    }
  ]
}
```

### Step C: Sign the Canonical Manifest Payload
Use the exact `canonicalizeSpeechManifestPayload` function exported by `src/server/pipeline/audioProcessor.ts`:

```bash
npx tsx -e "
import fs from 'fs';
import crypto from 'crypto';
import { canonicalizeSpeechManifestPayload } from './src/server/pipeline/audioProcessor';

const manifest = JSON.parse(fs.readFileSync('tests/fixtures/speech/manifest.json', 'utf8'));
delete manifest.signature;
const privPem = fs.readFileSync('/tmp/whisper_manifest_private.pem', 'utf8');
const payload = Buffer.from(canonicalizeSpeechManifestPayload(manifest), 'utf8');
const sig = crypto.sign(null, payload, privPem).toString('base64');
manifest.signature = {
  algorithm: 'ed25519',
  keyId: 'release-2026-q4',
  value: sig,
  signedAt: new Date().toISOString()
};
fs.writeFileSync('tests/fixtures/speech/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('Signed manifest.json cleanly with keyId=release-2026-q4');
"
```

---

## 4. Configure Environment & Verify Runtime Readiness

Set in production `.env`:

```bash
WHISPER_PATH=/opt/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL_PATH=/opt/whisper-models/ggml-base.en.bin
WHISPER_COMPAT_AUDIO_PATH=/app/tests/fixtures/speech/whisper_speech_16k.wav
WHISPER_SPEECH_MANIFEST_PATH=/app/tests/fixtures/speech/manifest.json
WHISPER_VERIFY_COMPATIBILITY=true
WHISPER_STRICT_PROVENANCE=true
WHISPER_TRUSTED_PUBLIC_KEYS='{"release-2026-q4":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"}'
```

Run live verification against the real `whisper-cli` binary, GGML model, and human speech WAV:

```bash
curl -s http://localhost:3000/api/health/readiness | jq '.checks.whisperStt'
```

Expected readiness output:
- `"status": "healthy"`
- `"details.runtimeExecutionStatus": "RUNTIME_EXECUTION_VERIFIED"`
- `"details.provenanceTrustTier": "CRYPTOGRAPHICALLY_VERIFIED"`
- `"details.signatureVerified": true`
- `"details.signatureKeyId": "release-2026-q4"`
- `"details.speechTranscriptStatus": "SPEECH_TRANSCRIPT_VERIFIED"`
- `"details.verificationStates"`: `["RUNTIME_COMPATIBLE", "FIXTURE_INTEGRITY_VERIFIED", "CRYPTOGRAPHICALLY_VERIFIED", "TRANSCRIPT_VERIFIED"]`

Also test real MP4 -> 16kHz WAV -> `whisper-cli` end-to-end transcription on an uploaded human speech `.mp4` scan and confirm zero temporary `.wav` or `.json` files remain in repository root or `os.tmpdir()`.
