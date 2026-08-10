// All /api responses are per-user, live data — forbid HTTP caching so a
// normal page reload never serves a stale group/profile from browser cache.
export const onRequest: PagesFunction = async (context) => {
  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
