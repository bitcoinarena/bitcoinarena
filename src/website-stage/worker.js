// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BOUNTY STAGE (kanban #1342, Daniel 2026-11-07: "Deploye es auf testnet-stage.bitcoinarena.io wo die feedback Funktion ueberall eingebaut ist"):
// testnet-stage.bitcoinarena.io serves the Pages branch `stage` - the one page build with the bounty on (ARENA_BOUNTY_BUILD) - as it is,
// kept out of search indexes. The faucet answers rewards only toward this origin (FAUCET_BOUNTY_ORIGINS).
// SEASON 2 (kanban #2623): the stage's own faucet doors - a reporter's link code and membership check (NIP-98 signed for this origin), the season's
// pot, the open-issues list and the paid log - passed on to the faucet (FAUCET_ORIGIN, a secret of this Worker). Nothing else of the faucet is reachable here.
const STAGE = 'https://stage.bitcoin-arena-site.pages.dev';
// WEEK 2 (kanban #2641): the social screen's live check of typed names
const FAUCET_DOORS = new Map([['/api/faucet/feedback/link', 'POST'], ['/api/faucet/feedback/verify', 'POST'], ['/api/faucet/feedback/social', 'POST'], ['/api/faucet/feedback/season', 'GET'],
  ['/api/faucet/feedback/open-issues', 'GET'], ['/api/faucet/feedback/paid-log', 'GET']]);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const door = FAUCET_DOORS.get(url.pathname);
    if (door) {
      if (!env.FAUCET_ORIGIN) return new Response('{"ok":false,"why":"the faucet is off"}', { status: 503, headers: { 'content-type': 'application/json' } });
      if (request.method !== door) return new Response(JSON.stringify({ ok: false, why: door }), { status: 405, headers: { 'content-type': 'application/json' } });
      const headers = new Headers({ 'content-type': 'application/json', origin: url.origin });
      if (request.headers.get('authorization')) headers.set('authorization', request.headers.get('authorization'));
      const r = await fetch(`${env.FAUCET_ORIGIN}${url.pathname.slice('/api/faucet'.length)}`, { method: door, headers, body: door === 'POST' ? await request.text() : undefined });
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });
    }
    const r = await fetch(new Request(`${STAGE}${url.pathname}${url.search}`, request), { redirect: 'manual' });
    const out = new Response(r.body, r);
    out.headers.set('x-robots-tag', 'noindex, nofollow');
    const loc = out.headers.get('location');
    if (loc && loc.startsWith(STAGE)) out.headers.set('location', loc.replace(STAGE, url.origin));
    return out;
  },
};
