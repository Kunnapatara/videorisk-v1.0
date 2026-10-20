import express, { Router, Request, Response, RequestHandler } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import net from 'net';
import { storage } from '../storage';
import { jobOrchestrator } from '../pipeline/jobOrchestrator';
import { mediaInspector } from '../pipeline/mediaInspector';
import { thumbnailInspector } from '../pipeline/thumbnailInspector';
import { creditService } from '../services/creditService';
import { billingService, ALLOWED_PAID_PLANS } from '../services/billingService';
import { ScanJob, ScanMode, UserAccount, CrossVideoPattern } from '../../types';

export const apiRouter = Router();

// Ensure upload directory exists
const uploadDir = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer upload config for video media
const storageConfig = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const sanitizedExt = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `videorisk_${uniqueSuffix}${sanitizedExt}`);
  }
});

const upload = multer({
  storage: storageConfig,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB max file size
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/avi'];
    const allowedExts = ['.mp4', '.mov', '.webm', '.mkv', '.avi'];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid video format. Supported formats: MP4, MOV, WebM, MKV.'));
    }
  }
});

// Multer upload config for thumbnail images
const thumbnailStorageConfig = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const sanitizedExt = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `thumb_${uniqueSuffix}${sanitizedExt}`);
  }
});

const uploadThumbnail = multer({
  storage: thumbnailStorageConfig,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB max image size
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid thumbnail format. Supported image formats: JPEG, PNG, WebP.'));
    }
  }
});

/**
 * Type-safe middleware wrapper for video uploads.
 * Invokes Multer to parse the 'video' field and cleanly intercepts file size and validation errors.
 */
const uploadVideoMiddleware: RequestHandler = (req, res, next) => {
  upload.single('video')(req as any, res as any, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Video file size exceeds 500 MB limit.' });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      return res.status(400).json({ error: err.message || 'Invalid upload.' });
    }
    next();
  });
};

/**
 * Type-safe middleware wrapper for thumbnail image uploads.
 * Invokes Multer to parse the 'thumbnail' field and cleanly intercepts file size and validation errors.
 */
const uploadThumbnailMiddleware: RequestHandler = (req, res, next) => {
  uploadThumbnail.single('thumbnail')(req as any, res as any, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Thumbnail file size exceeds 10 MB limit.' });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      return res.status(400).json({ error: err.message || 'Invalid upload.' });
    }
    next();
  });
};

/**
 * Validates that a file path is safely confined to the upload directory.
 * In non-production test environments, also allows temporary fixture directories.
 * Prevents directory traversal, symlink jumping, prefix-collision attacks, and directory deletions.
 */
function validateSafeStoragePath(candidatePath: string, options: { mustExist?: boolean } = {}): { isSafe: boolean; resolvedPath: string; error?: string } {
  try {
    if (!candidatePath || typeof candidatePath !== 'string') {
      return { isSafe: false, resolvedPath: '', error: 'Candidate path is empty or invalid.' };
    }
    const resolved = path.resolve(candidatePath);

    // Allowed storage roots: production permits uploadDir; non-production permits uploadDir and os.tmpdir()
    const allowedRoots = [uploadDir];
    if (process.env.NODE_ENV !== 'production') {
      allowedRoots.push(path.resolve(os.tmpdir()));
    }

    let matchedRoot: string | null = null;
    let relToRoot = '';

    for (const root of allowedRoots) {
      const rel = path.relative(root, resolved);
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '' && rel !== '.') {
        matchedRoot = root;
        relToRoot = rel;
        break;
      }
    }

    if (!matchedRoot) {
      return { isSafe: false, resolvedPath: resolved, error: 'Path escapes allowed storage directories.' };
    }

    // Prevent targeting the root storage directory or protected root subdirectories themselves
    if (!relToRoot || relToRoot === '.' || relToRoot === 'proxies' || relToRoot === 'frames') {
      return { isSafe: false, resolvedPath: resolved, error: 'Target path cannot be the root storage directory.' };
    }

    // If file exists, check symlink resolution to prevent symlink-based escapes
    if (fs.existsSync(resolved)) {
      try {
        const realRoot = fs.realpathSync(matchedRoot);
        const realTarget = fs.realpathSync(resolved);
        const realRel = path.relative(realRoot, realTarget);
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
          return { isSafe: false, resolvedPath: resolved, error: 'Symlink escapes allowed storage directory.' };
        }
      } catch {
        return { isSafe: false, resolvedPath: resolved, error: 'Symlink resolution failed.' };
      }
    } else if (options.mustExist) {
      return { isSafe: false, resolvedPath: resolved, error: 'File does not exist.' };
    }

    return { isSafe: true, resolvedPath: resolved };
  } catch (err: any) {
    return { isSafe: false, resolvedPath: '', error: `Path resolution error for '${candidatePath}': ${err?.message || err}` };
  }
}

function isSafeUploadPath(candidatePath: string): boolean {
  return validateSafeStoragePath(candidatePath, { mustExist: true }).isSafe;
}

/**
 * Checks whether test-only account switching endpoints are permitted.
 * In production or when ENABLE_TEST_ACCOUNT_SWITCH is not true, returns false.
 */
function isTestSwitchingAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ENABLE_TEST_ACCOUNT_SWITCH === 'true';
}

/**
 * Omit sensitive credentials (passwordHash, salt) from public user representation
 */
export function sanitizeUser(user: UserAccount) {
  const { passwordHash, salt, ...safeUser } = user;
  return safeUser;
}

/**
 * Extracts and authenticates user identity from request session tokens.
 * Supports Authorization Bearer token, x-session-token header, and cookie.
 * Returns null if token is missing, invalid, or expired.
 * Never silently converts an anonymous request into a shared default user.
 */
/**
 * Extracts and authenticates user identity from request session tokens.
 * Strictly supports Authorization Bearer token, x-session-token header, and cookie.
 * NEVER accepts session tokens from URL query strings (e.g. ?token= or ?sessionToken=)
 * to prevent token exposure in browser history, logs, and Referer headers.
 * Returns null if token is missing, invalid, or expired.
 */
export async function getAuthenticatedUser(req: Request): Promise<UserAccount | null> {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-session-token']) {
    token = String(req.headers['x-session-token']).trim();
  } else if ((req as any).cookies?.vr_session) {
    token = String((req as any).cookies.vr_session).trim();
  }

  if (!token) {
    return null;
  }

  return await storage.users.getUserBySession(token);
}

/**
 * Enforces that the request has a valid, active user session.
 * Rejects anonymous, missing, expired, or invalid sessions with 401 Unauthorized.
 */
export async function requireAuth(req: Request, res: Response): Promise<UserAccount | null> {
  const existingUser = (req as any).user;
  if (existingUser) {
    return existingUser;
  }
  const user = await getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized: A valid active session is required.' });
    return null;
  }
  (req as any).user = user;
  return user;
}

// ==============================================================================
// ISSUE B: SCOPED, SHORT-LIVED MEDIA ACCESS TOKENS (No Session Tokens in URL)
// ==============================================================================

/**
 * Server-authoritative secret for signing short-lived, resource-scoped media access tokens.
 * Kept isolated from primary session tokens and client credentials.
 * Production strictly requires a pre-shared, non-empty MEDIA_TOKEN_SECRET.
 */
let testInjectedSecret: string | null = null;
let devFallbackSecret: string | null = null;

export function setMediaTokenSecretForTest(secret: string | null): void {
  testInjectedSecret = secret;
}

export function validateAndGetMediaTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (testInjectedSecret !== null) {
    return testInjectedSecret;
  }

  const rawSecret = env.MEDIA_TOKEN_SECRET;
  const isProd = env.NODE_ENV === 'production';

  if (typeof rawSecret === 'string' && rawSecret.trim().length > 0) {
    return rawSecret.trim();
  }

  if (isProd) {
    throw new Error(
      '[FATAL SECURITY CONFIGURATION ERROR] MEDIA_TOKEN_SECRET environment variable is missing, empty, or whitespace-only. ' +
      'Production mode strictly requires an explicit, pre-shared MEDIA_TOKEN_SECRET to ensure multi-instance authorization integrity. ' +
      'Server startup aborted.'
    );
  }

  // Development / Test fallback: keep a stable secret per process lifecycle
  if (!devFallbackSecret) {
    devFallbackSecret = crypto.randomBytes(32).toString('hex');
  }
  return devFallbackSecret;
}

export interface MediaAccessTokenPayload {
  userId: string;
  resourceId: string; // canonical relative path or fileId, e.g. "videorisk_123.mp4"
  expiresAt: number;  // timestamp in milliseconds
  nonce: string;
}

/**
 * Sanitizes and enforces the server-authoritative media access token duration contract:
 * - Minimum: 10 seconds
 * - Maximum: 300 seconds
 * - Default: 120 seconds
 * - Decimals: Floored to integer
 * - Non-finite, NaN, Infinity, -Infinity, non-numeric: Default 120
 */
export function sanitizeMediaTokenDuration(durationSeconds: any): number {
  if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && !Number.isNaN(durationSeconds)) {
    return Math.min(300, Math.max(10, Math.floor(durationSeconds)));
  }
  return 120;
}

/**
 * Creates a cryptographically signed, short-lived media access token scoped strictly to a single resource.
 * Max duration: 300 seconds. Default duration: 120 seconds. Minimum duration: 10 seconds.
 */
