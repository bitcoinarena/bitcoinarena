// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE 10% ON A KNOWN STAKE (§0A.8 and §22A, RULED 2026-10-06/07): out of the stake the player chose,
// 5% to the nodes - mandatory, the entry's fee lock, three equal pools of 5/3 % (two halves when no guardian is eligible)
// - and a donation of 0-5% (default 5%), half to the protocol devs (the network's set) and half to the game dev (the
// game's set), one output per recipient when both sets name it. The rest, at least 90%, is the net stake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryFeeMsat, nodeFeeTable, NODE_FEE_BPS, GAME_VERIFY, SETTLEMENT, GUARDIAN } from '../../arena-protocol/src/fee.js';
import { splitDonation, splitTwoSets, donationOutputsExpected } from '../../arena-protocol/src/donation.js';
import { netStakeMsat, DELIVERED } from '../../arena-protocol/src/payout.js';
import { DONATION_DEFAULT_BPS, DONATION_CHOICES_BPS, DONATION_CONFIRM_BPS, donationChoice } from '../src/donation-choice.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const key = (n) => Uint8Array.from([0x02, ...b32(n)]);
// the network's protocol-dev set and a game's own set
const NETWORK = [{ recipientPk: key(0xa1), label: 'dev a', shareBps: 5000 }, { recipientPk: key(0xa2), label: 'dev b', shareBps: 5000 }];
const OTHER_GAME = [{ recipientPk: key(0xc1), label: 'game dev', shareBps: 10000 }];
const CONTRACT = { networkId: NETWORK_ID_REGTEST, gameId: b32(0x6e) };
const seats = { [GAME_VERIFY]: [b32(1), b32(2)], [SETTLEMENT]: [b32(1), b32(2)], [GUARDIAN]: [b32(3), b32(4), b32(5)] };
const everyone = new Set([b32(1), b32(2), b32(3), b32(4), b32(5)].map(toHex));
const bps = (stake, b) => (stake * BigInt(b)) / 10000n;
const tableOn = (stakeMsat, pools) => {
  // nodeFeeTable names the round by its contract's id (the order its leftover msats go out in): a contract that encodes
  const c = { ...minimalContract(), stakeMsat };
  return nodeFeeTable({ contract: c, entries: [{ stakeMsat, outcome: DELIVERED }], pools, eligible: everyone });
};

