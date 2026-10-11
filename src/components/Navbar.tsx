import React, { useState } from 'react';
import { 
  ShieldCheck, 
  Video, 
  History, 
  CreditCard, 
  Sparkles, 
  AlertTriangle, 
  Menu, 
  X, 
  User, 
  LogOut, 
  ChevronDown 
} from 'lucide-react';
import { UserAccount } from '../types';

interface NavbarProps {
  activeTab: 'home' | 'upload' | 'history' | 'pricing' | 'channel';
  setActiveTab: (tab: 'home' | 'upload' | 'history' | 'pricing' | 'channel') => void;
  user: UserAccount | null;
  onNewScan: () => void;
  onOpenAuth: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ 
  activeTab, 
  setActiveTab, 
  user, 
  onNewScan,
  onOpenAuth 
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleNavClick = (tab: 'home' | 'upload' | 'history' | 'pricing' | 'channel') => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  const handleScanClick = () => {
    onNewScan();
    setMobileMenuOpen(false);
  };

  return (
    <header className="border-b border-stone-800 bg-stone-950 text-stone-100 sticky top-0 z-40 backdrop-blur-md bg-stone-950/95">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Brand */}
        <div 
          className="flex items-center gap-3 cursor-pointer select-none group"
          onClick={() => handleNavClick('home')}
        >
          <div className="w-9 h-9 rounded-lg bg-rose-600 group-hover:bg-rose-500 transition-colors flex items-center justify-center text-white font-black text-sm tracking-tight shadow-md ring-1 ring-rose-400/30">
            VR
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-base sm:text-lg tracking-tight text-white group-hover:text-rose-100 transition-colors">
                VideoRisk
              </span>
              <span className="hidden xs:inline-block text-[11px] text-rose-400 font-semibold bg-rose-950/80 border border-rose-800/60 px-1.5 py-0.2 rounded">
                PRO
              </span>
            </div>
            <p className="text-[10px] sm:text-[11px] text-stone-400 leading-none">
              Know the risk before you publish.
            </p>
          </div>
        </div>

        {/* Desktop Navigation Links */}
        <nav className="hidden md:flex items-center gap-1 lg:gap-2 text-xs font-semibold">
          <button
            onClick={() => handleNavClick('home')}
            className={`px-3 py-2 rounded-lg transition-all ${
              activeTab === 'home' 
                ? 'text-white bg-stone-800/80 shadow-xs' 
                : 'text-stone-300 hover:text-white hover:bg-stone-900'
            }`}
          >
            Overview
          </button>
          
          <button
            onClick={onNewScan}
            className={`px-3 py-2 rounded-lg transition-all ${
              activeTab === 'upload' 
                ? 'text-white bg-stone-800/80 shadow-xs' 
                : 'text-stone-300 hover:text-white hover:bg-stone-900'
            }`}
          >
            New Scan
          </button>

          <button
            onClick={() => handleNavClick('history')}
            className={`px-3 py-2 rounded-lg transition-all ${
              activeTab === 'history' 
                ? 'text-white bg-stone-800/80 shadow-xs' 
                : 'text-stone-300 hover:text-white hover:bg-stone-900'
            }`}
          >
            Scans Archive
          </button>

          <button
            onClick={() => handleNavClick('channel')}
            className={`px-3 py-2 rounded-lg transition-all ${
              activeTab === 'channel' 
                ? 'text-white bg-stone-800/80 shadow-xs' 
                : 'text-stone-300 hover:text-white hover:bg-stone-900'
            }`}
          >
            Channel Context
          </button>

          <button
            onClick={() => handleNavClick('pricing')}
            className={`px-3 py-2 rounded-lg transition-all ${
              activeTab === 'pricing' 
                ? 'text-white bg-stone-800/80 shadow-xs' 
                : 'text-stone-300 hover:text-white hover:bg-stone-900'
            }`}
          >
            Credits & Plans
          </button>
        </nav>

        {/* Desktop Right Actions (Account, Credits, Scan CTA) */}
        <div className="hidden md:flex items-center gap-3">
          {/* User Account / Identity Badge */}
          <button
            onClick={onOpenAuth}
            className="flex items-center gap-2 px-2.5 py-1.5 bg-stone-900 hover:bg-stone-850 rounded-lg border border-stone-800 text-xs transition-colors"
            title="Manage account and switch user"
          >
            <div className="w-5 h-5 rounded-full bg-rose-700 text-white text-[10px] font-bold flex items-center justify-center">
              {user?.email?.charAt(0).toUpperCase() || 'U'}
            </div>
            <span className="text-stone-300 max-w-[120px] truncate font-medium">
              {user?.email?.split('@')[0] || 'Account'}
            </span>
            <ChevronDown className="w-3 h-3 text-stone-500" />
          </button>

