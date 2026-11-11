// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND THAT TAKES ANY FEDERATION: ITS FEDERATION ROWS AND ITS LATE LOSERS (kanban #1172, the 2026-11-06 state-machine audit). Before: each
// federation's row was `sent.accepted ? ACCEPTED : REFUSED` (a pre-validated submit ACCEPTED, a refused one REFUSED over another asker's landed one),
// a SUBMITTING federation row was never asked of its federation (not by recover, not by confirmSoon) and was rebuilt and submitted again each pass,
// keepFederationMoves rewrote the round's moves every pass, a refused federation build was reused, and recover() never read a late row. Now the
// federation's and the late row go through settlementRowStep (ACCEPTED only landed, REFUSED only after every kept txid was asked), are asked of their
// own federation first and at start, and the late loser's second settlement (claimed in its own federation since e399e524e) is found in at recover().
// The 1.9 port of the 2.0 test (efd76fb00): the gone-lock case is the refused-build case here, as this line has no #1146 A.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import { LockSettlement, federationPlans } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { encodeCommitments, decodeCommitments, encodeShare } from '../src/pool-wire.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { encodeRoundContract, encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const RID = b32(0x5e);
const STAKE = 100000n; const FEE = entryFeeMsat(STAKE);
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score, entryId: b32(0x10 + n) });
const W1 = entry(1, DELIVERED, 5), L1 = entry(3, FAILED, 0), L2 = entry(4, FAILED, 0);
const fedOfPlayer = new Map([[1, A], [3, A], [4, B]]);
const locks = new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + Number(e.pubkey[0])), outIdx: BigInt(e.pubkey[0]) }, amountMsat: STAKE - FEE, refundPk: refund(e.pubkey[0]) }]));
const PLAN = federationPlans({ roundId: RID, entries: [W1, L1, L2], minScore: 1, locks, feeLocks: new Map() },
  { federationOf: (o) => fedOfPlayer.get(Number(o.outIdx)), feesOf: () => ({ ppm: 0n, baseMsat: 0n }) });
const at = (o) => `${toHex(o.txid)}:${String(o.outIdx)}`;
const V3 = encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: new Uint8Array(32),
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 3 });

/**
 * A federation's port with what its guardians hold. `mode`: 'land' (the submit lands: its locks gone, its payouts stored - the tool says so),
 * 'prevalidate' (Ok from submit_transaction, nothing stored yet), 'refuse'. `landed(txid, claims, n)` lands a transaction as another asker's would.
 */
