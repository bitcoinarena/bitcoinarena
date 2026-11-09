// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PROTOCOL-27 SCOPE'S BATCH IS FROZEN ONCE ITS ROW STANDS ON IT (kanban #1170, the 2026-11-06 state-machine audit). Two signer sets S1, S2 over one
// body are two txids T1, T2, both valid. T1 (S1) lands; then a second asker signs S2 and hands its batch to every seat. Before: named_batches was
// INSERT OR REPLACE per (round, scope), so every seat replaced T1's batch with T2's, `take` rewrote a SUBMITTING(T1) row to T2, and `sendBuilt`
// served T2's txid and KeyAgg(S2) - auths and refunds (c) over contracts that do not exist, sends locked under KeyAgg(S1). Now every batch is kept by
// its txid, the scope stands on the one its row is SUBMITTING or ACCEPTED on (namedBatchStep), T2 is kept beside it and asked of the federation too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import * as settlementModule from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { namedKey } from '../src/named-claim.js';
import { zKey } from '../../arena-protocol/src/arena-lock.js';
import { lockSettlement } from '../../arena-protocol/src/lock-settlement.js';
import { DELIVERED, FAILED, computePayoutTable } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';

const { LockSettlement } = settlementModule;
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const RID = b32(0x6f);
const STAKE = 100000n; const FEE = entryFeeMsat(STAKE);
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score, entryId: b32(0x10 + n) });
const W1 = entry(1, DELIVERED, 5), L1 = entry(3, FAILED, 0), L2 = entry(4, FAILED, 0);
const Z = zKey();
const FEES = { ppm: 0n, baseMsat: 0n };
const locks = new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + e.pubkey[0]), outIdx: BigInt(e.pubkey[0]) }, amountMsat: STAKE - FEE,
  refundPk: Uint8Array.from([0x02, ...e.pubkey]), fields: { paymentImage: { kind: 'hash' } } }]));
const HASH = 'ab'.repeat(32);
const INVOICE = 'lnbcrt-the-winners-invoice';
const BASE = lockSettlement({ roundId: RID, entries: [W1, L1, L2], minScore: 1, locks, fees: FEES });
const PLAN = { ...BASE, payouts: BASE.payouts.map((p) => (toHex(p.pubkey) === toHex(W1.pubkey)
  ? { ...p, payoutPk: Z, kind: 'sent', sent: { paymentHash: HASH, gatewayPk: '03' + 'cd'.repeat(32), expiration: 500n } } : p)) };
const F = computePayoutTable({ roundId: RID, entries: [W1, L1, L2], minScore: 1 });
const ROWS = F.activated.map((e, i) => ({ entryId: e.entryId, pubkey: e.pubkey, amountMsat: F.table[i].amountMsat, outcome: e.outcome, score: e.score }));
const at = (o) => `${toHex(o.txid)}:${String(o.outIdx)}`;

/**
 * The federation as the stake-lock tool answers for Arena locks, with what the guardians hold: a submit lands only while every lock it claims is held
 * (a second transaction over the same locks is refused), and then its locks are gone and its payout contracts stored (`status`).
 */
