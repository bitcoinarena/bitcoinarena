// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT JOINS THE FROST SIGNING ONLY WITH ACKS FROM AT LEAST THE THRESHOLD (§5A.3, RULED 2026-11-02, kanban #1035, #1040). Two signer nodes of a
// 2-of-2 claim key settle a round of version 22 through each other's doors: the ack comes first, the commit carries the acks, each seat keeps
// them and the table they name. Refused by name: a commit with no acks, with too few, with another table's. A round of an older version
// settles with no acks, as it always did.
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
import { DELIVERED, FAILED, computePayoutTable } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { tableFalse } from '../../arena-protocol/src/settlement-rebuild.js';
import { joinAcks, splitAcks, splitSignedAck, encodeSettlementTable, decodeSettlementTable, settlementTableId, countAcks, signSettlementAck, planTableRows } from '../../arena-protocol/src/settlement-ack.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const RID = b32(0x5f);
const STAKE = 100000n; const FEE = entryFeeMsat(STAKE);
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score, entryId: b32(0x10 + n) });
const W1 = entry(1, DELIVERED, 5), L1 = entry(3, FAILED, 0), L2 = entry(4, FAILED, 0);
const fedOfPlayer = new Map([[1, A], [3, A], [4, B]]);
const locks = new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + Number(e.pubkey[0])), outIdx: BigInt(e.pubkey[0]) }, amountMsat: STAKE - FEE, refundPk: refund(e.pubkey[0]) }]));
const F = computePayoutTable({ roundId: RID, entries: [W1, L1, L2], minScore: 1 });
const F_ROWS = F.activated.map((e, i) => ({ entryId: e.entryId, pubkey: e.pubkey, amountMsat: F.table[i].amountMsat, outcome: e.outcome, score: e.score }));
const PLAN = federationPlans({ roundId: RID, entries: [W1, L1, L2], minScore: 1, locks, feeLocks: new Map() },
  { federationOf: (o) => fedOfPlayer.get(Number(o.outIdx)), feesOf: (f) => (f === A ? { ppm: 0n, baseMsat: 1000n } : { ppm: 0n, baseMsat: 0n }) });

