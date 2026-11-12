// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1542: the slow-subscriber bound sits only in the EVENT fan-out (fanOut). The REQ answer goes through send(),
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

test('#1489-v1-refute-50 a stalled socket sending REQs is not fed without bound', async () => {
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
    const slow = await open(r.port); pubs.push(slow);
    let got = 0, eose = 0;
    slow.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'EVENT') got += String(m).length; if (x[0] === 'EOSE') eose++; });
    slow._socket.pause();                                  // the attacker stops reading, then asks
    for (let i = 0; i < 10; i++) slow.send(JSON.stringify(['REQ', `q${i}`, { kinds: [30078], limit: 500 }]));
    await new Promise((x) => setTimeout(x, 3000));
    slow._socket.resume();
    let last = -1;
    for (let t = Date.now(); Date.now() - t < 20000 && got !== last;) { last = got; await new Promise((x) => setTimeout(x, 700)); }
    console.log(`  FACTS: ${r.events().length} stored, ${eose} EOSE, ${(got / 1e6).toFixed(1)} MB queued for one socket that did not read`);
    assert.ok(got < 16e6, `the relay held ${(got / 1e6).toFixed(1)} MB for one socket that did not read (REQ door)`);
  } finally { for (const w of pubs) w.terminate(); await r.close(); }
});
