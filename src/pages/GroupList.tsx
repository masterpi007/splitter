import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { useAuthContext } from '../components/auth';

export function GroupList() {
  const navigate = useNavigate();
  const { activeGroupId, groups, setActiveGroup, groupsLoading } = useApp();
  const { authenticated } = useAuthContext();
  const [joinCode, setJoinCode] = useState('');

  if (!authenticated) {
    return (
      <div className="max-w-md mx-auto mt-8">
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 text-center">
          <h2 className="text-lg font-semibold text-gray-100 mb-2">Sign in required</h2>
          <p className="text-sm text-gray-400">
            Sign in first to see your groups. Use the button in the top-right corner.
          </p>
        </div>
      </div>
    );
  }

  const handleSelect = (groupId: string) => {
    if (groupId !== activeGroupId) {
      setActiveGroup(groupId);
    }
    navigate('/');
  };

  const handleJoin = () => {
    const code = joinCode.trim();
    if (!code) return;
    // Extract code from a pasted URL if needed.
    const match = code.match(/\/invite\/([a-zA-Z0-9]+)/);
    const actual = match ? match[1] : code;
    navigate(`/invite/${actual}`);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-100 mb-1">Your groups</h1>
        <p className="text-sm text-gray-400">
          Switch between groups or create a new one. Each group has its own members, expenses, and balances.
        </p>
      </div>

      {groupsLoading && groups.length === 0 ? (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 text-center">
          <p className="text-sm text-gray-400 animate-pulse">Loading your groups…</p>
        </div>
      ) : groups.length === 0 ? (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 text-center">
          <p className="text-sm text-gray-400">You're not in any groups yet.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => (
            <li
              key={g.id}
              className={`bg-gray-800 border rounded-xl flex items-stretch transition-colors ${
                g.id === activeGroupId ? 'border-cyan-500' : 'border-gray-700'
              }`}
            >
              <button
                onClick={() => handleSelect(g.id)}
                className="flex-1 text-left p-4 hover:bg-gray-700 rounded-l-xl min-w-0"
              >
                <p className="font-medium text-gray-100 truncate">{g.name}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {g.memberCount} member{g.memberCount === 1 ? '' : 's'}
                  {g.isAdmin && <span className="ml-2 text-cyan-400">• admin</span>}
                  {g.id === activeGroupId && <span className="ml-2 text-cyan-400">• active</span>}
                </p>
              </button>
              <button
                onClick={() => navigate(`/groups/${g.id}/manage`)}
                className="px-4 border-l border-gray-700 text-sm text-gray-300 hover:bg-gray-700 hover:text-gray-100 rounded-r-xl"
                aria-label={`Manage ${g.name}`}
              >
                Manage
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="pt-4 space-y-3 border-t border-gray-700">
        <button
          onClick={() => navigate('/groups/new')}
          className="w-full py-3 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg font-medium"
        >
          + Create new group
        </button>

        <div className="pt-3">
          <label className="block text-sm text-gray-400 mb-1">Join with an invite link</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              placeholder="Paste invite link or code"
              className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-100 text-sm"
            />
            <button
              onClick={handleJoin}
              disabled={!joinCode.trim()}
              className="px-4 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white rounded-lg text-sm"
            >
              Join
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
