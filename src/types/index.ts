export type RiskLevel = 'LOW_RISK' | 'NEEDS_REVIEW' | 'HIGH_RISK';

export type JobStatus = 
  | 'QUEUED'
  | 'INSPECTING'
  | 'PROCESSING_AUDIO'
  | 'PROCESSING_VIDEO'
  | 'BUILDING_EVIDENCE'
  | 'MAPPING_POLICY'
  | 'BUILDING_REPORT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CLEANUP_PENDING';

export type ScanStage = 
  | 'Upload'
  | 'Media inspection'
  | 'Audio & transcript'
  | 'Scene analysis'
  | 'Visual evidence'
  | 'Policy analysis'
  | 'Risk report';

export type ScanMode = 'standard' | 'deep';

export type EvidenceDomain = 
  | 'video_audio' 
  | 'title' 
  | 'description_tags' 
  | 'thumbnail' 
  | 'channel_context';

export type DomainAssessmentStatus = 
  | 'POTENTIAL_RISK_DETECTED'
  | 'REVIEW_RECOMMENDED'
  | 'NO_MAJOR_RISK_SIGNALS_DETECTED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'NOT_ASSESSED'
  | 'ANALYSIS_UNAVAILABLE'
  | 'NOT_PROVIDED';

export type DetectorExecutionStatus = 
  | 'DETECTED'
  | 'NO_SIGNAL_DETECTED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'NOT_ASSESSED'
  | 'ANALYSIS_UNAVAILABLE'
  | 'NOT_PROVIDED';

export interface DetectorReport {
  detectorName: string;
  version: string;
  status: DetectorExecutionStatus;
  executionDurationMs: number;
  evidenceReferences?: string[];
  confidence?: number;
  limitations?: string;
  failureReason?: string;
  details?: Record<string, any>;
}

export type EvidenceStatus = 'VERIFIED' | 'OBSERVED' | 'INSUFFICIENT_EVIDENCE' | 'NOT_ASSESSED';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export type UncertaintyReason = 
  | 'INSUFFICIENT_EVIDENCE'
  | 'MISSING_TRANSCRIPT'
  | 'FAILED_FRAME_ANALYSIS'
  | 'AMBIGUOUS_CONTEXT'
  | 'ANALYZER_UNAVAILABLE'
  | 'CONFLICTING_EVIDENCE'
  | 'NONE';

export interface MediaMetadata {
  filename: string;
  originalSize: number;
  durationSeconds: number;
  width: number;
  height: number;
  resolutionLabel: string;
  fps: number;
  hasAudio: boolean;
  audioCodec?: string;
  videoCodec?: string;
  isProxyUsed: boolean;
  sha256?: string;
}

export type EvidenceCategory = 
  | 'reused_content'
  | 'original_contribution'
  | 'inauthentic_pattern'
  | 'ai_disclosure'
  | 'advertiser_friendly'
  | 'community_guidelines'
  | 'metadata_coherence'
  | 'thumbnail_integrity';

export type EvidenceSeverity = 'info' | 'warning' | 'high';

export interface EvidenceItem {
  id: string;
  scanId: string;
  domain: EvidenceDomain;
  timestampStart: number;
  timestampEnd: number;
  timestampLabel: string;
  assetLocation?: string; // e.g. "01:24", "Title", "Description: line 3", "Thumbnail top-right"
  type: string;
  category: EvidenceCategory;
  severity: EvidenceSeverity;
  confidence: number; // 0 to 1
  confidenceLevel: ConfidenceLevel;
  uncertaintyReason?: UncertaintyReason;
  evidenceStatus?: EvidenceStatus;
  provenance: string; // Extraction method / analyzer source (e.g. "ffmpeg:silencedetect", "nlp:metadata_compare")
  source: string;
  label: string;
  details: string;
  contextualInterpretation?: string;
  limitations?: string;
  recommendedAction?: string;
  frameThumbnailUrl?: string;
}

export interface TopIssue {
  id: string;
  domain: EvidenceDomain;
  type?: string;
  what: string;
  where: string;
  why: string;
  fix: string;
  evidence: string;
  context: string;
  recommendedAction: string;
  confidence: ConfidenceLevel;
  limitations: string;
  severity: EvidenceSeverity;
  policyArea: string;
  category: EvidenceCategory;
  timestampSeconds: number;
}

export interface RiskCategorySummary {
  status: RiskLevel;
  score: number; // 0-100 (lower score = lower risk)
  label: string;
  explanation: string;
}

