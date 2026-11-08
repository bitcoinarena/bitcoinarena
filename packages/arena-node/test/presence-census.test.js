// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A 22 CENSUS LESS ITS ABSENT, ONLY WITH PROOF, AT A SEAT AND AT THE CLIENT (§5A.3, kanban #727, the owner 2026-10-27). On the seat's own
// fixture chain: six bonded nodes, rounds of 3 seats drawing 3; node 5 is stopped. Its absence is proven by three seating certificates
// of other rounds of the 24 h, signed for real by their seated: drawn there, present at none. The seat serves a round whose root leaves
// node 5 out, and the client - from headers, the rounds' contracts and their census evidence alone - checks the same proofs and draws
// the seat's committee. A claim naming an honest node, a claim of 2 seatings, a forged or an under-threshold certificate: refused by
// the seat and by the client, by name. The presence book: the posting node's claim with its certificates, from what it holds and asks.
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
import { signSeatingBound, signSeen, seatingId, encodeSeatingCertificate, signPresent } from '../../arena-protocol/src/seating.js';
import { PRESENCE_VERSION } from '../../arena-protocol/src/constants.js';
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
// THE DUTY POSTING A ROUND BELONGS TO (kanban #727, only the duty postings' rounds prove): the day before its start posts it, by the
// first of that day's duty order over the six bonds; its publication carries the day marker, its contract names that creator. `rank`
// names another rank's key as the creator (a posting the proof rule does not take).
const DUTY_ITEM = 'nextblock-day';
const dutySlotOf = (c) => daySlotOf(Number(c.startTimeMs)) - 1;
// THE DUTY ORDER IS DRAWN BY BOND (kanban #1325): over the census entries this world's bonds make, one census per protocol version
const censusEntriesByVersion = new Map();
const censusEntriesOf = (v) => { if (!censusEntriesByVersion.has(v)) censusEntriesByVersion.set(v, rootFor(bondsAt(v), null, { protocolVersion: v }).entries); return censusEntriesByVersion.get(v); };
const dutyOrderOf = (c) => dutyDrawOrder({ networkId: NETWORK_ID_REGTEST, slot: dutySlotOf(c), entries: censusEntriesOf(c.protocolVersion ?? PRESENCE_VERSION), sw: null });
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
const chainWith = (bonds, contracts = []) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  // a round naming a creator is a duty posting's: its publication carries the day marker (a self-posted round's carries none)
  if (contracts.length) blocks[1] = { transactions: publicationsOf(contracts) };
  return chainOf(blocks, FROM, { timeOf });
};
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const nOf = new Map([1, 2, 3, 4, 5, 6].map((n) => [toHex(keyFor(n)), n]));
const signBy = (h) => (m) => schnorr.sign(m, b32(nOf.get(h)));
const STOPPED = toHex(keyFor(5));
const LIVE_ONE = toHex(keyFor(1));
/** The creator's signature over a round's id, as the seat keeps it and GET /absent hands it over. */
const creatorSigOf = (c) => (c.creatorPubkey ? toHex(signBy(toHex(c.creatorPubkey))(creatorMessage(roundId(c)))) : null);

