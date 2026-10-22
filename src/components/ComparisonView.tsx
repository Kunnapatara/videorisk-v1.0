import React from 'react';
import { ReScanComparison } from '../types';
import { CheckCircle2, AlertTriangle, ArrowRight, TrendingUp, ShieldCheck, RefreshCw, HelpCircle, Info } from 'lucide-react';

interface ComparisonViewProps {
  comparison: ReScanComparison;
  onBackToReport: () => void;
  onNewScan: () => void;
}

export const ComparisonView: React.FC<ComparisonViewProps> = ({ 
  comparison, 
  onBackToReport,
  onNewScan 
}) => {
  return (
    <div className="max-w-5xl mx-auto py-8 px-4 space-y-6">
      {/* Top Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <span className="text-xs uppercase tracking-wider text-rose-600 font-semibold">
            Workflow Verification
          </span>
          <h1 className="text-2xl font-bold text-stone-900 tracking-tight">
            Re-Scan Risk Comparison
          </h1>
          <p className="text-xs text-stone-500">
            Side-by-side delta between your original upload and the revised video cut.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onBackToReport}
            className="px-3.5 py-1.5 border border-stone-300 hover:bg-stone-50 text-stone-700 text-xs font-semibold rounded"
          >
            Back to Report
          </button>
          <button
            onClick={onNewScan}
            className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded"
          >
            New Scan
          </button>
        </div>
      </div>

      {/* Summary Banner */}
      <div className={`p-6 rounded-xl border ${
        comparison.signalsDelta <= 0 && comparison.revisedRisk !== 'HIGH_RISK'
          ? 'bg-emerald-50 border-emerald-200'
          : 'bg-amber-50 border-amber-200'
      }`}>
        <div className="flex items-start gap-3">
          {comparison.signalsDelta <= 0 && comparison.revisedRisk !== 'HIGH_RISK' ? (
            <ShieldCheck className="w-6 h-6 text-emerald-600 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle className="w-6 h-6 text-amber-600 mt-0.5 shrink-0" />
          )}
          <div>
            <h3 className={`font-bold text-base ${
              comparison.signalsDelta <= 0 && comparison.revisedRisk !== 'HIGH_RISK'
                ? 'text-emerald-950'
                : 'text-amber-950'
            }`}>
              {comparison.comparisonSummary}
            </h3>
            <p className={`text-xs mt-1 ${
              comparison.signalsDelta <= 0 && comparison.revisedRisk !== 'HIGH_RISK'
                ? 'text-emerald-800'
                : 'text-amber-800'
            }`}>
              {comparison.signalsDelta < 0
                ? 'Your edits have successfully addressed platform policy scrutiny points.'
                : comparison.signalsDelta === 0
                ? 'No net change in detected risk signals between cuts.'
                : 'Additional policy scrutiny signals were observed in this revision cut.'}
            </p>
          </div>
        </div>
      </div>

      {/* BEFORE VS AFTER CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* BEFORE CARD */}
        <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-stone-100">
            <span className="font-bold text-xs uppercase tracking-wider text-stone-500">
              ORIGINAL CUT (BEFORE)
            </span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded ${
              comparison.originalRisk === 'HIGH_RISK' 
                ? 'bg-rose-100 text-rose-800' 
                : comparison.originalRisk === 'NEEDS_REVIEW'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-emerald-100 text-emerald-800'
            }`}>
              {comparison.originalRisk === 'HIGH_RISK' ? '🔴 High Risk' : comparison.originalRisk === 'NEEDS_REVIEW' ? '🟡 Needs Review' : '🟢 Low Risk'}
            </span>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between py-1.5 border-b border-stone-50">
              <span className="text-stone-500">Risk Signals:</span>
              <strong className="text-stone-900">{comparison.originalSignalsCount} detected</strong>
            </div>
            <div className="flex justify-between py-1.5 border-b border-stone-50">
              <span className="text-stone-500">Original Commentary:</span>
              <strong className="text-stone-900">
                {typeof comparison.originalRatios.originalContribution === 'number'
                  ? `${comparison.originalRatios.originalContribution}%`
                  : 'Not Assessed'}
              </strong>
            </div>
            <div className="flex justify-between py-1.5 border-b border-stone-50">
              <span className="text-stone-500">Reused Material:</span>
              <strong className="text-stone-900">{comparison.originalRatios.reusedContent}%</strong>
            </div>
            {comparison.mediaIdentity?.originalSha256 && (
              <div className="flex justify-between py-1.5 border-b border-stone-50 text-[11px]">
                <span className="text-stone-500">Media SHA-256:</span>
                <span className="font-mono text-stone-700" title={comparison.mediaIdentity.originalSha256}>
                  {comparison.mediaIdentity.originalSha256.slice(0, 10)}…
                </span>
              </div>
            )}
          </div>
        </div>

        {/* AFTER CARD */}
        <div className={`bg-white rounded-xl border-2 p-5 space-y-4 shadow-xs ${
          comparison.revisedRisk === 'LOW_RISK'
            ? 'border-emerald-400'
            : comparison.revisedRisk === 'NEEDS_REVIEW'
            ? 'border-amber-400'
            : 'border-rose-400'
        }`}>
          <div className="flex items-center justify-between pb-3 border-b border-stone-100">
            <span className={`font-bold text-xs uppercase tracking-wider ${
              comparison.revisedRisk === 'LOW_RISK'
                ? 'text-emerald-700'
                : comparison.revisedRisk === 'NEEDS_REVIEW'
                ? 'text-amber-700'
                : 'text-rose-700'
            }`}>
              REVISED CUT (AFTER)
            </span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded ${
              comparison.revisedRisk === 'HIGH_RISK' 
                ? 'bg-rose-100 text-rose-800' 
                : comparison.revisedRisk === 'NEEDS_REVIEW'
                ? 'bg-amber-100 text-amber-800'
                : 'bg-emerald-100 text-emerald-800'
            }`}>
              {comparison.revisedRisk === 'HIGH_RISK' ? '🔴 High Risk' : comparison.revisedRisk === 'NEEDS_REVIEW' ? '🟡 Needs Review' : '🟢 Low Risk'}
            </span>
          </div>

          <div className="space-y-3 text-xs">
            <div className="flex justify-between py-1.5 border-b border-stone-50">
              <span className="text-stone-500">Risk Signals:</span>
              <strong className={`font-bold ${
                comparison.signalsDelta < 0 ? 'text-emerald-700' : comparison.signalsDelta === 0 ? 'text-stone-700' : 'text-rose-700'
              }`}>
                {comparison.revisedSignalsCount} remaining
              </strong>
            </div>
            <div className="flex justify-between py-1.5 border-b border-stone-50">
              <span className="text-stone-500">Original Commentary:</span>
              <strong className="text-stone-900 font-bold">
                {typeof comparison.revisedRatios.originalContribution === 'number' && typeof comparison.originalRatios.originalContribution === 'number'
                  ? `${comparison.revisedRatios.originalContribution}% (${comparison.revisedRatios.originalContribution - comparison.originalRatios.originalContribution >= 0 ? '+' : ''}${comparison.revisedRatios.originalContribution - comparison.originalRatios.originalContribution}%)`
                  : typeof comparison.revisedRatios.originalContribution === 'number'
                    ? `${comparison.revisedRatios.originalContribution}%`
                    : 'Not Assessed'}
              </strong>
            </div>
            <div className="flex justify-between py-1.5 border-b border-stone-50">
              <span className="text-stone-500">Reused Material:</span>
              <strong className="text-stone-900 font-bold">
                {comparison.revisedRatios.reusedContent}% ({comparison.revisedRatios.reusedContent - comparison.originalRatios.reusedContent >= 0 ? '+' : ''}${comparison.revisedRatios.reusedContent - comparison.originalRatios.reusedContent}%)
              </strong>
            </div>
            {comparison.mediaIdentity?.revisedSha256 && (
              <div className="flex justify-between py-1.5 border-b border-stone-50 text-[11px]">
                <span className="text-stone-500">Media SHA-256:</span>
                <span className="font-mono text-stone-700" title={comparison.mediaIdentity.revisedSha256}>
                  {comparison.mediaIdentity.revisedSha256.slice(0, 10)}…
                  <span className={`ml-1 text-[10px] font-sans font-semibold ${comparison.mediaIdentity.isIdenticalMedia ? 'text-amber-700' : 'text-emerald-700'}`}>
                    ({comparison.mediaIdentity.isIdenticalMedia ? 'Identical file' : 'Modified file'})
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* RESOLVED ISSUES CHECKLIST */}
      <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-4">
        <h4 className="font-bold text-sm text-stone-900">
          Resolved Signals ({comparison.resolvedIssues.length})
        </h4>

        {comparison.resolvedIssues.length > 0 ? (
          <div className="space-y-2">
            {comparison.resolvedIssues.map((issue, idx) => (
              <div key={idx} className="flex items-start gap-2.5 text-xs text-stone-700">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                <span>{issue}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-stone-500 py-1">
            <Info className="w-4 h-4 text-stone-400 shrink-0" />
            <span>No prior risk issues were verifiably resolved in this re-scan.</span>
          </div>
        )}
      </div>

      {/* NOT VERIFIED ISSUES (IF ANY) */}
      {comparison.notVerifiedIssues && comparison.notVerifiedIssues.length > 0 && (
        <div className="bg-amber-50/50 rounded-xl border border-amber-200 p-5 space-y-4">
          <h4 className="font-bold text-sm text-amber-900 flex items-center gap-2">
            <HelpCircle className="w-4 h-4 text-amber-600" />
            Not Verified Signals ({comparison.notVerifiedIssues.length})
          </h4>
          <p className="text-xs text-amber-700">
            These signals from the prior scan could not be verified as resolved due to unassessed detectors, insufficient evidence, or incomplete scan comparison.
          </p>
          <div className="space-y-2">
            {comparison.notVerifiedIssues.map((issue, idx) => (
              <div key={idx} className="flex items-start gap-2.5 text-xs text-amber-800">
                <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                <span>{issue}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* NEW ISSUES (IF ANY) */}
      {comparison.newIssues && comparison.newIssues.length > 0 && (
        <div className="bg-rose-50/50 rounded-xl border border-rose-200 p-5 space-y-4">
          <h4 className="font-bold text-sm text-rose-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600" />
            New Signals Detected ({comparison.newIssues.length})
          </h4>
          <div className="space-y-2">
            {comparison.newIssues.map((issue, idx) => (
              <div key={idx} className="flex items-start gap-2.5 text-xs text-rose-800">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500 mt-1.5 shrink-0" />
                <span>{issue}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* IMPROVEMENTS HIGHLIGHTS */}
      <div className="bg-stone-50 rounded-xl border border-stone-200 p-5 space-y-3">
        <h4 className="font-bold text-xs uppercase tracking-wider text-stone-500">
          Workflow Insights
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {comparison.improvements.map((imp, idx) => (
            <div key={idx} className="p-3 bg-white rounded border border-stone-200 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-600 shrink-0" />
              <span className="text-stone-800">{imp}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
