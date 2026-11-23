// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT census a5-2-1: newestCheckedCensus() (arena-client committee.js:622) answers the census of WHICHEVER round this page checked at
// the highest census height - a round's own census, filtered by that round's bond_min (and protocol version, depth). Its keys are then
// taken as "the network's bonded nodes": item-buy.js:161 (bondedKeys of the served list, mergeServedRounds drops every round whose
// committee has a key outside it) and the page's ARENA_CENSUS_KEYS (the collect scan's signed /settled answers, the item shop).
// A round naming a higher bond_min is taken by every seat ("stricter, and taken", server.js bondMinStands), so one such round at the
// newest census height - a stranger's POST /round or an honest higher bracket - that the lobby's prepRound checks narrows the page's
// bonded set: rounds served by the smaller bonds no longer count, and their nodes get no share of an item purchase.
// Safe behaviour: the keys a page takes as the network's bonded nodes at a height include every node bonded there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeSeatingCertificate, signSeating } from '../../arena-protocol/src/seating.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { chainOf, FIRST_TIME, SPACING, publicationOf } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { keyFor, bondFor } from './curve.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { committeeFromChain, censusFromEvidence } from '../../arena-protocol/src/client-committee.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { HOSTED } from './plugins/hosted.js';

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
// COMMITTEE_TIME IS INSIDE THIS CHAIN'S OWN CLOCK. It was 500 - 1970 - which
// is before every block a fixture ever mined, so the view could not say which
// block was FIRST after it: the true first would be Bitcoin block 1. The
// fixture chain now runs ten minutes a block from FIRST_TIME, and the round's
// committee time is a moment inside it.
const COMMITTEE_TIME = BigInt(FIRST_TIME + 15 * SPACING) * 1000n;
// THE BEACON IS THE CHAIN'S OWN. It used to be `{ hash: 0xbe repeated, height:
// 900005, timeMs: 900n }` - a block none of these fixture chains has - and the
// roster now asks whether the beacon is the block ITS chain names. One chain,
// one committee, so the fixture derives its beacon from the same blocks the
// census is derived from.
const beaconOf = (view, contract) => {
  const named = beaconFromChain(contract,
    { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight });
  if (!named.ok) throw new Error('this fixture chain names no beacon: ' + named.why);
  return { hash: named.hash, height: named.height, timeMs: named.timeMs };
};
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;

const contractFor = (over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: COMMITTEE_TIME + 60500n, entryCloseMs: COMMITTEE_TIME + 200000n,
  objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: HEIGHT, censusRoot: b32(2),
  committeeTimeMs: COMMITTEE_TIME, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)], ...over,
});

const advertFor = (n, roles, guardianOf = []) => ({
  nodePubkey: keyFor(n), operatorId: 'operator', protocolVersions: [1], roles, hostedGames: [NEXTBLOCK_GAME_ID],
  endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
  bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf, timestamp: 1788700000000n,
});
const bondOf = (n, roles = ['game'], guardianOf = [], value = 100000000) => bondTransaction(advertFor(n, roles, guardianOf), {
  previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)), value,
});

/** A mined chain carrying those bonds well under the census height. */
const chainWith = (bonds, contract) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  // AND THE ROUND'S PUBLICATION, well below any beacon (5A.5, v4.6.2): a node
  // signer nodes only a round its own chain shows published before the beacon block.
  if (contract) blocks[1] = { transactions: [publicationOf(contract)] };
  return chainOf(blocks, FROM);
};

/**
 * WHAT THE CHAIN GIVES, computed the way whoever opens a round computes it
 * before writing `censusRoot` into the contract. Every round names one, and
 * this node refuses a round whose named root is not what the blocks produce -
 * so a fixture has to be a round somebody could really have opened.
 */
function rootFor(bonds, over = {}) {
  // THROUGH THE ENCODING, because that is the contract the daemon reads: the
  // store keeps the bytes and hands back what `decodeRoundContract` makes of
  // them, protocol version and all. A root derived from the loose fixture
  // object would be a root of a contract nobody published.
  const contract = decodeRoundContract(encodeRoundContract(contractFor(over)));
  const view = chainWith(bonds);
  const byTxid = new Map();
  for (const block of view.blocks)
    for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const census = deriveCensus(view, {
    contract,
    bond: bondSetFor('regtest'),
    resolve: (e) => {
      const raw = byTxid.get(toHex(e.txid));
      return raw ? { transaction: raw } : null;
    },
  });
  assert.equal(census.ok, true, census.why);
  return census.root;
}

function daemon(bonds, over = {}) {
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const contract = contractFor({ ...over, censusRoot: rootFor(bonds, over) });
  const rid = round.open(contract);
  const roster = new Roster(round, { chainFor: ({ contract } = {}) => chainWith(bonds, contract),
    randomnessFor: ({ contract }) => beaconOf(chainWith(bonds, contract), contract) });
  return { round, rid, contract, roster };
}