export function createMediaAccessToken(
  userId: string,
  resourceId: string,
  durationSeconds: number = 120,
  options?: { nowMs?: number; secret?: string }
): string {
  if (!userId || typeof userId !== 'string') {
    throw new Error('Valid userId is required to create media access token.');
  }
  if (!resourceId || typeof resourceId !== 'string') {
    throw new Error('Valid resourceId is required to create media access token.');
  }

  // Enforce production contract: duration must be clamped strictly within [10, 300] seconds, default 120
  const safeDuration = sanitizeMediaTokenDuration(durationSeconds);
  const baseTime = (typeof options?.nowMs === 'number' && Number.isFinite(options.nowMs)) ? options.nowMs : Date.now();
  const normalizedResource = resourceId.replace(/^\/+/, '').trim();
  const payload: MediaAccessTokenPayload = {
    userId: userId.trim(),
    resourceId: normalizedResource,
    expiresAt: baseTime + (safeDuration * 1000),
    nonce: crypto.randomBytes(16).toString('hex')
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingSecret = options?.secret || validateAndGetMediaTokenSecret();
  const signature = crypto.createHmac('sha256', signingSecret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Validates a media access token against the requested resource path and verifies:
 * 1. Correct cryptographic HMAC-SHA256 signature (constant-time comparison).
 * 2. Token has not expired.
 * 3. Token resourceId strictly matches the requested resource.
 * Returns the authenticated userId or null if invalid, expired, tampered, or out of scope.
 */
export function verifyMediaAccessToken(
  tokenStr: string | undefined | null,
  requestedRelativePath: string,
  options?: { nowMs?: number; secret?: string }
): { userId: string } | null {
  if (!tokenStr || typeof tokenStr !== 'string') {
    return null;
  }

  const trimmed = tokenStr.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  const [payloadB64, providedSig] = parts;

  // Verify HMAC signature in constant time
  const verificationSecret = options?.secret || validateAndGetMediaTokenSecret();
  const expectedSig = crypto.createHmac('sha256', verificationSecret).update(payloadB64).digest('base64url');
  const providedBuf = Buffer.from(providedSig);
  const expectedBuf = Buffer.from(expectedSig);

  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  // Parse and validate payload
  try {
    const rawJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload: MediaAccessTokenPayload = JSON.parse(rawJson);

    if (!payload.userId || !payload.resourceId || !payload.expiresAt) {
      return null;
    }

    // Expiration check: production uses Date.now(); unit tests can inject nowMs if specified
    const currentTime = (typeof options?.nowMs === 'number' && Number.isFinite(options.nowMs)) ? options.nowMs : Date.now();
    if (currentTime >= payload.expiresAt) {
      return null;
    }

    // Strict Scope check:
    const normTokenResource = path.normalize(payload.resourceId).replace(/^\/+/, '');
    const normRequested = path.normalize(requestedRelativePath).replace(/^\/+/, '');

    const tokenBase = path.basename(normTokenResource);
    const reqBase = path.basename(normRequested);

    // Exact relative path match, or exact basename match for files inside root upload dir
    const isExactMatch = normTokenResource === normRequested;
    const isBasenameMatch = tokenBase === reqBase && (!normTokenResource.includes(path.sep) || normTokenResource === normRequested);

    // Proxy derivative matching: if token was granted for the parent video "video.mp4", allow its derived proxy "proxies/proxy_video.mp4"
    let isDerivedProxyMatch = false;
    if (normRequested.startsWith('proxies' + path.sep)) {
      const proxyStem = reqBase.replace(/^proxy_/, '').replace(/\.mp4$/i, '');
      const tokenStem = path.basename(normTokenResource, path.extname(normTokenResource));
      if (proxyStem === tokenStem) {
        isDerivedProxyMatch = true;
      }
    }

    if (!isExactMatch && !isBasenameMatch && !isDerivedProxyMatch) {
      return null; // Scope mismatch!
    }

    return { userId: payload.userId };
  } catch {
    return null;
  }
}

// ==============================================================================
// ISSUE A: TRUSTED PUBLIC MEDIA AUTHORIZATION (Explicit Allowlist Only)
// ==============================================================================

/**
 * Explicit allowlist of approved public demo/sample media assets.
 * Only exact filenames matching this allowlist and lacking any user ownership records
 * can be accessed unauthenticated.
 * Generic prefixes (e.g. "public_", "sample_public_") or path patterns are never trusted.
 */
export const TRUSTED_PUBLIC_MEDIA_ALLOWLIST = new Set<string>([
  'sample_public_demo.mp4',
  'sample_public_test.mp4',
  'public_demo_sample.mp4'
]);

export function registerTrustedPublicMedia(filename: string): void {
  const baseName = path.basename(filename.trim());
  if (baseName) {
    TRUSTED_PUBLIC_MEDIA_ALLOWLIST.add(baseName);
  }
}

export function unregisterTrustedPublicMedia(filename: string): void {
  const baseName = path.basename(filename.trim());
  if (baseName) {
    TRUSTED_PUBLIC_MEDIA_ALLOWLIST.delete(baseName);
  }
}

/**
 * Evaluates whether a media file is an explicitly approved public asset.
 * Hardened to enforce:
 * 1. Strict location binding: Only files located directly in the root of uploadDir are eligible.
 *    Files in any subdirectory (e.g. proxies/, frames/, nested subdirectories) are NEVER public.
 * 2. Strict relative path verification: No subdirectories, slashes, or traversal in requested relative path.
 * 3. Canonical path verification: Resolves symlinks to ensure target does not escape the public root or point into subdirectories.
 * 4. Explicit allowlist matching: File basename must match TRUSTED_PUBLIC_MEDIA_ALLOWLIST.
 * 5. Fails closed (returns false) on any ambiguity, invalid path, or non-matching location.
 */
export function isTrustedPublicMedia(resolvedPath: string, relativePath?: string): boolean {
  if (!resolvedPath || typeof resolvedPath !== 'string') {
    return false;
  }

  try {
    const uploadDirResolved = path.resolve(uploadDir);
    const targetResolved = path.resolve(resolvedPath);

    // 1. If relativePath is supplied, ensure it represents a direct child at the root (no subdirectories)
    if (relativePath !== undefined && relativePath !== null) {
      if (typeof relativePath !== 'string') return false;
      const cleanRel = relativePath.trim().replace(/^[/\\]+/, '');
      if (!cleanRel || cleanRel.includes('/') || cleanRel.includes('\\')) {
        return false;
      }
      const normRel = path.normalize(cleanRel);
      if (normRel.startsWith('..') || path.isAbsolute(normRel) || path.dirname(normRel) !== '.') {
        return false;
      }
    }

    // 2. Target must be directly inside uploadDir (parent directory must be exactly uploadDirResolved)
    if (path.dirname(targetResolved) !== uploadDirResolved) {
      return false;
    }

    // 3. Canonical symlink check: verify realpath is directly in real uploadDir
    if (fs.existsSync(targetResolved)) {
      try {
        const realUploadDir = fs.realpathSync(uploadDirResolved);
        const realTarget = fs.realpathSync(targetResolved);
        if (path.dirname(realTarget) !== realUploadDir) {
          return false;
        }
        // Ensure canonical basename matches resolved basename (no symlink alias trickery)
        if (path.basename(realTarget) !== path.basename(targetResolved)) {
          return false;
        }
      } catch {
        return false;
      }
    }

    // 4. Relative path from uploadDir must be exactly the filename without any directory component
    const relFromRoot = path.relative(uploadDirResolved, targetResolved);
    if (!relFromRoot || relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot) || relFromRoot.includes(path.sep)) {
      return false;
    }

    // 5. Must match an approved filename in the explicit allowlist
    const baseName = path.basename(targetResolved);
    return TRUSTED_PUBLIC_MEDIA_ALLOWLIST.has(baseName);
  } catch {
    return false;
  }
}

// ==============================================================================
// ISSUE C: STRICT OWNERSHIP RESOLUTION (Trusted Relationships, No Guessing)
// ==============================================================================

/**
 * Resolves the user account ID who owns a stored media file or scan artifact.
 * Strictly enforces:
 * 1. Exact canonical path matching against storage records (uploads and scans).
 * 2. Elimination of substring matching (e.g. no normPath.includes(scan.id)).
 * 3. Prevention of basename collision across different directories.
 * 4. Prevention of proxy stem collisions across multiple user accounts.
 * 5. Detection of conflicting records -> fails closed (returns null).
 * 6. Orphaned files without trusted relationships -> fails closed (returns null).
 */
export async function getMediaOwner(candidatePath: string): Promise<{ userId: string } | null> {
  let normPath: string;
  try {
    normPath = fs.existsSync(candidatePath) ? fs.realpathSync(candidatePath) : path.resolve(candidatePath);
  } catch {
    normPath = path.resolve(candidatePath);
  }

  const baseName = path.basename(normPath);
  const uploadDirResolved = path.resolve(uploadDir);

  // 1. Direct match in uploads repository by exact canonical filePath
  const uploadByPath = await storage.uploads.getUploadByPath(normPath);
  if (uploadByPath) {
    // Verify that the upload record's resolved path actually matches normPath
    if (path.resolve(uploadByPath.filePath) === normPath) {
      return { userId: uploadByPath.userId };
    }
  }

  // Check upload by fileId (primary key), but ONLY if the file is directly inside uploadDir
  // and its recorded filePath matches normPath (preventing cross-directory basename collisions)
  if (path.dirname(normPath) === uploadDirResolved) {
    const uploadByFileId = await storage.uploads.getUpload(baseName);
    if (uploadByFileId) {
      let recordResolved: string;
      try {
        recordResolved = fs.existsSync(uploadByFileId.filePath) 
          ? fs.realpathSync(uploadByFileId.filePath) 
          : path.resolve(uploadByFileId.filePath);
      } catch {
        recordResolved = path.resolve(uploadByFileId.filePath);
      }
      if (recordResolved === normPath) {
        return { userId: uploadByFileId.userId };
      }
    }
  }

  // 2. Direct exact match in scans repository
  const allScans = await storage.scans.getAllScans();
  const directMatchingScans = allScans.filter(scan => {
    const vMatch = scan.videoPath && path.resolve(scan.videoPath) === normPath;
    const tMatch = scan.thumbnailPath && path.resolve(scan.thumbnailPath) === normPath;
    const pMatch = scan.proxyPath && path.resolve(scan.proxyPath) === normPath;
    return vMatch || tMatch || pMatch;
  });

  if (directMatchingScans.length > 0) {
    const scanOwners = new Set(directMatchingScans.map(s => s.userId));
    if (scanOwners.size === 1) {
      return { userId: directMatchingScans[0].userId };
    }
    // Ambiguous conflict: Multiple distinct users own matching records -> fail closed!
    return null;
  }

  // 3. Proxy derivative matching: uploads/proxies/proxy_${sourceStem}.mp4
  const proxiesDir = path.resolve(uploadDirResolved, 'proxies');
  if (path.dirname(normPath) === proxiesDir && baseName.startsWith('proxy_') && baseName.endsWith('.mp4')) {
    const proxyStem = baseName.replace(/^proxy_/, '').replace(/\.mp4$/i, '');
    
    // Find all scans whose source video filename stem matches proxyStem exactly
    const matchingProxyScans = allScans.filter(scan => {
      if (scan.videoPath) {
        const vStem = path.basename(scan.videoPath, path.extname(scan.videoPath));
        if (vStem === proxyStem) return true;
      }
      if (scan.videoFilename) {
        const fStem = path.basename(scan.videoFilename, path.extname(scan.videoFilename));
        if (fStem === proxyStem) return true;
      }
      return false;
    });

    // Also check upload records whose source file stem matches proxyStem exactly
    const candidateOwners = new Set<string>();
    for (const scan of matchingProxyScans) {
      candidateOwners.add(scan.userId);
    }

    for (const ext of ['.mp4', '.mov', '.webm', '.mkv', '.avi']) {
      const up = await storage.uploads.getUpload(proxyStem + ext);
      if (up) {
        candidateOwners.add(up.userId);
      }
    }

    if (candidateOwners.size === 1) {
      const [singleOwner] = Array.from(candidateOwners);
      return { userId: singleOwner };
    }
    // If 0 matches (orphaned proxy) or >1 matches (cross-user collision): FAIL CLOSED!
    return null;
  }

  // 4. Frame snapshots: uploads/frames/${jobSubdir}/frame_xxx.jpg
  const framesDir = path.resolve(uploadDirResolved, 'frames');
  if (normPath.startsWith(framesDir + path.sep)) {
    const relFromFrames = path.relative(framesDir, normPath);
    const jobSubdir = relFromFrames.split(path.sep)[0];

    // Strictly match jobSubdir without substring ambiguity (never use includes)
    const matchingFrameScans = allScans.filter(scan => {
      if (jobSubdir === scan.id) return true;
      if (jobSubdir.startsWith(scan.id + '_')) {
        const suffix = jobSubdir.substring(scan.id.length + 1);
        // Suffix must be numeric or standard timestamp/random segment
        return /^[0-9]+(_[a-z0-9]+)?$/i.test(suffix);
      }
      return false;
    });

    const frameOwners = new Set(matchingFrameScans.map(s => s.userId));
    if (frameOwners.size === 1) {
      return { userId: matchingFrameScans[0].userId };
    }
    // If 0 matches or multiple conflicting scans: FAIL CLOSED!
    return null;
  }

  // No trusted relationship found -> FAIL CLOSED!
  return null;
}

/**
 * Secure file delivery handler for uploads directory.
 * Enforces:
 * 1. Directory traversal prevention (validateSafeStoragePath, URI decoding, null bytes check).
 * 2. Strict authentication & session verification (Bearer, x-session-token, cookie, or scoped media_token).
 *    NEVER accepts session tokens in URL query strings.
 * 3. Strict object-level authorization (IDOR protection: verifies that requesting user owns the media or associated scan).
 * 4. RFC 7233 byte-range streaming for audio/video players.
 * 5. Secure response headers (X-Content-Type-Options: nosniff, private cache control, Content-Type, Accept-Ranges).
 * 6. Directory listing prevention.
 */
export const secureUploadsHandler: RequestHandler = async (req: Request, res: Response, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return next();
  }

  try {
    let rawPath = '';
    if ((req.params as any)?.filePath) {
      rawPath = (req.params as any).filePath;
    } else if ((req.params as any)?.[0]) {
      rawPath = (req.params as any)[0];
    } else if (req.path) {
      rawPath = req.path.replace(/^\/+/, '');
    }

    if (!rawPath) {
      return res.status(400).json({ error: 'File path is required.' });
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      return res.status(400).json({ error: 'Malformed path encoding.' });
    }

    if (decodedPath.includes('\0')) {
      return res.status(400).json({ error: 'Null bytes are not permitted in file path.' });
    }

    // Resolve target path within upload directory
    const targetFullPath = path.resolve(uploadDir, decodedPath);

    // Validate path safety against traversal, symlink jumping, and directory escapes
    const validation = validateSafeStoragePath(targetFullPath);
    if (!validation.isSafe) {
      return res.status(403).json({ error: 'Access denied: Invalid or unsafe path.' });
    }

    const resolved = validation.resolvedPath;

    // Check file existence
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return res.status(403).json({ error: 'Directory listing is not permitted.' });
    }

    // Identify owner from storage records (uploads or scans)
    const owner = await getMediaOwner(resolved);

    // Trusted Public Sample detection (Issue A):
    // Only permit unauthenticated access if file is in explicit TRUSTED_PUBLIC_MEDIA_ALLOWLIST
    // AND has NO user ownership record in storage
    const isPublicApproved = !owner && isTrustedPublicMedia(resolved, decodedPath);

    if (!isPublicApproved) {
      // Authenticate requesting user:
      // 1. Primary session authentication via Authorization Bearer, x-session-token header, or vr_session cookie
      let authenticatedUserId: string | null = null;
      const sessionUser = await getAuthenticatedUser(req);
      if (sessionUser) {
        authenticatedUserId = sessionUser.id;
      }

      // 2. Resource-scoped, short-lived Media Access Token (Issue B):
      // Only accepted if passed via ?media_token= or ?mediaToken=
      // Note: Primary session tokens in ?token= or ?sessionToken= are strictly ignored and NOT accepted!
      if (!authenticatedUserId) {
        const queryMediaToken = (req.query?.media_token || req.query?.mediaToken);
        if (typeof queryMediaToken === 'string' && queryMediaToken.trim()) {
          const verified = verifyMediaAccessToken(queryMediaToken.trim(), decodedPath);
          if (verified) {
            authenticatedUserId = verified.userId;
          }
        }
      }

      // If unauthenticated by both session and valid media token: reject 401
      if (!authenticatedUserId) {
        return res.status(401).json({ error: 'Unauthorized: A valid active session or media access token is required.' });
      }

      // If an owner was identified, verify that the authenticated user owns this asset
      if (owner && owner.userId !== authenticatedUserId) {
        return res.status(403).json({ error: 'Access denied: You do not own this media asset.' });
      }

      // If the file is not tracked in storage and not an intentional public sample: fail closed (Issue C)
      if (!owner) {
        return res.status(403).json({ error: 'Access denied: Media asset is not associated with an authorized scan.' });
      }
    }

    // Determine MIME type
    const ext = path.extname(resolved).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.json': 'application/json',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain'
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';

    // Set secure response headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Accept-Ranges', 'bytes');

    if (req.method === 'HEAD') {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stat.size);
      return res.status(200).end();
    }

    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).json({ error: 'Range Not Satisfiable' });
      }

      const rawStart = match[1];
      const rawEnd = match[2];

      let start = 0;
      let end = fileSize - 1;

      if (rawStart === '' && rawEnd !== '') {
        const suffix = parseInt(rawEnd, 10);
        if (isNaN(suffix) || suffix <= 0) {
          res.setHeader('Content-Range', `bytes */${fileSize}`);
          return res.status(416).json({ error: 'Range Not Satisfiable' });
        }
        start = Math.max(0, fileSize - suffix);
        end = fileSize - 1;
      } else if (rawStart !== '') {
        start = parseInt(rawStart, 10);
        if (rawEnd !== '') {
          end = parseInt(rawEnd, 10);
        }
      } else {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).json({ error: 'Range Not Satisfiable' });
      }

      if (isNaN(start) || isNaN(end) || start < 0 || start > end || start >= fileSize) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).json({ error: 'Range Not Satisfiable' });
      }

      if (end >= fileSize) {
        end = fileSize - 1;
      }

      const chunkSize = (end - start) + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);
      res.setHeader('Content-Type', contentType);

      const stream = fs.createReadStream(resolved, { start, end });
      stream.on('error', (err) => {
        console.error('[Upload Streaming Error]', err?.message || err);
        if (!res.headersSent) res.status(500).end();
      });
      stream.pipe(res);
    } else {
      res.status(200);
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Content-Type', contentType);

      const stream = fs.createReadStream(resolved);
      stream.on('error', (err) => {
        console.error('[Upload Streaming Error]', err?.message || err);
        if (!res.headersSent) res.status(500).end();
      });
      stream.pipe(res);
    }
  } catch (err: any) {
    console.error('[Upload Serve Error]', err?.message || err);
    res.status(500).json({ error: 'Failed to retrieve media file.' });
  }
};

