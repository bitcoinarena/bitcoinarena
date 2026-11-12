// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1900, #1942 (bypass of #1550 / #1744): a first mark the entry's session key DID sign, that this seat does not
// hold, still makes lateByPeers ask every peer's /entry-void. That pull is now capped at one ENTRY_VOID record (1 MiB,
// verify.js's ENTRY_VOID_MAX_BYTES): one peer answering it with 128 MiB as fast as it can is cut, not read whole.
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

test('#1489-v1-refute-53-s2-3: a signed first mark the seat does not hold reads a peer\'s /entry-void up to the cap only', async () => {
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
  try {
    // seated and staked, no mark sent: the player's own signed first mark is held by no seat yet
    const played = await lockAndPlay(w, WINNER, { noMarks: true });
    w.a.verifier.peers = [...w.a.verifier.peers, `http://127.0.0.1:${evil.address().port}`];
    const answer = await sendFrame(w.a.port, played.late[1]);
    await wait(500);
    const facts = { asked, takenMiB: +(taken / MIB).toFixed(1), answer: answer.slice(0, 80) };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.ok(asked >= 1, 'the seat never asked the peer (path not reached)');
    assert.ok(taken <= 4 * MIB, `a signed first mark made the seat read ${facts.takenMiB} MiB of one peer's /entry-void (no cap)`);
  } finally {
    evil.closeAllConnections(); evil.close();
    await Promise.race([w.close(), wait(5000)]);
  }
});
