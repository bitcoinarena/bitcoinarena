// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 25 (nostr): #2677 let a writer in on a relay filled by one-event-per-fresh-key spam only when it "held at most one
// before" (mine.n <= 2 after its own insert). Its test had a zap server holding ONE receipt. A live zap server holds many. With two or
// more receipts kept, step 2 finds no stranger holding more than it (each holds 1), the 1-1 rule does not apply (mine.n > 2), step 3 is
// for STATE only, so the receipt is refused 'blocked: the relay is full' - for good, nothing ages out. The same holds for any honest
// author with two or more LOG events.
// And the newcomer let in by #2677 is the "most recently arrived single-event holder", so the stranger's very next one-event write
// evicts it again: a new player's profile is kept for one stranger write.
// Safe: one-event-per-key spam neither shuts out an established zap server's receipts nor evicts a new player's profile at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, publish, open, ask } from './_r22-common.mjs';

test('#1489-r25-nostr-1 a zap server that already holds two receipts still gets its next one in after one-event-per-key spam', async () => {
  const node = key();
  const r = await startRelay({ port: 0, keep: [node.pub], limits: { totalEvents: 40 } });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    const zapServer = key(), payer = key(), player = key();
    const first = await publish(r.port, [ev(zapServer, { kind: 9735, at: t0, tags: [['p', payer.pub]] }),
      ev(zapServer, { kind: 9735, at: t0 + 1, tags: [['p', payer.pub]], content: 'y' })], socks);
    assert.ok(first.every((m) => m[2] === true));
    const spam = [];
    for (let i = 0; i < 38; i++) spam.push(ev(key(), i % 2 ? { kind: 8, at: t0 + 10 } : { kind: 0, at: t0 + 10, content: '{}' }));
    await publish(r.port, spam, socks);
    const [ok] = await publish(r.port, [ev(zapServer, { kind: 9735, at: t0 + 100, tags: [['p', player.pub]] })], socks);
    console.log(`  FACTS: zap server holding 2 receipts, 38 one-event strangers: third receipt ${JSON.stringify([ok[2], ok[3]])}`);
    assert.deepEqual([ok[2], ok[3]], [true, ''], 'the zap server\'s receipt is refused on a relay strangers filled with one event per key');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});

// kanban #2847: waits for a ruling (refuse newcomers under a flood, or keep #2677's newest-out rule); kept as a todo until then
test('#1489-r25-nostr-1b a new player\'s profile let in by #2677 is not evicted by the stranger\'s next one-event write', { todo: 'kanban #2847: ruled - the newcomer now pays proof of work on a full relay; covered by relay-standing-pow-2847.test.js' }, async () => {
  const r = await startRelay({ port: 0, limits: { totalEvents: 40 } });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    const player = key();
    const spam = [];
    for (let i = 0; i < 40; i++) spam.push(ev(key(), i % 2 ? { kind: 8, at: t0 + 10 } : { kind: 0, at: t0 + 10, content: '{}' }));
    await publish(r.port, spam, socks);
    const [ok] = await publish(r.port, [ev(player, { kind: 0, at: t0 + 100, content: '{"name":"new player"}' })], socks);
    assert.equal(ok[2], true, 'the #2677 rule lets the profile in');
    // the stranger's next fresh key, one event
    await publish(r.port, [ev(key(), { kind: 0, at: t0 + 101, content: '{}' })], socks);
    const ws = await open(r.port); socks.push(ws);
    const got = await ask(ws, ['REQ', 's', { kinds: [0], authors: [player.pub] }], (m) => m[0] === 'EOSE');
    const kept = got.filter((m) => m[0] === 'EVENT').length;
    console.log(`  FACTS: new profile kept after one more stranger write: ${kept}`);
    assert.equal(kept, 1, 'the new player\'s profile is evicted by the next one-event stranger write');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
