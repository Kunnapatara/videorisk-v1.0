import React from 'react';
import { ReScanComparison } from '../types';
import { CheckCircle2, AlertTriangle, ArrowRight, TrendingUp, ShieldCheck, RefreshCw, HelpCircle, Info } from 'lucide-react';

export interface MediaIdentityDisplay {
  comparisonStatus: 'IDENTICAL' | 'DIFFERENT' | 'UNVERIFIED';
  statusLabel: string;
  statusBadgeText: string;
  originalHashDisplay: string;
  originalHashTitle?: string;
  revisedHashDisplay: string;
  revisedHashTitle?: string;
}

export function isValidSha256(hash?: string): boolean {
  if (typeof hash !== 'string') return false;
  return /^[a-fA-F0-9]{64}$/.test(hash.trim());
}

export function formatMediaIdentityDisplay(
  originalSha256?: string,
  revisedSha256?: string
): MediaIdentityDisplay {
  const validOrig = isValidSha256(originalSha256);
  const validRev = isValidSha256(revisedSha256);

  const origClean = validOrig ? originalSha256!.trim().toLowerCase() : undefined;
  const revClean = validRev ? revisedSha256!.trim().toLowerCase() : undefined;

  let comparisonStatus: 'IDENTICAL' | 'DIFFERENT' | 'UNVERIFIED' = 'UNVERIFIED';
  let statusBadgeText = '(File comparison unverified)';

  if (validOrig && validRev) {
    if (origClean === revClean) {
      comparisonStatus = 'IDENTICAL';
      statusBadgeText = '(Identical file)';
    } else {
      comparisonStatus = 'DIFFERENT';
      statusBadgeText = '(Modified file)';
    }
  }

  return {
    comparisonStatus,
    statusBadgeText,
    statusLabel: comparisonStatus === 'IDENTICAL'
      ? 'Identical file'
      : comparisonStatus === 'DIFFERENT'
      ? 'Modified file'
      : 'File comparison unverified',
    originalHashDisplay: validOrig ? `${origClean!.slice(0, 10)}…` : 'Unavailable',
    originalHashTitle: validOrig ? originalSha256 : undefined,
    revisedHashDisplay: validRev ? `${revClean!.slice(0, 10)}…` : 'Unavailable',
    revisedHashTitle: validRev ? revisedSha256 : undefined,
  };
}

