/**
 * VideoRisk.com — Production Billing & Environment Configuration Validator
 *
 * Validates Stripe environment variables, secret prefixes, price IDs,
 * environment separation, and pricing tier mappings for launch readiness.
 *
 * Usage:
 *   npx tsx scripts/validate-env.ts                     # Production check (default)
 *   npx tsx scripts/validate-env.ts --mode=production  # Explicit production check
 *   npx tsx scripts/validate-env.ts --mode=staging     # Explicit staging check (NODE_ENV=production + sk_test_)
 *   npx tsx scripts/validate-env.ts --mode=test        # Test mode check
 *   npx tsx scripts/validate-env.ts --mode=development # Development mode check
 *   npx tsx scripts/validate-env.ts --live-check       # Optional live Stripe API check (requires ALLOW_LIVE_STRIPE_CHECK=true)
 */

import fs from 'fs';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import {
  parseStrictPositiveInt,
  RATE_LIMIT_POLICY_SPECS,
  resolveConfiguredAppOrigin,
  resolveEnvironmentSecurity,
  validateAppOriginUrl,
  validateMediaTokenSecret,
  validateStripeSecretKeyFormat,
  validateTrustProxyValue,
} from '../src/server/config/environment';
import { resolveExecutable } from '../src/server/pipeline/binaryResolver';
import { resolveSmtpConfiguration } from '../src/server/services/emailService';
import { isValidInternalUserId } from '../src/server/services/ownerAuth';

dotenv.config({ quiet: true });

export type ValidationIssueType = 'ERROR' | 'WARNING' | 'INFO' | 'NOT CONFIGURED';

export interface ValidationIssue {
  type: ValidationIssueType;
  variable: string;
  message: string;
}

export interface ValidationSummary {
  mode: 'production' | 'staging' | 'test' | 'development' | 'ci';
  valid: boolean;
  errorsCount: number;
  warningsCount: number;
  notConfiguredCount: number;
  issues: ValidationIssue[];
}

export interface ValidateBillingOptions {
  strictOrigin?: boolean;
}

export const INTENDED_PLANS = [
  { id: 'free', name: 'Free', priceUsd: 0, credits: 10, interval: 'free_trial', envVar: null },
  { id: 'creator', name: 'Creator', priceUsd: 9, credits: 30, interval: 'month', envVar: 'STRIPE_PRICE_CREATOR' },
  { id: 'pro', name: 'Pro', priceUsd: 19, credits: 75, interval: 'month', envVar: 'STRIPE_PRICE_PRO' },
  { id: 'agency', name: 'Agency', priceUsd: 99, credits: 600, interval: 'month', envVar: 'STRIPE_PRICE_AGENCY' },
  { id: 'audit_once', name: 'One-time Audit', priceUsd: 29, credits: 60, interval: 'one-time', envVar: 'STRIPE_PRICE_AUDIT_ONCE' },
] as const;

/**
 * Safely masks secrets so credentials never leak to logs or terminal.
 * Returns e.g. "sk_live_...12ab" or "***"
 */
export function maskSecret(secret?: string | null): string {
  if (!secret) return '(not set)';
  const trimmed = secret.trim();
  if (trimmed.length <= 12) return '***';
  return `${trimmed.substring(0, 8)}...${trimmed.substring(trimmed.length - 4)}`;
}

/**
 * Authoritative Stripe webhook secret format validator.
 * Enforces that non-empty signing secrets strictly match 'whsec_[a-zA-Z0-9]{16,}'.
 */
export function validateStripeWebhookSecret(secret?: string | null): {
  isValid: boolean;
  error?: string;
} {
  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    return { isValid: false, error: 'Webhook secret is missing or empty' };
  }
  const trimmed = secret.trim();
  const whsecRegex = /^whsec_[a-zA-Z0-9]{16,}$/;
  if (!whsecRegex.test(trimmed)) {
    return {
      isValid: false,
      error: `Malformed Stripe webhook secret format. Expected 'whsec_...' with at least 16 base62 characters, got ${maskSecret(trimmed)}`
    };
  }
  return { isValid: true };
}

/**
 * Validates billing environment configuration
 */
