// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-24 client a7 r1 #3 (P8, P4, P1; the #3350 / #2652 class at a door neither covers): fetchFees (fee-proposal-page.js:20) takes the
// UNSIGNED fee set "most of them name" at the round's census height, counting one vote per URL string of the link's node= list
// (index.html:4331, nodes: named.nodes). A stranger's link that names the round's five seats plus six paths of one box
// (http://liar.test/a .. /f) decides the fee set the paid join builds its entry and fee lock from (round.feeSet -> splitForRound,
// reservesDonationForRound, the market's feeBps). Every honest seat checks the entry's fee against ITS OWN set (round.js
// giftsEntryExpected / feeMatchesEntry) and refuses it: no paid join through that link goes in.
// SAFE: one box is one seat's word however many paths name it: the five honest seats' set stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFees } from '../src/fee-proposal-page.js';
import { FEES_TODAY } from '../../arena-protocol/src/fee-proposal.js';

const LIAR_SET = { ...FEES_TODAY, roundNodeBps: 600, roundDonationBps: 300, roundReserveBps: 100 };

test('audit client a7 r1 #3: paths of one box do not outvote the round\'s seats on the fee set', async () => {
  const honest = ['http://s1.test', 'http://s2.test', 'http://s3.test', 'http://s4.test', 'http://s5.test'];
  const liar = ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => `http://liar.test/${p}`);
  const fetcher = async (url) => {
    const u = new URL(url);
    const set = u.host === 'liar.test' ? LIAR_SET : FEES_TODAY;
    return { ok: true, json: async () => ({ atHeight: set, inForce: set, tip: 900100 }) };
  };
  const plain = await fetchFees({ nodes: honest, height: 900000, fetcher });
  assert.equal(plain.ok, true);
  assert.equal(plain.fees.roundNodeBps, FEES_TODAY.roundNodeBps);
  const got = await fetchFees({ nodes: [...honest, ...liar], height: 900000, fetcher });
  console.log('  FACTS a7-1-3:', JSON.stringify({ ok: got.ok, agreeing: got.agreeing, asked: got.asked, roundNodeBps: got.fees && got.fees.roundNodeBps, why: got.why }));
  assert.ok(!got.ok || got.fees.roundNodeBps === FEES_TODAY.roundNodeBps,
    `one box under six paths set the round's fees: node fee ${got.fees && got.fees.roundNodeBps} bps, the seats' is ${FEES_TODAY.roundNodeBps}`);
});
