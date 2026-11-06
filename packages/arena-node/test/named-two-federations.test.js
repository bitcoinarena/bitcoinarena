// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TWO FEDERATIONS SETTLE ONE ROUND, EACH UNDER ITS OWN S (kanban #1044 B1, ruling #1135 3, #1145: this test stands in for the live run until testnet4).
// A protocol-27 round that takes any federation settles one transaction per federation. Seven seats of a 5-of-7, each its own node key and store, reach
// each other's doors as server.js serves them (named-settlement.test.js's world, with `&federation=`). Seat 1 does not answer for federation A and seat 2 not
// for federation B, so the two transactions have two body ids and two signer sets - and no nonce of one commit is in the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import { LockSettlement } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { namedKey } from '../src/named-claim.js';
import { decodeNamedCommitment } from '../src/named-settlement.js';
import { zKey } from '../../arena-protocol/src/arena-lock.js';
import { lockSettlement } from '../../arena-protocol/src/lock-settlement.js';
import { DELIVERED, FAILED, computePayoutTable } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const RID = b32(0x6f);
const STAKE = 100000n; const FEE = entryFeeMsat(STAKE);
const Z = zKey();
const FEES = { ppm: 0n, baseMsat: 0n };
const FED_A = 'a1'.repeat(32), FED_B = 'b2'.repeat(32);
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score, entryId: b32(0x10 + n) });
// federation A: a winner and a loser; federation B: another winner and loser - each its own claims, payouts and nonce
const partOf = (fid, w, l, nonceByte) => {
  const es = [w, l];
  const locks = new Map(es.map((e) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + e.pubkey[0]), outIdx: BigInt(e.pubkey[0]) }, amountMsat: STAKE - FEE, refundPk: Uint8Array.from([0x02, ...e.pubkey]), fields: { paymentImage: { kind: 'hash' } } }]));
  const plan = lockSettlement({ roundId: RID, entries: es, minScore: 1, locks, fees: FEES });
  assert.ok(plan.ok, plan.why);
  return { federation: fid, claims: plan.claims, payouts: plan.payouts, nonce: new Uint8Array(8).fill(nonceByte), poolMsat: plan.poolMsat || 0n, feePoolMsat: plan.feePoolMsat || 0n, plan, entries: es };
};
const A = partOf(FED_A, entry(1, DELIVERED, 5), entry(3, FAILED, 0), 0xa1);
const B = partOf(FED_B, entry(2, DELIVERED, 7), entry(4, FAILED, 0), 0xb2);
const ALL = [...A.entries, ...B.entries];
const F = computePayoutTable({ roundId: RID, entries: ALL, minScore: 1 });
const ROWS = F.activated.map((e, i) => ({ entryId: e.entryId, pubkey: e.pubkey, amountMsat: F.table[i].amountMsat, outcome: e.outcome, score: e.score }));

