// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 2026.0.2 SEATS: the round that names no draw, on a census of fourteen.
// THE COMMITTEE IS WHOM THE CHAIN ASSIGNED.
//
// A round's `nodes` list is what its author wrote down. Until this it was also
// what the node TRUSTED: `takeReceipt` checked membership against it and
// `verifiedFinal` counted against it, so a committee nobody bonded was served
// as readily as one the census produced.
//
// Letter 26's ruling: the assigned set is the only list that counts, and
// `contract.nodes` is checked against it - exactly, both ways. This file is
// that check, and the 2-of-2 built the honest way: two daemons whose OWN
// identities are bonded on the chain and assigned from the census, which step 1
// of this slice made possible by making a node's identity its bond key.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { serve } from '../src/server.js';
import { chainOf, FIRST_TIME, SPACING, publicationOf } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { bondFor } from './curve.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';

import { schnorr } from '@noble/curves/secp256k1.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
// A CLOCK AFTER THE COMMITTEE FORMS. It was 1234 - a millisecond in 1970 -
// which is now before the round's own committee_time, and a node refuses an
// entry before that instant (27). The fixture's clock has to be a moment the
// round is actually open in.
const AFTER_COMMITTEE = Number(BigInt(FIRST_TIME + 20 * SPACING) * 1000n);
const HEIGHT = 900000;
// THE BEACON these rounds are seeded from, owned by the fixture the way the
// census root is: a value published ABOVE the census height, which is what
// `beaconIsAfterRound` can prove until `committee_time` exists.
// THE BEACON IS THE FIXTURE CHAIN'S OWN, not a number beside it. It used to be
// `{ hash: 0xbe repeated, height: 900005, timeMs: 900n }` - a block this
// fixture's chain does not have, at a height it never reaches - and the roster
// now asks whether the beacon is the block ITS chain names. It was not. The
// answer is derived from the same blocks the census is, which is the thing the
// rule is for: one chain, one committee.
const beaconOf = (bonds, contract) => {
  const view = chainWith(bonds, contract);
  const named = beaconFromChain(contract,
    { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight });
  if (!named.ok) throw new Error('this fixture chain names no beacon: ' + named.why);
  return { hash: named.hash, height: named.height, timeMs: named.timeMs };
};
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;

const advertFor = (key, n) => ({
  nodePubkey: key, operatorId: 'operator', protocolVersions: [1, 2],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint: `ws://node${n}`, region: 'eu-west',
  capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
});
/** A real bond for a node's OWN identity key - possible since step 1. */
const bondOfKey = (key, n) => bondTransaction(advertFor(key, n), {
  previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(key),
});
const chainWith = (bonds, contract) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  // AND THE ROUND'S PUBLICATION, well below any beacon (5A.5, v4.6.2): a node
  // signer nodes only a round its own chain shows published before the beacon block.
  if (contract) blocks[1] = { transactions: [publicationOf(contract)] };
  return chainOf(blocks, FROM);
};
const contractWith = (nodes, censusRoot) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 60500n,
  entryCloseMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: HEIGHT, censusRoot, committeeTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes,
});
/** The root those blocks give, the way whoever opens a round computes it. */
function rootFor(bonds, nodes) {
  const contract = decodeRoundContract(encodeRoundContract(contractWith(nodes, b32(2))));
  const view = chainWith(bonds);
  const byTxid = new Map();
  for (const block of view.blocks)
    for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const census = deriveCensus(view, {
    contract, bond: bondSetFor('regtest'),
    resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; },
  });
  assert.equal(census.ok, true, census.why);
  return census.root;
}


// 2026.0.2 (RULED 2026-10-13, path 1): FOURTEEN BONDED NODES, as testnet4 holds them with two federations.
// A v1 contract can name no draw from them; a v2 contract names none, and the seat writes its seated 7 in.
const fourteen = Array.from({ length: 14 }, (_, i) => schnorr.getPublicKey(new Uint8Array(32).fill(i + 1)));
const bonds14 = fourteen.map((k, i) => bondOfKey(k, i + 1));
const seven = (c) => ({ ...c, gameVerifySlots: 7, settlementSlots: 7 });

