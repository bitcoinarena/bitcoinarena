// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE 5-OF-7 LNURL PAYOUT'S WORLD (reserve-payout.test.js, kanban #1156/#1159): seven guardian seats in one process, one fake federation
// (contracts, the settle and send the stake-lock tool answers), one fake gateway and one fake LNURL endpoint. `create` is the module under
// test (a measure script hands in an older one); `more(i)` adds options to seat i.
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createReservePayouts } from '../src/reserve-payout.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { bech32Encode, convertBits } from '../../arena-protocol/src/bech32.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { randomBytes } from 'node:crypto';

export const curve = { ...feldmanGroup, tweakPoint };
export const rand = (n) => new Uint8Array(randomBytes(n));
export const FED = 'b1'.repeat(32);
export const G = evenGroupSecret(0x1234567n, curve);
export const DEAL = trustedDealerSplit({ secret: G.secret, max: 7, min: 5, coefficients: [11n, 22n, 33n, 44n], curve });
export const KEY = DEAL.groupPublicKey;                                     // the reserve key, 33 bytes, even
export const NODE_KEYS = Array.from({ length: 7 }, (_, i) => toHex(schnorr.getPublicKey(Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? i + 1 : 9))))).sort();
// each seat's node key signs the records it hands on (kanban #1156)
export const SECRET_OF = new Map(Array.from({ length: 7 }, (_, i) => { const sk = Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? i + 1 : 9)); return [toHex(schnorr.getPublicKey(sk)), sk]; }));
export const FEES = { ppm: 100n, baseMsat: 1000n };
export const GW = { url: 'https://gw.example/', lightningPublicKey: '02' + 'ab'.repeat(32), modulePublicKey: '03' + 'cd'.repeat(32), live: true,
  sendFeeDefault: { baseMsat: 2000, ppm: 1000 }, expirationDeltaDefault: 144, expirationDeltaMinimum: 10 };
export const LNURL = 'dev@bitcoin-arena.io', METADATA = '[["text/plain","Bitcoin Arena development"]]';
export const PROPOSAL = 'aa'.repeat(32);

// A BOLT11 INVOICE as the reader takes it (the node's signature is not read: zeros)
export function invoiceOf(msat, paymentHash, metadata) {
  const words = [];
  let ts = 1792200000; const t = []; for (let i = 0; i < 7; i++) { t.unshift(ts % 32); ts = Math.floor(ts / 32); } words.push(...t);
  const field = (type, bytes) => { const w = convertBits([...bytes], 8, 5, true); words.push(type, Math.floor(w.length / 32), w.length % 32, ...w); };
  field(1, paymentHash); field(23, sha256(new TextEncoder().encode(metadata)));
  words.push(...new Array(104).fill(0));
  return bech32Encode(`lntb${msat * 10n}p`, words);
}

