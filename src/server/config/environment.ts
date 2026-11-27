import net from 'net';

export type ValidDeploymentEnv = 'development' | 'test' | 'staging' | 'production';
export type ValidPaymentMode = 'live' | 'production' | 'test' | 'simulation';

export interface EnvironmentConflict {
  variable: string;
  code:
    | 'INVALID_PAYMENT_MODE'
    | 'INVALID_DEPLOYMENT_ENV'
    | 'PROD_TEST_MODE_CONFLICT'
    | 'DEV_LIVE_PAYMENT_CONFLICT'
    | 'TEST_KEY_IN_LIVE_OR_PROD'
    | 'LIVE_KEY_IN_DEV_OR_TEST'
    | 'LIVE_KEY_IN_STAGING'
    | 'STAGING_LIVE_PAYMENT_CONFLICT'
    | 'STAGING_PLATFORM_PROD_CONFLICT'
    | 'DEPLOYMENT_NODE_ENV_CONFLICT';
  message: string;
}

export interface EnvironmentSecurityResolution {
  nodeEnv: string;
  deploymentEnv: ValidDeploymentEnv | '';
  paymentMode: string;
  isNodeEnvProduction: boolean;
  isExplicitStaging: boolean;
  isStaging: boolean;
  requiresLivePayments: boolean;
  isLivePaymentMode: boolean;
  hasLiveStripeKey: boolean;
  hasTestStripeKey: boolean;
  /**
   * Authoritative canonical predicate across Trusted Origins,
   * Checkout Origin Validation, Portal Redirect URL Validation, HTTPS Enforcement,
   * Readiness Checks, Media Token Secret enforcement, Demo Seeding, Password Reset Token Disclosure,
   * and Server Vite/Static serving.
   *
   * Any staging, live-payment, or production signal activates strict runtime production hardening
   * so neither Staging nor Live Payment can operate with Development origin / localhost / HTTP rules,
   * demo user seeding, or dev reset token disclosure.
   * Live Stripe key enforcement is governed separately by `requiresLivePayments`.
   */
  isProduction: boolean;
  conflicts: EnvironmentConflict[];
  hasConflict: boolean;
}

const VALID_PAYMENT_MODE_SET = new Set<string>(['live', 'production', 'test', 'simulation']);
const VALID_DEPLOYMENT_ENV_SET = new Set<string>(['development', 'test', 'staging', 'production']);

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

export const STRIPE_LIVE_SECRET_KEY_REGEX = /^(?:sk|rk)_live_[A-Za-z0-9][A-Za-z0-9_]{9,}$/;
export const STRIPE_TEST_SECRET_KEY_REGEX = /^(?:sk|rk)_test_[A-Za-z0-9][A-Za-z0-9_]{9,}$/;

export interface StripeSecretKeyValidationResult {
  present: boolean;
  validFormat: boolean;
  mode: 'live' | 'test' | 'malformed' | 'missing';
  code: 'VALID_LIVE' | 'VALID_TEST' | 'MISSING' | 'MALFORMED';
  message: string;
}

/**
 * Canonical Stripe secret key validator shared across runtime BillingService,
 * readiness probe, environment security resolution, and static CLI validation.
 * Never includes the raw secret value in diagnostic messages.
 */
export function validateStripeSecretKeyFormat(
  key?: string | null
): StripeSecretKeyValidationResult {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed) {
    return {
      present: false,
      validFormat: false,
      mode: 'missing',
      code: 'MISSING',
      message: 'STRIPE_SECRET_KEY is not configured.',
    };
  }
  if (STRIPE_LIVE_SECRET_KEY_REGEX.test(trimmed)) {
    return {
      present: true,
      validFormat: true,
      mode: 'live',
      code: 'VALID_LIVE',
      message: 'Valid Stripe live secret key format.',
    };
  }
  if (STRIPE_TEST_SECRET_KEY_REGEX.test(trimmed)) {
    return {
      present: true,
      validFormat: true,
      mode: 'test',
      code: 'VALID_TEST',
      message: 'Valid Stripe test secret key format.',
    };
  }
  return {
    present: true,
    validFormat: false,
    mode: 'malformed',
    code: 'MALFORMED',
    message:
      "Malformed STRIPE_SECRET_KEY format (expected 'sk_live_...', 'rk_live_...', 'sk_test_...', or 'rk_test_...' with at least 10 token characters).",
  };
}