/**
 * Strictly validates and parses a positive integer from a string value:
 * 1. Trims surrounding whitespace.
 * 2. Entire value must match digits only without leading zeroes: /^[1-9]\d*$/
 * 3. Rejects decimal values (e.g. "1.5"), trailing characters (e.g. "10abc"), zero ("0"),
 *    negative values ("-1"), non-numeric strings, and Infinity.
 * 4. Rejects values outside JavaScript's safe-integer range (Number.MAX_SAFE_INTEGER).
 * Returns null if invalid.
 */
export function parseStrictPositiveInt(val: string | undefined | null): number | null {
  if (val === undefined || val === null || typeof val !== 'string') {
    return null;
  }
  const trimmed = val.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return null;
  }
  // Check bounds using BigInt for values longer than 15 digits to avoid float precision coercion
  if (trimmed.length > 15) {
    try {
      if (BigInt(trimmed) > BigInt(Number.MAX_SAFE_INTEGER)) {
        return null;
      }
    } catch {
      return null;
    }
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num <= 0) {
    return null;
  }
  return num;
}

/**
 * Resolves a rate-limit integer setting with unambiguous precedence:
 * 1. Primary (current/specific) environment variable if set to a valid positive integer.
 * 2. Fallback (legacy/general) environment variable if set to a valid positive integer.
 * 3. Default positive integer value.
 *
 * Security Guarantee:
 * Invalid strings, empty strings, zero ('0'), negative numbers ('-1'), decimals ('1.5'),
 * trailing letters ('10abc'), NaN, Infinity, or overflow values are strictly rejected
 * and will never disable the rate limit. An invalid primary value never prevents a valid
 * legacy fallback from being applied.
 */
