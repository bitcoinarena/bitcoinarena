// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2595 (seating attacker audit) finding 1: ONE seat hands the client a certificate no other seat holds, and the client takes it over the one
// every honest seat holds - then names every honest seat as the liar. The client's #2564 rule takes, of two certificates that check at one index, the
// "replacement" (seatingReplaces: one leaves out a member of the other and takes in only nodes ranked after it). But an ordered #738 pair is replace-shaped
// too: S, the seating of fewer PRESENTs (X's arrived late, or X was unreachable, #979), then T with X in, which every honest seat moved to and certified.
// S is complete whenever its members' old signatures over S are joined by the one member that signed T first and S late (wf1489 r6 census-1: M). The
// seats keep T (they never hold S unless someone posts it; after entries they refuse it, #2083). M serves S on its own GET /seating door only: the client
// derives S, every honest seat's /committee answers T, and the round is refused naming the honest seats, not M.
// Safe behaviour: a certificate one seat alone hands does not override, at the same index, the one more seats hand.
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
const bondOf = (n, roles = ['game'], guardianOf = []) => bondTransaction(advertFor(n, roles, guardianOf), {
  previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)),
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
const ROLES = [['game', 'verify', 'settlement'], ['game', 'settlement'], ['settlement'], ['game', 'verify'], ['game', 'verify', 'settlement'], ['settlement', 'game']];
const BONDS = ROLES.map((r, i) => bondOf(i + 1, r));
const OVER = { gameVerifySlots: 3, settlementSlots: 3 };
const headersOf = (view) => view.blocks.map((b) => b.header);
const keys = (list) => list.map((k) => toHex(k)).sort();

function setup() {
  const d = daemon(BONDS, OVER);
  const view = chainWith(BONDS, d.contract);
  const ev = d.roster.censusEvidenceFor(d.rid);
  assert.equal(ev.ok, true, ev.why);
  return { ...d, view, ev, contract: decodeRoundContract(new Uint8Array(d.round.get(d.rid).contract)) };
}

import { clientCommittee, settlementSignerNodesFrom, forgetSeatings } from '../../arena-client/src/committee.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';

const secretOf = (key) => { for (let n = 1; n <= 9; n++) if (toHex(keyFor(n)) === toHex(key)) return new Uint8Array(32).fill(n); throw new Error('no fixture secret for that key'); };
const certOf = (rid, role, seated) => encodeSeatingCertificate({ roundId: rid, role, seated,
  signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: rid, role, seated }, (m) => schnorr.sign(m, secretOf(k))) })) });

test('#2595 1: a certificate only one seat hands does not override the one every other seat holds', async () => {
  forgetSeatings();
  const { roster, rid, view, ev, contract } = setup();
  const headerBytes = Buffer.concat(headersOf(view).map((h) => Buffer.from(h)));
  const T = {}, S = {};
  for (const role of ['game', 'settlement']) {
    const drawn = roster.committeeFor(rid, role).drawn.map((e) => e.pubkey);
    assert.equal(drawn.length, 3, 'the fixture draws 3 for 3 seats');
    T[role] = drawn;                          // the seating every honest seat certified (#738: X = drawn[1] in)
    S[role] = [drawn[0], drawn[2]];           // the seating of fewer PRESENTs (X's missing), completed by M's late signature
  }
  const hex = (b) => Buffer.from(b).toString('hex');
  const nodes = ['https://bad.example', 'https://seat-a.example', 'https://seat-b.example', 'https://seat-c.example'];
  const fetcher = async (url) => {
    const bad = url.startsWith('https://bad.example');
    const u = new URL(url);
    if (u.pathname === '/headers') return new Response(headerBytes, { status: 200 });
    if (u.pathname === '/census') return new Response(JSON.stringify(ev), { status: 200 });
    const role = u.searchParams.get('role');
    if (u.pathname === '/seating') {
      const seated = bad && role === 'settlement' ? S[role] : T[role];
      return new Response(JSON.stringify({ cert: hex(certOf(rid, role, seated)), index: 0 }), { status: 200 });
    }
    // every seat, M too, answers the committee the seats hold: M lies only by the certificate it hands
    if (u.pathname === '/committee') return new Response(Buffer.concat(T[role].map((k) => Buffer.from(k))), { status: 200 });
    return new Response('no', { status: 404 });
  };
  const anchorAt = { hash: blockHashOf(headersOf(view)[0]), height: view.firstHeight };
  const got = await clientCommittee(toHex(rid), contract, nodes, { curve: pageCurve, fetcher, anchorAt });
  const named = (got.seats || []).filter((s) => s.agrees === false).map((s) => s.node);
  console.log('  MEASURED #2595 1:', JSON.stringify({ ok: got.ok, why: got.why || null, settlement: (got.committees.settlement || []).map((k) => toHex(k).slice(0, 8)),
    T: T.settlement.map((k) => toHex(k).slice(0, 8)), from: got.seating && got.seating.settlement && got.seating.settlement.from, named }));
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(keys(got.committees.settlement), keys(T.settlement),
    `the client took the certificate only ${got.seating.settlement.from} handed (${S.settlement.length} seated) over the one the three other seats hold, and named ${named.join(', ')} as the liars`);
  assert.doesNotThrow(() => settlementSignerNodesFrom(got), 'the round is refused for the client');
});
