import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { 
  MediaMetadata, 
  DomainAssessmentStatus, 
  DetectorExecutionStatus,
  DetectorReport 
} from '../../types';
import { isProductionEnvironment } from '../config/environment';

const execFileAsync = promisify(execFile);

export class AudioProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioProcessingError';
  }
}

export interface AudioAnalysisResult {
  hasVoiceover: boolean;
  hasTimestampedVoiceover?: boolean;
  transcriptText?: string;
  voiceoverRatio: number; // 0 to 1
  silenceRatio: number;
  hasMusicDetected: boolean | null; // null when unassessed, unavailable, or insufficient evidence
  meanVolumeDb?: number;
  isAudible?: boolean;
  advertiserSpeechFlags: Array<{ word: string; timestamp: number; category: string }>;
  segments: Array<{ start: number; end: number; type: 'voice' | 'music' | 'silence' | 'mixed' }>;
  transcriptSummary: string;
  repeatedAudioSegments?: Array<{ 
    start: number; 
    end: number; 
    matchWithTimestamp: number; 
    similarity: number; 
  }>;
  speechAnalysisStatus?: DomainAssessmentStatus | DetectorExecutionStatus;
  musicAnalysisStatus?: DomainAssessmentStatus | DetectorExecutionStatus;
  speechDetectionStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  transcriptionStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  repeatedAudioStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  transcriptSegments?: Array<{
    start: number;
    end: number;
    text: string;
    confidence?: number;
  }>;
  detectors?: Record<string, DetectorReport>;
}

export type WhisperRuntimeExecutionStatus =
  | 'UNCONFIGURED'
  | 'UNVERIFIED'
  | 'RUNTIME_EXECUTION_VERIFIED'
  | 'FAILED';

export type WhisperRuntimeCompatibilityStatus =
  | 'UNCONFIGURED'
  | 'UNVERIFIED'
  | 'RUNTIME_COMPATIBLE'
  | 'FAILED';

export type WhisperSpeechTranscriptStatus =
  | 'SPEECH_TRANSCRIPT_UNVERIFIED'
  | 'SPEECH_TRANSCRIPT_VERIFIED'
  | 'SPEECH_TRANSCRIPT_FAILED';

export type HumanSpeechProvenanceStatus =
  | 'VERIFIED_HUMAN_SPEECH'
  | 'SYNTHETIC_FIXTURE'
  | 'UNTRUSTED_NO_MANIFEST_ENTRY'
  | 'UNTRUSTED_HASH_MISMATCH'
  | 'UNTRUSTED_PROVENANCE_UNVERIFIED'
  | 'INVALID_PROVENANCE';

export type ProvenanceTrustTier =
  | 'UNTRUSTED'
  | 'MAINTAINER_ATTESTED'
  | 'CRYPTOGRAPHICALLY_VERIFIED';

export type SpeechVerificationState =
  | 'RUNTIME_COMPATIBLE'
  | 'FIXTURE_INTEGRITY_VERIFIED'
  | 'MAINTAINER_ATTESTED'
  | 'CRYPTOGRAPHICALLY_VERIFIED'
  | 'TRANSCRIPT_VERIFIED'
  | 'NOT_VERIFIED'
  | 'INVALID_PROVENANCE';

export type TranscriptComparisonStatus =
  | 'NOT_COMPARED'
  | 'PASSED'
  | 'FAILED';

export interface TrustedSpeechManifestSignature {
  algorithm: 'ed25519';
  keyId: string;
  value: string;
  signedAt?: string;
}

export interface TrustedSpeechFixtureManifestEntry {
  fixtureId: string;
  relativePath?: string;
  filePath?: string;
  sha256: string;
  sourceDescription: string;
  recordingOrigin: string;
  humanSpeechVerificationStatus: 'VERIFIED_HUMAN_SPEECH' | 'UNVERIFIED' | 'SYNTHETIC';
  expectedTranscript: string;
  transcriptLanguage: string;
  transcriptReviewEvidence: string;
  verificationMetadata?: {
    verifiedBy?: string;
    verifiedAt?: string;
    verificationMethod?: string;
    hashAlgorithm?: string;
    [key: string]: unknown;
  };
}

export interface TrustedSpeechFixtureManifest {
  manifestVersion: string;
  description?: string;
  fixtures: TrustedSpeechFixtureManifestEntry[];
  signature?: TrustedSpeechManifestSignature;
}

export interface WhisperFixtureProvenanceReport {
  humanSpeechProvenanceStatus: HumanSpeechProvenanceStatus;
  provenanceTrustTier: ProvenanceTrustTier;
  verificationStates: SpeechVerificationState[];
  manifestPath?: string;
  fixtureId?: string;
  sha256?: string;
  sourceDescription?: string;
  recordingOrigin?: string;
  transcriptLanguage?: string;
  transcriptReviewEvidence?: string;
  verificationMethod?: string;
  hashAlgorithm?: string;
  signatureVerified?: boolean;
  signatureKeyId?: string;
  strictAttestationMode?: boolean;
  verifiedHumanSpeech: boolean;
  reason: string;
}

export interface WhisperTranscriptComparison {
  compared: boolean;
  expectedTranscriptPresent: boolean;
  passed?: boolean;
  expectedTokenCount: number;
  actualTokenCount: number;
  matchedTokenCount: number;
  recall?: number;
  precision?: number;
  score?: number;
  minRecallThreshold: number;
  minPrecisionThreshold: number;
  isSyntheticFixture?: boolean;
  reason?: string;
}

export interface LocalTranscriptionResult {
  status: DetectorExecutionStatus;
  transcriptText?: string;
  segments?: Array<{ start: number; end: number; text: string; confidence?: number }>;
  diagnosticCode?: WhisperDiagnosticCode;
  compatibilityVerified?: boolean; // Runtime compatibility ONLY (never implies speech transcript verification)
  runtimeCompatible?: boolean;
  runtimeCompatibilityStatus?: WhisperRuntimeCompatibilityStatus;
  runtimeExecutionStatus?: WhisperRuntimeExecutionStatus;
  transcriptComparisonStatus?: TranscriptComparisonStatus;
  humanSpeechProvenanceStatus?: HumanSpeechProvenanceStatus;
  provenanceTrustTier?: ProvenanceTrustTier;
  verificationStates?: SpeechVerificationState[];
  speechTranscriptStatus?: WhisperSpeechTranscriptStatus;
  speechTranscriptVerified?: boolean;
  failureReason?: string;
  limitations: string;
  executionDurationMs: number;
}

export type WhisperDiagnosticCode =
  | 'UNCONFIGURED'
  | 'BINARY_NOT_FOUND'
  | 'BINARY_NOT_EXECUTABLE'
  | 'IDENTITY_PROBE_FAILED'
  | 'IDENTITY_CONTRACT_MISMATCH'
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_NOT_READABLE'
  | 'MODEL_INCOMPATIBLE'
  | 'RUNTIME_INIT_FAILED'
  | 'SPEECH_FIXTURE_NOT_FOUND'
  | 'SPEECH_FIXTURE_INVALID'
  | 'TRANSCRIPTION_TIMEOUT'
  | 'TRANSCRIPTION_FAILED'
  | 'EMPTY_TRANSCRIPTION_OUTPUT'
  | 'VERIFICATION_PASSED'
  | 'READY';

export interface WhisperRuntimeValidation {
  isConfigured: boolean;
  executableFound: boolean;
  executablePath?: string;
  isExecutable: boolean;
  version?: string;
  modelConfigured: boolean;
  modelFound: boolean;
  modelPath?: string;
  runtimeType: 'openai_whisper' | 'whisper_cpp' | 'unconfigured';
  supportedLanguages: string[];
  status: 'READY' | 'MISSING_EXECUTABLE' | 'NON_EXECUTABLE' | 'MISSING_MODEL' | 'UNCONFIGURED' | 'ERROR';
  diagnosticCode?: WhisperDiagnosticCode;
  details?: string;
}

export interface WhisperCompatibilityResult {
  compatible: boolean; // Runtime compatibility ONLY
  runtimeCompatible: boolean;
  runtimeCompatibilityStatus: WhisperRuntimeCompatibilityStatus;
  compatibilityVerified: boolean; // Runtime compatibility ONLY (never replaces speechTranscriptVerified)
  diagnosticCode: WhisperDiagnosticCode;
  runtimeExecutionStatus: WhisperRuntimeExecutionStatus;
  transcriptComparisonStatus: TranscriptComparisonStatus;
  humanSpeechProvenanceStatus: HumanSpeechProvenanceStatus;
  provenanceTrustTier: ProvenanceTrustTier;
  verificationStates: SpeechVerificationState[];
  speechTranscriptStatus: WhisperSpeechTranscriptStatus;
  speechTranscriptVerified: boolean;
  runtimeType: 'openai_whisper' | 'whisper_cpp' | 'unconfigured';
  validation: WhisperRuntimeValidation;
  transcriptText?: string;
  segmentsCount?: number;
  audioFixturePath?: string;
  referenceTranscript?: string;
  referenceMatched?: boolean;
  transcriptComparison?: WhisperTranscriptComparison;
  fixtureProvenance?: WhisperFixtureProvenanceReport;
  isSyntheticFixture?: boolean;
  verifiedAt?: string;
  fromCache?: boolean;
  executionDurationMs: number;
  details: string;
}

const SUPPORTED_SPEECH_MANIFEST_VERSIONS = new Set<string>(['1.0.0', '1.1.0']);
const ISO_8601_UTC_OR_OFFSET_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const INVALID_VERIFICATION_METHODS = new Set<string>(['none', 'unknown', 'unverified', 'auto', 'mock', 'synthetic', 'skip', 'bypass']);

function canonicalizeJsonValue(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(canonicalizeJsonValue);
  }
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      const child = (val as Record<string, unknown>)[key];
      if (child !== undefined) {
        out[key] = canonicalizeJsonValue(child);
      }
    }
    return out;
  }
  return val;
}

/**
 * Produces a canonical deterministic UTF-8 JSON payload for a Speech Fixture Manifest,
 * stripping top-level `signature` and recursively sorting all object keys.
 */
export function canonicalizeSpeechManifestPayload(
  manifest: TrustedSpeechFixtureManifest | Omit<TrustedSpeechFixtureManifest, 'signature'>
): string {
  const payload: Record<string, unknown> = {
    manifestVersion: manifest.manifestVersion,
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    fixtures: Array.isArray(manifest.fixtures) ? manifest.fixtures : []
  };
  return JSON.stringify(canonicalizeJsonValue(payload));
}

const VALID_GGML_GGUF_MAGICS = new Set<string>([
  'GGUF', // GGUF container format
  'ggml', // Big-endian / ASCII GGML header
  'lmgg', // Little-endian 0x67676d6c ('ggml')
  'ggmf',
  'fmgg', // Little-endian 'ggmf'
  'ggjt',
  'tjgg'  // Little-endian 'ggjt' (whisper.cpp quantized models)
]);

const OPENAI_WHISPER_MODEL_NAMES = new Set<string>([
  'tiny', 'tiny.en',
  'base', 'base.en',
  'small', 'small.en',
  'medium', 'medium.en',
  'large', 'large-v1', 'large-v2', 'large-v3', 'turbo'
]);

/**
 * Determines whether Whisper runtime compatibility verification must be enforced
 * prior to transcription. Uses the canonical `isProductionEnvironment()` predicate
 * so live-payment configurations cannot bypass production compatibility checks
 * even when NODE_ENV=development.
 */
export function shouldEnforceWhisperCompatibility(
  options: {
    verifyCompatibility?: boolean;
    audioFixturePath?: string;
    modelConfigured: boolean;
  },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const hasSpeechFixtureEnv = Boolean(options.audioFixturePath || env.WHISPER_COMPAT_AUDIO_PATH);
  const compatEnvFlag = (env.WHISPER_VERIFY_COMPATIBILITY || '').trim().toLowerCase();
  const compatExplicitlyDisabled = options.verifyCompatibility === false || compatEnvFlag === 'false';
  const compatExplicitlyRequired = options.verifyCompatibility === true || compatEnvFlag === 'true';
  return (
    compatExplicitlyRequired ||
    (!compatExplicitlyDisabled && (
      isProductionEnvironment(env) ||
      (options.modelConfigured && hasSpeechFixtureEnv)
    ))
  );
}

/**
 * Adapter for optional local Speech-to-Text transcription.
 * Supports explicitly verified `whisper_cpp` and `openai_whisper` runtimes only.
 * Gracefully checks dependency availability (e.g. WHISPER_PATH or LOCAL_STT_PATH).
 * Never relies on executable basename heuristics, generic fallbacks, or unverified model files.
 */
export class SpeechTranscriptionAdapter {
  private compatibilityCache = new Map<string, WhisperCompatibilityResult>();

  public clearCompatibilityCache(): void {
    this.compatibilityCache.clear();
  }

  private getRuntimeFingerprint(
    validation: WhisperRuntimeValidation,
    fixturePath: string,
    fixtureSha256: string,
    expectedTranscript?: string,
    provenanceDigest?: string
  ): string {
    const safeStatKey = (p?: string): string => {
      if (!p) return 'none';
      try {
        const s = fs.statSync(p);
        return `${p}:${s.size}:${Math.trunc(s.mtimeMs)}`;
      } catch {
        return p;
      }
    };
    return [
      validation.runtimeType,
      safeStatKey(validation.executablePath),
      safeStatKey(validation.modelPath),
      safeStatKey(fixturePath),
      `sha:${fixtureSha256}`,
      expectedTranscript !== undefined ? `exp:${expectedTranscript}` : 'exp:unset',
      `prov:${provenanceDigest || 'none'}`
    ].join('|');
  }

  private computeFileSha256(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  private normalizeTranscriptTokens(txt: string): string[] {
    return txt
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  private parseTrustedPublicKeys(
    overrideKeys?: Record<string, string>
  ): { keys: Record<string, string>; error?: string } {
    const merged: Record<string, string> = {};
    const rawEnv = (process.env.WHISPER_TRUSTED_PUBLIC_KEYS || '').trim();
    if (rawEnv.length > 0) {
      try {
        const parsed = JSON.parse(rawEnv);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { keys: {}, error: 'WHISPER_TRUSTED_PUBLIC_KEYS must be a JSON object mapping keyId to PEM public key.' };
        }
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof k === 'string' && k.trim().length > 0 && typeof v === 'string' && v.trim().length > 0) {
            merged[k.trim()] = v.trim();
          } else {
            return { keys: {}, error: `WHISPER_TRUSTED_PUBLIC_KEYS contains invalid entry for keyId '${k}'.` };
          }
        }
      } catch (err: any) {
        return { keys: {}, error: `Malformed JSON in WHISPER_TRUSTED_PUBLIC_KEYS: ${err?.message || err}` };
      }
    }

