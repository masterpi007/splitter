import { ReactNode, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Navigation } from './Navigation';
import { MemberSelector } from './MemberSelector';
import { NotificationBell } from './NotificationBell';
import { useApp } from '../context/AppContext';
import { useAuthContext } from './auth';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { loading, error, group, groups } = useApp();
  const { authenticated, loading: authLoading } = useAuthContext();
  const navigate = useNavigate();
  const location = useLocation();

  // User-first: once auth and group list are resolved, guide the user
  // to create their first group if they have none.
  useEffect(() => {
    if (authLoading || loading) return;
    if (!authenticated) return;
    const onGroupsRoute = location.pathname.startsWith('/groups') || location.pathname.startsWith('/invite');
    if (groups.length === 0 && !onGroupsRoute) {
      navigate('/groups', { replace: true });
    }
  }, [authenticated, authLoading, loading, groups.length, location.pathname, navigate]);

  // The back button is a hardcoded "return to groups list" affordance —
  // simpler than history-based nav, which gets confusing when users land
  // deep via an invite link. Disabled on /groups itself (already there).
  const onGroupsScreen = location.pathname === '/groups';
  const headerTitle = onGroupsScreen ? 'Groups' : (group?.name ?? 'Split');

  const handleBack = () => {
    navigate('/groups');
  };

  const handleReload = async () => {
    // Hard reload: clear caches first, then reload
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
    }
    window.location.reload();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="flex flex-col items-center gap-3">
          <svg
            className="w-10 h-10 text-cyan-500 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-sm text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 p-4">
        <div className="bg-gray-800 border border-red-700 rounded-xl p-6 max-w-sm w-full text-center space-y-4">
          <div className="w-12 h-12 mx-auto rounded-full bg-red-900/40 flex items-center justify-center">
            <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-gray-100">Something went wrong</p>
            <p className="text-sm text-gray-400 mt-1">{error}</p>
          </div>
          <button
            onClick={handleReload}
            className="w-full py-2.5 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg text-sm font-medium"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-gray-800 shadow-sm border-b border-gray-700">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* iOS Safari navigation buttons */}
            <div className="flex items-center gap-1">
              <button
                onClick={handleBack}
                disabled={onGroupsScreen}
                className="cursor-pointer p-2.5 text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Back to groups"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={handleReload}
                className="cursor-pointer p-2.5 text-gray-400 hover:text-gray-200"
                aria-label="Reload"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>
            {onGroupsScreen ? (
              // Index screen — signal "this is the list, not any one group":
              // neutral grey, no logo emblem (the logo represents a specific group).
              <div className="flex items-center gap-2">
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 12h14M5 16h14" />
                </svg>
                <h1 className="text-lg font-semibold text-gray-200 tracking-wide">{headerTitle}</h1>
              </div>
            ) : (
              <button
                onClick={() => navigate('/groups')}
                className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
                title="Switch group"
                aria-label="Switch group"
              >
                <img src="/logo.svg" alt="" className="w-8 h-8" />
                <h1 className="text-xl font-bold text-cyan-400">{headerTitle}</h1>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <MemberSelector />
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-4xl mx-auto w-full px-4 pt-6 pb-24">
        {children}
      </main>
      <Navigation />
    </div>
  );
}
