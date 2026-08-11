import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { NotificationRecord, TelegramStatus, NotifyPrefs } from '../types';
import * as api from '../api/client';
import { useAuthContext } from './auth/AuthProvider';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { getTelegramStatus, connectTelegram, disconnectTelegram, updateTelegramPreferences } from '../api/telegram';

// Default all-on prefs used for display when prefs haven't loaded yet
const DEFAULT_PREFS: NotifyPrefs = {
  newExpense: true,
  expenseEdited: true,
  expenseDeleted: true,
  settlementRequest: true,
  settlementAccepted: true,
  settlementRejected: true,
};

const NOTIFY_LABELS: Record<keyof NotifyPrefs, string> = {
  newExpense: 'New expense',
  expenseEdited: 'Expense edited',
  expenseDeleted: 'Expense deleted',
  settlementRequest: 'Settlement request',
  settlementAccepted: 'Settlement accepted',
  settlementRejected: 'Settlement rejected',
};

const TG_ICON = (
  <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.99 1.27-5.62 3.72-.53.36-1.01.54-1.44.53-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.37-.49 1.02-.75 4-1.74 6.67-2.89 8.02-3.44 3.82-1.58 4.61-1.86 5.13-1.87.11 0 .37.03.54.17.14.12.18.28.2.45-.01.06.01.24 0 .37z"/>
  </svg>
);

const BELL_PATH = "M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9";

function GearIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

