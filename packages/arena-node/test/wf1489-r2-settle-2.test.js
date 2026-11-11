// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (settle-2): ONE guardian seat of seven blocks every 5-of-7 reserve payout (reserve-payout.js sign()).
// The coordinator takes the first `needed - 1` peers that answer /reserve-payout/commit, then asks each for its share; a share
// is neither checked on its own (FROST share verification) nor is the bad signer dropped and another honest seat asked: one
// refused share returns at once, and one junk share makes the aggregate fail "does not verify under the reserve key". The
// peer order is the same every pass, so a seat that commits honestly and answers its share with junk (or a refusal) holds a
// passed funding proposal unpaid forever while five honest guardians stand ready (P4).
// Safe: with six honest guardian seats of seven, the passed proposal is PAID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAYOUT } from '../src/reserve-payout.js';
import { world, PROPOSAL } from './reserve-payout-fixture.js';

for (const [name, bad] of [
  ['a junk share', async () => ({ ok: true, share: 123456789n })],
  ['a refused share', async () => ({ ok: false, why: 'no' })],
]) {
  test(`one guardian seat answering ${name} does not hold a passed reserve payout unpaid (6 honest of 7)`, async () => {
    const w = world();
    // seat 1 commits as an honest seat does, and then answers its share badly
    w.seats[1].api.share = bad;
    const seen = [];
    for (let h = 500; h <= 530; h++) {
      for (const s of w.seats) {
        if (s === w.seats[1]) continue;
        const got = await s.api.round({ height: h }).catch((e) => [{ ok: false, why: e.message }]);
        for (const r of got || []) seen.push(`${h}: ${r.ok ? r.state : r.why}`);
      }
      await w.deliver();
      if (w.fed.payments.length) break;
    }
    const states = w.seats.filter((_, i) => i !== 1).map((s) => (s.api.stateOf(PROPOSAL) || {}).state);
    assert.equal(w.fed.payments.length, 1, `nothing paid with six honest guardians; the passes said: ${[...new Set(seen.map((x) => x.replace(/^\d+: /, '')))].slice(0, 4).join(' | ')}`);
    assert.ok(states.includes(PAYOUT.PAID), `states ${states}`);
  });
}

// kanban #1527: with each guardian's public share at hand (server.js g.publicShares) the bad share is named at once and left off
test('with public shares a junk reserve share is named and left off: the payout is paid', async () => {
  const { createReservePayouts } = await import('../src/reserve-payout.js');
  const { DEAL, curve } = await import('./reserve-payout-fixture.js');
  const pub = new Map(DEAL.shares.map((s, i) => [String(i + 1), curve.pointFromScalar(s.share)]));
  let asked = 0;
  const create = (o) => createReservePayouts({ ...o, guardians: () => { const m = o.guardians(); for (const g of m.values()) g.publicShares = () => { asked++; return pub; }; return m; } });
  const w = world({ create });
  w.seats[1].api.share = async () => ({ ok: true, share: 123456789n });
  const seen = [];
  for (let h = 500; h <= 530 && !w.fed.payments.length; h++) {
    for (const s of w.seats) if (s !== w.seats[1]) for (const r of (await s.api.round({ height: h }).catch((e) => [{ ok: false, why: e.message }])) || []) seen.push(r.ok ? r.state : r.why);
    await w.deliver();
  }
  assert.equal(w.fed.payments.length, 1, [...new Set(seen)].slice(0, 4).join(' | '));
  assert.ok(asked > 0, 'the public shares were read');
});
