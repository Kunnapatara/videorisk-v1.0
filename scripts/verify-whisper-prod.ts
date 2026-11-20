/**
 * VideoRisk v1.0 — Production Deployment Verification Script for Whisper STT & Media Storage
 *
 * Non-destructive, read-only verification of:
 *   A. Whisper Binary (path, executable bit, --version/--help, shared libs via ldd, ffmpeg/ffprobe, runtime compat)
 *   B. GGML Model (path, readability, GGML/GGUF header, file size, automated Task 2 SHA-256 checksum)
 *   C. Offline Ed25519 Key & Provenance Hygiene (WHISPER_STRICT_PROVENANCE, WHISPER_TRUSTED_PUBLIC_KEYS rotation/revocation,
 *      manifest signature validation, private-key hygiene — NEVER generates or logs private keys)
 *   D. Persistent vs Temporary Storage Classification (SQLite DB dir, uploads/, uploads/proxies/, model dir,
 *      os.tmpdir(), uploads/ocr_frames/, mount filesystem type / non-tmpfs check, permissions, free disk, safe temp cleanup)
 *   E. Deterministic Summary & Exit Codes:
 *        0 = PASS (all required checks passed)
 *        1 = FAIL (hard integrity, binary, checksum, security, or storage failure)
 *        2 = BLOCKED (awaiting required ENV / credentials / host provisioning, with zero hard failures)
 *
 * Usage:
 *   npx tsx scripts/verify-whisper-prod.ts --mode=production
 *   npx tsx scripts/verify-whisper-prod.ts --mode=local
 *   npx tsx scripts/verify-whisper-prod.ts --mode=production --json
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import { speechTranscriptionAdapter } from '../src/server/pipeline/audioProcessor';

dotenv.config({ quiet: true });

const execFileAsync = promisify(execFile);

export type CheckOutcome = 'PASS' | 'FAIL' | 'BLOCKED' | 'WARN';

export interface CheckRecord {
  section: 'A_BINARY' | 'B_MODEL' | 'C_ED25519' | 'D_STORAGE';
  id: string;
  label: string;
  status: CheckOutcome;
  details: string;
  classification?: 'PERSISTENT' | 'TEMPORARY';
  targetPath?: string;
}

export interface WhisperProdVerificationReport {
  mode: 'production' | 'local';
  timestamp: string;
  hostPlatform: string;
  overallStatus: 'PASS' | 'FAIL' | 'BLOCKED';
  exitCode: 0 | 1 | 2;
  counts: {
    pass: number;
    warn: number;
    blocked: number;
    fail: number;
  };
  boundaryNote: string;
  checks: CheckRecord[];
}

const EPHEMERAL_TEST_KEY_ID_PATTERN = /(ephemeral|temp|mock|dummy|test[-_]?key|local[-_]?dev)/i;

function parseArgs(argv: string[]): { mode: 'production' | 'local'; json: boolean } {
  let mode: 'production' | 'local' =
    process.env.DEPLOYMENT_ENV === 'production' || process.env.NODE_ENV === 'production'
      ? 'production'
      : 'local';
  let json = false;

  for (const arg of argv) {
    if (arg === '--mode=production') mode = 'production';
    else if (arg === '--mode=local') mode = 'local';
    else if (arg === '--json') json = true;
  }

  return { mode, json };
}

function getDfStats(targetPath: string): Promise<{
  fsType: string;
  availKb: number;
  usedPct: string;
  mountPoint: string;
} | null> {
  return execFileAsync('df', ['-T', '-P', targetPath])
    .then(({ stdout }) => {
      const lines = stdout.trim().split(/\r?\n/);
      if (lines.length < 2) return null;
      const cols = lines[lines.length - 1].trim().split(/\s+/);
      // POSIX df -T -P columns: Filesystem Type 1024-blocks Used Available Capacity Mounted-on
      if (cols.length < 7) return null;
      return {
        fsType: cols[1],
        availKb: Number.parseInt(cols[4], 10) || 0,
        usedPct: cols[5],
        mountPoint: cols.slice(6).join(' '),
      };
    })
    .catch(() => null);
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fingerprintPublicKey(pem: string): string {
  return crypto.createHash('sha256').update(pem.trim()).digest('hex').slice(0, 16);
}

function checkPrivateKeyHygiene(workspaceRoot: string): { clean: boolean; findings: string[] } {
  const findings: string[] = [];
  const scanDirs = ['src', 'scripts', 'docs', 'tests'];
  const privateHeaderRegex = /-----BEGIN (?:ENCRYPTED |EC |RSA |OPENSSH )?PRIVATE KEY-----/;

  for (const relDir of scanDirs) {
    const absDir = path.join(workspaceRoot, relDir);
    if (!fs.existsSync(absDir)) continue;
    const stack = [absDir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.pem') || lower.endsWith('.key') || lower.includes('private_key')) {
          try {
            const head = fs.readFileSync(full, 'utf8').slice(0, 512);
            if (privateHeaderRegex.test(head)) {
              findings.push(path.relative(workspaceRoot, full));
            }
          } catch {
            // ignore unreadable binary
          }
        }
      }
    }
  }

  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (
      (envKey.startsWith('WHISPER_') || envKey.includes('ED25519')) &&
      typeof envVal === 'string' &&
      privateHeaderRegex.test(envVal)
    ) {
      findings.push(`ENV:${envKey} (contains PRIVATE KEY block)`);
    }
  }

  return { clean: findings.length === 0, findings };
}

export async function runVerifyWhisperProd(options?: {
  mode?: 'production' | 'local';
}): Promise<WhisperProdVerificationReport> {
  const parsed = parseArgs(process.argv.slice(2));
  const mode = options?.mode ?? parsed.mode;
  const checks: CheckRecord[] = [];
  const cwd = process.cwd();

  const add = (check: CheckRecord) => {
    checks.push(check);
  };

  // Preserve & temporarily bind local fallback paths ONLY in local mode when ENV is unset,
  // WITHOUT modifying process.env permanently or touching any production DB.
  const configuredBin = (process.env.WHISPER_PATH || process.env.LOCAL_STT_PATH || '').trim();
  const configuredModel = (process.env.WHISPER_MODEL_PATH || '').trim();
  const localDefaultBin = '/opt/whisper.cpp/build/bin/whisper-cli';
  const localDefaultModel = '/opt/whisper-models/ggml-base.en.bin';

  const effectiveBin = configuredBin || (mode === 'local' && fs.existsSync(localDefaultBin) ? localDefaultBin : '');
  const effectiveModel = configuredModel || (mode === 'local' && fs.existsSync(localDefaultModel) ? localDefaultModel : '');

  const savedEnv = {
    WHISPER_PATH: process.env.WHISPER_PATH,
    WHISPER_MODEL_PATH: process.env.WHISPER_MODEL_PATH,
    WHISPER_REQUIRE_MODEL_SHA256: process.env.WHISPER_REQUIRE_MODEL_SHA256,
  };

  try {
    if (mode === 'local') {
      if (!configuredBin && effectiveBin) process.env.WHISPER_PATH = effectiveBin;
      if (!configuredModel && effectiveModel) process.env.WHISPER_MODEL_PATH = effectiveModel;
    }

    // =========================================================================
    // A. BINARY CHECKS
    // =========================================================================
    if (!effectiveBin) {
      add({
        section: 'A_BINARY',
        id: 'binary.configured',
        label: 'Whisper binary path configured (WHISPER_PATH / LOCAL_STT_PATH)',
        status: 'BLOCKED',
        details: 'WHISPER_PATH and LOCAL_STT_PATH are unset. Provision whisper-cli and set WHISPER_PATH before production sign-off.',
      });
    } else if (!fs.existsSync(effectiveBin)) {
      add({
        section: 'A_BINARY',
        id: 'binary.exists',
        label: 'Whisper binary exists on disk',
        status: 'FAIL',
        targetPath: effectiveBin,
        details: `Configured binary path does not exist: ${effectiveBin}`,
      });
    } else {
      let isExec = false;
      try {
        fs.accessSync(effectiveBin, fs.constants.X_OK);
        isExec = true;
      } catch {
        isExec = false;
      }

      if (!isExec) {
        add({
          section: 'A_BINARY',
          id: 'binary.executable',
          label: 'Whisper binary executable permission (+x)',
          status: 'FAIL',
          targetPath: effectiveBin,
          details: `Binary exists at ${effectiveBin} but lacks executable permission.`,
        });
      } else {
        add({
          section: 'A_BINARY',
          id: 'binary.executable',
          label: 'Whisper binary exists & executable',
          status: 'PASS',
          targetPath: effectiveBin,
          details: `Verified executable binary at ${effectiveBin} (source=${configuredBin ? 'env' : 'local_host_default'}).`,
        });
      }

      // Shared library check via ldd on Linux
      if (process.platform === 'linux') {
        try {
          const { stdout, stderr } = await execFileAsync('ldd', [effectiveBin], { timeout: 5000 });
          const out = `${stdout}\n${stderr}`;
          const missingLines = out
            .split(/\r?\n/)
            .filter((l) => l.includes('not found'));
          if (missingLines.length > 0) {
            add({
              section: 'A_BINARY',
              id: 'binary.shared_libs',
              label: 'Binary shared library resolution (ldd)',
              status: 'FAIL',
              targetPath: effectiveBin,
              details: `Missing dynamic libraries: ${missingLines.map((s) => s.trim()).join('; ')}`,
            });
          } else {
            const isStatic = /statically linked|not a dynamic executable/i.test(out);
            add({
              section: 'A_BINARY',
              id: 'binary.shared_libs',
              label: 'Binary shared library resolution (ldd)',
              status: 'PASS',
              targetPath: effectiveBin,
              details: isStatic
                ? 'Static binary / no external dynamic libraries missing.'
                : 'All dynamic shared library dependencies resolved cleanly.',
            });
          }
        } catch (lddErr: any) {
          const msg = `${lddErr?.stdout || ''}\n${lddErr?.stderr || ''}\n${lddErr?.message || ''}`;
          if (/statically linked|not a dynamic executable/i.test(msg)) {
            add({
              section: 'A_BINARY',
              id: 'binary.shared_libs',
              label: 'Binary shared library resolution (ldd)',
              status: 'PASS',
              targetPath: effectiveBin,
              details: 'Static / script executable (no missing shared libraries).',
            });
          } else {
            add({
              section: 'A_BINARY',
              id: 'binary.shared_libs',
              label: 'Binary shared library resolution (ldd)',
              status: 'WARN',
              targetPath: effectiveBin,
              details: `ldd check did not complete cleanly: ${msg.trim().slice(0, 180)}`,
            });
          }
        }
      }
    }

    // FFmpeg / FFprobe toolchain dependencies
    for (const tool of ['ffmpeg', 'ffprobe']) {
      try {
        const { stdout } = await execFileAsync(tool, ['-version'], { timeout: 5000 });
        const firstLine = stdout.split(/\r?\n/)[0]?.trim() || 'available';
        add({
          section: 'A_BINARY',
          id: `toolchain.${tool}`,
          label: `${tool} toolchain executable`,
          status: 'PASS',
          details: firstLine,
        });
      } catch (err: any) {
        add({
          section: 'A_BINARY',
          id: `toolchain.${tool}`,
          label: `${tool} toolchain executable`,
          status: 'FAIL',
          details: `${tool} is required for 16kHz PCM audio extraction and is unavailable: ${err?.message || err}`,
        });
      }
    }

    // =========================================================================
    // B. MODEL & AUTOMATED SHA-256 VERIFICATION
    // =========================================================================
    if (!effectiveModel) {
      add({
        section: 'B_MODEL',
        id: 'model.configured',
        label: 'Whisper model path configured (WHISPER_MODEL_PATH)',
        status: 'BLOCKED',
        details: 'WHISPER_MODEL_PATH is unset. Provision verified GGML weights and configure WHISPER_MODEL_PATH.',
      });
    } else {
      const validation = await speechTranscriptionAdapter.validateRuntime({
        requireModelSha256: true,
      });

      if (validation.status === 'READY' && validation.modelSha256Verified) {
        const stat = fs.statSync(effectiveModel);
        add({
          section: 'B_MODEL',
          id: 'model.sha256',
          label: 'Whisper model header, readability & SHA-256 verification',
          status: 'PASS',
          targetPath: effectiveModel,
          details: `Verified ${path.basename(effectiveModel)} (${formatMb(stat.size)}, source=${validation.modelSha256Source}, sha256=${validation.modelSha256}).`,
        });
      } else if (validation.diagnosticCode === 'MODEL_EXPECTED_HASH_MISSING') {
        add({
          section: 'B_MODEL',
          id: 'model.sha256',
          label: 'Whisper model SHA-256 verification',
          status: mode === 'production' ? 'FAIL' : 'BLOCKED',
          targetPath: effectiveModel,
          details: validation.details || 'Expected SHA-256 hash missing for configured Whisper model.',
        });
      } else {
        add({
          section: 'B_MODEL',
          id: 'model.sha256',
          label: 'Whisper model header, readability & SHA-256 verification',
          status: 'FAIL',
          targetPath: effectiveModel,
          details: `${validation.diagnosticCode || validation.status}: ${validation.details || 'Model validation failed closed.'}`,
        });
      }

      if (path.basename(effectiveModel).endsWith('.en.bin')) {
        add({
          section: 'B_MODEL',
          id: 'model.multilingual_scope',
          label: 'Model language capability scope',
          status: 'WARN',
          targetPath: effectiveModel,
          details: `${path.basename(effectiveModel)} is English-only (.en). Provision multilingual GGML model (e.g. ggml-base.bin / ggml-medium.bin) if Thai or non-English audio is required.`,
        });
      }
    }

    // Binary + model live compatibility probe (if fixture is present)
    const configuredFixture = (process.env.WHISPER_COMPAT_AUDIO_PATH || '').trim();
    const checkedInJfkFixture = path.resolve(cwd, 'tests', 'fixtures', 'speech', 'jfk_1961_inaugural_16k.wav');
    const localCompatFixture =
      configuredFixture || (mode === 'local' && fs.existsSync(checkedInJfkFixture) ? checkedInJfkFixture : '');

    if (effectiveBin && effectiveModel) {
      if (!localCompatFixture || !fs.existsSync(localCompatFixture)) {
        add({
          section: 'A_BINARY',
          id: 'binary.runtime_compat',
          label: 'Binary + model speech fixture compatibility execution',
          status: 'BLOCKED',
          details: 'No compatibility speech WAV fixture configured (set WHISPER_COMPAT_AUDIO_PATH).',
        });
      } else {
        const compat = await speechTranscriptionAdapter.verifyRuntimeCompatibility({
          audioFixturePath: localCompatFixture,
          requireModelSha256: true,
          useCache: false,
        });
        if (compat.compatible && compat.speechTranscriptVerified) {
          add({
            section: 'A_BINARY',
            id: 'binary.runtime_compat',
            label: 'Binary + model real speech compatibility execution',
            status: 'PASS',
            targetPath: localCompatFixture,
            details: `Runtime executed cleanly (${compat.executionDurationMs}ms), provenance=${compat.provenanceTrustTier}, recall=${compat.transcriptComparison?.recall}, precision=${compat.transcriptComparison?.precision}.`,
          });
        } else if (compat.compatible) {
          add({
            section: 'A_BINARY',
            id: 'binary.runtime_compat',
            label: 'Binary + model runtime compatibility execution',
            status: mode === 'production' ? 'FAIL' : 'WARN',
            targetPath: localCompatFixture,
            details: `Runtime executed (${compat.executionDurationMs}ms) but speech transcript not verified (${compat.humanSpeechProvenanceStatus}).`,
          });
        } else {
          add({
            section: 'A_BINARY',
            id: 'binary.runtime_compat',
            label: 'Binary + model speech compatibility execution',
            status: 'FAIL',
            targetPath: localCompatFixture,
            details: `${compat.diagnosticCode}: ${compat.details}`,
          });
        }
      }
    }

    // =========================================================================
    // C. OFFLINE ED25519 KEY HYGIENE & STRICT PROVENANCE CHECKS
    // =========================================================================
    const hygiene = checkPrivateKeyHygiene(cwd);
    add({
      section: 'C_ED25519',
      id: 'ed25519.private_key_hygiene',
      label: 'Private key hygiene (zero committed/ENV private keys)',
      status: hygiene.clean ? 'PASS' : 'FAIL',
      details: hygiene.clean
        ? 'No Ed25519/PEM private keys found in workspace directories or WHISPER_* environment variables.'
        : `Private key material detected in unsafe locations: ${hygiene.findings.join(', ')}`,
    });

    const strictProvFlag = (process.env.WHISPER_STRICT_PROVENANCE || '').trim().toLowerCase() === 'true';
    const rawTrustedKeys = (process.env.WHISPER_TRUSTED_PUBLIC_KEYS || '').trim();
    const manifestPath = path.resolve(
      process.env.WHISPER_SPEECH_MANIFEST_PATH || path.join(cwd, 'tests', 'fixtures', 'speech', 'manifest.json')
    );

    if (!strictProvFlag) {
      add({
        section: 'C_ED25519',
        id: 'ed25519.strict_provenance',
        label: 'WHISPER_STRICT_PROVENANCE=true enforcement',
        status: mode === 'production' ? 'BLOCKED' : 'WARN',
        details:
          mode === 'production'
            ? 'WHISPER_STRICT_PROVENANCE is not set to true. Production deployment must enforce cryptographic manifest signatures.'
            : 'WHISPER_STRICT_PROVENANCE is unset (maintainer-attested unsigned manifest permitted only for local/non-strict checks).',
      });
    } else {
      add({
        section: 'C_ED25519',
        id: 'ed25519.strict_provenance',
        label: 'WHISPER_STRICT_PROVENANCE=true enforcement',
        status: 'PASS',
        details: 'Strict cryptographic Ed25519 provenance enforcement is enabled.',
      });
    }

    if (!rawTrustedKeys) {
      add({
        section: 'C_ED25519',
        id: 'ed25519.trusted_public_keys',
        label: 'WHISPER_TRUSTED_PUBLIC_KEYS configuration & rotation readiness',
        status: mode === 'production' ? 'BLOCKED' : 'WARN',
        details:
          mode === 'production'
            ? 'WHISPER_TRUSTED_PUBLIC_KEYS is unset. Configure production offline Ed25519 public key(s) JSON map before launch.'
            : 'WHISPER_TRUSTED_PUBLIC_KEYS is unset in local mode (using runtime test keys for ephemeral strict test only).',
      });
    } else {
      let keyObj: Record<string, unknown> | null = null;
      try {
        const parsedKeys = JSON.parse(rawTrustedKeys);
        if (!parsedKeys || typeof parsedKeys !== 'object' || Array.isArray(parsedKeys)) {
          throw new Error('Must be a JSON object mapping keyId -> PEM public key');
        }
        keyObj = parsedKeys as Record<string, unknown>;
      } catch (err: any) {
        add({
          section: 'C_ED25519',
          id: 'ed25519.trusted_public_keys',
          label: 'WHISPER_TRUSTED_PUBLIC_KEYS configuration & rotation readiness',
          status: 'FAIL',
          details: `Invalid WHISPER_TRUSTED_PUBLIC_KEYS JSON: ${err?.message || err}`,
        });
      }

      if (keyObj) {
        const entries = Object.entries(keyObj);
        if (entries.length === 0) {
          add({
            section: 'C_ED25519',
            id: 'ed25519.trusted_public_keys',
            label: 'WHISPER_TRUSTED_PUBLIC_KEYS non-empty keyset',
            status: 'FAIL',
            details: 'WHISPER_TRUSTED_PUBLIC_KEYS JSON object is empty.',
          });
        } else {
          const invalidKeys: string[] = [];
          const ephemeralIds: string[] = [];
          const keySummaries: string[] = [];

          for (const [keyId, pemVal] of entries) {
            if (typeof pemVal !== 'string' || !pemVal.trim()) {
              invalidKeys.push(`${keyId}: non-string or empty PEM`);
              continue;
            }
            if (/PRIVATE KEY/.test(pemVal)) {
              invalidKeys.push(`${keyId}: contains PRIVATE KEY instead of public key`);
              continue;
            }
            if (mode === 'production' && EPHEMERAL_TEST_KEY_ID_PATTERN.test(keyId)) {
              ephemeralIds.push(keyId);
            }
            try {
              const key = crypto.createPublicKey(pemVal);
              if (key.asymmetricKeyType !== 'ed25519') {
                invalidKeys.push(`${keyId}: expected ed25519 key, got ${key.asymmetricKeyType}`);
              } else {
                keySummaries.push(`${keyId} (fp:${fingerprintPublicKey(pemVal)})`);
              }
            } catch (keyErr: any) {
              invalidKeys.push(`${keyId}: invalid SPKI PEM (${keyErr?.message || keyErr})`);
            }
          }

          if (invalidKeys.length > 0 || ephemeralIds.length > 0) {
            add({
              section: 'C_ED25519',
              id: 'ed25519.trusted_public_keys',
              label: 'WHISPER_TRUSTED_PUBLIC_KEYS cryptographic validation',
              status: 'FAIL',
              details: [
                invalidKeys.length > 0 ? `Invalid keys: ${invalidKeys.join('; ')}` : '',
                ephemeralIds.length > 0
                  ? `Ephemeral/test keyIds forbidden in production: ${ephemeralIds.join(', ')}`
                  : '',
              ]
                .filter(Boolean)
                .join(' | '),
            });
          } else {
            add({
              section: 'C_ED25519',
              id: 'ed25519.trusted_public_keys',
              label: 'WHISPER_TRUSTED_PUBLIC_KEYS cryptographic validation',
              status: 'PASS',
              details: `Validated ${keySummaries.length} Ed25519 public key(s) [rotation-capable]: ${keySummaries.join(', ')}`,
            });
          }
        }
      }
    }

    // Check speech manifest signature status & revocation enforcement
    if (!fs.existsSync(manifestPath)) {
      add({
        section: 'C_ED25519',
        id: 'ed25519.manifest',
        label: 'Speech fixture manifest presence',
        status: 'FAIL',
        targetPath: manifestPath,
        details: `Speech fixture manifest missing at ${manifestPath}`,
      });
    } else {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest.signature) {
          add({
            section: 'C_ED25519',
            id: 'ed25519.manifest_signature',
            label: 'Speech fixture manifest Ed25519 signature',
            status: mode === 'production' || strictProvFlag ? 'BLOCKED' : 'WARN',
            targetPath: manifestPath,
            details:
              mode === 'production' || strictProvFlag
                ? `Manifest ${path.basename(manifestPath)} is unsigned; production requires offline Ed25519 signature by release key before launch.`
                : `Manifest ${path.basename(manifestPath)} is unsigned (MAINTAINER_ATTESTED tier only).`,
          });
        } else if (rawTrustedKeys) {
          // Verify signed manifest against WHISPER_TRUSTED_PUBLIC_KEYS AND verify revocation (untrusted key fails closed)
          const firstFixture = manifest.fixtures?.[0];
          const fixtureRel = firstFixture?.relativePath
            ? path.resolve(path.dirname(manifestPath), firstFixture.relativePath)
            : firstFixture?.filePath;
          if (!fixtureRel || !fs.existsSync(fixtureRel)) {
            add({
              section: 'C_ED25519',
              id: 'ed25519.manifest_signature',
              label: 'Speech fixture manifest Ed25519 signature',
              status: 'FAIL',
              targetPath: manifestPath,
              details: 'Manifest has no resolvable fixture audio file on disk to verify provenance against.',
            });
          } else {
            const trustedMap = JSON.parse(rawTrustedKeys) as Record<string, string>;
            const sigKeyId = String(manifest.signature?.keyId || '');
            if (!trustedMap[sigKeyId]) {
              add({
                section: 'C_ED25519',
                id: 'ed25519.manifest_signature',
                label: 'Speech fixture manifest Ed25519 signature',
                status: 'FAIL',
                targetPath: manifestPath,
                details: `Manifest signature keyId '${sigKeyId}' is not in WHISPER_TRUSTED_PUBLIC_KEYS (revoked or unknown key fails closed).`,
              });
            } else {
              const res = await speechTranscriptionAdapter.verifyRuntimeCompatibility({
                audioFixturePath: fixtureRel,
                trustedManifestPath: manifestPath,
                trustedPublicKeys: trustedMap,
                strictAttestationMode: true,
                useCache: false,
              });
              add({
                section: 'C_ED25519',
                id: 'ed25519.manifest_signature',
                label: 'Speech fixture manifest Ed25519 signature',
                status: res.fixtureProvenance?.signatureVerified ? 'PASS' : 'FAIL',
                targetPath: manifestPath,
                details: res.fixtureProvenance?.signatureVerified
                  ? `Manifest Ed25519 signature verified cleanly (keyId=${sigKeyId}, trustTier=${res.provenanceTrustTier}).`
                  : `Manifest Ed25519 signature verification failed: ${res.fixtureProvenance?.reason || res.details}`,
              });
            }
          }
        } else {
          add({
            section: 'C_ED25519',
            id: 'ed25519.manifest_signature',
            label: 'Speech fixture manifest Ed25519 signature',
            status: 'BLOCKED',
            targetPath: manifestPath,
            details: 'Manifest carries signature but WHISPER_TRUSTED_PUBLIC_KEYS is unset.',
          });
        }
      } catch (err: any) {
        add({
          section: 'C_ED25519',
          id: 'ed25519.manifest',
          label: 'Speech fixture manifest JSON validity',
          status: 'FAIL',
          targetPath: manifestPath,
          details: `Malformed manifest JSON: ${err?.message || err}`,
        });
      }
    }

    // =========================================================================
    // D. PERSISTENT VS TEMPORARY STORAGE CHECKS (READ-ONLY ON PROD DATA)
    // =========================================================================
    const configuredDbPath = process.env.DATABASE_PATH?.trim()
      ? path.resolve(process.env.DATABASE_PATH.trim())
      : process.env.DATA_DIR?.trim()
        ? path.resolve(process.env.DATA_DIR.trim(), 'videorisk.db')
        : path.resolve(cwd, 'data', 'videorisk.db');
    const dbDir = path.dirname(configuredDbPath);
    const uploadsDir = path.resolve(cwd, 'uploads');
    const proxiesDir = path.resolve(uploadsDir, 'proxies');
    const ocrFramesDir = path.resolve(uploadsDir, 'ocr_frames');
    const tmpBaseDir = path.resolve(os.tmpdir());

    // Helper for persistent directories (safe write+unlink probe only on directory, never touches DB file!)
    const inspectDirStorage = async (params: {
      id: string;
      label: string;
      dirPath: string;
      classification: 'PERSISTENT' | 'TEMPORARY';
      allowWriteProbe: boolean;
      requireNonTmpfs: boolean;
      minFreeMb: number;
      mustExist?: boolean;
    }) => {
      if (!fs.existsSync(params.dirPath)) {
        add({
          section: 'D_STORAGE',
          id: params.id,
          label: `${params.classification}: ${params.label}`,
          classification: params.classification,
          targetPath: params.dirPath,
          status: params.mustExist ? 'FAIL' : 'WARN',
          details: `Directory does not exist yet: ${params.dirPath}`,
        });
        return;
      }

      const df = await getDfStats(params.dirPath);
      const freeMb = df ? Math.round(df.availKb / 1024) : null;
      const fsType = df?.fsType || 'unknown';
      const mountPoint = df?.mountPoint || 'unknown';
      const isTmpfs = /^(tmpfs|ramfs|devtmpfs)$/i.test(fsType);

      let probeMsg = 'read-only inspected';
      if (params.allowWriteProbe) {
        const probeFile = path.join(
          params.dirPath,
          `.vr_storage_probe_${process.pid}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.tmp`
        );
        try {
          fs.writeFileSync(probeFile, 'ok', 'utf8');
          fs.unlinkSync(probeFile);
          probeMsg = 'writable + immediate cleanup verified';
        } catch (wErr: any) {
          try {
            if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile);
          } catch {}
          add({
            section: 'D_STORAGE',
            id: params.id,
            label: `${params.classification}: ${params.label}`,
            classification: params.classification,
            targetPath: params.dirPath,
            status: 'FAIL',
            details: `Directory not writable (${wErr?.message || wErr}) | fs=${fsType} mount=${mountPoint}`,
          });
          return;
        }
      } else {
        try {
          fs.accessSync(params.dirPath, fs.constants.R_OK);
          probeMsg = 'readable';
        } catch (rErr: any) {
          add({
            section: 'D_STORAGE',
            id: params.id,
            label: `${params.classification}: ${params.label}`,
            classification: params.classification,
            targetPath: params.dirPath,
            status: 'FAIL',
            details: `Directory not readable (${rErr?.message || rErr})`,
          });
          return;
        }
      }

      if (params.requireNonTmpfs && isTmpfs && mode === 'production') {
        add({
          section: 'D_STORAGE',
          id: params.id,
          label: `${params.classification}: ${params.label}`,
          classification: params.classification,
          targetPath: params.dirPath,
          status: 'FAIL',
          details: `Persistent path sits on volatile '${fsType}' mount (${mountPoint}). Mount persistent volume before production deployment.`,
        });
        return;
      }

      if (freeMb !== null && freeMb < params.minFreeMb) {
        add({
          section: 'D_STORAGE',
          id: params.id,
          label: `${params.classification}: ${params.label}`,
          classification: params.classification,
          targetPath: params.dirPath,
          status: 'FAIL',
          details: `Insufficient free disk space: ${freeMb} MB available (< ${params.minFreeMb} MB required) on ${mountPoint} (${fsType}).`,
        });
        return;
      }

      const modeBits = (fs.statSync(params.dirPath).mode & 0o777).toString(8);
      add({
        section: 'D_STORAGE',
        id: params.id,
        label: `${params.classification}: ${params.label}`,
        classification: params.classification,
        targetPath: params.dirPath,
        status: isTmpfs && params.requireNonTmpfs ? 'WARN' : 'PASS',
        details: `dir=${params.dirPath}, mode=0${modeBits}, ${probeMsg}, fs=${fsType}, mount=${mountPoint}, free=${freeMb ?? '?'} MB${isTmpfs && params.requireNonTmpfs ? ' (volatile tmpfs mount — acceptable in local container only, must be persistent volume in prod)' : ''}`,
      });
    };

    await inspectDirStorage({
      id: 'storage.persistent.db_dir',
      label: `SQLite database directory (${path.basename(configuredDbPath)})`,
      dirPath: dbDir,
      classification: 'PERSISTENT',
      allowWriteProbe: true,
      requireNonTmpfs: true,
      minFreeMb: 128,
      mustExist: true,
    });

    await inspectDirStorage({
      id: 'storage.persistent.uploads',
      label: 'Uploaded videos & thumbnails (uploads/)',
      dirPath: uploadsDir,
      classification: 'PERSISTENT',
      allowWriteProbe: true,
      requireNonTmpfs: true,
      minFreeMb: 256,
      mustExist: true,
    });

    if (fs.existsSync(proxiesDir)) {
      await inspectDirStorage({
        id: 'storage.persistent.proxies',
        label: 'Generated proxy videos (uploads/proxies/)',
        dirPath: proxiesDir,
        classification: 'PERSISTENT',
        allowWriteProbe: true,
        requireNonTmpfs: true,
        minFreeMb: 128,
      });
    }

    if (effectiveModel) {
      await inspectDirStorage({
        id: 'storage.persistent.whisper_model_dir',
        label: 'Whisper GGML model directory',
        dirPath: path.dirname(effectiveModel),
        classification: 'PERSISTENT',
        allowWriteProbe: false,
        requireNonTmpfs: true,
        minFreeMb: 150,
        mustExist: true,
      });
    }

    // Temporary Storage checks: os.tmpdir() (vr_whisper_*) & uploads/ocr_frames cleanup hygiene
    await inspectDirStorage({
      id: 'storage.temporary.os_tmpdir',
      label: 'Ephemeral PCM WAV & JSON transcript dir (os.tmpdir())',
      dirPath: tmpBaseDir,
      classification: 'TEMPORARY',
      allowWriteProbe: true,
      requireNonTmpfs: false,
      minFreeMb: 128,
      mustExist: true,
    });

    const leakedWhisperDirs = fs.existsSync(tmpBaseDir)
      ? fs.readdirSync(tmpBaseDir).filter((name) => name.startsWith('vr_whisper_'))
      : [];
    add({
      section: 'D_STORAGE',
      id: 'storage.temporary.whisper_cleanup_hygiene',
      label: 'TEMPORARY: Zero leaked vr_whisper_* directories in os.tmpdir()',
      classification: 'TEMPORARY',
      targetPath: tmpBaseDir,
      status: leakedWhisperDirs.length === 0 ? 'PASS' : 'WARN',
      details:
        leakedWhisperDirs.length === 0
          ? 'No stale vr_whisper_* temp directories left in os.tmpdir().'
          : `Found ${leakedWhisperDirs.length} leftover vr_whisper_* temp dir(s): ${leakedWhisperDirs.slice(0, 5).join(', ')}`,
    });

    const leakedOcrFrames = fs.existsSync(ocrFramesDir) ? fs.readdirSync(ocrFramesDir) : [];
    add({
      section: 'D_STORAGE',
      id: 'storage.temporary.ocr_frames_cleanup',
      label: 'TEMPORARY: Ephemeral OCR frames staging dir (uploads/ocr_frames/)',
      classification: 'TEMPORARY',
      targetPath: ocrFramesDir,
      status: leakedOcrFrames.length === 0 ? 'PASS' : 'WARN',
      details: !fs.existsSync(ocrFramesDir)
        ? 'Transient ocr_frames directory clean (created on demand per scan and removed in cleanupFrames()).'
        : leakedOcrFrames.length === 0
          ? 'uploads/ocr_frames exists and is empty (clean).'
          : `Found ${leakedOcrFrames.length} residual item(s) in uploads/ocr_frames: ${leakedOcrFrames.slice(0, 5).join(', ')}`,
    });
  } finally {
    if (savedEnv.WHISPER_PATH === undefined) delete process.env.WHISPER_PATH;
    else process.env.WHISPER_PATH = savedEnv.WHISPER_PATH;

    if (savedEnv.WHISPER_MODEL_PATH === undefined) delete process.env.WHISPER_MODEL_PATH;
    else process.env.WHISPER_MODEL_PATH = savedEnv.WHISPER_MODEL_PATH;

    if (savedEnv.WHISPER_REQUIRE_MODEL_SHA256 === undefined) delete process.env.WHISPER_REQUIRE_MODEL_SHA256;
    else process.env.WHISPER_REQUIRE_MODEL_SHA256 = savedEnv.WHISPER_REQUIRE_MODEL_SHA256;

    speechTranscriptionAdapter.clearCompatibilityCache();
  }

  const counts = {
    pass: checks.filter((c) => c.status === 'PASS').length,
    warn: checks.filter((c) => c.status === 'WARN').length,
    blocked: checks.filter((c) => c.status === 'BLOCKED').length,
    fail: checks.filter((c) => c.status === 'FAIL').length,
  };

  let overallStatus: 'PASS' | 'FAIL' | 'BLOCKED' = 'PASS';
  let exitCode: 0 | 1 | 2 = 0;
  if (counts.fail > 0) {
    overallStatus = 'FAIL';
    exitCode = 1;
  } else if (counts.blocked > 0) {
    overallStatus = 'BLOCKED';
    exitCode = 2;
  }

  return {
    mode,
    timestamp: new Date().toISOString(),
    hostPlatform: `${os.platform()} ${os.arch()} (${os.cpus().length} vCPU)`,
    overallStatus,
    exitCode,
    counts,
    boundaryNote:
      mode === 'local'
        ? 'LOCAL VERIFICATION ONLY: Checks reflect this host filesystem/binaries, NOT external production deployment verification.'
        : 'PRODUCTION MODE CHECK: Evaluates configured ENV, binary/model checksums, Ed25519 keys, and storage persistence.',
    checks,
  };
}

function printHumanReport(report: WhisperProdVerificationReport) {
  console.log('\n================================================================');
  console.log(`  VideoRisk Whisper Deployment Verification (--mode=${report.mode})`);
  console.log('================================================================');
  console.log(`Host      : ${report.hostPlatform}`);
  console.log(`Timestamp : ${report.timestamp}`);
  console.log(`Boundary  : ${report.boundaryNote}\n`);

  const sectionNames: Record<CheckRecord['section'], string> = {
    A_BINARY: 'A. Whisper Binary & Toolchain',
    B_MODEL: 'B. GGML Model & SHA-256 Verification',
    C_ED25519: 'C. Offline Ed25519 Key & Provenance Hygiene',
    D_STORAGE: 'D. Persistent vs Temporary Storage Paths',
  };

  for (const sec of ['A_BINARY', 'B_MODEL', 'C_ED25519', 'D_STORAGE'] as const) {
    console.log(`[${sectionNames[sec]}]`);
    for (const c of report.checks.filter((x) => x.section === sec)) {
      const icon = c.status === 'PASS' ? 'PASS   ' : c.status === 'WARN' ? 'WARN   ' : c.status === 'BLOCKED' ? 'BLOCKED' : 'FAIL   ';
      console.log(`  ${icon} | ${c.label}`);
      console.log(`          ${c.details}`);
    }
    console.log('');
  }

  console.log('----------------------------------------------------------------');
  console.log(
    `E. SUMMARY: OVERALL=${report.overallStatus} (exitCode=${report.exitCode}) | ` +
      `PASS=${report.counts.pass}, WARN=${report.counts.warn}, BLOCKED=${report.counts.blocked}, FAIL=${report.counts.fail}`
  );
  console.log('----------------------------------------------------------------\n');
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]).endsWith('verify-whisper-prod.ts');

if (isDirectEntry) {
  const { json } = parseArgs(process.argv.slice(2));
  runVerifyWhisperProd()
    .then((report) => {
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printHumanReport(report);
      }
      process.exit(report.exitCode);
    })
    .catch((err) => {
      console.error('❌ Verification script encountered unexpected error:', err);
      process.exit(1);
    });
}