export function resolveRateLimitInt(
  primaryVal: string | undefined,
  fallbackVal: string | undefined,
  defaultValue: number
): number {
  const primaryParsed = parseStrictPositiveInt(primaryVal);
  if (primaryParsed !== null) {
    return primaryParsed;
  }
  const fallbackParsed = parseStrictPositiveInt(fallbackVal);
  if (fallbackParsed !== null) {
    return fallbackParsed;
  }
  return defaultValue;
}

/**
 * Safely parses positive integers from environment configuration with fallback to secure default.
 * Guarantees that invalid, empty, negative, or zero inputs cannot silently disable rate limits.
 */
export function parsePositiveInt(val: string | undefined, defaultValue: number): number {
  return resolveRateLimitInt(val, undefined, defaultValue);
}

/**
 * Safely extracts client IP address respecting Express's configured trust-proxy semantics.
 * Does NOT blindly trust unvalidated X-Forwarded-For headers.
 * Relies on req.ip (which Express securely populates only when trust proxy is configured),
 * falling back to socket remote address.
 */
export function getClientIp(req: Request): string {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (typeof ip === 'string' && ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }
  return ip;
}

/**
 * Strictly validates an IP address (IPv4/IPv6) or CIDR block (IPv4/IPv6).
 * Uses Node's built-in net.isIP to validate octets and address formatting.
 * Strictly validates prefix lengths (0-32 for IPv4, 0-128 for IPv6).
 */
export function isValidIpOrCidr(entry: string): boolean {
  if (!entry || typeof entry !== 'string') return false;
  const trimmed = entry.trim();
  if (trimmed === '') return false;

  // CIDR: IP/prefix
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length !== 2) return false;
    const [ipPart, prefixPart] = parts;

    const ipVer = net.isIP(ipPart);
    if (ipVer === 0) return false;

    // Prefix must be a non-negative integer without signs, decimals, or letters
    if (!/^(0|[1-9]\d*)$/.test(prefixPart)) return false;
    const prefix = Number(prefixPart);
    if (!Number.isSafeInteger(prefix)) return false;

    if (ipVer === 4) {
      return prefix >= 0 && prefix <= 32;
    }
    if (ipVer === 6) {
      return prefix >= 0 && prefix <= 128;
    }
    return false;
  }

  // Standalone IP
  return net.isIP(trimmed) !== 0;
}

/**
 * Validates and configures reverse proxy trust settings for Express.
 *
 * Security Requirements & Assumptions:
 * - Proxy trust is disabled by default (false) to prevent client IP spoofing via arbitrary X-Forwarded-For headers.
 * - In production, unrestricted "true" should NOT be used unless all inbound traffic is strictly constrained
 *   to traverse the front-end reverse proxy (e.g. AWS ALB, Cloud Run, Nginx).
 * - Deployment Note: The application must NOT be directly reachable through an untrusted path when proxy trust is enabled.
 * - Accepts hop counts (e.g. 1), CIDR/IP lists, or standard keywords ("loopback", "linklocal", "uniquelocal").
 * - Fails safely to false if an invalid or unparseable configuration is provided.
 */
export function configureTrustProxy(app: express.Express, rawVal: string | undefined): void {
  if (rawVal === undefined || rawVal === null || typeof rawVal !== 'string' || rawVal.trim() === '' || rawVal.trim().toLowerCase() === 'false') {
    app.set('trust proxy', false);
    return;
  }

  const trimmed = rawVal.trim();

  // 1. Exact numeric positive hop count (e.g. "1", "2")
  if (/^[1-9]\d*$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isSafeInteger(num) && num > 0) {
      app.set('trust proxy', num);
      return;
    }
  }

  // 2. Standard Express trust proxy keywords
  const knownKeywords = ['loopback', 'linklocal', 'uniquelocal'];
  if (knownKeywords.includes(trimmed.toLowerCase())) {
    app.set('trust proxy', trimmed.toLowerCase());
    return;
  }

  // 3. Boolean "true" (unrestricted trust proxy) - always logs explicit security warning
  if (trimmed.toLowerCase() === 'true') {
    console.warn(
      '[SECURITY WARNING] TRUST_PROXY is set to unrestricted "true". ' +
      'This trusts all X-Forwarded-For headers from any connecting client. ' +
      'Ensure the application is NOT directly accessible without passing through your edge proxy/load balancer. ' +
      'Prefer configuring an exact hop count (e.g. TRUST_PROXY=1) or trusted subnet CIDR range.'
    );
    app.set('trust proxy', true);
    return;
  }

  // 4. Comma-separated list of IP addresses or CIDR subnets
  const parts = trimmed.split(',').map(p => p.trim());
  if (parts.length > 0 && parts.every(part => isValidIpOrCidr(part))) {
    app.set('trust proxy', parts.join(', '));
    return;
  }

  // 5. Invalid / unsupported configuration -> Fail safe to false
  console.error(`[SECURITY ERROR] Invalid TRUST_PROXY configuration value "${rawVal}". Defaulting to trust proxy: false for security.`);
  app.set('trust proxy', false);
}

/**
 * Express middleware requiring an authenticated user session.
 * Rejects unauthenticated requests with HTTP 401 before any downstream upload/processing runs.
 */
export const requireAuthMiddleware: RequestHandler = async (req, res, next) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) {
      return;
    }
    next();
  } catch (err: any) {
    res.status(500).json({ error: 'Authentication check failed.' });
  }
};

/**
 * Rate-limiting middleware for video file uploads.
 * Runs AFTER requireAuthMiddleware (ensuring the user is authenticated)
 * and BEFORE uploadVideoMiddleware (Multer), preventing unauthenticated or
 * rate-limited requests from writing large video files to the server disk.
 *
 * Enforces dual limits:
 * 1. User account quota: Prevents a single authenticated user from flooding storage.
 * 2. Client IP quota: Prevents sybil attacks spanning multiple accounts from the same IP.
 */
export const uploadRateLimitMiddleware: RequestHandler = async (req, res, next) => {
  try {
    const user = (req as any).user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: A valid active session is required.' });
      return;
    }

    const clientIp = getClientIp(req);

    // 1. Authenticated user quota limit (UPLOAD_USER_RATE_LIMIT takes precedence over legacy UPLOAD_RATE_LIMIT)
    const userLimit = resolveRateLimitInt(process.env.UPLOAD_USER_RATE_LIMIT, process.env.UPLOAD_RATE_LIMIT, 10);
    const userWindow = resolveRateLimitInt(process.env.UPLOAD_USER_RATE_WINDOW, process.env.UPLOAD_RATE_WINDOW, 600); // 10 minutes
    const userKey = `user_${user.id}`;

    // 2. Separate IP quota limit (prevents multi-account abuse from the same IP)
    const ipLimit = resolveRateLimitInt(process.env.UPLOAD_IP_RATE_LIMIT, undefined, 20);
    const ipWindow = resolveRateLimitInt(process.env.UPLOAD_IP_RATE_WINDOW, undefined, 600); // 10 minutes
    const ipKey = `ip_${clientIp}`;

    // 3. Atomically check and consume both quotas together:
    // If either quota is exhausted, NEITHER quota is consumed.
    const multiStatus = await storage.rateLimits.consumeRateLimits([
      { key: userKey, action: 'upload_video', limit: userLimit, windowSeconds: userWindow },
      { key: ipKey, action: 'upload_video_ip', limit: ipLimit, windowSeconds: ipWindow }
    ]);

    if (!multiStatus.allowed) {
      res.setHeader('Retry-After', String(multiStatus.retryAfter));
      const isIpBlocked = multiStatus.rejectedSpec?.action === 'upload_video_ip';
      res.status(429).json({ 
        error: isIpBlocked
          ? 'Upload rate limit exceeded for your network. Please wait before uploading another video.'
          : 'Upload rate limit exceeded for your account. Please wait before uploading another video.',
        retryAfter: multiStatus.retryAfter
      });
      return;
    }

    next();
  } catch (err: any) {
    console.error('[Upload Rate Limit Error]:', err?.message || err);
    res.status(500).json({ error: 'Failed to evaluate upload rate limit.' });
  }
};

/**
 * Pre-upload authorization check for re-scanning.
 * Ensures the parent scan exists, belongs to the authenticated user, and user has available credits
 * before Multer parses any multipart file upload.
 */
export const validateRescanAuthorization: RequestHandler = async (req, res, next) => {
  try {
    const user = (req as any).user || await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: A valid active session is required.' });
      return;
    }

    const parentScan = await storage.scans.getScan(req.params.id);
    if (!parentScan) {
      res.status(404).json({ error: 'Original scan not found.' });
      return;
    }
    if (parentScan.userId !== user.id) {
      res.status(403).json({ error: 'Access denied: Cannot re-scan video belonging to another user.' });
      return;
    }

    if (user.creditsRemaining <= 0) {
      res.status(402).json({ 
        error: 'Insufficient credits for re-scan. Please top up your balance.',
        creditsRemaining: user.creditsRemaining 
      });
      return;
    }

    (req as any).parentScan = parentScan;
    next();
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to authorize re-scan.' });
  }
};

// 1. Clean Health Endpoint (Public)
apiRouter.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'VideoRisk'
  });
});

