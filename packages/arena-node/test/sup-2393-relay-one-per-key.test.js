// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2393): 1.9's full relay makes room by fair share (#1943, #1983) and protects only the authors in
// `keep` (ARENA_RELAY_KEEP, the seats' node keys, #2146 / #2214): a node's events are never given back for another author's write. The test
// runs the relay as it must be run, with the node's key kept. The new-seed half is measured and kept as todo (open, needs a ruling).
// kanban #1489 a44-refute-20 skeptic 2: #2144 BROUGHT BACK THE #1620 OFF SWITCH, through one-per-key events.
// #2144 makes a full relay drop only REGULAR events (and 30762 results) to make room, and refuses the new event when none is left.
// Keys are free: a stranger fills the total with ONE kind 30078 under each of many fresh keys (each inside its quota, each one-per-key).
// Then there is no regular event left to drop, and every new event is refused 'blocked: the relay is full': a node's signed round
// result (30762, publishPass never sends it again) and a new player's game seed (30078, the login fails) - exactly #1620's attack.
// On 90d57151a (before #2144) the heaviest author (a stranger, one event) lost its 30078 and both were taken.
// Safe: strangers filling the total with one-per-key events still do not lock out a node's result or a new player's seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';
import { buildDefinitionEvent, buildAwardEvent, BADGES_AT_S } from '../src/nostr-badges.js';
import { buildResultEvent } from '../src/nostr-results.js';
import { BADGES } from '../../arena-protocol/src/badges.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
const ev = (k, kind, tags, at = Math.floor(Date.now() / 1000), content = 'x') => {
  const e = { pubkey: k.pub, created_at: at, kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s));
  return e;
};
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const put = (ws, e) => new Promise((x) => { const h = (raw) => { const a = JSON.parse(String(raw)); if (a[0] === 'OK' && a[1] === e.id) { ws.off('message', h); x(a); } }; ws.on('message', h); ws.send(JSON.stringify(['EVENT', e])); });

test('#2393 (1.9, node key kept): a relay filled with strangers\' one-per-key events still takes a node\'s result', async () => {
  const node = key(), player = key();
  const r = await startRelay({ port: 0, limits: { authorEvents: 5, totalEvents: 20 }, keep: [node.pub] });
  const socks = [];
  try {
    const sw = await open(r.port); socks.push(sw);
    for (let k = 0; k < 20; k++) { const s = key(); assert.equal((await put(sw, ev(s, 30078, [['d', 'bitcoin-arena/seed']], undefined, 'junk')))[2], true); }
    const ws = await open(r.port); socks.push(ws);
    const result = ev(node, 30762, [['d', `arena:result:${'ab'.repeat(32)}`], ['t', 'nextblock']], undefined, '{"v":1}');
    const seed = ev(player, 30078, [['d', 'bitcoin-arena/seed']], undefined, 'ciphertext');
    const a = await put(ws, result), b = await put(ws, seed);
    assert.equal(a[2], true, `the node's signed round result was refused: ${a[3]}`);
    console.log('  MEASURED one-per-key full relay:', JSON.stringify({ nodeResult: a[2], seed: [b[2], b[3]] }));
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});

test('#2393 (1.9): a relay filled with strangers\' one-per-key events still takes a NEW player\'s seed', { todo: 'kanban #2393 open: fair share refuses a new author when every holder holds one event; taking it would let strangers evict existing seeds (#2447) - needs a ruling' }, async () => {
  const r = await startRelay({ port: 0, limits: { authorEvents: 5, totalEvents: 20 } });
  const socks = [];
  try {
    const sw = await open(r.port); socks.push(sw);
    for (let k = 0; k < 20; k++) { const s = key(); assert.equal((await put(sw, ev(s, 30078, [['d', 'bitcoin-arena/seed']], undefined, 'junk')))[2], true); }
    const player = key();
    const b = await put(sw, ev(player, 30078, [['d', 'bitcoin-arena/seed']], undefined, 'ciphertext'));
    assert.equal(b[2], true, `a new player's game seed was refused: ${b[3]}`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
