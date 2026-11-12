// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute 2 (reload path) of #1542/#1717: the bound is per socket only. A stranger reconnects (a reload, a retry) and keeps
// every old socket open and unread: each one holds ~4.7 MB, 20 sockets ~94 MB, with no total bound over all clients.
// (original note) refute of #1542: the slow-subscriber bound sits only in the EVENT fan-out (fanOut). The REQ answer goes through send(),
// which never looks at bufferedAmount: a socket that stops reading and sends REQs for stored events makes the relay queue every stored
// match again for each REQ (up to 500 per filter, 64 KB each), with no drop. Same effect as #1542 through another door.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const open = (port) => new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.on('open', () => r(ws)); });
const sign = (sk, pk, i) => {
  const e = { pubkey: pk, created_at: Math.floor(Date.now() / 1000), kind: 30078, tags: [['d', `x${i}`]], content: `${i}:`.padEnd(60000, 'x') };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), sk));
  return e;
};

test('#1489-v1-refute-50-s2-2 reconnecting sockets that do not read are not fed without a total bound', async () => {
  const r = await startRelay({ port: 0 });
  const pubs = [];
  try {
    // 4 authors x 55 stored 60 KB events (each author under its 4 MB / 60-message budget): ~13 MB stored
    for (let a = 0; a < 4; a++) {
      const sk = new Uint8Array(32).fill(11 + a), pk = hex(schnorr.getPublicKey(sk));
      const ws = await open(r.port); pubs.push(ws);
      let ok = 0; ws.on('message', (m) => { if (JSON.parse(String(m))[0] === 'OK') ok++; });
      for (let i = 0; i < 55; i++) ws.send(JSON.stringify(['EVENT', sign(sk, pk, i)]));
      for (let t = Date.now(); ok < 55 && Date.now() - t < 15000;) await new Promise((x) => setTimeout(x, 20));
    }
    let got = 0;
    const slows = [];
    for (let k = 0; k < 20; k++) {
      const slow = await open(r.port); pubs.push(slow); slows.push(slow);
      slow.on('message', (m) => { if (JSON.parse(String(m))[0] === 'EVENT') got += String(m).length; });
      slow._socket.pause();
      slow.send(JSON.stringify(['REQ', 'q', { kinds: [30078], limit: 500 }]));
    }
    await new Promise((x) => setTimeout(x, 4000));
    for (const s of slows) s._socket.resume();
    let last = -1;
    for (let t = Date.now(); Date.now() - t < 30000 && got !== last;) { last = got; await new Promise((x) => setTimeout(x, 700)); }
    console.log(`  FACTS: ${r.events().length} stored, ${(got / 1e6).toFixed(1)} MB queued for 20 sockets of one stranger that did not read`);
    assert.ok(got < 32e6, `the relay held ${(got / 1e6).toFixed(1)} MB for 20 unread sockets of one stranger (reload door)`);
  } finally { for (const w of pubs) w.terminate(); await r.close(); }
});
