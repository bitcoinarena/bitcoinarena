// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAYING FEDERATION ROUND IS TAKEN ONLY ON A FEDERATION WHOSE OWN THRESHOLD OF GUARDIANS ARE
// BONDED CENSUS NODES (§23.6, P3; 2026-09-15 07:33: "every guardian / node must have its
// own bond or it may not take part. federationIsBonded stays on").
//
// The signer node door assigns a round from the chain's census (assignSignerNodes). Before this it assigned a
// paying FEDERATION round on any federation: federationIsBonded had no caller. Now, where the signer node
// has a chain view, the round's federation is asked for its guardians (the signer node's stake-lock port:
// blwp-stake-lock --mode guardians, the stock client's config) and counted against the census the
// signer node derived: at least the federation's own threshold of its guardian keys advertised under
// guardian_of[] by distinct census nodes bonded at or above the round's bond_min. Otherwise 409,
// and the round is stored with no signer nodes - no receipts, no claim key, so no lock can name it.
//
// The census here is two bonded signer nodes, as in signer-node-committee.test.js; the federation's size and
// threshold are the port's, which stands in for the federation's config.
import { TWO_GATEWAYS } from './lock-fixture.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
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
import { toHex } from '../../arena-protocol/src/hash.js';
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
async function door({ advertised = [[], []], port }) {
  const signerNodes = [new Round(openStore(':memory:'), () => AFTER_COMMITTEE, { plugins: HOSTED }), new Round(openStore(':memory:'), () => AFTER_COMMITTEE, { plugins: HOSTED })];
  const keys = signerNodes.map((s) => s.pubkey);
  const bonds = keys.map((k, i) => bondOfKey(k, i + 1, advertised[i].map((g) => ({ federationId: TEST_FEDERATION_ID, guardianKey: g })),
    signerNodes[i].identity.secret));
  const root = rootFor(bonds, keys);
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, 
    port: 0, funded: () => true, stakeLocks: port,
    chainFor: ({ contract } = {}) => chainWith(bonds, contract), randomnessFor: ({ contract }) => beaconOf(bonds, contract),
  });
  const post = async (over = {}) => {
    const c = contractWith(keys, root, over);
    const r = await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    return { status: r.status, why: (await r.text()).trim(), signerNodes: node.round.signerNodes(roundId(c)).length, round: () => c };
  };
  return { node, post, bonds };
}

test('a paying FEDERATION round is taken when its federation\'s threshold of guardians are bonded census nodes, and refused with its count when they are not', async () => {
  const two = [guardianKey(1), guardianKey(2)];
  // (A) a 2-guardian federation, threshold 2: both guardians are the bonded signer nodes.
  const a = await door({ advertised: [[two[0]], [two[1]]], port: federation({ keys: two, threshold: 2 }) });
  // (B) a 4-guardian federation, threshold 3: the same two are bonded, two are nobody's.
  const four = [...two, guardianKey(3), guardianKey(4)];
  const b = await door({ advertised: [[two[0]], [two[1]]], port: federation({ keys: four, threshold: 3 }) });
  // (C) today's census: no node advertises a guardian.
  const c = await door({ port: federation({ keys: two, threshold: 2 }) });
  // (D) the signer node reaches another federation than the round names.
  const d = await door({ advertised: [[two[0]], [two[1]]], port: federation({ id: b32(0xfd), keys: two, threshold: 2 }) });
  try {
    const got = { a: await a.post(), b: await b.post(), c: await c.post(), d: await d.post() };
    console.log('  FACTS:', JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, { ...v, why: v.why.slice(0, 150) }]))));
    assert.equal(got.a.status, 201, got.a.why);
    assert.equal(got.a.signerNodes, 2, 'a bonded federation\'s round was not joined');
    assert.equal(got.b.status, 409);
    assert.match(got.b.why, /2 of that federation's 4 guardians are bonded census nodes, and its threshold is 3/);
    assert.equal(got.b.signerNodes, 0, 'a round on an unbonded federation was joined');
    assert.equal(got.c.status, 409);
    assert.match(got.c.why, /0 of that federation's 2 guardians are bonded census nodes/);
    assert.equal(got.c.signerNodes, 0);
    assert.equal(got.d.status, 409);
    assert.match(got.d.why, /reaches federation fdfd.* and that round names/);
    assert.equal(got.d.signerNodes, 0);
  } finally { for (const w of [a, b, c, d]) await w.node.close(); }
});

test('a free round is assigned on a census that lists no guardian and the federation is not asked; the withdrawn THRESHOLD_LN is no round', async () => {
  const port = federation({ keys: [guardianKey(1), guardianKey(2)], threshold: 2 });
  const w = await door({ port });
  try {
    // RULED 2026-09-22 22:59: THRESHOLD_LN does not exist - the codec refuses it before any door is asked.
    await assert.rejects(w.post({ custody: 'THRESHOLD_LN', federationId: new Uint8Array(32), configHash: TRUCK_V3_CONFIG_HASH, slashMinimumServed: 21 }),
      /THRESHOLD_LN is not a custody this network has/);
    const free = await w.post({ stakeMsat: 0n, federationId: new Uint8Array(32), configHash: TRUCK_V3_CONFIG_HASH, slashMinimumServed: 22 });
    console.log('  FACTS:', JSON.stringify({ free, asked: port.asked }));
    assert.equal(free.status, 201, free.why);
    assert.equal(free.signerNodes, 2);
    assert.equal(port.asked, 0, 'the federation was asked about a round that takes no stake into it');
  } finally { await w.node.close(); }
});

