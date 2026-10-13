import path from 'path';
import fs from 'fs';
import os from 'os';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStorageRepository, migrateJsonToSqlite } from '../src/server/storage/sqliteStorage';
import { ScanJob } from '../src/types';

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
    await storage.queue.completeJob(workerBetaClaimAfterRecovery!.id, 'worker_alpha');
    const stillRunningJob = await storage.queue.getJobByScanId(scanJob.id);
    assert(stillRunningJob?.status === 'RUNNING', 'Stale worker Alpha is fenced from completing job owned by Worker Beta');
    assert(stillRunningJob?.lockedBy === 'worker_beta', 'Worker Beta still securely holds lease lock');

    // Legitimate owner Worker Beta completes job
    await storage.queue.completeJob(workerBetaClaimAfterRecovery!.id, 'worker_beta');
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
    const renewed = await storage.queue.renewLease(claimedRunning!.id, 'worker_gamma');
    assert(renewed === true, 'Active worker Gamma successfully renewed lease');

    // Stale worker cannot renew lease
    const staleRenew = await storage.queue.renewLease(claimedRunning!.id, 'worker_unauthorized');
    assert(staleRenew === false, 'Unauthorized/stale worker cannot renew lease');

    // Fail job with retryable = false (terminal FAILED)
    await storage.queue.failJob(claimedRunning!.id, 'Terminal test failure', false, 0, 'worker_gamma');
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
