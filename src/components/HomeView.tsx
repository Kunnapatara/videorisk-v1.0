import React from 'react';
import { 
  ShieldCheck, 
  Video, 
  Zap, 
  CheckCircle2, 
  Layers, 
  FileText, 
  RefreshCw, 
  Scale, 
  AlertCircle, 
  Eye, 
  ArrowRight,
  BookOpen,
  Sliders,
  Check
} from 'lucide-react';

interface HomeViewProps {
  onStartUpload: () => void;
  onExplorePricing: () => void;
  onTryDemo: () => void;
}

export const HomeView: React.FC<HomeViewProps> = ({ 
  onStartUpload, 
  onExplorePricing, 
  onTryDemo 
}) => {
  return (
    <div className="space-y-16 sm:space-y-20 pb-20">
      {/* 1. HERO SECTION */}
      <section className="bg-stone-900 text-white pt-16 sm:pt-20 pb-20 sm:pb-24 px-4 sm:px-6 lg:px-8 border-b border-stone-800 relative overflow-hidden">
        <div className="max-w-4xl mx-auto text-center space-y-6 sm:space-y-7 relative z-10">
          {/* Eyebrow Pill */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-stone-800/90 border border-stone-700/80 text-xs font-semibold text-rose-400 tracking-wide shadow-xs">
            <ShieldCheck className="w-4 h-4 text-rose-500 shrink-0" />
            <span>Pre-Publish Video Risk Intelligence</span>
          </div>

          {/* Main Headline */}
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-black tracking-tight leading-[1.1] text-white">
            Know the risk before you publish.
          </h1>

          {/* Subheading */}
          <p className="text-lg sm:text-2xl font-bold text-stone-200 tracking-tight">
            Your video deserves more than a score.
          </p>

          {/* Core Body Copy */}
          <div className="text-sm sm:text-base text-stone-300 max-w-2xl mx-auto space-y-3 font-normal leading-relaxed text-stone-300/90">
            <p>
              VideoRisk examines available video, audio, scene, and publishing-context signals to help you understand what may need attention before your video goes live.
            </p>
            <p>
              See the evidence. Understand the relevant platform policies. Learn what the findings mean, what remains uncertain, and what you can do next.
            </p>
            <p>
              Review your findings, make informed changes, and re-scan your revised video to compare the results.
            </p>
          </div>

          {/* Primary Action Buttons */}
          <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-3.5">
            <button
              onClick={onStartUpload}
              className="w-full sm:w-auto px-8 py-3.5 bg-rose-600 hover:bg-rose-500 active:scale-98 text-white font-bold text-sm rounded-xl shadow-lg shadow-rose-950/40 transition-all flex items-center justify-center gap-2"
            >
              <Video className="w-4 h-4" />
              <span>Upload Video</span>
            </button>

            <button
              onClick={onTryDemo}
              className="w-full sm:w-auto px-7 py-3.5 bg-stone-800 hover:bg-stone-700 active:scale-98 text-stone-200 border border-stone-700 font-semibold text-sm rounded-xl transition-all flex items-center justify-center gap-2 shadow-xs"
            >
              <Zap className="w-4 h-4 text-amber-400" />
              <span>Explore Sample Scan · 2 credits</span>
            </button>
          </div>

          <p className="text-[11px] text-stone-400 max-w-md mx-auto pt-1">
            Sample evaluations run in your account, require an available credit balance, and consume 2 evaluation credits.
          </p>

          {/* Technical Specs & Disclaimer */}
          <div className="space-y-2 pt-2">
            <p className="text-xs text-stone-400">
              Supports MP4, MOV, WebM, MKV · Up to 4K resolution · 10-minute evaluation trial for new accounts
            </p>
            <p className="text-[11px] text-stone-400 italic max-w-xl mx-auto leading-normal">
              *VideoRisk provides evidence-based risk analysis, not a guarantee of YouTube approval, copyright clearance, or monetization eligibility.*
            </p>
          </div>
        </div>
      </section>

      {/* 2. THREE PILLARS OF PRE-PUBLISH RISK INTELLIGENCE */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 space-y-10">
        <div className="text-center max-w-3xl mx-auto space-y-3">
          <span className="text-xs uppercase tracking-wider text-rose-600 font-extrabold">
            Comprehensive Analysis Architecture
          </span>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-stone-900 tracking-tight">
            Three Pillars of Pre-Publish Risk Intelligence
          </h2>
          <p className="text-sm sm:text-base text-stone-600 leading-relaxed">
            A reliable review connects multi-modal media inspection, creator production context, and before-and-after cut verification into one explainable workflow.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-8">
          {/* Pillar 1: Detection Engines */}
          <div className="bg-white rounded-2xl border border-stone-200 p-6 sm:p-7 shadow-xs hover:border-stone-300 transition-all flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="w-12 h-12 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center font-bold">
                <Layers className="w-6 h-6" />
              </div>
              <div>
                <span className="text-[11px] font-mono uppercase tracking-wider text-rose-600 font-bold block mb-1">
                  Pillar 01
                </span>
                <h3 className="font-bold text-lg text-stone-900">
                  Multi-Modal Detection Engines
                </h3>
              </div>
              <p className="text-xs sm:text-sm text-stone-600 leading-relaxed">
                Inspects video frames, audio tracks, spoken narration, scene pacing, and metadata alignment to identify potential policy friction points before upload.
              </p>
              
              <ul className="space-y-2 pt-2 border-t border-stone-100 text-xs text-stone-600">
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Audio & Speech:</strong> Measures spoken commentary presence and voiceover consistency.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Visual Repetition:</strong> Analyzes scene duration, static slides, and reused visual segments.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Metadata Coherence:</strong> Evaluates title-to-content alignment and thumbnail integrity.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Ad Suitability:</strong> Flags sensitive themes, shocking imagery, and profanity signals.</span>
                </li>
              </ul>
            </div>

            <div className="pt-3 border-t border-stone-100 bg-stone-50/70 -mx-6 -mb-6 sm:-mx-7 sm:-mb-7 p-4 sm:p-5 rounded-b-2xl">
              <p className="text-xs text-stone-700 leading-normal">
                <strong className="font-bold text-stone-900">Evidence First:</strong> Every finding links directly to timestamps and concrete media observations.
              </p>
            </div>
          </div>

          {/* Pillar 2: Channel Context */}
          <div className="bg-white rounded-2xl border border-stone-200 p-6 sm:p-7 shadow-xs hover:border-stone-300 transition-all flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center font-bold">
                <Sliders className="w-6 h-6" />
              </div>
              <div>
                <span className="text-[11px] font-mono uppercase tracking-wider text-amber-700 font-bold block mb-1">
                  Pillar 02
                </span>
                <h3 className="font-bold text-lg text-stone-900">
                  Declared Channel Context
                </h3>
              </div>
              <p className="text-xs sm:text-sm text-stone-600 leading-relaxed">
                Grounds findings in your declared production workflow—such as critical commentary, educational breakdown, or gaming critique—preventing false alarms.
              </p>
              
              <ul className="space-y-2 pt-2 border-t border-stone-100 text-xs text-stone-600">
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Format Grounding:</strong> Applies fair-use transformational standards tailored to your niche.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Snapshot Versioning:</strong> Saves a permanent profile record with every video scan.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Catalog Patterns:</strong> Tracks cross-video risk trends across your completed scans (requires 2+ videos).</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Clear Scope:</strong> Distinguishes creator-declared context from independent platform clearance.</span>
                </li>
              </ul>
            </div>

            <div className="pt-3 border-t border-stone-100 bg-stone-50/70 -mx-6 -mb-6 sm:-mx-7 sm:-mb-7 p-4 sm:p-5 rounded-b-2xl">
              <p className="text-xs text-stone-700 leading-normal">
                <strong className="font-bold text-stone-900">Context That Matters:</strong> Avoids treating review clips or parody excerpts as raw reused content.
              </p>
            </div>
          </div>

          {/* Pillar 3: Verifiable Comparison */}
          <div className="bg-white rounded-2xl border border-stone-200 p-6 sm:p-7 shadow-xs hover:border-stone-300 transition-all flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
                <Scale className="w-6 h-6" />
              </div>
              <div>
                <span className="text-[11px] font-mono uppercase tracking-wider text-emerald-700 font-bold block mb-1">
                  Pillar 03
                </span>
                <h3 className="font-bold text-lg text-stone-900">
                  Verifiable Cut Comparison
                </h3>
              </div>
              <p className="text-xs sm:text-sm text-stone-600 leading-relaxed">
                Upload revised cuts to verify that edits resolved targeted signals, track before-and-after deltas, and document residual considerations.
              </p>
              
              <ul className="space-y-2 pt-2 border-t border-stone-100 text-xs text-stone-600">
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Side-by-Side Deltas:</strong> Compares original vs. revised risk scores and signal counts.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Resolved Issues:</strong> Confirms which specific segment warnings have been resolved.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Residual Questions:</strong> Highlights remaining items still requiring your editorial review.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span><strong>Revision Archive:</strong> Keeps parent-child scan lineage organized in your account archive.</span>
                </li>
              </ul>
            </div>

            <div className="pt-3 border-t border-stone-100 bg-stone-50/70 -mx-6 -mb-6 sm:-mx-7 sm:-mb-7 p-4 sm:p-5 rounded-b-2xl">
              <p className="text-xs text-stone-700 leading-normal">
                <strong className="font-bold text-stone-900">Actionable Feedback:</strong> Close the loop with measured verification before uploading to YouTube.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 4. MORE THAN DETECTION. A BETTER-INFORMED CREATOR. */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 space-y-10">
        <div className="text-center max-w-3xl mx-auto space-y-3">
          <span className="text-xs uppercase tracking-wider text-rose-600 font-extrabold">
            More Than Detection. A Better-Informed Creator.
          </span>
          <h2 className="text-2xl sm:text-4xl font-black text-stone-900 tracking-tight">
            Understand the rules behind your work.
          </h2>
          <div className="text-sm sm:text-base text-stone-600 space-y-2 max-w-2xl mx-auto leading-relaxed">
            <p>
              Platform policies are often broad, and a general policy statement cannot tell you everything about a specific video.
            </p>
            <p>
              VideoRisk helps connect three important pieces of the puzzle:
            </p>
          </div>
        </div>

        {/* 3 Pillars */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-xs space-y-3 text-center sm:text-left">
            <div className="w-10 h-10 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center font-bold">
              <BookOpen className="w-5 h-5 text-rose-600" />
            </div>
            <h3 className="font-bold text-base text-stone-900">
              Official Policy
            </h3>
            <p className="text-xs text-stone-600 leading-relaxed">
              What the platform's published guidance says.
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-xs space-y-3 text-center sm:text-left">
            <div className="w-10 h-10 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center font-bold">
              <FileText className="w-5 h-5 text-rose-600" />
            </div>
            <h3 className="font-bold text-base text-stone-900">
              Your Video's Evidence
            </h3>
            <p className="text-xs text-stone-600 leading-relaxed">
              What the available analysis actually observed in your content.
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-xs space-y-3 text-center sm:text-left">
            <div className="w-10 h-10 rounded-xl bg-stone-100 text-stone-800 flex items-center justify-center font-bold">
              <ArrowRight className="w-5 h-5 text-rose-600" />
            </div>
            <h3 className="font-bold text-base text-stone-900">
              Your Next Step
            </h3>
            <p className="text-xs text-stone-600 leading-relaxed">
              What you can reasonably do, verify, or investigate further.
            </p>
          </div>
        </div>

        <p className="text-xs sm:text-sm text-stone-500 text-center max-w-2xl mx-auto leading-relaxed pt-2">
          The goal is not to make you afraid of publishing. It is to help you make better-informed decisions with a clearer understanding of the evidence and its limitations.
        </p>
      </section>

      {/* 5. WHAT YOU GET FROM EVERY REVIEW */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white rounded-2xl border border-stone-200 p-8 sm:p-10 shadow-xs space-y-8">
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-xl sm:text-2xl font-black text-stone-900 tracking-tight">
              What You Get From Every Review
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
                <Check className="w-3.5 h-3.5 stroke-3" />
              </div>
              <p className="text-xs sm:text-sm text-stone-700 leading-relaxed">
                <strong className="font-bold text-stone-900">Evidence you can investigate:</strong> Understand the observations behind each finding.
              </p>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
                <Check className="w-3.5 h-3.5 stroke-3" />
              </div>
              <p className="text-xs sm:text-sm text-stone-700 leading-relaxed">
                <strong className="font-bold text-stone-900">Context that matters:</strong> Learn which policy area may be relevant and why.
              </p>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
                <Check className="w-3.5 h-3.5 stroke-3" />
              </div>
              <p className="text-xs sm:text-sm text-stone-700 leading-relaxed">
                <strong className="font-bold text-stone-900">Clear limitations:</strong> Know what was not verified or cannot be concluded.
              </p>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
                <Check className="w-3.5 h-3.5 stroke-3" />
              </div>
              <p className="text-xs sm:text-sm text-stone-700 leading-relaxed">
                <strong className="font-bold text-stone-900">Practical next steps:</strong> Turn findings into actions you can evaluate and perform.
              </p>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
                <Check className="w-3.5 h-3.5 stroke-3" />
              </div>
              <p className="text-xs sm:text-sm text-stone-700 leading-relaxed">
                <strong className="font-bold text-stone-900">A record of your reviews:</strong> Revisit previous scans and their findings.
              </p>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
                <Check className="w-3.5 h-3.5 stroke-3" />
              </div>
              <p className="text-xs sm:text-sm text-stone-700 leading-relaxed">
                <strong className="font-bold text-stone-900">Before-and-after comparison:</strong> Where supported by the scan data, compare findings after making changes.
              </p>
            </div>
          </div>

          <div className="pt-4 border-t border-stone-100 text-center">
            <p className="text-[11px] text-stone-500 italic max-w-xl mx-auto leading-normal">
              *VideoRisk findings are assessments to inform your decisions. Only the relevant platform can make its own final policy, copyright, and monetization decisions.*
            </p>
          </div>
        </div>
      </section>

      {/* 6. READY TO UNDERSTAND YOUR VIDEO BEFORE PUBLISHING? */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
        <div className="p-8 sm:p-12 bg-stone-900 text-white rounded-3xl border border-stone-800 space-y-6 shadow-xl shadow-stone-950/20">
          <div className="space-y-3">
            <h3 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
              Ready to Understand Your Video Before Publishing?
            </h3>
            <div className="text-sm sm:text-base text-stone-300 max-w-lg mx-auto space-y-1.5 leading-relaxed">
              <p>Give your next upload a more informed review.</p>
              <p className="text-stone-400">
                Explore the available evidence, understand potential policy concerns, and decide what deserves attention before you publish.
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row justify-center items-center gap-3.5 pt-2">
            <button
              onClick={onStartUpload}
              className="w-full sm:w-auto px-8 py-3.5 bg-rose-600 hover:bg-rose-500 active:scale-98 text-white font-bold text-sm rounded-xl shadow-lg shadow-rose-950/40 transition-all flex items-center justify-center gap-2"
            >
              <Video className="w-4 h-4" />
              <span>Upload Video Now</span>
            </button>
            <button
              onClick={onExplorePricing}
              className="w-full sm:w-auto px-7 py-3.5 bg-stone-800 hover:bg-stone-700 active:scale-98 text-stone-200 border border-stone-700 font-semibold text-sm rounded-xl transition-all"
            >
              View Pricing & Credits
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
