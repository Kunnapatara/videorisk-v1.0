import path from 'path';
import fs from 'fs';
import { enforceTestDatabaseIsolation, verifyStorageTestDatabase } from '../src/server/storage/testIsolation';

// ----------------------------------------------------------------------------
// TEST RUNNER DATABASE ISOLATION:
// Explicitly establish dedicated test database BEFORE importing storage or routes.
// Guarantees automated tests cannot silently use or wipe production videorisk.db!
// ----------------------------------------------------------------------------
process.env.VIDEORISK_TEST_RUN = 'true';
const testDbResolution = enforceTestDatabaseIsolation();

async function main() {
  console.log('######################################################');
  console.log('# VIDEORISK.COM — MASTER VERIFICATION TEST SUITE     #');
  console.log('# Security, Isolation, Context & Capability Proofs   #');
  console.log('######################################################');
  console.log(`[Database Isolation] Active Test Database: ${testDbResolution.resolvedPath} (${testDbResolution.source})\n`);

  const startTime = Date.now();

  try {
    // Dynamically import test suites and storage AFTER DATABASE_PATH is locked to test db
    const { storage } = await import('../src/server/storage');

    // Verify the resolved database path before any test performs storage mutations
    verifyStorageTestDatabase((storage as any).dbPath, testDbResolution.resolvedPath);

    const { runAuthAndOwnershipTests } = await import('./auth_and_ownership.test');
    const { runProductCapabilitiesTests } = await import('./product_capabilities.test');
    const { runPersistenceAndBillingHardeningTests } = await import('./persistence_and_billing_hardening.test');
    const { runStorageFailClosedTests } = await import('./storage_fail_closed.test');
    const { runFreeCreditHardeningTests } = await import('./free_credit_hardening.test');
    const { runEvidenceIntegrityHardeningTests } = await import('./evidence_integrity_hardening.test');
    const { runSqliteStorageAndQueueTests } = await import('./sqlite_storage_and_queue.test');
    const { runPasswordRecoveryTests } = await import('./password_recovery.test');
    const { runSecurityRetentionAndE2ETests } = await import('./security_retention_and_e2e.test');
    const { runLeaseFencingAndHeartbeatTests } = await import('./lease_fencing_and_heartbeat.test');
    const { runScanDeletionAndMediaCleanupTests } = await import('./scan_deletion_and_media_cleanup.test');
    const { runRateLimitingAndAbuseProtectionTests } = await import('./rate_limiting_and_abuse_protection.test');
    const { runComprehensiveDefectAndPipelineTests } = await import('./comprehensive_defect_and_pipeline_verification.test');
    const { runVisualDuplicateBenchmark } = await import('./visual_duplicate_benchmark.test');

    // Narrowly scoped cleanup of test-specific rate limits (never deletes real/unrelated records)
    await storage.rateLimits.clearRateLimits?.();

    // Run Suite 1
    await runAuthAndOwnershipTests();

    // Run Suite 2
    await runProductCapabilitiesTests();

    // Run Suite 3
    await runPersistenceAndBillingHardeningTests();

    // Run Suite 4: Storage Fail-Closed
    await runStorageFailClosedTests();

    // Run Suite 5: Free Credit Claim Hardening
    await runFreeCreditHardeningTests();

    // Run Suite 6: Evidence Integrity Hardening & Credit Refund
    await runEvidenceIntegrityHardeningTests();

    // Run Suite 7: Durable SQLite Storage & Job Queue
    await runSqliteStorageAndQueueTests();

    // Run Suite 8: Secure Password Recovery
    await runPasswordRecoveryTests();

    // Run Suite 9: Security, Retention & Real Media E2E
    await runSecurityRetentionAndE2ETests();

    // Run Suite 10: Lease Fencing, Heartbeat & Stale Worker Protection
    await runLeaseFencingAndHeartbeatTests();

    // Run Suite 11: Scan Deletion & Billing Configuration
    await runScanDeletionAndMediaCleanupTests();

    // Run Suite 12: Route-Level Rate Limiting & Abuse Protection
    await runRateLimitingAndAbuseProtectionTests();

    // Run Suite 13: Comprehensive Defect & Pipeline Verification
    await runComprehensiveDefectAndPipelineTests();

    // Run Suite 14: Visual Duplicate & Slideshow Benchmark
    await runVisualDuplicateBenchmark();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n🎉 ALL AUTOMATED VERIFICATION SUITES COMPLETED SUCCESSFULLY in ${elapsed}s!`);
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ MASTER VERIFICATION RUN FAILED:', err);
    process.exit(1);
  }
}

main();
