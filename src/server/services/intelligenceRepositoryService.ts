import crypto from 'crypto';
import {
  DetectionHistoryInput,
  DetectionHistoryStatus,
  DetectorReport,
  EvidenceItem,
  FingerprintInput,
  FingerprintRecord,
  MediaMetadata,
  PersistedEvidenceRecord,
  ReScanComparison,
  RiskReport,
  ScanJob,
  StoredAudioSignature,
  StoredVisualSignature,
} from '../../types';
import { AudioAnalysisResult } from '../pipeline/audioProcessor';
import { VideoAnalysisResult } from '../pipeline/videoProcessor';
import { policyIntelligenceEngine } from '../intelligence/policyIntelligence';

export const PIPELINE_DETECTION_PROCESSING_VERSION = '2a.1.0';

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableSerialize(obj[k])}`)
    .join(',')}}`;
}

export function computeSha256Hex(value: unknown): string {
  const serialized = typeof value === 'string' ? value : stableSerialize(value);
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export function computeEvidenceIntegritySha256(item: EvidenceItem): string {
  const canonicalPayload = {
    id: item.id,
    scanId: item.scanId,
    domain: item.domain,
    timestampStart: Number.isFinite(item.timestampStart) ? item.timestampStart : 0,
    timestampEnd: Number.isFinite(item.timestampEnd) ? item.timestampEnd : 0,
    timestampLabel: item.timestampLabel || '',
    type: item.type || '',
    category: item.category || '',
    severity: item.severity || 'info',
    confidence: item.confidence === undefined ? null : item.confidence,
    confidenceLevel: item.confidenceLevel || 'UNKNOWN',
    uncertaintyReason: item.uncertaintyReason || 'NONE',
    evidenceStatus: item.evidenceStatus || 'OBSERVED',
    provenance: item.provenance || '',
    source: item.source || '',
    label: item.label || '',
    details: item.details || '',
  };
  return computeSha256Hex(canonicalPayload);
}

export function verifyEvidenceIntegrity(record: PersistedEvidenceRecord): boolean {
  if (!record || !record.integritySha256) return false;
  return computeEvidenceIntegritySha256(record) === record.integritySha256;
}

export function deriveEvidenceStage(item: EvidenceItem): string {
  const source = (item.source || '').toLowerCase();
  const prov = (item.provenance || '').toLowerCase();
  if (prov.includes('ffprobe') || source.includes('mediainfo')) {
    return 'Media inspection';
  }
  if (prov.includes('whisper') || prov.includes('audio') || source.includes('audio')) {
    return 'Audio & transcript';
  }
  if (
    prov.includes('video') ||
    prov.includes('tesseract') ||
    prov.includes('perceptual_hash') ||
    prov.includes('ocr') ||
    source.includes('video')
  ) {
    return 'Scene analysis';
  }
  if (item.domain === 'thumbnail' || source.includes('thumbnail')) {
    return 'Visual evidence';
  }
  return 'Visual evidence';
}

export function extractMediaSha256Fingerprint(
  scan: Pick<ScanJob, 'id' | 'userId'>,
  metadata?: MediaMetadata | null
): FingerprintInput | null {
  const rawSha = typeof metadata?.sha256 === 'string' ? metadata.sha256.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(rawSha)) {
    return null;
  }

  return {
    scanId: scan.id,
    userId: scan.userId,
    fingerprintType: 'media_sha256',
    algorithm: 'sha256_container_digest',
    algorithmVersion: '1.0.0',
    fingerprintHash: rawSha,
    signatureCount: 1,
    payload: { sha256: rawSha },
    provenance: 'mediaInspector.ts:sha256',
    sourceStage: 'Media inspection',
  };
}

