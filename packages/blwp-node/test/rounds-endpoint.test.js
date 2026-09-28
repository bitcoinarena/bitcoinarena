// GET /rounds: EVERY ANNOUNCED ROUND, ITS TIMES, AND WHO IS RESPONSIBLE (the owner 2026-09-28 16:12, ROUNDS-EP-1612).
//
// On a bonded round both holders list it with its start and end as ISO-8601 UTC and its committees drawn from the
// census and the beacon - the same keys /committee answers and the round's own node list names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { toHex } from '../../protocol/src/hash.js';
import { roundEndMs } from '../../protocol/src/first-mark.js';

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
      assert.deepEqual([...union].sort(), w.c.nodes.map(toHex).sort(), 'the drawn committees are the round\'s own nodes');
      rows.push(row);
    }
    assert.deepEqual(rows[0].committee, rows[1].committee, 'both holders name the same committees');
    console.log(`  FACTS: ${JSON.stringify({ start: rows[0].startTime, end: rows[0].endTime, committee: rows[0].committee })}`);
  } finally { await w.close(); }
});
