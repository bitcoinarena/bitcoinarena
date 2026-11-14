// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2641: the Week 2 draw - a member of Telegram, Discord or Armada enters once per report key; the seed is the first Bitcoin block whose header
// time is after the week's end (a block stamped exactly at the end does not count).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason, seasonEndMs, SEASON_MS } from '../src/bounty-season.js';
import { seedBlockAfter } from '../tools/bounty-draw.mjs';

const K = (n) => n.toString(16).padStart(64, '0');
const rep = (n, pubkey) => ({ id: `d${n}`.padEnd(64, '0'), pubkey });

test('#2641 draw entries: one per key in any of Telegram / Discord / Armada; none without; a shared account counts for the first key only', async () => {
  const s = openBountySeason();
  const link = (k, p, id, name) => { assert.equal(s.claimName(k, p, { userId: id, username: name }).ok, true); };
  link(K(1), 'telegram', 't1', '@all3'); link(K(1), 'discord', 'd1', 'all3'); link(K(1), 'armada', 'a'.repeat(64), 'npub1all3');
  link(K(2), 'armada', 'b'.repeat(64), 'npub1onlyarmada');
  link(K(3), 'x', 'x3', 'xonly');
  link(K(4), 'telegram', 't4', '@first');
  assert.equal(s.claimName(K(5), 'telegram', { userId: 't4', username: '@first' }).ok, false, 'the same Telegram account for a second key');
  const yes = { telegram: async () => ({ member: true }), discord: async () => ({ member: true }), armada: async () => ({ member: true }), x: async () => ({ member: true }) };
  for (let n = 1; n <= 5; n++) { await s.verify(K(n), yes); const r = rep(n, K(n)); s.commit(r, s.plan(r, { level: 'low' })); }
  const r1b = rep(11, K(1)); s.commit(r1b, s.plan(r1b, { level: 'medium' }));
  assert.deepEqual(s.drawEntries(2), ['armada:npub1onlyarmada', 'telegram:@all3', 'telegram:@first'],
    'K1 (all three, two reports) once; K2 by Armada alone; K3 only X: none; K4 once; K5 holds no account: none');
});

test('#2641 the week ends 7 days after its start', () => {
  const start = Date.parse('2026-11-14T07:12:35Z');
  assert.equal(new Date(seasonEndMs(2, start)).toISOString(), '2026-11-21T07:12:35.000Z');
  assert.equal(seasonEndMs(3, start), start + 2 * SEASON_MS); assert.equal(seasonEndMs(2, null), null);
});

test('#2641 the seed block: the first header time after the end; exactly at the end does not count; out-of-order times', async () => {
  const end = Date.parse('2026-11-21T07:12:35Z'), E = end / 1000;
  // heights 0..39: 10 minutes apart, ending around the end, with an out-of-order stamp and a block exactly at the end
  const times = Array.from({ length: 40 }, (_, h) => E - (30 - h) * 600);
  times[30] = E;            // exactly at the end: not after it
  times[31] = E - 120;      // stamped earlier than its parent (allowed): still not after
  times[32] = E + 1;        // the first after the end
  times[33] = E + 400;
  const chain = { tip: async () => 39, hashAt: async (h) => `h${h}`, timeOf: async (hash) => times[Number(hash.slice(1))] };
  assert.deepEqual(await seedBlockAfter(end, chain), { height: 32, hash: 'h32', time: E + 1 });
  const short = { ...chain, tip: async () => 31 };
  assert.equal(await seedBlockAfter(end, short), null, 'no block after the end yet');
  times[25] = E + 50;       // an earlier block stamped after the end (within the margin) is the first one
  assert.equal((await seedBlockAfter(end, chain)).height, 25);
});

test('#2641 the open-issues list holds our own audit cards too, by area and number only', async () => {
  const { openIssueAreas } = await import('../src/bounty-season.js');
  const l = openIssueAreas([{ id: 2700, title: 'Audit [high] Season account signature leaves out bot mark: unsigned', status: 'todo', tags: [] },
    { id: 2701, title: 'State machine (settle, retry) double payout window', status: 'todo', tags: [] },
    { id: 2702, title: 'Polish the lobby colours', status: 'todo', tags: ['UX'] }, { id: 2703, title: 'Audit [low] fixed thing', status: 'done', tags: [] }]);
  const all = l.areas.flatMap((a) => a.tickets);
  assert.deepEqual(all.sort(), ['#2700', '#2701']);
  assert.equal(JSON.stringify(l).includes('signature'), false, 'never a title');
});