export function extractAudioSpectralFingerprint(
  scan: Pick<ScanJob, 'id' | 'userId'>,
  audioResult?: AudioAnalysisResult | null
): FingerprintInput | null {
  if (!audioResult) return null;
  const detector: DetectorReport | undefined = audioResult.detectors?.audio_repeated_segments;
  if (!detector) return null;
  if (detector.status === 'ANALYSIS_UNAVAILABLE' || detector.status === 'NOT_ASSESSED' || detector.status === 'NOT_PROVIDED') {
    return null;
  }

  const rawSigs = detector.details?.audioSignatures;
  if (!Array.isArray(rawSigs) || rawSigs.length === 0) {
    return null;
  }

  const normalizedSigs: StoredAudioSignature[] = rawSigs
    .filter((s: any) => s && Array.isArray(s.spectralProfile) && s.spectralProfile.length > 0)
    .map((s: any) => ({
      sec: Number(s.sec || 0),
      duration: Number(s.duration || 0),
      rms: Number(s.rms || 0),
      zcr: Number(s.zcr || 0),
      spectralProfile: s.spectralProfile.map((v: any) => Number(v || 0)),
    }));

  if (normalizedSigs.length === 0) {
    return null;
  }

  const algorithm = detector.detectorName || 'subband_spectral_audio_fingerprint';
  const algorithmVersion = detector.version || '1.1.0';
  const fingerprintHash = computeSha256Hex({
    type: 'audio_spectral_sequence',
    algorithm,
    algorithmVersion,
    signatures: normalizedSigs,
  });

  return {
    scanId: scan.id,
    userId: scan.userId,
    fingerprintType: 'audio_spectral_sequence',
    algorithm,
    algorithmVersion,
    fingerprintHash,
    signatureCount: normalizedSigs.length,
    payload: normalizedSigs,
    provenance: detector.provenance
      ? `${detector.provenance.sourceFile || 'audioProcessor.ts'}:${detector.provenance.method || algorithm}`
      : `audioProcessor.ts:${algorithm}`,
    sourceStage: 'Audio & transcript',
  };
}

export function extractVisualDhashFingerprint(
  scan: Pick<ScanJob, 'id' | 'userId'>,
  videoResult?: VideoAnalysisResult | null
): FingerprintInput | null {
  if (!videoResult) return null;
  const detector: DetectorReport | undefined = videoResult.detectors?.video_repeated_footage;
  if (!detector) return null;
  if (detector.status === 'ANALYSIS_UNAVAILABLE' || detector.status === 'NOT_ASSESSED' || detector.status === 'NOT_PROVIDED') {
    return null;
  }

  const rawSigs = detector.details?.visualSignatures;
  if (!Array.isArray(rawSigs) || rawSigs.length === 0) {
    return null;
  }

  const normalizedSigs: StoredVisualSignature[] = rawSigs
    .filter((s: any) => s && typeof s.hGrad === 'string' && typeof s.vGrad === 'string')
    .map((s: any) => ({
      timestamp: Number(s.timestamp || 0),
      hGrad: String(s.hGrad),
      vGrad: String(s.vGrad),
      meanY: Number(s.meanY || 0),
      stdDevY: Number(s.stdDevY || 0),
      meanR: Number(s.meanR || 0),
      meanG: Number(s.meanG || 0),
      meanB: Number(s.meanB || 0),
    }));

  if (normalizedSigs.length === 0) {
    return null;
  }

  const algorithm = detector.detectorName || 'perceptual_hash_comparator';
  const algorithmVersion = detector.version || '1.0.0';
  const fingerprintHash = computeSha256Hex({
    type: 'visual_dhash_sequence',
    algorithm,
    algorithmVersion,
    signatures: normalizedSigs,
  });

  return {
    scanId: scan.id,
    userId: scan.userId,
    fingerprintType: 'visual_dhash_sequence',
    algorithm,
    algorithmVersion,
    fingerprintHash,
    signatureCount: normalizedSigs.length,
    payload: normalizedSigs,
    provenance: detector.provenance
      ? `${detector.provenance.sourceFile || 'videoProcessor.ts'}:${detector.provenance.method || algorithm}`
      : `videoProcessor.ts:${algorithm}`,
    sourceStage: 'Scene analysis',
  };
}

