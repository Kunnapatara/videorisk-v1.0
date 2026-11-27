import fs from 'fs';
import path from 'path';
import { ScanJob } from '../../types';
import {
  resolveRetentionConfiguration,
  RetentionConfiguration,
} from '../config/environment';
import { storage as defaultStorage, IStorageRepository } from '../storage';
import {
  cleanupMediaPaths,
  cleanupScanFrameDirectories,
  collectScanMediaPaths,
  getDefaultUploadDir,
  validateSafeStoragePath,
} from './mediaCleanupService';

export interface RetentionSweepSummary {
  executed: boolean;
  skippedOverlap: boolean;
  startedAt: string;
  completedAt: string;
  config: RetentionConfiguration;
  pendingScansReconciled: number;
  pendingScansPurged: number;
  expiredScansMediaCleaned: number;
  expiredFilesRemoved: number;
  expiredUploadsRemoved: number;
  tempArtifactsRemoved: number;
  errors: number;
}

export interface RetentionServiceOptions {
  storage?: IStorageRepository;
  uploadDir?: string;
  env?: NodeJS.ProcessEnv;
  nowFn?: () => number;
  unlinkFn?: (targetPath: string) => void;
  trustedPublicFilenames?: Set<string>;
}

const DEFAULT_TRUSTED_PUBLIC_FILENAMES = new Set<string>([
  'sample_public_demo.mp4',
  'sample_public_test.mp4',
  'public_demo_sample.mp4',
]);

export class RetentionService {
  private readonly storage: IStorageRepository;
  private readonly uploadDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nowFn: () => number;
  private readonly unlinkFn: (targetPath: string) => void;
  private readonly trustedPublicFilenames: Set<string>;

  private sweepInProgress = false;
  private intervalTimer: NodeJS.Timeout | null = null;
  private initialDelayTimer: NodeJS.Timeout | null = null;

  constructor(options: RetentionServiceOptions = {}) {
    this.storage = options.storage ?? defaultStorage;
    this.uploadDir = path.resolve(options.uploadDir || getDefaultUploadDir());
    this.env = options.env ?? process.env;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.unlinkFn = options.unlinkFn ?? fs.unlinkSync;
    this.trustedPublicFilenames = options.trustedPublicFilenames ?? DEFAULT_TRUSTED_PUBLIC_FILENAMES;
  }

  public getConfiguration(): RetentionConfiguration {
    return resolveRetentionConfiguration(this.env);
  }

  public isRunning(): boolean {
    return this.sweepInProgress;
  }

  private isTrustedPublicPath(resolvedPath: string): boolean {
    const dir = path.dirname(path.resolve(resolvedPath));
    if (dir !== this.uploadDir) return false;
    return this.trustedPublicFilenames.has(path.basename(resolvedPath));
  }

