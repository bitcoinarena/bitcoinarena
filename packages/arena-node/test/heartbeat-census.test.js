// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEARTBEAT AT A SEAT AND AT THE CLIENT (§5A.3, protocol 22, kanban #727, the owner 2026-10-27). On the seat's own fixture chain (an hour
// a block): six bonded nodes, node 5 stopped, earlier rounds of the 24 h an hour apart. The five live nodes run the heartbeat agent on
// a round - each beats to the slot's committee (one slot per round, the owner 2026-10-27), each member signs who it heard, and the
// certificate stands with 5. Three rounds' slots an hour apart prove node 5 out: the seat serves the round whose root leaves it out,
// and the client - from headers, the rounds' contracts and their census evidence alone - checks the same proofs and agrees. Four
// signers, a listing, two slots only: refused at both, by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { presenceBook } from '../src/presence-book.js';
import { heartbeatAgent } from '../src/heartbeat-agent.js';
import { chainOf, FIRST_TIME, publicationOf } from '../../arena-protocol/tools/chainview.js';
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
import { signHeard, encodeHeartbeatCertificate, heartbeatRole, verifyHeartbeatCertificate, heartbeatCloseMs } from '../../arena-protocol/src/heartbeat.js';
import { PRESENCE_VERSION } from '../../arena-protocol/src/constants.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SPACING = 3600;
const timeOf = (i) => FIRST_TIME + i * SPACING;
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
const advertFor = (n) => ({
  nodePubkey: keyFor(n), operatorId: 'operator', protocolVersions: [PRESENCE_VERSION], roles: ['game', 'verify', 'settlement'], hostedGames: [NEXTBLOCK_GAME_ID],
  endpoint: `http://node${n}.example`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
});
const NODES = [1, 2, 3, 4, 5, 6];
const bonds = NODES.map((n) => bondTransaction(advertFor(n), { previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)) }));
const chainWith = (contracts = []) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  if (contracts.length) blocks[1] = { transactions: contracts.map(publicationOf) };
  return chainOf(blocks, FROM, { timeOf });
};
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const nOf = new Map(NODES.map((n) => [toHex(keyFor(n)), n]));
const signBy = (h) => (m) => schnorr.sign(m, b32(nOf.get(h)));
const STOPPED = toHex(keyFor(5));
const LIVE = NODES.filter((n) => n !== 5).map((n) => toHex(keyFor(n)));

