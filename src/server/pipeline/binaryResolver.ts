import fs from 'fs';
import path from 'path';

export type BinaryResolutionStatus =
  | 'READY'
  | 'MISSING_EXECUTABLE'
  | 'NON_EXECUTABLE'
  | 'NOT_CONFIGURED';

export type BinaryResolutionSource = 'CONFIGURED' | 'PATH' | 'NONE';

export interface BinaryResolutionResult {
  envVar: string;
  binaryName: string;
  configured: boolean;
  configuredPath: string | null;
  resolvedPath: string | null;
  source: BinaryResolutionSource;
  found: boolean;
  executable: boolean;
  status: BinaryResolutionStatus;
}

function checkCandidateExecutable(candidatePath: string): { found: boolean; executable: boolean } {
  try {
    const stat = fs.statSync(candidatePath);
    if (!stat.isFile()) {
      // Directory or special non-file path cannot be executed
      return { found: true, executable: false };
    }
    try {
      fs.accessSync(candidatePath, fs.constants.X_OK);
      return { found: true, executable: true };
    } catch {
      return { found: true, executable: false };
    }
  } catch {
    return { found: false, executable: false };
  }
}

/**
 * Safely scans PATH entries for an executable matching `binaryName` without shell invocation.
 */
export function findExecutableOnPath(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env
): { found: boolean; executable: boolean; resolvedPath: string | null } {
  const rawPath = typeof env.PATH === 'string' ? env.PATH : '';
  if (!rawPath.trim()) {
    return { found: false, executable: false, resolvedPath: null };
  }

  const dirs = rawPath
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);

  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .map((e) => e.trim())
          .filter(Boolean)
      : [''];

  let firstNonExecutableMatch: string | null = null;

  for (const dir of dirs) {
    for (const ext of extensions) {
      const targetName =
        ext && !binaryName.toLowerCase().endsWith(ext.toLowerCase())
          ? `${binaryName}${ext}`
          : binaryName;
      const candidate = path.join(dir, targetName);
      const check = checkCandidateExecutable(candidate);
      if (check.found && check.executable) {
        return { found: true, executable: true, resolvedPath: candidate };
      }
      if (check.found && !firstNonExecutableMatch) {
        firstNonExecutableMatch = candidate;
      }
    }
  }

  if (firstNonExecutableMatch) {
    return { found: true, executable: false, resolvedPath: firstNonExecutableMatch };
  }

  return { found: false, executable: false, resolvedPath: null };
}

/**
 * Resolves a local media/OCR/STT executable consistently:
 * 1. Explicit configured environment variable takes strict precedence.
 *    If configured but missing or non-executable, fails deterministically without silent PATH fallback.
 * 2. When the environment variable is unset/empty, safely resolves `binaryName` from PATH.
 * 3. If unavailable everywhere, returns status='NOT_CONFIGURED'.
 */
export function resolveExecutable(
  binaryName: string,
  envVar: string,
  env: NodeJS.ProcessEnv = process.env
): BinaryResolutionResult {
  const rawConfigured = env[envVar];
  const configuredPath = typeof rawConfigured === 'string' ? rawConfigured.trim() : '';

  if (configuredPath.length > 0) {
    const hasPathSeparator = configuredPath.includes('/') || configuredPath.includes('\\');
    if (hasPathSeparator) {
      const check = checkCandidateExecutable(configuredPath);
      if (check.found && check.executable) {
        return {
          envVar,
          binaryName,
          configured: true,
          configuredPath,
          resolvedPath: configuredPath,
          source: 'CONFIGURED',
          found: true,
          executable: true,
          status: 'READY',
        };
      }
      return {
        envVar,
        binaryName,
        configured: true,
        configuredPath,
        resolvedPath: null,
        source: 'CONFIGURED',
        found: check.found,
        executable: false,
        status: check.found ? 'NON_EXECUTABLE' : 'MISSING_EXECUTABLE',
      };
    }

    // Bare binary name explicitly supplied in envVar (e.g. FFMPEG_PATH=ffmpeg)
    const pathLookup = findExecutableOnPath(configuredPath, env);
    if (pathLookup.found && pathLookup.executable) {
      return {
        envVar,
        binaryName,
        configured: true,
        configuredPath,
        resolvedPath: pathLookup.resolvedPath,
        source: 'CONFIGURED',
        found: true,
        executable: true,
        status: 'READY',
      };
    }
    return {
      envVar,
      binaryName,
      configured: true,
      configuredPath,
      resolvedPath: null,
      source: 'CONFIGURED',
      found: pathLookup.found,
      executable: false,
      status: pathLookup.found ? 'NON_EXECUTABLE' : 'MISSING_EXECUTABLE',
    };
  }

  // Fallback to PATH when envVar is unset/empty
  const pathLookup = findExecutableOnPath(binaryName, env);
  if (pathLookup.found && pathLookup.executable) {
    return {
      envVar,
      binaryName,
      configured: false,
      configuredPath: null,
      resolvedPath: pathLookup.resolvedPath,
      source: 'PATH',
      found: true,
      executable: true,
      status: 'READY',
    };
  }

  if (pathLookup.found && !pathLookup.executable) {
    return {
      envVar,
      binaryName,
      configured: false,
      configuredPath: null,
      resolvedPath: null,
      source: 'NONE',
      found: true,
      executable: false,
      status: 'NON_EXECUTABLE',
    };
  }

  return {
    envVar,
    binaryName,
    configured: false,
    configuredPath: null,
    resolvedPath: null,
    source: 'NONE',
    found: false,
    executable: false,
    status: 'NOT_CONFIGURED',
  };
}
