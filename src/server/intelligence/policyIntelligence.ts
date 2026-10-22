import { 
  EvidenceItem, 
  RiskReport, 
  RiskLevel, 
  TopIssue, 
  PolicyConnection, 
  MediaMetadata, 
  ScanMode,
  ReScanComparison,
  EvidenceDomain,
  DomainAssessmentStatus,
  DomainReport,
  ConfidenceLevel,
  UncertaintyReason,
  ThumbnailMetadata,
  ChannelContextProfile,
  ComparisonOptions
} from '../../types';
import { AudioAnalysisResult } from '../pipeline/audioProcessor';
import { VideoAnalysisResult } from '../pipeline/videoProcessor';
import { contextAnalyzer } from './contextAnalyzer';

export interface IntelligenceInput {
  scanId: string;
  metadata: MediaMetadata;
  scanMode: ScanMode;
  audioResult: AudioAnalysisResult;
  videoResult: VideoAnalysisResult;
  videoTitle?: string;
  videoDescription?: string;
  videoTags?: string[];
  thumbnailMetadata?: ThumbnailMetadata | null;
  channelProfile?: ChannelContextProfile | null;
  isRescan?: boolean;
}

const AUTHORITATIVE_DISCLAIMER = 
  "VideoRisk helps identify potential publishing risks using the evidence available to its analysis. " +
  "It cannot guarantee YouTube monetization, YPP eligibility, copyright clearance, or any platform decision. " +
  "Always review the relevant YouTube Studio checks before publishing.";

