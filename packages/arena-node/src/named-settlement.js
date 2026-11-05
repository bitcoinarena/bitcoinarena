// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROTOCOL-27 SETTLEMENT BATCH, THE SEAT'S SIDE (kanban #1044 B1, rulings #1131 3, #1134 2, #1135, #1136). A round whose locks are Arena locks
// (arena-lock.js namedClaims) is signed by the signer set S with BIP-327 MuSig2, in one batch, each message its own nonce pair:
//   1. the settlement transaction (its REAL txid: the body with S in every claim and KeyAgg(S) for every Z),
//   2. for each gateway send, the gateway's auth (the invoice's consensus hash; the send's refund key is KeyAgg(S)),
//   3. for each send to a qualifier, the presigned refund (c): the send contract (real txid, index) by Refund into a pre-expired payout to the
//      qualifier's own key (stake-lock arena-send-refund).
// The seats ack and commit over the BODY id; nonces need no message, so a seat commits before S is known; S is the t lowest seat indices with a
// valid signed commit; nothing is submitted until every signature of the batch exists, and every seat keeps the auths and the refunds.
//
// Here: which messages a body signs (`namedSlots`), one seat's nonces for one session (`NamedNonces`), and the bytes the doors carry.
import { nonceGen, nonceAgg, sign } from './musig2.js';
import { evenYKey, signingSecret, namedContext, namedKey, aggregateNamed } from './named-claim.js';
import { SIGNED_SETTLEMENT_COMMIT_BYTES } from '../../arena-protocol/src/settlement-ack.js';

const PUBNONCE = 66, PARTIAL = 32, SIG = 64;

/**
 * THE MESSAGES A BODY'S BATCH SIGNS, in the order the commit hashes their nonces (ruling #1135 1): the claim, then each send's auth (in payout
 * order), then each send to a qualifier's refund (c) (in payout order). A donation's send has an auth and no refund (c): a recipient has no key
 * (#1134 2). A held share (no invoice) has neither. `payouts` the plan's payouts as the body orders them.
 */
export function namedSlots(payouts) {
  const sends = (payouts || []).map((p, outIdx) => ({ p, outIdx })).filter(({ p }) => p.sent);
  return [{ kind: 'claim' },
    ...sends.map(({ p, outIdx }) => ({ kind: 'auth', outIdx, paymentHash: p.sent.paymentHash })),
    ...sends.filter(({ p }) => !p.donation).map(({ p, outIdx }) => ({ kind: 'refund', outIdx, qualifierPk: Uint8Array.from([0x02, ...p.pubkey]), msat: p.msat }))];
}

/**
 * ONE SEAT'S NONCES FOR ONE SESSION: `count` fresh BIP-327 nonce pairs, made before S or any message is known (BIP-327 nonces need neither). Each
 * secret nonce signs once and is deleted; a session whose list failed is never signed again - the next one takes new nonces.
 */
export class NamedNonces {
  constructor({ count, secret, myKey, rand }) {
    this.sk = signingSecret(secret);
    this.pk = evenYKey(myKey);
    this.secnonces = []; this.pubnonces = [];
    for (let k = 0; k < count; k++) {
      const n = nonceGen({ sk: this.sk, pk: this.pk, rand: rand(32) });
      this.secnonces.push(n.secnonce); this.pubnonces.push(n.pubnonce);
    }
    this.list = null;       // the signer list these nonces signed, once they did
    this.partials = null;
  }
  /** Round two: this seat's partials over `messages` for the list `signers` (S) with every member's public nonces; once. */
  sign({ claimKeys, threshold, signers, pubnoncesBySigner, messages }) {
    if (messages.length !== this.secnonces.length) throw new Error(`the batch signs ${messages.length} messages and this seat committed to ${this.secnonces.length}`);
    if (this.secnonces.some((s) => s === null)) throw new Error('these nonces signed already: a new session takes new nonces');
    const ctx = namedContext(claimKeys, threshold, signers);
    const out = messages.map((msg, k) => {
      const s = this.secnonces[k];
      this.secnonces[k] = null;
      return sign(s, this.sk, ctx, nonceAgg(pubnoncesBySigner.map((p) => p[k])), msg);
    });
    this.partials = out;
    return out;
  }
}

