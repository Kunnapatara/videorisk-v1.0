import crypto from 'crypto';
import { storage, IStorageRepository } from '../storage';
import { mediaInspector, MediaInspectionError } from './mediaInspector';
import { proxyGenerator, ProxyGenerationError } from './proxyGenerator';
import { audioProcessor, AudioProcessingError } from './audioProcessor';
import { videoProcessor, VideoProcessingError } from './videoProcessor';
import { thumbnailInspector } from './thumbnailInspector';
import { policyIntelligenceEngine } from '../intelligence/policyIntelligence';
import { creditService } from '../services/creditService';
import { ScanJob, ScanStage, JobStatus, ThumbnailMetadata, JobQueueRecord, FencingError } from '../../types';

export interface JobOrchestratorPipelineDeps {
  mediaInspector?: Pick<typeof mediaInspector, 'inspect'>;
  proxyGenerator?: Pick<typeof proxyGenerator, 'generateProxyIfNeeded'>;
  audioProcessor?: Pick<typeof audioProcessor, 'analyzeAudio'>;
  videoProcessor?: Pick<typeof videoProcessor, 'analyzeVideo' | 'performVideoOcr' | 'cleanupFrames'>;
  thumbnailInspector?: Pick<typeof thumbnailInspector, 'inspect'>;
  policyIntelligenceEngine?: Pick<typeof policyIntelligenceEngine, 'generateEvidenceTimeline' | 'buildReport' | 'generateComparison'>;
}

export class JobOrchestrator {
  private activeJobs = new Set<string>();
  private workerId = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  private isWorkerRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private staleRecoveryTimer: NodeJS.Timeout | null = null;
  private maxConcurrentJobs = 2;
  private currentRunningCount = 0;
  private storageRepo: IStorageRepository;
  private deps: Required<JobOrchestratorPipelineDeps>;

  constructor(
    customStorage?: IStorageRepository,
    autoStart: boolean = true,
    pipelineDeps?: JobOrchestratorPipelineDeps
  ) {
    this.storageRepo = customStorage || storage;
    this.deps = {
      mediaInspector: pipelineDeps?.mediaInspector || mediaInspector,
      proxyGenerator: pipelineDeps?.proxyGenerator || proxyGenerator,
      audioProcessor: pipelineDeps?.audioProcessor || audioProcessor,
      videoProcessor: pipelineDeps?.videoProcessor || videoProcessor,
      thumbnailInspector: pipelineDeps?.thumbnailInspector || thumbnailInspector,
      policyIntelligenceEngine: pipelineDeps?.policyIntelligenceEngine || policyIntelligenceEngine
    };
    if (autoStart) {
      this.startWorker();
    }
  }

  public startWorker(): void {
    if (this.isWorkerRunning) return;
    this.isWorkerRunning = true;

    // Periodic job queue polling
    this.pollTimer = setInterval(() => {
      this.pollQueue();
    }, 500);
    if (this.pollTimer.unref) this.pollTimer.unref();

    // Periodic stale job recovery (every 15s)
    this.staleRecoveryTimer = setInterval(() => {
      this.storageRepo.queue.recoverStaleJobs(60000).catch(err => {
        console.warn('[JobOrchestrator] Error recovering stale jobs:', err);
      });
    }, 15000);
    if (this.staleRecoveryTimer.unref) this.staleRecoveryTimer.unref();

    // Initial check for recovery from server restart
    this.storageRepo.queue.recoverStaleJobs(60000).catch(() => {});
  }

