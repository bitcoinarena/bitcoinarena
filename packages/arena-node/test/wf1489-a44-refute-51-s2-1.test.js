// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-51 skeptic 2 (bypass of #2161 / #1672): ONE GUARDIAN PEER HOLDS EVERY RESERVE PAYOUT WITH A FORGED ID.
// #2161 put commitmentListRefusal ("no id twice") in reserve-payout.js shareHere. The coordinator's sign() never checks that a peer's
// round-one commitment carries that peer's own signer id. One guardian seat answers /reserve-payout/commit with its commitment under
// the coordinator's id (or another peer's): the coordinator's list now names an id twice, its OWN shareHere refuses it, and sign()
// returns at once ("a tx share was refused") - no leave-out, no next peer. Before #2161 the same list was signed, the aggregate
// failed, and the #1527 suspect loop left the bad seat off and paid. One of seven seats now stops the payout for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './reserve-payout-fixture.js';

async function forged(asId) {
  const w = world();
  const bad = w.seats[1];                      // guardian seat 2 of 7 (signer id 2), a peer of coordinator seat 0 (signer id 1)
  const honest = bad.api.commit;
  bad.api.commit = async (b) => {
    const r = await honest(b);
    return r && r.ok ? { ...r, commitment: { ...r.commitment, id: asId } } : r;
  };
  const out = [];
  for (const h of [500, 501, 502, 503]) out.push(...(await w.seats[0].api.round({ height: h })));
  return { w, out };
}

test('wf1489 a44-refute-51 s2: a peer whose commitment names the coordinator\'s id does not stop the reserve payout (5 honest of 6 left)', async () => {
  const { w, out } = await forged(1);
  assert.equal(w.fed.payments.length, 1, `nothing paid with one bad guardian of 7: ${JSON.stringify(out.map((x) => x.state || x.why))}`);
});

test('wf1489 a44-refute-51 s2: a peer whose commitment names another peer\'s id does not stop the reserve payout', async () => {
  const { w, out } = await forged(3);
  assert.equal(w.fed.payments.length, 1, `nothing paid with one bad guardian of 7: ${JSON.stringify(out.map((x) => x.state || x.why))}`);
});
