// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2393): 1.9's full relay makes room by fair share (#1943, #1983) and protects only the authors in
// `keep` (ARENA_RELAY_KEEP, the seats' node keys, #2146 / #2214): a node's events are never given back for another author's write. The test
// runs the relay as it must be run, with the node's key kept.
// kanban #1489 a44-refute-20 skeptic 2: ONE STRANGER KEY, RE-SENT, STILL EATS A NODE'S BADGE AWARDS.
// #2144 keeps a node's 30009 definitions on a full relay, but a replaceable/parameterized event still drops the oldest REGULAR event
// of the heaviest author - a busy node's kind 8 awards (published once: nostr-badges publish marks them done, never sent again).
// One stranger key needs no fresh keys: it sends kind 30078 under new `d` values; each one, while the relay is full, drops one of the
// node's awards, and only then does the stranger's own quota drop the stranger's own oldest 30078 - so the total stays full and the
// next one takes the next award (live: up to 500 a key, keys free). The definitions survive, but every player's award is gone.
// Safe: a stranger's one-per-key events on a full relay do not push out a node's badge awards.
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

test('#2393 (1.9, node key kept) s2-2: one stranger key\'s 30078s on a full relay do not push out a node\'s awards', async () => {
  const secret = schnorr.utils.randomSecretKey();
  const r = await startRelay({ port: 0, limits: { authorEvents: 10, totalEvents: 20 }, keep: [hex(schnorr.getPublicKey(secret))] });
  const socks = [];
  try {
    const ws = await open(r.port); socks.push(ws);
    const defs = BADGES.map((badge) => buildDefinitionEvent({ badge, secret }));
    for (const d of defs) assert.equal((await put(ws, d))[2], true);
    const awards = [];
    for (let i = 0; i < 10 - defs.length; i++) {
      const player = hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
      const a = buildAwardEvent({ award: { d: BADGES[0].d, player, scope: 'nextblock', game: 'nextblock', evidence: { rounds: ['aa'.repeat(32)] } }, secret, atMs: Date.now() + i });
      assert.equal((await put(ws, a))[2], true); awards.push(a);
    }
    const sw = await open(r.port); socks.push(sw);
    for (let k = 0; k < 4; k++) { const s = key(); for (let i = 0; i < 2; i++) assert.equal((await put(sw, ev(s, 8, [['p', s.pub], ['n', String(i)]])))[2], true); }
    const s = key();
    for (let i = 0; i < 2; i++) assert.equal((await put(sw, ev(s, 30078, [['d', `x${i}`]])))[2], true);   // the total is now 20 of 20
    for (let i = 2; i < 12; i++) await put(sw, ev(s, 30078, [['d', `x${i}`]]));   // one key, ten new d values
    const kept = new Set(r.events().map((e) => e.id));
    const lost = awards.filter((a) => !kept.has(a.id)).length;
    assert.equal(lost, 0, `one stranger key sending 30078s under new d values pushed out ${lost} of the node's ${awards.length} badge awards (relay holds ${kept.size} of 20)`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