// 2. Authentication & Account Management (Public)
apiRouter.post('/auth/register', async (req: Request, res: Response) => {
  try {
    const clientIp = getClientIp(req);
    const registerLimit = resolveRateLimitInt(process.env.AUTH_REGISTER_RATE_LIMIT, undefined, 30);
    const registerWindow = resolveRateLimitInt(process.env.AUTH_REGISTER_RATE_WINDOW, undefined, 900); // 15 minutes

    const regStatus = await storage.rateLimits.consumeRateLimit(clientIp, 'auth_register', registerLimit, registerWindow);
    if (!regStatus.allowed) {
      res.setHeader('Retry-After', String(regStatus.retryAfter));
      return res.status(429).json({ 
        error: 'Too many registration attempts. Please wait before trying again.',
        retryAfter: regStatus.retryAfter
      });
    }

    const { email, password } = req.body || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await storage.users.getUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');

    const newUser = await storage.users.createUser(
      normalizedEmail,
      passwordHash,
      salt,
      10, // 10 free minutes starter credits
      'free'
    );

    const sessionToken = await storage.users.createSession(newUser.id);

    res.status(201).json({
      user: sanitizeUser(newUser),
      token: sessionToken,
      message: 'Account successfully registered.'
    });
  } catch (err: any) {
    console.error('[Auth Register Error]:', err?.message || err);
    res.status(500).json({ error: 'Registration service temporarily unavailable. Please try again later.' });
  }
});

apiRouter.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body || {};
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // 1. IP-based brute-force limit (AUTH_LOGIN_IP_RATE_LIMIT takes precedence over legacy AUTH_LOGIN_RATE_LIMIT)
    const clientIp = getClientIp(req);
    const loginIpLimit = resolveRateLimitInt(process.env.AUTH_LOGIN_IP_RATE_LIMIT, process.env.AUTH_LOGIN_RATE_LIMIT, 20);
    const loginIpWindow = resolveRateLimitInt(process.env.AUTH_LOGIN_IP_RATE_WINDOW, process.env.AUTH_LOGIN_RATE_WINDOW, 900); // 15 minutes

    // 2. Account identifier limit (normalized, length-limited, and SHA-256 hashed to avoid storing raw emails)
    const normalizedEmail = email.toLowerCase().trim().slice(0, 255);
    const accountHash = crypto.createHash('sha256').update(normalizedEmail).digest('hex').slice(0, 32);
    const accountKey = `acct_${accountHash}`;
    const acctLimit = resolveRateLimitInt(process.env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT, undefined, 5);
    const acctWindow = resolveRateLimitInt(process.env.AUTH_LOGIN_ACCOUNT_RATE_WINDOW, undefined, 900); // 15 minutes

    // 3. Atomically check and consume both login rate limits:
    // If either limit is exceeded, neither quota is consumed and expensive scrypt hashing is avoided.
    const loginStatus = await storage.rateLimits.consumeRateLimits([
      { key: clientIp, action: 'auth_login', limit: loginIpLimit, windowSeconds: loginIpWindow },
      { key: accountKey, action: 'auth_login_account', limit: acctLimit, windowSeconds: acctWindow }
    ]);

    if (!loginStatus.allowed) {
      res.setHeader('Retry-After', String(loginStatus.retryAfter));
      const isAcctBlocked = loginStatus.rejectedSpec?.action === 'auth_login_account';
      return res.status(429).json({ 
        error: isAcctBlocked
          ? 'Too many login attempts for this account. Please wait before trying again.'
          : 'Too many login attempts from this network. Please wait before trying again.',
        retryAfter: loginStatus.retryAfter
      });
    }

    // 3. Credential verification (applied only AFTER both rate-limit checks pass)
    const user = await storage.users.getUserByEmail(normalizedEmail);
    if (!user || !user.passwordHash || !user.salt) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const computedHash = crypto.scryptSync(password, user.salt, 64).toString('hex');
    if (!crypto.timingSafeEqual(Buffer.from(user.passwordHash, 'hex'), Buffer.from(computedHash, 'hex'))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const sessionToken = await storage.users.createSession(user.id);
    res.json({
      user: sanitizeUser(user),
      token: sessionToken,
    });
  } catch (err: any) {
    console.error('[Auth Login Error]:', err?.message || err);
    res.status(500).json({ error: 'Authentication service temporarily unavailable. Please try again later.' });
  }
});

apiRouter.post('/auth/logout', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    let token: string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.headers['x-session-token']) {
      token = String(req.headers['x-session-token']).trim();
    } else if ((req as any).cookies?.vr_session) {
      token = String((req as any).cookies.vr_session).trim();
    }
    if (token) {
      await storage.users.deleteSession(token);
    }
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Logout failed.' });
  }
});

// Password Recovery: Request Reset Token (Public, Non-enumerating, Rate-limited)
apiRouter.post('/auth/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    const clientIp = getClientIp(req);
    const fpStatus = await storage.rateLimits.consumeRateLimit(clientIp, 'forgot_password', 5, 900);
    if (!fpStatus.allowed) {
      res.setHeader('Retry-After', String(fpStatus.retryAfter));
      return res.status(429).json({ 
        error: 'Too many password reset requests. Please wait a few minutes before trying again.',
        retryAfter: fpStatus.retryAfter
      });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await storage.users.getUserByEmail(normalizedEmail);

    let devToken: string | undefined;

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour expiration

      await storage.passwordReset.createResetToken(user.id, tokenHash, expiresAt);

      // Safe development-only exposure for testing/local verification
      if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEV_RESET_TOKEN === 'true') {
        devToken = rawToken;
      }

      if (process.env.SMTP_HOST && process.env.SMTP_USER) {
        console.log(`[Auth] Dispatched password reset notification for account: ${user.email}`);
      }
    }

    // Strict non-enumerating response: never reveals whether email exists
    res.json({
      success: true,
      message: 'If an account exists with that email address, password reset instructions have been generated.',
      ...(devToken ? { devToken } : {})
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Unable to process password reset request.' });
  }
});

// Password Recovery: Confirm Reset (Public, Single-Use Token, Invalidate Sessions)
apiRouter.post('/auth/reset-password', async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Reset token is required.' });
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
    }

    const clientIp = getClientIp(req);
    const rpStatus = await storage.rateLimits.consumeRateLimit(clientIp, 'reset_password_attempt', 10, 900);
    if (!rpStatus.allowed) {
      res.setHeader('Retry-After', String(rpStatus.retryAfter));
      return res.status(429).json({ 
        error: 'Too many reset attempts. Please wait before trying again.',
        retryAfter: rpStatus.retryAfter
      });
    }

    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
    const resetRecord = await storage.passwordReset.getResetToken(tokenHash);

    if (!resetRecord) {
      return res.status(400).json({ error: 'Invalid or expired password reset token.' });
    }

    if (resetRecord.usedAt) {
      return res.status(400).json({ error: 'This password reset token has already been used.' });
    }

    if (new Date(resetRecord.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'This password reset token has expired. Please request a new one.' });
    }

    const user = await storage.users.getUser(resetRecord.userId);
    if (!user) {
      return res.status(400).json({ error: 'Associated user account no longer exists.' });
    }

    // Scrypt password hash
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(newPassword, salt, 64).toString('hex');

    await storage.users.updateUser(user.id, {
      passwordHash,
      salt
    });

    // Mark single-use token as permanently used
    await storage.passwordReset.markTokenUsed(tokenHash);

    // Invalidate all active sessions for this user to revoke unauthorized access
    await storage.passwordReset.revokeAllUserSessions(user.id);

    res.json({
      success: true,
      message: 'Your password has been successfully reset. Please sign in with your new password.'
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// Authenticated session check (Protected)
apiRouter.get('/auth/me', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const safe = sanitizeUser(user);
    res.json({
      ...safe,
      user: safe
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve session user.' });
  }
});

// Test Account listing — Gated strictly to development/test environments
apiRouter.get('/auth/accounts', async (req: Request, res: Response) => {
  if (!isTestSwitchingAllowed()) {
    return res.status(403).json({ error: 'Forbidden: Test account listing is disabled in this environment.' });
  }

  try {
    const allUsers = await storage.users.listUsers();
    const safeList = allUsers.map(u => ({
      id: u.id,
      email: u.email,
      plan: u.plan,
      creditsRemaining: u.creditsRemaining,
      totalScansCount: u.totalScansCount
    }));
    res.json(safeList);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list test accounts.' });
  }
});

// Test Account switcher — Gated strictly to development/test environments
apiRouter.post('/auth/switch-account', async (req: Request, res: Response) => {
  if (!isTestSwitchingAllowed()) {
    return res.status(403).json({ error: 'Forbidden: Account switching is disabled in this environment.' });
  }

  try {
    const { userId, email } = req.body;
    let targetUser: UserAccount | null = null;

    if (userId) {
      targetUser = await storage.users.getUser(userId);
    } else if (email) {
      targetUser = await storage.users.getUserByEmail(email);
    }

    if (!targetUser) {
      return res.status(404).json({ error: 'Target account not found.' });
    }

    const sessionToken = await storage.users.createSession(targetUser.id);
    res.json({
      user: sanitizeUser(targetUser),
      token: sessionToken,
      message: `Switched account to ${targetUser.email}`
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to switch account.' });
  }
});

apiRouter.post('/auth/switch-demo-user', async (req: Request, res: Response) => {
  if (!isTestSwitchingAllowed()) {
    return res.status(403).json({ error: 'Forbidden: Account switching is disabled in this environment.' });
  }

  try {
    const { userId, email } = req.body;
    let targetUser: UserAccount | null = null;

    if (userId) {
      targetUser = await storage.users.getUser(userId);
    } else if (email) {
      targetUser = await storage.users.getUserByEmail(email);
    }

    if (!targetUser) {
      return res.status(404).json({ error: 'Target account not found.' });
    }

    const sessionToken = await storage.users.createSession(targetUser.id);
    res.json({
      user: sanitizeUser(targetUser),
      token: sessionToken,
      message: `Switched account to ${targetUser.email}`
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to switch account.' });
  }
});

// 3. User & Usage Profile (Protected)
apiRouter.get('/user', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    res.json(sanitizeUser(user));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve user account.' });
  }
});

apiRouter.post('/user/plan', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { plan } = req.body;
    
    // Free trial can only be claimed once across the account lifecycle
    if (plan === 'free') {
      const result = await storage.users.claimFreeTrial(user.id);
      if (result.alreadyClaimed) {
        return res.status(409).json({
          error: 'Free trial has already been claimed for this account.',
          alreadyClaimed: true,
          user: sanitizeUser(result.user),
        });
      }
      return res.json(sanitizeUser(result.user));
    }

    // Paid tiers (creator, pro, agency, audit_once) MUST go through checkout session
    res.status(400).json({ 
      error: 'Paid plans require a verified checkout session. Please initiate checkout via /api/billing/checkout.',
      planRequested: plan
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update plan.' });
  }
});

// 4. Production Billing & Checkout Routes
apiRouter.post('/billing/checkout', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { planId } = req.body;
    if (!planId || !ALLOWED_PAID_PLANS.includes(planId as any)) {
      return res.status(400).json({ 
        error: `Valid paid plan ID is required for checkout. Allowed plans: ${ALLOWED_PAID_PLANS.join(', ')}` 
      });
    }

    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;

    const session = await billingService.createCheckoutSession({
      userId: user.id,
      planId,
      originUrl: origin,
    });

    res.json(session);
  } catch (err: any) {
    console.error('[API] Checkout session creation failed:', err.message);
    res.status(400).json({ error: err.message || 'Failed to create checkout session.' });
  }
});

// Webhook endpoint with fail-closed cryptographic signature verification and idempotency
apiRouter.post('/billing/webhook', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['stripe-signature'] as string | undefined;
    const rawBody = (req as any).rawBody as Buffer | undefined;

    const paymentMode = process.env.PAYMENT_MODE;
    const isProd = process.env.NODE_ENV === 'production' || paymentMode === 'production' || paymentMode === 'live';

    if (isProd) {
      if (!signature) {
        return res.status(400).json({ error: 'Missing stripe-signature header.' });
      }
      if (!rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        return res.status(400).json({ error: 'Missing raw request payload for webhook verification.' });
      }
    } else {
      if (!rawBody && !signature) {
        return res.status(400).json({ error: 'Missing webhook payload.' });
      }
    }

    const payloadBuffer = rawBody || Buffer.from(JSON.stringify(req.body));
    const result = await billingService.handleWebhook(payloadBuffer, signature || '');
    res.json(result);
  } catch (err: any) {
    console.error('[API Webhook Error]', err.message);
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/billing/session-status', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { sessionId, plan, mode } = req.query as { sessionId?: string; plan?: string; mode?: string };
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId query parameter is required.' });
    }

    const paymentMode = process.env.PAYMENT_MODE;
    const requireLive = process.env.NODE_ENV === 'production' || paymentMode === 'production' || paymentMode === 'live';

    if (mode === 'simulation') {
      if (requireLive) {
        return res.status(403).json({ error: 'Simulated checkout is disabled in production.' });
      }
      if (!plan || !ALLOWED_PAID_PLANS.includes(plan as any)) {
        return res.status(400).json({ 
          error: `Valid paid plan is required for simulated checkout (${ALLOWED_PAID_PLANS.join(', ')}).` 
        });
      }
      const updatedUser = await billingService.completeSimulatedCheckout(sessionId, plan, user.id);
      return res.json({ status: 'complete', paymentStatus: 'paid', mode: 'simulation', user: sanitizeUser(updatedUser) });
    }

    // Real verification via Stripe
    if (!billingService.isStripeClientConfigured()) {
      if (requireLive) {
        return res.status(503).json({ error: 'Stripe gateway is unconfigured in production.' });
      }
      return res.status(400).json({ error: 'Invalid checkout session or payment provider unconfigured.' });
    }

    const verification = await billingService.verifyCheckoutSession(sessionId, user.id);
    return res.json(verification);
  } catch (err: any) {
    const statusCode = (err.statusCode && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 401) ? err.statusCode : 400;
    res.status(statusCode).json({ error: err.message || 'Failed to verify session status.' });
  }
});

