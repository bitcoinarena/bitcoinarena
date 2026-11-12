// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 5 (nostr): #1543 made a REQ an indexed SQL read, but every EVENT is still matched in JS against EVERY
// filter of EVERY subscription of EVERY socket (fs.some(matches) in the fan-out), and matches() runs e.tags.some(... vals.includes)
// - tags x values per filter. A stranger opens a few free sockets, each with 20 subscriptions of 10 filters naming 500 tag values
// that never match, then sends one 60 KB event with ~2000 tags: each EVENT costs sockets x 200 x 2000 x 500 string compares,
// synchronously, on the relay's one event loop (NIP-46 signing, NWC payments, logins wait). 60 such events per 10 s per socket.
// Safe: one EVENT does not hold the relay's event loop for seconds; another client's REQ is answered promptly.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
const sign = (k, e0) => { const e = { pubkey: k.pub, created_at: Math.floor(Date.now() / 1000), ...e0 }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s)); return e; };
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const ask = (ws, m, until) => new Promise((x) => { const got = []; const h = (raw) => { const a = JSON.parse(String(raw)); got.push(a); if (until(a)) { ws.off('message', h); x(got); } }; ws.on('message', h); ws.send(JSON.stringify(m)); });

test('r5-nostr-2: one event against many wide subscriptions does not stall the relay', async () => {
  const r = await startRelay({ port: 0 });
  const socks = [];
  try {
    const vals = Array.from({ length: 500 }, (_, i) => `v${String(i).padStart(18, '0')}`);
    const filter = { kinds: [8], '#a': vals };
    for (let s = 0; s < 8; s++) {
      const ws = await open(r.port); socks.push(ws);
      for (let i = 0; i < 20; i++) {
        const got = await ask(ws, ['REQ', `s${i}`, ...Array(10).fill(filter)], (m) => m[0] === 'EOSE' || m[0] === 'CLOSED');
        assert.equal(got.at(-1)[0], 'EOSE');
      }
    }
    const tags = Array.from({ length: 2000 }, (_, i) => ['a', `w${String(i).padStart(18, '0')}`]);
    const e = sign(key(), { kind: 8, tags, content: '' });
    console.log('size', JSON.stringify(e).length); assert.ok(JSON.stringify(e).length < 64 * 1024);
    const attacker = await open(r.port); socks.push(attacker);
    const honest = await open(r.port); socks.push(honest);
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) attacker.send(JSON.stringify(['EVENT', sign(key(), { kind: 8, tags, content: String(i) })]));
    await new Promise((x) => setTimeout(x, 5));
    await ask(honest, ['REQ', 'h', { kinds: [0], limit: 1 }], (m) => m[0] === 'EOSE');
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `an honest REQ waited ${ms} ms behind five strangers' events`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