function fedPort(fid, log, allLocks) {
  const bytesOf = ({ claims, payouts, nonce }) => sha256(new TextEncoder().encode(JSON.stringify({ fid, c: claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}:${c.amountMsat}`),
    p: payouts.map((p) => `${toHex(p.payoutPk)}:${p.msat}`), n: toHex(nonce) })));
  const spent = new Set(), stored = new Set();
  const p = {
    mode: 'land', spent, stored,
    landed(txid, claims, n) { for (const c of claims) spent.add(c); for (let i = 0; i < n; i++) stored.add(`${txid}:${i}`); },
    fees: async () => ({ ppm: 0n, baseMsat: 0n }),
    status: async (o) => ({ blockCount: 500, stored: stored.has(at(o)) || (allLocks.has(at(o)) && !spent.has(at(o))) ? { blocksLeft: 100 } : null }),
    settle: async ({ claimPk, claims, payouts, nonce, signature }) => {
      const msg = bytesOf({ claims, payouts, nonce });
      if (!signature) return { message: toHex(msg), txid: toHex(msg) };
      const good = schnorr.verify(signature, msg, claimPk.subarray(1));
      log.push({ fid, txid: toHex(msg), mode: p.mode, good });
      if (!good || p.mode === 'refuse') return { accepted: false, error: good ? 'the guardians said no' : 'bad signature' };
      if (p.mode === 'prevalidate') return { accepted: true, payoutsStored: payouts.map(() => null), locksAfter: claims.map(() => ({ held: true })) };
      p.landed(toHex(msg), claims.map((c) => at(c.outpoint)), payouts.length);
      return { accepted: true, payoutsStored: payouts.map(() => ({ stored: true })), locksAfter: claims.map(() => null) };
    },
  };
  return p;
}

function twoNodes() {
  const G = evenGroupSecret(0x51515n, curve);
  const deal = trustedDealerSplit({ secret: G.secret, max: 2, min: 2, coefficients: [0x77n], curve });
  const claimPk = deal.groupPublicKey;
  const log = [];
  const allLocks = new Set([...locks.values()].map((l) => at(l.outpoint)));
  const ports = { [A]: fedPort(A, log, allLocks), [B]: fedPort(B, log, allLocks) };
  const router = { forFederation: async (f) => ports[f] || null, status: async () => ({ stored: null }), settle: async () => { throw new Error('a round that takes any federation never settles on the home port'); } };
  const contract = { stakeMsat: STAKE, protocolVersion: 3, federationId: new Uint8Array(32), nodes: [pk(0xa1), pk(0xa2)], settlementSlots: 2, minScore: 1 };
  const nodes = [];
  for (const id of [1, 2]) {
    const round = new Round(openStore(':memory:'));
    round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: V3 } : null);
    const ls = new LockSettlement(round, { dkg: {}, port: router, curve, random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) }, peersFor: () => (id === 1 ? ['http://peer2'] : []) });
    ls.planOf = async () => ({ ok: true, anyFed: true, plan: PLAN.plan, split: PLAN.split, contract, claimPk,
      held: { signerNode: deal.shares[id - 1] }, lockEntry: new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), e.entryId])) });
    ls.confirmSoon = () => {};
    nodes.push(ls);
  }
  nodes[0].fetcher = async (url, o) => {
    const u = new URL(url); const fed = u.searchParams.get('federation'); const two = nodes[1];
    const ok = (bytes) => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), text: async () => '' });
    const no = (why) => ({ ok: false, text: async () => why });
    if (u.pathname === '/settle-commit') { const g = await two.commit(RID, { txid: u.searchParams.get('txid'), federation: fed }); return g.ok ? ok(encodeCommitments([g.commitment])) : no(g.why); }
    if (u.pathname === '/settle-share') { const g = await two.share(RID, decodeCommitments(new Uint8Array(o.body)), { federation: fed }); return g.ok ? ok(encodeShare(g.share)) : no(g.why); }
    if (u.pathname === '/settle-signature') { const g = await two.take(RID, o.body, { federation: fed }); return g.ok ? ok(new Uint8Array(0)) : no(g.why); }
    return no('no such door');
  };
  return { nodes, ports, log };
}
const rowsOf = (n) => n.round.fedLockSettlementsOf(RID).map((r) => `${r.federation.slice(0, 2)} ${r.state}`).join(', ');

test('#1172 a federation\'s row is ACCEPTED only landed; a handed SUBMITTING row is asked at start; a refused one over a landed txid is ACCEPTED', async () => {
  const { nodes, ports, log } = twoNodes();
  // A's guardians pre-validate only (another asker's F' landed first, say); B's land it
  ports[A].mode = 'prevalidate';
  const got = await nodes[0].settle(RID);
  const one = rowsOf(nodes[0]);
  console.log(`#1172 pass 1 (A pre-validated only, B landed): node 1 rows ${one}; round ${nodes[0].round.settlementState(RID)} - ${got.why.slice(0, 160)}`);
  assert.equal(nodes[0].round.fedLockSettlement(RID, A).state, 'SUBMITTING', 'a pre-validated submit is not a landed one');
  assert.equal(nodes[0].round.fedLockSettlement(RID, B).state, 'ACCEPTED');
  assert.equal(nodes[0].round.settlementState(RID), 'SUBMITTING');
  // A's transaction lands later (the guardians' consensus caught up); node 2 holds SUBMITTING on both, as handed - a restart asks every federation's row
  const txA = nodes[0].round.fedLockSettlement(RID, A).txid;
  ports[A].landed(txA, PLAN.split.settlements.find((s) => s.federation === A).claims.map((c) => at(c.outpoint)), PLAN.split.settlements.find((s) => s.federation === A).payouts.length);
  const before = rowsOf(nodes[1]);
  const rec = await nodes[1].recover();
  console.log(`#1172 node 2 (handed) before recover: ${before}; after: ${rowsOf(nodes[1])} (${rec.length} row(s) asked)`);
  assert.deepEqual(nodes[1].round.fedLockSettlementsOf(RID).map((r) => r.state), ['ACCEPTED', 'ACCEPTED']);
  // node 1 asks again: A is found in first, nothing is submitted a second time, and the round's moves are not rewritten once a federation is in
  let rewrites = 0;
  const keep = nodes[0].keepFederationMoves.bind(nodes[0]);
  nodes[0].keepFederationMoves = (...a) => { rewrites++; return keep(...a); };
  const submits = log.length;
  const again = await nodes[0].settle(RID);
  console.log(`#1172 node 1 pass 2: ${rowsOf(nodes[0])}, submits ${submits} -> ${log.length}, moves rewritten ${rewrites} time(s) - ${again.why.slice(0, 120)}`);
  assert.equal(again.ok, true, again.why);
  assert.equal(log.length, submits, 'a federation found in is not submitted again');
  assert.equal(rewrites, 0, 'the round\'s moves are written before any federation is in, never after');
});

test('#1172 a refused federation submit whose transaction is in (another asker\'s, same bytes) is ACCEPTED, not REFUSED and submitted again', async () => {
  const { nodes, ports, log } = twoNodes();
  ports[A].mode = 'refuse';
  // the other asker's submit of the same bytes landed in A just before this one
  const sA = PLAN.split.settlements.find((s) => s.federation === A);
  const m = await nodes[0].fedMessage(RID, A);
  ports[A].landed(m.txid, sA.claims.map((c) => at(c.outpoint)), sA.payouts.length);
  await nodes[0].settle(RID);
  const first = nodes[0].round.fedLockSettlement(RID, A);
  await nodes[0].settle(RID);
  const submitsA = log.filter((x) => x.fid === A).length;
  console.log(`#1172 A refused but in: row ${first.state} (${first.why.slice(0, 90)}); A submits over two passes: ${submitsA}`);
  assert.equal(first.state, 'ACCEPTED');
  assert.equal(submitsA, 1);
});

// THE 1.9 LINE HAS NO #1146 A (no gone-lock read, no peerSaysGone): what it takes is that a refused federation submit's build is not reused, and that
// REFUSED is written only after every txid of that federation was asked
test('#1172 a refused federation submit, nothing landed: REFUSED after every kept txid was asked, and its build is dropped', async () => {
  const { nodes, ports } = twoNodes();
  ports[A].mode = 'refuse';
  const k = toHex(RID);
  await nodes[0].settle(RID);
  const row = nodes[0].round.fedLockSettlement(RID, A);
  const left = [...nodes[0].built.keys()].filter((x) => x === `${k}:fed:${A}`);
  const kept = nodes[0].round.scopedSettlementTxidsOf ? nodes[0].round.scopedSettlementTxidsOf(RID, `fed:${A}`).length : 0;
  console.log(`#1172 A refused, nothing landed: row ${row.state} (${row.why.slice(0, 80)}); txids of A kept ${kept}; A builds left ${left.length}`);
  assert.equal(row.state, 'REFUSED');
  assert.equal(kept, 1, 'the refused txid is kept with what it moves, so a later pass asks about it');
  assert.deepEqual(left, [], 'a refused submit\'s build is not reused');
});

// ---- THE LATE LOSER OF A ROUND THAT TAKES ANY FEDERATION ----

const CLAIM_SK = b32(0x33);
const CLAIM_PK = Uint8Array.from([0x02, ...schnorr.getPublicKey(CLAIM_SK)]);
const LATE = entry(4, FAILED, 0);
const lateEntryBytes = encodeEntryContract({ roundId: RID, playerPubkey: LATE.pubkey, sessionPubkey: b32(0x71), stakeCommitment: b32(0x72), stakeMsat: STAKE,
  feeMsat: FEE, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x73), vssSharesRef: b32(0), stakePoint: new Uint8Array(33), feePreimage: b32(0x74),
  stakeLockOutpoint: { txid: b32(0x44), outIdx: 4n }, feeLockOutpoint: { txid: b32(0x45), outIdx: 4n }, claimKeyAttestationRef: b32(0x75), federationId: fromHex(B) });

function lateSeat() {
  const log = [];
  const allLocks = new Set([...locks.values()].map((l) => at(l.outpoint)));
  const ports = { [A]: fedPort(A, log, allLocks), [B]: fedPort(B, log, allLocks) };
  const built = [];
  for (const f of [A, B]) { const s = ports[f].settle; ports[f].settle = async (x) => { if (!x.signature) built.push(f); return s(x); }; }
  const router = { forFederation: async (f) => ports[f] || null, status: async () => ({ stored: null }), settle: async () => { throw new Error('never the home port'); }, fees: async () => { throw new Error('never the home port\'s fees'); } };
  const round = new Round(openStore(':memory:'));
  round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: V3 } : null);
  const lockOf = (e) => ({ outpoint: at(locks.get(toHex(e.pubkey)).outpoint), fields: { paymentImage: { kind: 'hash', bytes: '' }, amountMsat: String(STAKE - FEE), claimPk: toHex(CLAIM_PK), refundPk: toHex(refund(e.pubkey[0])), expiration: 1000 } });
  round.stakeLock = (eid) => [W1, L1, LATE].map((e) => (toHex(e.entryId) === toHex(eid) ? lockOf(e) : null)).find(Boolean) || null;
  round.feeLock = () => null;
  round.entry = (eid) => (toHex(eid) === toHex(LATE.entryId) ? lateEntryBytes : null);
  round.entriesOf = () => [W1, L1, LATE].map((e) => ({ entryId: e.entryId, entry: { playerPubkey: e.pubkey, stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: 0n, feePreimage: b32(0x74) } }));
  const ls = new LockSettlement(round, { dkg: { signerNodeFor: () => ({ ok: true, signerNode: { id: 1 }, pool: { groupPublicKey: CLAIM_PK } }) }, port: router, curve,
    stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) } });
  ls.finalityOf = () => ({ state: 'FORFEIT', why: 'test view: the late loser forfeited after its re-run window' });
  ls.confirmSoon = () => {};
  // THE ROUND'S OWN SETTLEMENT, AS AN ANY-FEDERATION ROUND KEEPS IT: a row per federation, the moves under "federations", the winner's share
  round.putLockSettlementMoves({ roundId: RID, txid: 'federations', claims: [at(locks.get(toHex(L1.pubkey)).outpoint)], payouts: 1 });
  round.putLockSettlementShares(RID, [{ pubkey: W1.pubkey, msat: STAKE - FEE }]);
  // THE OBJECTION, AS STORED (the intake row that makes the entry one to ask about)
  round.db.exec('PRAGMA foreign_keys = OFF');   // the round and its entries are this test's stubs, not rows
  round.db.prepare('INSERT INTO objections (round_id, entry_id, seen_ms) VALUES (?, ?, ?)').run(Buffer.from(RID), Buffer.from(LATE.entryId), 1);
  return { ls, round, ports, built };
}

