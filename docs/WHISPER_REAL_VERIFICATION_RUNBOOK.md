# VideoRisk v1.0 — Real Whisper Binary, Model & Human Speech Verification Runbook (WS5 & WS2)

> **Verification Boundary Statement (Verified Locally vs Production):**
> - **Verified Locally (Current Build/Verification Host):** Real native `whisper.cpp` (`whisper-cli` v1.9.6-dev, commit `95b3b2f855e09404499529228de15734cdeeb6a1`), real GGML model `/opt/whisper-models/ggml-base.en.bin` (`147,964,211` bytes, SHA-1 `137c40403d78fd54d454da0f9bd998f78703390c`, SHA-256 `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`), and real non-synthetic human speech fixture `tests/fixtures/speech/jfk_1961_inaugural_16k.wav` (11.0s Public Domain 1961 speech, SHA-256 `e39623e2c5d0e0013ab265d1e751c8aedae412ace9de5ab811d561ca9c9b57e1`) executed end-to-end via `npm run test:whisper:real` (`0.00%` WER, `recall=1`, `precision=1`), including MP4 -> FFmpeg 16kHz PCM WAV -> `whisper-cli`, `/api/health/readiness`, strict Ed25519 manifest attestation, and fail-closed error handling (corrupted media, missing model, timeout).
> - **Standard CI (`npm test`, `npm run test:regression`, `npm run test:phase4-6`):** Validates FFmpeg/Tesseract on synthetic media plus Whisper CLI contracts, SHA-256 TOCTOU checks, and Ed25519 manifest logic using isolated mock executables (because CI runners do not compile `whisper.cpp` or download 142 MiB GGML weights by default).
> - **NOT Verified in External Production:** Host binaries in `/opt/whisper.cpp` and `/opt/whisper-models` reside on the local verification container only. Production hosts/images must provision `whisper-cli`, checksum-verified models, offline maintainer Ed25519 signing (`WHISPER_STRICT_PROVENANCE=true`), and verify real workload latency, non-English/Thai speech models if needed, and multi-speaker noisy audio before claiming production readiness.

---

## 1. Install `whisper.cpp` Binary & Download Verified Model

### Option A: Build `whisper.cpp` (`whisper-cli`)
Requires `git`, `cmake`, and a C++17 toolchain (`g++` / `clang++`):

```bash
apt-get update && apt-get install -y --no-install-recommends cmake g++ git curl ffmpeg
git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /opt/whisper.cpp
# Verified commit on local verification host: 95b3b2f855e09404499529228de15734cdeeb6a1
cmake -B /opt/whisper.cpp/build -S /opt/whisper.cpp -DBUILD_SHARED_LIBS=OFF
cmake --build /opt/whisper.cpp/build -j --config Release --target whisper-cli
# Binary path: /opt/whisper.cpp/build/bin/whisper-cli
/opt/whisper.cpp/build/bin/whisper-cli --version
# Expected: whisper.cpp version: 1.9.6-dev (or newer)
```

### Download & Verify GGML Model (`ggml-base.en.bin`)
```bash
mkdir -p /opt/whisper-models
curl -fL --retry 3 \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
  -o /opt/whisper-models/ggml-base.en.bin

sha1sum /opt/whisper-models/ggml-base.en.bin
# Official whisper.cpp SHA-1 for base.en: 137c40403d78fd54d454da0f9bd998f78703390c

sha256sum /opt/whisper-models/ggml-base.en.bin
# Verified SHA-256: a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002
```

> Note: `ggml-base.en.bin` is English-only. If you require Thai (`th`) or multilingual transcription in production, provision a multilingual GGML model (e.g., `ggml-base.bin` or `ggml-medium.bin`) and verify its SHA-1/SHA-256 against `whisper.cpp/models/README.md`.

---

## 2. Checked-In Real Human Speech Fixture & `manifest.json`

> Never register synthetic tones, TTS, or unreviewed recordings as human speech.

Repository includes a verified Public Domain human speech fixture (not named `whisper_speech_16k.wav` so negative-control CI tests checking default unset behavior remain intact):

- **File:** `tests/fixtures/speech/jfk_1961_inaugural_16k.wav` (`352,078` bytes, `11.0s`, `pcm_s16le`, `16000 Hz`, mono)
- **Source & License:** Excerpt of President John F. Kennedy's 1961-01-20 Inaugural Address from `ggml-org/whisper.cpp` (`samples/jfk.wav`), Public Domain (U.S. Federal Government work, 17 U.S.C. § 105).
- **SHA-256:** `e39623e2c5d0e0013ab265d1e751c8aedae412ace9de5ab811d561ca9c9b57e1`
- **Manifest:** `tests/fixtures/speech/manifest.json` (`fixtureId`: `jfk_1961_inaugural_en_01`)

