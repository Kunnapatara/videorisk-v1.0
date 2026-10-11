import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { apiRouter } from '../src/server/routes/api';
import { storage, InMemoryStorageRepository } from '../src/server/storage';
import { billingService, ALLOWED_PAID_PLANS } from '../src/server/services/billingService';

export async function runPersistenceAndBillingHardeningTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 3: BILLING HARDENING & PERSISTENCE ---');
  console.log('======================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, desc: string) {
    total++;
    if (condition) {
      console.log(`  ✅ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${desc}`);
      throw new Error(`Test assertion failed: ${desc}`);
    }
  }

  // Set up Express test app with raw body support
  const app = express();
  app.use(express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    }
  }));
  app.use('/api', apiRouter);

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  const origNodeEnv = process.env.NODE_ENV;
  const origPaymentMode = process.env.PAYMENT_MODE;
  const origWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    // Register a test user for billing tests
    const userEmail = `billing_audit_${Date.now()}@videorisk.com`;
    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userEmail, password: 'password123' })
    });
    const regData = await regRes.json();
    const token = regData.token;
    const testUser = regData.user;

    // ---------------------------------------------------------
    // 1. FAIL-CLOSED STRIPE WEBHOOK VERIFICATION
    // ---------------------------------------------------------
    console.log('[1. Fail-Closed Stripe Webhook Verification]');

    // 1.1 Webhook without signature header in production mode
    process.env.NODE_ENV = 'production';
    delete process.env.STRIPE_WEBHOOK_SECRET;

    const noSigRes = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'evt_test_1', type: 'checkout.session.completed' })
    });
    assert(noSigRes.status === 400, 'Production webhook without stripe-signature header rejected with 400');

    // 1.2 Webhook with missing webhook secret in production fails closed
    const unconfiguredSecretRes = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'stripe-signature': 't=12345,v1=fake_signature'
      },
      body: JSON.stringify({ id: 'evt_test_2', type: 'checkout.session.completed' })
    });
    assert(unconfiguredSecretRes.status === 400, 'Production webhook with missing STRIPE_WEBHOOK_SECRET fails closed');

    // 1.3 Invalid signature rejected and mutates zero data
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_for_hardening';
    const initialCredits = (await storage.users.getUser(testUser.id))?.creditsRemaining;

    const invalidSigRes = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'stripe-signature': 't=12345,v1=invalid_signature_hex'
      },
      body: JSON.stringify({
        id: 'evt_forged_sig',
        type: 'checkout.session.completed',
        data: {
          object: {
            client_reference_id: testUser.id,
            metadata: { planId: 'agency' },
            payment_status: 'paid'
          }
        }
      })
    });
    assert(invalidSigRes.status === 400, 'Invalid signature rejected with 400 Bad Request');
    const creditsAfterInvalidSig = (await storage.users.getUser(testUser.id))?.creditsRemaining;
    assert(creditsAfterInvalidSig === initialCredits, 'Invalid signature produced zero changes to user credits');
    assert((await storage.billing.isEventProcessed('evt_forged_sig')) === false, 'Invalid signature produced zero billing-event records');

    // 1.4 Production rejects simulated webhooks
    process.env.ALLOW_SIMULATION_WEBHOOK = 'true';
    const simInProdRes = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'evt_sim_1', type: 'checkout.session.completed' })
    });
    assert(simInProdRes.status === 400, 'Production rejects unverified/simulation webhook payloads');

    // Reset env vars back for non-production tests
    process.env.NODE_ENV = 'test';
    delete process.env.PAYMENT_MODE;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.ALLOW_SIMULATION_WEBHOOK;

    // ---------------------------------------------------------
    // 2. ATOMIC AND IDEMPOTENT BILLING EFFECTS
    // ---------------------------------------------------------
    console.log('\n[2. Atomic and Idempotent Billing Effects]');

    // 2.1 Complete simulated checkout idempotency
    const simSessionId = `sim_session_${Date.now()}`;
    const userCreditsBeforeSim = (await storage.users.getUser(testUser.id))?.creditsRemaining || 0;

    const statusRes1 = await fetch(`${baseUrl}/billing/session-status?sessionId=${simSessionId}&plan=creator&mode=simulation`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(statusRes1.status === 200, 'Valid simulation checkout returns 200 OK');
    const statusData1 = await statusRes1.json();
    assert(statusData1.status === 'complete', 'Simulation checkout returns status: complete');
    const userCreditsAfterFirstSim = (await storage.users.getUser(testUser.id))?.creditsRemaining || 0;
    assert(userCreditsAfterFirstSim === userCreditsBeforeSim + 30, 'Creator plan granted exactly 30 credits');

    // 2.2 Replay identical session status (duplicate delivery)
    const statusRes2 = await fetch(`${baseUrl}/billing/session-status?sessionId=${simSessionId}&plan=creator&mode=simulation`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(statusRes2.status === 200, 'Duplicate session status returns 200 OK');
    const userCreditsAfterSecondSim = (await storage.users.getUser(testUser.id))?.creditsRemaining || 0;
    assert(userCreditsAfterSecondSim === userCreditsAfterFirstSim, 'Duplicate checkout delivery granted zero extra credits (Idempotent)');

    // 2.3 Concurrent simulation checkouts with same session ID
    const dupSimId = `sim_concurrent_${Date.now()}`;
    const concurrentRequests = await Promise.all([
      fetch(`${baseUrl}/billing/session-status?sessionId=${dupSimId}&plan=creator&mode=simulation`, {
        headers: { Authorization: `Bearer ${token}` }
      }),
      fetch(`${baseUrl}/billing/session-status?sessionId=${dupSimId}&plan=creator&mode=simulation`, {
        headers: { Authorization: `Bearer ${token}` }
      }),
      fetch(`${baseUrl}/billing/session-status?sessionId=${dupSimId}&plan=creator&mode=simulation`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ]);
    assert(concurrentRequests.every(r => r.status === 200), 'Concurrent checkout status requests all succeed');
    const creditsAfterConcurrent = (await storage.users.getUser(testUser.id))?.creditsRemaining || 0;
    assert(creditsAfterConcurrent === userCreditsAfterSecondSim + 30, 'Concurrent execution granted credits exactly once (No double-spend)');

    // 2.4 Rejection of unknown plans during simulated checkout
    const badPlanRes = await fetch(`${baseUrl}/billing/session-status?sessionId=sim_bad_plan_${Date.now()}&plan=free_infinite&mode=simulation`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(badPlanRes.status === 400, 'Unknown plan in simulated checkout rejected with 400 Bad Request');

    // 2.5 Rejection of checkout completion for non-existent user
    let nonExistentUserCaught = false;
    try {
      await billingService.completeSimulatedCheckout(`sim_ghost_${Date.now()}`, 'creator', 'user_does_not_exist_xyz');
    } catch (err: any) {
      nonExistentUserCaught = err.message.includes('User not found');
    }
    assert(nonExistentUserCaught, 'Billing rejects non-existent user ID without silent substitution');

    // ---------------------------------------------------------
    // 3. CHECKOUT SESSION STATUS VERIFICATION
    // ---------------------------------------------------------
    console.log('\n[3. Checkout Session Status Verification]');

    // 3.1 Missing sessionId returns 400
    const missingSessionRes = await fetch(`${baseUrl}/billing/session-status`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(missingSessionRes.status === 400, 'GET /billing/session-status without sessionId returns 400 Bad Request');

    // 3.2 Arbitrary sessionId without provider/simulation returns 400 (not false 'complete')
    const fakeSessionRes = await fetch(`${baseUrl}/billing/session-status?sessionId=cs_arbitrary_fake_12345`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(fakeSessionRes.status === 400, 'Arbitrary session ID rejected without false payment success');

    // 3.3 Simulation status rejected when in production mode
    process.env.NODE_ENV = 'production';
    const prodSimRes = await fetch(`${baseUrl}/billing/session-status?sessionId=sim_123&plan=creator&mode=simulation`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert(prodSimRes.status === 403, 'Simulated session status rejected with 403 Forbidden in production');
    process.env.NODE_ENV = 'test';

    // ---------------------------------------------------------
    // 4. STRICT PLAN AND PRICE CONFIGURATION
    // ---------------------------------------------------------
    console.log('\n[4. Strict Plan and Price Configuration]');

    // 4.1 Server rejects unknown plan ID on checkout
    const unknownPlanCheckout = await fetch(`${baseUrl}/billing/checkout`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ planId: 'hacked_unlimited' })
    });
    assert(unknownPlanCheckout.status === 400, 'Unknown plan ID in checkout rejected with 400');

    // 4.2 Free plan cannot be checked out via payment session
    const freePlanCheckout = await fetch(`${baseUrl}/billing/checkout`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ planId: 'free' })
    });
    assert(freePlanCheckout.status === 400, 'Free plan rejected from paid checkout session creation');

    // 4.3 Allowlist contains strictly supported paid tiers
    assert(ALLOWED_PAID_PLANS.includes('creator'), 'Allowlist includes creator');
    assert(ALLOWED_PAID_PLANS.includes('pro'), 'Allowlist includes pro');
    assert(ALLOWED_PAID_PLANS.includes('agency'), 'Allowlist includes agency');
    assert(ALLOWED_PAID_PLANS.includes('audit_once'), 'Allowlist includes audit_once');
    assert(!ALLOWED_PAID_PLANS.includes('free' as any), 'Allowlist excludes free');

    // ---------------------------------------------------------
    // 5. SAFE AND DURABLE DATA PERSISTENCE
    // ---------------------------------------------------------
    console.log('\n[5. Safe and Durable Data Persistence]');

    // 5.1 Atomic write behavior
    const tempStorePath = path.resolve(os.tmpdir(), `videorisk_store_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.json`);
    const tempStorage = new InMemoryStorageRepository(tempStorePath);

    const testUserPersist = await tempStorage.users.createUser('persist_test@videorisk.com', 'hash123', 'salt123', 50, 'creator');
    assert(fs.existsSync(tempStorePath), 'Store file created on disk');

    // Verify written JSON is complete and valid
    const fileContent = JSON.parse(fs.readFileSync(tempStorePath, 'utf-8'));
    assert(fileContent.users[testUserPersist.id].email === 'persist_test@videorisk.com', 'User correctly persisted in store file');

    // 5.2 Concurrent transaction writes without data corruption
    const iterations = 30;
    const initialBalance = testUserPersist.creditsRemaining;
    const writePromises = [];
    for (let i = 0; i < iterations; i++) {
      writePromises.push(tempStorage.users.addCredits(testUserPersist.id, 2));
    }
    await Promise.all(writePromises);

    const finalBalance = (await tempStorage.users.getUser(testUserPersist.id))?.creditsRemaining;
    assert(finalBalance === initialBalance + iterations * 2, `Concurrent transactions matched expected balance (${finalBalance} credits)`);

    // 5.3 Durability across simulated server restarts
    // Instantiate new storage pointing to existing store file
    const restartedStorage = new InMemoryStorageRepository(tempStorePath);
    const restoredUser = await restartedStorage.users.getUser(testUserPersist.id);
    assert(restoredUser !== null, 'User survived restart from persisted storage');
    assert(restoredUser?.creditsRemaining === finalBalance, 'User credit balance preserved exactly across restart');
    assert(restoredUser?.plan === 'creator', 'User plan preserved exactly across restart');

    // 5.4 Production demo user isolation
    process.env.NODE_ENV = 'production';
    let demoInProdBlocked = false;
    try {
      await restartedStorage.users.getOrCreateDefaultUser();
    } catch (err: any) {
      demoInProdBlocked = err.message.includes('disabled in production');
    }
    assert(demoInProdBlocked, 'Default demo user creation blocked in production environment');
    process.env.NODE_ENV = origNodeEnv;

    // Cleanup temp store file
    if (fs.existsSync(tempStorePath)) {
      fs.unlinkSync(tempStorePath);
    }

    console.log(`\n======================================================`);
    console.log(`TEST SUITE 3 COMPLETE: ${passed}/${total} assertions passed!`);
    console.log(`======================================================\n`);
  } finally {
    server.close();
    process.env.NODE_ENV = origNodeEnv;
    if (origPaymentMode) process.env.PAYMENT_MODE = origPaymentMode;
    if (origWebhookSecret) process.env.STRIPE_WEBHOOK_SECRET = origWebhookSecret;
  }
}
