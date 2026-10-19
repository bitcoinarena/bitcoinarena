// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// MUSIG2 (BIP-327), FOR THE BOND'S KEY PATH (spec 5A.3B: "key path MuSig2(node_key,
// arbitration_aggregate_key) -> cooperative release or cooperative slash, one signature, indistinguishable on chain").
//
// Two layers in this file:
//   1. BIP-327 as written - KeySort, KeyAgg with GetSecondKey, ApplyTweak (plain and x-only), NonceGen, NonceAgg, Sign,
//      PartialSigVerify, PartialSigAgg over 33-byte keys - held to the BIP's published vectors (test-vectors/bip327).
//   2. THE BOND'S NESTED KEY. bond-script.js aggregates 32-byte x-only keys (each lifted to even y, BIP-327's own hashes
//      over 32-byte serialisations): first the 7 arbitration keys into one, then [node_key, that aggregate]. Signing that
//      key is the same session math with one signer - the arbitration aggregate - made of 7 members: their nonces sum
//      into that signer's pair, and each member's partial signature carries the outer coefficient times its inner one.
//      NAMED RESIDUAL: nesting is not part of BIP-327. Its soundness rests on the nested-MuSig2 construction, not on the
//      BIP; what is measured here is that the aggregate signature verifies under the bond's output key and that bitcoind
//      accepts the key-path spend.
// The curve is @noble/curves' secp256k1, as everywhere in this package.
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { createHash, randomBytes } from 'node:crypto';

const Point = secp256k1.Point;
const n = Point.Fn.ORDER;
const G = Point.BASE;
const mod = (a) => { const r = a % n; return r >= 0n ? r : r + n; };
const hex = (b) => Buffer.from(b).toString('hex');
const int = (b) => BigInt('0x' + (hex(b) || '0'));
const bytes32 = (x) => Uint8Array.from(Buffer.from(x.toString(16).padStart(64, '0'), 'hex'));
const cat = (...p) => Uint8Array.from(Buffer.concat(p.map((x) => Buffer.from(x))));
const sha = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const tagged = (tag, msg) => { const t = sha(Buffer.from(tag)); return sha(cat(t, t, msg)); };
const hasEvenY = (P) => (P.toAffine().y & 1n) === 0n;
const xbytes = (P) => bytes32(P.toAffine().x);
const cbytes = (P) => P.toBytes(true);
const liftX = (x32) => schnorr.utils.lift_x(int(x32));
const pointOf = (b) => (b.length === 32 ? liftX(b) : Point.fromBytes(b));
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export class MusigError extends Error { constructor(why, { signer = null, contrib = null } = {}) { super(why); this.signer = signer; this.contrib = contrib; } }

// ---- key aggregation (BIP-327 KeyAgg; works on 33-byte keys, or 32-byte x-only keys as bond-script.js uses them) ----

export const keySort = (pks) => [...pks].sort(compare);

function secondKey(pks) { for (const pk of pks.slice(1)) if (compare(pk, pks[0]) !== 0) return pk; return null; }

function coefficient(pks, i, second) {
  const pk = pks[i];
  if (second && compare(pk, second) === 0) return 1n;
  return mod(int(tagged('KeyAgg coefficient', cat(tagged('KeyAgg list', cat(...pks)), pk))));
}

/** KeyAgg: the context { Q, gacc, tacc, pks } (BIP-327), or a MusigError naming the invalid key. */
export function keyAgg(pks) {
  const second = secondKey(pks);
  let Q = Point.ZERO;
  pks.forEach((pk, i) => {
    let P;
    try { P = pointOf(pk); } catch { throw new MusigError('invalid public key', { signer: i, contrib: 'pubkey' }); }
    Q = Q.add(P.multiply(coefficient(pks, i, second)));
  });
  if (Q.equals(Point.ZERO)) throw new MusigError('the aggregate is infinity');
  return { Q, gacc: 1n, tacc: 0n, pks: [...pks], second };
}

/** ApplyTweak (BIP-327): plain or x-only. */
export function applyTweak(ctx, tweak, isXonly) {
  const g = isXonly && !hasEvenY(ctx.Q) ? n - 1n : 1n;
  const t = int(tweak);
  if (t >= n) throw new MusigError('the tweak is out of range');
  const Q = ctx.Q.multiply(g).add(t === 0n ? Point.ZERO : G.multiply(t));
  if (Q.equals(Point.ZERO)) throw new MusigError('the tweaked key is infinity');
  return { ...ctx, Q, gacc: mod(g * ctx.gacc), tacc: mod(t + g * ctx.tacc) };
}

export const xonlyOf = (ctx) => xbytes(ctx.Q);
const coefficientOf = (ctx, pk) => coefficient(ctx.pks, ctx.pks.findIndex((p) => compare(p, pk) === 0), ctx.second);

// ---- nonces ----

