import path from 'path';
import fs from 'fs';

export const DEFAULT_PRODUCTION_DB_BASENAME = 'videorisk.db';
export const DEFAULT_TEST_DB_BASENAME = 'videorisk_test.db';

export interface TestDatabaseResolution {
  resolvedPath: string;
  isCustom: boolean;
  source: 'TEST_DATABASE_PATH' | 'DEFAULT_TEST_PATH' | 'VALIDATED_DATABASE_PATH';
}

/**
 * Resolves a database file path to its canonical filesystem target.
 * Resolves all symbolic links whether the target exists or not.
 * 
 * Guarantees:
 * 1. For existing files or symlinks, resolves realpath through the filesystem.
 * 2. For non-existent database files, verifies and canonicalizes the parent directory.
 * 3. Follows symlink chains with recursion/cycle detection.
 * 4. Fails closed on missing or unresolvable parent directories.
 * 5. Read-only: never creates, modifies, truncates, or deletes any database file.
 */
export function canonicalizeDatabaseTarget(targetPath: string, visited: Set<string> = new Set()): string {
  if (!targetPath || typeof targetPath !== 'string' || targetPath.trim() === '') {
    throw new Error('[Database Isolation Error] Database path must be a non-empty string.');
  }

  const resolved = path.resolve(targetPath.trim());
  if (visited.has(resolved) || visited.size > 40) {
    throw new Error(`[Database Isolation Error] Detected symlink cycle or excessive link depth for path: '${targetPath}'`);
  }
  visited.add(resolved);

  // Check if targetPath itself is a symbolic link (even if broken or pointing to non-existent file)
  try {
    const lstat = fs.lstatSync(resolved);
    if (lstat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(resolved);
      const nextPath = path.isAbsolute(linkTarget)
        ? linkTarget
        : path.resolve(path.dirname(resolved), linkTarget);
      return canonicalizeDatabaseTarget(nextPath, visited);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw new Error(`[Database Isolation Error] Cannot access path '${targetPath}': ${err.message}`);
    }
  }

  // If path exists and is not a symlink, realpathSync returns the canonical filesystem path
  try {
    return fs.realpathSync(resolved);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw new Error(`[Database Isolation Error] Cannot canonicalize path '${targetPath}': ${err.message}`);
    }
  }

  // Target file does not exist: safely validate and canonicalize the parent directory
  const parentDir = path.dirname(resolved);
  const baseName = path.basename(resolved);

  try {
    const canonicalParent = fs.realpathSync(parentDir);
    return path.join(canonicalParent, baseName);
  } catch (err: any) {
    // If parent directory does not exist or cannot be resolved, fail closed
    throw new Error(
      `[Database Isolation Error] Cannot safely canonicalize database path '${targetPath}': parent directory '${parentDir}' does not exist or is unresolvable.`
    );
  }
}

/**
 * Returns the resolved path to the production database based on current configuration.
 */
export function getProductionDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const cwd = process.cwd();
  if (env.DATA_DIR && env.DATA_DIR.trim() !== '') {
    return path.resolve(env.DATA_DIR.trim(), DEFAULT_PRODUCTION_DB_BASENAME);
  }
  return path.resolve(cwd, 'data', DEFAULT_PRODUCTION_DB_BASENAME);
}

/**
 * Returns all canonical target paths that represent production databases under current configuration.
 * Always includes both the DATA_DIR target (if configured) and the default cwd/data/videorisk.db target.
 */
