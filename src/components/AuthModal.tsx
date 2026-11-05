import React, { useState, useEffect } from 'react';
import { UserAccount } from '../types';
import { authFetch, setSessionToken, removeSessionToken } from '../utils/api';
import { 
  X, 
  Lock, 
  Mail, 
  User, 
  ShieldCheck, 
  ArrowRight, 
  CheckCircle2, 
  AlertCircle, 
  RefreshCw, 
  LogOut,
  CreditCard,
  History,
  Calendar,
  Sparkles,
  ExternalLink
} from 'lucide-react';

interface AuthModalProps {
  currentUser: UserAccount | null;
  isOpen: boolean;
  onClose: () => void;
  onUserChanged: (user: UserAccount | null) => void;
  initialMode?: 'account' | 'login' | 'register' | 'switch' | 'forgot' | 'reset';
  intendedPlanId?: string | null;
  onIntendedPlanConfirmed?: (planId: string) => void;
  onExplorePricing?: () => void;
}

interface BillingSummaryData {
  email: string;
  plan: string;
  creditsRemaining: number;
  creditsUsedTotal: number;
  totalScansCount: number;
  subscription: {
    id: string;
    planId: string;
    status: string;
    currentPeriodEnd?: string | null;
    createdAt?: string;
  } | null;
  isRecurring: boolean;
  hasStripeCustomer: boolean;
}

