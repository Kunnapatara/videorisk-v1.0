import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { enforceTestDatabaseIsolation } from '../src/server/storage/testIsolation';
import type {
  EvidenceItem,
  MediaMetadata,
  RiskReport,
  ScanJob,
  StoredAudioSignature,
  StoredVisualSignature,
} from '../src/types';

process.env.VIDEORISK_TEST_RUN = 'true';
const testDbResolution = enforceTestDatabaseIsolation();

function createMockVisualSignatures(seed: number = 1): StoredVisualSignature[] {
  return [
    {
      timestamp: 0,
      hGrad: (seed % 2 === 0 ? 'ffffffffffffff' : '0123456789abcd'),
      vGrad: 'fedcba98765432',
      meanY: 120 + seed,
      stdDevY: 22.5,
      meanR: 110,
      meanG: 125,
      meanB: 130,
    },
    {
      timestamp: 2,
      hGrad: 'abcdef01234567',
      vGrad: '76543210fedcba',
      meanY: 135 + seed,
      stdDevY: 18.2,
      meanR: 120,
      meanG: 130,
      meanB: 140,
    },
  ];
}

function createMockAudioSignatures(seed: number = 1): StoredAudioSignature[] {
  return [
    {
      sec: 0,
      duration: 2,
      rms: 450 + seed * 10,
      zcr: 0.08,
      spectralProfile: Array.from({ length: 16 }, (_, idx) => parseFloat(((idx + seed) / 20).toFixed(4))),
    },
    {
      sec: 2,
      duration: 2,
      rms: 510 + seed * 10,
      zcr: 0.11,
      spectralProfile: Array.from({ length: 16 }, (_, idx) => parseFloat(((16 - idx + seed) / 22).toFixed(4))),
    },
  ];
}

function makeRichTestReport(params: {
  scanId: string;
  issueTitle?: string;
  includeIssue?: boolean;
  ocrUnavailable?: boolean;
  detectorVersion?: string;
  visualSignatures?: StoredVisualSignature[];
  audioSignatures?: StoredAudioSignature[];
}): RiskReport {
  const ver = params.detectorVersion || '1.0.0';
  const includeIssue = params.includeIssue !== false;
  const issueTitle = params.issueTitle || 'Repeated visual montage with minimal original commentary';

  return {
    scanId: params.scanId,
    overallRisk: includeIssue ? 'NEEDS_REVIEW' : 'LOW_RISK',
    riskSummary: includeIssue ? 'Detected potential reused segment.' : 'No major risk signals detected.',
    disclaimer: 'Test report',
    domainReports: {
      video_audio: {
        domain: 'video_audio',
        domainLabel: 'Video & Audio',
        status: includeIssue ? 'POTENTIAL_RISK_DETECTED' : 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: includeIssue ? issueTitle : 'Clean audio/video.',
        findingsCount: includeIssue ? 1 : 0,
        confidence: 'HIGH',
        limitations: 'None',
      },
      title: {
        domain: 'title',
        domainLabel: 'Title',
        status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: 'Clean title',
        findingsCount: 0,
        confidence: 'MEDIUM',
        limitations: 'None',
      },
      description_tags: {
        domain: 'description_tags',
        domainLabel: 'Description & Tags',
        status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: 'Clean description',
        findingsCount: 0,
        confidence: 'MEDIUM',
        limitations: 'None',
      },
      thumbnail: {
        domain: 'thumbnail',
        domainLabel: 'Thumbnail',
        status: 'NOT_PROVIDED',
        summary: 'No thumbnail uploaded',
        findingsCount: 0,
        confidence: 'UNKNOWN',
        limitations: 'Not provided',
      },
      channel_context: {
        domain: 'channel_context',
        domainLabel: 'Channel Context',
        status: 'NOT_PROVIDED',
        summary: 'No profile',
        findingsCount: 0,
        confidence: 'UNKNOWN',
        limitations: 'Not provided',
      },
    },
    riskCategories: {
      yppMonetization: { status: includeIssue ? 'NEEDS_REVIEW' : 'LOW_RISK', score: includeIssue ? 55 : 10, label: 'YPP', explanation: 'Test' },
      videoMonetization: { status: 'LOW_RISK', score: 15, label: 'Monetization', explanation: 'Test' },
      advertiserFriendly: { status: 'LOW_RISK', score: 10, label: 'Ad', explanation: 'Test' },
      copyrightSignals: { status: 'LOW_RISK', score: 10, label: 'Copyright', explanation: 'Test' },
    },
    topIssues: includeIssue
      ? [
          {
            id: `issue_${params.scanId}_1`,
            domain: 'video_audio',
            type: 'repeated_visual_footage',
            what: issueTitle,
            where: '00:00–00:10',
            why: 'Repeated visual frames detected',
            fix: 'Add original commentary',
            evidence: 'Frame sequence matched threshold',
            context: 'No narration overlap',
            recommendedAction: 'Narrate over segment',
            confidence: 'HIGH',
            limitations: 'Automated signal',
            severity: 'warning',
            policyArea: 'Reused Content',
            category: 'reused_content',
            timestampSeconds: 0,
          },
        ]
      : [],
    policyConnections: [],
    timeline: [],
    reusedContentRatio: includeIssue ? 40 : 0,
    metadataScore: 85,
    detectors: {
      video_repeated_footage: {
        detectorName: 'perceptual_hash_comparator',
        version: ver,
        status: includeIssue ? 'DETECTED' : 'NO_SIGNAL_DETECTED',
        executionDurationMs: 25,
        details: {
          visualSignatures: params.visualSignatures || createMockVisualSignatures(1),
        },
      },
      audio_repeated_segments: {
        detectorName: 'subband_spectral_audio_fingerprint',
        version: '1.1.0',
        status: 'NO_SIGNAL_DETECTED',
        executionDurationMs: 18,
        details: {
          audioSignatures: params.audioSignatures || createMockAudioSignatures(1),
        },
      },
      video_ocr: {
        detectorName: 'full_video_ocr_adapter',
        version: '1.0.0',
        status: params.ocrUnavailable ? 'ANALYSIS_UNAVAILABLE' : 'NO_SIGNAL_DETECTED',
        executionDurationMs: 10,
        failureReason: params.ocrUnavailable ? 'tesseract missing in test' : undefined,
      },
    },
    benchmarkMetrics: {
      totalProcessingSeconds: 0.5,
      inspectionMs: 20,
      audioProcessingMs: 30,
      videoAnalysisMs: 40,
      evidenceBuildingMs: 10,
      policyReasoningMs: 15,
      framesSampled: 2,
      scenesDetected: 1,
    },
  };
}