test('#1172 a late loser of a round that takes any federation is a candidate once every federation is in, and is built in its own federation', async () => {
  const { ls, round, ports, built } = lateSeat();
  round.putFedLockSettlement({ roundId: RID, federation: A, txid: 'a1'.repeat(32), message: new Uint8Array(32), signature: new Uint8Array(64), state: 'SUBMITTING', why: 'test' });
  const early = round.lateSettlementCandidates().length;
  round.putFedLockSettlement({ roundId: RID, federation: A, txid: 'a1'.repeat(32), message: new Uint8Array(32), signature: new Uint8Array(64), state: 'ACCEPTED', why: 'test' });
  const cands = round.lateSettlementCandidates().map((c) => toHex(c.entryId));
  const m = await ls.lateMessage(RID, LATE.entryId);
  console.log(`#1172 late loser: candidates while A SUBMITTING ${early}, once in ${cands.length}; built ${m.ok ? `in federation(s) ${built.map((f) => f.slice(0, 2)).join(',')}, txid ${m.txid.slice(0, 12)}` : `nothing: ${m.why}`}`);
  assert.equal(early, 0);
  assert.deepEqual(cands, [toHex(LATE.entryId)]);
  assert.equal(m.ok, true, m.why);
  assert.deepEqual(built, [B], 'the late loser\'s lock is in B: its second settlement is built there');
  // the signature handed for it: SUBMITTING with what it moves; B's guardians land it; a restart finds it in
  const signature = schnorr.sign(m.message, CLAIM_SK);
  const took = await ls.take(RID, signature, { entry: LATE.entryId });
  assert.equal(took.ok, true, took.why);
  assert.equal(round.lateLockSettlement(RID, LATE.entryId).state, 'SUBMITTING');
  ports[B].landed(m.txid, [at(locks.get(toHex(LATE.pubkey)).outpoint)], m.plan.payouts.length);
  await ls.recover();
  const row = round.lateLockSettlement(RID, LATE.entryId);
  console.log(`#1172 late row after B landed it and recover(): ${row.state} - ${row.why.slice(0, 100)}`);
  assert.equal(row.state, 'ACCEPTED');
  // and its submit through the late port, refused but in: ACCEPTED, not REFUSED
  assert.equal(ports[A].spent.size, 0, 'nothing moved in A');
});

