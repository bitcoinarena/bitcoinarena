// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROTOCOL-22 PAID ROUND'S FIXTURE (kanban #725, #724), shared by protocol22-paid.test.js and protocol22-contradicted.test.js - one
// test a file, each under the the test host's 180 s budget: seven in-process seats of one federation (lock-round-fixture: claim key and reserve
// key by their own DKGs) and an eighth daemon that is no seat of the round and the one node that may audit it; a winner with a secret
// of its own; and the money the round owes, from the rules alone.
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound } from './lock-round-fixture.js';
import { CLOCK } from './block-clock.js';
import { assumeAssigned } from './assignment.js';
import { HOSTED } from './plugins/hosted.js';
import { b32, STAKE, opts, qualifiersUnder } from './window-fixture.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId, splitDonation } from '../../arena-protocol/src/donation.js';
import { AUDITOR_VERSION } from '../../arena-protocol/src/constants.js';
import { roundSplit } from '../../arena-protocol/src/reserves.js';
import { nodeFeeTable, frontendShares, GAME_VERIFY, SETTLEMENT, GUARDIAN } from '../../arena-protocol/src/fee.js';
import { auditorShares } from '../../arena-protocol/src/auditor.js';
import { netStakeMsat, DELIVERED } from '../../arena-protocol/src/payout.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { donationContractFields } from '../src/stake-lock-signer-node.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

export const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;   // the protocol devs: dev a 6667, dev b 3333
export const ROUND = { protocolVersion: AUDITOR_VERSION, donationSetId: donationSetId(NETWORK) };
export const WEBSITE = Uint8Array.from([0x02, ...sha256(new TextEncoder().encode('the website that brought the winner'))]);
export const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;
export const str = (x) => (typeof x === 'bigint' ? String(x) : x);

/** The seven seats at protocol 22 and the auditor daemon beside them (weight 1 of 1 in the audit set, so its VRF always draws it). */
export async function seatsAndAuditor() {
  const box = { key: null };
  const audit = { everyMs: 0, setFor: () => (box.key ? { eligible: new Map([[box.key, 1n]]), total: 1n } : null) };
  const w = await lockRound({ n: 7, round: ROUND, endMs: testNow() + 6000,
    serveOpts: { plugins: [NEXTBLOCK], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], audit, finality: { everyMs: 100 } } });
  const auditor = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, stakeLocks: w.slot.port, chainFor: w.slot.chainFor,
    randomnessFor: w.slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2), audit, donationSets: [TEST_DONATION_SET_KEYS_REGTEST] });
  auditor.round.chainView = CLOCK.chainView();
  box.key = toHex(auditor.round.pubkey);
  // IT HOLDS THE ROUND and sits in none of its committees: the seven the census assigned
  auditor.round.open(w.c);
  assumeAssigned(auditor.round, w.rid, w.c.nodes);
  auditor.verifier.peers = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
  return { w, auditor, key: box.key, close: async () => { await auditor.close(); await w.close(); } };
}

/** The winner: a real player key (qualifiersUnder: secret 0x30 + i) driven to deliver under the round's beacon - its secret collects. */
export async function winnerUnder(w) {
  const [q] = await qualifiersUnder(w.randomness, 1);
  const i = Array.from({ length: 64 }, (_, n) => n).find((n) => toHex(schnorr.getPublicKey(b32(0x30 + n))) === toHex(q.key));
  assert.notEqual(i, undefined, 'the qualifier\'s key is one of the fixture\'s');
  return { ...q, secret: b32(0x30 + i) };
}

/** What the federation holds at an outpoint: the payout contract to `recipientPk` for `amountMsat`, or null. */
export async function heldAt(port, outpoint, recipientPk, amountMsat) {
  const st = await port.status(outpoint);
  if (!st.stored) return null;
  return st.stored.contractId === (await port.contractId(donationContractFields({ recipientPk, amountMsat }))) ? { key: toHex(recipientPk), msat: amountMsat } : { wrong: st.stored.contractId };
}

/**
 * THE MONEY THE ROUND OWES, FROM THE RULES ALONE (no settlement code): the split of each 100 000 msat stake (§27A.9.1), the net
 * pool, the nodes' table over the seats' three pools (§22A: game-verify, settlement, and the guardians - the fixture's bonds make the
 * seven the federation's guardians too), the website's 10 % of the nodes' fee on the stake it brought (fee-proposal.js websitePct, 10 since kanban #675), the auditors' 10 % of what is
 * left, the seats' shares of the rest. The federation charges nothing per input or output (§22A), so every line is exact.
 */
export function owedTable(w, { winner, loser, auditors }) {
  const split = roundSplit(STAKE);
  const seats = w.c.nodes;
  const entries = [{ stakeMsat: STAKE, outcome: DELIVERED, frontendPk: WEBSITE, pubkey: winner.entry.playerPubkey },
    { stakeMsat: STAKE, outcome: DELIVERED, pubkey: loser.entry.playerPubkey }];
  const table = nodeFeeTable({ contract: w.c, entries, pools: { [GAME_VERIFY]: seats, [SETTLEMENT]: seats, [GUARDIAN]: seats }, eligible: new Set(seats.map(toHex)), feeBps: 400 });
  const sites = frontendShares({ entries, fee: table.fee, gross: table.gross });
  const websiteMsat = sites.shares.get(toHex(WEBSITE)) || 0n;
  const audit = auditorShares({ nodesMsat: table.fee - websiteMsat, auditors });
  const auditorMsat = audit.each.length ? audit.each[0].msat : 0n;
  const seatLines = new Map();
  for (const [k, msat] of table.signerNodes) {
    const node = k.slice(k.indexOf(':') + 1);
    seatLines.set(node, (seatLines.get(node) || 0n) + msat);
  }
  // each seat's share of the table, less the website's and the auditors' lines (lock-settlement.js: the table share scaled to the rest)
  const nodesSpendable = table.fee - websiteMsat - auditorMsat * BigInt(audit.each.length);
  const perSeat = new Map([...seatLines].map(([node, msat]) => [toHex(refundKeyOf(fromHex(node))), (msat * nodesSpendable) / table.fee]));
  return { split, fee: table.fee, gross: table.gross, websiteMsat, auditorMsat, perSeat, net: netStakeMsat(loser.entry),
    devs: { network: splitDonation({ donationMsat: split.protocolDevsMsat + split.gameDevsMsat, recipients: { network: NETWORK, game: NEXTBLOCK.donationSet } }) } };
}

