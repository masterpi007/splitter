import type { AuthEnv } from './types/auth';
import { requireGroup } from './utils/session';
import { getNotifications, saveNotifications } from './utils/db';

// GET /api/notifications — notifications for (current user, active group).
export const onRequestGet: PagesFunction<AuthEnv> = async (context) => {
  const ctx = await requireGroup(context.env, context.request);
  if (ctx instanceof Response) return ctx;
  const notifications = await getNotifications(context.env, ctx.session.userId, ctx.group.id);
  return Response.json({ success: true, data: notifications });
};

// PUT /api/notifications — mark all read for (current user, active group).
export const onRequestPut: PagesFunction<AuthEnv> = async (context) => {
  const ctx = await requireGroup(context.env, context.request);
  if (ctx instanceof Response) return ctx;
  await context.env.DB.prepare(
    `UPDATE notifications SET read = 1 WHERE user_id = ? AND group_id = ?`,
  )
    .bind(ctx.session.userId, ctx.group.id)
    .run();
  const updated = await getNotifications(context.env, ctx.session.userId, ctx.group.id);
  return Response.json({ success: true, data: updated });
};
