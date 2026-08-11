import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { createAvatar } from '@dicebear/core';
import { thumbs } from '@dicebear/collection';
import { useApp } from '../context/AppContext';
import { useAuthContext, AuthModal } from './auth';
import { ProfileModal } from './ProfileModal';
import type { Member } from '../types';

type AuthFlow = 'signin' | 'register' | 'edit-profile' | null;

export function MemberSelector() {
  const { group, currentUser, setCurrentUser, updateProfile, refreshGroups, refreshData, clearGroupData } = useApp();
  const navigate = useNavigate();
  const {
    authenticated,
    session,
    loading: authLoading,
    isSupported,
    webAuthnLoading,
    webAuthnError,
    authenticate,
    register,
    logout,
    clearWebAuthnError,
  } = useAuthContext();

  const [authFlow, setAuthFlow] = useState<AuthFlow>(null);
  const [newName, setNewName] = useState('');
  const [registerError, setRegisterError] = useState<string | null>(null);

  // Sync current user with auth session and group data
  useEffect(() => {
    if (authLoading || !group) return;

    if (authenticated && session) {
      // Find the caller's member row in the active group. Legacy 1matrix
      // members have userId === id so the first lookup matches; for joined
      // groups, userId is the authoritative link.
      const member =
        group.members.find((m) => m.userId === session.userId) ??
        group.members.find((m) => m.id === session.userId);
      if (member) {
        // Adopt the fresh member row whenever it differs — comparing only
        // id/name left bank & avatar changes from other devices invisible
        // until a full reload. Reference equality settles after one pass
        // because we store the row object itself.
        if (currentUser !== member) {
          setCurrentUser(member);
        }
      }
    } else if (!authenticated && currentUser) {
      setCurrentUser(null);
    }
  }, [authenticated, session, authLoading, group, currentUser, setCurrentUser]);

  const handleSignIn = async () => {
    clearWebAuthnError();
    setAuthFlow('signin');
    try {
      await authenticate();
      // The app booted unauthenticated, so groups/expenses state is empty —
      // refetch now that the session cookie is live. Sequential on purpose:
      // refreshGroups fixes/clears the active group id (possibly left over
      // from another user on this browser) BEFORE refreshData reads it.
      await refreshGroups();
      await refreshData();
      setAuthFlow(null);
    } catch {
      // Error shown in UI
    }
  };

  const handleRegister = async () => {
    if (!newName.trim()) return;

    setRegisterError(null);
    clearWebAuthnError();

    try {
      // New flow: register creates a standalone User with no group membership.
      // After sign-in, the user creates their first group via /groups/new.
      const userId = crypto.randomUUID();
      await register(userId, newName.trim());
      // Sequential: a fresh user has no groups, and refreshGroups clears any
      // stale active-group id (e.g. another user used this browser) before
      // refreshData would load that group.
      await refreshGroups();
      await refreshData();
      setNewName('');
      setAuthFlow(null);
    } catch (err) {
      // Show specific error for already registered case
      const message = err instanceof Error ? err.message : 'Registration failed';
      if (message.includes('already registered') || message.includes('credential already exists')) {
        setRegisterError('This passkey is already registered. Please sign in instead.');
      }
      // Other errors shown via webAuthnError
    }
  };

  const handleLogout = async () => {
    await logout();
    clearGroupData();
    setAuthFlow(null);
    navigate('/');
  };

  const handleDeleteAccount = async () => {
    await logout();
    clearGroupData();
    setAuthFlow(null);
    navigate('/');
  };

  const handleEditProfile = () => {
    setAuthFlow('edit-profile');
  };

  const handleProfileSave = async (updates: Partial<Member>) => {
    try {
      await updateProfile(updates);
    } catch (err) {
      // Error will be handled by ProfileModal
      throw err;
    }
  };

  const handleCloseModal = () => {
    setAuthFlow(null);
    setNewName('');
    setRegisterError(null);
    clearWebAuthnError();
  };

  // Compute avatar at top level (Rules of Hooks: no hooks inside conditionals).
  // Falls back to session.userName when user has no group membership yet.
  const avatarSeed = currentUser?.avatarSeed || currentUser?.name || session?.userName || '';
  const avatarSvg = useMemo(() => {
    if (!avatarSeed) return '';
    return createAvatar(thumbs, { seed: avatarSeed, size: 36 }).toString();
  }, [avatarSeed]);
  const avatarDisplayName = currentUser?.name || session?.userName || '';
  const avatarUrl = avatarSeed ? `data:image/svg+xml;utf8,${encodeURIComponent(avatarSvg)}` : '';

  if (!isSupported) {
    return (
      <div className="text-sm text-red-400">
        Passkeys not supported
      </div>
    );
  }

  // Show loading state
  if (authLoading) {
    return <div className="text-sm text-gray-400">Loading...</div>;
  }

  // Authenticated state — show avatar whenever signed in, even before first group.
  if (authenticated) {
    return (
      <>
        <button
          onClick={handleEditProfile}
          className="cursor-pointer w-9 h-9 rounded-full overflow-hidden shrink-0 hover:opacity-80 transition-opacity"
          title={avatarDisplayName}
          aria-label="Profile"
        >
          <img src={avatarUrl} alt={avatarDisplayName} className="w-full h-full" />
        </button>

        <ProfileModal
          isOpen={authFlow === 'edit-profile'}
          // Users without a group yet still have a session identity — feed the
          // modal a synthetic member so name/avatar aren't blank.
          currentUser={
            currentUser ??
            (session
              ? { id: session.userId, userId: session.userId, name: session.userName }
              : null)
          }
          onClose={handleCloseModal}
          onSave={handleProfileSave}
          onLogout={handleLogout}
          onDeleteAccount={handleDeleteAccount}
        />
      </>
    );
  }

  // Not authenticated state
  return (
    <>
      <div className="flex items-center gap-2">
        <button
          onClick={handleSignIn}
          disabled={webAuthnLoading}
          title="Sign in"
          aria-label="Sign in"
          className="p-1.5 text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
        >
          {webAuthnLoading && authFlow === 'signin' ? (
            <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          ) : (
            /* login: arrow into door */
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
            </svg>
          )}
        </button>
        <button
          onClick={() => setAuthFlow('register')}
          disabled={webAuthnLoading}
          title="New user"
          aria-label="New user"
          className="p-1.5 text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
        >
          {/* user-plus */}
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
          </svg>
        </button>
      </div>

      <AuthModal isOpen={authFlow === 'register'} onClose={handleCloseModal}>
        <div className="p-6">
          <div className="text-center">
            <div className="text-4xl mb-4">👤</div>
            <h2 className="text-xl font-semibold text-gray-100 mb-2">Create Account</h2>
            <p className="text-gray-400 mb-6">
              Enter your name to create an account with passkey authentication.
            </p>

            <div className="mb-6">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                placeholder="Your name"
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-center text-gray-100"
                autoFocus
                disabled={webAuthnLoading}
              />
            </div>

            {(webAuthnError || registerError) && (
              <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg">
                <p className="text-sm text-red-300">{registerError || webAuthnError}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleCloseModal}
                disabled={webAuthnLoading}
                className="flex-1 px-4 py-2 border border-gray-600 rounded-lg text-gray-300 hover:bg-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRegister}
                disabled={webAuthnLoading || !newName.trim()}
                className="flex-1 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 disabled:opacity-50"
              >
                {webAuthnLoading ? 'Creating...' : 'Create Account'}
              </button>
            </div>
          </div>
        </div>
      </AuthModal>

      {/* Sign-in gets the same backdrop treatment as registration: a modal
          for the whole flow, not only for the failure case. */}
      <AuthModal isOpen={authFlow === 'signin'} onClose={handleCloseModal}>
        <div className="p-6">
          <div className="text-center">
            <div className="text-4xl mb-4">🔐</div>
            <h2 className="text-xl font-semibold text-gray-100 mb-2">
              {webAuthnError ? 'Sign In Failed' : 'Sign In'}
            </h2>
            <p className="text-gray-400 mb-6 text-sm">
              {webAuthnError
                ? 'Something went wrong with your passkey.'
                : 'Confirm with your passkey to continue.'}
            </p>

            {webAuthnError && (
              <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg">
                <p className="text-sm text-red-300">{webAuthnError}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleCloseModal}
                className="flex-1 px-4 py-2 border border-gray-600 rounded-lg text-gray-300 hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleSignIn}
                disabled={webAuthnLoading}
                className="flex-1 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 disabled:opacity-50"
              >
                {webAuthnLoading ? 'Signing in…' : webAuthnError ? 'Try Again' : 'Continue'}
              </button>
            </div>
          </div>
        </div>
      </AuthModal>
    </>
  );
}