apiRouter.get('/usage', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const stats = await storage.usage.getUsageStats(user.id);
    res.json({ user: sanitizeUser(user), stats });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve usage stats.' });
  }
});

apiRouter.get('/plans', async (req: Request, res: Response) => {
  try {
    const plans = await storage.billing.getPlans();
    res.json(plans);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve plans.' });
  }
});

apiRouter.get('/billing/plans', async (req: Request, res: Response) => {
  try {
    const plans = await storage.billing.getPlans();
    res.json(plans);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve plans.' });
  }
});

// 5. Upload & Pre-inspection (Protected)
apiRouter.post(
  '/uploads',
  requireAuthMiddleware,
  uploadRateLimitMiddleware,
  uploadVideoMiddleware,
  async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return;
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided.' });
    }

    const filePath = req.file.path;
    const fileId = path.basename(filePath);

    // Track upload ownership record
    await storage.uploads.recordUpload({
      fileId,
      userId: user.id,
      filename: req.file.originalname,
      filePath,
      fileSize: req.file.size,
      type: 'video',
      createdAt: new Date().toISOString()
    });

    const metadata = await mediaInspector.inspect(filePath, req.file.originalname);

    const standardCredits = creditService.calculateRequiredCredits(metadata.durationSeconds, 'standard');
    const deepCredits = creditService.calculateRequiredCredits(metadata.durationSeconds, 'deep');

    res.json({
      fileId,
      filePath,
      filename: req.file.originalname,
      metadata,
      estimatedCredits: {
        standard: standardCredits,
        deep: deepCredits,
        inputMinutes: creditService.formatMinutes(metadata.durationSeconds)
      }
    });
  } catch (err: any) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    res.status(400).json({ error: err.message || 'Failed to inspect uploaded video.' });
  }
});

// 5b. Upload Thumbnail Image (Protected)
apiRouter.post('/uploads/thumbnail', requireAuthMiddleware, uploadThumbnailMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return;
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No thumbnail image file provided.' });
    }

    const filePath = req.file.path;
    const fileId = path.basename(filePath);

    // Track thumbnail ownership record
    await storage.uploads.recordUpload({
      fileId,
      userId: user.id,
      filename: req.file.originalname,
      filePath,
      fileSize: req.file.size,
      type: 'thumbnail',
      createdAt: new Date().toISOString()
    });

    const thumbnailMetadata = await thumbnailInspector.inspect(filePath, req.file.originalname);

    res.json({
      fileId,
      filePath,
      filename: req.file.originalname,
      thumbnailMetadata
    });
  } catch (err: any) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    res.status(400).json({ error: err.message || 'Failed to inspect uploaded thumbnail image.' });
  }
});

// 6. Channel Context Profile Endpoints (User-Owned & Scoped)
apiRouter.get('/channel/profile', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const profile = await storage.channelProfiles.getProfile(user.id);
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve channel context profile.' });
  }
});

apiRouter.put('/channel/profile', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const updated = await storage.channelProfiles.saveProfile(user.id, req.body);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save channel context profile.' });
  }
});

apiRouter.delete('/channel/profile', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const deleted = await storage.channelProfiles.deleteProfile(user.id);
    res.json({ success: deleted });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete channel context profile.' });
  }
});

// 6b. Cross-Video Recurring Patterns (Scoped strictly to user's authorized scan history)
apiRouter.get('/channel/patterns', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const userScans = await storage.scans.getAllScans(user.id);
    const completedScans = userScans.filter(s => s.status === 'COMPLETED');

    const patterns: CrossVideoPattern[] = [];
    const sampleSize = completedScans.length;

    if (sampleSize >= 2) {
      // 1. Analyze recurring lack of voiceover
      let lowVoiceCount = 0;
      let titleMismatchCount = 0;

      for (const s of completedScans) {
        const report = await storage.scans.getReport(s.id);
        if (report) {
          if (typeof report.originalContributionRatio === 'number' && report.originalContributionRatio < 20) {
            lowVoiceCount++;
          }
          if (report.topIssues.some(i => i.domain === 'title' && i.category === 'metadata_coherence')) {
            titleMismatchCount++;
          }
        }
      }

      if (lowVoiceCount >= 2) {
        patterns.push({
          id: 'pat_reused_signal',
          patternType: 'repeated_reused_signal',
          label: 'Recurring Absence of Creator Commentary',
          severity: 'warning',
          frequency: parseFloat(((lowVoiceCount / sampleSize) * 100).toFixed(0)),
          affectedScansCount: lowVoiceCount,
          explanation: `In ${lowVoiceCount} of your ${sampleSize} analyzed videos, audio tracks lacked an identifiable creator voice track.`,
          recommendation: 'Adding consistent spoken perspective or voiceover transforms material under YouTube YPP reused-content policies.',
          disclaimer: 'Observed pattern across your uploaded video sample; not an automated channel-wide YouTube audit.'
        });
      }

      if (titleMismatchCount >= 2) {
        patterns.push({
          id: 'pat_metadata_gap',
          patternType: 'title_content_mismatch',
          label: 'Recurring Title-to-Content Pacing Gap',
          severity: 'warning',
          frequency: parseFloat(((titleMismatchCount / sampleSize) * 100).toFixed(0)),
          affectedScansCount: titleMismatchCount,
          explanation: `In ${titleMismatchCount} of ${sampleSize} videos, titles suggested case studies while opening sequences lacked direct spoken hooks.`,
          recommendation: 'Ensure video openings immediately connect to the topic promised in the title.',
          disclaimer: 'Observed pattern across your uploaded video sample; not an automated channel-wide YouTube audit.'
        });
      }
    }

    res.json({
      sampleSize,
      patterns,
      disclaimer: 'Cross-video insights reflect patterns in your authorized uploaded scans only. YouTube Studio remains the authoritative destination for platform checks.'
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to compute cross-video patterns.' });
  }
});

