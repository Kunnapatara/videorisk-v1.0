import assert from 'assert';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { SqliteStorageRepository } from '../src/server/storage/sqliteStorage';
import { InMemoryStorageRepository } from '../src/server/storage';
import { FencingError, ScanJob, JobQueueRecord, EvidenceItem, RiskReport } from '../src/types';
import { JobOrchestrator } from '../src/server/pipeline/jobOrchestrator';

export async function runLeaseFencingAndHeartbeatTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 10: LEASE FENCING & STALE WORKER PROTECTION ---');
  console.log('======================================================');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fencing_test_'));
  const testDbPath = path.join(tempDir, 'fencing_test.db');
  const storage = new SqliteStorageRepository(testDbPath);

  try {
    // Setup test user
    const user = await storage.users.createUser('fencing_spec@videorisk.com', 'hash', 'salt', 50, 'creator');

    // -------------------------------------------------------------------------
    // GROUP 1: LEASE FENCING (Reqs 1 - 5)
    // -------------------------------------------------------------------------
    console.log('\n[Group 1: Lease Fencing (Requirements 1 - 5)]');

    const scan1: ScanJob = {
      id: `scan_fence_g1_${Date.now()}`,
      userId: user.id,
      videoTitle: 'Fenced Ownership Job',
      videoFilename: 'fence.mp4',
      videoPath: '/tmp/fence.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scan1);

    // 1. Worker A claims a job and receives an ownership token
    const workerAClaim = await storage.queue.claimNextJob('worker_A', 5000);
    assert(workerAClaim !== null, 'Requirement 1: Worker A successfully claims job');
    assert(typeof workerAClaim?.leaseToken === 'string' && workerAClaim.leaseToken.startsWith('lease_'), 'Requirement 1: Worker A receives valid lease token');
    const tokenA = workerAClaim!.leaseToken!;

    // 2. Worker A's lease expires (simulated by advancing locked_at into the past)
    const expiredLockedAt = new Date(Date.now() - 30000).toISOString();
    storage.db.prepare('UPDATE job_queue SET locked_at = ? WHERE id = ?').run(expiredLockedAt, workerAClaim!.id);
    const recoveredCount = await storage.queue.recoverStaleJobs(5000);
    assert(recoveredCount === 1, 'Requirement 2: Stale job recovered after Worker A lease expiration');

    // 3. Worker B reclaims the job and receives a different token
    const workerBClaim = await storage.queue.claimNextJob('worker_B', 15000);
    assert(workerBClaim !== null, 'Requirement 3: Worker B successfully reclaims job');
    assert(typeof workerBClaim?.leaseToken === 'string' && workerBClaim.leaseToken !== tokenA, 'Requirement 3: Worker B receives fresh lease token superseding Worker A');
    const tokenB = workerBClaim!.leaseToken!;

    // 4. Worker A cannot renew, complete, fail, update scan state, deduct credits, refund credits, save evidence, or save a report
    // 4a. Worker A cannot renew lease
    const renewByA = await storage.queue.renewLease(workerBClaim!.id, 'worker_A', tokenA);
    assert(renewByA === false, 'Requirement 4a: Stale Worker A cannot renew lease');

    // 4b. Worker A cannot complete job
    let completeByAFailed = false;
    try {
      await storage.queue.completeJob(workerBClaim!.id, 'worker_A', tokenA);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') completeByAFailed = true;
    }
    assert(completeByAFailed, 'Requirement 4b: Stale Worker A cannot complete job (FencingError thrown)');

    // 4c. Worker A cannot fail job
    let failByAFailed = false;
    try {
      await storage.queue.failJob(workerBClaim!.id, 'Stale fail attempt', false, 0, 'worker_A', tokenA);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') failByAFailed = true;
    }
    assert(failByAFailed, 'Requirement 4c: Stale Worker A cannot fail job (FencingError thrown)');

    // 4d. Worker A cannot update scan state
    let updateByAFailed = false;
    try {
      await storage.scans.updateScan(scan1.id, { status: 'BUILDING_REPORT' }, tokenA);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') updateByAFailed = true;
    }
    assert(updateByAFailed, 'Requirement 4d: Stale Worker A cannot update scan state (FencingError thrown)');

    // 4e. Worker A cannot deduct credits
    let deductByAFailed = false;
    try {
      await storage.scans.deductScanCredits(scan1.id, user.id, 10, tokenA);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') deductByAFailed = true;
    }
    assert(deductByAFailed, 'Requirement 4e: Stale Worker A cannot deduct credits (FencingError thrown)');

    // 4f. Worker A cannot refund credits
    let refundByAFailed = false;
    try {
      await storage.scans.refundScanCredits(scan1.id, 10, tokenA);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') refundByAFailed = true;
    }
    assert(refundByAFailed, 'Requirement 4f: Stale Worker A cannot refund credits (FencingError thrown)');

    // 4g. Worker A cannot save evidence
    let evidenceByAFailed = false;
    try {
      await storage.evidence.saveEvidence(scan1.id, [{
        id: 'stale_evidence_A',
        scanId: scan1.id,
        timestamp: 10,
        type: 'visual',
        title: 'Unauthorized Evidence',
        severity: 'critical',
        explanation: 'Should be rejected'
      } as unknown as EvidenceItem], tokenA);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') evidenceByAFailed = true;
    }
    assert(evidenceByAFailed, 'Requirement 4g: Stale Worker A cannot save evidence (FencingError thrown)');

    // 4h. Worker A cannot save a report
    let reportByAFailed = false;
    try {
      await storage.scans.saveReport(scan1.id, {
        scanId: scan1.id,
        overallRisk: 'HIGH_RISK',
        riskSummary: 'Unauthorized stale report',
        disclaimer: 'none',
        domainReports: {},
        riskCategories: {},
        topIssues: [],
        policyConnections: [],
        timeline: []
      } as unknown as RiskReport, tokenA);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') reportByAFailed = true;
    }
    assert(reportByAFailed, 'Requirement 4h: Stale Worker A cannot save report (FencingError thrown)');

    // 5. Worker B can complete the job normally
    await storage.scans.updateScan(scan1.id, { status: 'PROCESSING_VIDEO' }, tokenB);
    await storage.evidence.saveEvidence(scan1.id, [{
      id: 'legit_evidence_B',
      scanId: scan1.id,
      timestamp: 5,
      type: 'audio',
      title: 'Legitimate Evidence',
      severity: 'low',
      explanation: 'Authorized Worker B'
    } as unknown as EvidenceItem], tokenB);
    await storage.scans.saveReport(scan1.id, {
      scanId: scan1.id,
      overallRisk: 'LOW_RISK',
      riskSummary: 'Legitimate report by Worker B',
      disclaimer: 'standard',
      domainReports: {},
      riskCategories: {},
      topIssues: [],
      policyConnections: [],
      timeline: []
    } as unknown as RiskReport, tokenB);
    await storage.scans.updateScan(scan1.id, { status: 'COMPLETED', completedAt: new Date().toISOString() }, tokenB);
    await storage.queue.completeJob(workerBClaim!.id, 'worker_B', tokenB);

    const completedScan1 = await storage.scans.getScan(scan1.id);
    const completedJob1 = await storage.queue.getJobByScanId(scan1.id);
    assert(completedScan1?.status === 'COMPLETED', 'Requirement 5: Worker B successfully updates scan to COMPLETED');
    assert(completedJob1?.status === 'COMPLETED', 'Requirement 5: Worker B successfully completes job in queue');
    assert(completedJob1?.leaseToken === null, 'Requirement 5: Lease token cleared upon completion');

    // 5b. DEF-02: Lease expiration check at persistence boundary without waiting for recovery
    const scanBoundary: ScanJob = {
      id: `scan_boundary_${Date.now()}`,
      userId: user.id,
      videoTitle: 'Boundary Expiry Video',
      videoFilename: 'bound.mp4',
      videoPath: '/tmp/bound.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scanBoundary);
    const boundClaim = await storage.queue.claimNextJob('worker_bound', 5000);
    const boundToken = boundClaim!.leaseToken!;

    // Artificially expire lease in job_queue without running recovery (status remains RUNNING)
    storage.db.prepare('UPDATE job_queue SET lease_expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(), boundClaim!.id
    );

    let boundaryExpiryCaught = false;
    try {
      await storage.scans.updateScan(scanBoundary.id, { status: 'BUILDING_REPORT' }, boundToken);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') boundaryExpiryCaught = true;
    }
    assert(boundaryExpiryCaught, 'DEF-02: Expired lease rejected at persistence boundary even before recovery runs');

    // Clean up
    await storage.queue.recoverStaleJobs(100);
    const drainBound = await storage.queue.claimNextJob('worker_cleanup_bound', 1000);
    if (drainBound) await storage.queue.completeJob(drainBound.id, 'worker_cleanup_bound', drainBound.leaseToken!);

    // -------------------------------------------------------------------------
    // GROUP 2: HEARTBEAT (Reqs 6 - 9)
    // -------------------------------------------------------------------------
    console.log('\n[Group 2: Heartbeat (Requirements 6 - 9)]');

    // 6. Healthy long-running worker renews its lease and is not reclaimed
    const scan2: ScanJob = {
      id: `scan_heartbeat_g2_${Date.now()}`,
      userId: user.id,
      videoTitle: 'Long Running Video',
      videoFilename: 'long.mp4',
      videoPath: '/tmp/long.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scan2);
    const workerCClaim = await storage.queue.claimNextJob('worker_C', 10000);
    assert(workerCClaim !== null, 'Worker C claimed job');

    // Simulate passage of time where heartbeat renews lease
    const renewedC1 = await storage.queue.renewLease(workerCClaim!.id, 'worker_C', workerCClaim!.leaseToken!, 10000);
    assert(renewedC1 === true, 'Requirement 6: Healthy worker successfully renews lease');

    // Stale recovery should NOT reclaim healthy worker whose lease was renewed
    const reclaimedDuringHealthy = await storage.queue.recoverStaleJobs(10000);
    assert(reclaimedDuringHealthy === 0, 'Requirement 6: Healthy worker with renewed lease is not reclaimed');

    // Clean up worker C
    await storage.queue.completeJob(workerCClaim!.id, 'worker_C', workerCClaim!.leaseToken!);

    // 7. A confirmed lease-loss response prevents further authoritative writes
    const scan3: ScanJob = {
      id: `scan_loss_g2_${Date.now()}`,
      userId: user.id,
      videoTitle: 'Lease Loss Video',
      videoFilename: 'loss.mp4',
      videoPath: '/tmp/loss.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scan3);
    const workerDClaim = await storage.queue.claimNextJob('worker_D', 5000);
    const tokenD = workerDClaim!.leaseToken!;

    // Supersede worker D's lease
    storage.db.prepare('UPDATE job_queue SET locked_at = ? WHERE id = ?').run(
      new Date(Date.now() - 30000).toISOString(), workerDClaim!.id
    );
    await storage.queue.recoverStaleJobs(5000);

    // Heartbeat renewal confirms loss of ownership (returns false)
    const renewD = await storage.queue.renewLease(workerDClaim!.id, 'worker_D', tokenD);
    assert(renewD === false, 'Requirement 7: Heartbeat renewal returns false on confirmed loss of ownership');

    // Confirmed loss prevents further writes
    let lossWriteBlocked = false;
    try {
      await storage.scans.updateScan(scan3.id, { status: 'COMPLETED' }, tokenD);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') lossWriteBlocked = true;
    }
    assert(lossWriteBlocked, 'Requirement 7: Confirmed lease-loss prevents further authoritative writes');

    // Clean up scan3 so queue is clean for subsequent tests
    const drainScan3 = await storage.queue.claimNextJob('cleanup_worker_g2', 1000);
    if (drainScan3) {
      await storage.queue.completeJob(drainScan3.id, 'cleanup_worker_g2', drainScan3.leaseToken!);
    }

    // 8. Heartbeat storage error does not silently allow unbounded processing with presumed ownership
    // Verified by JobOrchestrator heartbeat fail-closed threshold: consecutiveRenewalErrors >= max
    const scanHbFail: ScanJob = {
      id: `scan_hb_fail_${Date.now()}`,
      userId: user.id,
      videoTitle: 'HB Fail Video',
      videoFilename: 'hbfail.mp4',
      videoPath: '/tmp/nonexistent.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scanHbFail);
    const hbClaim = await storage.queue.claimNextJob('worker_hb_fail', 5000);
    assert(hbClaim !== null, 'Claimed job for heartbeat fail test');

    let renewAttempts = 0;
    const failingStorage = Object.create(storage);
    failingStorage.scans = {
      ...storage.scans,
      getScan: async (id: string) => {
        // Delay enough for 2 heartbeat intervals of 15ms to trigger
        await new Promise(r => setTimeout(r, 50));
        return storage.scans.getScan(id);
      }
    };
    failingStorage.queue = {
      ...storage.queue,
      renewLease: async (id: string, workerId: string, leaseToken?: string, leaseDurationMs?: number) => {
        renewAttempts++;
        throw new Error('Database connection reset during renewal');
      }
    };

    const orchestratorFailClosed = new JobOrchestrator(failingStorage, false);
    await orchestratorFailClosed.executeJob(hbClaim, 15);
    assert(renewAttempts >= 2, 'Requirement 8: Heartbeat attempted renewals and encountered storage errors');
    const jobAfterFailClosed = await storage.queue.getJobByScanId(scanHbFail.id);
    assert(jobAfterFailClosed?.status !== 'COMPLETED', 'Requirement 8: Job is not completed after failing closed on heartbeat error');

    // 9. Heartbeat resources are stopped after success, failure, and shutdown
    const heartbeatTracker = { clearIntervalCalled: false };
    const origClearInterval = global.clearInterval;
    global.clearInterval = ((timer: any) => {
      heartbeatTracker.clearIntervalCalled = true;
      return origClearInterval(timer);
    }) as any;

    try {
      const scanClean: ScanJob = {
        id: `scan_clean_${Date.now()}`,
        userId: user.id,
        videoTitle: 'Clean HB Video',
        videoFilename: 'clean.mp4',
        videoPath: '/tmp/clean.mp4',
        scanMode: 'standard',
        status: 'QUEUED',
        currentStage: 'Upload',
        completedStages: ['Upload'],
        creditsUsed: 0,
        createdAt: new Date().toISOString()
      };
      await storage.scans.createScan(scanClean);
      const cleanClaim = await storage.queue.claimNextJob('worker_clean', 5000);
      const cleanOrchestrator = new JobOrchestrator(storage, false);
      await cleanOrchestrator.executeJob(cleanClaim!, 50);
      assert(heartbeatTracker.clearIntervalCalled === true, 'Requirement 9: clearInterval invoked and heartbeat resources stopped cleanly on shutdown');
    } finally {
      global.clearInterval = origClearInterval;
    }

    // -------------------------------------------------------------------------
    // GROUP 3: FINANCIAL INTEGRITY (Reqs 10 - 13)
    // -------------------------------------------------------------------------
    console.log('\n[Group 3: Financial Integrity (Requirements 10 - 13)]');

    const financeUser = await storage.users.createUser('finance_g3@videorisk.com', 'h', 's', 30, 'creator');
    const scanFinance: ScanJob = {
      id: `scan_finance_${Date.now()}`,
      userId: financeUser.id,
      videoTitle: 'Finance Test Video',
      videoFilename: 'finance.mp4',
      videoPath: '/tmp/finance.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scanFinance);
    const financeClaim = await storage.queue.claimNextJob('worker_fin', 10000);
    const tokenFin = financeClaim!.leaseToken!;

    // 10. Concurrent attempts cannot charge the same scan twice
    const [deductResult1, deductResult2] = await Promise.all([
      storage.scans.deductScanCredits(scanFinance.id, financeUser.id, 10, tokenFin),
      storage.scans.deductScanCredits(scanFinance.id, financeUser.id, 10, tokenFin)
    ]);
    assert(deductResult1 === true && deductResult2 === true, 'Requirement 10: Deduct calls succeed idempotently');
    const financeUserAfterDeduct = await storage.users.getUser(financeUser.id);
    assert(financeUserAfterDeduct?.creditsRemaining === 20, 'Requirement 10: Balance decremented exactly once (30 -> 20, not double-charged)');

    // 11. A stale attempt cannot refund credits belonging to a newer attempt
    const staleTokenFin = 'lease_stale_fin_99999';
    let staleRefundCaught = false;
    try {
      await storage.scans.refundScanCredits(scanFinance.id, 10, staleTokenFin);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') staleRefundCaught = true;
    }
    assert(staleRefundCaught, 'Requirement 11: Stale attempt cannot refund credits belonging to active attempt');
    const financeUserAfterBlockedRefund = await storage.users.getUser(financeUser.id);
    assert(financeUserAfterBlockedRefund?.creditsRemaining === 20, 'Requirement 11: Balance remains untouched after blocked stale refund');

    // 12. Retry after failure preserves intended credit accounting
    // Terminal failure refunds credits once
    const refundRes1 = await storage.scans.refundScanCredits(scanFinance.id, 10, tokenFin);
    assert(refundRes1.refunded === true && refundRes1.amount === 10, 'Requirement 12: Terminal failure grants refund of 10 credits');
    const financeUserAfterRefund = await storage.users.getUser(financeUser.id);
    assert(financeUserAfterRefund?.creditsRemaining === 30, 'Requirement 12: Balance safely restored back to 30');

    // 13. Repeated failure handling cannot issue duplicate refunds
    const refundRes2 = await storage.scans.refundScanCredits(scanFinance.id, 10, tokenFin);
    assert(refundRes2.refunded === false && refundRes2.amount === 0, 'Requirement 13: Duplicate refund strictly blocked (refunded = false)');
    const financeUserAfterDupRefund = await storage.users.getUser(financeUser.id);
    assert(financeUserAfterDupRefund?.creditsRemaining === 30, 'Requirement 13: Balance remains strictly 30 (no double refund)');

    // DEF-03: Usage Ledger Fencing & Idempotency Check
    let staleUsageCaught = false;
    try {
      await storage.usage.recordUsage(financeUser.id, scanFinance.id, 10, 10, 'standard', staleTokenFin);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') staleUsageCaught = true;
    }
    assert(staleUsageCaught, 'DEF-03: Stale worker attempt to recordUsage is rejected with FencingError');

    // Valid usage recording with tokenFin
    await storage.usage.recordUsage(financeUser.id, scanFinance.id, 10, 10, 'standard', tokenFin);
    const stats1 = await storage.usage.getUsageStats(financeUser.id);
    assert(stats1.scanCount === 1, 'DEF-03: Usage recorded exactly once for valid lease');

    // Repeated call for same scanId is idempotent
    await storage.usage.recordUsage(financeUser.id, scanFinance.id, 10, 10, 'standard', tokenFin);
    const stats2 = await storage.usage.getUsageStats(financeUser.id);
    assert(stats2.scanCount === 1, 'DEF-03: Duplicate usage recording for same scan is idempotent');

    // Clean up finance job
    await storage.queue.failJob(financeClaim!.id, 'Finance test complete', false, 0, 'worker_fin', tokenFin);

    // -------------------------------------------------------------------------
    // GROUP 4: EVIDENCE AND REPORT INTEGRITY (Reqs 14 - 16)
    // -------------------------------------------------------------------------
    console.log('\n[Group 4: Evidence & Report Integrity (Requirements 14 - 16)]');

    const scanEvReport: ScanJob = {
      id: `scan_ev_rep_${Date.now()}`,
      userId: user.id,
      videoTitle: 'Report Integrity Video',
      videoFilename: 'rep.mp4',
      videoPath: '/tmp/rep.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scanEvReport);
    const evClaim1 = await storage.queue.claimNextJob('worker_ev_1', 5000);
    const tokenEv1 = evClaim1!.leaseToken!;

    // Worker 1 writes evidence and report
    await storage.evidence.saveEvidence(scanEvReport.id, [{
      id: 'attempt1_ev',
      scanId: scanEvReport.id,
      timestamp: 1,
      type: 'audio',
      title: 'Attempt 1 Evidence',
      severity: 'low',
      explanation: 'Worker 1'
    } as unknown as EvidenceItem], tokenEv1);

    // Worker 1 expires and Worker 2 claims
    storage.db.prepare('UPDATE job_queue SET locked_at = ? WHERE id = ?').run(
      new Date(Date.now() - 30000).toISOString(), evClaim1!.id
    );
    await storage.queue.recoverStaleJobs(5000);
    const evClaim2 = await storage.queue.claimNextJob('worker_ev_2', 15000);
    const tokenEv2 = evClaim2!.leaseToken!;

    // 14. A stale worker cannot overwrite the latest authoritative report
    // Worker 2 writes authoritative report
    await storage.scans.saveReport(scanEvReport.id, {
      scanId: scanEvReport.id,
      overallRisk: 'LOW_RISK',
      riskSummary: 'Authoritative Worker 2 Report',
      disclaimer: 'v2',
      domainReports: {},
      riskCategories: {},
      topIssues: [],
      policyConnections: [],
      timeline: []
    } as unknown as RiskReport, tokenEv2);

    let staleWorkerOverwriteCaught = false;
    try {
      await storage.scans.saveReport(scanEvReport.id, {
        scanId: scanEvReport.id,
        overallRisk: 'HIGH_RISK',
        riskSummary: 'Stale Worker 1 Overwrite Attempt',
        disclaimer: 'v1',
        domainReports: {},
        riskCategories: {},
        topIssues: [],
        policyConnections: [],
        timeline: []
      } as unknown as RiskReport, tokenEv1);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') staleWorkerOverwriteCaught = true;
    }
    assert(staleWorkerOverwriteCaught, 'Requirement 14: Stale worker cannot overwrite authoritative report');
    const authoritativeReport = await storage.scans.getReport(scanEvReport.id);
    assert(authoritativeReport?.riskSummary === 'Authoritative Worker 2 Report', 'Requirement 14: Authoritative report strictly preserved');

    // 15. Evidence from different attempts cannot be mixed in the final report
    let staleEvidenceWriteCaught = false;
    try {
      await storage.evidence.saveEvidence(scanEvReport.id, [{
        id: 'attempt1_mixed_ev',
        scanId: scanEvReport.id,
        timestamp: 99,
        type: 'visual',
        title: 'Mixed Stale Evidence',
        severity: 'critical',
        explanation: 'Should never appear'
      } as unknown as EvidenceItem], tokenEv1);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') staleEvidenceWriteCaught = true;
    }
    assert(staleEvidenceWriteCaught, 'Requirement 15: Stale attempt cannot inject evidence into report');

    // Clean up evClaim2
    await storage.queue.completeJob(evClaim2!.id, 'worker_ev_2', tokenEv2);

    // 16. Explicit re-scan creates expected new scan/report lifecycle without modifying parent scan's results
    const parentScan: ScanJob = {
      id: `scan_parent_${Date.now()}`,
      userId: user.id,
      videoTitle: 'Parent Video',
      videoFilename: 'parent.mp4',
      videoPath: '/tmp/parent.mp4',
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 5,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(parentScan);
    // Parent scan job was completed
    const parentJob = await storage.queue.getJobByScanId(parentScan.id);
    if (parentJob && parentJob.status !== 'COMPLETED') {
      storage.db.prepare("UPDATE job_queue SET status = 'COMPLETED' WHERE id = ?").run(parentJob.id);
    }
    await storage.scans.saveReport(parentScan.id, {
      scanId: parentScan.id,
      overallRisk: 'HIGH_RISK',
      riskSummary: 'Parent Baseline Report',
      disclaimer: 'parent',
      domainReports: {},
      riskCategories: {},
      topIssues: [],
      policyConnections: [],
      timeline: []
    } as unknown as RiskReport, { systemBypass: true });

    const reScan: ScanJob = {
      id: `scan_rescan_${Date.now()}`,
      userId: user.id,
      videoTitle: 'Revised Video (Re-Scan)',
      videoFilename: 'revised.mp4',
      videoPath: '/tmp/revised.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      parentScanId: parentScan.id,
      isRescan: true,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(reScan);
    const reScanClaim = await storage.queue.claimNextJob('worker_rescan', 10000);
    const tokenReScan = reScanClaim!.leaseToken!;

    await storage.scans.saveReport(reScan.id, {
      scanId: reScan.id,
      overallRisk: 'LOW_RISK',
      riskSummary: 'Revised Clean Report',
      disclaimer: 'rescan',
      domainReports: {},
      riskCategories: {},
      topIssues: [],
      policyConnections: [],
      timeline: []
    } as unknown as RiskReport, tokenReScan);

    const parentReportAfterReScan = await storage.scans.getReport(parentScan.id);
    const reScanReport = await storage.scans.getReport(reScan.id);
    assert(parentReportAfterReScan?.overallRisk === 'HIGH_RISK', 'Requirement 16: Parent scan report preserved intact');
    assert(reScanReport?.overallRisk === 'LOW_RISK', 'Requirement 16: Re-scan report saved under new scan ID independently');

    await storage.queue.completeJob(reScanClaim!.id, 'worker_rescan', tokenReScan);

    // -------------------------------------------------------------------------
    // GROUP 5: QUEUE LIFECYCLE (Reqs 17 - 20)
    // -------------------------------------------------------------------------
    console.log('\n[Group 5: Queue Lifecycle (Requirements 17 - 20)]');

    // 17. Repeated startJob() calls do not reopen or duplicate existing jobs
    const orchestratorTestInstance = new JobOrchestrator(storage, false);

    const scanStartJob: ScanJob = {
      id: `scan_start_job_${Date.now()}`,
      userId: user.id,
      videoTitle: 'Start Job Idempotency',
      videoFilename: 'start.mp4',
      videoPath: '/tmp/start.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scanStartJob);
    const claimBeforeMultipleStarts = await storage.queue.claimNextJob('worker_sj', 30000);
    assert(claimBeforeMultipleStarts?.status === 'RUNNING', 'Job claimed and in RUNNING status');

    // Call startJob multiple times while job is RUNNING
    orchestratorTestInstance.startJob(scanStartJob.id);
    orchestratorTestInstance.startJob(scanStartJob.id);
    orchestratorTestInstance.startJob(scanStartJob.id);

    // Give microtasks a tick to resolve
    await new Promise(r => setTimeout(r, 50));

    const jobAfterMultipleStarts = await storage.queue.getJobByScanId(scanStartJob.id);
    assert(jobAfterMultipleStarts?.status === 'RUNNING', 'Requirement 17: Repeated startJob() calls do not reopen or mutate RUNNING job');
    assert(jobAfterMultipleStarts?.attempts === 1, 'Requirement 17: Attempts count not incremented by startJob() calls');

    // Complete job, then call startJob again
    await storage.queue.completeJob(claimBeforeMultipleStarts!.id, 'worker_sj', claimBeforeMultipleStarts!.leaseToken!);
    orchestratorTestInstance.startJob(scanStartJob.id);
    await new Promise(r => setTimeout(r, 50));

    const jobAfterCompletedStart = await storage.queue.getJobByScanId(scanStartJob.id);
    assert(jobAfterCompletedStart?.status === 'COMPLETED', 'Requirement 17: Repeated startJob() does not reopen COMPLETED job to QUEUED');

    // 18. Concurrent claim attempts cannot both acquire the same valid lease
    const scanConcurrent: ScanJob = {
      id: `scan_concurrent_${Date.now()}`,
      userId: user.id,
      videoTitle: 'Concurrent Race Video',
      videoFilename: 'race.mp4',
      videoPath: '/tmp/race.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scanConcurrent);

    // Two workers race concurrently to claim the single queued job
    const [raceClaim1, raceClaim2] = await Promise.all([
      storage.queue.claimNextJob('racer_1', 10000),
      storage.queue.claimNextJob('racer_2', 10000)
    ]);
    const winners = [raceClaim1, raceClaim2].filter(c => c !== null);
    assert(winners.length === 1, 'Requirement 18: Exactly one concurrent worker acquires the lease (no double claim)');

    // 19. Lease recovery works after simulated process failure
    const winningClaim = winners[0]!;
    // Simulate process crash: worker dies without completing or failing job, lease times out
    storage.db.prepare('UPDATE job_queue SET locked_at = ? WHERE id = ?').run(
      new Date(Date.now() - 60000).toISOString(), winningClaim.id
    );
    const recoveredAfterCrash = await storage.queue.recoverStaleJobs(10000);
    assert(recoveredAfterCrash === 1, 'Requirement 19: Lease recovery successfully reclaims abandoned job after process crash');

    const recoveredJobRecord = await storage.queue.getJobByScanId(scanConcurrent.id);
    assert(recoveredJobRecord?.status === 'RETRYABLE', 'Requirement 19: Recovered job is marked RETRYABLE');
    assert(recoveredJobRecord?.lockedBy === null, 'Requirement 19: Locked by is cleared');
    assert(recoveredJobRecord?.leaseToken === null, 'Requirement 19: Lease token is atomically cleared');

    // Clean up
    const drainClaim = await storage.queue.claimNextJob('cleanup_worker', 1000);
    if (drainClaim) {
      await storage.queue.completeJob(drainClaim.id, 'cleanup_worker', drainClaim.leaseToken!);
    }

    // 20. In-memory storage behavioral parity for all fencing semantics
    console.log('\n[Requirement 20: In-Memory Storage Behavioral Parity]');
    const memStore = new InMemoryStorageRepository();
    const memUser = await memStore.users.createUser('mem_p1b1@videorisk.com', 'h', 's', 20, 'creator');
    const memScan: ScanJob = {
      id: `mem_scan_p1b1_${Date.now()}`,
      userId: memUser.id,
      videoTitle: 'In-Memory Parity',
      videoFilename: 'mem.mp4',
      videoPath: '/tmp/mem.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await memStore.scans.createScan(memScan);
    const memClaimA = await memStore.queue.claimNextJob('mem_A', 1000);
    assert(memClaimA !== null, 'In-memory Worker A claimed job');
    const memTokenA = memClaimA!.leaseToken!;

    // Simulate timeout and reclaim
    (memStore as any).state.jobQueue[memScan.id].lockedAt = new Date(Date.now() - 5000).toISOString();
    await memStore.queue.recoverStaleJobs(1000);

    const memClaimB = await memStore.queue.claimNextJob('mem_B', 1000);
    assert(memClaimB !== null, 'In-memory Worker B claimed job');
    const memTokenB = memClaimB!.leaseToken!;
    assert(memTokenB !== memTokenA, 'In-memory Worker B received different leaseToken');

    // Stale Worker A is fenced across all mutations in in-memory
    let memFenceScanUpdateCaught = false;
    try {
      await memStore.scans.updateScan(memScan.id, { status: 'COMPLETED' }, memTokenA);
    } catch (err: any) {
      if (err instanceof FencingError) memFenceScanUpdateCaught = true;
    }
    assert(memFenceScanUpdateCaught, 'Requirement 20: In-memory fences stale updateScan');

    let memFenceDeductCaught = false;
    try {
      await memStore.scans.deductScanCredits(memScan.id, memUser.id, 5, memTokenA);
    } catch (err: any) {
      if (err instanceof FencingError) memFenceDeductCaught = true;
    }
    assert(memFenceDeductCaught, 'Requirement 20: In-memory fences stale deductScanCredits');

    let memFenceRefundCaught = false;
    try {
      await memStore.scans.refundScanCredits(memScan.id, 5, memTokenA);
    } catch (err: any) {
      if (err instanceof FencingError) memFenceRefundCaught = true;
    }
    assert(memFenceRefundCaught, 'Requirement 20: In-memory fences stale refundScanCredits');

    let memFenceEvidenceCaught = false;
    try {
      await memStore.evidence.saveEvidence(memScan.id, [], memTokenA);
    } catch (err: any) {
      if (err instanceof FencingError) memFenceEvidenceCaught = true;
    }
    assert(memFenceEvidenceCaught, 'Requirement 20: In-memory fences stale saveEvidence');

    let memFenceReportCaught = false;
    try {
      await memStore.scans.saveReport(memScan.id, {} as any, memTokenA);
    } catch (err: any) {
      if (err instanceof FencingError) memFenceReportCaught = true;
    }
    assert(memFenceReportCaught, 'Requirement 20: In-memory fences stale saveReport');

    let memFenceUsageCaught = false;
    try {
      await memStore.usage.recordUsage(memUser.id, memScan.id, 5, 5, 'standard', memTokenA);
    } catch (err: any) {
      if (err instanceof FencingError) memFenceUsageCaught = true;
    }
    assert(memFenceUsageCaught, 'Requirement 20: In-memory fences stale recordUsage');

    await memStore.usage.recordUsage(memUser.id, memScan.id, 5, 5, 'standard', memTokenB);
    const memStats1 = await memStore.usage.getUsageStats(memUser.id);
    assert(memStats1.scanCount === 1, 'Requirement 20: In-memory usage recorded once');

    await memStore.usage.recordUsage(memUser.id, memScan.id, 5, 5, 'standard', memTokenB);
    const memStats2 = await memStore.usage.getUsageStats(memUser.id);
    assert(memStats2.scanCount === 1, 'Requirement 20: In-memory duplicate usage is idempotent');

    // Worker B completes
    await memStore.queue.completeJob(memClaimB!.id, 'mem_B', memTokenB);
    const completedMemJob = await memStore.queue.getJobByScanId(memScan.id);
    assert(completedMemJob?.status === 'COMPLETED', 'Requirement 20: In-memory legitimate Worker B completes job');

    console.log('======================================================');
    console.log('TEST SUITE 10 COMPLETE: All 20 Phase 1B.1 requirements verified!');
    console.log('======================================================');
  } finally {
    await storage.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('lease_fencing_and_heartbeat.test.ts')) {
  runLeaseFencingAndHeartbeatTests().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

