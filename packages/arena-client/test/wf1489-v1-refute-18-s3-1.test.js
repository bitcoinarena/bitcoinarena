// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 v1-refute-18 skeptic 3 (second copies): #1507 bounded the seat's GET /reveals pull (verify.js carryReveals) in time and size, and
// #1685/#1870 put every other peer pull of the head-to-head close under peer-body.js. The PAGE has its own copy of the same pull:
// arena-client head-to-head.js revealsOfRound (bundled into src/arena-ui/arena-client.js, called by index.html `reveals` and by the RPS
// client's refresh) still does a bare fetch + r.json() under Promise.all - no deadline, no cap. One committee seat that answers 200 and
// trickles its body holds the whole call forever (the RPS client's `refreshing` flag then never clears: the page stops reading the seats),
// and one that streams a huge body is buffered whole into the tab. Safe behaviour: the honest seats' moves come back in a few seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { revealsOfRound } from '../src/head-to-head.js';

const ME = 'aa'.repeat(32), THEM = 'bb'.repeat(32);
const honestBody = JSON.stringify({ reveals: [{ entry: ME, move: 1 }, { entry: THEM, move: 0 }] });
const serve = (handler) => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => ok(s)); });
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;

test('#1489 v1-refute-18-s3-1: one seat trickling its /reveals body holds the page\'s revealsOfRound forever', async () => {
  const honest = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(honestBody); });
  const timers = [];
  const slow = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"reveals":[');
    const t = setInterval(() => { try { res.write(' '); } catch { /* gone */ } }, 200); timers.push(t);
    res.on('close', () => clearInterval(t));
  });
  try {
    const t0 = Date.now();
    const got = await Promise.race([
      revealsOfRound({ roundIdHex: 'cc'.repeat(32), nodes: [urlOf(honest), urlOf(honest), urlOf(slow)] }),
      new Promise((r) => setTimeout(() => r('STALLED'), 15000)),
    ]);
    console.log(`  FACTS after ${Date.now() - t0} ms: ${JSON.stringify(got)}`);
    assert.notEqual(got, 'STALLED', 'one trickling seat held revealsOfRound past 15 s (no deadline on the page\'s /reveals pull)');
    assert.equal(got[ME], 1); assert.equal(got[THEM], 0);
  } finally { for (const t of timers) clearInterval(t); honest.closeAllConnections(); slow.closeAllConnections(); honest.close(); slow.close(); }
});

test('#1489 v1-refute-18-s3-1b: one seat streaming a huge /reveals body is buffered whole by the page', async () => {
  const honest = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(honestBody); });
  let sent = 0;
  const MiB = 1024 * 1024, chunk = Buffer.alloc(MiB, 0x20), TOTAL = 96;
  const flood = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"reveals":[');
    let n = 0;
    const more = () => { while (n < TOTAL) { n++; sent += MiB; if (!res.write(chunk)) { res.once('drain', more); return; } } res.end(']}'); };
    res.on('close', () => { n = TOTAL + 1; });
    more();
  });
  try {
    const got = await revealsOfRound({ roundIdHex: 'cc'.repeat(32), nodes: [urlOf(honest), urlOf(honest), urlOf(flood)] });
    console.log(`  FACTS the flooding seat got ${Math.round(sent / MiB)} MiB into the page's read; result ${JSON.stringify(got)}`);
    assert.ok(sent < 16 * MiB, `the page read ${Math.round(sent / MiB)} MiB of one seat's /reveals - no size cap (a head-to-head round's reveals are a few hundred bytes)`);
  } finally { honest.closeAllConnections(); flood.closeAllConnections(); honest.close(); flood.close(); }
});
