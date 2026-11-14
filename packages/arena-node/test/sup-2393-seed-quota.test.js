// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2393 (Daniel 2026-11-14: a separate quota for encrypted seeds): kind 30078 is counted against seedEvents / seedBytes alone.
// Strangers' seeds filling it refuse a further new seed, but never a node's result, and never push out an existing player's seed (#2447);
// a player replacing their own seed is still taken.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
let tick = Math.floor(Date.now() / 1000) - 500;
const ev = (k, kind, tags, content = 'x') => {
  const e = { pubkey: k.pub, created_at: tick++, kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s));
  return e;
};
const put = (ws, e) => new Promise((x) => { const h = (raw) => { const a = JSON.parse(String(raw)); if (a[0] === 'OK' && a[1] === e.id) { ws.off('message', h); x(a); } }; ws.on('message', h); ws.send(JSON.stringify(['EVENT', e])); });
const SEED = [['d', 'bitcoin-arena/seed']];

test('#2393 the seeds\' own quota: full of strangers it refuses a new seed, never a node result or an existing seed', async () => {
  const r = await startRelay({ port: 0, limits: { authorEvents: 5, totalEvents: 3, seedEvents: 5 } });
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}`); await new Promise((x) => ws.on('open', x));
  try {
    const player = key(), node = key();
    assert.equal((await put(ws, ev(player, 30078, SEED, 'mine')))[2], true);
    for (let i = 0; i < 4; i++) assert.equal((await put(ws, ev(key(), 30078, SEED, 'junk')))[2], true);
    const late = await put(ws, ev(key(), 30078, SEED, 'junk'));
    assert.deepEqual([late[2], late[3]], [false, 'blocked: the relay is full']);
    for (let i = 0; i < 3; i++) assert.equal((await put(ws, ev(node, 30762, [['d', `arena:result:${i}`]], '{"v":1}')))[2], true, 'a node result beside a full seed quota');
    const again = ev(player, 30078, SEED, 'mine, newer');
    assert.equal((await put(ws, again))[2], true, 'a player replaces their own seed');
    const kept = r.events();
    assert.equal(kept.filter((x) => x.kind === 30078).length, 5);
    assert.ok(kept.some((x) => x.id === again.id));
    assert.equal(kept.filter((x) => x.kind === 30762).length, 3);
  } finally { ws.terminate(); await r.close(); }
});
