// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute 4 of #1542/#1717/#1871/#1904 (honest path): the relay-wide bound drops "the client with the largest backlog",
// said to be "an unread socket, never one that reads". But a REQ answer is queued in one synchronous loop, so a client that reads
// at full speed holds its whole answer (minus what the kernel takes) as backlog for that moment. A stranger who spreads ~7 MB of
// unread backlog thinly over many sockets (each smaller than one honest answer) makes the honest reader the largest: it is the one
// cut off, the stranger's sockets stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const open = (port) => new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.on('open', () => r(ws)); });
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const sign = (sk, pk, i) => {
  const e = { pubkey: pk, created_at: Math.floor(Date.now() / 1000), kind: 30078, tags: [['d', `x${i}`]], content: `${i}:`.padEnd(60000, 'x') };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), sk));
  return e;
};
// the relay's own server-side sockets (same ws module), only to print their backlog
const srv = new Set();
const origSend = WebSocket.prototype.send;
WebSocket.prototype.send = function (...a) { if (this._isServer) srv.add(this); return origSend.apply(this, a); };
const backlog = () => [...srv].filter((s) => s.readyState === 1).map((s) => s.bufferedAmount);

async function seed(r, pubs, authors) {
  const pks = [];
  for (let a = 0; a < authors; a++) {
    const sk = new Uint8Array(32).fill(41 + a), pk = hex(schnorr.getPublicKey(sk)); pks.push(pk);
    const ws = await open(r.port); pubs.push(ws);
    let ok = 0; ws.on('message', (m) => { if (JSON.parse(String(m))[0] === 'OK') ok++; });
    for (let i = 0; i < 55; i++) ws.send(JSON.stringify(['EVENT', sign(sk, pk, i)]));
    for (let t = Date.now(); ok < 55 && Date.now() - t < 15000;) await sleep(20);
  }
  return pks;
}
const ask = (ws, sid, filter) => new Promise((res) => {
  let n = 0, end = null;
  ws.on('message', (m) => { const x = JSON.parse(String(m)); if (x[1] !== sid) return; if (x[0] === 'EVENT') n++; if (x[0] === 'EOSE' || x[0] === 'CLOSED') { end = x[0]; res({ n, end, closed: false }); } });
  ws.on('close', () => res({ n, end, closed: true }));
  ws.send(JSON.stringify(['REQ', sid, filter]));
  setTimeout(() => res({ n, end, closed: false, timeout: true }), 20000);
});

test('#2119 #1489-v1-refute-50-s4-1 a reading client is not the one dropped while a stranger spreads unread backlog thinly', async () => {
  const r = await startRelay({ port: 0 });
  const pubs = [];
  try {
    const [A, B] = await seed(r, pubs, 2);
    // control: alone, an honest reader gets its 50-event (~3 MB) answer in full
    const h0 = await open(r.port); pubs.push(h0);
    const alone = await ask(h0, 'h0', { authors: [A], limit: 50 });
    console.log(`  FACTS: alone the honest reader got ${alone.n} events, ${alone.end}, closed=${alone.closed}`);
    assert.equal(alone.n, 50);
    // the stranger: unread sockets, each asking for 30 events (~1.8 MB, partly taken by the kernel), until ~6.5 MB of unread backlog is held in total
    const slows = [];
    for (let k = 0; k < 40; k++) {
      const s = await open(r.port); pubs.push(s); slows.push(s);
      let gone = false; s.on('close', () => { gone = true; }); s.gone = () => gone;
      s._socket.pause();
      s.send(JSON.stringify(['REQ', 'q', { authors: [B], limit: 30 }]));
      await sleep(150);
      const b = backlog(); const sum = b.reduce((x, y) => x + y, 0);
      if (sum > 6.5e6) break;
    }
    const b = backlog();
    console.log(`  FACTS: ${slows.length} unread sockets, relay backlog ${(b.reduce((x, y) => x + y, 0) / 1e6).toFixed(2)} MB, largest ${(Math.max(...b) / 1e6).toFixed(2)} MB`);
    const h = await open(r.port); pubs.push(h);
    const got = await ask(h, 'h', { authors: [A], limit: 50 });
    await sleep(300);
    const alive = slows.filter((s) => !s.gone()).length;
    const relaySide = [...srv].filter((x) => x.readyState === 1).length;
    console.log(`  FACTS: relay-side sockets still open: ${relaySide} (the honest reader, the control, the two seeders and the unread ones it kept)`);
    console.log(`  FACTS: the honest reader got ${got.n} of 50 events, end=${got.end}, closed=${got.closed}; ${alive} of ${slows.length} unread sockets still open`);
    assert.ok(!got.closed && got.end === 'EOSE' && got.n === 50, `the relay dropped the client that reads (${got.n}/50, ${got.end}, closed=${got.closed}) and kept ${alive} unread sockets`);
  } finally { WebSocket.prototype.send = origSend; for (const w of pubs) w.terminate(); await r.close(); }
});