function arenaPort(seatKeys, log) {
  const bodyOf = ({ claims, payouts, nonce }, set = [], agg = null) => sha256(new TextEncoder().encode(JSON.stringify({
    c: claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}:${toHex(c.preimage)}`), s: set,
    p: payouts.map((p) => `${agg && toHex(p.payoutPk) === toHex(Z) ? toHex(agg) : toHex(p.payoutPk)}:${p.msat}`), n: toHex(nonce) })));
  const spent = new Set(), stored = new Set();
  return {
    spent, stored,
    fees: async () => FEES,
    settle: async () => { throw new Error('a protocol-27 round is never settled by the stock settle'); },
    status: async (o) => ({ blockCount: 500, stored: (o.outIdx !== undefined && stored.has(at(o))) || ([...locks.values()].some((l) => at(l.outpoint) === at(o)) && !spent.has(at(o))) ? { blocksLeft: 100 } : null }),
    arenaSettle: async ({ claims, payouts, nonce, signers = null, signature = null }) => {
      const bodyId = toHex(bodyOf({ claims, payouts, nonce }));
      if (!signers) return { bodyId, zSlots: payouts.map((p, i) => (toHex(p.payoutPk) === toHex(Z) ? i : -1)).filter((i) => i >= 0) };
      const agg = namedKey(seatKeys, 5, signers);
      const txid = toHex(bodyOf({ claims, payouts, nonce }, signers, Uint8Array.from([0x02, ...agg])));
      if (!signature) return { bodyId, txid, message: txid, aggKey: toHex(agg) };
      const good = verify(signature, fromHex(txid), agg);
      const free = claims.every((c) => !spent.has(at(c.outpoint)));
      const accepted = good && free;
      log.push({ txid, signers, accepted });
      if (accepted) { for (const c of claims) spent.add(at(c.outpoint)); payouts.forEach((_, i) => stored.add(`${txid}:${i}`)); }
      return { bodyId, txid, message: txid, aggKey: toHex(agg), accepted, error: accepted ? null : good ? 'the claimed lock is already spent' : 'bad signature', locksSpent: accepted };
    },
    send: async ({ invoice }) => ({ message: sha256(new TextEncoder().encode(invoice)) }),
    arenaSendRefund: async ({ send, refundPk, qualifierPk }) => {
      const t = toHex(sha256(new TextEncoder().encode(`refund:${toHex(send.txid)}:${send.outIdx}:${toHex(refundPk)}:${toHex(qualifierPk)}`)));
      return { txid: t, message: t };
    },
  };
}

function world() {
  const log = [];
  const down = [];
  const stores = Array.from({ length: 7 }, () => new Round(openStore(':memory:')));
  const seatKeys = stores.map((r) => r.pubkey);
  const contract = { stakeMsat: STAKE, protocolVersion: 27, networkId: NETWORK_ID_REGTEST, censusHeight: 900000, federationId: b32(0xfe), nodes: seatKeys, settlementSlots: 7, minScore: 1 };
  const port = arenaPort(seatKeys, log);
  const seats = [];
  const fetcher = async (url, opts = {}) => {
    const u = new URL(url);
    const i = Number(u.hostname.replace('seat', ''));
    if (down.includes(i)) throw new Error('connection refused');
    const ls = seats[i];
    const r8 = fromHex(u.searchParams.get('round'));
    const named = u.searchParams.get('named') === '1';
    const body = opts.body ? new Uint8Array(opts.body) : new Uint8Array();
    const ask = opts.headers && opts.headers['x-settlement-ask'] ? fromHex(opts.headers['x-settlement-ask']) : null;
    const answer = (got, bytes, headers = {}) => ({ ok: got.ok, status: got.ok ? 200 : got.status || 409, text: async () => got.why || '',
      arrayBuffer: async () => bytes, headers: { get: (h) => headers[h] || null } });
    if (u.pathname === '/settle-ack') { const got = await ls.ack(r8, { txid: u.searchParams.get('txid') }); return answer(got, got.bytes); }
    if (u.pathname === '/settle-commit') {
      const got = await ls.commit(r8, { txid: u.searchParams.get('txid'), acks: body, door: true, ask });
      return answer(got, got.wire, got.word ? { 'x-settlement-commit': toHex(got.word) } : {});
    }
    if (u.pathname === '/settle-share') { const got = await ls.share(r8, body, { door: true, ask, named }); return answer(got, got.wire); }
    if (u.pathname === '/settle-signature') { const got = await ls.take(r8, body, { named }); return answer(got, new Uint8Array()); }
    throw new Error(`no door ${u.pathname}`);
  };
  stores.forEach((round, i) => {
    const winnings = { round: { sendAttemptsOf: () => [{ attempt: 0, paymentHash: HASH, payoutMsat: PLAN.payouts.find((p) => p.sent).msat, expiration: 500n,
      gatewayPk: '03' + 'cd'.repeat(32), invoice: INVOICE }] } };
    const ls = new LockSettlement(round, { dkg: { signerNodeFor: () => { throw new Error('a protocol-27 round has no claim-key share'); } }, port, curve,
      random: (n) => crypto.getRandomValues(new Uint8Array(n)), stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) },
      peersFor: () => seatKeys.map((_, j) => j).filter((j) => j !== i).map((j) => `http://seat${j}`), fetcher, winnings, peerAskMs: 2000, peerGraceMs: 50 });
    ls.planOf = async () => ({ ok: true, plan: PLAN, base: { plan: PLAN }, contract, claimPk: Z, held: { ok: true, signerNode: null },
      locks, lockEntry: new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), e.entryId])), ackRows: ROWS });
    ls.turn = async () => ({ mine: i === 0, why: 'seat 0 combines' });
    ls.planSends = async () => ({ ok: true });
    ls.sendWinnings = async () => [];
    ls.confirmSoon = () => {};
    seats.push(ls);
  });
  return { seats, stores, seatKeys, log, down, port };
}

