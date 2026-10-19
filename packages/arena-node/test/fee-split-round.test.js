// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE 10% IN A PAYING LOCK ROUND, END TO END (kanban #205, §0A.8 and §22A): two players stake 100 000 000 msat each and
// donate the default 5%. The NODES' 5% is taken from the settlement transaction - its payouts to the round's seats (and
// guardians) - and the DEVELOPERS' 5% from what the federation holds at the outputs each entry's lock named: half to the
// network's protocol-dev set, half to the round's game's set. nextblock's protocol devs are its game dev (one merged
// output per key); tally's game dev is a key of its own (separate outputs, 2.5% each).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, openLockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32, WINNER, LOSER } from './window-fixture.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TALLY, TALLY_CORE, TALLY_CORE_HASH, TALLY_CONFIG_HASH, TALLY_GAME_ID } from './plugins/tally/index.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { nodeFeeTable, entryFeeMsat, GAME_VERIFY, SETTLEMENT, GUARDIAN } from '../../arena-protocol/src/fee.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { donationContractFields } from '../src/stake-lock-signer-node.js';
import { DELIVERED } from '../../arena-protocol/src/payout.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const STAKE = 100_000_000n;
const DONATION = STAKE * 500n / 10000n;                      // the default 5%
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;   // the protocol devs (dev a 6667, dev b 3333)
const NETWORK_ROUND = { donationSetId: donationSetId(NETWORK) };
const TALLY_ROUND = { ...NETWORK_ROUND, gameId: TALLY_GAME_ID, simCoreHash: TALLY_CORE_HASH, configHash: TALLY_CONFIG_HASH, blockTicks: 600, startDeadlineTicks: 300 };
const HIGH = { name: 'high', key: b32(0x21), worldSecret: b32(0x31), ticks: 600, words: () => [7, 0, 0, 0, 0] };
const LOW = { name: 'low', key: b32(0x22), worldSecret: b32(0x32), ticks: 600, words: () => [2, 0, 0, 0, 0] };
const hex = toHex;
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);

/** What the federation holds at each donation output of an entry, checked to be the payout contract to its key. */
async function heldDonations(w, played) {
  const out = [];
  for (const d of played.donated) {
    const st = await w.port.status(d.outpoint);
    assert.ok(st.stored, 'the federation holds nothing at a donation output');
    assert.equal(st.stored.contractId, await w.port.contractId(donationContractFields({ recipientPk: d.recipientPk, amountMsat: d.amountMsat })),
      'a donation output is not the payout contract to its key for its amount');
    out.push({ key: hex(d.recipientPk), msat: d.amountMsat });
  }
  return out;
}

/** The node fee in the round's settlement transaction: its payouts to anybody but the players, by key. */
function nodePayouts(w, players) {
  // the settlement that claims this round's locks - a stake lock or a fee lock of its players
  const ours = new Set(players.flatMap((p) => [p.outpoint, p.feeOutpoint]).map((o) => hex(o.txid)));
  const tx = w.port.settlements.find((s) => s.claims.some((c) => ours.has(hex(c.outpoint.txid))));
  assert.ok(tx, 'no settlement transaction claims this round\'s locks');
  const playerKeys = new Set(players.map((p) => hex(refundKeyOf(p.entry.playerPubkey))));
  return tx.payouts.filter((p) => !playerKeys.has(hex(p.payoutPk))).map((p) => ({ key: hex(p.payoutPk), msat: p.msat }));
}

/** The table §22A owes for this round: the seats in both pools, any guardian the settlement paid in the third. */
function owedTable(w, players, paid) {
  const seats = w.c.nodes;
  const seatKeys = new Set(seats.map((k) => hex(refundKeyOf(k))));
  const guardians = paid.filter((p) => !seatKeys.has(p.key));
  const t = nodeFeeTable({ contract: w.c, entries: players.map((p) => ({ stakeMsat: p.entry.stakeMsat, outcome: DELIVERED })),
    pools: { [GAME_VERIFY]: seats, [SETTLEMENT]: seats, [GUARDIAN]: [] }, eligible: new Set(seats.map(hex)) });
  return { t, guardians };
}