test('on 100 000 000 msat: nodes 5 000 000 in thirds 1 666 666 / 1 666 666 / 1 666 668, protocol devs 2 500 000, game dev 2 500 000, net 90 000 000', () => {
  const stake = 100_000_000n;
  assert.equal(NODE_FEE_BPS, 500);
  const fee = entryFeeMsat(stake);
  const t = tableOn(stake, seats);
  const donation = bps(stake, DONATION_DEFAULT_BPS);
  const split = splitTwoSets({ donationMsat: donation, networkSet: NETWORK, gameSet: OTHER_GAME });
  const net = netStakeMsat({ stakeMsat: stake, feeMsat: fee, donationMsat: donation });
  const facts = { fee, pools: [t.pools[GAME_VERIFY], t.pools[SETTLEMENT], t.pools[GUARDIAN]], protocol: split.protocolMsat, game: split.gameMsat, net };
  console.log('  FACTS (100 000 000 msat):', JSON.stringify(facts, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.equal(fee, 5_000_000n);
  assert.deepEqual(facts.pools, [1_666_666n, 1_666_666n, 1_666_668n]);
  assert.equal(t.unallocated, 0n);
  assert.equal([...t.signerNodes.values()].reduce((a, b) => a + b, 0n), 5_000_000n);
  assert.equal(DONATION_DEFAULT_BPS, 500);
  assert.equal(donation, 5_000_000n);
  assert.equal(split.protocolMsat, 2_500_000n);
  assert.equal(split.gameMsat, 2_500_000n);
  assert.deepEqual(split.protocol.map((s) => s.amountMsat), [1_250_000n, 1_250_000n]);
  assert.deepEqual(split.game.map((s) => s.amountMsat), [2_500_000n]);
  assert.equal(net, 90_000_000n);
  assert.equal(fee + donation + net, stake);
  // NO GUARDIAN ELIGIBLE: two halves of the 5%, nothing left unallocated (2026-10-07)
  const two = tableOn(stake, { [GAME_VERIFY]: seats[GAME_VERIFY], [SETTLEMENT]: seats[SETTLEMENT], [GUARDIAN]: [] });
  assert.deepEqual([two.pools[GAME_VERIFY], two.pools[SETTLEMENT], two.pools[GUARDIAN], two.unallocated], [2_500_000n, 2_500_000n, 0n, 0n]);
});

test('an odd stake: every millisatoshi of the fee and the donation is somebody\'s, to the msat', () => {
  const stake = 33_333_333n;
  const fee = entryFeeMsat(stake);                                   // 5% floored: 1 666 666
  const t = tableOn(stake, seats);
  const donation = bps(stake, 500);                                  // 1 666 666
  const THREE = [{ recipientPk: key(0xb1), label: 'x', shareBps: 3333 }, { recipientPk: key(0xb2), label: 'y', shareBps: 3333 },
    { recipientPk: key(0xb3), label: 'z', shareBps: 3334 }];
  const split = splitTwoSets({ donationMsat: donation, networkSet: THREE, gameSet: OTHER_GAME });
  const net = netStakeMsat({ stakeMsat: stake, feeMsat: fee, donationMsat: donation });
  console.log('  FACTS (odd):', JSON.stringify({ fee, pools: Object.values(t.pools), protocol: split.protocol.map((s) => s.amountMsat), game: split.gameMsat, net },
    (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.equal(fee, 1_666_666n);
  assert.deepEqual([t.pools[GAME_VERIFY], t.pools[SETTLEMENT], t.pools[GUARDIAN]], [555_555n, 555_555n, 555_556n]);
  assert.equal([...t.signerNodes.values()].reduce((a, b) => a + b, 0n), fee, 'a fee msat went to nobody');
  // the protocol half floored, the game half the rest; each half's shares floored, the remainder to the first as published
  assert.deepEqual([split.protocolMsat, split.gameMsat], [833_333n, 833_333n]);
  assert.deepEqual(split.protocol.map((s) => s.amountMsat), [277_751n, 277_749n, 277_833n]);
  assert.equal(split.shares.reduce((a, s) => a + s.amountMsat, 0n), donation, 'a donation msat went to nobody');
  assert.equal(net, 30_000_001n);
  assert.equal(fee + donation + net, stake);
});

test('the same recipients in both sets are paid once, the sum of both halves; different sets pay each its own half', () => {
  const donation = 5_000_000n;
  const merged = splitTwoSets({ donationMsat: donation, networkSet: NETWORK, gameSet: NETWORK });
  const separate = splitTwoSets({ donationMsat: donation, networkSet: NETWORK, gameSet: OTHER_GAME });
  console.log('  FACTS (outputs):', JSON.stringify({ merged: merged.shares.map((s) => [toHex(s.recipientPk).slice(0, 6), String(s.amountMsat)]),
    separate: separate.shares.map((s) => [toHex(s.recipientPk).slice(0, 6), String(s.amountMsat)]) }));
  // nextblock's case: one output per key, 2 500 000 each (1 250 000 protocol + 1 250 000 game)
  assert.deepEqual(merged.shares.map((s) => [toHex(s.recipientPk), s.amountMsat]), [[toHex(key(0xa1)), 2_500_000n], [toHex(key(0xa2)), 2_500_000n]]);
  // a game with its own dev: the protocol devs' two halves of 2.5% and the game dev's 2.5%
  assert.deepEqual(separate.shares.map((s) => [toHex(s.recipientPk), s.amountMsat]),
    [[toHex(key(0xa1)), 1_250_000n], [toHex(key(0xa2)), 1_250_000n], [toHex(key(0xc1)), 2_500_000n]]);
  // and the entry names exactly those outputs, as the node checks them
  const outs = (target, n) => donationOutputsExpected({ donationMsat: donation, donationOutpoints: Array.from({ length: n }, (_, i) => ({ txid: b32(0x70 + i), outIdx: 0n })) }, target);
  assert.equal(outs({ network: NETWORK, game: NETWORK }, 2).ok, true);
  assert.equal(outs({ network: NETWORK, game: NETWORK }, 4).ok, false, 'a merged recipient was paid twice');
  assert.equal(outs({ network: NETWORK, game: OTHER_GAME }, 3).ok, true);
  // splitDonation takes the two-set target as the one entry point every donation path uses
  assert.deepEqual(splitDonation({ donationMsat: donation, recipients: { network: NETWORK, game: NETWORK } }).shares.map((s) => s.amountMsat), [2_500_000n, 2_500_000n]);
});

test('the choice is 0 to 5% (default 5%), 6% needs the second confirmation, and a free round pays neither fee nor donation', () => {
  const stake = 100_000_000n;
  assert.deepEqual([...DONATION_CHOICES_BPS], [0, 100, 200, 300, 400, 500]);
  for (const b of DONATION_CHOICES_BPS) {
    const got = donationChoice({ typed: String(b / 100), stakeMsat: stake });
    assert.equal(got.ok, true, `${b / 100}%: ${got.why}`);
    assert.equal(got.donationMsat, bps(stake, b));
    assert.equal(splitTwoSets({ donationMsat: got.donationMsat, networkSet: NETWORK, gameSet: OTHER_GAME }).shares.reduce((a, s) => a + s.amountMsat, 0n), got.donationMsat);
  }
  assert.equal(DONATION_CONFIRM_BPS, 500);
  assert.equal(donationChoice({ typed: '6', stakeMsat: stake, confirm: () => false }).ok, false);
  assert.match(donationChoice({ typed: '6', stakeMsat: stake }).why, /above 5% and was not confirmed a second time/);
  assert.equal(donationChoice({ typed: '6', stakeMsat: stake, confirm: () => true }).ok, true);
  // a free round: no fee, no donation, nothing to anybody
  assert.equal(entryFeeMsat(0n), 0n);
  const free = splitTwoSets({ donationMsat: 0n, networkSet: NETWORK, gameSet: OTHER_GAME });
  assert.equal(free.shares.reduce((a, s) => a + s.amountMsat, 0n), 0n);
  assert.equal(netStakeMsat({ stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n }), 0n);
});

function minimalContract() {
  return {
    networkId: NETWORK_ID_REGTEST, gameId: CONTRACT.gameId, configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
    simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
    slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: b32(0x0f), stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
    donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(1), b32(2)],
  };
}
