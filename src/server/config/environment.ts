import net from 'net';

export type ValidPaymentMode = 'live' | 'production' | 'test' | 'simulation';

export interface EnvironmentConflict {
  variable: string;
  code:
    | 'INVALID_PAYMENT_MODE'
    | 'PROD_TEST_MODE_CONFLICT'
    | 'DEV_LIVE_PAYMENT_CONFLICT'
    | 'TEST_KEY_IN_LIVE_OR_PROD'
    | 'LIVE_KEY_IN_DEV_OR_TEST';
  message: string;
}

export interface EnvironmentSecurityResolution {
  nodeEnv: string;
  paymentMode: string;
  isNodeEnvProduction: boolean;
  isLivePaymentMode: boolean;
  hasLiveStripeKey: boolean;
  hasTestStripeKey: boolean;
  /**
   * Authoritative canonical predicate across Stripe Live/Test mode, Trusted Origins,
   * Checkout Origin Validation, Portal Redirect URL Validation, HTTPS Enforcement,
   * Readiness Checks, Media Token Secret enforcement, and Environment Validation.
   *
   * Any live-payment or production signal activates strict production security rules
   * so Live Payment can NEVER operate with Development origin / localhost / HTTP rules.
   */
  isProduction: boolean;
  conflicts: EnvironmentConflict[];
  hasConflict: boolean;
}

const VALID_PAYMENT_MODE_SET = new Set<string>(['live', 'production', 'test', 'simulation']);

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