function rootFor(absent) {
  const contract = decodeRoundContract(encodeRoundContract(contractFor()));
  const view = chainWith();
  const byTxid = new Map();
  for (const block of view.blocks) for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const census = deriveCensus(view, { contract, bond: bondSetFor('regtest'), absent: absent ? absent.map((node) => ({ node })) : null,
    resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  assert.equal(census.ok, true, census.why);
  return census;
}

/** THE WORLD: the chain, a seat with its presence book, 6 earlier rounds an hour apart (census: the chain's own), the round less node 5. */
function world() {
  const full = rootFor(null), less = rootFor([STOPPED]);
  const current = contractFor({ censusRoot: less.root });
  const earlier = Array.from({ length: 6 }, (_, j) => contractFor({ startTimeMs: COMMITTEE_TIME + 60500n - BigInt(j + 1) * 3600000n,
    entryCloseMs: COMMITTEE_TIME + 200000n - BigInt(j + 1) * 3600000n, committeeTimeMs: COMMITTEE_TIME - BigInt(j + 1) * 3600000n, censusRoot: full.root }));
  const view = chainWith([current, ...earlier]);
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const roster = new Roster(round, { chainFor: () => view, randomnessFor: ({ contract: c }) => beaconOf(view, c) });
  const book = presenceBook({ round, roster, verify });
  roster.absence = { claimFor: book.claimFor, check: book.check };
  const rids = earlier.map((c) => round.open(c));
  const rid = round.open(current);
  const contract = decodeRoundContract(new Uint8Array(round.get(rid).contract));
  const w = presenceWindow(censusTimeMs(view, HEIGHT));
  const contracts = Object.fromEntries(rids.map((r) => [toHex(r), toHex(new Uint8Array(round.get(r).contract))]));
  return { round, roster, book, rid, rids, contract, view, w, contracts };
}
/** A heartbeat certificate of slot `slot` of round `rid`, signed for real by `signers`, each listing `heard`. */
const certOf = (rid, slot, signers = LIVE, heard = LIVE) => toHex(encodeHeartbeatCertificate({ roundId: rid, slot,
  groups: [{ heard, leftOut: [], signatures: signers.map((h) => ({ nodePubkey: fromHex(h), signature: signHeard({ roundId: rid, slot, heard, leftOut: [] }, signBy(h)) })) }] }));
const claimOf = (node, list) => ({ claims: [{ node, proofs: list.map(({ rid, slot }) => ({ roundId: toHex(rid), role: heartbeatRole(slot) })) }],
  certs: Object.fromEntries(list.map(({ rid, slot, cert }) => [`${toHex(rid)}:${heartbeatRole(slot)}`, cert || certOf(rid, slot)])) });
const client = (W, claim) => {
  const ev = W.roster.censusEvidenceFor(W.rid);
  const own = ev.ok ? committeeFromChain({ contract: W.contract, roundId: W.rid, headers: W.view.blocks.map((b) => b.header), firstHeight: W.view.firstHeight,
    evidence: ev.entries, bond: bondSetFor('regtest'), verify }) : null;
  return absenceFromChain({ contract: W.contract, claim: { ...claim, contracts: W.contracts }, headers: W.view.blocks.map((b) => b.header), firstHeight: W.view.firstHeight,
    evidenceOf: (r) => W.roster.censusEvidenceFor(fromHex(r)).entries, bond: bondSetFor('regtest'), verify, entries: own && own.ok ? own.checkedCensus.entries : [] });
};

/** THE FIVE LIVE NODES RUN THE AGENT on one round: each its own store holding the round, the seat's roster for the draw. */
function agents(W, rid, clock) {
  const by = new Map();
  for (const n of NODES.filter((x) => x !== 5)) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
    db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, new Uint8Array(W.round.get(rid).contract));
    const round = { db, pubkey: keyFor(n) };
    const fetcher = async (url, init = {}) => {
      const u = new URL(url);
      const to = by.get(u.host);
      if (!to) return new Response('down', { status: 503 });      // node 5 is stopped
      const r = u.pathname === '/heartbeats' ? to.takeHeartbeats(new Uint8Array(init.body)) : u.pathname === '/heard' ? to.takeHeard(JSON.parse(init.body)) : { ok: false };
      return new Response(JSON.stringify(r), { status: r.ok ? 201 : 400 });
    };
    by.set(`node${n}.example`, heartbeatAgent({ round, roster: W.roster, sign: signBy(toHex(keyFor(n))), verify, fetcher, nowMs: () => clock.now }));
  }
  return by;
}

test('five live nodes beat, sign who they heard and certify each slot with 5; the stopped node is in no list, and a beat after the close is refused', async () => {
  const W = world();
  const rid = W.rids[0];
  const contract = decodeRoundContract(new Uint8Array(W.round.get(rid).contract));
  const clock = { now: 0 };
  const A = agents(W, rid, clock);
  for (const slot of [0]) {
    const close = heartbeatCloseMs(contract, slot);
    clock.now = Number(close) - 30000;
    for (const a of A.values()) await a.tick();
    clock.now = Number(close) + 1000;
    for (const a of A.values()) await a.tick();          // each signs its HEARD and hands it out
    for (const a of A.values()) await a.tick();          // and certifies with the others'
    const c = W.roster.heartbeatCommitteeFor(rid, slot);
    for (const [host, a] of A) {
      const cert = a.certOf(rid, slot);
      assert.ok(cert, `${host} slot ${slot}: a certificate`);
      const v = verifyHeartbeatCertificate(fromHex(cert), { roundId: rid, slot, committee: c.committee.map((e) => toHex(e.pubkey)), census: c.census, verify });
      assert.equal(v.ok, true, v.why);
      assert.deepEqual(v.signers, [...LIVE].sort(), 'signed by the 5 live members');
      assert.deepEqual(v.heard, [...LIVE].sort(), 'every live node heard, the stopped one not');
    }
  }
  // a HEARTBEAT after its slot closed is not taken
  const any = [...A.values()][0];
  const { signHeartbeat } = await import('../../arena-protocol/src/heartbeat.js');
  assert.match(any.takeHeartbeat(signHeartbeat({ roundId: rid, slot: 0, nodePubkey: keyFor(5) }, signBy(STOPPED))).why, /has closed/);
});

