import fs from 'fs';
import path from 'path';
import { ScanJob, UserAccount } from '../../types';
import { IStorageRepository, storage as defaultStorage, AccountDeletionResult } from '../storage';
import {
  cleanupMediaPaths,
  cleanupScanFrameDirectories,
  collectScanMediaPaths,
  getDefaultUploadDir,
  validateSafeStoragePath,
} from './mediaCleanupService';
import { isAuthorizedAdminUser, isVerifiedOwnerUser } from './ownerAuth';

export interface AccountDeletionWorkflowResult {
  ok: boolean;
  statusCode: number;
  error?: string;
  code?: string;
  status?: string;
  deletedUserId?: string;
  anonymizedSubjectId?: string;
  filesRemoved?: number;
  archivedBillingRecords?: number;
}

export async function executePermanentAccountDeletion(
  user: UserAccount,
  options: {
    storage?: IStorageRepository;
    uploadDir?: string;
    env?: NodeJS.ProcessEnv;
    unlinkFn?: (targetPath: string) => void;
    isTrustedPublicMediaFn?: (resolvedPath: string) => boolean;
    failDbDeletionForTest?: boolean;
  } = {}
): Promise<AccountDeletionWorkflowResult> {
  const storageRepo = options.storage ?? defaultStorage;
  const resolvedUploadDir = path.resolve(options.uploadDir || getDefaultUploadDir());
  const env = options.env ?? process.env;

  // 1. Protect privileged owner & admin accounts from self-service deletion
  if (isVerifiedOwnerUser(user, env) || isAuthorizedAdminUser(user, env)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'Forbidden: Protected owner or administrator accounts cannot be deleted through self-service.',
      code: 'PROTECTED_ACCOUNT',
    };
  }

  // 2. Check for active RUNNING jobs belonging to this user
  const userScans = await storageRepo.scans.getAllScans(user.id);
  for (const scan of userScans) {
    const job = await storageRepo.queue.getJobByScanId(scan.id);
    if (job && job.status === 'RUNNING') {
      return {
        ok: false,
        statusCode: 409,
        error: 'Cannot delete account while video analysis is actively running.',
        code: 'ACTIVE_SCAN_RUNNING',
      };
    }
  }

  // 3. Gather all candidate media paths from user's scans and upload records
  const candidatePaths: string[] = [];
  const scanPathMap = new Map<string, string[]>();

  for (const scan of userScans) {
    const scanPaths = collectScanMediaPaths(scan, { uploadDir: resolvedUploadDir });
    scanPathMap.set(scan.id, scanPaths.map((p) => path.resolve(p)));
    candidatePaths.push(...scanPaths);
  }

  if (storageRepo.uploads.listUploads) {
    const allUploads = await storageRepo.uploads.listUploads();
    for (const up of allUploads) {
      if (up.userId === user.id && up.filePath && up.filePath.trim()) {
        candidatePaths.push(up.filePath.trim());
      }
    }
  }

  // Validate safety of all paths up front
  for (const p of candidatePaths) {
    const validation = validateSafeStoragePath(p, {
      mustExist: false,
      uploadDir: resolvedUploadDir,
      env,
    });
    if (!validation.isSafe) {
      console.error('[Account Deletion] Rejected unsafe media path during preflight:', validation.error);
      return {
        ok: false,
        statusCode: 400,
        error: 'Invalid or unsafe media path encountered during account cleanup.',
        code: 'UNSAFE_MEDIA_PATH',
      };
    }
  }

  // 4. Delete unshared media files while preserving any asset referenced by another user
  const cleanupResult = await cleanupMediaPaths(candidatePaths, {
    storage: storageRepo,
    excludeUserId: user.id,
    uploadDir: resolvedUploadDir,
    env,
    unlinkFn: options.unlinkFn,
    isTrustedPublicMediaFn: options.isTrustedPublicMediaFn,
  });

  if (!cleanupResult.ok) {
    const failedSet = new Set(cleanupResult.failedPaths.map((p) => path.resolve(p)));
    for (const scan of userScans) {
      const sPaths = scanPathMap.get(scan.id) || [];
      if (sPaths.some((p) => failedSet.has(p))) {
        try {
          await storageRepo.scans.updateScan(
            scan.id,
            {
              status: 'CLEANUP_PENDING',
              error: 'Account deletion paused: media cleanup failed and files remain on disk pending retry.',
            },
            { systemBypass: true }
          );
        } catch {
          // Best-effort status mark
        }
      }
    }

    return {
      ok: false,
      statusCode: 500,
      error: 'Failed to remove all user media files from storage. Account was preserved and affected scans marked CLEANUP_PENDING.',
      code: 'MEDIA_CLEANUP_FAILED',
      status: 'CLEANUP_PENDING',
    };
  }

  // Remove scan frame subdirectories once media files succeeded
  for (const scan of userScans) {
    cleanupScanFrameDirectories(scan.id, { uploadDir: resolvedUploadDir, env });
  }

  // 5. Execute atomic database purge + anonymized billing archive
  let deletionResult: AccountDeletionResult;
  try {
    if (options.failDbDeletionForTest) {
      throw new Error('Simulated database deletion failure');
    }
    deletionResult = await storageRepo.users.deleteAccount(user.id);
    if (!deletionResult.deleted) {
      throw new Error('User record deletion returned false');
    }
  } catch (dbErr: any) {
    console.error('[Account Deletion] Database purge failed after media cleanup:', dbErr?.message || dbErr);

    const removedSet = new Set(cleanupResult.removedPaths.map((p) => path.resolve(p)));
    const cleanedAt = new Date().toISOString();

    for (const scan of userScans) {
      const clearVideo = scan.videoPath && removedSet.has(path.resolve(scan.videoPath));
      const clearProxy = scan.proxyPath && removedSet.has(path.resolve(scan.proxyPath));
      const clearThumb = scan.thumbnailPath && removedSet.has(path.resolve(scan.thumbnailPath));
      if (clearVideo || clearProxy || clearThumb) {
        try {
          await storageRepo.scans.updateScan(
            scan.id,
            {
              status: 'CLEANUP_PENDING',
              videoPath: clearVideo ? '' : scan.videoPath,
              proxyPath: clearProxy ? '' : scan.proxyPath,
              thumbnailPath: clearThumb ? '' : scan.thumbnailPath,
              error: 'Media assets removed from disk, but database account deletion failed. Marked CLEANUP_PENDING.',
              metadata: {
                ...(scan.metadata || ({} as any)),
                mediaCleaned: true,
                mediaCleanedAt: cleanedAt,
              } as any,
            },
            { systemBypass: true }
          );
        } catch {
          // Best-effort recovery state
        }
      }
    }

    return {
      ok: false,
      statusCode: 500,
      error: 'Media assets removed, but database account deletion failed. Affected scans marked CLEANUP_PENDING.',
      code: 'ACCOUNT_DELETION_DB_FAILED',
      status: 'CLEANUP_PENDING',
    };
  }

  return {
    ok: true,
    statusCode: 200,
    deletedUserId: user.id,
    anonymizedSubjectId: deletionResult.anonymizedSubjectId,
    filesRemoved: cleanupResult.filesRemoved,
    archivedBillingRecords: deletionResult.archivedBillingRecords,
  };
}
