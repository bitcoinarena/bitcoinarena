// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RELAY'S UNFINISHED-MESSAGE BUDGET IS NOT FIRST COME, FIRST SERVED (kanban #3734, audit nostr a8-1-1, a gap in #3691). It is one pool for every
// socket, and behind the tunnel every peer has one address, so the per-address shares do not help. A stranger whose sockets each hold part of
// a frame filled the budget and the reserve, and from then on every honest socket that sent a message in more than one read (a slow link, a
// profile EVENT cut by TCP) was ended at its first bytes. Now a message that finds the budget full ends the sockets whose unfinished messages
// began first, not itself. audit-nostr-a8-1-1 sends the honest REQ in one read, which #3733 already lets through. Here it is cut over reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { startRelay } from '../src/nostr-relay.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (payload) => { const k = randomBytes(4); const out = Buffer.from(payload); for (let i = 0; i < out.length; i++) out[i] ^= k[i % 4]; return [k, out]; };
const frame = (text) => {
  const [k, body] = mask(Buffer.from(text)); const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, 0x80 | n]) : Buffer.from([0x81, 0x80 | 126, n >> 8, n & 0xff]);
  return Buffer.concat([head, k, body]);
};

/** a raw upgraded socket; `send(buf)` is one write (one read on loopback); `text` what came back after the upgrade */
function raw(port) {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1');
    const st = { closed: false, socket: s, text: '', send: (b) => new Promise((r) => s.write(b, r)) };
    s.on('close', () => { st.closed = true; });
    s.on('error', () => { st.closed = true; });
    let got = '';
    s.on('data', function first(d) {
      got += d.toString('latin1');
      if (!got.includes('\r\n\r\n')) return;
      s.off('data', first);
      if (!/^HTTP\/1\.1 101/.test(got)) return reject(new Error(got.split('\r\n')[0]));
      s.on('data', (x) => { st.text += x.toString('latin1'); });
      resolve(st);
    });
    s.on('connect', () => s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  });
}
const startOf = (len, sent) => { const h = Buffer.alloc(14); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); randomBytes(4).copy(h, 10); return Buffer.concat([h, Buffer.alloc(sent, 0x61)]); };

/** fill greedily, as the audit did: sockets of one size until the relay refuses one, then smaller ones */
async function fill(port, held) {
  for (const sent of [120 * 1024, 8 * 1024, 512, 16]) {
    for (let i = 0; i < 400; i++) {
      const s = await raw(port); held.push(s); s.sent = sent;
      await s.send(startOf(128 * 1024 - 64, sent));
      await pause(sent > 1024 ? 2 : 10);
      if (s.closed) break;
    }
  }
  await pause(200);
}
const req = (id) => frame(JSON.stringify(['REQ', id, { kinds: [30078], authors: ['ab'.repeat(32)], limit: 1 }]));
const eoseOf = async (s, id, ms = 3000) => { for (let t = 0; t < ms; t += 50) { if (s.text.includes(`"EOSE","${id}"`)) return true; if (s.closed) return false; await pause(50); } return false; };

test('#3734: with the budget full of a stranger\'s unfinished frames, an honest REQ cut over three reads is still answered', async () => {
  const r = await startRelay({ port: 0 });   // the relay's defaults: 16 MiB budget, 15 s per unfinished message
  const held = [];
  try {
    await fill(r.port, held);
    const open = held.filter((s) => !s.closed).length;
    assert.ok(open > 100, `the stranger holds the budget (${open} sockets)`);
    const honest = await raw(r.port);
    const m = req('login');
    // three reads: the first two (60 bytes each) are held and must be charged; the last ends the message
    await honest.send(m.subarray(0, 60)); await pause(60);
    await honest.send(m.subarray(60, 120)); await pause(60);
    await honest.send(m.subarray(120));
    const eose = await eoseOf(honest, 'login');
    console.log('#3734 FACTS', JSON.stringify({ strangerOpen: open, honestEose: eose, honestClosed: honest.closed }));
    assert.ok(eose, `the honest REQ got no EOSE (its socket ${honest.closed ? 'was ended' : 'stayed silent'}) while a stranger holds ${open} sockets of unfinished frames`);
    honest.socket.destroy();
  } finally { for (const s of held) s.socket.destroy(); await r.close(); }
});

test('#3734: a stranger\'s new unfinished frames end his own older ones, not an honest message in flight; the budget still holds', async () => {
  const r = await startRelay({ port: 0 });   // 16 MiB budget, 4 MiB reserve (one address 2 MiB): 170 x 120 KiB is past both
  const held = [];
  try {
    // the budget full of 120 KiB frames, then an honest REQ begun, then 1.8 MiB more of the stranger's frames while it is in flight
    for (let i = 0; i < 170; i++) { const s = await raw(r.port); held.push(s); s.sent = 120 * 1024; await s.send(startOf(128 * 1024 - 64, s.sent)); await pause(2); }
    await pause(100);
    assert.ok(held.slice(0, 10).every((s) => s.closed), 'a newcomer that finds the budget full ends the oldest unfinished messages');
    assert.equal(held.at(-1).closed, false, 'the newcomer itself is kept');
    const honest = await raw(r.port);
    const m = frame(JSON.stringify(['REQ', 'slow', { kinds: [30078], authors: ['cd'.repeat(32)], limit: 1, '#d': ['x'.repeat(3000)] }]));
    await honest.send(m.subarray(0, 1500)); await pause(30);
    for (let i = 0; i < 30; i++) { const s = await raw(r.port); held.push(s); s.sent = 60 * 1024; await s.send(startOf(128 * 1024 - 64, s.sent)); await pause(2); }
    await pause(100);
    assert.equal(honest.closed, false, 'the honest message in flight was ended by the stranger\'s newer frames');
    await honest.send(m.subarray(1500));
    assert.ok(await eoseOf(honest, 'slow'), 'the honest REQ was answered');
    const kept = held.filter((s) => !s.closed).reduce((a, s) => a + s.sent, 0);
    assert.ok(kept <= 20 * 1024 * 1024, `the stranger's open sockets hold ${kept >> 10} KiB: past the 16 MiB budget and its reserve`);
    honest.socket.destroy();
  } finally { for (const s of held) s.socket.destroy(); await r.close(); }
});
