// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION THAT OPENS NO NEW ROUNDS (kanban #807, the owner 2026-11-02): on a real seat, with the real ids. The door takes a new round in A, refuses one in B
// by name with nothing stored, and a B round this seat already holds still answers: the page posts those to this door, and they play out.
import { TWO_GATEWAYS } from './lock-fixture.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { serve } from '../src/server.js';
import { chainOf, FIRST_TIME, SPACING, publicationOf } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { bondFor } from './curve.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { guardiansOf, offersFrom, bondedGuardians } from '../../arena-client/src/guardians.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const guardianKey = (n) => Uint8Array.from([0x02, ...b32(0x60 + n)]);
const AFTER_COMMITTEE = Number(BigInt(FIRST_TIME + 20 * SPACING) * 1000n);
const HEIGHT = 900000;
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;

const advertFor = (key, n, guardianOf) => ({
  nodePubkey: key, operatorId: `operator${n}`, protocolVersions: [1],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint: `ws://node${n}`, region: 'eu-west',
  capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf, timestamp: 1788700000000n,
});
/**
 * A real bond for a node's own identity key, its advertisement naming the guardian keys it runs -
 * signed by that key (5A.1), which the page checks when it counts guardians itself.
 */
const bondOfKey = (key, n, guardianOf = [], secret) => {
  const a = advertFor(key, n, guardianOf);
  return bondTransaction(a, {
    previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(key),
    signature: secret ? schnorr.sign(advertId(a), secret) : undefined,
  });
};
const chainWith = (bonds, contract) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  if (contract) blocks[1] = { transactions: [publicationOf(contract)] };
  return chainOf(blocks, FROM);
};
const beaconOf = (bonds, contract) => {
  const view = chainWith(bonds, contract);
  const named = beaconFromChain(contract, { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight });
  if (!named.ok) throw new Error('this fixture chain names no beacon: ' + named.why);
  return { hash: named.hash, height: named.height, timeMs: named.timeMs };
};
const contractWith = (nodes, censusRoot, over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 60500n,
  entryCloseMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: HEIGHT, censusRoot, committeeTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes, ...over,
});
function rootFor(bonds, nodes) {
  const contract = decodeRoundContract(encodeRoundContract(contractWith(nodes, b32(2))));
  const view = chainWith(bonds);
  const byTxid = new Map();
  for (const block of view.blocks) for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const census = deriveCensus(view, { contract, bond: bondSetFor('regtest'),
    resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  assert.equal(census.ok, true, census.why);
  return census.root;
}
/** The signer node's federation, as its stake-lock port answers: its id, its guardians' keys, its threshold. */
const federation = ({ id = TEST_FEDERATION_ID, keys, threshold }) => ({
  asked: 0,
  async guardians() { this.asked++; return { federationId: id, guardians: keys.length, threshold, keys }; },
  async fees() { return { ppm: 0n, baseMsat: 0n }; },
  // its two gateways, so §23.6's gateway gate is met and the guardian count is what these tests measure
  async gateways() { return { federationId: id, gateways: TWO_GATEWAYS }; },
});

/** Two signer nodes bonded on the chain - each advertising the guardian keys given - and one door. */
async function door({ advertised = [[], []], port, fed = TEST_FEDERATION_ID }) {
  const signerNodes = [new Round(openStore(':memory:'), () => AFTER_COMMITTEE, { plugins: HOSTED }), new Round(openStore(':memory:'), () => AFTER_COMMITTEE, { plugins: HOSTED })];
  const keys = signerNodes.map((s) => s.pubkey);
  const bonds = keys.map((k, i) => bondOfKey(k, i + 1, advertised[i].map((g) => ({ federationId: fed, guardianKey: g })),
    signerNodes[i].identity.secret));
  const root = rootFor(bonds, keys);
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, 
    port: 0, funded: () => true, stakeLocks: port,
    chainFor: ({ contract } = {}) => chainWith(bonds, contract), randomnessFor: ({ contract }) => beaconOf(bonds, contract),
  });
  // INSIDE THE ROUND'S ENTRY WINDOW, so /rounds would list a stored round.
  node.round.now = () => (FIRST_TIME + 15 * SPACING) * 1000 + 100000;
  const post = async (over = {}) => {
    const c = contractWith(keys, root, { federationId: fed, ...over });
    const r = await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    return { status: r.status, why: (await r.text()).trim(), signerNodes: node.round.signerNodes(roundId(c)).length, round: () => c };
  };
  return { node, post, bonds };
}

const A = fromHex('337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e'), B = fromHex('4dc88be70830d3619fd8742eaf639ab297774850cc68a203aad5b10a21e1fe98');
const two = [guardianKey(1), guardianKey(2)];

test('a new round opens in A', async () => {
  const w = await door({ fed: A, advertised: [[two[0]], [two[1]]], port: federation({ id: A, keys: two, threshold: 2 }) });
  try {
    const got = await w.post();
    const rid = roundId(got.round());
    console.log('  TOOK:', toHex(rid), 'federation', toHex(got.round().federationId).slice(0, 16), got.status);
    assert.equal(got.status, 201, got.why);
    assert.ok(w.node.round.get(rid));
  } finally { await w.node.close(); }
});

test('a new round in B is refused by name, nothing stored', async () => {
  const w = await door({ fed: B, advertised: [[two[0]], [two[1]]], port: federation({ id: B, keys: two, threshold: 2 }) });
  try {
    const got = await w.post();
    console.log('  REFUSED:', got.status, got.why);
    assert.equal(got.status, 409);
    assert.match(got.why, /^federation 4dc88be70830d361 opens no new rounds/);
    assert.ok(!w.node.round.get(roundId(got.round())));
  } finally { await w.node.close(); }
});

test('a B round the seat already holds still answers at the door', async () => {
  const w = await door({ fed: B, advertised: [[two[0]], [two[1]]], port: federation({ id: B, keys: two, threshold: 2 }) });
  const real = w.node.round.get;
  try {
    w.node.round.get = () => ({ contract: new Uint8Array(0) });   // the seat holds it: the gate must not be what answers
    const got = await w.post();
    console.log('  HELD:', got.status, got.why.slice(0, 90));
    assert.doesNotMatch(got.why, /opens no new rounds/);
  } finally { w.node.round.get = real; await w.node.close(); }
});
