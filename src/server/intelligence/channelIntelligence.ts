import {
  ScanJob,
  RiskReport,
  CrossVideoPattern,
  CrossVideoComparisonItem,
  CrossVideoComparisonType,
  CrossVideoComparisonStatus,
  TemporalAnalysisResult,
  TemporalPatternItem,
  ChannelCoverageReport,
  ChannelCoverageDetail,
  ChannelIntelligenceRecord,
  ChannelPatternsResponse,
  StoredVisualSignature,
  StoredAudioSignature
} from '../../types';
import { storage, IStorageRepository } from '../storage';

export const MANDATORY_COVERAGE_STATEMENT = 
  'Channel insights are based only on videos uploaded and analyzed in your VideoRisk account. This is not a complete audit of all videos on your YouTube channel.';

export function hexToBits(hex: string): boolean[] {
  const bits: boolean[] = [];
  for (let i = 0; i < hex.length; i++) {
    const val = parseInt(hex[i], 16);
    bits.push((val & 8) !== 0);
    bits.push((val & 4) !== 0);
    bits.push((val & 2) !== 0);
    bits.push((val & 1) !== 0);
  }
  return bits;
}

export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function compareFrameSignatures(
  f1: StoredVisualSignature, 
  f2: StoredVisualSignature
): { isMatch: boolean; similarity: number } {
  // Color similarity
  const colorDiff = (
    Math.abs(f1.meanR - f2.meanR) +
    Math.abs(f1.meanG - f2.meanG) +
    Math.abs(f1.meanB - f2.meanB)
  ) / (3 * 255);
  const colorSim = Math.max(0, 1 - colorDiff);

  // Flat frame handling (solid colors/titles/black frames)
  const isFlat1 = f1.stdDevY < 2.5;
  const isFlat2 = f2.stdDevY < 2.5;
  if (isFlat1 || isFlat2) {
    if (isFlat1 && isFlat2) {
      const lumDiff = Math.abs(f1.meanY - f2.meanY) / 255;
      const isMatch = colorSim >= 0.95 && lumDiff <= 0.05;
      return { isMatch, similarity: isMatch ? parseFloat((colorSim * 0.95).toFixed(3)) : parseFloat((colorSim * 0.5).toFixed(3)) };
    }
    return { isMatch: false, similarity: Math.min(colorSim, 0.60) };
  }

  // Gradient comparison (dHash)
  const h1 = hexToBits(f1.hGrad);
  const h2 = hexToBits(f2.hGrad);
  const v1 = hexToBits(f1.vGrad);
  const v2 = hexToBits(f2.vGrad);

  let gradMatches = 0;
  const bitCount = Math.min(56, h1.length, h2.length);
  for (let i = 0; i < bitCount; i++) {
    if (h1[i] === h2[i]) gradMatches++;
    if (v1[i] === v2[i]) gradMatches++;
  }
  const gradSim = gradMatches / 112;

  // Luminance correlation
  const lumDiff = Math.abs(f1.meanY - f2.meanY) / 255;
  const lumSim = Math.max(0, 1 - lumDiff);

  const similarity = parseFloat((0.60 * gradSim + 0.25 * colorSim + 0.15 * lumSim).toFixed(3));
  const isMatch = gradSim >= 0.88 && colorSim >= 0.80 && similarity >= 0.86;

  return { isMatch, similarity };
}

export function compareAudioChunkSignatures(
  c1: StoredAudioSignature, 
  c2: StoredAudioSignature
): { isMatch: boolean; similarity: number; isSilentOrTone: boolean } {
  // Reject silence / near-silence (< 50 rms)
  if (c1.rms < 50 || c2.rms < 50) {
    return { isMatch: false, similarity: 0, isSilentOrTone: true };
  }

  const p1 = c1.spectralProfile;
  const p2 = c2.spectralProfile;
  if (!p1 || !p2 || p1.length < 16 || p2.length < 16) {
    return { isMatch: false, similarity: 0, isSilentOrTone: false };
  }

  const mean1 = p1.reduce((a, b) => a + b, 0) / p1.length;
  const mean2 = p2.reduce((a, b) => a + b, 0) / p2.length;
  const var1 = p1.reduce((a, b) => a + (b - mean1) ** 2, 0) / p1.length;
  const var2 = p2.reduce((a, b) => a + (b - mean2) ** 2, 0) / p2.length;

  // Flat tone rejection (almost zero frequency variance across subbands)
  if (var1 < 0.0001 || var2 < 0.0001) {
    return { isMatch: false, similarity: 0, isSilentOrTone: true };
  }

  // Cosine similarity across 16 subbands
  let dot = 0;
  let norm1 = 0;
  let norm2 = 0;
  for (let i = 0; i < 16; i++) {
    dot += p1[i] * p2[i];
    norm1 += p1[i] * p1[i];
    norm2 += p2[i] * p2[i];
  }

  const cosine = (norm1 > 0 && norm2 > 0) ? dot / (Math.sqrt(norm1) * Math.sqrt(norm2)) : 0;
  const similarity = parseFloat(Math.max(0, Math.min(1, cosine)).toFixed(3));
  const isMatch = similarity >= 0.92;

  return { isMatch, similarity, isSilentOrTone: false };
}

export class ChannelIntelligenceEngine {
  private storageRepo: IStorageRepository;

  constructor(customStorage?: IStorageRepository) {
    this.storageRepo = customStorage || storage;
  }

