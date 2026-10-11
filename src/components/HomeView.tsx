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
              <span>Try Demo Scan</span>
            </button>
          </div>

          {/* Technical Specs & Disclaimer */}
          <div className="space-y-2 pt-2">
            <p className="text-xs text-stone-400">
              Supports MP4, MOV, WebM, MKV · Up to 4K resolution · 10 free minutes included
            </p>
            <p className="text-[11px] text-stone-400 italic max-w-xl mx-auto leading-normal">
              *VideoRisk provides evidence-based risk analysis, not a guarantee of YouTube approval, copyright clearance, or monetization eligibility.*
            </p>
          </div>
        </div>
      </section>

      {/* 2. UNDERSTAND YOUR VIDEO BEYOND A SINGLE SCORE */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 space-y-10">
        <div className="text-center max-w-3xl mx-auto space-y-3">
          <h2 className="text-2xl sm:text-3xl font-extrabold text-stone-900 tracking-tight">
            Understand Your Video Beyond a Single Score
          </h2>
          <p className="text-sm sm:text-base text-stone-600 leading-relaxed">
            A useful review should explain more than whether something looks risky. It should help you understand what was observed, why it may matter, and what deserves your attention.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Card 1: Reused-content signals */}
          <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-xs hover:border-stone-300 transition-all flex flex-col justify-between space-y-5">
            <div className="space-y-3">
              <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center font-bold">
                <Layers className="w-5 h-5" />
              </div>
              <h3 className="font-bold text-base text-stone-900">
                Reused-content signals
              </h3>
              <p className="text-xs text-stone-600 leading-relaxed">
                Identify available signals that may warrant closer review of third-party footage or externally sourced sequences. Understand why context, meaningful original contribution, and the way content is used matter when evaluating reused-content concerns.
              </p>
            </div>
            <div className="pt-3 border-t border-stone-100 bg-stone-50/60 -mx-6 -mb-6 p-4 rounded-b-2xl">
              <p className="text-xs text-stone-800 leading-normal">
                <strong className="font-bold text-stone-900">What you gain:</strong> Clearer guidance on which material to review and what evidence of your contribution may be relevant.
              </p>
            </div>
          </div>

          {/* Card 2: Original contribution */}
          <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-xs hover:border-stone-300 transition-all flex flex-col justify-between space-y-5">
            <div className="space-y-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <h3 className="font-bold text-base text-stone-900">
                Original contribution
              </h3>
              <p className="text-xs text-stone-600 leading-relaxed">
                Review available indicators related to creator commentary, analysis, creative context, and how the video adds value beyond its source material.
              </p>
            </div>
            <div className="pt-3 border-t border-stone-100 bg-stone-50/60 -mx-6 -mb-6 p-4 rounded-b-2xl">
              <p className="text-xs text-stone-800 leading-normal">
                <strong className="font-bold text-stone-900">What you gain:</strong> A better understanding of the questions to ask about your own contribution, without treating audio activity or editing intensity as proof of originality.
              </p>
            </div>
          </div>

          {/* Card 3: Repetitive and mass-produced patterns */}
          <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-xs hover:border-stone-300 transition-all flex flex-col justify-between space-y-5">
            <div className="space-y-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
                <Sliders className="w-5 h-5" />
              </div>
              <h3 className="font-bold text-base text-stone-900">
                Repetitive and mass-produced patterns
              </h3>
              <p className="text-xs text-stone-600 leading-relaxed">
                Examine observable scene, pacing, and repetition patterns that may deserve a closer look. Understand the difference between a measurable editing pattern and a conclusion about repetitive or inauthentic content.
              </p>
            </div>
            <div className="pt-3 border-t border-stone-100 bg-stone-50/60 -mx-6 -mb-6 p-4 rounded-b-2xl">
              <p className="text-xs text-stone-800 leading-normal">
                <strong className="font-bold text-stone-900">What you gain:</strong> More informed decisions about differentiation, creative value, and whether further review is needed.
              </p>
            </div>
          </div>

          {/* Card 4: AI-generated and synthetic-content signals */}
          <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-xs hover:border-stone-300 transition-all flex flex-col justify-between space-y-5">
            <div className="space-y-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
                <Eye className="w-5 h-5" />
              </div>
              <h3 className="font-bold text-base text-stone-900">
                AI-generated and synthetic-content signals
              </h3>
              <p className="text-xs text-stone-600 leading-relaxed">
                Review available signals that may be relevant to synthetic audio or other AI-assisted content. Understand when additional context or a separate disclosure check may be necessary.
              </p>
            </div>
            <div className="pt-3 border-t border-stone-100 bg-stone-50/60 -mx-6 -mb-6 p-4 rounded-b-2xl">
              <p className="text-xs text-stone-800 leading-normal">
                <strong className="font-bold text-stone-900">What you gain:</strong> Better awareness of potential disclosure considerations, without assuming that a voice or sound pattern alone proves AI generation or determines whether disclosure is required.
              </p>
            </div>
          </div>

          {/* Card 5: Third-party content and copyright signals */}
          <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-xs hover:border-stone-300 transition-all flex flex-col justify-between space-y-5">
            <div className="space-y-3">
              <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-700 flex items-center justify-center font-bold">
                <Scale className="w-5 h-5" />
              </div>
              <h3 className="font-bold text-base text-stone-900">
                Third-party content and copyright signals
              </h3>
              <p className="text-xs text-stone-600 leading-relaxed">
                Keep copyright-related observations separate from YouTube Partner Program reused-content considerations. Review available evidence and licensing questions to determine what may need further verification.
              </p>
              <p className="text-[11px] text-stone-500 italic leading-snug pt-1">
                *VideoRisk does not perform YouTube Content ID matching or prove copyright clearance unless a specific, verified capability is explicitly available.*
              </p>
            </div>
            <div className="pt-3 border-t border-stone-100 bg-stone-50/60 -mx-6 -mb-6 p-4 rounded-b-2xl">
              <p className="text-xs text-stone-800 leading-normal">
                <strong className="font-bold text-stone-900">What you gain:</strong> A clearer path to checking source material, permissions, and other relevant rights instead of treating every third-party-content concern as the same problem.
              </p>
            </div>
          </div>

          {/* Card 6: Advertiser-friendly content signals */}
          <div className="bg-white rounded-2xl border border-stone-200 p-6 shadow-xs hover:border-stone-300 transition-all flex flex-col justify-between space-y-5">
            <div className="space-y-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center font-bold">
                <AlertCircle className="w-5 h-5" />
              </div>
              <h3 className="font-bold text-base text-stone-900">
                Advertiser-friendly content signals
              </h3>
              <p className="text-xs text-stone-600 leading-relaxed">
                Review available indicators involving profanity, sensitive themes, or potentially shocking material. Understand which findings may warrant a closer look at advertiser-friendly guidelines.
              </p>
            </div>
            <div className="pt-3 border-t border-stone-100 bg-stone-50/60 -mx-6 -mb-6 p-4 rounded-b-2xl">
              <p className="text-xs text-stone-800 leading-normal">
                <strong className="font-bold text-stone-900">What you gain:</strong> More context for reviewing sensitive sections before publishing, without assuming that a detected signal automatically makes a video unsuitable for advertising.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 3. THE VIDEORISK DIFFERENCE */}
      <section className="bg-stone-50 border-y border-stone-200 py-16 sm:py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto space-y-12">
          <div className="text-center max-w-3xl mx-auto space-y-3">
            <span className="text-xs uppercase tracking-wider text-rose-600 font-extrabold">
              The VideoRisk Difference
            </span>
            <h2 className="text-2xl sm:text-4xl font-black text-stone-900 tracking-tight">
              Not a simplistic score. An explainable workflow.
            </h2>
            <div className="text-sm sm:text-base text-stone-600 space-y-2 max-w-2xl mx-auto leading-relaxed">
              <p>
                A finding is only useful when you can understand where it came from, why it matters, and what to do next.
              </p>
              <p>
                VideoRisk is designed to connect multiple stages of review into one practical workflow.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {/* Step 1: Evidence */}
            <div className="p-6 bg-white rounded-2xl border border-stone-200 shadow-xs space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-rose-600 bg-rose-50 px-2 py-0.5 rounded">01</span>
                <h3 className="font-bold text-base text-stone-900">1. Evidence</h3>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                Examine available audio, visual, scene, and video-context signals. Findings should be traceable to the evidence actually collected.
              </p>
            </div>

            {/* Step 2: Policy Context */}
            <div className="p-6 bg-white rounded-2xl border border-stone-200 shadow-xs space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-rose-600 bg-rose-50 px-2 py-0.5 rounded">02</span>
                <h3 className="font-bold text-base text-stone-900">2. Policy Context</h3>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                Understand the relevant YouTube policy area and how it relates to the finding. Keep copyright, reused content, inauthentic content, and advertiser suitability distinct.
              </p>
            </div>

            {/* Step 3: Risk Interpretation */}
            <div className="p-6 bg-white rounded-2xl border border-stone-200 shadow-xs space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-rose-600 bg-rose-50 px-2 py-0.5 rounded">03</span>
                <h3 className="font-bold text-base text-stone-900">3. Risk Interpretation</h3>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                See why an observation may deserve attention, together with its confidence, limitations, and unresolved questions.
              </p>
            </div>

            {/* Step 4: Explanation */}
            <div className="p-6 bg-white rounded-2xl border border-stone-200 shadow-xs space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-rose-600 bg-rose-50 px-2 py-0.5 rounded">04</span>
                <h3 className="font-bold text-base text-stone-900">4. Explanation</h3>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                Learn what was observed, why it may matter, and what the system cannot establish from the available evidence.
              </p>
            </div>

            {/* Step 5: Actionable Guidance */}
            <div className="p-6 bg-white rounded-2xl border border-stone-200 shadow-xs space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-rose-600 bg-rose-50 px-2 py-0.5 rounded">05</span>
                <h3 className="font-bold text-base text-stone-900">5. Actionable Guidance</h3>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                Get practical next steps tailored to the finding, such as reviewing a specific segment, checking a source, verifying permissions, or documenting your creative contribution.
              </p>
            </div>

            {/* Step 6: Re-scan and Compare */}
            <div className="p-6 bg-white rounded-2xl border border-rose-300 bg-rose-50/20 shadow-xs space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black text-rose-700 bg-rose-100 px-2 py-0.5 rounded">06</span>
                <h3 className="font-bold text-base text-rose-900">6. Re-scan and Compare</h3>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                Review your revised video and compare the new findings with the previous scan. Understand what changed, what remains unresolved, and which conclusions still require independent verification.
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