/** What each seat would send and serve now: the txid and signer set its sends read, and its row. */
async function standing(seats, stores) {
  const out = [];
  for (let i = 0; i < seats.length; i++) {
    const built = seats[i].sendBuilt(RID, await seats[i].message(RID));
    const row = stores[i].lockSettlement(RID);
    out.push({ seat: i, sends: built.ok ? built.txid.slice(0, 8) : `none (${built.why.slice(0, 40)})`, S: built.ok ? built.signers.join(',') : null,
      row: row ? `${row.state} ${row.txid.slice(0, 8)}` : 'none', standing: (stores[i].namedBatch(RID, '') || { txid: '-' }).txid.slice(0, 8) });
  }
  return out;
}

test('#1170 T1 of S1 landed; a second asker\'s batch of S2 over the same body is kept beside it, never in its place', async () => {
  const { seats, stores, seatKeys, log, down } = world();
  // ROUND ONE: seat 1 silent, seat 0 signs S1 = 0,2,3,4,5 and submits T1; it lands
  down.push(1);
  const first = await seats[0].settle(RID);
  assert.equal(first.ok, true, first.why);
  const T1 = log[0].txid;
  assert.deepEqual(log[0].signers, [0, 2, 3, 4, 5]);
  // seat 3 asks the federation and finds T1 in: ACCEPTED on T1
  seats[3].turn = async () => ({ mine: false, why: 'seat 0 combines' });
  const found = await seats[3].settle(RID);
  assert.equal(stores[3].lockSettlement(RID).state, 'ACCEPTED', found.why);
  // ROUND TWO: seat 1 back and asking (a takeover, or on purpose): it keeps no batch, so it signs S2 = 0,1,2,3,4 and hands it to every seat
  down.length = 0;
  seats[1].turn = async () => ({ mine: true, why: 'seat 1 takes over' });
  await seats[1].settle(RID);
  const T2 = log.find((x) => x.txid !== T1) ? log.find((x) => x.txid !== T1).txid : null;
  assert.ok(T2 && T2 !== T1, 'the second asker signed another signer set over the same body');
  assert.equal(log.find((x) => x.txid === T2).accepted, false, 'T2 claims locks T1 already spent');
  const now = await standing(seats, stores);
  console.log(`#1170 T1 ${T1.slice(0, 8)} (S1 0,2,3,4,5) landed; T2 ${T2.slice(0, 8)} (S2 0,1,2,3,4) handed after it`);
  for (const x of now) console.log(`#1170   seat ${x.seat}: sends read ${x.sends}${x.S ? ` S ${x.S}` : ''}, row ${x.row}, standing batch ${x.standing}`);
  for (const i of [0, 2, 3, 4, 5, 6]) {
    const x = now[i];
    assert.equal(x.sends, T1.slice(0, 8), `seat ${i}'s sends read ${x.sends}, not the landed T1`);
    assert.equal(x.S, '0,2,3,4,5');
    assert.match(x.row, new RegExp(` ${T1.slice(0, 8)}$`), `seat ${i}'s row moved to T2`);
    assert.equal(x.standing, T1.slice(0, 8));
  }
  // the refund key every seat's sends name is KeyAgg(S1), the key the landed contracts refund to
  const agg1 = Uint8Array.from([0x02, ...namedKey(seatKeys, 5, [0, 2, 3, 4, 5])]);
  const b0 = seats[0].sendBuilt(RID, await seats[0].message(RID));
  assert.equal(toHex(b0.claimPk), toHex(agg1));
  // T2's batch is kept, by its txid, at the seats it was handed to
  if (typeof stores[2].namedBatchesOf === 'function') assert.deepEqual(stores[2].namedBatchesOf(RID, '').map((b) => b.txid).sort(), [T1, T2].sort());
});

