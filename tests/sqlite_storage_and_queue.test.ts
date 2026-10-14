import path from 'path';
import fs from 'fs';
import os from 'os';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorageRepository, migrateJsonToSqlite } from '../src/server/storage/sqliteStorage';
import { InMemoryStorageRepository } from '../src/server/storage/index';
import { ScanJob, FencingError, RiskReport, EvidenceItem, ReScanComparison } from '../src/types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ✅ PASS: ${message}`);
}

export async function runSqliteStorageAndQueueTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 7: DURABLE SQLITE STORAGE & QUEUE ---');
  console.log('======================================================');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_sqlite_test_'));
  const testDbPath = path.join(tempDir, 'videorisk_test.db');

  try {
    // ---------------------------------------------------------
    // 1. Schema Migrations & Pragma Verification
    // ---------------------------------------------------------
    console.log('\n[1. Schema Migrations & ACID Durability]');
    const storage = new SqliteStorageRepository(testDbPath);

    const tables = storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map(t => t.name));

    assert(tableNames.has('schema_migrations'), 'schema_migrations table exists');
    assert(tableNames.has('users'), 'users table exists');
    assert(tableNames.has('sessions'), 'sessions table exists');
    assert(tableNames.has('password_resets'), 'password_resets table exists');
    assert(tableNames.has('rate_limits'), 'rate_limits table exists');
    assert(tableNames.has('uploads'), 'uploads table exists');
    assert(tableNames.has('scans'), 'scans table exists');
    assert(tableNames.has('job_queue'), 'job_queue table exists');
    assert(tableNames.has('reports'), 'reports table exists');
    assert(tableNames.has('evidence'), 'evidence table exists');
    assert(tableNames.has('comparisons'), 'comparisons table exists');
    assert(tableNames.has('usage_ledger'), 'usage_ledger table exists');
    assert(tableNames.has('webhook_events'), 'webhook_events table exists');
    assert(tableNames.has('subscriptions'), 'subscriptions table exists');

    const journalMode = (storage.db.prepare('PRAGMA journal_mode').get() as any).journal_mode;
    assert(journalMode.toLowerCase() === 'wal', 'SQLite journal_mode is configured to WAL');

    const fk = (storage.db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys;
    assert(Number(fk) === 1, 'Foreign keys are strictly enforced (PRAGMA foreign_keys = ON)');

    // ---------------------------------------------------------
    // 2. User Accounts, Unique Constraints & ACID Transactions
    // ---------------------------------------------------------
    console.log('\n[2. User Accounts, Unique Constraints & Atomicity]');
    const user = await storage.users.createUser('alice@videorisk.com', 'hash123', 'salt123', 25, 'creator');
    assert(user.email === 'alice@videorisk.com', 'Created user email matches');
    assert(user.creditsRemaining === 25, 'Created user initial credits match');
    assert(user.plan === 'creator', 'Created user plan matches');

    let duplicateEmailRejected = false;
    try {
      await storage.users.createUser('alice@videorisk.com', 'hash_other', 'salt_other', 10, 'free');
    } catch {
      duplicateEmailRejected = true;
    }
    assert(duplicateEmailRejected, 'Unique email constraint strictly prevents duplicate registration');

    // Atomic deductions
    const deducted = await storage.users.deductCredits(user.id, 10);
    assert(deducted === true, 'Credits deducted successfully');
    const userAfterDeduct = await storage.users.getUser(user.id);
    assert(userAfterDeduct?.creditsRemaining === 15, 'Credits balance updated correctly (15)');
    assert(userAfterDeduct?.creditsUsedTotal === 10, 'Usage total incremented correctly (10)');

    const overspend = await storage.users.deductCredits(user.id, 999);
    assert(overspend === false, 'Overspending credits beyond balance rejected atomically');

    // Free trial single claim constraint
    const newUser = await storage.users.createUser('bob@videorisk.com', 'hash', 'salt', 0, 'free');
    // Ensure initial free trial flag is false for test
    storage.db.prepare('UPDATE users SET free_trial_claimed = 0, credits_remaining = 0 WHERE id = ?').run(newUser.id);
    
    const claim1 = await storage.users.claimFreeTrial(newUser.id);
    assert(claim1.alreadyClaimed === false, 'First free trial claim succeeds');
    assert(claim1.user.creditsRemaining === 10, 'Granted 10 free trial credits');

    const claim2 = await storage.users.claimFreeTrial(newUser.id);
    assert(claim2.alreadyClaimed === true, 'Second free trial claim on same account rejected (alreadyClaimed)');
    const bobAfterClaim2 = await storage.users.getUser(newUser.id);
    assert(bobAfterClaim2?.creditsRemaining === 10, 'Balance unchanged at 10 after repeat trial claim attempt');

    // ---------------------------------------------------------
    // 3. Durable Job Queue with Lease Locking & Worker Recovery
    // ---------------------------------------------------------
    console.log('\n[3. Durable Queue: Lease Locking & Stale Job Recovery]');
    const scanJob: ScanJob = {
      id: `scan_queue_${Date.now()}`,
      userId: user.id,
      videoTitle: 'Queue Test Video',
      videoFilename: 'test.mp4',
      videoPath: '/tmp/test.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scanJob);

    // Verify scan automatically enrolled into job queue
    const queuedJob = await storage.queue.getJobByScanId(scanJob.id);
    assert(queuedJob !== null, 'Scan job automatically created in durable job_queue table');
    assert(queuedJob?.status === 'QUEUED', 'Job starts in QUEUED status');
    assert(queuedJob?.attempts === 0, 'Job initial attempts count is 0');

    // Worker 1 claims job with 2000ms lease
    const claimedJob = await storage.queue.claimNextJob('worker_alpha', 2000);
    assert(claimedJob !== null && claimedJob.scanId === scanJob.id, 'Worker Alpha successfully claimed next queued job');
    assert(claimedJob?.status === 'RUNNING', 'Claimed job transitions to RUNNING status');
    assert(claimedJob?.lockedBy === 'worker_alpha', 'Lease locked by Worker Alpha');
    assert(claimedJob?.attempts === 1, 'Job attempts incremented to 1 on claim');

    // Worker 2 attempts claim while Worker Alpha holds lease
    const workerBetaClaim = await storage.queue.claimNextJob('worker_beta', 2000);
    assert(workerBetaClaim === null, 'Worker Beta cannot claim job while lease is actively held');

    // Validate invalid lease timeout rejected
    let invalidTimeoutCaught = false;
    try {
      await storage.queue.recoverStaleJobs(-100);
    } catch {
      invalidTimeoutCaught = true;
    }
    assert(invalidTimeoutCaught, 'Negative lease timeout rejected with validation error');

    // Verify active lease is NOT reclaimed early
    const activeUnexpiredCount = await storage.queue.recoverStaleJobs(60000);
    assert(activeUnexpiredCount === 0, 'Active running job with valid lease is NOT prematurely reclaimed');

    // Stale job recovery test: Simulate lease expiration
    const expiredTimestamp = new Date(Date.now() - 5000).toISOString();
    storage.db.prepare('UPDATE job_queue SET locked_at = ? WHERE scan_id = ?').run(expiredTimestamp, scanJob.id);

    const recoveredCount = await storage.queue.recoverStaleJobs(1000);
    assert(recoveredCount === 1, 'Expired job recovered from abandoned worker lease');

    const recoveredJob = await storage.queue.getJobByScanId(scanJob.id);
    assert(recoveredJob?.status === 'RETRYABLE', 'Recovered job marked RETRYABLE');
    assert(recoveredJob?.lockedBy === null, 'Recovered job released lease lock');

    // Worker Beta claims the recovered job
    const workerBetaClaimAfterRecovery = await storage.queue.claimNextJob('worker_beta', 5000);
    assert(workerBetaClaimAfterRecovery !== null, 'Worker Beta successfully claimed recovered job');
    assert(workerBetaClaimAfterRecovery?.lockedBy === 'worker_beta', 'Worker Beta now holds lease lock');

    // Worker Alpha (stale worker) attempts to complete the reclaimed job with its stale ownership
    let staleAlphaCaught = false;
    try {
      await storage.queue.completeJob(workerBetaClaimAfterRecovery!.id, 'worker_alpha', claimedJob!.leaseToken!);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') staleAlphaCaught = true;
    }
    assert(staleAlphaCaught, 'Stale worker Alpha is fenced from completing job owned by Worker Beta');
    const stillRunningJob = await storage.queue.getJobByScanId(scanJob.id);
    assert(stillRunningJob?.status === 'RUNNING', 'Job remains in RUNNING status');
    assert(stillRunningJob?.lockedBy === 'worker_beta', 'Worker Beta still securely holds lease lock');

    // Legitimate owner Worker Beta completes job
    await storage.queue.completeJob(workerBetaClaimAfterRecovery!.id, 'worker_beta', workerBetaClaimAfterRecovery!.leaseToken!);
    const completedJob = await storage.queue.getJobByScanId(scanJob.id);
    assert(completedJob?.status === 'COMPLETED', 'Job successfully completed by legitimate Worker Beta and marked COMPLETED');

    // ---------------------------------------------------------
    // 3.1 Idempotency, No-Reset Protection & Lease Renewal
    // ---------------------------------------------------------
    console.log('\n[3.1 Idempotency, No-Reset Protection & Lease Renewal]');

    // Repeat enqueue on COMPLETED job must NOT reopen to QUEUED
    await storage.queue.enqueueJob(scanJob.id);
    const postCompletedReEnqueue = await storage.queue.getJobByScanId(scanJob.id);
    assert(postCompletedReEnqueue?.status === 'COMPLETED', 'Duplicate enqueue on COMPLETED job does NOT reset status to QUEUED (Idempotent)');

    // Active RUNNING job non-reset test
    const scanJobRunning: ScanJob = {
      id: `scan_running_${Date.now()}`,
      userId: user.id,
      videoTitle: 'Running Non-Reset Video',
      videoFilename: 'test_running.mp4',
      videoPath: '/tmp/test_running.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(scanJobRunning);
    const claimedRunning = await storage.queue.claimNextJob('worker_gamma', 30000);
    assert(claimedRunning !== null && claimedRunning.scanId === scanJobRunning.id, 'Claimed running job');
    assert(claimedRunning?.status === 'RUNNING', 'Job is in RUNNING status');

    // Duplicate enqueue while RUNNING must NOT reset to QUEUED or clear lease
    await storage.queue.enqueueJob(scanJobRunning.id);
    const stillRunningAfterEnqueue = await storage.queue.getJobByScanId(scanJobRunning.id);
    assert(stillRunningAfterEnqueue?.status === 'RUNNING', 'Duplicate enqueue on RUNNING job does NOT reset to QUEUED');
    assert(stillRunningAfterEnqueue?.lockedBy === 'worker_gamma', 'Duplicate enqueue does NOT clear active worker lease');

    // Lease renewal test: Worker Gamma successfully renews lease
    const renewed = await storage.queue.renewLease(claimedRunning!.id, 'worker_gamma', claimedRunning!.leaseToken!);
    assert(renewed === true, 'Active worker Gamma successfully renewed lease');

    // Stale worker cannot renew lease
    let staleRenewCaught = false;
    try {
      const staleRenew = await storage.queue.renewLease(claimedRunning!.id, 'worker_unauthorized', 'stale_token_xyz');
      if (staleRenew === false) staleRenewCaught = true;
    } catch (err: any) {
      if (err instanceof FencingError) staleRenewCaught = true;
    }
    assert(staleRenewCaught, 'Unauthorized/stale worker cannot renew lease');

    // Fail job with retryable = false (terminal FAILED)
    await storage.queue.failJob(claimedRunning!.id, 'Terminal test failure', false, 0, 'worker_gamma', claimedRunning!.leaseToken!);
    const failedJob = await storage.queue.getJobByScanId(scanJobRunning.id);
    assert(failedJob?.status === 'FAILED', 'Job transitioned to terminal FAILED status');

    // Duplicate enqueue on FAILED job must NOT silently reopen
    await storage.queue.enqueueJob(scanJobRunning.id);
    const failedJobAfterReEnqueue = await storage.queue.getJobByScanId(scanJobRunning.id);
    assert(failedJobAfterReEnqueue?.status === 'FAILED', 'Duplicate enqueue on FAILED job does NOT reopen to QUEUED');

    // Intentional retry via retryJob
    const retriedJob = await storage.queue.retryJob(scanJobRunning.id);
    assert(retriedJob.status === 'QUEUED', 'Explicit retryJob safely transitions FAILED job back to QUEUED');
    assert(retriedJob.attempts === 0, 'Explicit retryJob resets attempts count to 0');
    assert(retriedJob.lockedBy === null, 'Explicit retryJob clears worker lease');

    // Attempting retryJob on active QUEUED job throws error
    let activeRetryCaught = false;
    try {
      await storage.queue.retryJob(scanJobRunning.id);
    } catch {
      activeRetryCaught = true;
    }
    assert(activeRetryCaught, 'retryJob on already QUEUED job is rejected');

    // Attempting retryJob on COMPLETED job throws error (must use explicit re-scan)
    let completedRetryCaught = false;
    try {
      await storage.queue.retryJob(scanJob.id);
    } catch {
      completedRetryCaught = true;
    }
    assert(completedRetryCaught, 'retryJob on COMPLETED job is rejected (re-scan required)');

    // Drain previous test job from queue so 3.2 starts with a clean queue
    const drainJob = await storage.queue.claimNextJob('cleanup_worker', 1000);
    if (drainJob) {
      await storage.queue.completeJob(drainJob.id, 'cleanup_worker', drainJob.leaseToken!);
    }

    // ---------------------------------------------------------
    // 3.2 Lease Fencing & Stale Worker Protection
    // ---------------------------------------------------------
    console.log('\n[3.2 Lease Fencing & Stale Worker Protection]');

    // Create test scan for fencing verification
    const fenceUser = await storage.users.createUser('fence_user@videorisk.com', 'h', 's', 20, 'creator');
    const fencedScan: ScanJob = {
      id: `scan_fenced_${Date.now()}`,
      userId: fenceUser.id,
      videoTitle: 'Fenced Concurrency Video',
      videoFilename: 'fenced.mp4',
      videoPath: '/tmp/fenced.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await storage.scans.createScan(fencedScan);

    // Generation 1: Worker 1 claims job
    const worker1Claim = await storage.queue.claimNextJob('worker_1', 10000);
    assert(worker1Claim !== null && worker1Claim.scanId === fencedScan.id, 'Worker 1 successfully claimed job');
    assert(typeof worker1Claim?.leaseToken === 'string' && worker1Claim.leaseToken.startsWith('lease_'), 'Claim generates unique leaseToken');
    const worker1Token = worker1Claim!.leaseToken!;

    // Worker 1 can perform updates with valid lease token
    const updatedByWorker1 = await storage.scans.updateScan(fencedScan.id, {
      status: 'INSPECTING',
      currentStage: 'Media inspection'
    }, worker1Token);
    assert(updatedByWorker1?.status === 'INSPECTING', 'Worker 1 updates scan status with valid lease token');

    // Worker 1 deducts credits with valid lease token
    const initialUserCredits = (await storage.users.getUser(fenceUser.id))!.creditsRemaining;
    const worker1Deduct = await storage.scans.deductScanCredits(fencedScan.id, fenceUser.id, 5, worker1Token);
    assert(worker1Deduct === true, 'Worker 1 successfully deducts credits with valid lease token');
    const userCreditsAfterWorker1Deduct = (await storage.users.getUser(fenceUser.id))!.creditsRemaining;
    assert(userCreditsAfterWorker1Deduct === initialUserCredits - 5, 'User balance decreased by 5');

    // Simulate lease expiration on Worker 1 and recovery
    const staleTime = new Date(Date.now() - 30000).toISOString();
    storage.db.prepare('UPDATE job_queue SET locked_at = ? WHERE scan_id = ?').run(staleTime, fencedScan.id);
    const recoveredFenced = await storage.queue.recoverStaleJobs(5000);
    assert(recoveredFenced === 1, 'Worker 1 expired lease recovered by queue recovery');

    // Generation 2: Worker 2 claims recovered job
    const worker2Claim = await storage.queue.claimNextJob('worker_2', 15000);
    assert(worker2Claim !== null && worker2Claim.scanId === fencedScan.id, 'Worker 2 claimed recovered job');
    assert(worker2Claim?.leaseToken !== worker1Token, 'Worker 2 assigned fresh, unique leaseToken superseding Worker 1');
    const worker2Token = worker2Claim!.leaseToken!;

    // 1. Stale Worker 1 attempting scan update is fenced
    let worker1UpdateFailed = false;
    try {
      await storage.scans.updateScan(fencedScan.id, {
        status: 'PROCESSING_AUDIO',
        currentStage: 'Audio & transcript'
      }, worker1Token);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') worker1UpdateFailed = true;
    }
    assert(worker1UpdateFailed, 'Stale Worker 1 is fenced from updating scan status (FencingError thrown)');
    const scanAfterBlockedUpdate = await storage.scans.getScan(fencedScan.id);
    assert(scanAfterBlockedUpdate?.status === 'INSPECTING', 'Scan status remained intact after stale update attempt');

    // 2. Stale Worker 1 attempting credit deduction is fenced
    let worker1DeductFailed = false;
    try {
      await storage.scans.deductScanCredits(fencedScan.id, fenceUser.id, 5, worker1Token);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') worker1DeductFailed = true;
    }
    assert(worker1DeductFailed, 'Stale Worker 1 is fenced from deducting credits');
    const userCreditsAfterBlockedDeduct = (await storage.users.getUser(fenceUser.id))!.creditsRemaining;
    assert(userCreditsAfterBlockedDeduct === userCreditsAfterWorker1Deduct, 'User credit balance untouched by stale worker deduction');

    // 3. Stale Worker 1 attempting refund is fenced
    let worker1RefundFailed = false;
    try {
      await storage.scans.refundScanCredits(fencedScan.id, undefined, worker1Token);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') worker1RefundFailed = true;
    }
    assert(worker1RefundFailed, 'Stale Worker 1 is fenced from refunding scan credits');
    const userCreditsAfterBlockedRefund = (await storage.users.getUser(fenceUser.id))!.creditsRemaining;
    assert(userCreditsAfterBlockedRefund === userCreditsAfterWorker1Deduct, 'User credit balance untouched by stale worker refund');

    // 4. Stale Worker 1 attempting to save evidence is fenced
    let worker1EvidenceFailed = false;
    try {
      await storage.evidence.saveEvidence(fencedScan.id, [{
        id: 'stale_ev_1',
        scanId: fencedScan.id,
        timestamp: 1.5,
        type: 'visual',
        title: 'Stale Evidence',
        severity: 'critical',
        explanation: 'Should be rejected'
      } as any], worker1Token);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') worker1EvidenceFailed = true;
    }
    assert(worker1EvidenceFailed, 'Stale Worker 1 is fenced from saving evidence');
    const evidenceAfterBlockedSave = await storage.evidence.getEvidence(fencedScan.id);
    assert(evidenceAfterBlockedSave.length === 0, 'No evidence written by stale worker');

    // 5. Stale Worker 1 attempting to save report is fenced
    let worker1ReportFailed = false;
    try {
      await storage.scans.saveReport(fencedScan.id, {
        scanId: fencedScan.id,
        overallRisk: 'HIGH_RISK',
        riskSummary: 'Stale report',
        disclaimer: 'test',
        domainReports: {},
        riskCategories: {},
        topIssues: [],
        policyConnections: [],
        timeline: []
      } as any, worker1Token);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') worker1ReportFailed = true;
    }
    assert(worker1ReportFailed, 'Stale Worker 1 is fenced from saving report');
    const reportAfterBlockedSave = await storage.scans.getReport(fencedScan.id);
    assert(reportAfterBlockedSave === null, 'No report written by stale worker');

    // 6. Stale Worker 1 attempting completeJob or failJob is fenced
    let worker1CompleteFailed = false;
    try {
      await storage.queue.completeJob(worker2Claim!.id, 'worker_1', worker1Token);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') worker1CompleteFailed = true;
    }
    assert(worker1CompleteFailed, 'Stale Worker 1 is fenced from completing job (FencingError thrown)');

    let worker1FailJobFailed = false;
    try {
      await storage.queue.failJob(worker2Claim!.id, 'stale failure', false, 0, 'worker_1', worker1Token);
    } catch (err: any) {
      if (err instanceof FencingError || err.name === 'FencingError') worker1FailJobFailed = true;
    }
    assert(worker1FailJobFailed, 'Stale Worker 1 is fenced from failing job (FencingError thrown)');

    // 7. Legitimate Worker 2 succeeds with its active lease token across all operations
    await storage.evidence.saveEvidence(fencedScan.id, [{
      id: 'legit_ev_1',
      scanId: fencedScan.id,
      timestamp: 2.0,
      type: 'audio',
      title: 'Legitimate Evidence',
      severity: 'medium',
      explanation: 'Verified by Worker 2'
    } as any], worker2Token);
    const legitEvidence = await storage.evidence.getEvidence(fencedScan.id);
    assert(legitEvidence.length === 1 && legitEvidence[0].id === 'legit_ev_1', 'Worker 2 successfully writes evidence');

    await storage.scans.saveReport(fencedScan.id, {
      scanId: fencedScan.id,
      overallRisk: 'LOW_RISK',
      riskSummary: 'Clean scan report by Worker 2',
      disclaimer: 'Verified',
      domainReports: {},
      riskCategories: {},
      topIssues: [],
      policyConnections: [],
      timeline: []
    } as any, worker2Token);
    const legitReport = await storage.scans.getReport(fencedScan.id);
    assert(legitReport !== null && legitReport.riskSummary === 'Clean scan report by Worker 2', 'Worker 2 successfully saves report');

    await storage.scans.updateScan(fencedScan.id, {
      status: 'COMPLETED',
      completedAt: new Date().toISOString()
    }, worker2Token);
    const completedScanRecord = await storage.scans.getScan(fencedScan.id);
    assert(completedScanRecord?.status === 'COMPLETED', 'Worker 2 successfully updates scan to COMPLETED');

    await storage.queue.completeJob(worker2Claim!.id, 'worker_2', worker2Token);
    const completedQueueRecord = await storage.queue.getJobByScanId(fencedScan.id);
    assert(completedQueueRecord?.status === 'COMPLETED', 'Worker 2 successfully completes job with matching token');
    assert(completedQueueRecord?.leaseToken === null, 'Lease token cleared on completion');

    // ---------------------------------------------------------
    // 3.3 In-Memory Storage Fencing Parity Check
    // ---------------------------------------------------------
    console.log('\n[3.3 In-Memory Storage Lease Fencing Behavioral Parity]');
    const memStorage = new InMemoryStorageRepository();
    const memUser = await memStorage.users.createUser('mem_user@videorisk.com', 'h', 's', 20, 'creator');
    const memScan: ScanJob = {
      id: `mem_scan_${Date.now()}`,
      userId: memUser.id,
      videoTitle: 'Mem Fenced Scan',
      videoFilename: 'mem.mp4',
      videoPath: '/tmp/mem.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString()
    };
    await memStorage.scans.createScan(memScan);

    const memClaim1 = await memStorage.queue.claimNextJob('mem_worker_1', 1000);
    assert(memClaim1 !== null && typeof memClaim1.leaseToken === 'string', 'In-memory claim sets unique leaseToken');
    const memToken1 = memClaim1!.leaseToken!;

    // Fast-forward lockedAt to simulate timeout and recover
    (memStorage as any).state.jobQueue[memScan.id].lockedAt = new Date(Date.now() - 5000).toISOString();
    await memStorage.queue.recoverStaleJobs(1000);

    const memClaim2 = await memStorage.queue.claimNextJob('mem_worker_2', 1000);
    assert(memClaim2 !== null && memClaim2.leaseToken !== memToken1, 'In-memory second claim has new leaseToken');
    const memToken2 = memClaim2!.leaseToken!;

    let memStaleUpdateCaught = false;
    try {
      await memStorage.scans.updateScan(memScan.id, { status: 'FAILED' }, memToken1);
    } catch (err: any) {
      if (err instanceof FencingError) memStaleUpdateCaught = true;
    }
    assert(memStaleUpdateCaught, 'In-memory storage fences stale worker from updateScan');

    let memStaleDeductCaught = false;
    try {
      await memStorage.scans.deductScanCredits(memScan.id, memUser.id, 5, memToken1);
    } catch (err: any) {
      if (err instanceof FencingError) memStaleDeductCaught = true;
    }
    assert(memStaleDeductCaught, 'In-memory storage fences stale worker from deductScanCredits');

    let memStaleRefundCaught = false;
    try {
      await memStorage.scans.refundScanCredits(memScan.id, 5, memToken1);
    } catch (err: any) {
      if (err instanceof FencingError) memStaleRefundCaught = true;
    }
    assert(memStaleRefundCaught, 'In-memory storage fences stale worker from refundScanCredits');

    let memStaleEvidenceCaught = false;
    try {
      await memStorage.evidence.saveEvidence(memScan.id, [], memToken1);
    } catch (err: any) {
      if (err instanceof FencingError) memStaleEvidenceCaught = true;
    }
    assert(memStaleEvidenceCaught, 'In-memory storage fences stale worker from saveEvidence');

    let memStaleReportCaught = false;
    try {
      await memStorage.scans.saveReport(memScan.id, {} as any, memToken1);
    } catch (err: any) {
      if (err instanceof FencingError) memStaleReportCaught = true;
    }
    assert(memStaleReportCaught, 'In-memory storage fences stale worker from saveReport');

    // Legitimate owner completes in-memory job
    await memStorage.queue.completeJob(memClaim2!.id, 'mem_worker_2', memToken2);
    const completedMemJob = await memStorage.queue.getJobByScanId(memScan.id);
    assert(completedMemJob?.status === 'COMPLETED', 'In-memory legitimate worker completes job successfully');

    // ---------------------------------------------------------
    // 4. Durability Across Restart
    // ---------------------------------------------------------
    console.log('\n[4. Persistence Across Database Restarts]');
    await storage.close();

    // Reopen database from same file path
    const reopenedStorage = new SqliteStorageRepository(testDbPath);
    const restoredUser = await reopenedStorage.users.getUser(user.id);
    assert(restoredUser !== null, 'User account persisted and restored across database reload');
    assert(restoredUser?.email === 'alice@videorisk.com', 'Restored user email matches');
    assert(restoredUser?.creditsRemaining === 15, 'Restored user credits balance matches (15)');

    const restoredScan = await reopenedStorage.scans.getScan(scanJob.id);
    assert(restoredScan !== null, 'Scan record persisted and restored across database reload');
    assert(restoredScan?.videoTitle === 'Queue Test Video', 'Restored scan title matches');

    // ---------------------------------------------------------
    // 5. Legacy JSON to SQLite Migration
    // ---------------------------------------------------------
    console.log('\n[5. Legacy JSON Storage Migration Utility]');
    const legacyJsonPath = path.join(tempDir, 'legacy_store.json');
    const legacyData = {
      users: {
        usr_legacy_101: {
          id: 'usr_legacy_101',
          email: 'legacy_migrated@videorisk.com',
          plan: 'creator',
          creditsRemaining: 42,
          creditsUsedTotal: 10,
          totalScansCount: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
          freeTrialClaimed: true
        }
      },
      scans: {
        scan_legacy_501: {
          id: 'scan_legacy_501',
          userId: 'usr_legacy_101',
          videoTitle: 'Legacy Archive Cut',
          videoFilename: 'archive.mp4',
          videoPath: '/tmp/archive.mp4',
          scanMode: 'standard',
          status: 'COMPLETED',
          currentStage: 'Risk report',
          completedStages: ['Upload', 'Risk report'],
          creditsUsed: 2,
          createdAt: '2026-01-01T01:00:00.000Z'
        }
      },
      reports: {
        scan_legacy_501: {
          scanId: 'scan_legacy_501',
          overallRisk: 'LOW_RISK',
          riskSummary: 'Clean legacy baseline',
          disclaimer: 'Legacy disclaimer',
          domainReports: {},
          riskCategories: {},
          topIssues: [],
          policyConnections: [],
          timeline: []
        }
      }
    };
    fs.writeFileSync(legacyJsonPath, JSON.stringify(legacyData));

    const migrationResult = migrateJsonToSqlite(legacyJsonPath, reopenedStorage);
    assert(migrationResult.migratedUsers === 1, 'Migrated 1 legacy user record to SQLite');
    assert(migrationResult.migratedScans === 1, 'Migrated 1 legacy scan record to SQLite');
    assert(migrationResult.migratedReports === 1, 'Migrated 1 legacy risk report to SQLite');
    assert(fs.existsSync(migrationResult.backupPath), 'Timestamped JSON backup created before migration');

    const migratedUserInSqlite = await reopenedStorage.users.getUser('usr_legacy_101');
    assert(migratedUserInSqlite?.creditsRemaining === 42, 'Migrated user credit balance strictly preserved at 42');
    assert(migratedUserInSqlite?.freeTrialClaimed === true, 'Migrated user freeTrialClaimed status preserved');

    const migratedScanInSqlite = await reopenedStorage.scans.getScan('scan_legacy_501');
    assert(migratedScanInSqlite?.videoTitle === 'Legacy Archive Cut', 'Migrated scan retrieved from SQLite');

    // ---------------------------------------------------------
    // 6. Transaction Atomicity & Nested Savepoint Rollback
    // ---------------------------------------------------------
    console.log('\n[6. Transaction Boundaries & Nested Savepoints]');
    
    // Top-level failure rolls back entire transaction
    let txFailed = false;
    try {
      await reopenedStorage.runTransaction(async db => {
        db.prepare(`
          INSERT INTO users (id, email, plan, credits_remaining, created_at)
          VALUES ('user_fail_1', 'fail_rollback@videorisk.com', 'free', 10, ?)
        `).run(new Date().toISOString());

        throw new Error('Simulated mid-transaction failure');
      });
    } catch {
      txFailed = true;
    }
    assert(txFailed, 'Transaction threw planned failure error');
    const rolledBackUser = await reopenedStorage.users.getUser('user_fail_1');
    assert(rolledBackUser === null, 'User created before failure was cleanly rolled back (no partial write)');

    // Nested transaction savepoint rollback
    await reopenedStorage.runTransaction(async outerDb => {
      outerDb.prepare(`
        INSERT INTO users (id, email, plan, credits_remaining, created_at)
        VALUES ('user_nested_outer', 'outer_tx@videorisk.com', 'free', 25, ?)
      `).run(new Date().toISOString());

      let innerFailed = false;
      try {
        await reopenedStorage.runTransaction(async innerDb => {
          innerDb.prepare(`
            INSERT INTO users (id, email, plan, credits_remaining, created_at)
            VALUES ('user_nested_inner', 'inner_tx@videorisk.com', 'free', 5, ?)
          `).run(new Date().toISOString());

          throw new Error('Simulated nested savepoint failure');
        });
      } catch {
        innerFailed = true;
      }
      assert(innerFailed, 'Inner savepoint transaction threw error');
    });

    const outerUser = await reopenedStorage.users.getUser('user_nested_outer');
    const innerUser = await reopenedStorage.users.getUser('user_nested_inner');
    assert(outerUser !== null, 'Outer transaction successfully committed its modifications');
    assert(innerUser === null, 'Inner failed transaction was safely rolled back by savepoint without aborting outer');

    await reopenedStorage.close();
    console.log('======================================================');
    console.log('TEST SUITE 7 COMPLETE: All SQLite & Queue assertions passed!');
    console.log('======================================================');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