  public stopWorker(): void {
    this.isWorkerRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.staleRecoveryTimer) {
      clearInterval(this.staleRecoveryTimer);
      this.staleRecoveryTimer = null;
    }
  }

  /**
   * Wakes worker to process scan.
   * createScan() is the authoritative durable queue-job creator.
   * If the job was not already enqueued, enqueues it idempotently.
   */
  public startJob(scanId: string): void {
    this.storageRepo.queue.getJobByScanId(scanId).then(existing => {
      if (existing) {
        this.triggerPoll();
      } else {
        this.storageRepo.queue.enqueueJob(scanId).then(() => {
          this.triggerPoll();
        }).catch(err => {
          console.error(`[JobOrchestrator] Failed to enqueue fallback job ${scanId}:`, err);
        });
      }
    }).catch(() => {
      this.triggerPoll();
    });
  }

  public triggerPoll(): void {
    setImmediate(() => this.pollQueue());
  }

  private async pollQueue(): Promise<void> {
    if (!this.isWorkerRunning) {
      return;
    }

    while (this.isWorkerRunning && this.currentRunningCount < this.maxConcurrentJobs) {
      try {
        const job = await this.storageRepo.queue.claimNextJob(this.workerId, 60000);
        if (!job) break;

        this.currentRunningCount++;
        this.activeJobs.add(job.scanId);

        this.executeJob(job)
          .catch(err => {
            console.error(`[JobOrchestrator] Unhandled error executing job ${job.id}:`, err);
          })
          .finally(() => {
            this.currentRunningCount--;
            this.activeJobs.delete(job.scanId);
            // Check if more jobs are waiting
            this.triggerPoll();
          });
      } catch (err) {
        console.warn('[JobOrchestrator] Queue polling error:', err);
        break;
      }
    }
  }

  public async executeJob(job: JobQueueRecord, customHeartbeatIntervalMs?: number): Promise<void> {
    const scanId = job.scanId;
    const leaseToken = job.leaseToken || undefined;
    const leaseDurationMs = job.leaseDurationMs || 60000;
    let leaseLost = false;
    let consecutiveRenewalErrors = 0;
    const maxConsecutiveRenewalErrors = 2;
    let lastSuccessfulHeartbeat = Date.now();
    const abortController = new AbortController();
    let heartbeatTimer: NodeJS.Timeout | null = null;

    // Heartbeat: renew lease periodically while executing to prevent premature reclamation on long scans
    const heartbeatInterval = customHeartbeatIntervalMs || 15000;
    heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await this.storageRepo.queue.renewLease(job.id, this.workerId, leaseToken, leaseDurationMs);
        if (!renewed) {
          // Confirmed loss of ownership (reclaimed or cancelled)
          leaseLost = true;
          abortController.abort();
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          console.warn(`[JobOrchestrator] Heartbeat renewal confirmed lease lost for job ${job.id}`);
          return;
        }
        // Successful renewal
        consecutiveRenewalErrors = 0;
        lastSuccessfulHeartbeat = Date.now();
      } catch (err: any) {
        // Distinguish transient storage error vs confirmed loss
        consecutiveRenewalErrors++;
        const elapsedSinceSuccess = Date.now() - lastSuccessfulHeartbeat;
        console.warn(`[JobOrchestrator] Heartbeat renewal error (${consecutiveRenewalErrors}/${maxConsecutiveRenewalErrors}) for job ${job.id}:`, err?.message || err);

        // Fail-closed if errors accumulate or elapsed time approaches lease expiry
        if (consecutiveRenewalErrors >= maxConsecutiveRenewalErrors || elapsedSinceSuccess >= leaseDurationMs * 0.75) {
          leaseLost = true;
          abortController.abort();
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          console.warn(`[JobOrchestrator] Heartbeat renewal error threshold reached; failing closed for job ${job.id}`);
        }
      }
    }, heartbeatInterval);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    try {
      await this.processJob(scanId, leaseToken, abortController.signal, () => leaseLost);

      if (leaseLost || abortController.signal.aborted) {
        console.warn(`[JobOrchestrator] Stale worker lease lost during processing for job ${job.id}. Skipping completion.`);
        return;
      }

      await this.storageRepo.queue.completeJob(job.id, this.workerId, leaseToken);
    } catch (err: any) {
      // If lease was lost or this was a fencing violation, suppress state mutations and credit refunds
      if (leaseLost || abortController.signal.aborted || err instanceof FencingError || err.name === 'FencingError') {
        console.warn(`[JobOrchestrator] Fencing protection: superseded worker halted for job ${job.id} (scan ${scanId}) without side effects: ${err.message}`);
        return;
      }

      console.error(`[JobOrchestrator] Job ${job.id} for scan ${scanId} failed:`, err);

      const isTerminal = 
        err instanceof MediaInspectionError || 
        err.message?.includes('Insufficient credits') ||
        job.attempts >= job.maxAttempts;

      if (!isTerminal) {
        // Retryable: backoff exponentially and synchronize scan status
        const backoffMs = Math.min(30000, 2000 * Math.pow(2, job.attempts));
        try {
          await this.storageRepo.scans.updateScan(scanId, {
            status: 'QUEUED',
            error: `Transient issue: retrying (attempt ${job.attempts}/${job.maxAttempts})...`
          }, leaseToken);
          await this.storageRepo.queue.failJob(job.id, err.message, true, backoffMs, this.workerId, leaseToken);
        } catch (fencingErr) {
          console.warn(`[JobOrchestrator] Stale worker fenced during retry update for job ${job.id}`);
        }
      } else {
        // Terminal failure: refund credits idempotently and mark scan failed
        try {
          const refundResult = await this.storageRepo.scans.refundScanCredits(scanId, undefined, leaseToken);
          if (refundResult.refunded) {
            console.log(`[JobOrchestrator] Refunded ${refundResult.amount} credits for failed job ${scanId}`);
          }
        } catch (refundErr) {
          console.error(`[JobOrchestrator] Failed to execute credit refund for job ${scanId}:`, refundErr);
        }

        try {
          await this.storageRepo.scans.updateScan(scanId, {
            status: 'FAILED',
            error: (err instanceof MediaInspectionError || err instanceof VideoProcessingError || err instanceof AudioProcessingError || err instanceof ProxyGenerationError)
              ? err.message
              : 'We couldn’t complete this scan. Your video was not published or shared. Credits have been refunded. Please try again.'
          }, leaseToken);

          await this.storageRepo.queue.failJob(job.id, err.message, false, 0, this.workerId, leaseToken);
        } catch (fencingErr) {
          console.warn(`[JobOrchestrator] Stale worker fenced during terminal failure update for job ${job.id}`);
        }
      }
    } finally {
      // Stop and clean up heartbeat resources in all execution paths
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  }

  private async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async processJob(
    scanId: string, 
    leaseToken?: string, 
    abortSignal?: AbortSignal, 
    isLeaseLost?: () => boolean
  ): Promise<void> {
    const checkLease = () => {
      if (abortSignal?.aborted || isLeaseLost?.()) {
        throw new FencingError(`Worker lease lost or superseded during processing of scan ${scanId}`);
      }
    };

    checkLease();
    const scan = await this.storageRepo.scans.getScan(scanId);
    if (!scan) throw new Error('Scan not found');

    const startTime = Date.now();
    let tempFramesDirToClean: string | null = null;
    let deductedCredits = 0;

    try {
      // 1. Stage: Media inspection
      checkLease();
      await this.storageRepo.scans.updateScan(scanId, {
        status: 'INSPECTING',
        currentStage: 'Media inspection',
        completedStages: ['Upload']
      }, leaseToken);

      const inspectionStart = Date.now();
      const metadata = await this.deps.mediaInspector.inspect(scan.videoPath, scan.videoFilename);
      const inspectionMs = Date.now() - inspectionStart;

      // Check proxy requirements for 4K / UHD
      let proxyPath = scan.videoPath;
      if (metadata.isProxyUsed) {
        proxyPath = await this.deps.proxyGenerator.generateProxyIfNeeded(scan.videoPath, metadata);
      }

      checkLease();
      // Deduct credits based on real duration
      const requiredCredits = creditService.calculateRequiredCredits(metadata.durationSeconds, scan.scanMode);
      const deducted = await this.storageRepo.scans.deductScanCredits(scanId, scan.userId, requiredCredits, leaseToken);
      
      if (!deducted) {
        throw new Error(`Insufficient credits. Required: ${requiredCredits} minute(s), but available balance is lower.`);
      }

      deductedCredits = requiredCredits;
      await this.storageRepo.usage.recordUsage(
        scan.userId, 
        scan.id, 
        creditService.formatMinutes(metadata.durationSeconds), 
        requiredCredits, 
        scan.scanMode,
        leaseToken
      );

      checkLease();
      await this.storageRepo.scans.updateScan(scanId, {
        metadata,
        proxyPath,
        creditsUsed: requiredCredits,
        completedStages: ['Upload', 'Media inspection']
      }, leaseToken);

      await this.sleep(300);

      // 2. Stage: Audio & transcript
      checkLease();
      await this.storageRepo.scans.updateScan(scanId, {
        status: 'PROCESSING_AUDIO',
        currentStage: 'Audio & transcript',
        completedStages: ['Upload', 'Media inspection']
      }, leaseToken);
      const audioStart = Date.now();
      const audioResult = await this.deps.audioProcessor.analyzeAudio(proxyPath, metadata);
      const audioMs = Date.now() - audioStart;

      await this.sleep(300);

      // 3. Stage: Scene analysis
      checkLease();
      await this.storageRepo.scans.updateScan(scanId, {
        status: 'PROCESSING_VIDEO',
        currentStage: 'Scene analysis',
        completedStages: ['Upload', 'Media inspection', 'Audio & transcript']
      }, leaseToken);
      const videoStart = Date.now();
      const videoResult = await this.deps.videoProcessor.analyzeVideo(proxyPath, metadata, scan.scanMode);
      tempFramesDirToClean = videoResult.tempFramesDir;

      // Execute Full-Video OCR (Phase 4.3) on sampled frames if video stream is present
      try {
        // Timeline-wide sampling: do not pass sampleIntervalSeconds so samples distribute across [0, dur]
        const videoOcr = await this.deps.videoProcessor.performVideoOcr(proxyPath, metadata, {
          maxFrames: scan.scanMode === 'deep' ? 30 : 15
        });
        videoResult.videoOcr = videoOcr;
        if (!videoResult.detectors) {
          videoResult.detectors = {};
        }
        videoResult.detectors.video_ocr = mapVideoOcrDetectorReport(videoOcr, metadata, scan.scanMode);
      } catch (ocrErr: any) {
        console.warn('[JobOrchestrator] Video OCR analysis warning:', ocrErr);
      }

      const videoMs = Date.now() - videoStart;

      await this.sleep(300);

      // 4. Stage: Visual evidence
      checkLease();
      await this.storageRepo.scans.updateScan(scanId, {
        status: 'BUILDING_EVIDENCE',
        currentStage: 'Visual evidence',
        completedStages: ['Upload', 'Media inspection', 'Audio & transcript', 'Scene analysis']
      }, leaseToken);

      // Thumbnail Inspection if provided
      let thumbnailMetadata: ThumbnailMetadata | null = null;
      let thumbnailInspectionError: string | null = null;
      const thumbnailProvided = Boolean(scan.thumbnailPath && scan.thumbnailFilename);

      if (thumbnailProvided) {
        try {
          thumbnailMetadata = await this.deps.thumbnailInspector.inspect(scan.thumbnailPath!, scan.thumbnailFilename!);
        } catch (thumbErr: any) {
          thumbnailInspectionError = thumbErr?.message || 'Failed to inspect thumbnail image.';
          console.warn('[JobOrchestrator] Thumbnail inspection error:', thumbErr);
        }
      }

      // Fetch Channel Context Profile snapshot if exists for user
      const channelProfile = await this.storageRepo.channelProfiles.getProfile(scan.userId);

      const evidenceStart = Date.now();
      const timeline = this.deps.policyIntelligenceEngine.generateEvidenceTimeline({
        scanId,
        metadata,
        scanMode: scan.scanMode,
        audioResult,
        videoResult,
        videoTitle: scan.videoTitle,
        videoDescription: scan.videoDescription,
        videoTags: scan.videoTags,
        thumbnailMetadata,
        thumbnailProvided,
        thumbnailInspectionError,
        channelProfile,
        isRescan: scan.isRescan,
      });

      checkLease();
      await this.storageRepo.evidence.saveEvidence(scanId, timeline, leaseToken);
      const evidenceMs = Date.now() - evidenceStart;

      await this.sleep(300);

      // 5. Stage: Policy analysis & Risk report
      checkLease();
      await this.storageRepo.scans.updateScan(scanId, {
        status: 'MAPPING_POLICY',
        currentStage: 'Policy analysis',
        completedStages: ['Upload', 'Media inspection', 'Audio & transcript', 'Scene analysis', 'Visual evidence']
      }, leaseToken);

      await this.sleep(300);

      checkLease();
      await this.storageRepo.scans.updateScan(scanId, {
        status: 'BUILDING_REPORT',
        currentStage: 'Risk report',
        completedStages: ['Upload', 'Media inspection', 'Audio & transcript', 'Scene analysis', 'Visual evidence', 'Policy analysis']
      }, leaseToken);
      const policyStart = Date.now();
      const report = this.deps.policyIntelligenceEngine.buildReport({
        scanId,
        metadata,
        scanMode: scan.scanMode,
        audioResult,
        videoResult,
        videoTitle: scan.videoTitle,
        videoDescription: scan.videoDescription,
        videoTags: scan.videoTags,
        thumbnailMetadata,
        thumbnailProvided,
        thumbnailInspectionError,
        channelProfile,
        isRescan: scan.isRescan,
        benchmarkTimings: {
          totalProcessingSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
          inspectionMs,
          audioProcessingMs: audioMs,
          videoAnalysisMs: videoMs,
          evidenceBuildingMs: evidenceMs,
          policyReasoningMs: Date.now() - policyStart,
        }
      }, timeline);

      checkLease();
      await this.storageRepo.scans.saveReport(scanId, report, leaseToken);

      // Save thumbnail metadata and channel profile snapshot on scan job record
      await this.storageRepo.scans.updateScan(scanId, {
        thumbnailMetadata: thumbnailMetadata || undefined,
        channelProfileSnapshot: channelProfile || undefined,
      }, leaseToken);

      // If this is a re-scan, generate and save the comparison with parent scan
      if (scan.parentScanId) {
        const parentReport = await this.storageRepo.scans.getReport(scan.parentScanId);
        const parentScan = await this.storageRepo.scans.getScan(scan.parentScanId);
        if (parentReport) {
          const comparison = this.deps.policyIntelligenceEngine.generateComparison(parentReport, report, {
            originalScanRecord: parentScan || undefined,
            revisedScanRecord: { ...scan, metadata },
          });
          checkLease();
          await this.storageRepo.scans.saveComparison(comparison, leaseToken);
        }
      }

      // 6. Complete
      checkLease();
      await this.storageRepo.scans.updateScan(scanId, {
        status: 'COMPLETED',
        currentStage: 'Risk report',
        completedStages: [
          'Upload', 
          'Media inspection', 
          'Audio & transcript', 
          'Scene analysis', 
          'Visual evidence', 
          'Policy analysis', 
          'Risk report'
        ],
        completedAt: new Date().toISOString()
      }, leaseToken);
    } finally {
      // Clean up temporary extracted frames to prevent disk exhaustion
      if (tempFramesDirToClean) {
        await this.deps.videoProcessor.cleanupFrames(tempFramesDirToClean);
      }
    }
  }
}

