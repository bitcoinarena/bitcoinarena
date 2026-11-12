// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm7-find-federation 1 (state machine audit, federation; crash-restart between a move's PLANNED and its tx shares):
// A DRAINED FEDERATION'S RESERVE MOVE THAT A SEAT HOLDS PLANNED IS REFUSED BY THAT SEAT AFTER A RESTART.
// reserve-payout.js says "A MOVE ONCE CALLED FOR STAYS KNOWN: planned, its inputs count as spent and the drained federation's unspent
// reserves read 0, so the records no longer list it - and its signing, sending and claiming must go on". It stays known in `knownMoves`,
// a Map in memory only. A seat that committed to the move's transaction holds the plan PLANNED (its inputs in reserve_payout_inputs), so
// after a restart its own moves() lists nothing (unspent 0) and knownMoves is empty: commitHere -> planStands(late) -> moveOf() is null ->
// "this seat's records call for no such move", and for kind 'tx' that refusal stands. The coordinator's own sign() asks its own
// commitHere first, so a coordinator restarted with its move PLANNED refuses its own move. The move cannot be signed by the seats that
// hold it until each of them expires its plan (12 blocks and two federation sessions), and every restart in that window starts it over.
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
const SECRET_OF = new Map([1, 2].flatMap((k) => Array.from({ length: 7 }, (_, i) => { const sk = Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? i + 1 : k)); return [toHex(schnorr.getPublicKey(sk)), sk]; })));
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
  const chain = { tip: null };
  const mk = (fed, keys, D, i, down) => {
    const me = keys[i];
    const s = { me, fed, down, inbox: [] };
    const rowsFor = (f) => [...rows.filter((r) => r.fed === f), ...w.kept.filter((k) => k.seat === s && k.fed === f).map((k) => k.row)];
    s.db = openStore(':memory:');
    s.open = () => createReservePayouts({ db: s.db, me, heightNow: () => chain.tip, curve, random: rand, network: 'testnet4', passed: () => [], sign: (d) => schnorr.sign(d, SECRET_OF.get(me)),
      reserveRows: (f) => rowsFor(f), portOf: async (f) => port(f), payRequest: async () => ({ ok: false }), invoiceFor: async () => ({ ok: false }),
      keepRow: (row) => { const o = `${toHex(row.outpoint.txid)}:${row.outpoint.outIdx}`, f = toHex(row.federationId);
        if (!w.kept.some((k) => k.seat === s && k.row.outpoint === o)) w.kept.push({ seat: s, fed: f, row: { outpoint: o, amountMsat: String(row.amountMsat), verifiedMs: 99 } }); },
      broadcast: (rec) => { for (const o of seats) if (o !== s) o.inbox.push(rec); },
      moves: () => moveTargets([X, Y].map((f) => ({ id: f, status: w.status[f], height: 500, successor: null, key: toHex((f === X ? DX : DY).groupPublicKey),
        unspentMsat: rowsFor(f).filter((r) => !s.api.spent().has(r.outpoint)).reduce((t, r) => t + BigInt(r.amountMsat), 0n) }))).moves,
      guardians: () => new Map([[X, KX, DX], [Y, KY, DY]].map(([f, ks, d]) => [f, { members: ks, key: d.groupPublicKey, needed: 5,
        signer: f === fed ? { id: i + 1, share: d.shares[i].share } : null,
        peers: f === fed ? seats.filter((o) => o !== s && o.fed === fed).map((o) => ({ commit: async (b) => (o.down ? { ok: false, why: 'down' } : o.api.commit(b)), share: async (b) => (o.down ? { ok: false, why: 'down' } : o.api.share(b)) })) : [] }])) });
    // ONE CHAIN (kanban #1159): every seat reads the height the last pass ran at, as a seat reads its tip
    s.restart = () => { s.api = s.open(); const pass = s.api.round; s.api.round = (o = {}) => { chain.tip = o.height; return pass(o); }; };
    s.restart();
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

test('a move held PLANNED is still signed by its seats after they restart (knownMoves is memory only)', async () => {
  const { w, seats, deliver, xCoord } = world();
  const xs = seats.filter((s) => s.fed === X);
  // three of X's seven seats down at the drain's height: the coordinator and three co-signers commit (4 of 5) and hold the plan PLANNED
  for (const s of xs.slice(4)) s.down = true;
  const [a] = await xCoord.api.round({ height: 500 });
  assert.equal(a.ok, false, 'four of five commit: not signed yet');
  assert.match(String(a.why), /4 of 5/);
  const holding = xs.filter((s) => s.api.stateOf(MOVE) && s.api.stateOf(MOVE).state === PAYOUT.PLANNED);
  assert.equal(holding.length, 4, 'the coordinator and three co-signers hold the move PLANNED');
  // a release rollout: X's seats restart (same database), the three down ones come back
  for (const s of xs) { s.restart(); s.down = false; }
  assert.equal(xCoord.api.stateOf(MOVE).state, PAYOUT.PLANNED, 'the plan is on disk');
  // next block, well inside the plan's 12 blocks: all seven seats answer - the move must be signed and paid
  const [b] = await xCoord.api.round({ height: 501 });
  await deliver();
  assert.deepEqual([b && b.ok, b && b.state, b && b.why], [true, PAYOUT.PAID, undefined], 'the restarted seats still sign the move they hold');
  assert.equal(w.payments.length, 1);
});

test('control: without the restart the same move is signed and paid at the next block', async () => {
  const { w, seats, deliver, xCoord } = world();
  const xs = seats.filter((s) => s.fed === X);
  for (const s of xs.slice(4)) s.down = true;
  const [a] = await xCoord.api.round({ height: 500 });
  assert.equal(a.ok, false);
  for (const s of xs) s.down = false;
  const [b] = await xCoord.api.round({ height: 501 });
  await deliver();
  assert.deepEqual([b.ok, b.state], [true, PAYOUT.PAID], b.why);
  assert.equal(w.payments.length, 1);
});

// Measured (a pass of every X seat each block, this fixture, no session gate): paid at height 513 - only once every seat holding the plan
// expired it, 12 blocks after it was planned; live the expiry also waits two federation sessions (#1354), and each restart in the window
// leaves the seats that committed holding a plan they refuse to sign.