export function isLiveStripeSecretKey(key?: string | null): boolean {
  if (!key || typeof key !== 'string') return false;
  return STRIPE_LIVE_SECRET_KEY_REGEX.test(key.trim());
}

export function isTestStripeSecretKey(key?: string | null): boolean {
  if (!key || typeof key !== 'string') return false;
  return STRIPE_TEST_SECRET_KEY_REGEX.test(key.trim());
}

export type AppOriginVariableName = 'APP_BASE_URL' | 'APP_URL' | 'PUBLIC_APP_URL';

export interface ResolvedAppOriginConfig {
  rawOrigin: string;
  variable: AppOriginVariableName | null;
  hasExplicitAppBaseUrl: boolean;
  hasAppUrlFallback: boolean;
  hasPublicAppUrlFallback: boolean;
}

/**
 * Resolves configured application origin with explicit precedence and attribution:
 * APP_BASE_URL > APP_URL > PUBLIC_APP_URL
 */
export function resolveConfiguredAppOrigin(
  env: NodeJS.ProcessEnv = process.env
): ResolvedAppOriginConfig {
  const appBaseUrl = typeof env.APP_BASE_URL === 'string' ? env.APP_BASE_URL.trim() : '';
  const appUrl = typeof env.APP_URL === 'string' ? env.APP_URL.trim() : '';
  const publicAppUrl = typeof env.PUBLIC_APP_URL === 'string' ? env.PUBLIC_APP_URL.trim() : '';

  if (appBaseUrl) {
    return {
      rawOrigin: appBaseUrl,
      variable: 'APP_BASE_URL',
      hasExplicitAppBaseUrl: true,
      hasAppUrlFallback: Boolean(appUrl),
      hasPublicAppUrlFallback: Boolean(publicAppUrl),
    };
  }
  if (appUrl) {
    return {
      rawOrigin: appUrl,
      variable: 'APP_URL',
      hasExplicitAppBaseUrl: false,
      hasAppUrlFallback: true,
      hasPublicAppUrlFallback: Boolean(publicAppUrl),
    };
  }
  if (publicAppUrl) {
    return {
      rawOrigin: publicAppUrl,
      variable: 'PUBLIC_APP_URL',
      hasExplicitAppBaseUrl: false,
      hasAppUrlFallback: false,
      hasPublicAppUrlFallback: true,
    };
  }
  return {
    rawOrigin: '',
    variable: null,
    hasExplicitAppBaseUrl: false,
    hasAppUrlFallback: false,
    hasPublicAppUrlFallback: false,
  };
}

export interface AppOriginValidationResult {
  valid: boolean;
  origin?: string;
  code:
    | 'VALID'
    | 'MISSING'
    | 'UNSAFE_SYNTAX'
    | 'MALFORMED_URL'
    | 'INSECURE_SCHEME'
    | 'FORBIDDEN_HOST'
    | 'UNSUPPORTED_SCHEME';
  message: string;
}

/**
 * Authoritative origin URL validator shared across validate-env.ts, BillingService,
 * EmailService, and /api/health/readiness.
 */
export function validateAppOriginUrl(
  rawOrigin: string | undefined | null,
  requireHttpsPublic: boolean,
  variableName: string = 'APP_BASE_URL'
): AppOriginValidationResult {
  const trimmed = typeof rawOrigin === 'string' ? rawOrigin.trim() : '';
  if (!trimmed) {
    return {
      valid: false,
      code: 'MISSING',
      message: `${variableName} is missing or empty.`,
    };
  }

  if (
    /\s/.test(trimmed) ||
    trimmed.includes('\\') ||
    trimmed.includes('@') ||
    trimmed.startsWith('//')
  ) {
    return {
      valid: false,
      code: 'UNSAFE_SYNTAX',
      message: `Unsafe or malformed origin in ${variableName}: userinfo (@), backslashes, whitespace, and protocol-relative URLs are forbidden.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      code: 'MALFORMED_URL',
      message: `Malformed URL syntax in ${variableName}. Expected e.g. 'https://videorisk.com'.`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      code: 'UNSAFE_SYNTAX',
      message: `Unsafe or malformed origin in ${variableName}: userinfo credentials are forbidden.`,
    };
  }

  if (requireHttpsPublic) {
    if (parsed.protocol !== 'https:') {
      return {
        valid: false,
        code: 'INSECURE_SCHEME',
        message: `Insecure scheme '${parsed.protocol}' in ${variableName}. Production and staging strictly require https:// origins.`,
      };
    }
    if (isForbiddenProductionOriginHostname(parsed.hostname)) {
      return {
        valid: false,
        code: 'FORBIDDEN_HOST',
        message: `Loopback, localhost, or unspecified origin '${parsed.origin}' in ${variableName} is forbidden in production/staging/live payment mode.`,
      };
    }
  } else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      valid: false,
      code: 'UNSUPPORTED_SCHEME',
      message: `Unsupported scheme '${parsed.protocol}' in ${variableName}. Only http:// and https:// origins are allowed.`,
    };
  }

  return {
    valid: true,
    origin: parsed.origin,
    code: 'VALID',
    message: `${variableName} origin is valid.`,
  };
}

