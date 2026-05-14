import { useState, useEffect, useMemo } from 'react';
import { createAvatar } from '@dicebear/core';
import { thumbs } from '@dicebear/collection';
import { useApp } from '../context/AppContext';
import { useAuthContext, AuthModal } from './auth';
import { ProfileModal } from './ProfileModal';
import type { Member } from '../types';

type AuthFlow = 'signin' | 'register' | 'edit-profile' | null;

export function MemberSelector() {
  const { group, currentUser, setCurrentUser, updateProfile } = useApp();
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
        // Update if ID changed OR name changed
        if (currentUser?.id !== member.id || currentUser?.name !== member.name) {
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
    setCurrentUser(null);
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
          currentUser={currentUser}
          onClose={handleCloseModal}
          onSave={handleProfileSave}
          onLogout={handleLogout}
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
          className="px-3 py-1 bg-cyan-600 text-white text-sm rounded hover:bg-cyan-700 disabled:opacity-50"
        >
          {webAuthnLoading && authFlow === 'signin' ? 'Signing in...' : 'Sign In'}
        </button>
        <button
          onClick={() => setAuthFlow('register')}
          disabled={webAuthnLoading}
          className="text-cyan-400 text-sm font-medium hover:text-cyan-300 disabled:opacity-50"
        >
          New User
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

      <AuthModal isOpen={authFlow === 'signin' && !!webAuthnError} onClose={handleCloseModal}>
        <div className="p-6">
          <div className="text-center">
            <div className="text-4xl mb-4">🔐</div>
            <h2 className="text-xl font-semibold text-gray-100 mb-2">Sign In Failed</h2>

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
                Try Again
              </button>
            </div>
          </div>
        </div>
      </AuthModal>
    </>
  );
}
