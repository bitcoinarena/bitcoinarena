// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 5 (nostr): BYPASS OF #1542. A client that does not read is dropped only in fanOut (live events); the answer to
// a REQ goes out through send(), which never looks at bufferedAmount. One socket that stops reading sends REQ {kinds:[8],limit:500}
// again and again: each one queues up to 500 stored events (64 KB each, ~30 MB) in the relay's memory, 60 REQs per 10 s per socket,
// any number of sockets. The stored events cost nothing: fresh keys, each within its own author quota.
// Safe: a client whose unsent backlog passes SLOW_BYTES is cut off on the REQ path too.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const open = (port) => new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.on('open', () => r(ws)); });
const sign = (sk, i) => {
  const e = { pubkey: hex(schnorr.getPublicKey(sk)), created_at: Math.floor(Date.now() / 1000) - i, kind: 8, tags: [], content: `${i}:`.padEnd(60000, 'x') };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), sk));
  return e;
};

test('#1489-r5-nostr-4 REQ answers to a socket that does not read are not queued without bound', async () => {
  const r = await startRelay({ port: 0 });
  const socks = [];
  try {
    // 10 fresh keys x 50 events of 60 KB (3 MB each, under the 4 MB author quota), one socket each (under the 60-message budget)
    let oks = 0;
    await Promise.all(Array.from({ length: 10 }, async (_, a) => {
      const ws = await open(r.port); socks.push(ws);
      const sk = new Uint8Array(32).fill(a + 1);
      ws.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'OK' && x[2] === true) oks++; });
      for (let i = 0; i < 50; i++) ws.send(JSON.stringify(['EVENT', sign(sk, i)]));
    }));
    for (let t = Date.now(); oks < 500 && Date.now() - t < 30000;) await new Promise((x) => setTimeout(x, 50));
    const slow = await open(r.port); socks.push(slow);
    let got = 0, eose = 0, notice = null;
    slow.on('message', (m) => { const s = String(m); const x = JSON.parse(s); if (x[0] === 'EVENT') got += s.length; if (x[0] === 'EOSE') eose++; if (x[0] === 'NOTICE') notice = x[1]; });
    slow._socket.pause();                                 // the attacker stops reading
    for (let i = 0; i < 10; i++) slow.send(JSON.stringify(['REQ', `q${i}`, { kinds: [8], limit: 500 }]));
    await new Promise((x) => setTimeout(x, 3000));
    slow._socket.resume();
    let last = -1;
    for (let t = Date.now(); Date.now() - t < 20000 && (got !== last || eose < 10); ) { last = got; await new Promise((x) => setTimeout(x, 500)); if (got === last && slow.readyState !== 1) break; }
    console.log(`  FACTS: ${oks} events stored; ${(got / 1e6).toFixed(1)} MB of REQ answers queued for one socket that did not read, ${eose} EOSE, notice ${notice}`);
    assert.ok(got < 16e6, `the relay held ${(got / 1e6).toFixed(1)} MB of REQ answers for one socket that did not read`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