function makeShortKeyHash(raw: string): string {
  return crypto.createHash('sha256').update(raw.trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

function normalizeDetectionKey(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return `${cleaned || 'signal'}_${makeShortKeyHash(raw).slice(0, 8)}`;
}

function pickFingerprintForDomain(
  domain: string,
  fingerprints: FingerprintRecord[]
): string | null {
  if (!fingerprints || fingerprints.length === 0) return null;
  if (domain === 'video_audio') {
    const visual = fingerprints.find((f) => f.fingerprintType === 'visual_dhash_sequence');
    if (visual) return visual.id;
    const audio = fingerprints.find((f) => f.fingerprintType === 'audio_spectral_sequence');
    if (audio) return audio.id;
  }
  const media = fingerprints.find((f) => f.fingerprintType === 'media_sha256');
  return media ? media.id : fingerprints[0].id;
}

function pickEvidenceIdsForIssue(
  domain: string,
  category: string,
  evidence: EvidenceItem[]
): string[] {
  const matched = evidence
    .filter((ev) => ev.domain === domain && (!category || ev.category === category))
    .map((ev) => ev.id);
  if (matched.length > 0) return matched;
  return evidence.filter((ev) => ev.domain === domain).map((ev) => ev.id);
}

export function buildDetectionHistoryEventsForScan(params: {
  scan: ScanJob;
  report: RiskReport;
  evidence: EvidenceItem[];
  fingerprints: FingerprintRecord[];
  comparison?: ReScanComparison | null;
  parentReport?: RiskReport | null;
  parentScan?: ScanJob | null;
}): DetectionHistoryInput[] {
  const { scan, report, evidence, fingerprints, comparison, parentReport, parentScan } = params;
  const detectedAt = scan.completedAt || new Date().toISOString();
  const events: DetectionHistoryInput[] = [];
  const defaultFingerprintId = pickFingerprintForDomain('video_audio', fingerprints);

  const detectorVersions = Object.entries(report.detectors || {})
    .map(([k, v]) => `${k}:${v?.version || 'unknown'}`)
    .sort()
    .join(',');
  const processingVersion = detectorVersions
    ? `${PIPELINE_DETECTION_PROCESSING_VERSION}|${detectorVersions}`
    : PIPELINE_DETECTION_PROCESSING_VERSION;

  const emitNotVerifiedCoverageEvents = () => {
    for (const [domainKey, domReport] of Object.entries(report.domainReports || {})) {
      if (
        domReport.status === 'ANALYSIS_UNAVAILABLE' ||
        domReport.status === 'INSUFFICIENT_EVIDENCE' ||
        domReport.status === 'NOT_ASSESSED'
      ) {
        const detectionKey = `coverage_${domainKey}`;
        const domEvidence = pickEvidenceIdsForIssue(domainKey, '', evidence);
        events.push({
          scanId: scan.id,
          userId: scan.userId,
          parentScanId: scan.parentScanId || null,
          comparisonScanId: comparison ? comparison.originalScanId : null,
          fingerprintId: pickFingerprintForDomain(domainKey, fingerprints),
          evidenceId: domEvidence[0] || null,
          evidenceIds: domEvidence,
          detectionType: 'verification_coverage',
          detectionKey,
          detectorName: domainKey,
          detectorStatus: domReport.status,
          resultStatus: 'NOT VERIFIED',
          processingVersion,
          verificationReason: `${domReport.domainLabel}: ${domReport.status} — ${domReport.limitations || domReport.summary}`,
          idempotencyKey: `det_hist:${scan.id}:coverage:${domainKey}`,
          details: {
            domain: domainKey,
            domainStatus: domReport.status,
            summary: domReport.summary,
          },
          detectedAt,
        });
      }
    }

    for (const [detKey, detRep] of Object.entries(report.detectors || {})) {
      if (
        detRep &&
        (detRep.status === 'ANALYSIS_UNAVAILABLE' ||
          detRep.status === 'INSUFFICIENT_EVIDENCE' ||
          detRep.status === 'NOT_ASSESSED')
      ) {
        const detectionKey = `detector_${detKey}`;
        events.push({
          scanId: scan.id,
          userId: scan.userId,
          parentScanId: scan.parentScanId || null,
          comparisonScanId: comparison ? comparison.originalScanId : null,
          fingerprintId: defaultFingerprintId,
          evidenceId: null,
          evidenceIds: [],
          detectionType: 'detector_coverage',
          detectionKey,
          detectorName: detRep.detectorName || detKey,
          detectorStatus: detRep.status,
          resultStatus: 'NOT VERIFIED',
          processingVersion: `${PIPELINE_DETECTION_PROCESSING_VERSION}|${detKey}:${detRep.version || 'unknown'}`,
          verificationReason: detRep.failureReason || detRep.limitations || `Detector ${detKey} reported ${detRep.status}`,
          idempotencyKey: `det_hist:${scan.id}:detector:${detKey}`,
          details: {
            detectorName: detRep.detectorName || detKey,
            detectorVersion: detRep.version || null,
            status: detRep.status,
          },
          detectedAt,
        });
      }
    }
  };

  if (comparison && parentReport) {
    // Re-scan with comparison: map baseline + revised issues into explicit lifecycle statuses
    const origIssues = parentReport.topIssues || [];
    const revIssues = report.topIssues || [];

    const verifyByIssueWhat = (what: string) => {
      const matchedOrig = origIssues.find((o) => o.what === what);
      if (!matchedOrig) {
        return { verifiable: false, reason: 'Baseline issue not found for resolution verification' };
      }
      return policyIntelligenceEngine.canVerifyResolution(
        matchedOrig.domain,
        parentReport,
        report,
        {
          originalScanRecord: parentScan || undefined,
          revisedScanRecord: scan,
        },
        matchedOrig
      );
    };

    for (const resolvedWhat of comparison.resolvedIssues || []) {
      const matchedOrig = origIssues.find((o) => o.what === resolvedWhat);
      const verification = verifyByIssueWhat(resolvedWhat);
      const resultStatus: DetectionHistoryStatus = verification.verifiable ? 'Resolved' : 'NOT VERIFIED';
      const domain = matchedOrig?.domain || 'video_audio';
      const category = matchedOrig?.category || 'resolved_finding';
      const detectionKey = normalizeDetectionKey(`${domain}_${category}_${resolvedWhat}`);

      events.push({
        scanId: scan.id,
        userId: scan.userId,
        parentScanId: comparison.originalScanId,
        comparisonScanId: comparison.originalScanId,
        fingerprintId: pickFingerprintForDomain(domain, fingerprints),
        evidenceId: pickEvidenceIdsForIssue(domain, category, evidence)[0] || null,
        evidenceIds: pickEvidenceIdsForIssue(domain, category, evidence),
        detectionType: category,
        detectionKey,
        detectorName: matchedOrig?.type || domain,
        detectorStatus: report.domainReports?.[domain]?.status || null,
        resultStatus,
        processingVersion,
        verificationReason: verification.verifiable
          ? 'Verified absence of prior finding in revised scan'
          : verification.reason || 'Resolution verification unavailable',
        idempotencyKey: `det_hist:${scan.id}:resolved:${makeShortKeyHash(resolvedWhat)}`,
        details: {
          what: resolvedWhat,
          where: matchedOrig?.where || null,
          mediaIdentity: comparison.mediaIdentity || null,
        },
        detectedAt,
      });
    }

    for (const remainingLabel of comparison.remainingIssues || []) {
      const matchedIssue =
        origIssues.find((o) => `${o.where}: ${o.what}` === remainingLabel) ||
        revIssues.find((r) => `${r.where}: ${r.what}` === remainingLabel);
      const domain = matchedIssue?.domain || 'video_audio';
      const category = matchedIssue?.category || 'persisting_finding';
      const evIds = pickEvidenceIdsForIssue(domain, category, evidence);
      const detectionKey = normalizeDetectionKey(`${domain}_${category}_${matchedIssue?.what || remainingLabel}`);

      events.push({
        scanId: scan.id,
        userId: scan.userId,
        parentScanId: comparison.originalScanId,
        comparisonScanId: comparison.originalScanId,
        fingerprintId: pickFingerprintForDomain(domain, fingerprints),
        evidenceId: evIds[0] || null,
        evidenceIds: evIds,
        detectionType: category,
        detectionKey,
        detectorName: matchedIssue?.type || domain,
        detectorStatus: report.domainReports?.[domain]?.status || null,
        resultStatus: 'Still Present',
        processingVersion,
        verificationReason: 'Issue persists across baseline and revised scans',
        idempotencyKey: `det_hist:${scan.id}:still_present:${makeShortKeyHash(remainingLabel)}`,
        details: {
          label: remainingLabel,
          severity: matchedIssue?.severity || null,
          domain,
        },
        detectedAt,
      });
    }

    for (const newLabel of comparison.newIssues || []) {
      const matchedIssue = revIssues.find((r) => `${r.where}: ${r.what}` === newLabel);
      const domain = matchedIssue?.domain || 'video_audio';
      const category = matchedIssue?.category || 'new_finding';
      const evIds = pickEvidenceIdsForIssue(domain, category, evidence);
      const detectionKey = normalizeDetectionKey(`${domain}_${category}_${matchedIssue?.what || newLabel}`);

      events.push({
        scanId: scan.id,
        userId: scan.userId,
        parentScanId: comparison.originalScanId,
        comparisonScanId: comparison.originalScanId,
        fingerprintId: pickFingerprintForDomain(domain, fingerprints),
        evidenceId: evIds[0] || null,
        evidenceIds: evIds,
        detectionType: category,
        detectionKey,
        detectorName: matchedIssue?.type || domain,
        detectorStatus: report.domainReports?.[domain]?.status || null,
        resultStatus: 'New',
        processingVersion,
        verificationReason: 'Newly detected in revised scan',
        idempotencyKey: `det_hist:${scan.id}:new:${makeShortKeyHash(newLabel)}`,
        details: {
          label: newLabel,
          severity: matchedIssue?.severity || null,
          domain,
        },
        detectedAt,
      });
    }

    for (const unverifiedLabel of comparison.notVerifiedIssues || []) {
      const detectionKey = normalizeDetectionKey(`not_verified_${unverifiedLabel}`);
      events.push({
        scanId: scan.id,
        userId: scan.userId,
        parentScanId: comparison.originalScanId,
        comparisonScanId: comparison.originalScanId,
        fingerprintId: defaultFingerprintId,
        evidenceId: null,
        evidenceIds: [],
        detectionType: 'rescan_verification',
        detectionKey,
        detectorName: null,
        detectorStatus: 'NOT_ASSESSED',
        resultStatus: 'NOT VERIFIED',
        processingVersion,
        verificationReason: unverifiedLabel,
        idempotencyKey: `det_hist:${scan.id}:not_verified:${makeShortKeyHash(unverifiedLabel)}`,
        details: {
          summary: unverifiedLabel,
        },
        detectedAt,
      });
    }

    emitNotVerifiedCoverageEvents();
    return events;
  }

  // Baseline scan (or re-scan whose parent report is unavailable)
  for (const issue of report.topIssues || []) {
    const evIds = pickEvidenceIdsForIssue(issue.domain, issue.category, evidence);
    const detectionKey = normalizeDetectionKey(`${issue.domain}_${issue.category}_${issue.what}`);
    events.push({
      scanId: scan.id,
      userId: scan.userId,
      parentScanId: scan.parentScanId || null,
      comparisonScanId: null,
      fingerprintId: pickFingerprintForDomain(issue.domain, fingerprints),
      evidenceId: evIds[0] || null,
      evidenceIds: evIds,
      detectionType: issue.category,
      detectionKey,
      detectorName: issue.type || issue.domain,
      detectorStatus: report.domainReports?.[issue.domain]?.status || null,
      resultStatus: 'New',
      processingVersion,
      verificationReason: scan.parentScanId
        ? 'Parent scan report unavailable; finding recorded as observed in this scan'
        : 'Initial baseline detection',
      idempotencyKey: `det_hist:${scan.id}:issue:${makeShortKeyHash(`${issue.domain}:${issue.where}:${issue.what}`)}`,
      details: {
        what: issue.what,
        where: issue.where,
        severity: issue.severity,
        domain: issue.domain,
        timestampSeconds: issue.timestampSeconds,
      },
      detectedAt,
    });
  }

  if (scan.parentScanId && !parentReport) {
    events.push({
      scanId: scan.id,
      userId: scan.userId,
      parentScanId: scan.parentScanId,
      comparisonScanId: scan.parentScanId,
      fingerprintId: defaultFingerprintId,
      evidenceId: null,
      evidenceIds: [],
      detectionType: 'rescan_verification',
      detectionKey: 'parent_comparison_unavailable',
      detectorName: 'policyIntelligence',
      detectorStatus: 'NOT_ASSESSED',
      resultStatus: 'NOT VERIFIED',
      processingVersion,
      verificationReason: 'Baseline parent report not available; prior issue resolution cannot be verified',
      idempotencyKey: `det_hist:${scan.id}:parent_missing`,
      details: {
        parentScanId: scan.parentScanId,
      },
      detectedAt,
    });
  }

  emitNotVerifiedCoverageEvents();
  return events;
}

export function buildFailedScanDetectionHistoryEvent(
  scan: ScanJob,
  failureReason: string,
  detectorName?: string
): DetectionHistoryInput {
  return {
    scanId: scan.id,
    userId: scan.userId,
    parentScanId: scan.parentScanId || null,
    comparisonScanId: scan.parentScanId || null,
    fingerprintId: null,
    evidenceId: null,
    evidenceIds: [],
    detectionType: 'scan_execution',
    detectionKey: 'scan_pipeline_execution',
    detectorName: detectorName || 'jobOrchestrator',
    detectorStatus: 'ANALYSIS_UNAVAILABLE',
    resultStatus: 'NOT VERIFIED',
    processingVersion: PIPELINE_DETECTION_PROCESSING_VERSION,
    verificationReason: failureReason || 'Scan processing failed before verification completed',
    idempotencyKey: `det_hist:${scan.id}:scan_failed`,
    details: {
      scanStatus: 'FAILED',
      error: failureReason,
    },
    detectedAt: new Date().toISOString(),
  };
}