  /**
   * Executes one idempotent, non-overlapping retention & orphaned cleanup sweep:
   * 1. Reconciles any `CLEANUP_PENDING` scans (e.g., partial deletion failure before restart).
   * 2. Expires raw video/proxy/thumbnail media on completed/failed scans beyond MEDIA_RETENTION_HOURS
   *    while preserving structured reports, evidence, comparisons, channel intelligence, and billing records.
   * 3. Removes orphaned expired uploads no longer referenced by any active scan.
   * 4. Cleans orphaned temporary frame captures (`uploads/frames/*`) and `.tmp` files beyond TEMP_ARTIFACT_RETENTION_HOURS.
   */
  public async runCleanupSweep(): Promise<RetentionSweepSummary> {
    const config = this.getConfiguration();
    const startedAtMs = this.nowFn();
    const startedAt = new Date(startedAtMs).toISOString();

    if (!config.enabled) {
      return {
        executed: false,
        skippedOverlap: false,
        startedAt,
        completedAt: new Date(this.nowFn()).toISOString(),
        config,
        pendingScansReconciled: 0,
        pendingScansPurged: 0,
        expiredScansMediaCleaned: 0,
        expiredFilesRemoved: 0,
        expiredUploadsRemoved: 0,
        tempArtifactsRemoved: 0,
        errors: 0,
      };
    }

    if (this.sweepInProgress) {
      return {
        executed: false,
        skippedOverlap: true,
        startedAt,
        completedAt: new Date(this.nowFn()).toISOString(),
        config,
        pendingScansReconciled: 0,
        pendingScansPurged: 0,
        expiredScansMediaCleaned: 0,
        expiredFilesRemoved: 0,
        expiredUploadsRemoved: 0,
        tempArtifactsRemoved: 0,
        errors: 0,
      };
    }

    this.sweepInProgress = true;

    let pendingScansReconciled = 0;
    let pendingScansPurged = 0;
    let expiredScansMediaCleaned = 0;
    let expiredFilesRemoved = 0;
    let expiredUploadsRemoved = 0;
    let tempArtifactsRemoved = 0;
    let errors = 0;

    try {
      let allScans = await this.storage.scans.getAllScans();
      const activeScanJobIds = new Set<string>();

      // Track active RUNNING queue jobs once so we never touch active media
      for (const scan of allScans) {
        try {
          const job = await this.storage.queue.getJobByScanId(scan.id);
          if (job && job.status === 'RUNNING') {
            activeScanJobIds.add(scan.id);
          }
        } catch {
          // Conservative: ignore individual queue lookup failure
        }
      }

      // ------------------------------------------------------------------
      // 1. Reconcile CLEANUP_PENDING scans (restart-safe & idempotent)
      // ------------------------------------------------------------------
      for (const scan of allScans) {
        if (scan.status !== 'CLEANUP_PENDING') continue;
        if (activeScanJobIds.has(scan.id)) continue;

        try {
          const paths = collectScanMediaPaths(scan, { uploadDir: this.uploadDir });
          let filesOk = true;

          if (paths.length > 0) {
            const batch = await cleanupMediaPaths(paths, {
              storage: this.storage,
              excludeScanIds: new Set([scan.id]),
              allScansCache: allScans,
              uploadDir: this.uploadDir,
              env: this.env,
              unlinkFn: this.unlinkFn,
              isTrustedPublicMediaFn: (p) => this.isTrustedPublicPath(p),
            });
            expiredFilesRemoved += batch.filesRemoved;
            filesOk = batch.ok;
          }

          if (!filesOk) {
            errors++;
            continue;
          }

          cleanupScanFrameDirectories(scan.id, { uploadDir: this.uploadDir, env: this.env });
          pendingScansReconciled++;

          const deleted = await this.storage.scans.deleteScan(scan.id);
          if (deleted) {
            pendingScansPurged++;
          } else {
            errors++;
          }
        } catch (err: any) {
          errors++;
          console.error('[Retention] Failed reconciling CLEANUP_PENDING scan:', err?.message || 'Unknown error');
        }
      }

      // Refresh scan cache after pending purges
      allScans = await this.storage.scans.getAllScans();
      const mediaCutoffMs = startedAtMs - config.mediaRetentionHours * 60 * 60 * 1000;

      // ------------------------------------------------------------------
      // 2. Expire raw media on terminal scans older than MEDIA_RETENTION_HOURS
      //    Preserve scans, reports, evidence, comparisons, channel intelligence & billing records.
      // ------------------------------------------------------------------
      const removedPathSet = new Set<string>();

      for (const scan of allScans) {
        if (scan.status !== 'COMPLETED' && scan.status !== 'FAILED') continue;
        if (activeScanJobIds.has(scan.id)) continue;
        if ((scan.metadata as any)?.mediaExpired === true) continue;

        const referenceIso = scan.completedAt || scan.createdAt;
        const referenceMs = Date.parse(referenceIso);
        if (!Number.isFinite(referenceMs) || referenceMs >= mediaCutoffMs) {
          continue;
        }

        const rawPaths = collectScanMediaPaths(scan, { uploadDir: this.uploadDir });
        if (rawPaths.length === 0) {
          continue;
        }

        try {
          const batch = await cleanupMediaPaths(rawPaths, {
            storage: this.storage,
            excludeScanIds: new Set([scan.id]),
            allScansCache: allScans,
            uploadDir: this.uploadDir,
            env: this.env,
            unlinkFn: this.unlinkFn,
            isTrustedPublicMediaFn: (p) => this.isTrustedPublicPath(p),
          });

          expiredFilesRemoved += batch.filesRemoved;
          for (const rp of batch.removedPaths) {
            removedPathSet.add(rp);
          }

          cleanupScanFrameDirectories(scan.id, { uploadDir: this.uploadDir, env: this.env });

          const skippedSet = new Set(batch.skippedSharedPaths.map((p) => path.resolve(p)));
          const failedSet = new Set(batch.failedPaths.map((p) => path.resolve(p)));

          const shouldClear = (candidate?: string): boolean => {
            if (!candidate || !candidate.trim()) return false;
            const resolved = path.resolve(candidate.trim());
            return !skippedSet.has(resolved) && !failedSet.has(resolved);
          };

          const nextVideoPath = shouldClear(scan.videoPath) ? '' : scan.videoPath;
          const nextProxyPath = shouldClear(scan.proxyPath) ? '' : scan.proxyPath;
          const nextThumbPath = shouldClear(scan.thumbnailPath) ? '' : scan.thumbnailPath;

          if (!batch.ok) {
            errors++;
          }

          await this.storage.scans.updateScan(
            scan.id,
            {
              videoPath: nextVideoPath,
              proxyPath: nextProxyPath,
              thumbnailPath: nextThumbPath,
              metadata: {
                ...(scan.metadata || ({} as any)),
                ...(batch.ok
                  ? {
                      mediaExpired: true,
                      mediaExpiredAt: new Date(this.nowFn()).toISOString(),
                    }
                  : {
                      mediaExpiryPartialFailure: true,
                    }),
              } as any,
            },
            { systemBypass: true }
          );

          // Keep in-memory cache synchronized for subsequent scans in the same sweep
          scan.videoPath = nextVideoPath;
          scan.proxyPath = nextProxyPath;
          scan.thumbnailPath = nextThumbPath;

          if (batch.ok) {
            expiredScansMediaCleaned++;
          }
        } catch (err: any) {
          errors++;
          console.error('[Retention] Failed expiring media for aged scan:', err?.message || 'Unknown error');
        }
      }

      // ------------------------------------------------------------------
      // 3. Remove orphaned expired upload records and unreferenced upload files
      // ------------------------------------------------------------------
      if (this.storage.uploads.listUploads) {
        try {
          const allUploads = await this.storage.uploads.listUploads();
          const referencedByRemainingScans = new Set<string>();
          for (const scan of allScans) {
            if (scan.videoPath && scan.videoPath.trim()) referencedByRemainingScans.add(path.resolve(scan.videoPath));
            if (scan.proxyPath && scan.proxyPath.trim()) referencedByRemainingScans.add(path.resolve(scan.proxyPath));
            if (scan.thumbnailPath && scan.thumbnailPath.trim()) referencedByRemainingScans.add(path.resolve(scan.thumbnailPath));
          }

          for (const up of allUploads) {
            const resolvedUp = path.resolve(up.filePath);
            if (referencedByRemainingScans.has(resolvedUp)) continue;

            // If file was already removed as part of Step 2, remove stale upload row immediately
            if (removedPathSet.has(resolvedUp)) {
              await this.storage.uploads.deleteUpload(up.fileId);
              expiredUploadsRemoved++;
              continue;
            }

            const upCreatedMs = Date.parse(up.createdAt);
            if (!Number.isFinite(upCreatedMs) || upCreatedMs >= mediaCutoffMs) {
              continue;
            }

            const validation = validateSafeStoragePath(resolvedUp, {
              mustExist: false,
              uploadDir: this.uploadDir,
              env: this.env,
            });
            if (!validation.isSafe || this.isTrustedPublicPath(validation.resolvedPath)) {
              continue;
            }

            let diskOk = true;
            if (fs.existsSync(validation.resolvedPath)) {
              try {
                this.unlinkFn(validation.resolvedPath);
                expiredFilesRemoved++;
              } catch (err: any) {
                diskOk = false;
                errors++;
                console.error('[Retention] Failed deleting orphaned upload file:', err?.code || err?.message || 'Unknown error');
              }
            }

            if (diskOk) {
              await this.storage.uploads.deleteUpload(up.fileId);
              expiredUploadsRemoved++;
            }
          }
        } catch (err: any) {
          errors++;
          console.error('[Retention] Failed scanning orphaned uploads:', err?.message || 'Unknown error');
        }
      }

      // ------------------------------------------------------------------
      // 4. Clean expired temporary frame captures & `.tmp` files inside uploadDir
      // ------------------------------------------------------------------
      const tempCutoffMs = startedAtMs - config.tempArtifactRetentionHours * 60 * 60 * 1000;
      tempArtifactsRemoved += this.cleanupTemporaryArtifacts(tempCutoffMs, activeScanJobIds);
    } finally {
      this.sweepInProgress = false;
    }

    const summary: RetentionSweepSummary = {
      executed: true,
      skippedOverlap: false,
      startedAt,
      completedAt: new Date(this.nowFn()).toISOString(),
      config,
      pendingScansReconciled,
      pendingScansPurged,
      expiredScansMediaCleaned,
      expiredFilesRemoved,
      expiredUploadsRemoved,
      tempArtifactsRemoved,
      errors,
    };

    if (
      summary.pendingScansReconciled > 0 ||
      summary.expiredScansMediaCleaned > 0 ||
      summary.expiredUploadsRemoved > 0 ||
      summary.tempArtifactsRemoved > 0 ||
      summary.errors > 0
    ) {
      console.log('[Retention] Cleanup sweep completed:', {
        pendingScansReconciled: summary.pendingScansReconciled,
        pendingScansPurged: summary.pendingScansPurged,
        expiredScansMediaCleaned: summary.expiredScansMediaCleaned,
        expiredFilesRemoved: summary.expiredFilesRemoved,
        expiredUploadsRemoved: summary.expiredUploadsRemoved,
        tempArtifactsRemoved: summary.tempArtifactsRemoved,
        errors: summary.errors,
      });
    }

    return summary;
  }

