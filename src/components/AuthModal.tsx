import React, { useState, useEffect } from 'react';
import { UserAccount } from '../types';
import { authFetch, setSessionToken, removeSessionToken } from '../utils/api';
import { X, Lock, Mail, User, ShieldCheck, ArrowRight, CheckCircle2, AlertCircle, RefreshCw, LogOut } from 'lucide-react';

interface AuthModalProps {
  currentUser: UserAccount | null;
  isOpen: boolean;
  onClose: () => void;
  onUserChanged: (user: UserAccount | null) => void;
  initialMode?: 'account' | 'login' | 'register' | 'switch' | 'forgot' | 'reset';
}

export const AuthModal: React.FC<AuthModalProps> = ({
  currentUser,
  isOpen,
  onClose,
  onUserChanged,
  initialMode
}) => {
  const [mode, setMode] = useState<'account' | 'login' | 'register' | 'switch' | 'forgot' | 'reset'>('account');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Available test accounts (only populated in dev/test environment)
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
      setTimeout(() => onClose(), 600);
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
      setSuccess('Account created! 10 free minutes starter credits added.');
      setTimeout(() => onClose(), 600);
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
    setSuccess('Signed out successfully.');
    setTimeout(() => {
      onClose();
    }, 500);
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
        throw new Error(data.error || 'Failed to submit password reset request.');
      }
      setSuccess(data.message);
      if (data.devToken) {
        setResetToken(data.devToken);
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-950/60 backdrop-blur-xs">
      <div 
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-stone-200 overflow-hidden text-stone-900 animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-6 py-4 bg-stone-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-rose-500" />
            <h2 className="font-bold text-base tracking-tight">Account & Ownership</h2>
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
        <div className="px-6 py-3 bg-stone-100 border-b border-stone-200 flex items-center justify-between text-xs">
          <div>
            <span className="text-stone-500">Active Identity: </span>
            <span className="font-semibold text-stone-800">{currentUser?.email || 'Anonymous (Sign In Required)'}</span>
          </div>
          {currentUser && (
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded uppercase font-bold text-[10px] bg-stone-200 text-stone-700">
                {currentUser.plan}
              </span>
              <span className="font-semibold text-emerald-600">
                {currentUser.creditsRemaining}m
              </span>
            </div>
          )}
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-stone-200 bg-stone-50/50 text-xs font-semibold">
          {currentUser && (
            <button
              onClick={() => { setMode('account'); setError(null); }}
              className={`flex-1 py-3 text-center transition-colors border-b-2 ${
                mode === 'account'
                  ? 'border-rose-600 text-stone-900 bg-white font-bold'
                  : 'border-transparent text-stone-500 hover:text-stone-800'
              }`}
            >
              My Account
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
            Register
          </button>

          {/* Test Accounts Tab — Only displayed if test endpoint is enabled */}
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
        <div className="px-6 pt-4">
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

        {/* Tab 0: Authenticated Account View */}
        {mode === 'account' && currentUser && (
          <div className="p-6 space-y-5">
            <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 space-y-3 text-xs">
              <div className="flex justify-between items-center pb-2 border-b border-stone-200">
                <span className="text-stone-500">Email Address</span>
                <span className="font-bold text-stone-900">{currentUser.email}</span>
              </div>
              <div className="flex justify-between items-center pb-2 border-b border-stone-200">
                <span className="text-stone-500">Active Plan</span>
                <span className="font-bold uppercase text-stone-900">{currentUser.plan}</span>
              </div>
              <div className="flex justify-between items-center pb-2 border-b border-stone-200">
                <span className="text-stone-500">Available Credits</span>
                <span className="font-bold text-emerald-600 font-mono">{currentUser.creditsRemaining} minutes</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-stone-500">Lifetime Scans</span>
                <span className="font-bold text-stone-900">{currentUser.totalScansCount}</span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleLogout}
                className="w-full py-2.5 bg-stone-900 hover:bg-stone-850 text-white font-semibold text-xs rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out</span>
              </button>
            </div>
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
                        <span className="text-emerald-700 font-semibold">{acc.creditsRemaining} mins available</span>
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
              <label className="block text-xs font-semibold text-stone-700 mb-1">
                Password
              </label>
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

            <div className="flex items-center justify-between text-[11px] pt-0.5">
              <span className="text-stone-500">Need account recovery?</span>
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError(null); setSuccess(null); }}
                className="text-stone-700 hover:text-stone-900 font-semibold hover:underline"
              >
                Forgot password?
              </button>
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
                Create one
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
              <button
                type="button"
                onClick={() => setMode('reset')}
                className="text-rose-600 font-semibold hover:underline"
              >
                Already have a reset token?
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

        {/* Tab 3: Register */}
        {mode === 'register' && (
          <form onSubmit={handleRegister} className="p-6 space-y-4">
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

            <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 text-[11px] text-stone-600 space-y-1">
              <span className="font-bold text-stone-800 block">✨ Starter Evaluation Included</span>
              <p>Every newly registered account automatically receives 10 free minutes of pre-publish video inspection.</p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Creating Account...</span>
                </>
              ) : (
                <span>Register & Claim 10 Minutes</span>
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
  );
};