test('#1170 the batch step: a row SUBMITTING or ACCEPTED on T freezes T\'s batch; a row that moves onto T\' carries the standing batch with it', async () => {
  const { namedBatchStep } = settlementModule;
  assert.equal(typeof namedBatchStep, 'function', 'one transition function for the standing batch');
  const T = 'a1'.repeat(32), T2 = 'b2'.repeat(32);
  assert.equal(namedBatchStep(null, { txid: T }, null).ok, true);
  assert.equal(namedBatchStep({ txid: T }, { txid: T2 }, null).ok, true, 'no row on T yet: a new body or signer set may stand');
  assert.equal(namedBatchStep({ txid: T }, { txid: T2 }, { state: 'REFUSED', txid: T }).ok, true, 'refused on T: signed again');
  assert.match(namedBatchStep({ txid: T }, { txid: T2 }, { state: 'SUBMITTING', txid: T }).why, /frozen/);
  assert.match(namedBatchStep({ txid: T }, { txid: T2 }, { state: 'ACCEPTED', txid: T }).why, /frozen/);
  assert.equal(namedBatchStep({ txid: T }, { txid: T2 }, { state: 'ACCEPTED', txid: T2 }).ok, true, 'the row found T2 in: T2 stands');

  // a seat SUBMITTING on T1 is handed T2; T2 is the one that lands: the seat asks every txid it kept, moves onto T2, and stands on T2's batch
  const { seats, stores, log, down, port } = world();
  down.push(1);
  // seat 0 signs S1 but its submit never reaches the guardians (it dies there): the seats hold SUBMITTING(T1)
  const submit = port.arenaSettle;
  port.arenaSettle = async (a) => (a.signature ? { accepted: false, error: 'connection reset', txid: (await submit({ ...a, signature: null })).txid } : submit(a));
  await seats[0].settle(RID);
  port.arenaSettle = submit;
  const T1 = stores[2].lockSettlement(RID).txid;
  assert.equal(stores[2].lockSettlement(RID).state, 'SUBMITTING');
  down.length = 0;
  seats[1].turn = async () => ({ mine: true, why: 'seat 1 takes over' });
  const second = await seats[1].settle(RID);
  const T2b = log.find((x) => x.accepted).txid;
  assert.notEqual(T2b, T1);
  assert.equal(second.ok, true, second.why);
  const before = { row: stores[2].lockSettlement(RID).txid.slice(0, 8), standing: stores[2].namedBatch(RID, '').txid.slice(0, 8) };
  seats[2].turn = async () => ({ mine: false, why: 'seat 1 combines' });
  const asked = await seats[2].settle(RID);
  const after = { state: stores[2].lockSettlement(RID).state, row: stores[2].lockSettlement(RID).txid.slice(0, 8), standing: stores[2].namedBatch(RID, '').txid.slice(0, 8) };
  console.log(`#1170 seat 2 SUBMITTING T1 ${T1.slice(0, 8)}, handed T2 ${T2b.slice(0, 8)} which landed: before ${JSON.stringify(before)}, after asking ${JSON.stringify(after)} - ${String(asked.why).slice(0, 100)}`);
  assert.deepEqual(after, { state: 'ACCEPTED', row: T2b.slice(0, 8), standing: T2b.slice(0, 8) });
  assert.equal(seats[2].sendBuilt(RID, await seats[2].message(RID)).txid, T2b);
});

// kanban #1370 (audit 2 #1204 SETTLEMENT-2): the freeze holds on the seat's own pass too - a batch taken while the pass signed is not written over
test('#1370 a batch taken while this seat\'s own pass signed: the pass keeps its batch beside it and submits nothing', async () => {
  const { seats, stores, log, down } = world();
  const origFetch = seats[1].fetcher;
  let fired = false;
  // seat 1 asks; at its first share request, seat 0 settles with seat 4 silent (S_A = 0,1,2,3,5) and hands T_A to seat 1
  seats[1].fetcher = async (url, opts) => {
    if (!fired && new URL(url).pathname === '/settle-share') {
      fired = true;
      down.push(4);
      const a = await seats[0].settle(RID);
      down.length = 0;
      assert.equal(a.ok, true, a.why);
    }
    return origFetch(url, opts);
  };
  seats[1].turn = async () => ({ mine: true, why: 'seat 1 asks' });
  const b = await seats[1].settle(RID);
  const TA = log[0] && log[0].txid;
  const row = stores[1].lockSettlement(RID);
  const submits = log.map((x) => `${x.txid.slice(0, 8)} S ${x.signers.join(',')} ${x.accepted ? 'in' : 'refused'}`);
  console.log(`#1370 submits: ${submits.join(' | ')}; seat 1 row ${row ? `${row.state} ${row.txid.slice(0, 8)}` : 'none'}; its pass: ${b.ok ? 'ok' : b.why}`);
  assert.ok(fired && TA, 'seat 0 submitted T_A during seat 1\'s pass');
  assert.equal(log.length, 1, 'seat 1 submitted nothing of its own over the frozen row');
  assert.equal(row.txid, TA, 'seat 1\'s row stays on T_A');
  assert.equal(stores[1].lockSettlementMoves ? stores[1].lockSettlementMoves(RID).txid : TA, TA, 'and its moves name T_A');
});
