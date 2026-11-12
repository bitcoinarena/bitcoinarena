// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-22 (#1513): when the relay is full, the total check runs BEFORE the replaceable drop, so an honest player's
// replacement of their own profile (kind 0) or a node's newer result under the same `d` (kind 30762) - which would not add a row -
// is refused "blocked: the relay is full". Strangers' free keys fill the total (128 keys x 4 MB = 512 MB) and then nobody can even
// update what they already have.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, publish } from './_r22-common.mjs';

test('#1513 v1-refute-22-2: a replacement that adds no row is not refused by a full relay', async () => {
  const r = await startRelay({ port: 0, limits: { authorEvents: 5, totalEvents: 22 } });
  const socks = [];
  try {
    const node = key(), player = key();
    const t0 = 1_700_000_000;
    const first = await publish(r.port, [ev(player, { kind: 0, at: t0, content: '{"name":"old"}' }),
      ev(node, { kind: 30762, at: t0, tags: [['d', 'arena:result:r1']], content: 'pending' })], socks);
    assert.deepEqual(first.map((m) => m[2]), [true, true]);
    // strangers' fresh keys fill the rest (4 keys x 5 events)
    const spam = [];
    for (let k = 0; k < 4; k++) { const s = key(); for (let i = 0; i < 5; i++) spam.push(ev(s, { at: t0 + 10 + i })); }
    await publish(r.port, spam, socks);
    const upd = await publish(r.port, [ev(player, { kind: 0, at: t0 + 100, content: '{"name":"new"}' }),
      ev(node, { kind: 30762, at: t0 + 100, tags: [['d', 'arena:result:r1']], content: 'settled' })], socks);
    assert.deepEqual(upd.map((m) => [m[2], m[3]]), [[true, ''], [true, '']], 'replacements refused on a full relay');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
