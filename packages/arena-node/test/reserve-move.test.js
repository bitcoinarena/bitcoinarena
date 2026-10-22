// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RESERVES OF A DRAINED FEDERATION MOVED TO A HEALTHY ONE (§27A.9.2decision A): two fake federations X and Y, seven
// guardian seats each, in one process - X's 5-of-7 pays an invoice whose incoming contract only Y's 5-of-7 reserve key can claim, and Y's
// 5-of-7 claims it into a reserve output. the owner's tests: a draining federation moves exactly once, an open or halted one does not, the
// successor is chosen first, no healthy federation means no move, 4 signature shares fail and 5 sign, a second move plan is refused, a
// gateway failure refunds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createReservePayouts, PAYOUT } from '../src/reserve-payout.js';
import { moveTargets, moveIdOf } from '../src/reserve-move.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { largestPayoutMsat, lnv2FeeMsat } from '../../arena-protocol/src/lock-settlement.js';
import { bech32Encode, convertBits } from '../../arena-protocol/src/bech32.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { randomBytes } from 'node:crypto';

const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));
const X = 'a1'.repeat(32), Y = 'b2'.repeat(32), Z = 'c3'.repeat(32);
const dealt = (secret) => { const G = evenGroupSecret(secret, curve); return trustedDealerSplit({ secret: G.secret, max: 7, min: 5, coefficients: [3n, 5n, 7n, 11n], curve }); };
const DX = dealt(0x7777n), DY = dealt(0x8888n);
const nodeKeys = (k) => Array.from({ length: 7 }, (_, i) => toHex(schnorr.getPublicKey(Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? i + 1 : k))))).sort();
const KX = nodeKeys(1), KY = nodeKeys(2);
const FEES = { ppm: 100n, baseMsat: 1000n };
const GW = { url: 'https://gw.example/', lightningPublicKey: '02' + 'ab'.repeat(32), modulePublicKey: '03' + 'cd'.repeat(32), live: true,
  sendFeeDefault: { baseMsat: 2000, ppm: 1000 }, expirationDeltaDefault: 144, expirationDeltaMinimum: 10 };
const RECEIVE_FEE = 1000n;

function invoiceOf(msat, paymentHash) {
  const words = []; let ts = 1792200000; const t = []; for (let i = 0; i < 7; i++) { t.unshift(ts % 32); ts = Math.floor(ts / 32); } words.push(...t);
  const field = (type, bytes) => { const w = convertBits([...bytes], 8, 5, true); words.push(type, Math.floor(w.length / 32), w.length % 32, ...w); };
  field(1, paymentHash); field(23, sha256(new TextEncoder().encode('Bitcoin Arena protocol reserves')));
  words.push(...new Array(104).fill(0));
  return bech32Encode(`lntb${msat * 10n}p`, words);
}
const json = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v));

