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
  const [checkoutMessage, setCheckoutMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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

    if (checkoutStatus === 'success') {
      setLoading(true);
      authFetch(`/api/billing/session-status?sessionId=${sessionId || ''}&plan=${plan || ''}&mode=${mode || ''}`)
        .then(res => res.json())
        .then(data => {
          if (data.user) {
            onPlanUpdated(data.user);
            setCheckoutMessage({
              type: 'success',
              text: 'Payment received! Your plan entitlement and credits have been successfully activated.'
            });
          }
          window.history.replaceState({}, document.title, window.location.pathname);
        })
        .catch(err => {
          console.error('Error synchronizing session status:', err);
        })
        .finally(() => setLoading(false));
    } else if (checkoutStatus === 'canceled') {
      setCheckoutMessage({
        type: 'error',
        text: 'Checkout was canceled. No charges were made and your balance remains unchanged.'
      });
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [onPlanUpdated]);

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
            text: errData.error || 'Free trial has already been claimed for this account.'
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
          Pay for what you scan. 1 credit = 1 input minute for Standard Scan. 4K footage is processed with 1080p proxy with zero resolution surcharge.
        </p>
      </div>

      {/* Checkout feedback notification */}
      {checkoutMessage && (
        <div className={`p-4 rounded-xl border max-w-3xl mx-auto flex items-start gap-3 text-xs shadow-sm ${
          checkoutMessage.type === 'success' 
            ? 'bg-emerald-50 border-emerald-200 text-emerald-900' 
            : 'bg-rose-50 border-rose-200 text-rose-900'
        }`}>
          {checkoutMessage.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          )}
          <div>
            <p className="font-bold text-sm">{checkoutMessage.type === 'success' ? 'Transaction Completed' : 'Checkout Notice'}</p>
            <p className="mt-0.5">{checkoutMessage.text}</p>
          </div>
        </div>
      )}

      {/* Credit Formula Banner */}
      <div className="bg-stone-900 text-stone-100 rounded-2xl p-5 sm:p-6 max-w-3xl mx-auto grid grid-cols-1 sm:grid-cols-3 gap-4 text-center text-xs shadow-lg">
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
                    'Select Free'
                  ) : (
                    `Subscribe $${plan.priceUsd}`
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
