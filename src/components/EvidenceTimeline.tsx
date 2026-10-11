import React, { useState } from 'react';
import { EvidenceItem, EvidenceCategory } from '../types';
import { Clock, AlertTriangle, CheckCircle, Info, ShieldAlert, Sparkles, Filter } from 'lucide-react';

interface EvidenceTimelineProps {
  timeline: EvidenceItem[];
  onSelectTimestamp?: (timestamp: number) => void;
}

export const EvidenceTimeline: React.FC<EvidenceTimelineProps> = ({ timeline, onSelectTimestamp }) => {
  const [filter, setFilter] = useState<string>('all');
  const [selectedId, setSelectedId] = useState<string | null>(timeline[0]?.id || null);

  const filteredItems = timeline.filter(item => {
    if (filter === 'all') return true;
    return item.category === filter;
  });

  const selectedItem = timeline.find(item => item.id === selectedId) || filteredItems[0];

  const getCategoryIcon = (category: EvidenceCategory, severity: string) => {
    if (severity === 'high') return <AlertTriangle className="w-4 h-4 text-rose-600" />;
    if (severity === 'warning') return <AlertTriangle className="w-4 h-4 text-amber-500" />;
    return <CheckCircle className="w-4 h-4 text-emerald-600" />;
  };

  return (
    <div className="bg-white rounded-xl border border-stone-200 overflow-hidden shadow-sm">
      {/* Header and Filter Controls */}
      <div className="p-4 border-b border-stone-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-stone-50/50">
        <div>
          <h3 className="font-bold text-stone-900 text-sm flex items-center gap-2">
            <Clock className="w-4 h-4 text-stone-600" />
            <span>Interactive Evidence Timeline</span>
          </h3>
          <p className="text-xs text-stone-500 mt-0.5">
            Click any timestamp interval to inspect the specific finding, policy connection, and fix.
          </p>
        </div>

        {/* Filter buttons */}
        <div className="flex items-center gap-1 bg-stone-100 p-1 rounded-lg text-xs overflow-x-auto max-w-full whitespace-nowrap">
          <button
            onClick={() => setFilter('all')}
            className={`px-2.5 py-1 rounded transition-colors shrink-0 ${
              filter === 'all' ? 'bg-white font-semibold text-stone-900 shadow-xs' : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            All ({timeline.length})
          </button>
          <button
            onClick={() => setFilter('reused_content')}
            className={`px-2.5 py-1 rounded transition-colors shrink-0 ${
              filter === 'reused_content' ? 'bg-white font-semibold text-stone-900 shadow-xs' : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            Reused Clips
          </button>
          <button
            onClick={() => setFilter('original_contribution')}
            className={`px-2.5 py-1 rounded transition-colors shrink-0 ${
              filter === 'original_contribution' ? 'bg-white font-semibold text-stone-900 shadow-xs' : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            Original
          </button>
          <button
            onClick={() => setFilter('ai_disclosure')}
            className={`px-2.5 py-1 rounded transition-colors shrink-0 ${
              filter === 'ai_disclosure' ? 'bg-white font-semibold text-stone-900 shadow-xs' : 'text-stone-600 hover:text-stone-900'
            }`}
          >
            AI Signals
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-stone-200">
        {/* Timeline Events List */}
        <div className="lg:col-span-6 p-4 max-h-96 overflow-y-auto space-y-2">
          {filteredItems.map(item => {
            const isSelected = item.id === selectedItem?.id;
            return (
              <div
                key={item.id}
                onClick={() => {
                  setSelectedId(item.id);
                  if (onSelectTimestamp) onSelectTimestamp(item.timestampStart);
                }}
                className={`p-3 rounded border text-left cursor-pointer transition-all ${
                  isSelected 
                    ? 'border-stone-800 bg-stone-50 ring-1 ring-stone-800' 
                    : 'border-stone-100 hover:border-stone-300 bg-white'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {getCategoryIcon(item.category, item.severity)}
                    <span className="font-mono text-xs font-semibold text-stone-800">
                      {item.timestampLabel}
                    </span>
                  </div>
                  <span className="text-[11px] text-stone-400 capitalize">
                    {item.category.replace('_', ' ')}
                  </span>
                </div>

                <p className="text-xs font-medium text-stone-800 mt-1 line-clamp-1">
                  {item.label}
                </p>
                <p className="text-[11px] text-stone-500 mt-0.5 line-clamp-1">
                  {item.details}
                </p>
              </div>
            );
          })}

          {filteredItems.length === 0 && (
            <div className="p-8 text-center text-stone-400 text-xs">
              No evidence events match the selected category.
            </div>
          )}
        </div>

        {/* Selected Event Deep Dive */}
        <div className="lg:col-span-6 p-5 bg-stone-50/40">
          {selectedItem ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="font-mono font-bold text-sm text-stone-900 bg-stone-100 px-2.5 py-1 rounded">
                  Segment: {selectedItem.timestampLabel}
                </span>
                <span className="text-xs text-stone-500">
                  Confidence: {Math.round(selectedItem.confidence * 100)}%
                </span>
              </div>

              <div>
                <h4 className="font-bold text-stone-900 text-sm">
                  {selectedItem.label}
                </h4>
                <p className="text-xs text-stone-600 mt-1 leading-relaxed">
                  {selectedItem.details}
                </p>
              </div>

              <div className="p-3 bg-white border border-stone-200 rounded space-y-2 text-xs">
                <div className="text-stone-500 font-semibold uppercase text-[10px] tracking-wider">
                  Detection Source
                </div>
                <div className="text-stone-800">
                  Signal identified via <span className="font-mono font-medium">{selectedItem.source}</span> analysis.
                </div>
              </div>

              <div className="p-3 bg-rose-50/50 border border-rose-200/80 rounded space-y-1 text-xs">
                <div className="text-rose-800 font-semibold uppercase text-[10px] tracking-wider">
                  Recommended Action
                </div>
                <div className="text-stone-700">
                  {selectedItem.severity === 'info' 
                    ? 'Retain this structure. Healthy original commentary aids monetization compliance.' 
                    : 'Consider adding spoken context or transforming with personal editorial critique.'}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-8 text-center text-stone-400 text-xs">
              Select an item on the timeline to view details.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
