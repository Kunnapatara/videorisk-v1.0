import crypto from 'crypto';
import type { UserAccount } from '../../types';

/**
 * Valid internal VideoRisk User ID format:
 * - Non-empty, 1-128 chars
 * - Strictly forbids email addresses ('@'), whitespace, commas, and control characters
 * - Matches standard internal IDs such as 'usr_1795590327744_sxbm7' or test IDs
 */
const INTERNAL_USER_ID_REGEX = /^[a-zA-Z0-9._:-]{1,128}$/;

export function isValidInternalUserId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value) {
    // Callers should trim first; handle trimmed checks explicitly below
  }
  if (!trimmed || trimmed.includes('@') || /\s/.test(trimmed)) {
    return false;
  }
  return INTERNAL_USER_ID_REGEX.test(trimmed);
}

/**
 * Constant-time exact string equality on UTF-8 byte buffers.
 */
export function timingSafeExactEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Parses a comma-separated list of internal User IDs (e.g. ADMIN_USER_IDS).
 * Strictly ignores empty tokens, whitespace-containing tokens, and any email addresses ('@').
 */
export function parseAuthorizedUserIds(raw: string | undefined | null): Set<string> {
  const result = new Set<string>();
  if (!raw || typeof raw !== 'string') {
    return result;
  }

  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (isValidInternalUserId(trimmed)) {
      result.add(trimmed);
    }
  }
  return result;
}

/**
 * Resolves the authoritative configured OWNER_USER_ID from environment.
 * Fails closed (returns null) if unset, empty, malformed, or containing an email address ('@').
 */
export function getConfiguredOwnerUserId(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.OWNER_USER_ID;
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!isValidInternalUserId(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Authorizes Owner privileges strictly by exact internal User ID comparison against OWNER_USER_ID.
 * - Fails closed when OWNER_USER_ID is missing, invalid, or unverified.
 * - Never matches by email address.
 * - Never trusts client-supplied flags, profile fields, query params, or headers.
 */
export function isVerifiedOwnerUser(
  user: Pick<UserAccount, 'id'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!user || typeof user.id !== 'string') {
    return false;
  }
  const candidateId = user.id.trim();
  if (!isValidInternalUserId(candidateId)) {
    return false;
  }

  const configuredOwnerId = getConfiguredOwnerUserId(env);
  if (!configuredOwnerId) {
    return false;
  }

  return timingSafeExactEqual(candidateId, configuredOwnerId);
}

/**
 * Authorizes Admin privileges strictly by verified internal User ID comparison:
 * - Configured OWNER_USER_ID receives Admin access.
 * - Explicit internal User IDs listed in ADMIN_USER_IDS receive Admin access.
 * - ADMIN_EMAILS matching alone NEVER grants Admin privileges.
 * - Email addresses are NEVER accepted as User IDs.
 * - Fails closed when neither valid OWNER_USER_ID nor valid ADMIN_USER_IDS matches.
 */
export function isAuthorizedAdminUser(
  user: Pick<UserAccount, 'id'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!user || typeof user.id !== 'string') {
    return false;
  }
  const candidateId = user.id.trim();
  if (!isValidInternalUserId(candidateId)) {
    return false;
  }

  if (isVerifiedOwnerUser({ id: candidateId }, env)) {
    return true;
  }

  const adminUserIds = parseAuthorizedUserIds(env.ADMIN_USER_IDS);
  if (adminUserIds.size === 0) {
    return false;
  }

  for (const allowedId of adminUserIds) {
    if (timingSafeExactEqual(candidateId, allowedId)) {
      return true;
    }
  }
  return false;
}
