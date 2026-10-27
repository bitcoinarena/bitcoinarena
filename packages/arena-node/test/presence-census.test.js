// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A 22 CENSUS LESS ITS ABSENT, AT A SEAT AND AT THE CLIENT (§5A.3, kanban #727). On the seat's own fixture chain: a round of protocol 22
// whose root leaves out two absent nodes is served by a seat that holds the posting node's claim and finds nothing against it - and the
// client, from headers and the seat's census evidence alone, draws exactly the seat's committee, with neither absent node in it. A seat
// with no claim for the root, a seat holding an absent node's signature of the 24 h, and a round below 22 refuse the root by name.
// The presence book: proofs taken and served, claims kept, and the posting node asking before it leaves anyone out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { presenceBook } from '../src/presence-book.js';
import { chainOf, FIRST_TIME, SPACING, publicationOf } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { keyFor, bondFor } from './curve.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { committeeFromChain } from '../../arena-protocol/src/client-committee.js';
import { checkAbsent, presenceWindow } from '../../arena-protocol/src/presence.js';
import { signPresent } from '../../arena-protocol/src/seating.js';
import { PRESENCE_VERSION } from '../../arena-protocol/src/constants.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const AFTER_COMMITTEE = Number(BigInt(FIRST_TIME + 20 * SPACING) * 1000n);
const HEIGHT = 900000;
const COMMITTEE_TIME = BigInt(FIRST_TIME + 15 * SPACING) * 1000n;
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;
const beaconOf = (view, contract) => {
  const named = beaconFromChain(contract, { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight });
  if (!named.ok) throw new Error('this fixture chain names no beacon: ' + named.why);
  return { hash: named.hash, height: named.height, timeMs: named.timeMs };
};
const contractFor = (over = {}) => ({
  protocolVersion: PRESENCE_VERSION,
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 3, settlementSlots: 3, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: COMMITTEE_TIME + 60500n, entryCloseMs: COMMITTEE_TIME + 200000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: HEIGHT, censusRoot: b32(2),
  committeeTimeMs: COMMITTEE_TIME, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)], ...over,
});
const advertFor = (n, version) => ({
  nodePubkey: keyFor(n), operatorId: 'operator', protocolVersions: [version], roles: ['game', 'verify', 'settlement'], hostedGames: [NEXTBLOCK_GAME_ID],
  endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
});
const bondsAt = (version) => [1, 2, 3, 4, 5, 6].map((n) => bondTransaction(advertFor(n, version), { previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)) }));
const chainWith = (bonds, contract) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  if (contract) blocks[1] = { transactions: [publicationOf(contract)] };
  return chainOf(blocks, FROM);
};
const ABSENT = [2, 5].map((n) => toHex(keyFor(n))).sort();
const CLAIMS = ABSENT.map((node) => ({ node, drawnIn: [{ roundId: 'aa'.repeat(32), role: 'settlement' }] }));
const DRAWN_YESTERDAY = { drawn: [1, 2, 3, 4, 5, 6].map((n) => toHex(keyFor(n))) };

