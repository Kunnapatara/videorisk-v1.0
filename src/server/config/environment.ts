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

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '0.0.0.0'
  );
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
