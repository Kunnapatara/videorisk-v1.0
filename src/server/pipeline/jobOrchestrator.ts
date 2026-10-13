import crypto from 'crypto';
import { storage } from '../storage';
import { mediaInspector, MediaInspectionError } from './mediaInspector';
import { proxyGenerator } from './proxyGenerator';
import { audioProcessor, AudioProcessingError } from './audioProcessor';
import { videoProcessor, VideoProcessingError } from './videoProcessor';
import { thumbnailInspector } from './thumbnailInspector';
import { policyIntelligenceEngine } from '../intelligence/policyIntelligence';
import { creditService } from '../services/creditService';
import { ScanJob, ScanStage, JobStatus, ThumbnailMetadata, JobQueueRecord } from '../../types';

export class JobOrchestrator {
  private activeJobs = new Set<string>();
  private workerId = `worker_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  private isWorkerRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private staleRecoveryTimer: NodeJS.Timeout | null = null;
  private maxConcurrentJobs = 2;
  private currentRunningCount = 0;

  constructor() {
    // Automatically start worker loop
    this.startWorker();
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
      storage.queue.recoverStaleJobs(60000).catch(err => {
        console.warn('[JobOrchestrator] Error recovering stale jobs:', err);
      });
    }, 15000);
    if (this.staleRecoveryTimer.unref) this.staleRecoveryTimer.unref();

    // Initial check for recovery from server restart
    storage.queue.recoverStaleJobs(60000).catch(() => {});
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
   * Enqueues scan job durably and kicks worker (idempotent)
   */
  public startJob(scanId: string): void {
    storage.queue.enqueueJob(scanId).then(() => {
      this.triggerPoll();
    }).catch(err => {
      console.error(`[JobOrchestrator] Failed to enqueue job ${scanId}:`, err);
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
        const job = await storage.queue.claimNextJob(this.workerId, 60000);
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

  private async executeJob(job: JobQueueRecord): Promise<void> {
    const scanId = job.scanId;

    // Heartbeat: renew lease periodically while executing to prevent premature reclamation on long scans
    const heartbeatTimer = setInterval(() => {
      storage.queue.renewLease(job.id, this.workerId).catch(err => {
        console.warn(`[JobOrchestrator] Heartbeat renewal error for job ${job.id}:`, err);
      });
    }, 15000);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    try {
      await this.processJob(scanId);
      clearInterval(heartbeatTimer);
      await storage.queue.completeJob(job.id, this.workerId);
    } catch (err: any) {
      clearInterval(heartbeatTimer);
      console.error(`[JobOrchestrator] Job ${job.id} for scan ${scanId} failed:`, err);

      const isTerminal = 
        err instanceof MediaInspectionError || 
        err.message?.includes('Insufficient credits') ||
        job.attempts >= job.maxAttempts;

      if (!isTerminal) {
        // Retryable: backoff exponentially and synchronize scan status
        const backoffMs = Math.min(30000, 2000 * Math.pow(2, job.attempts));
        await storage.scans.updateScan(scanId, {
          status: 'QUEUED',
          error: `Transient issue: retrying (attempt ${job.attempts}/${job.maxAttempts})...`
        });
        await storage.queue.failJob(job.id, err.message, true, backoffMs, this.workerId);
      } else {
        // Terminal failure: refund credits idempotently and mark scan failed
        try {
          const refundResult = await storage.scans.refundScanCredits(scanId);
          if (refundResult.refunded) {
            console.log(`[JobOrchestrator] Refunded ${refundResult.amount} credits for failed job ${scanId}`);
          }
        } catch (refundErr) {
          console.error(`[JobOrchestrator] Failed to execute credit refund for job ${scanId}:`, refundErr);
        }

        await storage.scans.updateScan(scanId, {
          status: 'FAILED',
          error: (err instanceof MediaInspectionError || err instanceof VideoProcessingError || err instanceof AudioProcessingError)
            ? err.message
            : 'We couldn’t complete this scan. Your video was not published or shared. Credits have been refunded. Please try again.'
        });

        await storage.queue.failJob(job.id, err.message, false, 0, this.workerId);
      }
    }
  }

  private async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async processJob(scanId: string): Promise<void> {
    const scan = await storage.scans.getScan(scanId);
    if (!scan) throw new Error('Scan not found');

    const startTime = Date.now();
    let tempFramesDirToClean: string | null = null;
    let deductedCredits = 0;

    try {
      // 1. Stage: Media inspection
      await storage.scans.updateScan(scanId, {
        status: 'INSPECTING',
        currentStage: 'Media inspection',
        completedStages: ['Upload']
      });

      const inspectionStart = Date.now();
      const metadata = await mediaInspector.inspect(scan.videoPath, scan.videoFilename);
      const inspectionMs = Date.now() - inspectionStart;

      // Check proxy requirements for 4K / UHD
      let proxyPath = scan.videoPath;
      if (metadata.isProxyUsed) {
        proxyPath = await proxyGenerator.generateProxyIfNeeded(scan.videoPath, metadata);
      }

      // Deduct credits based on real duration
      const requiredCredits = creditService.calculateRequiredCredits(metadata.durationSeconds, scan.scanMode);
      const deducted = await storage.scans.deductScanCredits(scanId, scan.userId, requiredCredits);
      
      if (!deducted) {
        throw new Error(`Insufficient credits. Required: ${requiredCredits} minute(s), but available balance is lower.`);
      }

      deductedCredits = requiredCredits;
      await storage.usage.recordUsage(
        scan.userId, 
        scan.id, 
        creditService.formatMinutes(metadata.durationSeconds), 
        requiredCredits, 
        scan.scanMode
      );

      await storage.scans.updateScan(scanId, {
        metadata,
        proxyPath,
        creditsUsed: requiredCredits,
        completedStages: ['Upload', 'Media inspection']
      });

      await this.sleep(300);

      // 2. Stage: Audio & transcript
      await storage.scans.updateScan(scanId, {
        status: 'PROCESSING_AUDIO',
        currentStage: 'Audio & transcript',
        completedStages: ['Upload', 'Media inspection']
      });
      const audioStart = Date.now();
      const audioResult = await audioProcessor.analyzeAudio(proxyPath, metadata);
      const audioMs = Date.now() - audioStart;

      await this.sleep(300);

      // 3. Stage: Scene analysis
      await storage.scans.updateScan(scanId, {
        status: 'PROCESSING_VIDEO',
        currentStage: 'Scene analysis',
        completedStages: ['Upload', 'Media inspection', 'Audio & transcript']
      });
      const videoStart = Date.now();
      const videoResult = await videoProcessor.analyzeVideo(proxyPath, metadata, scan.scanMode);
      tempFramesDirToClean = videoResult.tempFramesDir;
      const videoMs = Date.now() - videoStart;

      await this.sleep(300);

      // 4. Stage: Visual evidence
      await storage.scans.updateScan(scanId, {
        status: 'BUILDING_EVIDENCE',
        currentStage: 'Visual evidence',
        completedStages: ['Upload', 'Media inspection', 'Audio & transcript', 'Scene analysis']
      });

      // Thumbnail Inspection if provided
      let thumbnailMetadata: ThumbnailMetadata | null = null;
      if (scan.thumbnailPath && scan.thumbnailFilename) {
        try {
          thumbnailMetadata = await thumbnailInspector.inspect(scan.thumbnailPath, scan.thumbnailFilename);
        } catch (thumbErr) {
          console.warn('[JobOrchestrator] Thumbnail inspection error:', thumbErr);
        }
      }

      // Fetch Channel Context Profile snapshot if exists for user
      const channelProfile = await storage.channelProfiles.getProfile(scan.userId);

      const evidenceStart = Date.now();
      const timeline = policyIntelligenceEngine.generateEvidenceTimeline({
        scanId,
        metadata,
        scanMode: scan.scanMode,
        audioResult,
        videoResult,
        videoTitle: scan.videoTitle,
        videoDescription: scan.videoDescription,
        videoTags: scan.videoTags,
        thumbnailMetadata,
        channelProfile,
        isRescan: scan.isRescan,
      });
      await storage.evidence.saveEvidence(scanId, timeline);
      const evidenceMs = Date.now() - evidenceStart;

      await this.sleep(300);

      // 5. Stage: Policy analysis & Risk report
      await storage.scans.updateScan(scanId, {
        status: 'MAPPING_POLICY',
        currentStage: 'Policy analysis',
        completedStages: ['Upload', 'Media inspection', 'Audio & transcript', 'Scene analysis', 'Visual evidence']
      });

      await this.sleep(300);

      await storage.scans.updateScan(scanId, {
        status: 'BUILDING_REPORT',
        currentStage: 'Risk report',
        completedStages: ['Upload', 'Media inspection', 'Audio & transcript', 'Scene analysis', 'Visual evidence', 'Policy analysis']
      });
      const policyStart = Date.now();
      const report = policyIntelligenceEngine.buildReport({
        scanId,
        metadata,
        scanMode: scan.scanMode,
        audioResult,
        videoResult,
        videoTitle: scan.videoTitle,
        videoDescription: scan.videoDescription,
        videoTags: scan.videoTags,
        thumbnailMetadata,
        channelProfile,
        isRescan: scan.isRescan,
      }, timeline);

      report.benchmarkMetrics = {
        totalProcessingSeconds: parseFloat(((Date.now() - startTime) / 1000).toFixed(2)),
        inspectionMs,
        audioProcessingMs: audioMs,
        videoAnalysisMs: videoMs,
        evidenceBuildingMs: evidenceMs,
        policyReasoningMs: Date.now() - policyStart,
        framesSampled: videoResult.framesSampled,
        scenesDetected: videoResult.scenesCount,
      };

      await storage.scans.saveReport(scanId, report);

      // Save thumbnail metadata and channel profile snapshot on scan job record
      await storage.scans.updateScan(scanId, {
        thumbnailMetadata: thumbnailMetadata || undefined,
        channelProfileSnapshot: channelProfile || undefined,
      });

      // If this is a re-scan, generate and save the comparison with parent scan
      if (scan.parentScanId) {
        const parentReport = await storage.scans.getReport(scan.parentScanId);
        if (parentReport) {
          const comparison = policyIntelligenceEngine.generateComparison(parentReport, report);
          await storage.scans.saveComparison(comparison);
        }
      }

      // 6. Complete
      await storage.scans.updateScan(scanId, {
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
      });
    } finally {
      // Clean up temporary extracted frames to prevent disk exhaustion
      if (tempFramesDirToClean) {
        await videoProcessor.cleanupFrames(tempFramesDirToClean);
      }
    }
  }
}

export const jobOrchestrator = new JobOrchestrator();
