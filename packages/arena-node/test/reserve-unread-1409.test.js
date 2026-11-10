// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1409 (audit 5 #1399): a seat holds the contracts of about half the rounds but imports every verified reserve row from its peers; since
// #1336 a row whose round it could not read was dropped - co-signers refused the plan ("no unspent reserve output of this seat") and a coordinator
// that read none of them wrote a terminal SHORT though the federation held enough. The rows are wired as server.js wires them: through
// reserveRowsOfNetwork with each seat's own reading of the rounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYOUT, reserveRowsOfNetwork } from '../src/reserve-payout.js';
import { world, PROPOSAL } from './reserve-payout-fixture.js';

const NET = '10'.repeat(32), OTHER = 'ee'.repeat(32);
const MSAT = [60000000n, 40000000n, 50000000n];
const raw = MSAT.map((m, i) => ({ outpoint: `${String(i + 1).padStart(2, '0').repeat(32)}:0`, amountMsat: String(m), verifiedMs: i + 1, roundId: String(i + 1).padStart(2, '0').repeat(32) }));
// `reads(i)`: which rounds seat i holds (round id -> network), as round.contractOf answers there
const wired = (reads) => (i) => ({ reserveRows: () => reserveRowsOfNetwork(raw, NET, (rid) => reads(i)[rid] || null)
  .map((r) => ({ outpoint: r.outpoint, amountMsat: r.amountMsat, verifiedMs: r.verifiedMs, ...(r.unknown ? { unknown: true } : {}) })) });
const all = Object.fromEntries(raw.map((r) => [r.roundId, NET]));

test('#1409 co-signers that hold none of the rounds still sign the coordinator\'s plan: PAID on all 7', async () => {
  const w = world({ more: wired((i) => (i === 0 ? all : {})) });
  const [r] = await w.seats[0].api.round({ height: 500 });
  await w.deliver();
  const states = w.seats.map((s) => (s.api.stateOf(PROPOSAL) || {}).state);
  console.log(`  MEASURED #1409: coordinator reads all 3 rounds, 6 co-signers none: ${r.state || r.why}; states ${states.join(',')}; payments ${w.fed.payments.length}`);
  assert.equal(r.state, PAYOUT.PAID, r.why);
  assert.ok(states.every((s) => s === PAYOUT.PAID));
  assert.equal(w.fed.payments.length, 1);
});

test('#1409 a coordinator that reads none of the rounds writes no SHORT (asked again); a real shortfall is still SHORT', async () => {
  const w = world({ more: wired(() => ({})) });
  const [r] = await w.seats[0].api.round({ height: 500 });
  console.log(`  MEASURED #1409: coordinator reads none: ${JSON.stringify(r).slice(0, 160)}`);
  assert.notEqual(r.state, PAYOUT.SHORT);
  assert.match(r.why, /cannot read/);
  assert.equal(w.seats[0].api.stateOf(PROPOSAL), null);
  const short = world({ amountSats: 200000n, more: wired(() => ({})) });   // 200,000 sat; all rows together hold 150,000
  const [s] = await short.seats[0].api.round({ height: 500 });
  assert.equal(s.state, PAYOUT.SHORT);
});

test('#1409 a row whose round names another network is still never spent, nor taken by a co-signer', async () => {
  const foreign = { ...all, [raw[0].roundId]: OTHER, [raw[1].roundId]: OTHER };   // only the 50,000 sat row is this network's
  const w = world({ more: wired(() => foreign) });
  const [r] = await w.seats[0].api.round({ height: 500 });
  assert.equal(r.state, PAYOUT.SHORT, 'the coordinator spent another network\'s reserves');
  const rows = reserveRowsOfNetwork(raw, NET, (rid) => foreign[rid]);
  assert.deepEqual(rows.map((x) => [x.outpoint.slice(0, 4), !!x.unknown]), [['0303', false]]);
});
