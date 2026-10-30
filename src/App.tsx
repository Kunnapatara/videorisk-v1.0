import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { HomeView } from './components/HomeView';
import { UploadModal } from './components/UploadModal';
import { ProcessingView } from './components/ProcessingView';
import { ReportView } from './components/ReportView';
import { ComparisonView } from './components/ComparisonView';
import { HistoryView } from './components/HistoryView';
import { PricingView } from './components/PricingView';
import { ChannelProfileView } from './components/ChannelProfileView';
import { AuthModal } from './components/AuthModal';
import { UserAccount, RiskReport, ScanJob, ReScanComparison } from './types';
import { authFetch } from './utils/api';

export function App() {
  const [activeTab, setActiveTab] = useState<'home' | 'upload' | 'processing' | 'report' | 'comparison' | 'history' | 'pricing' | 'channel'>('home');
  const [user, setUser] = useState<UserAccount | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalInitialMode, setAuthModalInitialMode] = useState<'account' | 'login' | 'register' | 'switch' | 'forgot' | 'reset'>('login');

  // Active scan state
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [activeScan, setActiveScan] = useState<ScanJob | null>(null);
  const [activeReport, setActiveReport] = useState<RiskReport | null>(null);
  const [activeComparison, setActiveComparison] = useState<ReScanComparison | null>(null);

  // Re-scan trigger parent ID
  const [rescanParentId, setRescanParentId] = useState<string | undefined>(undefined);

  const fetchUser = async () => {
    try {
      const res = await authFetch('/api/user');
      if (res.ok) {
        const data = await res.json();
        setUser(data);
      } else {
        setUser(null);
      }
    } catch (err) {
      setUser(null);
      console.warn('Failed to load user account:', err);
    }
  };

  useEffect(() => {
    fetchUser();
  }, []);

  // When user switches or logs in
  const handleUserChanged = (newUser: UserAccount | null) => {
    if (!newUser) {
      setUser(null);
      setActiveScan(null);
      setActiveReport(null);
      setActiveComparison(null);
      setActiveScanId(null);
      setActiveTab('home');
      return;
    }

    setUser(newUser);
    // If viewing a scan that might not belong to new user, reset to home or history
    if (activeScan && activeScan.userId !== newUser.id) {
      setActiveScan(null);
      setActiveReport(null);
      setActiveComparison(null);
      setActiveScanId(null);
      setActiveTab('history');
    }
  };

  // When a scan is created
  const handleScanCreated = (scanId: string) => {
    setActiveScanId(scanId);
    setActiveTab('processing');
    setRescanParentId(undefined);
    fetchUser();
  };

  // When processing completes
  const handleProcessingComplete = async (scanId: string) => {
    try {
      // Fetch scan
      const scanRes = await authFetch(`/api/scans/${scanId}`);
      if (scanRes.ok) {
        const scanData = await scanRes.json();
        setActiveScan(scanData);
      }

      // Fetch report
      const reportRes = await authFetch(`/api/scans/${scanId}/report`);
      if (reportRes.ok) {
        const reportData = await reportRes.json();
        setActiveReport(reportData);
      }

      // Fetch comparison if available
      const compRes = await authFetch(`/api/scans/${scanId}/comparison`);
      if (compRes.ok) {
        const compData = await compRes.json();
        setActiveComparison(compData);
      } else {
        setActiveComparison(null);
      }

      setActiveTab('report');
      fetchUser();
    } catch (err) {
      console.error('Error fetching completed scan report:', err);
    }
  };

  // When selecting a scan from history
  const handleSelectHistoricalScan = async (scanId: string) => {
    setActiveScanId(scanId);
    await handleProcessingComplete(scanId);
  };

  // Initiate re-scan
  const handleInitiateRescan = (parentScanId: string) => {
    setRescanParentId(parentScanId);
    setActiveTab('upload');
  };

  return (
    <div className="min-h-screen bg-stone-100 flex flex-col font-sans text-stone-900 selection:bg-rose-500 selection:text-white antialiased">
      <Navbar 
        activeTab={
          activeTab === 'processing' || activeTab === 'report' || activeTab === 'comparison'
            ? 'upload'
            : activeTab
        }
        setActiveTab={(tab) => {
          setRescanParentId(undefined);
          setActiveTab(tab);
        }}
        user={user}
        onNewScan={() => {
          setRescanParentId(undefined);
          setActiveTab('upload');
        }}
        onOpenAuth={() => {
          setAuthModalInitialMode(user ? 'account' : 'login');
          setAuthModalOpen(true);
        }}
      />

      <main className="flex-1 w-full">
        {activeTab === 'home' && (
          <HomeView
            user={user}
            onStartUpload={() => {
              setRescanParentId(undefined);
              setActiveTab('upload');
            }}
            onExplorePricing={() => setActiveTab('pricing')}
            onTryDemo={() => {
              setRescanParentId(undefined);
              setActiveTab('upload');
            }}
            onOpenRegister={() => {
              setAuthModalInitialMode('register');
              setAuthModalOpen(true);
            }}
          />
        )}

        {activeTab === 'upload' && (
          <div className="py-6 sm:py-10 px-3 sm:px-6 max-w-4xl mx-auto w-full">
            <UploadModal
              user={user}
              onScanCreated={handleScanCreated}
              onCancel={() => setActiveTab('home')}
              parentScanId={rescanParentId}
              onGoToChannelProfile={() => setActiveTab('channel')}
              onExplorePricing={() => setActiveTab('pricing')}
            />
          </div>
        )}

        {activeTab === 'processing' && activeScanId && (
          <div className="py-6 sm:py-10 px-3 sm:px-6 max-w-4xl mx-auto w-full">
            <ProcessingView
              scanId={activeScanId}
              onComplete={handleProcessingComplete}
              onCancel={() => setActiveTab('home')}
            />
          </div>
        )}

        {activeTab === 'report' && activeReport && activeScan && (
          <div className="w-full">
            <ReportView
              report={activeReport}
              scan={activeScan}
              onInitiateRescan={handleInitiateRescan}
              onViewComparison={() => setActiveTab('comparison')}
              hasComparison={!!activeComparison}
            />
          </div>
        )}

        {activeTab === 'comparison' && activeComparison && (
          <div className="w-full">
            <ComparisonView
              comparison={activeComparison}
              onBackToReport={() => setActiveTab('report')}
              onNewScan={() => {
                setRescanParentId(undefined);
                setActiveTab('upload');
              }}
            />
          </div>
        )}

        {activeTab === 'history' && (
          <div className="w-full">
            <HistoryView
              onSelectScan={handleSelectHistoricalScan}
              onInitiateRescan={handleInitiateRescan}
              onNewScan={() => {
                setRescanParentId(undefined);
                setActiveTab('upload');
              }}
            />
          </div>
        )}

        {activeTab === 'channel' && (
          <div className="w-full">
            <ChannelProfileView
              user={user}
              onStartScan={() => {
                setRescanParentId(undefined);
                setActiveTab('upload');
              }}
            />
          </div>
        )}

        {activeTab === 'pricing' && (
          <div className="w-full">
            <PricingView
              user={user}
              onPlanUpdated={(updatedUser) => setUser(updatedUser)}
              onNewScan={() => {
                setRescanParentId(undefined);
                setActiveTab('upload');
              }}
            />
          </div>
        )}
      </main>

      {/* Auth & Account Modal */}
      <AuthModal
        currentUser={user}
        isOpen={authModalOpen}
        initialMode={authModalInitialMode}
        onClose={() => setAuthModalOpen(false)}
        onUserChanged={handleUserChanged}
      />

      {/* Responsive Footer */}
      <footer className="border-t border-stone-200 bg-white py-8 sm:py-10 px-4 text-xs text-stone-500 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
              <span className="font-extrabold text-stone-900">VideoRisk</span>
              <span>·</span>
              <span className="font-medium text-stone-600">Pre-Publish Video Risk Intelligence</span>
            </div>
            <p className="font-bold text-stone-800">
              Know the risk before you publish.
            </p>
          </div>
          <div className="text-[11px] text-stone-400 max-w-md sm:text-right space-y-1">
            <p className="font-medium text-stone-600">Evidence first. Context that matters. Better-informed decisions.</p>
            <p>VideoRisk provides policy risk intelligence and does not make final platform decisions or guarantee monetization outcomes.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