// 7. Create Scan (with Path Traversal, Ownership & Credit Checks)
apiRouter.post('/scans', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { 
      videoPath, 
      videoFilename, 
      videoTitle, 
      videoDescription, 
      videoTags,
      thumbnailPath,
      thumbnailFilename,
      scanMode = 'standard',
      parentScanId,
      isRescan = false
    } = req.body;

    if (!videoPath || typeof videoPath !== 'string') {
      return res.status(400).json({ error: 'Valid video file path is required.' });
    }

    // Security: Safe Upload Path Traversal Check
    if (!isSafeUploadPath(videoPath)) {
      return res.status(403).json({ error: 'Access denied: Invalid or unauthorized video path.' });
    }

    // Security: Ownership verification of uploaded video file
    const videoUploadRecord = await storage.uploads.getUploadByPath(videoPath);
    if (videoUploadRecord && videoUploadRecord.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Uploaded video file belongs to another user.' });
    }

    // Security: Path Traversal & Ownership check for optional thumbnail
    if (thumbnailPath) {
      if (!isSafeUploadPath(thumbnailPath)) {
        return res.status(403).json({ error: 'Access denied: Invalid or unauthorized thumbnail path.' });
      }
      const thumbUploadRecord = await storage.uploads.getUploadByPath(thumbnailPath);
      if (thumbUploadRecord && thumbUploadRecord.userId !== user.id) {
        return res.status(403).json({ error: 'Access denied: Uploaded thumbnail file belongs to another user.' });
      }
    }

    // If re-scan, verify that parent scan belongs to this authenticated user
    if (parentScanId) {
      const parentScan = await storage.scans.getScan(parentScanId);
      if (!parentScan) {
        return res.status(404).json({ error: 'Parent scan not found.' });
      }
      if (parentScan.userId !== user.id) {
        return res.status(403).json({ error: 'Access denied: Parent scan belongs to another user.' });
      }
    }

    // Financial: Prevent queuing if user has 0 or insufficient credits
    if (user.creditsRemaining <= 0) {
      return res.status(402).json({ 
        error: 'Insufficient credits. Please top up or upgrade your plan to analyze videos.',
        creditsRemaining: user.creditsRemaining
      });
    }

    const scanId = `scan_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const scanJob: ScanJob = {
      id: scanId,
      userId: user.id,
      videoTitle: videoTitle || videoFilename || 'Untitled Video',
      videoDescription: videoDescription || '',
      videoTags: Array.isArray(videoTags) ? videoTags : undefined,
      videoFilename: videoFilename || path.basename(videoPath),
      videoPath,
      thumbnailPath: thumbnailPath || undefined,
      thumbnailFilename: thumbnailFilename || undefined,
      scanMode: (scanMode === 'deep' ? 'deep' : 'standard') as ScanMode,
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
      parentScanId,
      isRescan: !!isRescan
    };

    await storage.scans.createScan(scanJob);

    // Launch background asynchronous analysis
    jobOrchestrator.startJob(scanId);

    res.status(201).json(scanJob);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create scan.' });
  }
});

// 8. Create Demo Scan (Quick Creator Playground with Strict User Ownership)
apiRouter.post('/scans/demo', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { 
      demoType = 'problematic', 
      scanMode = 'standard',
      videoTitle,
      videoDescription,
      hasThumbnail = false
    } = req.body;

    if (user.creditsRemaining <= 0) {
      return res.status(402).json({ 
        error: 'Insufficient credits to launch demo scan.',
        creditsRemaining: user.creditsRemaining 
      });
    }

    const demoFilename = demoType === 'revised' 
      ? 'Clean_Cut_Creator_Commentary_Final.mp4' 
      : 'Top10_Gaming_Montage_With_Clips.mp4';
    const demoPath = path.join(uploadDir, `demo_${Date.now()}_${demoFilename}`);
    
    fs.writeFileSync(demoPath, 'VIDEORISK_SAMPLE_CONTAINER');

    let demoThumbPath: string | undefined;
    let demoThumbFilename: string | undefined;

    if (hasThumbnail) {
      demoThumbFilename = 'demo_thumbnail_16x9.jpg';
      demoThumbPath = path.join(uploadDir, `demo_thumb_${Date.now()}.jpg`);
      fs.writeFileSync(demoThumbPath, 'VIDEORISK_SAMPLE_THUMBNAIL');
    }

    const scanId = `scan_demo_${Date.now()}`;
    const scanJob: ScanJob = {
      id: scanId,
      userId: user.id,
      videoTitle: videoTitle || (demoType === 'revised' 
        ? 'How I Actually Built a Business (Revised Cut with Commentary)' 
        : 'How I Built a Real Business (Uncommentated Clips & Montage)'),
      videoDescription: videoDescription || (demoType === 'revised'
        ? 'In-depth original breakdown with voice commentary and critique of industry practices.'
        : 'Compilation of business clips and stock footage showing business growth.'),
      videoFilename: demoFilename,
      videoPath: demoPath,
      thumbnailPath: demoThumbPath,
      thumbnailFilename: demoThumbFilename,
      scanMode: scanMode as ScanMode,
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 2,
      createdAt: new Date().toISOString(),
      isRescan: demoType === 'revised',
      parentScanId: req.body.parentScanId
    };

    await storage.scans.createScan(scanJob);
    jobOrchestrator.startJob(scanId);

    res.status(201).json(scanJob);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to launch demo scan.' });
  }
});

// 9. Get All Scans (Strict User Ownership: returns only requesting user's scans)
apiRouter.get('/scans', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scans = await storage.scans.getAllScans(user.id);
    res.json(scans);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve scans.' });
  }
});

// 10. Get Single Scan Status (Strict IDOR protection: only scan owner may read)
apiRouter.get('/scans/:id', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scan = await storage.scans.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: 'Scan job not found.' });
    }
    if (scan.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: You do not own this scan.' });
    }
    res.json(scan);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve scan status.' });
  }
});

// 11. Get Evidence (Strict IDOR protection)
apiRouter.get('/scans/:id/evidence', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scan = await storage.scans.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: 'Scan job not found.' });
    }
    if (scan.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Evidence belongs to another user.' });
    }
    const evidence = await storage.evidence.getEvidence(req.params.id);
    res.json(evidence);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve evidence.' });
  }
});

// 12. Get Report (Strict IDOR protection)
apiRouter.get('/scans/:id/report', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scan = await storage.scans.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: 'Scan job not found.' });
    }
    if (scan.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Report belongs to another user.' });
    }
    const report = await storage.scans.getReport(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Report not yet generated or scan not found.' });
    }
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve report.' });
  }
});

// 13. Re-scan Endpoint (Strict IDOR protection)
apiRouter.post('/scans/:id/rescan', requireAuthMiddleware, validateRescanAuthorization, uploadVideoMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return;
    }

    const parentScan = (req as any).parentScan || await storage.scans.getScan(req.params.id);
    if (!parentScan) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return res.status(404).json({ error: 'Original scan not found.' });
    }
    if (parentScan.userId !== user.id) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return res.status(403).json({ error: 'Access denied: Cannot re-scan video belonging to another user.' });
    }

    if (user.creditsRemaining <= 0) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return res.status(402).json({ 
        error: 'Insufficient credits for re-scan. Please top up your balance.',
        creditsRemaining: user.creditsRemaining 
      });
    }

    let filePath = '';
    let filename = '';

    if (req.file) {
      filePath = req.file.path;
      filename = req.file.originalname;
      await storage.uploads.recordUpload({
        fileId: path.basename(filePath),
        userId: user.id,
        filename,
        filePath,
        fileSize: req.file.size,
        type: 'video',
        createdAt: new Date().toISOString()
      });
    } else if (req.body.videoPath && isSafeUploadPath(req.body.videoPath)) {
      filePath = req.body.videoPath;
      filename = req.body.videoFilename || path.basename(filePath);
      const uploadRec = await storage.uploads.getUploadByPath(filePath);
      if (uploadRec && uploadRec.userId !== user.id) {
        return res.status(403).json({ error: 'Access denied: Video file belongs to another user.' });
      }
    } else {
      filename = `Revised_${parentScan.videoFilename}`;
      filePath = path.join(uploadDir, `demo_rescan_${Date.now()}.mp4`);
      fs.writeFileSync(filePath, 'VIDEORISK_RESCAN_CONTAINER');
    }

    const newScanId = `scan_rescan_${Date.now()}`;

    const rescanJob: ScanJob = {
      id: newScanId,
      userId: user.id,
      videoTitle: `${parentScan.videoTitle} (Revised Cut)`,
      videoDescription: parentScan.videoDescription,
      videoFilename: filename,
      videoPath: filePath,
      thumbnailPath: parentScan.thumbnailPath,
      thumbnailFilename: parentScan.thumbnailFilename,
      scanMode: parentScan.scanMode,
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
      parentScanId: parentScan.id,
      isRescan: true
    };

    await storage.scans.createScan(rescanJob);
    jobOrchestrator.startJob(newScanId);

    res.status(201).json(rescanJob);
  } catch (err: any) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    res.status(500).json({ error: err.message || 'Failed to initiate re-scan.' });
  }
});

// 14. Comparison Endpoint (Strict IDOR protection)
apiRouter.get('/scans/:id/comparison', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scan = await storage.scans.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found.' });
    }
    if (scan.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Comparison belongs to another user.' });
    }

    const comparison = await storage.scans.getComparison(req.params.id);
    if (!comparison) {
      return res.status(404).json({ error: 'Comparison delta not found for this scan.' });
    }
    res.json(comparison);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve comparison.' });
  }
});

// 15. Secure Scan Deletion & Asset Retention Cleanup (Workstream 14 / Targeted Production Readiness)
apiRouter.delete('/scans/:id', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scan = await storage.scans.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found.' });
    }
    if (scan.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Cannot delete scan belonging to another user.' });
    }

    // Active Job Protection: Do not delete files while job is running in a worker
    const job = await storage.queue.getJobByScanId(scan.id);
    if (job && job.status === 'RUNNING') {
      return res.status(409).json({ error: 'Cannot delete scan while video analysis is actively running.' });
    }

    // Identify candidate paths for scan-owned media files and artifacts
    // Identify candidate paths for scan-owned media files and artifacts
    const candidatePaths: string[] = [];
    if (scan.videoPath && scan.videoPath.trim()) candidatePaths.push(scan.videoPath.trim());
    if (scan.thumbnailPath && scan.thumbnailPath.trim()) candidatePaths.push(scan.thumbnailPath.trim());
    if (scan.proxyPath && scan.proxyPath.trim()) candidatePaths.push(scan.proxyPath.trim());

    // Also check for generated proxy artifact even if proxyPath was not stored on scan record
    if (scan.videoPath && scan.videoPath.trim()) {
      const baseName = path.basename(scan.videoPath, path.extname(scan.videoPath));
      const potentialProxy = path.join(uploadDir, 'proxies', `proxy_${baseName}.mp4`);
      if (fs.existsSync(potentialProxy) && !candidatePaths.includes(potentialProxy)) {
        candidatePaths.push(potentialProxy);
      }
    }

    // Validate path safety against directory traversal and symlink escapes for all candidates
    for (const p of candidatePaths) {
      const validation = validateSafeStoragePath(p);
      if (!validation.isSafe) {
        console.error('[Storage Security] Unsafe file path rejected during scan deletion:', validation.error);
        return res.status(400).json({ error: 'Invalid or unsafe media path in scan record.' });
      }
    }

    let filesRemoved = 0;
    let cleanupFailed = false;

    // Deduplicate candidate paths
    const uniqueCandidates = Array.from(new Set(candidatePaths));

    for (const p of uniqueCandidates) {
      const resolved = path.resolve(p);

      // Handle missing files idempotently
      if (!fs.existsSync(resolved)) {
        continue;
      }

      // Protection against deleting another scan's files:
      // Verify if another scan shares this media file
      const isShared = await storage.scans.isMediaShared(resolved, scan.id);
      if (isShared) {
        continue;
      }

      try {
        fs.unlinkSync(resolved);
        filesRemoved++;
      } catch (err: any) {
        // Log cleanup failure without exposing sensitive filesystem paths to the client
        console.error('[Storage] Filesystem cleanup failed for scan asset:', err?.code || err?.message || 'Unknown error');
        cleanupFailed = true;
      }
    }

    // Inconsistent state guard: If cleanup failed for files that remain on disk,
    // do NOT permanently purge DB records. Mark status as CLEANUP_PENDING and return 500.
    if (cleanupFailed) {
      await storage.scans.updateScan(scan.id, {
        status: 'CLEANUP_PENDING',
        error: 'Media file cleanup failed. Files remain on disk pending retry.'
      }, { systemBypass: true });

      return res.status(500).json({
        error: 'Failed to completely remove media files from storage. Scan marked for cleanup retry.',
        scanId: scan.id,
        status: 'CLEANUP_PENDING'
      });
    }

    // Filesystem cleanup succeeded (or files were already absent / shared).
    // Attempt permanent database record purge.
    let dbDeleted = false;
    try {
      dbDeleted = await storage.scans.deleteScan(req.params.id);
    } catch (dbErr: any) {
      console.error('[Storage] Database deletion failed for scan after file cleanup:', dbErr?.code || dbErr?.message || 'Database error');
      dbDeleted = false;
    }

    if (!dbDeleted) {
      // Partial failure state: Filesystem deletion succeeded, but DB deletion failed.
      // Attempt to transition the scan record to a documented, detectable, and recoverable state (CLEANUP_PENDING),
      // clear dangling file references, and record that media files were removed.
      let recoveryConfirmed = false;
      let verificationIssue = '';

      try {
        const updateResult = await storage.scans.updateScan(scan.id, {
          status: 'CLEANUP_PENDING',
          videoPath: '',
          thumbnailPath: '',
          proxyPath: '',
          error: 'Media assets removed from disk, but database record purge failed. Awaiting deletion retry.',
          metadata: {
            ...(scan.metadata || {} as any),
            mediaCleaned: true,
            mediaCleanedAt: new Date().toISOString(),
            filesRemovedCount: filesRemoved
          } as any
        }, { systemBypass: true });

        // Storage contract: updateScan returns null if record was not found or update could not be performed
        if (updateResult) {
          // Re-read scan record to determine its actual persisted state rather than inferring from attempted update
          try {
            const persistedScan = await storage.scans.getScan(scan.id);
            if (!persistedScan) {
              verificationIssue = 'scan record not found on re-read';
            } else if (persistedScan.status !== 'CLEANUP_PENDING') {
              verificationIssue = `status mismatch (expected: CLEANUP_PENDING, got: ${persistedScan.status})`;
            } else if (persistedScan.videoPath && persistedScan.videoPath.trim() !== '') {
              verificationIssue = 'videoPath was not cleared';
            } else if (persistedScan.thumbnailPath && persistedScan.thumbnailPath.trim() !== '') {
              verificationIssue = 'thumbnailPath was not cleared';
            } else if (persistedScan.proxyPath && persistedScan.proxyPath.trim() !== '') {
              verificationIssue = 'proxyPath was not cleared';
            } else if ((persistedScan.metadata as any)?.mediaCleaned !== true) {
              verificationIssue = 'metadata.mediaCleaned is not true';
            } else if (typeof (persistedScan.metadata as any)?.mediaCleanedAt !== 'string' || (persistedScan.metadata as any)?.mediaCleanedAt.trim() === '') {
              verificationIssue = 'metadata.mediaCleanedAt timestamp is missing or whitespace-only';
            } else if (typeof (persistedScan.metadata as any)?.filesRemovedCount !== 'number' || (persistedScan.metadata as any)?.filesRemovedCount !== filesRemoved) {
              verificationIssue = `metadata.filesRemovedCount mismatch (expected: ${filesRemoved}, got: ${(persistedScan.metadata as any)?.filesRemovedCount})`;
            } else {
              recoveryConfirmed = true;
            }

            if (!recoveryConfirmed) {
              console.warn(`[Storage] Scan ${scan.id} recovery verification failed: ${verificationIssue}`);
            }
          } catch (readErr: any) {
            verificationIssue = `re-read exception: ${readErr?.message || readErr}`;
            console.error('[Storage] Failed to re-read scan to verify recovery persistence:', readErr?.message || readErr);
          }
        } else {
          verificationIssue = 'updateScan returned null';
          console.warn(`[Storage] updateScan returned null for scan ${scan.id} during deletion recovery.`);
        }
      } catch (updateErr: any) {
        verificationIssue = `updateScan exception: ${updateErr?.message || updateErr}`;
        console.error('[Storage] Failed to update scan record during deletion recovery:', updateErr?.message || updateErr);
      }

      if (recoveryConfirmed) {
        return res.status(500).json({
          error: 'Media assets removed, but database deletion failed. Scan marked for deletion retry.',
          scanId: scan.id,
          status: 'CLEANUP_PENDING',
          mediaCleaned: true,
          statePersisted: true
        });
      }

      // If recovery update failed or could not be confirmed via re-read:
      // Truthful error response: do NOT falsely claim CLEANUP_PENDING or mediaCleaned: true was persisted.
      console.error(`[Storage] CRITICAL: Scan deletion failed and recovery state could not be confirmed for scan ${scan.id}. Files removed: ${filesRemoved}. Issue: ${verificationIssue || 'unknown'}. Diagnostic information preserved for operational investigation.`);
      return res.status(500).json({
        error: 'Media assets removed, but database deletion and recovery state persistence could not be confirmed.',
        scanId: scan.id,
        statePersisted: false
      });
    }

    res.json({
      success: true,
      deletedScanId: req.params.id,
      filesRemoved,
      message: 'Scan and associated assets securely deleted from storage.'
    });
  } catch (err: any) {
    console.error('[Storage] Unexpected error during scan deletion:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete scan.' });
  }
});

// 16. Secure Upload Deletion (Workstream 14)
apiRouter.delete('/uploads/:fileId', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const upload = await storage.uploads.getUpload(req.params.fileId);
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found.' });
    }
    if (upload.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Cannot delete file belonging to another user.' });
    }

    if (isSafeUploadPath(upload.filePath) && fs.existsSync(upload.filePath)) {
      try {
        fs.unlinkSync(upload.filePath);
      } catch (e) {
        console.warn('[Storage] Failed to unlink upload file:', e);
      }
    }

    const deleted = await storage.uploads.deleteUpload(req.params.fileId);
    res.json({
      success: deleted,
      fileId: req.params.fileId,
      message: 'Uploaded file securely removed from storage.'
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete upload.' });
  }
});

// 16b. Secure Delivery of Uploaded Media & Artifacts (Protected against unauth, IDOR, traversal)
apiRouter.get('/uploads/:filePath(*)', secureUploadsHandler);
apiRouter.get('/uploads', secureUploadsHandler);

// 16c. Issue Scoped, Short-Lived Media Access Token
apiRouter.post('/media/token', requireAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { fileId, durationSeconds = 120 } = req.body;
    if (!fileId || typeof fileId !== 'string') {
      return res.status(400).json({ error: 'fileId is required.' });
    }

    const cleanFileId = path.normalize(fileId).replace(/^\/+/, '');
    const targetPath = path.resolve(uploadDir, cleanFileId);

    // Validate path safety against traversal
    const validation = validateSafeStoragePath(targetPath);
    if (!validation.isSafe) {
      return res.status(403).json({ error: 'Invalid file path.' });
    }

    // Verify ownership
    const owner = await getMediaOwner(validation.resolvedPath);
    if (!owner) {
      return res.status(404).json({ error: 'Media asset not found or unowned.' });
    }
    if (owner.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: You do not own this media asset.' });
    }

    const parsedDuration = sanitizeMediaTokenDuration(durationSeconds);

    const mediaToken = createMediaAccessToken(user.id, cleanFileId, parsedDuration);
    const expiresAt = new Date(Date.now() + (parsedDuration * 1000)).toISOString();

    res.json({
      mediaToken,
      fileId: cleanFileId,
      expiresAt,
      expiresInSeconds: parsedDuration,
      mediaUrl: `/uploads/${cleanFileId}?media_token=${mediaToken}`
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to generate media token.' });
  }
});

// 17. Operational Metrics & Cost Telemetry (Workstream 12)
apiRouter.get('/operational/metrics', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    if (storage.getOperationalMetrics) {
      const metrics = await storage.getOperationalMetrics();
      return res.json(metrics);
    }

    res.json({
      totalScans: 0,
      completedScans: 0,
      failedScans: 0,
      averageProcessingSeconds: 0,
      totalDurationSecondsScanned: 0,
      estimatedComputeCostUsd: 0,
      estimatedStorageCostUsd: 0,
      measuredStageAveragesMs: {
        inspection: 0,
        audio: 0,
        video: 0,
        policy: 0
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve operational metrics.' });
  }
});
