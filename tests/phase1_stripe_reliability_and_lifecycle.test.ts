import assert from 'assert';
import express from 'express';
import { storage } from '../src/server/storage';
import { billingService, ALLOWED_PAID_PLANS } from '../src/server/services/billingService';
import { creditService } from '../src/server/services/creditService';
import { apiRouter } from '../src/server/routes/api';

export async function runPhase1StripeReliabilityAndLifecycleTests() {
  console.log('\n======================================================');
  console.log('--- SUITE 16: PHASE 1 STRIPE RELIABILITY & LIFECYCLE ---');
  console.log('Checkout, Lifecycle Sync, Entitlements & Queue Invariants');
  console.log('======================================================\n');

  // Set up Express test app for HTTP route tests
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // --------------------------------------------------------------------------
    // 1. UNIT TESTS: Plan Mapping, Entitlement Rules & Grace Period
    // --------------------------------------------------------------------------
    console.log('[1. Unit Tests — Plan Mapping, Entitlements & Grace Period]');

    // 1.1 Price ID mapping
    assert.strictEqual(billingService.getPlanFromPriceId('price_creator'), 'creator');
    assert.strictEqual(billingService.getPlanFromPriceId('price_pro'), 'pro');
    assert.strictEqual(billingService.getPlanFromPriceId('price_agency'), 'agency');
    assert.strictEqual(billingService.getPlanFromPriceId('price_audit_once'), 'audit_once');
    assert.strictEqual(billingService.getPlanFromPriceId('  price_pro  '), 'pro', 'Trimmed price ID');
    assert.strictEqual(billingService.getPlanFromPriceId('unknown_price_xyz'), null, 'Unknown price returns null');
    assert.strictEqual(billingService.getPlanFromPriceId(''), null, 'Empty string returns null');
    console.log('  ✅ PASS: 1.1 Price ID reverse-mapping resolves valid plans and safely rejects unknown');

    // 1.2 Entitlement status matrix
    const nowMs = Date.now();
    assert.strictEqual(billingService.isSubscriptionEntitled('active'), true, 'active is entitled');
    assert.strictEqual(billingService.isSubscriptionEntitled('trialing'), true, 'trialing is entitled');
    assert.strictEqual(billingService.isSubscriptionEntitled('unpaid'), false, 'unpaid is unentitled');
    assert.strictEqual(billingService.isSubscriptionEntitled('incomplete'), false, 'incomplete is unentitled');
    assert.strictEqual(billingService.isSubscriptionEntitled('incomplete_expired'), false, 'incomplete_expired is unentitled');

    // Canceled subscription: entitled during prepaid duration, unentitled once passed
    const futurePeriodEnd = new Date(nowMs + 7 * 86400 * 1000).toISOString();
    const pastPeriodEnd = new Date(nowMs - 1 * 86400 * 1000).toISOString();
    assert.strictEqual(billingService.isSubscriptionEntitled('canceled', futurePeriodEnd), true, 'canceled with future period end is entitled');
    assert.strictEqual(billingService.isSubscriptionEntitled('canceled', pastPeriodEnd), false, 'canceled with past period end is unentitled');

    // Past due subscription: 7-day grace period
    const pastDueWithinGrace = new Date(nowMs - 3 * 86400 * 1000).toISOString();
    const pastDueExpiredGrace = new Date(nowMs - 8 * 86400 * 1000).toISOString();
    assert.strictEqual(billingService.isSubscriptionEntitled('past_due', pastDueWithinGrace), true, 'past_due within 7-day grace is entitled');
    assert.strictEqual(billingService.isSubscriptionEntitled('past_due', pastDueExpiredGrace), false, 'past_due beyond 7-day grace is unentitled');
    assert.strictEqual(billingService.isSubscriptionEntitled('past_due', 0), false, 'past_due with unknown period end is unentitled');
    console.log('  ✅ PASS: 1.2 Subscription entitlement matrix and 7-day grace period verified');

    // 1.3 Credit Calculation Unit Tests
    assert.strictEqual(creditService.calculateRequiredCredits(30, 'standard'), 1, '30s standard = 1 credit');
    assert.strictEqual(creditService.calculateRequiredCredits(60, 'standard'), 1, '60s standard = 1 credit');
    assert.strictEqual(creditService.calculateRequiredCredits(61, 'standard'), 2, '61s standard = 2 credits');
    assert.strictEqual(creditService.calculateRequiredCredits(60, 'deep'), 2, '60s deep = 2 credits');
    assert.strictEqual(creditService.calculateRequiredCredits(120, 'deep'), 4, '120s deep = 4 credits');
    console.log('  ✅ PASS: 1.3 Credit calculation rates per minute verified');

    // --------------------------------------------------------------------------
    // 2. INTEGRATION TESTS: Race Conditions & Checkout Synchronization
    // --------------------------------------------------------------------------
    console.log('\n[2. Integration Tests — Checkout Sync & Webhook Arrival Sequences]');
    process.env.ALLOW_SIMULATION_WEBHOOK = 'true';

    // 2.1 Webhook arrives BEFORE user returns to site
    const userEmail1 = `race_webhook_first_${Date.now()}@videorisk.test`;
    const user1 = await storage.users.createUser(userEmail1, 'hash_1', 'salt_1', 10, 'free');
    const user1Token = await storage.users.createSession(user1.id);
    const customerId1 = `cus_race1_${Date.now()}`;
    const sessionId1 = `cs_race1_${Date.now()}`;

    // Mock Stripe checkout session
    const mockStripe: any = {
      checkout: {
        sessions: {
          retrieve: async (sId: string) => {
            if (sId === sessionId1) {
              return {
                id: sessionId1,
                client_reference_id: user1.id,
                customer: customerId1,
                subscription: `sub_race1_${Date.now()}`,
                metadata: { userId: user1.id, planId: 'pro' },
                payment_status: 'paid',
                status: 'complete',
                livemode: false,
              };
            }
            if (sId.startsWith('cs_race2_')) {
              const uId = sId.replace('cs_race2_', '');
              return {
                id: sId,
                client_reference_id: uId,
                customer: `cus_race2_${Date.now()}`,
                subscription: `sub_race2_${Date.now()}`,
                metadata: { userId: uId, planId: 'pro' },
                payment_status: 'paid',
                status: 'complete',
                livemode: false,
              };
            }
            return null;
          }
        }
      }
    };
    billingService.setStripeClientForTest(mockStripe);

    // Step A: Webhook delivers checkout.session.completed first
    const evtWebhookFirst = {
      id: `evt_cs_comp_first_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId1,
          client_reference_id: user1.id,
          customer: customerId1,
          subscription: `sub_race1_${Date.now()}`,
          payment_status: 'paid',
          metadata: { userId: user1.id, planId: 'pro' }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(evtWebhookFirst)), '');
    const user1AfterWebhook = await storage.users.getUser(user1.id);
    assert.strictEqual(user1AfterWebhook?.plan, 'pro');
    assert.strictEqual(user1AfterWebhook?.creditsRemaining, 85, 'Initial 10 + 75 Pro = 85');

    // Step B: User returns to site and invokes /api/billing/session-status
    const syncRes1 = await fetch(`${baseUrl}/billing/session-status?sessionId=${sessionId1}`, {
      headers: { Authorization: `Bearer ${user1Token}` }
    });
    const syncData1 = await syncRes1.json();
    assert.strictEqual(syncRes1.status, 200);
    assert.strictEqual(syncData1.status, 'complete');
    assert.strictEqual(syncData1.user.plan, 'pro');
    assert.strictEqual(syncData1.user.creditsRemaining, 85, 'No duplicate credits when user returns after webhook');
    console.log('  ✅ PASS: 2.1 Webhook arriving before user return prevents duplicate credit');

    // 2.2 User returns BEFORE webhook arrives
    const userEmail2 = `race_user_first_${Date.now()}@videorisk.test`;
    const user2 = await storage.users.createUser(userEmail2, 'hash_2', 'salt_2', 10, 'free');
    const user2Token = await storage.users.createSession(user2.id);
    const sessionId2 = `cs_race2_${user2.id}`;

    // Step A: User returns and invokes /api/billing/session-status first
    const syncRes2 = await fetch(`${baseUrl}/billing/session-status?sessionId=${sessionId2}`, {
      headers: { Authorization: `Bearer ${user2Token}` }
    });
    const syncData2 = await syncRes2.json();
    assert.strictEqual(syncRes2.status, 200);
    assert.strictEqual(syncData2.status, 'complete');
    assert.strictEqual(syncData2.user.plan, 'pro');
    assert.strictEqual(syncData2.user.creditsRemaining, 85, 'Initial 10 + 75 Pro = 85');

    // Step B: Webhook arrives subsequently
    const evtWebhookSecond = {
      id: `evt_cs_comp_second_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId2,
          client_reference_id: user2.id,
          customer: `cus_race2_${Date.now()}`,
          subscription: `sub_race2_${Date.now()}`,
          payment_status: 'paid',
          metadata: { userId: user2.id, planId: 'pro' }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(evtWebhookSecond)), '');
    const user2AfterSubsequentWebhook = await storage.users.getUser(user2.id);
    assert.strictEqual(user2AfterSubsequentWebhook?.plan, 'pro');
    assert.strictEqual(user2AfterSubsequentWebhook?.creditsRemaining, 85, 'No duplicate credits when webhook arrives after sync');
    console.log('  ✅ PASS: 2.2 User return before webhook delivery prevents duplicate credit');

    // 2.3 customer.subscription.created event handling
    const userEmail3 = `sub_created_${Date.now()}@videorisk.test`;
    const user3 = await storage.users.createUser(userEmail3, 'hash_3', 'salt_3', 10, 'free');
    const customerId3 = `cus_sub_create_${Date.now()}`;
    await storage.users.updateUser(user3.id, { stripeCustomerId: customerId3 });
    const subId3 = `sub_create_${Date.now()}`;

    const subCreatedEvt = {
      id: `evt_sub_created_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      type: 'customer.subscription.created',
      data: {
        object: {
          id: subId3,
          customer: customerId3,
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          items: { data: [{ price: { id: 'price_pro' } }] }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(subCreatedEvt)), '');
    const user3AfterCreated = await storage.users.getUser(user3.id);
    assert.strictEqual(user3AfterCreated?.subscriptionStatus, 'active');
    assert.strictEqual(user3AfterCreated?.plan, 'pro');
    console.log('  ✅ PASS: 2.3 customer.subscription.created synchronizes status and activates entitlement');

    // --------------------------------------------------------------------------
    // 3. SECURITY & ACCOUNT ISOLATION TESTS
    // --------------------------------------------------------------------------
    console.log('\n[3. Security & Account Isolation Tests]');

    // 3.1 Cross-user checkout session access rejected with 403
    const crossAccessRes = await fetch(`${baseUrl}/billing/session-status?sessionId=${sessionId1}`, {
      headers: { Authorization: `Bearer ${user2Token}` } // User 2 trying to access User 1's session
    });
    assert.strictEqual(crossAccessRes.status, 403, 'Cross-user session check must return 403 Forbidden');
    const crossAccessData = await crossAccessRes.json();
    assert.strictEqual(crossAccessData.error, 'Checkout session does not belong to the authenticated user.');
    console.log('  ✅ PASS: 3.1 Cross-user checkout session inspection rejected with 403');

    // 3.2 Unauthorized direct plan elevation via /api/user/plan rejected with 400
    const unauthorizedPlanRes = await fetch(`${baseUrl}/user/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user1Token}`
      },
      body: JSON.stringify({ plan: 'pro' })
    });
    assert.strictEqual(unauthorizedPlanRes.status, 400, 'Direct paid plan modification rejected');
    console.log('  ✅ PASS: 3.2 Direct client plan upgrade without checkout rejected with 400');

    // 3.3 Customer portal session rejects user without active customer mapping
    const userEmailNoCus = `no_cus_${Date.now()}@videorisk.test`;
    const userNoCus = await storage.users.createUser(userEmailNoCus, 'hash_nc', 'salt_nc', 10, 'free');
    const userNoCusToken = await storage.users.createSession(userNoCus.id);

    const portalFailRes = await fetch(`${baseUrl}/billing/create-portal-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userNoCusToken}`
      },
      body: JSON.stringify({ returnUrl: 'https://videorisk.com/pricing' })
    });
    assert.strictEqual(portalFailRes.status, 400, 'Portal session without customer mapping rejected with 400');
    console.log('  ✅ PASS: 3.3 User without Stripe customer rejected from Customer Portal');

    // --------------------------------------------------------------------------
    // 4. REGRESSION: STRIPE UNKNOWN / MISSING PRICE ID ENTITLEMENT ESCALATION
    // --------------------------------------------------------------------------
    console.log('\n[4. Regression — Unknown & Missing Price ID Entitlement Hardening]');

    // 4.1 Unknown Price ID does not grant Pro, does not grant credits, ignores invalid metadata
    const escEmail1 = `esc_unknown_${Date.now()}@videorisk.test`;
    const escUser1 = await storage.users.createUser(escEmail1, 'hash_e1', 'salt_e1', 10, 'free');
    const escCus1 = `cus_esc1_${Date.now()}`;
    await storage.users.updateUser(escUser1.id, { stripeCustomerId: escCus1 });
    const escSub1 = `sub_esc1_${Date.now()}`;
    const escBaseSec = Math.floor(Date.now() / 1000);

    const unknownPriceEvt = {
      id: `evt_unknown_price_${Date.now()}`,
      created: escBaseSec,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: escSub1,
          customer: escCus1,
          status: 'active',
          current_period_end: escBaseSec + 30 * 86400,
          metadata: { userId: escUser1.id, planId: 'pro' },
          items: { data: [{ price: { id: 'price_totally_unknown_999' } }] }
        }
      }
    };
    const unknownRes1 = await billingService.handleWebhook(Buffer.from(JSON.stringify(unknownPriceEvt)), '');
    assert.strictEqual(unknownRes1.alreadyProcessed, false, '4.1a Unknown Price ID event handled cleanly');
    const escUser1AfterUnknown = await storage.users.getUser(escUser1.id);
    assert.strictEqual(escUser1AfterUnknown?.plan, 'free', '4.1b Unknown Price ID does NOT grant pro or any paid plan');
    assert.strictEqual(escUser1AfterUnknown?.creditsRemaining, 10, '4.1c Unknown Price ID grants zero additional credits');
    assert.strictEqual(await storage.billing.getSubscription(escSub1), null, '4.1d Unknown Price ID creates no subscription record');

    // 4.2 Repeated delivery of same invalid event is idempotent and leaves state unchanged
    const unknownResReplay = await billingService.handleWebhook(Buffer.from(JSON.stringify(unknownPriceEvt)), '');
    assert.strictEqual(unknownResReplay.alreadyProcessed, true, '4.2a Repeated invalid event is idempotent');
    const escUser1AfterReplay = await storage.users.getUser(escUser1.id);
    assert.strictEqual(escUser1AfterReplay?.plan, 'free', '4.2b Replay leaves plan unchanged');
    assert.strictEqual(escUser1AfterReplay?.creditsRemaining, 10, '4.2c Replay leaves credits unchanged');

    // 4.3 Subsequent valid subscription event still works cleanly for the same user/sub
    const subsequentValidEvt = {
      id: `evt_valid_after_unknown_${Date.now()}`,
      created: escBaseSec + 5,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: escSub1,
          customer: escCus1,
          status: 'active',
          current_period_end: escBaseSec + 30 * 86400,
          items: { data: [{ price: { id: 'price_creator' } }] }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(subsequentValidEvt)), '');
    const escUser1AfterValid = await storage.users.getUser(escUser1.id);
    assert.strictEqual(escUser1AfterValid?.plan, 'creator', '4.3a Subsequent valid Price ID maps to exact plan (creator)');
    assert.strictEqual(escUser1AfterValid?.subscriptionStatus, 'active', '4.3b Subsequent valid subscription becomes active');

    // 4.4 Invalid subscription event does NOT overwrite an existing valid subscription entitlement
    const overwriteAttemptEvt = {
      id: `evt_overwrite_valid_${Date.now()}`,
      created: escBaseSec + 10,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: escSub1,
          customer: escCus1,
          status: 'canceled',
          metadata: { userId: escUser1.id, planId: 'agency' },
          items: { data: [{ price: { id: 'price_evil_unmapped' } }] }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(overwriteAttemptEvt)), '');
    const escUser1AfterOverwriteAttempt = await storage.users.getUser(escUser1.id);
    const escSub1AfterOverwriteAttempt = await storage.billing.getSubscription(escSub1);
    assert.strictEqual(escUser1AfterOverwriteAttempt?.plan, 'creator', '4.4a Invalid Price ID event does not overwrite valid user plan');
    assert.strictEqual(escSub1AfterOverwriteAttempt?.planId, 'creator', '4.4b Invalid Price ID event does not overwrite subscription plan');
    assert.strictEqual(escSub1AfterOverwriteAttempt?.status, 'active', '4.4c Invalid Price ID event does not overwrite active status');

    // 4.5 Missing Price ID & existing user.plan cannot manufacture a new subscription entitlement
    const escEmail2 = `esc_missing_${Date.now()}@videorisk.test`;
    const escUser2 = await storage.users.createUser(escEmail2, 'hash_e2', 'salt_e2', 25, 'pro');
    const escCus2 = `cus_esc2_${Date.now()}`;
    await storage.users.updateUser(escUser2.id, { stripeCustomerId: escCus2 });
    const escSub2 = `sub_manufactured_${Date.now()}`;

    const missingPriceCreatedEvt = {
      id: `evt_missing_price_created_${Date.now()}`,
      created: escBaseSec,
      type: 'customer.subscription.created',
      data: {
        object: {
          id: escSub2,
          customer: escCus2,
          status: 'active',
          current_period_end: escBaseSec + 30 * 86400,
          metadata: { userId: escUser2.id, planId: 'agency' }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(missingPriceCreatedEvt)), '');
    assert.strictEqual(await storage.billing.getSubscription(escSub2), null, '4.5a Missing Price ID + existing user.plan + metadata cannot manufacture new subscription');
    assert.strictEqual((await storage.users.getUser(escUser2.id))?.creditsRemaining, 25, '4.5b Missing Price ID grants zero additional credits');

    const escUser3 = await storage.users.createUser(`esc_free_missing_${Date.now()}@videorisk.test`, 'hash_e3', 'salt_e3', 10, 'free');
    const escSub3 = `sub_free_missing_${Date.now()}`;
    const missingPriceFreeEvt = {
      id: `evt_missing_price_free_${Date.now()}`,
      created: escBaseSec,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: escSub3,
          customer: `cus_esc3_${Date.now()}`,
          status: 'active',
          metadata: { userId: escUser3.id, planId: 'pro' }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(missingPriceFreeEvt)), '');
    const escUser3After = await storage.users.getUser(escUser3.id);
    assert.strictEqual(escUser3After?.plan, 'free', '4.5c Missing Price ID on free user does NOT grant paid plan');
    assert.strictEqual(escUser3After?.creditsRemaining, 10, '4.5d Missing Price ID on free user grants zero credits');
    console.log('  ✅ PASS: All Stripe unknown/missing Price ID escalation & idempotency regression assertions passed');

    console.log('\n======================================================');
    console.log('✅ ALL PHASE 1 STRIPE RELIABILITY & LIFECYCLE TESTS PASSED');
    console.log('======================================================\n');
  } finally {
    server.close();
  }
}
