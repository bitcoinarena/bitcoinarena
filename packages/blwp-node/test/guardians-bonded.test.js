// A PAYING FEDERATION ROUND IS SEATED ONLY ON A FEDERATION WHOSE OWN THRESHOLD OF GUARDIANS ARE
// BONDED CENSUS NODES (§23.6, P3; the owner 2026-09-15 07:33: "every guardian / node must have its
// own bond or it may not take part. federationIsBonded stays on").
//
// The seat door seats a round from the chain's census (seatRound). Before this it seated a
// paying FEDERATION round on any federation: federationIsBonded had no caller. Now, where the seat
// has a chain view, the round's federation is asked for its guardians (the seat's stake-lock port:
// blwp-stake-lock --mode guardians, the stock client's config) and counted against the census the
// seat derived: at least the federation's own threshold of its guardian keys advertised under
// guardian_of[] by distinct census nodes bonded at or above the round's bond_min. Otherwise 409,
// and the round is stored with no seats - no receipts, no claim key, so no lock can name it.
//
// The census here is two bonded seats, as in seated-committee.test.js; the federation's size and
// threshold are the port's, which stands in for the federation's config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { serve } from '../src/server.js';
import { chainOf, FIRST_TIME, SPACING, publicationOf } from '../../protocol/tools/chainview.js';
import { bondTransaction } from '../../protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { deriveCensus } from '../../protocol/src/census.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { bondFor } from './curve.js';
import { toHex } from '../../protocol/src/hash.js';
import { beaconFromChain } from '../../protocol/src/beacon.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const guardianKey = (n) => Uint8Array.from([0x02, ...b32(0x60 + n)]);
const AFTER_COMMITTEE = Number(BigInt(FIRST_TIME + 20 * SPACING) * 1000n);
const HEIGHT = 900000;
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;

const advertFor = (key, n, guardianOf) => ({
  nodePubkey: key, operatorId: `operator${n}`, protocolVersions: [1],
  roles: ['game', 'settlement'], endpoint: `ws://node${n}`, region: 'eu-west',
  capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf, timestamp: 1788700000000n,
});
/** A real bond for a node's own identity key, its advertisement naming the guardian keys it runs. */
const bondOfKey = (key, n, guardianOf = []) => bondTransaction(advertFor(key, n, guardianOf), {
  previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(key),
});
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
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  startTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 60500n,
  entryCloseMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: HEIGHT, censusRoot, committeeTimeMs: BigInt(FIRST_TIME + 15 * SPACING) * 1000n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
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
/** The seat's federation, as its stake-lock port answers: its id, its guardians' keys, its threshold. */
const federation = ({ id = TEST_FEDERATION_ID, keys, threshold }) => ({
  asked: 0,
  async guardians() { this.asked++; return { federationId: id, guardians: keys.length, threshold, keys }; },
  async fees() { return { ppm: 0n, baseMsat: 0n }; },
});

/** Two seats bonded on the chain - each advertising the guardian keys given - and one door. */
async function door({ advertised = [[], []], port }) {
  const keys = [new Round(openStore(':memory:'), () => AFTER_COMMITTEE).pubkey, new Round(openStore(':memory:'), () => AFTER_COMMITTEE).pubkey];
  const bonds = keys.map((k, i) => bondOfKey(k, i + 1, advertised[i].map((g) => ({ federationId: TEST_FEDERATION_ID, guardianKey: g }))));
  const root = rootFor(bonds, keys);
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, stakeLocks: port,
    chainFor: ({ contract } = {}) => chainWith(bonds, contract), randomnessFor: ({ contract }) => beaconOf(bonds, contract),
  });
  const post = async (over = {}) => {
    const c = contractWith(keys, root, over);
    const r = await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    return { status: r.status, why: (await r.text()).trim(), seats: node.round.seats(roundId(c)).length };
  };
  return { node, post };
}

test('a paying FEDERATION round is seated when its federation\'s threshold of guardians are bonded census nodes, and refused with its count when they are not', async () => {
  const two = [guardianKey(1), guardianKey(2)];
  // (A) a 2-guardian federation, threshold 2: both guardians are the bonded seats.
  const a = await door({ advertised: [[two[0]], [two[1]]], port: federation({ keys: two, threshold: 2 }) });
  // (B) a 4-guardian federation, threshold 3: the same two are bonded, two are nobody's.
  const four = [...two, guardianKey(3), guardianKey(4)];
  const b = await door({ advertised: [[two[0]], [two[1]]], port: federation({ keys: four, threshold: 3 }) });
  // (C) today's census: no node advertises a guardian.
  const c = await door({ port: federation({ keys: two, threshold: 2 }) });
  // (D) the seat reaches another federation than the round names.
  const d = await door({ advertised: [[two[0]], [two[1]]], port: federation({ id: b32(0xfd), keys: two, threshold: 2 }) });
  try {
    const got = { a: await a.post(), b: await b.post(), c: await c.post(), d: await d.post() };
    console.log('  FACTS:', JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, { ...v, why: v.why.slice(0, 150) }]))));
    assert.equal(got.a.status, 201, got.a.why);
    assert.equal(got.a.seats, 2, 'a bonded federation\'s round was not seated');
    assert.equal(got.b.status, 409);
    assert.match(got.b.why, /2 of that federation's 4 guardians are bonded census nodes, and its threshold is 3/);
    assert.equal(got.b.seats, 0, 'a round on an unbonded federation was seated');
    assert.equal(got.c.status, 409);
    assert.match(got.c.why, /0 of that federation's 2 guardians are bonded census nodes/);
    assert.equal(got.c.seats, 0);
    assert.equal(got.d.status, 409);
    assert.match(got.d.why, /reaches federation fdfd.* and that round names/);
    assert.equal(got.d.seats, 0);
  } finally { for (const w of [a, b, c, d]) await w.node.close(); }
});

test('a THRESHOLD_LN round and a free round are seated on a census that lists no guardian, and the federation is not asked', async () => {
  const port = federation({ keys: [guardianKey(1), guardianKey(2)], threshold: 2 });
  const w = await door({ port });
  try {
    const lightning = await w.post({ custody: 'THRESHOLD_LN', federationId: new Uint8Array(32), configHash: b32(0x44) });
    const free = await w.post({ stakeMsat: 0n, federationId: new Uint8Array(32), configHash: b32(0x45) });
    console.log('  FACTS:', JSON.stringify({ lightning, free, asked: port.asked }));
    assert.equal(lightning.status, 201, lightning.why);
    assert.equal(lightning.seats, 2);
    assert.equal(free.status, 201, free.why);
    assert.equal(free.seats, 2);
    assert.equal(port.asked, 0, 'the federation was asked about a round that takes no stake into it');
  } finally { await w.node.close(); }
});
