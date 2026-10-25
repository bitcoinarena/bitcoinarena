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

export default {
async scheduled(event, env, ctx) {
  const before = await env.CHAIN.get(CHAIN_KEY, 'json');
  const read = await scanChain(before);
  // a read that reached nothing does not replace one that did
  if (read.txs.length || !before) await env.CHAIN.put(CHAIN_KEY, JSON.stringify(read));
  console.log(JSON.stringify({ chain: { txs: read.txs.length, tip: read.tip, fetches: read.fetches, partial: read.partial, errors: read.errors.length, ms: read.ms } }));
},
async fetch(request, env, ctx) {

  const url = new URL(request.url);
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
  if (url.hostname === 'chatgpt.bitcoin-arena.io') {
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