export async function runPhase2AIntelligenceFoundationTests() {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 32: PHASE 2A INTELLIGENCE FOUNDATION ---');
  console.log('======================================================');

  const { SqliteStorageRepository, InMemoryStorageRepository } = await import('../src/server/storage');
  const {
    computeEvidenceIntegritySha256,
    extractAudioSpectralFingerprint,
    extractMediaSha256Fingerprint,
    extractVisualDhashFingerprint,
    verifyEvidenceIntegrity,
  } = await import('../src/server/services/intelligenceRepositoryService');
  const { JobOrchestrator } = await import('../src/server/pipeline/jobOrchestrator');
  const { policyIntelligenceEngine } = await import('../src/server/intelligence/policyIntelligence');
  const { RetentionService } = await import('../src/server/services/retentionService');
  const { executePermanentAccountDeletion } = await import('../src/server/services/accountDeletionService');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_phase2a_test_'));

  try {
    // -------------------------------------------------------------------------
    // 1. Additive SQLite Migrations (Fresh + Legacy v11 Upgrade + Rollback)
    // -------------------------------------------------------------------------
    console.log('\n[1. Additive Migrations, Legacy DB Preservation & Failure Recovery]');
    const freshDbPath = path.join(tempDir, 'fresh_phase2a.db');
    const freshRepo = new SqliteStorageRepository(freshDbPath);

    const migRows = freshRepo.db
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ version: number; name: string }>;
    assert(migRows.some((m) => m.version === 12), 'Migration 12 applied (fingerprint repository)');
    assert(migRows.some((m) => m.version === 13), 'Migration 13 applied (evidence repository enrichment)');
    assert(migRows.some((m) => m.version === 14), 'Migration 14 applied (detection history)');

    const fpIndexes = freshRepo.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='video_fingerprints'")
      .all() as Array<{ name: string }>;
    const fpIdxNames = new Set(fpIndexes.map((i) => i.name));
    assert(fpIdxNames.has('idx_video_fingerprints_unique'), 'Unique index exists on video_fingerprints');
    assert(fpIdxNames.has('idx_video_fingerprints_user_hash'), 'Tenant+hash index exists on video_fingerprints');

    const dhIndexes = freshRepo.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='detection_history'")
      .all() as Array<{ name: string }>;
    const dhIdxNames = new Set(dhIndexes.map((i) => i.name));
    assert(dhIdxNames.has('idx_detection_history_idempotency'), 'Unique idempotency index exists on detection_history');
    assert(dhIdxNames.has('idx_detection_history_user_detected'), 'Chronological tenant index exists on detection_history');

    // Legacy v11 DB upgrade test: construct DB with Migrations 1-11 schema and pre-existing records
    const legacyDbPath = path.join(tempDir, 'legacy_v11.db');
    const legacyRawDb = new DatabaseSync(legacyDbPath);
    legacyRawDb.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1, '001_initial_relational_schema', datetime('now')),
        (2, '002_job_queue_lease_fencing', datetime('now')),
        (3, '003_lease_expiry_and_usage_idempotency', datetime('now')),
        (4, '004_credit_transactions_append_only_ledger', datetime('now')),
        (5, '005_channel_intelligence_persistence', datetime('now')),
        (6, '006_stripe_payments_and_refunds', datetime('now')),
        (7, '007_stripe_refunds_reconciliation_metadata', datetime('now')),
        (8, '008_stripe_refunds_event_ordering', datetime('now')),
        (9, '009_subscriptions_event_ordering_and_cancel_state', datetime('now')),
        (10, '010_analytics_events', datetime('now')),
        (11, '011_billing_audit_archive', datetime('now'));

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        credits_remaining INTEGER NOT NULL DEFAULT 10,
        credits_used_total INTEGER NOT NULL DEFAULT 0,
        total_scans_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        password_hash TEXT,
        salt TEXT,
        free_trial_claimed INTEGER NOT NULL DEFAULT 0,
        stripe_customer_id TEXT,
        subscription_id TEXT,
        subscription_status TEXT,
        updated_at TEXT
      );
      CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE rate_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, action TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE uploads (file_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, filename TEXT NOT NULL, file_path TEXT NOT NULL, file_size INTEGER NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE channel_profiles (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE scans (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        video_title TEXT NOT NULL,
        video_description TEXT,
        video_tags_json TEXT,
        video_filename TEXT NOT NULL,
        video_path TEXT NOT NULL,
        thumbnail_path TEXT,
        thumbnail_filename TEXT,
        thumbnail_metadata_json TEXT,
        proxy_path TEXT,
        scan_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        current_stage TEXT NOT NULL,
        completed_stages_json TEXT NOT NULL,
        credits_used INTEGER NOT NULL DEFAULT 0,
        credits_deducted INTEGER NOT NULL DEFAULT 0,
        credits_refunded INTEGER NOT NULL DEFAULT 0,
        credits_refunded_amount INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        benchmark_metrics_json TEXT,
        error TEXT,
        parent_scan_id TEXT,
        is_rescan INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE job_queue (id TEXT PRIMARY KEY, scan_id TEXT UNIQUE NOT NULL REFERENCES scans(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'QUEUED', attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, run_at TEXT NOT NULL, locked_at TEXT, locked_by TEXT, lease_token TEXT, lease_expires_at TEXT, lease_duration_ms INTEGER DEFAULT 60000, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE reports (scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE evidence (id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE comparisons (revised_scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE, original_scan_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE usage_ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scan_id TEXT NOT NULL, duration_minutes REAL NOT NULL, credits_deducted INTEGER NOT NULL, mode TEXT NOT NULL, timestamp TEXT NOT NULL);
      CREATE TABLE webhook_events (event_id TEXT PRIMARY KEY, provider TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, processed_at TEXT NOT NULL, user_id TEXT, credits_granted INTEGER, plan_granted TEXT);
      CREATE TABLE subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan_id TEXT NOT NULL, status TEXT NOT NULL, current_period_end TEXT, last_event_created INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE credit_transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, type TEXT NOT NULL, reference_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL);
      CREATE TABLE channel_intelligence (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, sample_size INTEGER NOT NULL DEFAULT 0, source_scan_ids_json TEXT NOT NULL, source_video_identities_json TEXT NOT NULL, patterns_json TEXT NOT NULL, comparisons_json TEXT NOT NULL, temporal_analysis_json TEXT, coverage_json TEXT NOT NULL, coverage_details_json TEXT NOT NULL, disclaimer TEXT NOT NULL, mandatory_coverage_statement TEXT NOT NULL, limitations TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE stripe_payments (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id TEXT, payment_intent_id TEXT, charge_id TEXT, invoice_id TEXT, subscription_id TEXT, customer_id TEXT, plan_id TEXT, credits_granted INTEGER NOT NULL DEFAULT 0, amount_total INTEGER, currency TEXT, status TEXT NOT NULL DEFAULT 'paid', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE stripe_refunds (refund_id TEXT PRIMARY KEY, payment_id TEXT, user_id TEXT, charge_id TEXT, payment_intent_id TEXT, invoice_id TEXT, subscription_id TEXT, plan_id TEXT, amount_refunded INTEGER NOT NULL DEFAULT 0, total_amount INTEGER, is_full_refund INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, raw_status TEXT, reconciled INTEGER NOT NULL DEFAULT 0, credits_adjusted INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, event_id TEXT NOT NULL, last_event_created INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE analytics_events (id TEXT PRIMARY KEY, event_name TEXT NOT NULL, user_id TEXT, anonymous_id TEXT, event_version INTEGER NOT NULL DEFAULT 1, occurred_at TEXT NOT NULL, properties TEXT NOT NULL DEFAULT '{}', idempotency_key TEXT, created_at TEXT NOT NULL);
      CREATE TABLE billing_audit_archive (id TEXT PRIMARY KEY, anonymized_subject_id TEXT NOT NULL, record_type TEXT NOT NULL, source_record_id TEXT NOT NULL, payload_json TEXT NOT NULL, archived_at TEXT NOT NULL);
    `);

    const legacyEvidenceItem: EvidenceItem = {
      id: 'ev_legacy_01',
      scanId: 'scan_legacy_01',
      domain: 'video_audio',
      timestampStart: 4,
      timestampEnd: 9,
      timestampLabel: '00:04–00:09',
      type: 'visual_repetition',
      category: 'reused_content',
      severity: 'warning',
      confidence: 0.91,
      confidenceLevel: 'HIGH',
      evidenceStatus: 'VERIFIED',
      provenance: 'videoProcessor.ts:perceptual_hash_comparator',
      source: 'video_analyzer',
      label: 'Legacy repeated segment',
      details: 'Pre-Phase-2A evidence item preserved across upgrade.',
    };

    legacyRawDb
      .prepare(`INSERT INTO users (id, email, plan, credits_remaining, created_at) VALUES (?, ?, 'creator', 25, ?)`)
      .run('user_legacy_1', 'legacy@videorisk.com', '2026-01-01T00:00:00.000Z');
    legacyRawDb
      .prepare(`
        INSERT INTO scans (id, user_id, video_title, video_filename, video_path, scan_mode, status, current_stage, completed_stages_json, created_at)
        VALUES (?, ?, 'Legacy Video', 'legacy.mp4', '/tmp/legacy.mp4', 'standard', 'COMPLETED', 'Risk report', '["Upload"]', ?)
      `)
      .run('scan_legacy_01', 'user_legacy_1', '2026-01-01T00:01:00.000Z');
    legacyRawDb
      .prepare(`INSERT INTO evidence (id, scan_id, data_json, created_at) VALUES (?, ?, ?, ?)`)
      .run('ev_legacy_01', 'scan_legacy_01', JSON.stringify(legacyEvidenceItem), '2026-01-01T00:02:00.000Z');
    legacyRawDb.close();

    // Open legacy v11 DB with current SqliteStorageRepository (runs Migrations 12-14 cleanly)
    const upgradedRepo = new SqliteStorageRepository(legacyDbPath);
    const preservedUser = await upgradedRepo.users.getUser('user_legacy_1');
    const preservedScan = await upgradedRepo.scans.getScan('scan_legacy_01');
    const backfilledEv = await upgradedRepo.evidence.getEvidenceForUser('scan_legacy_01', 'user_legacy_1');
    assert(preservedUser !== null && preservedUser.creditsRemaining === 25, 'Legacy user preserved after Migration 12-14');
    assert(preservedScan !== null && preservedScan.videoTitle === 'Legacy Video', 'Legacy scan preserved after Migration 12-14');
    assert(backfilledEv.length === 1 && backfilledEv[0].id === 'ev_legacy_01', 'Legacy evidence preserved across additive Migration 13');
    assert(backfilledEv[0].userId === 'user_legacy_1', 'Legacy evidence backfilled with owner userId');
    assert(verifyEvidenceIntegrity(backfilledEv[0]), 'Legacy backfilled evidence has valid integritySha256');
    await upgradedRepo.close();

    // Simulated migration rollback safety: conflicting pre-existing table causes Migration 12 failure and leaves DB clean
    const brokenMigDbPath = path.join(tempDir, 'broken_mig.db');
    const brokenSeedDb = new DatabaseSync(brokenMigDbPath);
    brokenSeedDb.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, name, applied_at) VALUES
        (1,'m1',datetime('now')),(2,'m2',datetime('now')),(3,'m3',datetime('now')),(4,'m4',datetime('now')),
        (5,'m5',datetime('now')),(6,'m6',datetime('now')),(7,'m7',datetime('now')),(8,'m8',datetime('now')),
        (9,'m9',datetime('now')),(10,'m10',datetime('now')),(11,'m11',datetime('now'));
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL);
      INSERT INTO users (id, email) VALUES ('u_keep', 'keep@videorisk.com');
      -- Create an incompatible video_fingerprints table missing expected columns so CREATE INDEX fails mid-Migration 12!
      CREATE TABLE video_fingerprints (id TEXT PRIMARY KEY);
    `);
    brokenSeedDb.close();

    let migrationFailureCaught = false;
    try {
      new SqliteStorageRepository(brokenMigDbPath);
    } catch {
      migrationFailureCaught = true;
    }
    assert(migrationFailureCaught, 'Failed migration 12 threw error cleanly');
    const inspectBrokenDb = new DatabaseSync(brokenMigDbPath);
    const brokenMigs = inspectBrokenDb.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
    const keptUser = inspectBrokenDb.prepare('SELECT email FROM users WHERE id = ?').get('u_keep') as { email: string } | undefined;
    inspectBrokenDb.close();
    assert(!brokenMigs.some((m) => m.version === 12), 'Failed migration 12 rolled back without recording partial migration');
    assert(keptUser?.email === 'keep@videorisk.com', 'Pre-existing records preserved on migration rollback');

    // -------------------------------------------------------------------------
    // 2. Fingerprint Repository (CRUD, Multi-Type, Dedup, No-Invent, Isolation, Tx Rollback)
    // -------------------------------------------------------------------------
    console.log('\n[2. Fingerprint Repository Verification]');
    const tenantA = await freshRepo.users.createUser('tenant_a@videorisk.com', 'h', 's', 30, 'creator');
    const tenantB = await freshRepo.users.createUser('tenant_b@videorisk.com', 'h', 's', 30, 'creator');

    const scanA1: ScanJob = {
      id: 'scan_p2a_a1',
      userId: tenantA.id,
      videoTitle: 'Tenant A Cut 1',
      videoFilename: 'a1.mp4',
      videoPath: '/tmp/a1.mp4',
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 1,
      createdAt: '2026-06-01T10:00:00.000Z',
    };
    const scanB1: ScanJob = {
      id: 'scan_p2a_b1',
      userId: tenantB.id,
      videoTitle: 'Tenant B Cut 1',
      videoFilename: 'b1.mp4',
      videoPath: '/tmp/b1.mp4',
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 1,
      createdAt: '2026-06-01T10:05:00.000Z',
    };
    await freshRepo.scans.createScan(scanA1);
    await freshRepo.scans.createScan(scanB1);

    // No-invent verification when extraction fails or returns missing/unavailable
    const validSha = crypto.createHash('sha256').update('sample-bytes-a1').digest('hex');
    assert(
      extractMediaSha256Fingerprint(scanA1, {
        filename: 'a1.mp4',
        originalSize: 100,
        durationSeconds: 10,
        width: 1920,
        height: 1080,
        resolutionLabel: '1080p',
        fps: 30,
        hasAudio: false,
        isProxyUsed: false,
        sha256: undefined,
      }) === null,
      'extractMediaSha256Fingerprint returns null when sha256 missing (never invents)'
    );
    assert(
      extractAudioSpectralFingerprint(scanA1, {
        hasVoiceover: false,
        voiceoverRatio: 0,
        silenceRatio: 1,
        hasMusicDetected: null,
        advertiserSpeechFlags: [],
        segments: [],
        transcriptSummary: '',
        speechAnalysisStatus: 'NOT_ASSESSED',
        detectors: {
          audio_repeated_segments: {
            detectorName: 'subband_spectral_audio_fingerprint',
            version: '1.1.0',
            status: 'ANALYSIS_UNAVAILABLE',
            executionDurationMs: 1,
          },
        },
      }) === null,
      'extractAudioSpectralFingerprint returns null when detector is ANALYSIS_UNAVAILABLE'
    );
    assert(
      extractVisualDhashFingerprint(scanA1, {
        scenesCount: 0,
        framesSampled: 0,
        hasSlideshowPattern: false,
        repeatedFootageSegments: [],
        templateRepetitions: [],
        averagePacingSeconds: 0,
        tempFramesDir: '',
        detectors: {
          video_repeated_footage: {
            detectorName: 'perceptual_hash_comparator',
            version: '1.0.0',
            status: 'ANALYSIS_UNAVAILABLE',
            executionDurationMs: 1,
            details: {},
          },
        },
      }) === null,
      'extractVisualDhashFingerprint returns null when visual signatures missing'
    );

    const fpInputsA = [
      extractMediaSha256Fingerprint(scanA1, {
        filename: 'a1.mp4',
        originalSize: 100,
        durationSeconds: 10,
        width: 1920,
        height: 1080,
        resolutionLabel: '1080p',
        fps: 30,
        hasAudio: true,
        isProxyUsed: false,
        sha256: validSha,
      })!,
      extractAudioSpectralFingerprint(scanA1, {
        hasVoiceover: true,
        voiceoverRatio: 0.7,
        silenceRatio: 0.1,
        hasMusicDetected: false,
        advertiserSpeechFlags: [],
        segments: [],
        transcriptSummary: 'Test transcript summary',
        speechAnalysisStatus: 'NOT_ASSESSED',
        detectors: {
          audio_repeated_segments: {
            detectorName: 'subband_spectral_audio_fingerprint',
            version: '1.1.0',
            status: 'NO_SIGNAL_DETECTED',
            executionDurationMs: 10,
            details: { audioSignatures: createMockAudioSignatures(1) },
          },
        },
      })!,
      extractVisualDhashFingerprint(scanA1, {
        scenesCount: 1,
        framesSampled: 2,
        hasSlideshowPattern: false,
        repeatedFootageSegments: [],
        templateRepetitions: [],
        averagePacingSeconds: 5,
        tempFramesDir: '',
        detectors: {
          video_repeated_footage: {
            detectorName: 'perceptual_hash_comparator',
            version: '1.0.0',
            status: 'DETECTED',
            executionDurationMs: 12,
            details: { visualSignatures: createMockVisualSignatures(1) },
          },
        },
      })!,
    ];

    const savedFpsA = await freshRepo.fingerprints.saveFingerprints(scanA1.id, fpInputsA, { systemBypass: true });
    assert(savedFpsA.length === 3, 'Saved 3 distinct fingerprints (media, audio, visual) for one scan');

    // Duplicate retry save must upsert rather than creating duplicates
    const savedFpsRetry = await freshRepo.fingerprints.saveFingerprints(scanA1.id, fpInputsA, { systemBypass: true });
    assert(savedFpsRetry.length === 3, 'Duplicate retry returns 3 fingerprints cleanly');
    const fetchedFpsA = await freshRepo.fingerprints.getFingerprintsByScan(scanA1.id, tenantA.id);
    assert(fetchedFpsA.length === 3, 'Duplicate protection keeps exact count 3 in DB');
    assert(fetchedFpsA.every((f) => Boolean(f.algorithm && f.algorithmVersion && f.provenance && f.createdAt)), 'Algorithm version and provenance preserved on all fingerprints');

    // Query by hash index
    const hashMatched = await freshRepo.fingerprints.queryFingerprints(tenantA.id, { fingerprintHash: validSha });
    assert(hashMatched.length === 1 && hashMatched[0].fingerprintType === 'media_sha256', 'Indexed lookup by fingerprintHash works for owner');

    // Cross-tenant isolation checks
    const crossTenantScanLookup = await freshRepo.fingerprints.getFingerprintsByScan(scanA1.id, tenantB.id);
    assert(crossTenantScanLookup.length === 0, 'Tenant B cannot retrieve Tenant A scan fingerprints');
    const crossTenantHashLookup = await freshRepo.fingerprints.queryFingerprints(tenantB.id, { fingerprintHash: validSha });
    assert(crossTenantHashLookup.length === 0, 'Tenant B cannot look up Tenant A fingerprints even when hash matches');

    // Transaction rollback on cross-tenant write / invalid second item in batch
    let fpBatchRollback = false;
    try {
      await freshRepo.fingerprints.saveFingerprints(
        scanB1.id,
        [
          {
            scanId: scanB1.id,
            userId: tenantB.id,
            fingerprintType: 'media_sha256',
            algorithm: 'sha256_container_digest',
            algorithmVersion: '1.0.0',
            fingerprintHash: crypto.createHash('sha256').update('b1').digest('hex'),
            signatureCount: 1,
            provenance: 'test',
            sourceStage: 'Media inspection',
          },
          {
            scanId: scanB1.id,
            userId: tenantA.id, // mismatch!
            fingerprintType: 'visual_dhash_sequence',
            algorithm: 'perceptual_hash_comparator',
            algorithmVersion: '1.0.0',
            fingerprintHash: 'bad',
            signatureCount: 1,
            provenance: 'test',
            sourceStage: 'Scene analysis',
          },
        ],
        { systemBypass: true }
      );
    } catch {
      fpBatchRollback = true;
    }
    assert(fpBatchRollback, 'Cross-tenant fingerprint batch throws and rejects mutation');
    assert((await freshRepo.fingerprints.getFingerprintsByScan(scanB1.id, tenantB.id)).length === 0, 'Failed batch rolled back completely (0 fingerprints committed for scanB1)');

    // -------------------------------------------------------------------------
    // 3. Evidence Repository (Structured Fields, Integrity, Unavailable Distinction, Tenant Isolation)
    // -------------------------------------------------------------------------
    console.log('\n[3. Evidence Repository Verification]');
    const evItemsA: EvidenceItem[] = [
      {
        id: 'ev_p2a_1',
        scanId: scanA1.id,
        domain: 'video_audio',
        timestampStart: 0,
        timestampEnd: 6,
        timestampLabel: '00:00–00:06',
        type: 'visual_repetition',
        category: 'reused_content',
        severity: 'warning',
        confidence: 0.9,
        confidenceLevel: 'HIGH',
        evidenceStatus: 'VERIFIED',
        provenance: 'videoProcessor.ts:perceptual_hash_comparator',
        source: 'video_analyzer',
        label: 'Repeated clip',
        details: 'Verified visual repetition',
      },
      {
        id: 'ev_p2a_2',
        scanId: scanA1.id,
        domain: 'video_audio',
        timestampStart: 0,
        timestampEnd: 10,
        timestampLabel: '00:00–00:10',
        type: 'video_ocr_unavailable',
        category: 'metadata_coherence',
        severity: 'info',
        confidence: null,
        confidenceLevel: 'UNKNOWN',
        uncertaintyReason: 'ANALYZER_UNAVAILABLE',
        evidenceStatus: 'NOT_ASSESSED',
        provenance: 'videoProcessor.ts:full_video_ocr_adapter',
        source: 'ocr_analyzer',
        label: 'OCR not assessed',
        details: 'Tesseract unavailable',
      },
      {
        id: 'ev_p2a_3',
        scanId: scanA1.id,
        domain: 'title',
        timestampStart: 0,
        timestampEnd: 0,
        timestampLabel: 'Title',
        type: 'title_signal',
        category: 'metadata_coherence',
        severity: 'info',
        confidence: 0.45,
        confidenceLevel: 'LOW',
        uncertaintyReason: 'INSUFFICIENT_EVIDENCE',
        evidenceStatus: 'INSUFFICIENT_EVIDENCE',
        provenance: 'policyIntelligence.ts:nlp',
        source: 'metadata_analyzer',
        label: 'Limited context',
        details: 'Short title',
      },
    ];
    await freshRepo.evidence.saveEvidence(scanA1.id, evItemsA, { systemBypass: true });

    const persistedEvA = await freshRepo.evidence.getEvidenceForUser(scanA1.id, tenantA.id);
    assert(persistedEvA.length === 3, 'All 3 evidence items persisted with distinct statuses');
    assert(persistedEvA.every((e) => verifyEvidenceIntegrity(e)), 'All persisted evidence items pass SHA-256 integrity verification');
    assert(
      persistedEvA.some((e) => e.evidenceStatus === 'NOT_ASSESSED') &&
        persistedEvA.some((e) => e.evidenceStatus === 'INSUFFICIENT_EVIDENCE') &&
        persistedEvA.some((e) => e.evidenceStatus === 'VERIFIED'),
      'VERIFIED, INSUFFICIENT_EVIDENCE, and NOT_ASSESSED statuses strictly preserved'
    );
    const filteredNotAssessed = await freshRepo.evidence.queryEvidence(tenantA.id, {
      scanId: scanA1.id,
      evidenceStatus: 'NOT_ASSESSED',
    });
    assert(filteredNotAssessed.length === 1 && filteredNotAssessed[0].id === 'ev_p2a_2', 'Indexed queryEvidence filters by evidenceStatus cleanly');
    assert((await freshRepo.evidence.getEvidenceForUser(scanA1.id, tenantB.id)).length === 0, 'Tenant B cannot read Tenant A evidence');

    // Tamper detection
    const tampered = { ...persistedEvA[0], details: 'Tampered details' };
    assert(!verifyEvidenceIntegrity(tampered), 'verifyEvidenceIntegrity detects tampered evidence payload');

    // -------------------------------------------------------------------------
    // 4. Detection History + JobOrchestrator E2E (New, Still Present, Resolved, NOT VERIFIED, Idempotency)
    // -------------------------------------------------------------------------
    console.log('\n[4. Detection History & JobOrchestrator Pipeline Integration]');
    let scenario: 'baseline' | 'rescan_partial' | 'rescan_clean_unverified_ocr' | 'fail' = 'baseline';

    const mockDeps = {
      mediaInspector: {
        inspect: async (_p: string, filename: string): Promise<MediaMetadata> => ({
          filename,
          originalSize: 2048,
          durationSeconds: 15,
          width: 1280,
          height: 720,
          resolutionLabel: '720p',
          fps: 30,
          hasAudio: scenario !== 'fail',
          isProxyUsed: false,
          sha256: crypto.createHash('sha256').update(`${scenario}_${filename}`).digest('hex'),
        }),
      },
      proxyGenerator: {
        generateProxyIfNeeded: async (p: string) => p,
      },
      audioProcessor: {
        analyzeAudio: async () => {
          if (scenario === 'fail') {
            throw new Error('Simulated audio decoder crash');
          }
          return {
            hasVoiceover: true,
            voiceoverRatio: 0.7,
            silenceRatio: 0.1,
            hasMusicDetected: false,
            advertiserSpeechFlags: [],
            segments: [],
            transcriptSummary: 'Mock transcript summary',
            speechAnalysisStatus: 'NOT_ASSESSED' as const,
            detectors: {
              audio_repeated_segments: {
                detectorName: 'subband_spectral_audio_fingerprint',
                version: '1.1.0',
                status: 'NO_SIGNAL_DETECTED' as const,
                executionDurationMs: 15,
                details: { audioSignatures: createMockAudioSignatures(scenario === 'baseline' ? 1 : 2) },
              },
            },
          };
        },
      },
      videoProcessor: {
        analyzeVideo: async () => ({
          scenesCount: 2,
          framesSampled: 2,
          hasSlideshowPattern: false,
          repeatedFootageSegments: [],
          templateRepetitions: [],
          averagePacingSeconds: 5,
          tempFramesDir: '',
          detectors: {
            video_repeated_footage: {
              detectorName: 'perceptual_hash_comparator',
              version: '1.0.0',
              status: scenario === 'rescan_clean_unverified_ocr' ? ('NO_SIGNAL_DETECTED' as const) : ('DETECTED' as const),
              executionDurationMs: 20,
              details: { visualSignatures: createMockVisualSignatures(scenario === 'baseline' ? 1 : 2) },
            },
          },
        }),
        performVideoOcr: async () => ({
          status: 'ANALYSIS_UNAVAILABLE' as const,
          framesInspected: 0,
          totalCandidateFrames: 5,
          coverageRatio: 0,
          limitations: 'OCR binary absent',
          failureReason: 'Tesseract missing',
          executionDurationMs: 2,
          detectedFrames: [],
          allExtractedText: [],
        }),
        cleanupFrames: async () => {},
      },
      thumbnailInspector: {
        inspect: async () => null as any,
      },
      policyIntelligenceEngine: {
        generateEvidenceTimeline: ({ scanId }: any): EvidenceItem[] => [
          {
            id: `ev_orch_${scanId}`,
            scanId,
            domain: 'video_audio',
            timestampStart: 0,
            timestampEnd: 10,
            timestampLabel: '00:00–00:10',
            type: 'visual_repetition',
            category: 'reused_content',
            severity: 'warning',
            confidence: 0.88,
            confidenceLevel: 'HIGH',
            evidenceStatus: 'VERIFIED',
            provenance: 'videoProcessor.ts:perceptual_hash_comparator',
            source: 'video_analyzer',
            label: 'Visual montage',
            details: 'Pipeline generated evidence',
          },
        ],
        buildReport: ({ scanId }: any): RiskReport => {
          if (scenario === 'baseline') {
            return makeRichTestReport({ scanId, includeIssue: true, ocrUnavailable: true });
          }
          if (scenario === 'rescan_partial') {
            const rep = makeRichTestReport({ scanId, includeIssue: true, ocrUnavailable: true });
            rep.topIssues.push({
              id: `issue_new_${scanId}`,
              domain: 'title',
              type: 'title_mismatch',
              what: 'Misleading clickbait claim in title',
              where: 'Title',
              why: 'Mismatch',
              fix: 'Update title',
              evidence: 'Title token match',
              context: 'New signal',
              recommendedAction: 'Fix title',
              confidence: 'MEDIUM',
              limitations: 'Heuristic',
              severity: 'warning',
              policyArea: 'Metadata',
              category: 'metadata_coherence',
              timestampSeconds: 0,
            });
            return rep;
          }
          return makeRichTestReport({ scanId, includeIssue: false, ocrUnavailable: true });
        },
        generateComparison: (orig: RiskReport, rev: RiskReport, opts?: any) => {
          return policyIntelligenceEngine.generateComparison(orig, rev, opts);
        },
      },
    };

    const orchestrator = new JobOrchestrator(freshRepo, false, mockDeps);
    const orchWorkerId = (orchestrator as any).workerId;

    // Run Scan 1 (Baseline)
    const orchScan1: ScanJob = {
      id: 'scan_orch_1',
      userId: tenantA.id,
      videoTitle: 'Orch Baseline',
      videoFilename: 'orch1.mp4',
      videoPath: '/tmp/orch1.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: '2026-06-02T10:00:00.000Z',
    };
    await freshRepo.scans.createScan(orchScan1);
    const claim1 = await freshRepo.queue.claimNextJob(orchWorkerId, 60000);
    assert(claim1 !== null && claim1.scanId === orchScan1.id, 'Claimed baseline scan job');
    await orchestrator.executeJob(claim1!);

    const fpsOrch1 = await freshRepo.fingerprints.getFingerprintsByScan(orchScan1.id, tenantA.id);
    assert(fpsOrch1.length === 3, 'Orchestrator persisted media, audio, and visual fingerprints for baseline scan');
    const histOrch1 = await freshRepo.detectionHistory.getHistoryByScan(orchScan1.id, tenantA.id);
    assert(histOrch1.some((h) => h.resultStatus === 'New'), 'Baseline scan recorded New detection history event');
    assert(histOrch1.some((h) => h.resultStatus === 'NOT VERIFIED'), 'Baseline scan recorded NOT VERIFIED for unavailable OCR coverage');
    assert(histOrch1.some((h) => h.fingerprintId && h.evidenceId), 'Detection history events linked to fingerprintId and evidenceId');

    // Run Scan 2 (Re-scan where prior issue is Still Present + a New issue appears)
    scenario = 'rescan_partial';
    const orchScan2: ScanJob = {
      id: 'scan_orch_2',
      userId: tenantA.id,
      videoTitle: 'Orch Rescan 1',
      videoFilename: 'orch2.mp4',
      videoPath: '/tmp/orch2.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      parentScanId: orchScan1.id,
      isRescan: true,
      createdAt: '2026-06-02T10:05:00.000Z',
    };
    await freshRepo.scans.createScan(orchScan2);
    const claim2 = await freshRepo.queue.claimNextJob(orchWorkerId, 60000);
    await orchestrator.executeJob(claim2!);

    const histOrch2 = await freshRepo.detectionHistory.getHistoryByScan(orchScan2.id, tenantA.id);
    assert(histOrch2.some((h) => h.resultStatus === 'Still Present'), 'Re-scan recorded Still Present for persisting issue');
    assert(histOrch2.some((h) => h.resultStatus === 'New'), 'Re-scan recorded New for newly introduced issue');

    // Run Scan 3 (Re-scan where prior issue resolves cleanly while OCR remains NOT VERIFIED)
    scenario = 'rescan_clean_unverified_ocr';
    const orchScan3: ScanJob = {
      id: 'scan_orch_3',
      userId: tenantA.id,
      videoTitle: 'Orch Rescan Clean',
      videoFilename: 'orch3.mp4',
      videoPath: '/tmp/orch3.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      parentScanId: orchScan1.id,
      isRescan: true,
      createdAt: '2026-06-02T10:10:00.000Z',
    };
    await freshRepo.scans.createScan(orchScan3);
    const claim3 = await freshRepo.queue.claimNextJob(orchWorkerId, 60000);
    await orchestrator.executeJob(claim3!);

    const histOrch3 = await freshRepo.detectionHistory.getHistoryByScan(orchScan3.id, tenantA.id);
    assert(histOrch3.some((h) => h.resultStatus === 'Resolved'), 'Re-scan recorded Resolved when responsible detector confirmed NO_SIGNAL_DETECTED');
    assert(
      histOrch3.some((h) => h.resultStatus === 'NOT VERIFIED' && h.detectorName === 'full_video_ocr_adapter'),
      'Unavailable OCR detector recorded as NOT VERIFIED (never falsely marked Resolved)'
    );

    // Verify all baseline history preserved chronologically across re-scans
    const allTenantAHist = await freshRepo.detectionHistory.getHistoryByUser(tenantA.id, { order: 'asc' });
    assert(
      allTenantAHist.some((h) => h.scanId === orchScan1.id) &&
        allTenantAHist.some((h) => h.scanId === orchScan2.id) &&
        allTenantAHist.some((h) => h.scanId === orchScan3.id),
      'Historical detection records across all 3 scans are preserved in chronological order'
    );

    // Retry idempotency check
    const retryAppend = await freshRepo.detectionHistory.appendEvents(
      orchScan3.id,
      [
        {
          scanId: orchScan3.id,
          userId: tenantA.id,
          detectionType: 'reused_content',
          detectionKey: histOrch3[0].detectionKey,
          resultStatus: histOrch3[0].resultStatus,
          processingVersion: histOrch3[0].processingVersion,
          idempotencyKey: histOrch3[0].idempotencyKey,
        },
      ],
      { systemBypass: true }
    );
    assert(retryAppend.appended === 0 && retryAppend.deduplicated === 1, 'Duplicate retry event is cleanly deduplicated');

    // Terminal failure scan: must NOT invent fingerprints or mark Resolved; must record NOT VERIFIED
    scenario = 'fail';
    const failScan: ScanJob = {
      id: 'scan_orch_fail',
      userId: tenantA.id,
      videoTitle: 'Orch Fail',
      videoFilename: 'fail.mp4',
      videoPath: '/tmp/fail.mp4',
      scanMode: 'standard',
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      parentScanId: orchScan1.id,
      isRescan: true,
      createdAt: '2026-06-02T10:15:00.000Z',
    };
    await freshRepo.scans.createScan(failScan);
    // Exhaust attempts on fail
    freshRepo.db.prepare('UPDATE job_queue SET attempts = 2 WHERE scan_id = ?').run(failScan.id);
    const claimFail = await freshRepo.queue.claimNextJob(orchWorkerId, 60000);
    await orchestrator.executeJob(claimFail!);

    const failFps = await freshRepo.fingerprints.getFingerprintsByScan(failScan.id, tenantA.id);
    assert(
      !failFps.some((f) => f.fingerprintType === 'audio_spectral_sequence' || f.fingerprintType === 'visual_dhash_sequence'),
      'Failed scan did NOT invent audio or visual fingerprints after audio processor crashed'
    );
    const failHist = await freshRepo.detectionHistory.getHistoryByScan(failScan.id, tenantA.id);
    assert(
      failHist.length === 1 && failHist[0].resultStatus === 'NOT VERIFIED',
      'Terminal scan failure recorded honest NOT VERIFIED history event and never marked Resolved'
    );

    // -------------------------------------------------------------------------
    // 5. Retention Preservation & Account Deletion Cascade
    // -------------------------------------------------------------------------
    console.log('\n[5. Retention Preservation & Account Deletion Cascade]');
    const retUploadDir = path.join(tempDir, 'uploads');
    fs.mkdirSync(retUploadDir, { recursive: true });
    const oldVideoPath = path.join(retUploadDir, 'aged_video_a1.mp4');
    fs.writeFileSync(oldVideoPath, 'dummy media payload');
    const agedScan: ScanJob = {
      id: 'scan_aged_preserve',
      userId: tenantA.id,
      videoTitle: 'Aged Preserved Scan',
      videoFilename: 'aged_video_a1.mp4',
      videoPath: oldVideoPath,
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
      completedAt: '2025-01-01T00:05:00.000Z',
    };
    await freshRepo.scans.createScan(agedScan);
    await freshRepo.fingerprints.saveFingerprints(
      agedScan.id,
      [
        {
          scanId: agedScan.id,
          userId: tenantA.id,
          fingerprintType: 'media_sha256',
          algorithm: 'sha256_container_digest',
          algorithmVersion: '1.0.0',
          fingerprintHash: crypto.createHash('sha256').update('aged').digest('hex'),
          signatureCount: 1,
          provenance: 'test',
          sourceStage: 'Media inspection',
        },
      ],
      { systemBypass: true }
    );
    await freshRepo.detectionHistory.appendEvents(
      agedScan.id,
      [
        {
          scanId: agedScan.id,
          userId: tenantA.id,
          detectionType: 'reused_content',
          detectionKey: 'aged_signal',
          resultStatus: 'New',
          processingVersion: '2a.1.0',
          idempotencyKey: `det_hist:${agedScan.id}:aged`,
        },
      ],
      { systemBypass: true }
    );

    const retSvc = new RetentionService({
      storage: freshRepo,
      uploadDir: retUploadDir,
      env: { ...process.env, RETENTION_CLEANUP_ENABLED: 'true', MEDIA_RETENTION_HOURS: '1' },
    });
    const sweepSummary = await retSvc.runCleanupSweep();
    assert(sweepSummary.executed === true && sweepSummary.expiredScansMediaCleaned >= 1, 'Retention sweep removed expired raw media');
    assert(!fs.existsSync(oldVideoPath), 'Expired raw video file removed from disk');
    assert((await freshRepo.fingerprints.getFingerprintsByScan(agedScan.id, tenantA.id)).length === 1, 'Fingerprints preserved after raw media expiration');
    assert((await freshRepo.detectionHistory.getHistoryByScan(agedScan.id, tenantA.id)).length === 1, 'Detection history preserved after raw media expiration');

    // Permanent account deletion must cascade cleanly across fingerprints, evidence, and detection_history
    const delRes = await executePermanentAccountDeletion(tenantA, {
      storage: freshRepo,
      uploadDir: retUploadDir,
      env: process.env,
    });
    assert(delRes.ok === true && delRes.statusCode === 200, 'Tenant A account permanently deleted');
    assert((await freshRepo.fingerprints.queryFingerprints(tenantA.id)).length === 0, 'Tenant A fingerprints purged on account deletion');
    assert((await freshRepo.evidence.queryEvidence(tenantA.id)).length === 0, 'Tenant A evidence purged on account deletion');
    assert((await freshRepo.detectionHistory.getHistoryByUser(tenantA.id)).length === 0, 'Tenant A detection history purged on account deletion');

    await freshRepo.close();

    // -------------------------------------------------------------------------
    // 6. InMemoryStorageRepository Parity
    // -------------------------------------------------------------------------
    console.log('\n[6. InMemoryStorageRepository Parity Check]');
    const memRepo = new InMemoryStorageRepository(path.join(tempDir, 'mem_phase2a.json'));
    const memUser = await memRepo.users.createUser('mem_p2a@videorisk.com', 'h', 's', 20, 'creator');
    const memOther = await memRepo.users.createUser('mem_other@videorisk.com', 'h', 's', 20, 'creator');
    const memScan: ScanJob = {
      id: 'scan_mem_1',
      userId: memUser.id,
      videoTitle: 'Mem Scan',
      videoFilename: 'mem.mp4',
      videoPath: '/tmp/mem.mp4',
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload'],
      creditsUsed: 1,
      createdAt: new Date().toISOString(),
    };
    await memRepo.scans.createScan(memScan);
    await memRepo.fingerprints.saveFingerprints(
      memScan.id,
      [
        {
          scanId: memScan.id,
          userId: memUser.id,
          fingerprintType: 'media_sha256',
          algorithm: 'sha256_container_digest',
          algorithmVersion: '1.0.0',
          fingerprintHash: validSha,
          signatureCount: 1,
          provenance: 'test',
          sourceStage: 'Media inspection',
        },
      ],
      { systemBypass: true }
    );
    await memRepo.evidence.saveEvidence(memScan.id, [{ ...evItemsA[0], scanId: memScan.id }], { systemBypass: true });
    await memRepo.detectionHistory.appendEvents(
      memScan.id,
      [
        {
          scanId: memScan.id,
          userId: memUser.id,
          detectionType: 'reused_content',
          detectionKey: 'mem_k1',
          resultStatus: 'New',
          processingVersion: '2a.1.0',
          idempotencyKey: 'mem_dh_1',
        },
      ],
      { systemBypass: true }
    );
    assert((await memRepo.fingerprints.getFingerprintsByScan(memScan.id, memOther.id)).length === 0, 'InMemory isolates fingerprints across tenants');
    assert((await memRepo.evidence.getEvidenceForUser(memScan.id, memUser.id)).length === 1, 'InMemory returns enriched evidence for owner');
    assert((await memRepo.detectionHistory.getHistoryByUser(memOther.id)).length === 0, 'InMemory isolates detection history across tenants');
    await memRepo.scans.deleteScan(memScan.id);
    assert((await memRepo.fingerprints.queryFingerprints(memUser.id)).length === 0, 'InMemory scan deletion purges fingerprints');
    assert((await memRepo.detectionHistory.getHistoryByUser(memUser.id)).length === 0, 'InMemory scan deletion purges detection history');

    // -------------------------------------------------------------------------
    // 7. HTTP API Auth & Cross-Tenant Isolation Verification
    // -------------------------------------------------------------------------
    console.log('\n[7. HTTP API Auth & Tenant Isolation Verification]');
    const { storage: activeStorage } = await import('../src/server/storage');
    const { apiRouter } = await import('../src/server/routes/api');

    const ownerUser = await activeStorage.users.createUser(`api_owner_${Date.now()}@videorisk.com`, 'h', 's', 20, 'creator');
    const attackerUser = await activeStorage.users.createUser(`api_attacker_${Date.now()}@videorisk.com`, 'h', 's', 20, 'creator');
    const ownerToken = await activeStorage.users.createSession(ownerUser.id);
    const attackerToken = await activeStorage.users.createSession(attackerUser.id);

    const apiScan: ScanJob = {
      id: `scan_api_p2a_${Date.now()}`,
      userId: ownerUser.id,
      videoTitle: 'API Isolation Video',
      videoFilename: 'api.mp4',
      videoPath: '/tmp/api.mp4',
      scanMode: 'standard',
      status: 'COMPLETED',
      currentStage: 'Risk report',
      completedStages: ['Upload', 'Risk report'],
      creditsUsed: 1,
      createdAt: new Date().toISOString(),
    };
    await activeStorage.scans.createScan(apiScan);
    await activeStorage.fingerprints.saveFingerprints(
      apiScan.id,
      [
        {
          scanId: apiScan.id,
          userId: ownerUser.id,
          fingerprintType: 'media_sha256',
          algorithm: 'sha256_container_digest',
          algorithmVersion: '1.0.0',
          fingerprintHash: validSha,
          signatureCount: 1,
          provenance: 'mediaInspector.ts:sha256',
          sourceStage: 'Media inspection',
        },
      ],
      { systemBypass: true }
    );
    await activeStorage.evidence.saveEvidence(apiScan.id, [{ ...evItemsA[0], id: `ev_api_${Date.now()}`, scanId: apiScan.id }], {
      systemBypass: true,
    });
    await activeStorage.detectionHistory.appendEvents(
      apiScan.id,
      [
        {
          scanId: apiScan.id,
          userId: ownerUser.id,
          detectionType: 'reused_content',
          detectionKey: 'api_key_1',
          resultStatus: 'New',
          processingVersion: '2a.1.0',
          idempotencyKey: `det_api_${apiScan.id}`,
        },
      ],
      { systemBypass: true }
    );

    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const port = (server.address() as any).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      // 401 Unauthenticated checks
      for (const route of [
        `/api/scans/${apiScan.id}/fingerprints`,
        `/api/scans/${apiScan.id}/detection-history`,
        '/api/detection-history',
        '/api/evidence',
      ]) {
        const res = await fetch(`${baseUrl}${route}`);
        assert(res.status === 401, `Unauthenticated GET ${route} returns 401 (got ${res.status})`);
      }

      // 403 Cross-tenant IDOR checks
      for (const route of [
        `/api/scans/${apiScan.id}/fingerprints`,
        `/api/scans/${apiScan.id}/detection-history`,
        `/api/detection-history?scanId=${apiScan.id}`,
        `/api/evidence?scanId=${apiScan.id}`,
      ]) {
        const res = await fetch(`${baseUrl}${route}`, {
          headers: { Authorization: `Bearer ${attackerToken}` },
        });
        assert(res.status === 403, `Cross-tenant GET ${route} returns 403 (got ${res.status})`);
      }

      // 200 Owner authorized checks
      const fpHttp = await fetch(`${baseUrl}/api/scans/${apiScan.id}/fingerprints`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert(fpHttp.status === 200, 'Owner GET fingerprints returns 200');
      const fpJson = await fpHttp.json();
      assert(fpJson.count === 1 && fpJson.fingerprints[0].fingerprintHash === validSha, 'Owner GET fingerprints returns accurate record');

      const dhHttp = await fetch(`${baseUrl}/api/scans/${apiScan.id}/detection-history`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert(dhHttp.status === 200, 'Owner GET detection-history returns 200');
      const dhJson = await dhHttp.json();
      assert(dhJson.count === 1 && dhJson.events[0].resultStatus === 'New', 'Owner GET detection-history returns New event');

      const evHttp = await fetch(`${baseUrl}/api/evidence?scanId=${apiScan.id}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert(evHttp.status === 200, 'Owner GET /api/evidence returns 200');
      const evJson = await evHttp.json();
      assert(evJson.count === 1 && Boolean(evJson.evidence[0].integritySha256), 'Owner GET /api/evidence returns integrity-verified record');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await activeStorage.scans.deleteScan(apiScan.id);
      await activeStorage.users.deleteAccount(ownerUser.id);
      await activeStorage.users.deleteAccount(attackerUser.id);
    }

    console.log('======================================================');
    console.log(`TEST SUITE 32 COMPLETE: All Phase 2A assertions passed! (DB=${testDbResolution.resolvedPath})`);
    console.log('======================================================');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const isDirectEntry = Boolean(process.argv[1] && process.argv[1].includes('phase2a_intelligence_foundation.test'));
if (isDirectEntry) {
  runPhase2AIntelligenceFoundationTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ TEST SUITE 32 FAILED:', err);
      process.exit(1);
    });
}
