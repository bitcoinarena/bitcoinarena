// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (nostr, 2026-11-14): #2393 closed the "one event per fresh key" off switch for the SEEDS only (kind 30078 got its own
// quota). The same off switch still works for every other non-kept author: a stranger fills the relay's TOTAL (by count) with ONE tiny event
// under each of many fresh keys. Then nobody holds more than anybody, fair share (#1943) has nothing to take, and
//   - a NEW player's profile (kind 0: the name the lobby shows, the lud16 a zap goes to) is refused 'blocked: the relay is full' (step 3 finds
//     no own older STATE event), for good - nothing ever ages out;
//   - the zap server's next receipt (kind 9735, LOG, its key is no seat key so it is not in `keep`) is refused too: it already holds one
//     receipt, so no stranger holds more than it (step 2), and a LOG event never rolls its own out (step 4).
// Safe: strangers' one-per-key spam does not lock a new player's profile or an honest zap receipt out of the relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, publish } from './_r22-common.mjs';

test('#1489-r2-nostr-11 one tiny event per fresh key does not shut a new player\'s profile or a zap receipt out', async () => {
  const node = key();
  const r = await startRelay({ port: 0, keep: [node.pub], limits: { totalEvents: 40 } });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    const zapServer = key(), player = key(), payer = key();
    // the zap server already published one receipt; the node one result
    const first = await publish(r.port, [ev(zapServer, { kind: 9735, at: t0, tags: [['p', payer.pub]] }),
      ev(node, { kind: 30762, at: t0, tags: [['d', 'arena:result:r1']], content: 'settled' })], socks);
    assert.ok(first.every((m) => m[2] === true));
    // the stranger: 38 fresh keys, ONE tiny event each - half profiles (STATE), half kind 8 (LOG): the total (40 events) is full
    const spam = [];
    for (let i = 0; i < 38; i++) spam.push(ev(key(), i % 2 ? { kind: 8, at: t0 + 10 } : { kind: 0, at: t0 + 10, content: '{}' }));
    await publish(r.port, spam, socks);
    const honest = [
      ev(player, { kind: 0, at: t0 + 100, content: '{"name":"new player","lud16":"me@wallet.example"}' }),
      ev(zapServer, { kind: 9735, at: t0 + 100, tags: [['p', player.pub]] }),
      ev(node, { kind: 30762, at: t0 + 100, tags: [['d', 'arena:result:r2']], content: 'settled' }),
    ];
    const oks = await publish(r.port, honest, socks);
    const said = oks.map((m) => [m[2], m[3]]);
    console.log(`  FACTS: after 38 one-event fresh keys: new profile ${JSON.stringify(said[0])}, zap receipt ${JSON.stringify(said[1])}, node result ${JSON.stringify(said[2])}`);
    assert.deepEqual(said[2], [true, ''], 'the kept node still gets in');
    assert.deepEqual(said[0], [true, ''], 'a new player\'s profile is refused on a relay strangers filled with one event per key');
    assert.deepEqual(said[1], [true, ''], 'the zap server\'s receipt is refused on a relay strangers filled with one event per key');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