To convert or audit additional human speech WAV fixtures:

```bash
ffmpeg -y -i raw_human_speech.wav -vn -ac 1 -ar 16000 -c:a pcm_s16le tests/fixtures/speech/<fixture_name>.wav
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 tests/fixtures/speech/<fixture_name>.wav
# Expected output: pcm_s16le,16000,1
sha256sum tests/fixtures/speech/<fixture_name>.wav
```

---

## 3. Reproducible Real Whisper Execution & Automated Verification

### A. Direct CLI Smoke Check
```bash
/opt/whisper.cpp/build/bin/whisper-cli \
  -m /opt/whisper-models/ggml-base.en.bin \
  -f tests/fixtures/speech/jfk_1961_inaugural_16k.wav \
  --output-json -of /tmp/jfk_probe
cat /tmp/jfk_probe.json
rm -f /tmp/jfk_probe.json
```

Expected transcription text:
`"And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country."`

### B. Full VideoRisk Pipeline Verification Suite (`npm run test:whisper:real`)
Run the dedicated non-mocked verification suite against `SpeechTranscriptionAdapter`, `AudioProcessor`, `/api/health/readiness`, Ed25519 strict attestation, real MP4 -> FFmpeg 16kHz WAV transcoding, and fail-closed failure modes:

```bash
WHISPER_PATH=/opt/whisper.cpp/build/bin/whisper-cli \
WHISPER_MODEL_PATH=/opt/whisper-models/ggml-base.en.bin \
npm run test:whisper:real
```

Expected verified output (observed on 2-vCPU x86_64 AVX512 container):
- Preflight `validateRuntime()`: `READY` (`runtimeType: 'whisper_cpp'`, model header validated).
- `verifyRuntimeCompatibility()` (WAV + `manifest.json`): `RUNTIME_EXECUTION_VERIFIED`, `VERIFIED_HUMAN_SPEECH`, `MAINTAINER_ATTESTED`, `SPEECH_TRANSCRIPT_VERIFIED`, `recall=1`, `precision=1`, `WER=0.00% (S=0, D=0, I=0, N=22)`, `~4.6s`.
- Strict Ed25519 test (`WHISPER_STRICT_PROVENANCE=true`): `CRYPTOGRAPHICALLY_VERIFIED` + `TRANSCRIPT_VERIFIED`.
- End-to-end MP4 -> FFmpeg 16kHz WAV -> `whisper-cli` + `AudioProcessor.analyzeAudio()`: `status=DETECTED`, `segments=1`, `WER=0.00%`, `voiceoverRatio > 0.5`, zero leaked `vr_whisper_*` temp directories.
- `/api/health/readiness`: HTTP `200`, `checks.whisperStt.status='healthy'`.
- Failure modes: corrupted WAV (`SPEECH_FIXTURE_INVALID`), corrupted MP4 (`ANALYSIS_UNAVAILABLE`), missing model (`MODEL_NOT_FOUND`), `1ms` subprocess timeout (`TRANSCRIPTION_TIMEOUT`).

---

## 4. Production Hardening: Offline Ed25519 Attestation (`WHISPER_STRICT_PROVENANCE=true`)

In production, sign `tests/fixtures/speech/manifest.json` with an **offline** Ed25519 private key and configure only the public key in `WHISPER_TRUSTED_PUBLIC_KEYS`:

```bash
# 1. Generate Ed25519 keypair (keep private key OFFLINE)
node -e "
const crypto = require('crypto');
const fs = require('fs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync('/tmp/whisper_manifest_private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync('/tmp/whisper_manifest_public.pem', publicKey.export({ type: 'spki', format: 'pem' }));
"

# 2. Sign canonical payload using canonicalizeSpeechManifestPayload()
npx tsx -e "
import fs from 'fs';
import crypto from 'crypto';
import { canonicalizeSpeechManifestPayload } from './src/server/pipeline/audioProcessor';

const manifest = JSON.parse(fs.readFileSync('tests/fixtures/speech/manifest.json', 'utf8'));
delete manifest.signature;
const privPem = fs.readFileSync('/tmp/whisper_manifest_private.pem', 'utf8');
const payload = Buffer.from(canonicalizeSpeechManifestPayload(manifest), 'utf8');
manifest.signature = {
  algorithm: 'ed25519',
  keyId: 'release-2026-q4',
  value: crypto.sign(null, payload, privPem).toString('base64'),
  signedAt: new Date().toISOString()
};
fs.writeFileSync('tests/fixtures/speech/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
"
```

