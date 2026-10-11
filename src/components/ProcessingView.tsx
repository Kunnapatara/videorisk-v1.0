import React, { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Loader2, AlertCircle, ArrowRight } from 'lucide-react';
import { ScanJob, ScanStage } from '../types';

interface ProcessingViewProps {
  scanId: string;
  onComplete: (scanId: string) => void;
  onCancel: () => void;
}

const ALL_STAGES: ScanStage[] = [
  'Upload',
  'Media inspection',
  'Audio & transcript',
  'Scene analysis',
  'Visual evidence',
  'Policy analysis',
  'Risk report'
];

export const ProcessingView: React.FC<ProcessingViewProps> = ({ scanId, onComplete, onCancel }) => {
  const [scan, setScan] = useState<ScanJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    let timer: any = null;

    const poll = async () => {
      try {
        const res = await fetch(`/api/scans/${scanId}`);
        if (!res.ok) throw new Error('Failed to fetch scan status');
        const data: ScanJob = await res.json();
        
        if (!isMounted) return;
        setScan(data);

        if (data.status === 'COMPLETED') {
          // Allow user to see completed state briefly before transition
          setTimeout(() => {
            if (isMounted) onComplete(scanId);
          }, 1000);
          return;
        }

        if (data.status === 'FAILED') {
          setError(data.error || 'Scan processing encountered an issue.');
          return;
        }

        // Keep polling
        timer = setTimeout(poll, 700);
      } catch (err: any) {
        if (!isMounted) return;
        console.warn('Poll error:', err);
        timer = setTimeout(poll, 1500);
      }
    };

    poll();

    return () => {
      isMounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [scanId, onComplete]);

  const getStageStatus = (stage: ScanStage) => {
    if (!scan) return 'pending';
    if (scan.completedStages?.includes(stage)) return 'completed';
    if (scan.currentStage === stage) return 'active';
    return 'pending';
  };

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <div className="bg-white rounded-xl shadow-sm border border-stone-200 overflow-hidden">
        {/* Banner */}
        <div className="p-6 bg-stone-900 text-white">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider text-rose-400 font-semibold">
              Analysis in Progress
            </span>
            <span className="text-xs text-stone-400">Scan ID: {scanId}</span>
          </div>
          <h2 className="text-xl font-bold tracking-tight">
            {scan?.videoTitle || 'Processing Video...'}
          </h2>
          <p className="text-xs text-stone-300 mt-1">
            Running multi-layer audio, scene, perceptual hash, and platform policy correlation.
          </p>
        </div>

        {/* Error State */}
        {error ? (
          <div className="p-6 space-y-4">
            <div className="p-4 bg-rose-50 border border-rose-200 rounded text-rose-800 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-rose-600 mt-0.5 shrink-0" />
              <div>
                <h4 className="font-semibold text-sm">We couldn't complete this scan</h4>
                <p className="text-xs mt-1 text-rose-700">
                  {error}
                </p>
                <p className="text-xs mt-2 text-stone-500">
                  Your video was not published or shared. Credits have been refunded.
                </p>
              </div>
            </div>
            <button
              onClick={onCancel}
              className="px-4 py-2 bg-stone-800 hover:bg-stone-700 text-white text-xs font-semibold rounded"
            >
              Back to Dashboard
            </button>
          </div>
        ) : (
          <div className="p-6 space-y-6">
            {/* Stage Timeline */}
            <div className="space-y-3">
              {ALL_STAGES.map((stage, idx) => {
                const status = getStageStatus(stage);
                return (
                  <div 
                    key={stage}
                    className={`flex items-center justify-between p-3 rounded transition-colors ${
                      status === 'active' 
                        ? 'bg-rose-50/70 border border-rose-200' 
                        : status === 'completed'
                          ? 'bg-stone-50 border border-stone-100 text-stone-700'
                          : 'text-stone-400 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {status === 'completed' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      ) : status === 'active' ? (
                        <Loader2 className="w-4 h-4 text-rose-600 animate-spin shrink-0" />
                      ) : (
                        <Circle className="w-4 h-4 text-stone-300 shrink-0" />
                      )}
                      <span className={`text-sm ${status === 'active' ? 'font-semibold text-rose-950' : ''}`}>
                        {stage}
                      </span>
                    </div>

                    <span className="text-xs font-mono">
                      {status === 'completed' ? 'Done' : status === 'active' ? 'Inspecting...' : 'Waiting'}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Video Telemetry Box */}
            {scan?.metadata && (
              <div className="p-3 bg-stone-50 rounded border border-stone-200 text-xs text-stone-600 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="text-stone-400">Duration:</span>{' '}
                  <strong className="text-stone-800">{scan.metadata.durationSeconds}s</strong>
                </div>
                <div>
                  <span className="text-stone-400">Format:</span>{' '}
                  <strong className="text-stone-800">{scan.metadata.resolutionLabel} @ {scan.metadata.fps}fps</strong>
                </div>
                <div>
                  <span className="text-stone-400">Audio:</span>{' '}
                  <strong className="text-stone-800">{scan.metadata.hasAudio ? 'Detected' : 'Silent'}</strong>
                </div>
                <div>
                  <span className="text-stone-400">Proxy:</span>{' '}
                  <strong className="text-stone-800">{scan.metadata.isProxyUsed ? '1080p Proxy Active' : 'Native'}</strong>
                </div>
              </div>
            )}

            {scan?.status === 'COMPLETED' && (
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded text-center">
                <p className="text-emerald-800 font-bold text-sm">
                  Your VideoRisk report is ready.
                </p>
                <p className="text-emerald-600 text-xs mt-0.5">
                  Redirecting to report...
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