/**
 * THE PAGE COUNTS THEM ITSELF (M3 G2/G3). The signer node serves the bonds of the round's guardians out of
 * its census (/guardian-bonds) - candidates, not a count. The page proves each into headers of the
 * chain (here the same chain's headers, as a provider serves them), checks each advertisement is
 * signed by the node it names, and counts with the keys ITS OWN lock client read off the federation
 * (guardians(): here in that answer's shape). A signer node can omit and cannot forge.
 */
test('the page counts the guardians on the bonds a signer node serves: 2 of 2 proven; one omitted, or a branch altered, is refused; on the 4-guardian federation page and signer node refuse with the same count', async () => {
  const two = [guardianKey(1), guardianKey(2)];
  const four = [...two, guardianKey(3), guardianKey(4)];
  const answerOf = (keys, threshold) => ({
    federation_id: toHex(TEST_FEDERATION_ID), guardians: keys.length, threshold,
    keys: keys.map((k, peer) => ({ peer: String(peer), key: toHex(k) })),
  });
  const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
  const a = await door({ advertised: [[two[0]], [two[1]]], port: federation({ keys: two, threshold: 2 }) });
  const b = await door({ advertised: [[two[0]], [two[1]]], port: federation({ keys: four, threshold: 3 }) });
  try {
    const served = async (w) => {
      const joined = await w.post();
      const c = joined.round();
      const r = await fetch(`http://127.0.0.1:${w.node.port}/guardian-bonds?round=${toHex(roundId(c))}`);
      const body = await r.text();
      assert.equal(r.status, 200, body);
      return { joined, c, body, chain: chainWith(w.bonds, c).blocks.map((x) => x.header) };
    };
    const count = (s, keys, threshold, offers = offersFrom(s.body)) =>
      bondedGuardians({ guardians: guardiansOf(answerOf(keys, threshold)), round: s.c, chain: s.chain, offers, verify });

    const sa = await served(a);
    // THE UNBONDED FEDERATION'S ROUND IS NOT STORED (RULED 2026-09-25: the bond check runs before round.open), so the
    // signer node serves no guardian bonds for that round id - 404. The page counts federation B (4 keys, threshold 3)
    // against the guardian bonds served for the stored bonded round of (a): both doors' bonds advertise the same two
    // guardian keys, so what the page can prove about B's guardians is what the signer node counted when it refused.
    const bJoined = await b.post();
    const bRound = bJoined.round();
    const bBonds = await fetch(`http://127.0.0.1:${b.node.port}/guardian-bonds?round=${toHex(roundId(bRound))}`);
    const sb = { joined: bJoined, bondsStatus: bBonds.status, bondsWhy: (await bBonds.text()).trim() };
    const whole = await count(sa, two, 2);
    const omitted = await count(sa, two, 2, offersFrom(sa.body).slice(0, 1));
    const altered = offersFrom(sa.body);
    altered[1] = { ...altered[1], branch: altered[1].branch.map(() => new Uint8Array(32)) };
    const forged = await count(sa, two, 2, altered);
    const unbonded = await count(sa, four, 3);
    console.log('  FACTS:', JSON.stringify({
      a: { signerNode: sa.joined.status, served: JSON.parse(sa.body).bonds.length, whole, omitted: omitted.why, forged: { why: forged.why, refused: forged.refused } },
      b: { signerNode: sb.joined.status, joinWhy: sb.joined.why.slice(0, 120), bondsDoor: `${sb.bondsStatus} ${sb.bondsWhy.slice(0, 40)}`, page: unbonded.why },
    }));

    assert.equal(sa.joined.status, 201, sa.joined.why);
    assert.equal(JSON.parse(sa.body).bonds.length, 2, 'the signer node served another number of guardian bonds than its census holds');
    assert.equal(whole.ok, true, whole.why);
    assert.equal(whole.bonded, 2);
    assert.deepEqual(whole.refused, []);
    assert.equal(omitted.ok, false, 'one bond counted as a federation of two');
    assert.match(omitted.why, /1 of that federation's 2 guardians are bonded census nodes, and its threshold is 2/);
    assert.equal(forged.ok, false, 'a bond whose branch was altered was counted');
    assert.match(forged.refused.join(';'), /bond 1: the transaction is not in any block of that chain/);

    assert.equal(sb.joined.status, 409);
    assert.equal(sb.bondsStatus, 404, 'the refused round was stored: its guardian bonds were served');
    assert.equal(unbonded.ok, false);
    const said = /2 of that federation's 4 guardians are bonded census nodes, and its threshold is 3/;
    assert.match(unbonded.why, said);
    assert.match(sb.joined.why, said, 'page and signer node do not refuse with the same count');
  } finally { for (const w of [a, b]) await w.node.close(); }
});
