// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4-nostr-2: THE RELAY'S AUTHOR QUOTA DROPS A NODE'S BADGE DEFINITIONS FIRST.
// The #1513 quota keeps an author's newest AUTHOR_EVENTS (500) events and drops its oldest by created_at - "so a node's newest round
// results and badges are always kept". A node signs its NIP-58 badge definitions (kind 30009) dated BADGES_AT_S (2026-10-15) and
// publishes them ONCE (nostr_badge_defs.published_ms set, never sent again); every settled round adds a kind 30762 result dated its
// FINAL time and every award a kind 8 dated now. So the definitions are always that author's oldest events: after ~500 rounds the
// relay drops all four, and every award on it then names (`a` 30009:<node>:<d>) a definition nobody can read - no name, no image,
// in every Nostr client. Nothing republishes them.
// Safe: a node's badge definitions stay on the relay while it keeps publishing results and awards.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay } from '../src/nostr-relay.js';
import { buildDefinitionEvent, buildAwardEvent, BADGES_AT_S } from '../src/nostr-badges.js';
import { buildResultEvent } from '../src/nostr-results.js';
import { BADGES } from '../../arena-protocol/src/badges.js';

const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const put = (ws, e) => new Promise((x) => { const h = (raw) => { const a = JSON.parse(String(raw)); if (a[0] === 'OK' && a[1] === e.id) { ws.off('message', h); x(a); } }; ws.on('message', h); ws.send(JSON.stringify(['EVENT', e])); });

test('#1489 r4-nostr-2: a node\'s badge definitions are not pushed out by its own later results', async () => {
  // the live rule at a small scale: 10 events an author (live: 500)
  const r = await startRelay({ port: 0, limits: { authorEvents: 10 } });
  const ws = await open(r.port);
  try {
    const secret = schnorr.utils.randomSecretKey();
    const defs = BADGES.map((badge) => buildDefinitionEvent({ badge, secret }));
    for (const d of defs) assert.equal((await put(ws, d))[2], true);
    const player = Buffer.from(schnorr.getPublicKey(schnorr.utils.randomSecretKey())).toString('hex');
    const award = buildAwardEvent({ award: { d: BADGES[0].d, player, scope: 'nextblock', game: 'nextblock', evidence: { rounds: ['aa'.repeat(32)] } }, secret, atMs: Date.now() });
    assert.equal((await put(ws, award))[2], true);
    // ten settled rounds later (each one result, dated its FINAL time, after the catalogue's date)
    for (let i = 0; i < 10; i++) {
      const round = i.toString(16).padStart(64, '0');
      const e = buildResultEvent({ result: { round, game: { name: 'nextblock', id: 'cd'.repeat(32) }, finalMs: (BADGES_AT_S + 86400 * (i + 1)) * 1000, entries: [] }, secret });
      assert.equal((await put(ws, e))[2], true);
    }
    const kept = new Set(r.events().map((e) => e.id));
    const lost = defs.filter((d) => !kept.has(d.id)).map((d) => d.tags[0][1]);
    assert.deepEqual(lost, [], `the relay dropped the node's badge definitions ${lost.join(', ')}; the award still on it names ${award.tags[0][1]}`);
  } finally { ws.terminate(); await r.close(); }
});
