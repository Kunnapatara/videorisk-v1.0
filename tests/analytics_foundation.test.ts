import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import Stripe from 'stripe';
import { DatabaseSync } from 'node:sqlite';
import { enforceTestDatabaseIsolation } from '../src/server/storage/testIsolation';
import {
  MediaInspectionError,
} from '../src/server/pipeline/mediaInspector';
import type { IStorageRepository } from '../src/server/storage';
import type { MediaMetadata, ScanJob } from '../src/types';

function buildSignedWebhookRequest(
  stripeHelper: Stripe,
  secret: string,
  eventPayload: Record<string, any>
): { rawBody: Buffer; payloadStr: string; signature: string } {
  const payloadStr = JSON.stringify(eventPayload);
  const signature = stripeHelper.webhooks.generateTestHeaderString({
    payload: payloadStr,
    secret,
  });
  return { rawBody: Buffer.from(payloadStr, 'utf-8'), payloadStr, signature };
}

function makeMockMediaMetadata(durationSeconds = 30): MediaMetadata {
  return {
    filename: 'fixture_clip.mp4',
    originalSize: 1024 * 1024,
    durationSeconds,
    width: 1280,
    height: 720,
    resolutionLabel: '720p',
    fps: 30,
    hasAudio: true,
    audioCodec: 'aac',
    videoCodec: 'h264',
    isProxyUsed: false,
  };
}

function createStubPipelineDeps(overrides: {
  onInspect?: () => Promise<MediaMetadata>;
  onVideo?: () => Promise<any>;
} = {}) {
  return {
    mediaInspector: {
      inspect: overrides.onInspect || (async () => makeMockMediaMetadata(30)),
    },
    proxyGenerator: {
      generateProxyIfNeeded: async (videoPath: string) => videoPath,
    },
    audioProcessor: {
      analyzeAudio: (async () => ({
        hasAudioStream: true,
        hasVoiceover: true,
        voiceoverRatio: 0.5,
        silenceRatio: 0.1,
        hasMusicDetected: false,
        speechDetected: true,
        speechAnalysisStatus: 'NO_SIGNAL_DETECTED',
        musicDetected: false,
        musicAnalysisStatus: 'NO_SIGNAL_DETECTED',
        hasRepeatedAudio: false,
        repeatedAudioStatus: 'NO_SIGNAL_DETECTED',
        transcriptAvailable: false,
        transcriptUnavailableReason: 'NOT_ASSESSED',
        audioFingerprintAvailable: false,
        speechSegments: [],
        musicSegments: [],
        repeatedAudioSegments: [],
      })) as any,
    },
    videoProcessor: {
      analyzeVideo: overrides.onVideo || (async () => ({
        repeatedFootageStatus: 'NO_SIGNAL_DETECTED' as const,
        slideshowAnalysisStatus: 'NO_SIGNAL_DETECTED' as const,
        sceneChangeFrequency: 4,
        visualSimilarityScore: 0.1,
        hasSlideshowPattern: false,
        frameHashesSampled: 10,
        frameCountMeasured: 10,
        repeatedFootageSegments: [],
        slideshowSegments: [],
        visualOverlaySignals: {
          status: 'NO_SIGNAL_DETECTED' as const,
          ocrAttempted: false,
          ocrAvailable: false,
          ocrFramesEvaluated: 0,
          ocrFramesWithText: 0,
          ocrTextFound: false,
          staticOverlayDetected: false,
          templateReuseSuspected: false,
          ocrFindingsCount: 0,
          ocrFindings: [],
          ocrUnavailableReason: 'NOT_ASSESSED',
        },
        visualVerificationLevel: 'MEASURED_FRAME_ANALYSIS' as const,
      })),
      performVideoOcr: (async () => ({
        status: 'NO_SIGNAL_DETECTED',
        ocrAttempted: false,
        ocrAvailable: false,
        ocrFramesEvaluated: 0,
        ocrFramesWithText: 0,
        ocrTextFound: false,
        staticOverlayDetected: false,
        templateReuseSuspected: false,
        ocrFindingsCount: 0,
        ocrFindings: [],
        ocrUnavailableReason: 'NOT_ASSESSED',
      })) as any,
      cleanupFrames: async () => {},
    },
    thumbnailInspector: {
      inspect: (async () => ({
        provided: false,
        assessed: false,
        status: 'NOT_ASSESSED',
        resolution: undefined,
        aspectRatio: undefined,
        fileSizeBytes: undefined,
        findings: [],
      })) as any,
    },
    policyIntelligenceEngine: {
      generateEvidenceTimeline: (() => []) as any,
      buildReport: ((params: any) => ({
        scanId: params.scanId,
        generatedAt: new Date().toISOString(),
        overallScore: 12,
        riskTier: 'Low Risk',
        riskSummary: 'Low risk test fixture.',
        policyTriggers: [],
        recommendations: [],
        evidenceTimeline: [],
        scoreBreakdown: {
          baseRisk: 0,
          reusedContentRisk: 0,
          repetitivePatternRisk: 0,
          audioReuseRisk: 0,
          monetizationRisk: 0,
        },
        signalConfidence: {
          overallConfidence: 'High',
          mediaMetadataVerified: true,
          audioTrackAnalyzed: true,
          speechTranscriptEvaluated: false,
          visualFramesAnalyzed: true,
          visualOcrEvaluated: false,
          thumbnailEvaluated: false,
        },
        mediaMetadata: params.metadata,
        limitations: [],
      })) as any,
      generateComparison: (() => null) as any,
    },
  };
}