export type PolicyImpact = 
  | 'High Scrutiny' 
  | 'Moderate Concern' 
  | 'Standard Baseline' 
  | 'No Direct Issues Detected' 
  | 'Insufficient Evidence' 
  | 'Not Assessed' 
  | 'Compliant';

export interface PolicyConnection {
  policyName: string;
  category: EvidenceCategory;
  impact: PolicyImpact;
  signalsCount: number;
  description: string;
  evidenceStatus?: EvidenceStatus;
  notes?: string;
}

export interface DomainReport {
  domain: EvidenceDomain;
  domainLabel: string;
  status: DomainAssessmentStatus;
  summary: string;
  findingsCount: number;
  confidence: ConfidenceLevel;
  limitations: string;
  details?: Record<string, any>;
}

export interface ThumbnailMetadata {
  filename: string;
  originalSize: number;
  width: number;
  height: number;
  aspectRatio: string;
  isStandardAspect: boolean; // 16:9 check
  format: string;
  meanLuminance: number | null; // null if unmeasured or measurement failed
  hasHighContrastText?: boolean | null;
  hasSensationalElements?: boolean | null;
  visualAnalysisStatus?: DomainAssessmentStatus;
  ocrAnalysisStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  contrastAnalysisStatus?: DetectorExecutionStatus | DomainAssessmentStatus;
  extractedText?: string | null;
  textDensityRatio?: number | null;
  notes?: string;
  detectors?: Record<string, DetectorReport>;
}

export interface ChannelContextProfile {
  id: string;
  userId: string;
  version: number;
  channelTopic: string; // e.g., "Technology Analysis", "Gaming & Commentary", "History & Documentary"
  contentType: 'commentary' | 'documentary' | 'educational' | 'gaming' | 'satire' | 'news' | 'creative' | 'mixed';
  productionWorkflow: string; // Details on original voice, original recording, scripted commentary
  thirdPartyFootageUsage: 'none' | 'licensed_stock' | 'fair_use_commentary' | 'gameplay' | 'public_domain' | 'frequent_clips';
  originalVoiceNarration: 'always' | 'mostly' | 'sometimes' | 'rarely' | 'none';
  aiAssistedContent: boolean;
  aiDisclosureDetails?: string;
  typicalSources: string;
  updatedAt: string;
}

export interface CrossVideoPattern {
  id: string;
  patternType: 'repeated_reused_signal' | 'recurring_silence' | 'title_content_mismatch' | 'consistent_originality';
  label: string;
  severity: 'info' | 'warning' | 'high';
  frequency: number;
  affectedScansCount: number;
  explanation: string;
  recommendation: string;
  disclaimer: string;
}

export interface RiskReport {
  scanId: string;
  overallRisk: RiskLevel;
  riskSummary: string;
  disclaimer: string;
  domainReports: Record<EvidenceDomain, DomainReport>;
  riskCategories: {
    yppMonetization: RiskCategorySummary;
    videoMonetization: RiskCategorySummary;
    advertiserFriendly: RiskCategorySummary;
    copyrightSignals: RiskCategorySummary;
  };
  topIssues: TopIssue[];
  policyConnections: PolicyConnection[];
  timeline: EvidenceItem[];
  originalContributionRatio?: number | null; // 0 - 100% or null when unassessed/insufficient evidence
  originalContributionStatus?: EvidenceStatus;
  reusedContentRatio: number; // 0 - 100%
  transformationScore?: number | null; // 0 - 100% or null when unassessed/insufficient evidence
  transformationStatus?: EvidenceStatus;
  metadataScore: number; // 0 - 100%
  thumbnailScore?: number; // 0 - 100%
  channelProfileSnapshot?: ChannelContextProfile;
  detectors?: Record<string, DetectorReport>;
  benchmarkMetrics: {
    totalProcessingSeconds: number;
    inspectionMs: number;
    audioProcessingMs: number;
    videoAnalysisMs: number;
    evidenceBuildingMs: number;
    policyReasoningMs: number;
    framesSampled: number;
    scenesDetected: number;
  };
}

