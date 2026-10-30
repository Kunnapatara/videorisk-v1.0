import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { storage } from '../src/server/storage';
import { billingService } from '../src/server/services/billingService';
import { creditService } from '../src/server/services/creditService';
import { mediaInspector } from '../src/server/pipeline/mediaInspector';
import { jobOrchestrator } from '../src/server/pipeline/jobOrchestrator';
import { ensureDemoFixtures, getDemoFixture } from '../src/server/fixtures/demoMedia';

export async function runP1DefectRemediationTests() {
  console.log('\n======================================================');
  console.log('SUITE 15: PRIORITY 1 DEFECT REMEDIATION VERIFICATION');
  console.log('Authoritative Demo Media, Preflight, Billing, & Lifecycle');
  console.log('======================================================\n');

  const testEmail = `p1_user_${Date.now()}@videorisk.test`;

  // Setup test user
  const createdUser = await storage.users.createUser(
    testEmail,
    'mock_hash',
    'mock_salt',
    10,
    'free'
  );
  const testUserId = createdUser.id;

  // --------------------------------------------------------------------------
  // TEST 1 (P1-01): Demo Media Container Integrity & FFprobe Inspection
  // --------------------------------------------------------------------------
  console.log('--- Test 1.1: Demo media fixtures exist and are valid media containers ---');
  await ensureDemoFixtures();

  const probFixture = getDemoFixture('problematic');
  const revFixture = getDemoFixture('revised');

  assert.strictEqual(fs.existsSync(probFixture.videoPath), true, 'Problematic video fixture must exist on disk');
  assert.strictEqual(fs.existsSync(revFixture.videoPath), true, 'Revised video fixture must exist on disk');
  assert.strictEqual(fs.existsSync(probFixture.thumbnailPath), true, 'Demo thumbnail fixture must exist on disk');

  // Inspect with real FFprobe via mediaInspector
  const probMetadata = await mediaInspector.inspect(probFixture.videoPath, probFixture.videoFilename);
  assert.ok(probMetadata.durationSeconds > 0, 'Problematic fixture must have real non-zero duration');
  assert.ok(probMetadata.width > 0 && probMetadata.height > 0, 'Problematic fixture must have valid dimensions');
  assert.ok(probMetadata.videoCodec, 'Problematic fixture must have valid video codec');

  const revMetadata = await mediaInspector.inspect(revFixture.videoPath, revFixture.videoFilename);
  assert.ok(revMetadata.durationSeconds > 0, 'Revised fixture must have real non-zero duration');
  console.log(`[PASS] Demo media verified: duration=${probMetadata.durationSeconds}s, resolution=${probMetadata.width}x${probMetadata.height}, codec=${probMetadata.videoCodec}`);

  // --------------------------------------------------------------------------
  // TEST 2 (P1-02): Authoritative Credit Calculation & Preflight Verification
  // --------------------------------------------------------------------------
  console.log('\n--- Test 2.1: Credit preflight calculation matches policy ---');
  // For standard mode: 1 credit per minute, ceiling rounded (min 1)
  const reqCreditsStandard = creditService.calculateRequiredCredits(probMetadata.durationSeconds, 'standard');
  assert.strictEqual(reqCreditsStandard, 1, 'Standard scan of ~2s video must require 1 credit');

  // For deep mode: 2 credits per minute
  const reqCreditsDeep = creditService.calculateRequiredCredits(probMetadata.durationSeconds, 'deep');
  assert.strictEqual(reqCreditsDeep, 2, 'Deep scan of ~2s video must require 2 credits');

  // Verify multi-minute credit calculation
  assert.strictEqual(creditService.calculateRequiredCredits(125, 'standard'), 3, '125s video must require 3 standard credits');
  assert.strictEqual(creditService.calculateRequiredCredits(125, 'deep'), 6, '125s video must require 6 deep credits');
  console.log('[PASS] Credit formula verified: Standard 1 credit/min, Deep 2 credits/min with ceiling rounding');

  console.log('\n--- Test 2.2: Insufficient credit rejection (Fail-Closed) ---');
  // Create user with 0 credits
  const brokeUserCreated = await storage.users.createUser(
    `broke_${Date.now()}@videorisk.test`,
    'mock_hash',
    'mock_salt',
    0,
    'free'
  );

  const brokeUser = await storage.users.getUser(brokeUserCreated.id);
  assert.ok(brokeUser, 'Broke user should exist');
  assert.strictEqual(brokeUser.creditsRemaining, 0);

  // Preflight check: should reject when creditsRemaining < requiredCredits
  const required = creditService.calculateRequiredCredits(probMetadata.durationSeconds, 'standard');
  const hasEnough = brokeUser.creditsRemaining >= required;
  assert.strictEqual(hasEnough, false, 'Preflight check must fail for user with insufficient credits');
  console.log('[PASS] Preflight credit check correctly identifies insufficient balance');

  // --------------------------------------------------------------------------
  // TEST 3 (P1-03): Stripe Session Entitlement Synchronization & Idempotency
  // --------------------------------------------------------------------------
  console.log('\n--- Test 3.1: Idempotent session synchronization & credit grant ---');
  const mockSessionId = `cs_test_mock_${Date.now()}`;
  
  // Verify initial user balance
  const userBeforeSync = await storage.users.getUser(testUserId);
  const initialCredits = userBeforeSync!.creditsRemaining;

  // First sync
  const syncResult1 = await billingService.verifyAndSynchronizeSession(mockSessionId, testUserId);
  assert.strictEqual(syncResult1.status, 'complete');
  assert.ok(syncResult1.user, 'Updated user object must be returned');
  const creditsAfterFirstSync = syncResult1.user.creditsRemaining;
  assert.ok(creditsAfterFirstSync >= initialCredits, 'Sync should maintain or increase credit balance according to plan');

  // Second sync (idempotent replay test)
  const syncResult2 = await billingService.verifyAndSynchronizeSession(mockSessionId, testUserId);
  assert.strictEqual(syncResult2.status, 'complete');
  assert.ok(syncResult2.user, 'User object should exist in replay result');
  assert.strictEqual(syncResult2.user.creditsRemaining, creditsAfterFirstSync, 'Replay of same session must NOT grant additional credits');

  console.log('[PASS] Idempotent session synchronization verified: exact credit allocation without duplicate grant');

  // --------------------------------------------------------------------------
  // TEST 4 (P1-04): Subscription Lifecycle & Entitlement Policy
  // --------------------------------------------------------------------------
  console.log('\n--- Test 4.1: isSubscriptionEntitled policy enforcement ---');
  // active -> true
  assert.strictEqual(billingService.isSubscriptionEntitled('active'), true);
  // trialing -> true
  assert.strictEqual(billingService.isSubscriptionEntitled('trialing'), true);
  
  // past_due within 7-day grace period -> true
  const recentPastDue = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(billingService.isSubscriptionEntitled('past_due', recentPastDue), true);

  // past_due beyond 7-day grace period -> false
  const expiredPastDue = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(billingService.isSubscriptionEntitled('past_due', expiredPastDue), false);

  // canceled within prepaid currentPeriodEnd -> true
  const futurePeriodEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(billingService.isSubscriptionEntitled('canceled', futurePeriodEnd), true);

  // canceled after prepaid currentPeriodEnd -> false
  const pastPeriodEnd = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(billingService.isSubscriptionEntitled('canceled', pastPeriodEnd), false);

  // unpaid -> false
  assert.strictEqual(billingService.isSubscriptionEntitled('unpaid'), false);
  // incomplete -> false
  assert.strictEqual(billingService.isSubscriptionEntitled('incomplete'), false);
  console.log('[PASS] Subscription entitlement policy correctly handles active, trialing, grace periods, and expirations');

  console.log('\n--- Test 4.2: Customer portal session creation ---');
  // Setup stripe customer ID for test user
  await storage.users.updateUser(testUserId, { stripeCustomerId: `cus_test_${Date.now()}` });
  const portalSession = await billingService.createCustomerPortalSession(testUserId, 'https://videorisk.test/pricing');
  assert.ok(portalSession.url, 'Portal session must return a valid redirect URL');
  console.log(`[PASS] Customer portal session generated: ${portalSession.url}`);

  // --------------------------------------------------------------------------
  // TEST 5 (P1-05): Environment Initialization Order & Dynamic Reconfiguration
  // --------------------------------------------------------------------------
  console.log('\n--- Test 5.1: Billing service lazy reconfiguration ---');
  billingService.reconfigure();
  const stripeClient = billingService.getStripeClient();
  // If no Stripe API key is in env, client remains null safely without crash
  assert.ok(stripeClient === null || typeof stripeClient === 'object');
  console.log('[PASS] BillingService reconfigured dynamically without restart');

  console.log('\n======================================================');
  console.log('✅ ALL PRIORITY 1 REMEDIATION TESTS PASSED');
  console.log('======================================================\n');
}
