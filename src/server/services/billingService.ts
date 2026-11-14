import Stripe from 'stripe';
import { storage, IStorageRepository } from '../storage';
import {
  UserAccount,
  SubscriptionRecord,
  WebhookEventRecord,
  StripePaymentRecord,
  StripeRefundRecord,
  StripeRefundStatus
} from '../../types';

export const ALLOWED_PAID_PLANS = ['creator', 'pro', 'agency', 'audit_once'] as const;
export type AllowedPaidPlan = typeof ALLOWED_PAID_PLANS[number];

export interface CheckoutSessionOptions {
  userId: string;
  planId: string;
  originUrl?: string;
}

function recordCreditTx(
  state: any,
  tx: {
    userId: string;
    delta: number;
    balanceAfter: number;
    type: string;
    referenceId?: string;
    metadataJson?: string;
  }
) {
  const id = `ctx_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const now = new Date().toISOString();
  if (state.prepare && typeof state.prepare === 'function') {
    state.prepare(`
      INSERT INTO credit_transactions (id, user_id, delta, balance_after, type, reference_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, tx.userId, tx.delta, tx.balanceAfter, tx.type, tx.referenceId || null, tx.metadataJson || null, now);
  } else if (Array.isArray(state.creditTransactions)) {
    state.creditTransactions.push({
      id,
      userId: tx.userId,
      delta: tx.delta,
      balanceAfter: tx.balanceAfter,
      type: tx.type as any,
      referenceId: tx.referenceId,
      metadataJson: tx.metadataJson,
      createdAt: now
    });
  }
}

export class BillingService {
  private stripe: Stripe | null = null;
  private isConfigured: boolean = false;
  private get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  private hasExplicitTestClient: boolean = false;
  private storageOverride: IStorageRepository | null = null;

  constructor() {
    this.reconfigure();
  }

  private getActiveStorage(): IStorageRepository {
    return this.storageOverride || storage;
  }

  public setStorageForTest(repo: IStorageRepository | null): void {
    this.storageOverride = repo;
  }

  public reconfigure(): void {
    this.hasExplicitTestClient = false;
    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (apiKey) {
      this.stripe = new Stripe(apiKey, {
        apiVersion: '2025-02-24.acacia' as any,
        typescript: true,
      });
      this.isConfigured = true;
    } else {
      this.stripe = null;
      this.isConfigured = false;
      if (this.isProduction && process.env.PAYMENT_PROVIDER === 'stripe') {
        console.error('[BillingService] FATAL: STRIPE_SECRET_KEY is missing in production environment!');
      }
    }
  }

  public setStripeClientForTest(client: Stripe | any): void {
    this.stripe = client;
    this.isConfigured = !!client;
    this.hasExplicitTestClient = true;
  }

  public getStripeClient(): Stripe | null {
    if (!this.hasExplicitTestClient && !this.stripe && process.env.STRIPE_SECRET_KEY) {
      this.reconfigure();
    }
    return this.stripe;
  }

  public isStripeClientConfigured(): boolean {
    return !!this.getStripeClient();
  }

  /**
   * Identifies the current Stripe environment mode based on the secret key prefix
   */
  public getStripeMode(): 'live' | 'test' | 'unconfigured' {
    const stripe = this.getStripeClient();
    if (!stripe || !process.env.STRIPE_SECRET_KEY) return 'unconfigured';
    const key = process.env.STRIPE_SECRET_KEY;
    if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
    if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
    return 'test';
  }

  /**
   * Returns configured base URL from environment if explicitly set.
   * Priority: APP_BASE_URL > APP_URL > PUBLIC_APP_URL
   */
  public getConfiguredAppBaseUrl(): string | null {
    const raw = process.env.APP_BASE_URL || process.env.APP_URL || process.env.PUBLIC_APP_URL;
    if (!raw || typeof raw !== 'string' || !raw.trim()) {
      return null;
    }
    return raw.trim().replace(/\/+$/, '');
  }

  /**
   * Canonical application URL helper.
   * In non-production, defaults to https://videorisk.com when APP_BASE_URL is not set.
   */
  public getCanonicalAppUrl(): string {
    const configured = this.getConfiguredAppBaseUrl();
    if (configured) {
      return configured;
    }
    return 'https://videorisk.com';
  }

  /**
   * Resolves list of trusted application origins strictly from server configuration.
   * Never reads request Host, X-Forwarded-Host, or arbitrary client headers.
   */
  public getTrustedOrigins(): string[] {
    const origins = new Set<string>();
    const configured = this.getConfiguredAppBaseUrl();
    const isDevOrTest = !this.isProduction || process.env.VIDEORISK_TEST_RUN === 'true';

    if (configured) {
      try {
        const parsed = new URL(configured);
        if (!parsed.username && !parsed.password && (parsed.protocol === 'https:' || (isDevOrTest && parsed.protocol === 'http:'))) {
          origins.add(parsed.origin);
        }
      } catch {
        // Invalid configured base URL will fail closed during validation
      }
    }
    if (isDevOrTest && !process.env.APP_BASE_URL) {
      // Development/test defaults when APP_BASE_URL is not explicitly overridden
      origins.add('https://videorisk.com');
      origins.add('https://www.videorisk.com');
    }

    if (process.env.ALLOWED_ORIGINS) {
      process.env.ALLOWED_ORIGINS.split(',').forEach(o => {
        const trimmed = o.trim();
        if (trimmed && !trimmed.includes('@') && !trimmed.startsWith('//')) {
          try {
            const parsed = new URL(trimmed);
            if (!parsed.username && !parsed.password) {
              if (parsed.protocol === 'https:' || (isDevOrTest && parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))) {
                origins.add(parsed.origin);
              }
            }
          } catch {
            // Ignore malformed entry
          }
        }
      });
    }

    // In development or test environments, permit explicit localhost origins
    if (isDevOrTest) {
      origins.add('http://localhost:3000');
      origins.add('http://127.0.0.1:3000');
      origins.add('http://localhost:5173');
      origins.add('http://127.0.0.1:5173');
      origins.add('https://localhost:3000');
      origins.add('https://127.0.0.1:3000');
    }

