// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1943, #1983 (#1489 v1-refute-22-s2): the full relay makes room by fair share in BOTH pools - strangers' free keys filling the total
// with STATE events (seeds under many `d`s) do not shut a new player's profile out, and LOG spam does not shut a node's next badge award out;
// what goes is the largest holders' oldest (the strangers'), and the honest authors' own events stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, publish } from './_r22-common.mjs';

test('#1943 #1983: state or log spam from free keys - honest new events kept, the honest authors keep theirs', async () => {
  const r = await startRelay({ port: 0, limits: { authorEvents: 5, totalEvents: 20 } });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    const node = key(), player = key(), old = key();
    assert.equal((await publish(r.port, [ev(old, { kind: 0, at: t0, content: '{"name":"old"}' }), ev(node, { kind: 8, at: t0, tags: [['p', old.pub]] })], socks)).every((m) => m[2]), true);
    const spam = [];
    for (let k = 0; k < 5; k++) { const s = key(); for (let i = 0; i < 5; i++) spam.push(ev(s, { kind: 30078, at: t0 + 10 + i, tags: [['d', `junk${i}`]] })); }
    for (let k = 0; k < 2; k++) { const s = key(); for (let i = 0; i < 5; i++) spam.push(ev(s, { kind: 8, at: t0 + 10 + i })); }
    await publish(r.port, spam, socks);
    const honest = [ev(player, { kind: 0, at: t0 + 100, content: '{"name":"new"}' }), ev(node, { kind: 8, at: t0 + 100, tags: [['p', player.pub]] })];
    const oks = await publish(r.port, honest, socks);
    assert.deepEqual(oks.map((m) => [m[2], m[3]]), [[true, ''], [true, '']]);
    const kept = r.events();
    // kanban #2393: the seeds (kind 30078) are counted against a quota of their own, not the total
    assert.ok(kept.filter((x) => x.kind !== 30078).length <= 20, `${kept.length} kept`);
    for (const e of honest) assert.ok(kept.some((x) => x.id === e.id));
    assert.equal(kept.filter((x) => x.pubkey === old.pub).length, 1, 'an earlier player keeps their profile');
    assert.equal(kept.filter((x) => x.pubkey === node.pub).length, 2, 'the node keeps its earlier award');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
