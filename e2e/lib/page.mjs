// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BUILT PAGE, SERVED AS THE SITE SERVES IT, for the e2e suite (kanban #2642).
// - a brotli .unityweb goes out with content-encoding br (Cloudflare's _headers do the same; devnet.mjs's own page part does not, and
//   the page then refuses Next Block's client as "not the pinned client" - a harness fault, not the page's)
// - the page's testnet-only parts (the players' faucet, feedback, opponent) are switched on by the page's own hostname test; here the
//   page is on 127.0.0.1, so index.html's ARENA_FAUCET_URL is pointed at the suite's own faucet service, proxied at /api/faucet/*
//   (the same path the site has). Every rewrite is listed in `rewrites` for the report.
// - THE ONE CHANGE TO THE CLIENT (anchor: the devnet's genesis, display hex): the client anchors a round's chain to a block compiled into
//   it by the round's network id (directory.js chainAnchorFor: testnet4's block 154000, else mainnet's genesis) and refuses an anchor a
//   page offers, so on a private regtest chain no page can prove a seat's bond and every join stops at "no proven endpoint: no chain"
//   (measured 2026-11-14 on the devnet). tools/tn4-live-run.mjs has ANCHOR_HASH for the same reason. Served with `anchor`, arena-client.js's
//   chainAnchorFor answers the devnet's genesis for a network that is not testnet4; nothing else in the page is touched.
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };

export async function servePage(dir, port, { faucet = null, anchor = null } = {}) {
  const rewrites = [];
  const fix = (html, origin) => {
    let out = html;
    if (faucet) {
      const from = "'https://bitcoinarena.io/api/faucet/player' : ''";
      if (out.includes(from)) { out = out.replace(from, `'https://bitcoinarena.io/api/faucet/player' : '${origin}/api/faucet/player'`); if (!rewrites.length || !rewrites.includes('ARENA_FAUCET_URL -> /api/faucet/player on 127.0.0.1')) rewrites.push('ARENA_FAUCET_URL -> /api/faucet/player on 127.0.0.1'); }
    }
    return out;
  };
  const s = createServer((rq, rs) => {
    const u = new URL(rq.url, 'http://x');
    if (faucet && u.pathname.startsWith('/api/faucet/')) {
      const target = new URL(u.pathname.slice('/api/faucet'.length) + u.search, faucet);
      const p = httpRequest(target, { method: rq.method, headers: { ...rq.headers, host: target.host } }, (r) => { rs.writeHead(r.statusCode, r.headers); r.pipe(rs); });
      p.on('error', (e) => { rs.writeHead(502, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ ok: false, why: `e2e proxy: ${e.message}` })); });
      rq.pipe(p);
      return;
    }
    let p = normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
    let f = join(dir, p);
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
    if (!existsSync(f)) { rs.writeHead(404, { 'content-type': 'text/plain' }); rs.end('not found'); return; }
    let b = readFileSync(f);
    const h = { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' };
    if (f.endsWith('.unityweb')) {
      h['content-encoding'] = 'br';
      if (f.endsWith('.wasm.unityweb')) h['content-type'] = 'application/wasm';
      else if (f.endsWith('.js.unityweb')) h['content-type'] = 'application/javascript';
    }
    if (anchor && f === join(dir, 'arena-client.js')) {
      const from = 'return TESTNET4_ANCHOR;\n  return BITCOIN_MAINNET_GENESIS;\n}';
      const internal = Buffer.from(anchor, 'hex').reverse().toString('hex');
      const t = b.toString('utf8');
      if (!t.includes(from)) throw new Error('arena-client.js has no chainAnchorFor to point at the devnet: the e2e anchor rewrite needs updating');
      b = Buffer.from(t.replace(from, `return TESTNET4_ANCHOR;\n  return fromHex('${internal}'); /* e2e #2642: the devnet's genesis */\n}`));
      if (!rewrites.includes('arena-client.js chainAnchorFor -> the devnet genesis')) rewrites.push('arena-client.js chainAnchorFor -> the devnet genesis');
    }
    if (f.endsWith('index.html') && f === join(dir, 'index.html')) b = Buffer.from(fix(b.toString('utf8'), `http://127.0.0.1:${port}`));
    rs.writeHead(200, h); rs.end(b);
  });
  await new Promise((ok, no) => { s.once('error', no); s.listen(port, '127.0.0.1', ok); });
  return { port, url: `http://127.0.0.1:${port}`, rewrites, close: () => s.close() };
}
