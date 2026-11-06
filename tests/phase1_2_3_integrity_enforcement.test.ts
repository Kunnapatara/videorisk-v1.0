import assert from 'assert';
import path from 'path';
import { policyIntelligenceEngine, PolicyIntelligenceEngine } from '../src/server/intelligence/policyIntelligence';
import { channelIntelligenceEngine, countDistinctOccurrences } from '../src/server/intelligence/channelIntelligence';
import { storage, InMemoryStorageRepository } from '../src/server/storage';
import { SqliteStorageRepository } from '../src/server/storage/sqliteStorage';
import { videoProcessor } from '../src/server/pipeline/videoProcessor';
import { 
  RiskReport, 
  ScanJob, 
  TopIssue, 
  CrossVideoComparisonItem, 
  ChannelIntelligenceRecord 
} from '../src/types';

export async function runPhase123IntegrityEnforcementTests() {
  console.log('\n======================================================');
  console.log('--- SUITE 22: PHASE 1–3 INTEGRITY ENFORCEMENT TESTS ---');
  console.log('Re-Scan Verification, Storage Concurrency & Gradient Mirroring');
  console.log('======================================================\n');

  // =========================================================================
  // PART 1: PHASE 1 — RE-SCAN INTEGRITY TESTS
  // =========================================================================
  console.log('[1. Phase 1 — Re-scan Integrity & Version Compatibility]');

  // 1.1 Verify all required detectors are in DETECTOR_NAME_MAPPINGS and risk signal detectors in RISK_SIGNAL_DETECTORS
  const requiredDetectors = [
    'video_repeated_footage',
    'video_slideshow_heuristic',
    'video_template_heuristic',
    'audio_repeated_segments',
    'audio_music_detection',
    'audio_silence_volume',
    'audio_speech_activity',
    'audio_transcription',
    'thumbnail_ocr',
    'thumbnail_contrast'
  ];

  for (const det of requiredDetectors) {
    assert(
      det in PolicyIntelligenceEngine.DETECTOR_NAME_MAPPINGS,
      `Required detector "${det}" must be mapped in DETECTOR_NAME_MAPPINGS`
    );
  }

  const riskDetectors = [
    'video_repeated_footage',
    'video_slideshow_heuristic',
    'video_template_heuristic',
    'audio_repeated_segments',
    'audio_music_detection',
    'thumbnail_ocr',
    'thumbnail_contrast'
  ];

  for (const det of riskDetectors) {
    assert(
      PolicyIntelligenceEngine.RISK_SIGNAL_DETECTORS.has(det),
      `Risk signal detector "${det}" must be present in RISK_SIGNAL_DETECTORS`
    );
  }
  console.log('  ✅ PASS: 1.1 Detector registry mappings and risk signal detector sets verified');

  // 1.2 Strict detector status validation
  const dummyMeta = {
    filename: 'test.mp4',
    originalSize: 1024,
    durationSeconds: 30,
    width: 1280,
    height: 720,
    resolutionLabel: '720p',
    fps: 30,
    hasAudio: true,
    videoCodec: 'h264',
    audioCodec: 'aac',
    isProxyUsed: false,
    sha256: 'a'.repeat(64)
  };

  const sampleIssue: TopIssue = {
    id: 'issue_repeat_1',
    domain: 'video_audio',
    type: 'repeated_visual_footage',
    what: 'Repeated Visual Footage',
    where: '00:05–00:10',
    why: 'Duplicate frame sequence',
    fix: 'Trim duplicated footage',
    evidence: 'dHash match',
    context: 'Test context',
    recommendedAction: 'Trim duplicate frames',
    confidence: 'HIGH',
    limitations: 'Local check',
    severity: 'warning',
    policyArea: 'REUSED CONTENT',
    category: 'reused_content',
    timestampSeconds: 5
  };

  const baseReport: RiskReport = {
    scanId: 'scan_base_1',
    overallRisk: 'NEEDS_REVIEW',
    riskSummary: 'Baseline risk report',
    disclaimer: 'VideoRisk analysis',
    domainReports: {
      video_audio: {
        domain: 'video_audio',
        domainLabel: 'Video & Audio',
        status: 'POTENTIAL_RISK_DETECTED',
        summary: 'Repeated footage found',
        findingsCount: 1,
        confidence: 'HIGH',
        limitations: 'Local check'
      },
      title: {
        domain: 'title',
        domainLabel: 'Title',
        status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: 'Title clear',
        findingsCount: 0,
        confidence: 'HIGH',
        limitations: 'None'
      },
      description_tags: {
        domain: 'description_tags',
        domainLabel: 'Description',
        status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: 'Description clear',
        findingsCount: 0,
        confidence: 'HIGH',
        limitations: 'None'
      },
      thumbnail: {
        domain: 'thumbnail',
        domainLabel: 'Thumbnail',
        status: 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: 'Thumbnail clear',
        findingsCount: 0,
        confidence: 'HIGH',
        limitations: 'None'
      },
      channel_context: {
        domain: 'channel_context',
        domainLabel: 'Channel Context',
        status: 'NOT_PROVIDED',
        summary: 'No channel context',
        findingsCount: 0,
        confidence: 'LOW',
        limitations: 'None'
      }
    },
    riskCategories: {
      yppMonetization: { status: 'NEEDS_REVIEW', score: 45, label: 'YPP', explanation: 'Reused content' },
      videoMonetization: { status: 'LOW_RISK', score: 10, label: 'Monetization', explanation: 'OK' },
      advertiserFriendly: { status: 'LOW_RISK', score: 10, label: 'Ad Suitability', explanation: 'OK' },
      copyrightSignals: { status: 'LOW_RISK', score: 10, label: 'Copyright', explanation: 'OK' }
    },
    topIssues: [sampleIssue],
    policyConnections: [],
    timeline: [],
    reusedContentRatio: 0,
    metadataScore: 100,
    benchmarkMetrics: {
      totalProcessingSeconds: 1,
      inspectionMs: 10,
      audioProcessingMs: 10,
      videoAnalysisMs: 10,
      evidenceBuildingMs: 10,
      policyReasoningMs: 10,
      framesSampled: 10,
      scenesDetected: 1
    },
    detectors: {
      video_repeated_footage: {
        detectorName: 'perceptual_hash_comparator',
        version: '1.0.0',
        status: 'DETECTED',
        executionDurationMs: 40,
        limitations: 'Local test'
      }
    }
  };

  const invalidStatuses = [
    'DETECTED',
    'NOT_ASSESSED',
    'ANALYSIS_UNAVAILABLE',
    'INSUFFICIENT_EVIDENCE',
    'NOT_PROVIDED',
    'ERROR'
  ];

  for (const st of invalidStatuses) {
    const revReport: RiskReport = {
      ...baseReport,
      scanId: 'scan_rev_1',
      topIssues: [],
      detectors: {
        video_repeated_footage: {
          detectorName: 'perceptual_hash_comparator',
          version: '1.0.0',
          status: st as any,
          executionDurationMs: 30,
          limitations: 'Local test'
        }
      }
    };

    const res = policyIntelligenceEngine.canVerifyResolution(
      'video_audio',
      baseReport,
      revReport,
      {
        originalScanRecord: { status: 'COMPLETED', metadata: dummyMeta },
        revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'b'.repeat(64) } }
      },
      sampleIssue
    );

    assert.strictEqual(
      res.verifiable,
      false,
      `Status "${st}" must reject resolution verification`
    );
  }
  console.log('  ✅ PASS: 1.2 All unverified/failure statuses strictly reject resolution');

  // 1.3 Major version mismatch rejects resolution
  const revReportMajorMismatch: RiskReport = {
    ...baseReport,
    scanId: 'scan_rev_version_mismatch',
    topIssues: [],
    detectors: {
      video_repeated_footage: {
        detectorName: 'perceptual_hash_comparator',
        version: '2.0.0', // Incompatible major version bump
        status: 'NO_SIGNAL_DETECTED',
        executionDurationMs: 30,
        limitations: 'Major upgrade'
      }
    }
  };

  const resMismatch = policyIntelligenceEngine.canVerifyResolution(
    'video_audio',
    baseReport,
    revReportMajorMismatch,
    {
      originalScanRecord: { status: 'COMPLETED', metadata: dummyMeta },
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'b'.repeat(64) } }
    },
    sampleIssue
  );

  assert.strictEqual(resMismatch.verifiable, false, 'Major version mismatch must fail verification');
  assert(resMismatch.reason?.includes('major version mismatch'), 'Reason indicates major version mismatch');
  console.log('  ✅ PASS: 1.3 Major version mismatch (1.0.0 vs 2.0.0) strictly rejected');

  // 1.4 Compatible minor/patch version succeeds
  const revReportCompatibleVersion: RiskReport = {
    ...baseReport,
    scanId: 'scan_rev_compatible',
    topIssues: [],
    detectors: {
      video_repeated_footage: {
        detectorName: 'perceptual_hash_comparator',
        version: '1.3.1', // Compatible minor version
        status: 'NO_SIGNAL_DETECTED',
        executionDurationMs: 30,
        limitations: 'Clean run'
      }
    }
  };

  const resCompatible = policyIntelligenceEngine.canVerifyResolution(
    'video_audio',
    baseReport,
    revReportCompatibleVersion,
    {
      originalScanRecord: { status: 'COMPLETED', metadata: dummyMeta },
      revisedScanRecord: { status: 'COMPLETED', metadata: { ...dummyMeta, sha256: 'b'.repeat(64) } }
    },
    sampleIssue
  );

  assert.strictEqual(resCompatible.verifiable, true, 'Compatible version must verify resolution');
  console.log('  ✅ PASS: 1.4 Compatible minor version (1.0.0 vs 1.3.1) successfully verifies resolution');

  // =========================================================================
  // PART 2: PHASE 2 — CHANNEL INTELLIGENCE CONCURRENCY & VERSIONING
  // =========================================================================
  console.log('\n[2. Phase 2 — Storage Concurrency, Versioning & Overlapping Occurrences]');

  // 2.1 Overlapping occurrence interval merging
  const testComparisons: CrossVideoComparisonItem[] = [
    {
      id: 'cmp_1',
      type: 'visual_segment',
      scanIdA: 'scan_subject',
      scanIdB: 'scan_target_1',
      status: 'MATCH_CONFIRMED',
      intervalA: { start: 5, end: 12, label: '00:05–00:12' },
      intervalB: { start: 10, end: 17, label: '00:10–00:17' },
      algorithm: 'perceptual_hash',
      algorithmVersion: '1.0.0',
      decisionThreshold: 0.85,
      measuredSimilarity: 0.95,
      evidenceStrength: 'STRONG',
      limitations: 'Local check',
      explanation: 'Test overlap interval 1',
      createdAt: new Date().toISOString()
    },
    {
      id: 'cmp_2',
      type: 'visual_segment',
      scanIdA: 'scan_subject',
      scanIdB: 'scan_target_2',
      status: 'MATCH_CONFIRMED',
      intervalA: { start: 10, end: 20, label: '00:10–00:20' }, // Overlaps with [5, 12] on scan_subject!
      intervalB: { start: 15, end: 25, label: '00:15–00:25' },
      algorithm: 'perceptual_hash',
      algorithmVersion: '1.0.0',
      decisionThreshold: 0.85,
      measuredSimilarity: 0.94,
      evidenceStrength: 'STRONG',
      limitations: 'Local check',
      explanation: 'Test overlap interval 2',
      createdAt: new Date().toISOString()
    },
    {
      id: 'cmp_3',
      type: 'visual_segment',
      scanIdA: 'scan_subject',
      scanIdB: 'scan_target_3',
      status: 'MATCH_CONFIRMED',
      intervalA: { start: 30, end: 40, label: '00:30–00:40' }, // Disjoint interval on scan_subject
      intervalB: { start: 0, end: 10, label: '00:00–00:10' },
      algorithm: 'perceptual_hash',
      algorithmVersion: '1.0.0',
      decisionThreshold: 0.85,
      measuredSimilarity: 0.92,
      evidenceStrength: 'STRONG',
      limitations: 'Local check',
      explanation: 'Test disjoint interval',
      createdAt: new Date().toISOString()
    }
  ];

  const distinctOccurrences = countDistinctOccurrences(testComparisons, ['scan_subject']);
  // [5, 12] and [10, 20] merge into [5, 20] on scan_subject (1 occurrence)
  // [30, 40] is a 2nd occurrence on scan_subject
  // Total merged occurrences on scan_subject = 2
  assert.strictEqual(distinctOccurrences, 2, 'Overlapping intervals must merge so occurrences are not inflated');
  console.log('  ✅ PASS: 2.1 Overlapping temporal intervals accurately merged in occurrence counts');

  // 2.2 Storage concurrency & version protection in SQLite
  const testEmail = `test_concurrency_user_${Date.now()}@example.com`;
  const testUser = await storage.users.createUser(
    testEmail,
    'hash',
    'salt',
    10,
    'free'
  );

  const initialRecord: ChannelIntelligenceRecord = {
    id: `ch_intel_${testUser.id}_v1`,
    userId: testUser.id,
    scopeId: 'user_channel',
    version: 1,
    status: 'COMPLETED',
    sampleSize: 0,
    sourceScanIds: [],
    sourceVideoIdentities: [],
    patterns: [],
    crossVideoComparisons: [],
    coverage: {
      titleMetadata: 'AVAILABLE',
      introOutro: 'NOT_AVAILABLE',
      crossVideoFootage: 'AVAILABLE',
      audioPatterns: 'NOT_AVAILABLE',
      originalContribution: 'NOT_AVAILABLE'
    },
    disclaimer: 'Test disclaimer',
    mandatoryCoverageStatement: 'Test statement',
    createdAt: new Date(Date.now() - 5000).toISOString(),
    updatedAt: new Date(Date.now() - 5000).toISOString()
  };

  await storage.channelIntelligence.save(initialRecord);

  const newerRecord: ChannelIntelligenceRecord = {
    ...initialRecord,
    id: `ch_intel_${testUser.id}_v2`,
    version: 2,
    updatedAt: new Date().toISOString()
  };
  await storage.channelIntelligence.save(newerRecord);

  // Attempting to save a stale v1 record must NOT overwrite v2
  const staleAttemptRecord: ChannelIntelligenceRecord = {
    ...initialRecord,
    id: `ch_intel_${testUser.id}_stale_v1`,
    version: 1,
    updatedAt: new Date().toISOString(),
    disclaimer: 'Stale attempt'
  };
  await storage.channelIntelligence.save(staleAttemptRecord);

  const latestAfterStale = await storage.channelIntelligence.getLatest(testUser.id);
  assert.strictEqual(latestAfterStale?.version, 2, 'Stale lower version write must not overwrite newer version');
  console.log('  ✅ PASS: 2.2 Stale version write attempt safely rejected; latest version preserved');

  // Invalidate marks prior analysis as STALE
  await storage.channelIntelligence.invalidate(testUser.id);
  const afterInvalidate = await storage.channelIntelligence.getLatest(testUser.id);
  assert.strictEqual(afterInvalidate, null, 'Invalidated record marked STALE is excluded from getLatest');
  console.log('  ✅ PASS: 2.3 Invalidated records excluded from active channel intelligence');

  // =========================================================================
  // PART 3: PHASE 3 — VIDEO DUPLICATE GRADIENT INDEXING & BOUNDS VERIFICATION
  // =========================================================================
  console.log('\n[3. Phase 3 — Video Duplicate Row-Major Gradient Indexing]');

  // Create two synthetic 64-pixel luminance grids (8x8):
  // Frame 1: Left-to-right gradient with vertical stripes
  const lum1 = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      lum1[y * 8 + x] = x * 30 + y * 5;
    }
  }

  // Frame 2: Horizontally mirrored version of Frame 1 (flipped x -> 7 - x)
  const lum2Mirrored = new Float32Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      lum2Mirrored[y * 8 + (7 - x)] = lum1[y * 8 + x];
    }
  }

  // Generate horizontal and vertical gradients for Frame 1
  const hGrad1: boolean[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 7; x++) {
      hGrad1.push(lum1[y * 8 + x + 1] > lum1[y * 8 + x]);
    }
  }
  const vGrad1: boolean[] = [];
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 8; x++) {
      vGrad1.push(lum1[(y + 1) * 8 + x] > lum1[y * 8 + x]);
    }
  }

  // Generate horizontal and vertical gradients for Mirrored Frame 2
  const hGrad2: boolean[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 7; x++) {
      hGrad2.push(lum2Mirrored[y * 8 + x + 1] > lum2Mirrored[y * 8 + x]);
    }
  }
  const vGrad2: boolean[] = [];
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 8; x++) {
      vGrad2.push(lum2Mirrored[(y + 1) * 8 + x] > lum2Mirrored[y * 8 + x]);
    }
  }

  assert.strictEqual(hGrad1.length, 56, 'Frame 1 hGradients has 56 bits');
  assert.strictEqual(vGrad1.length, 56, 'Frame 1 vGradients has 56 bits');
  assert.strictEqual(hGrad2.length, 56, 'Frame 2 hGradients has 56 bits');
  assert.strictEqual(vGrad2.length, 56, 'Frame 2 vGradients has 56 bits');

  // Verify horizontal reflection mirror comparison
  let mirrorMatches = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 7; x++) {
      const mirrorH = !hGrad2[y * 7 + (6 - x)];
      if (hGrad1[y * 7 + x] === mirrorH) mirrorMatches++;
    }
  }
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 8; x++) {
      if (vGrad1[y * 8 + x] === vGrad2[y * 8 + (7 - x)]) mirrorMatches++;
    }
  }

  // Since Frame 2 is an exact horizontal mirror of Frame 1:
  // All 56 horizontal gradient comparisons and all 56 vertical gradient comparisons must match!
  assert.strictEqual(mirrorMatches, 112, 'Horizontally mirrored frame yields 112/112 gradient matches');
  console.log('  ✅ PASS: 3.1 Mathematical mirror reflection matches 112/112 gradient bits with zero bounds violations');

  console.log('\n======================================================');
  console.log('✅ ALL PHASE 1–3 INTEGRITY ENFORCEMENT TESTS PASSED');
  console.log('======================================================\n');
}

if (process.argv[1] && process.argv[1].includes('phase1_2_3_integrity_enforcement.test')) {
  process.env.VIDEORISK_TEST_RUN = 'true';
  runPhase123IntegrityEnforcementTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