export function world({ rows = [60000000n, 40000000n, 50000000n], amountSats = 70000n, gatewayFails = false, down = [], create = createReservePayouts, more = () => ({}) } = {}) {
  const fed = { height: 1000, contracts: new Map(), submits: [], payments: [], preimages: new Map(), invoiceAsks: 0, gatewayFails };
  const reserveRows = rows.map((m, i) => ({ outpoint: `${String(i + 1).padStart(2, '0').repeat(32)}:0`, amountMsat: String(m), verifiedMs: i + 1 }));
  for (const r of reserveRows) fed.contracts.set(r.outpoint, { key: toHex(KEY), msat: BigInt(r.amountMsat), expiration: 0, spent: false });
  const msgOf = (o) => sha256(new TextEncoder().encode(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v))));
  const port = {
    fees: async () => FEES,
    gateways: async () => ({ gateways: [GW], height: fed.height }),
    status: async (at) => { const c = fed.contracts.get(`${toHex(at.txid)}:${at.outIdx}`); return { blockCount: fed.height, stored: c && !c.spent ? { contractId: 'c', blocksLeft: c.expiration - fed.height } : null }; },
    settle: async ({ claimPk, refunds, payouts, nonce, signature = null }) => {
      if (!(nonce instanceof Uint8Array) || nonce.length !== 8) throw new Error('--nonce is 8 bytes');   // as the stake-lock tool
      const message = msgOf({ k: claimPk, r: refunds.map((x) => [toHex(x.outpoint.txid), String(x.outpoint.outIdx), x.amountMsat]), p: payouts, n: nonce });
      if (!signature) return { message: toHex(message) };
      if (!schnorr.verify(signature, message, claimPk.subarray(1))) return { accepted: false, error: 'the signature does not verify' };
      for (const x of refunds) { const c = fed.contracts.get(`${toHex(x.outpoint.txid)}:${x.outpoint.outIdx}`);
        if (!c || c.spent || c.key !== toHex(claimPk) || c.msat !== x.amountMsat || c.expiration > fed.height) return { accepted: false, error: 'an input is not spendable' }; }
      for (const x of refunds) fed.contracts.get(`${toHex(x.outpoint.txid)}:${x.outpoint.outIdx}`).spent = true;
      const txid = toHex(message);
      payouts.forEach((p, i) => fed.contracts.set(`${txid}:${i}`, { key: toHex(p.payoutPk), msat: p.msat, expiration: p.sent ? Number(p.sent.expiration) : 0, spent: false, sent: p.sent || null }));
      fed.submits.push({ txid, refunds: refunds.length, payouts: payouts.map((p) => p.msat) });
      return { txid, accepted: true, message: txid };
    },
    send: async ({ outpoint, paymentHash, refundPk, auth = null }) => {
      const at = `${toHex(outpoint.txid)}:${outpoint.outIdx}`;
      const message = msgOf({ auth: at, h: paymentHash });
      if (!auth) return { message };
      if (!schnorr.verify(auth, message, refundPk.subarray(1))) return { sent: false, why: 'the auth does not verify' };
      if (fed.gatewayFails) return { sent: false, why: 'the gateway is down' };
      const c = fed.contracts.get(at);
      if (fed.payments.some((p) => p.hash === paymentHash)) return { sent: true, preimage: fed.preimages.get(paymentHash) };   // paid already: the same preimage
      if (!c || c.spent) return { sent: false, why: 'no contract' };
      c.spent = true; fed.payments.push({ hash: paymentHash, msat: c.msat });
      return { sent: true, preimage: fed.preimages.get(paymentHash) };
    },
  };
  const lnurl = {
    payRequest: async (address) => (address === LNURL ? { ok: true, metadata: METADATA, callback: 'https://x/cb' } : { ok: false, why: 'no such address' }),
    invoiceFor: async (address, msat) => { fed.invoiceAsks++;
      if (address !== LNURL) return { ok: false, why: 'no such address' };
      const pre = rand(32), hash = sha256(pre); fed.preimages.set(toHex(hash), pre);
      return { ok: true, invoice: invoiceOf(msat, hash, METADATA), paymentHash: toHex(hash), metadata: METADATA }; },
  };
  const state = { passed: [{ id: PROPOSAL, lnurl: LNURL, amountSats, decidableAt: 500 }], kept: [] };
  const seats = [];
  for (let i = 0; i < 7; i++) {
    const me = NODE_KEYS[i];
    const s = { me, down: down.includes(i), inbox: [] };
    s.api = create({ db: openStore(':memory:'), me, curve, random: rand, network: 'testnet4', sign: (d) => schnorr.sign(d, SECRET_OF.get(me)),
      passed: () => state.passed, reserveRows: () => [...reserveRows, ...state.kept.filter((k) => k.seat === i).map((k) => k.row)],
      portOf: async () => port, payRequest: lnurl.payRequest, invoiceFor: lnurl.invoiceFor,
      // as putDonationOutputs: one row per outpoint (INSERT OR REPLACE)
      keepRow: (row) => { const o = `${toHex(row.outpoint.txid)}:${row.outpoint.outIdx}`; if (!state.kept.some((k) => k.seat === i && k.row.outpoint === o)) state.kept.push({ seat: i, row: { outpoint: o, amountMsat: String(row.amountMsat), verifiedMs: 99 } }); },
      broadcast: (rec) => { for (const o of seats) if (o !== s) o.inbox.push(rec); },
      guardians: () => new Map([[FED, { members: NODE_KEYS, key: KEY, needed: 5, signer: { id: i + 1, share: DEAL.shares[i].share },
        peers: seats.filter((o) => o !== s).map((o) => ({ commit: async (b) => (o.down ? { ok: false, why: 'down' } : o.api.commit(b)), share: async (b) => (o.down ? { ok: false, why: 'down' } : o.api.share(b)) })) }]]), ...more(i) });
    seats.push(s);
  }
  const deliver = async () => { for (const s of seats) { while (s.inbox.length) await s.api.learn(s.inbox.shift()); } };
  const held = (i) => { const spent = seats[i].api.spent(); return [...reserveRows, ...state.kept.filter((k) => k.seat === i).map((k) => k.row)].filter((r) => !spent.has(r.outpoint))
    .reduce((t, r) => t + BigInt(r.amountMsat), 0n); };
  return { fed, seats, state, deliver, held, reserveRows, port, lnurl };
}

