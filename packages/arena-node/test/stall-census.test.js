// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STALLED NODES LEAVE THE DRAW, AT A SEAT AND AT THE CLIENT (§5A.3 "Stalled in its rounds", protocol 26, kanban #1044 option 2, ruling #1052). On the seat's own fixture chain, twelve
// bonded nodes, rounds of 7 seats: a claim of a node named by 4 seats of 3 duty rounds, signed for real, serves a round whose root leaves it out, at the seat and at the client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { presenceBook } from '../src/presence-book.js';
import { chainOf, FIRST_TIME, publicationOf } from '../../arena-protocol/tools/chainview.js';
// AN HOUR A BLOCK, so the fixture chain spans 30 h and its earlier rounds sit an hour apart inside the census's 24 h, each with a beacon
// of its own (the 3 missed closes of a proof lie at least 1 h apart, presence.js ABSENCE_PROOF_SPACING_MS)
const SPACING = 3600;
const timeOf = (i) => FIRST_TIME + i * SPACING;
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { keyFor, bondFor } from './curve.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { committeeFromChain, absenceFromChain } from '../../arena-protocol/src/client-committee.js';
import { presenceWindow, censusTimeMs } from '../../arena-protocol/src/presence.js';
import { signSeatingBound, signSeen, seatingId, encodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
import { STALL_VERSION } from '../../arena-protocol/src/constants.js';
import { stallBook } from '../src/stall-book.js';
import { STALL_STAGE, signStallNote, stallWindow, stallCloseMs, verifyStallNote, STALL_SEASON_BLOCKS } from '../../arena-protocol/src/stall.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { HOSTED } from './plugins/hosted.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { publicationOutput } from '../../arena-protocol/src/publication.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { dutyMarkerOutput, backupMarkerOutput, dutyDrawOrder, daySlotOf, DUTY_PROOF_RANKS } from '../../arena-protocol/src/duty.js';
import { creatorMessage } from '../../arena-protocol/src/creator.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODES = Array.from({ length: 12 }, (_, i) => i + 1);
// THE DUTY POSTING A ROUND BELONGS TO (kanban #727, only the duty postings' rounds prove): the day before its start posts it, by the
// first of that day's duty order over the six bonds; its publication carries the day marker, its contract names that creator. `rank`
// names another rank's key as the creator (a posting the proof rule does not take).
const DUTY_ITEM = 'nextblock-day';
const dutySlotOf = (c) => daySlotOf(Number(c.startTimeMs)) - 1;
// THE DUTY ORDER IS DRAWN BY BOND (kanban #1325): over the census entries this world's bonds make, one census per protocol version
const censusEntriesByVersion = new Map();
const censusEntriesOf = (v) => { if (!censusEntriesByVersion.has(v)) censusEntriesByVersion.set(v, rootFor(bondsAt(v), null, { protocolVersion: v }).entries); return censusEntriesByVersion.get(v); };
const dutyOrderOf = (c) => dutyDrawOrder({ networkId: NETWORK_ID_REGTEST, slot: dutySlotOf(c), entries: censusEntriesOf(c.protocolVersion ?? STALL_VERSION), sw: null });
const asDuty = (c, rank = 1) => ({ ...c, creatorPubkey: dutyOrderOf(c)[rank - 1] });
const rankOf = (c) => dutyOrderOf(c).findIndex((k) => toHex(k) === toHex(c.creatorPubkey)) + 1;
/**
 * THE PUBLICATIONS OF A DAY'S ROUNDS, AS THE DUTY POSTS THEM: one transaction per day and posting carrying every round of it and the day
 * marker - the primary's ('D') by the day's first in order, a backup's ('B') by another rank - and one plain publication per round of
 * nobody's duty. (A grid is one series published by one transaction; here each round has its own publication output in that transaction.)
 */
function publicationsOf(contracts) {
  const byPosting = new Map();
  const out = [];
  for (const c of contracts) {
    if (!c.creatorPubkey) { out.push(publicationOf(c)); continue; }
    const key = `${dutySlotOf(c)}:${rankOf(c) === 1 ? 'D' : 'B'}`;
    if (!byPosting.has(key)) byPosting.set(key, []);
    byPosting.get(key).push(c);
  }
  for (const [key, list] of byPosting) {
    const marker = key.endsWith(':D') ? dutyMarkerOutput(dutySlotOf(list[0]), DUTY_ITEM) : backupMarkerOutput(dutySlotOf(list[0]), DUTY_ITEM);
    out.push(serializeSpend({ inputs: [{ txid: roundId(list[0]), vout: 0, sequence: 0xffffffff }], outputs: [...list.map((c) => publicationOutput(roundId(c))), marker], witnesses: [[new Uint8Array(64)]] }));
  }
  return out;
}
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
  protocolVersion: STALL_VERSION,
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
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
const bondsAt = (version) => NODES.map((n) => bondTransaction(advertFor(n, version), { previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)) }));
const chainWith = (bonds, contracts = []) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  // a round naming a creator is a duty posting's: its publication carries the day marker (a self-posted round's carries none)
  if (contracts.length) blocks[1] = { transactions: publicationsOf(contracts) };
  return chainOf(blocks, FROM, { timeOf });
};
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const nOf = new Map(NODES.map((n) => [toHex(keyFor(n)), n]));
const signBy = (h) => (m) => schnorr.sign(m, b32(nOf.get(h)));
/** The creator's signature over a round's id, as the seat keeps it and GET /absent hands it over. */
const creatorSigOf = (c) => (c.creatorPubkey ? toHex(signBy(toHex(c.creatorPubkey))(creatorMessage(roundId(c)))) : null);