export function validateBillingConfiguration(
  mode: 'production' | 'staging' | 'test' | 'development' | 'ci' = 'production',
  env: NodeJS.ProcessEnv = process.env,
  options: ValidateBillingOptions = {}
): ValidationSummary {
  const issues: ValidationIssue[] = [];

  const envSec = resolveEnvironmentSecurity(env);
  const secretKey = env.STRIPE_SECRET_KEY?.trim() || '';
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || '';
  const paymentProvider = env.PAYMENT_PROVIDER?.trim() || '';
  const paymentMode = envSec.paymentMode;

  const isStagingTarget =
    (mode === 'staging' || (mode !== 'ci' && mode !== 'production' && envSec.isStaging)) &&
    !envSec.requiresLivePayments;

  const hasExplicitLiveSignal =
    envSec.isLivePaymentMode ||
    envSec.hasLiveStripeKey;

  // Escalate to strict live production billing whenever production mode is targeted OR explicit live payment signals are active
  const effectiveProduction =
    mode === 'production' ||
    hasExplicitLiveSignal ||
    (mode !== 'ci' && mode !== 'staging' && envSec.requiresLivePayments);

  // Strict runtime hardening (HTTPS origins, webhooks, MEDIA_TOKEN_SECRET, zero simulation) applies to both staging and production
  const enforceRuntimeHardening = effectiveProduction || isStagingTarget;

  // Flag explicit cross-variable conflicts (DEPLOYMENT_ENV vs NODE_ENV vs PAYMENT_MODE vs target mode)
  for (const conflict of envSec.conflicts) {
    // Key conflicts are emitted in section 1 with maskSecret details below
    if (
      conflict.code === 'TEST_KEY_IN_LIVE_OR_PROD' ||
      conflict.code === 'LIVE_KEY_IN_DEV_OR_TEST' ||
      conflict.code === 'LIVE_KEY_IN_STAGING'
    ) {
      continue;
    }
    issues.push({
      type: 'ERROR',
      variable: conflict.variable,
      message: conflict.message,
    });
  }

  if (mode === 'staging') {
    if (envSec.deploymentEnv && envSec.deploymentEnv !== 'staging') {
      issues.push({
        type: 'ERROR',
        variable: 'DEPLOYMENT_ENV',
        message: `Contradictory environment configuration: DEPLOYMENT_ENV='${envSec.deploymentEnv}' cannot run under '--mode=staging'.`,
      });
    }
    if (envSec.isLivePaymentMode && !envSec.conflicts.some((c) => c.code === 'STAGING_LIVE_PAYMENT_CONFLICT')) {
      issues.push({
        type: 'ERROR',
        variable: 'PAYMENT_MODE',
        message: `Contradictory environment configuration: PAYMENT_MODE='${paymentMode}' is forbidden under '--mode=staging'.`,
      });
    }
  }

  if ((mode === 'test' || mode === 'development') && envSec.isLivePaymentMode) {
    if (!envSec.conflicts.some((c) => c.code === 'DEV_LIVE_PAYMENT_CONFLICT')) {
      issues.push({
        type: 'ERROR',
        variable: 'PAYMENT_MODE',
        message: `Contradictory environment configuration: PAYMENT_MODE='${paymentMode}' cannot run under '${mode}' mode.`,
      });
    }
  }

  if (mode === 'production' && (envSec.nodeEnv === 'development' || envSec.nodeEnv === 'test')) {
    issues.push({
      type: 'ERROR',
      variable: 'NODE_ENV',
      message: `Contradictory environment configuration: NODE_ENV='${envSec.nodeEnv}' cannot be combined with production evaluation mode.`,
    });
  }

  if (mode === 'production' && envSec.isExplicitStaging) {
    issues.push({
      type: 'ERROR',
      variable: 'DEPLOYMENT_ENV',
      message: `Contradictory environment configuration: DEPLOYMENT_ENV='staging' cannot satisfy '--mode=production'.`,
    });
  }

  // 1. Stripe Secret Key Validation (canonical format validation across all modes)
  const keyValidation = validateStripeSecretKeyFormat(secretKey);
  if (!keyValidation.present) {
    if (effectiveProduction) {
      issues.push({
        type: 'ERROR',
        variable: 'STRIPE_SECRET_KEY',
        message: 'Missing required Stripe secret key in production environment.',
      });
    } else if (isStagingTarget) {
      issues.push({
        type: 'ERROR',
        variable: 'STRIPE_SECRET_KEY',
        message: 'Missing required Stripe test secret key (expected sk_test_... or rk_test_...) in staging environment.',
      });
    } else if (mode === 'test') {
      issues.push({
        type: 'ERROR',
        variable: 'STRIPE_SECRET_KEY',
        message: 'Missing Stripe test secret key (expected sk_test_... or rk_test_...).',
      });
    } else if (mode === 'ci') {
      issues.push({
        type: 'INFO',
        variable: 'STRIPE_SECRET_KEY',
        message: 'CI environment validation: STRIPE_SECRET_KEY not set in CI runner. Static price mappings and plan contracts validated.',
      });
    } else {
      issues.push({
        type: 'WARNING',
        variable: 'STRIPE_SECRET_KEY',
        message: 'STRIPE_SECRET_KEY not set. Development server will operate in simulation mode.',
      });
    }
  } else if (!keyValidation.validFormat) {
    issues.push({
      type: 'ERROR',
      variable: 'STRIPE_SECRET_KEY',
      message: `Malformed Stripe secret key (${maskSecret(secretKey)}): expected 'sk_live_...', 'rk_live_...', 'sk_test_...', or 'rk_test_...' with at least 10 token characters.`,
    });
  } else {
    const isLiveKey = keyValidation.mode === 'live';
    const isTestKey = keyValidation.mode === 'test';

    const isNonProdContext =
      mode === 'staging' ||
      mode === 'test' ||
      mode === 'development' ||
      envSec.isStaging ||
      envSec.nodeEnv === 'development' ||
      envSec.nodeEnv === 'test' ||
      paymentMode === 'test' ||
      paymentMode === 'simulation';

    if (isStagingTarget && !effectiveProduction) {
      if (isLiveKey) {
        issues.push({
          type: 'ERROR',
          variable: 'STRIPE_SECRET_KEY',
          message: `Accidental live key (${maskSecret(secretKey)}) in staging mode! Staging strictly requires sk_test_... or rk_test_... to prevent real charges.`,
        });
      }
    } else if (isNonProdContext) {
      if (isLiveKey) {
        issues.push({
          type: 'ERROR',
          variable: 'STRIPE_SECRET_KEY',
          message: `Accidental live key (${maskSecret(secretKey)}) in ${mode} mode! Non-production mode must use sk_test_... or rk_test_... to prevent real credit card charges.`,
        });
      } else if (effectiveProduction && isTestKey) {
        issues.push({
          type: 'ERROR',
          variable: 'STRIPE_SECRET_KEY',
          message: `Contradictory environment configuration: Test key (${maskSecret(secretKey)}) found in production mode. Production strictly requires a live key (sk_live_... or rk_live_...).`,
        });
      }
    } else if (effectiveProduction && isTestKey) {
      issues.push({
        type: 'ERROR',
        variable: 'STRIPE_SECRET_KEY',
        message: `Contradictory environment configuration: Test key (${maskSecret(secretKey)}) found in production mode. Production strictly requires a live key (sk_live_... or rk_live_...).`,
      });
    }
  }

  // 2. Stripe Webhook Secret Validation
  if (!webhookSecret) {
    if (enforceRuntimeHardening) {
      issues.push({
        type: 'ERROR',
        variable: 'STRIPE_WEBHOOK_SECRET',
        message: isStagingTarget
          ? 'Missing required STRIPE_WEBHOOK_SECRET in staging. Stripe webhook signature verification will fail closed.'
          : 'Missing required STRIPE_WEBHOOK_SECRET in production. Stripe webhook signature verification will fail closed.',
      });
    } else if (mode === 'test') {
      issues.push({
        type: 'WARNING',
        variable: 'STRIPE_WEBHOOK_SECRET',
        message: 'STRIPE_WEBHOOK_SECRET is recommended in test mode to verify webhook signature handling with Stripe CLI.',
      });
    }
  } else {
    const whsecValidation = validateStripeWebhookSecret(webhookSecret);
    if (!whsecValidation.isValid) {
      issues.push({
        type: 'ERROR',
        variable: 'STRIPE_WEBHOOK_SECRET',
        message: whsecValidation.error || `Malformed STRIPE_WEBHOOK_SECRET: signing secrets must begin with 'whsec_'. Found: ${maskSecret(webhookSecret)}.`,
      });
    }
  }

  // 3. Price IDs for All Paid Plans
  const paidPlans = INTENDED_PLANS.filter((p) => p.envVar !== null);
  for (const plan of paidPlans) {
    const priceId = env[plan.envVar!]?.trim() || '';

    if (!priceId) {
      if (effectiveProduction) {
        issues.push({
          type: 'ERROR',
          variable: plan.envVar!,
          message: `Missing Stripe Price ID for ${plan.name} plan ($${plan.priceUsd}, ${plan.credits} credits). Set ${plan.envVar}=price_... in production.`,
        });
      } else if (isStagingTarget || mode === 'test') {
        issues.push({
          type: 'WARNING',
          variable: plan.envVar!,
          message: `Missing test Price ID for ${plan.name} plan. Checkout falls back to inline price_data, but customer.subscription.* webhooks in staging require a configured Test Mode price_... ID.`,
        });
      }
    } else {
      if (!/^price_[A-Za-z0-9_]+$/.test(priceId)) {
        issues.push({
          type: 'ERROR',
          variable: plan.envVar!,
          message: `Malformed Price ID for ${plan.name}: expected 'price_...' format. Found: ${maskSecret(priceId)}.`,
        });
      }
    }
  }

  // 4. Payment Provider & Mode Cohesion
  if (paymentProvider && paymentProvider.toLowerCase() !== 'stripe') {
    issues.push({
      type: 'WARNING',
      variable: 'PAYMENT_PROVIDER',
      message: `PAYMENT_PROVIDER is set to '${paymentProvider}'. Only 'stripe' is natively supported in this version.`,
    });
  }

  if (enforceRuntimeHardening && paymentMode === 'simulation') {
    issues.push({
      type: 'ERROR',
      variable: 'PAYMENT_MODE',
      message: "PAYMENT_MODE='simulation' is strictly forbidden in production/staging/live mode.",
    });
  }

  // 5. Application Origin & Redirect Security (APP_BASE_URL / APP_URL / PUBLIC_APP_URL / ALLOWED_ORIGINS)
  const originCfg = resolveConfiguredAppOrigin(env);
  if (!originCfg.rawOrigin) {
    if (enforceRuntimeHardening) {
      issues.push({
        type: 'ERROR',
        variable: 'APP_BASE_URL',
        message: isStagingTarget
          ? 'Missing required APP_BASE_URL (or valid HTTPS origin fallback) in staging environment. Checkout & portal redirects require an explicit non-localhost HTTPS origin.'
          : 'Missing required APP_BASE_URL (or valid HTTPS origin fallback) in production environment. Checkout & portal redirects fail closed until an explicit non-localhost HTTPS origin is configured.',
      });
    } else if (mode === 'test') {
      issues.push({
        type: 'WARNING',
        variable: 'APP_BASE_URL',
        message: 'APP_BASE_URL not set in test mode; canonical fallback https://videorisk.com will be used.',
      });
    } else {
      issues.push({
        type: 'INFO',
        variable: 'APP_BASE_URL',
        message: 'APP_BASE_URL not set; local development preview fallback (http://localhost:3000 / https://videorisk.com) remains active.',
      });
    }
  } else {
    const activeOriginVar = originCfg.variable!;
    const originCheck = validateAppOriginUrl(originCfg.rawOrigin, enforceRuntimeHardening, activeOriginVar);
    if (!originCheck.valid) {
      issues.push({
        type: 'ERROR',
        variable: activeOriginVar,
        message: originCheck.message,
      });
    } else if (originCfg.hasExplicitAppBaseUrl) {
      if (originCfg.hasAppUrlFallback || originCfg.hasPublicAppUrlFallback) {
        issues.push({
          type: 'INFO',
          variable: 'APP_BASE_URL',
          message: `Explicit APP_BASE_URL (${originCheck.origin}) overrides fallback origin variable(s).`,
        });
      }
    } else {
      // Origin satisfied via APP_URL or PUBLIC_APP_URL fallback while APP_BASE_URL itself is unset
      if (options.strictOrigin) {
        issues.push({
          type: 'ERROR',
          variable: 'APP_BASE_URL',
          message: `Strict origin validation (--strict-origin) requires explicit APP_BASE_URL; only fallback ${activeOriginVar} (${originCheck.origin}) is currently configured.`,
        });
      } else if (enforceRuntimeHardening) {
        issues.push({
          type: 'WARNING',
          variable: 'APP_BASE_URL',
          message: `Application origin requirement satisfied via fallback ${activeOriginVar} (${originCheck.origin}); APP_BASE_URL itself is not explicitly set. Set explicit APP_BASE_URL before production deployment.`,
        });
      } else {
        issues.push({
          type: 'INFO',
          variable: activeOriginVar,
          message: `Development/preview origin satisfied via ${activeOriginVar} (${originCheck.origin}); APP_BASE_URL itself is unset.`,
        });
      }
    }
  }

  const allowedOriginsRaw = env.ALLOWED_ORIGINS?.trim() || '';
  if (allowedOriginsRaw) {
    for (const entry of allowedOriginsRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const allowedCheck = validateAppOriginUrl(entry, enforceRuntimeHardening, 'ALLOWED_ORIGINS');
      if (!allowedCheck.valid) {
        issues.push({
          type: 'ERROR',
          variable: 'ALLOWED_ORIGINS',
          message: allowedCheck.message,
        });
      }
    }
  }

  // 6. Media Access Token Secret Validation (shared canonical rule with runtime API & readiness)
  const mediaSecretValidation = validateMediaTokenSecret(env.MEDIA_TOKEN_SECRET, enforceRuntimeHardening);
  if (!mediaSecretValidation.valid) {
    issues.push({
      type: 'ERROR',
      variable: 'MEDIA_TOKEN_SECRET',
      message: mediaSecretValidation.message,
    });
  } else if (mediaSecretValidation.severity === 'INFO') {
    issues.push({
      type: 'INFO',
      variable: 'MEDIA_TOKEN_SECRET',
      message: mediaSecretValidation.message,
    });
  }

  // 7. Optional Password Reset Email Delivery (SMTP — never required for server startup, required for real reset email)
  const smtpResolution = resolveSmtpConfiguration(env);
  if (!smtpResolution.configured) {
    const reason = smtpResolution.reason || 'SMTP_INVALID';
    if (reason === 'SMTP_NOT_CONFIGURED') {
      if (enforceRuntimeHardening) {
        issues.push({
          type: 'WARNING',
          variable: 'SMTP_HOST',
          message:
            'Optional SMTP email delivery is not configured (server startup succeeds, but real password-reset emails will not be delivered until SMTP_HOST, SMTP_FROM, and credentials are configured and live-verified).',
        });
      } else {
        issues.push({
          type: 'INFO',
          variable: 'SMTP_HOST',
          message: 'SMTP_HOST not set; password-reset email dispatch is disabled.',
        });
      }
    } else {
      let targetVar = 'SMTP_HOST';
      let detailMsg = `Invalid SMTP configuration (${reason}).`;
      if (reason === 'SMTP_HOST_MISSING') {
        targetVar = 'SMTP_HOST';
        detailMsg =
          'Orphan SMTP credentials detected: SMTP_USER and/or SMTP_PASS are configured without SMTP_HOST (credential values redacted).';
      } else if (reason === 'SMTP_AUTH_INCOMPLETE') {
        targetVar = (env.SMTP_USER || '').trim() ? 'SMTP_PASS' : 'SMTP_USER';
        detailMsg = 'Incomplete SMTP credentials: both SMTP_USER and SMTP_PASS must be set together (values redacted).';
      } else if (reason === 'INVALID_SMTP_PORT') {
        targetVar = 'SMTP_PORT';
        detailMsg = 'Invalid SMTP_PORT: expected integer port 1-65535.';
      } else if (reason === 'INVALID_SMTP_SECURE') {
        targetVar = 'SMTP_SECURE';
        detailMsg = "Invalid SMTP_SECURE: expected 'true' or 'false'.";
      } else if (reason === 'MISSING_SMTP_FROM' || reason === 'INVALID_SMTP_FROM') {
        targetVar = 'SMTP_FROM';
        detailMsg = 'Missing or invalid SMTP_FROM / EMAIL_FROM sender address.';
      }
      issues.push({
        type: 'ERROR',
        variable: targetVar,
        message: detailMsg,
      });
    }
  } else {
    issues.push({
      type: 'INFO',
      variable: 'SMTP_HOST',
      message: 'SMTP settings syntax-validated (verify live password-reset email delivery before enabling Password Reset or Production).',
    });
  }

  // 8. Owner & Admin User ID validation (only flags errors/warnings when misconfigured)
  const rawOwnerId = env.OWNER_USER_ID?.trim() || '';
  if (rawOwnerId && !isValidInternalUserId(rawOwnerId)) {
    issues.push({
      type: 'ERROR',
      variable: 'OWNER_USER_ID',
      message: 'OWNER_USER_ID must be a valid internal User ID (e.g. usr_...), never an email address or whitespace.',
    });
  }

  const rawAdminUserIds = env.ADMIN_USER_IDS?.trim() || '';
  if (rawAdminUserIds) {
    const entries = rawAdminUserIds.split(',').map((s) => s.trim()).filter(Boolean);
    if (entries.length === 0 || entries.some((entry) => !isValidInternalUserId(entry))) {
      issues.push({
        type: 'ERROR',
        variable: 'ADMIN_USER_IDS',
        message: 'ADMIN_USER_IDS must be a comma-separated list of valid internal User IDs, never email addresses.',
      });
    }
  }

  if (env.ADMIN_EMAILS && env.ADMIN_EMAILS.trim().length > 0) {
    issues.push({
      type: 'WARNING',
      variable: 'ADMIN_EMAILS',
      message: 'ADMIN_EMAILS is deprecated and ignored for authorization; configure OWNER_USER_ID and ADMIN_USER_IDS with internal User IDs.',
    });
  }

  // 9. Rate Limit Configuration & Precedence Validation
  for (const spec of RATE_LIMIT_POLICY_SPECS) {
    const rawPrimary = env[spec.primaryVar];
    const primarySet = typeof rawPrimary === 'string' && rawPrimary.trim().length > 0;
    const primaryValid = primarySet ? parseStrictPositiveInt(rawPrimary) !== null : true;

    if (primarySet && !primaryValid) {
      issues.push({
        type: 'WARNING',
        variable: spec.primaryVar,
        message: `Invalid positive integer in ${spec.primaryVar}; runtime rejects invalid value and falls back to ${spec.fallbackVar || `default (${spec.defaultValue})`}.`,
      });
    }

    if (spec.fallbackVar) {
      const rawFallback = env[spec.fallbackVar];
      const fallbackSet = typeof rawFallback === 'string' && rawFallback.trim().length > 0;
      const fallbackValid = fallbackSet ? parseStrictPositiveInt(rawFallback) !== null : true;
      if (fallbackSet && !fallbackValid) {
        issues.push({
          type: 'WARNING',
          variable: spec.fallbackVar,
          message: `Invalid positive integer in ${spec.fallbackVar}; runtime ignores invalid legacy value and uses ${spec.primaryVar} or default (${spec.defaultValue}).`,
        });
      }
      if (primarySet && primaryValid && fallbackSet && fallbackValid && rawPrimary!.trim() !== rawFallback!.trim()) {
        issues.push({
          type: 'INFO',
          variable: spec.primaryVar,
          message: `Both ${spec.primaryVar} and legacy ${spec.fallbackVar} are configured; ${spec.primaryVar} takes precedence.`,
        });
      }
    }
  }

  // 10. Storage Engine, Reverse Proxy Trust, and Simulation Webhook Guardrails
  const storageEngine = (env.STORAGE_ENGINE || '').trim().toLowerCase();
  if (storageEngine && storageEngine !== 'sqlite' && storageEngine !== 'memory') {
    issues.push({
      type: 'ERROR',
      variable: 'STORAGE_ENGINE',
      message: `Unrecognized STORAGE_ENGINE='${storageEngine}'. Allowed values are 'sqlite' or 'memory'.`,
    });
  } else if (storageEngine === 'memory') {
    if (enforceRuntimeHardening) {
      issues.push({
        type: 'ERROR',
        variable: 'STORAGE_ENGINE',
        message: "STORAGE_ENGINE='memory' is strictly forbidden in staging and production; durable 'sqlite' storage is required.",
      });
    } else {
      issues.push({
        type: 'INFO',
        variable: 'STORAGE_ENGINE',
        message: "STORAGE_ENGINE='memory' active (ephemeral non-persistent storage for dev/test).",
      });
    }
  }

  const trustProxyCheck = validateTrustProxyValue(env.TRUST_PROXY);
  if (!trustProxyCheck.valid) {
    issues.push({
      type: 'ERROR',
      variable: 'TRUST_PROXY',
      message: trustProxyCheck.error || 'Invalid TRUST_PROXY syntax.',
    });
  } else if (trustProxyCheck.warning) {
    issues.push({
      type: 'WARNING',
      variable: 'TRUST_PROXY',
      message: trustProxyCheck.warning,
    });
  }

  const rawSimWebhook = (env.ALLOW_SIMULATION_WEBHOOK || '').trim().toLowerCase();
  if (rawSimWebhook && rawSimWebhook !== 'true' && rawSimWebhook !== 'false') {
    issues.push({
      type: 'ERROR',
      variable: 'ALLOW_SIMULATION_WEBHOOK',
      message: "Invalid ALLOW_SIMULATION_WEBHOOK value; expected 'true' or 'false'.",
    });
  } else if (rawSimWebhook === 'true') {
    if (enforceRuntimeHardening) {
      issues.push({
        type: 'ERROR',
        variable: 'ALLOW_SIMULATION_WEBHOOK',
        message: "ALLOW_SIMULATION_WEBHOOK='true' is strictly forbidden in staging and production environments.",
      });
    } else {
      issues.push({
        type: 'WARNING',
        variable: 'ALLOW_SIMULATION_WEBHOOK',
        message: "ALLOW_SIMULATION_WEBHOOK='true' enables unsigned simulation webhooks in non-production.",
      });
    }
  }

  // 11. Local Media, OCR, and Speech-to-Text Executable / Model Checks
  const checkBinaryTool = (binaryName: string, envVar: string, requiredForMedia: boolean) => {
    const res = resolveExecutable(binaryName, envVar, env);
    if (res.configured) {
      if (res.status === 'READY') {
        issues.push({
          type: 'INFO',
          variable: envVar,
          message: `${envVar} is configured and executable.`,
        });
      } else if (res.status === 'NON_EXECUTABLE') {
        issues.push({
          type: 'ERROR',
          variable: envVar,
          message: `${envVar} points to a non-executable or non-file path.`,
        });
      } else {
        issues.push({
          type: 'ERROR',
          variable: envVar,
          message: `${envVar} points to a missing executable path.`,
        });
      }
      return true;
    }

    if (res.status === 'READY') {
      issues.push({
        type: 'INFO',
        variable: envVar,
        message: `${envVar} is unset; resolved system '${binaryName}' from PATH.`,
      });
      return true;
    }

    if (requiredForMedia && enforceRuntimeHardening) {
      issues.push({
        type: 'WARNING',
        variable: envVar,
        message: `${envVar} is not configured and '${binaryName}' was not found on PATH; media inspection/processing requires ${binaryName}.`,
      });
    } else {
      issues.push({
        type: 'NOT CONFIGURED',
        variable: envVar,
        message: `${envVar} is not configured and '${binaryName}' was not found on PATH; dependent detector reports NOT_ASSESSED or unavailable.`,
      });
    }
    return false;
  };

  checkBinaryTool('ffmpeg', 'FFMPEG_PATH', true);
  checkBinaryTool('ffprobe', 'FFPROBE_PATH', true);
  checkBinaryTool('tesseract', 'TESSERACT_PATH', false);

  const rawWhisperPath = (env.WHISPER_PATH || '').trim();
  const rawLocalSttPath = (env.LOCAL_STT_PATH || '').trim();
  let hasConfiguredSttBinary = false;

  if (rawWhisperPath) {
    hasConfiguredSttBinary = true;
    const whisperRes = resolveExecutable('whisper', 'WHISPER_PATH', env);
    if (whisperRes.status === 'READY') {
      issues.push({
        type: 'INFO',
        variable: 'WHISPER_PATH',
        message: 'WHISPER_PATH is configured and executable.',
      });
    } else {
      issues.push({
        type: 'ERROR',
        variable: 'WHISPER_PATH',
        message:
          whisperRes.status === 'NON_EXECUTABLE'
            ? 'WHISPER_PATH points to a non-executable or non-file path.'
            : 'WHISPER_PATH points to a missing executable path.',
      });
    }
  }

  if (rawLocalSttPath) {
    hasConfiguredSttBinary = true;
    const localSttRes = resolveExecutable('whisper', 'LOCAL_STT_PATH', env);
    if (localSttRes.status === 'READY') {
      issues.push({
        type: 'INFO',
        variable: 'LOCAL_STT_PATH',
        message: 'LOCAL_STT_PATH is configured and executable.',
      });
    } else {
      issues.push({
        type: 'ERROR',
        variable: 'LOCAL_STT_PATH',
        message:
          localSttRes.status === 'NON_EXECUTABLE'
            ? 'LOCAL_STT_PATH points to a non-executable or non-file path.'
            : 'LOCAL_STT_PATH points to a missing executable path.',
      });
    }
  }

  if (!hasConfiguredSttBinary) {
    issues.push({
      type: 'NOT CONFIGURED',
      variable: 'WHISPER_PATH',
      message: 'Optional local Whisper STT binary (WHISPER_PATH / LOCAL_STT_PATH) is not configured; speech transcription remains NOT_ASSESSED.',
    });
  }

  const rawWhisperModelPath = (env.WHISPER_MODEL_PATH || '').trim();
  if (rawWhisperModelPath) {
    try {
      const modelStat = fs.statSync(rawWhisperModelPath);
      if (!modelStat.isFile() || modelStat.size <= 0) {
        issues.push({
          type: 'ERROR',
          variable: 'WHISPER_MODEL_PATH',
          message: 'WHISPER_MODEL_PATH must point to a readable non-empty model file.',
        });
      } else {
        issues.push({
          type: 'INFO',
          variable: 'WHISPER_MODEL_PATH',
          message: 'WHISPER_MODEL_PATH exists and is a non-empty file.',
        });
      }
    } catch {
      issues.push({
        type: 'ERROR',
        variable: 'WHISPER_MODEL_PATH',
        message: 'WHISPER_MODEL_PATH points to a missing or inaccessible model file.',
      });
    }
  } else if (hasConfiguredSttBinary) {
    issues.push({
      type: 'WARNING',
      variable: 'WHISPER_MODEL_PATH',
      message: 'WHISPER_MODEL_PATH is not configured alongside local Whisper STT binary.',
    });
  } else {
    issues.push({
      type: 'NOT CONFIGURED',
      variable: 'WHISPER_MODEL_PATH',
      message: 'Optional Whisper model file (WHISPER_MODEL_PATH) is not configured.',
    });
  }

  const rawMusicClassifierPath = (env.MUSIC_CLASSIFIER_PATH || '').trim();
  if (rawMusicClassifierPath) {
    const musicRes = resolveExecutable('music-classifier', 'MUSIC_CLASSIFIER_PATH', env);
    if (musicRes.status === 'READY') {
      issues.push({
        type: 'INFO',
        variable: 'MUSIC_CLASSIFIER_PATH',
        message: 'MUSIC_CLASSIFIER_PATH is configured and executable.',
      });
    } else {
      issues.push({
        type: 'ERROR',
        variable: 'MUSIC_CLASSIFIER_PATH',
        message:
          musicRes.status === 'NON_EXECUTABLE'
            ? 'MUSIC_CLASSIFIER_PATH points to a non-executable or non-file path.'
            : 'MUSIC_CLASSIFIER_PATH points to a missing executable path.',
      });
    }
  } else {
    issues.push({
      type: 'NOT CONFIGURED',
      variable: 'MUSIC_CLASSIFIER_PATH',
      message: 'Optional local music classifier (MUSIC_CLASSIFIER_PATH) is not configured.',
    });
  }

  const errorsCount = issues.filter((i) => i.type === 'ERROR').length;
  const warningsCount = issues.filter((i) => i.type === 'WARNING').length;
  const notConfiguredCount = issues.filter((i) => i.type === 'NOT CONFIGURED').length;

  return {
    mode,
    valid: errorsCount === 0,
    errorsCount,
    warningsCount,
    notConfiguredCount,
    issues,
  };
}