function fedPort(fid, log) {
  const bytesOf = ({ claims, payouts, nonce }) => sha256(new TextEncoder().encode(JSON.stringify({ fid, c: claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`),
    p: payouts.map((p) => `${toHex(p.payoutPk)}:${p.msat}`), n: toHex(nonce) })));
  return {
    fees: async () => (fid === A ? { ppm: 0n, baseMsat: 1000n } : { ppm: 0n, baseMsat: 0n }),
    settle: async ({ claimPk, claims, payouts, nonce, signature }) => {
      const msg = bytesOf({ claims, payouts, nonce });
      if (!signature) return { message: toHex(msg), txid: toHex(msg) };
      const accepted = schnorr.verify(signature, msg, claimPk.subarray(1));
      log.push({ fid, accepted });
      // AS THE TOOL ANSWERS (kanban #1171, #1172): an accepted submit's payouts stored and its claimed locks gone
      return accepted ? { accepted: true, payoutsStored: payouts.map(() => ({ stored: true })), locksAfter: claims.map(() => null) } : { accepted: false, error: 'bad signature' };
    },
  };
}

const V3 = encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: new Uint8Array(32),
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 3 });

/** Two seats, each with its own node key, that reach each other's doors as server.js serves them. `rows(id)` lets a seat compute another table. */
function world({ protocolVersion, rows = () => null, door = null }) {
  const G = evenGroupSecret(0x51515n, curve);
  const deal = trustedDealerSplit({ secret: G.secret, max: 2, min: 2, coefficients: [0x77n], curve });
  const log = [];
  const ports = { [A]: fedPort(A, log), [B]: fedPort(B, log) };
  const router = { forFederation: async (f) => ports[f] || null, settle: async () => { throw new Error('a round that takes any federation never settles on the home port'); } };
  const stores = [1, 2].map(() => new Round(openStore(':memory:')));
  const contract = { stakeMsat: STAKE, protocolVersion, networkId: NETWORK_ID_REGTEST, censusHeight: 900000, federationId: new Uint8Array(32), nodes: stores.map((r) => r.pubkey), settlementSlots: 2, minScore: 1 };
  const nodes = stores.map((round, i) => {
    const dkg = { publicSharesFor: () => ({ ok: true, shares: new Map(deal.shares.map((x) => [String(x.id), curve.pointFromScalar(x.share)])) }) };
    const ls = new LockSettlement(round, { dkg, port: router, curve, random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) }, peersFor: () => (i === 0 ? ['http://peer2'] : []), peerKeyOf: (rid, base) => (base === 'http://peer2' ? toHex(stores[1].pubkey) : null) });
    ls.planOf = async () => ({ ok: true, anyFed: true, plan: PLAN.plan, split: PLAN.split, contract, claimPk: deal.groupPublicKey,
      held: { signerNode: deal.shares[i] }, lockEntry: new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), e.entryId])), ackRows: rows(i) || F_ROWS });
    round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: V3 } : null);
    return ls;
  });
  nodes[0].fetcher = async (url, o) => {
    const u = new URL(url); const fed = u.searchParams.get('federation'); const two = nodes[1];
    const ok = (bytes, word = null) => ({ ok: true, headers: new Map(word ? [['x-settlement-commit', toHex(word)]] : []), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), text: async () => '' });
    const no = (why) => ({ ok: false, text: async () => why });
    if (door) { const got = door(u, o); if (got) return got; }
    if (u.pathname === '/settle-ack') { const g = await two.ack(RID, { txid: u.searchParams.get('txid'), federation: fed }); return g.ok ? ok(g.bytes) : no(g.why); }
    if (u.pathname === '/settle-commit') { const g = await two.commit(RID, { txid: u.searchParams.get('txid'), federation: fed, acks: o.body ? new Uint8Array(o.body) : new Uint8Array(0) }); return g.ok ? ok(encodeCommitments([g.commitment]), g.word) : no(g.why); }
    if (u.pathname === '/settle-share') { const g = await two.share(RID, decodeCommitments(new Uint8Array(o.body)), { federation: fed }); return g.ok ? ok(encodeShare(g.share)) : no(g.why); }
    if (u.pathname === '/settle-signature') { const g = await two.take(RID, o.body, { federation: fed }); return g.ok ? ok(new Uint8Array(0)) : no(g.why); }
    return no('no such door');
  };
  return { nodes, stores, log, contract, deal };
}
const close = (w) => { for (const r of w.stores) r.db.close(); };

test('a round of version 22 settles on a threshold of acks, and both seats keep them and the table', async () => {
  const w = world({ protocolVersion: 22 });
  const got = await w.nodes[0].settle(RID);
  console.log('  SETTLE:', got.why);
  assert.equal(got.ok, true, got.why);
  assert.equal(w.log.length, 2, 'one submit per federation');
  assert.ok(w.log.every((x) => x.accepted));
  for (const r of w.stores) {
    const rows = r.settlementAcksOf(RID);
    assert.deepEqual(rows.map((x) => x.scope).sort(), [A, B]);
    for (const row of rows) {
      const acks = splitAcks(row.acks);
      const table = decodeSettlementTable(row.table);
      assert.equal(toHex(settlementTableId(table)), toHex(row.tableId), 'the published table is the one the acks name');
      assert.deepEqual(table.rows.map((x) => toHex(x.entryId)).sort(), [W1, L1, L2].map((e) => toHex(e.entryId)).sort());
      const c = countAcks({ acks, seats: w.contract.nodes, slots: 2, roundId: RID, payoutTableId: row.tableId, settlementTxid: splitSignedAck(acks[0]).ack.settlementTxid, verify });
      assert.deepEqual([c.agreed, c.needed, c.final], [2, 2, true], 'a stranger checks them from the bytes alone');
      assert.equal(toHex(splitSignedAck(acks[0]).ack.settlementTxid), row.txid);
      // EACH FEDERATION'S TABLE IS ITS OWN (kanban #1043): its claims, its payouts and its nonce, read against the rows the way the seats split them, and it stands
      assert.equal(toHex(table.federationId), row.scope);
      assert.deepEqual(table.claims.map((c) => toHex(c.entryId)).sort(), (row.scope === A ? [L1] : [L2]).map((e) => toHex(e.entryId)));
      const shown = new Map([W1, L1, L2].map((e) => [toHex(e.entryId), { roundId: RID, playerPubkey: e.pubkey, stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: e.donationMsat,
        federationId: fromHex(fedOfPlayer.get(Number(e.pubkey[0]))), stakeLockOutpoint: locks.get(toHex(e.pubkey)).outpoint, feeLockOutpoint: { txid: b32(0x60), outIdx: 0n } }]));
      const rate = { [A]: { ppm: 0n, baseMsat: 1000n }, [B]: { ppm: 0n, baseMsat: 0n } };
      const read = (t) => tableFalse({ table: t, contract: { ...w.contract, minScore: 1, federationId: new Uint8Array(32) }, entries: shown, feesOf: (f) => rate[f] });
      assert.deepEqual(read(table), [], 'an honest federation\'s table is false on nothing');
      assert.match(read({ ...table, payouts: table.payouts.map((p) => ({ ...p, msat: p.msat - 1n })) }).join('; '), /the transaction does not/);
    }
  }
  close(w);
});

test('a seat refuses to join without the threshold of acks, each way short by name', async () => {
  const w = world({ protocolVersion: 22 });
  const [one, two] = w.nodes;
  const m = await one.fedMessage(RID, A);
  const q = { txid: m.txid, federation: A };
  assert.match((await two.commit(RID, q)).why, /joins the signing only with acks from 2 of the round's seats, and holds 0/);
  const mine = (await one.ack(RID, q)).bytes, theirs = (await two.ack(RID, q)).bytes;
  assert.match((await two.commit(RID, { ...q, acks: joinAcks([mine]) })).why, /holds 1/);
  assert.match((await two.commit(RID, { ...q, acks: joinAcks([mine, mine]) })).why, /holds 1/, 'one seat twice is one ack');
  const tampered = mine.slice(); tampered[tampered.length - 1] ^= 1;
  assert.match((await two.commit(RID, { ...q, acks: joinAcks([tampered, theirs]) })).why, /does not verify/);
  // a stranger's ack is not a seat's
  const secret = b32(7);
  const stranger = signSettlementAck(splitSignedAck(mine).ack, schnorr.getPublicKey(secret), (d) => schnorr.sign(d, secret));
  assert.match((await two.commit(RID, { ...q, acks: joinAcks([stranger, theirs]) })).why, /not one of the round's seats/);
  // the threshold over the right bytes is a commitment
  assert.equal((await two.commit(RID, { ...q, acks: joinAcks([mine, theirs]) })).ok, true);
  assert.equal(w.stores[1].settlementAcksOf(RID, A).length, 1);
  assert.equal(w.stores[1].settlementAcksOf(RID, B).length, 0);
  close(w);
});

test('a seat that computed another table does not make the threshold: nothing is signed, and the ask says who', async () => {
  const w = world({ protocolVersion: 22, rows: (i) => (i === 1 ? [W1, L1, L2].map((e) => ({ entryId: e.entryId, pubkey: e.pubkey, amountMsat: 2n })) : null) });
  const got = await w.nodes[0].settle(RID);
  assert.equal(got.ok, false);
  assert.match(got.why, /1 of the 2 signer nodes the settlement needs acked it/);
  assert.match(got.why, /computed another table/);
  assert.equal(w.log.length, 0, 'nothing went to a federation');
  assert.equal(w.nodes[1].pairs.size, 0, 'and the peer made no nonce for it');
  close(w);
});

test('a peer with no ack door stops a round of 22, and a round older than the ack settles with none', async () => {
  const noDoor = world({ protocolVersion: 22, door: (u) => (u.pathname === '/settle-ack' ? { ok: false, text: async () => 'not found' } : null) });
  const stopped = await noDoor.nodes[0].settle(RID);
  assert.equal(stopped.ok, false);
  assert.match(stopped.why, /acked it/);
  close(noDoor);

  const old = world({ protocolVersion: 3, door: (u) => { if (u.pathname === '/settle-ack') throw new Error('an old round asked for an ack'); return null; } });
  const got = await old.nodes[0].settle(RID);
  assert.equal(got.ok, true, got.why);
  assert.equal(old.stores[0].settlementAcksOf(RID).length, 0);
  assert.match((await old.nodes[1].ack(RID, { federation: A })).why, /older than the ack/);
  close(old);
});

test('a late loser\'s second settlement goes through the same acks, under its own scope', async () => {
  const w = world({ protocolVersion: 22 });
  const LATE = b32(0x71);
  const message = sha256(new TextEncoder().encode('a late settlement'));
  const log = [];
  w.nodes.forEach((ls, i) => {
    ls.lateMessage = async () => ({ ok: true, message, txid: toHex(message), plan: { claims: [], payouts: [], poolMsat: 0n, paidMsat: 0n, nonce: b32(3) }, claims: [],
      claimPk: w.deal.groupPublicKey, signerNode: w.deal.shares[i], needed: 2, contract: w.contract,
      ackTable: { roundId: RID, lateEntryId: LATE, rows: [{ entryId: new Uint8Array(32), pubkey: pk(1), amountMsat: 7n }] } });
    ls.turn = async () => ({ mine: true });
    ls.portFor = async () => ({ settle: async ({ claimPk, signature }) => { const accepted = schnorr.verify(signature, message, claimPk.subarray(1)); log.push(accepted); return { accepted, payoutsStored: [{ stored: true }], locksAfter: [null] }; } });
    ls.latePort = ls.portFor;   // the late loser's federation's port (kanban #1172)
    ls.sendLate = async () => null;
  });
  const realFetch = w.nodes[0].fetcher;
  w.nodes[0].fetcher = async (url, o) => {
    const u = new URL(url); const two = w.nodes[1];
    const ok = (bytes) => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), text: async () => '' });
    const no = (why) => ({ ok: false, text: async () => why });
    if (!u.searchParams.get('entry')) return realFetch(url, o);
    const entry = new Uint8Array(Buffer.from(u.searchParams.get('entry'), 'hex'));
    if (u.pathname === '/settle-ack') { const g = await two.ack(RID, { txid: u.searchParams.get('txid'), entry }); return g.ok ? ok(g.bytes) : no(g.why); }
    if (u.pathname === '/settle-commit') { const g = await two.commit(RID, { txid: u.searchParams.get('txid'), entry, acks: o.body }); return g.ok ? ok(encodeCommitments([g.commitment])) : no(g.why); }
    if (u.pathname === '/settle-share') { const g = await two.share(RID, decodeCommitments(new Uint8Array(o.body)), { entry }); return g.ok ? ok(encodeShare(g.share)) : no(g.why); }
    if (u.pathname === '/settle-signature') { const g = await two.take(RID, o.body, { entry }); return g.ok ? ok(new Uint8Array(0)) : no(g.why); }
    return no('no such door');
  };
  const got = await w.nodes[0].settleLate(RID, LATE);
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(log, [true]);
  const [row] = w.stores[1].settlementAcksOf(RID, toHex(LATE));
  assert.equal(splitAcks(row.acks).length, 2);
  assert.equal(toHex(decodeSettlementTable(row.table).lateEntryId), toHex(LATE));
  close(w);
});

test('the table of a plan with no entries of its own encodes a payout key of 33 bytes (kanban #1049: every late settlement of protocol 22 threw at the seat\'s own ack)', () => {
  const rows = planTableRows({ payouts: [{ payoutPk: refund(7), msat: 90000n }, { payoutPk: pk(8), msat: 4000n }] });
  const t = decodeSettlementTable(encodeSettlementTable({ roundId: RID, lateEntryId: b32(9), rows }));
  assert.deepEqual(t.rows.map((r) => [toHex(r.pubkey), r.amountMsat]).sort(), [[toHex(refund(7).subarray(1)), 90000n], [toHex(pk(8)), 4000n]].sort());
});

// WHO WAS SILENT, AS THE SEAT THAT ASKED HOLDS IT (§5A.3 "Stalled in its rounds", protocol 26, RULED 2026-11-03, kanban #1066): where the pass stopped, the seats that gave no signed
// word at that step, the share included, and a refusal counts only after signing FINAL.
const down = { ok: false, status: 503, text: async () => 'bad gateway' };
const refusal = { ok: false, status: 409, text: async () => 'this node holds no such series' };
const signedFinal = (w) => w.stores[0].db.prepare('INSERT INTO final_sigs (round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)').run(RID, Buffer.alloc(32, 1), Buffer.alloc(32, 2), w.stores[1].pubkey, Buffer.alloc(1), 1);
const stopped = async (door, { final = false } = {}) => {
  const w = world({ protocolVersion: 26, door });
  if (final) signedFinal(w);
  const got = await w.nodes[0].settle(RID);
  assert.equal(got.ok, false);
  const passes = w.stores[0].settlePassesOf(RID), peer = toHex(w.stores[1].pubkey);
  close(w);
  assert.deepEqual([...new Set(passes.map((p) => p.scope))].sort(), [A, B]);
  assert.equal(new Set(passes.map((p) => p.step)).size, 1);
  return { step: passes[0].step, named: passes.every((p) => p.silent.length === 1 && p.silent[0] === peer), clear: passes.every((p) => p.silent.length === 0) };
};
test('from protocol 26 a commit comes with the seat\'s signed word, and a pass that stops keeps who was silent at the step it stopped at', async () => {
  const fine = world({ protocolVersion: 26 });
  assert.equal((await fine.nodes[0].settle(RID)).ok, true);
  assert.deepEqual(fine.stores[0].settlePassesOf(RID), [], 'a pass that worked keeps nothing');
  close(fine);
  for (const [step, path] of [['ack', '/settle-ack'], ['commit', '/settle-commit'], ['share', '/settle-share']]) {
    const door = (answer) => (u) => (u.pathname === path ? answer : null);
    const out = await stopped(door(down));
    assert.deepEqual([out.step, out.named], [step, true], `no answer at the ${step}: silent, FINAL or not`);
    const refused = await stopped(door(refusal));
    assert.deepEqual([refused.step, refused.clear], [step, true], `a refusal at the ${step} by a seat that never signed FINAL: not named`);
    const after = await stopped(door(refusal), { final: true });
    assert.deepEqual([after.step, after.named], [step, true], `a refusal at the ${step} after signing FINAL: silent, whatever its reason`);
  }
  const lost = await stopped((u) => { if (u.pathname === '/settle-share') throw new Error('fetch failed'); return null; });
  assert.deepEqual([lost.step, lost.named], ['share', true], 'a share that never came');
  // A SHARE THAT DOES NOT COMBINE IS NO SIGNED WORD: the seat's public share says whose it was
  const bad = encodeShare(12345n);
  const spoilt = await stopped((u) => (u.pathname === '/settle-share' ? { ok: true, arrayBuffer: async () => bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.length) } : null));
  assert.deepEqual([spoilt.step, spoilt.named], ['share', true]);

  const old = world({ protocolVersion: 22, door: (u) => (u.pathname === '/settle-ack' ? { ok: false, text: async () => 'down' } : null) });
  await old.nodes[0].settle(RID);
  assert.deepEqual(old.stores[0].settlePassesOf(RID), [], 'below 26 nothing is kept');
  close(old);
});