/** The root of the chain census at HEIGHT less `absent` - what the posting node writes. */
function rootFor(bonds, absent, over = {}) {
  const contract = decodeRoundContract(encodeRoundContract(contractFor(over)));
  const view = chainWith(bonds);
  const byTxid = new Map();
  for (const block of view.blocks) for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const census = deriveCensus(view, { contract, bond: bondSetFor('regtest'), absent: absent ? absent.map((node) => ({ node })) : null,
    resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  assert.equal(census.ok, true, census.why);
  return census;
}

/** A 22 certificate of a seating, signed for real by its seated: `present` what each lists, `seenSigner` who signs the SEEN. */
function certOf(s, { present = s.seated, seated = s.seated, seenSigner = signBy } = {}) {
  const rid = fromHex(s.roundId), keys = seated.map(fromHex);
  const id = seatingId({ roundId: rid, role: s.role, seated: keys });
  return toHex(encodeSeatingCertificate({ roundId: rid, role: s.role, seated: keys,
    signatures: seated.map((h) => ({ nodePubkey: fromHex(h), signature: signSeatingBound({ roundId: rid, role: s.role, seated: keys }, signBy(h)) })),
    seen: [{ present, leftOut: [], signatures: seated.map((h) => ({ nodePubkey: fromHex(h), signature: signSeen({ roundId: rid, role: s.role, seating: id, present, leftOut: [] }, seenSigner(h)) })) }] }));
}

/**
 * THE WORLD: one chain holding every round's publication, a seat with its presence book, earlier rounds of the 24 h (their census
 * the chain's own), and the seatings among them that drew the stopped node at different closes - its proofs.
 */
function world({ over = {}, absent = [STOPPED], rounds = 8, selfPosted = 0, wrongRank = 0, least = 4 } = {}) {
  const bonds = bondsAt(over.protocolVersion ?? PRESENCE_VERSION);
  const full = rootFor(bonds, null, over), less = rootFor(bonds, absent, over);
  const current = contractFor({ ...over, censusRoot: less.root });
  // an hour apart, so any 3 of their closes count (presence.js ABSENCE_PROOF_SPACING_MS); every one a duty posting's round (kanban #727)
  const earlierAt = (j, nodes) => contractFor({ ...over, startTimeMs: COMMITTEE_TIME + 60500n - BigInt(j + 1) * 3600000n,
    entryCloseMs: COMMITTEE_TIME + 200000n - BigInt(j + 1) * 3600000n, committeeTimeMs: COMMITTEE_TIME - BigInt(j + 1) * 3600000n, censusRoot: full.root, ...(nodes ? { nodes } : {}) });
  const earlier = Array.from({ length: rounds }, (_, j) => asDuty(earlierAt(j)));
  // AND ROUNDS THAT ARE NO DUTY POSTING'S: self-posted (no marker, no creator), or marked but by a creator past the first 3 of the day's order
  // (at the same closes as the duty rounds - the chain is 20 blocks, an hour each - told apart by their `nodes`)
  const others = [...Array.from({ length: selfPosted }, (_, j) => earlierAt(j % rounds, [b32(0x50 + j)])),
    ...Array.from({ length: wrongRank }, (_, j) => asDuty(earlierAt(j % rounds, [b32(0x70 + j)]), DUTY_PROOF_RANKS + 1 + (j % 3)))];
  const view = chainWith(bonds, [current, ...earlier, ...others]);
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const roster = new Roster(round, { chainFor: () => view, randomnessFor: ({ contract: c }) => beaconOf(view, c) });
  const book = presenceBook({ round, roster, verify, creatorOf: (r) => { const s = creators[toHex(r)]; return s ? fromHex(s) : null; } });
  roster.absence = { claimFor: book.claimFor, check: book.check };
  const creators = {};
  const seatings = [], other = [];
  const seatingOf = (c, into) => {
    const rid = round.open(c);
    if (c.creatorPubkey) creators[toHex(rid)] = creatorSigOf(c);
    for (const role of ['settlement', 'game']) {
      const d = roster.committeeFor(rid, role);
      assert.equal(d.ok, true, d.why);
      const drawn = d.drawn.map((e) => toHex(e.pubkey));
      if (drawn.includes(STOPPED)) { into.push({ roundId: toHex(rid), role, drawn, seated: drawn.filter((h) => h !== STOPPED), duty: !!c.creatorPubkey && into === seatings }); break; }
    }
  };
  for (const c of earlier) seatingOf(c, seatings);
  for (const c of others) seatingOf(c, other);
  if (rounds) assert.ok(seatings.length >= least, `the earlier rounds drew the stopped node at ${least} or more closes`);
  const rid = round.open(current);
  const contract = decodeRoundContract(new Uint8Array(round.get(rid).contract));
  const w = presenceWindow(censusTimeMs(view, HEIGHT));
  const named = [...seatings, ...other];
  const contracts = Object.fromEntries(named.map((s) => [s.roundId, toHex(new Uint8Array(round.get(fromHex(s.roundId)).contract))]));
  // what GET /absent hands a client beside the contracts: each named round's publication with its branch, and its creator's signature
  const publications = Object.fromEntries(named.map((s) => [s.roundId, book.publicationProofOf(s.roundId)]));
  return { round, roster, book, rid, contract, view, seatings, other, w, contracts, publications, creators, bonds, less };
}
const proofsOf = (list) => list.map((s) => ({ roundId: s.roundId, role: s.role }));
/** A claim of `node` at `list` seatings, with `certs` (default: each signed honestly). */
const claimOf = (node, list, certs = Object.fromEntries(list.map((s) => [`${s.roundId}:${s.role}`, certOf(s)]))) => ({ claims: [{ node, proofs: proofsOf(list) }], certs });
/** The client's check: the claim, the rounds' contracts and census evidence a seat hands over, the headers. */
const client = (W, claim) => {
  // the round's own census as the client checked it (none where the seat serves it no census: nothing to hold the claim against)
  const ev = W.roster.censusEvidenceFor(W.rid);
  const own = ev.ok ? committeeFromChain({ contract: W.contract, roundId: W.rid, headers: W.view.blocks.map((b) => b.header), firstHeight: W.view.firstHeight,
    evidence: ev.entries, bond: bondSetFor('regtest'), verify }) : null;
  return absenceFromChain({ contract: W.contract, claim: { ...claim, contracts: W.contracts, publications: W.publications, creators: W.creators }, headers: W.view.blocks.map((b) => b.header),
    firstHeight: W.view.firstHeight, evidenceOf: (r) => W.roster.censusEvidenceFor(fromHex(r)).entries, bond: bondSetFor('regtest'), verify, entries: own && own.ok ? own.checkedCensus.entries : [] });
};
const keys = (list) => list.map((k) => toHex(k)).sort();

test('a 22 round less a node proven absent at 3 seatings: the seat serves it, and the client checks the same proofs and draws the seat\'s committee', () => {
  const W = world();
  assert.equal(W.less.entries.length, 5, 'six bonds less the stopped one');
  const claim = claimOf(STOPPED, W.seatings.slice(0, 3));
  assert.equal(W.book.keepClaim(toHex(W.contract.censusRoot), claim).ok, true);
  const c = W.roster.censusFor(W.rid);
  assert.equal(c.ok, true, c.why);
  assert.deepEqual(c.absent.map((x) => x.node), [STOPPED]);
  const ev = W.roster.censusEvidenceFor(W.rid);
  assert.equal(ev.ok, true, ev.why);
  assert.equal(ev.entries.length, 5, 'the evidence a client gets is the census less the absent');
  const got = client(W, claim);
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.absent, [STOPPED]);
  const mine = committeeFromChain({ contract: W.contract, roundId: W.rid, headers: W.view.blocks.map((b) => b.header), firstHeight: W.view.firstHeight,
    evidence: ev.entries, bond: bondSetFor('regtest'), verify });
  assert.equal(mine.ok, true, mine.why);
  for (const role of ['game', 'settlement']) {
    const at = W.roster.committeeFor(W.rid, role);
    assert.equal(at.ok, true, at.why);
    assert.deepEqual(keys(mine.drawn[role]), keys(at.drawn.map((e) => e.pubkey)), `${role}: the client and the seat draw one set`);
    assert.ok(!mine.drawn[role].some((k) => toHex(k) === STOPPED), 'the absent node is drawn by neither');
  }
});

test('a claim naming an honest node is refused by the seat and by the client: listed present, 2 seatings only, a forged certificate, one under threshold', () => {
  const W = world();
  const three = W.seatings.slice(0, 3);
  const k0 = `${three[0].roundId}:${three[0].role}`;
  const cases = [
    // 1. a seated node of a named seating listed it present: it was there
    ['present', claimOf(STOPPED, three, { ...claimOf(STOPPED, three).certs, [k0]: certOf(three[0], { present: [...three[0].seated, STOPPED] }) }), /lists it present/],
    // 2. proven at 2 seatings only (a node flooded at 2 of its seatings)
    ['too-few', claimOf(STOPPED, three.slice(0, 2)), /on 2 missed close\(s\) at least 1 h apart; it takes 3/],
    // 3. a forged certificate: who was present signed by a key that is not the seated
    ['certificate', claimOf(STOPPED, three, { ...claimOf(STOPPED, three).certs, [k0]: certOf(three[0], { seenSigner: () => signBy(LIVE_ONE === three[0].seated[0] ? three[0].seated[1] : LIVE_ONE) }) }), /does not stand/],
    // 4. under threshold: one seated of a 3-seat round needing 2
    ['certificate', claimOf(STOPPED, three, { ...claimOf(STOPPED, three).certs, [k0]: certOf(three[0], { seated: three[0].seated.slice(0, 1), present: three[0].seated.slice(0, 1) }) }), /fewer than the 2/],
  ];
  const census = W.roster.censusFor(W.rid, null, { asRoundsOwn: false });
  for (const [proof, claim, why] of cases) {
    const atSeat = W.book.check(claim, { census: census.entries.map((e) => toHex(e.pubkey)), w: W.w });
    assert.equal(atSeat.ok, false, `${proof}: the seat refuses`);
    assert.equal(atSeat.proof, proof);
    assert.match(atSeat.why, why);
    const atClient = client(W, claim);
    assert.equal(atClient.ok, false, `${proof}: the client refuses`);
    assert.match(atClient.why, why);
  }
  // a live node named absent at seatings that never drew it
  const notDrawn = claimOf(LIVE_ONE, W.seatings.filter((s) => !s.drawn.includes(LIVE_ONE)).slice(0, 3));
  if (notDrawn.claims[0].proofs.length === 3) assert.match(client(W, notDrawn).why, /neither drew it .*nor had it left out/);
  // a seat holding a window certificate that lists the stopped node present refuses whatever the claim names
  const fourth = W.seatings[3];
  assert.equal(W.book.takeCert(fromHex(certOf(fourth, { present: [...fourth.seated, STOPPED] }))).ok, true);
  const held = W.book.check(claimOf(STOPPED, three), { census: census.entries.map((e) => toHex(e.pubkey)), w: W.w });
  assert.equal(held.proof, 'seen');
  // and wired through the roster: the round's census is refused by name, and not served
  W.book.keepClaim(toHex(W.contract.censusRoot), claimOf(STOPPED, three.slice(0, 2)));
  const r = W.roster.censusFor(W.rid);
  assert.equal(r.ok, false);
  assert.ok(r.refuted && r.refuted.node === STOPPED, r.why);
});

// ONLY THE DUTY POSTINGS' ROUNDS PROVE (kanban #727; the heartbeat helper's open hole: a group that posts many rounds of its own gets more
// draws to land 5 of its nodes in). A certificate of a self-posted round - no duty marker on its publication - or of a marked round whose
// creator is past the first 3 of its day's duty order is refused as proof by the seat and by the client, by name; the posting node never
// names one, however many it holds. The duty rounds of the same window are taken as before.
test('a certificate of a self-posted series proves nothing: refused as proof at the seat and at the client; the day\'s duty rounds are accepted; the posting node names only them', async () => {
  // (8 and 3: with them in the publication block the fixture's draws give 6 duty seatings and 7 others that drew the stopped node)
  const W = world({ selfPosted: 8, wrongRank: 3, least: 3 });
  const self = W.other.filter((s) => !W.contracts[s.roundId] || !decodeRoundContract(fromHex(W.contracts[s.roundId])).creatorPubkey);
  const late = W.other.filter((s) => !self.includes(s));
  assert.ok(self.length >= 2 && late.length >= 1, `the self-posted (${self.length}) and the wrong-rank (${late.length}) rounds drew the stopped node`);
  const census = W.roster.censusFor(W.rid, null, { asRoundsOwn: false }).entries.map((e) => toHex(e.pubkey));
  // the seat's and the client's duty check of a named round, by itself
  for (const s of W.seatings) { const d = W.book.dutyOf(s.roundId); assert.equal(d.ok, true, d.why); assert.equal(d.rank, 1); }
  assert.match(W.book.dutyOf(self[0].roundId).why, /no duty marker/);
  assert.match(W.book.dutyOf(late[0].roundId).why, new RegExp(`rank [${DUTY_PROOF_RANKS + 1}-6] of its day's duty order`));
  assert.ok(W.publications[self[0].roundId] && W.publications[late[0].roundId], 'their publications are handed over too (the client reads the marker off them)');
  const cases = [
    ['a self-posted round', claimOf(STOPPED, [self[0], ...W.seatings.slice(0, 2)]), /no duty marker/],
    ['a creator past the first 3', claimOf(STOPPED, [late[0], ...W.seatings.slice(0, 2)]), /of its day's duty order; a duty posting is by one of the first 3/],
  ];
  for (const [what, claim, why] of cases) {
    const atSeat = W.book.check(claim, { census, w: W.w });
    assert.equal(atSeat.ok, false, `${what}: the seat refuses`);
    assert.equal(atSeat.proof, 'not-duty');
    assert.match(atSeat.why, why);
    const atClient = client(W, claim);
    assert.equal(atClient.ok, false, `${what}: the client refuses`);
    assert.match(atClient.why, why);
  }
  // the client reads the publication and the creator's signature itself: without them, or with another key's signature, no proof
  const duty = claimOf(STOPPED, W.seatings.slice(0, 3));
  assert.equal(client(W, duty).ok, true, 'the day\'s duty rounds are accepted');
  assert.equal(W.book.check(duty, { census, w: W.w }).ok, true);
  const r0 = W.seatings[0].roundId;
  assert.match(client({ ...W, publications: { ...W.publications, [r0]: undefined } }, duty).why, /publication was not handed over/);
  assert.match(client({ ...W, publications: { ...W.publications, [r0]: W.publications[self[0].roundId] } }, duty).why, /does not publish it/);
  const creator0 = toHex(decodeRoundContract(fromHex(W.contracts[r0])).creatorPubkey);
  const forger = [1, 2, 3, 4, 5, 6].map((n) => toHex(keyFor(n))).find((h) => h !== creator0);
  assert.match(client({ ...W, creators: { ...W.creators, [r0]: toHex(signBy(forger)(creatorMessage(fromHex(r0)))) } }, duty).why, /not the named creator's/);
  // the posting node: holding the self-posted rounds' certificates and two duty ones, it names nobody; with a third duty one, the stopped
  // node - by duty rounds only
  const hold = (s) => W.round.db.prepare('INSERT OR IGNORE INTO seat_certs (round_id, role, cert) VALUES (?, ?, ?)').run(fromHex(s.roundId), s.role, fromHex(certOf(s)));
  for (const s of [...self, ...late, ...W.seatings.slice(0, 2)]) hold(s);
  const chain = [1, 2, 3, 4, 5, 6].map((n) => toHex(keyFor(n)));
  assert.deepEqual((await W.book.absentForPosting({ census: chain, w: W.w })).claims, [], 'two duty misses and any number of self-posted ones: kept');
  hold(W.seatings[2]);
  const posted = await W.book.absentForPosting({ census: chain, w: W.w });
  assert.deepEqual(posted.claims.map((c) => c.node), [STOPPED]);
  assert.ok(posted.claims[0].proofs.every((p) => W.seatings.some((s) => s.roundId === p.roundId)), 'every proof names a duty round');
  assert.equal(client(W, posted).ok, true);
  // a self-posted round's certificate still keeps the nodes it lists in
  const listed = { ...self[1], seated: self[1].seated, present: [...self[1].seated, STOPPED] };
  W.round.db.prepare('INSERT OR REPLACE INTO seat_certs (round_id, role, cert) VALUES (?, ?, ?)').run(fromHex(listed.roundId), listed.role, fromHex(certOf(self[1], { present: listed.present })));
  assert.deepEqual((await W.book.absentForPosting({ census: chain, w: W.w })).claims, [], 'listed present at a self-posted round: kept');
});

test('no claim held, a proof seating not drawable yet: not yet, not refused for good; below protocol 22 nothing is left out', () => {
  const W = world();
  assert.match(W.roster.censusFor(W.rid).why, /no absent claim is held here for that root/);
  // a seating this seat does not hold: it cannot draw it yet
  const claim = claimOf(STOPPED, W.seatings.slice(0, 3));
  claim.claims[0].proofs[0] = { roundId: 'ab'.repeat(32), role: 'game' };
  const census = W.roster.censusFor(W.rid, null, { asRoundsOwn: false });
  const r = W.book.check(claim, { census: census.entries.map((e) => toHex(e.pubkey)), w: W.w });
  assert.equal(r.notYet, true, r.why);
  const old = world({ over: { protocolVersion: 20 }, absent: null, rounds: 0 });
  const c = old.roster.censusFor(old.rid);
  assert.equal(c.ok, true, c.why);
  assert.equal(c.entries.length, 6, 'a 20 census keeps every bond');
});

test('the presence book: the posting node leaves out the node its certificates prove absent, with them attached - and keeps one a peer\'s certificate lists present', async () => {
  const W = world();
  // this seat holds the certificates of three of the seatings (it was drawn there)
  for (const s of W.seatings.slice(0, 3)) W.round.db.prepare('INSERT INTO seat_certs (round_id, role, cert) VALUES (?, ?, ?)').run(fromHex(s.roundId), s.role, fromHex(certOf(s)));
  const chain = [1, 2, 3, 4, 5, 6].map((n) => toHex(keyFor(n)));
  assert.equal(W.book.seatingsIn(W.w).length, 3);
  const asked = [];
  const claim = await W.book.absentForPosting({ census: chain, w: W.w, ask: async (nodes) => { asked.push(...nodes); return { presents: [], certs: [] }; } });
  assert.deepEqual(claim.claims.map((c) => c.node), [STOPPED], 'the node the certificates show drawn and absent at 3 closes');
  assert.ok(asked.includes(STOPPED), 'the nodes this seat saw nowhere are asked for first');
  assert.equal(Object.keys(claim.certs).length, 3, 'the three certificates attached');
  assert.equal(client(W, claim).ok, true, 'and the client takes the claim as posted');
  // a peer holds a fourth seating whose certificate lists it present: handed over, the node is kept
  const fourth = W.seatings[3];
  const kept = await W.book.absentForPosting({ census: chain, w: W.w, ask: async () => ({ presents: [], certs: [certOf(fourth, { present: [...fourth.seated, STOPPED] })] }) });
  assert.deepEqual(kept.claims, [], 'present once in the 24 h: kept');
  assert.equal(W.book.certsOf([STOPPED], W.w).length, 4, 'and the certificates are served on to the next asker');
  // a PRESENT a peer holds, forged or outside the window, is no proof
  const [rid] = [fromHex(W.seatings[0].roundId)];
  assert.match(W.book.takeProof(signPresent({ roundId: rid, role: 'game', nodePubkey: keyFor(5) }, (m) => schnorr.sign(m, b32(4))), W.w).why, /not signed by the node it names/);
  // claims by root, with their certificates
  const root = 'cd'.repeat(32);
  assert.equal(W.book.keepClaim(root, claim).ok, true);
  assert.deepEqual(W.book.claimFor(root).claims.map((c) => c.node), [STOPPED]);
  assert.equal(Object.keys(W.book.claimFor(root).certs).length, 3);
  assert.equal(W.book.claimFor('ef'.repeat(32)), null);
  assert.match(W.book.keepClaim(root, { claims: [{ node: 'zz' }] }).why, /32 bytes hex/);
  // a node left out comes back by being seen: the rounds whose census names it absent, as their seatings come
  W.book.keepClaim(toHex(W.contract.censusRoot), claim);
  const close = BigInt(W.contract.startTimeMs) - 120000n;
  assert.deepEqual(W.book.roundsToReturn(STOPPED, Number(close - 30000n)).map(toHex), [toHex(W.rid)]);
  assert.deepEqual(W.book.roundsToReturn(LIVE_ONE, Number(close - 30000n)), [], 'a node no census left out signs nothing extra');
});

// ---- the page's own function, over what the seats serve (GET /headers, /census, /absent) ----
import { clientCommittee } from '../../arena-client/src/committee.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';

test('the page joins a 22 round only after it checked the absent claim the seats hand over: a proven claim joins, a claim of 2 seatings is refused', async () => {
  // the refusal first: a claim that stood is kept per root, a refused one never is
  for (const [list, ok] of [[2, false], [3, true]]) {
    const W = world();
    const claim = claimOf(STOPPED, W.seatings.slice(0, list));
    // the seat serves the round with the proven claim; the page is handed `claim` by GET /absent
    W.book.keepClaim(toHex(W.contract.censusRoot), claimOf(STOPPED, W.seatings.slice(0, 3)));
    const served = W.roster.censusFor(W.rid);
    assert.equal(served.ok, true, served.why);
    const headers = Buffer.concat(W.view.blocks.map((b) => Buffer.from(b.header)));
    const fetcher = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/headers') return new Response(headers, { status: 200 });
      if (u.pathname === '/census') return new Response(JSON.stringify(W.roster.censusEvidenceFor(fromHex(u.searchParams.get('round')))), { status: 200 });
      // GET /absent: the claim, the named rounds' contracts, their publications with branches and their creators' signatures (kanban #727)
      if (u.pathname === '/absent') return new Response(JSON.stringify({ root: u.searchParams.get('root'), ...claim, contracts: W.contracts, publications: W.publications, creators: W.creators }), { status: 200 });
      return new Response('no', { status: 404 });
    };
    const got = await clientCommittee(toHex(W.rid), W.contract, ['https://seat-a.example', 'https://seat-b.example'], { curve: pageCurve, fetcher, compare: false,
      anchorAt: { hash: blockHashOf(W.view.blocks[0].header), height: W.view.firstHeight } });
    if (ok) { assert.equal(got.ok, true, got.why); assert.deepEqual(got.absent, [STOPPED]); }
    else { assert.equal(got.ok, false); assert.match(got.why, /leaves out a node without proof: .*it takes 3/); }
  }
});

test('kanban #1325: a claim leaving out more than 20 % of the chain census is refused by the seat whatever its proofs, and no census commits to it', () => {
  const W = world();
  const proofs = W.seatings.slice(0, 3);
  const two = { claims: [{ node: STOPPED, proofs: proofsOf(proofs) }, { node: LIVE_ONE, proofs: proofsOf(proofs) }],
    certs: Object.fromEntries(proofs.map((s) => [`${s.roundId}:${s.role}`, certOf(s)])) };
  assert.equal(W.book.keepClaim(toHex(W.contract.censusRoot), two).ok, true, 'kept: the seat decides when it reads it');
  const c = W.roster.censusFor(W.rid);
  assert.equal(c.ok, false);
  assert.match(c.why, /above the 20 % a census may leave out/);
  // and the derivation itself refuses a census less those two (2 of 6 bonds)
  const contract = decodeRoundContract(encodeRoundContract(contractFor({})));
  const view = chainWith(W.bonds);
  const byTxid = new Map();
  for (const block of view.blocks) for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const d = deriveCensus(view, { contract, bond: bondSetFor('regtest'), absent: [{ node: STOPPED }, { node: LIVE_ONE }],
    resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  assert.equal(d.ok, false);
  assert.match(d.why, /above the 20 %/);
});

test('kanban #1325: the client refuses a committed census under 75 % of the chain census it sees itself; the honest one passes', () => {
  const W = world();
  const claim = claimOf(STOPPED, W.seatings.slice(0, 3));
  W.book.keepClaim(toHex(W.contract.censusRoot), claim);
  const ev = W.roster.censusEvidenceFor(W.rid);
  const own = committeeFromChain({ contract: W.contract, roundId: W.rid, headers: W.view.blocks.map((b) => b.header), firstHeight: W.view.firstHeight,
    evidence: ev.entries, bond: bondSetFor('regtest'), verify });
  assert.equal(own.ok, true, own.why);
  const check = (entries) => absenceFromChain({ contract: W.contract, claim: { ...claim, contracts: W.contracts, publications: W.publications, creators: W.creators },
    headers: W.view.blocks.map((b) => b.header), firstHeight: W.view.firstHeight, evidenceOf: (r) => W.roster.censusEvidenceFor(fromHex(r)).entries,
    bond: bondSetFor('regtest'), verify, entries });
  const honest = check(own.checkedCensus.entries);
  assert.equal(honest.ok, true, honest.why);
  // the same claim over a census that also dropped two nodes nobody named: half the chain census the client read from the proof rounds
  const short = check(own.checkedCensus.entries.slice(2));
  assert.equal(short.ok, false);
  assert.match(short.why, /under 75 % of the \d+ this client sees on the chain itself/);
});