    if (overrideKeys) {
      for (const [k, v] of Object.entries(overrideKeys)) {
        if (typeof k === 'string' && k.trim().length > 0 && typeof v === 'string' && v.trim().length > 0) {
          merged[k.trim()] = v.trim();
        }
      }
    }
    return { keys: merged };
  }

  private isValidIso8601Timestamp(val: unknown): boolean {
    if (typeof val !== 'string') return false;
    const trimmed = val.trim();
    if (!ISO_8601_UTC_OR_OFFSET_REGEX.test(trimmed)) return false;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) && !Number.isNaN(ms);
  }

  private validateFixtureProvenance(
    canonicalFixturePath: string,
    fixtureSha256: string,
    options?: {
      isSyntheticFixture?: boolean;
      trustedManifestPath?: string;
      trustedManifest?: TrustedSpeechFixtureManifest;
      trustedPublicKeys?: Record<string, string>;
      strictAttestationMode?: boolean;
    }
  ): { report: WhisperFixtureProvenanceReport; manifestEntry?: TrustedSpeechFixtureManifestEntry; manifestDigest: string } {
    const defaultManifestPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'speech', 'manifest.json');
    const resolvedManifestPath = path.resolve(
      options?.trustedManifestPath || process.env.WHISPER_SPEECH_MANIFEST_PATH || defaultManifestPath
    );
    const manifestLabel = options?.trustedManifest ? 'inline-manifest' : resolvedManifestPath;
    const manifestDir = path.dirname(resolvedManifestPath);
    let realManifestDir = manifestDir;
    try {
      realManifestDir = fs.existsSync(manifestDir) ? fs.realpathSync(manifestDir) : path.resolve(manifestDir);
    } catch {
      realManifestDir = path.resolve(manifestDir);
    }

    const strictMode = Boolean(
      options?.strictAttestationMode ||
      (process.env.WHISPER_STRICT_PROVENANCE || '').trim().toLowerCase() === 'true'
    );

    const invalidProvenanceResult = (
      reason: string,
      opts?: {
        manifestDigest?: string;
        entry?: TrustedSpeechFixtureManifestEntry;
        signatureVerified?: boolean;
        signatureKeyId?: string;
      }
    ) => ({
      manifestEntry: opts?.entry,
      manifestDigest: opts?.manifestDigest || 'invalid-provenance',
      report: {
        humanSpeechProvenanceStatus: 'INVALID_PROVENANCE' as HumanSpeechProvenanceStatus,
        provenanceTrustTier: 'UNTRUSTED' as ProvenanceTrustTier,
        verificationStates: ['INVALID_PROVENANCE', 'NOT_VERIFIED'] as SpeechVerificationState[],
        manifestPath: manifestLabel,
        ...(opts?.entry?.fixtureId ? { fixtureId: opts.entry.fixtureId } : {}),
        sha256: fixtureSha256,
        sourceDescription: opts?.entry?.sourceDescription,
        recordingOrigin: opts?.entry?.recordingOrigin,
        transcriptLanguage: opts?.entry?.transcriptLanguage,
        transcriptReviewEvidence: opts?.entry?.transcriptReviewEvidence,
        ...(opts?.signatureVerified !== undefined ? { signatureVerified: opts.signatureVerified } : {}),
        ...(opts?.signatureKeyId ? { signatureKeyId: opts.signatureKeyId } : {}),
        strictAttestationMode: strictMode,
        verifiedHumanSpeech: false,
        reason
      }
    });

    const explicitSynthetic = Boolean(
      options?.isSyntheticFixture ||
      (process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE || '').trim().toLowerCase() === 'true'
    );

    let manifest: TrustedSpeechFixtureManifest | null = null;
    let manifestDigest = 'missing-manifest';

    if (options?.trustedManifest !== undefined) {
      if (!options.trustedManifest || typeof options.trustedManifest !== 'object' || Array.isArray(options.trustedManifest)) {
        return invalidProvenanceResult('Inline speech fixture manifest must be a valid JSON object.', { manifestDigest: 'invalid-manifest' });
      }
      manifest = options.trustedManifest;
      manifestDigest = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    } else if (fs.existsSync(resolvedManifestPath)) {
      let raw = '';
      try {
        raw = fs.readFileSync(resolvedManifestPath, 'utf-8');
        manifestDigest = crypto.createHash('sha256').update(raw).digest('hex');
      } catch (readErr: any) {
        return invalidProvenanceResult(
          `Unable to read speech fixture manifest at ${resolvedManifestPath}: ${readErr?.message || readErr}`,
          { manifestDigest: 'unreadable-manifest' }
        );
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return invalidProvenanceResult('Speech fixture manifest JSON must be a top-level object.', { manifestDigest: 'invalid-schema' });
        }
        manifest = parsed as TrustedSpeechFixtureManifest;
      } catch (parseErr: any) {
        return invalidProvenanceResult(
          `Malformed JSON in speech fixture manifest (${resolvedManifestPath}): ${parseErr?.message || parseErr}`,
          { manifestDigest: 'invalid-json' }
        );
      }
    }

    if (manifest) {
      const versionStr = typeof manifest.manifestVersion === 'string' ? manifest.manifestVersion.trim() : '';
      if (!SUPPORTED_SPEECH_MANIFEST_VERSIONS.has(versionStr)) {
        return invalidProvenanceResult(
          `Unsupported speech fixture manifestVersion '${String(manifest.manifestVersion)}'. Allowed versions: ${[...SUPPORTED_SPEECH_MANIFEST_VERSIONS].join(', ')}.`,
          { manifestDigest }
        );
      }
      if (!Array.isArray(manifest.fixtures)) {
        return invalidProvenanceResult(
          'Invalid speech fixture manifest schema: fixtures must be an array.',
          { manifestDigest }
        );
      }
    }

    // Parse trusted Ed25519 public keys map
    const parsedKeys = this.parseTrustedPublicKeys(options?.trustedPublicKeys);
    if (parsedKeys.error && (manifest?.signature !== undefined || strictMode)) {
      return invalidProvenanceResult(parsedKeys.error, { manifestDigest });
    }

    // Cryptographic signature verification (Option B)
    let signatureVerified = false;
    let signatureKeyId: string | undefined;

    if (manifest?.signature !== undefined) {
      const sig = manifest.signature;
      if (!sig || typeof sig !== 'object' || Array.isArray(sig)) {
        return invalidProvenanceResult('Malformed manifest signature object.', { manifestDigest, signatureVerified: false });
      }
      if (sig.algorithm !== 'ed25519') {
        return invalidProvenanceResult(
          `Unsupported manifest signature algorithm '${String((sig as any).algorithm)}'; only 'ed25519' is allowed.`,
          { manifestDigest, signatureVerified: false }
        );
      }
      const keyId = typeof sig.keyId === 'string' ? sig.keyId.trim() : '';
      const sigValue = typeof sig.value === 'string' ? sig.value.trim() : '';
      if (!keyId || !sigValue) {
        return invalidProvenanceResult(
          'Manifest signature must specify non-empty keyId and base64 signature value.',
          { manifestDigest, signatureVerified: false }
        );
      }
      if (sig.signedAt !== undefined && !this.isValidIso8601Timestamp(sig.signedAt)) {
        return invalidProvenanceResult(
          `Manifest signature signedAt '${String(sig.signedAt)}' is not a valid strict ISO-8601 timestamp.`,
          { manifestDigest, signatureVerified: false, signatureKeyId: keyId }
        );
      }

      const publicKeyPem = parsedKeys.keys[keyId];
      if (!publicKeyPem) {
        return invalidProvenanceResult(
          `Manifest signed with unknown or untrusted keyId '${keyId}'.`,
          { manifestDigest, signatureVerified: false, signatureKeyId: keyId }
        );
      }

      try {
        const canonicalPayload = Buffer.from(canonicalizeSpeechManifestPayload(manifest), 'utf8');
        const sigBuf = Buffer.from(sigValue, 'base64');
        const ok = sigBuf.length === 64 && crypto.verify(null, canonicalPayload, publicKeyPem, sigBuf);
        if (!ok) {
          return invalidProvenanceResult(
            `Ed25519 signature verification failed for manifest keyId '${keyId}'.`,
            { manifestDigest, signatureVerified: false, signatureKeyId: keyId }
          );
        }
        signatureVerified = true;
        signatureKeyId = keyId;
      } catch (cryptoErr: any) {
        return invalidProvenanceResult(
          `Ed25519 signature verification error for keyId '${keyId}': ${cryptoErr?.message || cryptoErr}`,
          { manifestDigest, signatureVerified: false, signatureKeyId: keyId }
        );
      }
    }

    // Validate ALL manifest entries for structural conflicts (duplicates, path traversal) BEFORE selecting a match
    let matchedEntry: TrustedSpeechFixtureManifestEntry | undefined;

    if (manifest) {
      const seenFixtureIds = new Set<string>();
      const seenCanonicalPaths = new Set<string>();

      for (let i = 0; i < manifest.fixtures.length; i++) {
        const entry = manifest.fixtures[i];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return invalidProvenanceResult(`Invalid manifest entry object at index ${i}.`, {
            manifestDigest,
            signatureVerified,
            signatureKeyId
          });
        }

        const fid = typeof entry.fixtureId === 'string' ? entry.fixtureId.trim() : '';
        if (fid.length > 0) {
          if (seenFixtureIds.has(fid)) {
            return invalidProvenanceResult(
              `Duplicate fixtureId '${fid}' detected in speech fixture manifest.`,
              { manifestDigest, entry, signatureVerified, signatureKeyId }
            );
          }
          seenFixtureIds.add(fid);
        }

        // Reject relativePath traversal escaping manifestDir
        if (typeof entry.relativePath === 'string' && entry.relativePath.trim().length > 0) {
          const rawRel = entry.relativePath.trim();
          if (path.isAbsolute(rawRel)) {
            return invalidProvenanceResult(
              `Manifest entry '${fid || i}' relativePath '${rawRel}' must not be an absolute path.`,
              { manifestDigest, entry, signatureVerified, signatureKeyId }
            );
          }
          const resolvedCandidate = path.resolve(manifestDir, rawRel);
          const relFromDir = path.relative(manifestDir, resolvedCandidate);
          if (relFromDir.startsWith('..') || path.isAbsolute(relFromDir)) {
            return invalidProvenanceResult(
              `Manifest entry '${fid || i}' relativePath '${rawRel}' escapes manifest directory.`,
              { manifestDigest, entry, signatureVerified, signatureKeyId }
            );
          }
          if (fs.existsSync(resolvedCandidate)) {
            try {
              const realCandidate = fs.realpathSync(resolvedCandidate);
              const realRel = path.relative(realManifestDir, realCandidate);
              if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
                return invalidProvenanceResult(
                  `Manifest entry '${fid || i}' relativePath '${rawRel}' symlink escapes manifest directory.`,
                  { manifestDigest, entry, signatureVerified, signatureKeyId }
                );
              }
            } catch {
              return invalidProvenanceResult(
                `Failed resolving realpath for manifest entry '${fid || i}'.`,
                { manifestDigest, entry, signatureVerified, signatureKeyId }
              );
            }
          }
        }

        const rawPath = entry.filePath || (entry.relativePath ? path.resolve(manifestDir, entry.relativePath) : '');
        let resolvedEntry: string | null = null;
        if (rawPath) {
          try {
            resolvedEntry = fs.existsSync(rawPath) ? fs.realpathSync(rawPath) : path.resolve(rawPath);
          } catch {
            resolvedEntry = path.resolve(rawPath);
          }
        }

        if (resolvedEntry) {
          if (seenCanonicalPaths.has(resolvedEntry)) {
            return invalidProvenanceResult(
              `Duplicate canonical fixture path '${resolvedEntry}' detected in speech fixture manifest (conflicting entries rejected).`,
              { manifestDigest, entry, signatureVerified, signatureKeyId }
            );
          }
          seenCanonicalPaths.add(resolvedEntry);
          if (resolvedEntry === canonicalFixturePath) {
            matchedEntry = entry;
          }
        }
      }
    }

    const isEntryMarkedSynthetic = Boolean(
      matchedEntry && (
        matchedEntry.humanSpeechVerificationStatus === 'SYNTHETIC' ||
        /\b(synthetic|mock|tts|generated|tone)\b/i.test(matchedEntry.recordingOrigin || '') ||
        /\b(synthetic|mock)\b/i.test(matchedEntry.sourceDescription || '')
      )
    );

    if (explicitSynthetic || isEntryMarkedSynthetic) {
      return {
        manifestEntry: matchedEntry,
        manifestDigest,
        report: {
          humanSpeechProvenanceStatus: 'SYNTHETIC_FIXTURE',
          provenanceTrustTier: 'UNTRUSTED',
          verificationStates: ['NOT_VERIFIED'],
          manifestPath: manifestLabel,
          ...(matchedEntry?.fixtureId ? { fixtureId: matchedEntry.fixtureId } : {}),
          sha256: fixtureSha256,
          sourceDescription: matchedEntry?.sourceDescription,
          recordingOrigin: matchedEntry?.recordingOrigin,
          signatureVerified,
          ...(signatureKeyId ? { signatureKeyId } : {}),
          strictAttestationMode: strictMode,
          verifiedHumanSpeech: false,
          reason: 'Audio fixture is flagged or recorded as synthetic/mock audio and cannot grant SPEECH_TRANSCRIPT_VERIFIED.'
        }
      };
    }

    if (!matchedEntry) {
      if (strictMode && manifest && !signatureVerified) {
        return invalidProvenanceResult(
          'Strict provenance mode requires a cryptographically signed manifest; unsigned manifest rejected.',
          { manifestDigest, signatureVerified: false }
        );
      }
      return {
        manifestDigest,
        report: {
          humanSpeechProvenanceStatus: 'UNTRUSTED_NO_MANIFEST_ENTRY',
          provenanceTrustTier: 'UNTRUSTED',
          verificationStates: ['NOT_VERIFIED'],
          manifestPath: manifestLabel,
          sha256: fixtureSha256,
          signatureVerified,
          ...(signatureKeyId ? { signatureKeyId } : {}),
          strictAttestationMode: strictMode,
          verifiedHumanSpeech: false,
          reason: 'Audio fixture has no registered entry in the trusted human speech fixture manifest.'
        }
      };
    }

    // Strict provenance mode rejects unsigned manifests even if all entry fields look valid
    if (strictMode && !signatureVerified) {
      return invalidProvenanceResult(
        'Strict provenance mode (WHISPER_STRICT_PROVENANCE=true) rejects unsigned manifest entries; cryptographic Ed25519 signature required.',
        { manifestDigest, entry: matchedEntry, signatureVerified: false }
      );
    }

    const expectedSha = String(matchedEntry.sha256 || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedSha) || expectedSha !== fixtureSha256.toLowerCase()) {
      return {
        manifestEntry: matchedEntry,
        manifestDigest,
        report: {
          humanSpeechProvenanceStatus: 'UNTRUSTED_HASH_MISMATCH',
          provenanceTrustTier: 'UNTRUSTED',
          verificationStates: ['NOT_VERIFIED'],
          manifestPath: manifestLabel,
          fixtureId: matchedEntry.fixtureId,
          sha256: fixtureSha256,
          sourceDescription: matchedEntry.sourceDescription,
          recordingOrigin: matchedEntry.recordingOrigin,
          signatureVerified,
          ...(signatureKeyId ? { signatureKeyId } : {}),
          strictAttestationMode: strictMode,
          verifiedHumanSpeech: false,
          reason: `SHA-256 mismatch against trusted manifest entry '${matchedEntry.fixtureId || canonicalFixturePath}'.`
        }
      };
    }

    // Validate hashAlgorithm and verificationMethod explicitly when present or in strict mode
    const rawHashAlg = matchedEntry.verificationMetadata?.hashAlgorithm;
    const normalizedHashAlg = typeof rawHashAlg === 'string' ? rawHashAlg.trim().toLowerCase() : undefined;
    if (rawHashAlg !== undefined && normalizedHashAlg !== 'sha256') {
      return invalidProvenanceResult(
        `Invalid hashAlgorithm '${String(rawHashAlg)}' in manifest entry '${matchedEntry.fixtureId}'; expected 'sha256'.`,
        { manifestDigest, entry: matchedEntry, signatureVerified, signatureKeyId }
      );
    }
    if (strictMode && normalizedHashAlg !== 'sha256') {
      return invalidProvenanceResult(
        `Strict provenance mode requires verificationMetadata.hashAlgorithm='sha256' on entry '${matchedEntry.fixtureId}'.`,
        { manifestDigest, entry: matchedEntry, signatureVerified, signatureKeyId }
      );
    }

    const rawVerMethod = matchedEntry.verificationMetadata?.verificationMethod;
    const trimmedVerMethod = typeof rawVerMethod === 'string' ? rawVerMethod.trim() : undefined;
    if (rawVerMethod !== undefined) {
      if (!trimmedVerMethod || INVALID_VERIFICATION_METHODS.has(trimmedVerMethod.toLowerCase())) {
        return invalidProvenanceResult(
          `Invalid verificationMethod '${String(rawVerMethod)}' in manifest entry '${matchedEntry.fixtureId}'.`,
          { manifestDigest, entry: matchedEntry, signatureVerified, signatureKeyId }
        );
      }
    }
    if (strictMode && !trimmedVerMethod) {
      return invalidProvenanceResult(
        `Strict provenance mode requires non-empty verificationMetadata.verificationMethod on entry '${matchedEntry.fixtureId}'.`,
        { manifestDigest, entry: matchedEntry, signatureVerified, signatureKeyId }
      );
    }

    // Strict ISO-8601 check on verifiedAt when provided
    const rawVerifiedAt = matchedEntry.verificationMetadata?.verifiedAt;
    if (rawVerifiedAt !== undefined && String(rawVerifiedAt).trim().length > 0 && !this.isValidIso8601Timestamp(rawVerifiedAt)) {
      return invalidProvenanceResult(
        `Invalid verificationMetadata.verifiedAt '${String(rawVerifiedAt)}' in manifest entry '${matchedEntry.fixtureId}'; strict ISO-8601 timestamp with timezone required.`,
        { manifestDigest, entry: matchedEntry, signatureVerified, signatureKeyId }
      );
    }

    const hasValidProvenanceFields = Boolean(
      typeof matchedEntry.fixtureId === 'string' && matchedEntry.fixtureId.trim().length > 0 &&
      typeof matchedEntry.sourceDescription === 'string' && matchedEntry.sourceDescription.trim().length > 0 &&
      typeof matchedEntry.recordingOrigin === 'string' && matchedEntry.recordingOrigin.trim().length > 0 &&
      matchedEntry.humanSpeechVerificationStatus === 'VERIFIED_HUMAN_SPEECH' &&
      typeof matchedEntry.expectedTranscript === 'string' && this.normalizeTranscriptTokens(matchedEntry.expectedTranscript).length > 0 &&
      typeof matchedEntry.transcriptLanguage === 'string' && matchedEntry.transcriptLanguage.trim().length > 0 &&
      typeof matchedEntry.transcriptReviewEvidence === 'string' && matchedEntry.transcriptReviewEvidence.trim().length > 0 &&
      typeof matchedEntry.verificationMetadata?.verifiedBy === 'string' && matchedEntry.verificationMetadata.verifiedBy.trim().length > 0 &&
      this.isValidIso8601Timestamp(rawVerifiedAt)
    );

    if (!hasValidProvenanceFields) {
      return {
        manifestEntry: matchedEntry,
        manifestDigest,
        report: {
          humanSpeechProvenanceStatus: 'UNTRUSTED_PROVENANCE_UNVERIFIED',
          provenanceTrustTier: 'UNTRUSTED',
          verificationStates: ['FIXTURE_INTEGRITY_VERIFIED', 'NOT_VERIFIED'],
          manifestPath: manifestLabel,
          fixtureId: matchedEntry.fixtureId,
          sha256: fixtureSha256,
          sourceDescription: matchedEntry.sourceDescription,
          recordingOrigin: matchedEntry.recordingOrigin,
          transcriptLanguage: matchedEntry.transcriptLanguage,
          transcriptReviewEvidence: matchedEntry.transcriptReviewEvidence,
          verificationMethod: trimmedVerMethod,
          hashAlgorithm: normalizedHashAlg || 'sha256',
          signatureVerified,
          ...(signatureKeyId ? { signatureKeyId } : {}),
          strictAttestationMode: strictMode,
          verifiedHumanSpeech: false,
          reason: 'Manifest entry lacks complete VERIFIED_HUMAN_SPEECH provenance, transcript review evidence, or verification metadata.'
        }
      };
    }

    const trustTier: ProvenanceTrustTier = signatureVerified
      ? 'CRYPTOGRAPHICALLY_VERIFIED'
      : 'MAINTAINER_ATTESTED';

    return {
      manifestEntry: matchedEntry,
      manifestDigest,
      report: {
        humanSpeechProvenanceStatus: 'VERIFIED_HUMAN_SPEECH',
        provenanceTrustTier: trustTier,
        verificationStates: ['FIXTURE_INTEGRITY_VERIFIED', trustTier],
        manifestPath: manifestLabel,
        fixtureId: matchedEntry.fixtureId,
        sha256: fixtureSha256,
        sourceDescription: matchedEntry.sourceDescription,
        recordingOrigin: matchedEntry.recordingOrigin,
        transcriptLanguage: matchedEntry.transcriptLanguage,
        transcriptReviewEvidence: matchedEntry.transcriptReviewEvidence,
        verificationMethod: trimmedVerMethod,
        hashAlgorithm: normalizedHashAlg || 'sha256',
        signatureVerified,
        ...(signatureKeyId ? { signatureKeyId } : {}),
        strictAttestationMode: strictMode,
        verifiedHumanSpeech: true,
        reason: signatureVerified
          ? `Fixture SHA-256 and Ed25519 manifest signature (keyId=${signatureKeyId}) cryptographically verified.`
          : 'Fixture SHA-256 and maintainer attestation metadata verified against unsigned manifest (MAINTAINER_ATTESTED).'
      }
    };
  }

  /**
   * Validates that an external audio fixture is a readable 16kHz mono 16-bit PCM WAV containing non-silent audio.
   */
  private validateSpeechWavFixture(fixturePath: string): { valid: boolean; reason?: string; durationSeconds?: number; rms?: number } {
    let buf: Buffer;
    try {
      const stat = fs.statSync(fixturePath);
      if (!stat.isFile()) {
        return { valid: false, reason: `Speech fixture path is not a regular file: ${fixturePath}` };
      }
      if (stat.size < 44) {
        return { valid: false, reason: `Speech fixture WAV is truncated (${stat.size} bytes)` };
      }
      buf = fs.readFileSync(fixturePath);
    } catch (err: any) {
      return { valid: false, reason: `Unable to read speech fixture at ${fixturePath}: ${err?.message || err}` };
    }

    if (buf.subarray(0, 4).toString('ascii') !== 'RIFF' || buf.subarray(8, 12).toString('ascii') !== 'WAVE') {
      return { valid: false, reason: 'Speech fixture is not a valid RIFF/WAVE container.' };
    }

    let offset = 12;
    let audioFormat: number | null = null;
    let numChannels: number | null = null;
    let sampleRate: number | null = null;
    let bitsPerSample: number | null = null;
    let dataOffset = -1;
    let dataSize = 0;

    while (offset + 8 <= buf.length) {
      const chunkId = buf.subarray(offset, offset + 4).toString('ascii');
      const chunkSize = buf.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;

      if (chunkId === 'fmt ' && chunkSize >= 16 && chunkStart + 16 <= buf.length) {
        audioFormat = buf.readUInt16LE(chunkStart);
        numChannels = buf.readUInt16LE(chunkStart + 2);
        sampleRate = buf.readUInt32LE(chunkStart + 4);
        bitsPerSample = buf.readUInt16LE(chunkStart + 14);
      } else if (chunkId === 'data') {
        dataOffset = chunkStart;
        dataSize = Math.min(chunkSize, Math.max(0, buf.length - chunkStart));
      }

      offset = chunkStart + chunkSize + (chunkSize % 2);
    }

    if (audioFormat !== 1 || numChannels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16) {
      return {
        valid: false,
        reason: `Speech fixture must be 16kHz mono 16-bit PCM WAV (got format=${audioFormat}, channels=${numChannels}, rate=${sampleRate}, bits=${bitsPerSample}).`
      };
    }

    if (dataOffset < 0 || dataSize < 3200) {
      return {
        valid: false,
        reason: 'Speech fixture WAV contains insufficient PCM audio samples (minimum 0.1s required).'
      };
    }

    const totalSamples = Math.floor(dataSize / 2);
    let sumSq = 0;
    for (let i = 0; i < totalSamples; i++) {
      const sample = buf.readInt16LE(dataOffset + i * 2) / 32768;
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / totalSamples);
    if (rms < 0.0005) {
      return {
        valid: false,
        reason: 'Speech fixture WAV is near-silent and cannot verify real speech transcription.'
      };
    }

    return {
      valid: true,
      durationSeconds: parseFloat((totalSamples / 16000).toFixed(3)),
      rms: parseFloat(rms.toFixed(4))
    };
  }

  private classifyWhisperProcessError(
    execErr: any,
    timeoutMs: number
  ): { diagnosticCode: WhisperDiagnosticCode; details: string } {
    const combinedErr = `${execErr?.stderr || ''}\n${execErr?.message || ''}`.trim();
    const isTimeout = Boolean(
      execErr?.killed === true ||
      execErr?.signal === 'SIGTERM' ||
      execErr?.code === 'ETIMEDOUT' ||
      /timed?\s*out/i.test(combinedErr)
    );
    if (isTimeout) {
      return {
        diagnosticCode: 'TRANSCRIPTION_TIMEOUT',
        details: `Whisper execution timed out after ${timeoutMs}ms.`
      };
    }

    if (execErr?.code === 'ENOENT') {
      return {
        diagnosticCode: 'BINARY_NOT_FOUND',
        details: 'Whisper executable became unavailable during execution (ENOENT).'
      };
    }

    if (execErr?.code === 'EACCES' || execErr?.code === 'EPERM' || execErr?.code === 'EISDIR') {
      return {
        diagnosticCode: 'BINARY_NOT_EXECUTABLE',
        details: `Whisper executable failed permission check (${execErr.code}).`
      };
    }

    if (/invalid\s+model|failed\s+to\s+(init|initialize|load).*model|unknown\s+model|incompatible\s+model|corrupt(ed)?\s+model|ggml.*magic|unexpected\s+eof.*model/i.test(combinedErr)) {
      return {
        diagnosticCode: 'MODEL_INCOMPATIBLE',
        details: combinedErr.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ').slice(0, 220) || 'Whisper model initialization failed: incompatible or corrupt model.'
      };
    }

    if (/dlopen|error while loading shared libraries|cannot open shared object|segmentation fault|sigsegv|illegal instruction|cuda.*error|metal.*error|vulkan.*error|failed\s+to\s+(init|initialize)\s+whisper/i.test(combinedErr)) {
      return {
        diagnosticCode: 'RUNTIME_INIT_FAILED',
        details: combinedErr.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ').slice(0, 220) || 'Whisper native runtime failed initialization.'
      };
    }

    return {
      diagnosticCode: 'TRANSCRIPTION_FAILED',
      details: combinedErr.split(/\r?\n/).filter(Boolean).slice(-2).join(' | ').slice(0, 220) || 'Whisper transcription execution failed.'
    };
  }

  /**
   * Validates local Whisper runtime installation, executable status, CLI identity contract, and model validity.
   */
  public async validateRuntime(): Promise<WhisperRuntimeValidation> {
    const sttPath = process.env.WHISPER_PATH || process.env.LOCAL_STT_PATH;
    const modelPath = process.env.WHISPER_MODEL_PATH;

    if (!sttPath) {
      return {
        isConfigured: false,
        executableFound: false,
        isExecutable: false,
        modelConfigured: Boolean(modelPath),
        modelFound: false,
        runtimeType: 'unconfigured',
        supportedLanguages: ['en', 'th'],
        status: 'UNCONFIGURED',
        diagnosticCode: 'UNCONFIGURED',
        details: 'Neither WHISPER_PATH nor LOCAL_STT_PATH is defined in the environment.'
      };
    }

    if (!fs.existsSync(sttPath)) {
      return {
        isConfigured: true,
        executableFound: false,
        executablePath: sttPath,
        isExecutable: false,
        modelConfigured: Boolean(modelPath),
        modelFound: false,
        runtimeType: 'unconfigured',
        supportedLanguages: ['en', 'th'],
        status: 'MISSING_EXECUTABLE',
        diagnosticCode: 'BINARY_NOT_FOUND',
        details: `Configured STT executable does not exist at ${sttPath}`
      };
    }

    // Check that path is a regular file, not a directory
    try {
      const fileStat = fs.statSync(sttPath);
      if (!fileStat.isFile()) {
        return {
          isConfigured: true,
          executableFound: true,
          executablePath: sttPath,
          isExecutable: false,
          modelConfigured: Boolean(modelPath),
          modelFound: false,
          runtimeType: 'unconfigured',
          supportedLanguages: ['en', 'th'],
          status: 'NON_EXECUTABLE',
          diagnosticCode: 'BINARY_NOT_EXECUTABLE',
          details: `Configured STT path at ${sttPath} is a directory, not an executable file.`
        };
      }
    } catch (statErr: any) {
      return {
        isConfigured: true,
        executableFound: false,
        executablePath: sttPath,
        isExecutable: false,
        modelConfigured: Boolean(modelPath),
        modelFound: false,
        runtimeType: 'unconfigured',
        supportedLanguages: ['en', 'th'],
        status: 'MISSING_EXECUTABLE',
        diagnosticCode: 'BINARY_NOT_FOUND',
        details: `Unable to inspect STT file at ${sttPath}: ${statErr?.message || statErr}`
      };
    }

    // Check file execution permissions
    try {
      fs.accessSync(sttPath, fs.constants.X_OK);
    } catch {
      return {
        isConfigured: true,
        executableFound: true,
        executablePath: sttPath,
        isExecutable: false,
        modelConfigured: Boolean(modelPath),
        modelFound: false,
        runtimeType: 'unconfigured',
        supportedLanguages: ['en', 'th'],
        status: 'NON_EXECUTABLE',
        diagnosticCode: 'BINARY_NOT_EXECUTABLE',
        details: `Binary at ${sttPath} lacks execution permissions (X_OK).`
      };
    }

    // Check --help and --version to verify genuine supported runtime identity (no filename heuristics)
    let helpOutput = '';
    let versionOutput = '';
    let helpSucceeded = false;
    let versionSucceeded = false;

    try {
      const { stdout, stderr } = await execFileAsync(sttPath, ['--help'], { timeout: 10000 });
      helpOutput = (stdout || '') + '\n' + (stderr || '');
      helpSucceeded = true;
    } catch (helpErr: any) {
      // Capture stderr/stdout if CLI exits non-zero on --help (some CLIs emit usage to stderr),
      // still check --version before giving up.
      helpOutput = String(helpErr?.stdout || '') + '\n' + String(helpErr?.stderr || '');
    }

    try {
      const { stdout, stderr } = await execFileAsync(sttPath, ['--version'], { timeout: 10000 });
      versionOutput = (stdout || '') + '\n' + (stderr || '');
      versionSucceeded = true;
    } catch (verErr: any) {
      versionOutput = String(verErr?.stdout || '') + '\n' + String(verErr?.stderr || '');
    }

    if (!helpSucceeded && !versionSucceeded) {
      return {
        isConfigured: true,
        executableFound: true,
        executablePath: sttPath,
        isExecutable: true,
        modelConfigured: Boolean(modelPath),
        modelFound: false,
        runtimeType: 'unconfigured',
        supportedLanguages: ['en', 'th'],
        status: 'ERROR',
        diagnosticCode: 'IDENTITY_PROBE_FAILED',
        details: `STT executable at ${sttPath} failed both '--help' and '--version' identity probes.`
      };
    }

    const combinedOutput = `${helpOutput}\n${versionOutput}`.trim();
    const lowerOutput = combinedOutput.toLowerCase();

    // Strict identity contract per supported runtime:
    // 1. whisper_cpp: explicitly identifies whisper.cpp / whisper-cli AND exposes model/file/json flags
    const isWhisperCppIdentity = (
      (lowerOutput.includes('whisper.cpp') || lowerOutput.includes('whisper-cli') || lowerOutput.includes('whisper_cpp')) &&
      (lowerOutput.includes('-m') || lowerOutput.includes('--model')) &&
      (lowerOutput.includes('-f') || lowerOutput.includes('--file') || lowerOutput.includes('--output-json') || lowerOutput.includes('-oj') || lowerOutput.includes('<model>'))
    );

    // 2. openai_whisper: explicitly identifies openai-whisper / whisper usage AND exposes --output_format + --model
    const isOpenAiWhisperIdentity = (
      (lowerOutput.includes('openai-whisper') || lowerOutput.includes('openai/whisper') || lowerOutput.includes('usage: whisper')) &&
      lowerOutput.includes('--output_format') &&
      lowerOutput.includes('--model')
    );

    let runtimeType: WhisperRuntimeValidation['runtimeType'];
    if (isWhisperCppIdentity) {
      runtimeType = 'whisper_cpp';
    } else if (isOpenAiWhisperIdentity) {
      runtimeType = 'openai_whisper';
    } else {
      return {
        isConfigured: true,
        executableFound: true,
        executablePath: sttPath,
        isExecutable: true,
        modelConfigured: Boolean(modelPath),
        modelFound: false,
        runtimeType: 'unconfigured',
        supportedLanguages: ['en', 'th'],
        status: 'ERROR',
        diagnosticCode: 'IDENTITY_CONTRACT_MISMATCH',
        details: `Executable at ${sttPath} failed runtime identity verification: output from '--help'/'--version' does not match supported whisper_cpp or openai_whisper contracts.`
      };
    }

    const versionStr = combinedOutput.split('\n').map(l => l.trim()).find(Boolean)?.substring(0, 100);

    // Validate model requirements rigorously (existence, regular file, readable, > 0 bytes, and format header)
    const validateModelFile = (
      p: string,
      rt: 'whisper_cpp' | 'openai_whisper'
    ): { valid: boolean; status?: 'MISSING_MODEL' | 'ERROR'; diagnosticCode?: WhisperDiagnosticCode; reason?: string } => {
      try {
        if (!fs.existsSync(p)) {
          return {
            valid: false,
            status: 'MISSING_MODEL',
            diagnosticCode: 'MODEL_NOT_FOUND',
            reason: `Configured WHISPER_MODEL_PATH not found on disk at ${p}`
          };
        }
        const stat = fs.statSync(p);
        if (!stat.isFile()) {
          return {
            valid: false,
            status: 'MISSING_MODEL',
            diagnosticCode: 'MODEL_INCOMPATIBLE',
            reason: `Configured WHISPER_MODEL_PATH at ${p} is not a regular file`
          };
        }
        if ((stat.mode & 0o444) === 0) {
          return {
            valid: false,
            status: 'MISSING_MODEL',
            diagnosticCode: 'MODEL_NOT_READABLE',
            reason: `Configured WHISPER_MODEL_PATH at ${p} is not readable (no read permission bits set)`
          };
        }
        try {
          fs.accessSync(p, fs.constants.R_OK);
        } catch {
          return {
            valid: false,
            status: 'MISSING_MODEL',
            diagnosticCode: 'MODEL_NOT_READABLE',
            reason: `Configured WHISPER_MODEL_PATH at ${p} is not readable (R_OK check failed)`
          };
        }
        if (stat.size <= 0) {
          return {
            valid: false,
            status: 'MISSING_MODEL',
            diagnosticCode: 'MODEL_INCOMPATIBLE',
            reason: `Configured WHISPER_MODEL_PATH at ${p} is an empty file (0 bytes)`
          };
        }

        // Read header magic bytes to reject arbitrary non-model / corrupt files
        const fd = fs.openSync(p, 'r');
        const headerBuf = Buffer.alloc(16);
        let bytesRead = 0;
        try {
          bytesRead = fs.readSync(fd, headerBuf, 0, 16, 0);
        } finally {
          fs.closeSync(fd);
        }

        if (bytesRead < 4) {
          return {
            valid: false,
            status: 'ERROR',
            diagnosticCode: 'MODEL_INCOMPATIBLE',
            reason: `Model file at ${p} is truncated (${bytesRead} bytes) and cannot contain a valid model header.`
          };
        }

        const magic4 = headerBuf.subarray(0, 4).toString('ascii');
        if (rt === 'whisper_cpp') {
          if (!VALID_GGML_GGUF_MAGICS.has(magic4)) {
            return {
              valid: false,
              status: 'ERROR',
              diagnosticCode: 'MODEL_INCOMPATIBLE',
              reason: `Model file at ${p} has unrecognized header signature; whisper_cpp requires a valid GGML or GGUF model binary.`
            };
          }
        } else if (rt === 'openai_whisper') {
          const isZipCheckpoint =
            headerBuf[0] === 0x50 && headerBuf[1] === 0x4b &&
            ((headerBuf[2] === 0x03 && headerBuf[3] === 0x04) || (headerBuf[2] === 0x05 && headerBuf[3] === 0x06));
          const isPickleCheckpoint =
            headerBuf[0] === 0x80 && headerBuf[1] >= 0x02 && headerBuf[1] <= 0x05;
          if (!isZipCheckpoint && !isPickleCheckpoint) {
            return {
              valid: false,
              status: 'ERROR',
              diagnosticCode: 'MODEL_INCOMPATIBLE',
              reason: `Model file at ${p} is not a valid PyTorch/OpenAI Whisper checkpoint (.pt ZIP or pickle header expected).`
            };
          }
        }

        return { valid: true };
      } catch (err: any) {
        const isAccessErr = err?.code === 'EACCES' || err?.code === 'EPERM';
        return {
          valid: false,
          status: 'MISSING_MODEL',
          diagnosticCode: isAccessErr ? 'MODEL_NOT_READABLE' : 'MODEL_NOT_FOUND',
          reason: `Failed to inspect model file at ${p}: ${err?.message || err}`
        };
      }
    };

    const isModelConfigured = Boolean(modelPath);
    let modelFound = false;

    if (runtimeType === 'whisper_cpp') {
      if (!isModelConfigured || !modelPath) {
        return {
          isConfigured: true,
          executableFound: true,
          executablePath: sttPath,
          isExecutable: true,
          version: versionStr,
          modelConfigured: false,
          modelFound: false,
          runtimeType,
          supportedLanguages: ['en', 'th'],
          status: 'MISSING_MODEL',
          diagnosticCode: 'MODEL_NOT_CONFIGURED',
          details: 'whisper_cpp runtime strictly requires a valid GGML/GGUF model file via WHISPER_MODEL_PATH.'
        };
      }
      const modelCheck = validateModelFile(modelPath, 'whisper_cpp');
      if (!modelCheck.valid) {
        return {
          isConfigured: true,
          executableFound: true,
          executablePath: sttPath,
          isExecutable: true,
          version: versionStr,
          modelConfigured: true,
          modelFound: false,
          modelPath,
          runtimeType,
          supportedLanguages: ['en', 'th'],
          status: modelCheck.status || 'MISSING_MODEL',
          diagnosticCode: modelCheck.diagnosticCode || 'MODEL_INCOMPATIBLE',
          details: modelCheck.reason || `Invalid WHISPER_MODEL_PATH at ${modelPath}`
        };
      }
      modelFound = true;
    } else if (runtimeType === 'openai_whisper') {
      if (isModelConfigured && modelPath) {
        if (OPENAI_WHISPER_MODEL_NAMES.has(modelPath.trim())) {
          modelFound = true;
        } else {
          const modelCheck = validateModelFile(modelPath, 'openai_whisper');
          if (!modelCheck.valid) {
            return {
              isConfigured: true,
              executableFound: true,
              executablePath: sttPath,
              isExecutable: true,
              version: versionStr,
              modelConfigured: true,
              modelFound: false,
              modelPath,
              runtimeType,
              supportedLanguages: ['en', 'th'],
              status: modelCheck.status || 'MISSING_MODEL',
              diagnosticCode: modelCheck.diagnosticCode || 'MODEL_INCOMPATIBLE',
              details: modelCheck.reason || `Invalid WHISPER_MODEL_PATH at ${modelPath}`
            };
          }
          modelFound = true;
        }
      }
    }

    return {
      isConfigured: true,
      executableFound: true,
      executablePath: sttPath,
      isExecutable: true,
      version: versionStr,
      modelConfigured: isModelConfigured,
      modelFound,
      modelPath,
      runtimeType,
      supportedLanguages: ['en', 'th'],
      status: 'READY',
      diagnosticCode: 'READY',
      details: `Verified ${runtimeType} binary and model preflight requirements (speech execution compatibility must be verified separately via verifyRuntimeCompatibility).`
    };
  }

  /**
   * Cached initialization wrapper around `verifyRuntimeCompatibility()` for readiness checks and repeated scans.
   * Re-verifies automatically if executable, model, or fixture/manifest files change on disk or when `forceRefresh: true`.
   */
  public async initializeRuntime(options?: {
    audioFixturePath?: string;
    expectedTranscript?: string;
    timeoutMs?: number;
    forceRefresh?: boolean;
    isSyntheticFixture?: boolean;
    trustedManifestPath?: string;
    trustedManifest?: TrustedSpeechFixtureManifest;
    trustedPublicKeys?: Record<string, string>;
    strictAttestationMode?: boolean;
  }): Promise<WhisperCompatibilityResult> {
    return this.verifyRuntimeCompatibility({
      audioFixturePath: options?.audioFixturePath,
      expectedTranscript: options?.expectedTranscript,
      timeoutMs: options?.timeoutMs,
      useCache: !options?.forceRefresh,
      isSyntheticFixture: options?.isSyntheticFixture,
      trustedManifestPath: options?.trustedManifestPath,
      trustedManifest: options?.trustedManifest,
      trustedPublicKeys: options?.trustedPublicKeys,
      strictAttestationMode: options?.strictAttestationMode
    });
  }

  /**
   * Executes an actual runtime compatibility smoke test against a configured Whisper binary + model
   * using a 16kHz mono PCM WAV audio fixture.
   *
   * Strictly separates:
   * - `runtimeCompatibilityStatus` / `compatibilityVerified`: Runtime compatibility ONLY (binary + model + non-empty execution).
   * - `runtimeExecutionStatus`: `UNCONFIGURED` | `UNVERIFIED` | `RUNTIME_EXECUTION_VERIFIED` | `FAILED`.
   * - `humanSpeechProvenanceStatus`: Verified via SHA-256 + Two-Tier Trust Model against manifest.
   * - `provenanceTrustTier`: `UNTRUSTED` | `MAINTAINER_ATTESTED` | `CRYPTOGRAPHICALLY_VERIFIED`.
   * - `transcriptComparisonStatus`: `NOT_COMPARED` | `PASSED` | `FAILED`.
   * - `speechTranscriptStatus` / `speechTranscriptVerified`: `SPEECH_TRANSCRIPT_VERIFIED` is ONLY granted when
   *   runtime execution succeeded, provenance is `VERIFIED_HUMAN_SPEECH`, TOCTOU SHA-256 check passed, and
   *   ordered-token LCS comparison passed thresholds.
   */
  public async verifyRuntimeCompatibility(options?: {
    audioFixturePath?: string;
    expectedTranscript?: string;
    timeoutMs?: number;
    useCache?: boolean;
    isSyntheticFixture?: boolean;
    trustedManifestPath?: string;
    trustedManifest?: TrustedSpeechFixtureManifest;
    trustedPublicKeys?: Record<string, string>;
    strictAttestationMode?: boolean;
  }): Promise<WhisperCompatibilityResult> {
    const startTime = Date.now();
    const timeoutMs = options?.timeoutMs ?? 20000;
    const isSyntheticFlag = Boolean(
      options?.isSyntheticFixture ||
      (process.env.WHISPER_COMPAT_SYNTHETIC_FIXTURE || '').trim().toLowerCase() === 'true'
    );
    const defaultProvStatus: HumanSpeechProvenanceStatus = isSyntheticFlag
      ? 'SYNTHETIC_FIXTURE'
      : 'UNTRUSTED_NO_MANIFEST_ENTRY';

    const validation = await this.validateRuntime();

    if (validation.status !== 'READY' || (validation.runtimeType !== 'whisper_cpp' && validation.runtimeType !== 'openai_whisper')) {
      const code: WhisperDiagnosticCode =
        validation.diagnosticCode ||
        (validation.status === 'UNCONFIGURED'
          ? 'UNCONFIGURED'
          : validation.status === 'MISSING_EXECUTABLE'
            ? 'BINARY_NOT_FOUND'
            : validation.status === 'NON_EXECUTABLE'
              ? 'BINARY_NOT_EXECUTABLE'
              : validation.status === 'MISSING_MODEL'
                ? 'MODEL_NOT_FOUND'
                : 'IDENTITY_CONTRACT_MISMATCH');

      const rtStatus: WhisperRuntimeCompatibilityStatus =
        validation.status === 'UNCONFIGURED' ? 'UNCONFIGURED' : 'FAILED';

      return {
        compatible: false,
        runtimeCompatible: false,
        runtimeCompatibilityStatus: rtStatus,
        compatibilityVerified: false,
        diagnosticCode: code,
        runtimeExecutionStatus: validation.status === 'UNCONFIGURED' ? 'UNCONFIGURED' : 'FAILED',
        transcriptComparisonStatus: 'NOT_COMPARED',
        humanSpeechProvenanceStatus: defaultProvStatus,
        provenanceTrustTier: 'UNTRUSTED',
        verificationStates: ['NOT_VERIFIED'],
        speechTranscriptStatus: 'SPEECH_TRANSCRIPT_UNVERIFIED',
        speechTranscriptVerified: false,
        runtimeType: validation.runtimeType,
        validation,
        isSyntheticFixture: isSyntheticFlag,
        verifiedAt: new Date().toISOString(),
        executionDurationMs: Date.now() - startTime,
        details: validation.details || `Whisper runtime preflight failed with status ${validation.status}.`
      };
    }

    const defaultCheckedInSpeechFixture = path.resolve(process.cwd(), 'tests', 'fixtures', 'speech', 'whisper_speech_16k.wav');
    const resolvedFixturePath = options?.audioFixturePath || process.env.WHISPER_COMPAT_AUDIO_PATH || (fs.existsSync(defaultCheckedInSpeechFixture) ? defaultCheckedInSpeechFixture : undefined);

    if (!resolvedFixturePath || !fs.existsSync(resolvedFixturePath)) {
      return {
        compatible: false,
        runtimeCompatible: false,
        runtimeCompatibilityStatus: 'UNVERIFIED',
        compatibilityVerified: false,
        diagnosticCode: 'SPEECH_FIXTURE_NOT_FOUND',
        runtimeExecutionStatus: 'UNVERIFIED',
        transcriptComparisonStatus: 'NOT_COMPARED',
        humanSpeechProvenanceStatus: defaultProvStatus,
        provenanceTrustTier: 'UNTRUSTED',
        verificationStates: ['NOT_VERIFIED'],
        speechTranscriptStatus: 'SPEECH_TRANSCRIPT_UNVERIFIED',
        speechTranscriptVerified: false,
        runtimeType: validation.runtimeType,
        validation,
        isSyntheticFixture: isSyntheticFlag,
        verifiedAt: new Date().toISOString(),
        executionDurationMs: Date.now() - startTime,
        details: 'No 16kHz mono PCM WAV fixture is configured or present on disk (set WHISPER_COMPAT_AUDIO_PATH or provide audioFixturePath).'
      };
    }

    const wavCheck = this.validateSpeechWavFixture(resolvedFixturePath);
    if (!wavCheck.valid) {
      return {
        compatible: false,
        runtimeCompatible: false,
        runtimeCompatibilityStatus: 'FAILED',
        compatibilityVerified: false,
        diagnosticCode: 'SPEECH_FIXTURE_INVALID',
        runtimeExecutionStatus: 'FAILED',
        transcriptComparisonStatus: 'NOT_COMPARED',
        humanSpeechProvenanceStatus: isSyntheticFlag ? 'SYNTHETIC_FIXTURE' : 'UNTRUSTED_PROVENANCE_UNVERIFIED',
        provenanceTrustTier: 'UNTRUSTED',
        verificationStates: ['NOT_VERIFIED'],
        speechTranscriptStatus: 'SPEECH_TRANSCRIPT_UNVERIFIED',
        speechTranscriptVerified: false,
        runtimeType: validation.runtimeType,
        validation,
        audioFixturePath: resolvedFixturePath,
        isSyntheticFixture: isSyntheticFlag,
        verifiedAt: new Date().toISOString(),
        executionDurationMs: Date.now() - startTime,
        details: wavCheck.reason || `Invalid speech WAV fixture at ${resolvedFixturePath}.`
      };
    }

    let canonicalFixturePath: string;
    try {
      canonicalFixturePath = fs.realpathSync(resolvedFixturePath);
    } catch {
      canonicalFixturePath = path.resolve(resolvedFixturePath);
    }

    const preSha256 = this.computeFileSha256(canonicalFixturePath);
    const provenanceResult = this.validateFixtureProvenance(canonicalFixturePath, preSha256, {
      isSyntheticFixture: isSyntheticFlag,
      trustedManifestPath: options?.trustedManifestPath,
      trustedManifest: options?.trustedManifest,
      trustedPublicKeys: options?.trustedPublicKeys,
      strictAttestationMode: options?.strictAttestationMode
    });
    const provenance = provenanceResult.report;
    const effectiveSynthetic = provenance.humanSpeechProvenanceStatus === 'SYNTHETIC_FIXTURE' || isSyntheticFlag;

    // Fail closed immediately on manifest/signature/provenance corruption or hash mismatch
    if (
      provenance.humanSpeechProvenanceStatus === 'UNTRUSTED_HASH_MISMATCH' ||
      provenance.humanSpeechProvenanceStatus === 'INVALID_PROVENANCE'
    ) {
      return {
        compatible: false,
        runtimeCompatible: false,
        runtimeCompatibilityStatus: 'FAILED',
        compatibilityVerified: false,
        diagnosticCode: 'SPEECH_FIXTURE_INVALID',
        runtimeExecutionStatus: 'FAILED',
        transcriptComparisonStatus: 'FAILED',
        humanSpeechProvenanceStatus: provenance.humanSpeechProvenanceStatus,
        provenanceTrustTier: 'UNTRUSTED',
        verificationStates: provenance.humanSpeechProvenanceStatus === 'INVALID_PROVENANCE'
          ? ['INVALID_PROVENANCE', 'NOT_VERIFIED']
          : ['NOT_VERIFIED'],
        speechTranscriptStatus: 'SPEECH_TRANSCRIPT_FAILED',
        speechTranscriptVerified: false,
        runtimeType: validation.runtimeType,
        validation,
        audioFixturePath: resolvedFixturePath,
        fixtureProvenance: provenance,
        isSyntheticFixture: effectiveSynthetic,
        verifiedAt: new Date().toISOString(),
        executionDurationMs: Date.now() - startTime,
        details: provenance.reason
      };
    }

    const hasExplicitOptionExpected = options?.expectedTranscript !== undefined;
    const rawEnvExpected = process.env.WHISPER_COMPAT_EXPECTED_TRANSCRIPT;
    const hasNonEmptyEnvExpected = typeof rawEnvExpected === 'string' && rawEnvExpected.trim().length > 0;
    const hasManifestExpected = Boolean(
      provenance.verifiedHumanSpeech && provenanceResult.manifestEntry?.expectedTranscript
    );

    const expectedProvided = hasExplicitOptionExpected || hasNonEmptyEnvExpected || hasManifestExpected;
    const callerExpected = hasExplicitOptionExpected
      ? options!.expectedTranscript!
      : (hasNonEmptyEnvExpected ? rawEnvExpected! : undefined);
    const expectedTranscript = callerExpected !== undefined
      ? callerExpected
      : provenanceResult.manifestEntry?.expectedTranscript;

    // Reject transcript tampering if fixture is verified against manifest and caller passed a conflicting reference transcript
    if (
      provenance.verifiedHumanSpeech &&
      provenanceResult.manifestEntry &&
      callerExpected !== undefined
    ) {
      const callerNorm = this.normalizeTranscriptTokens(callerExpected).join(' ');
      const manifestNorm = this.normalizeTranscriptTokens(provenanceResult.manifestEntry.expectedTranscript).join(' ');
      if (!callerNorm || callerNorm !== manifestNorm) {
        const tamperedReport: WhisperFixtureProvenanceReport = {
          ...provenance,
          humanSpeechProvenanceStatus: 'UNTRUSTED_HASH_MISMATCH',
          provenanceTrustTier: 'UNTRUSTED',
          verificationStates: ['NOT_VERIFIED'],
          verifiedHumanSpeech: false,
          reason: `Expected transcript does not match trusted manifest transcript for '${provenanceResult.manifestEntry.fixtureId}'.`
        };
        return {
          compatible: false,
          runtimeCompatible: false,
          runtimeCompatibilityStatus: 'FAILED',
          compatibilityVerified: false,
          diagnosticCode: 'SPEECH_FIXTURE_INVALID',
          runtimeExecutionStatus: 'FAILED',
          transcriptComparisonStatus: 'FAILED',
          humanSpeechProvenanceStatus: 'UNTRUSTED_HASH_MISMATCH',
          provenanceTrustTier: 'UNTRUSTED',
          verificationStates: ['NOT_VERIFIED'],
          speechTranscriptStatus: 'SPEECH_TRANSCRIPT_FAILED',
          speechTranscriptVerified: false,
          runtimeType: validation.runtimeType,
          validation,
          audioFixturePath: resolvedFixturePath,
          referenceTranscript: callerExpected,
          referenceMatched: false,
          fixtureProvenance: tamperedReport,
          isSyntheticFixture: effectiveSynthetic,
          verifiedAt: new Date().toISOString(),
          executionDurationMs: Date.now() - startTime,
          details: tamperedReport.reason
        };
      }
    }

    const strictEnvFlag = Boolean(options?.strictAttestationMode || (process.env.WHISPER_STRICT_PROVENANCE || '').trim().toLowerCase() === 'true');
    const keysHash = crypto.createHash('sha256').update(JSON.stringify(this.parseTrustedPublicKeys(options?.trustedPublicKeys).keys)).digest('hex').slice(0, 12);
    const fingerprint = this.getRuntimeFingerprint(
      validation,
      canonicalFixturePath,
      preSha256,
      expectedTranscript,
      `${provenanceResult.manifestDigest}:${provenance.humanSpeechProvenanceStatus}:${provenance.provenanceTrustTier}:${strictEnvFlag}:${keysHash}`
    );

    if (options?.useCache) {
      const cached = this.compatibilityCache.get(fingerprint);
      if (cached) {
        return {
          ...cached,
          fromCache: true,
          executionDurationMs: 0,
        };
      }
    }

    const sttPath = validation.executablePath!;
    const modelPath = validation.modelPath;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_whisper_compat_'));

    try {
      const outPrefix = path.join(tmpDir, 'whisper_out');
      const cliArgs: string[] = validation.runtimeType === 'whisper_cpp'
        ? ['-m', modelPath!, '-f', canonicalFixturePath, '--output-json', '-of', outPrefix]
        : [
            canonicalFixturePath,
            '--output_format', 'json',
            '--output_dir', tmpDir,
            ...(modelPath ? ['--model', modelPath] : [])
          ];

      let stdout = '';
      let stderr = '';
      try {
        const res = await execFileAsync(sttPath, cliArgs, { timeout: timeoutMs, cwd: tmpDir });
        stdout = res.stdout || '';
        stderr = res.stderr || '';
      } catch (execErr: any) {
        const elapsed = Date.now() - startTime;
        const classified = this.classifyWhisperProcessError(execErr, timeoutMs);
        const failResult: WhisperCompatibilityResult = {
          compatible: false,
          runtimeCompatible: false,
          runtimeCompatibilityStatus: 'FAILED',
          compatibilityVerified: false,
          diagnosticCode: classified.diagnosticCode,
          runtimeExecutionStatus: 'FAILED',
          transcriptComparisonStatus: 'NOT_COMPARED',
          humanSpeechProvenanceStatus: provenance.humanSpeechProvenanceStatus,
          provenanceTrustTier: provenance.provenanceTrustTier,
          verificationStates: ['NOT_VERIFIED'],
          speechTranscriptStatus: 'SPEECH_TRANSCRIPT_UNVERIFIED',
          speechTranscriptVerified: false,
          runtimeType: validation.runtimeType,
          validation,
          audioFixturePath: resolvedFixturePath,
          fixtureProvenance: provenance,
          isSyntheticFixture: effectiveSynthetic,
          verifiedAt: new Date().toISOString(),
          fromCache: false,
          executionDurationMs: elapsed,
          details: classified.details
        };
        if (options?.useCache) {
          this.compatibilityCache.set(fingerprint, failResult);
        }
        return failResult;
      }

      // TOCTOU Post-Execution Check: Verify fixture file still exists, is valid WAV, and matches pre-execution SHA-256
      let toctouFailedReason: string | null = null;
      if (!fs.existsSync(canonicalFixturePath)) {
        toctouFailedReason = 'Speech fixture disappeared on disk during Whisper execution (TOCTOU check failed).';
      } else {
        const postSha256 = this.computeFileSha256(canonicalFixturePath);
        if (postSha256 !== preSha256) {
          toctouFailedReason = 'Speech fixture SHA-256 digest changed mid-verification (TOCTOU integrity check failed).';
        }
      }
      if (toctouFailedReason) {
        const toctouReport: WhisperFixtureProvenanceReport = {
          ...provenance,
          humanSpeechProvenanceStatus: 'UNTRUSTED_HASH_MISMATCH',
          provenanceTrustTier: 'UNTRUSTED',
          verificationStates: ['NOT_VERIFIED'],
          verifiedHumanSpeech: false,
          reason: toctouFailedReason
        };
        return {
          compatible: false,
          runtimeCompatible: false,
          runtimeCompatibilityStatus: 'FAILED',
          compatibilityVerified: false,
          diagnosticCode: 'SPEECH_FIXTURE_INVALID',
          runtimeExecutionStatus: 'FAILED',
          transcriptComparisonStatus: 'FAILED',
          humanSpeechProvenanceStatus: 'UNTRUSTED_HASH_MISMATCH',
          provenanceTrustTier: 'UNTRUSTED',
          verificationStates: ['NOT_VERIFIED'],
          speechTranscriptStatus: 'SPEECH_TRANSCRIPT_FAILED',
          speechTranscriptVerified: false,
          runtimeType: validation.runtimeType,
          validation,
          audioFixturePath: resolvedFixturePath,
          fixtureProvenance: toctouReport,
          isSyntheticFixture: effectiveSynthetic,
          verifiedAt: new Date().toISOString(),
          fromCache: false,
          executionDurationMs: Date.now() - startTime,
          details: toctouFailedReason
        };
      }

      const elapsed = Date.now() - startTime;
      const baseWav = path.basename(canonicalFixturePath, path.extname(canonicalFixturePath));
      const candidateJsonPaths = [
        `${outPrefix}.json`,
        `${canonicalFixturePath}.json`,
        path.join(tmpDir, `${path.basename(canonicalFixturePath)}.json`),
        path.join(tmpDir, `${baseWav}.json`)
      ];

      let parsedPayload: any = null;
      for (const jsonPath of candidateJsonPaths) {
        if (fs.existsSync(jsonPath)) {
          try {
            const rawJson = fs.readFileSync(jsonPath, 'utf-8').trim();
            if (rawJson) {
              parsedPayload = JSON.parse(rawJson);
              break;
            }
          } catch {
            // Fall through to stdout inspection
          }
        }
      }

      const trimmedStdout = stdout.trim();
      if (!parsedPayload && (trimmedStdout.startsWith('{') || trimmedStdout.startsWith('['))) {
        try {
          parsedPayload = JSON.parse(trimmedStdout);
        } catch {
          return {
            compatible: false,
            runtimeCompatible: false,
            runtimeCompatibilityStatus: 'FAILED',
            compatibilityVerified: false,
            diagnosticCode: 'TRANSCRIPTION_FAILED',
            runtimeExecutionStatus: 'FAILED',
            transcriptComparisonStatus: 'FAILED',
            humanSpeechProvenanceStatus: provenance.humanSpeechProvenanceStatus,
            provenanceTrustTier: provenance.provenanceTrustTier,
            verificationStates: ['NOT_VERIFIED'],
            speechTranscriptStatus: 'SPEECH_TRANSCRIPT_UNVERIFIED',
            speechTranscriptVerified: false,
            runtimeType: validation.runtimeType,
            validation,
            audioFixturePath: resolvedFixturePath,
            fixtureProvenance: provenance,
            isSyntheticFixture: effectiveSynthetic,
            verifiedAt: new Date().toISOString(),
            fromCache: false,
            executionDurationMs: elapsed,
            details: 'Whisper executable produced malformed JSON output during compatibility probe.'
          };
        }
      }

      let extractedText = '';
      let segmentsCount = 0;

      if (parsedPayload && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload)) {
        const segList = Array.isArray(parsedPayload.segments)
          ? parsedPayload.segments
          : Array.isArray(parsedPayload.transcription)
            ? parsedPayload.transcription
            : [];
        segmentsCount = segList.length;
        const segText = segList
          .map((s: any) => String(s?.text || '').trim())
          .filter(Boolean)
          .join(' ')
          .trim();
        const directText = typeof parsedPayload.text === 'string' ? parsedPayload.text.trim() : '';
        extractedText = directText || segText;
      } else if (trimmedStdout && !trimmedStdout.startsWith('{')) {
        extractedText = trimmedStdout;
      }

      if (!extractedText) {
        return {
          compatible: false,
          runtimeCompatible: false,
          runtimeCompatibilityStatus: 'FAILED',
          compatibilityVerified: false,
          diagnosticCode: 'EMPTY_TRANSCRIPTION_OUTPUT',
          runtimeExecutionStatus: 'FAILED',
          transcriptComparisonStatus: 'NOT_COMPARED',
          humanSpeechProvenanceStatus: provenance.humanSpeechProvenanceStatus,
          provenanceTrustTier: provenance.provenanceTrustTier,
          verificationStates: ['NOT_VERIFIED'],
          speechTranscriptStatus: 'SPEECH_TRANSCRIPT_UNVERIFIED',
          speechTranscriptVerified: false,
          runtimeType: validation.runtimeType,
          validation,
          audioFixturePath: resolvedFixturePath,
          fixtureProvenance: provenance,
          isSyntheticFixture: effectiveSynthetic,
          verifiedAt: new Date().toISOString(),
          fromCache: false,
          executionDurationMs: elapsed,
          details: `Whisper executable ran without error on speech fixture but produced empty transcription output.${stderr ? ' Check speech audio fixture or model configuration.' : ''}`
        };
      }

      const MIN_RECALL_THRESHOLD = 0.85;
      const MIN_PRECISION_THRESHOLD = 0.80;
      const actualTokens = this.normalizeTranscriptTokens(extractedText);

      let speechTranscriptStatus: WhisperSpeechTranscriptStatus = 'SPEECH_TRANSCRIPT_UNVERIFIED';
      let transcriptComparisonStatus: TranscriptComparisonStatus = 'NOT_COMPARED';
      let referenceMatched: boolean | undefined;
      let transcriptComparison: WhisperTranscriptComparison;
      const verifiedAt = new Date().toISOString();

      if (!expectedProvided) {
        transcriptComparison = {
          compared: false,
          expectedTranscriptPresent: false,
          expectedTokenCount: 0,
          actualTokenCount: actualTokens.length,
          matchedTokenCount: 0,
          minRecallThreshold: MIN_RECALL_THRESHOLD,
          minPrecisionThreshold: MIN_PRECISION_THRESHOLD,
          isSyntheticFixture: effectiveSynthetic,
          reason: 'No expected reference transcript configured; runtime execution verified, but speech transcript verification remains SPEECH_TRANSCRIPT_UNVERIFIED.'
        };
      } else {
        const expectedTokens = this.normalizeTranscriptTokens(expectedTranscript || '');

        if (expectedTokens.length === 0 || actualTokens.length === 0) {
          referenceMatched = false;
          speechTranscriptStatus = 'SPEECH_TRANSCRIPT_FAILED';
          transcriptComparisonStatus = 'FAILED';
          const reason = expectedTokens.length === 0
            ? 'Expected transcript contains zero alphanumeric speech tokens after normalization.'
            : 'Extracted transcript contains zero alphanumeric speech tokens after normalization.';
          transcriptComparison = {
            compared: true,
            expectedTranscriptPresent: true,
            passed: false,
            expectedTokenCount: expectedTokens.length,
            actualTokenCount: actualTokens.length,
            matchedTokenCount: 0,
            recall: 0,
            precision: 0,
            score: 0,
            minRecallThreshold: MIN_RECALL_THRESHOLD,
            minPrecisionThreshold: MIN_PRECISION_THRESHOLD,
            isSyntheticFixture: effectiveSynthetic,
            reason
          };

          const failStatesEmpty: SpeechVerificationState[] = ['RUNTIME_COMPATIBLE'];
          if (provenance.verifiedHumanSpeech && provenance.provenanceTrustTier !== 'UNTRUSTED') {
            failStatesEmpty.push('FIXTURE_INTEGRITY_VERIFIED', provenance.provenanceTrustTier);
          }
          failStatesEmpty.push('NOT_VERIFIED');

          return {
            compatible: false,
            runtimeCompatible: false,
            runtimeCompatibilityStatus: 'FAILED',
            compatibilityVerified: false,
            diagnosticCode: 'TRANSCRIPTION_FAILED',
            runtimeExecutionStatus: 'RUNTIME_EXECUTION_VERIFIED',
            transcriptComparisonStatus,
            humanSpeechProvenanceStatus: provenance.humanSpeechProvenanceStatus,
            provenanceTrustTier: provenance.provenanceTrustTier,
            verificationStates: failStatesEmpty,
            speechTranscriptStatus,
            speechTranscriptVerified: false,
            runtimeType: validation.runtimeType,
            validation,
            audioFixturePath: resolvedFixturePath,
            transcriptText: extractedText,
            segmentsCount,
            referenceTranscript: expectedTranscript,
            referenceMatched: false,
            transcriptComparison,
            fixtureProvenance: provenance,
            isSyntheticFixture: effectiveSynthetic,
            verifiedAt,
            fromCache: false,
            executionDurationMs: elapsed,
            details: `${reason} (runtime execution succeeded, speech transcript verification failed).`
          };
        }

        // Speech-fixture compatibility smoke check using ordered token Longest Common Subsequence (LCS).
        const m = expectedTokens.length;
        const n = actualTokens.length;
        let prev = new Array<number>(n + 1).fill(0);
        let curr = new Array<number>(n + 1).fill(0);
        for (let i = 1; i <= m; i++) {
          for (let j = 1; j <= n; j++) {
            if (expectedTokens[i - 1] === actualTokens[j - 1]) {
              curr[j] = prev[j - 1] + 1;
            } else {
              curr[j] = prev[j] >= curr[j - 1] ? prev[j] : curr[j - 1];
            }
          }
          const tmp = prev;
          prev = curr;
          curr = tmp;
          curr.fill(0);
        }
        const lcsLen = prev[n];
        const rawRecall = lcsLen / m;
        const rawPrecision = lcsLen / n;
        const recall = parseFloat(rawRecall.toFixed(4));
        const precision = parseFloat(rawPrecision.toFixed(4));
        const score = rawRecall + rawPrecision > 0
          ? parseFloat(((2 * rawRecall * rawPrecision) / (rawRecall + rawPrecision)).toFixed(4))
          : 0;
        const lcsPassed = rawRecall >= MIN_RECALL_THRESHOLD && rawPrecision >= MIN_PRECISION_THRESHOLD;

        if (!lcsPassed) {
          referenceMatched = false;
          speechTranscriptStatus = 'SPEECH_TRANSCRIPT_FAILED';
          transcriptComparisonStatus = 'FAILED';
          const reason = `Ordered token LCS check failed (recall=${recall} < ${MIN_RECALL_THRESHOLD} or precision=${precision} < ${MIN_PRECISION_THRESHOLD}).`;
          transcriptComparison = {
            compared: true,
            expectedTranscriptPresent: true,
            passed: false,
            expectedTokenCount: m,
            actualTokenCount: n,
            matchedTokenCount: lcsLen,
            recall,
            precision,
            score,
            minRecallThreshold: MIN_RECALL_THRESHOLD,
            minPrecisionThreshold: MIN_PRECISION_THRESHOLD,
            isSyntheticFixture: effectiveSynthetic,
            reason
          };

          const failStatesLcs: SpeechVerificationState[] = ['RUNTIME_COMPATIBLE'];
          if (provenance.verifiedHumanSpeech && provenance.provenanceTrustTier !== 'UNTRUSTED') {
            failStatesLcs.push('FIXTURE_INTEGRITY_VERIFIED', provenance.provenanceTrustTier);
          }
          failStatesLcs.push('NOT_VERIFIED');

          return {
            compatible: false,
            runtimeCompatible: false,
            runtimeCompatibilityStatus: 'FAILED',
            compatibilityVerified: false,
            diagnosticCode: 'TRANSCRIPTION_FAILED',
            runtimeExecutionStatus: 'RUNTIME_EXECUTION_VERIFIED',
            transcriptComparisonStatus,
            humanSpeechProvenanceStatus: provenance.humanSpeechProvenanceStatus,
            provenanceTrustTier: provenance.provenanceTrustTier,
            verificationStates: failStatesLcs,
            speechTranscriptStatus,
            speechTranscriptVerified: false,
            runtimeType: validation.runtimeType,
            validation,
            audioFixturePath: resolvedFixturePath,
            transcriptText: extractedText,
            segmentsCount,
            referenceTranscript: expectedTranscript,
            referenceMatched: false,
            transcriptComparison,
            fixtureProvenance: provenance,
            isSyntheticFixture: effectiveSynthetic,
            verifiedAt,
            fromCache: false,
            executionDurationMs: elapsed,
            details: `Transcript output did not match expected speech smoke-check transcript ('${expectedTranscript}' vs '${extractedText.slice(0, 120)}'). ${reason}`
          };
        }

        // Token comparison passed thresholds. Now gate SPEECH_TRANSCRIPT_VERIFIED strictly on trusted human speech provenance!
        if (!provenance.verifiedHumanSpeech || provenance.humanSpeechProvenanceStatus !== 'VERIFIED_HUMAN_SPEECH' || effectiveSynthetic) {
          referenceMatched = false;
          speechTranscriptStatus = 'SPEECH_TRANSCRIPT_UNVERIFIED';
          transcriptComparisonStatus = 'PASSED';
          transcriptComparison = {
            compared: true,
            expectedTranscriptPresent: true,
            passed: false,
            expectedTokenCount: m,
            actualTokenCount: n,
            matchedTokenCount: lcsLen,
            recall,
            precision,
            score,
            minRecallThreshold: MIN_RECALL_THRESHOLD,
            minPrecisionThreshold: MIN_PRECISION_THRESHOLD,
            isSyntheticFixture: effectiveSynthetic,
            reason: `Token comparison matched thresholds, but SPEECH_TRANSCRIPT_VERIFIED is withheld because fixture provenance is ${provenance.humanSpeechProvenanceStatus}: ${provenance.reason}`
          };
        } else {
          referenceMatched = true;
          speechTranscriptStatus = 'SPEECH_TRANSCRIPT_VERIFIED';
          transcriptComparisonStatus = 'PASSED';
          transcriptComparison = {
            compared: true,
            expectedTranscriptPresent: true,
            passed: true,
            expectedTokenCount: m,
            actualTokenCount: n,
            matchedTokenCount: lcsLen,
            recall,
            precision,
            score,
            minRecallThreshold: MIN_RECALL_THRESHOLD,
            minPrecisionThreshold: MIN_PRECISION_THRESHOLD,
            isSyntheticFixture: false,
            reason: provenance.provenanceTrustTier === 'CRYPTOGRAPHICALLY_VERIFIED'
              ? 'Ordered token LCS comparison met recall/precision thresholds on cryptographically verified (Ed25519 + SHA-256) human speech fixture.'
              : 'Ordered token LCS comparison met recall/precision thresholds on maintainer-attested (SHA-256) human speech fixture.'
          };
        }
      }

      const speechVerified = speechTranscriptStatus === 'SPEECH_TRANSCRIPT_VERIFIED';
      const verificationStates: SpeechVerificationState[] = ['RUNTIME_COMPATIBLE'];
      if (provenance.verifiedHumanSpeech && provenance.provenanceTrustTier !== 'UNTRUSTED') {
        verificationStates.push('FIXTURE_INTEGRITY_VERIFIED', provenance.provenanceTrustTier);
      }
      verificationStates.push(speechVerified ? 'TRANSCRIPT_VERIFIED' : 'NOT_VERIFIED');

      const passResult: WhisperCompatibilityResult = {
        compatible: true,
        runtimeCompatible: true,
        runtimeCompatibilityStatus: 'RUNTIME_COMPATIBLE',
        compatibilityVerified: true, // Runtime compatibility ONLY
        diagnosticCode: 'VERIFICATION_PASSED',
        runtimeExecutionStatus: 'RUNTIME_EXECUTION_VERIFIED',
        transcriptComparisonStatus,
        humanSpeechProvenanceStatus: provenance.humanSpeechProvenanceStatus,
        provenanceTrustTier: provenance.provenanceTrustTier,
        verificationStates,
        speechTranscriptStatus,
        speechTranscriptVerified: speechVerified,
        runtimeType: validation.runtimeType,
        validation,
        audioFixturePath: resolvedFixturePath,
        transcriptText: extractedText,
        segmentsCount,
        ...(expectedProvided ? { referenceTranscript: expectedTranscript, referenceMatched } : {}),
        transcriptComparison,
        fixtureProvenance: provenance,
        isSyntheticFixture: effectiveSynthetic,
        verifiedAt,
        fromCache: false,
        executionDurationMs: elapsed,
        details: speechVerified
          ? `Verified ${validation.runtimeType} runtime execution AND human speech transcript match (${provenance.provenanceTrustTier}) on 16kHz mono WAV fixture (${wavCheck.durationSeconds}s).`
          : `Verified ${validation.runtimeType} runtime compatibility/execution ONLY on 16kHz mono WAV fixture (${wavCheck.durationSeconds}s); speech transcript accuracy remains SPEECH_TRANSCRIPT_UNVERIFIED (${provenance.humanSpeechProvenanceStatus}).`
      };

      if (options?.useCache) {
        this.compatibilityCache.set(fingerprint, passResult);
      }

      return passResult;
    } finally {
      try {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore temp cleanup failures
      }
    }
  }

  public async transcribe(
    videoPath: string,
    durationSeconds: number,
    options?: {
      verifyCompatibility?: boolean;
      audioFixturePath?: string;
      expectedTranscript?: string;
      forceRefreshCompatibility?: boolean;
      isSyntheticFixture?: boolean;
      trustedManifestPath?: string;
      trustedManifest?: TrustedSpeechFixtureManifest;
      trustedPublicKeys?: Record<string, string>;
      strictAttestationMode?: boolean;
    }
  ): Promise<LocalTranscriptionResult> {
    const startTime = Date.now();

    // Enforce preflight runtime validation before transcription
    const validation = await this.validateRuntime();
    if (validation.status === 'UNCONFIGURED') {
      return {
        status: 'NOT_ASSESSED',
        diagnosticCode: 'UNCONFIGURED',
        compatibilityVerified: false,
        runtimeCompatible: false,
        runtimeCompatibilityStatus: 'UNCONFIGURED',
        runtimeExecutionStatus: 'UNCONFIGURED',
        transcriptComparisonStatus: 'NOT_COMPARED',
        humanSpeechProvenanceStatus: 'UNTRUSTED_NO_MANIFEST_ENTRY',
        provenanceTrustTier: 'UNTRUSTED',
        verificationStates: ['NOT_VERIFIED'],
        speechTranscriptStatus: 'SPEECH_TRANSCRIPT_UNVERIFIED',
        speechTranscriptVerified: false,
        limitations: 'Local speech-to-text executable (WHISPER_PATH or LOCAL_STT_PATH) not configured. Speech detection is acoustic-only without automated transcription.',
        executionDurationMs: 0
      };
    }

    if (validation.status !== 'READY' || (validation.runtimeType !== 'whisper_cpp' && validation.runtimeType !== 'openai_whisper')) {
      let failureReason = validation.details || 'Whisper runtime validation failed.';
      if (validation.status === 'MISSING_EXECUTABLE') {
        failureReason = `Configured STT executable not found at ${validation.executablePath}`;
      } else if (validation.status === 'NON_EXECUTABLE') {
        failureReason = `Configured STT binary at ${validation.executablePath} is not executable (lacks execution permissions)`;
      } else if (validation.status === 'MISSING_MODEL') {
        failureReason = validation.details || `Configured WHISPER_MODEL_PATH not found on disk at ${validation.modelPath}`;
      }

      return {
        status: 'ANALYSIS_UNAVAILABLE',
        diagnosticCode: validation.diagnosticCode,
        compatibilityVerified: false,
        runtimeCompatible: false,
        runtimeCompatibilityStatus: 'FAILED',
        runtimeExecutionStatus: 'FAILED',
        transcriptComparisonStatus: 'NOT_COMPARED',
        humanSpeechProvenanceStatus: 'UNTRUSTED_NO_MANIFEST_ENTRY',
        provenanceTrustTier: 'UNTRUSTED',
        verificationStates: ['NOT_VERIFIED'],
        speechTranscriptStatus: 'SPEECH_TRANSCRIPT_UNVERIFIED',
        speechTranscriptVerified: false,
        failureReason,
        limitations: `Whisper runtime validation failed with status ${validation.status}.`,
        executionDurationMs: Date.now() - startTime
      };
    }

    // Enforce runtime compatibility verification when explicitly required (WHISPER_VERIFY_COMPATIBILITY=true
    // or verifyCompatibility=true), in canonical Production Mode unless explicitly disabled, or when a speech fixture is configured.
    const shouldVerifyCompatibility = shouldEnforceWhisperCompatibility(
      {
        verifyCompatibility: options?.verifyCompatibility,
        audioFixturePath: options?.audioFixturePath,
        modelConfigured: validation.modelConfigured
      },
      process.env
    );

    let compatibilityVerified = false;
    let runtimeCompatibilityStatus: WhisperRuntimeCompatibilityStatus = 'UNVERIFIED';
    let runtimeExecutionStatus: WhisperRuntimeExecutionStatus = 'UNVERIFIED';
    let transcriptComparisonStatus: TranscriptComparisonStatus = 'NOT_COMPARED';
    let humanSpeechProvenanceStatus: HumanSpeechProvenanceStatus = 'UNTRUSTED_NO_MANIFEST_ENTRY';
    let provenanceTrustTier: ProvenanceTrustTier = 'UNTRUSTED';
    let verificationStates: SpeechVerificationState[] = ['NOT_VERIFIED'];
    let speechTranscriptStatus: WhisperSpeechTranscriptStatus = 'SPEECH_TRANSCRIPT_UNVERIFIED';
    let speechTranscriptVerified = false;

    if (shouldVerifyCompatibility) {
      const compat = await this.initializeRuntime({
        audioFixturePath: options?.audioFixturePath,
        expectedTranscript: options?.expectedTranscript,
        forceRefresh: options?.forceRefreshCompatibility,
        isSyntheticFixture: options?.isSyntheticFixture,
        trustedManifestPath: options?.trustedManifestPath,
        trustedManifest: options?.trustedManifest,
        trustedPublicKeys: options?.trustedPublicKeys,
        strictAttestationMode: options?.strictAttestationMode
      });
      runtimeExecutionStatus = compat.runtimeExecutionStatus;
      runtimeCompatibilityStatus = compat.runtimeCompatibilityStatus;
      transcriptComparisonStatus = compat.transcriptComparisonStatus;
      humanSpeechProvenanceStatus = compat.humanSpeechProvenanceStatus;
      provenanceTrustTier = compat.provenanceTrustTier;
      verificationStates = compat.verificationStates;
      speechTranscriptStatus = compat.speechTranscriptStatus;
      speechTranscriptVerified = compat.speechTranscriptVerified;
      if (!compat.compatible) {
        return {
          status: 'ANALYSIS_UNAVAILABLE',
          diagnosticCode: compat.diagnosticCode,
          compatibilityVerified: false,
          runtimeCompatible: false,
          runtimeCompatibilityStatus: compat.runtimeCompatibilityStatus,
          runtimeExecutionStatus: compat.runtimeExecutionStatus,
          transcriptComparisonStatus: compat.transcriptComparisonStatus,
          humanSpeechProvenanceStatus: compat.humanSpeechProvenanceStatus,
          provenanceTrustTier: compat.provenanceTrustTier,
          verificationStates: compat.verificationStates,
          speechTranscriptStatus: compat.speechTranscriptStatus,
          speechTranscriptVerified: false,
          failureReason: compat.details,
          limitations: `Whisper runtime compatibility verification failed (${compat.diagnosticCode}).`,
          executionDurationMs: Date.now() - startTime
        };
      }
      compatibilityVerified = true;
    }

    const sttPath = validation.executablePath!;
    const modelPath = validation.modelPath;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_whisper_tx_'));

    try {
      const outPrefix = path.join(tmpDir, 'whisper_out');
      let sttInputPath = videoPath;

      // Build strict runtime-specific CLI argument list with isolated temporary output directory
      let cliArgs: string[];
      if (validation.runtimeType === 'whisper_cpp') {
        if (!modelPath) {
          return {
            status: 'ANALYSIS_UNAVAILABLE',
            diagnosticCode: 'MODEL_NOT_CONFIGURED',
            compatibilityVerified: false,
            runtimeCompatible: false,
            runtimeCompatibilityStatus: 'FAILED',
            runtimeExecutionStatus: 'FAILED',
            transcriptComparisonStatus,
            humanSpeechProvenanceStatus,
            provenanceTrustTier,
            verificationStates,
            speechTranscriptStatus,
            speechTranscriptVerified,
            failureReason: 'whisper_cpp runtime requires a valid WHISPER_MODEL_PATH.',
            limitations: 'Whisper model path missing.',
            executionDurationMs: Date.now() - startTime
          };
        }

        // Convert audio-bearing video inputs (e.g., .mp4, .mov, .mkv) to 16kHz mono 16-bit PCM WAV for real whisper.cpp binaries
        const inputExt = path.extname(videoPath).toLowerCase();
        if (inputExt !== '.wav' && fs.existsSync(videoPath)) {
          let containerHasAudio = false;
          try {
            const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';
            const { stdout: probeOut } = await execFileAsync(
              ffprobeBin,
              ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', videoPath],
              { timeout: 15000 }
            );
            containerHasAudio = String(probeOut || '').trim().length > 0;
          } catch {
            containerHasAudio = false;
          }

          if (containerHasAudio) {
            const wavInputPath = path.join(tmpDir, 'whisper_input_16k.wav');
            const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
            try {
              await execFileAsync(
                ffmpegBin,
                ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavInputPath],
                { timeout: 60000 }
              );
              if (!fs.existsSync(wavInputPath) || fs.statSync(wavInputPath).size < 44) {
                return {
                  status: 'ANALYSIS_UNAVAILABLE',
                  diagnosticCode: 'TRANSCRIPTION_FAILED',
                  compatibilityVerified,
                  runtimeCompatible: compatibilityVerified,
                  runtimeCompatibilityStatus,
                  runtimeExecutionStatus,
                  transcriptComparisonStatus,
                  humanSpeechProvenanceStatus,
                  provenanceTrustTier,
                  verificationStates,
                  speechTranscriptStatus,
                  speechTranscriptVerified,
                  failureReason: 'FFmpeg failed to extract a valid 16kHz mono PCM WAV track for whisper_cpp.',
                  limitations: 'Audio extraction to 16kHz WAV failed prior to local transcription.',
                  executionDurationMs: Date.now() - startTime
                };
              }
              sttInputPath = wavInputPath;
            } catch (ffmpegErr: any) {
              return {
                status: 'ANALYSIS_UNAVAILABLE',
                diagnosticCode: 'TRANSCRIPTION_FAILED',
                compatibilityVerified,
                runtimeCompatible: compatibilityVerified,
                runtimeCompatibilityStatus,
                runtimeExecutionStatus,
                transcriptComparisonStatus,
                humanSpeechProvenanceStatus,
                provenanceTrustTier,
                verificationStates,
                speechTranscriptStatus,
                speechTranscriptVerified,
                failureReason: `FFmpeg failed extracting 16kHz mono PCM WAV for whisper_cpp: ${ffmpegErr?.message || ffmpegErr}`,
                limitations: 'Audio extraction to 16kHz WAV failed prior to local transcription.',
                executionDurationMs: Date.now() - startTime
              };
            }
          }
        }

        cliArgs = ['-m', modelPath, '-f', sttInputPath, '--output-json', '-of', outPrefix];
      } else {
        // Verified openai_whisper CLI
        cliArgs = [videoPath, '--output_format', 'json', '--output_dir', tmpDir];
        if (modelPath) {
          cliArgs.push('--model', modelPath);
        }
      }

      // Execute local STT binary safely without shell expansion inside isolated tmpDir
      const { stdout } = await execFileAsync(sttPath, cliArgs, { timeout: 60000, cwd: tmpDir });
      const elapsed = Date.now() - startTime;

      const baseVideo = path.basename(videoPath, path.extname(videoPath));
      const candidateJsonPaths = [
        `${outPrefix}.json`,
        path.join(tmpDir, `${path.basename(videoPath)}.json`),
        path.join(tmpDir, `${baseVideo}.json`)
      ];

      let rawOutput = '';
      for (const jsonPath of candidateJsonPaths) {
        if (fs.existsSync(jsonPath)) {
          try {
            const content = fs.readFileSync(jsonPath, 'utf-8').trim();
            if (content) {
              rawOutput = content;
              break;
            }
          } catch {
            // Fall through to next candidate or stdout
          }
        }
      }

      if (!rawOutput) {
        rawOutput = (stdout || '').trim();
      }

      if (!rawOutput) {
        return {
          status: 'INSUFFICIENT_EVIDENCE',
          transcriptText: '',
          segments: [],
          diagnosticCode: 'EMPTY_TRANSCRIPTION_OUTPUT',
          compatibilityVerified,
          runtimeCompatible: compatibilityVerified,
          runtimeCompatibilityStatus,
          runtimeExecutionStatus,
          transcriptComparisonStatus,
          humanSpeechProvenanceStatus,
          provenanceTrustTier,
          verificationStates,
          speechTranscriptStatus,
          speechTranscriptVerified,
          failureReason: 'STT executable completed with empty output',
          limitations: 'STT executable produced empty output; cannot verify presence or absence of speech without transcript data.',
          executionDurationMs: elapsed
        };
      }

      let parsed: any = null;
      let isJson = false;

      // Check if output looks like JSON
      if (rawOutput.startsWith('{') || rawOutput.startsWith('[')) {
        try {
          parsed = JSON.parse(rawOutput);
          isJson = true;
        } catch {
          // Output attempted JSON formatting but is malformed
          return {
            status: 'ANALYSIS_UNAVAILABLE',
            diagnosticCode: 'TRANSCRIPTION_FAILED',
            compatibilityVerified,
            runtimeCompatible: compatibilityVerified,
            runtimeCompatibilityStatus,
            runtimeExecutionStatus,
            transcriptComparisonStatus,
            humanSpeechProvenanceStatus,
            provenanceTrustTier,
            verificationStates,
            speechTranscriptStatus,
            speechTranscriptVerified,
            failureReason: 'Malformed JSON output from STT executable',
            limitations: 'STT executable produced invalid JSON structure that could not be parsed.',
            executionDurationMs: elapsed
          };
        }
      }

      if (!isJson) {
        // Plain text transcript output without timestamps
        // CRITICAL: NEVER fabricate a full-duration segment [0, durationSeconds] from plain text
        return {
          status: rawOutput.length > 0 ? 'DETECTED' : 'INSUFFICIENT_EVIDENCE',
          transcriptText: rawOutput,
          segments: [], // Segments MUST remain empty when timestamps are absent
          compatibilityVerified,
          runtimeCompatible: compatibilityVerified,
          runtimeCompatibilityStatus,
          runtimeExecutionStatus,
          transcriptComparisonStatus,
          humanSpeechProvenanceStatus,
          provenanceTrustTier,
          verificationStates,
          speechTranscriptStatus,
          speechTranscriptVerified,
          limitations: 'Plain text transcript returned without segment timestamps; segment-level timestamps are unavailable and were not fabricated.',
          executionDurationMs: elapsed
        };
      }

      // Check if parsed is an object
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          status: 'ANALYSIS_UNAVAILABLE',
          diagnosticCode: 'TRANSCRIPTION_FAILED',
          compatibilityVerified,
          runtimeCompatible: compatibilityVerified,
          runtimeCompatibilityStatus,
          runtimeExecutionStatus,
          transcriptComparisonStatus,
          humanSpeechProvenanceStatus,
          provenanceTrustTier,
          verificationStates,
          speechTranscriptStatus,
          speechTranscriptVerified,
          failureReason: 'STT executable returned invalid JSON structure (expected JSON object)',
          limitations: 'STT JSON output did not contain an object payload.',
          executionDurationMs: elapsed
        };
      }

      // Support both OpenAI Whisper (`segments`) and whisper.cpp (`transcription`) JSON payloads
      const hasSegmentsArray = Array.isArray(parsed.segments);
      const hasCppTranscriptionArray = Array.isArray(parsed.transcription);

      if (typeof parsed.text !== 'string' && !hasSegmentsArray && !hasCppTranscriptionArray) {
        return {
          status: 'ANALYSIS_UNAVAILABLE',
          diagnosticCode: 'TRANSCRIPTION_FAILED',
          compatibilityVerified,
          runtimeCompatible: compatibilityVerified,
          runtimeCompatibilityStatus,
          runtimeExecutionStatus,
          transcriptComparisonStatus,
          humanSpeechProvenanceStatus,
          provenanceTrustTier,
          verificationStates,
          speechTranscriptStatus,
          speechTranscriptVerified,
          failureReason: 'STT JSON output missing text, segments, and transcription fields',
          limitations: 'STT executable output did not contain usable text or segments fields.',
          executionDurationMs: elapsed
        };
      }

      const parseWhisperCppTimestamp = (ts: unknown): number => {
        if (typeof ts === 'number') return ts;
        if (typeof ts !== 'string') return NaN;
        const m = ts.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
        if (!m) return parseFloat(ts);
        const hrs = parseInt(m[1], 10);
        const mins = parseInt(m[2], 10);
        const secs = parseInt(m[3], 10);
        const ms = parseInt(m[4].padEnd(3, '0'), 10);
        return hrs * 3600 + mins * 60 + secs + ms / 1000;
      };

      const rawSegments = hasSegmentsArray
        ? parsed.segments
        : hasCppTranscriptionArray
          ? parsed.transcription.map((item: any) => ({
              start: typeof item?.offsets?.from === 'number'
                ? item.offsets.from / 1000
                : parseWhisperCppTimestamp(item?.timestamps?.from),
              end: typeof item?.offsets?.to === 'number'
                ? item.offsets.to / 1000
                : parseWhisperCppTimestamp(item?.timestamps?.to),
              text: item?.text,
              confidence: item?.confidence
            }))
          : [];

      const validSegments: Array<{ start: number; end: number; text: string; confidence?: number }> = [];
      let rejectedTimestampsCount = 0;

      for (const s of rawSegments) {
        const start = typeof s?.start === 'number' ? s.start : parseFloat(s?.start);
        const end = typeof s?.end === 'number' ? s.end : parseFloat(s?.end);
        const text = String(s?.text || '').trim();

        // Validate finite, non-negative, ordered (start < end), and within media duration
        if (
          !Number.isFinite(start) || 
          !Number.isFinite(end) || 
          start < 0 || 
          end <= start || 
          start >= durationSeconds + 0.1
        ) {
          rejectedTimestampsCount++;
          continue;
        }

        const clampedEnd = Math.min(parseFloat(end.toFixed(2)), durationSeconds);
        const clampedStart = parseFloat(start.toFixed(2));

        if (clampedStart < clampedEnd) {
          validSegments.push({
            start: clampedStart,
            end: clampedEnd,
            text,
            confidence: typeof s?.confidence === 'number' && Number.isFinite(s.confidence) ? s.confidence : undefined
          });
        }
      }

      const transcriptText = typeof parsed.text === 'string' 
        ? parsed.text.trim() 
        : validSegments.map(s => s.text).join(' ').trim();

      let limitationNotes = 'Transcribed via local STT executable; automated transcripts may contain phonetic inaccuracies.';
      if (rejectedTimestampsCount > 0) {
        limitationNotes += ` Note: ${rejectedTimestampsCount} invalid or out-of-order segment timestamp(s) were rejected.`;
      }

      let status: DetectorExecutionStatus;
      let failureReason: string | undefined;

      if (validSegments.length > 0 || transcriptText.length > 0) {
        status = 'DETECTED';
      } else if (rawSegments.length > 0 && validSegments.length === 0) {
        status = 'INSUFFICIENT_EVIDENCE';
        failureReason = 'All reported segment timestamps were invalid or out of bounds.';
        limitationNotes += ' All reported segment timestamps were invalid or out of bounds.';
      } else {
        status = 'NO_SIGNAL_DETECTED';
      }

      return {
        status,
        transcriptText,
        segments: validSegments,
        compatibilityVerified,
        runtimeCompatible: compatibilityVerified,
        runtimeCompatibilityStatus,
        runtimeExecutionStatus,
        transcriptComparisonStatus,
        humanSpeechProvenanceStatus,
        provenanceTrustTier,
        verificationStates,
        speechTranscriptStatus,
        speechTranscriptVerified,
        ...(failureReason ? { failureReason } : {}),
        limitations: limitationNotes,
        executionDurationMs: elapsed
      };
    } catch (err: any) {
      const classified = this.classifyWhisperProcessError(err, 60000);
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        diagnosticCode: classified.diagnosticCode,
        compatibilityVerified,
        runtimeCompatible: compatibilityVerified,
        runtimeCompatibilityStatus,
        runtimeExecutionStatus,
        transcriptComparisonStatus,
        humanSpeechProvenanceStatus,
        provenanceTrustTier,
        verificationStates,
        speechTranscriptStatus,
        speechTranscriptVerified,
        failureReason: `Local STT process execution failed [${classified.diagnosticCode}]: ${classified.details}`,
        limitations: 'Speech transcription failed during local execution.',
        executionDurationMs: Date.now() - startTime
      };
    } finally {
      try {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore temp cleanup failures
      }
    }
  }
}

