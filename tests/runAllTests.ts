import path from 'path';
import fs from 'fs';
import os from 'os';
import { runAuthAndOwnershipTests } from './auth_and_ownership.test';
import { runProductCapabilitiesTests } from './product_capabilities.test';
import { runPersistenceAndBillingHardeningTests } from './persistence_and_billing_hardening.test';
import { runStorageFailClosedTests } from './storage_fail_closed.test';
import { runFreeCreditHardeningTests } from './free_credit_hardening.test';
import { runEvidenceIntegrityHardeningTests } from './evidence_integrity_hardening.test';
import { runSqliteStorageAndQueueTests } from './sqlite_storage_and_queue.test';
import { runPasswordRecoveryTests } from './password_recovery.test';
import { runSecurityRetentionAndE2ETests } from './security_retention_and_e2e.test';

async function main() {
  console.log('######################################################');
  console.log('# VIDEORISK.COM — MASTER VERIFICATION TEST SUITE     #');
  console.log('# Security, Isolation, Context & Capability Proofs   #');
  console.log('######################################################');

  const startTime = Date.now();

  try {
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

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n🎉 ALL AUTOMATED VERIFICATION SUITES COMPLETED SUCCESSFULLY in ${elapsed}s!`);
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ MASTER VERIFICATION RUN FAILED:', err);
    process.exit(1);
  }
}

main();
