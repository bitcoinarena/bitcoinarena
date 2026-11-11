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

test('compact=1 says a drawn committee as drawn: true and keeps both committees; without it the drawn keys as before', async () => {
  const w = await lockRound();
  try {
    const d = w.a; d.round.now = () => Number(w.c.committeeTimeMs) + 1;
    const row = async (q) => (await (await fetch(`http://127.0.0.1:${d.port}/rounds${q}`)).json()).rounds.find((r) => r.id === toHex(w.rid));
    const full = await row('?next=8'), compact = await row('?next=8&compact=1');
    assert.ok(full.committee.drawn, 'drawn');   // the keys where reserve seats seat ({ game, settlement }), else true
    assert.equal(compact.committee.drawn, true, 'compact: drawn, without the keys');
    assert.deepEqual(compact.committee.game, full.committee.game); assert.deepEqual(compact.committee.settlement, full.committee.settlement);
    assert.equal(compact.sig, full.sig, 'the signed facts are the same');
    assert.deepEqual((await row('?next=8')).committee.drawn, full.committee.drawn, 'the kept committee was not changed by the compact answer');
  } finally { await w.close(); }
});