// KANBAN #1240 (audit 3 #1210 FIXES-6): only the seat that combined the federations' transactions kept the winners' shares; a seat that took
// the handed signatures kept none, refused every late loser ("kept no shares"), and fewer than a threshold ever committed
test('#1240 a seat that kept no shares of an any-federation round derives them from its plan and builds the late loser\'s settlement', async () => {
  const { ls, round, built } = lateSeat();
  round.db.prepare('DELETE FROM lock_settlement_shares WHERE round_id = ?').run(Buffer.from(RID));
  round.putFedLockSettlement({ roundId: RID, federation: A, txid: 'a1'.repeat(32), message: new Uint8Array(32), signature: new Uint8Array(64), state: 'ACCEPTED', why: 'test' });
  const WINNER = [{ pubkey: W1.pubkey, msat: STAKE - FEE }];
  let planned = 0;
  // this seat's own plan of the settled round: one payout over its federations, as the kept moves say
  ls.planOf = async () => { planned++; return { ok: true, anyFed: true, plan: { ...PLAN.plan, stakeShares: WINNER }, split: { settlements: [{ payouts: [{}] }] } }; };
  const before = round.lockSettlementShares(RID);
  const m = await ls.lateMessage(RID, LATE.entryId);
  const kept = round.lockSettlementShares(RID);
  console.log(`  MEASURED #1240: shares kept before ${JSON.stringify(before)}, planned ${planned}x, late message ${m.ok ? `built in ${built.map((f) => f.slice(0, 2)).join(',')}` : `refused: ${m.why}`}, shares kept after ${kept ? kept.length : null}`);
  assert.equal(before, null);
  assert.equal(m.ok, true, m.why);
  assert.deepEqual(built, [B]);
  assert.equal(kept.length, 1, 'the derived shares are kept for the next ask');
  // a plan that pays another number of outputs than the kept moves is not taken
  const other = lateSeat();
  other.round.db.prepare('DELETE FROM lock_settlement_shares WHERE round_id = ?').run(Buffer.from(RID));
  other.round.putFedLockSettlement({ roundId: RID, federation: A, txid: 'a1'.repeat(32), message: new Uint8Array(32), signature: new Uint8Array(64), state: 'ACCEPTED', why: 'test' });
  other.ls.planOf = async () => ({ ok: true, anyFed: true, plan: { ...PLAN.plan, stakeShares: WINNER }, split: { settlements: [{ payouts: [{}, {}] }] } });
  const no = await other.ls.lateMessage(RID, LATE.entryId);
  assert.equal(no.ok, false); assert.match(no.why, /kept no shares/);
});
