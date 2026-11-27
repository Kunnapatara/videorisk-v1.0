import React from 'react';
import { ArrowLeft, ShieldCheck, Database, Film, Clock, CreditCard, Trash2, Mail } from 'lucide-react';

interface PrivacyPolicyViewProps {
  onBack: () => void;
  onOpenTerms: () => void;
}

export const PrivacyPolicyView: React.FC<PrivacyPolicyViewProps> = ({
  onBack,
  onOpenTerms,
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
          onClick={onOpenTerms}
          className="text-xs font-semibold text-rose-600 hover:text-rose-700 hover:underline"
        >
          View Terms of Service
        </button>
      </div>

      <div className="bg-white border border-stone-200 rounded-2xl shadow-xs overflow-hidden">
        <div className="px-6 sm:px-8 py-6 border-b border-stone-200 bg-stone-950 text-white">
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-bold uppercase tracking-wider mb-1.5">
            <ShieldCheck className="w-4 h-4" />
            <span>Data Protection &amp; Retention</span>
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight">Privacy Policy</h1>
          <p className="text-xs text-stone-400 mt-1">
            Effective Date: [PENDING LEGAL REVIEW — PLACEHOLDER] · Draft for Pre-Launch Review
          </p>
        </div>

        <div className="p-6 sm:p-8 space-y-7 text-xs sm:text-sm text-stone-700 leading-relaxed">
          <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 text-xs space-y-1">
            <p className="font-bold">Notice Regarding Legal Entity &amp; Policy Review Placeholders</p>
            <p>
              Bracketed placeholders and default retention windows below reflect configurable system defaults and require review and approval by the data controller and legal counsel prior to production activation.
            </p>
          </div>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-stone-900">
              <Database className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-base font-bold">1. Data We Collect and Why</h2>
            </div>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <strong>Account &amp; Authentication Data:</strong> Your email address, salted scrypt password hash, session tokens, and single-use password reset token hashes to authenticate access and protect your account.
              </li>
              <li>
                <strong>Uploaded Media &amp; Scan Inputs:</strong> Video files, thumbnail images, titles, descriptions, tags, and optional channel context profiles that you submit so VideoRisk can inspect policy risk indicators.
              </li>
              <li>
                <strong>Derived Evidence &amp; Reports:</strong> Extracted audio/speech transcripts, sampled visual frame diagnostics, OCR text snippets, risk reports, cross-video comparisons, and channel intelligence summaries displayed in your workspace.
              </li>
              <li>
                <strong>Billing &amp; Credit Records:</strong> Subscription status, credit transaction ledger entries, and Stripe payment/refund identifiers needed to grant credits, prevent duplicate charges, and reconcile refunds. Full credit card numbers are processed directly by Stripe and are never stored by VideoRisk.
              </li>
              <li>
                <strong>Operational &amp; Security Telemetry:</strong> Rate-limiting records (client network key and hashed account identifiers) to mitigate brute-force and upload abuse, plus aggregate operational metrics and internal product funnel events.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-stone-900">
              <Film className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-base font-bold">2. How Uploaded Video and Extracted Evidence Are Processed</h2>
            </div>
            <p>
              Uploaded videos and thumbnails are stored in access-controlled server storage and processed through an isolated scan job pipeline (media inspection, audio/speech transcription, frame &amp; scene analysis, thumbnail inspection, evidence assembly, and policy reasoning).
            </p>
            <p>
              Playback and inspection of private user uploads require authenticated session credentials or short-lived, resource-scoped signed media access tokens verified against record ownership on every request.
            </p>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-stone-900">
              <Clock className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-base font-bold">3. Data Retention and Automated Media Cleanup</h2>
            </div>
            <p>
              VideoRisk applies configurable automated retention cleanup windows (subject to business-owner approval prior to production activation):
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <strong>Temporary Processing Artifacts:</strong> Extracted frame captures and <code className="font-mono text-xs">.tmp</code> work files are automatically purged after the configured temporary artifact retention window (configurable default: 24 hours via <code className="font-mono text-xs">TEMP_ARTIFACT_RETENTION_HOURS</code>).
              </li>
              <li>
                <strong>Raw Uploaded Media &amp; Derived Proxies:</strong> Raw video files, proxy videos, and uploaded thumbnails for completed or failed scans are automatically removed after the configured media retention period (configurable default: 7 days / 168 hours via <code className="font-mono text-xs">MEDIA_RETENTION_HOURS</code>), unless still referenced by a newer active or unexpired scan.
              </li>
              <li>
                <strong>Structured Reports &amp; Evidence:</strong> Structured risk reports, evidence summaries, and comparison metadata remain available in your scan archive after raw video files expire, until you delete the scan or delete your account.
              </li>
              <li>
                <strong>Financial &amp; Tax Audit Records:</strong> Billing, credit ledger, and Stripe payment/refund reconciliation records may be retained in anonymized form following account deletion for accounting and dispute resolution compliance.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-stone-900">
              <CreditCard className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-base font-bold">4. Third-Party Payment &amp; Delivery Services</h2>
            </div>
            <p>
              Checkout sessions, invoice management, and subscription billing are handled via Stripe. When password reset emails are enabled, reset instructions are transmitted via the deployment&apos;s configured SMTP mail server. VideoRisk does not sell personal information or publish private user draft videos.
            </p>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2 text-stone-900">
              <Trash2 className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-base font-bold">5. Your Deletion &amp; Access Rights</h2>
            </div>
            <p>
              You may permanently delete individual scans (including unshared media files) from your scan history or delete your entire account at any time via <strong>Account Settings &rarr; Delete Account</strong>. Account deletion invalidates all active sessions and removes your email, credentials, profile, channel intelligence, scans, reports, evidence, and unshared media files. Protected administrative/owner accounts cannot be deleted via self-service.
            </p>
          </section>

          <section className="space-y-2 pt-2 border-t border-stone-200">
            <div className="flex items-center gap-2 text-stone-900">
              <Mail className="w-4 h-4 text-rose-600 shrink-0" />
              <h2 className="text-base font-bold">6. Privacy Contact &amp; Controller Information</h2>
            </div>
            <p>
              Data Controller:{' '}
              <span className="font-mono text-xs bg-stone-100 px-1.5 py-0.5 rounded border border-stone-200">
                [OPERATOR LEGAL ENTITY NAME — PENDING LEGAL REVIEW]
              </span>
              ,{' '}
              <span className="font-mono text-xs bg-stone-100 px-1.5 py-0.5 rounded border border-stone-200">
                [REGISTERED BUSINESS ADDRESS — PENDING]
              </span>.
            </p>
            <p>
              Privacy &amp; Data Deletion Requests:{' '}
              <span className="font-mono text-xs bg-stone-100 px-1.5 py-0.5 rounded border border-stone-200">
                [PRIVACY &amp; SUPPORT CONTACT EMAIL — PENDING CONFIGURATION]
              </span>. Automated transactional reset notices use the configured <code className="font-mono text-xs">SMTP_FROM</code> / <code className="font-mono text-xs">EMAIL_FROM</code> sender when SMTP is enabled.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
};