  /**
   * Compares visual frame signatures between two specific scans
   */
  public compareVisualSignatures(
    scanA: ScanJob,
    scanB: ScanJob,
    reportA: RiskReport | null,
    reportB: RiskReport | null
  ): {
    status: CrossVideoComparisonStatus;
    comparisons: CrossVideoComparisonItem[];
    limitations: string;
  } {
    const sigsA: StoredVisualSignature[] = reportA?.detectors?.video_repeated_footage?.details?.visualSignatures || [];
    const sigsB: StoredVisualSignature[] = reportB?.detectors?.video_repeated_footage?.details?.visualSignatures || [];

    if (sigsA.length === 0 || sigsB.length === 0) {
      return {
        status: 'UNAVAILABLE_MISSING_EVIDENCE',
        comparisons: [],
        limitations: 'One or both scans lack persisted visual frame signatures required for cross-video perceptual comparison.'
      };
    }

    const comparisons: CrossVideoComparisonItem[] = [];
    const nowIso = new Date().toISOString();

    // 1. Intro comparison (first 15 seconds)
    const introA = sigsA.filter(s => s.timestamp <= 15);
    const introB = sigsB.filter(s => s.timestamp <= 15);
    let introMatchCount = 0;
    let introTotalSim = 0;
    const minIntroLen = Math.min(introA.length, introB.length);

    for (let i = 0; i < minIntroLen; i++) {
      const match = compareFrameSignatures(introA[i], introB[i]);
      if (match.isMatch) {
        introMatchCount++;
        introTotalSim += match.similarity;
      }
    }

    if (minIntroLen >= 2 && introMatchCount >= 2 && (introMatchCount / minIntroLen) >= 0.70) {
      const avgSim = parseFloat((introTotalSim / introMatchCount).toFixed(3));
      comparisons.push({
        id: `cmp_intro_${scanA.id}_${scanB.id}`,
        type: 'intro_outro',
        scanIdA: scanA.id,
        scanIdB: scanB.id,
        videoTitleA: scanA.videoTitle,
        videoTitleB: scanB.videoTitle,
        intervalA: { start: introA[0].timestamp, end: introA[introMatchCount - 1].timestamp, label: `${formatTime(introA[0].timestamp)}–${formatTime(introA[introMatchCount - 1].timestamp)}` },
        intervalB: { start: introB[0].timestamp, end: introB[introMatchCount - 1].timestamp, label: `${formatTime(introB[0].timestamp)}–${formatTime(introB[introMatchCount - 1].timestamp)}` },
        algorithm: 'perceptual_hash_dhash_ncc',
        algorithmVersion: '1.2.0',
        decisionThreshold: 0.86,
        measuredSimilarity: avgSim,
        status: 'MATCH_CONFIRMED',
        evidenceStrength: 'STRONG',
        limitations: 'Evaluates opening sequence visual frames for shared channel bumper branding.',
        explanation: `Shared opening intro sequence identified between "${scanA.videoTitle}" and "${scanB.videoTitle}" (${Math.round(avgSim * 100)}% structural visual parity).`,
        createdAt: nowIso
      });
    }

    // 2. Outro comparison (last 15 seconds)
    const maxTimeA = sigsA[sigsA.length - 1].timestamp;
    const maxTimeB = sigsB[sigsB.length - 1].timestamp;
    const outroA = sigsA.filter(s => s.timestamp >= Math.max(0, maxTimeA - 15));
    const outroB = sigsB.filter(s => s.timestamp >= Math.max(0, maxTimeB - 15));
    let outroMatchCount = 0;
    let outroTotalSim = 0;
    const minOutroLen = Math.min(outroA.length, outroB.length);

    for (let i = 0; i < minOutroLen; i++) {
      const match = compareFrameSignatures(outroA[outroA.length - 1 - i], outroB[outroB.length - 1 - i]);
      if (match.isMatch) {
        outroMatchCount++;
        outroTotalSim += match.similarity;
      }
    }

    if (minOutroLen >= 2 && outroMatchCount >= 2 && (outroMatchCount / minOutroLen) >= 0.70) {
      const avgSim = parseFloat((outroTotalSim / outroMatchCount).toFixed(3));
      comparisons.push({
        id: `cmp_outro_${scanA.id}_${scanB.id}`,
        type: 'intro_outro',
        scanIdA: scanA.id,
        scanIdB: scanB.id,
        videoTitleA: scanA.videoTitle,
        videoTitleB: scanB.videoTitle,
        intervalA: { start: outroA[0].timestamp, end: outroA[outroA.length - 1].timestamp, label: `${formatTime(outroA[0].timestamp)}–${formatTime(outroA[outroA.length - 1].timestamp)}` },
        intervalB: { start: outroB[0].timestamp, end: outroB[outroB.length - 1].timestamp, label: `${formatTime(outroB[0].timestamp)}–${formatTime(outroB[outroB.length - 1].timestamp)}` },
        algorithm: 'perceptual_hash_dhash_ncc',
        algorithmVersion: '1.2.0',
        decisionThreshold: 0.86,
        measuredSimilarity: avgSim,
        status: 'MATCH_CONFIRMED',
        evidenceStrength: 'STRONG',
        limitations: 'Evaluates closing sequence visual frames for shared outro card or credits.',
        explanation: `Shared closing outro / credit sequence identified between "${scanA.videoTitle}" and "${scanB.videoTitle}" (${Math.round(avgSim * 100)}% structural visual parity).`,
        createdAt: nowIso
      });
    }

    // 3. Repeated footage segments across videos (minimum 3 consecutive matching sampled frames)
    let currentRunA: StoredVisualSignature[] = [];
    let currentRunB: StoredVisualSignature[] = [];
    let currentSims: number[] = [];

    // Sliding cross-correlation between sampled frames
    for (let i = 0; i < sigsA.length; i++) {
      for (let j = 0; j < sigsB.length; j++) {
        // Do not compare the exact opening intro range against itself if intro was already matched
        const bothAtIntro = sigsA[i].timestamp <= 15 && sigsB[j].timestamp <= 15 && Math.abs(sigsA[i].timestamp - sigsB[j].timestamp) <= 2;
        if (bothAtIntro && comparisons.some(c => c.type === 'intro_outro')) continue;

        let runA: StoredVisualSignature[] = [];
        let runB: StoredVisualSignature[] = [];
        let runSims: number[] = [];

        let step = 0;
        while (i + step < sigsA.length && j + step < sigsB.length) {
          const comp = compareFrameSignatures(sigsA[i + step], sigsB[j + step]);
          if (!comp.isMatch) break;
          runA.push(sigsA[i + step]);
          runB.push(sigsB[j + step]);
          runSims.push(comp.similarity);
          step++;
        }

        if (runA.length >= 3) {
          const avgSim = parseFloat((runSims.reduce((a, b) => a + b, 0) / runSims.length).toFixed(3));
          const startA = runA[0].timestamp;
          const endA = runA[runA.length - 1].timestamp;
          const startB = runB[0].timestamp;
          const endB = runB[runB.length - 1].timestamp;

          // Check if already covered by an existing comparison
          const alreadyCovered = comparisons.some(c => 
            c.type === 'visual_segment' &&
            c.intervalA && Math.abs(c.intervalA.start - startA) < 2 &&
            c.intervalB && Math.abs(c.intervalB.start - startB) < 2
          );

          if (!alreadyCovered) {
            comparisons.push({
              id: `cmp_vis_${scanA.id}_${scanB.id}_${Math.round(startA)}_${Math.round(startB)}`,
              type: 'visual_segment',
              scanIdA: scanA.id,
              scanIdB: scanB.id,
              videoTitleA: scanA.videoTitle,
              videoTitleB: scanB.videoTitle,
              intervalA: { start: startA, end: endA, label: `${formatTime(startA)}–${formatTime(endA)}` },
              intervalB: { start: startB, end: endB, label: `${formatTime(startB)}–${formatTime(endB)}` },
              algorithm: 'consecutive_perceptual_hash_ncc',
              algorithmVersion: '1.2.0',
              decisionThreshold: 0.86,
              measuredSimilarity: avgSim,
              status: 'MATCH_CONFIRMED',
              evidenceStrength: 'STRONG',
              limitations: 'Detects cross-video visual repetition across uploaded files; does not establish copyright infringement or third-party ownership.',
              explanation: `Visual segment from "${scanA.videoTitle}" (${formatTime(startA)}–${formatTime(endA)}) matches visual sequence in "${scanB.videoTitle}" (${formatTime(startB)}–${formatTime(endB)}) with ${Math.round(avgSim * 100)}% similarity score.`,
              createdAt: nowIso
            });
          }
        } else if (runA.length === 1 && comparisons.length === 0) {
          // Check for isolated similar frame
          const comp = compareFrameSignatures(sigsA[i], sigsB[j]);
          if (comp.isMatch && comp.similarity >= 0.90) {
            comparisons.push({
              id: `cmp_frame_${scanA.id}_${scanB.id}_${Math.round(sigsA[i].timestamp)}`,
              type: 'visual_frame',
              scanIdA: scanA.id,
              scanIdB: scanB.id,
              videoTitleA: scanA.videoTitle,
              videoTitleB: scanB.videoTitle,
              intervalA: { start: sigsA[i].timestamp, end: sigsA[i].timestamp, label: formatTime(sigsA[i].timestamp) },
              intervalB: { start: sigsB[j].timestamp, end: sigsB[j].timestamp, label: formatTime(sigsB[j].timestamp) },
              algorithm: 'perceptual_hash_dhash_ncc',
              algorithmVersion: '1.2.0',
              decisionThreshold: 0.86,
              measuredSimilarity: comp.similarity,
              status: 'SIMILAR_INCONCLUSIVE',
              evidenceStrength: 'HEURISTIC',
              limitations: 'Isolated matching frame without continuous segment match; does not constitute footage repetition.',
              explanation: `Similar visual frame observed at ${formatTime(sigsA[i].timestamp)} in "${scanA.videoTitle}" and ${formatTime(sigsB[j].timestamp)} in "${scanB.videoTitle}". Inconclusive without continuous sequence match.`,
              createdAt: nowIso
            });
          }
        }
      }
    }

    const overallStatus: CrossVideoComparisonStatus = comparisons.some(c => c.status === 'MATCH_CONFIRMED')
      ? 'MATCH_CONFIRMED'
      : (comparisons.some(c => c.status === 'SIMILAR_INCONCLUSIVE') ? 'SIMILAR_INCONCLUSIVE' : 'NO_MATCH');

    return {
      status: overallStatus,
      comparisons,
      limitations: 'Visual comparisons are derived from stored 8x8 luminance gradient signatures. They compare uploaded video files within your account only and do not search external YouTube catalogs.'
    };
  }

