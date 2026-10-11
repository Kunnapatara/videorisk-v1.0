import React, { useState, useEffect } from 'react';
import { ScanJob } from '../types';
import { authFetch } from '../utils/api';
import { Film, CheckCircle2, Clock, AlertTriangle, ArrowRight, RefreshCw, XCircle, Search, ShieldCheck } from 'lucide-react';

interface HistoryViewProps {
  onSelectScan: (scanId: string) => void;
  onInitiateRescan: (scanId: string) => void;
  onNewScan: () => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({ 
  onSelectScan, 
  onInitiateRescan, 
  onNewScan 
}) => {
  const [scans, setScans] = useState<ScanJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchFilter, setSearchFilter] = useState('');

  useEffect(() => {
    authFetch('/api/scans')
      .then(res => res.json())
      .then(data => {
        setScans(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load user scan history:', err);
        setLoading(false);
      });
  }, []);

  const filteredScans = scans.filter(s => 
    s.videoTitle.toLowerCase().includes(searchFilter.toLowerCase()) ||
    s.videoFilename.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="max-w-5xl mx-auto py-6 sm:py-10 px-4 sm:px-6 space-y-6">
      {/* Title & Actions Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-rose-600 mb-1">
            <ShieldCheck className="w-4 h-4" />
            <span>Isolated Channel History</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-stone-900 tracking-tight">
            Scans Archive
          </h1>
          <p className="text-xs text-stone-500 mt-0.5">
            Historical risk intelligence reports and revised video re-scans for your account.
          </p>
        </div>

        <button
          onClick={onNewScan}
          className="self-start sm:self-auto px-4 py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-lg shadow-sm transition-colors flex items-center gap-2"
        >
          <span>+ New Video Scan</span>
        </button>
      </div>

      {/* Filter / Search input */}
      {scans.length > 0 && (
        <div className="relative">
          <Search className="w-4 h-4 text-stone-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Search scans by video title or filename..."
            className="w-full pl-9 pr-4 py-2 bg-white text-xs border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 shadow-2xs"
          />
        </div>
      )}

      {loading ? (
        <div className="p-12 text-center text-xs text-stone-500 bg-white rounded-xl border border-stone-200">
          <div className="w-6 h-6 border-2 border-rose-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
          <span>Loading your scan archive...</span>
        </div>
      ) : scans.length === 0 ? (
        <div className="p-12 bg-white rounded-xl border border-stone-200 text-center space-y-4 shadow-xs">
          <Film className="w-12 h-12 text-stone-300 mx-auto" />
          <div>
            <h3 className="font-bold text-base text-stone-900">No Scans Recorded in this Account</h3>
            <p className="text-xs text-stone-500 max-w-sm mx-auto mt-1 leading-relaxed">
              Upload your first video to inspect reused-content signals, ad suitability, and original contribution. All scan reports are private to your user account.
            </p>
          </div>
          <button
            onClick={onNewScan}
            className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-lg shadow-sm transition-colors"
          >
            Start First Video Scan
          </button>
        </div>
      ) : filteredScans.length === 0 ? (
        <div className="p-8 bg-white rounded-xl border border-stone-200 text-center text-xs text-stone-500">
          No scans matched your search "{searchFilter}".
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-stone-200 overflow-hidden divide-y divide-stone-100 shadow-xs">
          {filteredScans.map(scan => (
            <div 
              key={scan.id}
              className="p-4 sm:p-5 hover:bg-stone-50/70 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4"
            >
              <div className="space-y-1.5 flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-bold text-sm text-stone-900 truncate max-w-md">
                    {scan.videoTitle}
                  </h3>
                  {scan.isRescan && (
                    <span className="text-[10px] uppercase font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
                      Revised Re-Scan
                    </span>
                  )}
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${
                    scan.status === 'COMPLETED' ? 'bg-emerald-100 text-emerald-800' :
                    scan.status === 'FAILED' ? 'bg-rose-100 text-rose-800' :
                    'bg-amber-100 text-amber-800'
                  }`}>
                    {scan.status}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
                  <span>{new Date(scan.createdAt).toLocaleDateString()}</span>
                  <span>·</span>
                  <span className="capitalize">{scan.scanMode} Scan</span>
                  {scan.metadata && (
                    <>
                      <span>·</span>
                      <span>{scan.metadata.durationSeconds}s</span>
                      <span>·</span>
                      <span>{scan.metadata.resolutionLabel}</span>
                    </>
                  )}
                  <span>·</span>
                  <span className="text-stone-700 font-medium">{scan.creditsUsed} credits used</span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 self-start md:self-auto shrink-0 w-full sm:w-auto">
                {scan.status === 'COMPLETED' ? (
                  <>
                    <button
                      onClick={() => onInitiateRescan(scan.id)}
                      className="flex-1 sm:flex-initial px-3 py-1.5 border border-stone-300 hover:bg-white text-stone-700 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors"
                      title="Re-scan revised video cut"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Re-Scan Cut</span>
                    </button>
                    <button
                      onClick={() => onSelectScan(scan.id)}
                      className="flex-1 sm:flex-initial px-4 py-1.5 bg-stone-900 hover:bg-stone-800 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition-colors shadow-xs"
                    >
                      <span>View Report</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </>
                ) : scan.status === 'FAILED' ? (
                  <span className="text-xs text-rose-600 font-semibold flex items-center gap-1">
                    <XCircle className="w-4 h-4" />
                    <span>Analysis Error (Credits Refunded)</span>
                  </span>
                ) : (
                  <button
                    onClick={() => onSelectScan(scan.id)}
                    className="flex-1 sm:flex-initial px-4 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <Clock className="w-3.5 h-3.5 animate-spin" />
                    <span>In Progress...</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