export interface LocalMusicClassificationResult {
  status: DetectorExecutionStatus;
  hasMusic: boolean | null;
  confidence?: number;
  segments?: Array<{ start: number; end: number; confidence?: number }>;
  failureReason?: string;
  limitations: string;
  executionDurationMs: number;
}

/**
 * Adapter for optional local Music Classification.
 * Checks dependency availability (MUSIC_CLASSIFIER_PATH).
 * Never assumes unassessed audio is music-free; distinguishes NOT_ASSESSED,
 * ANALYSIS_UNAVAILABLE, INSUFFICIENT_EVIDENCE, DETECTED, and NO_SIGNAL_DETECTED.
 */
export class MusicClassificationAdapter {
  public async classify(videoPath: string, durationSeconds: number): Promise<LocalMusicClassificationResult> {
    const startTime = Date.now();
    const classifierPath = process.env.MUSIC_CLASSIFIER_PATH;

    if (!classifierPath) {
      return {
        status: 'NOT_ASSESSED',
        hasMusic: null,
        limitations: 'Music detection and classification model (MUSIC_CLASSIFIER_PATH) not configured in local environment; music presence is unverified.',
        executionDurationMs: 0
      };
    }

    if (!fs.existsSync(classifierPath)) {
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        hasMusic: null,
        failureReason: `Configured music classifier executable not found at ${classifierPath}`,
        limitations: 'Music classifier path was configured but executable is missing on disk.',
        executionDurationMs: Date.now() - startTime
      };
    }

