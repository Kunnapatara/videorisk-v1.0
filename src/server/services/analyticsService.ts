import crypto from 'crypto';
import { storage, IStorageRepository, AnalyticsEventInput } from '../storage';
import {
  AnalyticsEventName,
  AnalyticsEventRecord,
  AnalyticsEventsPage,
  AnalyticsFunnelSummary,
  AnalyticsQueryOptions,
} from '../../types';
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_EVENT_VERSION,
  isValidAnalyticsEventName,
  sanitizeAnalyticsProperties,
} from './analyticsSanitizer';

export { ANALYTICS_EVENT_NAMES, ANALYTICS_EVENT_VERSION };

export interface UserRegisteredProperties {
  registrationMethod: 'email_password' | 'oauth' | 'other';
}

export interface TrialActivatedProperties {
  trialType: 'free_starter' | 'free_plan_claim';
  grantedCredits: number;
}

export interface PurchaseCompletedProperties {
  purchaseType: 'credit_purchase' | 'subscription_purchase' | 'subscription_renewal' | 'plan_upgrade';
  planId: string;
  previousPlanId?: string;
  currency?: string;
  amountMinorUnits?: number;
  paymentProvider: 'stripe' | 'stripe_simulation';
  purchaseRef: string;
}

export interface AnalysisStartedProperties {
  analysisId: string;
  analysisMode: 'standard' | 'deep';
  isRescan?: boolean;
}

export interface AnalysisCompletedProperties {
  analysisId: string;
  analysisMode: 'standard' | 'deep';
  processingStatus: 'COMPLETED';
  processingDurationMs: number;
  isRescan?: boolean;
}

export interface AnalysisFailedProperties {
  analysisId: string;
  analysisMode: 'standard' | 'deep';
  processingStatus: 'FAILED';
  processingDurationMs: number;
  failureCategory:
    | 'MEDIA_INSPECTION_ERROR'
    | 'INSUFFICIENT_CREDITS'
    | 'VIDEO_PROCESSING_ERROR'
    | 'AUDIO_PROCESSING_ERROR'
    | 'PROXY_GENERATION_ERROR'
    | 'PIPELINE_ERROR';
  isRescan?: boolean;
}

export type TypedAnalyticsEventPayload =
  | { eventName: 'user_registered'; properties: UserRegisteredProperties }
  | { eventName: 'trial_activated'; properties: TrialActivatedProperties }
  | { eventName: 'purchase_completed'; properties: PurchaseCompletedProperties }
  | { eventName: 'analysis_started'; properties: AnalysisStartedProperties }
  | { eventName: 'analysis_completed'; properties: AnalysisCompletedProperties }
  | { eventName: 'analysis_failed'; properties: AnalysisFailedProperties };

export type TrackAnalyticsInput = TypedAnalyticsEventPayload & {
  userId?: string | null;
  anonymousId?: string | null;
  occurredAt?: string;
  eventVersion?: number;
  idempotencyKey?: string | null;
};

export interface AnalyticsTrackResult {
  recorded: boolean;
  deduplicated: boolean;
  event: AnalyticsEventRecord | null;
  error?: string;
}

export class AnalyticsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsValidationError';
    Object.setPrototypeOf(this, AnalyticsValidationError.prototype);
  }
}

export class AnalyticsService {
  private storageOverride: IStorageRepository | null = null;

  public setStorageForTest(repo: IStorageRepository | null): void {
    this.storageOverride = repo;
  }

  private resolveStorage(explicitRepo?: IStorageRepository | null): IStorageRepository {
    return explicitRepo || this.storageOverride || storage;
  }

