// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN UNFINISHED MESSAGE DOES NOT PIN THE STANDALONE RELAY'S MEMORY (kanban #3691, bypass audit wf_12229180-099: the twin of #2075 outside the
// seat). nostr-relay.js takes a message of up to maxPayload (128 KiB) per socket, has no cap on sockets per address (behind the tunnel every
// player has one address), and had no budget for bytes received since a socket's last whole message nor a time limit on an unfinished one:
// N sockets that each send most of a 120 KiB frame and never its end held N x 120 KiB for as long as they stayed open. Now every socket's
// unfinished bytes count against one budget (body-budget.js messageBudget, as server.js's websockets since #2075) and a message unfinished
// for messageMs is not waited for. Honest whole messages are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { startRelay } from '../src/nostr-relay.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** A raw socket upgraded to a websocket, then the header of one masked text frame of `len` bytes and `sent` of them - never the rest. */
function unfinished(port, len, sent) {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1');
    const st = { closed: false, socket: s };
    s.on('close', () => { st.closed = true; });
    s.on('error', () => { st.closed = true; });
    let got = '';
    s.on('data', function first(d) {
      got += d.toString('latin1');
      if (!got.includes('\r\n\r\n')) return;
      s.off('data', first);
      if (!/^HTTP\/1\.1 101/.test(got)) return reject(new Error(got.split('\r\n')[0]));
      const head = Buffer.alloc(14);
      head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); randomBytes(4).copy(head, 10);
      s.write(Buffer.concat([head, Buffer.alloc(sent, 0x61)]), () => resolve(st));
    });
    s.on('connect', () => s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  });
}

test('#3691: a socket that never finishes its message is not waited for past messageMs', async () => {
  const r = await startRelay({ port: 0, limits: { wsMessageMs: 400 } });
  try {
    const s = await unfinished(r.port, 120 * 1024, 100 * 1024);
    await pause(1500);
    console.log('#3691 FACTS one unfinished socket after 1.5 s (messageMs 400):', JSON.stringify({ closed: s.closed }));
    assert.equal(s.closed, true, 'a socket holding 100 KiB of an unfinished frame is still open after 1.5 s: the relay waits for it forever');
  } finally { await r.close(); }
});

test('#3691: many sockets holding unfinished frames are bounded by one budget, and an honest socket still talks', async () => {
  const r = await startRelay({ port: 0, limits: { wsBudget: 1024 * 1024, wsMessageMs: 60000 } });
  const held = [];
  try {
    for (let i = 0; i < 24; i++) held.push(await unfinished(r.port, 120 * 1024, 100 * 1024));
    await pause(300);
    const open = held.filter((s) => !s.closed).length;
    // an honest client: a REQ and its EOSE
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}`);
    await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); });
    const eose = await new Promise((ok) => { ws.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'EOSE') ok(x); }); ws.send(JSON.stringify(['REQ', 'a', { kinds: [0], limit: 1 }])); setTimeout(() => ok(null), 3000); });
    ws.close();
    console.log('#3691 FACTS 24 sockets x 100 KiB unfinished, budget 1 MiB:', JSON.stringify({ open, honestEose: !!eose }));
    assert.ok(eose, 'the honest REQ got no EOSE');
    assert.ok(open * 100 * 1024 <= 2 * 1024 * 1024, `${open} sockets still hold ${open * 100} KiB of unfinished frames, past the 1 MiB budget (and its reserve)`);
  } finally { for (const s of held) s.socket.destroy(); await r.close(); }
});