    try {
      const { stdout } = await execFileAsync(classifierPath, [videoPath, '--format', 'json'], { timeout: 60000 });
      const elapsed = Date.now() - startTime;
      const rawOutput = (stdout || '').trim();

      if (!rawOutput) {
        return {
          status: 'INSUFFICIENT_EVIDENCE',
          hasMusic: null,
          failureReason: 'Music classifier completed with empty output',
          limitations: 'Music classifier completed with empty output; cannot confirm presence or absence of music.',
          executionDurationMs: elapsed
        };
      }

      let parsed: any;
      try {
        parsed = JSON.parse(rawOutput);
      } catch {
        return {
          status: 'ANALYSIS_UNAVAILABLE',
          hasMusic: null,
          failureReason: 'Malformed JSON output from music classifier executable',
          limitations: 'Music classifier returned non-JSON output.',
          executionDurationMs: elapsed
        };
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          status: 'ANALYSIS_UNAVAILABLE',
          hasMusic: null,
          failureReason: 'Music classifier output must be a JSON object',
          limitations: 'Music classifier returned non-object JSON structure.',
          executionDurationMs: elapsed
        };
      }

      if (typeof parsed.hasMusic !== 'boolean') {
        return {
          status: 'ANALYSIS_UNAVAILABLE',
          hasMusic: null,
          failureReason: 'Malformed or missing hasMusic boolean field in classifier output',
          limitations: 'Music classifier output did not contain a valid boolean hasMusic property.',
          executionDurationMs: elapsed
        };
      }

