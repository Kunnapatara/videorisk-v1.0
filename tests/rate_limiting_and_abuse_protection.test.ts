import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import type { Server } from 'http';
import {
  apiRouter,
  getClientIp,
  parsePositiveInt,
  resolveRateLimitInt,
  parseStrictPositiveInt,
  configureTrustProxy,
  isValidIpOrCidr
} from '../src/server/routes/api';
import { storage, InMemoryStorageRepository, SqliteStorageRepository } from '../src/server/storage';
import {
  enforceTestDatabaseIsolation,
  verifyStorageTestDatabase,
  getProductionDatabasePath,
  getDefaultTestDatabasePath,
  canonicalizeDatabaseTarget,
  validateTestDatabaseTarget,
  isTargetingProduction,
  getProductionCanonicalTargets,
  isTestDatabasePath,
  setPreservedProductionDatabasePath,
  getPreservedProductionDatabasePath,
  DEFAULT_PRODUCTION_DB_BASENAME,
  DEFAULT_TEST_DB_BASENAME
} from '../src/server/storage/testIsolation';

function assert(condition: boolean, desc: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${desc}`);
  } else {
    console.error(`  ❌ FAIL: ${desc}`);
    throw new Error(`Test assertion failed: ${desc}`);
  }
}

export async function runRateLimitingAndAbuseProtectionTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 12: ROUTE-LEVEL RATE LIMITING & ABUSE PROTECTION ---');
  console.log('======================================================\n');

  // ---------------------------------------------------------
  // 1. Storage Concurrency & Atomic Quota Protection
  // ---------------------------------------------------------
  console.log('[1. Storage Concurrency & Atomic Quota Protection]');

  const testKey = `concurrent_test_${Date.now()}`;
  const action = 'burst_attempt';
  const limit = 5;
  const windowSec = 60;

  // Fire 15 simultaneous requests across async promises
  const burstPromises = Array.from({ length: 15 }, () =>
    storage.rateLimits.checkRateLimit(testKey, action, limit, windowSec)
  );

  const results = await Promise.all(burstPromises);
  const allowedCount = results.filter(r => r === true).length;
  const blockedCount = results.filter(r => r === false).length;

  assert(allowedCount === limit, `Exactly ${limit} simultaneous requests allowed under concurrency (got ${allowedCount})`);
  assert(blockedCount === 10, `Remaining 10 concurrent requests cleanly rejected (got ${blockedCount})`);

  // Verify consumeRateLimit interface returns accurate counts and retryAfter
  const consumeBlocked = await storage.rateLimits.consumeRateLimit(testKey, action, limit, windowSec);
  assert(consumeBlocked.allowed === false, 'consumeRateLimit reports allowed: false when quota exhausted');
  assert(consumeBlocked.retryAfter > 0 && consumeBlocked.retryAfter <= windowSec, `Valid retryAfter computed (${consumeBlocked.retryAfter}s)`);

  // Verify root storage and passwordReset delegations
  const rootAllowed = await storage.checkRateLimit(`test_root_${Date.now()}`, 'root_action', 1, 60);
  assert(rootAllowed === true, 'Root storage.checkRateLimit() interface is functional');

  const pwResetAllowed = await storage.passwordReset.checkRateLimit(`test_pw_${Date.now()}`, 'pw_action', 1, 60);
  assert(pwResetAllowed === true, 'storage.passwordReset.checkRateLimit() backward compatibility preserved');

  // ---------------------------------------------------------
  // 2. Test Database Isolation & Exact Prefix Cleanup
  // ---------------------------------------------------------
  console.log('\n[2. Test Database Isolation & Exact Prefix Cleanup]');

  // Test 2.1: Enforce Test Database Isolation Regression Proofs
  const mockEnv1: NodeJS.ProcessEnv = {};
  const res1 = enforceTestDatabaseIsolation(mockEnv1);
  assert(
    res1.resolvedPath === getDefaultTestDatabasePath() && mockEnv1.DATABASE_PATH === getDefaultTestDatabasePath(),
    'Unset DATABASE_PATH safely establishes default isolated test database'
  );

  const mockEnv2: NodeJS.ProcessEnv = { DATABASE_PATH: 'data/videorisk.db' };
  let caughtConflictingDb = false;
  try {
    enforceTestDatabaseIsolation(mockEnv2);
  } catch (err: any) {
    caughtConflictingDb = err.message.includes('Conflicting DATABASE_PATH detected');
  }
  assert(caughtConflictingDb, 'Conflicting external DATABASE_PATH fails safely with clear error');

  const customTestDb = path.resolve(os.tmpdir(), `custom_test_${Date.now()}.db`);
  const mockEnv3: NodeJS.ProcessEnv = { TEST_DATABASE_PATH: customTestDb };
  const res3 = enforceTestDatabaseIsolation(mockEnv3);
  assert(
    res3.resolvedPath === customTestDb && mockEnv3.DATABASE_PATH === customTestDb,
    'Supported explicit TEST_DATABASE_PATH override is honored'
  );

  const mockEnv4: NodeJS.ProcessEnv = { TEST_DATABASE_PATH: 'data/videorisk.db' };
  let caughtProdOverride = false;
  try {
    enforceTestDatabaseIsolation(mockEnv4);
  } catch (err: any) {
    caughtProdOverride = err.message.includes('Refusing to use database path');
  }
  assert(caughtProdOverride, 'Refuses to use production database path as TEST_DATABASE_PATH');

  const mockEnv5: NodeJS.ProcessEnv = {
    TEST_DATABASE_PATH: customTestDb,
    DATABASE_PATH: '/different/path.db'
  };
  let caughtConflictWithTest = false;
  try {
    enforceTestDatabaseIsolation(mockEnv5);
  } catch (err: any) {
    caughtConflictWithTest = err.message.includes('conflicts with explicit TEST_DATABASE_PATH');
  }
  assert(caughtConflictWithTest, 'Conflicting DATABASE_PATH with explicit TEST_DATABASE_PATH throws error');

  // Verify storage database path is NOT production
  const activeStoragePath = (storage as any).dbPath || '';
  const prodPath = getProductionDatabasePath();
  assert(
    path.resolve(activeStoragePath) !== prodPath && path.basename(activeStoragePath) !== 'videorisk.db',
    `Verified active test database (${activeStoragePath}) is isolated from production`
  );

  // Symlink Regression Hardening Tests
  const symlinkTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-symlink-isolation-'));
  try {
    // 1. Test database path that is a symlink to production database
    const dummyProdDir = path.join(symlinkTempDir, 'prod_dir');
    fs.mkdirSync(dummyProdDir, { recursive: true });
    const dummyProdDb = path.join(dummyProdDir, 'videorisk.db');
    const initialProdContent = 'PRODUCTION_DATA_INTEGRITY_MARKER_' + Date.now();
    fs.writeFileSync(dummyProdDb, initialProdContent, 'utf8');

    const envWithCustomDataDir: NodeJS.ProcessEnv = { DATA_DIR: dummyProdDir };
    const symlinkToProd = path.join(symlinkTempDir, 'symlink_to_prod.db');
    fs.symlinkSync(dummyProdDb, symlinkToProd);

    // Verify validateTestDatabaseTarget catches symlink and throws before connection opens
    let caughtSymlinkToProd = false;
    try {
      validateTestDatabaseTarget(symlinkToProd, envWithCustomDataDir);
    } catch (err: any) {
      caughtSymlinkToProd = err.message.includes('matches production database');
    }
    assert(caughtSymlinkToProd, 'Validation detects and rejects test database path that is a symlink to production');

    // Verify pre-open check in SqliteStorageRepository blocks connection before open
    let caughtRepoOpen = false;
    try {
      new SqliteStorageRepository(symlinkToProd);
    } catch (err: any) {
      caughtRepoOpen = err.message.includes('matches production database') || err.message.includes('Refusing to use database path');
    }
    assert(caughtRepoOpen, 'SqliteStorageRepository pre-open check blocks initialization on symlink to production');

    // Verify production database contents remained completely unchanged
    const afterCheckContent = fs.readFileSync(dummyProdDb, 'utf8');
    assert(afterCheckContent === initialProdContent, 'Production database contents remain completely intact after rejected symlink access');

    // 2. Default test database replaced with a symlink to production
    const symlinkAsDefaultTest = path.join(symlinkTempDir, 'videorisk_test.db');
    fs.symlinkSync(dummyProdDb, symlinkAsDefaultTest);
    let caughtDefaultSymlink = false;
    try {
      validateTestDatabaseTarget(symlinkAsDefaultTest, envWithCustomDataDir);
    } catch (err: any) {
      caughtDefaultSymlink = err.message.includes('matches production database');
    }
    assert(caughtDefaultSymlink, 'Rejection enforced when default test path is replaced with a symlink to production');

    // 3. Production paths configured through DATA_DIR
    let caughtDataDirProd = false;
    try {
      validateTestDatabaseTarget(dummyProdDb, envWithCustomDataDir);
    } catch (err: any) {
      caughtDataDirProd = err.message.includes('matches production database') || err.message.includes('production database name');
    }
    assert(caughtDataDirProd, 'Production paths configured through DATA_DIR are strictly protected');

    // 4. Existing database files vs not-yet-created database files
    const nonExistentDb = path.join(symlinkTempDir, 'not_yet_created.db');
    const validatedNonExistent = validateTestDatabaseTarget(nonExistentDb, envWithCustomDataDir);
    assert(validatedNonExistent === nonExistentDb, 'Not-yet-created database file in valid directory validates successfully');

    const existingValidDb = path.join(symlinkTempDir, 'existing_valid.db');
    fs.writeFileSync(existingValidDb, 'TEST_DATA');
    const validatedExisting = validateTestDatabaseTarget(existingValidDb, envWithCustomDataDir);
    assert(validatedExisting === existingValidDb, 'Existing valid test database file validates successfully');

    // 5. Unsafe or unresolvable parent directory
    const unresolvableDb = path.join(symlinkTempDir, 'non_existent_subdir_xyz', 'test.db');
    let caughtUnresolvable = false;
    try {
      validateTestDatabaseTarget(unresolvableDb, envWithCustomDataDir);
    } catch (err: any) {
      caughtUnresolvable = err.message.includes('does not exist or is unresolvable');
    }
    assert(caughtUnresolvable, 'Unsafe or unresolvable parent directories fail closed safely');
  } finally {
    fs.rmSync(symlinkTempDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Custom DATABASE_PATH Production Isolation & Symlink Regression Suite
  // (Tests Cases 1 to 13: Custom paths, direct symlinks, parent symlinks,
  // storage precedence, data integrity, and test override compatibility)
  // -------------------------------------------------------------------------
  const customProdTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-custom-prod-isolation-'));
  try {
    const realProdDir = path.join(customProdTempDir, 'storage');
    fs.mkdirSync(realProdDir, { recursive: true });
    const customProdFile = path.join(realProdDir, 'live.sqlite');
    const initialCustomBytes = Buffer.from('LIVE_PRODUCTION_SQLITE_HEADER_AND_RECORDS_' + Date.now());
    fs.writeFileSync(customProdFile, initialCustomBytes);

    const customProdEnv: NodeJS.ProcessEnv = {
      DATABASE_PATH: customProdFile
    };

    // Case 1: Custom production DATABASE_PATH (storage/live.sqlite) is recognized as production target
    assert(
      getProductionDatabasePath(customProdEnv) === path.resolve(customProdFile),
      'Custom production DATABASE_PATH (storage/live.sqlite) is recognized as production target path'
    );
    assert(
      isTargetingProduction(customProdFile, customProdEnv) === true,
      'isTargetingProduction recognizes custom production DATABASE_PATH'
    );
    assert(
      getProductionCanonicalTargets(customProdEnv).includes(canonicalizeDatabaseTarget(customProdFile)),
      'getProductionCanonicalTargets includes canonical custom production target'
    );

    // Case 2: Test database path that is a symlink directly to custom production database is rejected
    const directSymlinkTestDb = path.join(customProdTempDir, 'direct_symlink_test.sqlite');
    fs.symlinkSync(customProdFile, directSymlinkTestDb);

    let caughtDirectSymlink = false;
    try {
      validateTestDatabaseTarget(directSymlinkTestDb, customProdEnv);
    } catch (err: any) {
      caughtDirectSymlink = err.message.includes('matches production database');
    }
    assert(caughtDirectSymlink, 'Direct symlink to custom production database is strictly rejected');

    // Verify pre-open check blocks initialization before SQLite opens with customProdEnv
    let caughtDirectOpen = false;
    try {
      new SqliteStorageRepository(directSymlinkTestDb, customProdEnv);
    } catch (err: any) {
      caughtDirectOpen = err.message.includes('matches production database') || err.message.includes('Refusing to use database path');
    }
    assert(caughtDirectOpen, 'Pre-open check blocks SqliteStorageRepository initialization on symlink to custom production');

    // Also verify pre-open check blocks initialization when custom production is preserved globally
    setPreservedProductionDatabasePath(customProdFile);
    let caughtPreservedOpen = false;
    try {
      new SqliteStorageRepository(directSymlinkTestDb);
    } catch (err: any) {
      caughtPreservedOpen = err.message.includes('matches production database') || err.message.includes('Refusing to use database path');
    }
    assert(caughtPreservedOpen, 'Pre-open check blocks SqliteStorageRepository when custom production path is preserved globally');
    setPreservedProductionDatabasePath(undefined); // clean up

    // Assert production bytes remain completely untouched
    const currentBytesCase2 = fs.readFileSync(customProdFile);
    assert(
      Buffer.compare(currentBytesCase2, initialCustomBytes) === 0,
      'Data Integrity: Custom production database bytes remain strictly unchanged after rejected symlink access'
    );

    // Case 3: Test database path reaching custom production database through a symlinked parent directory is rejected
    const symlinkedParentDir = path.join(customProdTempDir, 'symlinked_parent');
    fs.symlinkSync(realProdDir, symlinkedParentDir);
    const testDbViaSymlinkedParent = path.join(symlinkedParentDir, 'live.sqlite');

    let caughtParentSymlink = false;
    try {
      validateTestDatabaseTarget(testDbViaSymlinkedParent, customProdEnv);
    } catch (err: any) {
      caughtParentSymlink = err.message.includes('matches production database');
    }
    assert(caughtParentSymlink, 'Test database path through symlinked parent directory to custom production is rejected');

    let caughtParentOpen = false;
    try {
      new SqliteStorageRepository(testDbViaSymlinkedParent, customProdEnv);
    } catch (err: any) {
      caughtParentOpen = err.message.includes('matches production database') || err.message.includes('Refusing to use database path');
    }
    assert(caughtParentOpen, 'SqliteStorageRepository pre-open check blocks access via symlinked parent directory');
    const currentBytesCase3 = fs.readFileSync(customProdFile);
    assert(
      Buffer.compare(currentBytesCase3, initialCustomBytes) === 0,
      'Data Integrity: Custom production database bytes remain unchanged after rejected parent symlink access'
    );

    // Case 4: Existing production path behavior using DATA_DIR remains protected
    const dataDirEnv: NodeJS.ProcessEnv = { DATA_DIR: realProdDir };
    assert(
      getProductionDatabasePath(dataDirEnv) === path.resolve(realProdDir, DEFAULT_PRODUCTION_DB_BASENAME),
      'DATA_DIR precedence honored for production database path'
    );
    assert(
      isTargetingProduction(path.join(realProdDir, DEFAULT_PRODUCTION_DB_BASENAME), dataDirEnv) === true,
      'DATA_DIR/videorisk.db target is strictly protected'
    );

    // Case 5: Default production path data/videorisk.db remains protected
    const defaultProdTarget = path.resolve(process.cwd(), 'data', DEFAULT_PRODUCTION_DB_BASENAME);
    assert(
      isTargetingProduction(defaultProdTarget, {}) === true,
      'Default production target cwd/data/videorisk.db is always protected'
    );

    // Case 6: Relative and absolute paths handled consistently after canonicalization
    const relativeCustomProd = path.relative(process.cwd(), customProdFile);
    const relEnv: NodeJS.ProcessEnv = { DATABASE_PATH: relativeCustomProd };
    assert(
      isTargetingProduction(customProdFile, relEnv) === true,
      'Absolute path targets relative custom production configuration'
    );
    assert(
      isTargetingProduction(relativeCustomProd, customProdEnv) === true,
      'Relative path targets absolute custom production configuration'
    );
    const redundantRelPath = path.join(realProdDir, '..', 'storage', 'live.sqlite');
    assert(
      isTargetingProduction(redundantRelPath, customProdEnv) === true,
      'Normalized relative/redundant path targets custom production configuration'
    );

    // Case 7: Nonexistent database target is resolved safely when parent directory can be canonicalized
    const nonExistentTarget = path.join(customProdTempDir, 'non_existent_test_db.sqlite');
    assert(!fs.existsSync(nonExistentTarget), 'Target file does not exist yet');
    const resolvedNonExistent = canonicalizeDatabaseTarget(nonExistentTarget);
    assert(
      resolvedNonExistent === nonExistentTarget,
      'Nonexistent database target resolved safely via canonical parent directory'
    );
    assert(!fs.existsSync(nonExistentTarget), 'Verification: canonicalizeDatabaseTarget did NOT create nonexistent file');

    // Case 8: Broken symlink handled safely and cannot bypass production target protection
    const brokenSymlinkProd = path.join(customProdTempDir, 'broken_symlink_to_nonexistent_prod.sqlite');
    const nonExistentProdTarget = path.join(realProdDir, 'non_existent_live.sqlite');
    fs.symlinkSync(nonExistentProdTarget, brokenSymlinkProd);
    const brokenProdEnv: NodeJS.ProcessEnv = { DATABASE_PATH: nonExistentProdTarget };

    let caughtBrokenSymlink = false;
    try {
      validateTestDatabaseTarget(brokenSymlinkProd, brokenProdEnv);
    } catch (err: any) {
      caughtBrokenSymlink = err.message.includes('matches production database') || err.message.includes('Cannot safely canonicalize');
    }
    assert(caughtBrokenSymlink, 'Broken symlink pointing to production target is safely rejected');

    // Broken symlink to nonexistent unresolvable directory fails closed
    const brokenSymlinkUnresolvable = path.join(customProdTempDir, 'broken_symlink_unresolvable.sqlite');
    fs.symlinkSync('/non_existent_unresolvable_dir_xyz/missing.db', brokenSymlinkUnresolvable);
    let caughtUnresolvableBroken = false;
    try {
      validateTestDatabaseTarget(brokenSymlinkUnresolvable, {});
    } catch (err: any) {
      caughtUnresolvableBroken = err.message.includes('does not exist or is unresolvable');
    }
    assert(caughtUnresolvableBroken, 'Broken symlink to unresolvable parent directory fails closed safely');

    // Case 9: Symlink cycles, excessive depth fail closed
    const cycleA = path.join(customProdTempDir, 'cycle_a.db');
    const cycleB = path.join(customProdTempDir, 'cycle_b.db');
    fs.symlinkSync(cycleB, cycleA);
    fs.symlinkSync(cycleA, cycleB);

    let caughtCycle = false;
    try {
      validateTestDatabaseTarget(cycleA, {});
    } catch (err: any) {
      caughtCycle = err.message.includes('Detected symlink cycle or excessive link depth');
    }
    assert(caughtCycle, 'Symlink cycle fails closed safely with cycle detection error');

    // Case 10: Any rejected configuration fails before SQLite opens the database
    let rejectedPreOpenFailed = false;
    try {
      new SqliteStorageRepository(cycleA);
    } catch (err: any) {
      rejectedPreOpenFailed = err.message.includes('symlink cycle');
    }
    assert(rejectedPreOpenFailed, 'Rejected cycle configuration fails before SQLite opens the database');

    // Case 11: Test runner's test-specific DATABASE_PATH override is not incorrectly treated as original production configuration
    const testRunnerOverrideEnv: NodeJS.ProcessEnv = {
      DATABASE_PATH: 'data/videorisk_test.db'
    };
    assert(
      isTestDatabasePath('data/videorisk_test.db', testRunnerOverrideEnv) === true,
      'data/videorisk_test.db is recognized as test database path'
    );
    assert(
      getProductionDatabasePath(testRunnerOverrideEnv) === path.resolve(process.cwd(), 'data', 'videorisk.db'),
      'Test runner DATABASE_PATH override is NOT classified as production database'
    );
    assert(
      isTargetingProduction('data/videorisk_test.db', testRunnerOverrideEnv) === false,
      'data/videorisk_test.db is NOT flagged as targeting production'
    );

    // Custom TEST_DATABASE_PATH override
    const customTestRunnerEnv: NodeJS.ProcessEnv = {
      TEST_DATABASE_PATH: '/tmp/test_runner_override.db',
      DATABASE_PATH: '/tmp/test_runner_override.db'
    };
    assert(
      isTestDatabasePath('/tmp/test_runner_override.db', customTestRunnerEnv) === true,
      'Explicit TEST_DATABASE_PATH override is recognized as test database'
    );
    assert(
      getProductionDatabasePath(customTestRunnerEnv) === path.resolve(process.cwd(), 'data', 'videorisk.db'),
      'Explicit TEST_DATABASE_PATH is NOT treated as production database path'
    );

    // Case 12: Valid explicitly configured TEST_DATABASE_PATH continues to work
    const validTestDbTarget = path.join(customProdTempDir, 'valid_isolated_test.db');
    const validTestEnv: NodeJS.ProcessEnv = {
      TEST_DATABASE_PATH: validTestDbTarget
    };
    const validResolution = enforceTestDatabaseIsolation(validTestEnv);
    assert(
      validResolution.resolvedPath === validTestDbTarget && validResolution.isCustom === true,
      'Valid explicitly configured TEST_DATABASE_PATH is successfully validated and enforced'
    );

    // Final Data Integrity check: Production database bytes remained 100% identical throughout all tests
    const finalBytes = fs.readFileSync(customProdFile);
    assert(
      Buffer.compare(finalBytes, initialCustomBytes) === 0,
      'Comprehensive Data Integrity: Production database bytes remained 100% untouched throughout all isolation tests'
    );
  } finally {
    fs.rmSync(customProdTempDir, { recursive: true, force: true });
  }

  // Test 2.2: Exact Rate-Limit Prefix Cleanup (Literal vs SQL LIKE Wildcards)
  const exactKey = `test_exact_${Date.now()}`;
  const likeKey1 = `testX_customer_${Date.now()}`; // Underscore wildcard trap
  const likeKey2 = `test%special_${Date.now()}`;    // Percent wildcard trap
  const prodRecordKey = `prod_customer_${Date.now()}`;
  const unrelatedIpKey = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;

  await storage.rateLimits.checkRateLimit(exactKey, 'test_action', 10, 3600);
  await storage.rateLimits.checkRateLimit(likeKey1, 'test_action', 10, 3600);
  await storage.rateLimits.checkRateLimit(likeKey2, 'test_action', 10, 3600);
  await storage.rateLimits.checkRateLimit(prodRecordKey, 'customer_action', 10, 3600);
  await storage.rateLimits.checkRateLimit(unrelatedIpKey, 'ip_action', 10, 3600);

  // Run targeted prefix cleanup with literal prefix 'test_'
  await storage.rateLimits.clearRateLimits?.({ keyPrefix: 'test_' });

  const exactCheck = await storage.rateLimits.consumeRateLimit(exactKey, 'test_action', 10, 3600);
  const like1Check = await storage.rateLimits.consumeRateLimit(likeKey1, 'test_action', 10, 3600);
  const prodCheck = await storage.rateLimits.consumeRateLimit(prodRecordKey, 'customer_action', 10, 3600);
  const unrelatedCheck = await storage.rateLimits.consumeRateLimit(unrelatedIpKey, 'ip_action', 10, 3600);

  assert(exactCheck.count === 1, "Literal match 'test_exact' was deleted by cleanup (count reset)");
  assert(like1Check.count === 2, "Wildcard lookalike 'testX_customer' was NOT deleted by 'test_' prefix");
  assert(prodCheck.count === 2, 'Unrelated production record was NOT deleted by test cleanup');
  assert(unrelatedCheck.count === 2, 'Unrelated IP rate-limit record was NOT deleted by test cleanup');

  // Verify clearTestRateLimits literal prefix behavior on SQLite
  await storage.rateLimits.clearTestRateLimits?.('test%');
  const like2Check = await storage.rateLimits.consumeRateLimit(likeKey2, 'test_action', 10, 3600);
  assert(like2Check.count === 1, "clearTestRateLimits with literal 'test%' deleted only literal percent match");

  // Verify exact prefix cleanup on InMemoryStorageRepository consistency
  const inMemory = new InMemoryStorageRepository();
  const memExactKey = `test_mem_${Date.now()}`;
  const memLikeKey = `testX_mem_${Date.now()}`;
  const memProdKey = `prod_mem_${Date.now()}`;
  await inMemory.rateLimits.checkRateLimit(memExactKey, 'action', 5, 60);
  await inMemory.rateLimits.checkRateLimit(memLikeKey, 'action', 5, 60);
  await inMemory.rateLimits.checkRateLimit(memProdKey, 'action', 5, 60);
  await inMemory.rateLimits.clearRateLimits?.({ keyPrefix: 'test_' });

  const mem1Check = await inMemory.rateLimits.consumeRateLimit(memExactKey, 'action', 5, 60);
  const mem2Check = await inMemory.rateLimits.consumeRateLimit(memLikeKey, 'action', 5, 60);
  const mem3Check = await inMemory.rateLimits.consumeRateLimit(memProdKey, 'action', 5, 60);
  assert(mem1Check.count === 1, 'InMemoryStorage: Literal prefix match was cleanly removed');
  assert(mem2Check.count === 2, 'InMemoryStorage: Wildcard lookalike was NOT removed');
  assert(mem3Check.count === 2, 'InMemoryStorage: Unrelated record was preserved');

  // Verify production safety gate: unconstrained clear in production throws error
  const origNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    let threw = false;
    try {
      await storage.rateLimits.clearRateLimits?.();
    } catch {
      threw = true;
    }
    assert(threw === true, 'Unscoped clearRateLimits() is strictly rejected in production environment');
  } finally {
    process.env.NODE_ENV = origNodeEnv;
  }

  // ---------------------------------------------------------
  // 3. Environment Variable Parsing Safety & Precedence
  // ---------------------------------------------------------
  console.log('\n[3. Environment Variable Precedence & Safety]');

  // Test parseStrictPositiveInt and parsePositiveInt
  assert(parseStrictPositiveInt('10') === 10, '"10" -> accepted as 10');
  assert(parseStrictPositiveInt(' 10 ') === 10, '" 10 " -> accepted as 10 after trimming');
  assert(parseStrictPositiveInt('1.5') === null, '"1.5" -> rejected (decimal)');
  assert(parseStrictPositiveInt('10abc') === null, '"10abc" -> rejected (trailing characters)');
  assert(parseStrictPositiveInt('0') === null, '"0" -> rejected (zero is not positive)');
  assert(parseStrictPositiveInt('-1') === null, '"-1" -> rejected (negative)');
  assert(parseStrictPositiveInt('Infinity') === null, '"Infinity" -> rejected');
  assert(parseStrictPositiveInt('') === null, 'Empty string -> rejected');
  assert(parseStrictPositiveInt('   ') === null, 'Whitespace-only string -> rejected');
  assert(parseStrictPositiveInt('9007199254740992') === null, 'Value larger than MAX_SAFE_INTEGER -> rejected');
  assert(parseStrictPositiveInt('999999999999999999999999') === null, 'Huge numeric string -> rejected');
  assert(parseStrictPositiveInt(undefined) === null, 'undefined -> rejected (returns null)');

  // parsePositiveInt fallback to default
  assert(parsePositiveInt('15', 10) === 15, 'Valid string parsed as positive integer');
  assert(parsePositiveInt(undefined, 10) === 10, 'Undefined falls back to safe default');
  assert(parsePositiveInt('invalid', 10) === 10, 'NaN string falls back to safe default');
  assert(parsePositiveInt('-5', 10) === 10, 'Negative integer falls back to safe default');
  assert(parsePositiveInt('0', 10) === 10, 'Zero integer falls back to safe default');
  assert(parsePositiveInt('1.5', 10) === 10, 'Decimal string falls back to safe default');
  assert(parsePositiveInt('10abc', 10) === 10, 'Partially numeric string falls back to safe default');

  // Test resolveRateLimitInt unambiguous precedence:
  // 1. Valid primary plus valid legacy fallback -> primary value used
  assert(resolveRateLimitInt('20', '10', 5) === 20, 'Valid primary plus valid legacy fallback -> primary value used');
  // 2. Invalid primary plus valid legacy fallback -> legacy value used
  assert(resolveRateLimitInt('1.5', '10', 5) === 10, 'Invalid primary ("1.5") plus valid legacy fallback -> legacy value used');
  assert(resolveRateLimitInt('0', '10', 5) === 10, 'Invalid primary ("0") plus valid legacy fallback -> legacy value used');
  assert(resolveRateLimitInt('-1', '10', 5) === 10, 'Invalid primary ("-1") plus valid legacy fallback -> legacy value used');
  assert(resolveRateLimitInt('10abc', '10', 5) === 10, 'Invalid primary ("10abc") plus valid legacy fallback -> legacy value used');
  assert(resolveRateLimitInt('Infinity', '10', 5) === 10, 'Invalid primary ("Infinity") plus valid legacy fallback -> legacy value used');
  assert(resolveRateLimitInt('', '10', 5) === 10, 'Empty primary plus valid legacy fallback -> legacy value used');
  assert(resolveRateLimitInt(undefined, '10', 5) === 10, 'Undefined primary plus valid legacy fallback -> legacy value used');
  // 3. Invalid primary and invalid legacy fallback -> existing secure default used
  assert(resolveRateLimitInt('1.5', '10abc', 20) === 20, 'Invalid primary and invalid legacy fallback -> secure default used');
  assert(resolveRateLimitInt('0', '0', 20) === 20, 'Zero primary and zero legacy fallback -> secure default used');
  assert(resolveRateLimitInt('-5', 'invalid', 20) === 20, 'Negative primary and invalid legacy fallback -> secure default used');
  assert(resolveRateLimitInt(undefined, undefined, 20) === 20, 'Undefined primary and undefined legacy fallback -> secure default used');
  assert(resolveRateLimitInt('  30  ', undefined, 20) === 30, 'Trimmed positive integer parsed correctly');

  // ---------------------------------------------------------
  // 4. Express App Setup with Trust Proxy Configuration
  // ---------------------------------------------------------
  console.log('\n[4. Express App Setup & Trusted Proxy Validation]');

  // Positive hop counts
  const proxyAppHop1 = express();
  configureTrustProxy(proxyAppHop1, '1');
  assert(proxyAppHop1.get('trust proxy') === 1, 'Positive hop count "1" configures 1 hop');

  const proxyAppHop2 = express();
  configureTrustProxy(proxyAppHop2, ' 2 ');
  assert(proxyAppHop2.get('trust proxy') === 2, 'Trimmed positive hop count " 2 " configures 2 hops');

  // Supported proxy keywords
  const proxyAppLoopback = express();
  configureTrustProxy(proxyAppLoopback, 'loopback');
  assert(proxyAppLoopback.get('trust proxy') === 'loopback', 'Keyword "loopback" is accepted');

  const proxyAppLinklocal = express();
  configureTrustProxy(proxyAppLinklocal, 'linklocal');
  assert(proxyAppLinklocal.get('trust proxy') === 'linklocal', 'Keyword "linklocal" is accepted');

  const proxyAppUniquelocal = express();
  configureTrustProxy(proxyAppUniquelocal, 'uniquelocal');
  assert(proxyAppUniquelocal.get('trust proxy') === 'uniquelocal', 'Keyword "uniquelocal" is accepted');

  // Valid IPv4, IPv6, and CIDRs
  const proxyAppIp = express();
  configureTrustProxy(proxyAppIp, '192.168.1.1, 10.0.0.0/8, ::1, 2001:db8::/32');
  assert(
    proxyAppIp.get('trust proxy') === '192.168.1.1, 10.0.0.0/8, ::1, 2001:db8::/32',
    'Valid IPv4, IPv6, and CIDR list is accepted'
  );

  // Malformed and rejected examples -> must fail closed to false
  const proxyTestCases: Array<{ label: string; val: any }> = [
    { label: 'Malformed IPv4 (999.999.999.999)', val: '999.999.999.999' },
    { label: 'Malformed CIDR prefix (10.0.0.1/99)', val: '10.0.0.1/99' },
    { label: 'Malformed IPv6 string (fe80:::1)', val: 'fe80:::1' },
    { label: 'Invalid IPv4 prefix length (10.0.0.1/-1)', val: '10.0.0.1/-1' },
    { label: 'Invalid IPv4 prefix length (10.0.0.1/33)', val: '10.0.0.1/33' },
    { label: 'Invalid IPv6 prefix length (2001:db8::/129)', val: '2001:db8::/129' },
    { label: 'Zero hop count ("0")', val: '0' },
    { label: 'Negative hop count ("-1")', val: '-1' },
    { label: 'Decimal hop count ("1.5")', val: '1.5' },
    { label: 'Malformed hop count ("10abc")', val: '10abc' },
    { label: 'Empty configuration ("")', val: '' },
    { label: 'Whitespace configuration ("   ")', val: '   ' },
    { label: 'Undefined configuration', val: undefined },
    { label: 'Arbitrary string ("malformed-value-xyz")', val: 'malformed-value-xyz' },
    { label: 'Explicit "false"', val: 'false' }
  ];

  for (const tc of proxyTestCases) {
    const testApp = express();
    configureTrustProxy(testApp, tc.val);
    assert(testApp.get('trust proxy') === false, `${tc.label} fails closed to false`);
  }

  // Explicit unrestricted "true" - verify warning and configuration
  const proxyAppTrue = express();
  const warningState = { captured: false };
  const origWarn = console.warn;
  console.warn = (...args: any[]) => {
    if (args.some(a => String(a).includes('TRUST_PROXY is set to unrestricted "true"'))) {
      warningState.captured = true;
    }
    origWarn(...args);
  };
  try {
    configureTrustProxy(proxyAppTrue, 'true');
    assert(proxyAppTrue.get('trust proxy') === true, 'Explicit "true" sets trust proxy to true');
    assert(warningState.captured === true, 'Explicit "true" logs security warning');
  } finally {
    console.warn = origWarn;
  }

  const app = express();
  app.set('trust proxy', true); // Trust proxy enabled in test harness to evaluate simulated client IPs
  app.use(express.json());
  app.use('/api', apiRouter);

  const server: Server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // ---------------------------------------------------------
    // 5. Login Rate Limiting (IP-Based Brute-Force Protection)
    // ---------------------------------------------------------
    console.log('\n[5. Login IP-Based Brute-Force Protection]');

    const originalLoginLimit = process.env.AUTH_LOGIN_RATE_LIMIT;
    const originalLoginWindow = process.env.AUTH_LOGIN_RATE_WINDOW;
    const originalLoginIpLimit = process.env.AUTH_LOGIN_IP_RATE_LIMIT;
    process.env.AUTH_LOGIN_RATE_LIMIT = '3';
    process.env.AUTH_LOGIN_RATE_WINDOW = '60';

    const loginAttackerIp = `192.0.2.${Math.floor(Math.random() * 200) + 10}`;

    // Attempt 1-3 from attacker IP
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': loginAttackerIp },
        body: JSON.stringify({ email: `target_${Date.now()}_${i}@videorisk.com`, password: `wrong_${i}` })
      });
      assert(res.status === 401 || res.status === 400, `Login attempt ${i} reaches auth check (HTTP ${res.status})`);
    }

    // Attempt 4 from same IP must be rejected with HTTP 429 and Retry-After header
    const blockedLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': loginAttackerIp },
      body: JSON.stringify({ email: `target_${Date.now()}_4@videorisk.com`, password: 'wrong_password' })
    });
    assert(blockedLoginRes.status === 429, 'Attempt 4 triggers HTTP 429 Too Many Requests');
    const retryAfterIp = blockedLoginRes.headers.get('Retry-After');
    assert(!!retryAfterIp && parseInt(retryAfterIp, 10) > 0, `Retry-After header present and positive (${retryAfterIp}s)`);
    const blockedLoginBody = await blockedLoginRes.json();
    assert(blockedLoginBody.error.includes('Too many login attempts'), 'Returns informative rate-limit message');

    // Attempt from a distinct IP must NOT be blocked
    const cleanIp = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;
    const cleanLoginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': cleanIp },
      body: JSON.stringify({ email: `other_${Date.now()}@videorisk.com`, password: 'wrong_password' })
    });
    assert(cleanLoginRes.status === 401, 'Unrelated client IP is NOT blocked (IP rate limit isolation verified)');

    // Restore login env vars
    if (originalLoginLimit !== undefined) process.env.AUTH_LOGIN_RATE_LIMIT = originalLoginLimit;
    else delete process.env.AUTH_LOGIN_RATE_LIMIT;
    if (originalLoginWindow !== undefined) process.env.AUTH_LOGIN_RATE_WINDOW = originalLoginWindow;
    else delete process.env.AUTH_LOGIN_RATE_WINDOW;
    if (originalLoginIpLimit !== undefined) process.env.AUTH_LOGIN_IP_RATE_LIMIT = originalLoginIpLimit;
    else delete process.env.AUTH_LOGIN_IP_RATE_LIMIT;

    // ---------------------------------------------------------
    // 6. Login Rate Limiting (Account Identifier Distributed Protection)
    // ---------------------------------------------------------
    console.log('\n[6. Login Account Identifier Distributed Protection]');

    const originalAcctLimit = process.env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT;
    const originalAcctWindow = process.env.AUTH_LOGIN_ACCOUNT_RATE_WINDOW;
    process.env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT = '2';
    process.env.AUTH_LOGIN_ACCOUNT_RATE_WINDOW = '60';

    const targetAccount = `victim_${Date.now()}@videorisk.com`;

    // Attempt 1: from IP 1
    const ip1 = `192.0.2.11`;
    const res1 = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip1 },
      body: JSON.stringify({ email: targetAccount, password: 'wrong_password_1' })
    });
    assert(res1.status === 401, 'Account attack from IP 1 reaches auth check (HTTP 401)');

    // Attempt 2: from IP 2 (different IP targeting same account, uppercase/padded email to test normalization)
    const ip2 = `192.0.2.22`;
    const res2 = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip2 },
      body: JSON.stringify({ email: `  ${targetAccount.toUpperCase()}  `, password: 'wrong_password_2' })
    });
    assert(res2.status === 401, 'Normalized account attack from IP 2 reaches auth check (HTTP 401)');

    // Attempt 3: from IP 3 (different IP targeting same account -> should be blocked by account quota of 2)
    const ip3 = `192.0.2.33`;
    const res3 = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip3 },
      body: JSON.stringify({ email: targetAccount, password: 'wrong_password_3' })
    });
    assert(res3.status === 429, 'Distributed attack from IP 3 blocked by account quota with HTTP 429');
    const retryAfterAcct = res3.headers.get('Retry-After');
    assert(!!retryAfterAcct && parseInt(retryAfterAcct, 10) > 0, `Account block includes valid Retry-After (${retryAfterAcct}s)`);

    // Independent account from IP 3 must NOT be blocked (account limit isolation)
    const resDifferentAcct = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip3 },
      body: JSON.stringify({ email: `independent_${Date.now()}@videorisk.com`, password: 'wrong_password' })
    });
    assert(resDifferentAcct.status === 401, 'Different account from IP 3 is NOT blocked by victim account limit');

    // Restore account env vars
    if (originalAcctLimit !== undefined) process.env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT = originalAcctLimit;
    else delete process.env.AUTH_LOGIN_ACCOUNT_RATE_LIMIT;
    if (originalAcctWindow !== undefined) process.env.AUTH_LOGIN_ACCOUNT_RATE_WINDOW = originalAcctWindow;
    else delete process.env.AUTH_LOGIN_ACCOUNT_RATE_WINDOW;

    // ---------------------------------------------------------
    // 7. Malformed Request & Generic Credential Security
    // ---------------------------------------------------------
    console.log('\n[7. Malformed Request & Generic Credential Security]');

    const malformedRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 12345 }) // malformed payload
    });
    assert(malformedRes.status === 400, 'Malformed login request returns HTTP 400 Bad Request');

    const unknownAccountRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `nonexistent_${Date.now()}@videorisk.com`, password: 'anyPassword123' })
    });
    const unknownBody = await unknownAccountRes.json();
    assert(unknownAccountRes.status === 401, 'Non-existent account returns generic 401 Unauthorized');
    assert(unknownBody.error === 'Invalid email or password.', 'Generic error does not reveal account existence');

    // ---------------------------------------------------------
    // 8. Registration Rate Limiting & Retry-After
    // ---------------------------------------------------------
    console.log('\n[8. Registration Rate Limiting & Retry-After]');

    const originalRegLimit = process.env.AUTH_REGISTER_RATE_LIMIT;
    const originalRegWindow = process.env.AUTH_REGISTER_RATE_WINDOW;
    process.env.AUTH_REGISTER_RATE_LIMIT = '2';
    process.env.AUTH_REGISTER_RATE_WINDOW = '60';

    const regSpammerIp = `203.0.113.${Math.floor(Math.random() * 200) + 10}`;

    // Registration 1 & 2 succeed
    for (let i = 1; i <= 2; i++) {
      const regRes = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': regSpammerIp },
        body: JSON.stringify({ email: `spammer_${Date.now()}_${i}@videorisk.com`, password: 'strongPassword123' })
      });
      assert(regRes.status === 201, `Registration ${i} succeeded with 201 Created`);
    }

    // Registration 3 from same IP must be rate-limited
    const blockedRegRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': regSpammerIp },
      body: JSON.stringify({ email: `spammer_blocked_${Date.now()}@videorisk.com`, password: 'strongPassword123' })
    });
    assert(blockedRegRes.status === 429, 'Registration 3 blocked with HTTP 429 Too Many Requests');
    const retryAfterReg = blockedRegRes.headers.get('Retry-After');
    assert(!!retryAfterReg && parseInt(retryAfterReg, 10) > 0, `Registration block returns valid Retry-After (${retryAfterReg}s)`);
    const blockedRegBody = await blockedRegRes.json();
    assert(blockedRegBody.error.includes('Too many registration attempts'), 'Returns informative registration rate-limit message');

    // Restore registration env vars
    if (originalRegLimit !== undefined) process.env.AUTH_REGISTER_RATE_LIMIT = originalRegLimit;
    else delete process.env.AUTH_REGISTER_RATE_LIMIT;
    if (originalRegWindow !== undefined) process.env.AUTH_REGISTER_RATE_WINDOW = originalRegWindow;
    else delete process.env.AUTH_REGISTER_RATE_WINDOW;

    // ---------------------------------------------------------
    // 9. Video Upload Rate Limiting (Dual Quotas & Atomic Non-Consumption)
    // ---------------------------------------------------------
    console.log('\n[9. Video Upload Rate Limiting (Dual Quotas & Atomic Non-Consumption)]');

    // Test 9.1: Unauthenticated request receives 401 before upload rate limiting runs
    const unauthRes = await fetch(`${baseUrl}/uploads`, {
      method: 'POST'
    });
    assert(unauthRes.status === 401, 'Unauthenticated POST /uploads returns 401 Unauthorized (requireAuthMiddleware runs first)');

    // Helper to count files in uploads directory
    const uploadsDir = path.resolve(process.cwd(), 'uploads');
    const getUploadsFileCount = () => {
      if (!fs.existsSync(uploadsDir)) return 0;
      return fs.readdirSync(uploadsDir).length;
    };

    // Helper to send multipart upload
    const sendMultipartUpload = async (token: string, filename: string, content: Buffer, ip?: string) => {
      const boundary = `----WebKitFormBoundary${crypto.randomBytes(8).toString('hex')}`;
      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([header, content, footer]);

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      };
      if (ip) headers['x-forwarded-for'] = ip;

      return fetch(`${baseUrl}/uploads`, {
        method: 'POST',
        headers,
        body
      });
    };

    const dummyMp4 = Buffer.from('fake mp4 video content for testing upload pipeline');

    // Register User 1
    const uploader1Email = `uploader1_${Date.now()}@videorisk.com`;
    const uploader1Reg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uploader1Email, password: 'uploaderPassword123' })
    });
    const uploader1Token = (await uploader1Reg.json()).token;

    // Test User & IP Upload Quotas
    const originalUploadLimit = process.env.UPLOAD_RATE_LIMIT;
    const originalUploadWindow = process.env.UPLOAD_RATE_WINDOW;
    const originalUploadUserLimit = process.env.UPLOAD_USER_RATE_LIMIT;
    const originalUploadIpLimit = process.env.UPLOAD_IP_RATE_LIMIT;

    process.env.UPLOAD_RATE_LIMIT = '2';
    process.env.UPLOAD_RATE_WINDOW = '60';
    process.env.UPLOAD_IP_RATE_LIMIT = '2';

    const uploadIpPrefix = `198.51.${Math.floor(Math.random() * 200) + 10}`;
    const uploadIp1 = `${uploadIpPrefix}.77`;

    // Upload 1 & 2 succeed/reach pipeline
    const up1 = await sendMultipartUpload(uploader1Token, 'test_vid1.mp4', dummyMp4, uploadIp1);
    assert(up1.status === 200 || up1.status === 400, `User 1 upload 1 processed (HTTP ${up1.status})`);

    const up2 = await sendMultipartUpload(uploader1Token, 'test_vid2.mp4', dummyMp4, uploadIp1);
    assert(up2.status === 200 || up2.status === 400, `User 1 upload 2 processed (HTTP ${up2.status})`);

    const filesBeforeBlockedUpload = getUploadsFileCount();

    // Upload 3 exceeds User quota -> HTTP 429 with Retry-After
    const up3 = await sendMultipartUpload(uploader1Token, 'test_vid3.mp4', dummyMp4, uploadIp1);
    assert(up3.status === 429, 'User upload 3 rejected with HTTP 429 Too Many Requests');
    const retryAfterUp = up3.headers.get('Retry-After');
    assert(!!retryAfterUp && parseInt(retryAfterUp, 10) > 0, `Upload 429 returns Retry-After header (${retryAfterUp}s)`);
    const up3Body = await up3.json();
    assert(up3Body.error.includes('Upload rate limit exceeded'), 'Upload error message verified');

    // Verify Multer did NOT write file to disk on 429
    const filesAfterBlockedUpload = getUploadsFileCount();
    assert(
      filesAfterBlockedUpload === filesBeforeBlockedUpload,
      `Multer did NOT write file to disk on 429 (file count unchanged: ${filesBeforeBlockedUpload})`
    );

    // Register User 2
    const uploader2Email = `uploader2_${Date.now()}@videorisk.com`;
    const uploader2Reg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uploader2Email, password: 'uploaderPassword123' })
    });
    const uploader2Token = (await uploader2Reg.json()).token;

    // User 2 tries to upload from uploadIp1 (which already consumed 2 slots from User 1) -> blocked by IP quota
    const upUser2Blocked = await sendMultipartUpload(uploader2Token, 'test_vid_sybil.mp4', dummyMp4, uploadIp1);
    assert(upUser2Blocked.status === 429, 'Separate IP upload quota blocks 2nd account from same exhausted IP (HTTP 429)');
    const upUser2Body = await upUser2Blocked.json();
    assert(upUser2Body.error.includes('Upload rate limit exceeded for your network'), 'Network IP upload rate limit message returned');

    // CRITICAL ATOMIC NON-CONSUMPTION PROOF 1:
    // User 2's upload was rejected by IP quota. User 2's OWN account quota must NOT have been consumed!
    // When User 2 uploads from a fresh, unblocked IP, the upload must be allowed through!
    const cleanIpForUser2 = `${uploadIpPrefix}.88`;
    const upUser2Clean = await sendMultipartUpload(uploader2Token, 'test_vid_user2.mp4', dummyMp4, cleanIpForUser2);
    assert(
      upUser2Clean.status === 200 || upUser2Clean.status === 400,
      `User 2 upload succeeds on clean IP: User quota was NOT consumed when previously rejected by IP quota (HTTP ${upUser2Clean.status})`
    );

    // CRITICAL ATOMIC NON-CONSUMPTION PROOF 2:
    // User 1's user quota is exhausted (2 of 2). User 1 attempts upload on a fresh IP (cleanIpForUser3).
    // It is rejected by user quota. The fresh IP's quota must NOT be consumed!
    const freshSharedIp = `${uploadIpPrefix}.99`;
    const upUser1BlockedOnFreshIp = await sendMultipartUpload(uploader1Token, 'test_vid_u1_fresh.mp4', dummyMp4, freshSharedIp);
    assert(upUser1BlockedOnFreshIp.status === 429, 'Exhausted User 1 is blocked on fresh IP by user quota');

    // Register User 3 and upload from that same fresh IP:
    const uploader3Email = `uploader3_${Date.now()}@videorisk.com`;
    const uploader3Reg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uploader3Email, password: 'uploaderPassword123' })
    });
    const uploader3Token = (await uploader3Reg.json()).token;

    const upUser3OnFreshIp = await sendMultipartUpload(uploader3Token, 'test_vid_u3.mp4', dummyMp4, freshSharedIp);
    assert(
      upUser3OnFreshIp.status === 200 || upUser3OnFreshIp.status === 400,
      `User 3 upload succeeds on shared IP: IP quota was NOT consumed when User 1 was rejected by user quota (HTTP ${upUser3OnFreshIp.status})`
    );

    // Concurrent upload quota integrity test
    const concurrentUserEmail = `uploader_concurrent_${Date.now()}@videorisk.com`;
    const concurrentUserReg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: concurrentUserEmail, password: 'uploaderPassword123' })
    });
    const concurrentUserToken = (await concurrentUserReg.json()).token;
    const concurrentIp = `${uploadIpPrefix}.123`;

    // Fire 6 simultaneous uploads under a limit of 2
    const simultaneousUploads = await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        sendMultipartUpload(concurrentUserToken, `vid_${idx}.mp4`, dummyMp4, concurrentIp)
      )
    );
    const concurrentAllowed = simultaneousUploads.filter(r => r.status === 200 || r.status === 400).length;
    const concurrentBlocked = simultaneousUploads.filter(r => r.status === 429).length;

    assert(concurrentAllowed === 2, `Concurrent uploads strictly capped at quota limit (allowed: ${concurrentAllowed}, expected: 2)`);
    assert(concurrentBlocked === 4, `Excess concurrent uploads safely rejected with 429 (rejected: ${concurrentBlocked})`);

    // Restore upload env vars
    if (originalUploadLimit !== undefined) process.env.UPLOAD_RATE_LIMIT = originalUploadLimit;
    else delete process.env.UPLOAD_RATE_LIMIT;
    if (originalUploadWindow !== undefined) process.env.UPLOAD_RATE_WINDOW = originalUploadWindow;
    else delete process.env.UPLOAD_RATE_WINDOW;
    if (originalUploadUserLimit !== undefined) process.env.UPLOAD_USER_RATE_LIMIT = originalUploadUserLimit;
    else delete process.env.UPLOAD_USER_RATE_LIMIT;
    if (originalUploadIpLimit !== undefined) process.env.UPLOAD_IP_RATE_LIMIT = originalUploadIpLimit;
    else delete process.env.UPLOAD_IP_RATE_LIMIT;

    // ---------------------------------------------------------
    // 10. Untrusted Proxy Protection & Client IP Semantics
    // ---------------------------------------------------------
    console.log('\n[10. Untrusted Proxy Protection & Client IP Semantics]');

    // Test 10.1: App with trust proxy: false (default deployment)
    const untrustedApp = express();
    configureTrustProxy(untrustedApp, undefined); // Default -> false
    untrustedApp.use('/test-ip', (req, res) => {
      res.json({ ip: getClientIp(req) });
    });
    const untrustedServer: Server = await new Promise(resolve => {
      const s = untrustedApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const untrustedPort = (untrustedServer.address() as any).port;

    try {
      // Send spoofed X-Forwarded-For to untrusted app
      const spoofedRes = await fetch(`http://127.0.0.1:${untrustedPort}/test-ip`, {
        headers: { 'x-forwarded-for': '203.0.113.199' }
      });
      const spoofedData = await spoofedRes.json();
      assert(
        spoofedData.ip !== '203.0.113.199',
        `Arbitrary X-Forwarded-For is strictly IGNORED when trust proxy is disabled (got ${spoofedData.ip}, not spoofed IP)`
      );
    } finally {
      untrustedServer.close();
    }

    // Test 10.2: App with explicit single hop trust proxy (e.g. TRUST_PROXY=1)
    const hopProxyApp = express();
    configureTrustProxy(hopProxyApp, '1');
    hopProxyApp.use('/test-ip', (req, res) => {
      res.json({ ip: getClientIp(req) });
    });
    const hopServer: Server = await new Promise(resolve => {
      const s = hopProxyApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const hopPort = (hopServer.address() as any).port;

    try {
      const hopRes = await fetch(`http://127.0.0.1:${hopPort}/test-ip`, {
        headers: { 'x-forwarded-for': '203.0.113.199' }
      });
      const hopData = await hopRes.json();
      assert(
        hopData.ip === '203.0.113.199',
        `Hop count TRUST_PROXY=1 correctly evaluates client IP from trusted reverse proxy hop (got ${hopData.ip})`
      );
    } finally {
      hopServer.close();
    }

    // Test 10.3: App with explicit loopback / trusted IP proxy
    const loopbackApp = express();
    configureTrustProxy(loopbackApp, 'loopback');
    loopbackApp.use('/test-ip', (req, res) => {
      res.json({ ip: getClientIp(req) });
    });
    const loopbackServer: Server = await new Promise(resolve => {
      const s = loopbackApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const loopbackPort = (loopbackServer.address() as any).port;

    try {
      const lbRes = await fetch(`http://127.0.0.1:${loopbackPort}/test-ip`, {
        headers: { 'x-forwarded-for': '198.51.100.55' }
      });
      const lbData = await lbRes.json();
      assert(
        lbData.ip === '198.51.100.55',
        `Trusted 'loopback' proxy configuration resolves forwarded client IP through local proxy (got ${lbData.ip})`
      );
    } finally {
      loopbackServer.close();
    }

    console.log('\n======================================================');
    console.log('TEST SUITE 12 COMPLETE: All Rate Limiting & Abuse Protection assertions passed!');
    console.log('======================================================');
  } finally {
    server.close();
  }
}