export function getProductionCanonicalTargets(env: NodeJS.ProcessEnv = process.env): string[] {
  const targets: string[] = [];
  const cwd = process.cwd();

  // 1. Default production path: cwd/data/videorisk.db
  const defaultProd = path.resolve(cwd, 'data', DEFAULT_PRODUCTION_DB_BASENAME);
  try {
    targets.push(canonicalizeDatabaseTarget(defaultProd));
  } catch {
    targets.push(defaultProd);
  }

  // 2. DATA_DIR override path if set
  if (env.DATA_DIR && env.DATA_DIR.trim() !== '') {
    const dataDirProd = path.resolve(env.DATA_DIR.trim(), DEFAULT_PRODUCTION_DB_BASENAME);
    try {
      const canonicalDataDirProd = canonicalizeDatabaseTarget(dataDirProd);
      if (!targets.includes(canonicalDataDirProd)) {
        targets.push(canonicalDataDirProd);
      }
    } catch {
      if (!targets.includes(dataDirProd)) {
        targets.push(dataDirProd);
      }
    }
  }

  return targets;
}

/**
 * Returns the default dedicated test database path.
 */
export function getDefaultTestDatabasePath(): string {
  return path.resolve(process.cwd(), 'data', DEFAULT_TEST_DB_BASENAME);
}

/**
 * Checks whether a candidate database path canonicalizes to any production database target.
 */