      const hasMusic: boolean = parsed.hasMusic;
      const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : undefined;

      const segments = Array.isArray(parsed.segments)
        ? parsed.segments
            .filter((s: any) => Number.isFinite(s?.start) && Number.isFinite(s?.end) && s.start >= 0 && s.end > s.start && s.start < durationSeconds)
            .map((s: any) => ({
              start: parseFloat(s.start.toFixed(2)),
              end: Math.min(durationSeconds, parseFloat(s.end.toFixed(2))),
              confidence: typeof s?.confidence === 'number' && Number.isFinite(s.confidence) ? Math.max(0, Math.min(1, s.confidence)) : undefined
            }))
        : [];

      return {
        status: hasMusic ? 'DETECTED' : 'NO_SIGNAL_DETECTED',
        hasMusic,
        ...(confidence !== undefined ? { confidence } : {}),
        segments,
        limitations: 'Classified via local music classifier model. Does not query external copyright registries or YouTube Content ID.',
        executionDurationMs: elapsed
      };
    } catch (err: any) {
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        hasMusic: null,
        failureReason: `Local music classifier process execution failed: ${err?.message || err}`,
        limitations: 'Music classification failed during execution.',
        executionDurationMs: Date.now() - startTime
      };
    }
  }
}

/**
 * Radix-2 Cooley-Tukey In-Place Fast Fourier Transform for spectral audio analysis.
 */
