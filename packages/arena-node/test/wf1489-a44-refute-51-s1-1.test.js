// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-51 (bypass of #1672): THE FOURTH ROUND-TWO DOOR HAS NO COMMITTEE BOUND.
// #1672 put commitmentListRefusal (no list longer than a committee, no id twice) before signShare340 in settlement.js, forfeit.js and
// winnings-send.js. reserve-payout.js shareHere (POST /reserve-payout/share, 8 MiB JSON body) still signs over any list that carries
// the seat's own commitment and at least `needed` entries. One guardian seat of the federation (the asker; the ask is signed by it)
// pads the list with thousands of made-up commitments and holds every peer's loop in signShare340 - the very hole #1672 closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { askDigestOf, commitmentListOf } from '../src/reserve-payout.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { world, curve, NODE_KEYS, SECRET_OF } from './reserve-payout-fixture.js';

const fakes = (n, from) => Array.from({ length: n }, (_, k) => ({ id: from + k, hiding: curve.pointFromScalar(BigInt(1000 + k)), binding: curve.pointFromScalar(BigInt(900000 + k)) }));

async function padded(extra, dupe = false) {
  const w = world();
  const me0 = NODE_KEYS[0];
  let got = null;
  for (const target of w.seats.slice(1)) {
  const honest = target.api.share;
  target.api.share = async (b) => {
    if (!got) {
      // the asking guardian seat (seat 0) pads the list and signs its own ask over it
      const list = dupe ? [...b.commitments, ...b.commitments.slice(0, 1)] : [...b.commitments, ...fakes(extra, 100)];
      const ask = { ask: 'share', kind: String(b.kind), planId: String(b.planId), list: commitmentListOf(list), from: me0 };
      const sig = toHex(schnorr.sign(askDigestOf(ask), SECRET_OF.get(me0)));
      const t0 = Date.now();
      const r = await honest({ planId: b.planId, kind: b.kind, commitments: list, from: me0, sig });
      got = { n: list.length, ok: r.ok, why: r.why, ms: Date.now() - t0 };
    }
    return honest(b);
  };
  }
  await w.seats[0].api.round({ height: 500 });
  return got;
}

test('wf1489 a44-refute-51: /reserve-payout/share refuses a commitment list longer than the federation (as /settle-share since #1672)', async () => {
  const got = await padded(400);
  assert.ok(got, 'the coordinator never asked the peer for a share (fixture)');
  assert.equal(got.ok, false, `the peer signed over ${got.n} commitments for a 5-of-7 key (${got.ms} ms) - no committee bound at the reserve door`);
});

test('wf1489 a44-refute-51: a 6 000-commitment reserve list does not hold the seat\'s loop', async () => {
  const got = await padded(6000);
  assert.ok(got, 'the coordinator never asked the peer for a share (fixture)');
  assert.ok(got.ms < 500 && got.ok === false, `the peer spent ${got.ms} ms in round two over ${got.n} commitments (ok=${got.ok})`);
});

test('wf1489 a44-refute-51 (kanban #2161): a reserve list naming one guardian twice is refused before round two', async () => {
  const got = await padded(0, true);
  assert.ok(got, 'the coordinator never asked the peer for a share (fixture)');
  assert.equal(got.ok, false, `the peer signed over a list that names one id twice (${got.n} commitments)`);
  assert.match(String(got.why), /twice/);
});
