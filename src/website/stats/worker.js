// kanban #911: passes every request to the tunnel in front of Umami. ORIGIN is a secret, set by ops/umami-tunnel.sh whenever the tunnel's name changes.
// THE OLD DOMAIN (kanban #937): every (sub)domain of it sends to the same place on the new one, path and query kept
const OLD_DOMAIN = /(^|\.)bitcoin-arena\.io$/;
const moved = (url) => { if (!OLD_DOMAIN.test(url.hostname)) return null; const to = new URL(url); to.hostname = url.hostname.replace(/bitcoin-arena\.io$/, 'bitcoinarena.io'); return Response.redirect(to.toString(), 308); };
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
  { const went = moved(url); if (went) return went; }
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');
    const to = new URL(url.pathname + url.search, env.ORIGIN);
    return fetch(to, { method: request.method, headers, body: request.body, redirect: 'manual' });
  },
};