function computeFFT(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 0, j = 0; i < n; i++) {
    if (j > i) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let s = 2; s <= n; s <<= 1) {
    const half = s >> 1;
    const wStep = -2 * Math.PI / s;
    for (let i = 0; i < n; i += s) {
      for (let j = 0; j < half; j++) {
        const theta = j * wStep;
        const c = Math.cos(theta), sn = Math.sin(theta);
        const vR = real[i + j + half] * c - imag[i + j + half] * sn;
        const vI = real[i + j + half] * sn + imag[i + j + half] * c;
        real[i + j + half] = real[i + j] - vR;
        imag[i + j + half] = imag[i + j] - vI;
        real[i + j] += vR;
        imag[i + j] += vI;
      }
    }
  }
}

/**
 * 16 logarithmically/perceptually-spaced frequency subbands from 0 to 4000 Hz for 8kHz audio.
 */
const SPECTRAL_BANDS_8KHZ: Array<[number, number]> = [
  [0, 200], [200, 400], [400, 600], [600, 800],
  [800, 1000], [1000, 1250], [1250, 1500], [1500, 1750],
  [1750, 2000], [2000, 2300], [2300, 2600], [2600, 2900],
  [2900, 3200], [3200, 3500], [3500, 3800], [3800, 4000]
];

/**
 * Computes a normalized 16-band spectral energy profile for a window of 8000Hz PCM samples.
 */
function extractSubbandSpectralProfile(pcmBuffer: Buffer, startByte: number, lengthBytes: number): Float64Array {
  const profile = new Float64Array(SPECTRAL_BANDS_8KHZ.length);
  const totalSamples = Math.floor(lengthBytes / 2);
  const winSize = 512;
  const numWins = Math.floor(totalSamples / winSize);
  if (numWins <= 0) return profile;

  const binWidth = 8000 / winSize;
  const real = new Float64Array(winSize);
  const imag = new Float64Array(winSize);

  for (let w = 0; w < numWins; w++) {
    const winOffset = startByte + w * winSize * 2;
    for (let i = 0; i < winSize; i++) {
      // Periodic Hann window
      const h = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winSize - 1)));
      real[i] = pcmBuffer.readInt16LE(winOffset + i * 2) * h;
      imag[i] = 0;
    }
    computeFFT(real, imag);
    for (let b = 0; b < SPECTRAL_BANDS_8KHZ.length; b++) {
      const [fLow, fHigh] = SPECTRAL_BANDS_8KHZ[b];
      const startBin = Math.max(1, Math.floor(fLow / binWidth));
      const endBin = Math.min(winSize / 2 - 1, Math.ceil(fHigh / binWidth));
      for (let k = startBin; k <= endBin; k++) {
        profile[b] += (real[k] * real[k] + imag[k] * imag[k]);
      }
    }
  }

  let sumSq = 0;
  for (let b = 0; b < profile.length; b++) sumSq += profile[b] * profile[b];
  const norm = Math.sqrt(sumSq) || 1;
  for (let b = 0; b < profile.length; b++) profile[b] /= norm;
  return profile;
}

