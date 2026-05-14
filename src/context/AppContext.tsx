import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  ReactNode,
} from 'react';
import { Group, GroupSummary, Expense, Member } from '../types';
import * as api from '../api/client';
import { getActiveGroupId, setActiveGroupId, ApiError } from '../api/client';
import { resolveExpenseSplits } from '../utils/balances';

interface AppContextType {
  activeGroupId: string | null;
  groups: GroupSummary[];
  group: Group | null;
  expenses: Expense[];
  // Non-"deleted" tags across all expenses, sorted by descending frequency.
  // Computed once at the provider so every ExpenseCard can filter its own
  // tags off a shared list instead of walking every expense per render.
  tagsByFrequency: string[];
  currentUser: Member | null;
  loading: boolean;
  error: string | null;
  setActiveGroup: (groupId: string) => void;
  setCurrentUser: (user: Member | null) => void;
  refreshData: () => Promise<void>;
  refreshGroups: () => Promise<void>;
  addMember: (name: string) => Promise<Member | null>;
  removeMember: (id: string) => Promise<void>;
  updateGroupSettings: (name: string, currency: string) => Promise<void>;
  updateProfile: (updates: Partial<Member>) => Promise<void>;
  createExpense: (expense: Omit<Expense, 'id' | 'createdAt'>) => Promise<void>;
  updateExpense: (id: string, updates: Partial<Expense>) => Promise<void>;
  deleteExpense: (expense: Expense) => Promise<void>;
  signOffExpense: (expense: Expense) => Promise<void>;
  claimExpenseItem: (expenseId: string, itemId: string, claim: boolean) => Promise<void>;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  // Active group is held in localStorage (via api/client helpers) so it survives
  // reloads. Null when user has no groups yet.
  const [activeGroupId, setActiveGroupIdState] = useState<string | null>(getActiveGroupId());
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [group, setGroup] = useState<Group | null>(null);
  const [rawExpenses, setExpenses] = useState<Expense[]>([]);
  // Group-mode expenses have dynamic splits — we hydrate them from the current
  // member list here so every downstream consumer (balances, charts, cards)
  // reads through expense.splits without caring whether it was persisted or
  // computed. When a member is added/removed or a share weight changes, this
  // memo re-runs and past group expenses automatically re-weight.
  const expenses = useMemo<Expense[]>(() => {
    if (!group) return rawExpenses;
    return rawExpenses.map((e) =>
      e.splitType === 'group'
        ? { ...e, splits: resolveExpenseSplits(e, group.members) }
        : e,
    );
  }, [rawExpenses, group]);
  const [currentUser, setCurrentUserState] = useState<Member | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setCurrentUser = useCallback((user: Member | null) => {
    setCurrentUserState(user);
  }, []);

  const setActiveGroup = useCallback((groupId: string) => {
    setActiveGroupId(groupId);
    setActiveGroupIdState(groupId);
  }, []);

