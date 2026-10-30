// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// GET /rounds: EVERY ANNOUNCED ROUND, ITS TIMES, AND WHO IS RESPONSIBLE (2026-09-28 16:12, ROUNDS-EP-1612).
//
// On a bonded round both holders list it with its start and end as ISO-8601 UTC and its committees drawn from the
// census and the beacon - the same keys /committee answers and the round's own node list names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { LOSER } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';

const committeeAt = async (d, rid, role) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/committee?round=${toHex(rid)}&role=${role}`);
  assert.equal(r.status, 200, await r.clone().text());
  const b = new Uint8Array(await r.arrayBuffer());
  return Array.from({ length: b.length / 32 }, (_, i) => toHex(b.subarray(i * 32, i * 32 + 32)));
};

test('each holder lists the round with ISO start and end and the drawn committees, the ones /committee answers', async () => {
  const w = await lockRound();
  try {
    for (const d of [w.a, w.b]) d.round.now = () => Number(w.c.committeeTimeMs) + 1;   // announced, not ended
    const rows = [];
    for (const d of [w.a, w.b]) {
      const listed = await (await fetch(`http://127.0.0.1:${d.port}/rounds`)).json();
      const row = listed.rounds.find((r) => r.id === toHex(w.rid));
      assert.ok(row, 'the round is listed');
      assert.equal(row.startTime, new Date(Number(w.c.startTimeMs)).toISOString());
      assert.equal(row.endTime, new Date(Number(roundEndMs(w.c))).toISOString(), 'the end is the round\'s own end');
      assert.equal(row.committee.drawn, true, row.committee.why);
      assert.deepEqual(row.committee.settlement, await committeeAt(d, w.rid, 'settlement'));
      assert.deepEqual(row.committee.game, await committeeAt(d, w.rid, 'game'));
      const union = new Set([...row.committee.game, ...row.committee.settlement]);
      // §5A.9 overlap_count, published: the seats in both committees
      assert.equal(row.committee.overlapCount, row.committee.game.filter((k) => row.committee.settlement.includes(k)).length);
      assert.deepEqual([...union].sort(), w.c.nodes.map(toHex).sort(), 'the drawn committees are the round\'s own nodes');
      rows.push(row);
    }
    assert.deepEqual(rows[0].committee, rows[1].committee, 'both holders name the same committees');
    console.log(`  FACTS: ${JSON.stringify({ start: rows[0].startTime, end: rows[0].endTime, committee: rows[0].committee })}`);
  } finally { await w.close(); }
});

// ROUNDS-HTML-1617: /rounds is a page for a browser and the list for a fetch; a played, closed round moves from
// upcoming to finished, and its result names who played, what the signer nodes signed, and what was won.
test('a browser gets the rounds page; a finished round lists its players, outcomes and winnings', async () => {
  const w = await lockRound();
  try {
    for (const d of [w.a, w.b]) d.round.now = () => Number(w.c.committeeTimeMs) + 1;
    const base = `http://127.0.0.1:${w.a.port}`;
    const page = await fetch(`${base}/rounds`, { headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    // THE PAGE IS REACT'S (kanban #564, 87c84753): its upcoming and finished sections are drawn by /rounds/react.js (arena-web's
    // rounds test), so the page served here is the one that loads it and reads the node's own data for it (rounds-page.test.js)
    assert.match(html, /\/rounds\/react\.js/); assert.match(html, /api\/rounds/); assert.match(html, /api\/round-result/);
    const list = await fetch(`${base}/rounds`);
    assert.match(list.headers.get('content-type'), /application\/json/, 'a fetch still gets the list');

    const before = await (await fetch(`${base}/api/rounds`)).json();
    assert.ok(before.upcoming.some((r) => r.id === toHex(w.rid)), 'announced: upcoming');
    assert.ok(!before.finished.some((r) => r.id === toHex(w.rid)));

    const played = await lockAndPlay(w, LOSER);
    for (const d of [w.a, w.b]) d.round.close(w.rid);
    const after = await (await fetch(`${base}/api/rounds`)).json();
    const fin = after.finished.find((r) => r.id === toHex(w.rid));
    assert.ok(fin, 'closed: finished');
    assert.ok(!after.upcoming.some((r) => r.id === toHex(w.rid)), 'and no longer upcoming');
    assert.equal(fin.startTime, new Date(Number(w.c.startTimeMs)).toISOString());
    assert.equal(fin.committee.drawn, true);
    const res = await (await fetch(`${base}/api/round-result?round=${toHex(w.rid)}`)).json();
    assert.equal(res.players.length, 1);
    assert.equal(res.players[0].entry, toHex(played.eid));
    assert.ok('outcome' in res.players[0] && 'wonMsat' in res.players[0] && 'winningsState' in res.players[0]);
    console.log(`  FACTS: ${JSON.stringify({ finished: fin, result: res })}`);
  } finally { await w.close(); }
});