test('fourteen nodes: a v2 round is assigned 7 seats from the census and the beacon, written into the stored contract; its id does not move', () => {
  const root = rootFor(bonds14, []);
  const round = new Round(openStore(':memory:'), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const roster = new Roster(round, { chainFor: ({ contract } = {}) => chainWith(bonds14, contract), randomnessFor: ({ contract }) => beaconOf(bonds14, contract) });
  const c = { ...seven(contractWith([], root)), protocolVersion: 2 };
  const rid = round.open(c);
  assert.equal(toHex(rid), toHex(roundId(c)));
  const got = roster.assignSignerNodes(rid);
  assert.equal(got.ok, true, got.why);
  assert.equal(got.signerNodes.length, 7);
  const held = decodeRoundContract(new Uint8Array(round.get(rid).contract));
  assert.equal(held.nodes.length, 7, 'the seat wrote its 7 in');
  assert.deepEqual(held.nodes.map(toHex).sort(), got.signerNodes.map(toHex).sort());
  assert.deepEqual(round.signerNodes(rid).map(toHex), got.signerNodes.map(toHex).sort());
  assert.equal(toHex(roundId(held)), toHex(rid), 'the id of the contract with its seats is the round id');
  assert.equal(receiptsNeeded(held.nodes.length), 5, 'thresholds count the seated 7: 5 of 7');
  // the certified seating seats another 7 (a reserve for an absent one): it replaces them, the id still unmoved
  const others = fourteen.filter((k) => !got.signerNodes.some((s) => toHex(s) === toHex(k)));
  const certified = [...got.signerNodes.slice(1), others[0]];
  assert.equal(round.seatDrawFree(rid, certified), true);
  assert.deepEqual(decodeRoundContract(new Uint8Array(round.get(rid).contract)).nodes.map(toHex).sort(), certified.map(toHex).sort());
  assert.deepEqual(round.signerNodes(rid).map(toHex), certified.map(toHex).sort());
  assert.equal(round.seatDrawFree(rid, certified), false, 'the same seats again change nothing');
});

// kanban #786: the write-in is one transaction - all of it or none, one commit, and none of its own inside a caller's
test('a v2 write-in is all or nothing: a bad key leaves the contract and the signer nodes as they were; inside a transaction it opens none', () => {
  const root = rootFor(bonds14, []);
  const round = new Round(openStore(':memory:'), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const roster = new Roster(round, { chainFor: ({ contract } = {}) => chainWith(bonds14, contract), randomnessFor: ({ contract }) => beaconOf(bonds14, contract) });
  const rid = round.open({ ...seven(contractWith([], root)), protocolVersion: 2 });
  const got = roster.assignSignerNodes(rid);
  assert.equal(got.ok, true, got.why);
  const before = { contract: Buffer.from(round.get(rid).contract).toString('hex'), signers: round.signerNodes(rid).map(toHex) };
  const others = fourteen.filter((k) => !got.signerNodes.some((s) => toHex(s) === toHex(k)));
  // a failure after the UPDATE and the DELETE ran (the signer nodes' write throws)
  const record = round.recordSignerNodes;
  round.recordSignerNodes = () => { throw new Error('disk full'); };
  assert.throws(() => round.seatDrawFree(rid, [...got.signerNodes.slice(1), others[0]]), /disk full/);
  round.recordSignerNodes = record;
  assert.equal(Buffer.from(round.get(rid).contract).toString('hex'), before.contract, 'the contract is not rewritten');
  assert.deepEqual(round.signerNodes(rid).map(toHex), before.signers, 'the signer nodes are not deleted');
  assert.equal(round.db.isTransaction, false, 'and no transaction is left open');
  const certified = [...got.signerNodes.slice(1), others[0]];
  round.db.exec('BEGIN');
  assert.equal(round.seatDrawFree(rid, certified), true, 'inside a caller\'s transaction: no BEGIN of its own');
  assert.equal(round.db.isTransaction, true, 'the caller\'s transaction stays the caller\'s');
  round.db.exec('COMMIT');
  assert.deepEqual(round.signerNodes(rid).map(toHex), certified.map(toHex).sort());
});

test('fourteen nodes: a v1 contract naming 7 of them is refused - the draw it would have to name depends on its own id', () => {
  const root = rootFor(bonds14, fourteen.slice(0, 7));
  const round = new Round(openStore(':memory:'), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const roster = new Roster(round, { chainFor: ({ contract } = {}) => chainWith(bonds14, contract), randomnessFor: ({ contract }) => beaconOf(bonds14, contract) });
  const rid = round.open(seven(contractWith(fourteen.slice(0, 7), root)));
  const got = roster.assignSignerNodes(rid);
  assert.equal(got.ok, false);
  assert.match(got.why, /the census assigns/);
});