    return Array.from(origins);
  }

  /**
   * Validates and resolves a trusted origin for Stripe Checkout success_url / cancel_url.
   * Security rules:
   * - Fails closed in production if APP_BASE_URL (or APP_URL / PUBLIC_APP_URL) is missing or invalid.
   * - Never falls back to request Host or X-Forwarded-Host headers.
   * - If client supplies an Origin header or body originUrl, validates it strictly against server allowlist
   *   and rejects untrusted, lookalike, userinfo (@), protocol-relative, malformed, or insecure schemes (400).
   */
  public resolveTrustedCheckoutOrigin(options?: {
    requestedOrigin?: string | string[] | null;
    bodyOrigin?: string | null;
  }): string {
    const isDevOrTest = !this.isProduction || process.env.VIDEORISK_TEST_RUN === 'true';
    const configuredBase = this.getConfiguredAppBaseUrl();

    if (this.isProduction && process.env.VIDEORISK_TEST_RUN !== 'true') {
      if (!configuredBase) {
        const err: any = new Error('Server checkout origin misconfiguration: APP_BASE_URL must be configured in production.');
        err.statusCode = 500;
        throw err;
      }
      let parsedBase: URL;
      try {
        if (configuredBase.startsWith('//') || configuredBase.includes('@') || /\s/.test(configuredBase)) {
          throw new Error('Invalid characters');
        }
        parsedBase = new URL(configuredBase);
      } catch {
        const err: any = new Error('Server checkout origin misconfiguration: APP_BASE_URL is malformed.');
        err.statusCode = 500;
        throw err;
      }
      if (parsedBase.protocol !== 'https:' || parsedBase.username || parsedBase.password) {
        const err: any = new Error('Server checkout origin misconfiguration: APP_BASE_URL must be a valid HTTPS origin without credentials.');
        err.statusCode = 500;
        throw err;
      }
    }

    const validateCandidateOrigin = (candidate: unknown): string | null => {
      if (Array.isArray(candidate)) {
        const err: any = new Error('Multiple Origin headers are not permitted.');
        err.statusCode = 400;
        throw err;
      }

      if (candidate === undefined || candidate === null || (typeof candidate === 'string' && candidate.trim() === '')) {
        return null;
      }

      if (typeof candidate !== 'string') {
        const err: any = new Error('Invalid checkout origin format.');
        err.statusCode = 400;
        throw err;
      }

      const trimmed = candidate.trim();

      if (trimmed.startsWith('//') || trimmed.includes('\\') || /\s/.test(trimmed)) {
        const err: any = new Error('Malformed or protocol-relative checkout origin is strictly forbidden.');
        err.statusCode = 400;
        throw err;
      }

      if (trimmed.includes('@')) {
        const err: any = new Error('Userinfo credentials (@) in checkout origin are strictly forbidden.');
        err.statusCode = 400;
        throw err;
      }

      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        const err: any = new Error('Malformed checkout origin URL format.');
        err.statusCode = 400;
        throw err;
      }

      if (parsed.username || parsed.password) {
        const err: any = new Error('Userinfo credentials in checkout origin URL are strictly forbidden.');
        err.statusCode = 400;
        throw err;
      }

      if (parsed.protocol === 'javascript:' || parsed.protocol === 'data:' || parsed.protocol === 'file:') {
        const err: any = new Error(`Dangerous checkout origin scheme: ${parsed.protocol}`);
        err.statusCode = 400;
        throw err;
      }

      if (parsed.protocol === 'http:') {
        const isLocalHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
        if (!isDevOrTest || !isLocalHost) {
          const err: any = new Error('Insecure HTTP checkout origins are not permitted outside of development localhost.');
          err.statusCode = 400;
          throw err;
        }
      } else if (parsed.protocol !== 'https:') {
        const err: any = new Error(`Unsupported checkout origin protocol: ${parsed.protocol}`);
        err.statusCode = 400;
        throw err;
      }

      // Strict origin comparison (rejects lookalike suffixes such as videorisk.com.evil.com)
      const isTrusted = trustedOrigins.some(trusted => {
        try {
          const t = new URL(trusted);
          if (parsed.origin === t.origin) return true;
          if (isDevOrTest && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && (t.hostname === 'localhost' || t.hostname === '127.0.0.1')) {
            return true;
          }
        } catch {
          return false;
        }
        return false;
      });

      if (!isTrusted) {
        const err: any = new Error(`Checkout origin '${parsed.origin}' is not authorized.`);
        err.statusCode = 400;
        throw err;
      }

      return parsed.origin;
    };

    const trustedOrigins = this.getTrustedOrigins();
    const validatedHeaderOrigin = options?.requestedOrigin !== undefined
      ? validateCandidateOrigin(options.requestedOrigin)
      : null;
    const validatedBodyOrigin = options?.bodyOrigin !== undefined
      ? validateCandidateOrigin(options.bodyOrigin)
      : null;

    const resolvedOrigin = validatedBodyOrigin || validatedHeaderOrigin;
    if (resolvedOrigin) {
      return resolvedOrigin;
    }

    // No client-supplied origin (e.g., server-to-server call or same-origin without Origin header).
    // Use strictly server-configured canonical origin — never req.get('host').
    return configuredBase ? new URL(configuredBase).origin : this.getCanonicalAppUrl();
  }

  /**
   * Validates Customer Portal return URL strictly against trusted application origins.
   * Rejects external origins, lookalikes, userinfo spoofing, protocol-relative URLs, malformed URLs, and dangerous schemes.
   */
  public validatePortalReturnUrl(inputUrl?: string | null): string {
    const isDevOrTest = !this.isProduction || process.env.VIDEORISK_TEST_RUN === 'true';

    if (!isDevOrTest && !this.getConfiguredAppBaseUrl()) {
      const err: any = new Error('Server portal return URL misconfiguration: APP_BASE_URL must be configured in production.');
      err.statusCode = 500;
      throw err;
    }

    // Missing return URL falls back to canonical application URL
    if (!inputUrl || typeof inputUrl !== 'string' || !inputUrl.trim()) {
      return `${this.getCanonicalAppUrl()}/?view=pricing`;
    }

    const trimmed = inputUrl.trim();

    // Reject protocol-relative URLs
    if (trimmed.startsWith('//')) {
      const err: any = new Error('Protocol-relative return URLs are strictly forbidden.');
      err.statusCode = 400;
      throw err;
    }

    if (trimmed.includes('\\')) {
      const err: any = new Error('Malformed return URL format.');
      err.statusCode = 400;
      throw err;
    }

    // Reject malformed URLs
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      const err: any = new Error('Malformed return URL format.');
      err.statusCode = 400;
      throw err;
    }

    // Reject userinfo (@) spoofing attempts (e.g. https://videorisk.com@evil.com)
    if (parsed.username || parsed.password) {
      const err: any = new Error('Return URL credentials (userinfo) are strictly forbidden.');
      err.statusCode = 400;
      throw err;
    }

    // Reject unexpected schemes (javascript:, data:, file:, etc.)
    if (parsed.protocol === 'javascript:' || parsed.protocol === 'data:' || parsed.protocol === 'file:') {
      const err: any = new Error(`Dangerous return URL scheme: ${parsed.protocol}`);
      err.statusCode = 400;
      throw err;
    }

    if (parsed.protocol === 'http:') {
      const isLocalHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (!isDevOrTest || !isLocalHost) {
        const err: any = new Error('Insecure HTTP return URLs are not permitted outside of development localhost.');
        err.statusCode = 400;
        throw err;
      }
    } else if (parsed.protocol !== 'https:') {
      const err: any = new Error(`Unsupported return URL protocol: ${parsed.protocol}`);
      err.statusCode = 400;
      throw err;
    }

    // Origin check against trusted application origins
    const trustedOrigins = this.getTrustedOrigins();
    const isTrusted = trustedOrigins.some(trusted => {
      try {
        const t = new URL(trusted);
        if (parsed.origin === t.origin) return true;
        if (isDevOrTest && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && (t.hostname === 'localhost' || t.hostname === '127.0.0.1')) {
          return true;
        }
      } catch {
        return false;
      }
      return false;
    });

    if (!isTrusted) {
      const err: any = new Error(`Return URL origin '${parsed.origin}' is not authorized.`);
      err.statusCode = 400;
      throw err;
    }

    return parsed.toString();
  }

  /**
   * Reverse-maps a Stripe price ID to our internal plan identifier
   */
  public getPlanFromPriceId(priceId: string): AllowedPaidPlan | null {
    if (!priceId || typeof priceId !== 'string') return null;
    const cleanId = priceId.trim();

    if (process.env.STRIPE_PRICE_CREATOR && cleanId === process.env.STRIPE_PRICE_CREATOR) return 'creator';
    if (process.env.STRIPE_PRICE_PRO && cleanId === process.env.STRIPE_PRICE_PRO) return 'pro';
    if (process.env.STRIPE_PRICE_AGENCY && cleanId === process.env.STRIPE_PRICE_AGENCY) return 'agency';
    if (process.env.STRIPE_PRICE_AUDIT_ONCE && cleanId === process.env.STRIPE_PRICE_AUDIT_ONCE) return 'audit_once';

    // Standard fallback price identifiers for test suites, CI, and dev simulation
    if (cleanId === 'price_creator' || cleanId === 'price_creator_test' || cleanId === 'price_creator_123') return 'creator';
    if (cleanId === 'price_pro' || cleanId === 'price_pro_test' || cleanId === 'price_pro_123') return 'pro';
    if (cleanId === 'price_agency' || cleanId === 'price_agency_test' || cleanId === 'price_agency_123') return 'agency';
    if (cleanId === 'price_audit_once' || cleanId === 'price_audit_test' || cleanId === 'price_audit_123') return 'audit_once';

    return null;
  }

  /**
   * Evaluates whether a given subscription status and billing period confers active paid entitlements.
   * Explicitly handles active, trialing, past_due, canceled, unpaid, incomplete, and incomplete_expired.
   */
  public isSubscriptionEntitled(
    status?: string,
    currentPeriodEnd?: string | number | null
  ): boolean {
    if (!status) return false;

    // Explicitly unentitled statuses
    if (status === 'unpaid' || status === 'incomplete' || status === 'incomplete_expired') {
      return false;
    }

    // Active and trialing are always entitled
    if (status === 'active' || status === 'trialing') {
      return true;
    }

    const now = Date.now();
    const periodEndMs = typeof currentPeriodEnd === 'number'
      ? currentPeriodEnd * 1000
      : (currentPeriodEnd ? new Date(currentPeriodEnd).getTime() : 0);

    // Canceled but still within the prepaid period
    if (status === 'canceled') {
      return periodEndMs > now;
    }

    // Past due: 7-day grace period from period end
    if (status === 'past_due') {
      if (periodEndMs <= 0) return false;
      const gracePeriodMs = 7 * 24 * 60 * 60 * 1000;
      return now <= periodEndMs + gracePeriodMs;
    }

    return false;
  }

  /**
   * Helper to resolve plan credit allocations
   */
  public getPlanCreditAllocation(planId: string): number {
    switch (planId) {
      case 'creator':
        return 30;
      case 'pro':
        return 75;
      case 'agency':
        return 600;
      case 'audit_once':
        return 60;
      default:
        return 0;
    }
  }

  /**
   * Resolves configured price ID from environment
   */
  private getPriceIdForPlan(planId: string): string | null {
    switch (planId) {
      case 'creator':
        return process.env.STRIPE_PRICE_CREATOR || null;
      case 'pro':
        return process.env.STRIPE_PRICE_PRO || null;
      case 'agency':
        return process.env.STRIPE_PRICE_AGENCY || null;
      case 'audit_once':
        return process.env.STRIPE_PRICE_AUDIT_ONCE || null;
      default:
        return null;
    }
  }

  /**
   * Creates a Stripe Checkout Session for a selected plan
   */
  public async createCheckoutSession(options: CheckoutSessionOptions): Promise<{ url: string; sessionId: string; mode: string }> {
    const { userId, planId } = options;
    const trustedOrigin = this.resolveTrustedCheckoutOrigin({
      requestedOrigin: options.originUrl
    });

    if (!ALLOWED_PAID_PLANS.includes(planId as any)) {
      throw new Error(`Invalid plan ID: ${planId}. Allowed paid plans are: ${ALLOWED_PAID_PLANS.join(', ')}`);
    }

    const user = await this.getActiveStorage().users.getUser(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const paymentMode = process.env.PAYMENT_MODE;
    const requireLive = this.isProduction || paymentMode === 'production' || paymentMode === 'live';

    // Production guard: fail fast if production credentials are missing or if test key is used in production
    if (requireLive) {
      if (!this.stripe) {
        throw new Error('Payment gateway is not configured for production. Please verify STRIPE_SECRET_KEY.');
      }
      if (this.getStripeMode() !== 'live') {
        throw new Error('Production mode requires a Stripe LIVE key (sk_live_... or rk_live_...). Found test mode credentials.');
      }
      const priceId = this.getPriceIdForPlan(planId);
      if (!priceId) {
        throw new Error(`Configured Stripe Price ID missing for plan '${planId}' in production.`);
      }
    }

    // Real Stripe Session Creation if Stripe SDK is configured
    if (this.stripe) {
      const priceId = this.getPriceIdForPlan(planId);
      const isOneTime = (planId === 'audit_once');

      if (requireLive && !priceId) {
        throw new Error(`Missing configured Stripe Price ID for plan: ${planId}`);
      }

      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = priceId 
        ? [{ price: priceId, quantity: 1 }]
        : [{
            price_data: {
              currency: 'usd',
              product_data: {
                name: `VideoRisk ${planId.toUpperCase()} Plan`,
                description: isOneTime ? '60 video inspection minutes (one-time)' : 'Monthly video inspection credits',
              },
              unit_amount: planId === 'creator' ? 900 : planId === 'pro' ? 1900 : planId === 'agency' ? 9900 : 2900,
              recurring: isOneTime ? undefined : { interval: 'month' },
            },
            quantity: 1,
          }];

      const session = await this.stripe.checkout.sessions.create({
        mode: isOneTime ? 'payment' : 'subscription',
        line_items: lineItems,
        client_reference_id: user.id,
        metadata: {
          userId: user.id,
          planId: planId,
        },
        success_url: `${trustedOrigin}/?checkout_status=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${trustedOrigin}/?checkout_status=canceled`,
        ...(user.stripeCustomerId ? { customer: user.stripeCustomerId } : { customer_email: user.email }),
        ...(isOneTime ? {} : {
          subscription_data: {
            metadata: {
              userId: user.id,
              planId: planId,
            }
          }
        }),
      });

      if (!session.url) {
        throw new Error('Failed to generate checkout URL from Stripe.');
      }

      const stripeMode = session.livemode ? 'live' : 'test';

      return {
        url: session.url,
        sessionId: session.id,
        mode: stripeMode,
      };
    }

    // Development Simulation Mode (ONLY permitted when requireLive is false)
    if (requireLive) {
      throw new Error('Simulation checkout is strictly forbidden in production mode.');
    }

    const simulatedSessionId = `sim_session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    return {
      url: `${trustedOrigin}/?checkout_status=success&session_id=${simulatedSessionId}&plan=${planId}&mode=simulation`,
      sessionId: simulatedSessionId,
      mode: 'simulation',
    };
  }

  /**
   * Processes Stripe Webhook with Cryptographic Signature Verification, Fail-Closed Rules, and Idempotency
   */
  public async handleWebhook(rawBody: Buffer, signature: string): Promise<{ received: boolean; eventType: string; eventId: string; alreadyProcessed?: boolean }> {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const isProd = this.isProduction || process.env.PAYMENT_MODE === 'production' || process.env.PAYMENT_MODE === 'live';

    if (isProd) {
      if (!this.stripe || !webhookSecret) {
        throw new Error('Stripe Webhook is unconfigured in production: missing Stripe SDK or STRIPE_WEBHOOK_SECRET.');
      }
      if (!signature || typeof signature !== 'string' || !signature.trim()) {
        throw new Error('Missing or empty stripe-signature header.');
      }
      if (!rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        throw new Error('Missing raw request payload for webhook verification.');
      }

      let event: Stripe.Event;
      try {
        event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      } catch (err: any) {
        console.error('[BillingService] Production webhook signature verification failed:', err.message);
        throw new Error(`Webhook Error: ${err.message}`);
      }

      const { alreadyProcessed } = await this.processVerifiedEvent(event);
      return {
        received: true,
        eventType: event.type,
        eventId: event.id,
        alreadyProcessed,
      };
    }

    // Non-production environment
    let event: Stripe.Event;
    if (this.stripe && webhookSecret && signature) {
      try {
        event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      } catch (err: any) {
        console.error('[BillingService] Webhook signature verification failed:', err.message);
        throw new Error(`Webhook Error: ${err.message}`);
      }
    } else if (process.env.ALLOW_SIMULATION_WEBHOOK === 'true') {
      if (!rawBody || !Buffer.isBuffer(rawBody)) {
        throw new Error('Missing raw request payload for simulation webhook.');
      }
      try {
        event = JSON.parse(rawBody.toString('utf-8'));
      } catch (err) {
        throw new Error('Invalid JSON payload');
      }
    } else {
      throw new Error('Stripe Webhook verification failed: secret unconfigured and simulation webhooks are not enabled.');
    }

    const { alreadyProcessed } = await this.processVerifiedEvent(event);
    return {
      received: true,
      eventType: event.type,
      eventId: event.id,
      alreadyProcessed,
    };
  }

  /**
   * Upserts a Stripe payment correlation record inside the storage transaction.
   */
  private upsertStripePayment(
    state: any,
    payment: Partial<StripePaymentRecord> & { id: string; userId: string }
  ): StripePaymentRecord {
    if (!state.stripePayments) {
      state.stripePayments = {};
    }
    const existing: StripePaymentRecord | undefined = state.stripePayments[payment.id];
    const now = new Date().toISOString();
    const merged: StripePaymentRecord = {
      id: payment.id,
      userId: payment.userId || existing?.userId || '',
      sessionId: payment.sessionId ?? existing?.sessionId,
      paymentIntentId: payment.paymentIntentId ?? existing?.paymentIntentId,
      chargeId: payment.chargeId ?? existing?.chargeId,
      invoiceId: payment.invoiceId ?? existing?.invoiceId,
      subscriptionId: payment.subscriptionId ?? existing?.subscriptionId,
      customerId: payment.customerId ?? existing?.customerId,
      planId: payment.planId ?? existing?.planId,
      creditsGranted: Math.max(existing?.creditsGranted || 0, payment.creditsGranted || 0),
      amountTotal: payment.amountTotal ?? existing?.amountTotal,
      currency: payment.currency ?? existing?.currency,
      status: payment.status ?? existing?.status ?? 'paid',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    state.stripePayments[payment.id] = merged;
    return merged;
  }

  /**
   * Strict allowlist parser for Stripe refund statuses.
   * Never coerces missing, null, empty, or unknown status strings into 'succeeded'.
   */
  private normalizeRefundStatus(
    rawStatus: unknown,
    eventType: string
  ): { status: StripeRefundStatus; rawStatus?: string } {
    if (eventType === 'refund.failed') {
      return {
        status: 'failed',
        rawStatus: typeof rawStatus === 'string' && rawStatus.trim() ? rawStatus.trim().toLowerCase() : 'failed',
      };
    }

    if (typeof rawStatus !== 'string') {
      return {
        status: 'unknown',
        rawStatus: rawStatus === null ? 'null' : rawStatus === undefined ? 'missing' : String(rawStatus),
      };
    }

    const trimmed = rawStatus.trim().toLowerCase();
    if (!trimmed) {
      return { status: 'unknown', rawStatus: 'empty' };
    }

    if (
      trimmed === 'succeeded' ||
      trimmed === 'pending' ||
      trimmed === 'requires_action' ||
      trimmed === 'failed' ||
      trimmed === 'canceled'
    ) {
      return { status: trimmed, rawStatus: trimmed };
    }

    return { status: 'unknown', rawStatus: trimmed };
  }

  /**
   * Exact integer arithmetic for proportional credit reversal on cumulative cents refunded.
   * Uses BigInt multiplication/division so floating-point precision never causes drift or > 100% over-clawback.
   */
  private computeCumulativeTargetCredits(
    originalCreditsGranted: number,
    cumulativeCents: number,
    totalPaymentCents: number | undefined,
    isFull: boolean
  ): number {
    if (originalCreditsGranted <= 0) return 0;
    if (isFull) return originalCreditsGranted;
    if (!totalPaymentCents || !Number.isFinite(totalPaymentCents) || totalPaymentCents <= 0) {
      return 0;
    }
    if (!Number.isFinite(cumulativeCents) || cumulativeCents <= 0) {
      return 0;
    }
    const cappedCents = Math.min(Math.trunc(totalPaymentCents), Math.trunc(cumulativeCents));
    return Number((BigInt(originalCreditsGranted) * BigInt(cappedCents)) / BigInt(Math.trunc(totalPaymentCents)));
  }

  /**
   * Finds a Stripe payment correlation record by charge, payment_intent, invoice, session, or
   * non-conflicting subscription ID.
   */
  private findPaymentRecord(
    state: any,
    keys: {
      paymentIntentId?: string;
      chargeId?: string;
      invoiceId?: string;
      sessionId?: string;
      subscriptionId?: string;
    }
  ): StripePaymentRecord | null {
    const mapRow = (row: any): StripePaymentRecord => ({
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id || undefined,
      paymentIntentId: row.payment_intent_id || undefined,
      chargeId: row.charge_id || undefined,
      invoiceId: row.invoice_id || undefined,
      subscriptionId: row.subscription_id || undefined,
      customerId: row.customer_id || undefined,
      planId: row.plan_id || undefined,
      creditsGranted: Number(row.credits_granted || 0),
      amountTotal: row.amount_total !== null && row.amount_total !== undefined ? Number(row.amount_total) : undefined,
      currency: row.currency || undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });

    const isCompatibleSubCandidate = (r: StripePaymentRecord): boolean => {
      if (keys.paymentIntentId && r.paymentIntentId && r.paymentIntentId !== keys.paymentIntentId) return false;
      if (keys.chargeId && r.chargeId && r.chargeId !== keys.chargeId) return false;
      if (keys.invoiceId && r.invoiceId && r.invoiceId !== keys.invoiceId) return false;
      return true;
    };

    if (state.prepare && typeof state.prepare === 'function') {
      const specificQueries: Array<[string, string | undefined]> = [
        ['SELECT * FROM stripe_payments WHERE charge_id = ? ORDER BY created_at DESC LIMIT 1', keys.chargeId],
        ['SELECT * FROM stripe_payments WHERE payment_intent_id = ? ORDER BY created_at DESC LIMIT 1', keys.paymentIntentId],
        ['SELECT * FROM stripe_payments WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1', keys.invoiceId],
        ['SELECT * FROM stripe_payments WHERE session_id = ? ORDER BY created_at DESC LIMIT 1', keys.sessionId],
      ];
      for (const [sql, param] of specificQueries) {
        if (!param) continue;
        const row = state.prepare(sql).get(param) as any;
        if (row) return mapRow(row);
      }
      if (keys.subscriptionId && !keys.chargeId && !keys.paymentIntentId && !keys.invoiceId) {
        const row = state.prepare('SELECT * FROM stripe_payments WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 1').get(keys.subscriptionId) as any;
        if (row) {
          const mapped = mapRow(row);
          if (isCompatibleSubCandidate(mapped)) return mapped;
        }
      }
      return null;
    }

    const records: StripePaymentRecord[] = Object.values(state.stripePayments || {});
    for (const r of records) {
      if (keys.chargeId && r.chargeId === keys.chargeId) return r;
    }
    for (const r of records) {
      if (keys.paymentIntentId && r.paymentIntentId === keys.paymentIntentId) return r;
    }
    for (const r of records) {
      if (keys.invoiceId && r.invoiceId === keys.invoiceId) return r;
    }
    for (const r of records) {
      if (keys.sessionId && r.sessionId === keys.sessionId) return r;
    }
    if (keys.subscriptionId && !keys.chargeId && !keys.paymentIntentId && !keys.invoiceId) {
      for (const r of records) {
        if (r.subscriptionId === keys.subscriptionId && isCompatibleSubCandidate(r)) return r;
      }
    }
    return null;
  }

  /**
   * Lists all refund records associated with a payment across all identifiers.
   */
  private findRefundsForPayment(
    state: any,
    keys: {
      paymentId?: string;
      chargeId?: string;
      paymentIntentId?: string;
      invoiceId?: string;
    }
  ): StripeRefundRecord[] {
    if (state.prepare && typeof state.prepare === 'function') {
      const mapRow = (row: any): StripeRefundRecord => ({
        refundId: row.refund_id,
        paymentId: row.payment_id || undefined,
        userId: row.user_id || undefined,
        chargeId: row.charge_id || undefined,
        paymentIntentId: row.payment_intent_id || undefined,
        invoiceId: row.invoice_id || undefined,
        subscriptionId: row.subscription_id || undefined,
        planId: row.plan_id || undefined,
        amountRefunded: Number(row.amount_refunded || 0),
        totalAmount: row.total_amount !== null && row.total_amount !== undefined ? Number(row.total_amount) : undefined,
        isFullRefund: Boolean(row.is_full_refund),
        status: row.status,
        rawStatus: row.raw_status || undefined,
        reconciled: Boolean(row.reconciled),
        creditsAdjusted: Number(row.credits_adjusted || 0),
        failureReason: row.failure_reason || undefined,
        eventId: row.event_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });

      const byId = new Map<string, StripeRefundRecord>();
      const queries: Array<[string, string | undefined]> = [
        ['SELECT * FROM stripe_refunds WHERE payment_id = ? ORDER BY created_at ASC, refund_id ASC', keys.paymentId],
        ['SELECT * FROM stripe_refunds WHERE charge_id = ? ORDER BY created_at ASC, refund_id ASC', keys.chargeId],
        ['SELECT * FROM stripe_refunds WHERE payment_intent_id = ? ORDER BY created_at ASC, refund_id ASC', keys.paymentIntentId],
        ['SELECT * FROM stripe_refunds WHERE invoice_id = ? ORDER BY created_at ASC, refund_id ASC', keys.invoiceId],
      ];
      for (const [sql, param] of queries) {
        if (!param) continue;
        const rows = state.prepare(sql).all(param) as any[];
        for (const row of rows) {
          if (!byId.has(row.refund_id)) {
            byId.set(row.refund_id, mapRow(row));
          }
        }
      }
      return Array.from(byId.values()).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.refundId.localeCompare(b.refundId)
      );
    }

    const refunds: StripeRefundRecord[] = Object.values(state.stripeRefunds || {});
    return refunds
      .filter(r =>
        (keys.paymentId && r.paymentId === keys.paymentId) ||
        (keys.chargeId && r.chargeId === keys.chargeId) ||
        (keys.paymentIntentId && r.paymentIntentId === keys.paymentIntentId) ||
        (keys.invoiceId && r.invoiceId === keys.invoiceId)
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.refundId.localeCompare(b.refundId));
  }

  /**
   * Checks whether a full succeeded refund was already recorded for this payment_intent / charge / invoice
   * (supports out-of-order full-refund-before-checkout events).
   */
  private hasSucceededFullRefund(
    state: any,
    keys: { paymentIntentId?: string; chargeId?: string; invoiceId?: string }
  ): boolean {
    const matched = this.findRefundsForPayment(state, keys).filter(r => r.status === 'succeeded');
    if (matched.some(r => r.isFullRefund)) return true;

    // Also check if cumulative succeeded partial refunds cover 100% of totalAmount
    const totalAmount = matched.find(r => typeof r.totalAmount === 'number' && r.totalAmount > 0)?.totalAmount;
    if (totalAmount && totalAmount > 0) {
      const cumulativeCents = matched.reduce((sum, r) => sum + Math.max(0, Math.trunc(r.amountRefunded || 0)), 0);
      if (cumulativeCents >= totalAmount) return true;
    }
    return false;
  }

  /**
   * Computes total credits and cents previously accounted across succeeded Stripe refunds for a given payment.
   */
  private getPriorRefundTotalsForPayment(
    state: any,
    keys: { paymentId?: string; paymentIntentId?: string; chargeId?: string; invoiceId?: string },
    excludeRefundId?: string
  ): { priorCreditsAdjusted: number; priorSucceededCents: number } {
    const refunds = this.findRefundsForPayment(state, keys).filter(
      r => r.status === 'succeeded' && (!excludeRefundId || r.refundId !== excludeRefundId) && r.reconciled !== false
    );
    let priorCreditsAdjusted = 0;
    let priorSucceededCents = 0;
    for (const r of refunds) {
      priorCreditsAdjusted += Math.max(0, Math.trunc(r.creditsAdjusted || 0));
      priorSucceededCents += Math.max(0, Math.trunc(r.amountRefunded || 0));
    }
    return { priorCreditsAdjusted, priorSucceededCents };
  }

  /**
   * Reconciles any refunds that arrived out-of-order before `checkout.session.completed`, `invoice.paid`,
   * or `verifyAndSynchronizeSession` created the payment record.
   * Links unattached refunds, reverses net partial/full credits atomically, and updates payment/subscription state.
   */
  private reconcilePendingRefundsForPayment(
    state: any,
    payment: StripePaymentRecord,
    user: UserAccount,
    nowIso: string
  ): void {
    const matchedRefunds = this.findRefundsForPayment(state, {
      paymentId: payment.id,
      chargeId: payment.chargeId,
      paymentIntentId: payment.paymentIntentId,
      invoiceId: payment.invoiceId,
    });

    if (matchedRefunds.length === 0) return;

    const totalPaymentAmount = payment.amountTotal;
    const originalCreditsGranted = payment.creditsGranted || 0;
    let priorCreditsAdjusted = 0;
    let priorSucceededCents = 0;
    let priorAccountedTarget = 0;

    // Seed baseline from already-reconciled succeeded refunds
    for (const r of matchedRefunds) {
      if (r.status === 'succeeded' && r.reconciled) {
        const cents = Math.max(0, Math.trunc(r.amountRefunded || 0));
        priorSucceededCents += cents;
        priorCreditsAdjusted += Math.max(0, Math.trunc(r.creditsAdjusted || 0));
      }
    }
    if (priorSucceededCents > 0) {
      priorAccountedTarget = Math.max(
        priorCreditsAdjusted,
        this.computeCumulativeTargetCredits(originalCreditsGranted, priorSucceededCents, totalPaymentAmount, false)
      );
    }

    for (const r of matchedRefunds) {
      // Backfill missing ownership/payment links on any matched refund (pending/failed/unknown/succeeded)
      const needsLinkUpdate =
        r.paymentId !== payment.id ||
        r.userId !== user.id ||
        (payment.planId && !r.planId) ||
        (payment.amountTotal !== undefined && r.totalAmount === undefined);

      if (r.status !== 'succeeded') {
        if (needsLinkUpdate) {
          state.stripeRefunds[r.refundId] = {
            ...r,
            paymentId: payment.id,
            userId: user.id,
            planId: r.planId || payment.planId,
            totalAmount: r.totalAmount ?? payment.amountTotal,
            updatedAt: nowIso,
          };
        }
        continue;
      }

      if (r.reconciled) {
        if (needsLinkUpdate) {
          state.stripeRefunds[r.refundId] = {
            ...r,
            paymentId: payment.id,
            userId: user.id,
            planId: r.planId || payment.planId,
            totalAmount: r.totalAmount ?? payment.amountTotal,
            updatedAt: nowIso,
          };
        }
        continue;
      }

      // Unreconciled succeeded refund arriving before payment creation
      const refundCents = Math.max(0, Math.trunc(r.amountRefunded || 0));
      if (refundCents <= 0) {
        state.stripeRefunds[r.refundId] = {
          ...r,
          paymentId: payment.id,
          userId: user.id,
          planId: r.planId || payment.planId,
          totalAmount: totalPaymentAmount ?? r.totalAmount,
          isFullRefund: false,
          reconciled: true,
          creditsAdjusted: 0,
          updatedAt: nowIso,
        };
        continue;
      }

      const cumulativeCents = priorSucceededCents + refundCents;
      const effectiveTotal = totalPaymentAmount ?? r.totalAmount;
      const isCumulativeFull = Boolean(r.isFullRefund) ||
        (typeof effectiveTotal === 'number' && effectiveTotal > 0 && cumulativeCents >= effectiveTotal);

      let desiredClawback = 0;
      if (originalCreditsGranted > 0) {
        const cumulativeTarget = this.computeCumulativeTargetCredits(
          originalCreditsGranted,
          cumulativeCents,
          effectiveTotal,
          isCumulativeFull
        );
        const remainingReversible = Math.max(0, originalCreditsGranted - priorCreditsAdjusted);
        desiredClawback = Math.max(0, Math.min(remainingReversible, cumulativeTarget - priorAccountedTarget));
        priorAccountedTarget = Math.max(priorAccountedTarget, cumulativeTarget);
      }

      const actualDeduction = Math.min(Math.max(0, user.creditsRemaining), desiredClawback);
      if (actualDeduction > 0) {
        user.creditsRemaining -= actualDeduction;
      }

      priorSucceededCents = cumulativeCents;
      priorCreditsAdjusted += actualDeduction;

      recordCreditTx(state, {
        userId: user.id,
        delta: -actualDeduction,
        balanceAfter: user.creditsRemaining,
        type: isCumulativeFull ? 'STRIPE_PAYMENT_REFUND' : 'STRIPE_PARTIAL_REFUND',
        referenceId: `${r.refundId}:reconciled`,
        metadataJson: JSON.stringify({
          eventId: r.eventId,
          refundId: r.refundId,
          paymentId: payment.id,
          chargeId: r.chargeId || payment.chargeId || null,
          paymentIntentId: r.paymentIntentId || payment.paymentIntentId || null,
          invoiceId: r.invoiceId || payment.invoiceId || null,
          subscriptionId: payment.subscriptionId || r.subscriptionId || null,
          planId: payment.planId || r.planId || null,
          amountRefunded: refundCents,
          cumulativeRefundedCents: cumulativeCents,
          totalPaymentAmount: effectiveTotal,
          refundScope: isCumulativeFull ? 'full' : 'partial',
          desiredCreditClawback: desiredClawback,
          actualCreditsDeducted: actualDeduction,
          unrecoveredCredits: Math.max(0, desiredClawback - actualDeduction),
          reconciledFromOutOfOrder: true,
        }),
      });

      const isSubscriptionPurchase = Boolean(payment.subscriptionId) && payment.planId !== 'audit_once';
      if (isCumulativeFull && isSubscriptionPurchase && payment.subscriptionId) {
        const targetSub = state.subscriptions[payment.subscriptionId];
        if (targetSub) {
          targetSub.status = 'canceled';
          targetSub.updatedAt = nowIso;
        }
        if (user.subscriptionId === payment.subscriptionId || !user.subscriptionId) {
          user.subscriptionStatus = 'canceled';
          user.plan = 'free';
        }
      }

      this.upsertStripePayment(state, {
        id: payment.id,
        userId: payment.userId,
        chargeId: payment.chargeId || r.chargeId,
        paymentIntentId: payment.paymentIntentId || r.paymentIntentId,
        invoiceId: payment.invoiceId || r.invoiceId,
        status: isCumulativeFull ? 'refunded' : (payment.status === 'refunded' ? 'refunded' : 'partially_refunded'),
      });
      payment.status = isCumulativeFull ? 'refunded' : (payment.status === 'refunded' ? 'refunded' : 'partially_refunded');

      state.stripeRefunds[r.refundId] = {
        ...r,
        paymentId: payment.id,
        userId: user.id,
        planId: payment.planId || r.planId,
        totalAmount: effectiveTotal,
        isFullRefund: isCumulativeFull,
        reconciled: true,
        creditsAdjusted: actualDeduction,
        updatedAt: nowIso,
      };
    }
  }

  private resolveUserByStripeRefs(
    state: any,
    refs: { userId?: string; customerId?: string; subscriptionId?: string }
  ): UserAccount | null {
    if (refs.userId && state.users[refs.userId]) {
      return state.users[refs.userId];
    }
    if (refs.subscriptionId && state.subscriptions[refs.subscriptionId]) {
      const subUserId = state.subscriptions[refs.subscriptionId].userId;
      if (subUserId && state.users[subUserId]) {
        return state.users[subUserId];
      }
    }
    if (refs.customerId) {
      if (state.prepare && typeof state.prepare === 'function') {
        const row = state.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(refs.customerId) as any;
        if (row && state.users[row.id]) return state.users[row.id];
      }
      const userWithCustomer = Object.values(state.users).find((u: any) => u?.stripeCustomerId === refs.customerId) as UserAccount | undefined;
      if (userWithCustomer) return userWithCustomer;
    }
    return null;
  }

  /**
   * Handles Stripe refund webhook events (`charge.refunded`, `charge.refund.updated`,
   * `refund.created`, `refund.updated`, `refund.failed`) transactionally and idempotently.
   *
   * Credit & Entitlement Refund Policy (non-destructive & audit-logged):
   * - Strict status allowlist (`succeeded`, `pending`, `requires_action`, `failed`, `canceled`, or `unknown`).
   *   Never coerces missing, null, or unknown status into `'succeeded'`.
   * - Cumulative exact integer-cent proportional credit math (via BigInt).
   * - Out-of-order protection: refunds arriving before checkout/invoice persist with `reconciled=false` and
   *   reconcile atomically when the payment record is created.
   */
  private processRefundWebhook(state: any, event: Stripe.Event): void {
    if (!state.stripeRefunds) state.stripeRefunds = {};
    if (!state.stripePayments) state.stripePayments = {};

    const obj = event.data.object as any;
    const isChargeEvent = event.type === 'charge.refunded';

    const chargeId: string | undefined = isChargeEvent
      ? obj?.id
      : (typeof obj?.charge === 'string' ? obj.charge : obj?.charge?.id);
    const paymentIntentId: string | undefined = typeof obj?.payment_intent === 'string'
      ? obj.payment_intent
      : obj?.payment_intent?.id;
    const invoiceId: string | undefined = typeof obj?.invoice === 'string'
      ? obj.invoice
      : obj?.invoice?.id;
    const customerId: string | undefined = typeof obj?.customer === 'string'
      ? obj.customer
      : obj?.customer?.id;
    const metadataSubscriptionId: string | undefined = obj?.metadata?.subscriptionId;
    const metadataUserId: string | undefined = obj?.metadata?.userId;
    const metadataPlanId: string | undefined = obj?.metadata?.planId;

    const payment = this.findPaymentRecord(state, {
      chargeId,
      paymentIntentId,
      invoiceId,
      subscriptionId: metadataSubscriptionId,
    });

    // Enrich payment correlation with chargeId/paymentIntentId/invoiceId if newly observed
    if (payment && ((chargeId && !payment.chargeId) || (paymentIntentId && !payment.paymentIntentId) || (invoiceId && !payment.invoiceId))) {
      this.upsertStripePayment(state, {
        id: payment.id,
        userId: payment.userId,
        chargeId: payment.chargeId || chargeId,
        paymentIntentId: payment.paymentIntentId || paymentIntentId,
        invoiceId: payment.invoiceId || invoiceId,
      });
      if (chargeId && !payment.chargeId) payment.chargeId = chargeId;
      if (paymentIntentId && !payment.paymentIntentId) payment.paymentIntentId = paymentIntentId;
      if (invoiceId && !payment.invoiceId) payment.invoiceId = invoiceId;
    }

    const effectiveSubId = payment?.subscriptionId || metadataSubscriptionId;
    const effectiveCustomerId = customerId || payment?.customerId;
    const user = this.resolveUserByStripeRefs(state, {
      userId: payment?.userId || metadataUserId,
      customerId: effectiveCustomerId,
      subscriptionId: effectiveSubId,
    });

    const subRecord = effectiveSubId ? state.subscriptions[effectiveSubId] : undefined;
    const planId = payment?.planId || metadataPlanId || subRecord?.planId;
    const totalPaymentAmount = isChargeEvent
      ? (typeof obj?.amount === 'number' && Number.isFinite(obj.amount) ? Math.trunc(obj.amount) : payment?.amountTotal)
      : (payment?.amountTotal ?? undefined);

    interface NormalizedRefundItem {
      refundId: string;
      amount: number;
      status: StripeRefundStatus;
      rawStatus?: string;
      failureReason?: string;
      isFull: boolean;
    }

    const itemsToProcess: NormalizedRefundItem[] = [];

    if (isChargeEvent) {
      const chargeRefundsList: any[] = Array.isArray(obj?.refunds?.data) ? obj.refunds.data : [];
      const cumulativeRefunded = Number.isFinite(Number(obj?.amount_refunded)) ? Math.trunc(Number(obj.amount_refunded)) : 0;
      const chargeFullyRefunded = obj?.refunded === true ||
        (typeof totalPaymentAmount === 'number' && totalPaymentAmount > 0 && cumulativeRefunded >= totalPaymentAmount);

      if (chargeRefundsList.length > 0) {
        for (const r of chargeRefundsList) {
          const rAmount = Number.isFinite(Number(r?.amount)) ? Math.trunc(Number(r.amount)) : 0;
          const { status: rStatus, rawStatus } = this.normalizeRefundStatus(r?.status, event.type);
          const rIsFull =
            rStatus === 'succeeded' &&
            rAmount > 0 &&
            (chargeFullyRefunded ||
              (typeof totalPaymentAmount === 'number' && totalPaymentAmount > 0 && rAmount >= totalPaymentAmount));
          itemsToProcess.push({
            refundId: r?.id || `chg_refund_${chargeId || paymentIntentId || event.id}_${rAmount}`,
            amount: rAmount,
            status: rStatus,
            rawStatus,
            failureReason: r?.failure_reason || undefined,
            isFull: rIsFull,
          });
        }
      } else {
        // charge.refunded without refunds.data list: derive status strictly from charge.refunded / amount_refunded > 0
        const hasValidChargeRefundSignal = obj?.refunded === true || cumulativeRefunded > 0;
        const derivedStatus: StripeRefundStatus = hasValidChargeRefundSignal ? 'succeeded' : 'unknown';
        const effectiveAmount = cumulativeRefunded > 0 ? cumulativeRefunded : (obj?.refunded === true ? (totalPaymentAmount || 0) : 0);
        itemsToProcess.push({
          refundId: `chg_refund_${chargeId || paymentIntentId || event.id}_${effectiveAmount}`,
          amount: effectiveAmount,
          status: derivedStatus,
          rawStatus: hasValidChargeRefundSignal ? 'charge_summary_refunded' : 'missing_refund_summary',
          failureReason: hasValidChargeRefundSignal ? undefined : 'unknown_or_missing_refund_status: missing_charge_refund_summary',
          isFull: derivedStatus === 'succeeded' && effectiveAmount > 0 && (chargeFullyRefunded || (typeof totalPaymentAmount === 'number' && effectiveAmount >= totalPaymentAmount)),
        });
      }
    } else {
      // refund.created / refund.updated / refund.failed / charge.refund.updated
      const { status: rawNormStatus, rawStatus } = this.normalizeRefundStatus(obj?.status, event.type);
      const rAmount = Number.isFinite(Number(obj?.amount)) ? Math.trunc(Number(obj.amount)) : 0;
      const rIsFull =
        rawNormStatus === 'succeeded' &&
        rAmount > 0 &&
        typeof totalPaymentAmount === 'number' &&
        totalPaymentAmount > 0
          ? rAmount >= totalPaymentAmount
          : false;
      itemsToProcess.push({
        refundId: obj?.id || `refund_${event.id}`,
        amount: rAmount,
        status: rawNormStatus,
        rawStatus,
        failureReason: obj?.failure_reason || undefined,
        isFull: rIsFull,
      });
    }

    const nowIso = new Date().toISOString();
    let totalCreditsDeductedThisEvent = 0;

    for (const item of itemsToProcess) {
      const existingRefund: StripeRefundRecord | undefined = state.stripeRefunds[item.refundId];

      // 1. Failed or Canceled Refund: never adjust credits or revoke plan
      if (item.status === 'failed' || item.status === 'canceled') {
        const alreadyRecordedTerminalFailure =
          existingRefund && (existingRefund.status === 'failed' || existingRefund.status === 'canceled') && existingRefund.status === item.status;
        state.stripeRefunds[item.refundId] = {
          refundId: item.refundId,
          paymentId: payment?.id ?? existingRefund?.paymentId,
          userId: user?.id ?? existingRefund?.userId,
          chargeId,
          paymentIntentId,
          invoiceId,
          subscriptionId: effectiveSubId,
          planId,
          amountRefunded: Math.max(0, item.amount),
          totalAmount: totalPaymentAmount,
          isFullRefund: false,
          status: item.status,
          rawStatus: item.rawStatus,
          reconciled: Boolean(payment),
          creditsAdjusted: 0,
          failureReason: item.failureReason || (item.status === 'canceled' ? 'refund_canceled' : 'refund_failed'),
          eventId: event.id,
          createdAt: existingRefund?.createdAt || nowIso,
          updatedAt: nowIso,
        };

        if (!alreadyRecordedTerminalFailure && user) {
          recordCreditTx(state, {
            userId: user.id,
            delta: 0,
            balanceAfter: user.creditsRemaining,
            type: 'STRIPE_REFUND_FAILED',
            referenceId: `${item.refundId}:${item.status}`,
            metadataJson: JSON.stringify({
              eventId: event.id,
              refundId: item.refundId,
              chargeId,
              paymentIntentId,
              amountAttempted: item.amount,
              status: item.status,
              failureReason: item.failureReason || null,
            }),
          });
        }
        continue;
      }

      // 2. Provisional non-terminal states ('pending', 'requires_action'): persist without mutating credits/plan
      if (item.status === 'pending' || item.status === 'requires_action') {
        state.stripeRefunds[item.refundId] = {
          refundId: item.refundId,
          paymentId: payment?.id ?? existingRefund?.paymentId,
          userId: user?.id ?? existingRefund?.userId,
          chargeId,
          paymentIntentId,
          invoiceId,
          subscriptionId: effectiveSubId,
          planId,
          amountRefunded: Math.max(0, item.amount),
          totalAmount: totalPaymentAmount,
          isFullRefund: false,
          status: item.status,
          rawStatus: item.rawStatus,
          reconciled: false,
          creditsAdjusted: 0,
          eventId: event.id,
          createdAt: existingRefund?.createdAt || nowIso,
          updatedAt: nowIso,
        };
        continue;
      }

      // 3. Unknown / Missing / Null refund status: fail closed with diagnostic state, never deduct credits
      if (item.status === 'unknown') {
        state.stripeRefunds[item.refundId] = {
          refundId: item.refundId,
          paymentId: payment?.id ?? existingRefund?.paymentId,
          userId: user?.id ?? existingRefund?.userId,
          chargeId,
          paymentIntentId,
          invoiceId,
          subscriptionId: effectiveSubId,
          planId,
          amountRefunded: Math.max(0, item.amount),
          totalAmount: totalPaymentAmount,
          isFullRefund: false,
          status: 'unknown',
          rawStatus: item.rawStatus,
          reconciled: false,
          creditsAdjusted: 0,
          failureReason: item.failureReason || `unknown_or_missing_refund_status: ${item.rawStatus || 'missing'}`,
          eventId: event.id,
          createdAt: existingRefund?.createdAt || nowIso,
          updatedAt: nowIso,
        };
        continue;
      }

      // 4. Succeeded Refund: idempotent deduplication check
      if (existingRefund && existingRefund.status === 'succeeded' && (existingRefund.reconciled || !payment)) {
        // Already applied (e.g. refund.created arrived before charge.refunded or duplicate delivery)
        continue;
      }

      // Guard invalid or zero refund amount: persist without deducting credits or canceling subscription
      if (item.amount <= 0) {
        state.stripeRefunds[item.refundId] = {
          refundId: item.refundId,
          paymentId: payment?.id ?? existingRefund?.paymentId,
          userId: user?.id ?? existingRefund?.userId,
          chargeId,
          paymentIntentId,
          invoiceId,
          subscriptionId: effectiveSubId,
          planId,
          amountRefunded: Math.max(0, item.amount),
          totalAmount: totalPaymentAmount,
          isFullRefund: false,
          status: 'succeeded',
          rawStatus: item.rawStatus,
          reconciled: Boolean(payment),
          creditsAdjusted: 0,
          failureReason: item.amount < 0 ? 'invalid_negative_refund_amount' : 'zero_refund_amount',
          eventId: event.id,
          createdAt: existingRefund?.createdAt || nowIso,
          updatedAt: nowIso,
        };
        continue;
      }

      const refundCents = item.amount;
      const originalCreditsGranted = payment?.creditsGranted ?? (planId ? this.getPlanCreditAllocation(planId) : 0);

      // Out-of-order protection: payment hasn't arrived yet (e.g. refund.created/charge.refunded before checkout.session.completed or invoice.paid).
      // Record succeeded refund with reconciled=false and creditsAdjusted=0; do NOT deduct pre-existing unrelated balance yet.
      // When checkout.session.completed / invoice.paid / verifyAndSynchronizeSession arrives, reconcilePendingRefundsForPayment()
      // links and applies the exact net reversal atomically.
      if (!payment) {
        const isEstimatedFull = item.isFull ||
          (typeof totalPaymentAmount === 'number' && totalPaymentAmount > 0 && refundCents >= totalPaymentAmount);

        state.stripeRefunds[item.refundId] = {
          refundId: item.refundId,
          paymentId: undefined,
          userId: user?.id,
          chargeId,
          paymentIntentId,
          invoiceId,
          subscriptionId: effectiveSubId,
          planId,
          amountRefunded: refundCents,
          totalAmount: totalPaymentAmount,
          isFullRefund: isEstimatedFull,
          status: 'succeeded',
          rawStatus: item.rawStatus,
          reconciled: false,
          creditsAdjusted: 0,
          eventId: event.id,
          createdAt: existingRefund?.createdAt || nowIso,
          updatedAt: nowIso,
        };

        if (user) {
          recordCreditTx(state, {
            userId: user.id,
            delta: 0,
            balanceAfter: user.creditsRemaining,
            type: isEstimatedFull ? 'STRIPE_PAYMENT_REFUND' : 'STRIPE_PARTIAL_REFUND',
            referenceId: `${item.refundId}:awaiting_payment`,
            metadataJson: JSON.stringify({
              eventId: event.id,
              refundId: item.refundId,
              chargeId,
              paymentIntentId,
              invoiceId,
              subscriptionId: effectiveSubId,
              planId,
              amountRefunded: refundCents,
              totalPaymentAmount,
              refundScope: isEstimatedFull ? 'full' : 'partial',
              desiredCreditClawback: this.computeCumulativeTargetCredits(originalCreditsGranted, refundCents, totalPaymentAmount, isEstimatedFull),
              actualCreditsDeducted: 0,
              pendingPaymentReconciliation: true,
            }),
          });
        }
        continue;
      }

      // Payment exists: compute cumulative succeeded refund cents and proportional clawback
      const { priorCreditsAdjusted, priorSucceededCents } = this.getPriorRefundTotalsForPayment(
        state,
        {
          paymentId: payment.id,
          paymentIntentId,
          chargeId,
          invoiceId,
        },
        item.refundId
      );

      const effectiveRefundCents = (!isChargeEvent || (Array.isArray(obj?.refunds?.data) && obj.refunds.data.length > 0))
        ? refundCents
        : Math.max(0, refundCents - priorSucceededCents);

      if (effectiveRefundCents <= 0) {
        state.stripeRefunds[item.refundId] = {
          refundId: item.refundId,
          paymentId: payment.id,
          userId: user?.id,
          chargeId,
          paymentIntentId,
          invoiceId,
          subscriptionId: effectiveSubId,
          planId,
          amountRefunded: refundCents,
          totalAmount: totalPaymentAmount,
          isFullRefund: item.isFull,
          status: 'succeeded',
          rawStatus: item.rawStatus,
          reconciled: true,
          creditsAdjusted: 0,
          eventId: event.id,
          createdAt: existingRefund?.createdAt || nowIso,
          updatedAt: nowIso,
        };
        continue;
      }

      const cumulativeSucceededCents = priorSucceededCents + effectiveRefundCents;
      const isCumulativeFull = item.isFull ||
        (typeof totalPaymentAmount === 'number' && totalPaymentAmount > 0 && cumulativeSucceededCents >= totalPaymentAmount);

      const remainingReversible = Math.max(0, originalCreditsGranted - priorCreditsAdjusted);
      let desiredClawback = 0;

      if (remainingReversible > 0) {
        const cumulativeTarget = this.computeCumulativeTargetCredits(
          originalCreditsGranted,
          cumulativeSucceededCents,
          totalPaymentAmount,
          isCumulativeFull
        );
        const priorTarget = this.computeCumulativeTargetCredits(
          originalCreditsGranted,
          priorSucceededCents,
          totalPaymentAmount,
          false
        );
        const priorAccounted = Math.max(priorCreditsAdjusted, priorTarget);
        desiredClawback = Math.max(0, Math.min(remainingReversible, cumulativeTarget - priorAccounted));
      }

      let actualDeduction = 0;
      if (user) {
        actualDeduction = Math.min(Math.max(0, user.creditsRemaining), desiredClawback);
        if (actualDeduction > 0) {
          user.creditsRemaining -= actualDeduction;
        }
        totalCreditsDeductedThisEvent += actualDeduction;

        recordCreditTx(state, {
          userId: user.id,
          delta: -actualDeduction,
          balanceAfter: user.creditsRemaining,
          type: isCumulativeFull ? 'STRIPE_PAYMENT_REFUND' : 'STRIPE_PARTIAL_REFUND',
          referenceId: item.refundId,
          metadataJson: JSON.stringify({
            eventId: event.id,
            refundId: item.refundId,
            paymentId: payment.id,
            chargeId,
            paymentIntentId,
            invoiceId,
            subscriptionId: effectiveSubId,
            planId,
            amountRefunded: effectiveRefundCents,
            cumulativeRefundedCents: cumulativeSucceededCents,
            totalPaymentAmount,
            refundScope: isCumulativeFull ? 'full' : 'partial',
            desiredCreditClawback: desiredClawback,
            actualCreditsDeducted: actualDeduction,
            unrecoveredCredits: Math.max(0, desiredClawback - actualDeduction),
          }),
        });

        // Subscription revocation only on full cumulative refund of a subscription payment (never for audit_once one-time purchases)
        const isSubscriptionPurchase = Boolean(effectiveSubId) && planId !== 'audit_once';
        if (isCumulativeFull && isSubscriptionPurchase && effectiveSubId) {
          const targetSub = state.subscriptions[effectiveSubId];
          if (targetSub) {
            targetSub.status = 'canceled';
            targetSub.updatedAt = nowIso;
          }
          if (user.subscriptionId === effectiveSubId || !user.subscriptionId) {
            user.subscriptionStatus = 'canceled';
            user.plan = 'free';
          }
        }
      }

      const nextPaymentStatus = isCumulativeFull
        ? 'refunded'
        : (payment.status === 'refunded' ? 'refunded' : 'partially_refunded');

      this.upsertStripePayment(state, {
        id: payment.id,
        userId: payment.userId,
        chargeId: payment.chargeId || chargeId,
        paymentIntentId: payment.paymentIntentId || paymentIntentId,
        invoiceId: payment.invoiceId || invoiceId,
        status: nextPaymentStatus,
      });
      payment.status = nextPaymentStatus;

      state.stripeRefunds[item.refundId] = {
        refundId: item.refundId,
        paymentId: payment.id,
        userId: user?.id,
        chargeId,
        paymentIntentId,
        invoiceId,
        subscriptionId: effectiveSubId,
        planId,
        amountRefunded: effectiveRefundCents,
        totalAmount: totalPaymentAmount,
        isFullRefund: isCumulativeFull,
        status: 'succeeded',
        rawStatus: item.rawStatus,
        reconciled: true,
        creditsAdjusted: actualDeduction,
        eventId: event.id,
        createdAt: existingRefund?.createdAt || nowIso,
        updatedAt: nowIso,
      };
    }

    state.webhookEvents[event.id] = {
      eventId: event.id,
      provider: 'stripe',
      eventType: event.type,
      processedAt: nowIso,
      userId: user?.id,
      creditsGranted: totalCreditsDeductedThisEvent > 0 ? -totalCreditsDeductedThisEvent : 0,
      planGranted: planId,
    };
  }

  /**
   * Executes transactional state updates for verified webhook events
   */
  private async processVerifiedEvent(event: Stripe.Event): Promise<{ alreadyProcessed: boolean }> {
    return await this.getActiveStorage().runTransaction(async (state) => {
      // Idempotency check inside transaction
      if (state.webhookEvents[event.id]) {
        console.log(`[BillingService] Idempotency hit: Event ${event.id} already processed.`);
        return { alreadyProcessed: true };
      }

      const eventCreatedMs = (event.created || 0) * 1000;
      const isOutOfOrder = (subRecord: any) => {
        if (!subRecord || !subRecord.updatedAt || !event.created) return false;
        const subUpdatedMs = new Date(subRecord.updatedAt).getTime();
        return subUpdatedMs > 0 && eventCreatedMs < subUpdatedMs;
      };

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const clientRefId = (session.client_reference_id && typeof session.client_reference_id === 'string')
            ? session.client_reference_id.trim()
            : undefined;
          const metadataUserId = (session.metadata?.userId && typeof session.metadata.userId === 'string')
            ? session.metadata.userId.trim()
            : undefined;

          if (!clientRefId && !metadataUserId) {
            throw new Error(`checkout.session.completed missing user reference in session ${session.id}`);
          }
          if (clientRefId && metadataUserId && clientRefId !== metadataUserId) {
            throw new Error(`checkout.session.completed has conflicting user references in session ${session.id}`);
          }
          const userId = clientRefId || metadataUserId;
          if (!userId) {
            throw new Error(`checkout.session.completed missing user reference in session ${session.id}`);
          }

          const user = state.users[userId];
          if (!user) {
            throw new Error(`User not found for checkout session: ${userId}`);
          }
          const planId = session.metadata?.planId;
          if (!planId || !ALLOWED_PAID_PLANS.includes(planId as any)) {
            throw new Error(`Invalid or missing plan ID in checkout session metadata: ${planId}`);
          }

          const sessionPaymentIntentId = typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id;
          const sessionInvoiceId = typeof session.invoice === 'string'
            ? session.invoice
            : session.invoice?.id;
          const sessionCustomerId = typeof session.customer === 'string'
            ? session.customer
            : session.customer?.id;
          const sessionSubId = typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;

          // Payment status verification
          const isPaid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
          if (!isPaid) {
            console.warn(`[BillingService] Checkout session ${session.id} payment status is '${session.payment_status}'. Entitlements withheld.`);
            state.webhookEvents[event.id] = {
              eventId: event.id,
              provider: 'stripe',
              eventType: event.type,
              processedAt: new Date().toISOString(),
              userId: user.id,
            };
            return { alreadyProcessed: false };
          }

          // Out-of-order protection: if a full refund for this payment_intent/invoice arrived before checkout.session.completed,
          // record payment correlation in 'refunded' state, cancel any subscription if applicable, and do NOT grant unreversed credits.
          if (this.hasSucceededFullRefund(state, { paymentIntentId: sessionPaymentIntentId, invoiceId: sessionInvoiceId })) {
            const refundedPayment = this.upsertStripePayment(state, {
              id: `pay_${session.id}`,
              userId: user.id,
              sessionId: session.id,
              paymentIntentId: sessionPaymentIntentId,
              invoiceId: sessionInvoiceId,
              subscriptionId: sessionSubId,
              customerId: sessionCustomerId,
              planId,
              creditsGranted: 0,
              amountTotal: typeof session.amount_total === 'number' ? session.amount_total : undefined,
              currency: session.currency || undefined,
              status: 'refunded',
            });
            if (sessionCustomerId) {
              user.stripeCustomerId = sessionCustomerId;
            }
            if (sessionSubId && planId !== 'audit_once') {
              const nowIso = new Date().toISOString();
              user.subscriptionId = sessionSubId;
              user.subscriptionStatus = 'canceled';
              user.plan = 'free';
              state.subscriptions[sessionSubId] = {
                id: sessionSubId,
                userId: user.id,
                planId,
                status: 'canceled',
                createdAt: state.subscriptions[sessionSubId]?.createdAt || nowIso,
                updatedAt: nowIso,
              };
            }
            this.reconcilePendingRefundsForPayment(state, refundedPayment, user, new Date().toISOString());
            state.webhookEvents[event.id] = {
              eventId: event.id,
              provider: 'stripe',
              eventType: event.type,
              processedAt: new Date().toISOString(),
              userId: user.id,
              creditsGranted: 0,
              planGranted: planId,
            };
            state.webhookEvents[session.id] = state.webhookEvents[event.id];
            return { alreadyProcessed: false };
          }

          // Idempotency against prior synchronous session verification or duplicate webhook
          const syncEventId = `sync_${session.id}`;
          let alreadyCredited = !!state.webhookEvents[syncEventId] || !!state.webhookEvents[session.id];
          if (!alreadyCredited) {
            if (state.prepare && typeof state.prepare === 'function') {
              const row = state.prepare('SELECT id FROM credit_transactions WHERE reference_id = ? OR reference_id = ?').get(session.id, syncEventId) as any;
              if (row) alreadyCredited = true;
            } else if (Array.isArray((state as any).creditTransactions)) {
              alreadyCredited = (state as any).creditTransactions.some((tx: any) => tx.referenceId === session.id || tx.referenceId === syncEventId);
            }
          }

          if (alreadyCredited) {
            console.log(`[BillingService] checkout.session.completed: Session ${session.id} already credited. Synchronizing subscription records only.`);
            if (sessionCustomerId) {
              user.stripeCustomerId = sessionCustomerId;
            }
            if (sessionSubId) {
              user.subscriptionId = sessionSubId;
              user.subscriptionStatus = 'active';

              state.subscriptions[sessionSubId] = {
                id: sessionSubId,
                userId: user.id,
                planId,
                status: 'active',
                createdAt: new Date().toISOString(),
                updatedAt: new Date(Math.max(Date.now(), eventCreatedMs)).toISOString(),
              };
            }
            const existingOrSyncedPayment = this.upsertStripePayment(state, {
              id: `pay_${session.id}`,
              userId: user.id,
              sessionId: session.id,
              paymentIntentId: sessionPaymentIntentId,
              invoiceId: sessionInvoiceId,
              subscriptionId: sessionSubId,
              customerId: sessionCustomerId,
              planId,
              creditsGranted: this.getPlanCreditAllocation(planId),
              amountTotal: typeof session.amount_total === 'number' ? session.amount_total : undefined,
              currency: session.currency || undefined,
              status: 'paid',
            });
            this.reconcilePendingRefundsForPayment(state, existingOrSyncedPayment, user, new Date().toISOString());
            state.webhookEvents[event.id] = {
              eventId: event.id,
              provider: 'stripe',
              eventType: event.type,
              processedAt: new Date().toISOString(),
              userId: user.id,
              creditsGranted: 0,
              planGranted: planId,
            };
            state.webhookEvents[session.id] = state.webhookEvents[event.id];
            return { alreadyProcessed: false };
          }

          const creditAllocation = this.getPlanCreditAllocation(planId);
          if (planId === 'audit_once') {
            user.creditsRemaining += creditAllocation;
          } else {
            user.plan = planId as any;
            user.creditsRemaining = Math.max(0, user.creditsRemaining) + creditAllocation;
          }

          if (sessionCustomerId) {
            user.stripeCustomerId = sessionCustomerId;
          }
          if (sessionSubId) {
            user.subscriptionId = sessionSubId;
            user.subscriptionStatus = 'active';

            state.subscriptions[sessionSubId] = {
              id: sessionSubId,
              userId: user.id,
              planId,
              status: 'active',
              createdAt: new Date().toISOString(),
              updatedAt: new Date(Math.max(Date.now(), eventCreatedMs)).toISOString(),
            };
          }

          const createdPayment = this.upsertStripePayment(state, {
            id: `pay_${session.id}`,
            userId: user.id,
            sessionId: session.id,
            paymentIntentId: sessionPaymentIntentId,
            invoiceId: sessionInvoiceId,
            subscriptionId: sessionSubId,
            customerId: sessionCustomerId,
            planId,
            creditsGranted: creditAllocation,
            amountTotal: typeof session.amount_total === 'number' ? session.amount_total : undefined,
            currency: session.currency || undefined,
            status: 'paid',
          });

          state.webhookEvents[event.id] = {
            eventId: event.id,
            provider: 'stripe',
            eventType: event.type,
            processedAt: new Date().toISOString(),
            userId: user.id,
            creditsGranted: creditAllocation,
            planGranted: planId,
          };
          state.webhookEvents[session.id] = state.webhookEvents[event.id];

          recordCreditTx(state, {
            userId: user.id,
            delta: creditAllocation,
            balanceAfter: user.creditsRemaining,
            type: 'PLAN_PURCHASE',
            referenceId: session.id,
            metadataJson: JSON.stringify({
              planId,
              sessionId: session.id,
              paymentIntentId: sessionPaymentIntentId || null,
              invoiceId: sessionInvoiceId || null,
              eventId: event.id,
            })
          });

          // Reconcile any partial/out-of-order refunds that arrived before checkout.session.completed
          this.reconcilePendingRefundsForPayment(state, createdPayment, user, new Date().toISOString());

          console.log(`[BillingService] checkout.session.completed: Allocated ${creditAllocation} credits to ${userId} for plan ${planId}`);
          break;
        }

        case 'invoice.paid': {
          const invoice = event.data.object as any;
          const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
          const invoicePaymentIntentId = typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id;
          const invoiceChargeId = typeof invoice.charge === 'string' ? invoice.charge : invoice.charge?.id;
          const invoiceCustomerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;

          if (subId) {
            const sub = state.subscriptions[subId];
            if (sub) {
              if (isOutOfOrder(sub)) {
                console.log(`[BillingService] Out-of-order invoice.paid event ${event.id} ignored.`);
                state.webhookEvents[event.id] = {
                  eventId: event.id,
                  provider: 'stripe',
                  eventType: event.type,
                  processedAt: new Date().toISOString(),
                };
                return { alreadyProcessed: false };
              }

              sub.status = 'active';
              sub.updatedAt = new Date(Math.max(Date.now(), eventCreatedMs)).toISOString();

              const user = state.users[sub.userId];
              if (user) {
                const isRenewal = invoice.billing_reason === 'subscription_cycle';
                const hasPriorFullRefund = this.hasSucceededFullRefund(state, {
                  paymentIntentId: invoicePaymentIntentId,
                  chargeId: invoiceChargeId,
                  invoiceId: invoice.id,
                });

                if (hasPriorFullRefund) {
                  sub.status = 'canceled';
                  user.subscriptionStatus = 'canceled';
                  user.plan = 'free';
                  const refundedInvPayment = this.upsertStripePayment(state, {
                    id: `pay_inv_${invoice.id || event.id}`,
                    userId: sub.userId,
                    paymentIntentId: invoicePaymentIntentId,
                    chargeId: invoiceChargeId,
                    invoiceId: invoice.id,
                    subscriptionId: subId,
                    customerId: invoiceCustomerId || user.stripeCustomerId,
                    planId: sub.planId,
                    creditsGranted: 0,
                    amountTotal: typeof invoice.amount_paid === 'number' ? invoice.amount_paid : undefined,
                    currency: invoice.currency || undefined,
                    status: 'refunded',
                  });
                  this.reconcilePendingRefundsForPayment(state, refundedInvPayment, user, new Date().toISOString());
                  state.webhookEvents[event.id] = {
                    eventId: event.id,
                    provider: 'stripe',
                    eventType: event.type,
                    processedAt: new Date().toISOString(),
                    userId: sub.userId,
                    creditsGranted: 0,
                    planGranted: sub.planId,
                  };
                  return { alreadyProcessed: false };
                }

                user.subscriptionStatus = 'active';
                user.plan = sub.planId as any;

                const creditAllocation = isRenewal ? this.getPlanCreditAllocation(sub.planId) : 0;

                if (isRenewal) {
                  user.creditsRemaining += creditAllocation;
                }

                const invPayment = this.upsertStripePayment(state, {
                  id: `pay_inv_${invoice.id || event.id}`,
                  userId: sub.userId,
                  paymentIntentId: invoicePaymentIntentId,
                  chargeId: invoiceChargeId,
                  invoiceId: invoice.id,
                  subscriptionId: subId,
                  customerId: invoiceCustomerId || user.stripeCustomerId,
                  planId: sub.planId,
                  creditsGranted: isRenewal ? creditAllocation : this.getPlanCreditAllocation(sub.planId),
                  amountTotal: typeof invoice.amount_paid === 'number' ? invoice.amount_paid : undefined,
                  currency: invoice.currency || undefined,
                  status: 'paid',
                });

                if (isRenewal) {
                  state.webhookEvents[event.id] = {
                    eventId: event.id,
                    provider: 'stripe',
                    eventType: event.type,
                    processedAt: new Date().toISOString(),
                    userId: sub.userId,
                    creditsGranted: creditAllocation,
                    planGranted: sub.planId,
                  };
                  recordCreditTx(state, {
                    userId: sub.userId,
                    delta: creditAllocation,
                    balanceAfter: user.creditsRemaining,
                    type: 'SUBSCRIPTION_RENEWAL',
                    referenceId: event.id,
                    metadataJson: JSON.stringify({
                      planId: sub.planId,
                      invoiceId: invoice.id,
                      paymentIntentId: invoicePaymentIntentId || null,
                      chargeId: invoiceChargeId || null,
                    })
                  });
                  this.reconcilePendingRefundsForPayment(state, invPayment, user, new Date().toISOString());
                  return { alreadyProcessed: false };
                }
                this.reconcilePendingRefundsForPayment(state, invPayment, user, new Date().toISOString());
              }
            }
          }
          state.webhookEvents[event.id] = {
            eventId: event.id,
            provider: 'stripe',
            eventType: event.type,
            processedAt: new Date().toISOString(),
          };
          break;
        }

        case 'charge.refunded':
        case 'charge.refund.updated':
        case 'refund.created':
        case 'refund.updated':
        case 'refund.failed': {
          this.processRefundWebhook(state, event);
          break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription;
          const subId = subscription.id;
          const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
          const status = subscription.status;
          const currentPeriodEnd = (subscription as any).current_period_end 
            ? new Date((subscription as any).current_period_end * 1000).toISOString() 
            : undefined;

          let sub = state.subscriptions[subId];
          if (sub && isOutOfOrder(sub)) {
            console.log(`[BillingService] Out-of-order ${event.type} event ${event.id} ignored.`);
            state.webhookEvents[event.id] = {
              eventId: event.id,
              provider: 'stripe',
              eventType: event.type,
              processedAt: new Date().toISOString(),
              userId: sub.userId,
            };
            return { alreadyProcessed: false };
          }

          let userId = sub?.userId;
          if (!userId && (subscription.metadata?.userId || (subscription as any).client_reference_id)) {
            userId = (subscription.metadata?.userId || (subscription as any).client_reference_id).trim();
          }
          if (!userId && customerId) {
            if (state.prepare && typeof state.prepare === 'function') {
              const row = state.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(customerId) as any;
              if (row) userId = row.id;
            }
            if (!userId) {
              const userWithCustomer = Object.values(state.users).find((u: any) => u.stripeCustomerId === customerId);
              if (userWithCustomer) userId = (userWithCustomer as any).id;
            }
          }

          if (userId) {
            const user = state.users[userId];
            if (user) {
              user.subscriptionStatus = status;
              if (customerId) user.stripeCustomerId = customerId;
              user.subscriptionId = subId;

              const priceId = subscription.items?.data?.[0]?.price?.id;
              let mappedPlanId: AllowedPaidPlan | null = null;
              if (priceId) {
                mappedPlanId = this.getPlanFromPriceId(priceId);
              }
              if (!mappedPlanId && subscription.metadata?.planId && ALLOWED_PAID_PLANS.includes(subscription.metadata.planId as any)) {
                mappedPlanId = subscription.metadata.planId as AllowedPaidPlan;
              }
              if (!mappedPlanId && sub?.planId && ALLOWED_PAID_PLANS.includes(sub.planId as any) && sub.planId !== 'free') {
                mappedPlanId = sub.planId as AllowedPaidPlan;
              }
              if (!mappedPlanId && user.plan && ALLOWED_PAID_PLANS.includes(user.plan as any) && user.plan !== 'free') {
                mappedPlanId = user.plan as AllowedPaidPlan;
              }
              if (!mappedPlanId) {
                mappedPlanId = 'pro';
              }

              const entitled = this.isSubscriptionEntitled(status, currentPeriodEnd);
              if (entitled) {
                user.plan = mappedPlanId as any;
              } else {
                user.plan = 'free';
              }

              state.subscriptions[subId] = {
                id: subId,
                userId: user.id,
                planId: mappedPlanId,
                status: status as any,
                currentPeriodEnd,
                createdAt: sub?.createdAt || new Date().toISOString(),
                updatedAt: new Date(Math.max(Date.now(), eventCreatedMs)).toISOString(),
              };
            }
          }

          state.webhookEvents[event.id] = {
            eventId: event.id,
            provider: 'stripe',
            eventType: event.type,
            processedAt: new Date().toISOString(),
            userId: userId || undefined,
          };
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;
          const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
          let sub = state.subscriptions[subscription.id];
          if (sub && isOutOfOrder(sub)) {
            console.log(`[BillingService] Out-of-order customer.subscription.deleted event ${event.id} ignored.`);
            state.webhookEvents[event.id] = {
              eventId: event.id,
              provider: 'stripe',
              eventType: event.type,
              processedAt: new Date().toISOString(),
            };
            return { alreadyProcessed: false };
          }

          let userId = sub?.userId;
          if (!userId && (subscription.metadata?.userId || (subscription as any).client_reference_id)) {
            userId = (subscription.metadata?.userId || (subscription as any).client_reference_id).trim();
          }
          if (!userId && customerId) {
            if (state.prepare && typeof state.prepare === 'function') {
              const row = state.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(customerId) as any;
              if (row) userId = row.id;
            }
            if (!userId) {
              const userWithCustomer = Object.values(state.users).find((u: any) => u.stripeCustomerId === customerId);
              if (userWithCustomer) userId = (userWithCustomer as any).id;
            }
          }

          const currentPeriodEnd = (subscription as any).current_period_end 
            ? new Date((subscription as any).current_period_end * 1000).toISOString() 
            : sub?.currentPeriodEnd;

          if (sub) {
            sub.status = 'canceled';
            sub.currentPeriodEnd = currentPeriodEnd;
            sub.updatedAt = new Date(Math.max(Date.now(), eventCreatedMs)).toISOString();
          } else if (userId) {
            state.subscriptions[subscription.id] = {
              id: subscription.id,
              userId,
              planId: 'free',
              status: 'canceled',
              currentPeriodEnd,
              createdAt: new Date().toISOString(),
              updatedAt: new Date(Math.max(Date.now(), eventCreatedMs)).toISOString(),
            };
          }

          if (userId) {
            const user = state.users[userId];
            if (user) {
              user.subscriptionStatus = 'canceled';
              const entitled = this.isSubscriptionEntitled('canceled', currentPeriodEnd);
              if (!entitled) {
                user.plan = 'free';
              }
            }
          }

          state.webhookEvents[event.id] = {
            eventId: event.id,
            provider: 'stripe',
            eventType: event.type,
            processedAt: new Date().toISOString(),
            userId: userId || undefined,
          };
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as any;
          const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
          const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
          let sub = subId ? state.subscriptions[subId] : undefined;
          let userId = sub?.userId;

          if (!userId && customerId) {
            if (state.prepare && typeof state.prepare === 'function') {
              const row = state.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(customerId) as any;
              if (row) userId = row.id;
            }
            if (!userId) {
              const userWithCustomer = Object.values(state.users).find((u: any) => u.stripeCustomerId === customerId);
              if (userWithCustomer) userId = (userWithCustomer as any).id;
            }
          }

          if (subId) {
            if (sub) {
              if (isOutOfOrder(sub)) {
                console.log(`[BillingService] Out-of-order invoice.payment_failed event ${event.id} ignored.`);
                state.webhookEvents[event.id] = {
                  eventId: event.id,
                  provider: 'stripe',
                  eventType: event.type,
                  processedAt: new Date().toISOString(),
                };
                return { alreadyProcessed: false };
              }

              sub.status = 'past_due';
              sub.updatedAt = new Date(Math.max(Date.now(), eventCreatedMs)).toISOString();
            }
          }

          if (userId) {
            const user = state.users[userId];
            if (user) {
              user.subscriptionStatus = 'past_due';
              const periodEnd = sub?.currentPeriodEnd;
              if (!this.isSubscriptionEntitled('past_due', periodEnd)) {
                user.plan = 'free';
              }
            }
          }
          state.webhookEvents[event.id] = {
            eventId: event.id,
            provider: 'stripe',
            eventType: event.type,
            processedAt: new Date().toISOString(),
          };
          break;
        }

        default: {
          state.webhookEvents[event.id] = {
            eventId: event.id,
            provider: 'stripe',
            eventType: event.type,
            processedAt: new Date().toISOString(),
          };
          break;
        }
      }

      return { alreadyProcessed: false };
    });
  }

  /**
   * Authoritatively verifies Checkout Session status against Stripe
   */
  public async verifyCheckoutSession(sessionId: string, authenticatedUserId: string): Promise<{
    status: 'complete' | 'pending' | 'unpaid' | 'expired' | 'canceled' | 'unknown';
    paymentStatus: string;
    planId?: string;
    livemode?: boolean;
  }> {
    const stripe = this.getStripeClient();
    if (!stripe) {
      const err: any = new Error('Stripe client is not configured.');
      err.statusCode = 500;
      throw err;
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session) {
      const err: any = new Error(`Checkout session ${sessionId} not found.`);
      err.statusCode = 404;
      throw err;
    }

    const clientRefId = (session.client_reference_id && typeof session.client_reference_id === 'string')
      ? session.client_reference_id.trim()
      : undefined;
    const metadataUserId = (session.metadata?.userId && typeof session.metadata.userId === 'string')
      ? session.metadata.userId.trim()
      : undefined;

    // Fail closed: require authoritative non-empty ownership identifier
    if (!clientRefId && !metadataUserId) {
      const err: any = new Error('Checkout session is missing authoritative user ownership metadata.');
      err.statusCode = 403;
      throw err;
    }

    // Reject conflicting ownership metadata
    if (clientRefId && metadataUserId && clientRefId !== metadataUserId) {
      const err: any = new Error('Checkout session contains conflicting user ownership identifiers.');
      err.statusCode = 403;
      throw err;
    }

    const sessionUserId = clientRefId || metadataUserId;
    if (!sessionUserId || sessionUserId !== authenticatedUserId) {
      const err: any = new Error('Checkout session does not belong to the authenticated user.');
      err.statusCode = 403;
      throw err;
    }

    let status: 'complete' | 'pending' | 'unpaid' | 'expired' | 'canceled' | 'unknown' = 'pending';
    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
      status = 'complete';
    } else if (session.payment_status === 'unpaid') {
      status = 'unpaid';
    } else if (session.status === 'expired') {
      status = 'expired';
    } else if (session.status === 'open') {
      status = 'pending';
    }

    return {
      status,
      paymentStatus: session.payment_status || 'unpaid',
      planId: session.metadata?.planId,
      livemode: session.livemode,
    };
  }

  /**
   * Verifies Stripe checkout session status AND idempotently synchronizes user entitlements
   * when payment is complete, returning the updated user account.
   */
  public async verifyAndSynchronizeSession(sessionId: string, authenticatedUserId: string): Promise<{
    status: 'complete' | 'pending' | 'unpaid' | 'expired' | 'canceled' | 'unknown';
    paymentStatus: string;
    planId?: string;
    livemode?: boolean;
    entitlementActive: boolean;
    user?: UserAccount;
    message?: string;
  }> {
    const stripe = this.getStripeClient();
    if (!stripe) {
      const err: any = new Error('Stripe client is not configured.');
      err.statusCode = 500;
      throw err;
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session) {
      const err: any = new Error(`Checkout session ${sessionId} not found.`);
      err.statusCode = 404;
      throw err;
    }

    const clientRefId = (session.client_reference_id && typeof session.client_reference_id === 'string')
      ? session.client_reference_id.trim()
      : undefined;
    const metadataUserId = (session.metadata?.userId && typeof session.metadata.userId === 'string')
      ? session.metadata.userId.trim()
      : undefined;

    // Fail closed: require authoritative non-empty ownership identifier
    if (!clientRefId && !metadataUserId) {
      const err: any = new Error('Checkout session is missing authoritative user ownership metadata.');
      err.statusCode = 403;
      throw err;
    }

    // Reject conflicting ownership metadata
    if (clientRefId && metadataUserId && clientRefId !== metadataUserId) {
      const err: any = new Error('Checkout session contains conflicting user ownership identifiers.');
      err.statusCode = 403;
      throw err;
    }

    const sessionUserId = clientRefId || metadataUserId;
    if (!sessionUserId || sessionUserId !== authenticatedUserId) {
      const err: any = new Error('Checkout session does not belong to the authenticated user.');
      err.statusCode = 403;
      throw err;
    }

    const planId = session.metadata?.planId;
    if (planId && !ALLOWED_PAID_PLANS.includes(planId as any)) {
      const err: any = new Error(`Invalid plan ID in checkout session: ${planId}`);
      err.statusCode = 400;
      throw err;
    }

    const isPaid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';

    if (!isPaid) {
      let status: 'complete' | 'pending' | 'unpaid' | 'expired' | 'canceled' | 'unknown' = 'pending';
      if (session.payment_status === 'unpaid') {
        status = 'unpaid';
      } else if (session.status === 'expired') {
        status = 'expired';
      } else if (session.status === 'open') {
        status = 'pending';
      }

      return {
        status,
        paymentStatus: session.payment_status || 'unpaid',
        planId,
        livemode: session.livemode,
        entitlementActive: false,
        message: status === 'pending'
          ? 'Payment confirmation pending with payment provider.'
          : `Checkout was not completed (payment status: ${session.payment_status}).`
      };
    }

    // Payment verified: Synchronize user entitlement idempotently inside database transaction
    const syncEventId = `sync_${session.id}`;
    const targetUserId = sessionUserId;

    const updatedUser = await this.getActiveStorage().runTransaction(async (state) => {
      const user = state.users[targetUserId];
      if (!user) {
        throw new Error(`User not found: ${targetUserId}`);
      }

      // Check if already processed (either via webhook or prior sync call)
      let alreadyCredited = !!state.webhookEvents[syncEventId] || !!state.webhookEvents[session.id];
      if (!alreadyCredited) {
        if (state.prepare && typeof state.prepare === 'function') {
          const row = state.prepare('SELECT id FROM credit_transactions WHERE reference_id = ? OR reference_id = ?').get(session.id, syncEventId) as any;
          if (row) alreadyCredited = true;
        } else if (Array.isArray((state as any).creditTransactions)) {
          alreadyCredited = (state as any).creditTransactions.some((tx: any) => tx.referenceId === session.id || tx.referenceId === syncEventId);
        }
      }

      if (alreadyCredited) {
        return user;
      }

      if (planId) {
        const sessionPaymentIntentId = typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id;
        const sessionInvoiceId = typeof session.invoice === 'string'
          ? session.invoice
          : session.invoice?.id;
        const sessionCustomerId = typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id;
        const sessionSubId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id;

        if (this.hasSucceededFullRefund(state, { paymentIntentId: sessionPaymentIntentId, invoiceId: sessionInvoiceId })) {
          const refundedSyncPayment = this.upsertStripePayment(state, {
            id: `pay_${session.id}`,
            userId: user.id,
            sessionId: session.id,
            paymentIntentId: sessionPaymentIntentId,
            invoiceId: sessionInvoiceId,
            subscriptionId: sessionSubId,
            customerId: sessionCustomerId,
            planId,
            creditsGranted: 0,
            amountTotal: typeof session.amount_total === 'number' ? session.amount_total : undefined,
            currency: session.currency || undefined,
            status: 'refunded',
          });
          if (sessionCustomerId) {
            user.stripeCustomerId = sessionCustomerId;
          }
          if (sessionSubId && planId !== 'audit_once') {
            const nowIso = new Date().toISOString();
            user.subscriptionId = sessionSubId;
            user.subscriptionStatus = 'canceled';
            user.plan = 'free';
            state.subscriptions[sessionSubId] = {
              id: sessionSubId,
              userId: user.id,
              planId,
              status: 'canceled',
              createdAt: state.subscriptions[sessionSubId]?.createdAt || nowIso,
              updatedAt: nowIso,
            };
          }
          this.reconcilePendingRefundsForPayment(state, refundedSyncPayment, user, new Date().toISOString());
          state.webhookEvents[syncEventId] = {
            eventId: syncEventId,
            provider: 'stripe',
            eventType: 'checkout.session.completed',
            processedAt: new Date().toISOString(),
            userId: user.id,
            creditsGranted: 0,
            planGranted: planId,
          };
          state.webhookEvents[session.id] = state.webhookEvents[syncEventId];
          return user;
        }

        const creditAllocation = this.getPlanCreditAllocation(planId);
        if (planId === 'audit_once') {
          user.creditsRemaining += creditAllocation;
        } else {
          user.plan = planId as any;
          user.creditsRemaining = Math.max(0, user.creditsRemaining) + creditAllocation;
        }

        if (sessionCustomerId) {
          user.stripeCustomerId = sessionCustomerId;
        }

        if (sessionSubId) {
          user.subscriptionId = sessionSubId;
          user.subscriptionStatus = 'active';

          state.subscriptions[sessionSubId] = {
            id: sessionSubId,
            userId: user.id,
            planId,
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        }

        const syncedPayment = this.upsertStripePayment(state, {
          id: `pay_${session.id}`,
          userId: user.id,
          sessionId: session.id,
          paymentIntentId: sessionPaymentIntentId,
          invoiceId: sessionInvoiceId,
          subscriptionId: sessionSubId,
          customerId: sessionCustomerId,
          planId,
          creditsGranted: creditAllocation,
          amountTotal: typeof session.amount_total === 'number' ? session.amount_total : undefined,
          currency: session.currency || undefined,
          status: 'paid',
        });

        state.webhookEvents[syncEventId] = {
          eventId: syncEventId,
          provider: 'stripe',
          eventType: 'checkout.session.completed',
          processedAt: new Date().toISOString(),
          userId: user.id,
          creditsGranted: creditAllocation,
          planGranted: planId,
        };
        state.webhookEvents[session.id] = state.webhookEvents[syncEventId];

        recordCreditTx(state, {
          userId: user.id,
          delta: creditAllocation,
          balanceAfter: user.creditsRemaining,
          type: 'PLAN_PURCHASE',
          referenceId: session.id,
          metadataJson: JSON.stringify({
            planId,
            sessionId: session.id,
            paymentIntentId: sessionPaymentIntentId || null,
            invoiceId: sessionInvoiceId || null,
            source: 'session_sync',
          })
        });

        this.reconcilePendingRefundsForPayment(state, syncedPayment, user, new Date().toISOString());
      }

      return user;
    });

    return {
      status: 'complete',
      paymentStatus: session.payment_status || 'paid',
      planId,
      livemode: session.livemode,
      entitlementActive: true,
      user: updatedUser
    };
  }

  /**
   * Generates an authenticated Stripe Customer Portal session URL
   */
  public async createCustomerPortalSession(userId: string, returnUrl?: string | null): Promise<{ url: string }> {
    const stripe = this.getStripeClient();
    if (!stripe) {
      const err: any = new Error('Stripe client is not configured.');
      err.statusCode = 500;
      throw err;
    }

    const user = await storage.users.getUser(userId);
    if (!user) {
      const err: any = new Error('User not found.');
      err.statusCode = 404;
      throw err;
    }

    if (!user.stripeCustomerId) {
      const err: any = new Error('No billing history or active Stripe customer found for this account.');
      err.statusCode = 400;
      throw err;
    }

    // Strict validation of return URL against trusted origins
    const validatedReturnUrl = this.validatePortalReturnUrl(returnUrl);

    try {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: validatedReturnUrl,
      });

      return { url: portalSession.url };
    } catch (err: any) {
      console.error('[BillingService] Customer Portal session creation failed:', err.message);
      const error: any = new Error(`Failed to create billing portal session: ${err.message}`);
      error.statusCode = 502;
      throw error;
    }
  }

  /**
   * Completes a simulated checkout session (strictly for non-production environments)
   */
  public async completeSimulatedCheckout(sessionId: string, planId: string, userId: string): Promise<UserAccount> {
    const paymentMode = process.env.PAYMENT_MODE;
    const requireLive = this.isProduction || paymentMode === 'production' || paymentMode === 'live';
    if (requireLive) {
      throw new Error('Simulation checkout completion is strictly forbidden in production mode.');
    }

    if (!sessionId.startsWith('sim_')) {
      throw new Error('Invalid simulation session ID format.');
    }

    if (!ALLOWED_PAID_PLANS.includes(planId as any)) {
      throw new Error(`Invalid plan for simulation checkout: ${planId}`);
    }

    const syntheticEventId = `sim_evt_${sessionId}`;

    return await storage.runTransaction(async (state) => {
      const alreadyProcessed = !!state.webhookEvents[syntheticEventId];
      const user = state.users[userId];
      if (!user) {
        throw new Error(`User not found: ${userId}`);
      }

      if (alreadyProcessed) {
        return user;
      }

      const creditAllocation = this.getPlanCreditAllocation(planId);
      if (planId === 'audit_once') {
        user.creditsRemaining += creditAllocation;
      } else {
        user.plan = planId as any;
        user.creditsRemaining = Math.max(0, user.creditsRemaining) + creditAllocation;
      }

      state.webhookEvents[syntheticEventId] = {
        eventId: syntheticEventId,
        provider: 'stripe',
        eventType: 'checkout.session.completed',
        processedAt: new Date().toISOString(),
        userId: user.id,
        creditsGranted: creditAllocation,
        planGranted: planId,
      };

      recordCreditTx(state, {
        userId: user.id,
        delta: creditAllocation,
        balanceAfter: user.creditsRemaining,
        type: 'SIMULATED_PURCHASE',
        referenceId: syntheticEventId,
        metadataJson: JSON.stringify({ planId })
      });

      return user;
    });
  }
}

export const billingService = new BillingService();
