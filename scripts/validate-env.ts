/**
 * VideoRisk.com — Production Billing & Environment Configuration Validator
 *
 * Validates Stripe environment variables, secret prefixes, price IDs,
 * environment separation, and pricing tier mappings for launch readiness.
 *
 * Usage:
 *   npx tsx scripts/validate-env.ts                     # Production check (default)
 *   npx tsx scripts/validate-env.ts --mode=production  # Explicit production check
 *   npx tsx scripts/validate-env.ts --mode=test        # Test mode check
 *   npx tsx scripts/validate-env.ts --mode=development # Development mode check
 *   npx tsx scripts/validate-env.ts --live-check       # Optional live Stripe API check (requires ALLOW_LIVE_STRIPE_CHECK=true)
 */

import dotenv from 'dotenv';
import Stripe from 'stripe';

dotenv.config();

export interface ValidationIssue {
  type: 'ERROR' | 'WARNING' | 'INFO';
  variable: string;
  message: string;
}

export interface ValidationSummary {
  mode: 'production' | 'test' | 'development';
  valid: boolean;
  errorsCount: number;
  warningsCount: number;
  issues: ValidationIssue[];
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
 * Validates billing environment configuration
 */
export function validateBillingConfiguration(
  mode: 'production' | 'test' | 'development' = 'production',
  env: NodeJS.ProcessEnv = process.env
): ValidationSummary {
  const issues: ValidationIssue[] = [];

  const secretKey = env.STRIPE_SECRET_KEY?.trim() || '';
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || '';
  const paymentProvider = env.PAYMENT_PROVIDER?.trim() || '';
  const paymentMode = env.PAYMENT_MODE?.trim() || '';

  // 1. Stripe Secret Key Validation
  if (!secretKey) {
    if (mode === 'production') {
      issues.push({
        type: 'ERROR',
        variable: 'STRIPE_SECRET_KEY',
        message: 'Missing required Stripe secret key in production environment.',
      });
    } else if (mode === 'test') {
      issues.push({
        type: 'ERROR',
        variable: 'STRIPE_SECRET_KEY',
        message: 'Missing Stripe test secret key (expected sk_test_... or rk_test_...).',
      });
    } else {
      issues.push({
        type: 'WARNING',
        variable: 'STRIPE_SECRET_KEY',
        message: 'STRIPE_SECRET_KEY not set. Development server will operate in simulation mode.',
      });
    }
  } else {
    const isLiveKey = secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
    const isTestKey = secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_');

    if (mode === 'production') {
      if (!isLiveKey) {
        if (isTestKey) {
          issues.push({
            type: 'ERROR',
            variable: 'STRIPE_SECRET_KEY',
            message: `Contradictory environment configuration: Test key (${maskSecret(secretKey)}) found in production mode. Production strictly requires a live key (sk_live_... or rk_live_...).`,
          });
        } else {
          issues.push({
            type: 'ERROR',
            variable: 'STRIPE_SECRET_KEY',
            message: `Malformed Stripe secret key: must begin with 'sk_live_' or 'rk_live_'. Found: ${maskSecret(secretKey)}.`,
          });
        }
      }
    } else if (mode === 'test') {
      if (!isTestKey) {
        if (isLiveKey) {
          issues.push({
            type: 'ERROR',
            variable: 'STRIPE_SECRET_KEY',
            message: `Accidental live key (${maskSecret(secretKey)}) in test mode! Test mode must use sk_test_... or rk_test_... to prevent real credit card charges.`,
          });
        } else {
          issues.push({
            type: 'ERROR',
            variable: 'STRIPE_SECRET_KEY',
            message: `Malformed test key: must begin with 'sk_test_' or 'rk_test_'. Found: ${maskSecret(secretKey)}.`,
          });
        }
      }
    }
  }

  // 2. Stripe Webhook Secret Validation
  if (!webhookSecret) {
    if (mode === 'production') {
      issues.push({
        type: 'ERROR',
        variable: 'STRIPE_WEBHOOK_SECRET',
        message: 'Missing required STRIPE_WEBHOOK_SECRET in production. Stripe webhook signature verification will fail closed.',
      });
    } else if (mode === 'test') {
      issues.push({
        type: 'WARNING',
        variable: 'STRIPE_WEBHOOK_SECRET',
        message: 'STRIPE_WEBHOOK_SECRET is recommended in test mode to verify webhook signature handling with Stripe CLI.',
      });
    }
  } else {
    if (!webhookSecret.startsWith('whsec_')) {
      issues.push({
        type: 'ERROR',
        variable: 'STRIPE_WEBHOOK_SECRET',
        message: `Malformed STRIPE_WEBHOOK_SECRET: signing secrets must begin with 'whsec_'. Found: ${maskSecret(webhookSecret)}.`,
      });
    }
  }

  // 3. Price IDs for All Paid Plans
  const paidPlans = INTENDED_PLANS.filter((p) => p.envVar !== null);
  for (const plan of paidPlans) {
    const priceId = env[plan.envVar!]?.trim() || '';

    if (!priceId) {
      if (mode === 'production') {
        issues.push({
          type: 'ERROR',
          variable: plan.envVar!,
          message: `Missing Stripe Price ID for ${plan.name} plan ($${plan.priceUsd}, ${plan.credits} credits). Set ${plan.envVar}=price_... in production.`,
        });
      } else if (mode === 'test') {
        issues.push({
          type: 'WARNING',
          variable: plan.envVar!,
          message: `Missing test Price ID for ${plan.name} plan. Billing service will dynamically generate test price line items.`,
        });
      }
    } else {
      if (!priceId.startsWith('price_')) {
        issues.push({
          type: 'ERROR',
          variable: plan.envVar!,
          message: `Malformed Price ID for ${plan.name}: expected 'price_...' prefix. Found: ${maskSecret(priceId)}.`,
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

  if (mode === 'production' && paymentMode === 'simulation') {
    issues.push({
      type: 'ERROR',
      variable: 'PAYMENT_MODE',
      message: "PAYMENT_MODE='simulation' is strictly forbidden in production mode. Set to 'live' or leave unset.",
    });
  }

  // 6. Media Access Token Secret Validation
  const mediaTokenSecret = env.MEDIA_TOKEN_SECRET?.trim() || '';
  if (!mediaTokenSecret) {
    if (mode === 'production') {
      issues.push({
        type: 'WARNING',
        variable: 'MEDIA_TOKEN_SECRET',
        message: 'MEDIA_TOKEN_SECRET is not set. Production server startup will fail fast unless MEDIA_TOKEN_SECRET is provided.',
      });
    } else {
      issues.push({
        type: 'INFO',
        variable: 'MEDIA_TOKEN_SECRET',
        message: 'MEDIA_TOKEN_SECRET not set. Development server will operate with per-process random fallback secret.',
      });
    }
  }

  const errorsCount = issues.filter((i) => i.type === 'ERROR').length;
  const warningsCount = issues.filter((i) => i.type === 'WARNING').length;

  return {
    mode,
    valid: errorsCount === 0,
    errorsCount,
    warningsCount,
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
  let mode: 'production' | 'test' | 'development' = 'production';

  for (const arg of args) {
    if (arg === '--mode=production') mode = 'production';
    if (arg === '--mode=test') mode = 'test';
    if (arg === '--mode=development') mode = 'development';
  }

  if (!args.some((a) => a.startsWith('--mode='))) {
    if (env.NODE_ENV === 'test') mode = 'test';
    else if (env.NODE_ENV === 'development') mode = 'development';
    else mode = 'production';
  }

  console.log('======================================================================');
  console.log('VIDEORISK.COM — BILLING & ENVIRONMENT CONFIGURATION VALIDATOR');
  console.log(`Target Evaluation Mode: [${mode.toUpperCase()}]`);
  console.log('======================================================================\n');

  console.log('Configured Plans & Entitlements:');
  for (const plan of INTENDED_PLANS) {
    const status = plan.envVar ? (env[plan.envVar] ? maskSecret(env[plan.envVar]) : '(not configured)') : 'N/A (Free)';
    console.log(`  • ${plan.name.padEnd(16)}: $${plan.priceUsd.toString().padStart(2)} / ${plan.credits.toString().padStart(3)} credits [${plan.interval}] -> ${plan.envVar || 'None'}: ${status}`);
  }
  console.log();

  const summary = validateBillingConfiguration(mode, env);

  if (summary.issues.length === 0) {
    console.log(`✅ All ${mode} configuration checks PASSED with 0 errors and 0 warnings.\n`);
  } else {
    for (const issue of summary.issues) {
      const icon = issue.type === 'ERROR' ? '❌' : issue.type === 'WARNING' ? '⚠️ ' : 'ℹ️ ';
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
    console.error(`\n❌ Configuration validation FAILED with ${summary.errorsCount} error(s).\n`);
    return 1;
  }

  if (isLiveCheckRequested && !liveCheckPassed) {
    console.error(`\n❌ Live check failed or was unauthorized: ${liveCheckError || 'Live verification failed.'}\n`);
    return 1;
  }

  console.log(`\n✅ Configuration validation SUCCESSFUL for ${mode} mode${isLiveCheckRequested ? ' (Live check passed)' : ''}.\n`);
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
