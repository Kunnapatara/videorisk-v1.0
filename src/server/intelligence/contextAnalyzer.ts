import { 
  EvidenceDomain,
  ConfidenceLevel, 
  UncertaintyReason,
  ChannelContextProfile,
  ThumbnailMetadata
} from '../../types';

export interface ContextAnalysisInput {
  videoTitle?: string;
  videoDescription?: string;
  videoTags?: string[];
  channelProfile?: ChannelContextProfile | null;
  thumbnailMeta?: ThumbnailMetadata | null;
  hasAudio: boolean;
  hasVoiceover: boolean;
  voiceoverRatio: number;
  durationSeconds: number;
}

export interface ContextInterpretationResult {
  primaryContext: string;
  isEducationalOrDocumentary: boolean;
  isCommentaryOrCritique: boolean;
  isGamingOrCreative: boolean;
  isSatireOrPerformance: boolean;
  contextConfidence: ConfidenceLevel;
  uncertaintyReason: UncertaintyReason;
  notes: string;
}

export interface SensitiveKeywordFinding {
  word: string;
  category: 'controversial_issues' | 'sensitive_terms' | 'sensational_claims' | 'exaggerated_guarantee';
  contextualImpact: 'permissible_in_context' | 'needs_contextual_review' | 'high_scrutiny';
  explanation: string;
  recommendedAction: string;
}

export class ContextAnalyzer {
  private sensitiveLexicon: Array<{
    term: string;
    category: SensitiveKeywordFinding['category'];
    baseSeverity: 'warning' | 'high';
    contextPermitted: string[]; // contexts where the word is typically educational/documentary
  }> = [
    { term: 'kill', category: 'sensitive_terms', baseSeverity: 'high', contextPermitted: ['documentary', 'news', 'gaming', 'educational'] },
    { term: 'murder', category: 'sensitive_terms', baseSeverity: 'high', contextPermitted: ['documentary', 'news', 'educational'] },
    { term: 'death', category: 'sensitive_terms', baseSeverity: 'warning', contextPermitted: ['documentary', 'news', 'educational'] },
    { term: 'war', category: 'controversial_issues', baseSeverity: 'warning', contextPermitted: ['documentary', 'news', 'educational', 'gaming'] },
    { term: 'attack', category: 'sensitive_terms', baseSeverity: 'warning', contextPermitted: ['news', 'gaming', 'educational'] },
    { term: 'guaranteed', category: 'exaggerated_guarantee', baseSeverity: 'warning', contextPermitted: [] },
    { term: '100% cure', category: 'sensational_claims', baseSeverity: 'high', contextPermitted: [] },
    { term: 'get rich quick', category: 'sensational_claims', baseSeverity: 'high', contextPermitted: [] },
    { term: 'secret trick', category: 'sensational_claims', baseSeverity: 'warning', contextPermitted: ['satire', 'commentary'] },
    { term: 'insane money', category: 'sensational_claims', baseSeverity: 'warning', contextPermitted: [] },
  ];

  /**
   * Evaluates contextual framing from channel profile, title, and metadata
   */
  public interpretContext(input: ContextAnalysisInput): ContextInterpretationResult {
    const profile = input.channelProfile;
    const title = (input.videoTitle || '').toLowerCase();
    const desc = (input.videoDescription || '').toLowerCase();
    const combinedText = `${title} ${desc}`;

    let primaryContext = profile?.contentType || 'mixed';
    let contextConfidence: ConfidenceLevel = profile ? 'HIGH' : 'MEDIUM';
    let uncertaintyReason: UncertaintyReason = 'NONE';

    // Heuristic detection from metadata if profile is not provided
    if (!profile) {
      if (combinedText.includes('tutorial') || combinedText.includes('how to') || combinedText.includes('explained') || combinedText.includes('guide')) {
        primaryContext = 'educational';
      } else if (combinedText.includes('documentary') || combinedText.includes('history of') || combinedText.includes('investigation')) {
        primaryContext = 'documentary';
      } else if (combinedText.includes('review') || combinedText.includes('reaction') || combinedText.includes('critique') || combinedText.includes('commentary')) {
        primaryContext = 'commentary';
      } else if (combinedText.includes('gameplay') || combinedText.includes('walkthrough') || combinedText.includes('lets play')) {
        primaryContext = 'gaming';
      } else {
        contextConfidence = 'LOW';
        uncertaintyReason = 'AMBIGUOUS_CONTEXT';
      }
    }

    const isEducationalOrDocumentary = primaryContext === 'educational' || primaryContext === 'documentary';
    const isCommentaryOrCritique = primaryContext === 'commentary';
    const isGamingOrCreative = primaryContext === 'gaming' || primaryContext === 'creative';
    const isSatireOrPerformance = primaryContext === 'satire';

    return {
      primaryContext,
      isEducationalOrDocumentary,
      isCommentaryOrCritique,
      isGamingOrCreative,
      isSatireOrPerformance,
      contextConfidence,
      uncertaintyReason,
      notes: profile 
        ? `Grounded in user-specified Channel Context Profile (Type: ${profile.contentType}, Voice: ${profile.originalVoiceNarration}).`
        : `Context inferred from title/description keywords (Confidence: ${contextConfidence}). Specifying a Channel Context Profile is recommended for higher precision.`
    };
  }

  /**
   * Scans text for sensitive keywords and applies contextual modulation
   * (e.g. "war" in a historical documentary is educational, not gratuitous violence)
   */
  public analyzeSensitiveKeywords(
    text: string, 
    context: ContextInterpretationResult
  ): SensitiveKeywordFinding[] {
    const lower = text.toLowerCase();
    const findings: SensitiveKeywordFinding[] = [];

    for (const item of this.sensitiveLexicon) {
      if (lower.includes(item.term)) {
        let impact: SensitiveKeywordFinding['contextualImpact'] = 'high_scrutiny';
        let explanation = '';
        let recommendedAction = '';

        if (item.category === 'sensational_claims' || item.category === 'exaggerated_guarantee') {
          impact = 'high_scrutiny';
          explanation = `Term "${item.term}" triggers Deceptive Practices scrutiny if presented as an absolute promise without substantiated factual grounding.`;
          recommendedAction = `Rephrase title or description to emphasize methodology or findings rather than absolute guarantees.`;
        } else if (item.contextPermitted.includes(context.primaryContext)) {
          impact = 'permissible_in_context';
          explanation = `Term "${item.term}" detected, but context appears to be ${context.primaryContext}. Platform guidelines typically permit sensitive terms in educational, historical, or news contexts when not sensationalized.`;
          recommendedAction = `Ensure tone remains objective and that surrounding visual footage does not depict graphic or gratuitous harm.`;
        } else {
          impact = 'needs_contextual_review';
          explanation = `Term "${item.term}" may trigger automated advertiser suitability reviews (Limited Ads status) depending on audio context and visual depictions.`;
          recommendedAction = `Review placement. Avoid prominent placement in titles or thumbnail text where automated ad crawlers prioritize scrutiny.`;
        }

        findings.push({
          word: item.term,
          category: item.category,
          contextualImpact: impact,
          explanation,
          recommendedAction
        });
      }
    }

    return findings;
  }
}

export const contextAnalyzer = new ContextAnalyzer();
