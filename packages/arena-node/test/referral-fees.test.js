// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT EACH WEBSITE EARNED (kanban #676, the explorer's metrics: "total referrer fees accumulated"): GET /referral-fees sums the 'website'
// payouts a seat indexed, per website payout key; donations and reserves under other keys are not counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { joinedWithLock } from './lock-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('the websites\' payouts, per website and in total; other rows are not referral fees', async () => {
  const s = await joinedWithLock({});
  try {
    const row = (n, pk, msat, item) => ({ outpoint: { txid: new Uint8Array(32).fill(n), outIdx: 0n }, entryId: new Uint8Array(32), roundId: new Uint8Array(32).fill(1),
      federationId: new Uint8Array(32).fill(2), recipientPk: new Uint8Array(33).fill(pk), amountMsat: msat, contractId: `settlement:${n}`, ...(item ? { item } : {}) });
    s.d.round.putDonationOutputs([row(1, 3, 1500n, 'website'), row(2, 3, 500n, 'website'), row(3, 4, 7000n, 'website'), row(4, 5, 9000n, null), row(5, 6, 800n, 'donation · protocol · from site')]);
    const j = await (await fetch(`http://127.0.0.1:${s.d.port}/referral-fees`)).json();
    assert.equal(j.totalMsat, '9000');
    assert.deepEqual(j.sites.map((x) => [x.site.slice(0, 4), x.msat, x.payouts]), [['0404', '7000', 1], ['0303', '2000', 2]]);
    assert.equal(j.node, toHex(s.d.round.pubkey));
  } finally { await s.d.close(); }
});
