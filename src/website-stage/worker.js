// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BOUNTY STAGE (kanban #1342, the owner 2026-11-07: "Deploye es auf testnet-stage.bitcoinarena.io wo die feedback Funktion ueberall eingebaut ist"):
// testnet-stage.bitcoinarena.io serves the Pages branch `stage` - the one page build with the bounty on (ARENA_BOUNTY_BUILD) - as it is,
// kept out of search indexes. The faucet answers rewards only toward this origin (FAUCET_BOUNTY_ORIGINS).
// SEASON 2 (kanban #2623): the stage's own faucet doors - a reporter's link code and membership check (NIP-98 signed for this origin), the season's
// pot, the open-issues list and the paid log - passed on to the faucet (FAUCET_ORIGIN, a secret of this Worker). Nothing else of the faucet is reachable here.
const STAGE = 'https://stage.bitcoin-arena-site.pages.dev';
const FAUCET_DOORS = new Map([['/api/faucet/feedback/link', 'POST'], ['/api/faucet/feedback/verify', 'POST'], ['/api/faucet/feedback/season', 'GET'],
  ['/api/faucet/feedback/open-issues', 'GET'], ['/api/faucet/feedback/paid-log', 'GET']]);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // A DUPLICATE'S SECRET TICKET LINK (kanban #2745): GET, a page of its own (HTML), never indexed or cached
    if (/^\/api\/faucet\/feedback\/dup\/[0-9a-f]{32}$/.test(url.pathname)) {
      if (!env.FAUCET_ORIGIN || request.method !== 'GET') return new Response('Not found', { status: 404 });
      const r = await fetch(`${env.FAUCET_ORIGIN}${url.pathname.slice('/api/faucet'.length)}`, { headers: { origin: url.origin } });
      return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' } });
    }
    const door = FAUCET_DOORS.get(url.pathname);
    if (door) {
      if (!env.FAUCET_ORIGIN) return new Response('{"ok":false,"why":"the faucet is off"}', { status: 503, headers: { 'content-type': 'application/json' } });
      if (request.method !== door) return new Response(JSON.stringify({ ok: false, why: door }), { status: 405, headers: { 'content-type': 'application/json' } });
      const headers = new Headers({ 'content-type': 'application/json', origin: url.origin });
      if (request.headers.get('authorization')) headers.set('authorization', request.headers.get('authorization'));
      // kanban #2995: the caller's address, believed by the faucet only with this Worker's key (FAUCET_WORKER_KEY, as the site Worker's)
      headers.set('x-arena-ip', request.headers.get('cf-connecting-ip') || '');
      if (env.FAUCET_WORKER_KEY) headers.set('x-arena-worker', env.FAUCET_WORKER_KEY);
      const r = await fetch(`${env.FAUCET_ORIGIN}${url.pathname.slice('/api/faucet'.length)}`, { method: door, headers, body: door === 'POST' ? await request.text() : undefined });
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });
    }
    // THE ORANGE PILL RUN'S ROUND SERVICE ON THE STAGE (kanban #3245, #3265): /api/opr/* passed on to arena-opr on the test host, whose address is a secret of
    // this Worker (OPR_ORIGIN, the Funnel path as FAUCET_ORIGIN's; unset: off), with the caller's address under this Worker's key (OPR_WORKER_KEY), the
    // player's NIP-98 sign-in (signed for https://testnet-stage.bitcoinarena.io/api/opr<path>) and, on the admin paths only, the admin code. GET and POST only, nothing cached
    if (url.pathname.startsWith('/api/opr/')) {
      if (!env.OPR_ORIGIN) return new Response('{"ok":false,"why":"the round service is off"}', { status: 503, headers: { 'content-type': 'application/json' } });
      if (request.method !== 'GET' && request.method !== 'POST') return new Response('{"ok":false,"why":"GET or POST"}', { status: 405, headers: { 'content-type': 'application/json' } });
      const path = url.pathname.slice('/api/opr'.length);
      if (!/^\/[a-z0-9/_-]{1,80}$/.test(path)) return new Response('{"ok":false,"why":"no such route"}', { status: 404, headers: { 'content-type': 'application/json' } });
      const headers = new Headers({ 'content-type': 'application/json', 'x-arena-ip': request.headers.get('cf-connecting-ip') || '' });
      if (env.OPR_WORKER_KEY) headers.set('x-arena-worker', env.OPR_WORKER_KEY);
      if (request.headers.get('authorization')) headers.set('authorization', request.headers.get('authorization'));
      if (path.startsWith('/admin/') && request.headers.get('x-arena-admin')) headers.set('x-arena-admin', request.headers.get('x-arena-admin'));
      const r = await fetch(`${env.OPR_ORIGIN}${path}${url.search}`, { method: request.method, headers, body: request.method === 'POST' ? await request.text() : undefined });
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });
    }
    // THE GAME'S SHORT ADDRESS (kanban #3265): /orange-pill-run opens the page on the game, which makes or opens the wallet
    if (url.pathname === '/orange-pill-run' || url.pathname === '/orange-pill-run/') return Response.redirect(`${url.origin}/?game=orange-pill-run`, 302);
    const r = await fetch(new Request(`${STAGE}${url.pathname}${url.search}`, request), { redirect: 'manual' });
    const out = new Response(r.body, r);
    out.headers.set('x-robots-tag', 'noindex, nofollow');
    const loc = out.headers.get('location');
    if (loc && loc.startsWith(STAGE)) out.headers.set('location', loc.replace(STAGE, url.origin));
    return out;
  },
};
