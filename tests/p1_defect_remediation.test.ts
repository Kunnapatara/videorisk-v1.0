import assert from 'assert';
import path from 'path';
import fs from 'fs';
import express from 'express';
import http from 'http';
import { storage } from '../src/server/storage';
import { billingService } from '../src/server/services/billingService';
import { creditService } from '../src/server/services/creditService';
import { mediaInspector } from '../src/server/pipeline/mediaInspector';
import { ensureDemoFixtures, getDemoFixture } from '../src/server/fixtures/demoMedia';
import { apiRouter } from '../src/server/routes/api';

export async function runP1DefectRemediationTests() {
  console.log('\n======================================================');
  console.log('SUITE 15: PRIORITY 1 DEFECT REMEDIATION VERIFICATION');
  console.log('Authoritative Demo Media, Preflight, Billing, & Lifecycle');
  console.log('======================================================\n');

  // Set up Express test app for HTTP route tests
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    const testEmailA = `p1_user_a_${Date.now()}@videorisk.test`;
    const userA = await storage.users.createUser(testEmailA, 'hash_a', 'salt_a', 10, 'free');
    const tokenA = await storage.users.createSession(userA.id);

    const testEmailB = `p1_user_b_${Date.now()}@videorisk.test`;
    const userB = await storage.users.createUser(testEmailB, 'hash_b', 'salt_b', 10, 'free');
    const tokenB = await storage.users.createSession(userB.id);

    // --------------------------------------------------------------------------
    // TASK 1: Customer Portal CI Test Failure & Test Harness
    // --------------------------------------------------------------------------
    console.log('[Task 1 — Customer Portal CI Test Failure & Test Harness]');

    // Test 1.1: Missing Stripe client configuration returns controlled error
    billingService.setStripeClientForTest(null);
    let missingConfigThrew = false;
    try {
      await billingService.createCustomerPortalSession(userA.id, 'https://videorisk.com/pricing');
    } catch (err: any) {
      missingConfigThrew = true;
      assert.strictEqual(err.message, 'Stripe client is not configured.');
    }
    assert.strictEqual(missingConfigThrew, true, 'createCustomerPortalSession must fail when Stripe is unconfigured');
    console.log('  ✅ PASS: 1.1 Missing Stripe configuration returns controlled error');

    // Test 1.2: Missing Stripe customer mapping returns controlled error
    const csValidOwnerA = `cs_valid_owner_a_${Date.now()}`;
    const csOtherOwnerB = `cs_other_owner_b_${Date.now()}`;
    const csNoOwner = `cs_no_owner_${Date.now()}`;
    const csEmptyOwner = `cs_empty_owner_${Date.now()}`;
    const csConflictingOwner = `cs_conflicting_owner_${Date.now()}`;

    let mockPortalCalls: any[] = [];
    const mockStripe: any = {
      billingPortal: {
        sessions: {
          create: async (params: any) => {
            mockPortalCalls.push(params);
            return { url: `https://billing.stripe.com/session/${params.customer}` };
          }
        }
      },
      checkout: {
        sessions: {
          retrieve: async (sessionId: string) => {
            if (sessionId === csValidOwnerA) {
              return {
                id: sessionId,
                client_reference_id: userA.id,
                metadata: { userId: userA.id, planId: 'creator' },
                payment_status: 'paid',
                status: 'complete',
                livemode: false
              };
            }
            if (sessionId === csOtherOwnerB) {
              return {
                id: sessionId,
                client_reference_id: userB.id,
                metadata: { userId: userB.id, planId: 'creator' },
                payment_status: 'paid',
                status: 'complete',
                livemode: false
              };
            }
            if (sessionId === csNoOwner) {
              return {
                id: sessionId,
                payment_status: 'paid',
                status: 'complete',
                livemode: false
              };
            }
            if (sessionId === csEmptyOwner) {
              return {
                id: sessionId,
                client_reference_id: '   ',
                metadata: { userId: ' ' },
                payment_status: 'paid',
                status: 'complete',
                livemode: false
              };
            }
            if (sessionId === csConflictingOwner) {
              return {
                id: sessionId,
                client_reference_id: userA.id,
                metadata: { userId: userB.id, planId: 'creator' },
                payment_status: 'paid',
                status: 'complete',
                livemode: false
              };
            }
            return null;
          }
        }
      }
    };
    billingService.setStripeClientForTest(mockStripe);

    let missingCustomerThrew = false;
    try {
      await billingService.createCustomerPortalSession(userA.id, 'https://videorisk.com/pricing');
    } catch (err: any) {
      missingCustomerThrew = true;
      assert.strictEqual(err.statusCode, 400);
      assert.strictEqual(err.message, 'No billing history or active Stripe customer found for this account.');
    }
    assert.strictEqual(missingCustomerThrew, true, 'User without stripeCustomerId must be rejected with 400');
    console.log('  ✅ PASS: 1.2 Missing Stripe customer mapping is handled safely with 400');

    // Test 1.3: Valid customer mapping creates portal session using correct customer & return URL
    const testCustomerId = `cus_test_${Date.now()}`;
    await storage.users.updateUser(userA.id, { stripeCustomerId: testCustomerId });

    const portalResult = await billingService.createCustomerPortalSession(userA.id, 'https://videorisk.com/pricing');
    assert.strictEqual(portalResult.url, `https://billing.stripe.com/session/${testCustomerId}`);
    assert.strictEqual(mockPortalCalls.length, 1);
    assert.strictEqual(mockPortalCalls[0].customer, testCustomerId);
    assert.strictEqual(mockPortalCalls[0].return_url, 'https://videorisk.com/pricing');
    console.log('  ✅ PASS: 1.3 Valid customer mapping creates portal session with expected customer and return URL');

    // --------------------------------------------------------------------------
    // TASK 2: Strict Stripe Checkout Session Ownership
    // --------------------------------------------------------------------------
    console.log('\n[Task 2 — Strict Stripe Checkout Session Ownership]');

    // Test 2.1: Correct owner -> allowed
    const syncResA = await billingService.verifyAndSynchronizeSession(csValidOwnerA, userA.id);
    assert.strictEqual(syncResA.status, 'complete');
    assert.ok(syncResA.user);
    assert.strictEqual(syncResA.user?.plan, 'creator');
    console.log('  ✅ PASS: 2.1 Correct owner is allowed and synchronized');

    // Test 2.2: Different owner -> rejected (403)
    let differentOwnerThrew = false;
    try {
      await billingService.verifyAndSynchronizeSession(csOtherOwnerB, userA.id);
    } catch (err: any) {
      differentOwnerThrew = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.message, 'Checkout session does not belong to the authenticated user.');
    }
    assert.strictEqual(differentOwnerThrew, true, 'Different owner session must be rejected with 403');
    console.log('  ✅ PASS: 2.2 Different owner session rejected with 403');

    // Test 2.3: Missing both client_reference_id and metadata.userId -> rejected (403)
    let noOwnerThrew = false;
    try {
      await billingService.verifyAndSynchronizeSession(csNoOwner, userA.id);
    } catch (err: any) {
      noOwnerThrew = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.message, 'Checkout session is missing authoritative user ownership metadata.');
    }
    assert.strictEqual(noOwnerThrew, true, 'Missing owner metadata must fail closed with 403');
    console.log('  ✅ PASS: 2.3 Missing ownership metadata fails closed with 403');

    // Test 2.4: Empty owner string -> rejected (403)
    let emptyOwnerThrew = false;
    try {
      await billingService.verifyAndSynchronizeSession(csEmptyOwner, userA.id);
    } catch (err: any) {
      emptyOwnerThrew = true;
      assert.strictEqual(err.statusCode, 403);
    }
    assert.strictEqual(emptyOwnerThrew, true, 'Whitespace/empty owner must fail closed with 403');
    console.log('  ✅ PASS: 2.4 Empty owner string fails closed with 403');

    // Test 2.5: Conflicting ownership fields -> rejected (403)
    let conflictingOwnerThrew = false;
    try {
      await billingService.verifyAndSynchronizeSession(csConflictingOwner, userA.id);
    } catch (err: any) {
      conflictingOwnerThrew = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.message, 'Checkout session contains conflicting user ownership identifiers.');
    }
    assert.strictEqual(conflictingOwnerThrew, true, 'Conflicting ownership fields must be rejected with 403');
    console.log('  ✅ PASS: 2.5 Conflicting ownership fields rejected with 403');

    // Test 2.6: Missing session -> rejected (404)
    let notFoundThrew = false;
    try {
      await billingService.verifyAndSynchronizeSession('cs_non_existent', userA.id);
    } catch (err: any) {
      notFoundThrew = true;
      assert.strictEqual(err.statusCode, 404);
    }
    assert.strictEqual(notFoundThrew, true, 'Non-existent session rejected with 404');
    console.log('  ✅ PASS: 2.6 Non-existent session rejected with 404');

    // --------------------------------------------------------------------------
    // TASK 3: Subscription Lifecycle Synchronization & Out-of-Order Webhooks
    // --------------------------------------------------------------------------
    console.log('\n[Task 3 — Subscription Lifecycle Synchronization]');
    process.env.ALLOW_SIMULATION_WEBHOOK = 'true';

    const subUserEmail = `sub_lifecycle_${Date.now()}@videorisk.test`;
    const subUser = await storage.users.createUser(subUserEmail, 'hash_sub', 'salt_sub', 10, 'free');
    const subCustomerId = `cus_sub_${Date.now()}`;
    await storage.users.updateUser(subUser.id, { stripeCustomerId: subCustomerId });
    const subId = `sub_${Date.now()}`;

    // 3.1: Active subscription event
    const nowSec = Math.floor(Date.now() / 1000);
    const activeEvt = {
      id: `evt_sub_active_${Date.now()}`,
      created: nowSec,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: subCustomerId,
          status: 'active',
          current_period_end: nowSec + 30 * 86400,
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_PRO || 'price_pro' } } ] }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(activeEvt)), '');
    const userAfterActive = await storage.users.getUser(subUser.id);
    assert.strictEqual(userAfterActive?.subscriptionStatus, 'active');
    assert.strictEqual(userAfterActive?.plan, 'pro');
    console.log('  ✅ PASS: 3.1 Active subscription event synchronizes status and plan');

    // 3.2: Payment failure inside grace period (period_end in future or within 7 days)
    const failInsideGraceEvt = {
      id: `evt_pay_fail_grace_${Date.now()}`,
      created: nowSec + 10,
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: `in_fail_${Date.now()}`,
          subscription: subId,
          customer: subCustomerId
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(failInsideGraceEvt)), '');
    const userAfterGraceFail = await storage.users.getUser(subUser.id);
    assert.strictEqual(userAfterGraceFail?.subscriptionStatus, 'past_due');
    assert.strictEqual(userAfterGraceFail?.plan, 'pro', 'Plan retained during grace period');
    console.log('  ✅ PASS: 3.2 Payment failure inside grace period retains plan');

    // 3.3: Payment failure after grace period (period_end 8 days ago)
    const failExpiredEvt = {
      id: `evt_sub_past_due_expired_${Date.now()}`,
      created: nowSec + 20,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: subCustomerId,
          status: 'past_due',
          current_period_end: nowSec - 8 * 86400,
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_PRO || 'price_pro' } } ] }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(failExpiredEvt)), '');
    const userAfterExpiredFail = await storage.users.getUser(subUser.id);
    assert.strictEqual(userAfterExpiredFail?.subscriptionStatus, 'past_due');
    assert.strictEqual(userAfterExpiredFail?.plan, 'free', 'Plan downgraded after grace period expired');
    console.log('  ✅ PASS: 3.3 Payment failure after grace period downgrades to free');

    // 3.4: Subscription canceled with future current_period_end
    const cancelPrepaidEvt = {
      id: `evt_sub_cancel_prepaid_${Date.now()}`,
      created: nowSec + 30,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: subCustomerId,
          status: 'canceled',
          current_period_end: nowSec + 14 * 86400,
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_PRO || 'price_pro' } } ] }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(cancelPrepaidEvt)), '');
    const userAfterPrepaidCancel = await storage.users.getUser(subUser.id);
    assert.strictEqual(userAfterPrepaidCancel?.subscriptionStatus, 'canceled');
    assert.strictEqual(userAfterPrepaidCancel?.plan, 'pro', 'Plan retained until prepaid period end');
    console.log('  ✅ PASS: 3.4 Canceled subscription retains plan until prepaid period end');

    // 3.5: Subscription canceled after current_period_end
    const cancelExpiredEvt = {
      id: `evt_sub_cancel_expired_${Date.now()}`,
      created: nowSec + 40,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: subCustomerId,
          status: 'canceled',
          current_period_end: nowSec - 1 * 86400,
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_PRO || 'price_pro' } } ] }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(cancelExpiredEvt)), '');
    const userAfterExpiredCancel = await storage.users.getUser(subUser.id);
    assert.strictEqual(userAfterExpiredCancel?.subscriptionStatus, 'canceled');
    assert.strictEqual(userAfterExpiredCancel?.plan, 'free', 'Plan downgraded after prepaid period expired');
    console.log('  ✅ PASS: 3.5 Canceled subscription with expired period downgrades to free');

    // 3.6: Subscription updated to unpaid or incomplete
    const unpaidEvt = {
      id: `evt_sub_unpaid_${Date.now()}`,
      created: nowSec + 50,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: subCustomerId,
          status: 'unpaid',
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_PRO || 'price_pro' } } ] }
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(unpaidEvt)), '');
    const userAfterUnpaid = await storage.users.getUser(subUser.id);
    assert.strictEqual(userAfterUnpaid?.subscriptionStatus, 'unpaid');
    assert.strictEqual(userAfterUnpaid?.plan, 'free');
    console.log('  ✅ PASS: 3.6 Subscription status unpaid downgrades to free');

    // 3.7: Renewal after payment (invoice.paid restores plan and allocates renewal credits)
    const creditsBeforeRenewal = userAfterUnpaid!.creditsRemaining;
    const renewalInvoiceEvt = {
      id: `evt_invoice_renewal_${Date.now()}`,
      created: nowSec + 60,
      type: 'invoice.paid',
      data: {
        object: {
          id: `in_renew_${Date.now()}`,
          subscription: subId,
          customer: subCustomerId,
          billing_reason: 'subscription_cycle'
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(renewalInvoiceEvt)), '');
    const userAfterRenewal = await storage.users.getUser(subUser.id);
    assert.strictEqual(userAfterRenewal?.subscriptionStatus, 'active');
    assert.strictEqual(userAfterRenewal?.plan, 'pro');
    assert.strictEqual(userAfterRenewal?.creditsRemaining, creditsBeforeRenewal + 75, 'Pro plan renews with 75 credits');
    console.log('  ✅ PASS: 3.7 Subscription renewal after payment restores plan and allocates credits');

    // 3.8: Duplicate webhook event (Idempotency)
    const dupRes = await billingService.handleWebhook(Buffer.from(JSON.stringify(renewalInvoiceEvt)), '');
    assert.strictEqual(dupRes.alreadyProcessed, true);
    const userAfterDup = await storage.users.getUser(subUser.id);
    assert.strictEqual(userAfterDup?.creditsRemaining, userAfterRenewal?.creditsRemaining, 'Duplicate event must not add credits');
    console.log('  ✅ PASS: 3.8 Duplicate webhook event is idempotent and adds no duplicate credits');

    // 3.9: Out-of-order webhook event (older event arrives after newer event)
    const olderEvent = {
      id: `evt_older_past_due_${Date.now()}`,
      created: nowSec - 500, // Created 500 seconds ago, before active renewal
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: subCustomerId,
          status: 'past_due',
          current_period_end: nowSec - 500
        }
      }
    };
    await billingService.handleWebhook(Buffer.from(JSON.stringify(olderEvent)), '');
    const userAfterOlder = await storage.users.getUser(subUser.id);
    assert.strictEqual(userAfterOlder?.subscriptionStatus, 'active', 'Older event must not overwrite newer active status');
    assert.strictEqual(userAfterOlder?.plan, 'pro', 'Older event must not regress plan');
    console.log('  ✅ PASS: 3.9 Out-of-order older webhook event does not overwrite newer subscription state');

    // --------------------------------------------------------------------------
    // TASK 4: Validate Customer Portal Return URL
    // --------------------------------------------------------------------------
    console.log('\n[Task 4 — Validate Customer Portal Return URL]');

    // 4.1: Valid production application URL
    const validProdUrl = billingService.validatePortalReturnUrl('https://videorisk.com/settings');
    assert.strictEqual(validProdUrl, 'https://videorisk.com/settings');

    // 4.2: Valid development localhost URL in test environment
    const validLocalUrl = billingService.validatePortalReturnUrl('http://localhost:3000/pricing');
    assert.strictEqual(validLocalUrl, 'http://localhost:3000/pricing');

    // 4.3: External domain rejected (400)
    let externalDomainThrew = false;
    try {
      billingService.validatePortalReturnUrl('https://evil-phishing.com/callback');
    } catch (err: any) {
      externalDomainThrew = true;
      assert.strictEqual(err.statusCode, 400);
      assert.ok(err.message.includes('not authorized'));
    }
    assert.strictEqual(externalDomainThrew, true, 'External domain must be rejected with 400');

    // 4.4: Protocol-relative URL rejected (400)
    let protoRelativeThrew = false;
    try {
      billingService.validatePortalReturnUrl('//evil.com/phishing');
    } catch (err: any) {
      protoRelativeThrew = true;
      assert.strictEqual(err.statusCode, 400);
      assert.strictEqual(err.message, 'Protocol-relative return URLs are strictly forbidden.');
    }
    assert.strictEqual(protoRelativeThrew, true, 'Protocol-relative URL must be rejected with 400');

    // 4.5: Malformed URL rejected (400)
    let malformedThrew = false;
    try {
      billingService.validatePortalReturnUrl('htt ps://bad-url');
    } catch (err: any) {
      malformedThrew = true;
      assert.strictEqual(err.statusCode, 400);
      assert.strictEqual(err.message, 'Malformed return URL format.');
    }
    assert.strictEqual(malformedThrew, true, 'Malformed URL must be rejected with 400');

    // 4.6: Dangerous schemes rejected (400)
    const dangerousSchemes = ['javascript:alert(1)', 'data:text/html,hack', 'file:///etc/passwd'];
    for (const schemeUrl of dangerousSchemes) {
      let schemeThrew = false;
      try {
        billingService.validatePortalReturnUrl(schemeUrl);
      } catch (err: any) {
        schemeThrew = true;
        assert.strictEqual(err.statusCode, 400);
        assert.ok(err.message.includes('Dangerous return URL scheme'));
      }
      assert.strictEqual(schemeThrew, true, `${schemeUrl} must be rejected with 400`);
    }

    // 4.7: Missing return URL uses canonical application URL
    const fallbackUrl = billingService.validatePortalReturnUrl(undefined);
    assert.strictEqual(fallbackUrl, `${billingService.getCanonicalAppUrl()}/?view=pricing`);

    // 4.8: HTTP route testing with spoofed Origin header
    const routeResBad = await fetch(`${baseUrl}/billing/create-portal-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
        Origin: 'https://evil-spoof.com'
      },
      body: JSON.stringify({ returnUrl: 'https://evil-phishing.com/stolen' })
    });
    assert.strictEqual(routeResBad.status, 400, 'Route must reject unauthorized return URL regardless of Origin header');

    const routeResGood = await fetch(`${baseUrl}/billing/create-portal-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`
      },
      body: JSON.stringify({ returnUrl: 'https://videorisk.com/pricing' })
    });
    assert.strictEqual(routeResGood.status, 200, 'Route must accept authorized canonical return URL');
    const routeDataGood = await routeResGood.json();
    assert.ok(routeDataGood.url);
    console.log('  ✅ PASS: 4.1-4.8 All Customer Portal return URL validation tests passed');

    // --------------------------------------------------------------------------
    // TASK 5: Verify Credit Preflight at API Route Level
    // --------------------------------------------------------------------------
    console.log('\n[Task 5 — Verify Credit Preflight at API Route Level]');
    await ensureDemoFixtures();
    const probFixture = getDemoFixture('problematic');
    const probMeta = await mediaInspector.inspect(probFixture.videoPath, probFixture.videoFilename);
    const standardCredits = creditService.calculateRequiredCredits(probMeta.durationSeconds, 'standard');
    assert.strictEqual(standardCredits, 1);

    // 5.1: Sufficient credits on demo scan -> 201 Created
    const demoSufficientRes = await fetch(`${baseUrl}/scans/demo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`
      },
      body: JSON.stringify({ demoType: 'problematic', scanMode: 'standard' })
    });
    assert.strictEqual(demoSufficientRes.status, 201, 'Demo scan with sufficient credits must return 201');
    const demoJob = await demoSufficientRes.json();
    assert.strictEqual(demoJob.creditsUsed, 1);
    console.log('  ✅ PASS: 5.1 Demo scan with sufficient balance succeeds and creates job');

    // 5.2: Insufficient credits on demo scan -> 402 Payment Required
    const brokeEmail = `broke_preflight_${Date.now()}@videorisk.test`;
    const brokeUser = await storage.users.createUser(brokeEmail, 'hash_b', 'salt_b', 0, 'free');
    const brokeToken = await storage.users.createSession(brokeUser.id);

    const demoInsufficientRes = await fetch(`${baseUrl}/scans/demo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${brokeToken}`
      },
      body: JSON.stringify({ demoType: 'problematic', scanMode: 'standard' })
    });
    assert.strictEqual(demoInsufficientRes.status, 402, 'Demo scan with 0 credits must return 402');
    const demoErrData = await demoInsufficientRes.json();
    assert.strictEqual(demoErrData.requiredCredits, 1);
    assert.strictEqual(demoErrData.creditsRemaining, 0);
    console.log('  ✅ PASS: 5.2 Demo scan with insufficient balance rejected with 402');

    // 5.3: Concurrency protection — 2 concurrent requests competing for 1 credit
    const oneCreditEmail = `one_credit_${Date.now()}@videorisk.test`;
    const oneCreditUser = await storage.users.createUser(oneCreditEmail, 'hash_1', 'salt_1', 1, 'free');
    const oneCreditToken = await storage.users.createSession(oneCreditUser.id);

    const [resConcurrent1, resConcurrent2] = await Promise.all([
      fetch(`${baseUrl}/scans/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oneCreditToken}` },
        body: JSON.stringify({ demoType: 'problematic', scanMode: 'standard' })
      }),
      fetch(`${baseUrl}/scans/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oneCreditToken}` },
        body: JSON.stringify({ demoType: 'problematic', scanMode: 'standard' })
      })
    ]);

    const statuses = [resConcurrent1.status, resConcurrent2.status].sort();
    assert.ok(statuses.includes(201), 'At least one concurrent request should obtain the credit');
    // Balance check
    const finalOneCreditUser = await storage.users.getUser(oneCreditUser.id);
    assert.ok(finalOneCreditUser!.creditsRemaining >= 0, 'Balance must NEVER drop below 0');
    console.log('  ✅ PASS: 5.3 Concurrent requests competing for balance cannot spend below 0');

    // --------------------------------------------------------------------------
    // TASK 6: Demo Re-scan Ownership Verification
    // --------------------------------------------------------------------------
    console.log('\n[Task 6 — Demo Re-scan Ownership Verification]');

    // Create a completed scan for user A
    const parentScanId = `scan_parent_${Date.now()}`;
    await storage.scans.createScan({
      id: parentScanId,
      userId: userA.id,
      videoTitle: 'Original Completed Video',
      videoFilename: probFixture.videoFilename,
      videoPath: probFixture.videoPath,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Media inspection', 'Scene analysis', 'Risk report'],
      creditsUsed: 1,
      createdAt: new Date().toISOString()
    });

    // 6.1: Valid parent scan owned by user A -> 201 Created
    const validParentRes = await fetch(`${baseUrl}/scans/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ demoType: 'revised', parentScanId })
    });
    assert.strictEqual(validParentRes.status, 201, 'Valid parent scan owned by user must succeed');
    const validParentData = await validParentRes.json();
    assert.strictEqual(validParentData.parentScanId, parentScanId);
    assert.strictEqual(validParentData.isRescan, true);
    console.log('  ✅ PASS: 6.1 Demo re-scan with valid owned parent scan succeeds');

    // 6.2: User B attempting to reference user A's parent scan (Cross-user IDOR) -> 403 Forbidden
    const crossUserRes = await fetch(`${baseUrl}/scans/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ demoType: 'revised', parentScanId })
    });
    assert.strictEqual(crossUserRes.status, 403, 'Cross-user parent scan reference must be rejected with 403');
    const crossUserData = await crossUserRes.json();
    assert.strictEqual(crossUserData.error, 'Access denied: Cannot re-scan video belonging to another user.');
    console.log('  ✅ PASS: 6.2 Cross-user parent scan reference rejected with 403 Forbidden');

    // 6.3: Non-existent parent scan ID -> 404 Not Found
    const notFoundParentRes = await fetch(`${baseUrl}/scans/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ demoType: 'revised', parentScanId: 'scan_does_not_exist_9999' })
    });
    assert.strictEqual(notFoundParentRes.status, 404, 'Non-existent parent scan must be rejected with 404');
    console.log('  ✅ PASS: 6.3 Non-existent parent scan ID rejected with 404 Not Found');

    // 6.4: Parent scan still in progress (status !== COMPLETED) -> 400 Bad Request
    const runningParentId = `scan_running_${Date.now()}`;
    await storage.scans.createScan({
      id: runningParentId,
      userId: userA.id,
      videoTitle: 'Incomplete Running Video',
      videoFilename: probFixture.videoFilename,
      videoPath: probFixture.videoPath,
      scanMode: 'standard',
      status: 'PROCESSING_VIDEO',
      currentStage: 'Scene analysis',
      completedStages: ['Upload'],
      creditsUsed: 1,
      createdAt: new Date().toISOString()
    });

    const incompleteParentRes = await fetch(`${baseUrl}/scans/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ demoType: 'revised', parentScanId: runningParentId })
    });
    assert.strictEqual(incompleteParentRes.status, 400, 'Incomplete parent scan must be rejected with 400');
    console.log('  ✅ PASS: 6.4 Incomplete parent scan rejected with 400 Bad Request');

    console.log('\n======================================================');
    console.log('✅ ALL REMAINING PRIORITY 1 REMEDIATION TESTS PASSED');
    console.log('======================================================\n');
  } finally {
    // Restore billingService Stripe client
    billingService.reconfigure();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

if (process.argv[1] && process.argv[1].includes('p1_defect_remediation.test')) {
  runP1DefectRemediationTests().catch(err => {
    console.error('P1 Defect Remediation tests failed:', err);
    process.exit(1);
  });
}
