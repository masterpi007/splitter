import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useAuthContext } from '../components/auth';
import * as api from '../api/client';
import { sanitizeDecimalInput } from '../utils/balances';
import type { Group, GroupInvite, Member } from '../types';
import type { FriendCandidate } from '../api/client';

export function GroupManager() {
  const { id: routeGroupId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { group, activeGroupId, setActiveGroup, refreshData, refreshGroups } = useApp();
  const { session } = useAuthContext();

  const [invites, setInvites] = useState<GroupInvite[] | null>(null);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [friends, setFriends] = useState<FriendCandidate[] | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep the URL and the active group in sync. If the URL id doesn't match
  // the current active group, switch — then the fetch in AppContext reloads
  // the right group and this page re-renders with the correct data.
  useEffect(() => {
    if (routeGroupId && routeGroupId !== activeGroupId) {
      setActiveGroup(routeGroupId);
    }
  }, [routeGroupId, activeGroupId, setActiveGroup]);

  // Only trust the loaded `group` when it matches the URL. During the brief
  // window between navigating to /groups/:id and the new group loading, `group`
  // still points at the previous selection; without this guard the admin chrome
  // from group A would flash on top of group B's URL.
  const groupMatchesRoute = !!group && (!routeGroupId || group.id === routeGroupId);
  const currentMember = useMemo<Member | null>(() => {
    if (!group || !session || !groupMatchesRoute) return null;
    return (
      group.members.find((m) => m.userId === session.userId) ??
      group.members.find((m) => m.id === session.userId) ??
      null
    );
  }, [group, session, groupMatchesRoute]);
  const isAdmin = !!currentMember && !!group?.admins.includes(currentMember.id) && groupMatchesRoute;

  useEffect(() => {
    if (!group || !currentMember) return;
    setInvitesLoading(true);
    api.listInvites()
      .then(setInvites)
      .catch((err) => setInvitesError(err instanceof Error ? err.message : 'Failed to load invites'))
      .finally(() => setInvitesLoading(false));
  }, [group?.id, currentMember?.id]);

  // Friend list — candidates the admin can add directly without an invite link.
  // Only fetched for admins since the server rejects non-admins.
  useEffect(() => {
    if (!group || !currentMember || !isAdmin) {
      setFriends(null);
      return;
    }
    api.listFriends()
      .then(setFriends)
      .catch((err) => setFriendsError(err instanceof Error ? err.message : 'Failed to load friends'));
  }, [group?.id, currentMember?.id, isAdmin]);

  if (!group) {
    return <p className="text-sm text-gray-400">Loading…</p>;
  }

  if (!currentMember) {
    return (
      <div className="max-w-md mx-auto mt-8 bg-gray-800 border border-gray-700 rounded-xl p-6 text-center">
        <p className="text-sm text-gray-400">Sign in to manage this group.</p>
      </div>
    );
  }

  const wrap = async <T,>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
      return null;
    } finally {
      setBusy(null);
    }
  };

  const handleCreateInvite = async () => {
    const invite = await wrap('create-invite', () => api.createInvite());
    if (invite) setInvites((prev) => [...(prev ?? []), invite]);
  };

  const handleDeleteInvite = async (code: string) => {
    const ok = await wrap(`delete-invite-${code}`, () => api.deleteInvite(code));
    if (ok !== null) setInvites((prev) => prev?.filter((i) => i.code !== code) ?? null);
  };

  const handleCopyInviteLink = async (code: string) => {
    const url = `${window.location.origin}/invite/${code}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // ignore — user can select manually
    }
  };

  const handleShareInviteLink = async (code: string) => {
    const url = `${window.location.origin}/invite/${code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `Join ${group.name}`, url });
      } catch {
        // user cancelled — no-op
      }
    } else {
      handleCopyInviteLink(code);
    }
  };

  const handleToggleAdmin = async (memberId: string, makeAdmin: boolean) => {
    const updated = await wrap(`admin-${memberId}`, () => api.updateAdmin(memberId, makeAdmin));
    if (updated) syncGroupLocal(updated);
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!confirm('Remove this member? Their balances and history stay visible, but they lose access to the group.')) return;
    const updated = await wrap(`remove-${memberId}`, () => api.removeMember(memberId));
    if (!updated) return;
    if (memberId === currentMember.id) {
      // Left our own group — skip syncGroupLocal (which would refetch the
      // just-left group and hit 403/404). Refresh the group list and bounce
      // out; AppContext picks a new active group from the fresh list.
      await refreshGroups();
      navigate('/groups');
      return;
    }
    syncGroupLocal(updated);
  };

  const handleLeave = () => handleRemoveMember(currentMember.id);

  const handleDeleteGroup = async () => {
    if (!confirm(`Delete "${group.name}" permanently? This cannot be undone. All expenses, invites, and member data will be lost.`)) return;
    const ok = await wrap('delete-group', () => api.deleteGroup(group.id));
    if (ok !== null) {
      await refreshGroups();
      navigate('/groups');
    }
  };

  const handleAddFriend = async (friend: FriendCandidate) => {
    const updated = await wrap(`add-friend-${friend.userId}`, () =>
      api.addFriendToGroup(friend.userId),
    );
    if (updated) {
      setFriends((prev) => prev?.filter((f) => f.userId !== friend.userId) ?? null);
      syncGroupLocal(updated);
    }
  };

  const handleRateChange = async (memberId: string, raw: string) => {
    const trimmed = raw.trim();
    // Empty input → clear the override; valid positive number → save; else ignore.
    if (trimmed === '') {
      const updated = await wrap(`rate-${memberId}`, () =>
        api.updateMemberSettings(memberId, { share: null }),
      );
      if (updated) syncGroupLocal(updated);
      return;
    }
    // Accept either '.' or ',' as the decimal separator — the input is now
    // a text field (inputMode="decimal") so both may arrive.
    const n = Number(trimmed.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) {
      setError('Share must be a positive number');
      return;
    }
    const updated = await wrap(`rate-${memberId}`, () =>
      api.updateMemberSettings(memberId, { share: n }),
    );
    if (updated) syncGroupLocal(updated);
  };

  const syncGroupLocal = (_updated: Group) => {
    // The server returns the updated group; refreshing reloads from source
    // of truth so members/admins/expenses all stay consistent.
    void refreshData();
    void refreshGroups();
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">{group.name}</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {group.members.length} member{group.members.length === 1 ? '' : 's'}
            {isAdmin && <span className="ml-2 text-cyan-400">• you're an admin</span>}
          </p>
        </div>
        <button
          onClick={() => navigate('/')}
          className="text-sm text-gray-400 hover:text-gray-200"
        >
          Done
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* --- Members --- */}
      <section className="bg-gray-800 border border-gray-700 rounded-xl divide-y divide-gray-700">
        <div className="px-4 py-3">
          <h2 className="font-medium text-gray-100">Members</h2>
          {isAdmin && (
            <p className="text-xs text-gray-500 mt-0.5">
              Share weights the "Split" method. Blank = 1 (equal).
            </p>
          )}
        </div>
        {group.members.map((m) => {
          const memberIsAdmin = group.admins.includes(m.id);
          const lastAdmin = memberIsAdmin && group.admins.length <= 1;
          const isMe = m.id === currentMember.id;
          return (
            <div key={m.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
              {/* Share input leftmost → fixed-width first column so the share
                  columns line up vertically across all rows. `×` sits between
                  the input and the name as the "times" sign (rate × member). */}
              {isAdmin && (
                <>
                  <MemberRateInput
                    member={m}
                    busy={busy === `rate-${m.id}`}
                    onCommit={(val) => handleRateChange(m.id, val)}
                  />
                  <span className="text-xs text-gray-500">×</span>
                </>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-gray-100 truncate">
                  {m.name}
                  {isMe && <span className="ml-2 text-xs text-gray-500">(you)</span>}
                </p>
                <p className="text-xs text-gray-500">
                  {memberIsAdmin ? 'Admin' : 'Member'}
                  {!m.userId && <span className="ml-2 text-gray-600">• not signed up</span>}
                </p>
              </div>
              {isAdmin && !isMe && (
                <button
                  onClick={() => handleToggleAdmin(m.id, !memberIsAdmin)}
                  disabled={busy === `admin-${m.id}`}
                  className="text-xs px-2 py-1 border border-gray-600 rounded hover:bg-gray-700 disabled:opacity-50"
                  title={memberIsAdmin ? 'Demote to member' : 'Promote to admin'}
                >
                  {memberIsAdmin ? 'Demote' : 'Make admin'}
                </button>
              )}
              {isAdmin && !isMe && (
                <button
                  onClick={() => handleRemoveMember(m.id)}
                  disabled={busy === `remove-${m.id}` || lastAdmin}
                  className="text-xs px-2 py-1 border border-red-800 text-red-300 rounded hover:bg-red-900/30 disabled:opacity-50"
                  title={lastAdmin ? 'Cannot remove the only admin' : 'Remove from group'}
                >
                  Remove
                </button>
              )}
            </div>
          );
        })}
      </section>

      {/* --- Add friends (admin-only quick-add from shared groups) --- */}
      {isAdmin && (
        <section className="bg-gray-800 border border-gray-700 rounded-xl">
          <div className="px-4 py-3 border-b border-gray-700">
            <h2 className="font-medium text-gray-100">Add friends</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Users from your other groups who aren't in this one yet. Added instantly — no invite link needed.
            </p>
          </div>
          {friendsError ? (
            <p className="px-4 py-6 text-sm text-red-300">{friendsError}</p>
          ) : friends === null ? (
            <p className="px-4 py-6 text-sm text-gray-400">Loading…</p>
          ) : friends.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-400">
              No friends to add. Share a group with someone first, or use an invite link above.
            </p>
          ) : (
            <ul className="divide-y divide-gray-700">
              {friends.map((f) => (
                <li key={f.userId} className="px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-100 truncate">{f.name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      Also in: {f.groupNames.join(', ')}
                    </p>
                  </div>
                  <button
                    onClick={() => handleAddFriend(f)}
                    disabled={busy === `add-friend-${f.userId}`}
                    className="text-xs px-3 py-1.5 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white rounded"
                  >
                    {busy === `add-friend-${f.userId}` ? 'Adding…' : 'Add'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* --- Removed members (history) --- */}
      {group.removedMembers.length > 0 && (
        <section className="bg-gray-800 border border-gray-700 rounded-xl divide-y divide-gray-700">
          <div className="px-4 py-3">
            <h2 className="font-medium text-gray-100">Removed</h2>
            <p className="text-xs text-gray-500 mt-0.5">Kept for history — referenced by past expenses.</p>
          </div>
          {group.removedMembers.map((m) => (
            <div key={m.id} className="px-4 py-3 flex items-center gap-3">
              <p className="flex-1 text-gray-400 truncate">{m.name}</p>
              {m.removedAt && (
                <p className="text-xs text-gray-500">{new Date(m.removedAt).toLocaleDateString()}</p>
              )}
            </div>
          ))}
        </section>
      )}

      {/* --- Invites --- */}
      <section className="bg-gray-800 border border-gray-700 rounded-xl">
        <div className="px-4 py-3 flex items-center justify-between gap-3 border-b border-gray-700">
          <div>
            <h2 className="font-medium text-gray-100">Invite links</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Permanent — anyone with a link can join. {isAdmin ? 'Revoke anytime.' : 'Only admins can create or revoke.'}
            </p>
          </div>
          {isAdmin && (
            <button
              onClick={handleCreateInvite}
              disabled={busy === 'create-invite'}
              className="text-sm px-3 py-1.5 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white rounded"
            >
              + New link
            </button>
          )}
        </div>

        {invitesLoading ? (
          <p className="px-4 py-6 text-sm text-gray-400">Loading…</p>
        ) : invitesError ? (
          <p className="px-4 py-6 text-sm text-red-300">{invitesError}</p>
        ) : !invites || invites.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-400">No invite links yet.</p>
        ) : (
          <ul className="divide-y divide-gray-700">
            {invites.map((inv) => {
              const url = `${window.location.origin}/invite/${inv.code}`;
              return (
                <li key={inv.code} className="px-4 py-3 flex items-center gap-2">
                  <p className="flex-1 text-xs text-gray-300 font-mono truncate" title={url}>{url}</p>
                  <button
                    onClick={() => handleShareInviteLink(inv.code)}
                    className="text-xs px-2 py-1 border border-gray-600 rounded hover:bg-gray-700"
                  >
                    Share
                  </button>
                  <button
                    onClick={() => handleCopyInviteLink(inv.code)}
                    className="text-xs px-2 py-1 border border-gray-600 rounded hover:bg-gray-700"
                  >
                    Copy
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => handleDeleteInvite(inv.code)}
                      disabled={busy === `delete-invite-${inv.code}`}
                      className="text-xs px-2 py-1 border border-red-800 text-red-300 rounded hover:bg-red-900/30 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* --- Danger zone --- */}
      <section className="bg-gray-800 border border-red-900/40 rounded-xl px-4 py-4 space-y-4">
        <h2 className="font-medium text-red-400">Danger zone</h2>

        <div>
          <p className="text-sm text-gray-300 font-medium mb-0.5">Leave group</p>
          <p className="text-xs text-gray-500 mb-2">
            Your expense history stays visible to remaining members. {group.admins.length <= 1 && group.admins.includes(currentMember.id) && (
              <span className="text-yellow-400">You're the only admin — promote someone else before leaving.</span>
            )}
          </p>
          <button
            onClick={handleLeave}
            disabled={busy === `remove-${currentMember.id}` || (group.admins.length <= 1 && group.admins.includes(currentMember.id))}
            className="text-sm px-3 py-1.5 border border-red-800 text-red-300 rounded hover:bg-red-900/30 disabled:opacity-50"
          >
            Leave {group.name}
          </button>
        </div>

        {isAdmin && (
          <div className="border-t border-gray-700 pt-4">
            <p className="text-sm text-gray-300 font-medium mb-0.5">Delete group</p>
            <p className="text-xs text-gray-500 mb-2">
              Permanently deletes all expenses, invites, and member data. Cannot be undone.
            </p>
            <button
              onClick={handleDeleteGroup}
              disabled={busy === 'delete-group'}
              className="text-sm px-3 py-1.5 bg-red-900/40 border border-red-700 text-red-300 rounded hover:bg-red-900/70 disabled:opacity-50"
            >
              {busy === 'delete-group' ? 'Deleting…' : `Delete ${group.name}`}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// Local-only state so the input shows the in-progress edit without flashing
// back to the server value on each keystroke. Committed on blur / Enter.
function MemberRateInput({
  member,
  busy,
  onCommit,
}: {
  member: Member;
  busy: boolean;
  onCommit: (value: string) => void;
}) {
  const serverValue = member.share ?? '';
  const [local, setLocal] = useState(String(serverValue));

  // Sync if the server value changes for reasons other than our own edit.
  useEffect(() => {
    setLocal(String(serverValue));
  }, [serverValue]);

  const commit = () => {
    if (local === String(serverValue)) return;
    onCommit(local);
  };

  return (
    <label className="flex items-center text-xs text-gray-400" title="Share">
      <input
        type="text" inputMode="decimal"
        value={local}
        onChange={(e) => setLocal(sanitizeDecimalInput(e.target.value))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        disabled={busy}
        placeholder="1"
        className="w-14 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-gray-100 text-center disabled:opacity-50"
      />
    </label>
  );
}
