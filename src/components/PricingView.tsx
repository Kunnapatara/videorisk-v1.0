import React, { useState, useEffect } from 'react';
import { PlanDetails, UserAccount } from '../types';
import { authFetch } from '../utils/api';
import { Check, Zap, Shield, Sparkles, CreditCard, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';

interface PricingViewProps {
  user: UserAccount | null;
  onPlanUpdated: (user: UserAccount) => void;
  onNewScan: () => void;
}

export const PricingView: React.FC<PricingViewProps> = ({ user, onPlanUpdated, onNewScan }) => {
  const [plans, setPlans] = useState<PlanDetails[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [checkoutMessage, setCheckoutMessage] = useState<{ type: 'success' | 'error' | 'pending'; text: string } | null>(null);
  const [pendingSession, setPendingSession] = useState<{ sessionId: string; plan?: string | null; mode?: string | null } | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

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
      .then(data => setPlans(data))
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

  const handleSelectPlan = async (plan: PlanDetails) => {
    setLoading(true);
    setSelectedPlanId(plan.id);
    setCheckoutMessage(null);

    try {
      if (plan.id === 'free') {
        const res = await authFetch('/api/user/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 'free' })
        });
        if (res.ok) {
          const updated = await res.json();
          onPlanUpdated(updated);
          setCheckoutMessage({
            type: 'success',
            text: 'Free trial plan active with 10 evaluation minutes.'
          });
        } else {
          const errData = await res.json().catch(() => ({}));
          setCheckoutMessage({
            type: 'error',
            text: errData.error || 'The 10-minute evaluation trial has already been claimed for this account. Select a plan below to add minutes to your balance.'
          });
        }
        return;
      }

      // Paid plans: initiate Stripe Checkout Session
      const res = await authFetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: plan.id })
      });

      if (!res.ok) {
        const errData = await res.json();
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
      setSelectedPlanId(null);
    }
  };

  return (
    <div className="max-w-7xl mx-auto py-8 sm:py-12 px-4 sm:px-6 space-y-8 sm:space-y-12">
      {/* Header */}
      <div className="text-center max-w-3xl mx-auto space-y-3">
        <span className="text-xs uppercase tracking-wider text-rose-600 font-bold bg-rose-50 border border-rose-200 px-2.5 py-1 rounded-full">
          Transparent Creator Pricing
        </span>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-stone-900 tracking-tight">
          Credit-based on Input Video Minutes
        </h1>
        <p className="text-sm sm:text-base text-stone-600 leading-relaxed max-w-2xl mx-auto">
          Pay for what you scan. 1 credit = 1 input minute for Standard Scan. 4K footage is optimized automatically with zero resolution surcharge.
        </p>
      </div>

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

      {/* Credit Formula & Subscription Management Banner */}
      <div className="bg-stone-900 text-stone-100 rounded-2xl p-5 sm:p-6 max-w-3xl mx-auto shadow-lg space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center text-xs">
          <div className="p-3 border-b sm:border-b-0 sm:border-r border-stone-800 space-y-1">
            <span className="text-stone-400 block text-[11px] font-semibold uppercase tracking-wider">STANDARD SCAN</span>
            <strong className="text-base text-white font-extrabold block">1 Credit / Min</strong>
            <span className="text-stone-400 text-[11px] block">Full policy & evidence timeline</span>
          </div>
          <div className="p-3 border-b sm:border-b-0 sm:border-r border-stone-800 space-y-1">
            <span className="text-stone-400 block text-[11px] font-semibold uppercase tracking-wider">DEEP SCAN</span>
            <strong className="text-base text-white font-extrabold block">2 Credits / Min</strong>
            <span className="text-stone-400 text-[11px] block">Perceptual hash & cross-segment audit</span>
          </div>
          <div className="p-3 space-y-1">
            <span className="text-stone-400 block text-[11px] font-semibold uppercase tracking-wider">YOUR ACCOUNT</span>
            <strong className="text-base text-emerald-400 font-extrabold block font-mono">
              {user?.creditsRemaining ?? 0} Minutes
            </strong>
            <span className="text-stone-300 text-[11px] block truncate max-w-[200px] mx-auto">
              {user?.email || 'Active User'}
            </span>
          </div>
        </div>

        {/* Self-service customer portal when user has an active Stripe customer/subscription profile */}
        {(user?.stripeCustomerId || (user?.plan && user.plan !== 'free')) && (
          <div className="pt-3 border-t border-stone-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
            <div className="text-stone-400 text-center sm:text-left">
              <span>Subscription status: </span>
              <span className="font-semibold text-stone-200 capitalize">
                {user?.subscriptionStatus || (user?.plan !== 'free' ? 'Active' : 'None')}
              </span>
              {user?.plan && user.plan !== 'free' && (
                <span className="ml-2 px-2 py-0.5 rounded-full bg-stone-800 text-stone-300 text-[10px] uppercase font-bold">
                  {user.plan}
                </span>
              )}
            </div>
            <button
              onClick={handleManageSubscription}
              disabled={portalLoading}
              className="px-3.5 py-1.5 bg-stone-800 hover:bg-stone-700 active:scale-98 text-stone-200 hover:text-white font-semibold rounded-lg text-xs flex items-center gap-2 border border-stone-700 transition-colors"
            >
              {portalLoading ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Loading Portal...</span>
                </>
              ) : (
                <>
                  <CreditCard className="w-3.5 h-3.5 text-stone-400" />
                  <span>Manage Subscription & Invoices</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Responsive Plans Grid (1 col on mobile, 2 on tablet, 3 on desktop, 5 on wide screens) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 sm:gap-6">
        {plans.map(plan => {
          const isCurrent = user?.plan === plan.id;
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
                  {plan.highlight && (
                    <span className="text-[10px] uppercase font-extrabold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full tracking-wider">
                      Popular
                    </span>
                  )}
                </div>
                
                <div className="mt-2 flex items-baseline gap-1">
                  <span className="text-3xl font-black text-stone-900 tracking-tight">
                    ${plan.priceUsd}
                  </span>
                  <span className="text-xs text-stone-500 font-medium">
                    /{plan.period === 'month' ? 'mo' : 'one-time'}
                  </span>
                </div>

                <div className="text-xs font-bold text-rose-600 mt-1.5 flex items-center gap-1">
                  <span>{plan.credits} Minutes included</span>
                </div>

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
                  disabled={loading}
                  onClick={() => handleSelectPlan(plan)}
                  className={`w-full py-2.5 px-3 text-xs font-bold rounded-xl transition-all shadow-xs flex items-center justify-center gap-1.5 ${
                    isCurrent
                      ? 'bg-stone-100 text-stone-700 cursor-default border border-stone-200'
                      : plan.highlight
                        ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-900/20 hover:shadow-md active:scale-98'
                        : 'bg-stone-900 hover:bg-stone-850 text-white active:scale-98'
                  }`}
                >
                  {loading && selectedPlanId === plan.id ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Connecting...</span>
                    </>
                  ) : isCurrent ? (
                    'Current Plan'
                  ) : plan.id === 'free' ? (
                    'Claim 10-Min Free Trial'
                  ) : plan.period === 'one-time' ? (
                    `Purchase $${plan.priceUsd} · One-Time`
                  ) : (
                    `Subscribe · $${plan.priceUsd}/month`
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
