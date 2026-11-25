// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT nostr a8-1-2 (the #3691 fix does not hold): messageBudget counts a socket's bytes as they arrive (a 'data' listener put before ws's) and
// gives ALL of them back - and clears the unfinished-message timer - on ws's next 'message'. ws parses a chunk synchronously, so one TCP read
// (up to 64 KiB) that holds a whole small message followed by ~60 KiB of a 120 KiB frame is counted, then released by the small message's 'message' event: the
// unfinished frame that follows is held by ws with no charge against the budget and no deadline. Many such sockets pin N x 120 KiB of the relay's
// memory for as long as they stay open, past wsBudget and wsMessageMs. SAFE: such a socket is still timed out and the budget still holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { startRelay } from '../src/nostr-relay.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (payload) => { const k = randomBytes(4); const out = Buffer.from(payload); for (let i = 0; i < out.length; i++) out[i] ^= k[i % 4]; return [k, out]; };

/** One write: a whole small masked text frame, then the header of a masked text frame of `len` bytes and `sent` of them - never the rest. */
function smuggled(port, len, sent) {
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
      const [k, small] = mask(Buffer.from(JSON.stringify(['CLOSE', 'x'])));
      const whole = Buffer.concat([Buffer.from([0x81, 0x80 | small.length]), k, small]);
      const head = Buffer.alloc(14);
      head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); randomBytes(4).copy(head, 10);
      s.write(Buffer.concat([whole, head, Buffer.alloc(sent, 0x61)]), () => resolve(st));
    });
    s.on('connect', () => s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  });
}

test('audit nostr a8-1-2: an unfinished frame sent right after a whole message is still timed out (messageMs)', async () => {
  const r = await startRelay({ port: 0, limits: { wsMessageMs: 400 } });
  try {
    const s = await smuggled(r.port, 120 * 1024, 60 * 1024);
    await pause(1500);
    console.log('a8-1-2 FACTS one socket, whole message + 60 KiB unfinished, after 1.5 s (messageMs 400):', JSON.stringify({ closed: s.closed }));
    assert.equal(s.closed, true, 'the socket still holds 60 KiB of an unfinished frame after 1.5 s: the relay waits for it forever');
  } finally { await r.close(); }
});

test('audit nostr a8-1-2: such sockets are bounded by the unfinished-message budget', async () => {
  const r = await startRelay({ port: 0, limits: { wsBudget: 1024 * 1024, wsMessageMs: 60000 } });
  const held = [];
  try {
    for (let i = 0; i < 40; i++) held.push(await smuggled(r.port, 120 * 1024, 60 * 1024));
    await pause(500);
    const open = held.filter((s) => !s.closed).length;
    console.log('a8-1-2 FACTS 40 sockets x (whole message + 60 KiB unfinished), budget 1 MiB:', JSON.stringify({ open, heldKiB: open * 60 }));
    assert.ok(open * 60 * 1024 <= 2 * 1024 * 1024, `${open} sockets still hold ${open * 60} KiB of unfinished frames, past the 1 MiB budget (and its reserve)`);
  } finally { for (const s of held) s.socket.destroy(); await r.close(); }
});