function world({ statusX = 'DRAINING', gatewayFails = false, downY = [], noGatewayX = false, refuseFirstCheck = false } = {}) {
  const w = { height: 1000, gatewayFails, refuseFirstCheck, contracts: new Map(), incoming: new Map(), submits: [], payments: [], claims: [], invoices: 0, status: { [X]: statusX, [Y]: 'OPEN' }, kept: [] };
  const rows = [60000000n, 40000000n, 50000000n].map((m, i) => ({ outpoint: `${String(i + 1).padStart(2, '0').repeat(32)}:0`, amountMsat: String(m), verifiedMs: i + 1, fed: X }));
  for (const r of rows) w.contracts.set(r.outpoint, { fed: X, key: toHex(DX.groupPublicKey), msat: BigInt(r.amountMsat), expiration: 0, spent: false });
  const port = (fed) => ({
    fees: async () => FEES,
    gateways: async () => ({ gateways: noGatewayX && fed === X ? [] : [GW], height: w.height }),
    status: async (at) => { const c = w.contracts.get(`${toHex(at.txid)}:${at.outIdx}`); return { blockCount: w.height, stored: c && !c.spent ? { contractId: 'c', blocksLeft: c.expiration - w.height } : null }; },
    settle: async ({ claimPk, refunds, payouts, nonce, signature = null }) => {
      if (!(nonce instanceof Uint8Array) || nonce.length !== 8) throw new Error('--nonce is 8 bytes');   // as the stake-lock tool
      const message = sha256(new TextEncoder().encode(json({ fed, k: claimPk, r: refunds.map((x) => [toHex(x.outpoint.txid), String(x.outpoint.outIdx), x.amountMsat]), p: payouts, n: nonce })));
      if (!signature) return { message: toHex(message) };
      if (!schnorr.verify(signature, message, claimPk.subarray(1))) return { accepted: false, error: 'the signature does not verify' };
      for (const x of refunds) { const c = w.contracts.get(`${toHex(x.outpoint.txid)}:${x.outpoint.outIdx}`);
        if (!c || c.fed !== fed || c.spent || c.key !== toHex(claimPk) || c.msat !== x.amountMsat || c.expiration > w.height) return { accepted: false, error: 'an input is not spendable' }; }
      for (const x of refunds) w.contracts.get(`${toHex(x.outpoint.txid)}:${x.outpoint.outIdx}`).spent = true;
      const txid = toHex(message);
      payouts.forEach((p, i) => w.contracts.set(`${txid}:${i}`, { fed, key: toHex(p.payoutPk), msat: p.msat, expiration: p.sent ? Number(p.sent.expiration) : 0, spent: false, sent: p.sent || null }));
      w.submits.push({ fed, txid, payouts: payouts.map((p) => p.msat) });
      return { txid, accepted: true, message: txid };
    },
    send: async ({ outpoint, paymentHash, refundPk, auth = null }) => {
      const at = `${toHex(outpoint.txid)}:${outpoint.outIdx}`;
      const message = sha256(new TextEncoder().encode(json({ auth: at, h: paymentHash })));
      if (!auth) return { message };
      if (!schnorr.verify(auth, message, refundPk.subarray(1))) return { sent: false, why: 'the auth does not verify' };
      if (w.gatewayFails) return { sent: false, why: 'the gateway is down' };
      const inc = w.incoming.get(paymentHash);
      if (w.payments.some((p) => p.hash === paymentHash)) return { sent: true, preimage: inc.preimage };
      const c = w.contracts.get(at); if (!c || c.spent || !inc) return { sent: false, why: 'no contract or no such invoice' };
      c.spent = true; inc.funded = true; w.payments.push({ hash: paymentHash, msat: c.msat });
      return { sent: true, preimage: inc.preimage };
    },
    receiveToKey: async ({ claimPk, amountMsat, seed }) => {
      w.invoices++;
      const preimage = sha256(seed), hash = sha256(preimage);
      if (w.incoming.has(toHex(hash))) throw new Error('the gateway made no invoice: PaymentHash is already registered');   // as gatewayd
      const contract = { fed, claimPk: toHex(claimPk), hash: toHex(hash), amountMsat: String(amountMsat - RECEIVE_FEE) };
      w.incoming.set(toHex(hash), { ...contract, preimage, funded: false, claimed: false });
      return { invoice: invoiceOf(amountMsat, hash), paymentHash: toHex(hash), amountMsat, contractAmountMsat: amountMsat - RECEIVE_FEE, contractId: toHex(hash),
        contractHex: toHex(new TextEncoder().encode(JSON.stringify(contract))), claimPk: toHex(claimPk) };
    },
    claimIncoming: async ({ contractHex, seed, payoutPk, nonce, signature = null }) => {
      if (!(nonce instanceof Uint8Array) || nonce.length !== 8) throw new Error('--nonce is 8 bytes');   // as the stake-lock tool
      const contract = JSON.parse(new TextDecoder().decode(fromHex(contractHex)));
      if (toHex(sha256(sha256(seed))) !== contract.hash) throw new Error('that seed is not the one this contract was made with');
      const commitment = { claim_pk: contract.claimPk, payment_hash: contract.hash, amount_msat: contract.amountMsat };
      const inc = w.incoming.get(contract.hash);
      if (w.refuseFirstCheck && !signature) { w.refuseFirstCheck = false; throw new Error('the destination did not answer'); }   // a first plan falls through
      if (!inc || !inc.funded) return { funded: false, commitment };
      const amount = BigInt(contract.amountMsat);
      const msat = largestPayoutMsat(FEES, amount - lnv2FeeMsat(FEES, amount));
      const message = sha256(new TextEncoder().encode(json({ claim: contract.hash, payoutPk, nonce, msat })));
      const base = { funded: true, commitment, message: toHex(message), txid: toHex(message), payout: { msat: String(msat) } };
      if (!signature) return base;
      if (!schnorr.verify(signature, message, fromHex(contract.claimPk).subarray(1))) return { ...base, accepted: false, error: 'the claim signature does not verify' };
      if (inc.claimed) return { ...base, accepted: false, error: 'claimed already' };
      inc.claimed = true; w.contracts.set(`${toHex(message)}:0`, { fed, key: toHex(payoutPk), msat, expiration: 0, spent: false });
      w.claims.push({ fed, msat });
      return { ...base, accepted: true };
    },
  });
  const seats = [];
  const mk = (fed, keys, D, i, down) => {
    const me = keys[i];
    const s = { me, fed, down, inbox: [] };
    const rowsFor = (f) => [...rows.filter((r) => r.fed === f), ...w.kept.filter((k) => k.seat === s && k.fed === f).map((k) => k.row)];
    s.api = createReservePayouts({ db: openStore(':memory:'), me, curve, random: rand, network: 'testnet4', passed: () => [],
      reserveRows: (f) => rowsFor(f), portOf: async (f) => port(f), payRequest: async () => ({ ok: false }), invoiceFor: async () => ({ ok: false }),
      keepRow: (row) => { const o = `${toHex(row.outpoint.txid)}:${row.outpoint.outIdx}`, f = toHex(row.federationId);
        if (!w.kept.some((k) => k.seat === s && k.row.outpoint === o)) w.kept.push({ seat: s, fed: f, row: { outpoint: o, amountMsat: String(row.amountMsat), verifiedMs: 99 } }); },
      broadcast: (rec) => { for (const o of seats) if (o !== s) o.inbox.push(rec); },
      moves: () => moveTargets([X, Y].map((f) => ({ id: f, status: w.status[f], height: 500, successor: null, key: toHex((f === X ? DX : DY).groupPublicKey),
        unspentMsat: rowsFor(f).filter((r) => !s.api.spent().has(r.outpoint)).reduce((t, r) => t + BigInt(r.amountMsat), 0n) }))).moves,
      guardians: () => new Map([[X, KX, DX], [Y, KY, DY]].map(([f, ks, d]) => [f, { members: ks, key: d.groupPublicKey, needed: 5,
        signer: f === fed ? { id: i + 1, share: d.shares[i].share } : null,
        peers: f === fed ? seats.filter((o) => o !== s && o.fed === fed).map((o) => ({ commit: async (b) => (o.down ? { ok: false, why: 'down' } : o.api.commit(b)), share: async (b) => (o.down ? { ok: false, why: 'down' } : o.api.share(b)) })) : [] }])) });
    return s;
  };
  for (let i = 0; i < 7; i++) seats.push(mk(X, KX, DX, i, false));
  for (let i = 0; i < 7; i++) seats.push(mk(Y, KY, DY, i, downY.includes(i)));
  const deliver = async () => { for (let k = 0; k < 3; k++) for (const s of seats) { while (s.inbox.length) await s.api.learn(s.inbox.shift()); } };
  const held = (s, f) => { const spent = s.api.spent(); return [...rows.filter((r) => r.fed === f), ...w.kept.filter((k) => k.seat === s && k.fed === f).map((k) => k.row)]
    .filter((r) => !spent.has(r.outpoint)).reduce((t, r) => t + BigInt(r.amountMsat), 0n); };
  const xCoord = seats.find((s) => s.fed === X && s.me === KX[0]), yCoord = seats.find((s) => s.fed === Y && s.me === KY[0]);
  return { w, seats, deliver, held, xCoord, yCoord };
}
const MOVE = moveIdOf(X, Y);

