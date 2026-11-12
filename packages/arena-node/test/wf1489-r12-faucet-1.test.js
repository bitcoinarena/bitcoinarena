// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r12-faucet-1: walletFetch (feedback-store.js), the faucet's only fetcher for a stranger's Lightning address, builds
// `new Response(body, { status: res.statusCode })` inside the response's 'end' listener for every status 200-599. A wallet that answers
// 204, 205 or 304 makes that constructor throw ("Invalid response status code 204") inside an event listener: an uncaught exception, and the
// whole faucet process dies. Anyone reaches it: POST /feedback with a signed report naming lnAddress "x@evil.example" (any key signs),
// GET /feedback/lnaddress?a=..., and the admin's payout (lnAddressInvoice). Safe behaviour: the check answers { ok: false } and the process lives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'feedback-store.js');

// the child: a "public" wallet whose name resolves to a global address (dns stubbed) and whose HTTPS answer is a plain 204 from a local server
const child = (fn, status) => `
import https from 'node:https'; import http from 'node:http'; import dns from 'node:dns'; import { once } from 'node:events'; import { syncBuiltinESMExports } from 'node:module';
const srv = http.createServer((q, s) => { s.writeHead(${status}); s.end(); }).listen(0, '127.0.0.1'); await once(srv, 'listening');
const port = srv.address().port;
dns.lookup = (h, o, cb) => { if (typeof o === 'function') cb = o; cb(null, [{ address: '93.184.215.14', family: 4 }]); };
https.request = (url, opts, cb) => { const u = new URL(url); return http.request('http://127.0.0.1:' + port + u.pathname + u.search, { method: opts.method, headers: opts.headers, signal: opts.signal }, cb); };
syncBuiltinESMExports();
const m = await import(${JSON.stringify(pathToFileURL(STORE).href)});
const r = await m.${fn};
console.log('RESULT ' + JSON.stringify(r)); srv.close(); process.exit(0);
`;
function run(src) {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r12-faucet-1-')), f = join(dir, 'child.mjs');
  writeFileSync(f, src);
  return new Promise((ok) => { const p = spawn(process.execPath, [f], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', (code) => ok({ code, out, err })); });
}

for (const status of [204, 304]) {
  test(`#1489 r12-faucet-1: a Lightning address whose wallet answers ${status} is refused, the faucet process lives (lnAddressWorks)`, async () => {
    const r = await run(child(`lnAddressWorks('alice@wallet.example.com')`, status));
    console.log(`  FACTS r12-faucet-1 lnAddressWorks ${status}:`, JSON.stringify({ exit: r.code, out: r.out.trim(), err: r.err.split('\n').filter((l) => /Error|status code/.test(l)).slice(0, 2) }));
    assert.equal(r.code, 0, `the process died on a wallet's ${status}: ${r.err.split('\n').find((l) => /Error/.test(l)) || r.err.slice(0, 200)}`);
    assert.match(r.out, /RESULT \{"ok":false/);
  });
}

test('#1489 r12-faucet-1: the payout (lnAddressInvoice) to an address answering 204 fails, the faucet process lives', async () => {
  const r = await run(child(`lnAddressInvoice('alice@wallet.example.com', 1000, 'thanks')`, 204));
  console.log('  FACTS r12-faucet-1 lnAddressInvoice 204:', JSON.stringify({ exit: r.code, out: r.out.trim() }));
  assert.equal(r.code, 0, `the process died on a wallet's 204: ${r.err.split('\n').find((l) => /Error/.test(l)) || r.err.slice(0, 200)}`);
  assert.match(r.out, /RESULT \{"ok":false/);
});
