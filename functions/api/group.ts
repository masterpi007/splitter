import type { AuthEnv } from './types/auth';
import { requireGroup, requireSession, extractGroupId } from './utils/session';
import {
  saveGroup,
  getGroup,
  GroupRecord,
  GroupMember,
  LEGACY_GROUP_ID,
} from './utils/groups';

// GET /api/group — return the active group (scoped by X-Group-Id header).
// The legacy group is readable without a session so the self-registration
// bootstrap (MemberSelector → addMember → /api/auth/register/verify) can
// load the existing member list before the user has a passkey. Every other
// group still requires membership.
function createEmptyLegacyGroup(): GroupRecord {
  return {
    id: LEGACY_GROUP_ID,
    name: 'Expenses',
    currency: 'K',
    admins: [],
    members: [],
    removedMembers: [],
    createdAt: new Date().toISOString(),
  };
}

export const onRequestGet: PagesFunction<AuthEnv> = async (context) => {
  try {
    const groupId = extractGroupId(context.request);
    if (groupId === LEGACY_GROUP_ID) {
      const group = await getGroup(context.env, groupId);
      if (!group) {
        const emptyGroup = createEmptyLegacyGroup();
        await saveGroup(context.env, emptyGroup);
        return Response.json({ success: true, data: emptyGroup });
      }
      return Response.json({ success: true, data: group });
    }
    const ctx = await requireGroup(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    return Response.json({ success: true, data: ctx.group });
  } catch (error) {
    return Response.json(
      { success: false, error: 'Failed to fetch group' },
      { status: 500 }
    );
  }
};

function findDuplicateName(members: GroupRecord['members']): string | null {
  const seen = new Set<string>();
  for (const m of members) {
    const lowerName = m.name.toLowerCase();
    if (seen.has(lowerName)) return m.name;
    seen.add(lowerName);
  }
  return null;
}

// Rebuild the member list from trusted state for callers who may only add
// new placeholder rows (non-admins, or unauth legacy self-registration).
// Incoming rows matching an existing id are ignored; new rows must carry a
// non-empty name and have all other fields stripped (server mints the id).
// Accepting client-supplied userId here would let a caller forge a member
// row claiming to belong to another user — which then bootstraps a shared-
// group "friend" relationship they could exploit via /api/groups/members.
// Returns the new members list, or a Response on validation failure.
function applyPlaceholderAdd(
  group: GroupRecord,
  incomingMembers: GroupMember[],
): GroupMember[] | Response {
  const existingById = new Map(group.members.map((m) => [m.id, m]));
  const newPlaceholders: GroupMember[] = [];
  for (const incoming of incomingMembers) {
    if (existingById.has(incoming.id)) continue; // existing rows are not mutable
    const name = typeof incoming.name === 'string' ? incoming.name.trim() : '';
    if (!name) {
      return Response.json(
        { success: false, error: 'Member name is required' },
        { status: 400 }
      );
    }
    newPlaceholders.push({ id: crypto.randomUUID(), name });
  }
  const newIds = new Set(incomingMembers.map((m) => m.id));
  const removedBySave = group.members.some((m) => !newIds.has(m.id));
  if (removedBySave) {
    return Response.json(
      { success: false, error: 'Only admins can remove members' },
      { status: 403 }
    );
  }
  return [...group.members, ...newPlaceholders];
}

// PUT /api/group — update the active group. Settings (name, currency) require
// admin. Adding placeholder members is permitted for any group member (the
// pre-create flow — adding a friend who will sign up later). Unauthenticated
// callers may also append a placeholder to the LEGACY group — this is the
// bootstrap for the self-registration flow: the new user types a name in
// MemberSelector before they have a session, then /api/auth/register/verify
// claims the just-created row.
export const onRequestPut: PagesFunction<AuthEnv> = async (context) => {
  try {
    const updates = await context.request.json() as Partial<{
      name: string;
      currency: string;
      members: GroupRecord['members'];
    }>;
    const settingsTouched = updates.name !== undefined || updates.currency !== undefined;

    const authed = await requireSession(context.env, context.request);

    // Unauthenticated bootstrap path: only the legacy group, only
    // placeholder-add (no settings, no renames/removes).
    if (authed instanceof Response) {
      const groupId = extractGroupId(context.request);
      if (groupId !== LEGACY_GROUP_ID) return authed;
      if (settingsTouched) return authed;
      if (!updates.members) return authed;

      const group = (await getGroup(context.env, groupId)) ?? createEmptyLegacyGroup();
      const members = applyPlaceholderAdd(group, updates.members);
      if (members instanceof Response) return members;
      const duplicateName = findDuplicateName(members);
      if (duplicateName) {
        return Response.json(
          { success: false, error: `Name "${duplicateName}" already exists` },
          { status: 400 }
        );
      }
      const updated: GroupRecord = { ...group, members };
      await saveGroup(context.env, updated);
      return Response.json({ success: true, data: updated });
    }

    const ctx = await requireGroup(context.env, context.request);
    if (ctx instanceof Response) return ctx;
    const { group, member } = ctx;

    const isAdminCaller = group.admins.includes(member.id);
    if (settingsTouched && !isAdminCaller) {
      return Response.json(
        { success: false, error: 'Only admins can change group settings' },
        { status: 403 }
      );
    }

    let members = group.members;
    if (updates.members) {
      if (isAdminCaller) {
        members = updates.members;
      } else {
        const result = applyPlaceholderAdd(group, updates.members);
        if (result instanceof Response) return result;
        members = result;
      }

      const duplicateName = findDuplicateName(members);
      if (duplicateName) {
        return Response.json(
          { success: false, error: `Name "${duplicateName}" already exists` },
          { status: 400 }
        );
      }
    }

    const updated: GroupRecord = {
      ...group,
      name: updates.name ?? group.name,
      currency: updates.currency ?? group.currency,
      members,
    };
    await saveGroup(context.env, updated);

    return Response.json({ success: true, data: updated });
  } catch (error) {
    return Response.json(
      { success: false, error: 'Failed to update group' },
      { status: 500 }
    );
  }
};
