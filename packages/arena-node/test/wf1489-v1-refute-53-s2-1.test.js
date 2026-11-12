// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-53-s2 (bypass of #1550 / #1744): #1744 capped a peer's /entry-void at 1 MiB in verify.js,
// but server.js lateByPeers reads the very same door with a bare r.json() - no cap. It runs on the /play socket for
// every first mark this seat does not hold, BEFORE the mark is checked: a stranger sends a first mark with a junk
// signature for a real entry (no key needed), and the seat pulls every peer's /entry-void whole. One peer answering it
// with 128 MiB as fast as it can is read whole (string + parse), per frame, as often as the stranger sends one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { lockPort } from './lock-fixture.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { WINNER, wait } from './window-fixture.js';

const MIB = 1 << 20;
const sendFrame = (port, bytes) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  const t = setTimeout(() => { try { ws.close(); } catch { /* gone */ } resolve('timeout'); }, 15000);
  ws.on('open', () => ws.send(bytes));
  ws.on('message', (d) => { clearTimeout(t); resolve(String(d)); ws.close(); });
  ws.on('error', () => { clearTimeout(t); resolve('error'); });
});

test('#1489-v1-refute-53-s2-1: a stranger\'s junk first mark makes the seat read a peer\'s /entry-void uncapped', async () => {
  let taken = 0; let asked = 0;
  const evil = createServer((req, res) => {
    if (req.url.startsWith('/entry-void')) {
      asked++;
      res.writeHead(200, { 'content-type': 'application/json' });
      const pad = Buffer.alloc(MIB, 0x61); let closed = false; let sent = 0;
      res.on('close', () => { closed = true; });
      res.write('{"pad":"');
      const pump = () => {
        while (!closed && sent < 128) {
          sent++; if (!res.write(pad, (err) => { if (!err) taken += pad.length; })) { res.once('drain', pump); return; }
        }
        if (!closed) res.end('"}');
      };
      pump();
      return undefined;
    }
    if (req.url.startsWith('/receipts')) { res.writeHead(200); return res.end(Buffer.alloc(0)); }
    res.writeHead(404); return res.end('no');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const port = lockPort();
  const w = await lockRound({ port });
  const rss0 = process.memoryUsage().rss; let peak = rss0;
  const memT = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  try {
    const won = await lockAndPlay(w, WINNER);
    w.a.verifier.peers = [...w.a.verifier.peers, `http://127.0.0.1:${evil.address().port}`];
    // THE STRANGER: the seat's own held first mark, one state byte changed (another mark id), its signature now junk
    const held = w.a.round.firstMarkHeld(w.rid, won.eid);
    assert.ok(held, 'seat a holds no first mark');
    const forged = Uint8Array.from(held); forged[120] ^= 0xff;
    const answers = [];
    for (let k = 0; k < 3; k++) { forged[121] = k; answers.push(await sendFrame(w.a.port, forged)); }
    await wait(500);
    const facts = { asked, takenMiB: Math.round(taken / MIB), peakRssDeltaMiB: Math.round((peak - rss0) / MIB), answers: answers.map((a) => a.slice(0, 80)) };
    console.log('  FACTS:', JSON.stringify(facts));
    // kanban #1900's fix checks the first mark's signature before any peer is asked, so a junk mark costs no pull at all
    // (asked 0); the path is reached all the same - each frame is answered at /play, refused for its signature.
    // The size cap on a signed mark's pull is held by wf1489-v1-refute-53-s2-3.
    assert.equal(answers.length, 3);
    for (const a of answers) assert.match(a, /^error .*signature/, `a junk first mark was not refused for its signature: ${a}`);
    assert.ok(taken <= 4 * MIB, `a stranger's ${answers.length} junk first marks made the seat read ${facts.takenMiB} MiB of one peer's /entry-void (no cap; RSS +${facts.peakRssDeltaMiB} MiB)`);
  } finally {
    clearInterval(memT);
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