/** Every message of the batch, aggregated: { ok, signatures } or { ok: false, bad: [seat indices], why }. */
export function aggregateBatch({ claimKeys, threshold, signers, messages, pubnoncesBySigner, partialsBySigner }) {
  const signatures = [];
  const bad = new Set();
  let why = null;
  messages.forEach((message, k) => {
    const got = aggregateNamed({ claimKeys, threshold, signers, message, pubnonces: pubnoncesBySigner.map((p) => p[k]), partials: partialsBySigner.map((p) => (p ? p[k] : null)) });
    if (got.ok) signatures.push(got.signature);
    else { for (const i of got.bad) bad.add(signers[i]); why = why || got.why; }
  });
  return bad.size ? { ok: false, bad: [...bad].sort((a, b) => a - b), why } : { ok: true, signatures };
}

/** The refund key of the round's sends and held shares under S: KeyAgg(claim_keys[S]) lifted to 02 || x (#1134 2). */
export const signerSetKey = (claimKeys, threshold, signers) => evenYKey(namedKey(claimKeys, threshold, signers));

// ---- the bytes the doors carry ----
const u16 = (n) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
function reader(bytes) {
  let at = 0;
  const take = (n) => { if (at + n > bytes.length) throw new Error('the named settlement bytes end early'); const b = bytes.slice(at, at + n); at += n; return b; };
  return { take, u8: () => take(1)[0], u16: () => { const b = take(2); return (b[0] << 8) | b[1]; }, end: () => { if (at !== bytes.length) throw new Error('the named settlement bytes run on'); } };
}

/** A seat's commitment at the commit door: u16 k, then k public nonces. */
export const encodeNamedCommitment = (pubnonces) => cat(u16(pubnonces.length), ...pubnonces);
export function decodeNamedCommitment(bytes) {
  const r = reader(bytes); const k = r.u16(); const out = [];
  for (let i = 0; i < k; i++) out.push(r.take(PUBNONCE));
  r.end(); return out;
}

/** The list the share door is asked over: u8 n, then per member u8 seat index, its signed commit (195 bytes), u16 k and k public nonces. */
export const encodeNamedList = (members) => cat(Uint8Array.of(members.length),
  ...members.flatMap((m) => [Uint8Array.of(m.seat), m.word, encodeNamedCommitment(m.pubnonces)]));
export function decodeNamedList(bytes) {
  const r = reader(bytes); const n = r.u8(); const out = [];
  for (let i = 0; i < n; i++) {
    const seat = r.u8(); const word = r.take(SIGNED_SETTLEMENT_COMMIT_BYTES); const k = r.u16(); const pubnonces = [];
    for (let j = 0; j < k; j++) pubnonces.push(r.take(PUBNONCE));
    out.push({ seat, word, pubnonces });
  }
  r.end(); return out;
}

/** A member's partials at the share door: u16 k, then k partial signatures. */
export const encodeNamedPartials = (partials) => cat(u16(partials.length), ...partials);
export function decodeNamedPartials(bytes) {
  const r = reader(bytes); const k = r.u16(); const out = [];
  for (let i = 0; i < k; i++) out.push(r.take(PARTIAL));
  r.end(); return out;
}

/** The batch handed on before the submit: u8 t and the t signer indices, u16 k and the k signatures (claim, auths, refunds). */
export const encodeNamedBatch = ({ signers, signatures }) => cat(Uint8Array.of(signers.length), Uint8Array.from(signers), u16(signatures.length), ...signatures);
export function decodeNamedBatch(bytes) {
  const r = reader(bytes); const t = r.u8(); const signers = [...r.take(t)]; const k = r.u16(); const signatures = [];
  for (let i = 0; i < k; i++) signatures.push(r.take(SIG));
  r.end(); return { signers, signatures };
}
