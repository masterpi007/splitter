import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthContext } from '../components/auth';
import { useApp } from '../context/AppContext';
import * as authApi from '../api/auth';
import * as api from '../api/client';
import type { InvitePreview } from '../api/client';

// The same /invite/:code URL serves two different flows:
//   1. Group invite: someone sharing a link to join their expense group.
//   2. Passkey-device invite: an existing user adding a new device to their
//      account (cross-device registration).
// We disambiguate by trying the public group-invite preview first; if that
// fails, we fall back to the passkey-invite options flow.
type InviteKind =
  | { kind: 'loading' }
  | { kind: 'group'; preview: InvitePreview }
  | { kind: 'passkey'; userName: string }
  | { kind: 'error'; message: string };

export function AcceptInvite() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const {
    authenticated,
    session,
    acceptPasskeyInvite,
    authenticate,
    register,
    webAuthnLoading,
    webAuthnError,
    clearWebAuthnError,
  } = useAuthContext();
  const { setActiveGroup, refreshGroups, refreshData } = useApp();

  const [invite, setInvite] = useState<InviteKind>({ kind: 'loading' });
  const [displayName, setDisplayName] = useState('');
  const [friendlyName, setFriendlyName] = useState('');
  const [mode, setMode] = useState<'choose' | 'new-passkey' | 'existing-passkey'>('choose');
  const [submitting, setSubmitting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [success, setSuccess] = useState<'group' | 'passkey' | null>(null);

  // Resolve what kind of invite this code points to.
  useEffect(() => {
    if (!code) {
      setInvite({ kind: 'error', message: 'Invalid invite link' });
      return;
    }
    let cancelled = false;

    api.previewInvite(code)
      .then((preview) => {
        if (!cancelled) setInvite({ kind: 'group', preview });
      })
      .catch(() => {
        // Not a group invite — try the passkey-device invite path.
        authApi.getInvitePasskeyOptions(code)
          .then(({ userName }) => {
            if (!cancelled) setInvite({ kind: 'passkey', userName });
          })
          .catch((err) => {
            if (!cancelled) {
              setInvite({
                kind: 'error',
                message: err instanceof Error ? err.message : 'Invalid or expired invite',
              });
            }
          });
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  // Default display name from the user's profile once authenticated.
  useEffect(() => {
    if (session && !displayName) setDisplayName(session.userName);
  }, [session, displayName]);

  // --- Group invite: accept for signed-in user ---
  const handleAcceptGroupInvite = async () => {
    if (!code || invite.kind !== 'group') return;
    setSubmitting(true);
    setPageError(null);
    try {
      const result = await api.acceptInvite(code, displayName.trim() || undefined);
      setActiveGroup(result.groupId);
      await Promise.all([refreshGroups(), refreshData()]);
      setSuccess('group');
      setTimeout(() => navigate('/'), 1200);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to join group');
    } finally {
      setSubmitting(false);
    }
  };

  // --- Group invite: register new account AND join in one step ---
  const handleRegisterAndJoin = async () => {
    if (!code || invite.kind !== 'group') return;
    const name = displayName.trim();
    if (!name) {
      setPageError('Please enter a name');
      return;
    }
    clearWebAuthnError();
    setPageError(null);
    setSubmitting(true);
    try {
      // Client-minted id becomes both the User.id and WebAuthn userID. The
      // server derives the target group from the invite record (never from
      // the client), and mints a fresh memberId for the group row.
      const userId = crypto.randomUUID();
      await register(userId, name, undefined, code);
      setActiveGroup(invite.preview.groupId);
      await Promise.all([refreshGroups(), refreshData()]);
      setSuccess('group');
      setTimeout(() => navigate('/'), 1200);
    } catch (err) {
      // Server refuses to create a second account backed by a passkey
      // already known to another user. Redirect them into the sign-in
      // flow instead of bubbling up a confusing "failed" message.
      if ((err as Error & { code?: string })?.code === 'CREDENTIAL_EXISTS') {
        await handleSignInAndJoin();
        return;
      }
      setPageError(err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setSubmitting(false);
    }
  };

  // --- Group invite: sign in with existing passkey, then accept in one step ---
  const handleSignInAndJoin = async () => {
    if (!code || invite.kind !== 'group') return;
    clearWebAuthnError();
    setPageError(null);
    setSubmitting(true);
    try {
      const signedIn = await authenticate();
      // Chain straight into accept — the session cookie is live even
      // though React state hasn't re-rendered yet. Fall back to the
      // signed-in user's profile name if the invite-form input was
      // left blank.
      const nameToUse = displayName.trim() || signedIn.userName;
      const result = await api.acceptInvite(code, nameToUse || undefined);
      setActiveGroup(result.groupId);
      await Promise.all([refreshGroups(), refreshData()]);
      setSuccess('group');
      setTimeout(() => navigate('/'), 1200);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to sign in');
    } finally {
      setSubmitting(false);
    }
  };

  // --- Passkey-device invite: create new passkey ---
  const handleCreateNewPasskey = async () => {
    if (!code) return;
    clearWebAuthnError();
    setPageError(null);
    try {
      await acceptPasskeyInvite(code, friendlyName || undefined);
      // The app booted unauthenticated, so the group list is empty — refetch
      // now that the session cookie is live (same as the group-invite path).
      await Promise.all([refreshGroups(), refreshData()]);
      setSuccess('passkey');
      setTimeout(() => navigate('/'), 1500);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to register passkey');
    }
  };

  // --- Passkey-device invite: sign in with existing passkey ---
  const handleUseExistingPasskey = async () => {
    clearWebAuthnError();
    setPageError(null);
    try {
      await authenticate();
      await Promise.all([refreshGroups(), refreshData()]);
      setSuccess('passkey');
      setTimeout(() => navigate('/'), 1500);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Failed to sign in');
    }
  };

  // --- Render ---

  if (invite.kind === 'loading') {
    return (
      <div className="max-w-md mx-auto mt-12 bg-gray-800 rounded-xl p-6 border border-gray-700 text-center">
        <p className="text-gray-400">Validating invite…</p>
      </div>
    );
  }

  if (invite.kind === 'error') {
    return (
      <div className="max-w-md mx-auto mt-12 bg-gray-800 rounded-xl p-6 border border-gray-700 text-center">
        <h2 className="text-xl font-semibold text-red-400 mb-2">Invite unavailable</h2>
        <p className="text-gray-400 mb-4">{invite.message}</p>
        <button
          onClick={() => navigate('/')}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg"
        >
          Go home
        </button>
      </div>
    );
  }

  if (success === 'group') {
    return (
      <div className="max-w-md mx-auto mt-12 bg-gray-800 rounded-xl p-6 border border-gray-700 text-center">
        <h2 className="text-xl font-semibold text-green-400 mb-2">Joined!</h2>
        <p className="text-gray-400">Loading the group…</p>
      </div>
    );
  }

  if (success === 'passkey') {
    return (
      <div className="max-w-md mx-auto mt-12 bg-gray-800 rounded-xl p-6 border border-gray-700 text-center">
        <h2 className="text-xl font-semibold text-green-400 mb-2">Signed in!</h2>
        <p className="text-gray-400">Redirecting…</p>
      </div>
    );
  }

  // ============ GROUP INVITE ============
  if (invite.kind === 'group') {
    const { preview } = invite;

    if (!authenticated) {
      return (
        <div className="max-w-md mx-auto mt-8 bg-gray-800 rounded-xl p-6 border border-gray-700">
          <h2 className="text-xl font-semibold text-gray-100 mb-1">Join {preview.groupName}</h2>
          <p className="text-sm text-gray-400 mb-6">
            {preview.memberCount} member{preview.memberCount === 1 ? '' : 's'} are already in this group.
          </p>

          <label className="block text-sm text-gray-300 mb-1">Your display name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRegisterAndJoin()}
            placeholder="Your name"
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-100 mb-2"
            autoFocus
            disabled={submitting || webAuthnLoading}
          />
          <p className="text-xs text-gray-500 mb-6">
            We'll create an account with a passkey on this device.
          </p>

          {(pageError || webAuthnError) && (
            <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg">
              <p className="text-sm text-red-300">{pageError || webAuthnError}</p>
            </div>
          )}

          <button
            onClick={handleRegisterAndJoin}
            disabled={submitting || webAuthnLoading || !displayName.trim()}
            className="w-full py-2.5 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white rounded-lg font-medium mb-3"
          >
            {submitting || webAuthnLoading ? 'Creating account…' : 'Create account & join'}
          </button>

          <div className="text-center text-sm text-gray-400">
            Already have an account?{' '}
            <button
              onClick={handleSignInAndJoin}
              disabled={webAuthnLoading}
              className="text-cyan-400 hover:text-cyan-300 font-medium disabled:opacity-50"
            >
              Sign in
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="max-w-md mx-auto mt-8 bg-gray-800 rounded-xl p-6 border border-gray-700">
        <h2 className="text-xl font-semibold text-gray-100 mb-1">Join {preview.groupName}</h2>
        <p className="text-sm text-gray-400 mb-6">
          {preview.memberCount} member{preview.memberCount === 1 ? '' : 's'} are already in this group.
        </p>

        <label className="block text-sm text-gray-300 mb-1">Your display name in this group</label>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={session?.userName ?? 'Your name'}
          className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-100 mb-2"
        />
        <p className="text-xs text-gray-500 mb-6">
          Can differ per group. Defaults to your profile name.
        </p>

        {pageError && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg">
            <p className="text-sm text-red-300">{pageError}</p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => navigate('/')}
            className="flex-1 py-2.5 border border-gray-600 hover:bg-gray-800 text-gray-300 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={handleAcceptGroupInvite}
            disabled={submitting}
            className="flex-1 py-2.5 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white rounded-lg font-medium"
          >
            {submitting ? 'Joining…' : 'Join group'}
          </button>
        </div>
      </div>
    );
  }

  // ============ PASSKEY-DEVICE INVITE (legacy flow) ============
  if (authenticated) {
    return (
      <div className="max-w-md mx-auto mt-12 bg-gray-800 rounded-xl p-6 border border-gray-700 text-center">
        <h2 className="text-xl font-semibold text-green-400 mb-2">Already signed in</h2>
        <p className="text-gray-400 mb-4">
          You're signed in as <span className="text-cyan-400 font-medium">{session?.userName}</span>.
        </p>
        <button
          onClick={() => navigate('/')}
          className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg"
        >
          Go home
        </button>
      </div>
    );
  }

  const { userName } = invite;
  return (
    <div className="max-w-md mx-auto mt-12 bg-gray-800 rounded-xl p-6 border border-gray-700">
      {mode === 'choose' && (
        <div className="text-center">
          <h2 className="text-xl font-semibold text-gray-100 mb-2">Sign in as {userName}</h2>
          <p className="text-sm text-gray-400 mb-6">How would you like to sign in on this device?</p>

          {(pageError || webAuthnError) && (
            <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg">
              <p className="text-sm text-red-300">{pageError || webAuthnError}</p>
            </div>
          )}

          <div className="space-y-3">
            <button
              onClick={() => setMode('existing-passkey')}
              className="w-full py-3 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg font-medium"
            >
              Use existing passkey
            </button>
            <button
              onClick={() => setMode('new-passkey')}
              className="w-full py-3 bg-gray-600 hover:bg-gray-500 text-white rounded-lg font-medium"
            >
              Create new passkey
            </button>
          </div>
        </div>
      )}

      {mode === 'existing-passkey' && (
        <div className="text-center">
          <h2 className="text-xl font-semibold text-gray-100 mb-6">
            Sign in as <span className="text-cyan-400">{userName}</span>
          </h2>
          {(pageError || webAuthnError) && (
            <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg">
              <p className="text-sm text-red-300">{pageError || webAuthnError}</p>
            </div>
          )}
          <button
            onClick={handleUseExistingPasskey}
            disabled={webAuthnLoading}
            className="w-full py-3 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white rounded-lg font-medium mb-2"
          >
            {webAuthnLoading ? 'Signing in…' : 'Sign in with passkey'}
          </button>
          <button onClick={() => setMode('choose')} className="text-gray-400 hover:text-gray-200 text-sm">
            Back
          </button>
        </div>
      )}

      {mode === 'new-passkey' && (
        <div className="text-center">
          <h2 className="text-xl font-semibold text-gray-100 mb-6">
            Add a passkey for <span className="text-cyan-400">{userName}</span>
          </h2>
          <label className="block text-sm text-gray-400 mb-1 text-left">Device name (optional)</label>
          <input
            type="text"
            value={friendlyName}
            onChange={(e) => setFriendlyName(e.target.value)}
            placeholder="e.g. My iPhone"
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-100 mb-4"
            disabled={webAuthnLoading}
          />
          {(pageError || webAuthnError) && (
            <div className="mb-4 p-3 bg-red-900/30 border border-red-700 rounded-lg">
              <p className="text-sm text-red-300">{pageError || webAuthnError}</p>
            </div>
          )}
          <button
            onClick={handleCreateNewPasskey}
            disabled={webAuthnLoading}
            className="w-full py-3 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white rounded-lg font-medium mb-2"
          >
            {webAuthnLoading ? 'Creating…' : 'Create passkey'}
          </button>
          <button onClick={() => setMode('choose')} className="text-gray-400 hover:text-gray-200 text-sm">
            Back
          </button>
        </div>
      )}
    </div>
  );
}
