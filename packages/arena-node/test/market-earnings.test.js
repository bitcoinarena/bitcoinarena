// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A SEAT EARNED IN THE MARKETS (kanban #600): each ACCEPTED settlement of a market round read once - its `signer node` payouts to
// this seat's payout key summed and kept -, a round that is no market kept as such and never read, at most `perPass` plans a pass; the
// dashboard counts them as "other" income in the day, month, total and under their game.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { createMarketEarnings } from '../src/market-earnings.js';
import { dashboardData } from '../src/dashboard.js';
import { HOSTED } from './plugins/hosted.js';

const ME = '02' + 'aa'.repeat(32), OTHER = '02' + 'bb'.repeat(32), GAME = new Uint8Array(32).fill(7);
const NOW = Date.UTC(2026, 9, 23, 18);

test('market rounds read once, this seat\'s payouts summed and kept; other rounds skipped; counted on the dashboard', async () => {
  const db = openStore();
  const settle = db.prepare('INSERT INTO lock_settlements (round_id, txid, message, signature, state, why, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const rid = (n) => new Uint8Array(32).fill(n);
  settle.run(Buffer.from(rid(1)), 't1', Buffer.from([1]), Buffer.from([1]), 'ACCEPTED', '', NOW - 3600000);
  settle.run(Buffer.from(rid(2)), 't2', Buffer.from([1]), Buffer.from([1]), 'ACCEPTED', '', NOW - 7200000);
  settle.run(Buffer.from(rid(3)), 't3', Buffer.from([1]), Buffer.from([1]), 'ACCEPTED', '', NOW - 60000);   // a game round
  settle.run(Buffer.from(rid(4)), 't4', Buffer.from([1]), Buffer.from([1]), 'REFUSED', 'x', NOW - 60000);
  const asked = [];
  const me = createMarketEarnings({ db, ownPayoutHex: ME, perPass: 1,
    marketOf: (r) => (r[0] === 3 ? null : { gameId: GAME }),
    summaryOf: async (r) => { asked.push(r[0]); return { payouts: [{ kind: 'signer node', pk: ME, msat: String(1000 * r[0]) }, { kind: 'signer node', pk: OTHER, msat: '999' },
      { kind: 'qualifier', pk: ME, msat: '50000' }] }; } });
  assert.deepEqual(await me.pass(), { read: 1, kept: 1 }, 'one plan a pass');
  assert.deepEqual(await me.pass(), { read: 1, kept: 1 });
  assert.deepEqual(await me.pass(), { read: 0, kept: 0 }, 'each round read once; the game round never');
  assert.deepEqual(asked.sort(), [1, 2]);
  const rows = me.rows().sort((a, b) => a.madeMs - b.madeMs);
  assert.deepEqual(rows.map((x) => [x.msat, x.game]), [[2000n, '07'.repeat(32)], [1000n, '07'.repeat(32)]], 'only its own signer node payouts');
  const d = dashboardData(new Round(db, () => NOW, { plugins: HOSTED }), { nowMs: NOW, marketRows: rows, apps: new Map([['07'.repeat(32), { name: 'btc-updown-15m' }]]) });
  assert.equal(d.totals.day.otherMsat, '3000'); assert.equal(d.totals.month.otherMsat, '3000'); assert.equal(d.totals.total.otherMsat, '3000');
  const g = d.byGame.find((x) => x.game === '07'.repeat(32));
  assert.deepEqual([g.name, g.rounds, g.earned.otherMsat, g.month.otherMsat], ['btc-updown-15m', 2, '3000', '3000']);
  assert.equal(d.days[d.days.length - 1].otherMsat, '3000', 'in today\'s row');
});
