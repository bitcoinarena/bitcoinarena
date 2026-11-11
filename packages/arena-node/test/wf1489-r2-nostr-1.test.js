// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (nostr): a subscriber that stops reading must not make the relay buffer without bound. The relay
// fans each event out to every matching subscription with ws.send and never looks at bufferedAmount, so one socket with
// 20 catch-all subscriptions that never reads turns every 60 KB event anyone sends (ephemeral ones too, never stored) into
// 20 queued copies in the relay's memory. Safe: a subscriber whose backlog passes a bound is dropped (or its copies are).
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sk = new Uint8Array(32).fill(7), pk = hex(schnorr.getPublicKey(sk));
const sign = (i) => {
  const e = { pubkey: pk, created_at: Math.floor(Date.now() / 1000), kind: 24133, tags: [['p', pk]], content: `${i}:`.padEnd(60000, 'x') };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), sk));
  return e;
};
const open = (port) => new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.on('open', () => r(ws)); });

test('#1489-r2-nostr-1 a stalled subscriber is not fed without bound (20 copies of every 60 KB event)', async () => {
  const r = await startRelay({ port: 0 });
  const slow = await open(r.port), fast = await open(r.port);
  try {
    let got = 0, eose = 0;
    slow.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'EVENT') got += String(m).length; if (x[0] === 'EOSE') eose++; });
    for (let i = 0; i < 20; i++) slow.send(JSON.stringify(['REQ', `s${i}`, { kinds: [24133] }]));
    for (let t = Date.now(); eose < 20 && Date.now() - t < 3000;) await new Promise((x) => setTimeout(x, 10));
    slow._socket.pause();                              // the attacker stops reading
    const oks = [];
    fast.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'OK') oks.push(x); });
    for (let i = 0; i < 50; i++) fast.send(JSON.stringify(['EVENT', sign(i)]));
    for (let t = Date.now(); oks.length < 50 && Date.now() - t < 10000;) await new Promise((x) => setTimeout(x, 20));
    slow._socket.resume();
    let last = -1;
    for (let t = Date.now(); Date.now() - t < 8000 && got !== last; ) { last = got; await new Promise((x) => setTimeout(x, 500)); }
    console.log(`  FACTS: ${oks.length} events taken, ${(got / 1e6).toFixed(1)} MB queued for one stalled subscriber and delivered after it resumed`);
    assert.ok(got < 16e6, `the relay held ${(got / 1e6).toFixed(1)} MB for one socket that did not read`);
  } finally { slow.terminate(); fast.terminate(); await r.close(); }
});