export function NotificationBell() {
  const { authenticated } = useAuthContext();
  const navigate = useNavigate();
  const push = usePushNotifications();
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'history' | 'settings'>('history');
  const ref = useRef<HTMLDivElement>(null);

  // Telegram state
  const [telegram, setTelegram] = useState<TelegramStatus>({ connected: false, notifyPrefs: null });
  const [tgConnecting, setTgConnecting] = useState(false);
  const [tgFailed, setTgFailed] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Push prefs state
  const [pushPrefs, setPushPrefs] = useState<NotifyPrefs | null>(null);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const fetchNotifications = useCallback(async () => {
    if (!authenticated) return;
    try {
      const data = await api.getNotifications();
      setNotifications(data);
    } catch {
      // ignore
    }
  }, [authenticated]);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  // Re-fetch telegram status and push prefs whenever bell opens
  useEffect(() => {
    if (!open || !authenticated) return;
    getTelegramStatus().then((s) => {
      if (s.connected) {
        setTelegram(s);
        setTgConnecting(false);
        setTgFailed(false);
        stopPolling();
      } else if (!pollRef.current) {
        // Only overwrite if we're not currently polling for a connection
        setTelegram(s);
      }
    }).catch(() => {});
    api.getPushPrefs().then(setPushPrefs).catch(() => {});
  }, [open, authenticated]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Refresh on service worker REFRESH_DATA
  useEffect(() => {
    if (!navigator.serviceWorker) return;
    const handler = () => { fetchNotifications(); };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [fetchNotifications]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = async () => {
    const opening = !open;
    setOpen(opening);
    if (opening && unreadCount > 0) {
      try {
        const updated = await api.markNotificationsRead();
        setNotifications(updated);
      } catch {
        // ignore
      }
    }
    if (!opening) setView('history');
  };

  const handleClick = (n: NotificationRecord) => {
    setOpen(false);
    if (n.url) navigate(n.url);
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const handleTgConnect = async () => {
    setTgConnecting(true);
    setTgFailed(false);
    try {
      const { deepLink } = await connectTelegram();
      window.open(deepLink, '_blank');

      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        try {
          const s = await getTelegramStatus();
          if (s.connected) {
            setTelegram(s);
            setTgConnecting(false);
            stopPolling();
          } else if (attempts >= 40) {
            setTgConnecting(false);
            setTgFailed(true);
            stopPolling();
          }
        } catch {
          // ignore poll errors
        }
      }, 3000);
    } catch {
      setTgConnecting(false);
      setTgFailed(true);
    }
  };

  const handleTgDisconnect = async () => {
    try {
      await disconnectTelegram();
      setTelegram({ connected: false, notifyPrefs: null });
    } catch {
      // ignore
    }
  };

  // Single toggle: applies to both push and telegram simultaneously
  const handlePrefToggle = async (key: keyof NotifyPrefs) => {
    const effectivePrefs = pushPrefs ?? DEFAULT_PREFS;
    const newValue = !effectivePrefs[key];

    if (push.isSubscribed) {
      const updated = { ...effectivePrefs, [key]: newValue };
      setPushPrefs(updated);
      api.updatePushPrefs({ [key]: newValue }).catch(() => setPushPrefs(effectivePrefs));
    }

    if (telegram.connected && telegram.notifyPrefs) {
      const updatedTg = { ...telegram.notifyPrefs, [key]: newValue };
      setTelegram((prev) => ({ ...prev, notifyPrefs: updatedTg }));
      updateTelegramPreferences({ [key]: newValue }).catch(() =>
        setTelegram((prev) => ({ ...prev, notifyPrefs: telegram.notifyPrefs }))
      );
    }
  };

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  };

  const getEffectivePref = (key: keyof NotifyPrefs): boolean => {
    if (pushPrefs) return pushPrefs[key];
    if (telegram.notifyPrefs) return telegram.notifyPrefs[key];
    return DEFAULT_PREFS[key];
  };

  if (!authenticated) return null;

  const inSettings = view === 'settings';

  return (
    <div className="relative" ref={ref}>
      {/* Bell trigger */}
      <button
        onClick={handleOpen}
        className="p-1.5 text-gray-400 hover:text-gray-200 relative"
        aria-label="Notifications"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={BELL_PATH} />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center font-bold">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Full-width sheet on phones; on wider screens anchored under the bell
          itself rather than pinned to the viewport edge, which left it
          floating far from the button once the header became centred. */}
      {open && (
        <div className="fixed left-2 right-2 top-16 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 flex flex-col overflow-hidden"
          style={{ maxHeight: 'calc(100vh - 5rem)' }}>

          {/* Sliding panels wrapper */}
          <div
            className="flex flex-1 min-h-0 transition-transform duration-300 ease-in-out"
            style={{ transform: inSettings ? 'translateX(-50%)' : 'translateX(0)', width: '200%' }}
          >
            {/* ── Panel 1: History ── */}
            <div className="w-1/2 flex flex-col min-h-0">
              {/* History header */}
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-700 shrink-0">
                <span className="text-sm font-semibold text-gray-200">Notifications</span>
                <button
                  onClick={() => setView('settings')}
                  className="cursor-pointer p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-700"
                  title="Settings"
                >
                  <GearIcon />
                </button>
              </div>

              {/* History list */}
              <div className="overflow-y-auto flex-1">
                {notifications.length === 0 ? (
                  <div className="p-4 text-center text-gray-500 text-sm">No notifications yet</div>
                ) : (
                  notifications.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => handleClick(n)}
                      className={`w-full text-left px-3 py-2.5 border-b border-gray-700 last:border-b-0 hover:bg-gray-700/50 ${
                        !n.read ? 'bg-gray-700/30' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-200 truncate">{n.title}</div>
                          <div className="text-xs text-gray-400 mt-0.5">{n.body}</div>
                        </div>
                        <span className="text-xs text-gray-500 shrink-0">{timeAgo(n.createdAt)}</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* ── Panel 2: Settings ── */}
            <div className="w-1/2 flex flex-col min-h-0">
              {/* Settings header */}
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-700 shrink-0">
                <button
                  onClick={() => setView('history')}
                  className="cursor-pointer p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-700"
                  title="Back"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="text-sm font-semibold text-gray-200">Settings</span>
              </div>

              {/* Settings content */}
              <div className="overflow-y-auto flex-1 px-3 py-2 space-y-2">
                {/* Channel buttons */}
                <div className="space-y-1">
                  {/* Push */}
                  {push.isSupported && (
                    push.permission === 'denied' ? (
                      <p className="text-xs text-gray-500 px-2 py-1">Push blocked in browser settings</p>
                    ) : (
                      <button
                        onClick={push.isSubscribed ? push.unsubscribe : push.subscribe}
                        disabled={push.loading}
                        className={`cursor-pointer flex items-center gap-2 w-full px-2.5 py-2 rounded text-xs font-medium ${
                          push.isSubscribed
                            ? 'text-cyan-400 bg-cyan-900/30'
                            : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'
                        } disabled:opacity-50`}
                      >
                        <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={BELL_PATH} />
                        </svg>
                        {push.loading ? '...' : push.isSubscribed ? 'Push notifications on' : 'Enable push notifications'}
                      </button>
                    )
                  )}

                  {/* Telegram */}
                  <button
                    onClick={telegram.connected ? handleTgDisconnect : handleTgConnect}
                    disabled={tgConnecting}
                    className={`group flex items-center gap-2 w-full px-2.5 py-2 rounded text-xs font-medium ${
                      telegram.connected
                        ? 'cursor-pointer text-cyan-400 bg-cyan-900/30 hover:bg-red-900/20 hover:text-red-400'
                        : tgConnecting
                        ? 'text-gray-500 bg-gray-700/50 cursor-not-allowed'
                        : tgFailed
                        ? 'cursor-pointer text-red-400 bg-red-900/20 hover:bg-red-900/30'
                        : 'cursor-pointer text-gray-400 hover:text-gray-200 hover:bg-gray-700'
                    }`}
                  >
                    {TG_ICON}
                    {telegram.connected ? (
                      <>
                        <span className="group-hover:hidden">{`@${telegram.telegramName}`}</span>
                        <span className="hidden group-hover:inline">Disconnect</span>
                      </>
                    ) : tgConnecting ? 'Connecting...' : tgFailed ? 'Connection failed — Retry' : 'Connect Telegram'}
                  </button>
                </div>

                {/* Category toggles */}
                <div className="border-t border-gray-700 pt-2 space-y-0.5">
                  <p className="text-xs text-gray-500 mb-1.5">Notify me for:</p>
                  {(Object.keys(NOTIFY_LABELS) as (keyof NotifyPrefs)[]).map((key) => {
                    const on = getEffectivePref(key);
                    return (
                      <div key={key} className="flex items-center justify-between py-1">
                        <span className="text-xs text-gray-400">{NOTIFY_LABELS[key]}</span>
                        <button
                          role="switch"
                          aria-checked={on}
                          onClick={() => handlePrefToggle(key)}
                          className={`relative w-7 h-4 rounded-full transition-colors shrink-0 ml-2 cursor-pointer ${on ? 'bg-cyan-600' : 'bg-gray-600'}`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform ${on ? 'translate-x-3' : ''}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

