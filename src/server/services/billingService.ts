import Stripe from 'stripe';
import { storage } from '../storage';
import { UserAccount, SubscriptionRecord, WebhookEventRecord } from '../../types';

export const ALLOWED_PAID_PLANS = ['creator', 'pro', 'agency', 'audit_once'] as const;
export type AllowedPaidPlan = typeof ALLOWED_PAID_PLANS[number];

export interface CheckoutSessionOptions {
  userId: string;
  planId: string;
  originUrl: string;
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

  constructor() {
    this.reconfigure();
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
   * Canonical application URL helper
   */
  public getCanonicalAppUrl(): string {
    const url = process.env.APP_URL || process.env.PUBLIC_APP_URL || 'https://videorisk.com';
    return url.replace(/\/+$/, '');
  }

  /**
   * Resolves list of trusted application origins
   */
  public getTrustedOrigins(): string[] {
    const origins = new Set<string>();
    origins.add('https://videorisk.com');
    origins.add('https://www.videorisk.com');

    const canonical = this.getCanonicalAppUrl();
    try {
      origins.add(new URL(canonical).origin);
    } catch {
      // ignore
    }

    if (process.env.ALLOWED_ORIGINS) {
      process.env.ALLOWED_ORIGINS.split(',').forEach(o => {
        const trimmed = o.trim();
        if (trimmed) {
          try {
            origins.add(new URL(trimmed).origin);
          } catch {
            // ignore malformed entry
          }
        }
      });
    }

    // In development or test environments, permit localhost / 127.0.0.1
    if (!this.isProduction || process.env.VIDEORISK_TEST_RUN === 'true') {
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
   * Validates Customer Portal return URL strictly against trusted application origins.
   * Rejects external origins, protocol-relative URLs, malformed URLs, and dangerous schemes.
   */
  public validatePortalReturnUrl(inputUrl?: string | null): string {
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

    // Reject malformed URLs
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      const err: any = new Error('Malformed return URL format.');
      err.statusCode = 400;
      throw err;
    }

    // Reject unexpected schemes (javascript:, data:, file:, etc.)
    if (parsed.protocol === 'javascript:' || parsed.protocol === 'data:' || parsed.protocol === 'file:') {
      const err: any = new Error(`Dangerous return URL scheme: ${parsed.protocol}`);
      err.statusCode = 400;
      throw err;
    }

    const isDevOrTest = !this.isProduction || process.env.VIDEORISK_TEST_RUN === 'true';

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
    if (priceId === process.env.STRIPE_PRICE_CREATOR) return 'creator';
    if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
    if (priceId === process.env.STRIPE_PRICE_AGENCY) return 'agency';
    if (priceId === process.env.STRIPE_PRICE_AUDIT_ONCE) return 'audit_once';
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
    const { userId, planId, originUrl } = options;

    if (!ALLOWED_PAID_PLANS.includes(planId as any)) {
      throw new Error(`Invalid plan ID: ${planId}. Allowed paid plans are: ${ALLOWED_PAID_PLANS.join(', ')}`);
    }

    const user = await storage.users.getUser(userId);
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
        customer_email: user.email,
        client_reference_id: user.id,
        metadata: {
          userId: user.id,
          planId: planId,
        },
        success_url: `${originUrl}/?checkout_status=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${originUrl}/?checkout_status=canceled`,
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
      url: `${originUrl}/?checkout_status=success&session_id=${simulatedSessionId}&plan=${planId}&mode=simulation`,
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
   * Executes transactional state updates for verified webhook events
   */
  private async processVerifiedEvent(event: Stripe.Event): Promise<{ alreadyProcessed: boolean }> {
    return await storage.runTransaction(async (state) => {
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

          const creditAllocation = this.getPlanCreditAllocation(planId);
          if (planId === 'audit_once') {
            user.creditsRemaining += creditAllocation;
          } else {
            user.plan = planId as any;
            user.creditsRemaining = Math.max(0, user.creditsRemaining) + creditAllocation;
          }

          if (session.customer) {
            user.stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer.id;
          }
          if (session.subscription) {
            const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
            user.subscriptionId = subId;
            user.subscriptionStatus = 'active';

            state.subscriptions[subId] = {
              id: subId,
              userId: user.id,
              planId,
              status: 'active',
              createdAt: new Date().toISOString(),
              updatedAt: new Date(Math.max(Date.now(), eventCreatedMs)).toISOString(),
            };
          }

          state.webhookEvents[event.id] = {
            eventId: event.id,
            provider: 'stripe',
            eventType: event.type,
            processedAt: new Date().toISOString(),
            userId: user.id,
            creditsGranted: creditAllocation,
            planGranted: planId,
          };

          recordCreditTx(state, {
            userId: user.id,
            delta: creditAllocation,
            balanceAfter: user.creditsRemaining,
            type: 'PLAN_PURCHASE',
            referenceId: event.id,
            metadataJson: JSON.stringify({ planId, sessionId: session.id })
          });

          console.log(`[BillingService] checkout.session.completed: Allocated ${creditAllocation} credits to ${userId} for plan ${planId}`);
          break;
        }

        case 'invoice.paid': {
          const invoice = event.data.object as any;
          const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
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
                user.subscriptionStatus = 'active';
                user.plan = sub.planId as any;

                if (invoice.billing_reason === 'subscription_cycle') {
                  const creditAllocation = this.getPlanCreditAllocation(sub.planId);
                  user.creditsRemaining += creditAllocation;
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
                    metadataJson: JSON.stringify({ planId: sub.planId, invoiceId: invoice.id })
                  });
                  return { alreadyProcessed: false };
                }
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
            console.log(`[BillingService] Out-of-order customer.subscription.updated event ${event.id} ignored.`);
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
              let mappedPlanId = sub?.planId || user.plan;
              if (priceId) {
                const detectedPlan = this.getPlanFromPriceId(priceId);
                if (detectedPlan) mappedPlanId = detectedPlan;
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

    const updatedUser = await storage.runTransaction(async (state) => {
      const user = state.users[targetUserId];
      if (!user) {
        throw new Error(`User not found: ${targetUserId}`);
      }

      // Check if already processed (either via webhook or prior sync call)
      const alreadyCredited = !!state.webhookEvents[syncEventId] || 
        !!state.webhookEvents[session.id] ||
        (Array.isArray((state as any).creditTransactions) && (state as any).creditTransactions.some((tx: any) => tx.referenceId === session.id));

      if (alreadyCredited) {
        return user;
      }

      if (planId) {
        const creditAllocation = this.getPlanCreditAllocation(planId);
        if (planId === 'audit_once') {
          user.creditsRemaining += creditAllocation;
        } else {
          user.plan = planId as any;
          user.creditsRemaining = Math.max(0, user.creditsRemaining) + creditAllocation;
        }

        if (session.customer) {
          user.stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer.id;
        }

        if (session.subscription) {
          const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
          user.subscriptionId = subId;
          user.subscriptionStatus = 'active';

          state.subscriptions[subId] = {
            id: subId,
            userId: user.id,
            planId,
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        }

        state.webhookEvents[syncEventId] = {
          eventId: syncEventId,
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
          type: 'PLAN_PURCHASE',
          referenceId: session.id,
          metadataJson: JSON.stringify({ planId, sessionId: session.id, source: 'session_sync' })
        });
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
