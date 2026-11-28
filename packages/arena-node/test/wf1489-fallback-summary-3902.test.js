// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3902: copy of named-fallback-1281.test.js's harness. THE FALLBACK CLAIM THROUGH THE SEATS' DOORS (spec §23.2, RULED #1268 / #1290, kanban #1281): three of seven seats silent, the claim cannot reach
// five; the fallback's body is acked, committed and signed by the lowest four with t - 1 under KeyAgg of the four, filed through the tool's
// Fallback witness (no preimage), on the round's own row. The seven-seat harness of named-settlement.test.js, its port answering by the
// fallback's threshold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import { LockSettlement } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { namedKey } from '../src/named-claim.js';
import { namedSlots, decodeNamedList, encodeNamedList } from '../src/named-settlement.js';
import { zKey } from '../../arena-protocol/src/arena-lock.js';
import { lockSettlement } from '../../arena-protocol/src/lock-settlement.js';
import { settlementCommitBody, signSettlementCommit } from '../../arena-protocol/src/settlement-ack.js';
import { TAG } from '../../arena-protocol/src/constants.js';
import { DELIVERED, FAILED, computePayoutTable } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex, fromHex, sha256, taggedHash } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const RID = b32(0x6e);
const STAKE = 100000n; const FEE = entryFeeMsat(STAKE);
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score, entryId: b32(0x10 + n) });
const W1 = entry(1, DELIVERED, 5), L1 = entry(3, FAILED, 0), L2 = entry(4, FAILED, 0);
const Z = zKey();
const FEES = { ppm: 0n, baseMsat: 0n };
const locks = new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + e.pubkey[0]), outIdx: BigInt(e.pubkey[0]) }, amountMsat: STAKE - FEE,
  refundPk: Uint8Array.from([0x02, ...e.pubkey]), fields: { paymentImage: { kind: 'hash' } } }]));
const HASH = 'ab'.repeat(32);
const INVOICE = 'lnbcrt-the-winners-invoice';
// the plan with the winner paid by a gateway send refunding to the signer set's key (Z in the body): lockSettlement's own shape of a sent payout
const BASE = lockSettlement({ roundId: RID, entries: [W1, L1, L2], minScore: 1, locks, fees: FEES });
const PLAN = { ...BASE, payouts: BASE.payouts.map((p) => (toHex(p.pubkey) === toHex(W1.pubkey)
  ? { ...p, payoutPk: Z, kind: 'sent', sent: { paymentHash: HASH, gatewayPk: '03' + 'cd'.repeat(32), expiration: 500n } } : p)) };
// THE FALLBACK'S TABLE IS NOT THE CLAIM'S (spec §23.2): its node row goes only to the seats with a signed result, the rest to the reserves - here one payout more
const FB_PLAN = { ...PLAN, payouts: [...PLAN.payouts, { payoutPk: Uint8Array.from([0x02, ...b32(0x77)]), msat: 1000n, feeMsat: 0n, kind: 'reserve' }] };
const F = computePayoutTable({ roundId: RID, entries: [W1, L1, L2], minScore: 1 });
const ROWS = F.activated.map((e, i) => ({ entryId: e.entryId, pubkey: e.pubkey, amountMsat: F.table[i].amountMsat, outcome: e.outcome, score: e.score }));

