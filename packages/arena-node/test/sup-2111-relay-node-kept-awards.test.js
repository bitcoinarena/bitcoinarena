// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-22 skeptic 3 (#1513, fair share of bda24f38e): the LOG pool the same way - a node's badge awards (regular events,
// "each kept", how a player's badges are found by #p) are the largest LOG holding, so strangers' fresh keys posting one kind 8 each on a full
// relay erase the players' badge awards one by one.
// Adapted to 1.9 by #2536 (kanban #2111): 1.9's full relay makes room by fair share (#1943, #1983) and protects the authors in `keep`
// (ARENA_RELAY_KEEP, the seats' node keys, #2146 / #2214): a kept author's events are never given back for another author's write. The live
// relay sets it (2144-keep.conf: the census node keys, #2447). The same flood with the node's key kept, as the relay is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, publish } from './_r22-common.mjs';

test('#2111 (1.9, node kept) #1513 v1-refute-22-s3-2: strangers\' fresh keys on a full relay do not erase players\' badge awards', async () => {
  const node = key();
  const r = await startRelay({ port: 0, keep: [node.pub], limits: { authorEvents: 10, totalEvents: 20 } });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    const awards = [];
    for (let i = 0; i < 5; i++) awards.push(ev(node, { kind: 8, at: t0 + i, tags: [['a', `30009:${node.pub}:founder`], ['p', key().pub]] }));
    assert.equal((await publish(r.port, awards, socks)).every((m) => m[2]), true);
    const spam = [];
    for (let k = 0; k < 20; k++) spam.push(ev(key(), { kind: 8, at: t0 + 10 }));
    await publish(r.port, spam, socks);
    const kept = new Set(r.events().map((e) => e.id));
    assert.equal(awards.filter((e) => kept.has(e.id)).length, 5, 'players\' badge awards erased by strangers\' new keys');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