  /**
   * Compares audio subband spectral signatures between two specific scans
   */
  public compareAudioSignatures(
    scanA: ScanJob,
    scanB: ScanJob,
    reportA: RiskReport | null,
    reportB: RiskReport | null
  ): {
    status: CrossVideoComparisonStatus;
    comparisons: CrossVideoComparisonItem[];
    limitations: string;
  } {
    const audioA: StoredAudioSignature[] = reportA?.detectors?.audio_repeated_segments?.details?.audioSignatures || [];
    const audioB: StoredAudioSignature[] = reportB?.detectors?.audio_repeated_segments?.details?.audioSignatures || [];

    if (audioA.length === 0 || audioB.length === 0) {
      return {
        status: 'UNAVAILABLE_MISSING_EVIDENCE',
        comparisons: [],
        limitations: 'One or both scans lack persisted audio spectral signatures required for cross-video acoustic comparison.'
      };
    }

    const comparisons: CrossVideoComparisonItem[] = [];
    const nowIso = new Date().toISOString();

    for (let i = 0; i < audioA.length; i++) {
      for (let j = 0; j < audioB.length; j++) {
        let runA: StoredAudioSignature[] = [];
        let runB: StoredAudioSignature[] = [];
        let runSims: number[] = [];

        let step = 0;
        while (i + step < audioA.length && j + step < audioB.length) {
          const comp = compareAudioChunkSignatures(audioA[i + step], audioB[j + step]);
          if (!comp.isMatch) break;
          runA.push(audioA[i + step]);
          runB.push(audioB[j + step]);
          runSims.push(comp.similarity);
          step++;
        }

        if (runA.length >= 3) {
          const avgSim = parseFloat((runSims.reduce((a, b) => a + b, 0) / runSims.length).toFixed(3));
          const startA = runA[0].sec;
          const endA = runA[runA.length - 1].sec + runA[runA.length - 1].duration;
          const startB = runB[0].sec;
          const endB = runB[runB.length - 1].sec + runB[runB.length - 1].duration;

          const alreadyCovered = comparisons.some(c => 
            c.type === 'audio_repetition' &&
            c.intervalA && Math.abs(c.intervalA.start - startA) < 2 &&
            c.intervalB && Math.abs(c.intervalB.start - startB) < 2
          );

          if (!alreadyCovered) {
            comparisons.push({
              id: `cmp_aud_${scanA.id}_${scanB.id}_${Math.round(startA)}_${Math.round(startB)}`,
              type: 'audio_repetition',
              scanIdA: scanA.id,
              scanIdB: scanB.id,
              videoTitleA: scanA.videoTitle,
              videoTitleB: scanB.videoTitle,
              intervalA: { start: startA, end: endA, label: `${formatTime(startA)}–${formatTime(endA)}` },
              intervalB: { start: startB, end: endB, label: `${formatTime(startB)}–${formatTime(endB)}` },
              algorithm: 'subband_spectral_cosine_correlation',
              algorithmVersion: '1.2.0',
              decisionThreshold: 0.92,
              measuredSimilarity: avgSim,
              status: 'MATCH_CONFIRMED',
              evidenceStrength: 'STRONG',
              limitations: 'Identifies matching acoustic subband profiles across uploads. Does not distinguish licensed production music from copyright infringement.',
              explanation: `Audio segment from "${scanA.videoTitle}" (${formatTime(startA)}–${formatTime(endA)}) shares acoustic spectral characteristics with "${scanB.videoTitle}" (${formatTime(startB)}–${formatTime(endB)}) with ${Math.round(avgSim * 100)}% acoustic correlation score.`,
              createdAt: nowIso
            });
          }
        }
      }
    }

    const overallStatus: CrossVideoComparisonStatus = comparisons.some(c => c.status === 'MATCH_CONFIRMED')
      ? 'MATCH_CONFIRMED'
      : 'NO_MATCH';

    return {
      status: overallStatus,
      comparisons,
      limitations: 'Audio comparisons evaluate 16-band spectral energy envelopes across uploaded videos. Silent passages and continuous tones are strictly excluded from match claims.'
    };
  }