export async function runAnalyticsFoundationTests() {
  console.log('\n======================================================');
  console.log('--- SUITE 26: ANALYTICS FOUNDATION COMPLETION ---');
  console.log('Migration 010, Event Service, Funnel & Security Tests');
  console.log('======================================================\n');

  process.env.VIDEORISK_TEST_RUN = 'true';
  enforceTestDatabaseIsolation();

  const { storage, InMemoryStorageRepository } = await import('../src/server/storage');
  const { SqliteStorageRepository } = await import('../src/server/storage/sqliteStorage');
  const { analyticsService, AnalyticsValidationError, ANALYTICS_EVENT_VERSION } = await import(
    '../src/server/services/analyticsService'
  );
  const { billingService } = await import('../src/server/services/billingService');
  const { apiRouter } = await import('../src/server/routes/api');
  const { JobOrchestrator } = await import('../src/server/pipeline/jobOrchestrator');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_analytics_test_'));

  const prevEnv = {
    ADMIN_EMAILS: process.env.ADMIN_EMAILS,
    ADMIN_USER_IDS: process.env.ADMIN_USER_IDS,
    APP_BASE_URL: process.env.APP_BASE_URL,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRICE_CREATOR: process.env.STRIPE_PRICE_CREATOR,
    STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
    STRIPE_PRICE_AGENCY: process.env.STRIPE_PRICE_AGENCY,
    STRIPE_PRICE_AUDIT_ONCE: process.env.STRIPE_PRICE_AUDIT_ONCE,
    ALLOW_SIMULATION_WEBHOOK: process.env.ALLOW_SIMULATION_WEBHOOK,
    PAYMENT_MODE: process.env.PAYMENT_MODE,
  };

  const restoreEnv = () => {
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    billingService.setStripeClientForTest(null);
    billingService.reconfigure();
    analyticsService.setStorageForTest(null);
  };

  const app = express();
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use('/api', apiRouter);
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // -------------------------------------------------------------------------
    // 1. MIGRATION TESTS (010_analytics_events on pre-010 populated DB)
    // -------------------------------------------------------------------------
    console.log('[1. Migration Tests — Additive 010_analytics_events & Preservation]');

    const pre010DbPath = path.join(tempDir, 'pre010_populated.db');
    const rawPreDb = new DatabaseSync(pre010DbPath);
    rawPreDb.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, plan TEXT NOT NULL DEFAULT 'free',
        credits_remaining INTEGER NOT NULL DEFAULT 10, credits_used_total INTEGER NOT NULL DEFAULT 0,
        total_scans_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT,
        password_hash TEXT, salt TEXT, free_trial_claimed INTEGER NOT NULL DEFAULT 1,
        stripe_customer_id TEXT, subscription_id TEXT, subscription_status TEXT
      );
      CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE rate_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, action TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE uploads (file_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, filename TEXT NOT NULL, file_path TEXT NOT NULL, file_size INTEGER NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE channel_profiles (id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL, version INTEGER NOT NULL DEFAULT 1, channel_topic TEXT NOT NULL, content_type TEXT NOT NULL, production_workflow TEXT NOT NULL, third_party_footage_usage TEXT NOT NULL, original_voice_narration TEXT NOT NULL, ai_assisted_content INTEGER NOT NULL DEFAULT 0, ai_disclosure_details TEXT, typical_sources TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE scans (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, video_title TEXT NOT NULL, video_description TEXT,
        video_tags_json TEXT, video_filename TEXT NOT NULL, video_path TEXT NOT NULL,
        thumbnail_path TEXT, thumbnail_filename TEXT, thumbnail_metadata_json TEXT, proxy_path TEXT,
        scan_mode TEXT NOT NULL, status TEXT NOT NULL, current_stage TEXT NOT NULL, completed_stages_json TEXT NOT NULL,
        credits_used INTEGER NOT NULL DEFAULT 0, credits_deducted INTEGER NOT NULL DEFAULT 0,
        credits_refunded INTEGER NOT NULL DEFAULT 0, credits_refunded_amount INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT, benchmark_metrics_json TEXT, error TEXT, parent_scan_id TEXT,
        is_rescan INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE job_queue (
        id TEXT PRIMARY KEY, scan_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3, run_at TEXT NOT NULL, locked_at TEXT, locked_by TEXT,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        lease_token TEXT, lease_expires_at TEXT, lease_duration_ms INTEGER DEFAULT 60000
      );
      CREATE TABLE reports (scan_id TEXT PRIMARY KEY, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE evidence (scan_id TEXT NOT NULL, item_id TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY (scan_id, item_id));
      CREATE TABLE comparisons (id TEXT PRIMARY KEY, original_scan_id TEXT NOT NULL, revised_scan_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE usage_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scan_id TEXT NOT NULL UNIQUE, duration_minutes REAL NOT NULL, credits_deducted INTEGER NOT NULL, mode TEXT NOT NULL, timestamp TEXT NOT NULL);
      CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, provider TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, processed_at TEXT NOT NULL, user_id TEXT, credits_granted INTEGER, plan_granted TEXT);
      CREATE TABLE subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT NOT NULL, status TEXT NOT NULL, current_period_end TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_event_created INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE credit_transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, type TEXT NOT NULL, reference_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL);
      CREATE TABLE channel_intelligence (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, sample_size INTEGER NOT NULL DEFAULT 0, source_scan_ids_json TEXT NOT NULL, source_video_identities_json TEXT NOT NULL, patterns_json TEXT NOT NULL, comparisons_json TEXT NOT NULL, temporal_analysis_json TEXT, coverage_json TEXT NOT NULL, coverage_details_json TEXT NOT NULL, disclaimer TEXT NOT NULL, mandatory_coverage_statement TEXT NOT NULL, limitations TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE stripe_payments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, payment_intent_id TEXT, charge_id TEXT, invoice_id TEXT, subscription_id TEXT, customer_id TEXT, plan_id TEXT, credits_granted INTEGER NOT NULL DEFAULT 0, amount_total INTEGER, currency TEXT, status TEXT NOT NULL DEFAULT 'paid', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE stripe_refunds (refund_id TEXT PRIMARY KEY, payment_id TEXT, user_id TEXT, charge_id TEXT, payment_intent_id TEXT, invoice_id TEXT, subscription_id TEXT, plan_id TEXT, amount_refunded INTEGER NOT NULL DEFAULT 0, total_amount INTEGER, is_full_refund INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, credits_adjusted INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, event_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, raw_status TEXT, reconciled INTEGER NOT NULL DEFAULT 0, last_event_created INTEGER);

      INSERT INTO schema_migrations VALUES (1, '001_initial_relational_schema', '2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (2, '002_job_queue_lease_fencing', '2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (3, '003_lease_expiry_and_usage_idempotency', '2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (4, '004_credit_transactions_append_only_ledger', '2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (5, '005_channel_intelligence_persistence', '2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (6, '006_stripe_payments_and_refunds', '2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (7, '007_stripe_refunds_reconciliation_metadata', '2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (8, '008_stripe_refunds_event_ordering', '2026-01-01T00:00:00.000Z');
      INSERT INTO schema_migrations VALUES (9, '009_subscriptions_event_ordering_and_cancel_state', '2026-01-01T00:00:00.000Z');

      INSERT INTO users (id, email, plan, credits_remaining, credits_used_total, total_scans_count, created_at, free_trial_claimed)
      VALUES ('usr_legacy_1', 'legacy@videorisk.test', 'pro', 42, 8, 2, '2026-02-01T10:00:00.000Z', 1);
      INSERT INTO scans (id, user_id, video_title, video_filename, video_path, scan_mode, status, current_stage, completed_stages_json, credits_used, credits_deducted, created_at, completed_at)
      VALUES ('scan_legacy_1', 'usr_legacy_1', 'Legacy Video', 'legacy.mp4', '/tmp/legacy.mp4', 'standard', 'COMPLETED', 'Risk report', '["Upload","Risk report"]', 2, 2, '2026-02-01T11:00:00.000Z', '2026-02-01T11:02:00.000Z');
      INSERT INTO credit_transactions VALUES ('ctx_legacy_1', 'usr_legacy_1', 75, 75, 'PLAN_PURCHASE', 'sub_legacy_1', NULL, '2026-02-01T10:05:00.000Z');
      INSERT INTO subscriptions VALUES ('sub_legacy_1', 'usr_legacy_1', 'pro', 'active', '2026-03-01T10:05:00.000Z', '2026-02-01T10:05:00.000Z', '2026-02-01T10:05:00.000Z', 1769940300, 0);
      INSERT INTO stripe_payments VALUES ('pay_legacy_1', 'usr_legacy_1', 'cs_legacy_1', 'pi_legacy_1', 'ch_legacy_1', NULL, 'sub_legacy_1', 'cus_legacy_1', 'pro', 75, 2900, 'usd', 'paid', '2026-02-01T10:05:00.000Z', '2026-02-01T10:05:00.000Z');
      INSERT INTO stripe_refunds VALUES ('re_legacy_1', 'pay_legacy_1', 'usr_legacy_1', 'ch_legacy_1', 'pi_legacy_1', NULL, 'sub_legacy_1', 'pro', 0, 2900, 0, 'failed', 0, 'expired', 'evt_legacy_1', '2026-02-02T10:00:00.000Z', '2026-02-02T10:00:00.000Z', 'failed', 1, 1770026400);
    `);
    rawPreDb.close();

    const upgradedRepo = new SqliteStorageRepository(pre010DbPath, {
      NODE_ENV: 'test',
      VIDEORISK_TEST_RUN: 'true',
    });

    const migRows = upgradedRepo.db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ version: number; name: string }>;
    assert(migRows.length >= 10, 'Migration 10 and all additive migrations applied');
    const mig10 = migRows.find(r => r.version === 10);
    assert(mig10, 'Migration 10 exists');
    assert.strictEqual(mig10.name, '010_analytics_events');

    const idxRows = upgradedRepo.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'analytics_events'")
      .all() as Array<{ name: string }>;
    const idxNames = new Set(idxRows.map(r => r.name));
    assert(idxNames.has('idx_analytics_events_name_occurred'), 'name/occurred index exists');
    assert(idxNames.has('idx_analytics_events_user_occurred'), 'user/occurred index exists');
    assert(idxNames.has('idx_analytics_events_anon_occurred'), 'anon/occurred index exists');
    assert(idxNames.has('idx_analytics_events_idempotency'), 'idempotency unique index exists');

    // Existing records untouched
    const legacyUser = await upgradedRepo.users.getUser('usr_legacy_1');
    assert.strictEqual(legacyUser?.creditsRemaining, 42);
    assert.strictEqual(legacyUser?.plan, 'pro');
    const legacyScan = await upgradedRepo.scans.getScan('scan_legacy_1');
    assert.strictEqual(legacyScan?.status, 'COMPLETED');
    const legacyRefundCount = (upgradedRepo.db.prepare('SELECT COUNT(*) as c FROM stripe_refunds').get() as any).c;
    assert.strictEqual(legacyRefundCount, 1);

    // No historical reconstruction from pre-existing users/scans
    const emptyFunnel = await upgradedRepo.analytics.getFunnelSummary();
    assert.strictEqual(emptyFunnel.stages.user_registered.eventCount, 0);
    assert.strictEqual(emptyFunnel.stages.analysis_completed.eventCount, 0);
    assert.strictEqual(emptyFunnel.metadata.historicalReconstruction, false);
    assert.strictEqual(emptyFunnel.metadata.dataSource, 'analytics_events');
    await upgradedRepo.close();

    // Idempotent re-open on already migrated DB
    const reopenedRepo = new SqliteStorageRepository(pre010DbPath, {
      NODE_ENV: 'test',
      VIDEORISK_TEST_RUN: 'true',
    });
    const migRowsAfterReopen = reopenedRepo.db
      .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ version: number }>;
    assert.strictEqual(migRowsAfterReopen.length, migRows.length, 'Migrations are idempotent on re-open');
    await reopenedRepo.close();
    console.log('  ✅ PASS: Migration 010 applies cleanly, preserves pre-010 data, and is idempotent');

    // -------------------------------------------------------------------------
    // 2. EVENT SERVICE TESTS (Validation, Sanitization, Best-Effort, Idempotency)
    // -------------------------------------------------------------------------
    console.log('\n[2. Event Service Tests — Validation, Sanitization, Error Safety & Idempotency]');

    await assert.rejects(
      async () => {
        await analyticsService.recordEvent({
          eventName: 'unknown_fake_event' as any,
          properties: {} as any,
        });
      },
      (err: any) => err instanceof AnalyticsValidationError
    );

    await assert.rejects(
      async () => {
        await analyticsService.recordEvent({
          eventName: 'user_registered',
          occurredAt: 'not-a-timestamp',
          properties: { registrationMethod: 'email_password' },
        });
      },
      (err: any) => err instanceof AnalyticsValidationError
    );

    const memRepo = new InMemoryStorageRepository(path.join(tempDir, 'mem_store.json'), {
      NODE_ENV: 'test',
      VIDEORISK_TEST_RUN: 'true',
    });

    // Sanitization & schema version test
    const sanitizeRes = await analyticsService.recordEvent(
      {
        eventName: 'analysis_completed',
        userId: 'usr_san_1',
        anonymousId: 'anon_san_1',
        idempotencyKey: 'anl_san_key_1',
        properties: {
          analysisId: 'scan_san_1',
          analysisMode: 'deep',
          processingStatus: 'COMPLETED',
          processingDurationMs: 1234,
          password: 'secret-password',
          token: 'vr_sess_leaked_token',
          stripeKey: 'sk_test_1234567890',
          videoPath: '/private/uploads/video.mp4',
          videoFilename: 'secret_clip.mp4',
          transcript: 'full private transcript',
          extraUnexpectedKey: 'should-be-stripped-by-allowlist',
        } as any,
      },
      memRepo
    );
    assert.strictEqual(sanitizeRes.recorded, true);
    assert.strictEqual(sanitizeRes.event?.eventVersion, ANALYTICS_EVENT_VERSION);
    assert.deepStrictEqual(sanitizeRes.event?.properties, {
      analysisId: 'scan_san_1',
      analysisMode: 'deep',
      processingStatus: 'COMPLETED',
      processingDurationMs: 1234,
    });

    // Idempotency on InMemoryStorageRepository
    const memDup = await analyticsService.recordEvent(
      {
        eventName: 'analysis_completed',
        userId: 'usr_san_1',
        idempotencyKey: 'anl_san_key_1',
        properties: {
          analysisId: 'scan_san_1',
          analysisMode: 'deep',
          processingStatus: 'COMPLETED',
          processingDurationMs: 1234,
        },
      },
      memRepo
    );
    assert.strictEqual(memDup.recorded, false);
    assert.strictEqual(memDup.deduplicated, true);

    // Idempotency on SqliteStorageRepository
    const sqliteIsoPath = path.join(tempDir, 'service_sqlite.db');
    const sqliteRepo = new SqliteStorageRepository(sqliteIsoPath, {
      NODE_ENV: 'test',
      VIDEORISK_TEST_RUN: 'true',
    });
    const sqlFirst = await analyticsService.recordEvent(
      {
        eventName: 'user_registered',
        userId: 'usr_sql_1',
        idempotencyKey: 'reg_sql_1',
        properties: { registrationMethod: 'email_password' },
      },
      sqliteRepo
    );
    const sqlDup = await analyticsService.recordEvent(
      {
        eventName: 'user_registered',
        userId: 'usr_sql_1',
        idempotencyKey: 'reg_sql_1',
        properties: { registrationMethod: 'email_password' },
      },
      sqliteRepo
    );
    assert.strictEqual(sqlFirst.recorded, true);
    assert.strictEqual(sqlDup.recorded, false);
    assert.strictEqual(sqlDup.deduplicated, true);
    await sqliteRepo.close();

    // Best-effort trackSafe logs error and never throws when storage throws
    const capturedConsoleErrors: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: any[]) => {
      capturedConsoleErrors.push(args.map(a => String(a)).join(' '));
    };
    try {
      const brokenRepo = {
        ...memRepo,
        analytics: {
          ...memRepo.analytics,
          recordEvent: async () => {
            throw new Error('Simulated analytics storage outage');
          },
        },
      } as unknown as IStorageRepository;

      const safeRes = await analyticsService.trackSafe(
        {
          eventName: 'user_registered',
          userId: 'usr_broken_1',
          properties: { registrationMethod: 'email_password' },
        },
        brokenRepo
      );
      assert.strictEqual(safeRes.recorded, false);
      assert.strictEqual(safeRes.error, 'Simulated analytics storage outage');
      assert(
        capturedConsoleErrors.some(line => line.includes('Simulated analytics storage outage') && line.includes('AnalyticsService')),
        'Structured error logged when analytics write fails'
      );
    } finally {
      console.error = origConsoleError;
    }
    console.log('  ✅ PASS: Validation, property sanitization, idempotency & non-blocking trackSafe verified');

    // -------------------------------------------------------------------------
    // 3. FUNNEL INTEGRATION TESTS: REGISTRATION, TRIAL & STRIPE PURCHASE
    // -------------------------------------------------------------------------
    console.log('\n[3. Integration Tests — Registration, Trial Activation & Stripe Purchases]');

    const uniqueSuffix = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const regEmail = `funnel_reg_${uniqueSuffix}@videorisk.test`;
    const regPassword = 'StrongPassword123!';

    const regRes = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: regEmail, password: regPassword }),
    });
    assert.strictEqual(regRes.status, 201, 'Registration returns 201');
    const regBody = await regRes.json();
    const regUserId = regBody.user.id as string;
    const regToken = regBody.token as string;
    assert.strictEqual(regBody.user.creditsRemaining, 10);

    const regEvents = await analyticsService.queryEvents({ userId: regUserId });
    const regEventNames = regEvents.events.map(e => e.eventName).sort();
    assert.deepStrictEqual(regEventNames, ['trial_activated', 'user_registered']);
    const userRegisteredEvt = regEvents.events.find(e => e.eventName === 'user_registered')!;
    assert.deepStrictEqual(userRegisteredEvt.properties, { registrationMethod: 'email_password' });
    const trialStarterEvt = regEvents.events.find(e => e.eventName === 'trial_activated')!;
    assert.deepStrictEqual(trialStarterEvt.properties, { trialType: 'free_starter', grantedCredits: 10 });

    // Free trial claim via /api/user/plan for an account with freeTrialClaimed=false
    const unclaimedUser = await storage.users.createUser(
      `unclaimed_trial_${uniqueSuffix}@videorisk.test`,
      'hash',
      'salt',
      0,
      'free'
    );
    await storage.users.updateUser(unclaimedUser.id, { freeTrialClaimed: false, creditsRemaining: 0 });
    const unclaimedToken = await storage.users.createSession(unclaimedUser.id);

    const claim1 = await fetch(`${baseUrl}/user/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${unclaimedToken}`,
      },
      body: JSON.stringify({ plan: 'free' }),
    });
    assert.strictEqual(claim1.status, 200);
    const claim1Body = await claim1.json();
    assert.strictEqual(claim1Body.creditsRemaining, 10);

    // Duplicate claim -> 409 and NO duplicate trial_activated event
    const claim2 = await fetch(`${baseUrl}/user/plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${unclaimedToken}`,
      },
      body: JSON.stringify({ plan: 'free' }),
    });
    assert.strictEqual(claim2.status, 409);

    const claimEvents = await analyticsService.queryEvents({ userId: unclaimedUser.id, eventName: 'trial_activated' });
    assert.strictEqual(claimEvents.total, 1, 'Only 1 trial_activated recorded across duplicate claim attempts');
    assert.deepStrictEqual(claimEvents.events[0].properties, {
      trialType: 'free_plan_claim',
      grantedCredits: 10,
    });

    // Stripe checkout session creation does NOT emit purchase_completed
    const webhookSecret = 'whsec_test_analytics_secret_1234567890';
    const realStripeHmac = new Stripe('sk_test_dummy_hmac_helper_1234567890', {
      apiVersion: '2025-02-24.acacia' as any,
    });
    const sessionRegistry = new Map<string, any>();

    const mockStripeSdk: any = {
      webhooks: {
        constructEvent: (payload: Buffer | string, sig: string, secret: string) =>
          realStripeHmac.webhooks.constructEvent(payload, sig, secret),
      },
      checkout: {
        sessions: {
          create: async (params: any) => {
            const id = `cs_anl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            return {
              id,
              url: `https://checkout.stripe.com/c/pay/${id}`,
              livemode: false,
            };
          },
          retrieve: async (id: string) => sessionRegistry.get(id) || null,
        },
      },
    };

    process.env.STRIPE_SECRET_KEY = 'sk_test_analytics_mock_key_1234567890';
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.STRIPE_PRICE_CREATOR = 'price_creator';
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    process.env.STRIPE_PRICE_AGENCY = 'price_agency';
    process.env.STRIPE_PRICE_AUDIT_ONCE = 'price_audit_once';
    process.env.APP_BASE_URL = 'http://localhost:3000';
    process.env.ALLOW_SIMULATION_WEBHOOK = 'false';
    billingService.reconfigure();
    billingService.setStripeClientForTest(mockStripeSdk);

    const checkoutRes = await fetch(`${baseUrl}/billing/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${regToken}`,
      },
      body: JSON.stringify({ planId: 'audit_once' }),
    });
    assert.strictEqual(checkoutRes.status, 200);
    const checkoutData = await checkoutRes.json();
    assert(checkoutData.sessionId, 'Checkout created session');

    const purchasesAfterCheckoutCreate = await analyticsService.queryEvents({
      userId: regUserId,
      eventName: 'purchase_completed',
    });
    assert.strictEqual(purchasesAfterCheckoutCreate.total, 0, 'Checkout creation must NOT emit purchase_completed');

    // Unpaid checkout.session.completed must NOT emit purchase_completed
    const unpaidWebhook = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_unpaid_${uniqueSuffix}`,
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: checkoutData.sessionId,
          client_reference_id: regUserId,
          payment_status: 'unpaid',
          metadata: { userId: regUserId, planId: 'audit_once' },
        },
      },
    });
    const unpaidRes = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': unpaidWebhook.signature,
      },
      body: unpaidWebhook.payloadStr,
    });
    assert.strictEqual(unpaidRes.status, 200);
    const purchasesAfterUnpaid = await analyticsService.queryEvents({
      userId: regUserId,
      eventName: 'purchase_completed',
    });
    assert.strictEqual(purchasesAfterUnpaid.total, 0, 'Unpaid session must NOT emit purchase_completed');

    // Paid credit purchase webhook (audit_once) -> 1 purchase_completed; replay -> still 1
    const paidAuditSessionId = `cs_paid_audit_${uniqueSuffix}`;
    const auditWebhookPayload = {
      id: `evt_paid_audit_${uniqueSuffix}`,
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: paidAuditSessionId,
          client_reference_id: regUserId,
          customer: `cus_anl_${uniqueSuffix}`,
          payment_intent: `pi_audit_${uniqueSuffix}`,
          payment_status: 'paid',
          amount_total: 999,
          currency: 'usd',
          metadata: { userId: regUserId, planId: 'audit_once' },
        },
      },
    };
    const signedAudit1 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, auditWebhookPayload);
    const signedAudit2 = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      ...auditWebhookPayload,
      id: `evt_paid_audit_retry_${uniqueSuffix}`,
    });

    const whAudit1 = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedAudit1.signature },
      body: signedAudit1.payloadStr,
    });
    assert.strictEqual(whAudit1.status, 200);
    const whAudit2 = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedAudit2.signature },
      body: signedAudit2.payloadStr,
    });
    assert.strictEqual(whAudit2.status, 200);

    const userAfterAudit = await storage.users.getUser(regUserId);
    assert.strictEqual(userAfterAudit?.creditsRemaining, 70, '10 starter + 60 audit_once = 70');

    const auditPurchases = await analyticsService.queryEvents({
      userId: regUserId,
      eventName: 'purchase_completed',
    });
    assert.strictEqual(auditPurchases.total, 1, 'Webhook retry does not duplicate purchase_completed');
    assert.deepStrictEqual(auditPurchases.events[0].properties, {
      purchaseType: 'credit_purchase',
      planId: 'audit_once',
      currency: 'usd',
      amountMinorUnits: 999,
      paymentProvider: 'stripe',
      purchaseRef: paidAuditSessionId,
    });

    // Session sync + webhook race for subscription purchase deduplicates to 1 event
    const subSessionId = `cs_sub_pro_${uniqueSuffix}`;
    const subId = `sub_pro_${uniqueSuffix}`;
    const cusId = `cus_anl_${uniqueSuffix}`;
    sessionRegistry.set(subSessionId, {
      id: subSessionId,
      client_reference_id: regUserId,
      customer: cusId,
      subscription: subId,
      payment_intent: `pi_sub_${uniqueSuffix}`,
      payment_status: 'paid',
      status: 'complete',
      amount_total: 2900,
      currency: 'usd',
      metadata: { userId: regUserId, planId: 'pro' },
      livemode: false,
    });

    const syncRes = await fetch(`${baseUrl}/billing/session-status?sessionId=${subSessionId}`, {
      headers: { Authorization: `Bearer ${regToken}` },
    });
    assert.strictEqual(syncRes.status, 200);

    const signedSubWh = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_sub_cs_${uniqueSuffix}`,
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      data: {
        object: sessionRegistry.get(subSessionId),
      },
    });
    const whSubRes = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedSubWh.signature },
      body: signedSubWh.payloadStr,
    });
    assert.strictEqual(whSubRes.status, 200);

    const purchasesAfterSub = await analyticsService.queryEvents({
      userId: regUserId,
      eventName: 'purchase_completed',
    });
    assert.strictEqual(purchasesAfterSub.total, 2, 'session_sync + webhook race yields exactly 1 subscription purchase event');
    const subPurchase = purchasesAfterSub.events.find(e => e.properties.purchaseRef === subSessionId)!;
    assert.strictEqual(subPurchase.properties.purchaseType, 'subscription_purchase');
    assert.strictEqual(subPurchase.properties.planId, 'pro');

    // Invoice renewal emits subscription_renewal once
    const invoiceId = `in_renew_${uniqueSuffix}`;
    const signedRenewal = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_renew_${uniqueSuffix}`,
      created: Math.floor(Date.now() / 1000) + 10,
      type: 'invoice.paid',
      data: {
        object: {
          id: invoiceId,
          customer: cusId,
          subscription: subId,
          billing_reason: 'subscription_cycle',
          amount_paid: 2900,
          currency: 'usd',
          lines: { data: [{ price: { id: 'price_pro' } }] },
        },
      },
    });
    const renewRes = await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedRenewal.signature },
      body: signedRenewal.payloadStr,
    });
    assert.strictEqual(renewRes.status, 200);

    // Subscription update (pro -> agency, status='active') synchronizes state ONLY and must NOT emit purchase_completed without paid invoice evidence
    const upgradeSubWh = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_upgrade_${uniqueSuffix}`,
      created: Math.floor(Date.now() / 1000) + 20,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: subId,
          customer: cusId,
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
          items: { data: [{ price: { id: 'price_agency' } }] },
        },
      },
    });
    assert.strictEqual(
      (
        await fetch(`${baseUrl}/billing/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': upgradeSubWh.signature },
          body: upgradeSubWh.payloadStr,
        })
      ).status,
      200
    );
    const purchasesAfterSubUpdateOnly = await analyticsService.queryEvents({
      userId: regUserId,
      eventName: 'purchase_completed',
    });
    assert.strictEqual(
      purchasesAfterSubUpdateOnly.total,
      3,
      'customer.subscription.updated alone must NOT emit purchase_completed'
    );

    // Authoritative paid upgrade invoice.paid (billing_reason='subscription_update') emits plan_upgrade once
    const upgradeInvoiceId = `in_upgrade_${uniqueSuffix}`;
    const upgradeInvWh = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_upgrade_inv_${uniqueSuffix}`,
      created: Math.floor(Date.now() / 1000) + 22,
      type: 'invoice.paid',
      data: {
        object: {
          id: upgradeInvoiceId,
          customer: cusId,
          subscription: subId,
          billing_reason: 'subscription_update',
          paid: true,
          status: 'paid',
          amount_paid: 7000,
          currency: 'usd',
          lines: { data: [{ price: { id: 'price_agency' }, amount: 7000 }] },
        },
      },
    });
    assert.strictEqual(
      (
        await fetch(`${baseUrl}/billing/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': upgradeInvWh.signature },
          body: upgradeInvWh.payloadStr,
        })
      ).status,
      200
    );

    const cancelWh = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_cancel_${uniqueSuffix}`,
      created: Math.floor(Date.now() / 1000) + 30,
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: subId,
          customer: cusId,
          status: 'canceled',
        },
      },
    });
    assert.strictEqual(
      (
        await fetch(`${baseUrl}/billing/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': cancelWh.signature },
          body: cancelWh.payloadStr,
        })
      ).status,
      200
    );

    const refundWh = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_refund_${uniqueSuffix}`,
      created: Math.floor(Date.now() / 1000) + 40,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_audit_${uniqueSuffix}`,
          payment_intent: `pi_audit_${uniqueSuffix}`,
          amount: 999,
          amount_refunded: 999,
          refunds: { data: [{ id: `re_audit_${uniqueSuffix}`, amount: 999, status: 'succeeded' }] },
        },
      },
    });
    assert.strictEqual(
      (
        await fetch(`${baseUrl}/billing/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': refundWh.signature },
          body: refundWh.payloadStr,
        })
      ).status,
      200
    );

    // Out-of-order full refund BEFORE checkout.session.completed blocks credit grant & purchase_completed
    const oooUser = await storage.users.createUser(`ooo_${uniqueSuffix}@videorisk.test`, 'hash', 'salt', 10, 'free');
    const oooPi = `pi_ooo_${uniqueSuffix}`;
    const oooSessionId = `cs_ooo_${uniqueSuffix}`;
    const oooRefundWh = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_ooo_refund_${uniqueSuffix}`,
      created: Math.floor(Date.now() / 1000) + 50,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_ooo_${uniqueSuffix}`,
          payment_intent: oooPi,
          amount: 999,
          amount_refunded: 999,
          refunds: { data: [{ id: `re_ooo_${uniqueSuffix}`, amount: 999, status: 'succeeded' }] },
        },
      },
    });
    await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': oooRefundWh.signature },
      body: oooRefundWh.payloadStr,
    });
    const oooCheckoutWh = buildSignedWebhookRequest(realStripeHmac, webhookSecret, {
      id: `evt_ooo_checkout_${uniqueSuffix}`,
      created: Math.floor(Date.now() / 1000) + 55,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: oooSessionId,
          client_reference_id: oooUser.id,
          payment_intent: oooPi,
          payment_status: 'paid',
          amount_total: 999,
          currency: 'usd',
          metadata: { userId: oooUser.id, planId: 'audit_once' },
        },
      },
    });
    await fetch(`${baseUrl}/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': oooCheckoutWh.signature },
      body: oooCheckoutWh.payloadStr,
    });
    const oooPurchases = await analyticsService.queryEvents({
      userId: oooUser.id,
      eventName: 'purchase_completed',
    });
    assert.strictEqual(oooPurchases.total, 0, 'Pre-refunded payment must NOT emit purchase_completed');

    const finalRegPurchases = await analyticsService.queryEvents({
      userId: regUserId,
      eventName: 'purchase_completed',
    });
    assert.strictEqual(finalRegPurchases.total, 4, 'Exactly 4 purchases: credit_purchase, subscription_purchase, subscription_renewal, plan_upgrade');
    console.log('  ✅ PASS: Registration, free trial, Stripe purchase types, retries, refunds & cancellations verified');

    // -------------------------------------------------------------------------
    // 4. VIDEO ANALYSIS USAGE TESTS (Orchestrator lifecycle & non-interference)
    // -------------------------------------------------------------------------
    console.log('\n[4. Analysis Lifecycle Tests — Started, Completed, Retries, Failed & Non-Interference]');

    const analysisDbPath = path.join(tempDir, 'analysis_orchestrator.db');
    const analysisRepo = new SqliteStorageRepository(analysisDbPath, {
      NODE_ENV: 'test',
      VIDEORISK_TEST_RUN: 'true',
    });

    const scanUser = await analysisRepo.users.createUser(`scan_${uniqueSuffix}@videorisk.test`, 'hash', 'salt', 20, 'creator');

    const makeScan = (scanId: string, mode: 'standard' | 'deep' = 'standard'): ScanJob => ({
      id: scanId,
      userId: scanUser.id,
      videoTitle: 'Private Customer Title Should Never Leak',
      videoFilename: 'private_secret_filename.mp4',
      videoPath: '/tmp/private/secret_video_path.mp4',
      scanMode: mode,
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      creditsDeducted: 0,
      createdAt: new Date().toISOString(),
    });

    // 4.1 Happy path completion
    const okScanId = `scan_ok_${uniqueSuffix}`;
    await analysisRepo.scans.createScan(makeScan(okScanId, 'standard'));
    const okOrchestrator = new JobOrchestrator(analysisRepo, false, createStubPipelineDeps());
    const claimedOk = await analysisRepo.queue.claimNextJob('worker_ok', 60000);
    assert(claimedOk, 'Claimed ok job');
    (okOrchestrator as any).workerId = 'worker_ok';
    await okOrchestrator.executeJob(claimedOk);

    const okScanAfter = await analysisRepo.scans.getScan(okScanId);
    assert.strictEqual(okScanAfter?.status, 'COMPLETED');
    const okEvents = await analysisRepo.analytics.queryEvents({ userId: scanUser.id, order: 'asc' });
    assert.strictEqual(okEvents.events.length, 2);
    assert.strictEqual(okEvents.events[0].eventName, 'analysis_started');
    assert.strictEqual(okEvents.events[1].eventName, 'analysis_completed');
    assert.strictEqual(okEvents.events[1].properties.processingStatus, 'COMPLETED');
    const serializedOk = JSON.stringify(okEvents.events);
    assert(!serializedOk.includes('private_secret_filename.mp4'), 'Filename must never appear in analytics');
    assert(!serializedOk.includes('/tmp/private/secret_video_path.mp4'), 'File path must never appear in analytics');
    assert(!serializedOk.includes('Private Customer Title'), 'Title must never appear in analytics');

    // 4.2 Retryable transient error -> no analysis_failed, retry completion -> no duplicate analysis_started
    const retryScanId = `scan_retry_${uniqueSuffix}`;
    await analysisRepo.scans.createScan(makeScan(retryScanId, 'deep'));
    let inspectAttempts = 0;
    const retryOrchestrator = new JobOrchestrator(
      analysisRepo,
      false,
      createStubPipelineDeps({
        onInspect: async () => {
          inspectAttempts += 1;
          if (inspectAttempts === 1) {
            throw new Error('Transient IO glitch');
          }
          return makeMockMediaMetadata(30);
        },
      })
    );
    (retryOrchestrator as any).workerId = 'worker_retry';
    const claimedRetry1 = await analysisRepo.queue.claimNextJob('worker_retry', 60000);
    assert(claimedRetry1);
    await retryOrchestrator.executeJob(claimedRetry1);

    const retryFailedEvents = await analysisRepo.analytics.queryEvents({ eventName: 'analysis_failed' });
    assert.strictEqual(retryFailedEvents.total, 0, 'Retryable error must NOT emit analysis_failed');

    // Make job immediately runnable for attempt 2
    analysisRepo.db
      .prepare("UPDATE job_queue SET run_at = datetime('now', '-1 second') WHERE scan_id = ?")
      .run(retryScanId);
    const claimedRetry2 = await analysisRepo.queue.claimNextJob('worker_retry', 60000);
    assert(claimedRetry2);
    await retryOrchestrator.executeJob(claimedRetry2);

    const retryScanEvents = (await analysisRepo.analytics.queryEvents({ userId: scanUser.id }))
      .events.filter(e => e.properties.analysisId === retryScanId);
    assert.strictEqual(retryScanEvents.filter(e => e.eventName === 'analysis_started').length, 1, 'Retry does not duplicate analysis_started');
    assert.strictEqual(retryScanEvents.filter(e => e.eventName === 'analysis_completed').length, 1, 'Completed after retry emits 1 analysis_completed');

    // 4.3 Terminal failure (MediaInspectionError)
    const failScanId = `scan_fail_${uniqueSuffix}`;
    await analysisRepo.scans.createScan(makeScan(failScanId, 'standard'));
    const failOrchestrator = new JobOrchestrator(
      analysisRepo,
      false,
      createStubPipelineDeps({
        onInspect: async () => {
          throw new MediaInspectionError('Corrupt moov atom in /tmp/private/bad.mp4');
        },
      })
    );
    (failOrchestrator as any).workerId = 'worker_fail';
    const claimedFail = await analysisRepo.queue.claimNextJob('worker_fail', 60000);
    assert(claimedFail);
    await failOrchestrator.executeJob(claimedFail);

    const failScanEvents = (await analysisRepo.analytics.queryEvents({ userId: scanUser.id }))
      .events.filter(e => e.properties.analysisId === failScanId);
    assert.strictEqual(failScanEvents.filter(e => e.eventName === 'analysis_started').length, 1);
    assert.strictEqual(failScanEvents.filter(e => e.eventName === 'analysis_completed').length, 0);
    const failedEvt = failScanEvents.find(e => e.eventName === 'analysis_failed')!;
    assert(failedEvt, 'Terminal failure emits analysis_failed');
    assert.strictEqual(failedEvt.properties.failureCategory, 'MEDIA_INSPECTION_ERROR');
    assert(!JSON.stringify(failedEvt).includes('/tmp/private/bad.mp4'), 'Error file path must not leak to analytics');

    // 4.4 Lease loss / FencingError suppresses completion/failure analytics
    const fencedScanId = `scan_fenced_${uniqueSuffix}`;
    await analysisRepo.scans.createScan(makeScan(fencedScanId, 'standard'));
    const fencedOrchestrator = new JobOrchestrator(
      analysisRepo,
      false,
      createStubPipelineDeps({
        onVideo: async () => {
          // Simulate stale lease superseded by another worker before completion
          analysisRepo.db
            .prepare("UPDATE job_queue SET lease_token = 'superseded_token' WHERE scan_id = ?")
            .run(fencedScanId);
          return await (createStubPipelineDeps().videoProcessor.analyzeVideo as any)();
        },
      })
    );
    (fencedOrchestrator as any).workerId = 'worker_fenced';
    const claimedFenced = await analysisRepo.queue.claimNextJob('worker_fenced', 60000);
    assert(claimedFenced);
    await fencedOrchestrator.executeJob(claimedFenced);

    const fencedEvents = (await analysisRepo.analytics.queryEvents({ userId: scanUser.id }))
      .events.filter(e => e.properties.analysisId === fencedScanId);
    assert.strictEqual(fencedEvents.filter(e => e.eventName === 'analysis_completed').length, 0, 'Fenced worker does not emit analysis_completed');
    assert.strictEqual(fencedEvents.filter(e => e.eventName === 'analysis_failed').length, 0, 'Fenced worker does not emit analysis_failed');

    // 4.5 Non-interference: broken analytics repository NEVER breaks scan completion
    const nonIntScanId = `scan_nonint_${uniqueSuffix}`;
    await analysisRepo.scans.createScan(makeScan(nonIntScanId, 'standard'));
    const origRecordEvent = analysisRepo.analytics.recordEvent;
    analysisRepo.analytics.recordEvent = async () => {
      throw new Error('Analytics DB locked failure');
    };
    const origErr = console.error;
    console.error = () => {};
    try {
      const nonIntOrchestrator = new JobOrchestrator(analysisRepo, false, createStubPipelineDeps());
      (nonIntOrchestrator as any).workerId = 'worker_nonint';
      const claimedNonInt = await analysisRepo.queue.claimNextJob('worker_nonint', 60000);
      assert(claimedNonInt);
      await nonIntOrchestrator.executeJob(claimedNonInt);
      const nonIntScan = await analysisRepo.scans.getScan(nonIntScanId);
      assert.strictEqual(nonIntScan?.status, 'COMPLETED', 'Scan completes normally even when analytics writes fail');
    } finally {
      console.error = origErr;
      analysisRepo.analytics.recordEvent = origRecordEvent;
    }

    await analysisRepo.close();
    console.log('  ✅ PASS: Analysis lifecycle, retry deduplication, fencing & analytics non-interference verified');

    // -------------------------------------------------------------------------
    // 5. FUNNEL METRICS, DATE FILTERING & ADMIN API SECURITY TESTS
    // -------------------------------------------------------------------------
    console.log('\n[5. Funnel Metrics, Date Filtering & Admin-Restricted Analytics API Security]');

    // Verify funnel calculations and date filtering in an isolated InMemoryStorageRepository
    const funnelMem = new InMemoryStorageRepository(path.join(tempDir, 'funnel_mem.json'), {
      NODE_ENV: 'test',
      VIDEORISK_TEST_RUN: 'true',
    });
    // Day 1: 2 registered (u1, u2), 2 trial (u1, u2), 1 purchase (u1), 2 analysis_started (u1 x2, u2 x1), 1 completed (u1)
    await analyticsService.recordEvent({ eventName: 'user_registered', userId: 'u1', occurredAt: '2026-05-01T10:00:00.000Z', properties: { registrationMethod: 'email_password' } }, funnelMem);
    await analyticsService.recordEvent({ eventName: 'user_registered', userId: 'u2', occurredAt: '2026-05-01T11:00:00.000Z', properties: { registrationMethod: 'email_password' } }, funnelMem);
    await analyticsService.recordEvent({ eventName: 'trial_activated', userId: 'u1', occurredAt: '2026-05-01T10:01:00.000Z', properties: { trialType: 'free_starter', grantedCredits: 10 } }, funnelMem);
    await analyticsService.recordEvent({ eventName: 'trial_activated', userId: 'u2', occurredAt: '2026-05-01T11:01:00.000Z', properties: { trialType: 'free_starter', grantedCredits: 10 } }, funnelMem);
    await analyticsService.recordEvent({ eventName: 'purchase_completed', userId: 'u1', occurredAt: '2026-05-01T12:00:00.000Z', properties: { purchaseType: 'credit_purchase', planId: 'audit_once', paymentProvider: 'stripe', purchaseRef: 'cs_1' } }, funnelMem);
    await analyticsService.recordEvent({ eventName: 'analysis_started', userId: 'u1', occurredAt: '2026-05-01T13:00:00.000Z', properties: { analysisId: 's1', analysisMode: 'standard' } }, funnelMem);
    await analyticsService.recordEvent({ eventName: 'analysis_started', userId: 'u1', occurredAt: '2026-05-01T14:00:00.000Z', properties: { analysisId: 's2', analysisMode: 'deep' } }, funnelMem);
    await analyticsService.recordEvent({ eventName: 'analysis_completed', userId: 'u1', occurredAt: '2026-05-01T14:05:00.000Z', properties: { analysisId: 's2', analysisMode: 'deep', processingStatus: 'COMPLETED', processingDurationMs: 500 } }, funnelMem);
    // Day 2: u3 registered + failed
    await analyticsService.recordEvent({ eventName: 'user_registered', userId: 'u3', occurredAt: '2026-05-02T09:00:00.000Z', properties: { registrationMethod: 'email_password' } }, funnelMem);
    await analyticsService.recordEvent({ eventName: 'analysis_started', userId: 'u3', occurredAt: '2026-05-02T09:05:00.000Z', properties: { analysisId: 's3', analysisMode: 'standard' } }, funnelMem);
    await analyticsService.recordEvent({ eventName: 'analysis_failed', userId: 'u3', occurredAt: '2026-05-02T09:06:00.000Z', properties: { analysisId: 's3', analysisMode: 'standard', processingStatus: 'FAILED', processingDurationMs: 100, failureCategory: 'MEDIA_INSPECTION_ERROR' } }, funnelMem);

    const fullSummary = await analyticsService.getFunnelSummary({}, funnelMem);
    assert.strictEqual(fullSummary.stages.user_registered.uniqueUsers, 3);
    assert.strictEqual(fullSummary.stages.trial_activated.uniqueUsers, 2);
    assert.strictEqual(fullSummary.stages.purchase_completed.uniqueUsers, 1);
    assert.strictEqual(fullSummary.stages.analysis_started.eventCount, 3);
    assert.strictEqual(fullSummary.stages.analysis_started.uniqueUsers, 2);
    assert.strictEqual(fullSummary.conversionRates.registrationToPurchase.ratePercent, 33.33);
    assert.strictEqual(fullSummary.conversionRates.analysisStartedToCompleted.ratePercent, 50);
    assert.strictEqual(fullSummary.daily.length, 2);
    assert.strictEqual(fullSummary.daily[0].date, '2026-05-01');
    assert.strictEqual(fullSummary.daily[1].date, '2026-05-02');

    const day1Only = await analyticsService.getFunnelSummary(
      { startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-05-01T23:59:59.999Z' },
      funnelMem
    );
    assert.strictEqual(day1Only.stages.user_registered.uniqueUsers, 2);
    assert.strictEqual(day1Only.stages.analysis_failed.eventCount, 0);
    assert.strictEqual(day1Only.daily.length, 1);

    // HTTP Security checks against /api/analytics/funnel & /api/analytics/events
    delete process.env.ADMIN_EMAILS;
    delete process.env.ADMIN_USER_IDS;

    // 5.1 Unauthenticated -> 401
    const unauthFunnel = await fetch(`${baseUrl}/analytics/funnel`);
    assert.strictEqual(unauthFunnel.status, 401, 'Unauthenticated /analytics/funnel returns 401');
    const unauthEvents = await fetch(`${baseUrl}/analytics/events`);
    assert.strictEqual(unauthEvents.status, 401, 'Unauthenticated /analytics/events returns 401');

    // 5.2 Authenticated ordinary user when allowlists unset -> 403 (fail-closed)
    const nonAdminUnsetFunnel = await fetch(`${baseUrl}/analytics/funnel`, {
      headers: { Authorization: `Bearer ${regToken}` },
    });
    assert.strictEqual(nonAdminUnsetFunnel.status, 403, 'Fail-closed 403 when admin allowlist unset');

    // 5.3 Email-only ADMIN_EMAILS must NEVER grant admin privileges (403)
    const adminEmail = `admin_only_${uniqueSuffix}@videorisk.test`;
    const adminUser = await storage.users.createUser(adminEmail, 'hash', 'salt', 50, 'agency');
    const adminToken = await storage.users.createSession(adminUser.id);
    process.env.ADMIN_EMAILS = adminEmail;

    const emailOnlyAdminAttempt = await fetch(`${baseUrl}/analytics/funnel`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(emailOnlyAdminAttempt.status, 403, 'Email-only ADMIN_EMAILS matching must be rejected with 403');
    delete process.env.ADMIN_EMAILS;

    // 5.3b Authenticated ordinary user when allowlist targets a different admin User ID -> 403
    process.env.ADMIN_USER_IDS = adminUser.id;

    const nonAdminFunnel = await fetch(`${baseUrl}/analytics/funnel`, {
      headers: { Authorization: `Bearer ${regToken}` },
    });
    assert.strictEqual(nonAdminFunnel.status, 403, 'Ordinary user blocked from /analytics/funnel with 403');
    const nonAdminEvents = await fetch(`${baseUrl}/analytics/events?userId=${encodeURIComponent(adminUser.id)}`, {
      headers: { Authorization: `Bearer ${regToken}` },
    });
    assert.strictEqual(nonAdminEvents.status, 403, 'Ordinary user blocked from querying other user analytics with 403');

    // 5.4 Authorized admin user -> 200 and accurate validation
    const adminFunnel = await fetch(`${baseUrl}/analytics/funnel`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(adminFunnel.status, 200, 'Authorized admin receives 200 on /analytics/funnel');
    const adminFunnelBody = await adminFunnel.json();
    assert.strictEqual(adminFunnelBody.metadata.dataSource, 'analytics_events');
    assert.strictEqual(adminFunnelBody.metadata.historicalReconstruction, false);
    assert(adminFunnelBody.stages.user_registered.uniqueUsers >= 1);
    assert(adminFunnelBody.stages.purchase_completed.uniqueUsers >= 1);

    const adminEvents = await fetch(
      `${baseUrl}/analytics/events?userId=${encodeURIComponent(regUserId)}&eventName=purchase_completed&limit=2&offset=0&order=asc`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    assert.strictEqual(adminEvents.status, 200);
    const adminEventsBody = await adminEvents.json();
    assert.strictEqual(adminEventsBody.total, 4);
    assert.strictEqual(adminEventsBody.events.length, 2);
    assert.strictEqual(adminEventsBody.hasMore, true);
    const serializedAdminResp = JSON.stringify(adminEventsBody);
    assert(!serializedAdminResp.includes(regEmail), 'Customer email must not appear in analytics response');
    assert(!serializedAdminResp.includes(regPassword), 'Password must not appear in analytics response');
    assert(!serializedAdminResp.includes(regToken), 'Session token must not appear in analytics response');

    // 5.5 Query parameter validation -> 400
    const badQueries = [
      '/analytics/events?eventName=not_real_event',
      '/analytics/events?limit=500',
      '/analytics/events?limit=0',
      '/analytics/events?limit=abc',
      '/analytics/events?offset=-1',
      '/analytics/events?order=random',
      '/analytics/events?startDate=not-a-date',
      '/analytics/events?startDate=2026-02-30',
      '/analytics/events?startDate=2026-06-10&endDate=2026-06-01',
      '/analytics/funnel?startDate=invalid',
      '/analytics/funnel?startDate=2026-06-10&endDate=2026-06-01',
    ];
    for (const q of badQueries) {
      const badRes = await fetch(`${baseUrl}${q}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(badRes.status, 400, `Expected 400 for invalid query ${q}, got ${badRes.status}`);
    }

    console.log('  ✅ PASS: Funnel metrics, date filtering, admin authorization (401/403/200) & input validation verified');
    console.log('\n✅ ALL ANALYTICS FOUNDATION TESTS PASSED!');
  } finally {
    restoreEnv();
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('tests', 'analytics_foundation.test.ts'));
if (isDirectExecution) {
  runAnalyticsFoundationTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ ANALYTICS FOUNDATION TEST FAILED:', err);
      process.exit(1);
    });
}
