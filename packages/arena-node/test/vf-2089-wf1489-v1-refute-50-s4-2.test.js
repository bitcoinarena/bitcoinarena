// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute 4 of #1871/#1904 (honest path, no attacker): TOTAL_SLOW_BYTES (8 MB) is two answers' worth. A REQ answer is
// queued in one synchronous loop, so a few honest readers asking at the same moment (a page load, a reconnect after a relay
// restart) hold more than 8 MB unsent together for a moment, and the relay-wide shed cuts one of them off although every one reads.
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

test('#1489-v1-refute-50-s4-2 honest readers asking at the same moment all get their answer', async () => {
  const r = await startRelay({ port: 0 });
  const pubs = [];
  try {
    const pks = [];
    for (let a = 0; a < 2; a++) {
      const sk = new Uint8Array(32).fill(61 + a), pk = hex(schnorr.getPublicKey(sk)); pks.push(pk);
      const ws = await open(r.port); pubs.push(ws);
      let ok = 0; ws.on('message', (m) => { if (JSON.parse(String(m))[0] === 'OK') ok++; });
      for (let i = 0; i < 55; i++) ws.send(JSON.stringify(['EVENT', sign(sk, pk, i)]));
      for (let t = Date.now(); ok < 55 && Date.now() - t < 15000;) await sleep(20);
    }
    const N = 6;
    const hs = []; for (let i = 0; i < N; i++) { const h = await open(r.port); pubs.push(h); hs.push(h); }
    const results = await Promise.all(hs.map((h, i) => new Promise((res) => {
      let n = 0;
      h.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'EVENT') n++; if (x[0] === 'EOSE' || x[0] === 'CLOSED') res({ n, end: x[0] }); });
      h.on('close', () => res({ n, end: 'socket closed' }));
      setTimeout(() => res({ n, end: 'timeout' }), 30000);
      h.send(JSON.stringify(['REQ', 's', { authors: [pks[i % 2]], limit: 50 }]));
    })));
    console.log(`  FACTS: ${N} honest readers asked at once: ${results.map((x) => `${x.n}/${x.end}`).join(', ')}`);
    assert.ok(results.every((x) => x.n === 50 && x.end === 'EOSE'), `honest readers were cut: ${results.map((x) => `${x.n}/${x.end}`).join(', ')}`);
  } finally { for (const w of pubs) w.terminate(); await r.close(); }
});
