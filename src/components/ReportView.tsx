import React, { useState } from 'react';
import { 
  RiskReport, 
  ScanJob, 
  RiskLevel, 
  EvidenceDomain, 
  DomainAssessmentStatus,
  ConfidenceLevel
} from '../types';
import { EvidenceTimeline } from './EvidenceTimeline';
import { 
  ShieldCheck, 
  AlertTriangle, 
  XCircle, 
  RefreshCw, 
  CheckCircle2, 
  FileText, 
  ChevronRight, 
  HelpCircle,
  TrendingDown,
  TrendingUp,
  Sliders,
  Sparkles,
  ArrowRight,
  Info,
  Film,
  Tag,
  Image as ImageIcon,
  Tv,
  ExternalLink
} from 'lucide-react';

interface ReportViewProps {
  report: RiskReport;
  scan: ScanJob;
  onInitiateRescan: (parentScanId: string) => void;
  onViewComparison?: () => void;
  hasComparison?: boolean;
}

export const ReportView: React.FC<ReportViewProps> = ({ 
  report, 
  scan, 
  onInitiateRescan, 
  onViewComparison,
  hasComparison 
}) => {
  const [activeTab, setActiveTab] = useState<'issues' | 'domains' | 'timeline' | 'policies' | 'telemetry'>('issues');

  const getRiskBadge = (level: RiskLevel) => {
    switch (level) {
      case 'LOW_RISK':
        return {
          icon: <CheckCircle2 className="w-5 h-5 text-emerald-600" />,
          title: '🟢 Low Risk',
          bgColor: 'bg-emerald-50 border-emerald-200 text-emerald-900',
          label: 'No major risk signals detected across analyzed publishing assets.',
        };
      case 'NEEDS_REVIEW':
        return {
          icon: <AlertTriangle className="w-5 h-5 text-amber-600" />,
          title: '🟡 Needs Review',
          bgColor: 'bg-amber-50 border-amber-200 text-amber-900',
          label: 'Moderate risk signals detected. Specific findings require review prior to publishing.',
        };
      case 'HIGH_RISK':
        return {
          icon: <XCircle className="w-5 h-5 text-rose-600" />,
          title: '🔴 High Risk',
          bgColor: 'bg-rose-50 border-rose-200 text-rose-900',
          label: 'Significant policy signals detected. Revising and re-scanning cut recommended.',
        };
    }
  };

  const overall = getRiskBadge(report.overallRisk);

  const getDomainStatusBadge = (status: DomainAssessmentStatus) => {
    switch (status) {
      case 'POTENTIAL_RISK_DETECTED':
        return <span className="bg-rose-100 text-rose-800 text-[10px] font-bold px-2 py-0.5 rounded">Risk Detected</span>;
      case 'REVIEW_RECOMMENDED':
        return <span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded">Review Recommended</span>;
      case 'NO_MAJOR_RISK_SIGNALS_DETECTED':
        return <span className="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded">Clean Signals</span>;
      case 'INSUFFICIENT_EVIDENCE':
        return <span className="bg-stone-100 text-stone-600 text-[10px] font-bold px-2 py-0.5 rounded">Insufficient Evidence</span>;
      case 'NOT_ASSESSED':
        return <span className="bg-stone-100 text-stone-600 text-[10px] font-bold px-2 py-0.5 rounded">Not Assessed</span>;
      case 'ANALYSIS_UNAVAILABLE':
        return <span className="bg-stone-200 text-stone-700 text-[10px] font-bold px-2 py-0.5 rounded">Unavailable</span>;
      case 'NOT_PROVIDED':
        return <span className="bg-stone-100 text-stone-500 text-[10px] font-semibold px-2 py-0.5 rounded">Not Provided</span>;
    }
  };

  const getConfidenceBadge = (conf?: ConfidenceLevel) => {
    switch (conf) {
      case 'HIGH':
        return <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.2 rounded font-bold text-[10px]">CONFIDENCE: HIGH</span>;
      case 'MEDIUM':
        return <span className="bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.2 rounded font-bold text-[10px]">CONFIDENCE: MEDIUM</span>;
      case 'LOW':
        return <span className="bg-stone-100 text-stone-600 border border-stone-200 px-1.5 py-0.2 rounded font-bold text-[10px]">CONFIDENCE: LOW (AMBIGUOUS)</span>;
      default:
        return <span className="bg-stone-100 text-stone-500 border border-stone-200 px-1.5 py-0.2 rounded font-semibold text-[10px]">CONFIDENCE: UNKNOWN</span>;
    }
  };

  return (
    <div className="max-w-6xl mx-auto py-6 sm:py-8 px-4 sm:px-6 space-y-6">
      {/* Top Action & Breadcrumb */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 mb-1">
            <span>VideoRisk Pre-Publish Intelligence</span>
            <span>·</span>
            <span className="font-mono">Scan {scan.id}</span>
            <span>·</span>
            <span className="capitalize">{scan.scanMode} Scan</span>
            {scan.isRescan && (
              <>
                <span>·</span>
                <span className="text-emerald-700 font-bold bg-emerald-50 border border-emerald-200 px-1.5 py-0.2 rounded text-[10px]">REVISED VERIFICATION</span>
              </>
            )}
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-stone-950 tracking-tight">
            {scan.videoTitle}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {hasComparison && onViewComparison && (
            <button
              onClick={onViewComparison}
              className="px-3.5 py-2 border border-stone-300 hover:bg-stone-50 text-stone-700 text-xs font-bold rounded-lg flex items-center gap-1.5 transition-colors shadow-2xs"
            >
              <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
              <span>View Re-Scan Comparison</span>
            </button>
          )}

          <button
            onClick={() => onInitiateRescan(scan.id)}
            className="flex-1 sm:flex-initial px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-2 transition-all shadow-sm active:scale-98"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Re-Scan Revised Cut</span>
          </button>
        </div>
      </div>

      {/* AUTHORITATIVE EXPECTATION DISCLAIMER BANNER */}
      <div className="p-4 bg-stone-900 text-stone-200 rounded-xl border border-stone-800 text-xs space-y-1 shadow-sm">
        <div className="flex items-center gap-2 font-bold text-white">
          <Info className="w-4 h-4 text-rose-400 shrink-0" />
          <span>Pre-Publish Platform Scope & Authority</span>
        </div>
        <p className="leading-relaxed text-stone-300">
          {report.disclaimer || "VideoRisk helps identify potential risks using the evidence available to its analysis. It cannot guarantee YouTube monetization, YPP eligibility, copyright clearance, or any platform decision. Review the relevant YouTube Studio checks before publishing."}
        </p>
      </div>

      {/* OVERALL RISK BANNER */}
      <div className={`p-6 rounded-2xl border ${overall.bgColor} shadow-xs`}>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-start gap-4">
            <div className="mt-0.5 shrink-0">{overall.icon}</div>
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-extrabold tracking-tight">{overall.title}</h2>
                <span className="text-[11px] uppercase tracking-wider font-bold opacity-80">
                  Publishing Assessment
                </span>
              </div>
              <p className="text-sm font-semibold leading-relaxed">
                {overall.label}
              </p>
              <p className="text-xs text-stone-700">
                {report.riskSummary}
              </p>
            </div>
          </div>

          <div className="border-t md:border-t-0 md:border-l border-current/20 pt-4 md:pt-0 md:pl-6 shrink-0 grid grid-cols-3 gap-6 text-center md:text-left">
            <div>
              <span className="block text-[10px] uppercase tracking-wider text-stone-500 font-bold">
                Original Voice
              </span>
              <span className="text-xl font-black text-stone-900 font-mono">
                {typeof report.originalContributionRatio === 'number'
                  ? `${report.originalContributionRatio}%`
                  : report.originalContributionStatus === 'INSUFFICIENT_EVIDENCE'
                  ? 'Uncertain'
                  : 'Not Assessed'}
              </span>
              {typeof report.originalContributionRatio !== 'number' && (
                <span className="block text-[9px] text-stone-500 font-medium">
                  {report.originalContributionStatus === 'INSUFFICIENT_EVIDENCE' ? 'Speech unverified' : 'Single video scan'}
                </span>
              )}
            </div>
            <div>
              <span className="block text-[10px] uppercase tracking-wider text-stone-500 font-bold">
                Reused Material
              </span>
              <span className="text-xl font-black text-stone-900 font-mono">
                {report.reusedContentRatio}%
              </span>
            </div>
            <div>
              <span className="block text-[10px] uppercase tracking-wider text-stone-500 font-bold">
                Flagged Signals
              </span>
              <span className="text-xl font-black text-stone-900 font-mono">
                {report.topIssues.length}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* DOMAIN SCORECARDS SUMMARY GRID */}
      {report.domainReports && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {/* Domain 1: Video & Audio */}
          <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-2xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-stone-700 flex items-center gap-1">
                <Film className="w-3.5 h-3.5 text-rose-600" />
                <span>Video/Audio</span>
              </span>
              {getDomainStatusBadge(report.domainReports.video_audio.status)}
            </div>
            <p className="text-[11px] text-stone-600 line-clamp-2 mt-1">
              {report.domainReports.video_audio.summary}
            </p>
          </div>

          {/* Domain 2: Title */}
          <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-2xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-stone-700 flex items-center gap-1">
                <Tag className="w-3.5 h-3.5 text-rose-600" />
                <span>Title</span>
              </span>
              {getDomainStatusBadge(report.domainReports.title.status)}
            </div>
            <p className="text-[11px] text-stone-600 line-clamp-2 mt-1">
              {report.domainReports.title.summary}
            </p>
          </div>

          {/* Domain 3: Description/Tags */}
          <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-2xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-stone-700 flex items-center gap-1">
                <FileText className="w-3.5 h-3.5 text-rose-600" />
                <span>Description</span>
              </span>
              {getDomainStatusBadge(report.domainReports.description_tags.status)}
            </div>
            <p className="text-[11px] text-stone-600 line-clamp-2 mt-1">
              {report.domainReports.description_tags.summary}
            </p>
          </div>

          {/* Domain 4: Thumbnail */}
          <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-2xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-stone-700 flex items-center gap-1">
                <ImageIcon className="w-3.5 h-3.5 text-rose-600" />
                <span>Thumbnail</span>
              </span>
              {getDomainStatusBadge(report.domainReports.thumbnail.status)}
            </div>
            <p className="text-[11px] text-stone-600 line-clamp-2 mt-1">
              {report.domainReports.thumbnail.summary}
            </p>
          </div>

          {/* Domain 5: Channel Context */}
          <div className="p-4 bg-white rounded-xl border border-stone-200 shadow-2xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-stone-700 flex items-center gap-1">
                <Tv className="w-3.5 h-3.5 text-rose-600" />
                <span>Channel Context</span>
              </span>
              {getDomainStatusBadge(report.domainReports.channel_context.status)}
            </div>
            <p className="text-[11px] text-stone-600 line-clamp-2 mt-1">
              {report.domainReports.channel_context.summary}
            </p>
          </div>
        </div>
      )}

      {/* REPORT NAVIGATION TABS */}
      <div className="border-b border-stone-200 flex items-center gap-4 sm:gap-6 text-xs sm:text-sm font-semibold overflow-x-auto whitespace-nowrap pb-0.5">
        <button
          onClick={() => setActiveTab('issues')}
          className={`pb-3 transition-colors border-b-2 flex items-center gap-1.5 shrink-0 ${
            activeTab === 'issues' 
              ? 'border-rose-600 text-stone-900 font-bold' 
              : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          <span>Actionable Issues & Fixes</span>
          <span className="bg-stone-100 text-stone-700 text-xs px-2 py-0.5 rounded font-mono">
            {report.topIssues.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('domains')}
          className={`pb-3 transition-colors border-b-2 flex items-center gap-1.5 shrink-0 ${
            activeTab === 'domains' 
              ? 'border-rose-600 text-stone-900 font-bold' 
              : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          <span>Evidence Domains (5)</span>
        </button>

        <button
          onClick={() => setActiveTab('timeline')}
          className={`pb-3 transition-colors border-b-2 flex items-center gap-1.5 shrink-0 ${
            activeTab === 'timeline' 
              ? 'border-rose-600 text-stone-900 font-bold' 
              : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          <span>Evidence Timeline</span>
          <span className="bg-stone-100 text-stone-700 text-xs px-2 py-0.5 rounded font-mono">
            {report.timeline.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('policies')}
          className={`pb-3 transition-colors border-b-2 shrink-0 ${
            activeTab === 'policies' 
              ? 'border-rose-600 text-stone-900 font-bold' 
              : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          <span>Policy Connections ({report.policyConnections.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('telemetry')}
          className={`pb-3 transition-colors border-b-2 shrink-0 ${
            activeTab === 'telemetry' 
              ? 'border-rose-600 text-stone-900 font-bold' 
              : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          <span>Media Telemetry & Limits</span>
        </button>
      </div>

      {/* TAB 1: TOP ISSUES WITH WHAT / WHERE / EVIDENCE / CONTEXT / WHY / ACTION / CONFIDENCE / LIMITATIONS */}
      {activeTab === 'issues' && (
        <div className="space-y-4">
          {report.topIssues.length === 0 ? (
            <div className="p-8 bg-white rounded-2xl border border-stone-200 text-center space-y-2">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
              <h3 className="font-bold text-base text-stone-900">No Actionable Risk Issues Flagged</h3>
              <p className="text-xs text-stone-500 max-w-md mx-auto leading-relaxed">
                Your video exhibits balanced original narration, differentiated visual editing, and compliant metadata phrasing.
              </p>
            </div>
          ) : (
            report.topIssues.map(issue => (
              <div 
                key={issue.id}
                className="bg-white rounded-2xl border border-stone-200 p-5 sm:p-6 shadow-xs space-y-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {issue.severity === 'high' ? (
                      <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                    )}
                    <span className="font-extrabold text-sm text-stone-900">
                      {issue.policyArea}
                    </span>
                    {getConfidenceBadge(issue.confidence)}
                  </div>
                  <span className="font-mono text-xs font-semibold bg-stone-100 px-2 py-0.5 rounded text-stone-700 self-start sm:self-auto">
                    WHERE: {issue.where}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  {/* WHAT WAS OBSERVED */}
                  <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-100 space-y-1">
                    <span className="text-[10px] uppercase font-bold tracking-wider text-stone-500 block">
                      OBSERVED EVIDENCE
                    </span>
                    <p className="text-stone-900 font-semibold leading-relaxed">
                      {issue.what}
                    </p>
                    <p className="text-[11px] text-stone-500">
                      {issue.evidence}
                    </p>
                  </div>

                  {/* WHY IT TRIGGERS SCRUTINY */}
                  <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-100 space-y-1">
                    <span className="text-[10px] uppercase font-bold tracking-wider text-stone-500 block">
                      WHY IT TRIGGERS PLATFORM SCRUTINY
                    </span>
                    <p className="text-stone-800 leading-relaxed font-medium">
                      {issue.why}
                    </p>
                    {issue.context && (
                      <p className="text-[11px] text-stone-500 italic">
                        Context: {issue.context}
                      </p>
                    )}
                  </div>
                </div>

                {/* RECOMMENDED ACTIONABLE FIX */}
                <div className="p-4 bg-emerald-50/70 border border-emerald-200 rounded-xl text-xs space-y-1.5">
                  <span className="text-[10px] uppercase font-bold tracking-wider text-emerald-800 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    RECOMMENDED PROPORTIONATE CORRECTION
                  </span>
                  <p className="text-emerald-950 font-bold leading-relaxed text-sm">
                    {issue.fix}
                  </p>
                  {issue.limitations && (
                    <p className="text-[10px] text-emerald-700 pt-1 border-t border-emerald-200/60">
                      Limitations: {issue.limitations}
                    </p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* TAB 2: EVIDENCE DOMAINS DEEP DIVE */}
      {activeTab === 'domains' && report.domainReports && (
        <div className="space-y-4">
          {Object.values(report.domainReports).map((dom) => (
            <div key={dom.domain} className="bg-white rounded-2xl border border-stone-200 p-6 shadow-xs space-y-3">
              <div className="flex items-center justify-between pb-3 border-b border-stone-100">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-base text-stone-900">{dom.domainLabel}</span>
                  {getDomainStatusBadge(dom.status)}
                </div>
                {getConfidenceBadge(dom.confidence)}
              </div>
              <p className="text-xs text-stone-800 leading-relaxed font-medium">
                {dom.summary}
              </p>
              <div className="p-3 bg-stone-50 rounded-xl text-[11px] text-stone-500 border border-stone-100">
                <span className="font-bold text-stone-700 block mb-0.5">Known Analyzer Boundary:</span>
                <span>{dom.limitations}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* TAB 3: EVIDENCE TIMELINE */}
      {activeTab === 'timeline' && (
        <div>
          <EvidenceTimeline timeline={report.timeline} />
        </div>
      )}

      {/* TAB 4: POLICY CONNECTIONS */}
      {activeTab === 'policies' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {report.policyConnections.map((pc, idx) => (
            <div key={idx} className="bg-white rounded-2xl border border-stone-200 p-5 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-sm text-stone-900">{pc.policyName}</h3>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                  pc.impact === 'High Scrutiny' ? 'bg-rose-100 text-rose-800' :
                  pc.impact === 'Moderate Concern' ? 'bg-amber-100 text-amber-800' :
                  pc.impact === 'No Direct Issues Detected' ? 'bg-blue-100 text-blue-800' :
                  pc.impact === 'Insufficient Evidence' ? 'bg-stone-100 text-stone-700' :
                  pc.impact === 'Not Assessed' ? 'bg-stone-100 text-stone-600' :
                  'bg-stone-100 text-stone-800'
                }`}>
                  {pc.impact}
                </span>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                {pc.description}
              </p>
              <div className="pt-2 border-t border-stone-100 flex items-center justify-between text-[11px] text-stone-500">
                <span>Associated Evidence Signals:</span>
                <span className="font-bold text-stone-800">{pc.signalsCount} finding(s)</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* TAB 5: TELEMETRY & LIMITS */}
      {activeTab === 'telemetry' && (
        <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-xs space-y-6">
          <div>
            <h3 className="font-bold text-base text-stone-900">Deterministic Inspection Telemetry</h3>
            <p className="text-xs text-stone-500 mt-0.5">Real measurements recorded by FFmpeg, ffprobe, and local audio filters.</p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
            <div className="p-3 bg-stone-50 rounded-xl border border-stone-100">
              <span className="text-stone-500 block text-[11px]">Total Processing Time</span>
              <strong className="text-sm text-stone-900">{report.benchmarkMetrics.totalProcessingSeconds}s</strong>
            </div>
            <div className="p-3 bg-stone-50 rounded-xl border border-stone-100">
              <span className="text-stone-500 block text-[11px]">Sampled Keyframes</span>
              <strong className="text-sm text-stone-900">{report.benchmarkMetrics.framesSampled} frames</strong>
            </div>
            <div className="p-3 bg-stone-50 rounded-xl border border-stone-100">
              <span className="text-stone-500 block text-[11px]">Estimated Scenes</span>
              <strong className="text-sm text-stone-900">{report.benchmarkMetrics.scenesDetected} cuts</strong>
            </div>
            <div className="p-3 bg-stone-50 rounded-xl border border-stone-100">
              <span className="text-stone-500 block text-[11px]">Audio Processing Latency</span>
              <strong className="text-sm text-stone-900">{report.benchmarkMetrics.audioProcessingMs}ms</strong>
            </div>
          </div>

          <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 text-xs text-stone-600 space-y-2">
            <span className="font-bold text-stone-900 block">Explicit Known Platform Limitations:</span>
            <ul className="list-disc pl-5 space-y-1 text-[11px]">
              <li>VideoRisk does not access private YouTube Content ID reference audio/video databases.</li>
              <li>Pre-publish risk assessment reflects human reviewer monetization guidelines and automated policy filters.</li>
              <li>Only YouTube Studio can perform official pre-publish Content ID copyright matches and ad suitability green icon checks.</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};