/**
 * Verifiable processing bounds for audio pipeline extraction and repetition analysis.
 *
 * SIZING RATIONALE:
 * - maxAudioChunks (1800): Corresponds to 30 minutes of 1-second chunks (approx. 360 KB heap memory for signatures).
 *   Derived from existing pipeline tests requiring verification of 1024-second streams without buffer overflow.
 * - maxCandidatePairs (50,000): Upper bound on candidate pairs evaluated after silence/gap filtering.
 * - maxPairComparisons (30,000): Hard execution cap on pairwise spectral/acoustic calculations.
 *
 * NOTE: These are engineering safety limits designed to prevent runaway nested-loop execution.
 * They are NOT claimed to be globally optimal runtime bounds for all production topologies.
 */
export interface AudioAnalysisBounds {
  /** Maximum audio chunks extracted and retained in memory. */
  maxAudioChunks: number;
  /** Maximum candidate pairs considered (after silence and minimum gap filters). */
  maxCandidatePairs: number;
  /** Maximum acoustic pairwise comparisons actually executed (spectral/RMS/ZCR correlation). */
  maxPairComparisons: number;
}

export const DEFAULT_AUDIO_ANALYSIS_BOUNDS: AudioAnalysisBounds = Object.freeze({
  maxAudioChunks: 1800,
  maxCandidatePairs: 50000,
  maxPairComparisons: 30000
});

/**
 * Sanitizes caller-provided bounds to strictly prevent zero, negative, NaN,
 * infinite, or malformed inputs from bypassing processing limits or causing unbounded loops.
 */
export function sanitizeAudioAnalysisBounds(raw?: Partial<AudioAnalysisBounds>): AudioAnalysisBounds {
  const sanitizeInt = (val: any, fallback: number, min: number = 1): number => {
    if (typeof val === 'number' && Number.isFinite(val) && !Number.isNaN(val) && val >= min) {
      return Math.floor(val);
    }
    return fallback;
  };

  return {
    maxAudioChunks: sanitizeInt(raw?.maxAudioChunks, DEFAULT_AUDIO_ANALYSIS_BOUNDS.maxAudioChunks, 1),
    maxCandidatePairs: sanitizeInt(raw?.maxCandidatePairs, DEFAULT_AUDIO_ANALYSIS_BOUNDS.maxCandidatePairs, 1),
    maxPairComparisons: sanitizeInt(raw?.maxPairComparisons, DEFAULT_AUDIO_ANALYSIS_BOUNDS.maxPairComparisons, 1)
  };
}

export interface RepeatedAudioMatch {
  start: number;
  end: number;
  matchWithTimestamp: number;
  matchEndTimestamp?: number;
  similarity: number;
}

export interface RepeatedAudioAnalysisDetails {
  candidatePairsConsidered: number;
  pairComparisonsPerformed: number;
  budgetExceeded: boolean;
  limitReached?: 'CHUNK_LIMIT' | 'CANDIDATE_PAIR_LIMIT' | 'PAIR_COMPARISON_LIMIT';
  chunksEvaluated: number;
  totalChunks: number;
}

export interface AudioChunkSignature {
  sec: number;             // Start timestamp in seconds
  duration: number;        // Duration in seconds (1.0 or >= 0.5 for trailing partial chunk)
  rms: number;             // Root-Mean-Square energy amplitude
  zcr: number;             // Normalized Zero-Crossing Rate per second
  spectralProfile: Float64Array; // 16-band normalized energy profile
}

export interface PcmExtractionResult {
  status: 'SUCCESS' | 'INSUFFICIENT_EVIDENCE' | 'ANALYSIS_UNAVAILABLE';
  totalAudioSeconds: number;
  chunkSignatures: AudioChunkSignature[];
  failureReason?: string;
  limitations?: string;
  isTruncated?: boolean;
  chunksLimitExceeded?: boolean;
  totalChunksExtracted?: number;
}

/**
 * Merges contiguous matching repeated audio intervals while strictly preventing
 * false merging of disjoint intervals or differing repetition offsets.
 */
export function mergeContiguousAudioSegments(
  rawMatches: Array<{
    start: number;
    end: number;
    matchWithTimestamp: number;
    matchEndTimestamp?: number;
    similarity: number;
  }>
): Array<{
  start: number;
  end: number;
  matchWithTimestamp: number;
  similarity: number;
}> {
  if (rawMatches.length === 0) return [];

  // Sort by start timestamp ascending
  const sorted = [...rawMatches].sort((a, b) => a.start - b.start);
  const merged: Array<{
    start: number;
    end: number;
    matchWithTimestamp: number;
    similarity: number;
    _count: number;
    _totalSim: number;
  }> = [];

  for (const m of sorted) {
    if (merged.length === 0) {
      merged.push({
        start: m.start,
        end: m.end,
        matchWithTimestamp: m.matchWithTimestamp,
        similarity: m.similarity,
        _count: 1,
        _totalSim: m.similarity
      });
      continue;
    }

    const prev = merged[merged.length - 1];
    // Check contiguous adjacency:
    // prev.end matches m.start (within 0.05s tolerance for floating point rounding)
    // AND match offset (target - source) is consistent within 0.05s
    const isAdjacent = Math.abs(prev.end - m.start) <= 0.05;
    const prevOffset = prev.matchWithTimestamp - prev.start;
    const currOffset = m.matchWithTimestamp - m.start;
    const isConsistentMatchOffset = Math.abs(prevOffset - currOffset) <= 0.05;

    if (isAdjacent && isConsistentMatchOffset) {
      // Merge into prev interval
      prev.end = m.end;
      prev._count += 1;
      prev._totalSim += m.similarity;
      prev.similarity = parseFloat((prev._totalSim / prev._count).toFixed(3));
    } else {
      // Disjoint or different match interval - keep separate to prevent false merging
      merged.push({
        start: m.start,
        end: m.end,
        matchWithTimestamp: m.matchWithTimestamp,
        similarity: m.similarity,
        _count: 1,
        _totalSim: m.similarity
      });
    }
  }

  return merged.map(({ start, end, matchWithTimestamp, similarity }) => ({
    start: parseFloat(start.toFixed(2)),
    end: parseFloat(end.toFixed(2)),
    matchWithTimestamp: parseFloat(matchWithTimestamp.toFixed(2)),
    similarity
  }));
}

/**
 * Within-Video Repeated Audio Detection with verifiable processing bounds and detailed telemetry.
 *
 * SCORE SEMANTICS & DEFINITIONS:
 * A. Heuristic Weights (0.60, 0.25, 0.15):
 *    - Linear weighting factors used to combine 16-band spectral subband cosine correlation (0.60),
 *      RMS energy amplitude delta (0.25), and Zero-Crossing Rate delta (0.15).
 *    - These are deterministic engineering weights, NOT probabilities and NOT confidence ratings.
 * B. Similarity Scores (compositeSimilarity):
 *    - A deterministic value in [0, 1] measuring acoustic waveform & spectral profile resemblance.
 *    - Similarity measures how closely two audio chunks sound alike. It does NOT represent statistical
 *      confidence or legal copyright identity.
 * C. Confidence:
 *    - Maintained in DetectorReport / EvidenceItem to express detector assessment confidence.
 *    - Never conflated with similarity score. When execution is truncated by processing bounds,
 *      confidence is NOT claimed as high.
 */
export function detectRepeatedAudioDetailed(
  chunkSignatures: AudioChunkSignature[],
  durationSeconds: number,
  minAudioGapSeconds: number = 2.0,
  options?: { bounds?: Partial<AudioAnalysisBounds> }
): {
  matches: RepeatedAudioMatch[];
  details: RepeatedAudioAnalysisDetails;
} {
  const bounds: AudioAnalysisBounds = sanitizeAudioAnalysisBounds(options?.bounds);

  const totalChunks = chunkSignatures.length;
  const chunksToEvaluate = totalChunks > bounds.maxAudioChunks
    ? chunkSignatures.slice(0, bounds.maxAudioChunks)
    : chunkSignatures;

  let candidatePairsConsidered = 0;
  let pairComparisonsPerformed = 0;
  let budgetExceeded = totalChunks > bounds.maxAudioChunks;
  let limitReached: RepeatedAudioAnalysisDetails['limitReached'] = budgetExceeded ? 'CHUNK_LIMIT' : undefined;

  const rawMatches: Array<{
    start: number;
    end: number;
    matchWithTimestamp: number;
    matchEndTimestamp: number;
    similarity: number;
  }> = [];

  outerLoop: for (let i = 0; i < chunksToEvaluate.length; i++) {
    const c1 = chunksToEvaluate[i];
    if (c1.rms < 150) continue; // Skip near-silent intervals

    for (let j = i + 1; j < chunksToEvaluate.length; j++) {
      // Check candidate pair budget before computing gap
      if (candidatePairsConsidered >= bounds.maxCandidatePairs) {
        budgetExceeded = true;
        limitReached = limitReached || 'CANDIDATE_PAIR_LIMIT';
        break outerLoop;
      }

      const c2 = chunksToEvaluate[j];
      if (c2.rms < 150) continue;

      // Real media gap calculation:
      // Interval 1: [c1.sec, c1.sec + c1.duration]
      // Interval 2: [c2.sec, c2.sec + c2.duration]
      const c1End = c1.sec + c1.duration;
      const c2Start = c2.sec;
      const realGap = parseFloat((c2Start - c1End).toFixed(3));

      // Enforce configured minimum gap in real time units (seconds)
      if (realGap < minAudioGapSeconds) {
        continue;
      }

      // Candidate pair passed silence and minimum gap filters
      candidatePairsConsidered++;

      // Check pair comparison budget before expensive spectral and acoustic calculation
      if (pairComparisonsPerformed >= bounds.maxPairComparisons) {
        budgetExceeded = true;
        limitReached = limitReached || 'PAIR_COMPARISON_LIMIT';
        break outerLoop;
      }

      // Execute actual acoustic & spectral comparison between candidate chunks
      pairComparisonsPerformed++;

      let spectralSim = 0;
      for (let b = 0; b < 16; b++) {
        spectralSim += c1.spectralProfile[b] * c2.spectralProfile[b];
      }

      const rmsDelta = Math.abs(c1.rms - c2.rms) / Math.max(c1.rms, c2.rms);
      const zcrDelta = Math.abs(c1.zcr - c2.zcr) / Math.max(1, Math.max(c1.zcr, c2.zcr));

      // Match criteria:
      // 1. Spectral subband correlation >= 0.88
      // 2. RMS energy amplitude delta <= 25%
      // 3. Zero-crossing rate delta <= 20%
      if (spectralSim >= 0.88 && rmsDelta <= 0.25 && zcrDelta <= 0.20) {
        // Heuristic weights: 0.60 spectral + 0.25 RMS + 0.15 ZCR -> deterministic composite similarity
        const compositeSimilarity = parseFloat((0.60 * spectralSim + 0.25 * Math.max(0, 1 - rmsDelta) + 0.15 * Math.max(0, 1 - zcrDelta)).toFixed(3));
        const startSec = parseFloat(c1.sec.toFixed(2));
        const endSec = parseFloat(Math.min(c1.sec + c1.duration, durationSeconds).toFixed(2));
        const matchTimestamp = parseFloat(c2.sec.toFixed(2));
        const matchEndTimestamp = parseFloat(Math.min(c2.sec + c2.duration, durationSeconds).toFixed(2));

        if (startSec < endSec && endSec <= durationSeconds && matchTimestamp <= durationSeconds && matchEndTimestamp <= durationSeconds) {
          rawMatches.push({
            start: startSec,
            end: endSec,
            matchWithTimestamp: matchTimestamp,
            matchEndTimestamp,
            similarity: compositeSimilarity
          });
          break; // Record one match per source segment to avoid combinatorial explosion
        }
      }
    }
  }

  const mergedMatches = mergeContiguousAudioSegments(rawMatches);

  return {
    matches: mergedMatches,
    details: {
      candidatePairsConsidered,
      pairComparisonsPerformed,
      budgetExceeded,
      limitReached,
      chunksEvaluated: chunksToEvaluate.length,
      totalChunks
    }
  };
}

/**
 * Within-Video Repeated Audio Detection using real media timestamp gaps.
 * Detects non-adjacent audio segments with matching acoustic signatures and 16-band spectral profiles.
 * Preserves backward compatibility by returning an array while attaching telemetry details.
 */
export function detectRepeatedAudio(
  chunkSignatures: AudioChunkSignature[],
  durationSeconds: number,
  minAudioGapSeconds: number = 2.0,
  options?: { bounds?: Partial<AudioAnalysisBounds> }
): Array<{
  start: number;
  end: number;
  matchWithTimestamp: number;
  similarity: number;
}> & { details?: RepeatedAudioAnalysisDetails } {
  const result = detectRepeatedAudioDetailed(chunkSignatures, durationSeconds, minAudioGapSeconds, options);
  const arr = result.matches as Array<{
    start: number;
    end: number;
    matchWithTimestamp: number;
    similarity: number;
  }> & { details?: RepeatedAudioAnalysisDetails };
  arr.details = result.details;
  return arr;
}

export class AudioProcessor {
  private transcriptionAdapter = new SpeechTranscriptionAdapter();
  private musicAdapter = new MusicClassificationAdapter();

