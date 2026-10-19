// THE SITE IS PASSWORD PROTECTED (2026-10-08 17:11: "If the cookie is already there, log in automatically").
// A visitor with the cookie sees the site at once; anyone else gets the password form. The cookie holds a hash of the password
// (never the password), lasts a year, and on bitcoin-arena.io is set for the whole domain, so bitcoin-arena.io and
// www.bitcoin-arena.io share one login. The password is the Pages secret SITE_PASSWORD.
const COOKIE = 'ba_gate';
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

async function tokenOf(password) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bitcoin-arena-gate/v1:' + password));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cookieOf(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

const page = (wrong, next) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bitcoin Arena</title><meta name="robots" content="noindex">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100svh; display: grid; place-items: center; background: radial-gradient(90% 70% at 50% 0%, rgba(247,147,26,.16), transparent 60%), #07090d; color: #e8edf3; font: 16px/1.5 system-ui, sans-serif; }
  form { width: min(380px, calc(100% - 32px)); background: #0e131b; border: 1px solid #1d2633; border-radius: 20px; padding: 32px 28px; }
  .b { display: flex; align-items: center; gap: 10px; font: 700 20px system-ui; margin-bottom: 18px; }
  .b i { width: 30px; height: 30px; border-radius: 8px; background: conic-gradient(from 210deg, #f7931a, #ffd166, #f7931a); display: grid; place-items: center; font-style: normal; color: #1a0f00; }
  input { width: 100%; box-sizing: border-box; padding: 14px; border-radius: 12px; border: 1px solid #2a3544; background: #07090d; color: #e8edf3; font-size: 16px; }
  button { width: 100%; margin-top: 12px; padding: 14px; border: 0; border-radius: 12px; background: linear-gradient(135deg, #f7931a, #ffb347); color: #1a0f00; font: 600 16px system-ui; cursor: pointer; }
  p { margin: 12px 0 0; color: #ff8a8a; font-size: 14px; }
</style></head><body>
<form method="post" action="/__login"><div class="b"><i>₿</i>Bitcoin Arena</div>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${next.replace(/[^\w\/\-.#?=&%]/g, '')}">
<button>Enter</button>${wrong ? '<p>That password is not right.</p>' : ''}</form></body></html>`;

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
  // robots.txt OUTSIDE THE GATE: a fetcher that asks it first and gets 401 may stop there (the page itself stays gated)
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
  // chatgpt.bitcoin-arena.io HAS NO PASSWORD (2026-10-08 23:17: so ChatGPT can read the page): the same files, kept out
  // of search indexes; every other hostname stays gated
  if (url.hostname === 'chatgpt.bitcoin-arena.io') {
    if (url.pathname === '/api/chain-nodes') return chainNodes(env, ctx);
    const open = await env.ASSETS.fetch(request);
    const res = new Response(open.body, open);
    res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return res;
  }
  const password = env.SITE_PASSWORD;
  if (!password) return new Response('The site is not configured yet.', { status: 503 });
  const want = await tokenOf(password);
  const domain = url.hostname === 'bitcoin-arena.io' || url.hostname.endsWith('.bitcoin-arena.io') ? '; Domain=bitcoin-arena.io' : '';
  const login = (to) => new Response(null, { status: 303, headers: {
    Location: to.startsWith('/') && !to.startsWith('//') ? to : '/',
    'Set-Cookie': `${COOKIE}=${want}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax${domain}`,
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  const html = (wrong, status) => new Response(page(wrong, url.pathname === '/__login' ? '/' : url.pathname),
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  // ?password=… LOGS IN TOO (2026-10-08 ~23:10): the cookie is set as by the form, and the visitor lands on the same
  // address without the password in it
  // spaces around it are not part of it ("?password= lens-…" as typed into a chat measured 401)
  const given = url.searchParams.has('password') ? url.searchParams.get('password').trim() : null;
  if (given !== null) {
    if (given !== password) return html(true, 401);
    // THE PAGE AT ONCE, NOT A REDIRECT (2026-10-08 23:08: a fetcher that keeps no cookie got 401 after the 303): the
    // asset without the parameter, answered here with the cookie set on the same response
    url.searchParams.delete('password');
    const asset = await env.ASSETS.fetch(new Request(url.toString(), { method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers: request.headers }));
    const res = new Response(asset.body, asset);
    res.headers.append('Set-Cookie', `${COOKIE}=${want}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax${domain}`);
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');
    return res;
  }
  console.log(JSON.stringify({ gate: given === null ? (cookieOf(request, COOKIE) === want ? 'cookie' : 'none') : 'param', path: url.pathname, ua: (request.headers.get('User-Agent') || '').slice(0, 80) }));
  if (cookieOf(request, COOKIE) === want) return url.pathname === '/api/chain-nodes' ? chainNodes(env, ctx) : env.ASSETS.fetch(request);

  if (request.method === 'POST' && url.pathname === '/__login') {
    const form = await request.formData();
    if (String(form.get('password') || '').trim() !== password) return html(true, 401);
    return login(String(form.get('next') || '/'));
  }
  return html(false, 401);
}
};
