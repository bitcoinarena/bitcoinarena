// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT nostr a8-1-1 (gap in #3691): the standalone relay's unfinished-message budget is one first-come pool for every socket, and behind the
// tunnel every peer has the same address (the relay's own comment), so the per-address share is the whole budget and the small-message reserve is
// one address's half of it. One stranger who opens sockets that each send part of a frame and never its end fills the main budget and that
// address's reserve; from then on every honest socket that sends any frame (a REQ, a profile EVENT) is terminated at its first byte, for as long
// as the stranger renews his sockets (every messageMs, 15 s). SAFE: an honest small REQ from the same address is still answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { startRelay } from '../src/nostr-relay.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** A raw socket upgraded to a websocket, then the header of one masked text frame of `len` bytes and `sent` of its bytes - never the rest. */
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

test('audit nostr a8-1-1: one stranger\'s unfinished frames do not get every honest socket of the tunnel address terminated', async () => {
  const r = await startRelay({ port: 0 });   // the relay's own defaults: 16 MiB budget, 15 s per unfinished message
  const held = [];
  try {
    // FILL GREEDILY: sockets of one size until the relay refuses one (it is terminated at once), then smaller ones
    let sockets = 0;
    for (const sent of [120 * 1024, 8 * 1024, 512, 16]) {
      for (let i = 0; i < 400; i++) {
        const s = await unfinished(r.port, 128 * 1024 - 64, sent);
        held.push(s); sockets++;
        await pause(sent > 1024 ? 2 : 10);
        if (s.closed) break;
      }
    }
    await pause(200);
    const open = held.filter((s) => !s.closed).length;
    // an honest client from the same address (the tunnel): one small REQ, and its EOSE
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}`);
    await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); });
    let closed = false; ws.on('close', () => { closed = true; });
    const eose = await new Promise((ok) => { ws.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'EOSE') ok(x); });
      ws.send(JSON.stringify(['REQ', 'login', { kinds: [30078], authors: ['ab'.repeat(32)], limit: 1 }])); setTimeout(() => ok(null), 3000); });
    try { ws.close(); } catch { /* gone */ }
    console.log('a8-1-1 FACTS', JSON.stringify({ strangerSockets: sockets, strangerOpen: open, honestEose: !!eose, honestClosed: closed }));
    assert.ok(eose, `the honest REQ got no EOSE (its socket ${closed ? 'was terminated' : 'stayed silent'}) while one stranger holds ${open} sockets of unfinished frames`);
  } finally { for (const s of held) s.socket.destroy(); await r.close(); }
});
