// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// GET /rounds?games= (kanban #1391, Daniel 2026-11-09 "Make sure it is everything fast"): a game screen asks only its game's rounds; unnamed, every game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('games= lists only the named games\' rounds; unnamed or malformed, every round as before', async () => {
  const w = await lockRound();
  try {
    const d = w.a; d.round.now = () => Number(w.c.committeeTimeMs) + 1;
    const ids = async (q) => (await (await fetch(`http://127.0.0.1:${d.port}/rounds${q}`)).json()).rounds.map((r) => r.id);
    const rid = toHex(w.rid), game = toHex(w.c.gameId), other = 'ab'.repeat(32);
    assert.ok((await ids('?next=8')).includes(rid), 'unnamed: listed');
    assert.ok((await ids(`?next=8&games=${game}`)).includes(rid), 'its own game named: listed');
    assert.ok((await ids(`?next=8&games=${other},${game.toUpperCase()}`)).includes(rid), 'among others, any case: listed');
    assert.ok(!(await ids(`?next=8&games=${other}`)).includes(rid), 'another game named: not listed');
    assert.ok((await ids('?next=8&games=nothex')).includes(rid), 'nothing well-formed named: every game');
  } finally { await w.close(); }
});