/** The federation as the stake-lock tool answers for Arena locks: the body with Z, the real transaction with S and KeyAgg(S), the send, the refund (c). */
function arenaPort(seatKeys, log) {
  const keyHex = (k) => toHex(k);
  const bodyOf = ({ claims, payouts, nonce }, set = [], agg = null) => sha256(new TextEncoder().encode(JSON.stringify({
    c: claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}:${c.preimage ? toHex(c.preimage) : 'fallback'}`), s: set,
    p: payouts.map((p) => `${agg && keyHex(p.payoutPk) === toHex(Z) ? toHex(agg) : keyHex(p.payoutPk)}:${p.msat}`), n: toHex(nonce) })));
  return {
    fees: async () => FEES,
    settle: async () => { throw new Error('a protocol-27 round is never settled by the stock settle'); },
    arenaSettle: async ({ claims, payouts, nonce, signers = null, signature = null, fallback = false }) => {
      log.push({ arenaSettle: { fallback, signers, preimages: claims.map((c) => !!c.preimage) } });
      const bodyId = toHex(bodyOf({ claims, payouts, nonce }));
      if (!signers) return { bodyId, zSlots: payouts.map((p, i) => (toHex(p.payoutPk) === toHex(Z) ? i : -1)).filter((i) => i >= 0) };
      const agg = namedKey(seatKeys, fallback ? 4 : 5, signers);
      const txid = toHex(bodyOf({ claims, payouts, nonce }, signers, Uint8Array.from([0x02, ...agg])));
      if (!signature) return { bodyId, txid, message: txid, aggKey: toHex(agg) };
      const accepted = verify(signature, fromHex(txid), agg);
      log.push({ txid, signers, accepted, fallback });
      // AS THE TOOL ANSWERS (stake-lock arena-settle): an accepted submit's first claimed lock is spent within its wait (kanban #1171: locks_spent)
      return { bodyId, txid, message: txid, aggKey: toHex(agg), accepted, error: accepted ? null : 'bad signature', locksSpent: accepted };
    },
    send: async ({ invoice }) => ({ message: sha256(new TextEncoder().encode(invoice)) }),
    arenaSendRefund: async ({ send, refundPk, qualifierPk }) => {
      const t = toHex(sha256(new TextEncoder().encode(`refund:${toHex(send.txid)}:${send.outIdx}:${toHex(refundPk)}:${toHex(qualifierPk)}`)));
      return { txid: t, message: t };
    },
  };
}

/** Seven seats; `down` seats answer nothing, `spoil` seats answer partials that do not verify. */
function world({ down = [], spoil = [] } = {}) {
  const log = [];
  const stores = Array.from({ length: 7 }, () => new Round(openStore(':memory:')));
  const seatKeys = stores.map((r) => r.pubkey);
  const contract = { stakeMsat: STAKE, protocolVersion: 27, networkId: NETWORK_ID_REGTEST, censusHeight: 900000, federationId: b32(0xfe), nodes: seatKeys, settlementSlots: 7, minScore: 1 };
  const port = arenaPort(seatKeys, log);
  const base = (i) => `http://seat${i}`;
  const seats = [];
  const fetcher = async (url, opts = {}) => {
    const u = new URL(url);
    const i = Number(u.hostname.replace('seat', ''));
    if (down.includes(i)) throw new Error('connection refused');
    const ls = seats[i];
    const r8 = fromHex(u.searchParams.get('round'));
    const named = u.searchParams.get('named') === '1';
    const fallback = u.searchParams.get('fallback') === '1';
    const body = opts.body ? new Uint8Array(opts.body) : new Uint8Array();
    const ask = opts.headers && opts.headers['x-settlement-ask'] ? fromHex(opts.headers['x-settlement-ask']) : null;
    const answer = (got, bytes, headers = {}) => ({ ok: got.ok, status: got.ok ? 200 : got.status || 409, text: async () => got.why || '',
      arrayBuffer: async () => bytes, headers: { get: (h) => headers[h] || null } });
    if (u.pathname === '/settle-ack') { const got = await ls.ack(r8, { txid: u.searchParams.get('txid'), fallback }); return answer(got, got.bytes); }
    if (u.pathname === '/settle-commit') {
      const got = await ls.commit(r8, { txid: u.searchParams.get('txid'), acks: body, door: true, ask, fallback });
      return answer(got, got.wire, got.word ? { 'x-settlement-commit': toHex(got.word) } : {});
    }
    if (u.pathname === '/settle-share') {
      const got = await ls.share(r8, body, { door: true, ask, named, fallback });
      if (got.ok && spoil.includes(i)) return answer(got, Uint8Array.from([0, got.partials.length, ...got.partials.flatMap(() => [...b32(7)])]));
      return answer(got, got.wire);
    }
    if (u.pathname === '/settle-signature') { const got = await ls.take(r8, body, { named, fallback }); return answer(got, new Uint8Array()); }
    throw new Error(`no door ${u.pathname}`);
  };
  stores.forEach((round, i) => {
    const winnings = { round: { sendAttemptsOf: () => [{ attempt: 0, paymentHash: HASH, payoutMsat: PLAN.payouts.find((p) => p.sent).msat, expiration: 500n,
      gatewayPk: '03' + 'cd'.repeat(32), invoice: INVOICE }] } };
    const ls = new LockSettlement(round, { dkg: { signerNodeFor: () => { throw new Error('a protocol-27 round has no claim-key share'); } }, port, curve,
      random: (n) => crypto.getRandomValues(new Uint8Array(n)), stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) },
      peersFor: () => seatKeys.map((_, j) => j).filter((j) => j !== i).map(base), fetcher, winnings, peerAskMs: 2000, peerGraceMs: 50 });
    ls.planOf = async (_rid, o = {}) => ({ ok: true, plan: o.fallback ? FB_PLAN : PLAN, base: { plan: PLAN }, contract, claimPk: Z, held: { ok: true, signerNode: null },
      locks, lockEntry: new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), e.entryId])), ackRows: ROWS });
    ls.turn = async () => ({ mine: i === 0, why: 'seat 0 combines' });
    ls.planSends = async () => ({ ok: true });
    ls.sendWinnings = async () => [];
    ls.confirmSoon = () => {};
    seats.push(ls);
  });
  return { seats, stores, seatKeys, log };
}



