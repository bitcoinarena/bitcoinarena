// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-nostr-3: THE RELAY IS NOT ANYBODY'S DISK.
// startRelay keeps every regular event of its kinds (kind 8 badge awards, kind 9735 zap receipts) and every parameterized one under a
// new `d` (30078, 30762, 30009) for good, with no quota per author and none in total; its only limit is 60 messages per 10 s PER
// SOCKET, and sockets are not limited. One stranger key (free to make) opens a few sockets and stores as many events as it likes, up
// to 64 KB each; every later REQ walks the whole table (stored(): all.iterate() + JSON.parse per row, per filter).
// Safe: one author cannot keep more than a bounded number of events (here: the relay's own max_limit, 500).
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const secret = schnorr.utils.randomSecretKey();
const pubkey = hex(schnorr.getPublicKey(secret));
const ev = (i) => {
  const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: 8, tags: [['p', pubkey], ['n', String(i)]], content: 'x'.repeat(1000) };
  e.id = eventId(e);
  e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  return e;
};

test('#1489 r1-nostr-3: one stranger key cannot store an unbounded number of events on the relay', async () => {
  const r = await startRelay({ port: 0 });
  const socks = [];
  try {
    const N = 660, PER = 55;          // 12 sockets, 55 events each: under each socket's own budget of 60
    let n = 0;
    for (let s = 0; n < N; s++) {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}`);
      socks.push(ws);
      await new Promise((x) => ws.on('open', x));
      let oks = 0;
      const done = new Promise((x) => ws.on('message', (m) => { const a = JSON.parse(String(m)); if (a[0] === 'OK' && ++oks === PER) x(); }));
      for (let i = 0; i < PER; i++) ws.send(JSON.stringify(['EVENT', ev(n++)]));
      await done;
    }
    const kept = r.events().filter((e) => e.pubkey === pubkey).length;
    assert.ok(kept <= 500, `one fresh key kept ${kept} events of ~1 KB (any number, up to 64 KB each, through more sockets)`);
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