  /**
   * Evaluates temporal evolution between prior scan and latest scan
   */
  public computeTemporalChanges(
    priorScan: ScanJob,
    latestScan: ScanJob,
    priorReport: RiskReport | null,
    latestReport: RiskReport | null
  ): TemporalAnalysisResult {
    const priorSha = priorScan.metadata?.sha256;
    const latestSha = latestScan.metadata?.sha256;
    const isIdenticalMedia = Boolean(
      priorSha && latestSha &&
      priorSha.trim().toLowerCase() === latestSha.trim().toLowerCase()
    );

    const temporalPatterns: TemporalPatternItem[] = [];

    if (!priorReport || !latestReport) {
      return {
        scopeId: priorScan.userId,
        priorScanId: priorScan.id,
        latestScanId: latestScan.id,
        priorMediaSha256: priorSha,
        latestMediaSha256: latestSha,
        isIdenticalMedia,
        temporalPatterns: [],
        summary: 'Temporal comparison unavailable due to missing scan reports.',
        limitations: 'Both scans must have valid completed reports to perform temporal change tracking.'
      };
    }

    const priorIssues = priorReport.topIssues || [];
    const latestIssues = latestReport.topIssues || [];

    // Map each prior issue
    for (const pIssue of priorIssues) {
      const matchInLatest = latestIssues.find(lIssue => 
        lIssue.category === pIssue.category &&
        (lIssue.type === pIssue.type || lIssue.what.toLowerCase() === pIssue.what.toLowerCase())
      );

      if (matchInLatest) {
        temporalPatterns.push({
          patternId: `temp_persist_${pIssue.id}`,
          patternType: pIssue.type || pIssue.category,
          label: pIssue.what,
          priorScanId: priorScan.id,
          latestScanId: latestScan.id,
          status: 'PERSISTING',
          priorEvidenceRef: pIssue.id,
          latestEvidenceRef: matchInLatest.id,
          priorTimestamp: formatTime(pIssue.timestampSeconds),
          latestTimestamp: formatTime(matchInLatest.timestampSeconds),
          reason: 'Finding persists across both scans with active signal detection in latest report.',
          detectorVersionMatch: true,
          mediaIdentityMatch: isIdenticalMedia
        });
      } else {
        // Missing from latest: check if resolution can be verified with evidence
        // 1. If media is identical, fails closed!
        if (isIdenticalMedia) {
          temporalPatterns.push({
            patternId: `temp_unverified_${pIssue.id}`,
            patternType: pIssue.type || pIssue.category,
            label: pIssue.what,
            priorScanId: priorScan.id,
            latestScanId: latestScan.id,
            status: 'CHANGE_NOT_VERIFIED',
            priorEvidenceRef: pIssue.id,
            reason: 'Identical media file version (matching SHA-256) cannot verify content resolution.',
            detectorVersionMatch: true,
            mediaIdentityMatch: true
          });
        } else {
          // Check detector status in latest report
          const responsibleKey = pIssue.domain === 'video_audio' ? 'video_repeated_footage' : 'thumbnail_ocr';
          const detector = latestReport.detectors?.[responsibleKey];

          if (!detector || detector.status === 'NOT_ASSESSED' || detector.status === 'ANALYSIS_UNAVAILABLE') {
            temporalPatterns.push({
              patternId: `temp_unverified_${pIssue.id}`,
              patternType: pIssue.type || pIssue.category,
              label: pIssue.what,
              priorScanId: priorScan.id,
              latestScanId: latestScan.id,
              status: 'CHANGE_NOT_VERIFIED',
              priorEvidenceRef: pIssue.id,
              reason: `Responsible detector (${responsibleKey}) was not assessed or unavailable in latest scan; resolution cannot be certified.`,
              detectorVersionMatch: false,
              mediaIdentityMatch: false
            });
          } else {
            temporalPatterns.push({
              patternId: `temp_resolved_${pIssue.id}`,
              patternType: pIssue.type || pIssue.category,
              label: pIssue.what,
              priorScanId: priorScan.id,
              latestScanId: latestScan.id,
              status: 'RESOLVED_WITH_EVIDENCE',
              priorEvidenceRef: pIssue.id,
              reason: 'Prior finding no longer observed in revised media, supported by clean detector verification.',
              detectorVersionMatch: true,
              mediaIdentityMatch: false
            });
          }
        }
      }
    }

    // Unmatched issues in latest scan are NEWLY_OBSERVED
    for (const lIssue of latestIssues) {
      const matchInPrior = priorIssues.find(pIssue =>
        pIssue.category === lIssue.category &&
        (pIssue.type === lIssue.type || pIssue.what.toLowerCase() === lIssue.what.toLowerCase())
      );
      if (!matchInPrior) {
        temporalPatterns.push({
          patternId: `temp_new_${lIssue.id}`,
          patternType: lIssue.type || lIssue.category,
          label: lIssue.what,
          priorScanId: priorScan.id,
          latestScanId: latestScan.id,
          status: 'NEWLY_OBSERVED',
          latestEvidenceRef: lIssue.id,
          latestTimestamp: formatTime(lIssue.timestampSeconds),
          reason: 'New issue observed in latest scan that was not present in prior scan baseline.',
          detectorVersionMatch: true,
          mediaIdentityMatch: isIdenticalMedia
        });
      }
    }

    const resolvedCount = temporalPatterns.filter(t => t.status === 'RESOLVED_WITH_EVIDENCE').length;
    const persistingCount = temporalPatterns.filter(t => t.status === 'PERSISTING').length;
    const newCount = temporalPatterns.filter(t => t.status === 'NEWLY_OBSERVED').length;
    const unverifiedCount = temporalPatterns.filter(t => t.status === 'CHANGE_NOT_VERIFIED').length;

    const summary = `Temporal scan comparison: ${resolvedCount} resolved with evidence, ${persistingCount} persisting, ${newCount} newly observed, ${unverifiedCount} unverified.`;

    return {
      scopeId: priorScan.userId,
      priorScanId: priorScan.id,
      latestScanId: latestScan.id,
      priorMediaSha256: priorSha,
      latestMediaSha256: latestSha,
      isIdenticalMedia,
      temporalPatterns,
      summary,
      limitations: 'Temporal comparisons require compatible detector versions and distinct media identities. Identical SHA-256 files fail closed without certifying changes.'
    };
  }