export function getComparisonSubtitle(comparison: ReScanComparison): string {
  // Case 1: Revised media SHA-256 is unavailable: explicitly state that media comparison is unverified
  if (comparison.mediaIdentity && !isValidSha256(comparison.mediaIdentity.revisedSha256)) {
    return 'Media comparison is unverified: revised media SHA-256 is unavailable.';
  }

  const isCleanBaselineAndRevision = comparison.originalSignalsCount === 0 &&
    comparison.revisedSignalsCount === 0 &&
    comparison.revisedRisk !== 'HIGH_RISK';

  // Case 2 & 3: Previous findings were resolved
  if (comparison.resolvedIssues.length > 0) {
    if (comparison.remainingIssues.length === 0 && (!comparison.notVerifiedIssues || comparison.notVerifiedIssues.length === 0)) {
      if (comparison.newIssues && comparison.newIssues.length > 0) {
        // Case 2: Previous findings resolved, but new risk signals appeared
        return `Prior signal(s) resolved with evidence (${comparison.resolvedIssues.length}), but ${comparison.newIssues.length} new risk signal(s) were introduced in this cut.`;
      }
      // Case 3: Previous findings resolved with evidence and no new findings appeared
      return `Verified with evidence: All ${comparison.resolvedIssues.length} prior policy scrutiny signal(s) have been resolved.`;
    } else {
      if (comparison.newIssues && comparison.newIssues.length > 0) {
        return `Partial resolution verified: ${comparison.resolvedIssues.length} prior signal(s) resolved with evidence, but ${comparison.newIssues.length} new risk signal(s) appeared alongside remaining or unverified signals.`;
      }
      return `Partial resolution verified: ${comparison.resolvedIssues.length} prior signal(s) resolved with evidence, but additional signals remain present or unverified.`;
    }
  }

  // Case 4: Previous findings remain or their resolution could not be verified
  if (comparison.notVerifiedIssues && comparison.notVerifiedIssues.length > 0) {
    if (comparison.remainingIssues.length > 0) {
      return `Prior findings persist (${comparison.remainingIssues.length}) and resolution could not be verified for ${comparison.notVerifiedIssues.length} signal(s) due to unassessed detectors or insufficient evidence.`;
    }
    return `Signal resolution could not be verified (${comparison.notVerifiedIssues.length} item(s) unverified due to unassessed detectors or insufficient evidence).`;
  }

  if (comparison.remainingIssues.length > 0) {
    if (comparison.newIssues && comparison.newIssues.length > 0) {
      return `No prior risk signals were resolved. ${comparison.remainingIssues.length} prior signal(s) persist and ${comparison.newIssues.length} new signal(s) were introduced.`;
    }
    return `No prior risk signals were resolved. ${comparison.remainingIssues.length} signal(s) persist in this revision cut.`;
  }

  // Case 5: No risk signals detected in either cut
  if (isCleanBaselineAndRevision) {
    return 'No policy scrutiny signals detected in either cut.';
  }

  // Case 6: No prior findings were resolved, but fewer signals appear in the revision
  if (comparison.signalsDelta < 0) {
    return `Fewer signals detected in this cut (${comparison.revisedSignalsCount} vs ${comparison.originalSignalsCount}), but no prior findings were verifiably resolved with evidence.`;
  }

  if (comparison.newIssues && comparison.newIssues.length > 0) {
    return `New policy scrutiny signal(s) detected in this revision cut (${comparison.newIssues.length} signal(s)).`;
  }

  return 'No net change in detected risk signals between cuts.';
}

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
      {(() => {
        const isMediaUnverified = Boolean(
          comparison.mediaIdentity && !isValidSha256(comparison.mediaIdentity.revisedSha256)
        );

        const isFullyResolved = !isMediaUnverified &&
          comparison.resolvedIssues.length > 0 &&
          (!comparison.notVerifiedIssues || comparison.notVerifiedIssues.length === 0) &&
          comparison.remainingIssues.length === 0 &&
          (!comparison.newIssues || comparison.newIssues.length === 0) &&
          comparison.revisedRisk !== 'HIGH_RISK';

        const isCleanBaselineAndRevision = !isMediaUnverified &&
          comparison.originalSignalsCount === 0 &&
          comparison.revisedSignalsCount === 0 &&
          comparison.revisedRisk !== 'HIGH_RISK';

        const isGreen = isFullyResolved || isCleanBaselineAndRevision;
        const isHighRisk = comparison.revisedRisk === 'HIGH_RISK';
        const subtitle = getComparisonSubtitle(comparison);

        return (
          <div className={`p-6 rounded-xl border ${
            isGreen
              ? 'bg-emerald-50 border-emerald-200'
              : isHighRisk
              ? 'bg-rose-50 border-rose-200'
              : 'bg-amber-50 border-amber-200'
          }`}>
            <div className="flex items-start gap-3">
              {isGreen ? (
                <ShieldCheck className="w-6 h-6 text-emerald-600 mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle className={`w-6 h-6 mt-0.5 shrink-0 ${isHighRisk ? 'text-rose-600' : 'text-amber-600'}`} />
              )}
              <div>
                <h3 className={`font-bold text-base ${
                  isGreen
                    ? 'text-emerald-950'
                    : isHighRisk
                    ? 'text-rose-950'
                    : 'text-amber-950'
                }`}>
                  {comparison.comparisonSummary}
                </h3>
                <p className={`text-xs mt-1 ${
                  isGreen
                    ? 'text-emerald-800'
                    : isHighRisk
                    ? 'text-rose-800'
                    : 'text-amber-800'
                }`}>
                  {subtitle}
                </p>
              </div>
            </div>
          </div>
        );
      })()}

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
            {comparison.mediaIdentity && (() => {
              const display = formatMediaIdentityDisplay(
                comparison.mediaIdentity.originalSha256,
                comparison.mediaIdentity.revisedSha256
              );
              return (
                <div className="flex justify-between py-1.5 border-b border-stone-50 text-[11px]">
                  <span className="text-stone-500">Media SHA-256:</span>
                  <span className="font-mono text-stone-700" title={display.originalHashTitle}>
                    {display.originalHashDisplay}
                  </span>
                </div>
              );
            })()}
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
            {comparison.mediaIdentity && (() => {
              const display = formatMediaIdentityDisplay(
                comparison.mediaIdentity.originalSha256,
                comparison.mediaIdentity.revisedSha256
              );
              return (
                <div className="flex justify-between py-1.5 border-b border-stone-50 text-[11px]">
                  <span className="text-stone-500">Media SHA-256:</span>
                  <span className="font-mono text-stone-700" title={display.revisedHashTitle}>
                    {display.revisedHashDisplay}
                    <span className={`ml-1 text-[10px] font-sans font-semibold ${
                      display.comparisonStatus === 'IDENTICAL'
                        ? 'text-amber-700'
                        : display.comparisonStatus === 'DIFFERENT'
                        ? 'text-emerald-700'
                        : 'text-stone-500'
                    }`}>
                      {display.statusBadgeText}
                    </span>
                  </span>
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      {/* RESOLVED ISSUES CHECKLIST */}
      {comparison.resolvedIssues.length > 0 && (
        <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-4">
          <h4 className="font-bold text-sm text-stone-900">
            Resolved Signals ({comparison.resolvedIssues.length})
          </h4>
          <div className="space-y-2">
            {comparison.resolvedIssues.map((issue, idx) => (
              <div key={idx} className="flex items-start gap-2.5 text-xs text-stone-700">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                <span>{issue}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PERSISTING / REMAINING ISSUES (IF ANY) */}
      {comparison.remainingIssues && comparison.remainingIssues.length > 0 && (
        <div className="bg-white rounded-xl border border-amber-200 p-5 space-y-4">
          <h4 className="font-bold text-sm text-amber-950 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            Persisting Signals ({comparison.remainingIssues.length})
          </h4>
          <p className="text-xs text-stone-500">
            These signals detected in the original cut remain present in the revised cut.
          </p>
          <div className="space-y-2">
            {comparison.remainingIssues.map((issue, idx) => (
              <div key={idx} className="flex items-start gap-2.5 text-xs text-stone-800">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-1.5 shrink-0" />
                <span>{issue}</span>
              </div>
            ))}
          </div>
        </div>
      )}

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

      {/* EMPTY STATE WHEN NO ISSUES TO COMPARE */}
      {comparison.resolvedIssues.length === 0 &&
       comparison.remainingIssues.length === 0 &&
       (!comparison.notVerifiedIssues || comparison.notVerifiedIssues.length === 0) &&
       (!comparison.newIssues || comparison.newIssues.length === 0) && (
        <div className="bg-white rounded-xl border border-stone-200 p-6 text-center text-xs text-stone-500 space-y-2">
          <Info className="w-5 h-5 text-stone-400 mx-auto" />
          <p className="font-semibold text-stone-700">No Policy Scrutiny Signals to Compare</p>
          <p>Both original and revised cuts evaluated with zero detected policy issues.</p>
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
