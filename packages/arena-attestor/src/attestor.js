// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ATTESTOR OF A PERIOD MARKET (kanban #236; spec §0A.7b.1). Every 10 s it reads its sources and keeps the median, in whole
// cents. At the end of each round's window - the period before the round's entry close (attested.js marketWindowOf) - it
// applies the market's rule (up-down.js upDownOutcome: Up when the 60 s average at the window's end is at or above the 60 s
// average at its start, a tie Up), and signs the attestation body {round, outcome, observed_at = the window's end}. Honest attestors that saw the same
// outcome sign THE SAME BYTES, so their signatures combine: a seat takes an attestation only with the market's threshold of
// its attestors' signatures on it (attestationStands), and its intake is unchanged. So each attestor serves its own
// signature (GET /attestation?round=), pulls the others', and once the threshold of signatures over one body is held, posts
// that attestation to every seat - with retry. No reading a minute before the window's start: it signs nothing for that window.
//
// THE VALUE MODE (kanban #362 feature 8, scalar markets, protocol 7): for a scalar market the attestor signs the VALUE it observed
// instead of an outcome - a ValueAttestation (arena-protocol scalar.js: its own type byte and tag, never an outcome's) of the
// 60 s average at the window's end in whole cents, the same END PRICE the Up/Down rule reads (up-down.js upDownPrices). Honest
// attestors whose readings agree to the cent sign the same bytes and combine exactly as outcomes do; attestors that saw
// different cents sign different bodies, and only a threshold over ONE value makes an attestation (two values standing at a
// seat void the round - attested.js). A value needs no price to beat: only a reading a minute before the window's end.
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { attestationBodyId, encodeAttestation } from '../../arena-protocol/src/attested.js';
import { upDownOutcome, upDownPrices, UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { valueAttestationBodyId, encodeValueAttestation } from '../../arena-protocol/src/scalar.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An attestor key from a PKCS#8 DER (or a raw 32-byte Ed25519 seed): { key, pubkey }. */
export function attestorKey(bytes) {
  const der = bytes.length === 32 ? Buffer.concat([PKCS8_ED25519, Buffer.from(bytes)]) : Buffer.from(bytes);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('an attestor key is Ed25519');
  return { key, pubkey: new Uint8Array(createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32)) };
}

/**
 * THIS ATTESTOR'S WORD ON ONE WINDOW: `samples` [{ atMs, price }] (its medians), the round and its window. Answers
 * { ok, body, signature (hex), key (hex), priceToBeat, endPrice, label } or why it signs nothing.
 */
export function attestWindow({ samples, roundId, window, attestor }) {
  const out = upDownOutcome(samples, { startMs: window.startMs, endMs: window.endMs });
  if (!out.ok) return { ok: false, why: out.why };
  const body = { roundId, outcome: out.outcome, observedAtMs: window.endMs };
  const signature = new Uint8Array(edSign(null, Buffer.from(attestationBodyId(body)), attestor.key));
  return { ok: true, body, signature: toHex(signature), key: toHex(attestor.pubkey), priceToBeat: out.priceToBeat, endPrice: out.endPrice, label: out.label };
}

/**
 * THIS ATTESTOR'S VALUE FOR ONE WINDOW (a scalar market): the 60 s average ending at the window's end, whole cents, signed as a
 * value attestation body {round, value, observed_at = the window's end}. Answers { ok, body, signature, key, value } or why not.
 */
export function attestValue({ samples, roundId, window, attestor }) {
  // the end price alone: upDownPrices over the last millisecond of the window reads the 60 s average ending at its end
  const p = upDownPrices(samples, { startMs: window.endMs - 1n, endMs: window.endMs });
  if (!p.ok) return { ok: false, why: 'no reading a minute before the window\'s end: the value is not known' };
  const body = { roundId, value: p.endPrice, observedAtMs: window.endMs };
  const signature = new Uint8Array(edSign(null, Buffer.from(valueAttestationBodyId(body)), attestor.key));
  return { ok: true, body, signature: toHex(signature), key: toHex(attestor.pubkey), value: p.endPrice, label: `${p.endPrice} cents` };
}
const isValueWord = (w) => typeof w.body.value === 'bigint';

/**
 * THE SIGNATURES THAT COMBINE: of the words given (this attestor's and the others' - { body, key, signature }), the body the
 * most named attestors signed, and its attestation once it carries `threshold` of them - else null. Only keys the market
 * names count, each once.
 */
export function combine(words, { attestors, threshold }) {
  const named = new Set(attestors.map((k) => (typeof k === 'string' ? k : toHex(k))));
  const byBody = new Map();
  for (const w of words) {
    if (!w || !w.body || !named.has(w.key)) continue;
    // an outcome word and a value word never meet in one body: each is identified under its own tag
    const id = isValueWord(w) ? `v${toHex(valueAttestationBodyId(w.body))}` : toHex(attestationBodyId(w.body));
    if (!byBody.has(id)) byBody.set(id, { body: w.body, sigs: new Map() });
    byBody.get(id).sigs.set(w.key, w.signature);
  }
  const best = [...byBody.values()].sort((a, b) => b.sigs.size - a.sigs.size)[0];
  if (!best || best.sigs.size < threshold) return null;
  const signatures = [...best.sigs].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, Math.max(threshold, best.sigs.size))
    .map(([key, sig]) => ({ key: fromHex(key), signature: fromHex(sig) }));
  const bytes = typeof best.body.value === 'bigint' ? encodeValueAttestation({ ...best.body, signatures }) : encodeAttestation({ ...best.body, signatures });
  return { body: best.body, signers: best.sigs.size, bytes };
}

/** A word on the wire (JSON) and back. */
export const wordToJson = (w) => ({ body: { roundId: toHex(w.body.roundId), ...(isValueWord(w) ? { value: String(w.body.value) } : { outcome: w.body.outcome }), observedAtMs: String(w.body.observedAtMs) },
  key: w.key, signature: w.signature, priceToBeat: w.priceToBeat !== undefined ? String(w.priceToBeat) : null, endPrice: w.endPrice !== undefined ? String(w.endPrice) : null, label: w.label || null });
export function wordFromJson(j) {
  if (!j || !j.body || !/^[0-9a-f]{64}$/.test(String(j.body.roundId)) || !/^[0-9]{1,20}$/.test(String(j.body.observedAtMs))
      || !/^[0-9a-f]{64}$/.test(String(j.key)) || !/^[0-9a-f]{128}$/.test(String(j.signature))) return null;
  const at = { roundId: fromHex(j.body.roundId), observedAtMs: BigInt(j.body.observedAtMs) };
  // a value word (a scalar market's) or an outcome word - never both
  if (j.body.value !== undefined) {
    if (j.body.outcome !== undefined || !/^-?[0-9]{1,19}$/.test(String(j.body.value))) return null;
    return { body: { roundId: at.roundId, value: BigInt(j.body.value), observedAtMs: at.observedAtMs }, key: j.key, signature: j.signature };
  }
  if (!Number.isInteger(j.body.outcome)) return null;
  return { body: { roundId: at.roundId, outcome: j.body.outcome, observedAtMs: at.observedAtMs }, key: j.key, signature: j.signature };
}

export { UP_DOWN_OUTCOMES };