  const refreshGroups = useCallback(async () => {
    try {
      const list = await api.listGroups();
      setGroups(list);
      // If the current active group isn't in the list, fall back to the first
      // membership the user has. Never leaves the user on a group they've been
      // removed from. If the user has no groups, clear the active selection.
      if (list.length > 0 && !list.some((g) => g.id === activeGroupId)) {
        setActiveGroup(list[0].id);
      } else if (list.length === 0 && activeGroupId) {
        setActiveGroupIdState(null);
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem('splitter.activeGroupId');
        }
      }
    } catch {
      // If listing fails (e.g. not authenticated yet) leave empty silently.
      setGroups([]);
    }
  }, [activeGroupId, setActiveGroup]);

  const tagsByFrequency = useMemo(() => {
    const freq = new Map<string, number>();
    for (const e of expenses) {
      if (!e.tags) continue;
      for (const t of e.tags) {
        if (t === 'deleted') continue;
        freq.set(t, (freq.get(t) ?? 0) + 1);
      }
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  }, [expenses]);

  // Tracks the last refresh we issued, so a response that lands after the
  // user has switched groups can be discarded instead of applied to state
  // for the new group. Without this guard, any in-flight refresh (SW event,
  // visibilitychange, retry) would silently splice stale data in.
  const refreshTargetRef = useRef<string | null>(getActiveGroupId());

  const refreshData = useCallback(async () => {
    const targetGroupId = getActiveGroupId();
    refreshTargetRef.current = targetGroupId;
    if (!targetGroupId) {
      setGroup(null);
      setExpenses([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    // Settle independently so a 401 on expenses (unauthenticated caller)
    // doesn't block the group from loading. The legacy group is readable
    // without a session for the self-registration bootstrap, but expenses
    // are still private — MemberSelector only needs the member list to
    // let the new user pick a name.
    const [groupRes, expensesRes] = await Promise.allSettled([
      api.getGroup(targetGroupId),
      api.getExpenses(targetGroupId),
    ]);
    if (refreshTargetRef.current !== targetGroupId) {
      setLoading(false);
      return;
    }

    let firstError: unknown = null;
    if (groupRes.status === 'fulfilled') {
      setGroup(groupRes.value);
    } else {
      firstError = groupRes.reason;
    }
    if (expensesRes.status === 'fulfilled') {
      setExpenses(expensesRes.value);
    } else if (!firstError) {
      firstError = expensesRes.reason;
    }

    if (!firstError) {
      setError(null);
    } else if (firstError instanceof ApiError && (firstError.status === 401 || firstError.status === 404)) {
      // Unauthenticated or missing active group: let auth/group picker flow recover.
      setError(null);
      if (firstError.status === 404) {
        setGroup(null);
        setExpenses([]);
      }
    } else {
      setError(firstError instanceof Error ? firstError.message : 'Failed to fetch data');
    }
    setLoading(false);
  }, []);

  const addMember = useCallback(
    async (name: string): Promise<Member | null> => {
      if (!group) return null;
      const trimmedName = name.trim();
      const newMember: Member = {
        id: crypto.randomUUID(),
        name: trimmedName,
      };
      const updated = await api.updateGroup({
        members: [...group.members, newMember],
      });
      setGroup(updated);
      // The server mints placeholder ids (see /api/group PUT), so we can't
      // match by the UUID we proposed — fall back to name-based lookup.
      const addedMember = updated.members.find(
        (m) => m.name.toLowerCase() === trimmedName.toLowerCase()
      );
      return addedMember || null;
    },
    [group]
  );

  const removeMember = useCallback(
    async (id: string) => {
      if (!group) return;
      // Uses the dedicated soft-remove endpoint so the member's history is
      // preserved in `removedMembers` (old expenses still resolve names).
      const updated = await api.removeMember(id);
      setGroup(updated);
    },
    [group]
  );

  const updateGroupSettings = useCallback(
    async (name: string, currency: string) => {
      const updated = await api.updateGroup({ name, currency });
      setGroup(updated);
    },
    []
  );

  const updateProfile = useCallback(
    async (updates: Partial<Member>) => {
      const updated = await api.updateProfile(updates);
      if (group) {
        const updatedMembers = group.members.map((m) =>
          m.id === updated.id ? updated : m
        );
        setGroup({ ...group, members: updatedMembers });
      }
      if (currentUser && currentUser.id === updated.id) {
        setCurrentUser(updated);
      }
    },
    [group, currentUser, setCurrentUser]
  );

  const createExpense = useCallback(
    async (expense: Omit<Expense, 'id' | 'createdAt'>) => {
      const created = await api.createExpense(expense);
      setExpenses((prev) => [...prev, created]);
    },
    []
  );

  const updateExpense = useCallback(
    async (id: string, updates: Partial<Expense>) => {
      const updated = await api.updateExpense(id, updates);
      setExpenses((prev) => prev.map((e) => (e.id === id ? updated : e)));
    },
    []
  );

  const deleteExpense = useCallback(async (expense: Expense) => {
    const updated = await api.softDeleteExpense(expense);
    setExpenses((prev) =>
      prev.map((e) => (e.id === expense.id ? updated : e))
    );
  }, []);

  const signOffExpense = useCallback(
    async (expense: Expense) => {
      if (!currentUser) return;
      const updated = await api.signOffExpense(expense, currentUser.id);
      setExpenses((prev) =>
        prev.map((e) => (e.id === expense.id ? updated : e))
      );
    },
    [currentUser]
  );

  const claimExpenseItem = useCallback(
    async (expenseId: string, itemId: string, claim: boolean) => {
      if (!currentUser) return;
      const expense = expenses.find((e) => e.id === expenseId);
      if (!expense) return;
      const updated = await api.claimExpenseItem(expense, itemId, currentUser.id, claim);
      setExpenses((prev) =>
        prev.map((e) => (e.id === expenseId ? updated : e))
      );
    },
    [currentUser, expenses]
  );

  // Initial load + reload on active group change.
  useEffect(() => {
    refreshData();
  }, [refreshData, activeGroupId]);

  // Refresh group list on mount and whenever active group changes
  // (e.g. user just created or joined a group).
  useEffect(() => {
    refreshGroups();
  }, [refreshGroups]);

  // Drop currentUser if the member list changes (e.g. member removed).
  useEffect(() => {
    if (currentUser && group) {
      const memberExists = group.members.some((m) => m.id === currentUser.id);
      if (!memberExists) {
        setCurrentUser(null);
      }
    }
  }, [group, currentUser, setCurrentUser]);

  // Refresh on SW REFRESH_DATA broadcast.
  useEffect(() => {
    if (!navigator.serviceWorker) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'REFRESH_DATA') {
        refreshData();
      }
    };
    navigator.serviceWorker.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, [refreshData]);

  // Refresh when tab becomes visible again.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [refreshData]);

  return (
    <AppContext.Provider
      value={{
        activeGroupId,
        groups,
        group,
        expenses,
        tagsByFrequency,
        currentUser,
        loading,
        error,
        setActiveGroup,
        setCurrentUser,
        refreshData,
        refreshGroups,
        addMember,
        removeMember,
        updateGroupSettings,
        updateProfile,
        createExpense,
        updateExpense,
        deleteExpense,
        signOffExpense,
        claimExpenseItem,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