  private cleanupTemporaryArtifacts(tempCutoffMs: number, activeScanJobIds: Set<string>): number {
    let removed = 0;

    // 4a. Stale files inside uploads/frames/* not tied to an active RUNNING scan
    const framesDir = path.join(this.uploadDir, 'frames');
    if (fs.existsSync(framesDir)) {
      try {
        const entries = fs.readdirSync(framesDir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(framesDir, entry.name);
          const validation = validateSafeStoragePath(entryPath, {
            mustExist: false,
            uploadDir: this.uploadDir,
            env: this.env,
          });
          if (!validation.isSafe) continue;

          if (entry.isDirectory()) {
            const isActiveJobDir = Array.from(activeScanJobIds).some(
              (id) => entry.name === id || entry.name.startsWith(`${id}_`)
            );
            if (isActiveJobDir) continue;

            try {
              const files = fs.readdirSync(validation.resolvedPath, { withFileTypes: true });
              for (const f of files) {
                if (!f.isFile()) continue;
                const filePath = path.join(validation.resolvedPath, f.name);
                const stat = fs.statSync(filePath);
                if (stat.mtimeMs < tempCutoffMs) {
                  this.unlinkFn(filePath);
                  removed++;
                }
              }
              if (fs.readdirSync(validation.resolvedPath).length === 0) {
                fs.rmdirSync(validation.resolvedPath);
              }
            } catch {
              // Ignore temp dir errors
            }
          } else if (entry.isFile()) {
            try {
              const stat = fs.statSync(validation.resolvedPath);
              if (stat.mtimeMs < tempCutoffMs) {
                this.unlinkFn(validation.resolvedPath);
                removed++;
              }
            } catch {
              // Ignore
            }
          }
        }
      } catch {
        // Ignore unreadable frames dir
      }
    }

    // 4b. Stale `.tmp` files directly inside uploadDir or uploadDir/proxies
    for (const dir of [this.uploadDir, path.join(this.uploadDir, 'proxies')]) {
      if (!fs.existsSync(dir)) continue;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith('.tmp') && !entry.name.startsWith('.probe_')) continue;
          const filePath = path.join(dir, entry.name);
          const validation = validateSafeStoragePath(filePath, {
            mustExist: false,
            uploadDir: this.uploadDir,
            env: this.env,
          });
          if (!validation.isSafe || this.isTrustedPublicPath(validation.resolvedPath)) continue;
          try {
            const stat = fs.statSync(validation.resolvedPath);
            if (stat.mtimeMs < tempCutoffMs) {
              this.unlinkFn(validation.resolvedPath);
              removed++;
            }
          } catch {
            // Ignore
          }
        }
      } catch {
        // Ignore
      }
    }

    return removed;
  }

  public startScheduler(options: { initialDelayMs?: number } = {}): void {
    const config = this.getConfiguration();
    if (!config.enabled) {
      console.log('[Retention] Automated retention scheduler disabled (RETENTION_CLEANUP_ENABLED must be explicitly true or 1 to activate).');
      return;
    }
    if (this.intervalTimer) {
      return;
    }

    const initialDelay = Math.max(0, options.initialDelayMs ?? 5000);
    this.initialDelayTimer = setTimeout(() => {
      this.initialDelayTimer = null;
      this.runCleanupSweep().catch((err) => {
        console.error('[Retention] Initial recovery sweep failed:', err?.message || err);
      });
    }, initialDelay);
    this.initialDelayTimer.unref?.();

    this.intervalTimer = setInterval(() => {
      this.runCleanupSweep().catch((err) => {
        console.error('[Retention] Scheduled cleanup sweep failed:', err?.message || err);
      });
    }, config.cleanupIntervalMs);
    this.intervalTimer.unref?.();

    console.log(
      `[Retention] Automated cleanup scheduler active (mediaRetentionHours=${config.mediaRetentionHours}, tempArtifactRetentionHours=${config.tempArtifactRetentionHours}, intervalMs=${config.cleanupIntervalMs}, status=${config.approvalStatus}).`
    );
  }

  public stopScheduler(): void {
    if (this.initialDelayTimer) {
      clearTimeout(this.initialDelayTimer);
      this.initialDelayTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}

export const retentionService = new RetentionService();
