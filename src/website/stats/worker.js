// kanban #911: passes every request to the tunnel in front of Umami. ORIGIN is a secret, set by ops/umami-tunnel.sh whenever the tunnel's name changes.
// THE OLD DOMAIN (kanban #937): every (sub)domain of it sends to the same place on the new one, path and query kept
const OLD_DOMAIN = /(^|\.)bitcoin-arena\.io$/;
const moved = (url) => { if (!OLD_DOMAIN.test(url.hostname)) return null; const to = new URL(url); to.hostname = url.hostname.replace(/bitcoin-arena\.io$/, 'bitcoinarena.io'); return Response.redirect(to.toString(), 308); };
// THE PLAYED COUNTS ARE THE EXPLORER'S ALONE (kanban #2754, #1489 r7-faucet-5): 'played-round' and 'played-entry' events are sent only by the
// explorer Worker's sendPlayed (kanban #1110: Umami's played rounds are the explorer's, admin and bot rounds left out). This door passed every
// request on, so anyone posted the same events with any game and any timestamp - 25 of 25 made-up ones counted. Now an /api/send event whose
// name starts with 'played-' goes on only with the header PLAYED_HEADER carrying the secret PLAYED_TOKEN both Workers hold; any other is
// answered 204 and dropped. The header never reaches Umami. Every other event and request passes as before.
export const PLAYED_HEADER = 'x-arena-played';
const PLAYED_EVENT = /^played-/;
const sameText = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
  { const went = moved(url); if (went) return went; }
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', 'https');
    const token = headers.get(PLAYED_HEADER);
    headers.delete(PLAYED_HEADER);
    let body = request.body;
    if (request.method === 'POST' && /\/api\/send\/?$/.test(url.pathname)) {
      const text = await request.text();
      let name = null; try { const j = JSON.parse(text); name = j && j.payload && typeof j.payload.name === 'string' ? j.payload.name : null; } catch { name = null; }
      if (name !== null && PLAYED_EVENT.test(name) && !sameText(token, env.PLAYED_TOKEN)) return new Response(null, { status: 204 });
      body = text;
    }
    const to = new URL(url.pathname + url.search, env.ORIGIN);
    return fetch(to, { method: request.method, headers, body, redirect: 'manual' });
  },
};