export function isTargetingProduction(targetPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let canonicalTarget: string;
  try {
    canonicalTarget = canonicalizeDatabaseTarget(targetPath);
  } catch {
    // If path cannot be safely canonicalized, consider it unsafe
    return true;
  }

  const prodTargets = getProductionCanonicalTargets(env);
  for (const prodTarget of prodTargets) {
    if (canonicalTarget === prodTarget) {
      return true;
    }

    // Inode/device check if both files exist on disk
    try {
      const targetStat = fs.statSync(canonicalTarget);
      const prodStat = fs.statSync(prodTarget);
      if (targetStat.ino && prodStat.ino && targetStat.ino === prodStat.ino && targetStat.dev === prodStat.dev) {
        return true;
      }
    } catch {
      // One or both do not exist yet on disk
    }
  }

  // Also check if canonical target filename matches production database filename in a production directory
  const baseName = path.basename(canonicalTarget);
  if (baseName === DEFAULT_PRODUCTION_DB_BASENAME) {
    const targetDir = path.dirname(canonicalTarget);
    for (const prodTarget of prodTargets) {
      if (targetDir === path.dirname(prodTarget)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Validates a test database target path before opening or connecting:
 * - Resolves all symbolic links.
 * - Fails closed if the path resolves to any production database target.
 * - Fails closed if the parent directory does not exist or cannot be resolved.
 * - Fails closed if target is named videorisk.db.
 */
export function validateTestDatabaseTarget(targetPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const canonicalTarget = canonicalizeDatabaseTarget(targetPath);

  if (isTargetingProduction(targetPath, env)) {
    throw new Error(
      `[Database Isolation Error] Refusing to use database path '${targetPath}': canonical target '${canonicalTarget}' matches production database. Automated tests cannot target production databases.`
    );
  }

  const baseName = path.basename(canonicalTarget);
  if (baseName === DEFAULT_PRODUCTION_DB_BASENAME) {
    throw new Error(
      `[Database Isolation Error] Refusing to use database path '${targetPath}': target has production database name '${DEFAULT_PRODUCTION_DB_BASENAME}'.`
    );
  }

  return canonicalTarget;
}

/**
 * Enforces test database isolation:
 * - Guarantees automated test runners cannot silently use the production database path.
 * - Explicitly establishes a dedicated test database path before importing storage or routes.
 * - Validates resolved targets against symlinks and production targets.
 * - If an externally supplied DATABASE_PATH conflicts with required test database, fails safely.
 * - Preserves explicit TEST_DATABASE_PATH override when safe.
 * - Synchronizes process.env.DATABASE_PATH to the resolved isolated test path.
 */
export function enforceTestDatabaseIsolation(
  env: NodeJS.ProcessEnv = process.env
): TestDatabaseResolution {
  const defaultTestPath = getDefaultTestDatabasePath();

  // 1. Explicit, documented test-only mechanism: TEST_DATABASE_PATH
  if (env.TEST_DATABASE_PATH && env.TEST_DATABASE_PATH.trim() !== '') {
    const rawCustomPath = env.TEST_DATABASE_PATH.trim();
    // Validate target (resolves symlinks, checks production targets, checks parent dir)
    const canonicalCustom = validateTestDatabaseTarget(rawCustomPath, env);

    // If external DATABASE_PATH is also supplied, it must resolve to the same canonical database
    if (env.DATABASE_PATH && env.DATABASE_PATH.trim() !== '') {
      const rawDbPath = env.DATABASE_PATH.trim();
      let canonicalDbPath: string;
      try {
        canonicalDbPath = canonicalizeDatabaseTarget(rawDbPath);
      } catch {
        canonicalDbPath = path.resolve(rawDbPath);
      }

      if (canonicalDbPath !== canonicalCustom) {
        throw new Error(
          `[Database Isolation Error] Conflicting database configuration: DATABASE_PATH ('${rawDbPath}') conflicts with explicit TEST_DATABASE_PATH ('${rawCustomPath}'). Remove DATABASE_PATH or set it to match TEST_DATABASE_PATH.`
        );
      }
    }

    env.DATABASE_PATH = rawCustomPath;
    return { resolvedPath: canonicalCustom, isCustom: true, source: 'TEST_DATABASE_PATH' };
  }

  // 2. If TEST_DATABASE_PATH is NOT set, inspect DATABASE_PATH
  if (env.DATABASE_PATH && env.DATABASE_PATH.trim() !== '') {
    const rawDbPath = env.DATABASE_PATH.trim();
    let canonicalSupplied: string;
    try {
      canonicalSupplied = canonicalizeDatabaseTarget(rawDbPath);
    } catch {
      throw new Error(
        `[Database Isolation Error] Conflicting DATABASE_PATH detected: '${rawDbPath}'. Automated test runner requires isolated test database ('${defaultTestPath}'). To specify a custom test database, use the explicit TEST_DATABASE_PATH environment variable.`
      );
    }

    let canonicalDefaultTest: string;
    try {
      canonicalDefaultTest = canonicalizeDatabaseTarget(defaultTestPath);
    } catch {
      canonicalDefaultTest = defaultTestPath;
    }

    // If externally supplied DATABASE_PATH resolves to the default test path, allow it
    if (canonicalSupplied === canonicalDefaultTest) {
      validateTestDatabaseTarget(defaultTestPath, env);
      env.DATABASE_PATH = defaultTestPath;
      return { resolvedPath: canonicalDefaultTest, isCustom: false, source: 'VALIDATED_DATABASE_PATH' };
    }

    // Any other external DATABASE_PATH is rejected as a conflict
    throw new Error(
      `[Database Isolation Error] Conflicting DATABASE_PATH detected: '${rawDbPath}'. ` +
      `Automated test runner requires isolated test database ('${defaultTestPath}'). ` +
      `Automated tests cannot run against an external or production database. ` +
      `To specify a legitimate custom test database, use the explicit TEST_DATABASE_PATH environment variable.`
    );
  }

  // 3. Unset DATABASE_PATH: establish dedicated test database path
  const canonicalDefault = validateTestDatabaseTarget(defaultTestPath, env);
  env.DATABASE_PATH = defaultTestPath;
  return { resolvedPath: canonicalDefault, isCustom: false, source: 'DEFAULT_TEST_PATH' };
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
  const canonicalActive = validateTestDatabaseTarget(activeStoragePath, env);
  const canonicalExpected = canonicalizeDatabaseTarget(expectedPath);

  if (canonicalActive !== canonicalExpected) {
    throw new Error(
      `[CRITICAL SECURITY CHECK FAILED] Storage database path ('${activeStoragePath}', canonical '${canonicalActive}') does not match expected isolated test database ('${expectedPath}', canonical '${canonicalExpected}'). Aborting tests!`
    );
  }
}
