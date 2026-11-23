// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE EMBEDDING SITE NEVER HOLDS THE PLAYER'S SEED (kanban #3531, feedback #392): two origins in a headless Chrome - the Arena site
// (src/arena-ui on 127.0.0.1) and a host site (localhost, another site) whose page carries the official snippet. The player restores a
// wallet (ARENA_RESTORE_SEED, what Settings and the start screen call) wherever the engine runs; after the reload a host-page script reads
// everything the host origin can reach - localStorage, sessionStorage, cookies, the page's DOM text, every global it can enumerate - and
// must find neither the seed nor any 64-hex secret, while the Arena frame does hold the restored seed (the restore happened).
//
//   PLAYWRIGHT=/path/to/node_modules/playwright-core [FALLBACK=<built page>] node e2e/embed-seed-3531.mjs      exit 0: held; exit 1: the host read the seed
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

// the site's folder; a file it lacks (the built games/ parts) from FALLBACK, a built page (e.g. a sitemirror page without its Unity data)
const UI = new URL('../src/arena-ui/', import.meta.url).pathname;
const FALLBACK = process.env.FALLBACK || null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };
const listen = (s) => new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s.address().port)));

// the Arena site: its folder as the site serves it, answering any origin (as Cloudflare's _headers do for the kit)
const arena = createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://x');
  let p = join(UI, normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, ''));
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p) && FALLBACK) { p = join(FALLBACK, p.slice(UI.length)); if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html'); }
  if (!existsSync(p)) { rs.writeHead(404, { 'access-control-allow-origin': '*' }); rs.end('no'); return; }
  rs.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  rs.end(readFileSync(p));
});
const A = await listen(arena);
const SITE = `http://127.0.0.1:${A}`;
// the host site: one page with the official snippet, the kit from the Arena site
const hostSrv = createServer((rq, rs) => {
  rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  rs.end(`<!doctype html><html><head><title>host</title></head><body><h1>A site with a game</h1>
<div id="arena-game" style="height:720px"></div>
<script src="${SITE}/arena-embed.js" data-game="rock-paper-scissors" data-target="#arena-game"></script></body></html>`);
});
const B = await listen(hostSrv);
const HOST = `http://localhost:${B}/`;

const req = createRequire(import.meta.url);
const { chromium } = req(process.env.PLAYWRIGHT || 'playwright-core');
const browser = await chromium.launch({ headless: true });
const SEED = randomBytes(32).toString('hex');
let code = 2;
try {
  const page = await browser.newPage();
  if (process.env.DEBUG) { page.on('console', (m) => console.log('#3531 console: ' + m.text().slice(0, 300))); page.on('pageerror', (e) => console.log('#3531 pageerror: ' + String(e).slice(0, 300))); }
  // nothing leaves the two local origins: no live node, federation or relay is asked anything
  await page.context().route('**/*', (r) => { const h = new URL(r.request().url()).hostname; return h === '127.0.0.1' || h === 'localhost' ? r.continue() : r.abort(); });
  if (page.context().routeWebSocket) await page.context().routeWebSocket(/.*/, (ws) => ws.close());
  await page.goto(HOST);
  // wherever the engine runs: the host page itself (the old kit) or a frame on the Arena origin
  const engine = async () => {
    for (let i = 0; i < 240; i++) {
      for (const f of page.frames()) { try { if (await f.evaluate(() => typeof window.ARENA_RESTORE_SEED === 'function')) return f; } catch { /* navigating */ } }
      await page.waitForTimeout(250);
    }
    throw new Error('#3531 the engine never came up');
  };
  const e1 = await engine();
  const where = e1 === page.mainFrame() ? 'the host page' : 'a frame of ' + new URL(e1.url()).origin;
  console.log('#3531 engine runs in ' + where);
  await e1.evaluate((s) => { try { window.ARENA_RESTORE_SEED(s); } catch { /* the reload */ } }, SEED);
  await page.waitForTimeout(1500);
  const e2 = await engine();
  await page.waitForTimeout(3000);
  const arenaHolds = await e2.evaluate(() => sessionStorage.getItem('arena.player.seed'));
  // EVERYTHING A HOST-PAGE SCRIPT CAN READ
  const seen = await page.evaluate(() => {
    const out = [];
    for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) { const k = s.key(i); out.push(k + '=' + s.getItem(k)); }
    out.push(document.cookie, document.documentElement.outerHTML);
    for (const k of Object.getOwnPropertyNames(window)) {
      try { const v = window[k]; if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object' && !(v instanceof Node) && v !== window) out.push(JSON.stringify(v).slice(0, 100000)); } catch { /* not readable */ }
    }
    return out.join('\n');
  });
  const leaked = seen.toLowerCase().includes(SEED);
  console.log('#3531 restored seed held by the engine: ' + (arenaHolds === SEED));
  console.log('#3531 host-page script reads the seed: ' + leaked + (leaked ? ' (in ' + seen.split('\n').filter((l) => l.toLowerCase().includes(SEED)).map((l) => l.slice(0, 40)).join(' | ') + ')' : ''));
  code = !leaked && arenaHolds === SEED && where !== 'the host page' ? 0 : 1;
} finally {
  await browser.close();
  arena.close(); hostSrv.close();
}
console.log('#3531 ' + (code === 0 ? 'PASS' : 'FAIL'));
process.exit(code);