test('a paying round of each game: the seats take 5% of the gross from the settlement, the devs 5% of each stake from the locks - nextblock merged, tally separate', async () => {
  const w = await lockRound({ stakeMsat: STAKE, serveOpts: { plugins: [NEXTBLOCK, TALLY], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] }, round: NETWORK_ROUND });
  try {
    // NEXTBLOCK: its game set is the protocol devs' own keys
    const nbTarget = { network: NETWORK, game: NEXTBLOCK.donationSet };
    const won = await lockAndPlay(w, WINNER, { address: true, donation: { msat: DONATION, target: nbTarget } });
    const lost = await lockAndPlay(w, LOSER, { donation: { msat: DONATION, target: nbTarget } });
    await closeRound(w);
    const nb = await untilSettled(w);
    const nbPaid = nodePayouts(w, [won, lost]);
    const nbOwed = owedTable(w, [won, lost], nbPaid);
    const nbDev = [await heldDonations(w, won), await heldDonations(w, lost)];

    // TALLY ON THE SAME NODES: its game dev is a key of its own
    const t = await openLockRound(w, { stakeMsat: STAKE, round: TALLY_ROUND });
    const tTarget = { network: NETWORK, game: TALLY.donationSet };
    const play = { adapter: TALLY_CORE.adapter, config: {} };
    const high = await lockAndPlay(t, HIGH, { address: true, game: play, donation: { msat: DONATION, target: tTarget } });
    const low = await lockAndPlay(t, LOW, { game: play, donation: { msat: DONATION, target: tTarget } });
    await closeRound(t);
    const ty = await untilSettled(t);
    const tyPaid = nodePayouts(t, [high, low]);
    const tyDev = [await heldDonations(t, high), await heldDonations(t, low)];

    const facts = {
      nextblock: { state: nb.state, gross: String(2n * STAKE), feePerEntry: String(entryFeeMsat(STAKE)), nodes: nbPaid.map((p) => [p.key.slice(0, 8), String(p.msat)]),
        nodesTotal: String(sum(nbPaid.map((p) => p.msat))), devPerEntry: nbDev.map((d) => d.map((x) => [x.key.slice(0, 8), String(x.msat)])) },
      tally: { state: ty.state, nodes: tyPaid.map((p) => [p.key.slice(0, 8), String(p.msat)]), nodesTotal: String(sum(tyPaid.map((p) => p.msat))),
        devPerEntry: tyDev.map((d) => d.map((x) => [x.key.slice(0, 8), String(x.msat)])) },
    };
    console.log('  FACTS (fee split round):', JSON.stringify(facts));

    assert.equal(nb.state, 'ACCEPTED', nb.why);
    assert.equal(ty.state, 'ACCEPTED', ty.why);
    // THE NODES: 5% of the 200 000 000 gross = 10 000 000 msat, in the settlement, each seat what §22A's table owes it
    for (const [name, paid] of [['nextblock', nbPaid], ['tally', tyPaid]])
      assert.equal(sum(paid.map((p) => p.msat)), 10_000_000n, `${name}: the settlement did not pay the nodes 5% of the gross`);
    if (!nbOwed.guardians.length) {
      // no guardian paid: two halves of 2.5%, each seat in both pools - 2 500 000 + 2 500 000
      for (const k of w.c.nodes) assert.equal(nbPaid.find((p) => p.key === hex(refundKeyOf(k))).msat,
        nbOwed.t.signerNodes.get(`${GAME_VERIFY}:${hex(k)}`) + nbOwed.t.signerNodes.get(`${SETTLEMENT}:${hex(k)}`));
      assert.deepEqual([nbOwed.t.pools[GAME_VERIFY], nbOwed.t.pools[SETTLEMENT]], [5_000_000n, 5_000_000n]);
    }
    // THE DEVELOPERS, PER ENTRY: 5 000 000 msat of each 100 000 000 stake
    const [a, b] = NETWORK.map((r) => hex(r.recipientPk));
    for (const d of nbDev) {
      // nextblock: one output per key, both halves - dev a 6667 bps of 2 500 000 twice, dev b 3333 bps twice
      assert.deepEqual(d.map((x) => [x.key, x.msat]), [[a, 3_333_500n], [b, 1_666_500n]]);
      assert.equal(sum(d.map((x) => x.msat)), 5_000_000n);
    }
    const gameDev = hex(TALLY.donationSet[0].recipientPk);
    for (const d of tyDev) {
      // tally: the protocol devs' 2.5% over their two keys, the game dev's 2.5% to its own
      assert.deepEqual(d.map((x) => [x.key, x.msat]), [[a, 1_666_750n], [b, 833_250n], [gameDev, 2_500_000n]]);
      assert.equal(sum(d.filter((x) => x.key !== gameDev).map((x) => x.msat)), 2_500_000n);
      assert.equal(sum(d.map((x) => x.msat)), 5_000_000n);
    }
  } finally { await w.close(); }
});