test('the rule: a draining or critical federation with reserves moves to its open successor first, else the lowest-id open one; open, halted, closed or no healthy one - no move', () => {
  const f = (id, status, more = {}) => ({ id, status, height: 600, successor: null, key: id.slice(0, 2).repeat(33).slice(0, 66), unspentMsat: 5000n, ...more });
  assert.deepEqual(moveTargets([f(X, 'DRAINING', { successor: Z }), f(Y, 'OPEN'), f(Z, 'OPEN')]).moves.map((m) => [m.from, m.to]), [[X, Z]], 'the successor first');
  assert.deepEqual(moveTargets([f(X, 'CRITICAL', { successor: Z }), f(Y, 'OPEN'), f(Z, 'DRAINING', { unspentMsat: 0n })]).moves.map((m) => m.to), [Y], 'a successor not open: the lowest-id open one');
  assert.deepEqual(moveTargets([f(X, 'OPEN'), f(Y, 'OPEN')]).moves, []);
  const halted = moveTargets([f(X, 'HALTED'), f(Y, 'OPEN')]);
  assert.deepEqual([halted.moves, halted.waiting[0].why], [[], 'halted: its notes are frozen until it recovers']);
  assert.deepEqual(moveTargets([f(X, 'CLOSED'), f(Y, 'OPEN')]).moves, []);
  const none = moveTargets([f(X, 'DRAINING'), f(Y, 'DRAINING')]);
  assert.match(none.waiting.map((x) => x.why).join(' '), /no healthy federation/);
  assert.deepEqual(moveTargets([f(X, 'DRAINING', { unspentMsat: 0n }), f(Y, 'OPEN')]).moves, [], 'nothing held: nothing to move');
  assert.equal(moveTargets([f(X, 'DRAINING'), f(Y, 'OPEN')]).moves[0].decidableAt, 600);
});