/**
 * Strips or redacts any secret tokens (sk_..., rk_..., whsec_..., Bearer ...) from text.
 */
export function sanitizeLogOutput(text: string, knownSecrets: (string | undefined | null)[] = []): string {
  let sanitized = text;
  for (const s of knownSecrets) {
    if (s && s.trim().length > 6) {
      sanitized = sanitized.split(s.trim()).join(maskSecret(s));
    }
  }
  sanitized = sanitized.replace(/(sk_live_|sk_test_|rk_live_|rk_test_|whsec_)[a-zA-Z0-9_]{6,}/g, (match) => maskSecret(match));
  sanitized = sanitized.replace(/Bearer\s+([a-zA-Z0-9_\-\.]{8,})/gi, 'Bearer [REDACTED]');
  return sanitized;
}

/**
 * Optional live Stripe API check. Only executes when explicitly requested and authorized.
 */
export async function performLiveStripeCheck(
  secretKey: string,
  stripeClientFactory?: (key: string) => any
): Promise<{ success: boolean; message: string; livemode?: boolean }> {
  try {
    const stripe = stripeClientFactory
      ? stripeClientFactory(secretKey)
      : new Stripe(secretKey, {
          apiVersion: '2025-02-24.acacia' as any,
        });
    const balance = await stripe.balance.retrieve();
    const livemode = Boolean(balance?.livemode);
    const modeLabel = livemode ? 'LIVE' : 'TEST';
    return {
      success: true,
      livemode,
      message: `Successfully connected to Stripe API in ${modeLabel} mode. Live balance object retrieved.`,
    };
  } catch (err: any) {
    const rawMsg = err?.message || String(err);
    const sanitizedMsg = sanitizeLogOutput(rawMsg, [secretKey]);
    return {
      success: false,
      message: `Stripe API connection failed: ${sanitizedMsg}`,
    };
  }
}