function rootFor(bonds, out, over = {}) {
  const contract = decodeRoundContract(encodeRoundContract(contractFor(over)));
  const view = chainWith(bonds);
  const byTxid = new Map();
  for (const block of view.blocks) for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const census = deriveCensus(view, { contract, bond: bondSetFor('regtest'), absent: out ? out.map((node) => ({ node })) : null,
    resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  assert.equal(census.ok, true, census.why);
  return census;
}
function certOf(s) {
  const rid = fromHex(s.roundId), k = s.seated.map(fromHex), role = 'settlement', present = s.seated;
  const id = seatingId({ roundId: rid, role, seated: k });
  return toHex(encodeSeatingCertificate({ roundId: rid, role, seated: k,
    signatures: s.seated.map((h) => ({ nodePubkey: fromHex(h), signature: signSeatingBound({ roundId: rid, role, seated: k }, signBy(h)) })),
    seen: [{ present, leftOut: [], signatures: s.seated.map((h) => ({ nodePubkey: fromHex(h), signature: signSeen({ roundId: rid, role, seating: id, present, leftOut: [] }, signBy(h)) })) }] }));
}
/**
 * THE WORLD: twelve bonded nodes, rounds of 7 seats of a drawn 9, ten earlier duty rounds an hour apart under the chain's own census. `target`s: the keys the round's root leaves out as stalled.
 * Each earlier round's seats are the first 7 of its draw; `book` a seat's presence and stall books over one store.
 */
// `later({ less, bonds, targets, over })`: more rounds on the chain and in the seat after the current one (kanban #1327: a duty round of this census, a later census)
function world({ out = 1, over = {}, selfPosted = 0, later = null } = {}) {
  const version = over.protocolVersion ?? STALL_VERSION;
  const bonds = bondsAt(version);
  const full = rootFor(bonds, null, over);
  const earlierAt = (j, nodes) => contractFor({ ...over, startTimeMs: COMMITTEE_TIME + 60500n - BigInt(j + 1) * 3600000n, entryCloseMs: COMMITTEE_TIME + 200000n - BigInt(j + 1) * 3600000n,
    committeeTimeMs: COMMITTEE_TIME - BigInt(j + 1) * 3600000n, censusRoot: full.root, ...(nodes ? { nodes } : {}) });
  const earlier = Array.from({ length: 10 }, (_, j) => asDuty(earlierAt(j)));
  const others = Array.from({ length: selfPosted }, (_, j) => earlierAt(j, [b32(0x50 + j)]));
  // who is seated, found on a first world with the census as it stands; the round's root is then written for them
  const seatsOf = (contracts) => {
    const view = chainWith(bonds, contracts);
    const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
    const roster = new Roster(round, { chainFor: () => view, randomnessFor: ({ contract: c }) => beaconOf(view, c) });
    return contracts.map((c) => { const rid = round.open(c); const d = roster.committeeFor(rid, 'settlement'); assert.equal(d.ok, true, d.why);
      return { roundId: toHex(rid), drawn: d.drawn.map((e) => toHex(e.pubkey)), seated: d.drawn.slice(0, 7).map((e) => toHex(e.pubkey)), self: !c.creatorPubkey, contract: c }; });
  };
  const list = seatsOf([...earlier, ...others]);
  const dutyRounds = list.filter((s) => !s.self);
  const count = new Map();
  for (const s of dutyRounds) for (const h of s.seated) count.set(h, (count.get(h) || 0) + 1);
  const targets = [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([h]) => h).slice(0, out);
  const less = rootFor(bonds, targets, over);
  const current = contractFor({ ...over, censusRoot: less.root });
  const laterContracts = later ? later({ less, bonds, targets, over }) : [];
  const view = chainWith(bonds, [current, ...earlier, ...others, ...laterContracts]);
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const roster = new Roster(round, { chainFor: () => view, randomnessFor: ({ contract: c }) => beaconOf(view, c) });
  const creators = {};
  const presence = presenceBook({ round, roster, verify, creatorOf: (r) => { const s = creators[toHex(r)]; return s ? fromHex(s) : null; } });
  const me = fromHex(toHex(round.pubkey));
  const stall = stallBook({ round, presence, verify, sign: (m) => schnorr.sign(m, round.identity.secret) });
  roster.absence = { claimFor: presence.claimFor, check: (claim, ctx) => { const a = presence.check(claim, ctx); return a.ok ? stall.check(claim, ctx) : a; } };
  const seatings = [];
  for (const c of [...earlier, ...others]) {
    const rid = round.open(c);
    if (c.creatorPubkey) creators[toHex(rid)] = creatorSigOf(c);
    const d = roster.committeeFor(rid, 'settlement');
    assert.equal(d.ok, true, d.why);
    seatings.push({ roundId: toHex(rid), drawn: d.drawn.map((e) => toHex(e.pubkey)), seated: d.drawn.slice(0, 7).map((e) => toHex(e.pubkey)), self: !c.creatorPubkey, contract: c });
  }
  const rid = round.open(current);
  const laterIds = laterContracts.map((c) => { const r = round.open(c); if (c.creatorPubkey) creators[toHex(r)] = creatorSigOf(c); return r; });
  const contract = decodeRoundContract(new Uint8Array(round.get(rid).contract));
  const w = presenceWindow(censusTimeMs(view, HEIGHT));
  const contracts = Object.fromEntries(seatings.map((s) => [s.roundId, toHex(new Uint8Array(round.get(fromHex(s.roundId)).contract))]));
  const publications = Object.fromEntries(seatings.map((s) => [s.roundId, presence.publicationProofOf(s.roundId)]));
  return { round, roster, presence, stall, rid, contract, view, seatings, w, contracts, publications, creators, bonds, less, targets, me, laterIds };
}
/** Four seats of a round (not `node`) sign notes naming `node`. */
const notesOf = (s, nodes, signers = s.seated.filter((h) => !nodes.includes(h)).slice(0, 4)) =>
  signers.map((h) => toHex(signStallNote({ roundId: fromHex(s.roundId), stage: STALL_STAGE.RESULT, silent: nodes }, fromHex(h), signBy(h))));
/** A claim of `nodes` at each's 3 rounds, each with its notes and certificate. */
function claimOf(W, nodes, { perNode = 3, notes = notesOf, rounds = null } = {}) {
  const certs = {};
  const stalled = [...nodes].sort().map((node) => {
    const list = (rounds || W.seatings.filter((s) => !s.self && s.seated.includes(node))).slice(0, perNode);
    for (const s of list) certs[`${s.roundId}:settlement`] = certOf(s);
    return { node, proofs: list.map((s) => ({ roundId: s.roundId, seatRound: s.roundId, notes: notes(s, [node]) })) };
  });
  return { claims: [], certs, stalled };
}
const client = (W, claim) => {
  const ev = W.roster.censusEvidenceFor(W.rid);
  const own = ev.ok ? committeeFromChain({ contract: W.contract, roundId: W.rid, headers: W.view.blocks.map((b) => b.header), firstHeight: W.view.firstHeight, evidence: ev.entries, bond: bondSetFor('regtest'), verify }) : null;
  return absenceFromChain({ contract: W.contract, claim: { ...claim, contracts: W.contracts, publications: W.publications, creators: W.creators }, headers: W.view.blocks.map((b) => b.header),
    firstHeight: W.view.firstHeight, evidenceOf: (r) => W.roster.censusEvidenceFor(fromHex(r)).entries, bond: bondSetFor('regtest'), verify, entries: own && own.ok ? own.checkedCensus.entries : W.less.entries });
};
const keys = (list) => list.map((k) => toHex(k)).sort();
const seatCheck = (W, claim) => {
  const census = W.roster.censusFor(W.rid, null, { asRoundsOwn: false });
  const out = new Set(claim.stalled.map((c) => c.node));
  return W.stall.check(claim, { census: census.entries.map((e) => toHex(e.pubkey)), w: W.w, entries: census.entries, keptEntries: census.entries.filter((e) => !out.has(toHex(e.pubkey))) });
};

test('a round less a node named by 4 seats of 3 duty rounds: the seat serves it, the client checks the same notes, both draw one set without it, and it is not absent', () => {
  const W = world();
  const [node] = W.targets;
  const claim = claimOf(W, [node]);
  assert.equal(claim.stalled[0].proofs.length, 3);
  const kept = W.presence.keepClaim(toHex(W.contract.censusRoot), claim);
  assert.equal(kept.ok, true, kept.why);
  assert.equal(kept.stalled, 1);
  const c = W.roster.censusFor(W.rid);
  assert.equal(c.ok, true, c.why);
  assert.deepEqual(c.stalled.map((x) => x.node), [node]);
  assert.deepEqual(c.absent, [], 'absence is another list: its SEENs and heartbeats do not name a stalled node');
  assert.equal(c.entries.length, 11);
  const got = client(W, claim);
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.stalled, [node]);
  const ev = W.roster.censusEvidenceFor(W.rid);
  const mine = committeeFromChain({ contract: W.contract, roundId: W.rid, headers: W.view.blocks.map((b) => b.header), firstHeight: W.view.firstHeight, evidence: ev.entries, bond: bondSetFor('regtest'), verify });
  assert.equal(mine.ok, true, mine.why);
  for (const role of ['game', 'settlement']) {
    const at = W.roster.committeeFor(W.rid, role);
    assert.deepEqual(keys(mine.drawn[role]), keys(at.drawn.map((e) => e.pubkey)), `${role}: one set`);
    assert.ok(!mine.drawn[role].some((k) => toHex(k) === node), 'the stalled node is drawn by neither');
  }
  // its bond stays in the census at the chain: the census key and a slash read the chain census
  assert.ok(W.roster.censusFor(W.rid, null, { asRoundsOwn: false }).entries.some((e) => toHex(e.pubkey) === node));
});

test('a claim that does not stand is refused by the seat and by the client, by name: 3 notes, 2 rounds, a self-posted round, a forged note, a seat not seated, over the cap', () => {
  const W = world({ selfPosted: 3 });
  const [node] = W.targets;
  const honest = claimOf(W, [node]);
  assert.equal(seatCheck(W, honest).ok, true, seatCheck(W, honest).why);
  assert.equal(client(W, honest).ok, true);
  const self = W.seatings.filter((s) => s.self && s.seated.includes(node));
  const cases = [
    ['note', claimOf(W, [node], { notes: (s, n) => notesOf(s, n).slice(0, 3) }), /3 seats of round .* named .*; it takes 4/],
    ['too-few', claimOf(W, [node], { perNode: 2 }), /on 2 rounds at least 1 h apart, each a fresh draw; it takes 3/],
    ['note', claimOf(W, [node], { notes: (s, n) => notesOf(s, n).map((h, i) => (i === 0 ? h.replace(/..$/, (x) => (x === '00' ? '01' : '00')) : h)) }), /does not stand/],
  ];
  if (self.length) cases.push(['not-duty', claimOf(W, [node], { rounds: [self[0], ...W.seatings.filter((s) => !s.self && s.seated.includes(node)).slice(0, 2)] }), /no duty marker|no duty posting/]);
  for (const [proof, claim, why] of cases) {
    const atSeat = seatCheck(W, claim);
    assert.equal(atSeat.ok, false, `${proof}: the seat refuses`);
    assert.equal(atSeat.proof, proof);
    assert.match(atSeat.why, why);
    const atClient = client(W, claim);
    assert.equal(atClient.ok, false, `${proof}: the client refuses`);
    assert.match(atClient.why, why);
  }
  // a node not seated at a round its notes name
  const notThere = W.seatings.find((s) => !s.self && !s.seated.includes(node));
  const bad = claimOf(W, [node], { rounds: [notThere, ...W.seatings.filter((s) => !s.self && s.seated.includes(node)).slice(0, 2)], notes: (s, n) => notesOf(s, n, s.seated.filter((h) => h !== node).slice(0, 4)) });
  assert.equal(seatCheck(W, bad).proof, 'not-seated');
  assert.match(client(W, bad).why, /was not seated/);
  // and the roster refuses the round by name, and does not serve it
  W.presence.keepClaim(toHex(W.contract.censusRoot), claimOf(W, [node], { perNode: 2 }));
  const r = W.roster.censusFor(W.rid);
  assert.equal(r.ok, false);
  assert.ok(r.refuted && r.refuted.node === node, r.why);
});

test('the cap: on 12 equal nodes 1 node is out; a claim of 2 is refused at the seat and the client, those named longest ago stay out', () => {
  const W = world({ out: 2 });
  const claim = claimOf(W, W.targets);
  const atSeat = seatCheck(W, claim);
  assert.equal(atSeat.ok, false);
  assert.equal(atSeat.proof, 'cap');
  assert.match(client(W, claim).why, /past the 10 % cap/);
});

test('below protocol 26 a claim with a stalled list is refused, and a claim with none is the bytes it always was', () => {
  const W = world({ over: { protocolVersion: 25 } });
  const claim = claimOf(W, [W.targets[0]]);
  W.presence.keepClaim(toHex(W.contract.censusRoot), claim);
  const r = W.roster.censusFor(W.rid);
  assert.equal(r.ok, false);
  assert.match(r.why, /not under the rule/);
  assert.match(client(W, claim).why, /not under the rule/);
  W.presence.keepClaim('ab'.repeat(32), { claims: [], certs: {} });
  // a posted claim is kept as an offer (kanban #1367), its bytes as they always were
  assert.equal(W.round.db.prepare('SELECT claim FROM absent_offers WHERE root = ?').get('ab'.repeat(32)).claim, '{"claims":[],"certs":{}}');
});

// THE SEAT'S OWN NOTES, on its own store
function failedRound(W, { seats, results, decidedAfter = 0, outcome = 'VOID', entry = 'e1' }) {
  const rid = fromHex(W.seatings[0].roundId);
  const db = W.round.db;
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('DELETE FROM signer_nodes WHERE round_id = ?').run(rid);
  for (const h of seats) db.prepare('INSERT INTO signer_nodes (round_id, pubkey) VALUES (?, ?)').run(rid, fromHex(h));
  const e = Buffer.alloc(32, entry);
  db.prepare('INSERT OR REPLACE INTO no_quorum (entry_id, round_id, outcome, why, decided_ms) VALUES (?, ?, ?, ?, ?)').run(e, rid, outcome, 'no result at the threshold', 5000);
  for (const [h, seen] of results) db.prepare('INSERT OR REPLACE INTO results (round_id, entry_id, node_pubkey, result_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)').run(rid, e, fromHex(h), Buffer.alloc(32), Buffer.alloc(1), seen + decidedAfter);
  return { rid, contract: decodeRoundContract(new Uint8Array(W.round.get(rid).contract)) };
}

test('a seat notes who gave it no signed result after a round failed, once its windows are over; never in a round that worked, never when it was silent itself', () => {
  const W = world();
  const me = toHex(W.round.pubkey);
  const others = W.seatings[0].seated.slice(0, 6);
  const seats = [me, ...others];
  const { rid, contract } = failedRound(W, { seats, results: [[me, 1], [others[0], 1], [others[1], 1]] });
  const end = windowsOf(contract);
  // one result after the entry was decided and inside the re-run window, one after that window
  { const { results } = { results: [[others[2], end.rerunDeadlineMs], [others[3], end.rerunDeadlineMs + 1n]] };
    for (const [h, seen] of results) W.round.db.prepare('INSERT INTO results (round_id, entry_id, node_pubkey, result_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)').run(rid, Buffer.alloc(32, 'e1'), fromHex(h), Buffer.alloc(32), Buffer.alloc(1), Number(seen)); }
  assert.deepEqual(W.stall.noteRound(rid, contract, end.ownFinalAfterMs, { upSinceMs: end.ownFinalAfterMs + 1n }), [], 'a seat not up at the moment signs nothing');
  assert.deepEqual(W.stall.noteRound(rid, contract, end.finalAfterMs), [], 'not before the re-run windows are over');
  const made = W.stall.noteRound(rid, contract, end.ownFinalAfterMs);
  assert.equal(made.length, 1);
  const v = verifyStallNote(made[0], { verify });
  assert.equal(v.ok, true, v.why);
  assert.equal(v.note.signer, me);
  assert.equal(v.note.stage, STALL_STAGE.RESULT);
  assert.deepEqual(v.note.silent, [others[3], others[4], others[5]].sort(), 'a slow seat inside the re-run window clears itself; past it, it is silent');
  assert.deepEqual(W.stall.noteRound(rid, contract, end.ownFinalAfterMs), [], 'once');
  assert.equal(W.stall.notesIn({ fromMs: 0n, toMs: stallCloseMs(contract) }).length, 1);
  // silent itself: nothing
  const W2 = world();
  const me2 = toHex(W2.round.pubkey);
  const o2 = W2.seatings[0].seated.slice(0, 6);
  const f2 = failedRound(W2, { seats: [me2, ...o2], results: [[o2[0], 1]] });
  assert.deepEqual(W2.stall.noteRound(f2.rid, f2.contract, windowsOf(f2.contract).ownFinalAfterMs), []);
  // everyone signed, and the entry failed on a split: nobody was silent
  const W3 = world();
  const me3 = toHex(W3.round.pubkey);
  const o3 = W3.seatings[0].seated.slice(0, 6);
  const f3 = failedRound(W3, { seats: [me3, ...o3], results: [[me3, 1], ...o3.map((h) => [h, 1])] });
  assert.deepEqual(W3.stall.noteRound(f3.rid, f3.contract, windowsOf(f3.contract).ownFinalAfterMs), []);
  // a FORFEIT is the player's, a seat that was not seated notes nothing
  const W4 = world();
  const me4 = toHex(W4.round.pubkey);
  const o4 = W4.seatings[0].seated.slice(0, 6);
  const f4 = failedRound(W4, { seats: [me4, ...o4], results: [[me4, 1]], outcome: 'FORFEIT' });
  assert.deepEqual(W4.stall.noteRound(f4.rid, f4.contract, windowsOf(f4.contract).ownFinalAfterMs), []);
  const f5 = failedRound(W4, { seats: o4, results: [[o4[0], 1]] });
  assert.deepEqual(W4.stall.noteRound(f5.rid, f5.contract, windowsOf(f5.contract).ownFinalAfterMs), []);
});

test('a seat notes who gave its last settlement pass nothing, 2 h after final_after with the settlement not landed; landed, or never asked, it notes nothing', () => {
  const W = world();
  const me = toHex(W.round.pubkey);
  const others = W.seatings[0].seated.slice(0, 6);
  const { rid, contract } = failedRound(W, { seats: [me, ...others], results: [] });
  W.round.db.prepare('DELETE FROM no_quorum').run();
  const at = windowsOf(contract).finalAfterMs + 7200000n;
  assert.deepEqual(W.stall.noteRound(rid, contract, at), [], 'never asked: nothing to list');
  W.round.putSettlePass({ roundId: rid, scope: '', step: 'commit', silent: [others[0], others[1], others[2]] });
  assert.deepEqual(W.stall.noteRound(rid, contract, at - 1n), [], 'not before the 2 h');
  W.round.putSettlePass({ roundId: rid, scope: '', step: 'ack', silent: [others[3], others[4], others[5]] });
  const made = W.stall.noteRound(rid, contract, at);
  assert.equal(made.length, 1);
  const v = verifyStallNote(made[0], { verify });
  assert.equal(v.note.stage, STALL_STAGE.SETTLEMENT);
  assert.deepEqual(v.note.silent, [others[3], others[4], others[5]].sort(), 'the last pass stands');
  const W2 = world();
  const me2 = toHex(W2.round.pubkey);
  const o2 = W2.seatings[0].seated.slice(0, 6);
  const f = failedRound(W2, { seats: [me2, ...o2], results: [] });
  W2.round.db.prepare('DELETE FROM no_quorum').run();
  W2.round.putSettlePass({ roundId: f.rid, scope: '', step: 'commit', silent: [o2[0]] });
  W2.round.putLockSettlement({ roundId: f.rid, txid: 'aa'.repeat(32), message: new Uint8Array(32), signature: new Uint8Array(64), state: 'ACCEPTED', why: 'landed' });
  assert.deepEqual(W2.stall.noteRound(f.rid, f.contract, windowsOf(f.contract).finalAfterMs + 7200000n), []);
});

test('below STALL_SETTLEMENT_HEIGHT a seat signs no settlement note, takes none and counts none; its RESULT notes go on (#1069)', () => {
  const W = world();
  const me = toHex(W.round.pubkey);
  const others = W.seatings[0].seated.slice(0, 6);
  const { rid, contract } = failedRound(W, { seats: [me, ...others], results: [[me, 1]] });
  const sign = (m) => schnorr.sign(m, W.round.identity.secret);
  const off = stallBook({ round: W.round, presence: W.presence, verify, sign, settlementPointOf: () => null });
  W.round.putSettlePass({ roundId: rid, scope: '', step: 'commit', silent: [others[0], others[1], others[2]] });
  const at = windowsOf(contract).finalAfterMs + 7200000n;
  const stages = (made) => made.map((b) => verifyStallNote(b, { verify }).note.stage);
  assert.deepEqual(stages(off.noteRound(rid, contract, at)), [STALL_STAGE.RESULT], 'the RESULT note and no settlement note');
  assert.equal(W.round.db.prepare('SELECT 1 FROM stall_noted WHERE round_id = ? AND stage = ?').get(rid, STALL_STAGE.SETTLEMENT), undefined, 'and none marked done');
});

test('below STALL_SETTLEMENT_HEIGHT no settlement note is taken, read for a posting or counted in a claim, on the seats\' real notes and certificates (#1069)', async () => {
  const W = world();
  const [node] = W.targets;
  const settlementNotes = (x, nodes, signers = x.seated.filter((h) => !nodes.includes(h)).slice(0, 4)) =>
    signers.map((h) => toHex(signStallNote({ roundId: fromHex(x.roundId), stage: STALL_STAGE.SETTLEMENT, silent: nodes }, fromHex(h), signBy(h))));
  const claim = claimOf(W, [node], { notes: settlementNotes });
  const notes = claim.stalled[0].proofs.flatMap((p) => p.notes);
  const certs = Object.values(claim.certs);
  const census = W.roster.censusFor(W.rid, null, { asRoundsOwn: false });
  const t = W.w.toMs;
  const off = stallBook({ round: W.round, presence: W.presence, verify, sign: (m) => schnorr.sign(m, W.round.identity.secret), settlementPointOf: () => null });
  const before = await off.forPosting({ entries: census.entries, t, ask: async () => ({ notes, certs }) });
  assert.deepEqual(before.stalled, [], 'not taken, so nobody named');
  assert.match(off.take(fromHex(notes[0])).why, /STALL_SETTLEMENT_HEIGHT/);
  // WHERE THE HEIGHT IS PASSED THE SAME NOTES NAME THE NODE: and a book off it reads none of those it holds
  const on = await W.stall.forPosting({ entries: census.entries, t, ask: async () => ({ notes, certs }) });
  assert.deepEqual(on.stalled.map((c) => c.node), [node]);
  assert.deepEqual((await off.forPosting({ entries: census.entries, t })).stalled, [], 'notes held are not read');
  const held = { claims: [], certs: on.certs, stalled: on.stalled };
  assert.equal(seatCheck(W, held).ok, true, seatCheck(W, held).why);
  const refused = off.check(held, { census: census.entries.map((e) => toHex(e.pubkey)), w: W.w, entries: census.entries, keptEntries: census.entries.filter((e) => toHex(e.pubkey) !== node) });
  assert.equal(refused.ok, false);
  assert.equal(refused.proof, 'note', refused.why);
});

test('a seat notes who did not sign FINAL once entries are due, once; a round at its threshold, an entry not at PROVISIONALLY_FINAL, or a seat that did not sign itself notes nothing', () => {
  const W = world();
  const me = toHex(W.round.pubkey);
  const others = W.seatings[0].seated.slice(0, 6);
  const { rid, contract } = failedRound(W, { seats: [me, ...others], results: [] });
  W.round.db.prepare('DELETE FROM no_quorum').run();
  let state = 'PROVISIONALLY_FINAL';
  const book = stallBook({ round: W.round, presence: null, verify, sign: (m) => schnorr.sign(m, W.round.identity.secret), stateOf: () => state });
  const sig = (entry, who, run = 2) => W.round.db.prepare('INSERT INTO final_sigs (round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)').run(rid, Buffer.alloc(32, entry), Buffer.alloc(32, run), fromHex(who), Buffer.alloc(1), 1);
  const due = windowsOf(contract).ownFinalAfterMs + 60000n;
  for (const k of [me, others[0], others[1], others[2]]) sig(1, k);
  assert.deepEqual(book.noteRound(rid, contract, due - 1n), [], 'not before entries are due');
  state = 'SUSPENDED';
  assert.deepEqual(book.noteRound(rid, contract, due), [], 'a held objection is no failed round');
  W.round.db.prepare('DELETE FROM stall_noted').run();
  state = 'PROVISIONALLY_FINAL';
  const made = book.noteRound(rid, contract, due);
  assert.equal(made.length, 1);
  const v = verifyStallNote(made[0], { verify });
  assert.equal(v.note.stage, STALL_STAGE.FINAL);
  assert.deepEqual(v.note.silent, [others[3], others[4], others[5]].sort());
  assert.deepEqual(book.noteRound(rid, contract, due + 1n), [], 'read once');
  W.round.db.prepare('DELETE FROM stall_noted').run();
  assert.deepEqual(book.noteRound(rid, contract, due, { upSinceMs: Number(due) + 1 }), [], 'a seat not up at the moment signs nothing');
  for (const k of [others[3]]) sig(1, k);
  W.round.db.prepare('DELETE FROM stall_noted').run();
  assert.deepEqual(book.noteRound(rid, contract, due), [], '5 of 7 signed: no failed round');
  const W2 = world();
  const me2 = toHex(W2.round.pubkey), o2 = W2.seatings[0].seated.slice(0, 6);
  const f = failedRound(W2, { seats: [me2, ...o2], results: [] });
  W2.round.db.prepare('DELETE FROM no_quorum').run();
  const book2 = stallBook({ round: W2.round, presence: null, verify, sign: (m) => schnorr.sign(m, W2.round.identity.secret), stateOf: () => 'PROVISIONALLY_FINAL' });
  for (const k of [o2[0], o2[1], o2[2]]) W2.round.db.prepare('INSERT INTO final_sigs (round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)').run(f.rid, Buffer.alloc(32, 1), Buffer.alloc(32, 2), fromHex(k), Buffer.alloc(1), 1);
  assert.deepEqual(book2.noteRound(f.rid, f.contract, windowsOf(f.contract).ownFinalAfterMs + 60000n), [], 'a seat that did not sign FINAL itself lists nobody');
});

test('the duty node: notes gathered from the seats, a seat holding them answers GET /stall-notes, and forPosting makes the claim a seat accepts', async () => {
  const W = world();
  const [node] = W.targets;
  const claim = claimOf(W, [node]);
  // another seat's store holds the notes; this one holds none
  const notes = claim.stalled[0].proofs.flatMap((p) => p.notes);
  const certs = Object.values(claim.certs);
  const census = W.roster.censusFor(W.rid, null, { asRoundsOwn: false });
  const t = W.w.toMs;
  const none = await W.stall.forPosting({ entries: census.entries, t });
  assert.deepEqual(none.stalled, [], 'no notes held, nobody named');
  const got = await W.stall.forPosting({ entries: census.entries, t, ask: async () => ({ notes, certs }) });
  assert.deepEqual(got.stalled.map((c) => c.node), [node]);
  assert.equal(got.stalled[0].proofs.length, 3);
  assert.equal(Object.keys(got.certs).length, 3);
  const back = { claims: [], certs: got.certs, stalled: got.stalled };
  assert.equal(seatCheck(W, back).ok, true, seatCheck(W, back).why);
  assert.equal(client(W, back).ok, true);
  const size = JSON.stringify(back.stalled[0]).length / 2 + Object.values(got.certs).reduce((s, h) => s + h.length / 2, 0);
  console.log(`one stalled node in a claim: ${back.stalled[0].proofs.flatMap((p) => p.notes).reduce((s, h) => s + h.length / 2, 0)} bytes of notes, ${Object.values(got.certs).reduce((s, h) => s + h.length / 2, 0)} bytes of certificates, ~${Math.round(size)} in all`);
  // the door takes a note only from a key its round drew
  const stranger = toHex(W.round.pubkey);
  const notDrawn = W.seatings.find((x) => !x.drawn.includes(stranger));
  const signed = signStallNote({ roundId: fromHex(notDrawn.roundId), stage: STALL_STAGE.RESULT, silent: [notDrawn.seated[0]] }, W.round.pubkey, (m) => schnorr.sign(m, W.round.identity.secret));
  assert.match(W.stall.take(signed).why, /was not drawn for that round/);
  const a = W.stall.answer(stallWindow(t));
  assert.equal(a.notes.length, notes.length);
  assert.equal(a.certs.length, 3);
});

// KANBAN #1327 (§5A.3, ruling #1350 A): a stalled node is out for a season from H3, carried forward by census - a later census names the earlier
// census root, a duty round of it and H3 instead of the proofs. Measured at the seat: the later census keeps the node out of its draw on the carried
// entry alone, and at H3 + STALL_SEASON_BLOCKS nothing is carried, so the node is drawn again.
test('#1327 a later census keeps a stalled node out of the draw on its carried entry, and takes it back at H3 + the season', async () => {
  const LATER = HEIGHT + 3;
  const W = world({ later: ({ less, bonds, targets, over }) => [
    asDuty(contractFor({ ...over, censusRoot: less.root })),                                                            // a duty round of the census that named the node
    contractFor({ ...over, censusHeight: LATER, censusRoot: rootFor(bonds, targets, { ...over, censusHeight: LATER }).root }) ] });   // the later census, the node out
  const [node] = W.targets;
  const [dutyRid, laterRid] = W.laterIds;
  // THE EARLIER CENSUS: the node out on its three proofs, the claim kept at this seat
  const claim = claimOf(W, [node]);
  const kept = W.presence.keepClaim(toHex(W.contract.censusRoot), claim);
  assert.equal(kept.ok, true, kept.why);
  // the earlier census read once, as a seat does: the offer stands and is kept for its root (#1367) - through the roster's stand hook, as server.js wires it
  W.roster.absence.stand = (rootHex, c) => W.presence.standClaim(rootHex, c);
  const first = W.roster.censusFor(W.rid);
  assert.deepEqual(first.stalled.map((x) => x.node), [node]);
  // THE LATER CENSUS: the poster carries the node - no proofs, the earlier root, its duty round, H3
  const census = W.roster.censusFor(laterRid, null, { asRoundsOwn: false });
  assert.equal(census.ok, true, census.why);
  const got = await W.stall.forPosting({ entries: census.entries, t: W.w.toMs, censusHeight: LATER });
  assert.deepEqual(got.stalled.map((x) => x.node), [node]);
  const carried = got.stalled[0];
  assert.equal(carried.proofs, undefined, 'carried, not proved afresh');
  assert.deepEqual([carried.carried.root, carried.carried.roundId, carried.carried.h3], [toHex(W.contract.censusRoot), toHex(dutyRid), HEIGHT]);
  // the seat keeps that claim and its draw leaves the node out
  const later = W.presence.keepClaim(toHex(decodeRoundContract(new Uint8Array(W.round.get(laterRid).contract)).censusRoot), { claims: [], certs: got.certs, stalled: got.stalled });
  assert.equal(later.ok, true, later.why);
  const c = W.roster.censusFor(laterRid);
  assert.equal(c.ok, true, c.why);
  assert.deepEqual(c.stalled.map((x) => x.node), [node]);
  for (const role of ['game', 'settlement']) {
    const d = W.roster.committeeFor(laterRid, role);
    assert.equal(d.ok, true, d.why);
    assert.ok(!d.drawn.some((e) => toHex(e.pubkey) === node), `${role}: the carried node was drawn`);
  }
  // THE SEASON: the last census inside it still carries the node, the first at H3 + STALL_SEASON_BLOCKS does not - the node is drawn again
  const inside = await W.stall.forPosting({ entries: census.entries, t: W.w.toMs, censusHeight: HEIGHT + STALL_SEASON_BLOCKS - 1 });
  const after = await W.stall.forPosting({ entries: census.entries, t: W.w.toMs, censusHeight: HEIGHT + STALL_SEASON_BLOCKS });
  console.log(`  MEASURED #1327: H3 ${HEIGHT}; census ${LATER} carried ${JSON.stringify(got.stalled.map((x) => x.node.slice(0, 8)))}, drawn without it; at ${HEIGHT + STALL_SEASON_BLOCKS - 1}: ${inside.stalled.length} carried; at ${HEIGHT + STALL_SEASON_BLOCKS}: ${after.stalled.length}`);
  assert.deepEqual(inside.stalled.map((x) => x.node), [node]);
  assert.deepEqual(after.stalled, [], 'carried past its season');
  // and a seat refuses that carried entry at a census past the season
  const checkAt = (h) => W.stall.check({ claims: [], certs: {}, stalled: got.stalled }, { census: census.entries.map((e) => toHex(e.pubkey)), w: W.w, entries: census.entries,
    keptEntries: census.entries.filter((e) => toHex(e.pubkey) !== node), censusHeight: h });
  assert.equal(checkAt(LATER).ok, true, checkAt(LATER).why);
  const late = checkAt(HEIGHT + STALL_SEASON_BLOCKS);
  assert.equal(late.ok, false);
  assert.match(late.why, /season out ended at block/);
});
