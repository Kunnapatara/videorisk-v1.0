import fs from 'fs';
import path from 'path';
import os from 'os';
import { ScanJob } from '../../types';
import { isProductionEnvironment } from '../config/environment';
import { IStorageRepository } from '../storage';

export interface SafeStoragePathValidation {
  isSafe: boolean;
  resolvedPath: string;
  error?: string;
}

export function getDefaultUploadDir(): string {
  return path.resolve(process.cwd(), 'uploads');
}

/**
 * Validates that a candidate filesystem path is safely confined inside allowed upload storage.
 * In non-production environments, also permits `os.tmpdir()` for isolated tests.
 * Prevents path traversal, prefix-collision escapes, directory deletion, and symlink jumping.
 */
export function validateSafeStoragePath(
  candidatePath: string,
  options: { mustExist?: boolean; uploadDir?: string; env?: NodeJS.ProcessEnv } = {}
): SafeStoragePathValidation {
  try {
    if (!candidatePath || typeof candidatePath !== 'string') {
      return { isSafe: false, resolvedPath: '', error: 'Candidate path is empty or invalid.' };
    }

    const resolvedUploadDir = path.resolve(options.uploadDir || getDefaultUploadDir());
    const resolved = path.resolve(candidatePath);
    const env = options.env ?? process.env;

    const allowedRoots = [resolvedUploadDir];
    if (!isProductionEnvironment(env)) {
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

    if (!relToRoot || relToRoot === '.' || relToRoot === 'proxies' || relToRoot === 'frames') {
      return { isSafe: false, resolvedPath: resolved, error: 'Target path cannot be the root storage directory.' };
    }

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
    return {
      isSafe: false,
      resolvedPath: '',
      error: `Path resolution error for '${candidatePath}': ${err?.message || err}`,
    };
  }
}

export function isSafeUploadPath(
  candidatePath: string,
  options: { uploadDir?: string; env?: NodeJS.ProcessEnv } = {}
): boolean {
  return validateSafeStoragePath(candidatePath, { ...options, mustExist: true }).isSafe;
}

/**
 * Collects unique candidate media paths (source video, thumbnail, proxy, derived proxy)
 * belonging to a scan record.
 */
export function collectScanMediaPaths(
  scan: ScanJob,
  options: { uploadDir?: string } = {}
): string[] {
  const resolvedUploadDir = path.resolve(options.uploadDir || getDefaultUploadDir());
  const candidates: string[] = [];

  if (scan.videoPath && scan.videoPath.trim()) {
    candidates.push(scan.videoPath.trim());
  }
  if (scan.thumbnailPath && scan.thumbnailPath.trim()) {
    candidates.push(scan.thumbnailPath.trim());
  }
  if (scan.proxyPath && scan.proxyPath.trim()) {
    candidates.push(scan.proxyPath.trim());
  }

  if (scan.videoPath && scan.videoPath.trim()) {
    const baseName = path.basename(scan.videoPath, path.extname(scan.videoPath));
    if (baseName) {
      const potentialProxy = path.join(resolvedUploadDir, 'proxies', `proxy_${baseName}.mp4`);
      if (fs.existsSync(potentialProxy)) {
        candidates.push(potentialProxy);
      }
    }
  }

  return Array.from(new Set(candidates));
}

/**
 * Returns frame subdirectories inside `uploads/frames/` strictly matching `scanId`
 * (or `${scanId}_<timestamp/random>`) without unsafe substring matching.
 */
export function findScanFrameDirectories(
  scanId: string,
  options: { uploadDir?: string } = {}
): string[] {
  if (!scanId || typeof scanId !== 'string') return [];
  const framesDir = path.resolve(options.uploadDir || getDefaultUploadDir(), 'frames');
  if (!fs.existsSync(framesDir)) return [];

  const matched: string[] = [];
  try {
    const entries = fs.readdirSync(framesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name === scanId) {
        matched.push(path.join(framesDir, name));
      } else if (name.startsWith(`${scanId}_`)) {
        const suffix = name.substring(scanId.length + 1);
        if (/^[0-9]+(_[a-z0-9]+)?$/i.test(suffix)) {
          matched.push(path.join(framesDir, name));
        }
      }
    }
  } catch {
    // Non-fatal if frames dir cannot be read
  }
  return matched;
}

/**
 * Removes frame subdirectories owned by a scan, validating path safety before deletion.
 */
export function cleanupScanFrameDirectories(
  scanId: string,
  options: { uploadDir?: string; env?: NodeJS.ProcessEnv } = {}
): number {
  const dirs = findScanFrameDirectories(scanId, options);
  let removedFiles = 0;
  for (const dirPath of dirs) {
    const validation = validateSafeStoragePath(dirPath, {
      mustExist: false,
      uploadDir: options.uploadDir,
      env: options.env,
    });
    if (!validation.isSafe || !fs.existsSync(validation.resolvedPath)) continue;
    try {
      const entries = fs.readdirSync(validation.resolvedPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          fs.unlinkSync(path.join(validation.resolvedPath, entry.name));
          removedFiles++;
        }
      }
      fs.rmdirSync(validation.resolvedPath);
    } catch {
      // Ignore partial frame dir cleanup errors if files remain locked
    }
  }
  return removedFiles;
}