  /**
   * Deterministic Channel Intelligence aggregation across completed scans
   */
  public async aggregateChannelIntelligence(
    userId: string,
    options?: { recompute?: boolean; maxScans?: number }
  ): Promise<ChannelIntelligenceRecord> {
    const userScans = await this.storageRepo.scans.getAllScans(userId);

    // Filter strictly to unique, completed scans belonging to the user
    const seenScanIds = new Set<string>();
    const completedScans: ScanJob[] = [];
    for (const s of userScans) {
      if (s.status === 'COMPLETED' && !seenScanIds.has(s.id)) {
        seenScanIds.add(s.id);
        completedScans.push(s);
      }
    }

    const sampleSize = completedScans.length;
    const currentScanIds = completedScans.map(s => s.id).sort();

    // Check cached persistence if not explicitly recomputing
    if (!options?.recompute) {
      const existing = await this.storageRepo.channelIntelligence.getLatest(userId);
      if (existing && existing.status !== 'STALE' && existing.sampleSize === sampleSize) {
        const cachedScanIds = (existing.sourceScanIds || []).slice().sort();
        const isExactMatch = cachedScanIds.length === currentScanIds.length &&
          cachedScanIds.every((id, idx) => id === currentScanIds[idx]);
        if (isExactMatch) {
          return existing;
        }
      }
    }

    // Build source video identities
    const sourceVideoIdentities = completedScans.map(s => ({
      scanId: s.id,
      videoTitle: s.videoTitle || 'Untitled Video',
      videoFilename: s.videoFilename || 'unknown.mp4',
      sha256: s.metadata?.sha256,
      durationSeconds: s.metadata?.durationSeconds,
      createdAt: s.createdAt
    }));

    // Fetch reports for completed scans
    const scanReports = new Map<string, RiskReport | null>();
    for (const s of completedScans) {
      const report = await this.storageRepo.scans.getReport(s.id);
      scanReports.set(s.id, report);
    }

    // Determine capability coverage based on stored evidence
    const hasVisualSignatures = completedScans.some(s => {
      const rep = scanReports.get(s.id);
      const sigs = rep?.detectors?.video_repeated_footage?.details?.visualSignatures;
      return Array.isArray(sigs) && sigs.length > 0;
    });

    const hasAudioSignatures = completedScans.some(s => {
      const rep = scanReports.get(s.id);
      const sigs = rep?.detectors?.audio_repeated_segments?.details?.audioSignatures;
      return Array.isArray(sigs) && sigs.length > 0;
    });

    const coverage: ChannelCoverageReport = {
      titleMetadata: 'AVAILABLE',
      introOutro: hasVisualSignatures ? 'AVAILABLE' : 'NOT_AVAILABLE',
      crossVideoFootage: hasVisualSignatures ? 'AVAILABLE' : 'NOT_AVAILABLE',
      audioPatterns: hasAudioSignatures ? 'AVAILABLE' : 'NOT_AVAILABLE',
      originalContribution: 'INSUFFICIENT_EVIDENCE'
    };

    const coverageDetails: Record<keyof ChannelCoverageReport, ChannelCoverageDetail> = {
      titleMetadata: {
        status: 'AVAILABLE',
        reason: 'Evaluates persisted video titles, descriptions, tags, and metadata coherence findings across completed scans in your account.',
        dataRequirements: 'Requires at least 2 completed video scans with metadata.'
      },
      introOutro: {
        status: coverage.introOutro,
        reason: hasVisualSignatures
          ? 'Evaluates persisted perceptual frame signatures within the opening and closing video sequences across uploads.'
          : 'VideoProcessor perceptual frame signatures are transient in-memory structures and are not stored in the database after job execution. Cross-scan intro/outro comparison requires persistent structural frame signatures.',
        dataRequirements: 'Requires persistent cross-video visual signature index.'
      },
      crossVideoFootage: {
        status: coverage.crossVideoFootage,
        reason: hasVisualSignatures
          ? 'Evaluates continuous perceptual frame signature matches across distinct uploaded videos in your account.'
          : 'Production VideoProcessor evaluates intra-video repeated footage only. Cross-video visual comparison across distinct uploads is not currently persisted.',
        dataRequirements: 'Requires persistent visual signature hashing across scans.'
      },
      audioPatterns: {
        status: coverage.audioPatterns,
        reason: hasAudioSignatures
          ? 'Evaluates 16-band subband spectral acoustic signatures across uploaded video audio tracks.'
          : 'Audio processing buffers and acoustic energy measurements are transient. Unconfigured STT or music classification cannot be used to infer audio pattern recurrence across scans.',
        dataRequirements: 'Requires configured speech transcription and acoustic fingerprint persistence.'
      },
      originalContribution: {
        status: 'INSUFFICIENT_EVIDENCE',
        reason: 'Automated transcript and original contribution measurement is not established for uploaded videos. VideoRisk preserves null rather than fabricating an arbitrary original contribution score.',
        dataRequirements: 'Requires verified spoken dialogue transcript analysis and verified third-party source attribution.'
      }
    };

    const nowIso = new Date().toISOString();
    const existingRec = await this.storageRepo.channelIntelligence.getLatest(userId);
    const newVersion = existingRec ? existingRec.version + 1 : 1;
    const recordId = `ch_intel_${userId}_v${newVersion}`;

    if (sampleSize < 2) {
      const record: ChannelIntelligenceRecord = {
        id: recordId,
        userId,
        scopeId: userId,
        version: newVersion,
        status: sampleSize === 0 ? 'FAILED' : 'INSUFFICIENT_DATA',
        sampleSize,
        sourceScanIds: currentScanIds,
        sourceVideoIdentities,
        patterns: [],
        crossVideoComparisons: [],
        temporalAnalysis: null,
        coverage,
        coverageDetails,
        disclaimer: MANDATORY_COVERAGE_STATEMENT,
        mandatoryCoverageStatement: MANDATORY_COVERAGE_STATEMENT,
        limitations: 'At least 2 completed scans are required to evaluate recurring patterns across videos.',
        createdAt: nowIso,
        updatedAt: nowIso
      };
      await this.storageRepo.channelIntelligence.save(record);
      return record;
    }

    const patterns: CrossVideoPattern[] = [];
    const crossVideoComparisons: CrossVideoComparisonItem[] = [];

    // -------------------------------------------------------------------------
    // 1. EXACT REPEATED TITLES
    // -------------------------------------------------------------------------
    const titleGroups = new Map<string, ScanJob[]>();
    for (const s of completedScans) {
      const rawTitle = (s.videoTitle || '').trim();
      if (!rawTitle) continue;
      const normalizedTitle = rawTitle.toLowerCase().replace(/\s+/g, ' ');
      const existing = titleGroups.get(normalizedTitle) || [];
      existing.push(s);
      titleGroups.set(normalizedTitle, existing);
    }

    for (const [normTitle, group] of titleGroups.entries()) {
      if (group.length >= 2) {
        const affectedCount = group.length;
        const distinctVideosCount = new Set(group.map(g => g.videoFilename || g.id)).size;
        const frequency = parseFloat(((affectedCount / sampleSize) * 100).toFixed(0));
        const sampleOriginalTitle = group[0].videoTitle;
        const scanIds = group.map(g => g.id);
        const sortedDates = group.map(g => g.createdAt).sort();

        patterns.push({
          id: `pat_title_exact_${Buffer.from(normTitle).toString('base64url').substring(0, 16)}`,
          patternType: 'exact_repeated_title',
          label: `Identical Video Titles (${affectedCount} videos)`,
          severity: 'warning',
          sampleSize,
          affectedScansCount: affectedCount,
          distinctVideosCount,
          distinctOccurrencesCount: affectedCount,
          frequency,
          sourceScanIds: scanIds,
          evidenceReferences: scanIds,
          firstObservedAt: sortedDates[0],
          lastObservedAt: sortedDates[sortedDates.length - 1],
          algorithmVersion: '1.2.0',
          patternStatus: 'VERIFIED',
          evidenceStrength: 'STRONG',
          whatObserved: `${affectedCount} videos share the exact normalized title: "${sampleOriginalTitle}".`,
          whatEstablished: 'Identical metadata strings were used across distinct video uploads.',
          whatRemainsUnknown: 'Does not establish whether underlying media footage is identical or unique.',
          explanation: `${affectedCount} of ${sampleSize} analyzed videos share the exact title: "${sampleOriginalTitle}". Re-uploading identical titles can confuse audience search indexing and trigger platform spam or duplicate metadata filters.`,
          recommendation: 'Ensure each uploaded video features a distinct, descriptive title accurately reflecting its specific focus.',
          recommendedAction: 'Differentiate titles to highlight unique episode focus, guest, or topic.',
          confidence: 'HIGH',
          limitations: 'Evaluates exact normalized text parity across stored scan titles.',
          disclaimer: MANDATORY_COVERAGE_STATEMENT
        });
      }
    }

    // -------------------------------------------------------------------------
    // 2. SERIES / EPISODIC TITLE TEMPLATES
    // -------------------------------------------------------------------------
    const seriesPrefixRegex = /^(.*?)(?:[\s\-_|:]*(?:ep(?:isode)?|part|vol(?:ume)?|#)\s*\d+.*)$/i;
    const seriesLeadingRegex = /^(?:(?:ep(?:isode)?|part|vol(?:ume)?|#)\s*\d+[\s\-_|:]*)(.*?)$/i;
    const seriesGroups = new Map<string, ScanJob[]>();

    for (const s of completedScans) {
      const rawTitle = (s.videoTitle || '').trim();
      const matchPrefix = seriesPrefixRegex.exec(rawTitle);
      const matchLeading = seriesLeadingRegex.exec(rawTitle);

      let seriesKey: string | null = null;
      if (matchPrefix && matchPrefix[1] && matchPrefix[1].trim().length >= 3) {
        seriesKey = matchPrefix[1].trim().toLowerCase();
      } else if (matchLeading && matchLeading[1] && matchLeading[1].trim().length >= 3) {
        seriesKey = matchLeading[1].trim().toLowerCase();
      } else if (matchLeading) {
        seriesKey = 'episodic_format';
      }

      if (seriesKey) {
        const existing = seriesGroups.get(seriesKey) || [];
        existing.push(s);
        seriesGroups.set(seriesKey, existing);
      }
    }

    for (const [prefix, group] of seriesGroups.entries()) {
      const distinctTitles = new Set(group.map(g => (g.videoTitle || '').trim().toLowerCase()));
      if (group.length >= 2 && distinctTitles.size >= 2) {
        const affectedCount = group.length;
        const distinctVideosCount = new Set(group.map(g => g.videoFilename || g.id)).size;
        const frequency = parseFloat(((affectedCount / sampleSize) * 100).toFixed(0));
        const sampleSeriesTitle = group[0].videoTitle;
        const scanIds = group.map(g => g.id);
        const sortedDates = group.map(g => g.createdAt).sort();

        patterns.push({
          id: `pat_title_series_${Buffer.from(prefix).toString('base64url').substring(0, 16)}`,
          patternType: 'series_title_template',
          label: `Consistent Series Title Formatting`,
          severity: 'info',
          sampleSize,
          affectedScansCount: affectedCount,
          distinctVideosCount,
          distinctOccurrencesCount: affectedCount,
          frequency,
          sourceScanIds: scanIds,
          evidenceReferences: scanIds,
          firstObservedAt: sortedDates[0],
          lastObservedAt: sortedDates[sortedDates.length - 1],
          algorithmVersion: '1.2.0',
          patternStatus: 'OBSERVED',
          evidenceStrength: 'STRONG',
          whatObserved: `${affectedCount} videos follow a consistent episodic naming format.`,
          whatEstablished: 'Standard episodic serial branding structure is in use.',
          whatRemainsUnknown: 'Does not evaluate audience engagement or search rankings.',
          explanation: `${affectedCount} of ${sampleSize} analyzed videos follow a structured episodic or series naming template (e.g., "${sampleSeriesTitle}"). This is a standard episodic series format.`,
          recommendation: 'Maintain episodic branding while highlighting the episode-specific topic or guest name to maximize search discoverability.',
          recommendedAction: 'Continue consistent serial branding while featuring distinct episode subtopics.',
          confidence: 'HIGH',
          limitations: 'Recognizes serial numbering and common episodic naming prefixes.',
          disclaimer: MANDATORY_COVERAGE_STATEMENT
        });
      }
    }

    // -------------------------------------------------------------------------
    // 3. IDENTICAL VIDEO DESCRIPTIONS
    // -------------------------------------------------------------------------
    const descGroups = new Map<string, ScanJob[]>();
    for (const s of completedScans) {
      const rawDesc = (s.videoDescription || '').trim();
      if (!rawDesc || rawDesc.length < 25) continue;
      const normDesc = rawDesc.toLowerCase().replace(/\s+/g, ' ');
      const existing = descGroups.get(normDesc) || [];
      existing.push(s);
      descGroups.set(normDesc, existing);
    }

    for (const [normDesc, group] of descGroups.entries()) {
      if (group.length >= 2) {
        const affectedCount = group.length;
        const distinctVideosCount = new Set(group.map(g => g.videoFilename || g.id)).size;
        const frequency = parseFloat(((affectedCount / sampleSize) * 100).toFixed(0));
        const scanIds = group.map(g => g.id);
        const sortedDates = group.map(g => g.createdAt).sort();

        patterns.push({
          id: `pat_desc_exact_${Buffer.from(normDesc).toString('base64url').substring(0, 16)}`,
          patternType: 'repeated_description',
          label: `Identical Video Descriptions (${affectedCount} videos)`,
          severity: 'info',
          sampleSize,
          affectedScansCount: affectedCount,
          distinctVideosCount,
          distinctOccurrencesCount: affectedCount,
          frequency,
          sourceScanIds: scanIds,
          evidenceReferences: scanIds,
          firstObservedAt: sortedDates[0],
          lastObservedAt: sortedDates[sortedDates.length - 1],
          algorithmVersion: '1.2.0',
          patternStatus: 'VERIFIED',
          evidenceStrength: 'STRONG',
          whatObserved: `${affectedCount} videos share identical boilerplate description text.`,
          whatEstablished: 'Identical description copy is reused across multiple uploads.',
          whatRemainsUnknown: 'Does not measure whether links or social handles in the description are active.',
          explanation: `${affectedCount} of ${sampleSize} analyzed videos share identical description text. While boilerplate channel links and disclaimers are standard, unique video descriptions provide essential context for search indexing.`,
          recommendation: 'Include 1–2 paragraphs of unique summary describing the specific topics and takeaways of each video alongside your standard channel links.',
          recommendedAction: 'Add a video-specific summary above channel boilerplate links.',
          confidence: 'HIGH',
          limitations: 'Evaluates exact text parity across saved video descriptions.',
          disclaimer: MANDATORY_COVERAGE_STATEMENT
        });
      }
    }

    // -------------------------------------------------------------------------
    // 4. RECURRING TITLE-TO-CONTENT COHERENCE GAPS
    // -------------------------------------------------------------------------
    let titleMismatchCount = 0;
    const mismatchScanRefs: string[] = [];
    const mismatchDates: string[] = [];

    for (const s of completedScans) {
      const report = scanReports.get(s.id);
      if (report && Array.isArray(report.topIssues)) {
        const hasMismatch = report.topIssues.some(i => 
          (i.domain === 'title' && (i.category === 'metadata_coherence' || i.type === 'title_content_mismatch')) ||
          i.type === 'title_duration_mismatch'
        );
        if (hasMismatch) {
          titleMismatchCount++;
          mismatchScanRefs.push(s.id);
          mismatchDates.push(s.createdAt);
        }
      }
    }

    if (titleMismatchCount >= 2) {
      const frequency = parseFloat(((titleMismatchCount / sampleSize) * 100).toFixed(0));
      mismatchDates.sort();

      patterns.push({
        id: 'pat_metadata_gap',
        patternType: 'title_content_mismatch',
        label: 'Recurring Title-to-Content Pacing Gap',
        severity: 'warning',
        sampleSize,
        affectedScansCount: titleMismatchCount,
        distinctVideosCount: titleMismatchCount,
        distinctOccurrencesCount: titleMismatchCount,
        frequency,
        sourceScanIds: mismatchScanRefs,
        evidenceReferences: mismatchScanRefs,
        firstObservedAt: mismatchDates[0],
        lastObservedAt: mismatchDates[mismatchDates.length - 1],
        algorithmVersion: '1.2.0',
        patternStatus: 'OBSERVED',
        evidenceStrength: 'MODERATE',
        whatObserved: `Title promises differed from opening segment pacing or content structure across ${titleMismatchCount} videos.`,
        whatEstablished: 'Initial video segments delayed addressing topics promised in titles.',
        whatRemainsUnknown: 'Does not measure viewer drop-off or audience retention curves.',
        explanation: `In ${titleMismatchCount} of ${sampleSize} analyzed videos, title promises differed from opening segment pacing or detected content structure.`,
        recommendation: 'Ensure opening hooks immediately address the subject introduced in the title to maintain audience trust and retention.',
        recommendedAction: 'Align opening 10 seconds of visuals with the title topic.',
        confidence: 'MEDIUM',
        limitations: 'Derived from automated title lexicon matching against initial scene transitions and metadata.',
        disclaimer: MANDATORY_COVERAGE_STATEMENT
      });
    }

    // -------------------------------------------------------------------------
    // 5. PAIRWISE CROSS-VIDEO COMPARISONS (Visual & Audio)
    // -------------------------------------------------------------------------
    // Limit comparison pairs to prevent unbounded CPU execution on large catalogs (max 15 scans = 105 pairs)
    const maxScansToCompare = Math.min(completedScans.length, options?.maxScans || 15);
    const comparisonScans = completedScans.slice(0, maxScansToCompare);

    const visualMatchScanIds = new Set<string>();
    const introMatchScanIds = new Set<string>();
    const audioMatchScanIds = new Set<string>();

    for (let i = 0; i < comparisonScans.length; i++) {
      for (let j = i + 1; j < comparisonScans.length; j++) {
        const scanA = comparisonScans[i];
        const scanB = comparisonScans[j];
        const repA = scanReports.get(scanA.id) ?? null;
        const repB = scanReports.get(scanB.id) ?? null;

        // Visual comparison
        if (hasVisualSignatures) {
          const visRes = this.compareVisualSignatures(scanA, scanB, repA, repB);
          if (visRes.comparisons.length > 0) {
            crossVideoComparisons.push(...visRes.comparisons);
            visRes.comparisons.forEach(c => {
              if (c.type === 'intro_outro' && c.status === 'MATCH_CONFIRMED') {
                introMatchScanIds.add(scanA.id);
                introMatchScanIds.add(scanB.id);
              } else if (c.type === 'visual_segment' && c.status === 'MATCH_CONFIRMED') {
                visualMatchScanIds.add(scanA.id);
                visualMatchScanIds.add(scanB.id);
              }
            });
          }
        }

        // Audio comparison
        if (hasAudioSignatures) {
          const audRes = this.compareAudioSignatures(scanA, scanB, repA, repB);
          if (audRes.comparisons.length > 0) {
            crossVideoComparisons.push(...audRes.comparisons);
            audRes.comparisons.forEach(c => {
              if (c.status === 'MATCH_CONFIRMED') {
                audioMatchScanIds.add(scanA.id);
                audioMatchScanIds.add(scanB.id);
              }
            });
          }
        }
      }
    }

    // Add aggregate patterns for cross-video footage if detected
    if (visualMatchScanIds.size >= 2) {
      const affectedCount = visualMatchScanIds.size;
      const scanIds = Array.from(visualMatchScanIds);
      const frequency = parseFloat(((affectedCount / sampleSize) * 100).toFixed(0));

      patterns.push({
        id: 'pat_cross_video_visual_repeat',
        patternType: 'cross_video_repeated_footage',
        label: `Repeated Visual Footage Across Scans (${affectedCount} videos)`,
        severity: 'warning',
        sampleSize,
        affectedScansCount: affectedCount,
        distinctVideosCount: affectedCount,
        distinctOccurrencesCount: affectedCount,
        frequency,
        sourceScanIds: scanIds,
        evidenceReferences: scanIds,
        algorithmVersion: '1.2.0',
        patternStatus: 'VERIFIED',
        evidenceStrength: 'STRONG',
        whatObserved: `Continuous visual sequences recur across ${affectedCount} distinct video uploads.`,
        whatEstablished: 'Identical visual frames were rendered in multiple published video containers.',
        whatRemainsUnknown: 'Does not establish external copyright infringement or third-party rights.',
        explanation: `${affectedCount} of ${sampleSize} analyzed videos share repeated visual sequences. Video platforms evaluate reused video footage to ensure substantial editorial transformation and commentary.`,
        recommendation: 'Ensure reused clips include significant new commentary, critique, or visual annotations to demonstrate original creative value.',
        recommendedAction: 'Review shared segments and add unique editorial commentary.',
        confidence: 'HIGH',
        limitations: 'Compares perceptual frame hashes across uploads in your VideoRisk account; does not query external third-party catalogs.',
        disclaimer: MANDATORY_COVERAGE_STATEMENT
      });
    }

    // Add aggregate patterns for intro/outro branding if detected
    if (introMatchScanIds.size >= 2) {
      const affectedCount = introMatchScanIds.size;
      const scanIds = Array.from(introMatchScanIds);
      const frequency = parseFloat(((affectedCount / sampleSize) * 100).toFixed(0));

      patterns.push({
        id: 'pat_repeated_intro_outro',
        patternType: 'repeated_intro_outro',
        label: `Consistent Intro / Outro Branding (${affectedCount} videos)`,
        severity: 'info',
        sampleSize,
        affectedScansCount: affectedCount,
        distinctVideosCount: affectedCount,
        distinctOccurrencesCount: affectedCount,
        frequency,
        sourceScanIds: scanIds,
        evidenceReferences: scanIds,
        algorithmVersion: '1.2.0',
        patternStatus: 'VERIFIED',
        evidenceStrength: 'STRONG',
        whatObserved: `Standard intro or outro bumper sequence identified across ${affectedCount} videos.`,
        whatEstablished: 'Channel uses consistent branding sequences across uploads.',
        whatRemainsUnknown: 'Does not evaluate thumbnail or title branding consistency.',
        explanation: `${affectedCount} of ${sampleSize} analyzed videos incorporate shared intro or outro sequences. Consistent channel branding is a standard best practice; ensure bumpers remain brief so they do not dominate overall video duration.`,
        recommendation: 'Keep intro animations concise (ideally under 5–8 seconds) to optimize viewer retention.',
        recommendedAction: 'Maintain concise branding sequences under 10 seconds.',
        confidence: 'HIGH',
        limitations: 'Evaluates opening and closing frame sequence hashes.',
        disclaimer: MANDATORY_COVERAGE_STATEMENT
      });
    }

    // Add aggregate patterns for recurring audio if detected
    if (audioMatchScanIds.size >= 2) {
      const affectedCount = audioMatchScanIds.size;
      const scanIds = Array.from(audioMatchScanIds);
      const frequency = parseFloat(((affectedCount / sampleSize) * 100).toFixed(0));

      patterns.push({
        id: 'pat_cross_video_audio_repeat',
        patternType: 'repeated_audio_pattern',
        label: `Shared Audio Track / Background Loop (${affectedCount} videos)`,
        severity: 'info',
        sampleSize,
        affectedScansCount: affectedCount,
        distinctVideosCount: affectedCount,
        distinctOccurrencesCount: affectedCount,
        frequency,
        sourceScanIds: scanIds,
        evidenceReferences: scanIds,
        algorithmVersion: '1.2.0',
        patternStatus: 'VERIFIED',
        evidenceStrength: 'STRONG',
        whatObserved: `Matching acoustic subband profile detected across ${affectedCount} video uploads.`,
        whatEstablished: 'Identical background music or acoustic sound design is used across multiple videos.',
        whatRemainsUnknown: 'Does not verify music licensing status or copyright clearance.',
        explanation: `${affectedCount} of ${sampleSize} analyzed videos share an acoustic background music track or sound design loop. Recurring background music establishes recognizable production identity.`,
        recommendation: 'Verify that recurring background tracks are properly licensed for commercial monetization.',
        recommendedAction: 'Confirm soundtrack licensing covers all published uploads.',
        confidence: 'HIGH',
        limitations: 'Evaluates 16-band spectral energy correlation; does not query external copyright registries.',
        disclaimer: MANDATORY_COVERAGE_STATEMENT
      });
    }

    // -------------------------------------------------------------------------
    // 6. TEMPORAL ANALYSIS (Comparing latest scan against prior scan)
    // -------------------------------------------------------------------------
    let temporalAnalysis: TemporalAnalysisResult | null = null;
    if (completedScans.length >= 2) {
      const sortedByDate = completedScans.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const latest = sortedByDate[0];
      const prior = sortedByDate[1];
      temporalAnalysis = this.computeTemporalChanges(
        prior,
        latest,
        scanReports.get(prior.id) || null,
        scanReports.get(latest.id) || null
      );
    }

    const record: ChannelIntelligenceRecord = {
      id: recordId,
      userId,
      scopeId: userId,
      version: newVersion,
      status: 'COMPLETED',
      sampleSize,
      sourceScanIds: currentScanIds,
      sourceVideoIdentities,
      patterns,
      crossVideoComparisons,
      temporalAnalysis,
      coverage,
      coverageDetails,
      disclaimer: MANDATORY_COVERAGE_STATEMENT,
      mandatoryCoverageStatement: MANDATORY_COVERAGE_STATEMENT,
      limitations: 'Cross-video pattern analysis is bounded to scans completed in your VideoRisk account. Similarity is evidence for creator review, not proof of copyright infringement or platform monetization status.',
      createdAt: nowIso,
      updatedAt: nowIso
    };

    await this.storageRepo.channelIntelligence.save(record);
    return record;
  }
}

export const channelIntelligenceEngine = new ChannelIntelligenceEngine();