Production `.env`:
```bash
WHISPER_PATH=/opt/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL_PATH=/opt/whisper-models/ggml-base.en.bin
WHISPER_COMPAT_AUDIO_PATH=/app/tests/fixtures/speech/jfk_1961_inaugural_16k.wav
WHISPER_SPEECH_MANIFEST_PATH=/app/tests/fixtures/speech/manifest.json
WHISPER_VERIFY_COMPATIBILITY=true
WHISPER_STRICT_PROVENANCE=true
WHISPER_TRUSTED_PUBLIC_KEYS='{"release-2026-q4":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"}'
```

Verify readiness endpoint:
```bash
curl -s http://localhost:3000/api/health/readiness | jq '.checks.whisperStt'
```

---

## 5. Failure Diagnosis Reference

| Diagnostic Code | Root Cause | Resolution |
| :--- | :--- | :--- |
| `BINARY_NOT_FOUND` / `BINARY_NOT_EXECUTABLE` | `WHISPER_PATH` missing or lacks `+x` permission | Verify path and `chmod +x` on `whisper-cli` |
| `IDENTITY_CONTRACT_MISMATCH` | Binary `--help`/`--version` does not match `whisper.cpp` or `openai-whisper` CLI contract | Point `WHISPER_PATH` to compiled `whisper-cli` binary |
| `MODEL_NOT_FOUND` / `MODEL_INCOMPATIBLE` | Missing GGML file, wrong permissions, or invalid GGML/GGUF header bytes | Re-download model and verify SHA-1/SHA-256 checksum |
| `SPEECH_FIXTURE_NOT_FOUND` / `SPEECH_FIXTURE_INVALID` | Missing WAV, non-16kHz/mono PCM format, or silent/truncated WAV | Convert with `ffmpeg -ac 1 -ar 16000 -c:a pcm_s16le` |
| `UNTRUSTED_HASH_MISMATCH` / `INVALID_PROVENANCE` | WAV modified after manifest update, missing fields, or invalid Ed25519 signature | Update SHA-256, re-sign manifest, verify `WHISPER_TRUSTED_PUBLIC_KEYS` |
| `TRANSCRIPTION_TIMEOUT` | Inference exceeded `20000ms` (compat probe) or `60000ms` (`transcribe()`) | Allocate more CPU cores, use a smaller model (`tiny.en`/`base.en`), or keep clips bounded |
| `TRANSCRIPTION_FAILED` | Non-zero `whisper-cli` exit, malformed JSON, or corrupted input media | Inspect container logs / test `whisper-cli` directly on the file |

---

## 6. Resource Requirements & Operational Limitations

1. **Disk Footprint:** ~80 MB compiled `/opt/whisper.cpp/build` (runtime only needs the `3.4 MB` static `whisper-cli` binary) + `148 MB` for `ggml-base.en.bin` (or `~488 MB`–`3.1 GB` for larger multilingual models).
2. **Memory (RAM):** `ggml-base.en.bin` uses ~`147 MB` weights + `~160 MB` compute/KV buffers (~`320–400 MB` RSS per concurrent process). Larger models (`medium`, `large-v3`) require `2–4+ GB` RAM.
3. **CPU Latency & Timeouts:** Measured `~4.6s` on 11s audio (`~0.42x` real-time) on a 2-vCPU x86_64 host with AVX2/AVX512. On hosts without AVX2/F16C, or for long multi-minute videos, `transcribe()` enforces a hard `60,000ms` subprocess timeout (`audioProcessor.ts`) — long videos on CPU-only hosts can hit `TRANSCRIPTION_TIMEOUT` and fail closed as `ANALYSIS_UNAVAILABLE`.
4. **Scope & Language Capability Consistency (`ggml-base.en.bin` vs Thai `th`):**
   - `src/server/config/whisperModels.json` pins `ggml-base.en.bin` with `"modelType": "english-only"`, `"supportedLanguages": ["en"]`, and `"thaiSpeechSupported": false`.
   - `validateRuntime()`, `transcribe()`, `AudioProcessor.analyzeAudio()`, and `GET /api/health/readiness` (`checks.whisperStt.details`) all report `modelName`, `modelType`, `supportedLanguages`, `verifiedLanguages`, `thaiSpeechSupported`, `thaiSpeechVerified`, `transcriptionLanguage`, and `languageLimitation`.
   - **Fail-Closed `WHISPER_LANGUAGE` Guard:** Setting `WHISPER_LANGUAGE=th` (or any non-`en` language) against an `.en` model immediately fails closed with `ERROR` / `MODEL_INCOMPATIBLE` (`ANALYSIS_UNAVAILABLE` on `transcribe()` and `degraded` on `/api/health/readiness`).
   - **No Metadata-Only Thai Claims:** Even if a multilingual model filename (e.g. `ggml-base.bin`) or manifest metadata is configured, `'th'` and `thaiSpeechSupported: true` / `thaiSpeechVerified: true` are **never** claimed solely from filename or metadata without a passing Thai human speech verification fixture.
   - Measured `0.00%` WER is on a single clean archival 11s English recording (`jfk_1961_inaugural_16k.wav`); Thai (`th`) speech, background music overlap, heavy compression noise, and multi-speaker overlapping dialogue remain unverified on the default `ggml-base.en.bin` model.

