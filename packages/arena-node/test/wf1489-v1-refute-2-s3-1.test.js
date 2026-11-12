// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 skeptic 3 of fix:settle:1 (second copy): the settlement, send and forfeit doors now keep a pair per asking seat
// (nonce-pairs.js), but reserve-payout.js pairFor() still hands the FIRST UNSPENT pair to whichever guardian seat asks - the very
// settle-1 pattern. The coordinator's own commitment is that pair too (commitHere -> pairFor). One guardian seat of seven, asked for
// its commitment by the coordinator, asks the coordinator for "its" commitment (signed, as any guardian may), gets the coordinator's
// own pair, and spends it at once on a list of that commitment and four invented ones. The coordinator's shareHere over the real list
// is then refused ("signed that message over another list") and sign() returns at once - every pass, every coordinator: the passed
// proposal is never paid while six honest guardians stand ready (#1527 says one guardian seat must not hold a payout unpaid).
// Safe: with six honest guardian seats of seven, the passed proposal is PAID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { PAYOUT, askDigestOf, planIdOf, commitmentListOf } from '../src/reserve-payout.js';
import { world, PROPOSAL, SECRET_OF, curve } from './reserve-payout-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('one guardian seat taking the coordinator\'s own unspent pair does not hold a passed reserve payout unpaid (6 honest of 7)', async () => {
  const w = world();
  const bad = w.seats[1];
  const signed = (a) => ({ ...a, from: bad.me, sig: toHex(schnorr.sign(askDigestOf({ ...a, from: bad.me }), SECRET_OF.get(bad.me))) });
  let stolen = 0;
  const honestCommit = bad.api.commit;
  bad.api.commit = async (b) => {
    const mine = await honestCommit(b);   // it commits as an honest seat does
    const asker = w.seats.find((s) => s.me === b.from);
    if (asker && asker !== bad) {
      const planId = planIdOf(b.plan);
      const got = await asker.api.commit({ plan: b.plan, kind: b.kind, txid: b.txid || null, ...signed({ ask: 'commit', kind: String(b.kind), planId, txid: b.txid || null }) });
      if (got && got.ok) {
        const ids = [1, 2, 3, 4, 5, 6, 7].filter((i) => i !== got.commitment.id).slice(0, 4);
        const fake = ids.map((id) => ({ id, hiding: curve.pointFromScalar(BigInt(1000 + id)), binding: curve.pointFromScalar(BigInt(2000 + id)) }));
        const list = [got.commitment, ...fake].sort((x, y) => x.id - y.id);
        const sh = await asker.api.share({ planId, kind: b.kind, commitments: list, ...signed({ ask: 'share', kind: String(b.kind), planId, list: commitmentListOf(list) }) });
        if (sh && sh.ok) stolen++;
      }
    }
    return mine;
  };
  const seen = [];
  for (let h = 500; h <= 530 && !w.fed.payments.length; h++) {
    for (const s of w.seats) {
      if (s === bad) continue;
      for (const r of (await s.api.round({ height: h }).catch((e) => [{ ok: false, why: e.message }])) || []) seen.push(r.ok ? r.state : r.why);
    }
    await w.deliver();
  }
  const states = w.seats.filter((s) => s !== bad).map((s) => (s.api.stateOf(PROPOSAL) || {}).state);
  assert.equal(w.fed.payments.length, 1, `nothing paid with six honest guardians (${stolen} coordinator pairs spent by the bad seat); the passes said: ${[...new Set(seen)].slice(0, 4).join(' | ')}`);
  assert.ok(states.includes(PAYOUT.PAID), `states ${states}`);
});
