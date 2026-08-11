import type { AuthEnv } from '../types/auth';
import { createSession, createAuthCookie } from '../utils/jwt';
import { requireSession, requireGroup } from '../utils/session';
import { getGroup, saveGroup } from '../utils/groups';
import { getUser, saveUser, getMemberships } from '../utils/users';
import type { AuthEnv as Env } from '../types/auth';

// Propagate identity fields (name, avatar) to the user's member row in every
// group — bank details stay per-group by design. A group where the new name
// collides with another member keeps its old name there (avatar still updates).
async function propagateIdentity(
  env: Env,
  userId: string,
  fields: { name: string; avatarSeed?: string },
  excludeGroupId?: string,
): Promise<void> {
  const memberships = await getMemberships(env, userId);
  for (const m of memberships) {
    if (m.groupId === excludeGroupId) continue;
    const g = await getGroup(env, m.groupId);
    if (!g) continue;
    const row = g.members.find((mem) => mem.id === m.memberId);
    if (!row || row.removedAt) continue;
    const nameTaken = g.members.some(
      (mem) => mem.id !== row.id && mem.name.toLowerCase() === fields.name.toLowerCase(),
    );
    const updated = {
      ...row,
      ...(!nameTaken && { name: fields.name }),
      ...(fields.avatarSeed !== undefined && { avatarSeed: fields.avatarSeed }),
    };
    if (updated.name === row.name && updated.avatarSeed === row.avatarSeed) continue;
    await saveGroup(env, {
      ...g,
      members: g.members.map((mem) => (mem.id === row.id ? updated : mem)),
    });
  }
}

// PUT /api/auth/profile — update the caller's profile.
// When X-Group-Id is present and the caller is a member, also updates the
// per-group member row (name, avatar, bank). When the caller has no active
// group (X-Group-Id absent), updates the global User record only.
export const onRequestPut: PagesFunction<AuthEnv> = async (context) => {
  try {
    const {
      name,
      avatarSeed,
      bankId,
      bankName,
      bankShortName,
      accountName,
      accountNo,
    } = await context.request.json() as {
      name?: string;
      avatarSeed?: string;
      bankId?: string;
      bankName?: string;
      bankShortName?: string;
      accountName?: string;
      accountNo?: string;
    };

    if (!name || !name.trim()) {
      return Response.json(
        { success: false, error: 'Name is required' },
        { status: 400 }
      );
    }
    const trimmedName = name.trim();

    if (accountNo !== undefined && accountNo !== null && accountNo !== '') {
      if (!/^[0-9]{6,20}$/.test(accountNo)) {
        return Response.json(
          { success: false, error: 'Account number must be 6-20 digits' },
          { status: 400 }
        );
      }
    }
    if (accountName !== undefined && accountName !== null && accountName !== '') {
      if (!/^[A-Z\s]+$/.test(accountName)) {
        return Response.json(
          { success: false, error: 'Account name must contain only uppercase letters and spaces' },
          { status: 400 }
        );
      }
    }

    // Try group context first (updates both group member row and User).
    const groupCtx = await requireGroup(context.env, context.request);
    if (!(groupCtx instanceof Response)) {
      const { session, group, member } = groupCtx;

      const nameExists = group.members.some(
        (m) => m.id !== member.id && m.name.toLowerCase() === trimmedName.toLowerCase()
      );
      if (nameExists) {
        return Response.json(
          { success: false, error: 'Name already taken' },
          { status: 400 }
        );
      }

      const updatedMember = {
        ...member,
        name: trimmedName,
        ...(avatarSeed !== undefined && { avatarSeed }),
        ...(bankId !== undefined && { bankId }),
        ...(bankName !== undefined && { bankName }),
        ...(bankShortName !== undefined && { bankShortName }),
        ...(accountName !== undefined && { accountName }),
        ...(accountNo !== undefined && { accountNo }),
      };
      const updatedGroup = {
        ...group,
        members: group.members.map((m) => (m.id === member.id ? updatedMember : m)),
      };
      await saveGroup(context.env, updatedGroup);

      const user = await getUser(context.env, session.userId);
      if (
        user &&
        (user.name !== trimmedName || (avatarSeed !== undefined && user.avatarSeed !== avatarSeed))
      ) {
        await saveUser(context.env, {
          ...user,
          name: trimmedName,
          ...(avatarSeed !== undefined && { avatarSeed }),
        });
      }

      // Name and avatar follow the user everywhere; bank stays per-group.
      await propagateIdentity(context.env, session.userId, { name: trimmedName, avatarSeed }, group.id);

      const { token: newToken } = await createSession(context.env, session.userId, trimmedName);

      return new Response(
        JSON.stringify({ success: true, data: updatedMember }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': createAuthCookie(newToken),
          },
        }
      );
    }

    // No group context — update User record only (user not yet in any group).
    const authed = await requireSession(context.env, context.request);
    if (authed instanceof Response) return authed;
    const { session } = authed;

    const user = await getUser(context.env, session.userId);
    if (!user) {
      return Response.json({ success: false, error: 'User not found' }, { status: 404 });
    }

    await saveUser(context.env, {
      ...user,
      name: trimmedName,
      ...(avatarSeed !== undefined && { avatarSeed }),
    });

    await propagateIdentity(context.env, session.userId, { name: trimmedName, avatarSeed });

    const { token: newToken } = await createSession(context.env, session.userId, trimmedName);

    // Return a synthetic member shape so the client type stays consistent.
    const syntheticMember = {
      id: session.userId,
      userId: session.userId,
      name: trimmedName,
      ...(avatarSeed !== undefined && { avatarSeed }),
    };

    return new Response(
      JSON.stringify({ success: true, data: syntheticMember }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': createAuthCookie(newToken),
        },
      }
    );
  } catch (error) {
    console.error('Profile update error:', error);
    return Response.json(
      { success: false, error: 'Failed to update profile' },
      { status: 500 }
    );
  }
};
