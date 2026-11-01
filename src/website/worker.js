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
  if (!url.pathname.startsWith('/api/')) { const went = moved(url); if (went) return went; }   // a page already open still calls /api/ here
  if (url.pathname === '/api/season') return seasonSnapshot(url, env, ctx);
  // A SHORT LINK PER CHANNEL (kanban #943): a profile shows bitcoinarena.io/x, the visit still arrives with its campaign, and the referrer stays
  { const utm = CHANNEL_LINKS[url.pathname.replace(/\/$/, '')]; if (utm) return Response.redirect(`${url.origin}/?${utm}`, 302); }
  // THE PLAYERS' FAUCET AND THE TABLE WANTS (kanban #926): passed on to the faucet service, whose address is a secret of this Worker (FAUCET_ORIGIN), with the caller's address for its limits
  if (url.pathname === '/api/faucet/player' || url.pathname === '/api/faucet/opponent' || url.pathname === '/api/faucet/feedback') {
    if (!env.FAUCET_ORIGIN) return new Response('{"ok":false,"why":"the faucet is off"}', { status: 503, headers: { 'content-type': 'application/json' } });
    const headers = new Headers({ 'content-type': 'application/json', 'x-arena-ip': request.headers.get('cf-connecting-ip') || '' });
    const origin = request.headers.get('origin'); if (origin) headers.set('origin', origin);
    return fetch(`${env.FAUCET_ORIGIN}${url.pathname.slice('/api/faucet'.length)}`, { method: request.method, headers, body: request.method === 'POST' ? await request.text() : undefined });
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
  return url.pathname === '/api/chain-nodes' ? chainNodes(env, ctx) : env.ASSETS.fetch(request);
}
};