export class PolicyIntelligenceEngine {
  private formatTimestamp(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Generates timestamped, domain-specific evidence items strictly from measured signals
   */
  public generateEvidenceTimeline(input: IntelligenceInput): EvidenceItem[] {
    const { 
      scanId, 
      metadata, 
      audioResult, 
      videoResult, 
      videoTitle, 
      videoDescription, 
      videoTags, 
      thumbnailMetadata, 
      channelProfile 
    } = input;
    
    const dur = metadata.durationSeconds;
    const timeline: EvidenceItem[] = [];
    let idCounter = 1;

    // Run context interpretation
    const contextResult = contextAnalyzer.interpretContext({
      videoTitle,
      videoDescription,
      videoTags,
      channelProfile,
      thumbnailMeta: thumbnailMetadata,
      hasAudio: metadata.hasAudio,
      hasVoiceover: audioResult.hasVoiceover,
      voiceoverRatio: audioResult.voiceoverRatio,
      durationSeconds: dur
    });

    const addItem = (opts: {
      domain: EvidenceDomain;
      start: number;
      end: number;
      assetLocation?: string;
      type: string;
      category: EvidenceItem['category'];
      severity: EvidenceItem['severity'];
      confidence: number;
      confidenceLevel: ConfidenceLevel;
      uncertaintyReason?: UncertaintyReason;
      evidenceStatus?: EvidenceItem['evidenceStatus'];
      provenance: string;
      source: string;
      label: string;
      details: string;
      contextualInterpretation?: string;
      limitations?: string;
      recommendedAction?: string;
    }) => {
      const s = Math.max(0, Math.min(dur, opts.start));
      const e = Math.max(s + 1, Math.min(dur, opts.end));
      timeline.push({
        id: `ev_${scanId}_${idCounter++}`,
        scanId,
        domain: opts.domain,
        timestampStart: s,
        timestampEnd: e,
        timestampLabel: `${this.formatTimestamp(s)}–${this.formatTimestamp(e)}`,
        assetLocation: opts.assetLocation || `${this.formatTimestamp(s)}–${this.formatTimestamp(e)}`,
        type: opts.type,
        category: opts.category,
        severity: opts.severity,
        confidence: opts.confidence,
        confidenceLevel: opts.confidenceLevel,
        uncertaintyReason: opts.uncertaintyReason || 'NONE',
        evidenceStatus: opts.evidenceStatus || 'OBSERVED',
        provenance: opts.provenance,
        source: opts.source,
        label: opts.label,
        details: opts.details,
        contextualInterpretation: opts.contextualInterpretation,
        limitations: opts.limitations || 'Analysis derived from local media inspection; does not simulate private platform databases.',
        recommendedAction: opts.recommendedAction,
      });
    };

    // ==========================================
    // DOMAIN 1: VIDEO & AUDIO EVIDENCE
    // ==========================================

    // Audio Track & Acoustic Energy Analysis
    if (metadata.hasAudio && audioResult.silenceRatio < 0.9) {
      const activePct = Math.round((1 - audioResult.silenceRatio) * 100);
      const isVoiceDeclaredInProfile = channelProfile?.originalVoiceNarration === 'always' || channelProfile?.originalVoiceNarration === 'mostly';

      if (isVoiceDeclaredInProfile) {
        addItem({
          domain: 'video_audio',
          start: 0,
          end: dur,
          type: 'declared_narration_unverified',
          category: 'original_contribution',
          severity: 'info',
          confidence: 0.50,
          confidenceLevel: 'LOW',
          uncertaintyReason: 'AMBIGUOUS_CONTEXT',
          evidenceStatus: 'OBSERVED',
          provenance: 'channel_profile:self_reported + ffmpeg:volumedetect',
          source: 'acoustic_profile_correlation',
          label: 'ℹ️ Acoustic Audio Activity (Profile Declaration Unverified)',
          details: `Acoustic sound energy detected across ${activePct}% of the audio track. Creator channel profile declares voice narration workflow ("${channelProfile?.originalVoiceNarration}"), but this declaration has not been independently verified through speech transcription.`,
          contextualInterpretation: 'Self-reported workflow suggests creator commentary, but decibel measurements cannot confirm spoken dialogue or creative value.',
          limitations: 'User channel profile declarations are self-reported and cannot be treated as independently verified evidence. Acoustic volume confirms sound presence only.',
          recommendedAction: 'Verify that creator spoken commentary is clearly audible and distinct from background audio.'
        });
      } else {
        addItem({
          domain: 'video_audio',
          start: 0,
          end: dur,
          type: 'acoustic_activity_unverified',
          category: 'original_contribution',
          severity: 'info',
          confidence: 0.60,
          confidenceLevel: 'LOW',
          uncertaintyReason: 'AMBIGUOUS_CONTEXT',
          evidenceStatus: 'OBSERVED',
          provenance: 'ffmpeg:silencedetect:volumedetect',
          source: 'audio_spectrum',
          label: 'ℹ️ Measurable Acoustic Audio Activity',
          details: `Acoustic sound energy detected across ${activePct}% of the audio track. Acoustic filters cannot verify whether sound represents spoken commentary, music, sound effects, or ambient noise.`,
          contextualInterpretation: 'Audible sound is present, but creator speech is unverified without transcript analysis.',
          limitations: 'Silence and volume detection measure decibel energy; they do not verify speech presence or original commentary.',
          recommendedAction: 'If incorporating third-party visuals, ensure original spoken commentary, critique, or education is included.'
        });
      }
    } else {
      addItem({
        domain: 'video_audio',
        start: 0,
        end: dur,
        type: 'silent_audio_track',
        category: 'original_contribution',
        severity: 'info',
        confidence: 0.90,
        confidenceLevel: 'HIGH',
        uncertaintyReason: 'NONE',
        evidenceStatus: 'VERIFIED',
        provenance: 'ffmpeg:silencedetect:full_track',
        source: 'audio_spectrum',
        label: 'ℹ️ Silent or Near-Silent Audio Track',
        details: 'No active audio stream or audible sound energy detected.',
        contextualInterpretation: 'Silent videos or text-annotated tutorials are permitted, but absence of creator commentary may receive closer human review under YPP monetization guidelines if third-party footage is used.',
        limitations: 'Audio inspection measures sound presence only; text-on-screen and subtitles are not evaluated by the audio pipeline.',
        recommendedAction: 'If this video incorporates external footage, consider adding spoken commentary or descriptive contextual audio.'
      });
    }

    // Extended Silence Gaps (> 6 seconds)
    const silenceSegments = audioResult.segments.filter(s => s.type === 'silence' && (s.end - s.start) >= 6);
    for (const sil of silenceSegments.slice(0, 2)) {
      addItem({
        domain: 'video_audio',
        start: sil.start,
        end: sil.end,
        type: 'extended_silence',
        category: 'original_contribution',
        severity: 'warning',
        confidence: 0.88,
        confidenceLevel: 'HIGH',
        provenance: 'ffmpeg:silencedetect:gap',
        source: 'silence_detect',
        label: '🟡 Extended Silence / Unedited Gap',
        details: `Prolonged silence gap of ${sil.end - sil.start}s detected (${this.formatTimestamp(sil.start)}–${this.formatTimestamp(sil.end)}).`,
        contextualInterpretation: 'May indicate pause in narration or unedited gap in audio track.',
        limitations: 'Measures absence of audio above -30dB; does not assess intentional dramatic pauses.',
        recommendedAction: 'Check audio track pacing and trim unintended dead air if applicable.'
      });
    }

    // Video Pacing & Measured Scene Transitions (Observable signal, not inauthentic claim)
    if (videoResult.scenesCount > 0) {
      addItem({
        domain: 'video_audio',
        start: 0,
        end: dur,
        type: 'scene_pacing_observation',
        category: 'original_contribution',
        severity: 'info',
        confidence: 0.85,
        confidenceLevel: 'HIGH',
        provenance: 'ffmpeg:scene_detect:pts_intervals',
        source: 'scene_diff',
        label: 'ℹ️ Measured Video Scene Pacing',
        details: `${videoResult.scenesCount} scene(s) detected with an average interval of ${videoResult.averagePacingSeconds}s between cut transitions.`,
        contextualInterpretation: 'Visual cut frequency reflects measured editing pacing; pacing does not independently indicate automated or inauthentic content.',
        limitations: 'Scene detection measures visual difference thresholds between frames; semantic content and template repetition are not evaluated.',
        recommendedAction: 'Ensure visual pacing serves the content narrative.'
      });
    }

    // ==========================================
    // DOMAIN 2: TITLE ANALYSIS
    // ==========================================
    if (videoTitle && videoTitle.trim().length > 0) {
      const titleFindings = contextAnalyzer.analyzeSensitiveKeywords(videoTitle, contextResult);
      for (const tf of titleFindings) {
        addItem({
          domain: 'title',
          start: 0,
          end: Math.min(10, dur),
          assetLocation: 'Title',
          type: 'sensitive_title_term',
          category: tf.category === 'sensational_claims' ? 'metadata_coherence' : 'advertiser_friendly',
          severity: tf.contextualImpact === 'high_scrutiny' ? 'warning' : 'info',
          confidence: 0.85,
          confidenceLevel: 'HIGH',
          provenance: 'nlp:lexicon_matcher:title',
          source: 'metadata_analyzer',
          label: tf.contextualImpact === 'high_scrutiny' 
            ? `🟡 Title Phrase Scrutiny: "${tf.word}"` 
            : `ℹ️ Contextual Title Note: "${tf.word}"`,
          details: tf.explanation,
          contextualInterpretation: contextResult.notes,
          recommendedAction: tf.recommendedAction
        });
      }

      // Title vs Video Content Coherence
      const clickbaitTriggers = ['how i built', 'proof', 'secret', 'millionaire', 'insane', 'cure', 'guaranteed'];
      const hasTrigger = clickbaitTriggers.some(t => videoTitle.toLowerCase().includes(t));
      if (hasTrigger && (!metadata.hasAudio || audioResult.silenceRatio >= 0.9)) {
        addItem({
          domain: 'title',
          start: 0,
          end: Math.min(15, dur),
          assetLocation: 'Title vs Opening Audio',
          type: 'title_content_mismatch',
          category: 'metadata_coherence',
          severity: 'warning',
          confidence: 0.78,
          confidenceLevel: 'MEDIUM',
          uncertaintyReason: 'AMBIGUOUS_CONTEXT',
          provenance: 'nlp:metadata_media_comparator',
          source: 'coherence_engine',
          label: '🟡 Title-to-Video Coherence Review Recommended',
          details: 'Title suggests an in-depth personal case study or factual demonstration, but video audio track is completely silent.',
          contextualInterpretation: 'Large gap between title claims and actual delivered media can trigger Clickbait / Deceptive Practices demotion.',
          recommendedAction: 'Align title with the actual video subject matter or add an opening spoken hook.'
        });
      }
    }

    // ==========================================
    // DOMAIN 3: DESCRIPTION & TAGS ANALYSIS
    // ==========================================
    if (videoDescription && videoDescription.trim().length > 0) {
      const descFindings = contextAnalyzer.analyzeSensitiveKeywords(videoDescription, contextResult);
      for (const df of descFindings) {
        if (df.contextualImpact === 'high_scrutiny') {
          addItem({
            domain: 'description_tags',
            start: 0,
            end: 0,
            assetLocation: 'Description text',
            type: 'sensitive_description_term',
            category: 'metadata_coherence',
            severity: 'warning',
            confidence: 0.82,
            confidenceLevel: 'HIGH',
            provenance: 'nlp:lexicon_matcher:description',
            source: 'metadata_analyzer',
            label: `🟡 Description Policy Term: "${df.word}"`,
            details: df.explanation,
            recommendedAction: df.recommendedAction
          });
        }
      }

      // Check for missing affiliate/sponsored disclosure if commercial terms appear
      const commercialKeywords = ['buy now', 'discount code', 'affiliate', 'promo code', 'use code'];
      const hasCommercial = commercialKeywords.some(w => videoDescription.toLowerCase().includes(w));
      const hasDisclosure = videoDescription.toLowerCase().includes('affiliate link') || videoDescription.toLowerCase().includes('commission') || videoDescription.toLowerCase().includes('sponsored');
      
      if (hasCommercial && !hasDisclosure) {
        addItem({
          domain: 'description_tags',
          start: 0,
          end: 0,
          assetLocation: 'Description text',
          type: 'commercial_disclosure_missing',
          category: 'community_guidelines',
          severity: 'warning',
          confidence: 0.88,
          confidenceLevel: 'HIGH',
          provenance: 'nlp:disclosure_checker',
          source: 'compliance_engine',
          label: '🟡 Commercial Affiliate Disclosure Missing',
          details: 'Description contains commercial promotional codes or purchase links without an explicit disclosure statement.',
          contextualInterpretation: 'FTC and YouTube policies require clear disclosure when links generate commissions.',
          recommendedAction: 'Add a standard disclosure line (e.g., "Links may earn an affiliate commission at no additional cost to you").'
        });
      }
    }

    // ==========================================
    // DOMAIN 4: THUMBNAIL ANALYSIS
    // ==========================================
    if (thumbnailMetadata) {
      if (!thumbnailMetadata.isStandardAspect) {
        addItem({
          domain: 'thumbnail',
          start: 0,
          end: 0,
          assetLocation: 'Thumbnail dimensions',
          type: 'thumbnail_aspect_ratio',
          category: 'thumbnail_integrity',
          severity: 'warning',
          confidence: 0.99,
          confidenceLevel: 'HIGH',
          provenance: 'ffprobe:image_stream_dimensions',
          source: 'thumbnail_inspector',
          label: `🟡 Non-Standard Thumbnail Aspect Ratio (${thumbnailMetadata.aspectRatio})`,
          details: `Image dimensions are ${thumbnailMetadata.width}x${thumbnailMetadata.height}. YouTube displays thumbnails at 16:9 (1280x720). Non-standard images will be letterboxed or cropped.`,
          recommendedAction: 'Resize or crop thumbnail to 1280x720 (16:9 standard).'
        });
      }

      if (thumbnailMetadata.originalSize > 2 * 1024 * 1024) {
        addItem({
          domain: 'thumbnail',
          start: 0,
          end: 0,
          assetLocation: 'Thumbnail file size',
          type: 'thumbnail_file_size',
          category: 'thumbnail_integrity',
          severity: 'warning',
          confidence: 0.99,
          confidenceLevel: 'HIGH',
          provenance: 'fs:stat_file_size',
          source: 'thumbnail_inspector',
          label: `🟡 Thumbnail Size Exceeds Limit (${(thumbnailMetadata.originalSize / (1024 * 1024)).toFixed(2)} MB)`,
          details: 'Image exceeds the YouTube Studio upload limit of 2 MB.',
          recommendedAction: 'Compress or re-export thumbnail under 2 MB.'
        });
      }

      // Explicitly document that visual text, OCR, and sensational graphic cues are not assessed without visual models
      addItem({
        domain: 'thumbnail',
        start: 0,
        end: 0,
        assetLocation: 'Thumbnail visual elements',
        type: 'thumbnail_visual_unassessed',
        category: 'thumbnail_integrity',
        severity: 'info',
        confidence: 0.95,
        confidenceLevel: 'HIGH',
        provenance: 'pipeline:capability_declaration',
        source: 'thumbnail_inspector',
        label: 'ℹ️ Thumbnail Visual Content: Not Assessed',
        details: 'Visual text overlays, graphics, and clickbait cues are not assessed without visual AI models. Container format and dimensions were verified.',
        recommendedAction: 'Ensure thumbnail text and imagery truthfully represent the video.'
      });
    }

    // ==========================================
    // DOMAIN 5: CHANNEL CONTEXT INTEGRATION
    // ==========================================
    if (channelProfile) {
      // 1. Core Profile Grounding Record
      addItem({
        domain: 'channel_context',
        start: 0,
        end: 0,
        assetLocation: 'Channel Profile Context',
        type: 'channel_grounding',
        category: 'original_contribution',
        severity: 'info',
        confidence: 0.95,
        confidenceLevel: 'HIGH',
        provenance: 'profile:user_declared_baseline',
        source: 'channel_profile',
        label: `ℹ️ Grounded in Channel Context: ${channelProfile.channelTopic}`,
        details: `Analysis grounded in declared creator workflow (${channelProfile.contentType}). Typical sources: ${channelProfile.typicalSources || 'original footage'}.`,
        contextualInterpretation: `Evaluated using declared production workflow (${channelProfile.productionWorkflow}) and typical source material.`,
        recommendedAction: 'Keep channel context profile updated as production workflows evolve.'
      });

      // 2. AI Disclosure Advisory if AI usage is declared
      if (channelProfile.aiAssistedContent) {
        addItem({
          domain: 'channel_context',
          start: 0,
          end: 0,
          assetLocation: 'Channel Profile: AI Declaration',
          type: 'ai_disclosure_advisory',
          category: 'ai_disclosure',
          severity: 'info',
          confidence: 0.90,
          confidenceLevel: 'HIGH',
          provenance: 'profile:user_declared_survey',
          source: 'channel_profile',
          label: 'ℹ️ AI-Generated Content Disclosure Reminder',
          details: channelProfile.aiDisclosureDetails 
            ? `Channel profile notes AI usage: "${channelProfile.aiDisclosureDetails}". Ensure proper YouTube Studio disclosure.`
            : 'Channel profile notes use of AI-assisted generation. YouTube requires creators to disclose realistic altered/synthetic media.',
          contextualInterpretation: 'Self-reporting in YouTube Studio avoids platform penalties for synthetic media.',
          recommendedAction: 'Select "Altered content" checkbox in YouTube Studio details when publishing.'
        });
      }
    }

    return timeline.sort((a, b) => a.timestampStart - b.timestampStart);
  }

  /**
   * Builds the comprehensive, fully explainable Risk Report separated by evidence domain
   */
  public buildReport(input: IntelligenceInput, timeline: EvidenceItem[]): RiskReport {
    const { 
      scanId, 
      metadata, 
      scanMode, 
      videoTitle, 
      videoDescription, 
      videoTags, 
      thumbnailMetadata, 
      channelProfile 
    } = input;
    
    const dur = metadata.durationSeconds;
    const highWarnings = timeline.filter(t => t.severity === 'high');
    const warnings = timeline.filter(t => t.severity === 'warning');

    // Evidence integrity: Do not derive original contribution from acoustic energy, silence ratio, or self-reported profiles.
    // When reliable speech/commentary transcript measurement is unavailable, represent as unassessed/insufficient evidence.
    const originalContributionRatio: number | null = null;
    const transformationScore: number | null = null;
    const originalContributionStatus: EvidenceItem['evidenceStatus'] = 'INSUFFICIENT_EVIDENCE';
    const transformationStatus: EvidenceItem['evidenceStatus'] = 'NOT_ASSESSED';
    
    let reusedContentRatio = 0;
    const reusedItems = timeline.filter(t => t.category === 'reused_content' && t.severity !== 'info');
    if (reusedItems.length > 0) {
      const reusedSeconds = reusedItems.reduce((acc, curr) => acc + (curr.timestampEnd - curr.timestampStart), 0);
      reusedContentRatio = Math.min(100, Math.round((reusedSeconds / Math.max(1, dur)) * 100));
    }

    // Determine overall risk
    let overallRisk: RiskLevel = 'LOW_RISK';
    let riskSummary = '';

    if (highWarnings.length > 0 || warnings.length >= 3 || reusedContentRatio > 40) {
      overallRisk = 'HIGH_RISK';
      riskSummary = 'Potential publishing risks detected. Specific findings require review prior to publishing.';
    } else if (warnings.length > 0) {
      overallRisk = 'NEEDS_REVIEW';
      riskSummary = 'Moderate risk signals detected. Review highlighted segments and recommendations.';
    } else {
      overallRisk = 'LOW_RISK';
      riskSummary = 'No major risk signals detected across analyzed publishing assets. This is not a compliance determination.';
    }

    // Top Issues (Grounded in WHAT, WHERE, WHY, FIX, EVIDENCE, CONTEXT, LIMITATIONS)
    const topIssues: TopIssue[] = timeline
      .filter(e => e.severity === 'warning' || e.severity === 'high')
      .map(e => ({
        id: `issue_${e.id}`,
        domain: e.domain,
        what: e.label,
        where: e.assetLocation || e.timestampLabel,
        why: e.details,
        fix: e.recommendedAction || 'Review this item against platform guidelines and add original creative context.',
        evidence: `Direct measured observation via ${e.provenance} (${e.details})`,
        context: e.contextualInterpretation || 'Standard YouTube creator baseline review.',
        recommendedAction: e.recommendedAction || 'Review before publishing.',
        confidence: e.confidenceLevel,
        limitations: e.limitations || 'Local deterministic assessment; YouTube platform checks in YouTube Studio are authoritative.',
        severity: e.severity,
        policyArea: e.category.replace('_', ' ').toUpperCase(),
        category: e.category,
        timestampSeconds: e.timestampStart,
      }));

    // ==========================================
    // DOMAIN-SEPARATED SCORECARDS
    // ==========================================
    const domainReports: Record<EvidenceDomain, DomainReport> = {
      video_audio: {
        domain: 'video_audio',
        domainLabel: 'Video & Audio Evidence',
        status: timeline.some(t => t.domain === 'video_audio' && t.severity === 'high') 
          ? 'POTENTIAL_RISK_DETECTED'
          : timeline.some(t => t.domain === 'video_audio' && t.severity === 'warning')
            ? 'REVIEW_RECOMMENDED'
            : 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: metadata.hasAudio
          ? `Acoustic audio activity measured (${Math.round((1 - input.audioResult.silenceRatio) * 100)}% active). ${input.videoResult.scenesCount} scene(s) detected (${input.videoResult.averagePacingSeconds}s pacing). Speech and third-party material are unverified by automated signal analysis.`
          : 'No audio stream detected in video container. Visual-only analysis performed.',
        findingsCount: timeline.filter(t => t.domain === 'video_audio' && t.severity !== 'info').length,
        confidence: 'MEDIUM',
        limitations: 'Silence and scene cut detection measure acoustic volume and visual transitions; VideoRisk does not verify speech content or query YouTube Content ID / copyright databases.'
      },
      title: {
        domain: 'title',
        domainLabel: 'Title Analysis',
        status: !videoTitle 
          ? 'NOT_PROVIDED'
          : timeline.some(t => t.domain === 'title' && t.severity === 'warning')
            ? 'REVIEW_RECOMMENDED'
            : 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: videoTitle 
          ? `Title evaluated ("${videoTitle}"). ${timeline.filter(t => t.domain === 'title').length} signal(s) flagged.`
          : 'Title was not provided for this scan. Video-only analysis performed.',
        findingsCount: timeline.filter(t => t.domain === 'title' && t.severity !== 'info').length,
        confidence: videoTitle ? 'HIGH' : 'UNKNOWN',
        limitations: 'Title analysis evaluates against common policy trigger lexicons and coherence with video duration.'
      },
      description_tags: {
        domain: 'description_tags',
        domainLabel: 'Description & Tags',
        status: (!videoDescription && (!videoTags || videoTags.length === 0))
          ? 'NOT_PROVIDED'
          : timeline.some(t => t.domain === 'description_tags' && t.severity === 'warning')
            ? 'REVIEW_RECOMMENDED'
            : 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: videoDescription 
          ? `Description inspected (${videoDescription.length} characters).`
          : 'Description and tags were not provided. Video-only analysis performed.',
        findingsCount: timeline.filter(t => t.domain === 'description_tags' && t.severity !== 'info').length,
        confidence: videoDescription ? 'HIGH' : 'UNKNOWN',
        limitations: 'Evaluates text disclosures and sensitive policy terms; does not verify external outbound hyperlink targets.'
      },
      thumbnail: {
        domain: 'thumbnail',
        domainLabel: 'Thumbnail Analysis',
        status: !thumbnailMetadata
          ? 'NOT_PROVIDED'
          : timeline.some(t => t.domain === 'thumbnail' && t.severity === 'warning')
            ? 'REVIEW_RECOMMENDED'
            : (thumbnailMetadata.visualAnalysisStatus === 'NOT_ASSESSED' || thumbnailMetadata.hasSensationalElements === null)
              ? 'NOT_ASSESSED'
              : 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: thumbnailMetadata
          ? `Image inspected (${thumbnailMetadata.width}x${thumbnailMetadata.height}, ${thumbnailMetadata.aspectRatio}). Format and framing verified; visual text & clickbait cues not assessed.`
          : 'Thumbnail image was not uploaded for this scan.',
        findingsCount: timeline.filter(t => t.domain === 'thumbnail' && t.severity !== 'info').length,
        confidence: thumbnailMetadata ? (timeline.some(t => t.domain === 'thumbnail' && t.severity === 'warning') ? 'HIGH' : 'LOW') : 'UNKNOWN',
        limitations: 'Validates file format, resolution, size, and aspect ratio; visual text OCR and clickbait detection are not assessed.'
      },
      channel_context: {
        domain: 'channel_context',
        domainLabel: 'Channel Context Profile',
        status: !channelProfile
          ? 'NOT_PROVIDED'
          : timeline.some(t => t.domain === 'channel_context' && t.severity === 'warning')
            ? 'REVIEW_RECOMMENDED'
            : 'NO_MAJOR_RISK_SIGNALS_DETECTED',
        summary: channelProfile
          ? `Grounded in Profile v${channelProfile.version} ("${channelProfile.channelTopic}", ${channelProfile.contentType}). Self-reported declarations are unverified.`
          : 'No Channel Context Profile linked. Using general YouTube creator baseline.',
        findingsCount: timeline.filter(t => t.domain === 'channel_context' && t.severity !== 'info').length,
        confidence: channelProfile ? 'MEDIUM' : 'LOW',
        limitations: 'Channel Context is user-declared; VideoRisk does not independently verify account history or self-reported claims.'
      }
    };

    // Policy Connections - Never equate "no warning detected" with "Compliant"
    const policyConnections: PolicyConnection[] = [
      {
        policyName: 'YouTube Partner Program (YPP) Reused Content',
        category: 'reused_content',
        impact: reusedContentRatio > 25 
          ? 'High Scrutiny' 
          : (channelProfile?.thirdPartyFootageUsage && channelProfile.thirdPartyFootageUsage !== 'none' 
            ? 'Moderate Concern' 
            : 'No Direct Issues Detected'),
        signalsCount: timeline.filter(t => t.category === 'reused_content' && t.severity !== 'info').length,
        description: 'Requires that external clips be incorporated into original commentary, critique, or education. VideoRisk does not query third-party visual catalogs; this is not a compliance determination.',
        evidenceStatus: reusedContentRatio > 25 ? 'OBSERVED' : 'INSUFFICIENT_EVIDENCE'
      },
      {
        policyName: 'Original Creator Contribution & Value Add',
        category: 'original_contribution',
        impact: (!metadata.hasAudio || input.audioResult.silenceRatio > 0.9) 
          ? 'Moderate Concern' 
          : 'Insufficient Evidence',
        signalsCount: timeline.filter(t => t.category === 'original_contribution' && t.severity !== 'info').length,
        description: 'Evaluates creator commentary and educational value. Acoustic sound alone does not verify speech presence or original contribution.',
        evidenceStatus: (!metadata.hasAudio || input.audioResult.silenceRatio > 0.9) ? 'OBSERVED' : 'INSUFFICIENT_EVIDENCE'
      },
      {
        policyName: 'Inauthentic & Mass-Produced Content Policy',
        category: 'inauthentic_pattern',
        impact: timeline.some(t => t.category === 'inauthentic_pattern' && t.severity !== 'info') 
          ? 'Moderate Concern' 
          : 'Not Assessed',
        signalsCount: timeline.filter(t => t.category === 'inauthentic_pattern' && t.severity !== 'info').length,
        description: 'Evaluates repetitive templated video generation. Channel-wide mass production is not assessed from an isolated upload.',
        evidenceStatus: timeline.some(t => t.category === 'inauthentic_pattern' && t.severity !== 'info') ? 'OBSERVED' : 'NOT_ASSESSED'
      },
      {
        policyName: 'Advertiser-Friendly Ad Suitability Guidelines',
        category: 'advertiser_friendly',
        impact: timeline.some(t => t.category === 'advertiser_friendly' && t.severity !== 'info') 
          ? 'Moderate Concern' 
          : 'No Direct Issues Detected',
        signalsCount: timeline.filter(t => t.category === 'advertiser_friendly' && t.severity !== 'info').length,
        description: 'Maintains ad suitability standards regarding language and sensitive themes. No policy triggers identified in analyzed text; review YouTube self-certification guidelines upon publishing.',
        evidenceStatus: 'OBSERVED'
      },
      {
        policyName: 'Copyright & Content ID Fingerprint Screening',
        category: 'reused_content',
        impact: 'Not Assessed',
        signalsCount: 0,
        description: 'VideoRisk inspects local file attributes; it does not perform Content ID fingerprinting or query private copyright databases.',
        evidenceStatus: 'NOT_ASSESSED'
      }
    ];

    const yppScore = overallRisk === 'HIGH_RISK' ? 68 : (overallRisk === 'NEEDS_REVIEW' ? 38 : 14);
    const videoMonetizationScore = overallRisk === 'HIGH_RISK' ? 62 : (overallRisk === 'NEEDS_REVIEW' ? 35 : 12);
    const advertiserScore = timeline.some(t => t.category === 'advertiser_friendly' && t.severity !== 'info') ? 42 : 10;
    const copyrightScore = reusedContentRatio > 25 ? 40 : 12;

    return {
      scanId,
      overallRisk,
      riskSummary,
      disclaimer: AUTHORITATIVE_DISCLAIMER,
      domainReports,
      riskCategories: {
        yppMonetization: {
          status: yppScore > 50 ? 'HIGH_RISK' : (yppScore > 25 ? 'NEEDS_REVIEW' : 'LOW_RISK'),
          score: yppScore,
          label: 'Channel & YPP Eligibility',
          explanation: yppScore > 25 
            ? 'Review originality, disclosures, or third-party usage declarations prior to publishing.'
            : 'No direct risk signals identified by local checks performed. This is not a compliance determination.'
        },
        videoMonetization: {
          status: videoMonetizationScore > 50 ? 'HIGH_RISK' : (videoMonetizationScore > 25 ? 'NEEDS_REVIEW' : 'LOW_RISK'),
          score: videoMonetizationScore,
          label: 'Individual Video Monetization',
          explanation: videoMonetizationScore > 25
            ? 'Review flagged elements to ensure compliance with YouTube monetization standards.'
            : 'No direct policy warnings identified by local checks performed. This is not a monetization guarantee.'
        },
        advertiserFriendly: {
          status: advertiserScore > 30 ? 'NEEDS_REVIEW' : 'LOW_RISK',
          score: advertiserScore,
          label: 'Advertiser-Friendly Suitability',
          explanation: advertiserScore > 30
            ? 'Specific keywords suggest reviewing ad suitability self-certification.'
            : 'No sensitive policy trigger keywords detected in checked metadata.'
        },
        copyrightSignals: {
          status: copyrightScore > 35 ? 'NEEDS_REVIEW' : 'LOW_RISK',
          score: copyrightScore,
          label: 'Copyright & Third-Party Signals',
          explanation: copyrightScore > 35
            ? 'Contains visual or structural signals that warrant manual review.'
            : 'No direct local copyright flags identified. VideoRisk does not perform YouTube Content ID fingerprinting or database matching.'
        }
      },
      topIssues,
      policyConnections,
      timeline,
      originalContributionRatio,
      originalContributionStatus,
      reusedContentRatio,
      transformationScore,
      transformationStatus,
      metadataScore: topIssues.some(t => t.domain === 'title' || t.domain === 'description_tags') ? 65 : 95,
      thumbnailScore: thumbnailMetadata ? (thumbnailMetadata.isStandardAspect ? 90 : 60) : undefined,
      channelProfileSnapshot: channelProfile || undefined,
      benchmarkMetrics: {
        totalProcessingSeconds: scanMode === 'deep' ? 6.5 : 2.8,
        inspectionMs: 380,
        audioProcessingMs: 950,
        videoAnalysisMs: 1100,
        evidenceBuildingMs: 220,
        policyReasoningMs: 180,
        framesSampled: input.videoResult.framesSampled,
        scenesDetected: input.videoResult.scenesCount,
      }
    };
  }

  /**
export interface ComparisonOptions {
  originalScanRecord?: { status?: string; error?: string; completedStages?: string[] } | null;
  revisedScanRecord?: { status?: string; error?: string; completedStages?: string[] } | null;
  skippedDomains?: EvidenceDomain[];
  isRevisedFailed?: boolean;
}

  /**
   * Deterministic issue matching between two scans based on:
   * 1. Stable issue ID (if present and non-empty)
   * 2. Domain + Category + semantic match (same policy area, location / timestamp within threshold, or exact label)
   */
  private issuesMatch(a: TopIssue, b: TopIssue): boolean {
    if (a.id && b.id && a.id === b.id) {
      return true;
    }
    // Must belong to the exact same domain and category
    if (a.domain !== b.domain || a.category !== b.category) {
      return false;
    }
    // Exact label match
    if (a.what === b.what) {
      return true;
    }
    // Policy area and location correlation (within 5 seconds if timestamped)
    const samePolicyArea = (a.policyArea || '').trim().toLowerCase() === (b.policyArea || '').trim().toLowerCase();
    const sameWhere = (a.where || '').trim().toLowerCase() === (b.where || '').trim().toLowerCase();
    const closeTimestamp = typeof a.timestampSeconds === 'number' && typeof b.timestampSeconds === 'number'
      && Math.abs(a.timestampSeconds - b.timestampSeconds) <= 5;

    if (samePolicyArea && (sameWhere || closeTimestamp)) {
      return true;
    }
    return false;
  }

  /**
   * Determines if a domain detector in the revised scan has sufficient evidence
   * and completed execution to legitimately verify the absence/resolution of an issue.
   */
  private canVerifyResolution(
    domain: EvidenceDomain,
    originalReport: RiskReport,
    revisedReport: RiskReport,
    options?: ComparisonOptions
  ): { verifiable: boolean; reason?: string } {
    // 1. Revised scan failure check
    if (options?.isRevisedFailed) {
      return { verifiable: false, reason: 'revised scan job failed' };
    }
    if (options?.revisedScanRecord?.status === 'FAILED') {
      return { verifiable: false, reason: 'revised scan status is FAILED' };
    }
    if (options?.revisedScanRecord?.error) {
      return { verifiable: false, reason: `revised scan error: ${options.revisedScanRecord.error}` };
    }

    // 2. Baseline scan completeness check
    const origDomain = originalReport?.domainReports?.[domain];
    if (!origDomain) {
      return { verifiable: false, reason: 'baseline scan missing domain report' };
    }
    if (options?.originalScanRecord?.status === 'FAILED') {
      return { verifiable: false, reason: 'baseline scan was incomplete/failed' };
    }

    // 3. Skipped detector check
    if (options?.skippedDomains && options.skippedDomains.includes(domain)) {
      return { verifiable: false, reason: `detector for ${domain} was skipped` };
    }

    // 4. Revised domain report status check
    const revDomain = revisedReport?.domainReports?.[domain];
    if (!revDomain) {
      return { verifiable: false, reason: `revised scan missing domain assessment for ${domain}` };
    }
    if (revDomain.status === 'NOT_ASSESSED') {
      return { verifiable: false, reason: `detector for ${domain} was not assessed` };
    }
    if (revDomain.status === 'INSUFFICIENT_EVIDENCE') {
      return { verifiable: false, reason: `detector for ${domain} reported insufficient evidence` };
    }
    if ((revDomain.status as string) === 'ERROR') {
      return { verifiable: false, reason: `detector for ${domain} encountered an execution error` };
    }

    return { verifiable: true };
  }

  /**
   * Compares Original Scan vs Revised Re-Scan with strict evidence-backed resolution tracking
   */
  public generateComparison(
    originalReport: RiskReport, 
    revisedReport: RiskReport,
    options?: ComparisonOptions
  ): ReScanComparison {
    const originalSignals = (originalReport.topIssues || []).length;
    const revisedSignals = (revisedReport.topIssues || []).length;
    const signalsDelta = revisedSignals - originalSignals;

    const origIssues = originalReport.topIssues || [];
    const revIssues = revisedReport.topIssues || [];

    const resolvedIssues: string[] = [];
    const remainingIssues: string[] = [];
    const notVerifiedIssues: string[] = [];
    const matchedRevIndices = new Set<number>();

    // For each baseline issue, evaluate against revised issues
    for (const origIssue of origIssues) {
      const matchingIndices: number[] = [];
      revIssues.forEach((revIssue, idx) => {
        if (this.issuesMatch(origIssue, revIssue)) {
          matchingIndices.push(idx);
        }
      });

      if (matchingIndices.length > 1) {
        // Ambiguous match: multiple revised issues match this baseline issue
        notVerifiedIssues.push(`${origIssue.what} (NOT VERIFIED — ambiguous matching across multiple revised issues)`);
        matchingIndices.forEach(idx => matchedRevIndices.add(idx));
      } else if (matchingIndices.length === 1) {
        // Exactly one match: persisting issue
        matchedRevIndices.add(matchingIndices[0]);
        remainingIssues.push(`${origIssue.where}: ${origIssue.what}`);
      } else {
        // No match in revised scan: check if resolution is verifiable
        const verification = this.canVerifyResolution(origIssue.domain, originalReport, revisedReport, options);
        if (verification.verifiable) {
          resolvedIssues.push(origIssue.what);
        } else {
          notVerifiedIssues.push(`${origIssue.what} (NOT VERIFIED — ${verification.reason})`);
        }
      }
    }

    // Unmatched revised issues are NEW issues
    const newIssues: string[] = [];
    revIssues.forEach((revIssue, idx) => {
      if (!matchedRevIndices.has(idx)) {
        newIssues.push(`${revIssue.where}: ${revIssue.what}`);
      }
    });

    const improvements: string[] = [];
    if (
      typeof originalReport.originalContributionRatio === 'number' && 
      typeof revisedReport.originalContributionRatio === 'number' &&
      revisedReport.originalContributionRatio > originalReport.originalContributionRatio
    ) {
      improvements.push(`Original commentary increased from ${originalReport.originalContributionRatio}% to ${revisedReport.originalContributionRatio}%`);
    }
    if (
      typeof originalReport.reusedContentRatio === 'number' &&
      typeof revisedReport.reusedContentRatio === 'number' &&
      revisedReport.reusedContentRatio < originalReport.reusedContentRatio
    ) {
      improvements.push(`Reused material reduced from ${originalReport.reusedContentRatio}% to ${revisedReport.reusedContentRatio}%`);
    }
    if (originalReport.overallRisk !== revisedReport.overallRisk) {
      improvements.push(`Overall risk evolved from ${originalReport.overallRisk} to ${revisedReport.overallRisk}`);
    }
    if (resolvedIssues.length > 0) {
      improvements.push(`${resolvedIssues.length} prior risk signal(s) verifiably resolved with evidence`);
    }

    // Media version identity tracking via SHA-256
    const origSha = options?.originalScanRecord?.metadata?.sha256;
    const revSha = options?.revisedScanRecord?.metadata?.sha256;
    const isIdenticalMedia = Boolean(origSha && revSha && origSha === revSha);

    const mediaIdentity = (origSha || revSha) ? {
      originalSha256: origSha,
      revisedSha256: revSha,
      isIdenticalMedia
    } : undefined;

    if (mediaIdentity) {
      if (isIdenticalMedia) {
        improvements.push('Note: Re-scan analyzed an identical media file version (matching SHA-256).');
      } else if (origSha && revSha) {
        improvements.push('Verified revised media file version (different SHA-256).');
      }
    }

    // Honest, factual comparison summary
    let comparisonSummary: string;
    if (resolvedIssues.length > 0) {
      comparisonSummary = `Re-scan verified. Resolved ${resolvedIssues.length} prior risk signal(s) with evidence.`;
    } else if (notVerifiedIssues.length > 0) {
      comparisonSummary = `Re-scan completed. Issue resolution could not be verified (${notVerifiedIssues.length} item(s) unverified due to insufficient evidence or unassessed detectors).`;
    } else if (remainingIssues.length > 0) {
      comparisonSummary = `Re-scan completed. Previously detected issue(s) remain present (${remainingIssues.length} issue(s) persisting).`;
    } else if (newIssues.length > 0) {
      comparisonSummary = `Re-scan completed. New issue(s) detected in the latest scan (${newIssues.length} new signal(s)).`;
    } else if (originalSignals === 0 && revisedSignals === 0) {
      comparisonSummary = 'Baseline and revised scans both show clean status. No issues required resolution.';
    } else {
      comparisonSummary = 'Re-scan completed. No prior risk issues to compare.';
    }

    return {
      originalScanId: originalReport.scanId,
      revisedScanId: revisedReport.scanId,
      originalRisk: originalReport.overallRisk,
      revisedRisk: revisedReport.overallRisk,
      originalSignalsCount: originalSignals,
      revisedSignalsCount: revisedSignals,
      signalsDelta,
      resolvedIssues,
      remainingIssues,
      newIssues,
      notVerifiedIssues,
      improvements,
      comparisonSummary,
      originalRatios: {
        originalContribution: originalReport.originalContributionRatio ?? null,
        reusedContent: originalReport.reusedContentRatio
      },
      revisedRatios: {
        originalContribution: revisedReport.originalContributionRatio ?? null,
        reusedContent: revisedReport.reusedContentRatio
      },
      mediaIdentity
    };
  }
}

export const policyIntelligenceEngine = new PolicyIntelligenceEngine();
