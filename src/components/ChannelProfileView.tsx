import React, { useState, useEffect } from 'react';
import { ChannelContextProfile, CrossVideoPattern, UserAccount } from '../types';
import { authFetch } from '../utils/api';
import { 
  Tv, 
  Save, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle, 
  TrendingUp, 
  Sparkles, 
  Info, 
  Layers, 
  FileCheck,
  AlertTriangle,
  ArrowRight
} from 'lucide-react';

interface ChannelProfileViewProps {
  user: UserAccount | null;
  onStartScan: () => void;
}

export const ChannelProfileView: React.FC<ChannelProfileViewProps> = ({ user, onStartScan }) => {
  const [profile, setProfile] = useState<ChannelContextProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Form State
  const [channelTopic, setChannelTopic] = useState('');
  const [contentType, setContentType] = useState<ChannelContextProfile['contentType']>('commentary');
  const [productionWorkflow, setProductionWorkflow] = useState('');
  const [thirdPartyFootageUsage, setThirdPartyFootageUsage] = useState<ChannelContextProfile['thirdPartyFootageUsage']>('fair_use_commentary');
  const [originalVoiceNarration, setOriginalVoiceNarration] = useState<ChannelContextProfile['originalVoiceNarration']>('always');
  const [aiAssistedContent, setAiAssistedContent] = useState(false);
  const [aiDisclosureDetails, setAiDisclosureDetails] = useState('');
  const [typicalSources, setTypicalSources] = useState('');

  // Cross-video patterns
  const [patternsData, setPatternsData] = useState<{
    sampleSize: number;
    patterns: CrossVideoPattern[];
    disclaimer: string;
  } | null>(null);

  useEffect(() => {
    loadProfileAndPatterns();
  }, [user]);

  const loadProfileAndPatterns = async () => {
    setLoading(true);
    try {
      // 1. Load Profile
      const profRes = await authFetch('/api/channel/profile');
      if (profRes.ok) {
        const profData = await profRes.json();
        if (profData) {
          setProfile(profData);
          setChannelTopic(profData.channelTopic || '');
          setContentType(profData.contentType || 'commentary');
          setProductionWorkflow(profData.productionWorkflow || '');
          setThirdPartyFootageUsage(profData.thirdPartyFootageUsage || 'fair_use_commentary');
          setOriginalVoiceNarration(profData.originalVoiceNarration || 'always');
          setAiAssistedContent(!!profData.aiAssistedContent);
          setAiDisclosureDetails(profData.aiDisclosureDetails || '');
          setTypicalSources(profData.typicalSources || '');
        }
      }

      // 2. Load Patterns
      const patRes = await authFetch('/api/channel/patterns');
      if (patRes.ok) {
        const patData = await patRes.json();
        setPatternsData(patData);
      }
    } catch (err) {
      console.warn('Failed to load channel context profile:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveMessage(null);

    try {
      const res = await authFetch('/api/channel/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelTopic,
          contentType,
          productionWorkflow,
          thirdPartyFootageUsage,
          originalVoiceNarration,
          aiAssistedContent,
          aiDisclosureDetails,
          typicalSources,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save channel profile.');
      }

      const updated = await res.json();
      setProfile(updated);
      setSaveMessage({
        type: 'success',
        text: `Channel Context Profile v${updated.version} saved. Future scans will snapshot this context.`
      });
    } catch (err: any) {
      setSaveMessage({
        type: 'error',
        text: err.message || 'Error saving profile.'
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto py-6 sm:py-10 px-4 sm:px-6 space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded bg-stone-200 text-stone-800 text-xs font-semibold mb-2">
            <Tv className="w-3.5 h-3.5 text-rose-600" />
            <span>Persistent Context Intelligence</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-stone-900 tracking-tight">
            Channel Context Profile
          </h1>
          <p className="text-xs sm:text-sm text-stone-600 mt-1 max-w-2xl leading-relaxed">
            Tell VideoRisk about your production format and fair-use workflow. Grounding analysis in your declared channel context prevents false positives and improves policy interpretation.
          </p>
        </div>

        <button
          onClick={onStartScan}
          className="self-start sm:self-auto px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-lg shadow-sm transition-colors flex items-center gap-2"
        >
          <span>Start Scan with Context</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Expectation Management Disclaimer */}
      <div className="p-4 bg-stone-900 text-stone-200 rounded-xl text-xs space-y-1.5 border border-stone-800">
        <div className="flex items-center gap-2 font-bold text-white">
          <Info className="w-4 h-4 text-rose-400" />
          <span>About Channel Context Grounding</span>
        </div>
        <p className="leading-relaxed text-stone-300">
          Channel context is user-declared. It helps VideoRisk distinguish educational commentary from unedited compilations, but does not substitute for independent copyright permissions or guarantee YouTube Partner Program decisions.
        </p>
      </div>

      {saveMessage && (
        <div className={`p-4 rounded-xl border flex items-start gap-3 text-xs ${
          saveMessage.type === 'success' 
            ? 'bg-emerald-50 border-emerald-200 text-emerald-900' 
            : 'bg-rose-50 border-rose-200 text-rose-900'
        }`}>
          {saveMessage.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          )}
          <div>
            <p className="font-bold">{saveMessage.type === 'success' ? 'Profile Updated' : 'Notice'}</p>
            <p className="mt-0.5">{saveMessage.text}</p>
          </div>
        </div>
      )}

      {/* Main Profile Form */}
      <div className="bg-white rounded-2xl border border-stone-200 shadow-xs overflow-hidden">
        <form onSubmit={handleSaveProfile} className="p-6 sm:p-8 space-y-6">
          <div className="flex items-center justify-between pb-4 border-b border-stone-100">
            <div>
              <h2 className="text-base font-bold text-stone-900">Creator Production Details</h2>
              <p className="text-xs text-stone-500">Every scan takes a permanent snapshot of this profile version.</p>
            </div>
            {profile && (
              <span className="text-[11px] font-mono bg-stone-100 text-stone-700 px-2.5 py-1 rounded-md font-bold">
                Version {profile.version}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Channel Topic */}
            <div>
              <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1.5">
                Primary Channel Topic / Niche
              </label>
              <input
                type="text"
                required
                value={channelTopic}
                onChange={(e) => setChannelTopic(e.target.value)}
                placeholder="e.g. Technology Reviews & Teardowns, History Documentaries"
                className="w-full px-3.5 py-2.5 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
              />
              <span className="text-[11px] text-stone-400 mt-1 block">
                Helps evaluate industry-specific terminology and context.
              </span>
            </div>

            {/* Content Type */}
            <div>
              <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1.5">
                Primary Content Format
              </label>
              <select
                value={contentType}
                onChange={(e) => setContentType(e.target.value as any)}
                className="w-full px-3.5 py-2.5 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 bg-white"
              >
                <option value="commentary">Commentary, Critique & Reaction</option>
                <option value="educational">Educational Tutorials & How-To</option>
                <option value="documentary">Documentary & Historical Essay</option>
                <option value="gaming">Gaming Playthrough & Esports</option>
                <option value="satire">Satire, Parody & Comedy</option>
                <option value="news">News & Current Events Reporting</option>
                <option value="creative">Original Creative Film / Animation</option>
                <option value="mixed">Mixed / Multi-Format Creator</option>
              </select>
              <span className="text-[11px] text-stone-400 mt-1 block">
                Informs fair-use transformational standards.
              </span>
            </div>

            {/* Third-Party Footage Usage */}
            <div>
              <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1.5">
                Third-Party Footage Practices
              </label>
              <select
                value={thirdPartyFootageUsage}
                onChange={(e) => setThirdPartyFootageUsage(e.target.value as any)}
                className="w-full px-3.5 py-2.5 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 bg-white"
              >
                <option value="none">100% Original (No external clips used)</option>
                <option value="licensed_stock">Licensed B-Roll & Stock Footage</option>
                <option value="fair_use_commentary">Short Excerpts for Critical Commentary</option>
                <option value="gameplay">Licensed Gameplay / Engine Capture</option>
                <option value="public_domain">Public Domain / Archival Footage</option>
                <option value="frequent_clips">Frequent external montage clips</option>
              </select>
              <span className="text-[11px] text-stone-400 mt-1 block">
                Sets baseline for reused-material thresholds.
              </span>
            </div>

            {/* Spoken Narration Frequency */}
            <div>
              <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1.5">
                Spoken Voice Presence
              </label>
              <select
                value={originalVoiceNarration}
                onChange={(e) => setOriginalVoiceNarration(e.target.value as any)}
                className="w-full px-3.5 py-2.5 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 bg-white"
              >
                <option value="always">Always includes creator voice narration</option>
                <option value="mostly">Mostly narrated with occasional silent B-roll</option>
                <option value="sometimes">Intermittent commentary over music</option>
                <option value="rarely">Primarily silent / text-only presentation</option>
                <option value="none">Music-only compilation</option>
              </select>
              <span className="text-[11px] text-stone-400 mt-1 block">
                Crucial indicator for YPP human monetization review.
              </span>
            </div>
          </div>

          {/* Production Workflow Textarea */}
          <div>
            <label className="block text-xs font-bold text-stone-700 uppercase tracking-wider mb-1.5">
              Production Workflow & Creative Value Add
            </label>
            <textarea
              rows={3}
              value={productionWorkflow}
              onChange={(e) => setProductionWorkflow(e.target.value)}
              placeholder="Describe your writing, scripting, and editing process (e.g. I write original scripts, record voiceover in Audacity, and use screen recordings to critique software)..."
              className="w-full px-3.5 py-2.5 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
            />
          </div>

          {/* AI Disclosure Toggle */}
          <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-bold text-stone-900 block">AI-Assisted or Synthetic Content</span>
                <span className="text-stone-500 text-[11px]">Does your channel incorporate AI voice cloning, generative avatars, or synthetic video?</span>
              </div>
              <input
                type="checkbox"
                checked={aiAssistedContent}
                onChange={(e) => setAiAssistedContent(e.target.checked)}
                className="w-4 h-4 text-rose-600 rounded focus:ring-rose-500"
              />
            </div>

            {aiAssistedContent && (
              <div className="pt-2">
                <input
                  type="text"
                  value={aiDisclosureDetails}
                  onChange={(e) => setAiDisclosureDetails(e.target.value)}
                  placeholder="Describe AI tools used (e.g. ElevenLabs voiceover, Midjourney visual backdrops)..."
                  className="w-full px-3 py-2 text-xs border border-stone-300 rounded-lg bg-white"
                />
                <span className="text-[10px] text-stone-400 mt-1 block">
                  Enables pre-publish reminders for YouTube Studio altered-content disclosure settings.
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end pt-4 border-t border-stone-100">
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-lg shadow-sm transition-colors flex items-center gap-2"
            >
              {saving ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving Context...</span>
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Channel Profile</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Cross-Video Recurring Patterns Section */}
      <div className="bg-white rounded-2xl border border-stone-200 shadow-xs p-6 sm:p-8 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-stone-100">
          <div>
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-rose-600" />
              <h2 className="text-base font-bold text-stone-900">
                Cross-Video Recurring Patterns
              </h2>
            </div>
            <p className="text-xs text-stone-500 mt-0.5">
              Identifies potential recurring signals across your own scan history.
            </p>
          </div>

          {patternsData && (
            <span className="text-xs text-stone-500 font-semibold">
              Sample: {patternsData.sampleSize} scanned video(s)
            </span>
          )}
        </div>

        {patternsData?.patterns && patternsData.patterns.length > 0 ? (
          <div className="space-y-3">
            {patternsData.patterns.map((pat) => (
              <div 
                key={pat.id}
                className="p-4 rounded-xl border border-amber-200 bg-amber-50/60 space-y-2 text-xs"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 font-bold text-amber-950">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>{pat.label}</span>
                  </div>
                  <span className="bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded text-[11px]">
                    {pat.frequency}% of videos
                  </span>
                </div>
                <p className="text-amber-900 leading-relaxed">{pat.explanation}</p>
                <div className="p-2.5 bg-white/80 rounded-lg border border-amber-200/80 text-amber-950">
                  <span className="font-bold block mb-0.5">Recommended Adjustment:</span>
                  <span>{pat.recommendation}</span>
                </div>
                <span className="text-[10px] text-amber-700 block italic">
                  {pat.disclaimer}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-6 bg-stone-50 rounded-xl text-center text-xs text-stone-500 space-y-1">
            <CheckCircle2 className="w-6 h-6 text-emerald-600 mx-auto mb-1" />
            <p className="font-bold text-stone-800">No Recurring Risk Patterns Detected</p>
            <p className="max-w-md mx-auto">
              Your uploaded scans exhibit consistent creative differentiation and narrative variation.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