/**
 * Authoritative production mapping function for Video OCR DetectorReport.
 * Maps VideoOcrResult into a standardized DetectorReport without fabricating
 * confidence defaults when detection or genuine confidence evidence is missing.
 */
export function mapVideoOcrDetectorReport(
  videoOcr: import('../../types').VideoOcrResult,
  metadata: import('../../types').MediaMetadata,
  scanMode: import('../../types').ScanMode = 'standard'
): import('../../types').DetectorReport {
  // 3-state confidence handling:
  // 1) genuine 0 preserved strictly as 0
  // 2) genuine > 0 preserved (mean across frames with valid confidence)
  // 3) missing/empty/null confidence preserved as undefined (never fabricated or coerced to 0)
  const validConfidences = videoOcr.detectedFrames
    .map(f => f?.confidence)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));

  const confidence: number | undefined = validConfidences.length > 0
    ? parseFloat((validConfidences.reduce((sum, c) => sum + c, 0) / validConfidences.length).toFixed(3))
    : undefined;

  const framesTargeted = videoOcr.framesTargeted ?? videoOcr.totalCandidateFrames;
  const framesExtracted = videoOcr.framesExtracted ?? videoOcr.framesInspected;
  const framesAttempted = videoOcr.framesAttempted ?? videoOcr.framesInspected;
  const framesSucceeded = videoOcr.framesSucceeded ?? videoOcr.framesInspected;
  const framesFailed = videoOcr.framesFailed ?? 0;
  const framesSkipped = videoOcr.framesSkipped ?? 0;
  const samplingCoverageRatio = videoOcr.samplingCoverageRatio !== undefined
    ? videoOcr.samplingCoverageRatio
    : (videoOcr.coverageRatio ?? null);
  const ocrExecutionSuccessRatio = videoOcr.ocrExecutionSuccessRatio !== undefined
    ? videoOcr.ocrExecutionSuccessRatio
    : null;
  const timelineCoverageStatus = videoOcr.timelineCoverageStatus ?? 'NOT_VERIFIED';
  const timelineCoverageRatio = videoOcr.timelineCoverageRatio !== undefined
    ? videoOcr.timelineCoverageRatio
    : null;

  return {
    detectorName: 'full_video_ocr_adapter',
    version: '1.0.0',
    status: videoOcr.status,
    executionStatus: videoOcr.executionStatus ?? (videoOcr.status === 'DETECTED' ? 'SUCCESS' : (videoOcr.status === 'NO_SIGNAL_DETECTED' ? 'SUCCESS' : (videoOcr.isPartial ? 'PARTIAL' : 'FAILED'))),
    executionDurationMs: videoOcr.executionDurationMs,
    confidence,
    provenance: {
      detectorName: 'full_video_ocr_adapter',
      engine: 'Tesseract OCR 5.3.0',
      version: '1.0.0',
      sourceFile: 'videoProcessor.ts',
      method: 'deterministic_timeline_sampling_and_tsv_parser'
    },
    coverage: {
      expectedScope: `Full video timeline (${Math.round(metadata.durationSeconds)}s, up to ${scanMode === 'deep' ? 30 : 15} discrete samples)`,
      inspectedScope: `${videoOcr.framesInspected} discrete timestamps assessed (temporal interval coverage: ${timelineCoverageStatus})`,
      coverageRatio: typeof samplingCoverageRatio === 'number' ? samplingCoverageRatio : videoOcr.coverageRatio,
      partialReason: videoOcr.isPartial ? (videoOcr.failureReason ?? 'Partial sampling bounds reached') : undefined,
      limitsReached: videoOcr.isPartial ? ['FRAME_BUDGET_OR_TIMEOUT'] : []
    },
    limitations: videoOcr.limitations,
    failureReason: videoOcr.failureReason,
    details: {
      framesTargeted,
      framesExtracted,
      framesExtractionFailed: videoOcr.framesExtractionFailed ?? 0,
      framesAttempted,
      framesSucceeded,
      framesFailed,
      framesOcrFailed: videoOcr.framesOcrFailed ?? framesFailed,
      framesSkipped,
      plannedTimestamps: videoOcr.plannedTimestamps ?? [],
      extractedTimestamps: videoOcr.extractedTimestamps ?? [],
      succeededTimestamps: videoOcr.succeededTimestamps ?? [],
      extractionErrors: videoOcr.extractionErrors ?? [],
      timelineCoverageStatus,
      timelineCoverageRatio,
      samplingCoverageRatio,
      ocrExecutionSuccessRatio,
      framesInspected: videoOcr.framesInspected,
      totalCandidateFrames: videoOcr.totalCandidateFrames,
      coverageRatio: videoOcr.coverageRatio,
      detectedFramesCount: videoOcr.detectedFrames.length
    }
  };
}

export const jobOrchestrator = new JobOrchestrator();