test('a draining federation moves exactly once: X\'s 5-of-7 pays the invoice only Y\'s reserve key can claim, Y\'s 5-of-7 claims it; X at 0, Y up, on all 14 seats', async () => {
  const { w, seats, deliver, held, xCoord, yCoord } = world();
  const before = held(seats[0], X);
  assert.equal(before, 150000000n);
  assert.deepEqual(await xCoord.api.round({ height: 499 }), [], 'not before the drain\'s height');
  const [a] = await xCoord.api.round({ height: 500 });
  assert.deepEqual([a.ok, a.state], [true, PAYOUT.PAID], a.why);
  await deliver();
  assert.deepEqual(await yCoord.api.round({ height: 501 }), [], 'Y\'s coordinator waits 2 blocks after the drain');
  const [b] = await yCoord.api.round({ height: 502 });
  assert.deepEqual([b.ok, b.state], [true, PAYOUT.CLAIMED], b.why);
  await deliver();
  assert.deepEqual([w.invoices, w.submits.length, w.payments.length, w.claims.length], [1, 1, 1, 1], 'one invoice, one payout transaction, one payment, one claim');
  const recs = seats.map((s) => s.api.stateOf(MOVE));
  assert.ok(recs.every((r) => r && r.state === PAYOUT.CLAIMED && r.planId === recs[0].planId), recs.map((r) => r && r.state).join(','));
  const moved = BigInt(recs[0].claimMsat);
  for (const s of seats) {
    assert.equal(held(s, X), 0n, `${s.fed.slice(0, 2)} seat: X at 0`);
    assert.equal(held(s, Y), moved, `${s.fed.slice(0, 2)} seat: Y up by the claim`);
  }
  assert.ok(moved > before - 600000n, `only fees were lost: ${before - moved} msat`);
  for (const s of seats) await s.api.round({ height: 900 });
  assert.deepEqual([w.invoices, w.submits.length, w.payments.length, w.claims.length], [1, 1, 1, 1], 'run again on all 14: nothing new');
});

