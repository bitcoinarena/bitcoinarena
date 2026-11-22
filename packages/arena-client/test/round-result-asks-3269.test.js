// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #3269 (measured in Chrome on the RPS page 2026-11-22: about 2,200 GET /api/round-result in 3 minutes, 1,058 of them 404): ARENA_GAME.result
// asked every listed seat on every call. Now a seat is asked once while its ask is out, its answer is kept (3 s unsigned, 60 s when it signs
// every entry), and a seat that answers nothing is asked again only after a growing pause. The page's own code, run against faked seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { door, honest, mine } from './wf1489-a45-refute-12-s3-common.js';
const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const host = (u) => new URL(u).origin;
const unsigned = { players: honest.players.map((p) => ({ ...p, outcome: null, score: null, signedBy: 0 })) };
const nodes = ['http://s1', 'http://s2', 'http://s3', 'http://s4'];
const count = (asked) => asked.reduce((m, s) => ({ ...m, [s]: (m[s] || 0) + 1 }), {});
const clock = (t) => { const real = Date.now; let now = real(); Date.now = () => now; t.after(() => { Date.now = real; }); return (ms) => { now += ms; }; };

test('#3269: ten result() calls in 2 s ask each seat at most once, the verdict unchanged', async (t) => {
  const tick = clock(t);
  // s3 has not ended the round (404), s4 holds it unsigned yet
  const { result, asked } = door(PAGE, { 'http://s1': honest, 'http://s2': honest, 'http://s4': unsigned }, nodes, host);
  const said = [];
  for (let i = 0; i < 10; i++) { said.push(await result('aa'.repeat(32))); tick(200); }
  const per = count(asked);
  console.log('  FACTS asks per seat over 10 calls in 2 s: ' + JSON.stringify(per));
  for (const n of nodes) assert.ok((per[n] || 0) <= 1, n + ' asked ' + per[n] + ' times');
  for (const g of said) { const me = g.entries.find((e) => e.entry === mine); assert.equal(me.outcome, 'DELIVERED'); assert.ok(me.signedBy > 0); }
});

test('#3269: ten calls at once share one ask per seat', async () => {
  const { result, asked } = door(PAGE, { 'http://s1': honest, 'http://s2': honest, 'http://s4': unsigned }, nodes, host);
  await Promise.all(Array.from({ length: 10 }, () => result('aa'.repeat(32))));
  for (const [n, c] of Object.entries(count(asked))) assert.equal(c, 1, n + ' asked ' + c + ' times');
});

test('#3269: a round not settled: each answer is asked again after 3 s, a 404 after 3 s, 6 s, then every 10 s', async (t) => {
  const tick = clock(t);
  const { result, asked } = door(PAGE, { 'http://s1': honest, 'http://s2': unsigned }, ['http://s1', 'http://s2', 'http://s3'], host);
  const at = async (ms) => { tick(ms); asked.length = 0; await result('aa'.repeat(32)); return count(asked); };
  assert.deepEqual(await at(0), { 'http://s1': 1, 'http://s2': 1, 'http://s3': 1 });
  assert.deepEqual(await at(1000), {}, 'nothing again within 3 s');
  assert.deepEqual(await at(2100), { 'http://s1': 1, 'http://s2': 1, 'http://s3': 1 }, 'after 3 s: every seat, the 404 once more');
  assert.deepEqual(await at(3100), { 'http://s1': 1, 'http://s2': 1 }, 'the 404 seat waits 6 s after its second miss');
  assert.deepEqual(await at(3100), { 'http://s1': 1, 'http://s2': 1, 'http://s3': 1 });
  assert.deepEqual(await at(9000), { 'http://s1': 1, 'http://s2': 1 }, 'then every 10 s');
  assert.deepEqual(await at(1100), { 'http://s3': 1 });
});

test('#3269: a round the seats settle and sign is not asked again for 60 s, its 404 seat neither', async (t) => {
  const tick = clock(t);
  const { result, asked } = door(PAGE, { 'http://s1': honest, 'http://s2': honest }, ['http://s1', 'http://s2', 'http://s3'], host);
  const at = async (ms) => { tick(ms); asked.length = 0; const g = await result('aa'.repeat(32)); assert.equal(g.entries.find((e) => e.entry === mine).outcome, 'DELIVERED'); return count(asked); };
  assert.deepEqual(await at(0), { 'http://s1': 1, 'http://s2': 1, 'http://s3': 1 });
  for (let i = 0; i < 5; i++) assert.deepEqual(await at(10000), {}, 'kept while settled');
  assert.deepEqual(await at(10100), { 'http://s1': 1, 'http://s2': 1, 'http://s3': 1 }, 'asked again after 60 s');
});
