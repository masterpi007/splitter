import type { AuthEnv } from '../types/auth';
import { requireGroup } from '../utils/session';
import { getPushSubscriptions, savePushSubscriptions, deletePushSubscription } from '../utils/db';

// Push subscriptions are keyed per (userId, groupId) so a device only
// receives notifications for the groups it has actively subscribed to.
// The client calls this once per group while viewing it.

export const onRequestPost: PagesFunction<AuthEnv> = async (context) => {
  const ctx = await requireGroup(context.env, context.request);
  if (ctx instanceof Response) return ctx;

  const { subscription } = (await context.request.json()) as {
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  };

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return Response.json({ success: false, error: 'Invalid subscription' }, { status: 400 });
  }

  const existing = await getPushSubscriptions(context.env, ctx.session.userId, ctx.group.id);
  const filtered = existing.filter((s) => s.endpoint !== subscription.endpoint);
  filtered.push({
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    createdAt: new Date().toISOString(),
    userAgent: context.request.headers.get('User-Agent') || undefined,
  });

  await savePushSubscriptions(context.env, ctx.session.userId, ctx.group.id, filtered);

  return Response.json({ success: true });
};

export const onRequestDelete: PagesFunction<AuthEnv> = async (context) => {
  const ctx = await requireGroup(context.env, context.request);
  if (ctx instanceof Response) return ctx;

  const { endpoint } = (await context.request.json()) as { endpoint: string };
  if (!endpoint) {
    return Response.json({ success: false, error: 'endpoint is required' }, { status: 400 });
  }

  await deletePushSubscription(context.env, ctx.session.userId, endpoint);

  return Response.json({ success: true });
};
