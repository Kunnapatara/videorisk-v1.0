import React from 'react';
import { ArrowLeft, FileText, ShieldAlert, Scale, CreditCard, Trash2, HelpCircle } from 'lucide-react';

interface TermsOfServiceViewProps {
  onBack: () => void;
  onOpenPrivacy: () => void;
}

export const TermsOfServiceView: React.FC<TermsOfServiceViewProps> = ({
  onBack,
  onOpenPrivacy,
}) => {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-600 hover:text-stone-900 bg-white border border-stone-200 px-3 py-1.5 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to VideoRisk</span>
        </button>

        <button
          type="button"
          onClick={onOpenPrivacy}
          className="text-xs font-semibold text-rose-600 hover:text-rose-700 hover:underline"
        >
          View Privacy Policy
        </button>
      </div>

      <div className="bg-white border border-stone-200 rounded-2xl shadow-xs overflow-hidden">
        <div className="px-6 sm:px-8 py-6 border-b border-stone-200 bg-stone-950 text-white">
          <div className="flex items-center gap-2 text-rose-400 text-xs font-bold uppercase tracking-wider mb-1.5">
            <FileText className="w-4 h-4" />
            <span>Legal &amp; Service Terms</span>
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight">Terms of Service</h1>
          <p className="text-xs text-stone-400 mt-1">
            Effective Date: [PENDING LEGAL REVIEW — PLACEHOLDER] · Draft for Pre-Launch Review
          </p>
        </div>

        <div className="p-6 sm:p-8 space-y-7 text-xs sm:text-sm text-stone-700 leading-relaxed">
          <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 text-xs space-y-1">
            <p className="font-bold">Notice Regarding Business &amp; Legal Placeholders</p>
            <p>
              Bracketed placeholders below indicate legal entity, jurisdiction, and support details that must be verified and replaced by the service operator and legal counsel prior to commercial launch.
            </p>
          </div>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-stone-900">1. Agreement &amp; Service Operator</h2>
            <p>
              These Terms of Service govern your access to and use of VideoRisk, operated by{' '}
              <span className="font-mono text-xs bg-stone-100 px-1.5 py-0.5 rounded border border-stone-200">
                [OPERATOR LEGAL ENTITY NAME — PENDING LEGAL REVIEW]
              </span>{' '}
              (<span className="font-mono text-xs bg-stone-100 px-1.5 py-0.5 rounded border border-stone-200">
                [REGISTERED BUSINESS ADDRESS — PENDING]
              </span>). By creating an account, uploading video assets, or purchasing credits or subscriptions, you agree to be bound by these Terms and the{' '}
              <button
                type="button"
                onClick={onOpenPrivacy}
                className="text-rose-600 font-semibold hover:underline"
              >
                Privacy Policy
              </button>.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-stone-900">2. What VideoRisk Analyzes</h2>
            <p>
              VideoRisk provides automated pre-publish risk intelligence for creator video drafts. When you submit a scan, the service inspects technical media properties, audio/speech tracks, visual frames, thumbnails, video titles, descriptions, tags, and any channel context profile you choose to configure.
            </p>
            <p>
              Based on those inputs, VideoRisk generates structured evidence timelines, cross-video pattern comparisons, and informational risk reports covering areas such as reused content indicators, original contribution signals, metadata coherence, thumbnail integrity, and advertiser-friendly / community guideline considerations.
            </p>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-stone-900">
              <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-base font-bold">3. Service Limitations &amp; No Legal or Platform Guarantees</h2>
            </div>
            <p className="font-semibold text-stone-900">
              VideoRisk provides informational policy risk indicators only. Risk reports, scores, and recommendations are NOT legal advice, copyright clearance, or predictions or guarantees of decisions by YouTube or any other platform.
            </p>
            <p>
              Automated detectors (including speech transcription, optical character recognition, and visual/audio heuristic models) can miss signals, produce false positives, or become unavailable due to unsupported formats or missing optional engines. You remain solely responsible for reviewing your content, obtaining all necessary rights and licenses, and complying with applicable laws and platform terms before publishing.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-stone-900">4. Acceptable Content &amp; Account Responsibilities</h2>
            <p>
              You represent that you own or have lawful authorization to upload and analyze all video files, audio tracks, and thumbnails submitted through your account. You must not use VideoRisk to process unlawful material, attempt unauthorized access to other users&apos; assets, bypass rate limits, or disrupt service infrastructure.
            </p>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-stone-900">
              <CreditCard className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-base font-bold">5. Credits, Billing &amp; Subscriptions</h2>
            </div>
            <p>
              Scan usage is metered in credits calculated from video duration and selected scan mode (Standard or Deep). New accounts receive starter credits subject to one-time free-trial rules. Paid plans, one-time audits, and recurring subscriptions are billed through Stripe Checkout and managed via the Stripe Customer Portal.
            </p>
            <p>
              Failed scan jobs automatically reconcile and refund deducted scan credits back to your account balance when applicable. Refunds or charge disputes processed through Stripe update corresponding credit and subscription entitlements in your account ledger.
            </p>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-stone-900">
              <Trash2 className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-base font-bold">6. Content Retention &amp; Permanent Account Deletion</h2>
            </div>
            <p>
              You can delete individual scans or permanently delete your entire user account at any time from Account Settings. Deleting a scan removes the scan record and unshared media files. Deleting your account revokes all sessions, purges personal profile data, scans, reports, evidence, channel context, and unshared media assets, while retaining only de-identified financial and billing audit records needed for accounting and dispute compliance.
            </p>
            <p>
              In addition, raw uploaded videos, generated proxies, thumbnails, and temporary frame artifacts are subject to automated retention cleanup windows as described in the Privacy Policy.
            </p>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-stone-900">
              <Scale className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-base font-bold">7. Limitation of Liability &amp; Governing Law</h2>
            </div>
            <p>
              To the maximum extent permitted by applicable law, the service is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis without warranties of uninterrupted availability, monetization eligibility, or platform acceptance. These Terms are governed by the laws of{' '}
              <span className="font-mono text-xs bg-stone-100 px-1.5 py-0.5 rounded border border-stone-200">
                [GOVERNING JURISDICTION — PENDING LEGAL REVIEW]
              </span>.
            </p>
          </section>

          <section className="space-y-2 pt-2 border-t border-stone-200">
            <div className="flex items-center gap-2 text-stone-900">
              <HelpCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-base font-bold">8. Support &amp; Contact Information</h2>
            </div>
            <p>
              For account support, billing inquiries, or legal notices, contact:{' '}
              <span className="font-mono text-xs bg-stone-100 px-1.5 py-0.5 rounded border border-stone-200">
                [SUPPORT &amp; LEGAL CONTACT EMAIL — PENDING CONFIGURATION]
              </span>. Automated transactional account emails (such as password recovery notices) are sent from the deployment&apos;s configured <code className="font-mono text-xs">SMTP_FROM</code> / <code className="font-mono text-xs">EMAIL_FROM</code> address when mail delivery is enabled.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
};