/**
 * Strictly validates an IP address (IPv4/IPv6) or CIDR block (IPv4/IPv6).
 */
export function isValidIpOrCidr(entry: string): boolean {
  if (!entry || typeof entry !== 'string') return false;
  const trimmed = entry.trim();
  if (trimmed === '') return false;

  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length !== 2) return false;
    const [ipPart, prefixPart] = parts;

    const ipVer = net.isIP(ipPart);
    if (ipVer === 0) return false;

    if (!/^(0|[1-9]\d*)$/.test(prefixPart)) return false;
    const prefix = Number(prefixPart);
    if (!Number.isSafeInteger(prefix)) return false;

    if (ipVer === 4) {
      return prefix >= 0 && prefix <= 32;
    }
    if (ipVer === 6) {
      return prefix >= 0 && prefix <= 128;
    }
    return false;
  }

  return net.isIP(trimmed) !== 0;
}

export interface TrustProxyValidationResult {
  valid: boolean;
  mode: 'disabled' | 'hops' | 'keyword' | 'unrestricted' | 'ip_list' | 'invalid';
  normalizedValue: boolean | number | string;
  warning?: string;
  error?: string;
}

export function validateTrustProxyValue(rawVal: string | undefined | null): TrustProxyValidationResult {
  if (rawVal === undefined || rawVal === null || typeof rawVal !== 'string' || rawVal.trim() === '' || rawVal.trim().toLowerCase() === 'false') {
    return { valid: true, mode: 'disabled', normalizedValue: false };
  }

  const trimmed = rawVal.trim();

  if (/^[1-9]\d*$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isSafeInteger(num) && num > 0) {
      return { valid: true, mode: 'hops', normalizedValue: num };
    }
  }

  const knownKeywords = ['loopback', 'linklocal', 'uniquelocal'];
  if (knownKeywords.includes(trimmed.toLowerCase())) {
    return { valid: true, mode: 'keyword', normalizedValue: trimmed.toLowerCase() };
  }

  if (trimmed.toLowerCase() === 'true') {
    return {
      valid: true,
      mode: 'unrestricted',
      normalizedValue: true,
      warning:
        'TRUST_PROXY is set to unrestricted "true". Prefer configuring an exact hop count (e.g. TRUST_PROXY=1) or trusted subnet CIDR range.',
    };
  }

  const parts = trimmed.split(',').map((p) => p.trim());
  if (parts.length > 0 && parts.every((part) => isValidIpOrCidr(part))) {
    return { valid: true, mode: 'ip_list', normalizedValue: parts.join(', ') };
  }

  return {
    valid: false,
    mode: 'invalid',
    normalizedValue: false,
    error: `Invalid TRUST_PROXY syntax. Expected 'false', a positive integer hop count (e.g. '1'), 'loopback'/'linklocal'/'uniquelocal', comma-separated IP/CIDR list, or 'true'.`,
  };
}