/** The root of the chain census at the contract's height, less `absent` - what the posting node writes. */
function rootFor(bonds, over, absent) {
  const contract = decodeRoundContract(encodeRoundContract(contractFor(over)));
  const view = chainWith(bonds);
  const byTxid = new Map();
  for (const block of view.blocks) for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const census = deriveCensus(view, { contract, bond: bondSetFor('regtest'), absent,
    resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  assert.equal(census.ok, true, census.why);
  return census;
}

/** A seat whose presence book is `absence`; the round's root leaves out `absent` (or not). */
function seat({ over = {}, absent = CLAIMS, absence }) {
  const version = over.protocolVersion ?? PRESENCE_VERSION;
  const bonds = bondsAt(version);
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const census = rootFor(bonds, over, absent);
  const contract = contractFor({ ...over, censusRoot: census.root });
  const rid = round.open(contract);
  const roster = new Roster(round, { chainFor: ({ contract: c } = {}) => chainWith(bonds, c),
    randomnessFor: ({ contract: c }) => beaconOf(chainWith(bonds, c), c), absence });
  return { round, rid, roster, bonds, census, contract: decodeRoundContract(new Uint8Array(round.get(rid).contract)) };
}
const book = ({ claims = CLAIMS, seen = [], drawOf = () => ({ ...DRAWN_YESTERDAY, closeMs: 0n }) } = {}) => ({
  claimFor: () => claims,
  // the window is the fixture chain's; the named seating closes inside it
  check: (c, { census, w }) => checkAbsent(c, { census, seen, drawOf: (r, role) => { const d = drawOf(r, role); return d ? { ...d, closeMs: w.toMs - 1n } : null; }, window: w }),
});
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const keys = (list) => list.map((k) => toHex(k)).sort();

test('a 22 round less its two absent: the seat serves it, and the client draws the seat\'s committee from the evidence alone', () => {
  const s = seat({ absence: book() });
  assert.equal(s.census.entries.length, 4, 'the posting node\'s census: six bonds less two absent');
  assert.deepEqual(s.census.excluded.filter((x) => x.step === 'absent').map((x) => toHex(x.pubkey)).sort(), ABSENT);
  const c = s.roster.censusFor(s.rid);
  assert.equal(c.ok, true, c.why);
  assert.deepEqual(c.absent.map((x) => x.node), ABSENT);
  const ev = s.roster.censusEvidenceFor(s.rid);
  assert.equal(ev.ok, true, ev.why);
  assert.equal(ev.entries.length, 4, 'the evidence a client gets is the census less the absent');
  const view = chainWith(s.bonds, s.contract);
  const mine = committeeFromChain({ contract: s.contract, roundId: s.rid, headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight,
    evidence: ev.entries, bond: bondSetFor('regtest'), verify });
  assert.equal(mine.ok, true, mine.why);
  for (const role of ['game', 'settlement']) {
    const at = s.roster.committeeFor(s.rid, role);
    assert.equal(at.ok, true, at.why);
    assert.deepEqual(keys(mine.drawn[role]), keys(at.drawn.map((e) => e.pubkey)), `${role}: the client and the seat draw one set`);
    for (const k of mine.drawn[role]) assert.ok(!ABSENT.includes(toHex(k)), 'an absent node is drawn by neither');
  }
});

test('no claim held for the root, a seat holding an absent node\'s window signature, a claim naming a seating that did not draw it: refused by name', () => {
  const none = seat({ absence: book({ claims: null }) });
  assert.match(none.roster.censusFor(none.rid).why, /no absent claim is held here for that root/);
  const seen = seat({ absence: book({ seen: [ABSENT[0]] }) });
  const r = seen.roster.censusFor(seen.rid);
  assert.equal(r.ok, false);
  assert.match(r.why, /this seat holds its signature of a seating in the 24 h/);
  assert.deepEqual(r.refuted, { node: ABSENT[0], proof: 'seen' });
  const notDrawn = seat({ absence: book({ drawOf: () => ({ drawn: [toHex(keyFor(1))] }) }) });
  assert.match(notDrawn.roster.censusFor(notDrawn.rid).why, /none of the seatings it names drew it/);
  // a fresh seat: it cannot draw the named seating, so it serves the round
  const fresh = seat({ absence: book({ drawOf: () => null }) });
  const f = fresh.roster.censusFor(fresh.rid);
  assert.equal(f.ok, true, f.why);
  assert.deepEqual(f.uncheckedAbsent, ABSENT);
  // no presence book at all: the root is any other root the chain does not give
  const bare = seat({ absence: null });
  assert.match(bare.roster.censusFor(bare.rid).why, /that round names census root .* and the chain gives/);
});

test('below protocol 22 nothing is left out: the posting node\'s census is the chain\'s, whatever it is handed', () => {
  const s = seat({ over: { protocolVersion: 20 }, absence: book() });
  assert.equal(s.census.entries.length, 6, 'a 20 census keeps every bond');
  const c = s.roster.censusFor(s.rid);
  assert.equal(c.ok, true, c.why);
  assert.equal(c.entries.length, 6);
});

test('the presence book: a peer\'s PRESENT taken as a proof clears a node the posting node would have left out; claims kept by root', async () => {
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const T = 1793145600000n, w = presenceWindow(T);
  const nodes = [1, 2, 3, 4].map((n) => ({ n, secret: new Uint8Array(32).fill(n), get pubkey() { return schnorr.getPublicKey(this.secret); } }));
  const rids = [b32(0x51), b32(0x52), b32(0x53)];
  for (const rid of rids) round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, new Uint8Array(1), Number(T) - 3600000);
  const closeOfRound = (rid) => { const i = rids.findIndex((r) => toHex(r) === toHex(rid)); return i < 0 ? null : (i === 2 ? T + 1n : T - BigInt(i + 1) * 60000n); };
  const roster = { committeeFor: () => ({ ok: true, drawn: nodes.map((x) => ({ pubkey: x.pubkey })) }) };
  const ROOT0 = 'c0'.repeat(32);
  const pb = presenceBook({ round, roster, verify, closeOfRound, rootOfRound: () => ROOT0 });
  // this seat holds node 1's PRESENT of round 0 (it was drawn there too)
  round.db.prepare('INSERT INTO seat_presents (round_id, role, node, bytes) VALUES (?, ?, ?, ?)').run(rids[0], 'settlement', toHex(nodes[0].pubkey),
    signPresent({ roundId: rids[0], role: 'settlement', nodePubkey: nodes[0].pubkey }, (m) => schnorr.sign(m, nodes[0].secret)));
  assert.equal(pb.seatingsIn(w).length, 4, 'two rounds in the window, two roles each; the third closes after the census');
  const census = nodes.map((x) => toHex(x.pubkey));
  // node 2's PRESENT is held only by a peer: asked for, taken, and node 2 is kept
  const peerHeld = signPresent({ roundId: rids[1], role: 'game', nodePubkey: nodes[1].pubkey }, (m) => schnorr.sign(m, nodes[1].secret));
  const asked = [];
  const claims = await pb.absentForPosting({ census, w, ask: async (list) => { asked.push(...list); return [toHex(peerHeld)]; } });
  assert.deepEqual(asked.sort(), census.slice(1).sort(), 'the three not seen here are asked for');
  assert.deepEqual(claims.map((c) => c.node).sort(), [toHex(nodes[2].pubkey), toHex(nodes[3].pubkey)].sort());
  assert.deepEqual(pb.proofsOf([toHex(nodes[1].pubkey)], w), [toHex(peerHeld)], 'the proof taken is served on to the next asker');
  // a PRESENT outside the window, or forged, is not a proof
  assert.match(pb.takeProof(signPresent({ roundId: rids[2], role: 'game', nodePubkey: nodes[2].pubkey }, (m) => schnorr.sign(m, nodes[2].secret)), w).why, /outside the 24 h/);
  assert.match(pb.takeProof(signPresent({ roundId: rids[0], role: 'game', nodePubkey: nodes[2].pubkey }, (m) => schnorr.sign(m, nodes[3].secret)), w).why, /not signed by the node it names/);
  // claims by root
  const root = 'cd'.repeat(32);
  assert.equal(pb.keepClaim(root, claims).ok, true);
  assert.deepEqual(pb.claimFor(root).map((c) => c.node), claims.map((c) => c.node));
  assert.equal(pb.claimFor('ef'.repeat(32)), null);
  assert.match(pb.keepClaim(root, [{ node: 'zz' }]).why, /32 bytes hex/);
  // and the seat's check of its own claim stands
  assert.equal(pb.check(claims, { census, w }).ok, true);
  assert.equal(pb.check([{ node: toHex(nodes[1].pubkey), drawnIn: [{ roundId: toHex(rids[1]), role: 'game' }] }], { census, w }).proof, 'seen');
  // ABSENT STAYS ABSENT UNTIL SEEN: the census the window's rounds were drawn from left node 4 out; it stays out, naming that root
  pb.keepClaim(ROOT0, [{ node: toHex(nodes[3].pubkey), drawnIn: [] }]);
  assert.deepEqual(pb.carriedIn(w), [{ node: toHex(nodes[3].pubkey), root: ROOT0 }]);
  const again = await pb.absentForPosting({ census, w });
  assert.equal(again.find((c) => c.node === toHex(nodes[3].pubkey)).from, ROOT0);
  assert.equal(pb.check(again, { census, w }).ok, true, 'a seat holding the claim of that root agrees');
  // and node 4 comes back by being seen: the rounds whose census names it absent, as their seatings come
  assert.deepEqual(pb.roundsToReturn(toHex(nodes[3].pubkey), Number(T - 3n * 60000n)).map(toHex), [toHex(rids[1])], 'the round whose seating closes in the next minute');
  assert.deepEqual(pb.roundsToReturn(toHex(nodes[3].pubkey), Number(T - 2n * 60000n)).map(toHex), [toHex(rids[0])], 'and then the next');
  assert.deepEqual(pb.roundsToReturn(toHex(nodes[0].pubkey), Number(T - 3n * 60000n)), [], 'a node no census left out signs nothing extra');
  assert.equal(pb.takeProof(signPresent({ roundId: rids[0], role: 'game', nodePubkey: nodes[3].pubkey }, (m) => schnorr.sign(m, nodes[3].secret)), null).ok, true);
  const cleared = await pb.absentForPosting({ census, w });
  assert.ok(!cleared.some((c) => c.node === toHex(nodes[3].pubkey)), 'seen once in the 24 h, it is in the next census');
  void fromHex;
});