  /**
   * Bounded extraction of raw 8kHz mono 16-bit PCM audio stream into 1-second and trailing
   * partial chunk signatures using bounded temporary storage and streaming file reads.
   *
   * MEMORY ARCHITECTURE & WORKLOAD BOUNDS:
   * 1. File I/O Read Buffer:
   *    - Bounded to a single chunk buffer of 16,000 bytes (16 KB) for sequential streaming reads.
   *    - The entire raw PCM file is never loaded into a single Node.js Buffer at once.
   * 2. In-Memory Signature Storage:
   *    - Memory consumption is NOT O(1) across the entire pipeline.
   *    - Each extracted chunk allocates an AudioChunkSignature object (~200 bytes, including Float64Array(16)).
   *    - Accumulation is explicitly capped at maxAudioChunks (default: 1800 chunks, ~360 KB heap memory for signatures).
   *    - Once maxAudioChunks is reached, chunk extraction halts to strictly enforce memory and compute bounds.
   * 3. Pairwise Comparison Workload:
   *    - All-pairs comparison across N chunks is O(N^2) in the worst case (N*(N-1)/2 pairs).
   *    - Workload is explicitly bounded by maxCandidatePairs (default: 50,000) and maxPairComparisons (default: 30,000).
   * 4. Unmeasured Memory Usage:
   *    - External FFmpeg sub-process memory and OS disk I/O caching during PCM extraction are managed by the OS kernel
   *      and process execution timeout, not JavaScript V8 heap bounds.
   */
  public async extractPcmAudio(
    videoPath: string,
    durationSeconds: number,
    options?: { timeoutMs?: number; ffmpegBinary?: string; bounds?: Partial<AudioAnalysisBounds> }
  ): Promise<PcmExtractionResult> {
    if (!fs.existsSync(videoPath)) {
      return {
        status: 'ANALYSIS_UNAVAILABLE',
        totalAudioSeconds: 0,
        chunkSignatures: [],
        failureReason: `Video media file not found at ${path.basename(videoPath)}`,
        limitations: 'Media file does not exist on disk.'
      };
    }

    const ffmpegBin = options?.ffmpegBinary || 'ffmpeg';
    const timeoutMs = options?.timeoutMs || 45000;
    const tempPcmPath = path.resolve(os.tmpdir(), `vr_pcm_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.raw`);

    try {
      try {
        await execFileAsync(ffmpegBin, [
          '-y',
          '-i', videoPath,
          '-vn',
          '-ac', '1',
          '-ar', '8000',
          '-f', 's16le',
          tempPcmPath
        ], { timeout: timeoutMs });
      } catch (procErr: any) {
        const isTimeout = procErr?.killed || procErr?.signal === 'SIGTERM' || procErr?.message?.includes('timed out');
        const isMissingBin = procErr?.code === 'ENOENT';
        const rawMsg = procErr?.message || String(procErr);
        const sanitizedMsg = rawMsg.replace(new RegExp(tempPcmPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[temp_pcm]');

        const reason = isMissingBin
          ? 'FFmpeg executable not found or inaccessible for PCM extraction'
          : isTimeout
            ? `PCM audio extraction timed out after ${timeoutMs}ms`
            : `FFmpeg PCM audio extraction process failed: ${sanitizedMsg}`;

        return {
          status: 'ANALYSIS_UNAVAILABLE',
          totalAudioSeconds: 0,
          chunkSignatures: [],
          failureReason: reason,
          limitations: 'PCM extraction failed during local FFmpeg execution.'
        };
      }

      if (!fs.existsSync(tempPcmPath)) {
        return {
          status: 'ANALYSIS_UNAVAILABLE',
          totalAudioSeconds: 0,
          chunkSignatures: [],
          failureReason: 'FFmpeg process completed but PCM output file was not created',
          limitations: 'PCM output file missing after extraction.'
        };
      }

      const stats = fs.statSync(tempPcmPath);
      const totalBytes = stats.size;

      if (totalBytes === 0) {
        return {
          status: 'INSUFFICIENT_EVIDENCE',
          totalAudioSeconds: 0,
          chunkSignatures: [],
          failureReason: 'Extracted PCM audio output is empty (0 bytes)',
          limitations: 'Audio stream yielded zero bytes of PCM data.'
        };
      }

      const bytesPerSec = 16000;
      const totalAudioSeconds = parseFloat((totalBytes / bytesPerSec).toFixed(3));
      const maxChunks = sanitizeAudioAnalysisBounds(options?.bounds).maxAudioChunks;

      // Bounded buffer streaming: read 1-second chunks (16,000 bytes) one at a time
      const fd = fs.openSync(tempPcmPath, 'r');
      const chunkSignatures: AudioChunkSignature[] = [];
      let chunksLimitExceeded = false;

      try {
        const chunkBuf = Buffer.alloc(bytesPerSec);
        let offset = 0;
        let sec = 0;

        while (offset + bytesPerSec <= totalBytes) {
          // Pre-allocation bounds check: prevent unbounded memory accumulation
          if (sec >= maxChunks) {
            chunksLimitExceeded = true;
            break;
          }

          const bytesRead = fs.readSync(fd, chunkBuf, 0, bytesPerSec, offset);
          if (bytesRead < bytesPerSec) break;

          let sumSq = 0;
          let zcr = 0;
          let prevVal = chunkBuf.readInt16LE(0);

          for (let i = 1; i < 8000; i++) {
            const val = chunkBuf.readInt16LE(i * 2);
            sumSq += val * val;
            if ((val >= 0 && prevVal < 0) || (val < 0 && prevVal >= 0)) {
              zcr++;
            }
            prevVal = val;
          }

          const rms = Math.sqrt(sumSq / 8000);
          const spectralProfile = extractSubbandSpectralProfile(chunkBuf, 0, bytesPerSec);
          chunkSignatures.push({
            sec,
            duration: 1.0,
            rms,
            zcr,
            spectralProfile
          });

          offset += bytesPerSec;
          sec += 1;
        }

        // Handle trailing partial audio chunk if >= 0.5s and within maxChunks budget
        const remainderBytes = totalBytes - offset;
        const remainderSec = parseFloat((remainderBytes / bytesPerSec).toFixed(3));

        if (!chunksLimitExceeded && sec < maxChunks && remainderSec >= 0.5) {
          const remainderBuf = Buffer.alloc(remainderBytes);
          fs.readSync(fd, remainderBuf, 0, remainderBytes, offset);
          const numSamples = Math.floor(remainderBytes / 2);

          let sumSq = 0;
          let rawZcr = 0;
          let prevVal = remainderBuf.readInt16LE(0);

          for (let i = 1; i < numSamples; i++) {
            const val = remainderBuf.readInt16LE(i * 2);
            sumSq += val * val;
            if ((val >= 0 && prevVal < 0) || (val < 0 && prevVal >= 0)) {
              rawZcr++;
            }
            prevVal = val;
          }

          const rms = Math.sqrt(sumSq / numSamples);
          const zcr = (rawZcr / numSamples) * 8000; // Normalized to 1-second rate
          const spectralProfile = extractSubbandSpectralProfile(remainderBuf, 0, remainderBytes);

          chunkSignatures.push({
            sec,
            duration: remainderSec,
            rms,
            zcr,
            spectralProfile
          });
        }
      } finally {
        fs.closeSync(fd);
      }

      if (totalAudioSeconds < 2.0) {
        return {
          status: 'INSUFFICIENT_EVIDENCE',
          totalAudioSeconds,
          chunkSignatures,
          failureReason: 'Audio stream duration is under 2.0 seconds; insufficient timeline for repetition comparison.',
          limitations: 'Less than 2.0 seconds of audio data extracted; cannot perform non-adjacent repetition analysis.'
        };
      }

      const limitationsText = chunksLimitExceeded
        ? `Raw PCM audio extracted with bounded chunk limit (${chunkSignatures.length} chunks extracted of ${Math.ceil(totalAudioSeconds)} total seconds; trailing audio unextracted).`
        : 'Raw PCM audio successfully extracted and signature profiles computed.';

      return {
        status: 'SUCCESS',
        totalAudioSeconds,
        chunkSignatures,
        isTruncated: chunksLimitExceeded,
        chunksLimitExceeded,
        totalChunksExtracted: chunkSignatures.length,
        limitations: limitationsText
      };
    } finally {
      try {
        if (fs.existsSync(tempPcmPath)) {
          fs.unlinkSync(tempPcmPath);
        }
      } catch {
        // Safe disposal
      }
    }
  }

  /**
   * Processes audio stream using:
   * 1. FFmpeg silencedetect & volumedetect
   * 2. Acoustic energy modulation & Zero-Crossing Rate (ZCR) signal analysis
   * 3. Within-video non-adjacent repeated audio segment detection
   * 4. Optional local speech-to-text adapter
   */
  public async analyzeAudio(
    videoPath: string,
    metadataOrDuration: MediaMetadata | number,
    options?: { bounds?: Partial<AudioAnalysisBounds> }
  ): Promise<AudioAnalysisResult> {
    const startTime = Date.now();

    if (!fs.existsSync(videoPath)) {
      throw new AudioProcessingError(`Audio/video file not found at ${videoPath}`);
    }

    const durationSeconds = typeof metadataOrDuration === 'number'
      ? metadataOrDuration
      : metadataOrDuration.durationSeconds;
    const hasAudio = typeof metadataOrDuration === 'number'
      ? true
      : metadataOrDuration.hasAudio;

    if (!hasAudio) {
      return {
        hasVoiceover: false,
        voiceoverRatio: 0,
        silenceRatio: 1,
        hasMusicDetected: null,
        meanVolumeDb: undefined,
        isAudible: false,
        advertiserSpeechFlags: [],
        segments: [{ start: 0, end: durationSeconds, type: 'silence' }],
        transcriptSummary: 'No audio stream detected in container.',
        speechAnalysisStatus: 'NOT_PROVIDED',
        musicAnalysisStatus: 'NOT_PROVIDED',
        speechDetectionStatus: 'NOT_PROVIDED',
        transcriptionStatus: 'NOT_PROVIDED',
        repeatedAudioStatus: 'NOT_PROVIDED',
        detectors: {
          audio_silence_volume: {
            detectorName: 'ffmpeg_silence_and_volume',
            version: '1.0.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No audio stream detected in container.'
          },
          audio_speech_activity: {
            detectorName: 'acoustic_energy_modulation',
            version: '1.0.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No audio stream detected in container.'
          },
          audio_music_detection: {
            detectorName: 'music_classification_analyzer',
            version: '1.0.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No audio stream detected in container.'
          },
          audio_repeated_segments: {
            detectorName: 'subband_spectral_audio_fingerprint',
            version: '1.1.0',
            status: 'NOT_PROVIDED',
            executionDurationMs: 0,
            limitations: 'No audio stream detected in container.'
          }
        }
      };
    }

    try {
      const args = [
        '-i', videoPath,
        '-af', 'silencedetect=noise=-30dB:d=1.5,volumedetect',
        '-f', 'null',
        '-'
      ];

      // ffmpeg writes filter output and telemetry to stderr
      let output = '';
      try {
        const { stdout, stderr } = await execFileAsync('ffmpeg', args, { timeout: 30000 });
        output = (stdout || '') + (stderr || '');
      } catch (procErr: any) {
        // Fail closed: Never treat partial output from a failed FFmpeg process as a successful measurement
        throw new AudioProcessingError(`FFmpeg audio analysis failed: ${procErr?.message || procErr}`);
      }

      const dur = durationSeconds;
      if (!Number.isFinite(dur) || dur <= 0) {
        throw new AudioProcessingError(`FFmpeg audio analysis failed: invalid or non-finite duration (${dur})`);
      }

      // Look for volume level indicators - fail closed if missing or malformed
      const meanVolumeMatch = output.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
      if (!meanVolumeMatch) {
        throw new AudioProcessingError('FFmpeg audio analysis failed: missing mean_volume measurement in output');
      }

      const meanVol = parseFloat(meanVolumeMatch[1]);
      if (!Number.isFinite(meanVol)) {
        throw new AudioProcessingError(`FFmpeg audio analysis failed: malformed non-finite mean_volume measurement (${meanVolumeMatch[1]})`);
      }

      // Parse silencedetect events
      const silenceMatches = [...output.matchAll(/silence_start: ([\d.]+)|silence_end: ([\d.]+)/g)];
      let totalSilenceDuration = 0;
      let lastStart: number | null = null;
      const segments: AudioAnalysisResult['segments'] = [];

      for (const m of silenceMatches) {
        if (m[0].startsWith('silence_start')) {
          const val = parseFloat(m[1]);
          if (Number.isFinite(val)) {
            lastStart = val;
          }
        } else if (m[0].startsWith('silence_end') && lastStart !== null) {
          const end = parseFloat(m[2]);
          if (Number.isFinite(end) && end >= lastStart) {
            totalSilenceDuration += (end - lastStart);
            segments.push({ start: parseFloat(lastStart.toFixed(2)), end: parseFloat(end.toFixed(2)), type: 'silence' });
          }
          lastStart = null;
        }
      }

      if (!Number.isFinite(totalSilenceDuration)) {
        throw new AudioProcessingError('FFmpeg audio analysis failed: malformed silence duration calculation');
      }

      const silenceRatio = Math.min(1, totalSilenceDuration / dur);
      const activeRatio = Math.max(0, 1 - silenceRatio);
      const isAudible = meanVol > -50;

      // Extract raw PCM audio chunk samples for acoustic signal processing & repetition detection
      // 8000Hz mono 16-bit PCM: 16,000 bytes per second sequential streaming with bounded signature storage
      const pcmExtraction = await this.extractPcmAudio(videoPath, dur, { bounds: options?.bounds });
      const chunkSignatures = pcmExtraction.chunkSignatures;
      const totalAudioSeconds = pcmExtraction.totalAudioSeconds;

      // 1. Acoustic Speech Modulation Detection
      // Speech has high temporal modulation in energy envelope and significant ZCR variability between phonemes
      let speechDetectionStatus: DetectorExecutionStatus = 'NO_SIGNAL_DETECTED';
      let speechFailureReason: string | undefined;

      if (pcmExtraction.status === 'ANALYSIS_UNAVAILABLE') {
        speechDetectionStatus = 'ANALYSIS_UNAVAILABLE';
        speechFailureReason = pcmExtraction.failureReason;
      } else if (!isAudible || totalAudioSeconds < 1) {
        speechDetectionStatus = isAudible ? 'INSUFFICIENT_EVIDENCE' : 'NO_SIGNAL_DETECTED';
      } else {
        const rmsValues = chunkSignatures.map(c => c.rms).filter(r => r > 100);
        if (rmsValues.length >= 2) {
          const meanRms = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
          const varianceRms = rmsValues.reduce((a, b) => a + Math.pow(b - meanRms, 2), 0) / rmsValues.length;
          const stdDevRms = Math.sqrt(varianceRms);
          const coeffVariation = stdDevRms / Math.max(1, meanRms);

          // Natural speech exhibits syllabic modulation with coefficient of variation > 0.25
          // Synthetic single tones or flat hums exhibit coefficient of variation < 0.08
          if (coeffVariation >= 0.25) {
            speechDetectionStatus = 'DETECTED';
          } else {
            speechDetectionStatus = 'NO_SIGNAL_DETECTED';
          }
        }
      }

      // 2. Within-Video Repeated Audio Detection
      // Identifies non-adjacent audio segments with matching acoustic signatures and 16-band spectral profiles
      let repeatedAudioSegments: NonNullable<AudioAnalysisResult['repeatedAudioSegments']> = [];
      let repeatedAudioStatus: DetectorExecutionStatus;
      let repeatedAudioFailureReason: string | undefined;
      let repeatedAudioLimitations = 'Detects within-video acoustic repetition across non-adjacent segments using 16-band spectral energy correlation; does not match external copyrighted audio catalogs or YouTube Content ID.';
      let repDetails: RepeatedAudioAnalysisDetails = {
        candidatePairsConsidered: 0,
        pairComparisonsPerformed: 0,
        budgetExceeded: false,
        chunksEvaluated: chunkSignatures.length,
        totalChunks: chunkSignatures.length
      };

      if (pcmExtraction.status === 'ANALYSIS_UNAVAILABLE') {
        repeatedAudioStatus = 'ANALYSIS_UNAVAILABLE';
        repeatedAudioFailureReason = pcmExtraction.failureReason;
      } else if (pcmExtraction.status === 'INSUFFICIENT_EVIDENCE' || totalAudioSeconds < 2.0) {
        repeatedAudioStatus = 'INSUFFICIENT_EVIDENCE';
        repeatedAudioFailureReason = pcmExtraction.failureReason || 'Audio stream duration is under 2.0 seconds; insufficient timeline for repetition comparison.';
      } else {
        const repResult = detectRepeatedAudioDetailed(chunkSignatures, dur, 2.0, { bounds: options?.bounds });
        repeatedAudioSegments = repResult.matches;
        repDetails = repResult.details;

        const isBudgetExceeded = repDetails.budgetExceeded || (pcmExtraction.chunksLimitExceeded === true);

        if (isBudgetExceeded) {
          const budgetCause = pcmExtraction.chunksLimitExceeded
            ? `audio duration exceeded maximum chunk signature limit (${chunkSignatures.length} chunks extracted of ${Math.ceil(totalAudioSeconds)} total seconds)`
            : repDetails.limitReached === 'CANDIDATE_PAIR_LIMIT'
              ? `maximum candidate pairs (${repDetails.candidatePairsConsidered}) evaluated`
              : repDetails.limitReached === 'PAIR_COMPARISON_LIMIT'
                ? `maximum pair comparisons (${repDetails.pairComparisonsPerformed}) reached`
                : `audio duration exceeded maximum chunk signature limit (${chunkSignatures.length} chunks extracted)`;

          const budgetNotice = `Analysis budget reached: ${budgetCause} before completing full timeline repetition analysis.`;
          repeatedAudioLimitations += ` Incomplete coverage notice: ${budgetNotice}`;

          if (repeatedAudioSegments.length > 0) {
            // Reused audio segments detected before budget exhaustion are strictly preserved
            repeatedAudioStatus = 'DETECTED';
          } else {
            // Incomplete inspection with zero matches must NOT claim clean negative detection
            repeatedAudioStatus = 'INSUFFICIENT_EVIDENCE';
            repeatedAudioFailureReason = budgetNotice;
          }
        } else {
          repeatedAudioStatus = repeatedAudioSegments.length > 0 ? 'DETECTED' : 'NO_SIGNAL_DETECTED';
        }
      }

      // 3. Optional Local Speech Transcription
      const sttResult = await this.transcriptionAdapter.transcribe(videoPath, dur);

      // 4. Optional Local Music Classification
      const musicResult = await this.musicAdapter.classify(videoPath, dur);

      // Active intervals contain acoustic energy (music, speech, sfx, or ambient)
      if (isAudible) {
        if (segments.length === 0) {
          segments.push({ start: 0, end: dur, type: 'mixed' });
        } else {
          // Fill gaps between silence as mixed acoustic activity
          let curr = 0;
          const activeSegments: AudioAnalysisResult['segments'] = [];
          for (const s of segments) {
            if (s.start > curr + 1) {
              activeSegments.push({ start: curr, end: s.start, type: 'mixed' });
            }
            curr = s.end;
          }
          if (curr < dur) {
            activeSegments.push({ start: curr, end: dur, type: 'mixed' });
          }
          segments.push(...activeSegments);
          segments.sort((a, b) => a.start - b.start);
        }
      }

      // Evidence integrity: Distinguish measurable acoustic activity from verified speech:
      // Volume and silence filters measure sound energy, NOT speech or narrator identity.
      // Separate speech presence from segment timestamp availability without fabricating timestamps.
      const hasTimestampedVoiceover = Boolean(sttResult.segments && sttResult.segments.length > 0);
      const hasVoiceover = sttResult.status === 'DETECTED';
      const voiceoverRatio = hasTimestampedVoiceover
        ? Math.min(1, parseFloat(((sttResult.segments!.reduce((acc, s) => acc + (s.end - s.start), 0)) / dur).toFixed(2)))
        : 0;

      const totalMs = Date.now() - startTime;
      const isRepetitionBudgetExceeded = repDetails.budgetExceeded || (pcmExtraction.chunksLimitExceeded === true);

      const detectors: Record<string, DetectorReport> = {
        audio_silence_volume: {
          detectorName: 'ffmpeg_silence_and_volume',
          version: '1.0.0',
          status: 'DETECTED',
          executionDurationMs: totalMs,
          confidence: 0.95,
          limitations: 'Measures decibel energy and silence boundaries; does not determine speech semantics or music copyright.'
        },
        audio_speech_activity: {
          detectorName: 'acoustic_energy_modulation',
          version: '1.0.0',
          status: speechDetectionStatus,
          executionDurationMs: totalMs,
          confidence: speechDetectionStatus === 'ANALYSIS_UNAVAILABLE' ? undefined : 0.85,
          failureReason: speechFailureReason,
          limitations: 'Acoustic activity heuristic based on energy envelope modulation; does not produce verified speech semantics or textual transcripts. Confidence score is a heuristic execution rating, not a calibrated statistical probability.'
        },
        audio_transcription: {
          detectorName: 'local_speech_to_text_adapter',
          version: '1.0.0',
          status: sttResult.status,
          executionDurationMs: sttResult.executionDurationMs,
          limitations: sttResult.limitations,
          failureReason: sttResult.failureReason
        },
        audio_music_detection: {
          detectorName: 'music_classification_analyzer',
          version: '1.0.0',
          status: musicResult.status,
          executionDurationMs: musicResult.executionDurationMs,
          confidence: musicResult.confidence,
          limitations: musicResult.limitations,
          failureReason: musicResult.failureReason
        },
        audio_repeated_segments: {
          detectorName: 'subband_spectral_audio_fingerprint',
          version: '1.1.0',
          status: repeatedAudioStatus,
          executionDurationMs: totalMs,
          confidence: (repeatedAudioStatus === 'ANALYSIS_UNAVAILABLE' || repeatedAudioStatus === 'INSUFFICIENT_EVIDENCE' || isRepetitionBudgetExceeded) ? undefined : (repeatedAudioSegments.length > 0 ? 0.90 : 0.92),
          failureReason: repeatedAudioFailureReason,
          limitations: repeatedAudioLimitations,
          details: {
            candidatePairsConsidered: repDetails.candidatePairsConsidered,
            pairComparisonsPerformed: repDetails.pairComparisonsPerformed,
            budgetExceeded: isRepetitionBudgetExceeded,
            limitReached: repDetails.limitReached || (pcmExtraction.chunksLimitExceeded ? 'CHUNK_LIMIT' : undefined),
            chunksEvaluated: repDetails.chunksEvaluated,
            totalChunks: pcmExtraction.chunksLimitExceeded ? Math.ceil(pcmExtraction.totalAudioSeconds) : repDetails.totalChunks,
            audioSignatures: (pcmExtraction.chunkSignatures || []).map(c => ({
              sec: c.sec,
              duration: c.duration,
              rms: parseFloat(c.rms.toFixed(1)),
              zcr: Math.round(c.zcr),
              spectralProfile: c.spectralProfile.map(v => parseFloat(v.toFixed(3)))
            }))
          }
        }
      };

      return {
        hasVoiceover,
        hasTimestampedVoiceover,
        transcriptText: sttResult.transcriptText,
        voiceoverRatio,
        silenceRatio: parseFloat(silenceRatio.toFixed(2)),
        hasMusicDetected: musicResult.hasMusic,
        meanVolumeDb: meanVol,
        isAudible,
        advertiserSpeechFlags: [],
        segments,
        repeatedAudioSegments,
        transcriptSummary: isAudible 
          ? `Audio stream inspected. Acoustic energy present across ${Math.round(activeRatio * 100)}% of the timeline (mean volume ${meanVol} dB). ${
              sttResult.status === 'DETECTED' 
                ? (hasTimestampedVoiceover 
                    ? 'Speech transcription completed via local STT.' 
                    : 'Speech transcription completed via local STT (plain-text transcript without segment timestamps; voiceover timeline ratio is unestimated).') 
                : 'Speech and voice narration are unverified without transcript analysis.'
            }`
          : (sttResult.status === 'DETECTED'
              ? (hasTimestampedVoiceover
                  ? 'Low volume or quiet audio track. Speech transcription completed via local STT.'
                  : 'Low volume or quiet audio track. Speech transcription completed via local STT (plain-text transcript without segment timestamps; voiceover timeline ratio is unestimated).')
              : 'Low volume or quiet audio track.'),
        speechAnalysisStatus: sttResult.status,
        musicAnalysisStatus: musicResult.status,
        speechDetectionStatus,
        transcriptionStatus: sttResult.status,
        repeatedAudioStatus,
        transcriptSegments: sttResult.segments,
        detectors
      };
    } catch (err: any) {
      if (err instanceof AudioProcessingError) {
        throw err;
      }
      throw new AudioProcessingError(`Audio analysis failed: ${err?.message || 'FFmpeg process error'}`);
    }
  }
}

export const audioProcessor = new AudioProcessor();
export const speechTranscriptionAdapter = new SpeechTranscriptionAdapter();
