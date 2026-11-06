// THE SITE IS OPEN (kanban #611, 2026-10-24: "Remove the password from the website so everything works as expected"): it was
// behind a password form (SITE_PASSWORD, cookie ba_gate) since 2026-10-08, and the games screen's "Docs" link opened that form. Every
// page is served as it is. A link from the gated days still works: /__login and ?password=... land on the page they named, without a form.
import { scanChain } from './chain-scan.js';

// THE NODES, AS BITCOIN NAMES THEM: the cron below reads testnet4 through mempool.space every 2 minutes and
// keeps the read in KV; /api/chain-nodes hands it out at once. It is evidence, not a verdict - the page (www/js/
// chain-nodes.js) proves every transaction into its block and checks every signature before it believes a node.
const CHAIN_KEY = 'chain:testnet4';
async function chainNodes(env, ctx) {
  let body = await env.CHAIN.get(CHAIN_KEY);
  if (!body) { body = JSON.stringify(await scanChain(null)); ctx.waitUntil(env.CHAIN.put(CHAIN_KEY, body)); }
  return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30', 'Access-Control-Allow-Origin': '*' } });
}

// THE LAST BOARD, KEPT (kanban #941): a seat takes 5-13 s to merge a season from every seat, so the page shows this at once and asks the seats behind it. The board is the
// seats' own answer, read every 30 min by the cron for the 7-day boards and when someone looks at another, at most once in 30 min; KV keeps the writes few.
const SEASON_SEATS = ['https://tn4.bitcoin-arena.io/guardian-1', 'https://tn4.bitcoin-arena.io/guardian-2', 'https://tn4.bitcoin-arena.io/guardian-3'];
const SEASON_GAMES = ['nextblock', 'rock-paper-scissors', 'btc-updown-15m'], SEASON_DAYS = [7, 30, 90], SEASON_FRESH_MS = 1800000;
const seasonKey = (game, days) => `season:${game}:${days}`;
const readSeason = async (env, game, days) => {
  const body = await Promise.any(SEASON_SEATS.map(async (s) => { const r = await fetch(`${s}/season?game=${game}&days=${days}&scope=network`, { signal: AbortSignal.timeout(25000) }); if (!r.ok) throw new Error(String(r.status)); const t = await r.text(); JSON.parse(t); return t; }));
  const kept = `{"at":${Date.now()},"season":${body}}`;
  await env.CHAIN.put(seasonKey(game, days), kept);
  return kept;
};
async function seasonSnapshot(url, env, ctx) {
  const game = url.searchParams.get('game') || '', days = Number(url.searchParams.get('days'));
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=30' };
  if (!SEASON_GAMES.includes(game) || !SEASON_DAYS.includes(days)) return new Response('{"ok":false,"why":"no such board"}', { status: 404, headers });
  const kept = await env.CHAIN.get(seasonKey(game, days));
  if (kept) { if (Date.now() - Number(/^\{"at":(\d+)/.exec(kept)?.[1] || 0) > SEASON_FRESH_MS) ctx.waitUntil(readSeason(env, game, days).catch(() => {})); return new Response(kept, { headers }); }
  try { return new Response(await readSeason(env, game, days), { headers }); } catch { return new Response('{"ok":false,"why":"no seat answered"}', { status: 503, headers }); }
}
const CHANNEL_LINKS = {
  '/x': 'utm_source=x&utm_medium=social&utm_content=profile',
  '/nostr': 'utm_source=nostr&utm_medium=social&utm_content=profile',
  '/tg': 'utm_source=telegram&utm_medium=social&utm_content=profile',
  '/discord': 'utm_source=discord&utm_medium=social&utm_content=profile',
  '/dm': 'utm_source=dm&utm_medium=direct&utm_content=invite',
  '/compat': 'utm_source=compat&utm_medium=community&utm_content=wallets',
  '/night': 'utm_source=night&utm_medium=community&utm_content=testnet-night',
  '/sn': 'utm_source=stacker-news&utm_medium=community&utm_content=post',
  '/live': 'utm_source=live&utm_medium=community&utm_content=stream',
  '/invite': 'utm_source=invite&utm_medium=referral&utm_content=tester',
  '/reddit': 'utm_source=reddit&utm_medium=community&utm_content=post',
  '/community': 'utm_source=community&utm_medium=community&utm_content=post',
};
// TESTNET NIGHT ON OR OFF (kanban #926, the owner 2026-11-03: "optional so it can be enabled or disabled"): KV key `night` in CHAIN,
// "off" switches it off, anything else or nothing leaves it on. No deploy needed:
//   npx wrangler kv key put --binding CHAIN night off --remote     (off)
//   npx wrangler kv key delete --binding CHAIN night --remote      (on again)
async function nightOn(env) { try { return (await env.CHAIN.get('night', { cacheTtl: 60 })) !== 'off'; } catch { return true; } }
// TESTNET NIGHT'S LIVE COUNT (kanban #926 item 7): players joined in the rounds still open or playing, and the rounds playing, kept 30 s at the edge
async function nightCount() {
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=30' };
  try {
    const rows = await Promise.any(SEASON_SEATS.map(async (s) => { const r = await fetch(`${s}/rounds?next=1`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(String(r.status)); return (await r.json()).rounds || []; }));
    const live = rows.filter((r) => r.phase === 'open' || Number(r.playing) > 0);
    return new Response(JSON.stringify({ ok: true, at: Date.now(), joined: live.reduce((n, r) => n + (Number(r.joined) || 0), 0), playing: rows.reduce((n, r) => n + (Number(r.playing) || 0), 0), rounds: live.length }), { headers });
  } catch { return new Response('{"ok":false,"why":"no seat answered"}', { status: 503, headers }); }
}
// THE PUBLIC TESTNET REPORT'S NUMBERS (kanban #926 item 11): the kept 7-day boards, each player once, as tools/weekly-testers.mjs counts them; team keys and the test opponent left out
async function testers(env) {
  const team = new Set(JSON.parse(await env.CHAIN.get('team-keys') || '[]'));
  const everyone = new Set(); const games = []; let at = 0;
  for (const game of SEASON_GAMES) {
    const kept = JSON.parse(await env.CHAIN.get(seasonKey(game, 7)) || 'null');
    if (!kept) continue;
    at = Math.max(at, kept.at);
    const rows = (kept.season.rows || []).filter((r) => Number(r.rounds) > 0 && !team.has(String(r.player).toLowerCase()) && r.name !== 'Test bot');
    for (const r of rows) everyone.add(String(r.player).toLowerCase());
    games.push({ game, testers: rows.length, rounds: rows.reduce((n, r) => n + Number(r.rounds), 0), allRounds: Number(kept.season.rounds) || 0 });
  }
  return new Response(JSON.stringify({ at, testers: everyone.size, games }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' } });
}
// THE OLD DOMAIN (kanban #937): every (sub)domain of it sends to the same place on the new one, path and query kept
const OLD_DOMAIN = /(^|\.)bitcoin-arena\.io$/;
const moved = (url) => { if (!OLD_DOMAIN.test(url.hostname)) return null; const to = new URL(url); to.hostname = url.hostname.replace(/bitcoin-arena\.io$/, 'bitcoinarena.io'); return Response.redirect(to.toString(), 308); };
export default {
async scheduled(event, env, ctx) {
  if (new Date(event.scheduledTime).getUTCMinutes() % 30 < 2) ctx.waitUntil(Promise.allSettled(SEASON_GAMES.map((g) => readSeason(env, g, 7))));
  const before = await env.CHAIN.get(CHAIN_KEY, 'json');
  const read = await scanChain(before);
  // a read that reached nothing does not replace one that did
  if (read.txs.length || !before) await env.CHAIN.put(CHAIN_KEY, JSON.stringify(read));
  console.log(JSON.stringify({ chain: { txs: read.txs.length, tip: read.tip, fetches: read.fetches, partial: read.partial, errors: read.errors.length, ms: read.ms } }));
},
async fetch(request, env, ctx) {

  const url = new URL(request.url);
  // NIP-05: who our Nostr names are (kanban #958). Answered on every host, because the spec forbids a redirect here.
  if (url.pathname === '/.well-known/nostr.json') {
    return new Response(JSON.stringify({ names: { _: '09dbfd772e67e02440df604429f47c747668b82b8e8a5121d367976a06de2bf7', georgeprime: '97b7b1282ed2308f088c43b24b6e51ba9b5582c4d92aeae8691cfacf0f7c5e05', 'mateo-vives': 'cdbb9e44a92663610ffdfbedc003f9e5077dbc6470ca54ce973e06f683546e16', badges: '4e3c070cc5ed4cc1bb359edff94516313dfe9f782c04f261c89315d6641e63c5' } }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' } });
  }
  if (!url.pathname.startsWith('/api/')) { const went = moved(url); if (went) return went; }   // a page already open still calls /api/ here
  if (url.pathname === '/games' || url.pathname === '/games/') return Response.redirect(`${url.origin}/#games`, 301);   // kanban #948: the page is gone, a link to it lands on the home page's games
  if (url.pathname === '/api/season') return seasonSnapshot(url, env, ctx);
  if (url.pathname === '/api/testers') return testers(env);
  // TESTNET NIGHT'S LIVE COUNT (kanban #926 item 7, ruling #1081): how many have joined the rounds open or playing now, from the first seat that answers
  if (url.pathname === '/api/night') return (await nightOn(env)) ? nightCount() : new Response('{"ok":true,"on":false}', { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
  // A SHORT LINK PER CHANNEL (kanban #943): a profile shows bitcoinarena.io/x, the visit still arrives with its campaign, and the referrer stays
  // TESTNET NIGHT SWITCHED OFF (kanban #926): its page and short link land on the home page
  if ((url.pathname === '/night' || url.pathname === '/night/') && !(await nightOn(env))) return Response.redirect(`${url.origin}/`, 302);
  // /night lands on the Testnet Night page (kanban #926 item 7), the others on the home page; a visit already carrying its campaign is served, not sent round again
  { const path = url.pathname.replace(/\/$/, ''); const utm = CHANNEL_LINKS[path];
    if (utm && !url.searchParams.has('utm_source')) return Response.redirect(`${url.origin}${path === '/night' ? '/night/' : '/'}?${utm}`, 302); }
  // THE PLAYERS' FAUCET AND THE TABLE WANTS (kanban #926): passed on to the faucet service, whose address is a secret of this Worker (FAUCET_ORIGIN), with the caller's address for its limits
  if (url.pathname === '/api/faucet/player' || url.pathname === '/api/faucet/opponent' || url.pathname === '/api/faucet/feedback' || url.pathname === '/api/faucet/founding' || url.pathname === '/api/faucet/refill') {
    if (!env.FAUCET_ORIGIN) return new Response('{"ok":false,"why":"the faucet is off"}', { status: 503, headers: { 'content-type': 'application/json' } });
    const headers = new Headers({ 'content-type': 'application/json', 'x-arena-ip': request.headers.get('cf-connecting-ip') || '' });
    const origin = request.headers.get('origin'); if (origin) headers.set('origin', origin);
    return fetch(`${env.FAUCET_ORIGIN}${url.pathname.slice('/api/faucet'.length)}${url.search}`, { method: request.method, headers, body: request.method === 'POST' ? await request.text() : undefined });
  }
  // A PHONE'S BENCHMARK LINES (the page's ?bench=1): logged for wrangler tail, nothing stored, nothing served back
  if (url.pathname === '/__bench' && request.method === 'POST') {
    const body = (await request.text()).slice(0, 20000);
    console.log('[bench] ' + body);
    // KEPT, so a phone's run is not lost when no one is watching the log (the 01:45 gate found none)
    if (env.BENCH) {
      const country = (request.cf && request.cf.country) || '';
      await env.BENCH.put(`bench:${new Date().toISOString()}:${crypto.randomUUID().slice(0, 8)}`, body,
        { expirationTtl: 30 * 24 * 3600, metadata: { country, ua: (request.headers.get('User-Agent') || '').slice(0, 120) } });
    }
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  // THE NEW HOMEPAGE BESIDE THE LIVE ONE (kanban #1197): next.bitcoinarena.io serves www/next at its root, kept out of search indexes until Daniel
  // switches it; every other path (the API, NIP-05 above, the shared scripts, /night/, /security/) answers as on the live host
  if (url.hostname === 'next.bitcoinarena.io') {
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const open = await env.ASSETS.fetch(new Request(new URL('/next/', url), request));
      const res = new Response(open.body, open);
      res.headers.set('X-Robots-Tag', 'noindex, nofollow');
      return res;
    }
  }
  if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { headers: { 'Content-Type': 'text/plain' } });
  // chatgpt.bitcoin-arena.io (2026-10-08 23:17: so ChatGPT can read the page): the same files, kept out of search indexes
  if (url.hostname === 'chatgpt.bitcoin-arena.io' || url.hostname === 'chatgpt.bitcoinarena.io') {
    if (url.pathname === '/api/chain-nodes') return chainNodes(env, ctx);
    const open = await env.ASSETS.fetch(request);
    const res = new Response(open.body, open);
    res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return res;
  }
  // THE OLD LOGIN LINKS (the gate's form posted to /__login; ?password=... logged in from a link): to the page they named
  if (url.pathname === '/__login') return Response.redirect(url.origin + '/', 303);
  if (url.searchParams.has('password')) { url.searchParams.delete('password'); return Response.redirect(url.toString(), 301); }
  if (url.pathname === '/api/chain-nodes') return chainNodes(env, ctx);
  // THE HOMEPAGE'S VIDEOS IN BYTE RANGES (kanban #1197): the asset store answers a Range request with the whole file (200), and Safari on an
  // iPhone plays an mp4 only from 206 partial answers - so the Worker cuts the asked range itself (the files are a few MB)
  if (url.pathname.startsWith('/next/media/') && /\.(mp4|webm)$/.test(url.pathname) && request.method === 'GET') {
    const whole = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
    if (!whole.ok) return whole;
    const buf = await whole.arrayBuffer(); const size = buf.byteLength;
    const headers = new Headers({ 'Content-Type': whole.headers.get('content-type') || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' });
    const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
    if (!m) { headers.set('Content-Length', String(size)); return new Response(buf, { status: 200, headers }); }
    let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (!(start <= end) || start >= size) { headers.set('Content-Range', `bytes */${size}`); return new Response(null, { status: 416, headers }); }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`); headers.set('Content-Length', String(end - start + 1));
    return new Response(buf.slice(start, end + 1), { status: 206, headers });
  }
  const page = await env.ASSETS.fetch(request);
  // TESTNET NIGHT SWITCHED OFF: no page links to it
  if ((page.headers.get('content-type') || '').includes('text/html') && !(await nightOn(env))) return new HTMLRewriter().on('a[href="/night/"]', { element: (e) => e.remove() }).transform(page);
  return page;
}
};