          {/* Credits remaining counter */}
          <button 
            onClick={() => handleNavClick('pricing')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-900 hover:bg-stone-850 rounded-lg border border-stone-800 text-xs transition-colors"
            title="View credits & billing"
          >
            <span className="text-stone-400">Credits:</span>
            <span className="font-bold text-emerald-400 font-mono">
              {user?.creditsRemaining ?? 0}m
            </span>
          </button>

          {/* Quick Scan CTA */}
          <button
            onClick={onNewScan}
            className="flex items-center gap-1.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-all shadow-md hover:shadow-rose-900/30 active:scale-98"
          >
            <Video className="w-3.5 h-3.5" />
            <span>Scan Video</span>
          </button>
        </div>

        {/* Mobile Header Right: Balance Pill + Hamburger Button */}
        <div className="flex md:hidden items-center gap-2">
          {/* Compact Mobile Credits Badge */}
          <button
            onClick={() => handleNavClick('pricing')}
            className="flex items-center gap-1 px-2.5 py-1 bg-stone-900 rounded-lg border border-stone-800 text-xs text-stone-300"
          >
            <span className="font-bold text-emerald-400 font-mono text-xs">
              {user?.creditsRemaining ?? 0}m
            </span>
          </button>

          {/* Hamburger Menu Toggle Button */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-2 rounded-lg bg-stone-900 text-stone-300 hover:text-white hover:bg-stone-800 border border-stone-800 transition-colors focus:outline-none focus:ring-2 focus:ring-rose-500/50"
            aria-label="Toggle navigation menu"
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? (
              <X className="w-5 h-5 text-rose-500" />
            ) : (
              <Menu className="w-5 h-5" />
            )}
          </button>
        </div>
      </div>

      {/* MOBILE NAVIGATION DRAWER OVERLAY */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-stone-800 bg-stone-950 px-4 pt-3 pb-6 space-y-4 animate-in slide-in-from-top-2 duration-150">
          {/* Mobile User Profile Card */}
          <div className="p-3 bg-stone-900 rounded-xl border border-stone-800 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-rose-600 text-white font-bold text-xs flex items-center justify-center shrink-0">
                {user?.email?.charAt(0).toUpperCase() || 'U'}
              </div>
              <div className="overflow-hidden">
                <p className="text-xs font-bold text-white truncate max-w-[180px]">
                  {user?.email || 'Guest User'}
                </p>
                <div className="flex items-center gap-1.5 text-[10px] text-stone-400 mt-0.5">
                  <span className="uppercase font-semibold text-rose-400">{user?.plan || 'Free'} Plan</span>
                  <span>·</span>
                  <span className="text-emerald-400 font-bold">{user?.creditsRemaining ?? 0} mins left</span>
                </div>
              </div>
            </div>

            <button
              onClick={() => {
                setMobileMenuOpen(false);
                onOpenAuth();
              }}
              className="text-[11px] font-semibold text-rose-400 hover:text-rose-300 bg-stone-800 px-2.5 py-1 rounded-lg border border-stone-700"
            >
              Switch
            </button>
          </div>

          {/* Mobile Navigation Links */}
          <nav className="flex flex-col space-y-1">
            <button
              onClick={() => handleNavClick('home')}
              className={`w-full text-left px-3.5 py-2.5 rounded-lg text-sm font-semibold transition-colors flex items-center justify-between ${
                activeTab === 'home'
                  ? 'bg-rose-600/15 text-rose-400 font-bold border border-rose-600/30'
                  : 'text-stone-300 hover:bg-stone-900 hover:text-white'
              }`}
            >
              <span>Overview</span>
              <span className="text-xs text-stone-500">Home</span>
            </button>

            <button
              onClick={handleScanClick}
              className={`w-full text-left px-3.5 py-2.5 rounded-lg text-sm font-semibold transition-colors flex items-center justify-between ${
                activeTab === 'upload'
                  ? 'bg-rose-600/15 text-rose-400 font-bold border border-rose-600/30'
                  : 'text-stone-300 hover:bg-stone-900 hover:text-white'
              }`}
            >
              <span>New Scan</span>
              <span className="text-xs text-stone-500">Inspect</span>
            </button>

            <button
              onClick={() => handleNavClick('history')}
              className={`w-full text-left px-3.5 py-2.5 rounded-lg text-sm font-semibold transition-colors flex items-center justify-between ${
                activeTab === 'history'
                  ? 'bg-rose-600/15 text-rose-400 font-bold border border-rose-600/30'
                  : 'text-stone-300 hover:bg-stone-900 hover:text-white'
              }`}
            >
              <span>Scans Archive</span>
              <span className="text-xs text-stone-500">History</span>
            </button>

            <button
              onClick={() => handleNavClick('channel')}
              className={`w-full text-left px-3.5 py-2.5 rounded-lg text-sm font-semibold transition-colors flex items-center justify-between ${
                activeTab === 'channel'
                  ? 'bg-rose-600/15 text-rose-400 font-bold border border-rose-600/30'
                  : 'text-stone-300 hover:bg-stone-900 hover:text-white'
              }`}
            >
              <span>Channel Context</span>
              <span className="text-xs text-stone-500">Patterns</span>
            </button>

            <button
              onClick={() => handleNavClick('pricing')}
              className={`w-full text-left px-3.5 py-2.5 rounded-lg text-sm font-semibold transition-colors flex items-center justify-between ${
                activeTab === 'pricing'
                  ? 'bg-rose-600/15 text-rose-400 font-bold border border-rose-600/30'
                  : 'text-stone-300 hover:bg-stone-900 hover:text-white'
              }`}
            >
              <span>Credits & Plans</span>
              <span className="text-xs text-stone-500">Pricing</span>
            </button>
          </nav>

          {/* Prominent Action Button */}
          <div className="pt-2">
            <button
              onClick={handleScanClick}
              className="w-full py-3 bg-rose-600 hover:bg-rose-500 text-white font-bold text-sm rounded-xl shadow-lg shadow-rose-950 flex items-center justify-center gap-2 active:scale-98 transition-all"
            >
              <Video className="w-4 h-4" />
              <span>Start New Video Scan</span>
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
