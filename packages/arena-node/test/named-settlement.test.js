// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PROTOCOL-27 SETTLEMENT IS SIGNED BY ITS NAMED SIGNER SET (kanban #1044 B1, rulings #1131 3, #1134 2, #1135, #1136). Seven seats of a 5-of-7
// round, each its own node key, reach each other's doors as server.js serves them. The seats ack and commit over the BODY id; each commit carries one
// nonce pair per message of the batch (the claim, the send's auth, the qualifier's refund (c)); S is the 5 lowest seats with a signed commit; the
// claim, the auth and the refund are signed under KeyAgg(S) before anything is submitted, and every seat keeps the batch.
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
const F = computePayoutTable({ roundId: RID, entries: [W1, L1, L2], minScore: 1 });
const ROWS = F.activated.map((e, i) => ({ entryId: e.entryId, pubkey: e.pubkey, amountMsat: F.table[i].amountMsat, outcome: e.outcome, score: e.score }));

/** The federation as the stake-lock tool answers for Arena locks: the body with Z, the real transaction with S and KeyAgg(S), the send, the refund (c). */
function arenaPort(seatKeys, log) {
  const keyHex = (k) => toHex(k);
  const bodyOf = ({ claims, payouts, nonce }, set = [], agg = null) => sha256(new TextEncoder().encode(JSON.stringify({
    c: claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}:${toHex(c.preimage)}`), s: set,
    p: payouts.map((p) => `${agg && keyHex(p.payoutPk) === toHex(Z) ? toHex(agg) : keyHex(p.payoutPk)}:${p.msat}`), n: toHex(nonce) })));
  return {
    fees: async () => FEES,
    settle: async () => { throw new Error('a protocol-27 round is never settled by the stock settle'); },
    arenaSettle: async ({ claims, payouts, nonce, signers = null, signature = null }) => {
      const bodyId = toHex(bodyOf({ claims, payouts, nonce }));
      if (!signers) return { bodyId, zSlots: payouts.map((p, i) => (toHex(p.payoutPk) === toHex(Z) ? i : -1)).filter((i) => i >= 0) };
      const agg = namedKey(seatKeys, 5, signers);
      const txid = toHex(bodyOf({ claims, payouts, nonce }, signers, Uint8Array.from([0x02, ...agg])));
      if (!signature) return { bodyId, txid, message: txid, aggKey: toHex(agg) };
      const accepted = verify(signature, fromHex(txid), agg);
      log.push({ txid, signers, accepted });
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
    const body = opts.body ? new Uint8Array(opts.body) : new Uint8Array();
    const ask = opts.headers && opts.headers['x-settlement-ask'] ? fromHex(opts.headers['x-settlement-ask']) : null;
    const answer = (got, bytes, headers = {}) => ({ ok: got.ok, status: got.ok ? 200 : got.status || 409, text: async () => got.why || '',
      arrayBuffer: async () => bytes, headers: { get: (h) => headers[h] || null } });
    if (u.pathname === '/settle-ack') { const got = await ls.ack(r8, { txid: u.searchParams.get('txid') }); return answer(got, got.bytes); }
    if (u.pathname === '/settle-commit') {
      const got = await ls.commit(r8, { txid: u.searchParams.get('txid'), acks: body, door: true, ask });
      return answer(got, got.wire, got.word ? { 'x-settlement-commit': toHex(got.word) } : {});
    }
    if (u.pathname === '/settle-share') {
      const got = await ls.share(r8, body, { door: true, ask, named });
      if (got.ok && spoil.includes(i)) return answer(got, Uint8Array.from([0, got.partials.length, ...got.partials.flatMap(() => [...b32(7)])]));
      return answer(got, got.wire);
    }
    if (u.pathname === '/settle-signature') { const got = await ls.take(r8, body, { named }); return answer(got, new Uint8Array()); }
    throw new Error(`no door ${u.pathname}`);
  };
  stores.forEach((round, i) => {
    const winnings = { round: { sendAttemptsOf: () => [{ attempt: 0, paymentHash: HASH, payoutMsat: PLAN.payouts.find((p) => p.sent).msat, expiration: 500n,
      gatewayPk: '03' + 'cd'.repeat(32), invoice: INVOICE }] } };
    const ls = new LockSettlement(round, { dkg: { signerNodeFor: () => { throw new Error('a protocol-27 round has no claim-key share'); } }, port, curve,
      random: (n) => crypto.getRandomValues(new Uint8Array(n)), stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) },
      peersFor: () => seatKeys.map((_, j) => j).filter((j) => j !== i).map(base), fetcher, winnings, peerAskMs: 2000, peerGraceMs: 50 });
    ls.planOf = async () => ({ ok: true, plan: PLAN, base: { plan: PLAN }, contract, claimPk: Z, held: { ok: true, signerNode: null },
      locks, lockEntry: new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), e.entryId])), ackRows: ROWS });
    ls.turn = async () => ({ mine: i === 0, why: 'seat 0 combines' });
    ls.planSends = async () => ({ ok: true });
    ls.sendWinnings = async () => [];
    ls.confirmSoon = () => {};
    seats.push(ls);
  });
  return { seats, stores, seatKeys, log };
}

test('the plan this test settles pays the winner by a send refunding to Z, so the batch signs three messages', () => {
  assert.ok(PLAN.ok, PLAN.why);
  const slots = namedSlots(PLAN.payouts);
  assert.deepEqual(slots.map((s) => s.kind), ['claim', 'auth', 'refund']);
  assert.equal(toHex(PLAN.payouts.find((p) => p.sent).payoutPk), toHex(Z));
  // a donation's send has an auth and no refund (c): a recipient has no key (#1134 2); a held share neither
  const don = namedSlots([{ sent: { paymentHash: HASH }, donation: { id: b32(1) }, pubkey: b32(1), msat: 5n }, { kind: 'held', donation: {}, payoutPk: Z, msat: 3n }]);
  assert.deepEqual(don.map((s) => s.kind), ['claim', 'auth']);
});

test('a 5-of-7 protocol-27 round settles under KeyAgg of the 5 lowest seats that committed: seat 1 silent, S is 0,2,3,4,5', async () => {
  const { seats, stores, seatKeys, log } = world({ down: [1] });
  const got = await seats[0].settle(RID);
  assert.equal(got.ok, true, got.why);
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].signers, [0, 2, 3, 4, 5]);
  assert.equal(log[0].accepted, true);
  const agg = namedKey(seatKeys, 5, [0, 2, 3, 4, 5]);
  // every seat reached keeps the same batch: the claim over the real txid, the auth over the invoice, the refund (c) over its txid
  for (const i of [0, 2, 3, 4, 5, 6]) {
    const b = stores[i].namedBatch(RID, '');
    assert.ok(b, `seat ${i} keeps the batch`);
    assert.deepEqual(b.signers, [0, 2, 3, 4, 5]);
    assert.equal(b.txid, log[0].txid);
    assert.deepEqual(b.slots.map((s) => s.kind), ['claim', 'auth', 'refund']);
    b.signatures.forEach((sig, k) => assert.ok(verify(sig, fromHex(b.slots[k].message), agg), `seat ${i} signature ${k}`));
    assert.equal(b.slots[1].message, toHex(sha256(new TextEncoder().encode(INVOICE))));
    assert.equal(b.slots[2].qualifierPk, toHex(Uint8Array.from([0x02, ...W1.pubkey])));
  }
  assert.equal(stores[1].namedBatch(RID, ''), null);
  // the seats' rows name the REAL txid; the acks they kept name the body
  assert.equal(stores[0].lockSettlement(RID).txid, log[0].txid);
  assert.equal(stores[0].lockSettlement(RID).state, 'ACCEPTED');
  assert.equal(stores[3].lockSettlement(RID).txid, log[0].txid);
  const body = (await seats[0].message(RID)).bodyId;
  assert.notEqual(body, log[0].txid);
});

test('a member whose partials do not verify is left out, and the next session signs with new nonces and the next set', async () => {
  const { seats, seatKeys, log } = world({ spoil: [3] });
  const got = await seats[0].settle(RID);
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(log.map((x) => x.signers), [[0, 1, 2, 4, 5]]);
  assert.ok(log[0].accepted);
  assert.ok(verify(got.signature, fromHex(log[0].txid), namedKey(seatKeys, 5, [0, 1, 2, 4, 5])));
});

test('a member signs one list per nonce set, and only a list whose every commit is signed over this body', async () => {
  const { seats } = world({ down: [1, 2, 3, 4, 5, 6] });
  // seat 0 alone: it commits, but no signer set forms; nothing is submitted
  const got = await seats[0].settle(RID);
  assert.equal(got.ok, false);
  assert.match(got.why, /1 of the 5 signer nodes/);
  const { seats: s2 } = world();
  const m = await s2[2].message(RID);
  const acks = [];
  for (const i of [0, 1, 2, 3, 4]) acks.push((await s2[i].ack(RID, { txid: m.txid })).bytes);
  const joined = new Uint8Array(acks.reduce((t, a) => t + a.length, 0)); { let at = 0; for (const a of acks) { joined.set(a, at); at += a.length; } }
  const commits = [];
  for (const i of [0, 1, 2, 3, 4]) commits.push(await s2[i].commit(RID, { txid: m.txid, acks: joined }));
  const list = commits.map((c) => ({ seat: c.seat, word: c.word, pubnonces: c.pubnonces }));
  const forged = list.map((x, i) => (i === 1 ? { ...x, pubnonces: [...commits[2].pubnonces] } : x));
  const refusedForged = await s2[2].share(RID, encodeNamedList(forged), {});
  assert.equal(refusedForged.ok, false);
  assert.match(refusedForged.why, /seat 1's signed commit/);
  const first = await s2[2].share(RID, encodeNamedList(list), {});
  assert.equal(first.ok, true, first.why);
  assert.equal(first.partials.length, 3);
  assert.equal(decodeNamedList(encodeNamedList(list)).length, 5);
  const other = await s2[2].share(RID, encodeNamedList([...list.slice(0, 4), { ...list[4] }].map((x) => x)), {});
  assert.equal(other.ok, true, 'the same list again answers the same partials');
  assert.deepEqual(other.partials.map(toHex), first.partials.map(toHex));
});

test('a member checks the list\'s form and its own nonce, not that the list is the lowest (ruling #1137)', async () => {
  const { seats, stores } = world();
  const m = await seats[2].message(RID);
  const acks = [];
  for (const i of [0, 1, 2, 3, 4]) acks.push((await seats[i].ack(RID, { txid: m.txid })).bytes);
  const joined = new Uint8Array(acks.reduce((t, a) => t + a.length, 0)); { let at = 0; for (const a of acks) { joined.set(a, at); at += a.length; } }
  const c = new Map();
  for (const i of [0, 1, 2, 3, 4, 5, 6]) c.set(i, await seats[i].commit(RID, { txid: m.txid, acks: joined }));
  const of = (set) => set.map((i) => ({ seat: i, word: c.get(i).word, pubnonces: c.get(i).pubnonces }));
  // a list without this seat is refused
  const notMe = await seats[2].share(RID, encodeNamedList(of([0, 1, 3, 4, 5])), {});
  assert.equal(notMe.ok, false);
  assert.match(notMe.why, /not in that signer list/);
  // a member whose validly signed commit holds another number of nonce pairs: refused, and this seat's nonces are not spent by it
  const short = [c.get(6).pubnonces[0]];
  const word = signSettlementCommit({ roundId: RID, settlementBodyId: fromHex(m.txid), nonces: short }, stores[6].pubkey, (d) => schnorr.sign(d, stores[6].identity.secret));
  const odd = [...of([0, 2, 3, 4]), { seat: 6, word, pubnonces: short }];
  const refusedOdd = await seats[2].share(RID, encodeNamedList(odd), {});
  assert.equal(refusedOdd.ok, false);
  assert.match(refusedOdd.why, /seat 6 committed to 1 nonce pairs/);
  // a list that skips seat 1, whose commit this seat holds, is signed: the asker picks S
  const skip = await seats[2].share(RID, encodeNamedList(of([0, 2, 3, 4, 5])), {});
  assert.equal(skip.ok, true, skip.why);
  assert.equal(skip.partials.length, 3);
  // a second list under the same commit is refused: one list per nonce set
  const second = await seats[2].share(RID, encodeNamedList(of([0, 1, 2, 3, 4])), {});
  assert.equal(second.ok, false);
  assert.match(second.why, /over another list/);
  // a new commit takes new nonces, and the old list with the spent nonces no longer carries this seat's own
  const fresh = await seats[2].commit(RID, { txid: m.txid, acks: joined });
  assert.notEqual(toHex(fresh.pubnonces[0]), toHex(c.get(2).pubnonces[0]));
  const stale = await seats[2].share(RID, encodeNamedList(of([0, 2, 3, 4, 5])), {});
  assert.equal(stale.ok, false);
  assert.match(stale.why, /own nonces/);
});

test('the commit: below protocol 27 its bytes are unchanged; from 27 it hashes every nonce pair of the batch, in order', () => {
  const R = (n) => Uint8Array.from([0x02, ...b32(n)]);
  const old = settlementCommitBody({ roundId: RID, settlementTxid: b32(1), hiding: R(1), binding: R(2) });
  const nonces = new Uint8Array(66); nonces.set(R(1), 0); nonces.set(R(2), 33);
  assert.equal(toHex(old.subarray(67)), toHex(taggedHash(TAG.settlementCommit, nonces)));
  assert.equal(old.length, 99);
  const pn = (a, b) => Uint8Array.from([...R(a), ...R(b)]);
  const named = settlementCommitBody({ roundId: RID, settlementBodyId: b32(1), nonces: [pn(1, 2), pn(3, 4), pn(5, 6)] });
  assert.equal(named.length, 99);
  const all = Uint8Array.from([...pn(1, 2), ...pn(3, 4), ...pn(5, 6)]);
  assert.equal(toHex(named.subarray(67)), toHex(taggedHash(TAG.settlementCommit, all)));
  const swapped = settlementCommitBody({ roundId: RID, settlementBodyId: b32(1), nonces: [pn(1, 2), pn(3, 4), pn(5, 7)] });
  assert.notEqual(toHex(swapped), toHex(named));
});