  public buildValidatedEvent(input: TrackAnalyticsInput | {
    eventName: unknown;
    userId?: unknown;
    anonymousId?: unknown;
    occurredAt?: unknown;
    eventVersion?: unknown;
    idempotencyKey?: unknown;
    properties?: unknown;
  }): AnalyticsEventInput {
    if (!input || typeof input !== 'object') {
      throw new AnalyticsValidationError('Analytics event payload must be an object.');
    }

    if (!isValidAnalyticsEventName(input.eventName)) {
      throw new AnalyticsValidationError(`Invalid analytics event name: ${String(input.eventName)}`);
    }

    let userId: string | null = null;
    if (input.userId !== undefined && input.userId !== null) {
      if (typeof input.userId !== 'string' || !input.userId.trim()) {
        throw new AnalyticsValidationError('Analytics userId must be a non-empty string when provided.');
      }
      userId = input.userId.trim().slice(0, 128);
    }

    let anonymousId: string | null = null;
    if (input.anonymousId !== undefined && input.anonymousId !== null) {
      if (typeof input.anonymousId !== 'string' || !input.anonymousId.trim()) {
        throw new AnalyticsValidationError('Analytics anonymousId must be a non-empty string when provided.');
      }
      anonymousId = input.anonymousId.trim().slice(0, 128);
    }

    let occurredAt = new Date().toISOString();
    if (input.occurredAt !== undefined && input.occurredAt !== null) {
      if (typeof input.occurredAt !== 'string' || !input.occurredAt.trim()) {
        throw new AnalyticsValidationError('Analytics occurredAt must be a valid ISO-8601 timestamp string.');
      }
      const parsedMs = Date.parse(input.occurredAt);
      if (!Number.isFinite(parsedMs)) {
        throw new AnalyticsValidationError(`Invalid analytics occurredAt timestamp: ${input.occurredAt}`);
      }
      occurredAt = new Date(parsedMs).toISOString();
    }

    let eventVersion = ANALYTICS_EVENT_VERSION;
    if (input.eventVersion !== undefined && input.eventVersion !== null) {
      if (typeof input.eventVersion !== 'number' || !Number.isInteger(input.eventVersion) || input.eventVersion < 1) {
        throw new AnalyticsValidationError('Analytics eventVersion must be a positive integer.');
      }
      eventVersion = input.eventVersion;
    }

    let idempotencyKey: string | null = null;
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
      if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) {
        throw new AnalyticsValidationError('Analytics idempotencyKey must be a non-empty string when provided.');
      }
      idempotencyKey = input.idempotencyKey.trim().slice(0, 256);
    }

    const sanitizedProps = sanitizeAnalyticsProperties(input.properties, input.eventName, {
      enforceEventAllowlist: true,
    });

    this.validateRequiredEventProperties(input.eventName, sanitizedProps);

    const id = `evt_anl_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    return {
      id,
      eventName: input.eventName,
      userId,
      anonymousId,
      eventVersion,
      occurredAt,
      properties: sanitizedProps,
      idempotencyKey,
    };
  }

  private validateRequiredEventProperties(
    eventName: AnalyticsEventName,
    props: Record<string, unknown>
  ): void {
    switch (eventName) {
      case 'user_registered': {
        if (typeof props.registrationMethod !== 'string' || !props.registrationMethod) {
          throw new AnalyticsValidationError('user_registered requires properties.registrationMethod.');
        }
        break;
      }
      case 'trial_activated': {
        if (typeof props.trialType !== 'string' || !props.trialType) {
          throw new AnalyticsValidationError('trial_activated requires properties.trialType.');
        }
        if (typeof props.grantedCredits !== 'number' || props.grantedCredits < 0) {
          throw new AnalyticsValidationError('trial_activated requires non-negative numeric properties.grantedCredits.');
        }
        break;
      }
      case 'purchase_completed': {
        if (typeof props.purchaseType !== 'string' || !props.purchaseType) {
          throw new AnalyticsValidationError('purchase_completed requires properties.purchaseType.');
        }
        if (typeof props.planId !== 'string' || !props.planId) {
          throw new AnalyticsValidationError('purchase_completed requires properties.planId.');
        }
        if (typeof props.paymentProvider !== 'string' || !props.paymentProvider) {
          throw new AnalyticsValidationError('purchase_completed requires properties.paymentProvider.');
        }
        if (typeof props.purchaseRef !== 'string' || !props.purchaseRef) {
          throw new AnalyticsValidationError('purchase_completed requires properties.purchaseRef.');
        }
        break;
      }
      case 'analysis_started': {
        if (typeof props.analysisId !== 'string' || !props.analysisId) {
          throw new AnalyticsValidationError('analysis_started requires properties.analysisId.');
        }
        if (props.analysisMode !== 'standard' && props.analysisMode !== 'deep') {
          throw new AnalyticsValidationError('analysis_started requires valid properties.analysisMode.');
        }
        break;
      }
      case 'analysis_completed': {
        if (typeof props.analysisId !== 'string' || !props.analysisId) {
          throw new AnalyticsValidationError('analysis_completed requires properties.analysisId.');
        }
        if (props.processingStatus !== 'COMPLETED') {
          throw new AnalyticsValidationError('analysis_completed requires processingStatus=COMPLETED.');
        }
        break;
      }
      case 'analysis_failed': {
        if (typeof props.analysisId !== 'string' || !props.analysisId) {
          throw new AnalyticsValidationError('analysis_failed requires properties.analysisId.');
        }
        if (props.processingStatus !== 'FAILED') {
          throw new AnalyticsValidationError('analysis_failed requires processingStatus=FAILED.');
        }
        break;
      }
    }
  }

  /**
   * Strict analytics recording method (validates input and propagates storage/validation errors).
   */
  public async recordEvent(
    input: TrackAnalyticsInput | {
      eventName: unknown;
      userId?: unknown;
      anonymousId?: unknown;
      occurredAt?: unknown;
      eventVersion?: unknown;
      idempotencyKey?: unknown;
      properties?: unknown;
    },
    repo?: IStorageRepository | null
  ): Promise<AnalyticsTrackResult> {
    const validated = this.buildValidatedEvent(input);
    const activeRepo = this.resolveStorage(repo);
    return await activeRepo.analytics.recordEvent(validated);
  }

  /**
   * Best-effort, non-blocking-safe analytics recording wrapper.
   * Logs structured errors if validation or persistence fails, and NEVER throws into business flows.
   */
  public async trackSafe(
    input: TrackAnalyticsInput,
    repo?: IStorageRepository | null
  ): Promise<AnalyticsTrackResult> {
    try {
      return await this.recordEvent(input, repo);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'AnalyticsService',
          action: 'trackSafe',
          eventName: input?.eventName || 'unknown',
          error: errMsg,
          timestamp: new Date().toISOString(),
        })
      );
      return {
        recorded: false,
        deduplicated: false,
        event: null,
        error: errMsg,
      };
    }
  }

  public async queryEvents(
    options: AnalyticsQueryOptions = {},
    repo?: IStorageRepository | null
  ): Promise<AnalyticsEventsPage> {
    const activeRepo = this.resolveStorage(repo);
    return await activeRepo.analytics.queryEvents(options);
  }

  public async getFunnelSummary(
    options: { startDate?: string; endDate?: string } = {},
    repo?: IStorageRepository | null
  ): Promise<AnalyticsFunnelSummary> {
    const activeRepo = this.resolveStorage(repo);
    return await activeRepo.analytics.getFunnelSummary(options);
  }
}

export const analyticsService = new AnalyticsService();