/** The stake-lock tool for Arena locks, as named-settlement.test.js answers it: the body with Z, the real transaction with S and KeyAgg(S). */
function arenaPort(seatKeys, log) {
  const bodyOf = ({ claims, payouts, nonce }, set = [], agg = null) => sha256(new TextEncoder().encode(JSON.stringify({
    c: claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}:${toHex(c.preimage)}`), s: set,
    p: payouts.map((p) => `${agg && toHex(p.payoutPk) === toHex(Z) ? toHex(agg) : toHex(p.payoutPk)}:${p.msat}`), n: toHex(nonce) })));
  return {
    fees: async () => FEES,
    settle: async () => { throw new Error('a protocol-27 round is never settled by the stock settle'); },
    arenaSettle: async ({ claims, payouts, nonce, signers = null, signature = null }) => {
      const bodyId = toHex(bodyOf({ claims, payouts, nonce }));
      if (!signers) return { bodyId, zSlots: [] };
      const agg = namedKey(seatKeys, 5, signers);
      const txid = toHex(bodyOf({ claims, payouts, nonce }, signers, Uint8Array.from([0x02, ...agg])));
      if (!signature) return { bodyId, txid, message: txid, aggKey: toHex(agg) };
      const accepted = verify(signature, fromHex(txid), agg);
      log.push({ bodyId, txid, signers, accepted, nonce: toHex(nonce) });
      // AS THE TOOL ANSWERS (kanban #1171, #1172): an accepted submit's claimed lock is spent within its wait (locks_spent)
      return { bodyId, txid, message: txid, aggKey: toHex(agg), accepted, error: accepted ? null : 'bad signature', locksSpent: accepted };
    },
  };
}

function world({ downFor = { [FED_A]: [1], [FED_B]: [2] } } = {}) {
  const log = [], commits = [];
  const stores = Array.from({ length: 7 }, () => new Round(openStore(':memory:')));
  const seatKeys = stores.map((r) => r.pubkey);
  // THE ROUND AS THE STORE HOLDS IT: a whole contract, federation id zero - a round that takes any federation, settled one federation at a time
  const contract = {
    protocolVersion: 27, networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID,
    simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
    federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000,
    corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: seatKeys,
  };
  const encoded = encodeRoundContract(contract);
  for (const r of stores) { const get = r.get.bind(r); r.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: encoded } : get(rid)); }
  const port = arenaPort(seatKeys, log);
  const base = (i) => `http://seat${i}`;
  const seats = [];
  const fetcher = async (url, opts = {}) => {
    const u = new URL(url);
    const i = Number(u.hostname.replace('seat', ''));
    const federation = u.searchParams.get('federation');
    if ((downFor[federation] || []).includes(i)) throw new Error('connection refused');
    const ls = seats[i];
    const r8 = fromHex(u.searchParams.get('round'));
    const named = u.searchParams.get('named') === '1';
    const body = opts.body ? new Uint8Array(opts.body) : new Uint8Array();
    const ask = opts.headers && opts.headers['x-settlement-ask'] ? fromHex(opts.headers['x-settlement-ask']) : null;
    const answer = (got, bytes, headers = {}) => ({ ok: got.ok, status: got.ok ? 200 : got.status || 409, text: async () => got.why || '',
      arrayBuffer: async () => bytes, headers: { get: (h) => headers[h] || null } });
    if (u.pathname === '/settle-ack') { const got = await ls.ack(r8, { txid: u.searchParams.get('txid'), federation }); return answer(got, got.bytes); }
    if (u.pathname === '/settle-commit') {
      const got = await ls.commit(r8, { txid: u.searchParams.get('txid'), federation, acks: body, door: true, ask });
      if (got.ok) commits.push({ federation, seat: i, pubnonces: decodeNamedCommitment(got.wire).map(toHex) });
      return answer(got, got.wire, got.word ? { 'x-settlement-commit': toHex(got.word) } : {});
    }
    if (u.pathname === '/settle-share') { const got = await ls.share(r8, body, { federation, door: true, ask, named }); return answer(got, got.wire); }
    if (u.pathname === '/settle-signature') { const got = await ls.take(r8, body, { federation, named }); return answer(got, new Uint8Array()); }
    throw new Error(`no door ${u.pathname}`);
  };
  stores.forEach((round, i) => {
    const ls = new LockSettlement(round, { dkg: { signerNodeFor: () => { throw new Error('a protocol-27 round has no claim-key share'); } }, port, curve,
      random: (n) => crypto.getRandomValues(new Uint8Array(n)), stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) },
      peersFor: () => seatKeys.map((_, j) => j).filter((j) => j !== i).map(base), fetcher, winnings: null, peerAskMs: 2000, peerGraceMs: 50 });
    ls.planOf = async () => ({ ok: true, anyFed: true, plan: { ...A.plan, stakeShares: [] }, split: { settlements: [A, B] }, contract, claimPk: Z, held: { ok: true, signerNode: null },
      lockEntry: new Map(ALL.map((e) => [toHex(e.pubkey), e.entryId])), ackRows: ROWS });
    ls.turn = async () => ({ mine: i === 0, why: 'seat 0 combines' });
    ls.sendWinnings = async () => [];
    ls.confirmSoon = () => {};
    seats.push(ls);
  });
  return { seats, stores, seatKeys, log, commits };
}

test('one round, two federations: two body ids, a signer set each, every nonce committed once', async () => {
  const { seats, stores, seatKeys, log, commits } = world();
  const got = await seats[0].settle(RID);
  assert.equal(got.ok, true, got.why);
  assert.equal(log.length, 2, 'one transaction per federation');
  const [ta, tb] = log;
  assert.notEqual(ta.bodyId, tb.bodyId, 'two body ids');
  assert.notEqual(ta.txid, tb.txid);
  assert.deepEqual(ta.signers, [0, 2, 3, 4, 5], 'federation A: seat 1 silent');
  assert.deepEqual(tb.signers, [0, 1, 3, 4, 5], 'federation B: seat 2 silent');
  assert.notDeepEqual(ta.signers, tb.signers, 'S differs');
  assert.ok(ta.accepted && tb.accepted, 'each signature verifies under its own KeyAgg(S)');
  // EACH SEAT KEEPS ONE BATCH PER FEDERATION, under that federation's S
  for (const i of [0, 3, 4, 5]) {
    const a = stores[i].namedBatch(RID, FED_A), b = stores[i].namedBatch(RID, FED_B);
    assert.ok(a && b, `seat ${i} keeps both batches`);
    assert.deepEqual([a.signers, b.signers], [ta.signers, tb.signers]);
    assert.ok(verify(a.signatures[0], fromHex(a.slots[0].message), namedKey(seatKeys, 5, a.signers)));
    assert.ok(verify(b.signatures[0], fromHex(b.slots[0].message), namedKey(seatKeys, 5, b.signers)));
    assert.equal(verify(a.signatures[0], fromHex(a.slots[0].message), namedKey(seatKeys, 5, b.signers)), false, 'A\'s signature is not B\'s key\'s');
  }
  // NO NONCE IS SHARED: every public nonce any seat committed to appears in exactly one commit of one federation
  const byNonce = new Map();
  for (const c of commits) for (const n of c.pubnonces) byNonce.set(n, [...(byNonce.get(n) || []), `${c.federation.slice(0, 2)}:${c.seat}`]);
  assert.ok(commits.some((c) => c.federation === FED_A) && commits.some((c) => c.federation === FED_B), 'commits in both federations');
  for (const [n, where] of byNonce) assert.equal(new Set(where).size, 1, `nonce ${n.slice(0, 16)} committed in ${where.join(', ')}`);
  const fedsOf = (seat) => new Set(commits.filter((c) => c.seat === seat).map((c) => c.federation));
  assert.deepEqual([...fedsOf(3)].sort(), [FED_A, FED_B].sort(), 'a seat in both S committed in both, with other nonces');
  assert.equal(stores[0].fedLockSettlement(RID, FED_A).state, 'ACCEPTED');
  assert.equal(stores[0].fedLockSettlement(RID, FED_B).state, 'ACCEPTED');
});
