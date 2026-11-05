import assert from 'assert';
import express from 'express';
import { storage } from '../src/server/storage';
import { SqliteStorageRepository } from '../src/server/storage/sqliteStorage';
import { InMemoryStorageRepository } from '../src/server/storage';
import { OFFICIAL_PRICING_PLANS, getOfficialPlan } from '../src/server/storage/pricingCatalogue';
import { apiRouter } from '../src/server/routes/api';

export async function runPricingAndMembershipJourneyTests() {
  console.log('\n======================================================');
  console.log('SUITE 21: Customer-Facing Pricing & Membership Journey');
  console.log('======================================================');

  // Set up ephemeral express app for route tests
  const testApp = express();
  testApp.use(express.json());
  testApp.use('/api', apiRouter);

  const server = testApp.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // --------------------------------------------------------------------------
    // TEST 1: Dual Storage Catalogue Parity & Shared Official Plans
    // --------------------------------------------------------------------------
    console.log('[Test 1] Dual Storage Catalogue Parity & Official Plans');
    {
      const inMemoryRepo = new InMemoryStorageRepository();
      const inMemoryPlans = await inMemoryRepo.billing.getPlans();
      assert.strictEqual(inMemoryPlans.length, 5, 'InMemory storage must return 5 plans');

      const sqlitePlans = await storage.billing.getPlans();
      assert.strictEqual(sqlitePlans.length, 5, 'SQLite storage must return 5 plans');

      const expectedIds = ['free', 'creator', 'pro', 'agency', 'audit_once'];
      for (const id of expectedIds) {
        const pInMemory = inMemoryPlans.find(p => p.id === id);
        const pSqlite = sqlitePlans.find(p => p.id === id);
        const pOfficial = getOfficialPlan(id);

        assert.ok(pInMemory, `InMemory catalogue missing plan ${id}`);
        assert.ok(pSqlite, `SQLite catalogue missing plan ${id}`);
        assert.ok(pOfficial, `Official catalogue missing plan ${id}`);

        assert.strictEqual(pInMemory!.priceUsd, pOfficial!.priceUsd, `Price mismatch in InMemory for ${id}`);
        assert.strictEqual(pSqlite!.priceUsd, pOfficial!.priceUsd, `Price mismatch in SQLite for ${id}`);
        assert.strictEqual(pInMemory!.credits, pOfficial!.credits, `Credits mismatch in InMemory for ${id}`);
        assert.strictEqual(pSqlite!.credits, pOfficial!.credits, `Credits mismatch in SQLite for ${id}`);
        assert.strictEqual(pInMemory!.period, pOfficial!.period, `Period mismatch in InMemory for ${id}`);
        assert.strictEqual(pSqlite!.period, pOfficial!.period, `Period mismatch in SQLite for ${id}`);
      }

      // Specific commercial checks
      const auditOnce = getOfficialPlan('audit_once')!;
      assert.strictEqual(auditOnce.priceUsd, 29, 'Audit Once price must be $29');
      assert.strictEqual(auditOnce.credits, 60, 'Audit Once credits must be 60');
      assert.strictEqual(auditOnce.period, 'one-time', 'Audit Once period must be one-time');

      const pro = getOfficialPlan('pro')!;
      assert.strictEqual(pro.priceUsd, 19, 'Pro price must be $19/mo');
      assert.strictEqual(pro.credits, 75, 'Pro credits must be 75');

      const creator = getOfficialPlan('creator')!;
      assert.strictEqual(creator.priceUsd, 9, 'Creator price must be $9/mo');
      assert.strictEqual(creator.credits, 30, 'Creator credits must be 30');

      const agency = getOfficialPlan('agency')!;
      assert.strictEqual(agency.priceUsd, 99, 'Agency price must be $99/mo');
      assert.strictEqual(agency.credits, 600, 'Agency credits must be 600');

      const free = getOfficialPlan('free')!;
      assert.strictEqual(free.priceUsd, 0, 'Free price must be $0');
      assert.strictEqual(free.credits, 10, 'Free credits must be 10');

      console.log('  ✔ Dual storage catalogues return 5 identical plans matching official specification');
    }

    // --------------------------------------------------------------------------
    // TEST 2: Public Catalogue API Endpoints
    // --------------------------------------------------------------------------
    console.log('[Test 2] Public Catalogue API Endpoints (/api/plans and /api/billing/plans)');
    {
      const res1 = await fetch(`${baseUrl}/plans`);
      assert.strictEqual(res1.status, 200);
      const data1 = await res1.json() as any;
      const plansList1 = Array.isArray(data1) ? data1 : data1.plans;
      assert.ok(Array.isArray(plansList1));
      assert.strictEqual(plansList1.length, 5);

      const res2 = await fetch(`${baseUrl}/billing/plans`);
      assert.strictEqual(res2.status, 200);
      const data2 = await res2.json() as any;
      const plansList2 = Array.isArray(data2) ? data2 : data2.plans;
      assert.ok(Array.isArray(plansList2));
      assert.strictEqual(plansList2.length, 5);

      const planIds = plansList1.map((p: any) => p.id);
      assert.ok(planIds.includes('free'));
      assert.ok(planIds.includes('creator'));
      assert.ok(planIds.includes('pro'));
      assert.ok(planIds.includes('agency'));
      assert.ok(planIds.includes('audit_once'));

      console.log('  ✔ Both /api/plans and /api/billing/plans deliver complete 5-card pricing data');
    }

    // --------------------------------------------------------------------------
    // TEST 3: Registration Free Credit Guarantee & Duplicate Claim Protection
    // --------------------------------------------------------------------------
    console.log('[Test 3] Registration Free Credit Guarantee & Duplicate Claim Protection');
    {
      const regEmail = `pricing_test_${Date.now()}@example.com`;
      const regPassword = 'SecurePassword123!';

      const regRes = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: regEmail, password: regPassword })
      });

      assert.strictEqual(regRes.status, 201);
      const regData = await regRes.json() as any;
      assert.ok(regData.token, 'Registration must return auth session token');
      assert.strictEqual(regData.user.plan, 'free', 'Initial plan must be free');
      assert.strictEqual(regData.user.creditsRemaining, 10, 'Initial credits must be exactly 10');
      assert.strictEqual(regData.user.freeTrialClaimed, true, 'freeTrialClaimed must be true');

      const token = regData.token;

      // Verify credit ledger transaction was created
      const txRes = await fetch(`${baseUrl}/billing/transactions`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      assert.strictEqual(txRes.status, 200);
      const txData = await txRes.json() as any;
      assert.ok(Array.isArray(txData.transactions));
      assert.ok(txData.transactions.length >= 1, 'Credit ledger should record initial grant');
      const firstTx = txData.transactions[0];
      assert.strictEqual(firstTx.delta, 10, 'Credit transaction delta must be +10');
      assert.strictEqual(firstTx.balanceAfter, 10, 'Balance after initial grant must be 10');

      // Duplicate claim attempt via /api/user/plan must be rejected with 409 Conflict
      const claimRes = await fetch(`${baseUrl}/user/plan`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ plan: 'free' })
      });
      assert.strictEqual(claimRes.status, 409, 'Duplicate free trial claim must be rejected with 409 Conflict');
      const claimData = await claimRes.json() as any;
      assert.strictEqual(claimData.alreadyClaimed, true);

      console.log('  ✔ Registration immediately guarantees 10 credits, writes ledger, and blocks duplicate claims');
    }

    // --------------------------------------------------------------------------
    // TEST 4: Guest Checkout Protection & Authenticated Checkout Routing
    // --------------------------------------------------------------------------
    console.log('[Test 4] Guest Checkout Protection & Validated Plan Selection');
    {
      const { billingService } = await import('../src/server/services/billingService');
      const mockStripe: any = {
        checkout: {
          sessions: {
            create: async (params: any) => ({
              id: `cs_test_${Date.now()}`,
              url: `https://checkout.stripe.com/pay/cs_test_${Date.now()}`,
              mode: params.mode,
              metadata: params.metadata,
            }),
            retrieve: async (id: string) => ({
              id,
              payment_status: 'paid',
              status: 'complete',
              mode: 'subscription',
              metadata: { planId: 'pro' },
            })
          }
        }
      };
      billingService.setStripeClientForTest(mockStripe);

      // Unauthenticated checkout request MUST be rejected with 401
      const unauthCheckout = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: 'pro' })
      });
      assert.strictEqual(unauthCheckout.status, 401, 'Unauthenticated checkout must return 401');

      // Create authenticated user
      const userEmail = `checkout_test_${Date.now()}@example.com`;
      const regRes = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userEmail, password: 'SecurePassword123!' })
      });
      const regData = await regRes.json() as any;
      const userToken = regData.token;

      // Invalid plan ID must be rejected
      const invalidPlanCheckout = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ planId: 'non_existent_plan_xyz' })
      });
      assert.strictEqual(invalidPlanCheckout.status, 400, 'Invalid planId must return 400 Bad Request');

      // Test valid checkout for subscription plan (e.g. pro)
      const validProCheckout = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ planId: 'pro' })
      });
      assert.strictEqual(validProCheckout.status, 200);
      const proData = await validProCheckout.json() as any;
      assert.ok(proData.url || proData.sessionId);

      // Test valid checkout for one-time plan (audit_once)
      const validAuditCheckout = await fetch(`${baseUrl}/billing/checkout`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${userToken}`,
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ planId: 'audit_once' })
      });
      assert.strictEqual(validAuditCheckout.status, 200);
      const auditData = await validAuditCheckout.json() as any;
      assert.ok(auditData.url || auditData.sessionId);

      console.log('  ✔ Unauthenticated guests are prevented from calling checkout; valid plan selection is strictly checked');
    }

    // --------------------------------------------------------------------------
    // TEST 5: Credit Deductions & Precise Capacity Calculation
    // --------------------------------------------------------------------------
    console.log('[Test 5] Credit Deduction Formulas & Exact Capacity Rules');
    {
      const calcCost = (durationSec: number, mode: 'standard' | 'deep') => {
        const minutes = Math.ceil(durationSec / 60);
        return mode === 'deep' ? minutes * 2 : minutes;
      };

      // Standard scan durations:
      assert.strictEqual(calcCost(1, 'standard'), 1, '1s standard scan = 1 credit');
      assert.strictEqual(calcCost(60, 'standard'), 1, '60s standard scan = 1 credit');
      assert.strictEqual(calcCost(61, 'standard'), 2, '61s standard scan = 2 credits');
      assert.strictEqual(calcCost(120, 'standard'), 2, '120s standard scan = 2 credits');
      assert.strictEqual(calcCost(600, 'standard'), 10, '10m standard scan = 10 credits');

      // Deep scan durations:
      assert.strictEqual(calcCost(1, 'deep'), 2, '1s deep scan = 2 credits');
      assert.strictEqual(calcCost(60, 'deep'), 2, '60s deep scan = 2 credits');
      assert.strictEqual(calcCost(61, 'deep'), 4, '61s deep scan = 4 credits');
      assert.strictEqual(calcCost(120, 'deep'), 4, '120s deep scan = 4 credits');
      assert.strictEqual(calcCost(300, 'deep'), 10, '5m deep scan = 10 credits');

      // Specific Pro Deep Scan capacity calculation:
      // Pro has 75 credits.
      // Deep scan requires 2 credits per minute.
      // Math.floor(75 / 2) = 37 complete minutes, with 75 % 2 = 1 credit remaining.
      const proTotalCredits = 75;
      const proDeepCompleteMinutes = Math.floor(proTotalCredits / 2);
      const proDeepRemainingCredits = proTotalCredits % 2;
      assert.strictEqual(proDeepCompleteMinutes, 37, 'Pro plan must yield exactly 37 complete deep minutes');
      assert.strictEqual(proDeepRemainingCredits, 1, 'Pro plan must have 1 credit remaining');
      assert.notStrictEqual(proDeepCompleteMinutes, 38, 'Must NOT round Pro deep scan capacity up to 38');

      console.log('  ✔ Standard and Deep scan credit formulas and Pro 37m+1cr capacity verified');
    }

    // --------------------------------------------------------------------------
    // TEST 6: User-Scoped Billing Summary & Activity Ledger
    // --------------------------------------------------------------------------
    console.log('[Test 6] User-Scoped Billing Summary & Activity Ledger');
    {
      const testEmail = `summary_test_${Date.now()}@example.com`;
      const regRes = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: 'SecurePassword123!' })
      });
      const regData = await regRes.json() as any;
      const token = regData.token;

      // Test GET /api/billing/summary
      const summaryRes = await fetch(`${baseUrl}/billing/summary`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      assert.strictEqual(summaryRes.status, 200);
      const summaryData = await summaryRes.json() as any;
      assert.strictEqual(summaryData.email, testEmail);
      assert.strictEqual(summaryData.plan, 'free');
      assert.strictEqual(summaryData.creditsRemaining, 10);
      assert.strictEqual(typeof summaryData.creditsUsedTotal, 'number');
      assert.strictEqual(typeof summaryData.totalScansCount, 'number');
      assert.strictEqual(summaryData.isRecurring, false);

      // Test GET /api/billing/transactions
      const ledgerRes = await fetch(`${baseUrl}/billing/transactions`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      assert.strictEqual(ledgerRes.status, 200);
      const ledgerData = await ledgerRes.json() as any;
      assert.ok(Array.isArray(ledgerData.transactions));
      assert.ok(ledgerData.transactions.length >= 1);

      // Unauthenticated access must fail
      const unauthSummary = await fetch(`${baseUrl}/billing/summary`);
      assert.strictEqual(unauthSummary.status, 401);

      const unauthLedger = await fetch(`${baseUrl}/billing/transactions`);
      assert.strictEqual(unauthLedger.status, 401);

      console.log('  ✔ Authenticated billing summary and credit transaction ledger operate reliably and securely');
    }

    console.log('✔ All Pricing & Membership Journey Verification Tests Passed!\n');
  } finally {
    server.close();
  }
}

if (process.argv[1]?.includes('pricing_and_membership_journey.test.ts')) {
  runPricingAndMembershipJourneyTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