/**
 * CLI Entrypoint
 */
export async function runValidatorCli(
  cliArgs?: string[],
  cliEnv?: NodeJS.ProcessEnv,
  stripeClientFactory?: (key: string) => any
): Promise<number> {
  const args = cliArgs || process.argv.slice(2);
  const env = cliEnv || process.env;
  let mode: 'production' | 'staging' | 'test' | 'development' | 'ci' = 'production';

  for (const arg of args) {
    if (arg === '--mode=production') mode = 'production';
    if (arg === '--mode=staging') mode = 'staging';
    if (arg === '--mode=test') mode = 'test';
    if (arg === '--mode=development') mode = 'development';
    if (arg === '--mode=ci') mode = 'ci';
  }

  if (!args.some((a) => a.startsWith('--mode='))) {
    const depEnv = (env.DEPLOYMENT_ENV || '').trim().toLowerCase();
    if (env.CI === 'true') mode = 'ci';
    else if (depEnv === 'staging') mode = 'staging';
    else if (env.NODE_ENV === 'test' || depEnv === 'test') mode = 'test';
    else if (env.NODE_ENV === 'development' || depEnv === 'development') mode = 'development';
    else mode = 'production';
  }

  const strictOrigin = args.includes('--strict-origin');

  console.log('======================================================================');
  console.log('VIDEORISK.COM — BILLING & ENVIRONMENT CONFIGURATION VALIDATOR');
  console.log(`Target Evaluation Mode: [${mode.toUpperCase()}]${strictOrigin ? ' (STRICT ORIGIN)' : ''}`);
  console.log('======================================================================\n');

  console.log('Configured Plans & Entitlements:');
  for (const plan of INTENDED_PLANS) {
    const status = plan.envVar ? (env[plan.envVar] ? maskSecret(env[plan.envVar]) : '(not configured)') : 'N/A (Free)';
    console.log(`  • ${plan.name.padEnd(16)}: $${plan.priceUsd.toString().padStart(2)} / ${plan.credits.toString().padStart(3)} credits [${plan.interval}] -> ${plan.envVar || 'None'}: ${status}`);
  }
  console.log();

  const summary = validateBillingConfiguration(mode, env, { strictOrigin });

  if (summary.issues.length === 0) {
    console.log(`✅ All ${mode} configuration checks PASSED with 0 errors and 0 warnings.\n`);
  } else {
    for (const issue of summary.issues) {
      const icon =
        issue.type === 'ERROR'
          ? '❌'
          : issue.type === 'WARNING'
            ? '⚠️ '
            : issue.type === 'NOT CONFIGURED'
              ? '⚪'
              : 'ℹ️ ';
      console.log(`${icon} [${issue.type}] ${issue.variable}: ${issue.message}`);
    }
    console.log();
  }

  // Check if live API check was requested
  const isLiveCheckRequested = args.includes('--live-check') || args.includes('--verify-api');
  let liveCheckPassed = true;
  let liveCheckError: string | null = null;

  if (isLiveCheckRequested) {
    const secretKey = env.STRIPE_SECRET_KEY?.trim() || '';
    if (env.ALLOW_LIVE_STRIPE_CHECK !== 'true') {
      liveCheckError = 'Live API check requested, but ALLOW_LIVE_STRIPE_CHECK is not set to "true". Refusing to make live calls without explicit authorization.';
      console.error(`❌ [LIVE-CHECK ERROR] ${liveCheckError}\n`);
      liveCheckPassed = false;
    } else if (!secretKey) {
      liveCheckError = 'Live API check requested, but STRIPE_SECRET_KEY is empty or not configured.';
      console.error(`❌ [LIVE-CHECK ERROR] ${liveCheckError}\n`);
      liveCheckPassed = false;
    } else {
      console.log('Executing authorized read-only Stripe API balance verification...');
      const liveResult = await performLiveStripeCheck(secretKey, stripeClientFactory);
      if (liveResult.success) {
        console.log(`✅ [LIVE-CHECK SUCCESS] ${liveResult.message}\n`);
      } else {
        liveCheckError = liveResult.message;
        console.error(`❌ [LIVE-CHECK ERROR] ${liveResult.message}\n`);
        liveCheckPassed = false;
      }
    }
  }

  console.log('----------------------------------------------------------------------');
  console.log('VERIFICATION BOUNDARY NOTICE:');
  console.log('This validator verifies static environment configuration, key formats,');
  console.log('plan price mappings, and test/live mode separation.');
  console.log('It does NOT prove that a live payment or webhook delivery has succeeded.');
  console.log('Before production launch, execute a test checkout using the Stripe CLI:');
  console.log('  stripe listen --forward-to localhost:3000/api/billing/webhook');
  console.log('  stripe trigger payment_intent.succeeded');
  console.log('----------------------------------------------------------------------');

  if (!summary.valid) {
    console.error(`\n❌ Configuration validation FAILED with ${summary.errorsCount} error(s), ${summary.warningsCount} warning(s), ${summary.notConfiguredCount} not configured.\n`);
    return 1;
  }

  if (isLiveCheckRequested && !liveCheckPassed) {
    console.error(`\n❌ Live check failed or was unauthorized: ${liveCheckError || 'Live verification failed.'}\n`);
    return 1;
  }

  console.log(`\n✅ Configuration validation SUCCESSFUL for ${mode} mode (${summary.warningsCount} warning(s), ${summary.notConfiguredCount} not configured)${isLiveCheckRequested ? ' (Live check passed)' : ''}.\n`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('validate-env.ts')) {
  runValidatorCli()
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err) => {
      console.error('Validator execution error:', err);
      process.exit(1);
    });
}
