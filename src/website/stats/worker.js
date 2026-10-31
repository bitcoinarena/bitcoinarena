// kanban #911: passes every request to the tunnel in front of Umami. ORIGIN is a secret, set by ops/umami-tunnel.sh whenever the tunnel's name changes.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');
    const to = new URL(url.pathname + url.search, env.ORIGIN);
    return fetch(to, { method: request.method, headers, body: request.body, redirect: 'manual' });
  },
};
