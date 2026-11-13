// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-22 skeptic 3 (#1513, fair share of bda24f38e): the original fix promised a new event past a quota pushes out its
// author's OWN oldest, "never anyone else's". Fair share now makes room on a full relay from "the largest holder" - and the largest holder is
// the honest node (its badge definition and round results), not the stranger's one-event keys. So fresh free keys, one profile each, erase the
// node's badge definition (published once, never again) and its older round results.
// Adapted to 1.9 by #2536 (kanban #2079): 1.9's full relay makes room by fair share (#1943, #1983) and protects the authors in `keep`
// (ARENA_RELAY_KEEP, the seats' node keys, #2146 / #2214): a kept author's events are never given back for another author's write. The live
// relay sets it (2144-keep.conf: the census node keys, #2447). The same flood with the node's key kept, as the relay is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, publish } from './_r22-common.mjs';

test('#2079 (1.9, node kept) #1513 v1-refute-22-s3-1: strangers\' fresh keys on a full relay do not erase a node\'s badge definition and round results', async () => {
  const node = key();
  const r = await startRelay({ port: 0, keep: [node.pub], limits: { authorEvents: 10, totalEvents: 20 } });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    const mine = [ev(node, { kind: 30009, at: t0, tags: [['d', 'founder'], ['name', 'Founder']], content: '' })];
    for (let i = 1; i <= 4; i++) mine.push(ev(node, { kind: 30762, at: t0 + i, tags: [['d', `arena:result:r${i}`]], content: 'settled' }));
    assert.equal((await publish(r.port, mine, socks)).every((m) => m[2]), true);
    const spam = [];
    for (let k = 0; k < 20; k++) spam.push(ev(key(), { kind: 0, at: t0 + 10, content: '{"name":"x"}' }));
    await publish(r.port, spam, socks);
    const kept = new Set(r.events().map((e) => e.id));
    assert.deepEqual(mine.map((e) => [e.kind, e.tags[0][1], kept.has(e.id)]), mine.map((e) => [e.kind, e.tags[0][1], true]),
      'the node\'s own events, inside its quota, were erased by strangers\' new keys');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