interface CreditTransactionItem {
  id: string;
  delta: number;
  balanceAfter: number;
  type: string;
  referenceId: string | null;
  createdAt: string;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  currentUser,
  isOpen,
  onClose,
  onUserChanged,
  initialMode,
  intendedPlanId,
  onIntendedPlanConfirmed,
  onExplorePricing
}) => {
  const [mode, setMode] = useState<'account' | 'login' | 'register' | 'switch' | 'forgot' | 'reset'>('account');
  const [accountSubTab, setAccountSubTab] = useState<'overview' | 'ledger'>('overview');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Billing summary & transactions for authenticated account
  const [billingSummary, setBillingSummary] = useState<BillingSummaryData | null>(null);
  const [transactions, setTransactions] = useState<CreditTransactionItem[]>([]);
  const [loadingBilling, setLoadingBilling] = useState(false);

  // Available test accounts (dev/test environment only)
  const [testAccounts, setTestAccounts] = useState<Array<{
    id: string;
    email: string;
    plan: string;
    creditsRemaining: number;
    totalScansCount: number;
  }>>([]);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setSuccess(null);
      if (initialMode) {
        setMode(initialMode);
      } else {
        setMode(currentUser ? 'account' : 'login');
      }
      loadAccountsIfAvailable();
      if (currentUser) {
        loadBillingData();
      }
    }
  }, [isOpen, currentUser, initialMode]);

  const loadAccountsIfAvailable = async () => {
    try {
      const res = await authFetch('/api/auth/accounts');
      if (res.ok) {
        const data = await res.json();
        setTestAccounts(Array.isArray(data) ? data : []);
      } else {
        setTestAccounts([]);
      }
    } catch {
      setTestAccounts([]);
    }
  };

  const loadBillingData = async () => {
    setLoadingBilling(true);
    try {
      const [sumRes, txRes] = await Promise.all([
        authFetch('/api/billing/summary'),
        authFetch('/api/billing/transactions')
      ]);

      if (sumRes.ok) {
        const sumData = await sumRes.json();
        setBillingSummary(sumData);
      }
      if (txRes.ok) {
        const txData = await txRes.json();
        setTransactions(txData.transactions || []);
      }
    } catch (err) {
      console.warn('Failed to fetch billing data:', err);
    } finally {
      setLoadingBilling(false);
    }
  };

  if (!isOpen) return null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to sign in.');
      }

      setSessionToken(data.token);
      onUserChanged(data.user);
      setSuccess('Signed in successfully.');

      setTimeout(() => {
        onClose();
        if (intendedPlanId) {
          onIntendedPlanConfirmed?.(intendedPlanId);
        }
      }, 500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Registration failed.');
      }

      setSessionToken(data.token);
      onUserChanged(data.user);
      setSuccess('Free account created! Exactly 10 starter credits granted.');

      setTimeout(() => {
        onClose();
        if (intendedPlanId) {
          onIntendedPlanConfirmed?.(intendedPlanId);
        }
      }, 600);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchAccount = async (targetUserId: string) => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/auth/switch-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: targetUserId }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to switch account.');
      }

      setSessionToken(data.token);
      onUserChanged(data.user);
      setSuccess(`Switched to ${data.user.email}`);
      setTimeout(() => onClose(), 500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await authFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore
    }
    removeSessionToken();
    onUserChanged(null);
    onClose();
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to submit reset request.');
      }

      if (data.devResetToken) {
        setResetToken(data.devResetToken);
        setSuccess('Reset instructions sent. In development mode, token was populated automatically.');
        setTimeout(() => setMode('reset'), 1000);
      } else {
        setSuccess('If that email is registered, password reset instructions have been sent.');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reset password.');
      }
      setSuccess('Password updated successfully! Please sign in with your new credentials.');
      setTimeout(() => {
        setMode('login');
        setPassword('');
        setResetToken('');
        setNewPassword('');
        setSuccess(null);
      }, 1500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenCustomerPortal = async () => {
    setPortalLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/billing/create-portal-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl: window.location.href })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to access customer billing portal.');
      }
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('Billing portal URL was not returned.');
      }
    } catch (err: any) {
      setError(err.message || 'Unable to open billing portal. Please contact support.');
    } finally {
      setPortalLoading(false);
    }
  };

  const formatTxType = (type: string) => {
    switch (type) {
      case 'INITIAL_GRANT':
        return 'Free Registration Starter Credits';
      case 'PURCHASE_GRANT':
      case 'CHECKOUT_GRANT':
        return 'Plan Entitlement / Top-Up';
      case 'SCAN_DEDUCTION':
        return 'Video Risk Scan Deduction';
      case 'SCAN_REFUND':
        return 'Unused Scan Credit Refund';
      default:
        return type.replace(/_/g, ' ');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-950/65 backdrop-blur-xs">
      <div 
        className={`w-full ${mode === 'account' ? 'max-w-xl' : 'max-w-md'} bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden text-stone-900 animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh]`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-6 py-4 bg-stone-900 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-rose-500" />
            <h2 className="font-bold text-base tracking-tight">
              {mode === 'account' ? 'Account & Billing' : 'Account & Access'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-stone-400 hover:text-white hover:bg-stone-800 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Current Active User Banner */}
        <div className="px-6 py-2.5 bg-stone-100 border-b border-stone-200 flex items-center justify-between text-xs shrink-0">
          <div className="truncate max-w-[240px]">
            <span className="text-stone-500">Active Identity: </span>
            <span className="font-semibold text-stone-800">{currentUser?.email || 'Guest (Sign In Required)'}</span>
          </div>
          {currentUser && (
            <div className="flex items-center gap-2 shrink-0">
              <span className="px-2 py-0.5 rounded uppercase font-bold text-[10px] bg-stone-200 text-stone-800">
                {currentUser.plan}
              </span>
              <span className="font-bold text-emerald-600 font-mono">
                {currentUser.creditsRemaining} credits
              </span>
            </div>
          )}
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-stone-200 bg-stone-50/50 text-xs font-semibold shrink-0">
          {currentUser && (
            <button
              onClick={() => { setMode('account'); setError(null); }}
              className={`flex-1 py-3 text-center transition-colors border-b-2 ${
                mode === 'account'
                  ? 'border-rose-600 text-stone-900 bg-white font-bold'
                  : 'border-transparent text-stone-500 hover:text-stone-800'
              }`}
            >
              My Account & Billing
            </button>
          )}

          <button
            onClick={() => { setMode('login'); setError(null); }}
            className={`flex-1 py-3 text-center transition-colors border-b-2 ${
              mode === 'login'
                ? 'border-rose-600 text-stone-900 bg-white font-bold'
                : 'border-transparent text-stone-500 hover:text-stone-800'
            }`}
          >
            Sign In
          </button>

          <button
            onClick={() => { setMode('register'); setError(null); }}
            className={`flex-1 py-3 text-center transition-colors border-b-2 ${
              mode === 'register'
                ? 'border-rose-600 text-stone-900 bg-white font-bold'
                : 'border-transparent text-stone-500 hover:text-stone-800'
            }`}
          >
            Create Account
          </button>

          {/* Test Accounts Tab (Dev/Test only) */}
          {testAccounts.length > 0 && (
            <button
              onClick={() => { setMode('switch'); setError(null); }}
              className={`flex-1 py-3 text-center transition-colors border-b-2 ${
                mode === 'switch'
                  ? 'border-rose-600 text-stone-900 bg-white font-bold'
                  : 'border-transparent text-stone-500 hover:text-stone-800'
              }`}
            >
              Test Accounts
            </button>
          )}
        </div>

        {/* Feedback Notices */}
        {(error || success) && (
          <div className="px-6 pt-3 shrink-0">
            {error && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                <span>{error}</span>
              </div>
            )}
            {success && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
                <span>{success}</span>
              </div>
            )}
          </div>
        )}

        {/* Scrollable Modal Body */}
        <div className="overflow-y-auto flex-1">
          {/* Tab 0: Authenticated Account & Billing View */}
          {mode === 'account' && currentUser && (
            <div className="p-6 space-y-5">
              {/* Account Sub-Tabs: Overview vs Credit Activity Ledger */}
              <div className="flex rounded-xl bg-stone-100 p-1 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setAccountSubTab('overview')}
                  className={`flex-1 py-1.5 rounded-lg transition-all ${
                    accountSubTab === 'overview'
                      ? 'bg-white text-stone-900 shadow-xs font-bold'
                      : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  Subscription & Profile
                </button>
                <button
                  type="button"
                  onClick={() => setAccountSubTab('ledger')}
                  className={`flex-1 py-1.5 rounded-lg transition-all flex items-center justify-center gap-1.5 ${
                    accountSubTab === 'ledger'
                      ? 'bg-white text-stone-900 shadow-xs font-bold'
                      : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  <History className="w-3.5 h-3.5" />
                  <span>Credit Activity Ledger ({transactions.length})</span>
                </button>
              </div>

              {accountSubTab === 'overview' && (
                <div className="space-y-4">
                  {/* Account Overview Card */}
                  <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 space-y-2.5 text-xs">
                    <h4 className="font-bold text-stone-900 uppercase text-[10px] tracking-wider text-stone-500">
                      Account Overview
                    </h4>
                    <div className="flex justify-between items-center pb-2 border-b border-stone-200">
                      <span className="text-stone-600">Account Email</span>
                      <strong className="text-stone-900 font-bold">{currentUser.email}</strong>
                    </div>
                    <div className="flex justify-between items-center pb-2 border-b border-stone-200">
                      <span className="text-stone-600">Current Plan</span>
                      <strong className="uppercase text-stone-900 font-extrabold">{currentUser.plan}</strong>
                    </div>
                    <div className="flex justify-between items-center pb-2 border-b border-stone-200">
                      <span className="text-stone-600">Available Credit Balance</span>
                      <strong className="text-emerald-700 font-extrabold font-mono text-sm">
                        {currentUser.creditsRemaining} credits
                      </strong>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-stone-600">Lifetime Scans Completed</span>
                      <strong className="text-stone-900 font-bold font-mono">{currentUser.totalScansCount}</strong>
                    </div>
                  </div>

                  {/* Verified Subscription Info Card */}
                  <div className="p-4 rounded-xl bg-white border border-stone-200 space-y-3 text-xs shadow-2xs">
                    <div className="flex items-center justify-between">
                      <h4 className="font-bold text-stone-900 uppercase text-[10px] tracking-wider text-stone-500">
                        Subscription Details
                      </h4>
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-stone-100 text-stone-700">
                        {currentUser.plan === 'free' ? 'Free Benefit' : currentUser.plan === 'audit_once' ? 'One-Time' : (currentUser.subscriptionStatus || 'Active')}
                      </span>
                    </div>

                    <div className="space-y-2 text-stone-600">
                      <div className="flex justify-between items-center">
                        <span>Billing Structure:</span>
                        <strong className="text-stone-900 capitalize">
                          {currentUser.plan === 'free' ? 'Free registration trial' : currentUser.plan === 'audit_once' ? 'One-time purchase (non-recurring)' : 'Monthly recurring subscription'}
                        </strong>
                      </div>

                      {/* Verified Next Renewal / Current Period End Date */}
                      <div className="flex justify-between items-center">
                        <span>Next Period End / Renewal:</span>
                        <strong className="text-stone-900">
                          {billingSummary?.subscription?.currentPeriodEnd ? (
                            new Date(billingSummary.subscription.currentPeriodEnd).toLocaleDateString(undefined, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric'
                            })
                          ) : currentUser.plan === 'free' || currentUser.plan === 'audit_once' ? (
                            <span className="text-stone-500 font-normal">N/A — Non-recurring</span>
                          ) : (
                            <span className="text-stone-500 font-normal">Managed via Customer Portal</span>
                          )}
                        </strong>
                      </div>
                    </div>

                    {/* Customer Portal Button for Invoice & Payment Method Management */}
                    <div className="pt-2 border-t border-stone-100 flex flex-col sm:flex-row items-center justify-between gap-2.5">
                      <p className="text-[11px] text-stone-500">
                        Access Stripe Customer Portal for tax invoices, payment cards, or subscription changes:
                      </p>
                      <button
                        type="button"
                        onClick={handleOpenCustomerPortal}
                        disabled={portalLoading}
                        className="w-full sm:w-auto px-3.5 py-1.5 bg-stone-900 hover:bg-stone-850 text-white font-semibold rounded-lg text-xs flex items-center justify-center gap-1.5 shrink-0 transition-colors"
                      >
                        {portalLoading ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Opening...</span>
                          </>
                        ) : (
                          <>
                            <CreditCard className="w-3.5 h-3.5 text-stone-300" />
                            <span>Customer Portal</span>
                            <ExternalLink className="w-3 h-3 text-stone-400" />
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Actions Footer */}
                  <div className="flex flex-col sm:flex-row gap-2 pt-2">
                    {onExplorePricing && (
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          onExplorePricing();
                        }}
                        className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-xl transition-all shadow-xs flex items-center justify-center gap-1.5"
                      >
                        <span>Upgrade / Change Credit Plan</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="py-2.5 px-4 bg-stone-100 hover:bg-stone-200 text-stone-700 font-semibold text-xs rounded-xl transition-colors flex items-center justify-center gap-1.5 border border-stone-200"
                    >
                      <LogOut className="w-3.5 h-3.5 text-stone-500" />
                      <span>Sign Out</span>
                    </button>
                  </div>
                </div>
              )}

              {accountSubTab === 'ledger' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-bold text-xs text-stone-900">
                        Append-Only Credit Activity Ledger
                      </h4>
                      <p className="text-[11px] text-stone-500">
                        User-scoped transaction history for grants, deductions, and refunds.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={loadBillingData}
                      disabled={loadingBilling}
                      className="p-1.5 rounded-lg border border-stone-200 hover:bg-stone-50 text-stone-600 text-xs"
                      title="Refresh transaction history"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${loadingBilling ? 'animate-spin' : ''}`} />
                    </button>
                  </div>

                  {transactions.length === 0 ? (
                    <div className="p-6 text-center bg-stone-50 rounded-xl border border-stone-200 text-xs text-stone-500">
                      No credit transactions recorded yet.
                    </div>
                  ) : (
                    <div className="border border-stone-200 rounded-xl overflow-hidden max-h-64 overflow-y-auto">
                      <table className="w-full text-xs text-left">
                        <thead className="bg-stone-100 border-b border-stone-200 text-[10px] uppercase font-bold text-stone-600 sticky top-0">
                          <tr>
                            <th className="py-2 px-3">Date</th>
                            <th className="py-2 px-3">Activity Type</th>
                            <th className="py-2 px-3 text-right">Credits</th>
                            <th className="py-2 px-3 text-right">Balance</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100">
                          {transactions.map((tx) => (
                            <tr key={tx.id} className="hover:bg-stone-50">
                              <td className="py-2 px-3 text-stone-500 text-[11px]">
                                {new Date(tx.createdAt).toLocaleDateString(undefined, {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit'
                                })}
                              </td>
                              <td className="py-2 px-3 font-medium text-stone-800">
                                {formatTxType(tx.type)}
                              </td>
                              <td className={`py-2 px-3 text-right font-bold font-mono ${
                                tx.delta > 0 ? 'text-emerald-600' : 'text-rose-600'
                              }`}>
                                {tx.delta > 0 ? `+${tx.delta}` : tx.delta}
                              </td>
                              <td className="py-2 px-3 text-right font-mono font-bold text-stone-900">
                                {tx.balanceAfter}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <p className="text-[11px] text-stone-500 bg-stone-50 p-2.5 rounded-lg border border-stone-200 leading-normal">
                    *Note: This ledger tracks internal credit deductions and grants. Formal payment invoices and receipts are issued through the Stripe Customer Portal.*
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Tab 1: Test Accounts (Dev/Test only) */}
          {mode === 'switch' && testAccounts.length > 0 && (
            <div className="p-6 space-y-4">
              <div>
                <p className="text-xs text-stone-600">
                  Select an isolated creator identity for testing cross-account data boundaries:
                </p>
              </div>

              <div className="space-y-2 max-h-60 overflow-y-auto">
                {testAccounts.map((acc) => {
                  const isSelected = currentUser?.id === acc.id;
                  return (
                    <div
                      key={acc.id}
                      onClick={() => !isSelected && handleSwitchAccount(acc.id)}
                      className={`p-3 rounded-xl border flex items-center justify-between text-xs transition-all cursor-pointer ${
                        isSelected
                          ? 'border-stone-900 bg-stone-50 ring-1 ring-stone-900 cursor-default'
                          : 'border-stone-200 hover:border-stone-400 bg-white hover:bg-stone-50/60'
                      }`}
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-stone-900">{acc.email}</span>
                          {isSelected && (
                            <span className="text-[10px] bg-stone-900 text-white px-1.5 py-0.2 rounded font-semibold">
                              ACTIVE
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-stone-500 flex items-center gap-2">
                          <span className="capitalize">{acc.plan} Plan</span>
                          <span>·</span>
                          <span className="text-emerald-700 font-semibold">{acc.creditsRemaining} credits available</span>
                          <span>·</span>
                          <span>{acc.totalScansCount} scans</span>
                        </div>
                      </div>

                      {!isSelected && (
                        <button
                          type="button"
                          disabled={loading}
                          className="px-3 py-1 bg-stone-900 hover:bg-stone-800 text-white font-medium rounded text-xs shrink-0 transition-colors"
                        >
                          Switch
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tab 2: Standard Sign In */}
          {mode === 'login' && (
            <form onSubmit={handleLogin} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="creator@videorisk.com"
                    className="w-full pl-9 pr-3 py-2 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-stone-700">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => { setMode('forgot'); setError(null); }}
                    className="text-[11px] text-rose-600 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-3 py-2 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Signing in...</span>
                  </>
                ) : (
                  <span>Sign In</span>
                )}
              </button>

              <div className="text-center pt-2 text-xs text-stone-500">
                Don’t have an account?{' '}
                <button
                  type="button"
                  onClick={() => setMode('register')}
                  className="text-rose-600 font-semibold hover:underline"
                >
                  Create free account
                </button>
              </div>
            </form>
          )}

          {/* Tab 3: Forgot Password */}
          {mode === 'forgot' && (
            <form onSubmit={handleForgotPassword} className="p-6 space-y-4">
              <div>
                <h3 className="font-bold text-sm text-stone-900">Account Password Recovery</h3>
                <p className="text-xs text-stone-500 mt-1">
                  Enter your account email to receive secure single-use password reset instructions.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="creator@videorisk.com"
                    className="w-full pl-9 pr-3 py-2 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Sending Instructions...</span>
                  </>
                ) : (
                  <span>Send Reset Instructions</span>
                )}
              </button>

              <div className="flex items-center justify-between text-xs pt-2">
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className="text-stone-600 hover:text-stone-900 font-medium"
                >
                  Back to Sign In
                </button>
              </div>
            </form>
          )}

          {/* Tab 4: Confirm Password Reset */}
          {mode === 'reset' && (
            <form onSubmit={handleResetPassword} className="p-6 space-y-4">
              <div>
                <h3 className="font-bold text-sm text-stone-900">Enter Reset Token</h3>
                <p className="text-xs text-stone-500 mt-1">
                  Set a new password for your account using your single-use reset token.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Reset Token
                </label>
                <input
                  type="text"
                  required
                  value={resetToken}
                  onChange={(e) => setResetToken(e.target.value)}
                  placeholder="Paste reset token here"
                  className="w-full px-3 py-2 text-xs font-mono border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  New Password (min 8 characters)
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-3 py-2 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Updating Password...</span>
                  </>
                ) : (
                  <span>Confirm New Password</span>
                )}
              </button>

              <div className="text-center pt-2 text-xs">
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className="text-stone-600 hover:text-stone-900 font-medium"
                >
                  Back to Sign In
                </button>
              </div>
            </form>
          )}

          {/* Tab 5: Register / Sign Up (Official Section 6) */}
          {mode === 'register' && (
            <form onSubmit={handleRegister} className="p-6 space-y-4">
              {/* Context Banner if user arrived by selecting a paid plan */}
              {intendedPlanId && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-950 flex items-start gap-2 shadow-2xs">
                  <Sparkles className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold text-rose-900">Step 1 of 2: Create Account</p>
                    <p className="text-[11px] text-rose-800 mt-0.5">
                      Create your free VideoRisk account first. You can confirm your subscription to the <strong className="font-bold capitalize">{intendedPlanId}</strong> plan immediately after registration.
                    </p>
                  </div>
                </div>
              )}

              {/* Official Free Registration Value Proposition Banner */}
              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200 text-xs text-stone-700 space-y-2">
                <div className="flex items-center gap-1.5 font-extrabold text-stone-900 text-xs">
                  <Sparkles className="w-4 h-4 text-rose-600" />
                  <span>Create Your Free VideoRisk Account</span>
                </div>
                <ul className="space-y-1 text-[11px] text-stone-600 pl-1">
                  <li className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <span>Get 10 free credits automatically upon registration</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <span>Standard Scan: up to 10 input minutes</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <span>Deep Scan: up to 5 input minutes</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <span>Try the risk analysis and review your report</span>
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <span>Upgrade whenever you need more credits</span>
                  </li>
                </ul>
                <p className="text-[10px] text-stone-500 pt-1 border-t border-stone-200/80 font-medium">
                  No payment card is required to create a free account.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@channel.com"
                    className="w-full pl-9 pr-3 py-2 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-stone-700 mb-1">
                  Password (min 6 characters)
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-3 py-2 text-xs border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Creating Account...</span>
                  </>
                ) : (
                  <span>Create Free Account</span>
                )}
              </button>

              <div className="text-center pt-2 text-xs text-stone-500">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className="text-rose-600 font-semibold hover:underline"
                >
                  Sign In
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