// kanban #3902 (2.0 devnet dn3897, RPS 25b7de93): the round's lock fallback_after came before FINAL, seat 3 filed the fallback claim, the federation took it
// (12 payouts), every seat inside it made its row ACCEPTED on the fallback's txid - and GET /lock-settlement answered "moved": null at all six: summaryOf
// rebuilt only the claim's plan (11 payouts), which never matches the fallback's kept moves. The page counts an ACCEPTED answer only with moved.payouts,
// so the winner could not collect.
test('a round settled by its fallback claim: GET /lock-settlement answers what the fallback moved, at every seat inside it', async () => {
  const { seats, stores } = world({ down: [4, 5, 6] });
  const fb = await seats[0].settleFallback(RID);
  assert.equal(fb.ok, true, fb.why);
  for (const i of [0, 1, 2, 3]) {
    const row = stores[i].lockSettlement(RID);
    // seat 0 filed it; the other three took the signature and ask the federation next (on the devnet: ACCEPTED, "found in the federation")
    assert.equal(row && row.txid, stores[0].lockSettlement(RID).txid, `seat ${i} holds the fallback's row`);
    assert.equal(stores[i].namedBatchOf(RID, 'fallback', row.txid) !== null, true, `seat ${i} keeps the fallback batch`);
    // as after a restart, or a kept fallback dropped by a peer's other ask (settlement.js "asked about ..., built again")
    seats[i].fallbackBuilt.delete(toHex(RID));
    const moved = await seats[i].summaryOf(RID);
    assert.ok(moved, `seat ${i}: ACCEPTED with moved null`);
    assert.equal(moved.txid, row.txid);
    assert.equal(moved.payouts.length, FB_PLAN.payouts.length, `seat ${i}: the fallback's payouts`);
    assert.ok(moved.payouts.some((p) => p.kind === 'sent'), 'the winner\'s payout is there to collect');
  }
});

test('a round settled by its claim still answers the claim\'s moves (the fallback\'s plan is not taken for it)', async () => {
  const { seats, stores } = world();
  const got = await seats[0].settle(RID);
  assert.equal(got.ok, true, got.why);
  assert.equal(stores[0].lockSettlement(RID).state, 'ACCEPTED');
  seats[0].built.delete(toHex(RID));
  const moved = await seats[0].summaryOf(RID);
  assert.ok(moved);
  assert.equal(moved.payouts.length, PLAN.payouts.length);
});