/**
 * Checks whether a resolved media path is referenced by any remaining scan outside `excludeScanIds`,
 * or by an upload record owned by another user when `excludeUserId` is supplied.
 */
export async function isMediaPathSharedOutsideScope(
  filePath: string,
  storageRepo: IStorageRepository,
  options: {
    excludeScanIds?: Set<string>;
    excludeUserId?: string;
    allScansCache?: ScanJob[];
  } = {}
): Promise<boolean> {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  const excludeScanIds = options.excludeScanIds ?? new Set<string>();

  if (excludeScanIds.size === 1 && !options.excludeUserId && !options.allScansCache) {
    const [onlyScanId] = Array.from(excludeScanIds);
    return storageRepo.scans.isMediaShared(resolved, onlyScanId);
  }

  const allScans = options.allScansCache ?? (await storageRepo.scans.getAllScans());
  const sharedByScan = allScans.some((scan) => {
    if (excludeScanIds.has(scan.id)) return false;
    if (options.excludeUserId && scan.userId === options.excludeUserId) return false;
    const v = scan.videoPath ? path.resolve(scan.videoPath) : '';
    const p = scan.proxyPath ? path.resolve(scan.proxyPath) : '';
    const t = scan.thumbnailPath ? path.resolve(scan.thumbnailPath) : '';
    return v === resolved || p === resolved || t === resolved;
  });

  if (sharedByScan) {
    return true;
  }

  if (options.excludeUserId && storageRepo.uploads.listUploads) {
    const uploads = await storageRepo.uploads.listUploads();
    const sharedByOtherUpload = uploads.some(
      (up) => up.userId !== options.excludeUserId && path.resolve(up.filePath) === resolved
    );
    if (sharedByOtherUpload) {
      return true;
    }
  }

  return false;
}

export interface MediaCleanupBatchResult {
  ok: boolean;
  unsafePath?: string;
  unsafeError?: string;
  filesRemoved: number;
  removedPaths: string[];
  failedPaths: string[];
  skippedSharedPaths: string[];
}

/**
 * Safely validates and removes unshared media files for scan deletion, account deletion,
 * and automated retention sweeps.
 */
export async function cleanupMediaPaths(
  candidatePaths: string[],
  options: {
    storage: IStorageRepository;
    excludeScanIds?: Set<string>;
    excludeUserId?: string;
    allScansCache?: ScanJob[];
    uploadDir?: string;
    env?: NodeJS.ProcessEnv;
    unlinkFn?: (targetPath: string) => void;
    isTrustedPublicMediaFn?: (resolvedPath: string) => boolean;
  }
): Promise<MediaCleanupBatchResult> {
  const uniqueResolved = Array.from(
    new Set(
      candidatePaths
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => path.resolve(p.trim()))
    )
  );

  // Phase 1: Validate every candidate path BEFORE deleting anything
  for (const p of uniqueResolved) {
    const validation = validateSafeStoragePath(p, {
      mustExist: false,
      uploadDir: options.uploadDir,
      env: options.env,
    });
    if (!validation.isSafe) {
      return {
        ok: false,
        unsafePath: p,
        unsafeError: validation.error,
        filesRemoved: 0,
        removedPaths: [],
        failedPaths: [p],
        skippedSharedPaths: [],
      };
    }
  }

  const unlink = options.unlinkFn ?? fs.unlinkSync;
  const removedPaths: string[] = [];
  const failedPaths: string[] = [];
  const skippedSharedPaths: string[] = [];

  for (const resolved of uniqueResolved) {
    if (!fs.existsSync(resolved)) {
      continue;
    }

    if (options.isTrustedPublicMediaFn && options.isTrustedPublicMediaFn(resolved)) {
      skippedSharedPaths.push(resolved);
      continue;
    }

    const isShared = await isMediaPathSharedOutsideScope(resolved, options.storage, {
      excludeScanIds: options.excludeScanIds,
      excludeUserId: options.excludeUserId,
      allScansCache: options.allScansCache,
    });

    if (isShared) {
      skippedSharedPaths.push(resolved);
      continue;
    }

    try {
      unlink(resolved);
      removedPaths.push(resolved);
    } catch (err: any) {
      console.error(
        '[Storage] Filesystem cleanup failed for media asset:',
        err?.code || err?.message || 'Unknown error'
      );
      failedPaths.push(resolved);
    }
  }

  return {
    ok: failedPaths.length === 0,
    filesRemoved: removedPaths.length,
    removedPaths,
    failedPaths,
    skippedSharedPaths,
  };
}
