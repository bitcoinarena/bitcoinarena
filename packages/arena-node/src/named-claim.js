// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NAMED CLAIM, THE SEAT'S SIDE (protocol 27, kanban #1044 B1, rulings #1131 3 and #1134 2): the settlement seats of a round sign its
// Arena-lock claims with BIP-327 MuSig2 under the KeyAgg of exactly the signers the claims name - the t lowest seat indices that sent a valid
// SettlementCommit for the transaction (arena-lock.js namedSignerSet). Two rounds:
//   1. each seat makes a fresh nonce pair for (txid, set) and commits to its public nonce in the SettlementCommit it already sends
//      (commitNoncesOf: the commit hashes the two 33-byte points as it hashed FROST's);
//   2. each member of the set gives one partial signature, checked against its public nonce by everybody, and deletes the secret nonce.
// Anyone adds the partials together. One signature covers every input of the settlement: every lock it claims names the same set, so core's
// one-signature-per-input check takes the same signature for each. A member that drops out costs a new session with new nonces and the next set.
//
// The keys are the seats' x-only node keys lifted to 02 || x, so a seat whose secret gives an odd-y point signs with its negation (BIP-340's
// convention, and the fork's musig module's - fedimint-lnv2-common arena_lock::musig); the session math is musig2.js, held to BIP-327's vectors
// and here to the fork's own output (test/named-claim.test.js).
//
// The refund key of a gateway winnings send is KeyAgg of the same set (RULED #1134 2), signed in the same batch as the settlement: one message per
// signature, its own nonces each.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keyAgg, xonlyOf, nonceGen, nonceAgg, sign, partialSigVerify, partialSigAgg, MusigError } from './musig2.js';
import { namedSignerSet } from '../../arena-protocol/src/arena-lock.js';

const Point = secp256k1.Point;
const n = Point.Fn.ORDER;
const toBig = (b) => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
const to32 = (x) => Uint8Array.from(Buffer.from(x.toString(16).padStart(64, '0'), 'hex'));
const hex = (b) => Buffer.from(b).toString('hex');

/** An x-only key as the even-y point 02 || x. */
export const evenYKey = (x) => { if (!(x instanceof Uint8Array) || x.length !== 32) throw new MusigError('a claim key is 32 bytes'); return Uint8Array.from([0x02, ...x]); };

/** The secret a node key signs with: its own when its point has an even y, else its negation. */
export function signingSecret(sk) {
  const d = toBig(sk);
  if (d === 0n || d >= n) throw new MusigError('the secret key is out of range');
  const P = Point.BASE.multiply(d);
  return (P.toAffine().y & 1n) === 0n ? to32(d) : to32(n - d);
}

/** The exactly-t, ascending rule the guardians apply to a witness's signer indices. */
export function checkSigners(claimKeys, threshold, signers) {
  if (!Array.isArray(signers) || signers.length !== threshold) return { ok: false, why: `a claim names exactly ${threshold} signers, not ${Array.isArray(signers) ? signers.length : 0}` };
  for (let i = 0; i < signers.length; i++) {
    if (!Number.isInteger(signers[i]) || signers[i] < 0 || signers[i] >= claimKeys.length) return { ok: false, why: `signer ${signers[i]} is not one of the ${claimKeys.length} claim keys` };
    if (i > 0 && signers[i] <= signers[i - 1]) return { ok: false, why: 'the signer indices are not strictly ascending' };
  }
  return { ok: true };
}

/** The KeyAgg context of the named signers (index order, no tweak): what they sign with and what the guardians hand core. */
export function namedContext(claimKeys, threshold, signers) {
  const c = checkSigners(claimKeys, threshold, signers);
  if (!c.ok) throw new MusigError(c.why);
  return keyAgg(signers.map((i) => evenYKey(claimKeys[i])));
}
/** The named set's x-only key: a claim's input key as core reads it, and the refund key of the round's gateway sends (#1134 2). */
export const namedKey = (claimKeys, threshold, signers) => xonlyOf(namedContext(claimKeys, threshold, signers));
/** The refund key of a gateway winnings send, as the 33-byte key its OutgoingContract names: KeyAgg(claim_keys[S]), its x coordinate lifted to even y. */
export const sendRefundKey = (claimKeys, threshold, signers) => evenYKey(namedKey(claimKeys, threshold, signers));

/**
 * ONE SEAT'S PART OF ONE SIGNING SESSION. Holds the secret nonces until each is used once; `use` deletes it. `messages` the 32-byte messages of
 * the batch (the settlement txid first, then the sends' auth and refund messages), each its own nonce pair.
 */
export class NamedSession {
  constructor({ claimKeys, threshold, signers, me, secret, messages, rand = null }) {
    this.claimKeys = claimKeys; this.threshold = threshold; this.signers = signers.slice();
    this.ctx = namedContext(claimKeys, threshold, signers);
    this.position = signers.indexOf(me);
    if (this.position < 0) throw new MusigError(`seat ${me} is not one of the named signers ${signers.join(',')}`);
    this.sk = signingSecret(secret);
    const pk = evenYKey(claimKeys[me]);
    if (hex(Point.BASE.multiply(toBig(this.sk)).toBytes(true)) !== hex(pk)) throw new MusigError('that secret is not this seat\'s claim key');
    this.messages = messages.map((m) => Uint8Array.from(m));
    const aggpk = xonlyOf(this.ctx);
    this.secnonces = this.messages.map((msg, k) => nonceGen({ sk: this.sk, pk, aggpk, msg, rand: rand ? rand(k) : null }));
  }
  /** The public nonces (66 bytes each), one per message: the first is what the SettlementCommit carries. */
  get pubnonces() { return this.secnonces.map((s) => (s ? s.pubnonce : null)); }
  /** Round 2 for message k: this seat's partial signature; the secret nonce is deleted, so a second call throws. */
  partial(k, pubnoncesBySigner) {
    const s = this.secnonces[k];
    if (!s) throw new MusigError('that nonce was used already: a new session takes new nonces');
    this.secnonces[k] = null;
    const aggnonce = nonceAgg(pubnoncesBySigner.map((p) => p[k]));
    return sign(s.secnonce, this.sk, this.ctx, aggnonce, this.messages[k]);
  }
}

/** Checks member `position`'s partial for message k against its public nonce. */
export function partialStands({ claimKeys, threshold, signers, message, pubnonces, position, partial }) {
  try { return partialSigVerify(partial, pubnonces, namedContext(claimKeys, threshold, signers), message, position); } catch { return false; }
}

/**
 * THE SIGNATURE, from every member's partial: checked one by one first, so a bad one is named (and its seat dropped from the next set).
 * { ok: true, signature } or { ok: false, bad: [positions], why }.
 */
export function aggregateNamed({ claimKeys, threshold, signers, message, pubnonces, partials }) {
  const ctx = namedContext(claimKeys, threshold, signers);
  const bad = partials.map((p, i) => (p && partialSigVerify(p, pubnonces, ctx, message, i) ? null : i)).filter((i) => i !== null);
  if (bad.length) return { ok: false, bad, why: `the partial signature of seat ${bad.map((i) => signers[i]).join(', ')} does not verify` };
  return { ok: true, signature: partialSigAgg(partials, ctx, nonceAgg(pubnonces), message) };
}

/** The next session's set after `dropped` failed one: arena-lock.js namedSignerSet, re-exported for the seat. */
export { namedSignerSet };