function parseIpv6Hextets(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;

  let working = ip.toLowerCase();
  const lastColon = working.lastIndexOf(':');
  if (lastColon === -1) return null;

  const tail = working.slice(lastColon + 1);
  let trailingHextets: number[] | null = null;
  if (tail.includes('.')) {
    const octets = parseIpv4Octets(tail);
    if (!octets) return null;
    trailingHextets = [
      ((octets[0] << 8) | octets[1]) >>> 0,
      ((octets[2] << 8) | octets[3]) >>> 0,
    ];
    working = working.slice(0, lastColon);
    if (working.endsWith(':')) {
      // Case like "::127.0.0.1" -> working became ":" -> restore "::" marker by keeping empty right side
      working += ':';
    }
  }

  const doubleColonParts = working.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const tokens = side.split(':');
    const out: number[] = [];
    for (const tok of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
      out.push(parseInt(tok, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseSide(doubleColonParts[0]);
    if (!groups) return null;
    const full = trailingHextets ? [...groups, ...trailingHextets] : groups;
    return full.length === 8 ? full : null;
  }

  const left = parseSide(doubleColonParts[0]);
  const rightRaw = parseSide(doubleColonParts[1]);
  if (!left || !rightRaw) return null;
  const right = trailingHextets ? [...rightRaw, ...trailingHextets] : rightRaw;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

function isValidDnsHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  const labels = host.split('.');
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  );
}

function parseIpv6Candidate(hostname: string): number[] | null {
  if (typeof hostname !== 'string') return null;
  const trimmed = hostname.trim();
  if (!trimmed) return null;

  // Hostnames never contain whitespace, schemes, paths, queries, fragments, userinfo, or backslashes
  if (/[\s/@?#\\]/.test(trimmed)) return null;

  const hasOpenBracket = trimmed.includes('[');
  const hasCloseBracket = trimmed.includes(']');
  let candidate = trimmed;

  if (hasOpenBracket || hasCloseBracket) {
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
      return null;
    }
    candidate = trimmed.slice(1, -1);
    if (!candidate || candidate.includes('[') || candidate.includes(']')) {
      return null;
    }
  }

  const lower = candidate.toLowerCase();
  if (!lower.includes(':')) return null;

  // Support optional RFC 6874 IPv6 zone ID (e.g. ::1%lo0, ::%lo0)
  let ipPart = lower;
  const pctIdx = lower.indexOf('%');
  if (pctIdx !== -1) {
    const zone = lower.slice(pctIdx + 1);
    ipPart = lower.slice(0, pctIdx);
    if (!zone || !/^[a-z0-9._-]+$/.test(zone)) {
      return null;
    }
  }

  return parseIpv6Hextets(ipPart);
}

/**
 * Explicit detector for the IPv6 unspecified address `::` and its normalized equivalents
 * (`0:0:0:0:0:0:0:0`, `[::]`, `::0`, `::%lo0`, `::0.0.0.0`, etc.).
 * Distinct from loopback so `isLoopbackHostname('::')` remains semantically false while
 * production origin/security boundaries can reject both loopback and unspecified addresses.
 */
export function isUnspecifiedIpv6Hostname(hostname: string): boolean {
  const hextets = parseIpv6Candidate(hostname);
  if (!hextets) return false;
  return hextets.every((h) => h === 0);
}

/**
 * Authoritative loopback hostname detector covering:
 * - localhost & *.localhost (case-insensitive, optional single trailing FQDN dot)
 * - Complete IPv4 loopback range 127.0.0.0/8 and unspecified local bind 0.0.0.0
 * - IPv6 loopback ::1 in any valid representation (e.g. 0:0:0:0:0:0:0:1, [::1])
 * - IPv4-mapped IPv6 loopback ::ffff:127.0.0.0/8 (both dotted ::ffff:127.0.0.1 and WHATWG hex ::ffff:7f00:1)
 * - Deprecated IPv4-compatible IPv6 loopback ::127.0.0.0/8
 * Rejects malformed strings, unbalanced brackets, credentials, paths, and unrelated private/public IPs.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (typeof hostname !== 'string') return false;
  const trimmed = hostname.trim();
  if (!trimmed) return false;

  // Hostnames never contain whitespace, schemes, paths, queries, fragments, userinfo, or backslashes
  if (/[\s/@?#\\]/.test(trimmed)) return false;

  const hasOpenBracket = trimmed.includes('[');
  const hasCloseBracket = trimmed.includes(']');
  let candidate = trimmed;

  if (hasOpenBracket || hasCloseBracket) {
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
      return false;
    }
    candidate = trimmed.slice(1, -1);
    if (!candidate || candidate.includes('[') || candidate.includes(']')) {
      return false;
    }
  }

  const lower = candidate.toLowerCase();

  // Handle IPv6 addresses (any unescaped colon indicates IPv6 candidate; bare host:port without URL parsing is invalid)
  if (lower.includes(':')) {
    const hextets = parseIpv6Candidate(trimmed);
    if (!hextets) return false;

    const first6Zero =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0;

    // Exact IPv6 loopback ::1
    if (first6Zero && hextets[6] === 0 && hextets[7] === 1) {
      return true;
    }

    // IPv4-mapped IPv6 ::ffff:0:0/96 -> reject if mapped IPv4 falls inside 127.0.0.0/8 (or 0.0.0.0)
    const isIpv4Mapped =
      hextets[0] === 0 &&
      hextets[1] === 0 &&
      hextets[2] === 0 &&
      hextets[3] === 0 &&
      hextets[4] === 0 &&
      hextets[5] === 0xffff;

    if (isIpv4Mapped) {
      const mappedFirstOctet = (hextets[6] >>> 8) & 0xff;
      if (mappedFirstOctet === 127) return true;
      if (hextets[6] === 0 && hextets[7] === 0) return true;
      return false;
    }

    // Deprecated IPv4-compatible IPv6 ::127.0.0.0/8
    if (first6Zero && ((hextets[6] >>> 8) & 0xff) === 127) {
      return true;
    }

    return false;
  }

  // Bracketed input is strictly reserved for IPv6 literals per RFC 3986
  if (hasOpenBracket) {
    return false;
  }

  // Complete IPv4 loopback range 127.0.0.0/8 + local bind 0.0.0.0
  const ipv4Octets = parseIpv4Octets(lower);
  if (ipv4Octets) {
    return ipv4Octets[0] === 127 || lower === '0.0.0.0';
  }

  // Reject numeric/dotted-quad-like invalid IPs (e.g. 127.0.0.256, 127.0.1, all-numeric top label)
  if (/^\d+(?:\.\d+)*$/.test(lower)) {
    return false;
  }

  // DNS hostname check (allow at most one trailing FQDN dot)
  if (lower.endsWith('..')) return false;
  const hostNoDot = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  if (!isValidDnsHostname(hostNoDot)) return false;

  return hostNoDot === 'localhost' || hostNoDot.endsWith('.localhost');
}

/**
 * Authoritative production-origin host guard: rejects loopback hosts AND unspecified IPv6 `::`.
 */
export function isForbiddenProductionOriginHostname(hostname: string): boolean {
  return isLoopbackHostname(hostname) || isUnspecifiedIpv6Hostname(hostname);
}

export const MIN_PRODUCTION_MEDIA_TOKEN_SECRET_LENGTH = 32;

const WEAK_MEDIA_SECRET_LITERALS = new Set<string>([
  'secret',
  'changeme',
  'change-me',
  'change_me',
  'placeholder',
  'default',
  'default_secret',
  'default-secret',
  'dev_secret',
  'dev-secret',
  'test_secret',
  'test-secret',
  'your_secret_here',
  'your-secret-here',
  'replace_me',
  'replace-me',
  'password',
  'videorisk',
  'videorisk_secret',
]);

export interface MediaTokenSecretValidationResult {
  valid: boolean;
  severity: 'NONE' | 'ERROR' | 'INFO';
  code: 'VALID' | 'MISSING' | 'TOO_SHORT' | 'PLACEHOLDER_OR_WEAK' | 'DEV_RANDOM_FALLBACK';
  message: string;
}

/**
 * Authoritative validation rule for MEDIA_TOKEN_SECRET shared across:
 * - Server startup & runtime API token signing/verification (`api.ts`, `server.ts`)
 * - Readiness probe (`GET /api/health/readiness`)
 * - CLI & static environment validator (`scripts/validate-env.ts`)
 *
 * Security guarantee: Error/info messages NEVER expose the configured secret value.
 */
export function validateMediaTokenSecret(
  rawSecret: string | undefined | null,
  isProduction: boolean
): MediaTokenSecretValidationResult {
  const trimmed = typeof rawSecret === 'string' ? rawSecret.trim() : '';

  if (!trimmed) {
    if (isProduction) {
      return {
        valid: false,
        severity: 'ERROR',
        code: 'MISSING',
        message:
          'MEDIA_TOKEN_SECRET environment variable is missing, empty, or whitespace-only. Production mode strictly requires a pre-shared MEDIA_TOKEN_SECRET.',
      };
    }
    return {
      valid: true,
      severity: 'INFO',
      code: 'DEV_RANDOM_FALLBACK',
      message:
        'MEDIA_TOKEN_SECRET not set. Development/CI server will operate with a per-process ephemeral random fallback secret.',
    };
  }

  if (isProduction) {
    const lower = trimmed.toLowerCase();
    const isSingleRepeatedChar = /^(.)\1+$/.test(trimmed);
    const isPlaceholder =
      WEAK_MEDIA_SECRET_LITERALS.has(lower) ||
      lower.includes('changeme') ||
      lower.includes('placeholder') ||
      lower.includes('replace_me') ||
      lower.includes('replace-me') ||
      lower.includes('your_secret') ||
      lower.includes('your-secret');

    if (isPlaceholder || isSingleRepeatedChar) {
      return {
        valid: false,
        severity: 'ERROR',
        code: 'PLACEHOLDER_OR_WEAK',
        message:
          'MEDIA_TOKEN_SECRET appears to be a placeholder or weak repeated value. Configure a strong cryptographic secret in production.',
      };
    }

    if (trimmed.length < MIN_PRODUCTION_MEDIA_TOKEN_SECRET_LENGTH) {
      return {
        valid: false,
        severity: 'ERROR',
        code: 'TOO_SHORT',
        message: `MEDIA_TOKEN_SECRET is too short for production use (minimum ${MIN_PRODUCTION_MEDIA_TOKEN_SECRET_LENGTH} characters required).`,
      };
    }
  }

  return {
    valid: true,
    severity: 'NONE',
    code: 'VALID',
    message: 'MEDIA_TOKEN_SECRET configured and valid.',
  };
}

export function isLiveStripeSecretKey(key?: string | null): boolean {
  if (!key || typeof key !== 'string') return false;
  const trimmed = key.trim();
  return trimmed.startsWith('sk_live_') || trimmed.startsWith('rk_live_');
}

export function isTestStripeSecretKey(key?: string | null): boolean {
  if (!key || typeof key !== 'string') return false;
  const trimmed = key.trim();
  return trimmed.startsWith('sk_test_') || trimmed.startsWith('rk_test_');
}

export function resolveEnvironmentSecurity(
  env: NodeJS.ProcessEnv = process.env
): EnvironmentSecurityResolution {
  const nodeEnv = (env.NODE_ENV || '').trim().toLowerCase();
  const paymentMode = (env.PAYMENT_MODE || '').trim().toLowerCase();
  const stripeKey = (env.STRIPE_SECRET_KEY || '').trim();

  const isNodeEnvProduction = nodeEnv === 'production';
  const isLivePaymentMode = paymentMode === 'live' || paymentMode === 'production';
  const hasLiveStripeKey = isLiveStripeSecretKey(stripeKey);
  const hasTestStripeKey = isTestStripeSecretKey(stripeKey);

  const isProduction = isNodeEnvProduction || isLivePaymentMode || hasLiveStripeKey;

  const conflicts: EnvironmentConflict[] = [];

  if (paymentMode && !VALID_PAYMENT_MODE_SET.has(paymentMode)) {
    conflicts.push({
      variable: 'PAYMENT_MODE',
      code: 'INVALID_PAYMENT_MODE',
      message: `Unrecognized PAYMENT_MODE='${paymentMode}'. Allowed values are 'live', 'production', 'test', or 'simulation'.`,
    });
  }

  if (isNodeEnvProduction && (paymentMode === 'test' || paymentMode === 'simulation')) {
    conflicts.push({
      variable: 'PAYMENT_MODE',
      code: 'PROD_TEST_MODE_CONFLICT',
      message: `Contradictory environment configuration: NODE_ENV='production' cannot be combined with PAYMENT_MODE='${paymentMode}'.`,
    });
  }

  if ((nodeEnv === 'development' || nodeEnv === 'test') && isLivePaymentMode) {
    conflicts.push({
      variable: 'PAYMENT_MODE',
      code: 'DEV_LIVE_PAYMENT_CONFLICT',
      message: `Contradictory environment configuration: PAYMENT_MODE='${paymentMode}' cannot be combined with NODE_ENV='${nodeEnv}'. Align NODE_ENV='production' with live payment configuration.`,
    });
  }

  if (isProduction && hasTestStripeKey) {
    conflicts.push({
      variable: 'STRIPE_SECRET_KEY',
      code: 'TEST_KEY_IN_LIVE_OR_PROD',
      message: 'Contradictory environment configuration: Test Stripe key detected while production or live payment mode is active.',
    });
  }

  if (
    hasLiveStripeKey &&
    (nodeEnv === 'development' ||
      nodeEnv === 'test' ||
      paymentMode === 'test' ||
      paymentMode === 'simulation')
  ) {
    conflicts.push({
      variable: 'STRIPE_SECRET_KEY',
      code: 'LIVE_KEY_IN_DEV_OR_TEST',
      message: `Contradictory environment configuration: Live Stripe key cannot be used when NODE_ENV='${nodeEnv || '(unset)'}' or PAYMENT_MODE='${paymentMode || '(unset)'}'.`,
    });
  }

  return {
    nodeEnv,
    paymentMode,
    isNodeEnvProduction,
    isLivePaymentMode,
    hasLiveStripeKey,
    hasTestStripeKey,
    isProduction,
    conflicts,
    hasConflict: conflicts.length > 0,
  };
}

export function isProductionEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEnvironmentSecurity(env).isProduction;
}
