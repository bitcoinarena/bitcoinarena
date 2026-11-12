// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 (refute 2 of #1527 / #1715): ANOTHER GUARDIAN BURNS THE COORDINATOR'S NONCE PAIR. A commit or a share of a plan a seat
// holds may be asked by ANY guardian seat of the federation (askStands), and pairFor hands every asker the same pending pair. One guardian
// seat, asked for its commitment, asks the coordinator's own /reserve-payout/commit (it gets the coordinator's pending pair - the very
// commitment sign() just put first in its list) and then /reserve-payout/share over a list of its own making that carries it. The
// coordinator signs that list and locks the pair to it; its own share in sign() is then refused ("signed that message over another
// list") and sign() returns at once - nobody is left off, every pass of every coordinator fails the same way, and a passed payout stays
// unpaid while six honest guardians stand ready. Safe: with six honest seats of seven, the payout is PAID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { PAYOUT, createReservePayouts, askDigestOf, commitmentListOf } from '../src/reserve-payout.js';
import { world, PROPOSAL, DEAL, curve, SECRET_OF, rand } from './reserve-payout-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const withPub = (o) => createReservePayouts({ ...o, guardians: () => { const m = o.guardians();
  const pub = new Map(DEAL.shares.map((s, i) => [String(i + 1), curve.pointFromScalar(s.share)]));
  for (const g of m.values()) g.publicShares = () => pub; return m; } });

// M (a guardian seat) signs its own asks, as any guardian seat may
const signed = (me, a) => { const x = { ...a, from: me }; return { ...x, sig: toHex(schnorr.sign(askDigestOf(x), SECRET_OF.get(me))) }; };
const fake = () => curve.pointFromScalar(BigInt('0x' + toHex(rand(31))) + 1n);
// burn `victim`'s pending pair for that plan and kind: ask its commit (the pending pair comes back) and a share over M's own list
async function burn(M, victim, b) {
  const planId = b.planId, kind = b.kind;
  const c = await victim.api.commit({ ...b, ...signed(M.me, { ask: 'commit', kind, planId, txid: b.txid === undefined ? null : b.txid }) });
  if (!c || !c.ok) return false;
  const ids = [1, 2, 3, 4, 5, 6, 7].filter((i) => i !== c.commitment.id).slice(0, 4);
  const list = [c.commitment, ...ids.map((id) => ({ id, hiding: fake(), binding: fake() }))].sort((a, z) => a.id - z.id);
  const s = await victim.api.share({ planId, kind, commitments: list, ...signed(M.me, { ask: 'share', kind, planId, list: commitmentListOf(list) }) });
  return !!(s && s.ok);
}

for (const pub of [false, true]) for (const [name, honestAfter] of [['then commits honestly', true], ['then answers a junk commitment', false]]) {
  test(`a guardian seat that burns the coordinator's own nonce pair and ${name} does not hold a passed payout unpaid (6 honest of 7${pub ? ', public shares' : ''})`, async () => {
    const w = world(pub ? { create: withPub } : {});
    const M = w.seats[1];
    const commit = M.api.commit;
    let burnt = 0;
    M.api.commit = async (b) => {
      const coord = w.seats.find((s) => s.me === b.from);
      if (coord && coord !== M && b.kind !== 'claim' && await burn(M, coord, b)) burnt++;
      const r = await commit(b);
      return honestAfter ? r : (r && r.ok ? { ...r, commitment: { ...r.commitment, id: 99 } } : r);
    };
    const seen = [];
    for (let h = 500; h <= 540 && !w.fed.payments.length; h++) {
      for (const s of w.seats) {
        if (s === M) continue;
        const got = await s.api.round({ height: h }).catch((e) => [{ ok: false, why: `threw: ${e.message}` }]);
        for (const r of got || []) seen.push(r.ok ? r.state : r.why);
      }
      await w.deliver();
    }
    const states = w.seats.filter((s) => s !== M).map((s) => (s.api.stateOf(PROPOSAL) || {}).state);
    assert.equal(w.fed.payments.length, 1, `nothing paid with six honest guardians (${burnt} pairs burnt); the passes said: ${[...new Set(seen)].slice(0, 4).join(' | ')}`);
    assert.ok(states.includes(PAYOUT.PAID), `states ${states}`);
  });
}

// the same door against the honest PEERS: M, asked for its share, sees the whole list and locks every later peer's pair to another list
// first - each of them is refused and left off, M is not, and turn after turn the honest seats fall away until fewer than five commit
for (const pub of [false, true]) {
  test(`a guardian seat that burns the later peers' pairs from its share door does not hold a passed payout unpaid (6 honest of 7${pub ? ', public shares' : ''})`, async () => {
    const w = world(pub ? { create: withPub } : {});
    const M = w.seats[1];
    const share = M.api.share;
    M.api.share = async (b) => {
      const r = await share(b);
      for (const c of b.commitments) {
        const v = w.seats[c.id - 1];
        if (v === M || v.me === b.from) continue;
        const ids = [1, 2, 3, 4, 5, 6, 7].filter((i) => i !== c.id).slice(0, 4);
        const list = [c, ...ids.map((id) => ({ id, hiding: fake(), binding: fake() }))].sort((a, z) => a.id - z.id);
        await v.api.share({ planId: b.planId, kind: b.kind, commitments: list, ...signed(M.me, { ask: 'share', kind: b.kind, planId: b.planId, list: commitmentListOf(list) }) });
      }
      return r;
    };
    const seen = [];
    for (let h = 500; h <= 540 && !w.fed.payments.length; h++) {
      for (const s of w.seats) {
        if (s === M) continue;
        const got = await s.api.round({ height: h }).catch((e) => [{ ok: false, why: `threw: ${e.message}` }]);
        for (const r of got || []) seen.push(r.ok ? r.state : r.why);
      }
      await w.deliver();
    }
    assert.equal(w.fed.payments.length, 1, `nothing paid with six honest guardians; the passes said: ${[...new Set(seen)].slice(0, 4).join(' | ')}`);
  });
}

