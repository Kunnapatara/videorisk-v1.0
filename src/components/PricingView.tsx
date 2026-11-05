import React, { useState, useEffect } from 'react';
import { PlanDetails, UserAccount } from '../types';
import { authFetch } from '../utils/api';
import { 
  Check, 
  Zap, 
  Shield, 
  Sparkles, 
  CreditCard, 
  CheckCircle2, 
  AlertCircle, 
  RefreshCw, 
  ArrowRight,
  Lock,
  Layers,
  FileText,
  User,
  History
} from 'lucide-react';

interface PricingViewProps {
  user: UserAccount | null;
  onPlanUpdated: (user: UserAccount) => void;
  onNewScan: () => void;
  onOpenAuth?: (mode?: 'login' | 'register' | 'account', intendedPlanId?: string) => void;
  selectedPlanIdFromNavigation?: string | null;
  onClearSelectedPlanFromNavigation?: () => void;
  onOpenAccountModal?: () => void;
}

export const PricingView: React.FC<PricingViewProps> = ({ 
  user, 
  onPlanUpdated, 
  onNewScan,
  onOpenAuth,
  selectedPlanIdFromNavigation,
  onClearSelectedPlanFromNavigation,
  onOpenAccountModal
}) => {
  const [plans, setPlans] = useState<PlanDetails[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeActionPlanId, setActiveActionPlanId] = useState<string | null>(null);
  const [checkoutMessage, setCheckoutMessage] = useState<{ type: 'success' | 'error' | 'pending'; text: string } | null>(null);
  const [pendingSession, setPendingSession] = useState<{ sessionId: string; plan?: string | null; mode?: string | null } | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [pendingConfirmationPlan, setPendingConfirmationPlan] = useState<PlanDetails | null>(null);

  const pollSessionStatus = async (sessionId: string, plan?: string | null, mode?: string | null, attempt = 1, maxAttempts = 5) => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/billing/session-status?sessionId=${encodeURIComponent(sessionId)}&plan=${encodeURIComponent(plan || '')}&mode=${encodeURIComponent(mode || '')}`);
      const data = await res.json();

      if (res.ok && data.status === 'complete' && data.user) {
        onPlanUpdated(data.user);
        setCheckoutMessage({
          type: 'success',
          text: 'Payment received! Your plan entitlement and credits have been successfully activated.'
        });
        setPendingSession(null);
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (data.status === 'pending' || !data.user) {
        if (attempt < maxAttempts) {
          setCheckoutMessage({
            type: 'pending',
            text: `Payment is processing with Stripe... Verifying entitlement (attempt ${attempt} of ${maxAttempts}).`
          });
          setTimeout(() => {
            pollSessionStatus(sessionId, plan, mode, attempt + 1, maxAttempts);
          }, 2000);
          return;
        } else {
          setPendingSession({ sessionId, plan, mode });
          setCheckoutMessage({
            type: 'pending',
            text: 'Payment is still being processed by the payment network. You can retry confirmation now or your balance will update automatically upon completion.'
          });
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      } else {
        setCheckoutMessage({
          type: 'error',
          text: data.error || 'Session confirmation could not be verified.'
        });
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch (err: any) {
      console.error('Error synchronizing session status:', err);
      setPendingSession({ sessionId, plan, mode });
      setCheckoutMessage({
        type: 'error',
        text: 'Network error communicating with billing service. You can retry manual verification.'
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    authFetch('/api/plans')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setPlans(data);
        }
      })
      .catch(err => console.error('Failed to load plans', err));

    // Handle return from checkout
    const urlParams = new URLSearchParams(window.location.search);
    const checkoutStatus = urlParams.get('checkout_status');
    const sessionId = urlParams.get('session_id');
    const plan = urlParams.get('plan');
    const mode = urlParams.get('mode');

    if (checkoutStatus === 'success' && sessionId) {
      pollSessionStatus(sessionId, plan, mode, 1, 5);
    } else if (checkoutStatus === 'canceled') {
      setCheckoutMessage({
        type: 'error',
        text: 'Checkout was canceled. No charges were made and your balance remains unchanged.'
      });
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [onPlanUpdated]);

  // Handle plan passed through navigation (e.g. from Home or Register redirect)
  useEffect(() => {
    if (selectedPlanIdFromNavigation && plans.length > 0) {
      const targetPlan = plans.find(p => p.id === selectedPlanIdFromNavigation);
      if (targetPlan && targetPlan.id !== 'free') {
        if (user) {
          // User is authenticated, show confirmation before checkout
          setPendingConfirmationPlan(targetPlan);
        }
      }
      onClearSelectedPlanFromNavigation?.();
    }
  }, [selectedPlanIdFromNavigation, plans, user, onClearSelectedPlanFromNavigation]);

  const handleManualRetry = () => {
    if (pendingSession) {
      pollSessionStatus(pendingSession.sessionId, pendingSession.plan, pendingSession.mode, 1, 3);
    }
  };

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    setCheckoutMessage(null);
    try {
      const res = await authFetch('/api/billing/create-portal-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl: window.location.href })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to open customer billing portal.');
      }
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('Billing portal URL was not returned.');
      }
    } catch (err: any) {
      setCheckoutMessage({
        type: 'error',
        text: err.message || 'Unable to open billing portal. Please contact support.'
      });
    } finally {
      setPortalLoading(false);
    }
  };

  const initiateCheckout = async (plan: PlanDetails) => {
    setLoading(true);
    setActiveActionPlanId(plan.id);
    setCheckoutMessage(null);

    try {
      const res = await authFetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: plan.id })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to create checkout session.');
      }

      const session = await res.json();
      if (session.url) {
        window.location.href = session.url;
      } else {
        throw new Error('No checkout URL received from payment provider.');
      }
    } catch (err: any) {
      console.error(err);
      setCheckoutMessage({
        type: 'error',
        text: err.message || 'Payment initiation failed. Please try again.'
      });
    } finally {
      setLoading(false);
      setActiveActionPlanId(null);
    }
  };

  const handlePlanClick = (plan: PlanDetails) => {
    setCheckoutMessage(null);

    if (plan.id === 'free') {
      if (!user) {
        // Guest clicks Free -> open Register
        onOpenAuth?.('register');
      }
      // If user is already authenticated, Free cannot be claimed again (10 credits granted upon registration)
      return;
    }

    // Paid Plan Click
    if (!user) {
      // Guest: DO NOT call /api/billing/checkout while unauthenticated!
      // Preserve intended plan and open Register mode
      setPendingConfirmationPlan(plan);
      onOpenAuth?.('register', plan.id);
      return;
    }

    // User is authenticated: Show confirmation prompt before initiating checkout
    setPendingConfirmationPlan(plan);
  };

  const handleConfirmAndCheckout = async (plan: PlanDetails) => {
    setPendingConfirmationPlan(null);
    await initiateCheckout(plan);
  };

  const getDeepScanMinutesLabel = (plan: PlanDetails): string => {
    if (plan.id === 'free') return '5 min';
    if (plan.id === 'creator') return '15 min';
    if (plan.id === 'pro') return '37 min (+1 credit remaining)';
    if (plan.id === 'agency') return '300 min';
    if (plan.id === 'audit_once') return '30 min';
    return `${Math.floor(plan.credits / 2)} min`;
  };

  return (
    <div className="max-w-7xl mx-auto py-8 sm:py-12 px-4 sm:px-6 space-y-8 sm:space-y-12">
      {/* Header */}
      <div className="text-center max-w-3xl mx-auto space-y-3">
        <span className="text-xs uppercase tracking-wider text-rose-600 font-extrabold bg-rose-50 border border-rose-200 px-3 py-1 rounded-full shadow-2xs">
          Transparent Creator Pricing
        </span>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-stone-900 tracking-tight">
          Credit-based on Input Video Minutes
        </h1>
        <p className="text-sm sm:text-base text-stone-600 leading-relaxed max-w-2xl mx-auto">
          Pay for what you scan. Standard Scan uses 1 credit per input minute. Deep Scan uses 2 credits per input minute. 
          4K footage is optimized automatically with zero resolution surcharge.
        </p>
      </div>

      {/* Confirmation Dialog / Banner for Plan Purchase */}
      {pendingConfirmationPlan && user && (
        <div className="p-5 rounded-2xl bg-rose-50 border-2 border-rose-300 max-w-3xl mx-auto shadow-md animate-in fade-in zoom-in-98 duration-150">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-800 font-bold text-[11px]">
                <Sparkles className="w-3.5 h-3.5 text-rose-600" />
                <span>Confirm Selected Plan</span>
              </div>
              <h3 className="font-extrabold text-base text-stone-900">
                Ready to proceed with {pendingConfirmationPlan.name}?
              </h3>
              <p className="text-xs text-stone-700 leading-relaxed">
                You are signed in as <strong className="font-semibold text-stone-900">{user.email}</strong>. 
                {pendingConfirmationPlan.period === 'month' 
                  ? ` This will activate a recurring monthly subscription of $${pendingConfirmationPlan.priceUsd}/month granting ${pendingConfirmationPlan.credits} credits per monthly billing cycle.` 
                  : ` This is a one-time purchase of $${pendingConfirmationPlan.priceUsd} granting ${pendingConfirmationPlan.credits} credits (non-recurring).`}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
              <button
                type="button"
                onClick={() => setPendingConfirmationPlan(null)}
                className="px-3 py-2 border border-stone-300 bg-white hover:bg-stone-50 text-stone-700 text-xs font-semibold rounded-xl transition-colors"
              >
                Cancel / Browse
              </button>
              <button
                type="button"
                onClick={() => handleConfirmAndCheckout(pendingConfirmationPlan)}
                disabled={loading}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl shadow-xs flex items-center justify-center gap-1.5 transition-all"
              >
                {loading && activeActionPlanId === pendingConfirmationPlan.id ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Connecting...</span>
                  </>
                ) : (
                  <>
                    <Lock className="w-3.5 h-3.5" />
                    <span>Proceed to Checkout · ${pendingConfirmationPlan.priceUsd}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Checkout feedback notification */}
      {checkoutMessage && (
        <div className={`p-4 rounded-xl border max-w-3xl mx-auto flex items-start justify-between gap-3 text-xs shadow-sm ${
          checkoutMessage.type === 'success' 
            ? 'bg-emerald-50 border-emerald-200 text-emerald-900' 
            : checkoutMessage.type === 'pending'
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
        }`}>
          <div className="flex items-start gap-3">
            {checkoutMessage.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            ) : checkoutMessage.type === 'pending' ? (
              <RefreshCw className="w-5 h-5 text-amber-600 shrink-0 mt-0.5 animate-spin" />
            ) : (
              <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            )}
            <div>
              <p className="font-bold text-sm">
                {checkoutMessage.type === 'success' ? 'Transaction Completed' : checkoutMessage.type === 'pending' ? 'Payment Confirmation In Progress' : 'Checkout Notice'}
              </p>
              <p className="mt-0.5">{checkoutMessage.text}</p>
            </div>
          </div>
          {pendingSession && (
            <button
              onClick={handleManualRetry}
              disabled={loading}
              className="shrink-0 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg text-xs flex items-center gap-1.5 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Retry Sync
            </button>
          )}
        </div>
      )}

      {/* Authenticated Account Overview Banner */}
      {user && (
        <div className="bg-stone-900 text-stone-100 rounded-2xl p-5 sm:p-6 max-w-4xl mx-auto shadow-lg space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 text-center text-xs">
            <div className="p-3 border-b sm:border-b-0 sm:border-r border-stone-800 space-y-1">
              <span className="text-stone-400 block text-[11px] font-semibold uppercase tracking-wider">CURRENT PLAN</span>
              <strong className="text-base text-white font-extrabold uppercase block">{user.plan}</strong>
              <span className="text-stone-400 text-[11px] block capitalize">{user.subscriptionStatus || 'Active'}</span>
            </div>
            <div className="p-3 border-b sm:border-b-0 sm:border-r border-stone-800 space-y-1">
              <span className="text-stone-400 block text-[11px] font-semibold uppercase tracking-wider">AVAILABLE CREDITS</span>
              <strong className="text-base text-emerald-400 font-extrabold block font-mono">
                {user.creditsRemaining} credits
              </strong>
              <span className="text-stone-400 text-[11px] block">{user.creditsRemaining} standard min</span>
            </div>
            <div className="p-3 border-b sm:border-b-0 sm:border-r border-stone-800 space-y-1">
              <span className="text-stone-400 block text-[11px] font-semibold uppercase tracking-wider">LIFETIME SCANS</span>
              <strong className="text-base text-white font-extrabold block font-mono">
                {user.totalScansCount}
              </strong>
              <span className="text-stone-400 text-[11px] block">{user.creditsUsedTotal} credits used</span>
            </div>
            <div className="p-3 space-y-1">
              <span className="text-stone-400 block text-[11px] font-semibold uppercase tracking-wider">ACCOUNT IDENTITY</span>
              <strong className="text-xs text-stone-200 font-bold block truncate max-w-[160px] mx-auto">
                {user.email}
              </strong>
              <span className="text-stone-400 text-[11px] block">Verified User</span>
            </div>
          </div>

          {/* Action buttons: Self-service Customer Portal and Account Details */}
          <div className="pt-3 border-t border-stone-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
            <div className="text-stone-400 text-center sm:text-left text-xs">
              <span>Billing type: </span>
              <span className="font-semibold text-stone-200">
                {user.plan === 'free' ? 'One-time registration benefit' : user.plan === 'audit_once' ? 'One-time purchase (non-recurring)' : 'Monthly recurring subscription'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {onOpenAccountModal && (
                <button
                  type="button"
                  onClick={onOpenAccountModal}
                  className="px-3.5 py-1.5 bg-stone-800 hover:bg-stone-700 text-stone-200 hover:text-white font-semibold rounded-lg text-xs flex items-center gap-1.5 border border-stone-700 transition-colors"
                >
                  <History className="w-3.5 h-3.5 text-stone-400" />
                  <span>Account & Credit Ledger</span>
                </button>
              )}
              {(user.stripeCustomerId || (user.plan && user.plan !== 'free')) && (
                <button
                  type="button"
                  onClick={handleManageSubscription}
                  disabled={portalLoading}
                  className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 text-white font-semibold rounded-lg text-xs flex items-center gap-1.5 transition-colors shadow-2xs"
                >
                  {portalLoading ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Loading Portal...</span>
                    </>
                  ) : (
                    <>
                      <CreditCard className="w-3.5 h-3.5" />
                      <span>Manage Subscription & Invoices</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Credit Conversion & Comparison Table (Official Section 3) */}
      <div className="bg-white rounded-2xl border border-stone-200 p-5 sm:p-6 max-w-4xl mx-auto shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-stone-100 pb-3">
          <div>
            <h3 className="font-extrabold text-base text-stone-900">
              Credit to Video Inspection Minutes Conversion
            </h3>
            <p className="text-xs text-stone-500">
              Clear distinction between account credits and actual video duration.
            </p>
          </div>
          <span className="text-[11px] font-bold text-rose-600 bg-rose-50 border border-rose-200 px-2.5 py-1 rounded-full self-start sm:self-auto">
            1 Credit = 1 Standard Min · 2 Credits = 1 Deep Min
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="border-b border-stone-200 text-stone-500 uppercase text-[10px] tracking-wider">
                <th className="py-2.5 font-bold">Plan</th>
                <th className="py-2.5 font-bold text-right">Price</th>
                <th className="py-2.5 font-bold text-right">Credits</th>
                <th className="py-2.5 font-bold text-right">Standard Scan</th>
                <th className="py-2.5 font-bold text-right">Deep Scan</th>
                <th className="py-2.5 font-bold text-right">Billing Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              <tr className="hover:bg-stone-50">
                <td className="py-2.5 font-bold text-stone-900">Free</td>
                <td className="py-2.5 text-right font-mono">$0</td>
                <td className="py-2.5 text-right font-mono font-bold text-stone-900">10</td>
                <td className="py-2.5 text-right font-mono">10 min</td>
                <td className="py-2.5 text-right font-mono">5 min</td>
                <td className="py-2.5 text-right text-stone-500">Free Registration Benefit</td>
              </tr>
              <tr className="hover:bg-stone-50 bg-rose-50/20">
                <td className="py-2.5 font-bold text-rose-700">Creator</td>
                <td className="py-2.5 text-right font-mono">$9 / mo</td>
                <td className="py-2.5 text-right font-mono font-bold text-stone-900">30</td>
                <td className="py-2.5 text-right font-mono">30 min</td>
                <td className="py-2.5 text-right font-mono">15 min</td>
                <td className="py-2.5 text-right text-stone-500">Monthly Subscription</td>
              </tr>
              <tr className="hover:bg-stone-50">
                <td className="py-2.5 font-bold text-stone-900">Pro</td>
                <td className="py-2.5 text-right font-mono">$19 / mo</td>
                <td className="py-2.5 text-right font-mono font-bold text-stone-900">75</td>
                <td className="py-2.5 text-right font-mono">75 min</td>
                <td className="py-2.5 text-right font-mono text-stone-900 font-medium">37 min + 1 credit remaining</td>
                <td className="py-2.5 text-right text-stone-500">Monthly Subscription</td>
              </tr>
              <tr className="hover:bg-stone-50">
                <td className="py-2.5 font-bold text-stone-900">Agency / MCN</td>
                <td className="py-2.5 text-right font-mono">$99 / mo</td>
                <td className="py-2.5 text-right font-mono font-bold text-stone-900">600</td>
                <td className="py-2.5 text-right font-mono">600 min</td>
                <td className="py-2.5 text-right font-mono">300 min</td>
                <td className="py-2.5 text-right text-stone-500">Monthly Subscription</td>
              </tr>
              <tr className="hover:bg-stone-50">
                <td className="py-2.5 font-bold text-stone-900">Audit Once</td>
                <td className="py-2.5 text-right font-mono">$29 one-time</td>
                <td className="py-2.5 text-right font-mono font-bold text-stone-900">60</td>
                <td className="py-2.5 text-right font-mono">60 min</td>
                <td className="py-2.5 text-right font-mono">30 min</td>
                <td className="py-2.5 text-right text-stone-500 font-semibold text-amber-700">One-Time (Non-recurring)</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-stone-600 bg-stone-50 p-2.5 rounded-lg border border-stone-200">
          <strong>Note:</strong> Standard Scan uses 1 credit per input minute. Deep Scan uses 2 credits per input minute. Partial input minutes are rounded up to the next whole minute. Pro Deep Scan provides 37 complete minutes with 1 credit remaining.
        </p>
      </div>

      {/* Responsive Plans Grid (1 col mobile, 2 col tablet, 3 col desktop, 5 col wide desktop) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 sm:gap-6">
        {plans.map(plan => {
          const isCurrent = user?.plan === plan.id;
          const isOneTime = plan.period === 'one-time';
          const isFreeClaimed = user?.freeTrialClaimed && plan.id === 'free' && !isCurrent;

          return (
            <div
              key={plan.id}
              className={`rounded-2xl bg-white p-5 sm:p-6 flex flex-col justify-between border transition-all duration-150 ${
                plan.highlight
                  ? 'border-rose-500 ring-2 ring-rose-500/20 shadow-lg'
                  : 'border-stone-200 shadow-xs hover:border-stone-300 hover:shadow-md'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-bold text-lg text-stone-900">{plan.name}</h3>
                  {plan.highlight ? (
                    <span className="text-[10px] uppercase font-extrabold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full tracking-wider">
                      Popular
                    </span>
                  ) : plan.id === 'audit_once' ? (
                    <span className="text-[10px] font-bold text-stone-700 bg-stone-100 border border-stone-200 px-2 py-0.5 rounded-full">
                      One-Time
                    </span>
                  ) : null}
                </div>
                
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-black text-stone-900 tracking-tight">
                    ${plan.priceUsd}
                  </span>
                  <span className="text-xs text-stone-500 font-medium">
                    /{plan.period === 'month' ? 'month' : 'one-time'}
                  </span>
                </div>

                {/* Credit & Minutes Breakdown */}
                <div className="mt-2.5 py-2 px-3 bg-stone-50 rounded-xl border border-stone-100 text-xs space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="text-stone-500 font-medium">Account Balance:</span>
                    <strong className="text-stone-900 font-extrabold font-mono">{plan.credits} credits</strong>
                  </div>
                  <div className="text-[11px] text-stone-600">
                    Standard: <span className="font-semibold text-stone-900">{plan.credits} input min</span>
                  </div>
                  <div className="text-[11px] text-stone-600">
                    Deep: <span className="font-semibold text-stone-900">{getDeepScanMinutesLabel(plan)}</span>
                  </div>
                </div>

                {plan.description && (
                  <p className="text-xs text-stone-600 mt-3 leading-relaxed">
                    {plan.description}
                  </p>
                )}

                <div className="border-t border-stone-100 my-4 pt-4 space-y-2.5 text-xs text-stone-600">
                  {plan.features.map((feat, idx) => (
                    <div key={idx} className="flex items-start gap-2">
                      <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                      <span className="leading-tight">{feat}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pt-4 border-t border-stone-100 mt-auto">
                <button
                  type="button"
                  disabled={loading || isCurrent || isFreeClaimed}
                  onClick={() => handlePlanClick(plan)}
                  className={`w-full py-2.5 px-3 text-xs font-bold rounded-xl transition-all shadow-xs flex items-center justify-center gap-1.5 ${
                    isCurrent
                      ? 'bg-stone-100 text-stone-700 cursor-default border border-stone-200'
                      : isFreeClaimed
                        ? 'bg-stone-100 text-stone-400 cursor-not-allowed border border-stone-200'
                        : plan.highlight
                          ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-900/20 hover:shadow-md active:scale-98'
                          : 'bg-stone-900 hover:bg-stone-850 text-white active:scale-98'
                  }`}
                >
                  {loading && activeActionPlanId === plan.id ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Connecting...</span>
                    </>
                  ) : isCurrent ? (
                    'Current Plan'
                  ) : plan.id === 'free' ? (
                    !user ? 'Get Started Free' : isFreeClaimed ? 'Free Trial Already Used' : 'Current Plan'
                  ) : plan.period === 'one-time' ? (
                    `Purchase — $${plan.priceUsd} One-Time`
                  ) : (
                    `Subscribe — $${plan.priceUsd}/month`
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
