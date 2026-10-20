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
 * Global storage for preserved production database configuration captured before test runner override.
 */
let preservedProductionDatabasePath: string | undefined = undefined;

/**
 * Sets or clears the preserved original production database path.
 */
export function setPreservedProductionDatabasePath(val: string | undefined): void {
  preservedProductionDatabasePath = val && typeof val === 'string' && val.trim() !== '' ? val.trim() : undefined;
}

/**
 * Gets the preserved original production database path if captured.
 */
export function getPreservedProductionDatabasePath(): string | undefined {
  return preservedProductionDatabasePath;
}

/**
 * Determines whether a given database path represents a test-specific database or test override
 * rather than a production database target.
 */
export function isTestDatabasePath(candidatePath: string | undefined | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!candidatePath || typeof candidatePath !== 'string' || candidatePath.trim() === '') {
    return false;
  }
  const trimmed = candidatePath.trim();
  const baseName = path.basename(trimmed);

  // 1. Matches standard test basename ('videorisk_test.db')
  if (baseName === DEFAULT_TEST_DB_BASENAME) {
    return true;
  }

  // 2. Matches default test database path
  const defaultTestPath = getDefaultTestDatabasePath();
  if (path.resolve(trimmed) === defaultTestPath) {
    return true;
  }
  try {
    if (canonicalizeDatabaseTarget(trimmed) === canonicalizeDatabaseTarget(defaultTestPath)) {
      return true;
    }
  } catch {
    // If cannot canonicalize, path equality was checked above
  }

  // 3. Matches explicitly configured TEST_DATABASE_PATH
  if (env.TEST_DATABASE_PATH && env.TEST_DATABASE_PATH.trim() !== '') {
    const customTestPath = path.resolve(env.TEST_DATABASE_PATH.trim());
    if (path.resolve(trimmed) === customTestPath) {
      return true;
    }
    try {
      if (canonicalizeDatabaseTarget(trimmed) === canonicalizeDatabaseTarget(customTestPath)) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  return false;
}

// Preserve original production DATABASE_PATH if present at module load before any test runner mutation
if (process.env.PRODUCTION_DATABASE_PATH && process.env.PRODUCTION_DATABASE_PATH.trim() !== '') {
  preservedProductionDatabasePath = process.env.PRODUCTION_DATABASE_PATH.trim();
} else if (process.env.DATABASE_PATH && !isTestDatabasePath(process.env.DATABASE_PATH, process.env)) {
  preservedProductionDatabasePath = process.env.DATABASE_PATH.trim();
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
 * Returns the resolved path to the production database based on current configuration and storage precedence:
 * Precedence in SqliteStorageRepository:
 * 1. DATABASE_PATH (if set and not a test override)
 * 2. DATA_DIR/videorisk.db (if DATA_DIR is set)
 * 3. data/videorisk.db (default)
 */
export function getProductionDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const cwd = process.cwd();

  // 1. Explicit PRODUCTION_DATABASE_PATH override if configured
  if (env.PRODUCTION_DATABASE_PATH && env.PRODUCTION_DATABASE_PATH.trim() !== '') {
    return path.resolve(env.PRODUCTION_DATABASE_PATH.trim());
  }

  // 2. Custom production DATABASE_PATH if set and NOT a test database override
  if (env.DATABASE_PATH && env.DATABASE_PATH.trim() !== '') {
    const rawDbPath = env.DATABASE_PATH.trim();
    if (!isTestDatabasePath(rawDbPath, env)) {
      return path.resolve(rawDbPath);
    }
  }

  // 3. Preserved original production database path (if captured before test runner override)
  if (preservedProductionDatabasePath && !isTestDatabasePath(preservedProductionDatabasePath, env)) {
    return path.resolve(preservedProductionDatabasePath);
  }

  // 4. DATA_DIR override path: DATA_DIR/videorisk.db
  if (env.DATA_DIR && env.DATA_DIR.trim() !== '') {
    return path.resolve(env.DATA_DIR.trim(), DEFAULT_PRODUCTION_DB_BASENAME);
  }

  // 5. Default production path: cwd/data/videorisk.db
  return path.resolve(cwd, 'data', DEFAULT_PRODUCTION_DB_BASENAME);
}

/**
 * Returns all canonical target paths that represent production databases under current configuration.
 * Always includes:
 * - The primary configured production database (respecting storage precedence: DATABASE_PATH -> DATA_DIR -> default)
 * - The default cwd/data/videorisk.db target
 * - The DATA_DIR/videorisk.db target if DATA_DIR is configured
 * - Any preserved original production database path
 */
export function getProductionCanonicalTargets(env: NodeJS.ProcessEnv = process.env): string[] {
  const targets: string[] = [];
  const cwd = process.cwd();

  const addTarget = (targetPath: string | undefined | null) => {
    if (!targetPath || typeof targetPath !== 'string' || targetPath.trim() === '') return;
    const resolved = path.resolve(targetPath.trim());
    try {
      const canonical = canonicalizeDatabaseTarget(resolved);
      if (!targets.includes(canonical)) {
        targets.push(canonical);
      }
    } catch {
      if (!targets.includes(resolved)) {
        targets.push(resolved);
      }
    }
  };

  // 1. Primary resolved production database based on current configuration and precedence
  const primaryProd = getProductionDatabasePath(env);
  addTarget(primaryProd);

  // 2. Default production path: cwd/data/videorisk.db
  const defaultProd = path.resolve(cwd, 'data', DEFAULT_PRODUCTION_DB_BASENAME);
  addTarget(defaultProd);

  // 3. DATA_DIR override path if set
  if (env.DATA_DIR && env.DATA_DIR.trim() !== '') {
    const dataDirProd = path.resolve(env.DATA_DIR.trim(), DEFAULT_PRODUCTION_DB_BASENAME);
    addTarget(dataDirProd);
  }

  // 4. Preserved original production database path
  if (preservedProductionDatabasePath && !isTestDatabasePath(preservedProductionDatabasePath, env)) {
    addTarget(preservedProductionDatabasePath);
  }

  // 5. If env.DATABASE_PATH is set and is NOT a test database path, ensure it is added
  if (env.DATABASE_PATH && env.DATABASE_PATH.trim() !== '' && !isTestDatabasePath(env.DATABASE_PATH, env)) {
    addTarget(env.DATABASE_PATH.trim());
  }

  // 6. Explicit PRODUCTION_DATABASE_PATH if set
  if (env.PRODUCTION_DATABASE_PATH && env.PRODUCTION_DATABASE_PATH.trim() !== '') {
    addTarget(env.PRODUCTION_DATABASE_PATH.trim());
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
    // If path cannot be safely canonicalized, fail closed by considering it unsafe
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

  // Check if canonical target matches production database filename in a production directory
  const baseName = path.basename(canonicalTarget);
  const targetDir = path.dirname(canonicalTarget);
  for (const prodTarget of prodTargets) {
    const prodBase = path.basename(prodTarget);
    const prodDir = path.dirname(prodTarget);
    if (baseName === prodBase && targetDir === prodDir) {
      return true;
    }
  }

  // Standard production basename ('videorisk.db') is always protected
  if (baseName === DEFAULT_PRODUCTION_DB_BASENAME) {
    return true;
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
 * - Preserves the original production database configuration before changing environment variables.
 * - Validates resolved targets against symlinks and production targets.
 * - If an externally supplied DATABASE_PATH conflicts with required test database, fails safely.
 * - Preserves explicit TEST_DATABASE_PATH override when safe.
 * - Synchronizes process.env.DATABASE_PATH to the resolved isolated test path.
 */
export function enforceTestDatabaseIsolation(
  env: NodeJS.ProcessEnv = process.env
): TestDatabaseResolution {
  const defaultTestPath = getDefaultTestDatabasePath();
  const defaultTestDir = path.dirname(defaultTestPath);
  if (!fs.existsSync(defaultTestDir)) {
    fs.mkdirSync(defaultTestDir, { recursive: true });
  }

  // If env.DATABASE_PATH is set and represents an original custom production database (not test db),
  // preserve it before changing env.DATABASE_PATH:
  if (!preservedProductionDatabasePath && env.DATABASE_PATH && env.DATABASE_PATH.trim() !== '') {
    const candidate = env.DATABASE_PATH.trim();
    if (!isTestDatabasePath(candidate, env)) {
      preservedProductionDatabasePath = candidate;
    }
  }

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
