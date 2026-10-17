import path from 'path';

export const DEFAULT_PRODUCTION_DB_BASENAME = 'videorisk.db';
export const DEFAULT_TEST_DB_BASENAME = 'videorisk_test.db';

export interface TestDatabaseResolution {
  resolvedPath: string;
  isCustom: boolean;
  source: 'TEST_DATABASE_PATH' | 'DEFAULT_TEST_PATH' | 'VALIDATED_DATABASE_PATH';
}

/**
 * Returns the resolved absolute path to the production database based on current environment.
 */
export function getProductionDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const cwd = process.cwd();
  if (env.DATA_DIR && env.DATA_DIR.trim() !== '') {
    return path.resolve(env.DATA_DIR.trim(), DEFAULT_PRODUCTION_DB_BASENAME);
  }
  return path.resolve(cwd, 'data', DEFAULT_PRODUCTION_DB_BASENAME);
}

/**
 * Returns the default dedicated test database path.
 */
export function getDefaultTestDatabasePath(): string {
  return path.resolve(process.cwd(), 'data', DEFAULT_TEST_DB_BASENAME);
}

/**
 * Enforces test database isolation:
 * - Guarantees that automated test runners cannot silently use the production database path.
 * - Before importing storage or route modules, explicitly establishes a dedicated test database path.
 * - If an externally supplied DATABASE_PATH conflicts with the required test database, fails safely
 *   with a clear error rather than silently overriding a potentially important path or continuing against the wrong database.
 * - Preserves legitimate custom test database configuration only through the explicit, documented
 *   test-only mechanism: TEST_DATABASE_PATH.
 * - Synchronizes process.env.DATABASE_PATH to the resolved isolated test path.
 */
export function enforceTestDatabaseIsolation(
  env: NodeJS.ProcessEnv = process.env
): TestDatabaseResolution {
  const prodPath = getProductionDatabasePath(env);
  const defaultTestPath = getDefaultTestDatabasePath();

  // 1. Explicit, documented test-only mechanism: TEST_DATABASE_PATH
  if (env.TEST_DATABASE_PATH && env.TEST_DATABASE_PATH.trim() !== '') {
    const customTestPath = path.resolve(env.TEST_DATABASE_PATH.trim());

    // Never allow TEST_DATABASE_PATH to target production database
    if (customTestPath === prodPath || path.basename(customTestPath) === DEFAULT_PRODUCTION_DB_BASENAME) {
      throw new Error(
        `[Database Isolation Error] Refusing to use production database path as TEST_DATABASE_PATH: '${customTestPath}'. Automated tests cannot target production databases.`
      );
    }

    // If external DATABASE_PATH is also supplied, it must agree with TEST_DATABASE_PATH
    if (env.DATABASE_PATH && env.DATABASE_PATH.trim() !== '') {
      const existingDbPath = path.resolve(env.DATABASE_PATH.trim());
      if (existingDbPath !== customTestPath) {
        throw new Error(
          `[Database Isolation Error] Conflicting database configuration: DATABASE_PATH ('${env.DATABASE_PATH}') conflicts with explicit TEST_DATABASE_PATH ('${env.TEST_DATABASE_PATH}'). Remove DATABASE_PATH or set it to match TEST_DATABASE_PATH.`
        );
      }
    }

    env.DATABASE_PATH = customTestPath;
    return { resolvedPath: customTestPath, isCustom: true, source: 'TEST_DATABASE_PATH' };
  }

  // 2. If TEST_DATABASE_PATH is NOT set, inspect DATABASE_PATH
  if (env.DATABASE_PATH && env.DATABASE_PATH.trim() !== '') {
    const suppliedPath = path.resolve(env.DATABASE_PATH.trim());

    // If externally supplied DATABASE_PATH already matches the required test path, allow it
    if (suppliedPath === defaultTestPath) {
      env.DATABASE_PATH = defaultTestPath;
      return { resolvedPath: defaultTestPath, isCustom: false, source: 'VALIDATED_DATABASE_PATH' };
    }

    // If it conflicts with the required test database (e.g. points to production videorisk.db or other db)
    throw new Error(
      `[Database Isolation Error] Conflicting DATABASE_PATH detected: '${env.DATABASE_PATH}'. ` +
      `Automated test runner requires isolated test database ('${defaultTestPath}'). ` +
      `Automated tests cannot run against an external or production database. ` +
      `To specify a legitimate custom test database, use the explicit TEST_DATABASE_PATH environment variable.`
    );
  }

  // 3. Unset DATABASE_PATH: establish dedicated test database path
  env.DATABASE_PATH = defaultTestPath;
  return { resolvedPath: defaultTestPath, isCustom: false, source: 'DEFAULT_TEST_PATH' };
}

/**
 * Verifies that the storage instance is running on the expected isolated test database
 * before any test performs storage mutations.
 */
export function verifyStorageTestDatabase(
  activeStoragePath: string,
  expectedPath: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const resolvedActive = path.resolve(activeStoragePath);
  const resolvedExpected = path.resolve(expectedPath);
  const prodPath = getProductionDatabasePath(env);

  if (resolvedActive === prodPath || path.basename(resolvedActive) === DEFAULT_PRODUCTION_DB_BASENAME) {
    throw new Error(
      `[CRITICAL SECURITY CHECK FAILED] Storage is configured with production database path: '${resolvedActive}'. Aborting all tests immediately to protect production data!`
    );
  }

  if (resolvedActive !== resolvedExpected) {
    throw new Error(
      `[CRITICAL SECURITY CHECK FAILED] Storage database path ('${resolvedActive}') does not match expected isolated test database ('${resolvedExpected}'). Aborting tests!`
    );
  }
}
