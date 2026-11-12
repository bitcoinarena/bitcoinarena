// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-22 skeptic 2 (#1513): many free keys (a stranger, not one key) fill the relay's TOTAL, and from then on every
// honest NEW event is refused "blocked: the relay is full" - a node's round result for the next round (a new `d`, so a new row), a new
// player's profile and game seed. Nothing ever ages out, so a retry later, or after a relay restart (the total is re-read from disk),
// is refused again: the relay is shut to the game for good by keys that cost nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRelay } from '../src/nostr-relay.js';
import { key, ev, publish } from './_r22-common.mjs';

test('#1513 v1-refute-22-s2-1: strangers\' free keys filling the total do not shut honest new events out (also after retry and restart)', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'r22s2-')), 'relay.db');
  const limits = { authorEvents: 5, totalEvents: 20 };
  let r = await startRelay({ port: 0, dbPath, limits });
  const socks = [];
  const t0 = Math.floor(Date.now() / 1000) - 1000;
  const node = key(), player = key();
  try {
    // the node already has one result on the relay
    const first = await publish(r.port, [ev(node, { kind: 30762, at: t0, tags: [['d', 'arena:result:r1']], content: 'settled' })], socks);
    assert.equal(first[0][2], true);
    // a stranger: 4 fresh keys x 5 events (each key inside its own quota) - the relay is full
    const spam = [];
    for (let k = 0; k < 4; k++) { const s = key(); for (let i = 0; i < 5; i++) spam.push(ev(s, { at: t0 + 10 + i })); }
    await publish(r.port, spam, socks);
    const honest = [ev(node, { kind: 30762, at: t0 + 100, tags: [['d', 'arena:result:r2']], content: 'settled' }),
      ev(player, { kind: 0, at: t0 + 100, content: '{"name":"new player"}' }),
      ev(player, { kind: 30078, at: t0 + 100, tags: [['d', 'arena:seed']], content: 'nip44...' })];
    const now = await publish(r.port, honest, socks);
    // retry the same events, then restart the relay on the same store and retry again
    const retry = await publish(r.port, honest, socks);
    for (const w of socks.splice(0)) w.terminate();
    await r.close();
    r = await startRelay({ port: 0, dbPath, limits });
    const afterRestart = await publish(r.port, honest, socks);
    const why = (oks) => oks.map((m) => [m[2], m[3]]);
    assert.deepEqual({ now: why(now), retry: why(retry), afterRestart: why(afterRestart) },
      { now: why(now).map(() => [true, '']), retry: why(now).map(() => [true, '']), afterRestart: why(now).map(() => [true, '']) },
      'honest new events refused on a relay strangers filled');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
