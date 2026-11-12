// kanban #1489 refute of #1540 (skeptic 2, a STRANGER, not a seat): the per-seat bound is 4 MB, but the number of seats read is not.
// A node with no peers and no round of its own (the owner's installed node, networkSeats' fallback) reads every endpoint in its
// address book, and before a census is read POST /address-announcement takes any self-signed key (up to ADDRESS_BOOK_MAX = 4096).
// A stranger posts N announcements pointing at its own server, then asks GET /network-games?fresh=1 (public, every 30 s):
// readNetworkApps reads all N listings at once (Promise.all), each up to 4 MB - N x 4 MB in the reading seat at the same time.
// Safe behaviour: what one ask makes the seat hold stays bounded, as for one seat's oversized listing (< 64 MB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signAddressAnnouncement } from '../../arena-protocol/src/address-announcement.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';

test('#1489-v1-refute-52-s2-1: a stranger\'s self-signed address announcements make one /network-games?fresh=1 hold N x 4 MB', async () => {
  const N = 64;
  // the stranger's server runs in its own process, so only the reading seat's memory is measured
  const SRC = `const BODY = '{"games":[{"id":"00","manifest":"00","title":"' + 'x'.repeat(4 * 1048576 - 200) + '"}]}';
    let asked = 0;
    const s = require('node:http').createServer((q, r) => {
      if (q.url === '/count') { r.writeHead(200); return r.end(String(asked)); }
      if (!/\\/games$/.test(q.url.split('?')[0])) { r.writeHead(404); return r.end(); }
      asked++; r.writeHead(200, { 'content-type': 'application/json' }); r.end(BODY);
    });
    s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + '\\n'));`;
  const evil = spawn(process.execPath, ['-e', SRC], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((ok) => evil.stdout.once('data', (d) => ok(Number(String(d).trim()))));
  const E = `http://127.0.0.1:${port}`;
  const b = await serve(openStore(), { plugins: [], port: 0 });
  try {
    let took = 0;
    for (let i = 0; i < N; i++) {
      const secret = randomBytes(32);
      const node = Buffer.from(schnorr.getPublicKey(secret)).toString('hex');
      const a = signAddressAnnouncement({ node, endpoint: `${E}/s${i}`, atMs: Date.now() - 1000 }, (d) => schnorr.sign(d, secret));
      const r = await fetch(`http://127.0.0.1:${b.port}/address-announcement`, { method: 'POST', body: JSON.stringify(a) });
      if (r.ok) took++;
      await r.text();
    }
    console.log(`the stranger's announcements taken: ${took} of ${N}`);
    const mem = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
    global.gc?.();
    const base = mem();
    let peak = 0;
    const iv = setInterval(() => { peak = Math.max(peak, mem() - base); }, 2);
    const r = await fetch(`http://127.0.0.1:${b.port}/network-games?fresh=1`);
    const j = await r.json();
    clearInterval(iv);
    const asked = Number(await (await fetch(`${E}/count`)).text());
    const answered = (j.seats || []).filter((s) => s.answered).length;
    const mb = Math.round(peak / 1048576);
    console.log(`one public ask: ${asked} listings read, ${answered} answered, the reading seat grew ${mb} MB`);
    assert.ok(mb < 64, `one stranger's GET /network-games?fresh=1 made the seat read ${asked} listings and hold ${mb} MB (per-seat bound 4 MB, no bound on seats)`);
  } finally { await b.close(); evil.kill(); }
});
