// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-22 skeptic 2 (#1513, the #1769 fix): a node already AT its own event quota publishes the next round's result;
// its own oldest rolls out (no new row, dn = 0) - but when the new result is longer than the one rolled out (it names more players), dbytes > 0 and a relay strangers filled by bytes refuses it. A node that holds only its own quota cannot keep
// publishing its results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, publish } from './_r22-common.mjs';

test('#1513 v1-refute-22-s2-2: a node rolling its own oldest out is kept on a relay strangers filled by bytes', async () => {
  const r = await startRelay({ port: 0, limits: { authorEvents: 3, totalBytes: 12000 } });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    const node = key();
    const res = (i, extra = '', content = 'settled') => ev(node, { kind: 30762, at: t0 + i, tags: [['d', `arena:result:r${i}${extra}`]], content });
    const mine = await publish(r.port, [res(1), res(2), res(3)], socks);
    assert.deepEqual(mine.map((m) => m[2]), [true, true, true]);
    // strangers fill the bytes with fresh keys until refused
    let full = false;
    for (let k = 0; k < 40 && !full; k++) { const s = key(); const oks = await publish(r.port, [ev(s, { at: t0 + 10, content: 'y'.repeat(300) })], socks); full = oks[0][2] === false; }
    assert.ok(full, 'the relay is full');
    // the node's next result names more players (a longer content): its own oldest (r1) goes, no new row, the node stays inside its own quota
    const next = await publish(r.port, [res(4, '', JSON.stringify({ settled: true, players: Array.from({ length: 12 }, (_, i) => String(i).repeat(64)) }))], socks);
    assert.deepEqual(next.map((m) => [m[2], m[3]]), [[true, '']], 'a node inside its own quota refused');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
