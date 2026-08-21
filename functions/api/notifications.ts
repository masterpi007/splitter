import type { AuthEnv } from './types/auth';
import { requireSession, extractGroupId, badRequest } from './utils/session';
import { getNotifications } from './utils/db';

// GET /api/notifications — notifications for (current user, active group).
//
// This is the app's highest-frequency endpoint (every open tab polls it), so
// it deliberately skips the full group load: notifications are keyed by
// (user_id, group_id) and the user can only ever read their own rows, making
// the session check sufficient authorization.
export const onRequestGet: PagesFunction<AuthEnv> = async (context) => {
  const authed = await requireSession(context.env, context.request);
  if (authed instanceof Response) return authed;
  const groupId = extractGroupId(context.request);
  if (!groupId) return badRequest('Missing X-Group-Id');
  const notifications = await getNotifications(context.env, authed.session.userId, groupId);
  return Response.json({ success: true, data: notifications });
};

// PUT /api/notifications — mark all read for (current user, active group).
export const onRequestPut: PagesFunction<AuthEnv> = async (context) => {
  const authed = await requireSession(context.env, context.request);
  if (authed instanceof Response) return authed;
  const groupId = extractGroupId(context.request);
  if (!groupId) return badRequest('Missing X-Group-Id');
  await context.env.DB.prepare(
    `UPDATE notifications SET read = 1 WHERE user_id = ? AND group_id = ?`,
  )
    .bind(authed.session.userId, groupId)
    .run();
  const updated = await getNotifications(context.env, authed.session.userId, groupId);
  return Response.json({ success: true, data: updated });
};