export interface ScanJob {
  id: string;
  userId: string;
  videoTitle: string;
  videoDescription?: string;
  videoTags?: string[];
  videoFilename: string;
  videoPath: string;
  thumbnailPath?: string;
  thumbnailFilename?: string;
  thumbnailMetadata?: ThumbnailMetadata;
  proxyPath?: string;
  scanMode: ScanMode;
  status: JobStatus;
  currentStage: ScanStage;
  completedStages: ScanStage[];
  creditsUsed: number;
  creditsDeducted?: number;
  creditsRefunded?: boolean;
  creditsRefundedAmount?: number;
  metadata?: MediaMetadata;
  createdAt: string;
  completedAt?: string;
  error?: string;
  parentScanId?: string; // For re-scans
  isRescan?: boolean;
  channelProfileSnapshot?: ChannelContextProfile;
}

export interface ReScanComparison {
  originalScanId: string;
  revisedScanId: string;
  originalRisk: RiskLevel;
  revisedRisk: RiskLevel;
  originalSignalsCount: number;
  revisedSignalsCount: number;
  signalsDelta: number; // negative is improvement
  resolvedIssues: string[];
  remainingIssues: string[];
  newIssues?: string[];
  notVerifiedIssues?: string[];
  improvements: string[];
  comparisonSummary: string;
  originalRatios: {
    originalContribution?: number | null;
    reusedContent: number;
  };
  revisedRatios: {
    originalContribution?: number | null;
    reusedContent: number;
  };
  mediaIdentity?: {
    originalSha256?: string;
    revisedSha256?: string;
    isIdenticalMedia: boolean;
    comparisonStatus?: 'IDENTICAL' | 'DIFFERENT' | 'UNVERIFIED';
  };
}

export interface ComparisonOptions {
  isRevisedFailed?: boolean;
  revisedScanRecord?: { status?: string; error?: string; metadata?: MediaMetadata };
  originalScanRecord?: { status?: string; error?: string; metadata?: MediaMetadata };
  skippedDomains?: EvidenceDomain[];
}

export interface UserAccount {
  id: string;
  email: string;
  plan: 'free' | 'creator' | 'pro' | 'agency';
  creditsRemaining: number;
  creditsUsedTotal: number;
  totalScansCount: number;
  createdAt: string;
  stripeCustomerId?: string;
  subscriptionId?: string;
  subscriptionStatus?: string;
  passwordHash?: string;
  salt?: string;
  freeTrialClaimed?: boolean;
}

export interface AuthSessionRecord {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface SubscriptionRecord {
  id: string;
  userId: string;
  planId: string;
  status: 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete';
  currentPeriodEnd?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEventRecord {
  eventId: string;
  provider: 'stripe';
  eventType: string;
  processedAt: string;
  userId?: string;
  creditsGranted?: number;
  planGranted?: string;
}

export type CreditTransactionType = 
  | 'INITIAL_GRANT' 
  | 'FREE_TRIAL' 
  | 'PLAN_PURCHASE' 
  | 'SUBSCRIPTION_RENEWAL' 
  | 'SCAN_DEDUCTION' 
  | 'SCAN_REFUND' 
  | 'MANUAL_GRANT'
  | 'MANUAL_DEDUCTION' 
  | 'SIMULATED_PURCHASE';

export interface CreditTransactionRecord {
  id: string;
  userId: string;
  delta: number;
  balanceAfter: number;
  type: CreditTransactionType;
  referenceId?: string;
  metadataJson?: string;
  createdAt: string;
}

export interface PasswordResetRecord {
  tokenHash: string;
  userId: string;
  expiresAt: string;
  usedAt?: string | null;
  createdAt: string;
}

export class FencingError extends Error {
  constructor(message: string = 'Worker ownership/lease fencing token is invalid or has been superseded') {
    super(message);
    this.name = 'FencingError';
    Object.setPrototypeOf(this, FencingError.prototype);
  }
}

export interface JobQueueRecord {
  id: string;
  scanId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'RETRYABLE';
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lockedAt?: string | null;
  lockedBy?: string | null;
  leaseToken?: string | null;
  leaseExpiresAt?: string | null;
  leaseDurationMs?: number | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalMetrics {
  totalScans: number;
  completedScans: number;
  failedScans: number;
  averageProcessingSeconds: number;
  totalDurationSecondsScanned: number;
  estimatedComputeCostUsd: number;
  estimatedStorageCostUsd: number;
  measuredStageAveragesMs: {
    inspection: number;
    audio: number;
    video: number;
    policy: number;
  };
}

export interface PlanDetails {
  id: string;
  name: string;
  priceUsd: number;
  period: 'month' | 'one-time';
  credits: number;
  costPerMinuteStandard: string;
  features: string[];
  highlight?: boolean;
}
