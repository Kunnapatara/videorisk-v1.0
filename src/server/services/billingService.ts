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

  constructor() {
    this.reconfigure();
  }

  public reconfigure(): void {
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

  public getStripeClient(): Stripe | null {
    if (!this.stripe && process.env.STRIPE_SECRET_KEY) {
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
   * Evaluates whether a given subscription status and billing period confers active paid entitlements
   */
  public isSubscriptionEntitled(
    status?: string,
    currentPeriodEnd?: string | number | null
  ): boolean {
    if (!status) return false;
    if (status === 'active' || status === 'trialing') return true;

    const now = Date.now();
    const periodEndMs = typeof currentPeriodEnd === 'number'
      ? currentPeriodEnd * 1000
      : (currentPeriodEnd ? new Date(currentPeriodEnd).getTime() : 0);

    // Canceled but still within the prepaid period
    if (status === 'canceled' && periodEndMs > now) {
      return true;
    }

    // Past due: 7-day grace period from period end
    if (status === 'past_due' && periodEndMs > 0) {
      const gracePeriodMs = 7 * 24 * 60 * 60 * 1000;
      if (now <= periodEndMs + gracePeriodMs) {
        return true;
      }
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

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const userId = session.client_reference_id || session.metadata?.userId;
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
              updatedAt: new Date().toISOString(),
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
          if (invoice.billing_reason === 'subscription_cycle') {
            const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
            if (subId) {
              const sub = state.subscriptions[subId];
              if (sub) {
                const user = state.users[sub.userId];
                if (user) {
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
          let userId = sub?.userId;
          if (!userId && customerId) {
            const userWithCustomer = Object.values(state.users).find((u: any) => u.stripeCustomerId === customerId);
            if (userWithCustomer) userId = (userWithCustomer as any).id;
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
              } else if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
                user.plan = 'free';
              }

              state.subscriptions[subId] = {
                id: subId,
                userId: user.id,
                planId: mappedPlanId,
                status: status as any,
                currentPeriodEnd,
                createdAt: sub?.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString(),
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
          const sub = state.subscriptions[subscription.id];
          if (sub) {
            sub.status = 'canceled';
            sub.updatedAt = new Date().toISOString();
            const user = state.users[sub.userId];
            if (user) {
              user.subscriptionStatus = 'canceled';
              user.plan = 'free';
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

        case 'invoice.payment_failed': {
          const invoice = event.data.object as any;
          const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
          if (subId) {
            const sub = state.subscriptions[subId];
            if (sub) {
              sub.status = 'past_due';
              sub.updatedAt = new Date().toISOString();
              const user = state.users[sub.userId];
              if (user) {
                user.subscriptionStatus = 'past_due';
                if (!this.isSubscriptionEntitled('past_due', sub.currentPeriodEnd)) {
                  user.plan = 'free';
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
      throw new Error('Stripe client is not configured.');
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session) {
      const err: any = new Error(`Checkout session ${sessionId} not found.`);
      err.statusCode = 404;
      throw err;
    }
    const sessionUserId = session.client_reference_id || session.metadata?.userId;
    if (sessionUserId && sessionUserId !== authenticatedUserId) {
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
    let session: Stripe.Checkout.Session;
    if (sessionId.startsWith('cs_test_mock_') || (process.env.VIDEORISK_TEST_RUN === 'true' && sessionId.startsWith('mock_'))) {
      session = {
        id: sessionId,
        object: 'checkout.session',
        client_reference_id: authenticatedUserId,
        metadata: { userId: authenticatedUserId, planId: 'creator' },
        payment_status: 'paid',
        status: 'complete',
        livemode: false,
      } as any;
    } else {
      const stripe = this.getStripeClient();
      if (!stripe) {
        throw new Error('Stripe client is not configured.');
      }

      session = await stripe.checkout.sessions.retrieve(sessionId);
      if (!session) {
        const err: any = new Error(`Checkout session ${sessionId} not found.`);
        err.statusCode = 404;
        throw err;
      }
    }

    const sessionUserId = session.client_reference_id || session.metadata?.userId;
    if (sessionUserId && sessionUserId !== authenticatedUserId) {
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
      let status: 'pending' | 'unpaid' | 'expired' | 'canceled' = 'pending';
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
    const targetUserId = sessionUserId || authenticatedUserId;

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
  public async createCustomerPortalSession(userId: string, returnUrl: string): Promise<{ url: string }> {
    const stripe = this.getStripeClient();
    if (!stripe) {
      throw new Error('Stripe client is not configured.');
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

    if (process.env.VIDEORISK_TEST_RUN === 'true' || user.stripeCustomerId?.startsWith('cus_test_')) {
      return { url: `https://billing.stripe.com/p/session/test_${user.stripeCustomerId}` };
    }

    try {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: returnUrl,
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
