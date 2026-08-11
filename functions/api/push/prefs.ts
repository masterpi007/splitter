import type { AuthEnv, NotifyPrefs } from '../types/auth';
import { requireGroup } from '../utils/session';
import { getPushPrefs, savePushPrefs } from '../utils/db';

// Prefs are per (userId, groupId) — users can mute one group without affecting others.
export const onRequestGet: PagesFunction<AuthEnv> = async (context) => {
  const ctx = await requireGroup(context.env, context.request);
  if (ctx instanceof Response) return ctx;
  const prefs = await getPushPrefs(context.env, ctx.session.userId, ctx.group.id);
  return Response.json({ success: true, data: prefs });
};

export const onRequestPatch: PagesFunction<AuthEnv> = async (context) => {
  const ctx = await requireGroup(context.env, context.request);
  if (ctx instanceof Response) return ctx;

  const updates = await context.request.json() as Partial<NotifyPrefs>;
  const existing = await getPushPrefs(context.env, ctx.session.userId, ctx.group.id);
  const updated: NotifyPrefs = { ...existing, ...updates };
  await savePushPrefs(context.env, ctx.session.userId, ctx.group.id, updated);

  return Response.json({ success: true, data: updated });
};