---

## 7. Automated Model SHA-256 & Production Host Verification

### Automated GGML Model SHA-256 Verification
- Trusted built-in checksum manifest: `src/server/config/whisperModels.json` (`ggml-base.en.bin` -> `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002`).
- Anti-downgrade rule: `resolveExpectedModelSha256()` always inspects the built-in trusted manifest first. Conflicting `WHISPER_MODEL_SHA256`, `WHISPER_MODEL_MANIFEST_PATH`, or runtime hash overrides against a built-in manifest entry fail closed with `MODEL_SHA256_MISMATCH` (`modelIntegrityStatus: 'MISMATCH'`, `modelSha256Verified: false`).
- Env controls:
  - `WHISPER_MODEL_SHA256=<64-hex>` (must agree with built-in manifest when model filename is present in manifest; supplies hash for additional models)
  - `WHISPER_REQUIRE_MODEL_SHA256=true` (fail closed with `MODEL_EXPECTED_HASH_MISSING` if model is not in manifest and env hash is unset; invalidates cached runtime compatibility checks via runtime fingerprint)
  - `WHISPER_MODEL_MANIFEST_PATH=<path>` (supplemental manifest; cannot downgrade built-in checksums)
- Any SHA-256 mismatch or post-provisioning byte mutation fails closed immediately with `MODEL_SHA256_MISMATCH` (`ANALYSIS_UNAVAILABLE` on `transcribe()` and `degraded` on `/api/health/readiness`), bypassing cached compatibility results.
- CI-enforced contract suites (`.github/workflows/ci.yml`):
  - `npm run test:whisper:sha256` (`PASS` without downloading 142 MiB GGML weights)
  - `npm run test:stripe:harness` (`PASS` without requiring Stripe secrets or prod DB)

### Production Deployment Verification Script (`scripts/verify-whisper-prod.ts`)
Read-only, non-destructive host verification checking Binary + `ldd` + `ffmpeg`/`ffprobe`, Model SHA-256, Offline Ed25519 key hygiene & rotation (`WHISPER_TRUSTED_PUBLIC_KEYS` / `WHISPER_STRICT_PROVENANCE=true`), and Persistent vs Temporary storage paths:

```bash
# Production host check (strict: requires ENV binary, model, Ed25519 public key, non-tmpfs persistent volumes)
npm run verify:whisper:prod -- --mode=production

# Local verification container inspection (reflects local container only, NOT production sign-off)
npm run verify:whisper:prod -- --mode=local
```

Exit codes & Status Taxonomy:
- `0` = **`PASS`** (all host checks passed)
- `1` = **`FAIL`** (hard failure: checksum mismatch, missing library, tmpfs persistent volume in prod, leaked private key, etc.)
- `2` = **`BLOCKED`** (missing required ENV / Ed25519 public keys / host provisioning, zero hard failures; external host verification remains **`NOT VERIFIED`** until provisioned)

| Storage Path | Classification | Purpose & Verification Requirement |
| :--- | :--- | :--- |
| `DATA_DIR` / `DATABASE_PATH` dir | **PERSISTENT** | SQLite database (`videorisk.db`); writable dir, non-`tmpfs` volume |
| `uploads/` & `uploads/proxies/` | **PERSISTENT** | Uploaded media, thumbnails & playback proxies; non-`tmpfs` volume |
| `dirname(WHISPER_MODEL_PATH)` | **PERSISTENT** | Provisioned GGML weights; readable, non-`tmpfs` volume |
| `os.tmpdir()` (`vr_whisper_*`) | **TEMPORARY** | Transient 16kHz WAV & JSON output; cleaned up after every run |
| `uploads/ocr_frames/` | **TEMPORARY** | Per-scan OCR PNG staging frames; cleaned up via `cleanupFrames()` |

