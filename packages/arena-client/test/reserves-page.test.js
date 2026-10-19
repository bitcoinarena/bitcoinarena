// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE ON A VERSION-11 ROUND (§27A.9): the nodes' fee is 4 %, the developers' 4 % and the reserves' 2 % are
// mandatory and leave in the lock transaction - the developers' over their sets, the reserves' to the federation's reserve key,
// which the page takes only when at least five of the round's signer nodes name the same one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { feeBpsForRound, roundPaysReserves } from '../src/join.js';
import { donationKeyShares, donationCostMsat } from '../src/page-lock.js';
import { fetchReserveKey, reservesDonation } from '../src/reserves-page.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const key = (prefix, fill) => Uint8Array.of(prefix, ...new Uint8Array(32).fill(fill));
const DEVS = [{ recipientPk: key(0x02, 0xa1), shareBps: 6667, label: 'dev a' }, { recipientPk: key(0x03, 0xb2), shareBps: 3333, label: 'dev b' }];
const FED = new Uint8Array(32).fill(0x33);
const RK = key(0x02, 0xc3);

test('a version-11 game round: 4 % fee, a mandatory 6,000 msat on 100 sat, the reserve share last and marked', () => {
  const v11 = { protocolVersion: 11, stakeMsat: 100000n, gameId: new Uint8Array(32).fill(9) };
  assert.equal(roundPaysReserves(v11), true);
  assert.equal(feeBpsForRound(v11), 400);
  assert.equal(feeBpsForRound({ ...v11, protocolVersion: 10 }), 500, 'below 11: 5 %');
  const d = reservesDonation(100000n);
  assert.deepEqual([d.donationMsat, d.reserveMsat, d.mandatory], [6000n, 2000n, true]);
  const shares = donationKeyShares(d.donationMsat, { network: DEVS, game: DEVS, reserve: { recipientPk: RK, amountMsat: d.reserveMsat } });
  assert.equal(shares.at(-1).reserve, true); assert.equal(toHex(shares.at(-1).recipientPk), toHex(RK)); assert.equal(shares.at(-1).amountMsat, 2000n);
  assert.equal(shares.filter((s) => !s.reserve).reduce((t, s) => t + s.amountMsat, 0n), 4000n);
  assert.ok(donationCostMsat(d.donationMsat, { network: DEVS, game: DEVS, reserve: { recipientPk: RK, amountMsat: 2000n } }) >= 6000n);
});

test('the reserve key: five agreeing signer nodes make it; four, or a split, do not', async () => {
  const serve = (keys) => async (url) => { const i = Number(new URL(url).port); const k = keys[i];
    return new Response(JSON.stringify({ federations: k ? [{ federationId: toHex(FED), key: k }] : [] }), { status: 200 }); };
  const nodes = [1, 2, 3, 4, 5, 6, 7].map((p) => `http://127.0.0.1:${p}`);
  const k = toHex(RK), other = toHex(key(0x03, 0xd4));
  const five = await fetchReserveKey({ federationId: FED, nodes, fetcher: serve({ 1: k, 2: k, 3: k, 4: k, 5: k, 6: other }) });
  assert.equal(five.ok, true, five.why); assert.equal(toHex(five.key), k); assert.equal(five.agreeing, 5);
  const four = await fetchReserveKey({ federationId: FED, nodes, fetcher: serve({ 1: k, 2: k, 3: k, 4: k, 5: other, 6: other }) });
  assert.equal(four.ok, false); assert.match(four.why, /only 4 of the round's signer nodes/);
  const none = await fetchReserveKey({ federationId: FED, nodes, fetcher: serve({}) });
  assert.match(none.why, /none of the round's 7 signer nodes names a reserve key/);
});