test('three rounds\' heartbeat slots an hour apart prove the stopped node out: the seat serves the round less it, and the client agrees and draws the seat\'s committee', () => {
  const W = world();
  const claim = claimOf(STOPPED, W.rids.slice(0, 3).map((rid) => ({ rid, slot: 0 })));
  assert.equal(W.book.keepClaim(toHex(W.contract.censusRoot), claim).ok, true);
  const c = W.roster.censusFor(W.rid);
  assert.equal(c.ok, true, c.why);
  assert.deepEqual(c.absent.map((x) => x.node), [STOPPED]);
  const got = client(W, claim);
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.absent, [STOPPED], 'the client checks the same proofs and names the same absent');
  const ev = W.roster.censusEvidenceFor(W.rid);
  const mine = committeeFromChain({ contract: W.contract, roundId: W.rid, headers: W.view.blocks.map((b) => b.header), firstHeight: W.view.firstHeight,
    evidence: ev.entries, bond: bondSetFor('regtest'), verify });
  assert.equal(mine.ok, true, mine.why);
  const at = W.roster.committeeFor(W.rid, 'settlement');
  assert.deepEqual(mine.drawn.settlement.map(toHex).sort(), at.drawn.map((e) => toHex(e.pubkey)).sort(), 'one draw at the client and the seat');
  // the presence book, posting: holding those three certificates it finds the same claim
  for (const r of W.rids.slice(0, 3)) assert.equal(W.book.takeCert(fromHex(certOf(r, 0))).ok, true);
  return W.book.absentForPosting({ census: NODES.map((n) => toHex(keyFor(n))), w: W.w }).then((posted) => {
    assert.deepEqual(posted.claims.map((x) => x.node), [STOPPED]);
    assert.ok(posted.claims[0].proofs.every((p) => p.role.startsWith('heartbeat-')));
    assert.equal(client(W, posted).ok, true, 'and the client takes the claim as posted');
  });
});

test('a heartbeat claim against an honest node is refused by the seat and by the client: 4 signers, a listing, two slots only', () => {
  const W = world();
  const three = W.rids.slice(0, 3).map((rid) => ({ rid, slot: 0 }));
  const census = W.roster.censusFor(W.rid, null, { asRoundsOwn: false }).entries.map((e) => toHex(e.pubkey));
  const cases = [
    // 1. four members only: no certificate - a group of 4 makes none
    ['certificate', claimOf(STOPPED, [{ ...three[0], cert: certOf(three[0].rid, 0, LIVE.slice(0, 4)) }, ...three.slice(1)]), /fewer than the 5/],
    // 2. a member heard it: present
    ['present', claimOf(STOPPED, [{ ...three[0], cert: toHex(encodeHeartbeatCertificate({ roundId: three[0].rid, slot: 0, groups: [
      { heard: LIVE, leftOut: [], signatures: LIVE.slice(1).map((h) => ({ nodePubkey: fromHex(h), signature: signHeard({ roundId: three[0].rid, slot: 0, heard: LIVE, leftOut: [] }, signBy(h)) })) },
      { heard: [...LIVE, STOPPED], leftOut: [], signatures: [{ nodePubkey: fromHex(LIVE[0]), signature: signHeard({ roundId: three[0].rid, slot: 0, heard: [...LIVE, STOPPED], leftOut: [] }, signBy(LIVE[0])) }] }] })) }, ...three.slice(1)]), /lists it present/],
    // 3. two slots only: a node flooded at 2 moments stays in
    ['too-few', claimOf(STOPPED, three.slice(0, 2)), /on 2 missed close\(s\) at least 1 h apart; it takes 3/],
  ];
  for (const [proof, claim, why] of cases) {
    const atSeat = W.book.check(claim, { census, w: W.w });
    assert.equal(atSeat.ok, false, `${proof}: the seat refuses`);
    assert.equal(atSeat.proof, proof);
    assert.match(atSeat.why, why);
    const atClient = client(W, claim);
    assert.equal(atClient.ok, false, `${proof}: the client refuses`);
    assert.match(atClient.why, why);
  }
  // a seat that held the node's HEARTBEAT in the 24 h refuses whatever the claim names
  W.round.db.prepare('INSERT INTO hb_beats (round_id, slot, node, close_ms, bytes) VALUES (?, ?, ?, ?, ?)').run(W.rids[4], 0, STOPPED, Number(W.w.toMs) - 1000, new Uint8Array(132));
  assert.equal(W.book.check(claimOf(STOPPED, three), { census, w: W.w }).proof, 'seen');
});