export function resolveEnvironmentSecurity(
  env: NodeJS.ProcessEnv = process.env
): EnvironmentSecurityResolution {
  const nodeEnv = (env.NODE_ENV || '').trim().toLowerCase();
  const rawDeploymentEnv = (env.DEPLOYMENT_ENV || '').trim().toLowerCase();
  const paymentMode = (env.PAYMENT_MODE || '').trim().toLowerCase();
  const stripeKey = (env.STRIPE_SECRET_KEY || '').trim();

  const isDeploymentEnvValid = !rawDeploymentEnv || VALID_DEPLOYMENT_ENV_SET.has(rawDeploymentEnv);
  const deploymentEnv: ValidDeploymentEnv | '' = isDeploymentEnvValid
    ? (rawDeploymentEnv as ValidDeploymentEnv | '')
    : '';

  const isNodeEnvProduction = nodeEnv === 'production';
  const isExplicitProduction = deploymentEnv === 'production';
  const isExplicitStaging = deploymentEnv === 'staging';
  const isExplicitDevOrTest = deploymentEnv === 'development' || deploymentEnv === 'test';
  const isLivePaymentMode = paymentMode === 'live' || paymentMode === 'production';
  const hasLiveStripeKey = isLiveStripeSecretKey(stripeKey);
  const hasTestStripeKey = isTestStripeSecretKey(stripeKey);

  const platformProdSignals: Array<[string, string | undefined]> = [
    ['VERCEL_ENV', env.VERCEL_ENV],
    ['RAILWAY_ENVIRONMENT', env.RAILWAY_ENVIRONMENT],
    ['RAILWAY_ENVIRONMENT_NAME', env.RAILWAY_ENVIRONMENT_NAME],
    ['RENDER_ENV', env.RENDER_ENV],
    ['PLATFORM_ENV', env.PLATFORM_ENV],
    ['APP_ENV', env.APP_ENV],
  ];
  const matchedPlatformProd = platformProdSignals.find(
    ([, val]) => (val || '').trim().toLowerCase() === 'production'
  );

  // Runtime security hardening applies across BOTH staging and production (and any live payment signal).
  const isProduction =
    isNodeEnvProduction ||
    isExplicitProduction ||
    isExplicitStaging ||
    isLivePaymentMode ||
    hasLiveStripeKey ||
    Boolean(matchedPlatformProd);

  // Live billing enforcement applies to production / live payment contexts, and ALWAYS escalates if
  // staging is combined with live payment or platform-level production indicators.
  const requiresLivePayments =
    isExplicitProduction ||
    isLivePaymentMode ||
    hasLiveStripeKey ||
    Boolean(matchedPlatformProd) ||
    (isNodeEnvProduction && !isExplicitStaging);

  const isStaging =
    isExplicitStaging &&
    !isLivePaymentMode &&
    !hasLiveStripeKey &&
    !matchedPlatformProd;

  const conflicts: EnvironmentConflict[] = [];

  if (rawDeploymentEnv && !isDeploymentEnvValid) {
    conflicts.push({
      variable: 'DEPLOYMENT_ENV',
      code: 'INVALID_DEPLOYMENT_ENV',
      message: `Unrecognized DEPLOYMENT_ENV='${rawDeploymentEnv}'. Allowed values are 'development', 'test', 'staging', or 'production'.`,
    });
  }

  if (paymentMode && !VALID_PAYMENT_MODE_SET.has(paymentMode)) {
    conflicts.push({
      variable: 'PAYMENT_MODE',
      code: 'INVALID_PAYMENT_MODE',
      message: `Unrecognized PAYMENT_MODE='${paymentMode}'. Allowed values are 'live', 'production', 'test', or 'simulation'.`,
    });
  }

  if (isExplicitStaging && matchedPlatformProd) {
    conflicts.push({
      variable: 'DEPLOYMENT_ENV',
      code: 'STAGING_PLATFORM_PROD_CONFLICT',
      message: `Contradictory environment configuration: DEPLOYMENT_ENV='staging' cannot override ${matchedPlatformProd[0]}='production'.`,
    });
  }

  if (isExplicitStaging && isLivePaymentMode) {
    conflicts.push({
      variable: 'PAYMENT_MODE',
      code: 'STAGING_LIVE_PAYMENT_CONFLICT',
      message: `Contradictory environment configuration: DEPLOYMENT_ENV='staging' cannot be combined with PAYMENT_MODE='${paymentMode}'. Staging must use test billing credentials.`,
    });
  }

  if (isExplicitStaging && hasLiveStripeKey) {
    conflicts.push({
      variable: 'STRIPE_SECRET_KEY',
      code: 'LIVE_KEY_IN_STAGING',
      message: 'Contradictory environment configuration: Live Stripe key cannot be used when DEPLOYMENT_ENV=\'staging\'. Use sk_test_... / rk_test_... keys in staging.',
    });
  }

  if (isExplicitProduction && (nodeEnv === 'development' || nodeEnv === 'test')) {
    conflicts.push({
      variable: 'DEPLOYMENT_ENV',
      code: 'DEPLOYMENT_NODE_ENV_CONFLICT',
      message: `Contradictory environment configuration: DEPLOYMENT_ENV='production' cannot be combined with NODE_ENV='${nodeEnv}'.`,
    });
  }

  if (isExplicitStaging && (nodeEnv === 'development' || nodeEnv === 'test')) {
    conflicts.push({
      variable: 'DEPLOYMENT_ENV',
      code: 'DEPLOYMENT_NODE_ENV_CONFLICT',
      message: `Contradictory environment configuration: DEPLOYMENT_ENV='staging' cannot be combined with NODE_ENV='${nodeEnv}'. Use NODE_ENV='production' for optimized staging builds.`,
    });
  }

  if (isExplicitDevOrTest && isNodeEnvProduction) {
    conflicts.push({
      variable: 'DEPLOYMENT_ENV',
      code: 'DEPLOYMENT_NODE_ENV_CONFLICT',
      message: `Contradictory environment configuration: DEPLOYMENT_ENV='${deploymentEnv}' cannot be combined with NODE_ENV='production'.`,
    });
  }

  if (
    (requiresLivePayments && !isExplicitStaging && (paymentMode === 'test' || paymentMode === 'simulation')) ||
    (isExplicitStaging && paymentMode === 'simulation')
  ) {
    conflicts.push({
      variable: 'PAYMENT_MODE',
      code: 'PROD_TEST_MODE_CONFLICT',
      message: isExplicitStaging
        ? `Contradictory environment configuration: PAYMENT_MODE='simulation' is forbidden in staging.`
        : `Contradictory environment configuration: NODE_ENV='production' cannot be combined with PAYMENT_MODE='${paymentMode}'.`,
    });
  }

  if ((nodeEnv === 'development' || nodeEnv === 'test') && isLivePaymentMode) {
    conflicts.push({
      variable: 'PAYMENT_MODE',
      code: 'DEV_LIVE_PAYMENT_CONFLICT',
      message: `Contradictory environment configuration: PAYMENT_MODE='${paymentMode}' cannot be combined with NODE_ENV='${nodeEnv}'. Align NODE_ENV='production' with live payment configuration.`,
    });
  }

  if (requiresLivePayments && hasTestStripeKey) {
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
    deploymentEnv,
    paymentMode,
    isNodeEnvProduction,
    isExplicitStaging,
    isStaging,
    requiresLivePayments,
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

/**
 * Strictly validates and parses a positive integer from a string value:
 * 1. Trims surrounding whitespace.
 * 2. Entire value must match digits only without leading zeroes: /^[1-9]\d*$/
 * 3. Rejects decimal values (e.g. "1.5"), trailing characters (e.g. "10abc"), zero ("0"),
 *    negative values ("-1"), non-numeric strings, and Infinity.
 * 4. Rejects values outside JavaScript's safe-integer range (Number.MAX_SAFE_INTEGER).
 * Returns null if invalid.
 */
export function parseStrictPositiveInt(val: string | undefined | null): number | null {
  if (val === undefined || val === null || typeof val !== 'string') {
    return null;
  }
  const trimmed = val.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return null;
  }
  if (trimmed.length > 15) {
    try {
      if (BigInt(trimmed) > BigInt(Number.MAX_SAFE_INTEGER)) {
        return null;
      }
    } catch {
      return null;
    }
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num <= 0) {
    return null;
  }
  return num;
}

/**
 * Resolves a rate-limit integer setting with unambiguous precedence:
 * 1. Primary (current/specific) environment variable if set to a valid positive integer.
 * 2. Fallback (legacy/general) environment variable if set to a valid positive integer.
 * 3. Default positive integer value.
 */
export function resolveRateLimitInt(
  primaryVal: string | undefined,
  fallbackVal: string | undefined,
  defaultValue: number
): number {
  const primaryParsed = parseStrictPositiveInt(primaryVal);
  if (primaryParsed !== null) {
    return primaryParsed;
  }
  const fallbackParsed = parseStrictPositiveInt(fallbackVal);
  if (fallbackParsed !== null) {
    return fallbackParsed;
  }
  return defaultValue;
}

export interface RateLimitPolicySpec {
  id: string;
  primaryVar: string;
  fallbackVar?: string;
  defaultValue: number;
}

export const RATE_LIMIT_POLICY_SPECS: readonly RateLimitPolicySpec[] = [
  { id: 'auth_login_ip_limit', primaryVar: 'AUTH_LOGIN_IP_RATE_LIMIT', fallbackVar: 'AUTH_LOGIN_RATE_LIMIT', defaultValue: 20 },
  { id: 'auth_login_ip_window', primaryVar: 'AUTH_LOGIN_IP_RATE_WINDOW', fallbackVar: 'AUTH_LOGIN_RATE_WINDOW', defaultValue: 900 },
  { id: 'auth_login_account_limit', primaryVar: 'AUTH_LOGIN_ACCOUNT_RATE_LIMIT', defaultValue: 5 },
  { id: 'auth_login_account_window', primaryVar: 'AUTH_LOGIN_ACCOUNT_RATE_WINDOW', defaultValue: 900 },
  { id: 'auth_register_limit', primaryVar: 'AUTH_REGISTER_RATE_LIMIT', fallbackVar: 'AUTH_REGISTRATION_RATE_LIMIT', defaultValue: 30 },
  { id: 'auth_register_window', primaryVar: 'AUTH_REGISTER_RATE_WINDOW', fallbackVar: 'AUTH_REGISTRATION_RATE_WINDOW', defaultValue: 900 },
  { id: 'upload_user_limit', primaryVar: 'UPLOAD_USER_RATE_LIMIT', fallbackVar: 'UPLOAD_RATE_LIMIT', defaultValue: 10 },
  { id: 'upload_user_window', primaryVar: 'UPLOAD_USER_RATE_WINDOW', fallbackVar: 'UPLOAD_RATE_WINDOW', defaultValue: 600 },
  { id: 'upload_ip_limit', primaryVar: 'UPLOAD_IP_RATE_LIMIT', defaultValue: 20 },
  { id: 'upload_ip_window', primaryVar: 'UPLOAD_IP_RATE_WINDOW', defaultValue: 600 },
];

/**
 * Configurable media and temporary artifact retention defaults.
 * NOTE: These are operational defaults only and require explicit owner approval
 * before production deployment and policy enforcement.
 */
export const DEFAULT_MEDIA_RETENTION_HOURS = 168; // 7 days (requires owner sign-off for prod)
export const DEFAULT_TEMP_ARTIFACT_RETENTION_HOURS = 24; // 24 hours
export const DEFAULT_RETENTION_CLEANUP_INTERVAL_MS = 3600000; // 1 hour

export interface RetentionConfiguration {
  enabled: boolean;
  mediaRetentionHours: number;
  tempArtifactRetentionHours: number;
  cleanupIntervalMs: number;
  approvalStatus: 'CONFIGURABLE_DEFAULT_REQUIRES_OWNER_APPROVAL';
}

export function resolveRetentionConfiguration(
  env: NodeJS.ProcessEnv = process.env
): RetentionConfiguration {
  const rawEnabled = (env.RETENTION_CLEANUP_ENABLED || '').trim().toLowerCase();
  const enabled = rawEnabled !== 'false' && rawEnabled !== '0';

  const mediaRetentionHours =
    parseStrictPositiveInt(env.MEDIA_RETENTION_HOURS) ?? DEFAULT_MEDIA_RETENTION_HOURS;
  const tempArtifactRetentionHours =
    parseStrictPositiveInt(env.TEMP_ARTIFACT_RETENTION_HOURS) ?? DEFAULT_TEMP_ARTIFACT_RETENTION_HOURS;
  const cleanupIntervalMs =
    parseStrictPositiveInt(env.RETENTION_CLEANUP_INTERVAL_MS) ?? DEFAULT_RETENTION_CLEANUP_INTERVAL_MS;

  return {
    enabled,
    mediaRetentionHours,
    tempArtifactRetentionHours,
    cleanupIntervalMs,
    approvalStatus: 'CONFIGURABLE_DEFAULT_REQUIRES_OWNER_APPROVAL',
  };
}