test('a move whose first plan fell through asks for another invoice (kanban #326: one seed per move made one payment hash, refused by the gateway ever after)', async () => {
  const { w, seats, deliver, xCoord, yCoord } = world({ refuseFirstCheck: true });
  const [a] = await xCoord.api.round({ height: 500 });
  assert.equal(a.ok, false, 'the first plan falls through');
  const [b] = await xCoord.api.round({ height: 500 });
  assert.deepEqual([b.ok, b.state], [true, PAYOUT.PAID], b.why);
  await deliver();
  const [c] = await yCoord.api.round({ height: 502 });
  assert.deepEqual([c.ok, c.state], [true, PAYOUT.CLAIMED], c.why);
  await deliver();
  assert.deepEqual([w.invoices, w.payments.length, w.claims.length], [2, 1, 1], 'two invoices (two payment hashes), one payment, one claim');
  assert.ok(seats.every((s) => s.api.stateOf(MOVE) && s.api.stateOf(MOVE).state === PAYOUT.CLAIMED));
});

test('an open or a halted federation does not move', async () => {
  for (const status of ['OPEN', 'HALTED']) {
    const { w, seats } = world({ statusX: status });
    for (const s of seats) assert.deepEqual(await s.api.round({ height: 900 }), [], status);
    assert.deepEqual([w.invoices, w.submits.length, w.payments.length], [0, 0, 0]);
  }
});

test('a move that cannot start says why (kanban #326: it was skipped without a word): the drained federation has no live gateway', async () => {
  const { w, xCoord } = world({ noGatewayX: true });
  assert.deepEqual(await xCoord.api.round({ height: 1000 }), [{ id: MOVE, ok: false, why: 'the drained federation has no live gateway to pay through' }]);
  assert.deepEqual([w.invoices, w.submits.length, w.payments.length], [0, 0, 0], 'nothing invoiced, nothing paid');
});

test('a second move plan is refused by every signer; 4 of Y\'s shares cannot claim, 5 do', async () => {
  const { w, seats, deliver, xCoord, yCoord } = world({ downY: [1, 2, 3] });
  await xCoord.api.round({ height: 500 });
  await deliver();
  const plan = xCoord.api.stateOf(MOVE).plan;
  for (const bad of [{ ...plan, toKey: '02' + '99'.repeat(32) }, { ...plan, amountSats: String(BigInt(plan.amountSats) - 1n) }, { ...plan, refunds: plan.refunds.slice(1) }, { ...plan, to: Z }])
    for (const s of seats.filter((x) => x.fed === X)) assert.equal((await s.api.commit({ plan: bad, kind: 'tx' })).ok, false, s.me.slice(0, 8));
  const [c] = await yCoord.api.round({ height: 502 });
  assert.equal(c.ok, false); assert.match(c.why, /4 of 5 guardian seats committed to the claim/);
  assert.equal(w.claims.length, 0);
  for (const s of seats) s.down = false;
  const [d] = await yCoord.api.round({ height: 503 });
  assert.equal(d.state, PAYOUT.CLAIMED, d.why);
  assert.equal(w.claims.length, 1);
});

test('a gateway failure: the move\'s contract expires and is refunded to X\'s reserve key - REFUNDED, nothing moved, nothing claimed', async () => {
  const { w, seats, deliver, held, xCoord, yCoord } = world({ gatewayFails: true });
  const [a] = await xCoord.api.round({ height: 500 });
  assert.equal(a.ok, false); assert.match(a.why, /gateway did not pay yet/);
  w.height = 1000 + 144 + 1;
  const [b] = await xCoord.api.round({ height: 700 });
  assert.equal(b.state, PAYOUT.REFUNDED, b.why);
  await deliver();
  assert.deepEqual(await yCoord.api.round({ height: 900 }), [], 'nothing to claim');
  assert.deepEqual([w.payments.length, w.claims.length], [0, 0]);
  assert.ok(seats.every((s) => s.api.stateOf(MOVE).state === PAYOUT.REFUNDED));
  assert.ok(held(seats[0], X) > 150000000n - 100000n, 'the reserves are back under X\'s key, less fees');
  assert.equal(held(seats[7], Y), 0n);
});
