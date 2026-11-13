// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2144): 1.9's full relay makes room by fair share (#1943, #1983) and protects only the authors in
// `keep` (ARENA_RELAY_KEEP, the seats' node keys, #2146 / #2214): a node's events are never given back for another author's write. The test
// runs the relay as it must be run, with the node's key kept.
// kanban #1489 a44-refute-20 (re-check of #1621): A STRANGER STILL PUSHES OUT A NODE'S BADGE DEFINITIONS, through the #1620 door.
// #1621 made the author quota evict a node's regular events and round results before its one-per-key events (its 30009 badge
// definitions), "so its badge definitions are always kept". But #1620 added a second eviction: on a full relay a replaceable or
// parameterized event from ANY key makes room by dropping the oldest event of the author holding the most. A busy node (500 events:
// results + awards) is that heaviest author, so a stranger who filled the total with small keys then sends kind 30078 under fresh
// keys (one each, free) and every one of them takes one of the node's events: its results and awards first, then all four badge
// definitions. Nothing republishes them; the awards left anywhere name definitions nobody can read.
// Safe: a stranger's events never push out a node's badge definitions.
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

test('#2144 (1.9, node key kept): strangers on a full relay do not push out a node\'s badge definitions', async () => {
  // small scale: 10 events an author, 20 in total (live: 500 and 200,000)
  const secret = schnorr.utils.randomSecretKey();
  const r = await startRelay({ port: 0, limits: { authorEvents: 10, totalEvents: 20 }, keep: [hex(schnorr.getPublicKey(secret))] });
  const socks = [];
  try {
    const ws = await open(r.port); socks.push(ws);
    const defs = BADGES.map((badge) => buildDefinitionEvent({ badge, secret }));
    for (const d of defs) assert.equal((await put(ws, d))[2], true);
    const player = hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
    const award = buildAwardEvent({ award: { d: BADGES[0].d, player, scope: 'nextblock', game: 'nextblock', evidence: { rounds: ['aa'.repeat(32)] } }, secret, atMs: Date.now() });
    assert.equal((await put(ws, award))[2], true);
    for (let i = 0; i < 10 - defs.length - 1; i++) {   // the node's settled rounds: it now holds its full quota (10)
      const round = i.toString(16).padStart(64, '0');
      const e = buildResultEvent({ result: { round, game: { name: 'nextblock', id: 'cd'.repeat(32) }, finalMs: (BADGES_AT_S + 86400 * (i + 1)) * 1000, entries: [] }, secret });
      assert.equal((await put(ws, e))[2], true);
    }
    // the stranger fills the rest of the total with small keys (2 regular events each), every one inside its own quota
    for (let k = 0; k < 5; k++) { const s = key(); for (let i = 0; i < 2; i++) assert.equal((await put(ws, ev(s, 8, [['p', s.pub], ['n', String(i)]])))[2], true); }
    // then one kind 30078 under each of 30 fresh keys
    const sw = await open(r.port); socks.push(sw);
    for (let k = 0; k < 30; k++) { const s = key(); await put(sw, ev(s, 30078, [['d', 'x']])); }
    const kept = new Set(r.events().map((e) => e.id));
    const lost = defs.filter((d) => !kept.has(d.id)).map((d) => d.tags[0][1]);
    assert.deepEqual(lost, [], `strangers' events pushed out the node's badge definitions ${lost.join(', ')}`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