/** NonceGen (BIP-327): { secnonce (97 bytes: k1 || k2 || pk), pubnonce (66 bytes) }. */
export function nonceGen({ sk = null, pk, aggpk = null, msg = null, extraIn = null, rand = null } = {}) {
  const rand0 = rand ? Uint8Array.from(rand) : new Uint8Array(randomBytes(32));
  const aux = tagged('MuSig/aux', rand0);
  const r = sk ? Uint8Array.from(sk.map((v, i) => v ^ aux[i])) : rand0;
  const len4 = (b) => { const o = new Uint8Array(4); new DataView(o.buffer).setUint32(0, b.length); return o; };
  const len1 = (b) => Uint8Array.from([b.length]);
  const msgPrefixed = msg === null ? Uint8Array.from([0]) : cat(Uint8Array.from([1]), (() => { const o = new Uint8Array(8); new DataView(o.buffer).setBigUint64(0, BigInt(msg.length)); return o; })(), msg);
  const agg = aggpk || new Uint8Array(0);
  const extra = extraIn || new Uint8Array(0);
  const k = [0, 1].map((i) => mod(int(tagged('MuSig/nonce', cat(r, len1(pk), pk, len1(agg), agg, msgPrefixed, len4(extra), extra, Uint8Array.from([i]))))));
  if (k[0] === 0n || k[1] === 0n) throw new MusigError('a nonce is zero');
  const R1 = G.multiply(k[0]), R2 = G.multiply(k[1]);
  return { secnonce: cat(bytes32(k[0]), bytes32(k[1]), pk), pubnonce: cat(cbytes(R1), cbytes(R2)) };
}

const pubnoncePoints = (pn, i) => {
  try { return [Point.fromBytes(pn.subarray(0, 33)), Point.fromBytes(pn.subarray(33, 66))]; }
  catch { throw new MusigError('invalid pubnonce', { signer: i, contrib: 'pubnonce' }); }
};
const encodeMaybeInfinity = (P) => (P.equals(Point.ZERO) ? new Uint8Array(33) : cbytes(P));
const decodeMaybeInfinity = (b) => (b.every((x) => x === 0) ? Point.ZERO : Point.fromBytes(b));

/** NonceAgg (BIP-327): the 66-byte aggregate nonce. */
export function nonceAgg(pubnonces) {
  let R1 = Point.ZERO, R2 = Point.ZERO;
  pubnonces.forEach((pn, i) => { const [a, b] = pubnoncePoints(pn, i); R1 = R1.add(a); R2 = R2.add(b); });
  return cat(encodeMaybeInfinity(R1), encodeMaybeInfinity(R2));
}

// ---- a signing session ----

/** The session values (BIP-327 GetSessionValues): Q, gacc, tacc, b, R, e. `ctx` is a KeyAgg context (tweaks applied). */
export function sessionValues(ctx, aggnonce, msg) {
  let R1, R2;
  try { R1 = decodeMaybeInfinity(aggnonce.subarray(0, 33)); R2 = decodeMaybeInfinity(aggnonce.subarray(33, 66)); }
  catch { throw new MusigError('invalid aggnonce', { signer: null, contrib: 'aggnonce' }); }
  const b = mod(int(tagged('MuSig/noncecoef', cat(aggnonce, xbytes(ctx.Q), msg))));
  let R = R1.add(R2.multiply(b));
  if (R.equals(Point.ZERO)) R = G;
  const e = mod(int(tagged('BIP0340/challenge', cat(xbytes(R), xbytes(ctx.Q), msg))));
  return { ...ctx, b, R, e };
}

/**
 * ONE SIGNER'S PARTIAL SIGNATURE with an explicit effective coefficient. `scale` is what multiplies the signer's secret in
 * the aggregate key: BIP-327's a_i for a plain signer; outer a times inner a for a member of a nested aggregate.
 */
function partial(sv, secnonce, sk, scale) {
  let k1 = int(secnonce.subarray(0, 32)), k2 = int(secnonce.subarray(32, 64));
  if (k1 === 0n || k1 >= n || k2 === 0n || k2 >= n) throw new MusigError('the secnonce is invalid or was used');
  if (!hasEvenY(sv.R)) { k1 = n - k1; k2 = n - k2; }
  const d0 = int(sk);
  if (d0 === 0n || d0 >= n) throw new MusigError('the secret key is out of range');
  const g = hasEvenY(sv.Q) ? 1n : n - 1n;
  const d = mod(g * sv.gacc * d0);
  return bytes32(mod(k1 + sv.b * k2 + sv.e * mod(scale) * d));
}

/** Sign (BIP-327): the 32-byte partial signature of `sk` (whose 33-byte key is in the context) under `secnonce`. Wipes nothing: the caller drops the secnonce. */
export function sign(secnonce, sk, ctx, aggnonce, msg) {
  const sv = sessionValues(ctx, aggnonce, msg);
  const P = G.multiply(int(sk));
  const pk = cbytes(P);
  if (compare(secnonce.subarray(64, 97), pk) !== 0) throw new MusigError('the secnonce is not this key\'s');
  if (!ctx.pks.some((p) => compare(p, pk) === 0)) throw new MusigError('this key is not in the aggregate');
  return partial(sv, secnonce, sk, coefficientOf(ctx, pk));
}

