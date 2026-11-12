// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1715 (refute of #1527, more variants of wf1489-v1-refute-44-s1-1): (r2 settle-2): sign() in reserve-payout.js leaves a peer off when its SHARE is refused or does not
// stand, but never checks the peer's COMMITMENT. One guardian seat that answers /reserve-payout/commit with a commitment naming
// another signer's id (a duplicate in the list) makes the coordinator's own signShare340 (encodeCommitmentList)
// throw out of sign() - nothing is left off, the next pass asks the same seat first again, and the passed payout stays
// unpaid for good while six honest guardians stand ready. Safe: with six honest seats of seven, the payout is PAID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYOUT, createReservePayouts } from '../src/reserve-payout.js';
import { world, PROPOSAL, DEAL, curve } from './reserve-payout-fixture.js';

const withPub = (o) => createReservePayouts({ ...o, guardians: () => { const m = o.guardians();
  const pub = new Map(DEAL.shares.map((s, i) => [String(i + 1), curve.pointFromScalar(s.share)]));
  for (const g of m.values()) g.publicShares = () => pub; return m; } });

const BAD = [
  // kanban #1715: the other ways a commitment can be spoilt - each must only leave that seat off
  ['the coordinator\'s own id', (r) => ({ ...r, commitment: { ...r.commitment, id: 1 } })],
  ['an id no member has', (r) => ({ ...r, commitment: { ...r.commitment, id: 99 } })],
  ['a non-integer id', (r) => ({ ...r, commitment: { ...r.commitment, id: '2x' } })],
  ['a hiding point off the curve', (r) => ({ ...r, commitment: { ...r.commitment, hiding: new Uint8Array(33).fill(7) } })],
  ['a short binding point', (r) => ({ ...r, commitment: { ...r.commitment, binding: new Uint8Array(5) } })],
  ['the id of a guardian asked after it', (r) => ({ ...r, commitment: { ...r.commitment, id: 7 } })],
];
for (const pub of [false, true]) for (const [name, spoil] of BAD) {
  test(`one guardian seat answering its commit with ${name} does not hold a passed reserve payout unpaid (6 honest of 7${pub ? ', public shares' : ''})`, async () => {
    const w = world(pub ? { create: withPub } : {});
    const commit = w.seats[1].api.commit;
    w.seats[1].api.commit = async (b) => { const r = await commit(b); return r && r.ok ? spoil(r) : r; };
    const seen = [];
    for (let h = 500; h <= 530 && !w.fed.payments.length; h++) {
      for (const s of w.seats) {
        if (s === w.seats[1]) continue;
        const got = await s.api.round({ height: h }).catch((e) => [{ ok: false, why: `threw: ${e.message}` }]);
        for (const r of got || []) seen.push(r.ok ? r.state : r.why);
      }
      await w.deliver();
    }
    const states = w.seats.filter((_, i) => i !== 1).map((s) => (s.api.stateOf(PROPOSAL) || {}).state);
    assert.equal(w.fed.payments.length, 1, `nothing paid with six honest guardians; the passes said: ${[...new Set(seen)].slice(0, 4).join(' | ')}`);
    assert.ok(states.includes(PAYOUT.PAID), `states ${states}`);
  });
}