const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const headersOf = (view) => view.blocks.map((b) => b.header);
const keys = (list) => list.map((k) => toHex(k)).sort();


import { clientCommittee, forgetSeatings, newestCheckedCensus } from '../../arena-client/src/committee.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { mergeServedRounds } from '../../arena-protocol/src/served-nodes.js';

const secretOf = (key) => { for (let n = 1; n <= 9; n++) if (toHex(keyFor(n)) === toHex(key)) return new Uint8Array(32).fill(n); throw new Error('no fixture secret for that key'); };
const certOf = (rid, role, seated) => encodeSeatingCertificate({ roundId: rid, role, seated,
  signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: rid, role, seated }, (m) => schnorr.sign(m, secretOf(k))) })) });

const ALL = ['game', 'verify', 'settlement'];
// three large bonds (1 BTC) and three at 100,000 sat - every one above the network's 50,000 sat floor
const BONDS = [1, 2, 3, 4, 5, 6].map((n) => bondOf(n, ALL, [], n <= 3 ? 100000000 : 100000));
const OVER = { gameVerifySlots: 2, settlementSlots: 2 };

async function check(d, view) {
  const contract = decodeRoundContract(new Uint8Array(d.round.get(d.rid).contract));
  const ev = d.roster.censusEvidenceFor(d.rid);
  assert.equal(ev.ok, true, ev.why);
  const headerBytes = Buffer.concat(headersOf(view).map((h) => Buffer.from(h)));
  const seated = {};
  for (const role of ['game', 'settlement']) seated[role] = d.roster.committeeFor(d.rid, role).drawn.map((e) => e.pubkey).slice(0, 2);
  const hex = (b) => Buffer.from(b).toString('hex');
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/headers') return new Response(headerBytes, { status: 200 });
    if (u.pathname === '/census') return new Response(JSON.stringify(ev), { status: 200 });
    const role = u.searchParams.get('role');
    if (u.pathname === '/seating') return new Response(JSON.stringify({ cert: hex(certOf(d.rid, role, seated[role])), index: 0 }), { status: 200 });
    if (u.pathname === '/committee') return new Response(Buffer.concat(seated[role].map((k) => Buffer.from(k))), { status: 200 });
    return new Response('no', { status: 404 });
  };
  const anchorAt = { hash: blockHashOf(headersOf(view)[0]), height: view.firstHeight };
  const got = await clientCommittee(toHex(d.rid), contract, ['https://seat-a.example', 'https://seat-b.example', 'https://seat-c.example'], { curve: pageCurve, fetcher, anchorAt });
  assert.equal(got.ok, true, got.why);
  return { contract, got };
}

test('audit census a5-2-1: a higher-bond_min round checked at the newest height does not shrink the page\'s bonded node set', async () => {
  forgetSeatings();
  // round A: the network's floor, at the census height - its census bonds all six nodes
  const a = daemon(BONDS, OVER);
  const viewA = chainWith(BONDS, a.contract);
  const A = await check(a, viewA);
  const before = newestCheckedCensus();
  assert.equal(before.nodes, 6, 'the census at the network floor bonds all six nodes');
  // round B: the same chain one block later, naming a bond_min of 1,000,000 sat (stricter: every seat takes it)
  const overB = { ...OVER, bondMinSats: 1000000n, censusHeight: HEIGHT + 1 };
  const b = daemon(BONDS, overB);
  const viewB = chainWith(BONDS, b.contract);
  const B = await check(b, viewB);
  const after = newestCheckedCensus();
  const keysAfter = after.entries.map((e) => toHex(e.pubkey));
  console.log('  MEASURED a5-2-1:', JSON.stringify({ heightA: Number(A.contract.censusHeight), nodesA: before.nodes, heightB: Number(B.contract.censusHeight),
    bondMinB: String(B.contract.bondMinSats), newestHeight: after.height, newestNodes: after.nodes }));
  // the item shop's served list with the page's bonded keys: an honest round served by node 1 and node 4 (both bonded at both heights)
  const served = mergeServedRounds([[{ roundId: b32(0x55), committee: [keyFor(1), keyFor(4)], finals: [] }]], { own: false, bonded: new Set(keysAfter) });
  assert.equal(after.nodes, 6, `the page's "network's bonded nodes" shrank to ${after.nodes} (${keysAfter.map((k) => k.slice(0, 8)).join(', ')}): the census of one round naming bond_min ${B.contract.bondMinSats}`);
  assert.equal(served.rounds.length, 1, 'a round served by two bonded nodes is dropped from the item purchase\'s served list');
});