/** PartialSigVerify (BIP-327), for signer `i`. */
export function partialSigVerify(psig, pubnonces, ctx, msg, i) {
  const s = int(psig);
  if (s >= n) return false;
  const aggnonce = nonceAgg(pubnonces);
  const sv = sessionValues(ctx, aggnonce, msg);
  const [R1i, R2i] = pubnoncePoints(pubnonces[i], i);
  let Re = R1i.add(R2i.multiply(sv.b));
  if (!hasEvenY(sv.R)) Re = Re.negate();
  const g = hasEvenY(sv.Q) ? 1n : n - 1n;
  const gp = mod(g * sv.gacc);
  const P = pointOf(ctx.pks[i]);
  const lhs = s === 0n ? Point.ZERO : G.multiply(s);
  const rhs = Re.add(P.multiply(mod(sv.e * coefficientOf(ctx, ctx.pks[i]) * gp)));
  return lhs.equals(rhs);
}

/** PartialSigAgg (BIP-327): the 64-byte BIP-340 signature. */
export function partialSigAgg(psigs, ctx, aggnonce, msg) {
  const sv = sessionValues(ctx, aggnonce, msg);
  let s = 0n;
  psigs.forEach((p, i) => { const v = int(p); if (v >= n) throw new MusigError('invalid partial signature', { signer: i, contrib: 'psig' }); s = mod(s + v); });
  const g = hasEvenY(sv.Q) ? 1n : n - 1n;
  s = mod(s + sv.e * g * sv.tacc);
  return cat(xbytes(sv.R), bytes32(s));
}

// ---- the bond's key path: the node and the arbitration set's 7 members, nested ----

/**
 * THE BOND'S SIGNING CONTEXT: the outer KeyAgg over [node_key, arbitration aggregate] (x-only, as bond-script.js builds
 * it), with the BIP-341 taproot tweak of the bond's script tree applied (x-only), and the inner KeyAgg over the
 * arbitration keys. `tweak` is tapTweak(internalKey, merkleRoot).
 */
export function bondSigningContext({ nodeKey, arbitrationKeys, tweak }) {
  const inner = keyAgg(arbitrationKeys.map((k) => Uint8Array.from(k)));
  const arbAgg = xbytes(inner.Q);
  const outer = keyAgg([Uint8Array.from(nodeKey), arbAgg]);
  const tweaked = applyTweak(outer, tweak, true);
  return { outer: tweaked, inner, nodeKey: Uint8Array.from(nodeKey), arbAgg, internalKey: xbytes(outer.Q), outputKey: xbytes(tweaked.Q) };
}

/**
 * ONE PARTY'S PARTIAL SIGNATURE IN THE BOND'S SESSION. `who` is 'node' or a member index of the arbitration set.
 * x-only keys are lifted to even y, so a secret whose point has odd y signs negated; the inner aggregate is lifted the
 * same way inside the outer one, so a member's share is negated when the inner aggregate's y is odd.
 */
export function bondPartialSign(bctx, { who, sk, secnonce, aggnonce, msg }) {
  const sv = sessionValues(bctx.outer, aggnonce, msg);
  const P = G.multiply(int(sk));
  const evenSk = hasEvenY(P) ? int(sk) : n - int(sk);
  if (who === 'node') {
    if (compare(xbytes(P), bctx.nodeKey) !== 0) throw new MusigError('that secret is not the node key');
    return partial(sv, secnonce, bytes32(evenSk), coefficientOf(bctx.outer, bctx.nodeKey));
  }
  const member = bctx.inner.pks[who];
  if (!member || compare(xbytes(P), member) !== 0) throw new MusigError(`that secret is not arbitration member ${who}'s`);
  const lift = hasEvenY(bctx.inner.Q) ? 1n : n - 1n;
  const scale = mod(coefficientOf(bctx.outer, bctx.arbAgg) * lift * coefficientOf(bctx.inner, member));
  return partial(sv, secnonce, bytes32(evenSk), scale);
}

/** The bond session's aggregate nonce: the node's pair and the arbitration signer's (the sum of its members' pairs). */
export function bondNonceAgg({ node, members }) {
  return nonceAgg([node, nonceAgg(members)].map((b) => b));
}

/** The final BIP-340 signature of a bond's key-path spend, checked against its output key before it is handed back. */
export function bondSignatureAgg(bctx, { psigs, aggnonce, msg }) {
  const sig = partialSigAgg(psigs, bctx.outer, aggnonce, msg);
  if (!schnorr.verify(sig, msg, bctx.outputKey)) throw new MusigError('the aggregate does not verify under the bond\'s output key');
  return sig;
}

export const musigHex = hex;
