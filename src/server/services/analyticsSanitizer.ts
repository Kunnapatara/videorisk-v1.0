import {
  AnalyticsConversionRate,
  AnalyticsEventName,
  AnalyticsFunnelDailyEntry,
  AnalyticsFunnelStageMetrics,
  AnalyticsFunnelSummary,
} from '../../types';

export const ANALYTICS_EVENT_VERSION = 1;

export const ANALYTICS_EVENT_NAMES: readonly AnalyticsEventName[] = [
  'user_registered',
  'trial_activated',
  'purchase_completed',
  'analysis_started',
  'analysis_completed',
  'analysis_failed',
] as const;

const ANALYTICS_EVENT_NAME_SET = new Set<string>(ANALYTICS_EVENT_NAMES);

const SENSITIVE_KEY_REGEX =
  /(password|passhash|salt|token|secret|apikey|api_key|stripekey|stripe_key|webhook|creditcard|credit_card|cardnumber|card_number|cvv|cvc|ssn|authorization|cookie|rawbody|raw_body|videopath|video_path|videofilename|video_filename|thumbnailpath|thumbnail_path|thumbnailfilename|thumbnail_filename|proxypath|proxy_path|filepath|file_path|filename|transcript|videotitle|video_title|videodescription|video_description|email|phone|address|ipaddress|ip_address)/i;

const SECRET_VALUE_REGEX = /(sk_live_|sk_test_|rk_live_|rk_test_|whsec_|vr_sess_|Bearer\s+[A-Za-z0-9._-]+)/i;

const ALLOWED_PROPERTIES_BY_EVENT: Record<AnalyticsEventName, Set<string>> = {
  user_registered: new Set(['registrationMethod']),
  trial_activated: new Set(['trialType', 'grantedCredits']),
  purchase_completed: new Set([
    'purchaseType',
    'planId',
    'previousPlanId',
    'currency',
    'amountMinorUnits',
    'paymentProvider',
    'purchaseRef',
  ]),
  analysis_started: new Set(['analysisId', 'analysisMode', 'isRescan']),
  analysis_completed: new Set([
    'analysisId',
    'analysisMode',
    'processingStatus',
    'processingDurationMs',
    'isRescan',
  ]),
  analysis_failed: new Set([
    'analysisId',
    'analysisMode',
    'processingStatus',
    'processingDurationMs',
    'failureCategory',
    'isRescan',
  ]),
};

export function isValidAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && ANALYTICS_EVENT_NAME_SET.has(value);
}

export function sanitizeAnalyticsProperties(
  rawProps: unknown,
  eventName?: AnalyticsEventName,
  options: { enforceEventAllowlist?: boolean } = {}
): Record<string, unknown> {
  if (!rawProps || typeof rawProps !== 'object' || Array.isArray(rawProps)) {
    return {};
  }

  const allowlist = options.enforceEventAllowlist && eventName
    ? ALLOWED_PROPERTIES_BY_EVENT[eventName]
    : null;

  const clean: Record<string, unknown> = {};
  let keysAccepted = 0;

  for (const [key, val] of Object.entries(rawProps as Record<string, unknown>)) {
    if (keysAccepted >= 20) break;
    if (!key || typeof key !== 'string') continue;
    if (SENSITIVE_KEY_REGEX.test(key)) continue;
    if (allowlist && !allowlist.has(key)) continue;

    if (val === undefined) continue;
    if (val === null || typeof val === 'boolean') {
      clean[key] = val;
      keysAccepted++;
      continue;
    }
    if (typeof val === 'number') {
      if (Number.isFinite(val)) {
        clean[key] = val;
        keysAccepted++;
      }
      continue;
    }
    if (typeof val === 'string') {
      if (SECRET_VALUE_REGEX.test(val)) {
        continue;
      }
      clean[key] = val.trim().slice(0, 256);
      keysAccepted++;
      continue;
    }
  }

  return clean;
}

export function emptyStageMetrics(): AnalyticsFunnelStageMetrics {
  return { eventCount: 0, uniqueUsers: 0 };
}

export function createEmptyFunnelStages(): AnalyticsFunnelSummary['stages'] {
  return {
    user_registered: emptyStageMetrics(),
    trial_activated: emptyStageMetrics(),
    purchase_completed: emptyStageMetrics(),
    analysis_started: emptyStageMetrics(),
    analysis_completed: emptyStageMetrics(),
    analysis_failed: emptyStageMetrics(),
  };
}

export function createEmptyDailyEntry(date: string): AnalyticsFunnelDailyEntry {
  return {
    date,
    user_registered: emptyStageMetrics(),
    trial_activated: emptyStageMetrics(),
    purchase_completed: emptyStageMetrics(),
    analysis_started: emptyStageMetrics(),
    analysis_completed: emptyStageMetrics(),
    analysis_failed: emptyStageMetrics(),
  };
}

export function computeRate(numerator: number, denominator: number): AnalyticsConversionRate {
  const safeNum = Math.max(0, Math.trunc(numerator));
  const safeDen = Math.max(0, Math.trunc(denominator));
  if (safeDen <= 0) {
    return { ratePercent: 0, numerator: safeNum, denominator: 0 };
  }
  const ratePercent = Number(((safeNum / safeDen) * 100).toFixed(2));
  return { ratePercent, numerator: safeNum, denominator: safeDen };
}

export function buildFunnelConversionRates(
  stages: AnalyticsFunnelSummary['stages']
): AnalyticsFunnelSummary['conversionRates'] {
  return {
    registrationToTrial: computeRate(stages.trial_activated.uniqueUsers, stages.user_registered.uniqueUsers),
    trialToPurchase: computeRate(stages.purchase_completed.uniqueUsers, stages.trial_activated.uniqueUsers),
    purchaseToAnalysisStarted: computeRate(stages.analysis_started.uniqueUsers, stages.purchase_completed.uniqueUsers),
    analysisStartedToCompleted: computeRate(stages.analysis_completed.uniqueUsers, stages.analysis_started.uniqueUsers),
    registrationToPurchase: computeRate(stages.purchase_completed.uniqueUsers, stages.user_registered.uniqueUsers),
    registrationToAnalysisCompleted: computeRate(stages.analysis_completed.uniqueUsers, stages.user_registered.uniqueUsers),
  };
}
