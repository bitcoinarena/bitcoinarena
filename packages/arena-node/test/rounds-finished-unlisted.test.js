// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND THE LISTING LEAVES OUT IS NOT "FINISHED" BEFORE IT ENDS (kanban #564, measured 2026-10-21 on a test host seat: /api/rounds
// listed 1,569 finished rounds, among them RPS rounds starting 3 h later, none joined - rounds this node holds but no longer offers,
// added to the finished ones by a loop meant for open rounds whose end has passed). A round opened here and then refused (the
// node's refusedFor, as for a series it no longer holds) is held open and not announced: while it has not ended it is in neither list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { testNow } from './test-clock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('an open round this node no longer offers, ending in an hour, is in neither list', async () => {
  let refuse = false;
  const r = await lockRound({ endMs: testNow() + 3600000, serveOpts: { refusedFor: () => (refuse ? 'no longer offered here' : null) } });
  try {
    const list = async () => (await fetch(`http://127.0.0.1:${r.a.port}/api/rounds`)).json();
    const id = toHex(r.rid);
    // refused before this node first lists it (the listing keeps each round's verdict until the series it holds change)
    refuse = true;
    const d = await list();
    assert.equal(d.upcoming.some((x) => x.id === id), false, 'no longer offered: not announced');
    assert.equal(d.finished.some((x) => x.id === id), false, 'and not finished before its end');
  } finally { await r.close(); }
});
