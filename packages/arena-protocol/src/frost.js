// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNATURE SEVEN OPERATORS MAKE AND NO ONE OF THEM CAN.
//
// 23.5: "Settled loser stakes accumulate in a wallet whose every operation
// requires a 5-of-7 threshold signature of the settlement committee. No node
// and no minority can move a satoshi, at any moment, including during payout."
//
// Measured before this file existed: there is no pool wallet at all, and the
// number of keys that must agree before a settled satoshi moves is ONE - the
// macaroon of whichever Lightning node the operator pointed `lndPort` at.
// `aggregateKeys` next door does not help: it is BIP-327 MuSig2 and MuSig2
// needs EVERY signer, so it cannot say five of seven.
//
// THIS IS RFC 9591 AND NOTHING INVENTED. The whole reason PRIORITIES calls
// FROST "comparatively low risk despite sounding like the hardest part" is
// that it has published test vectors, so the implementation is measured
// against numbers somebody else wrote down rather than against its own
// opinion. `test-vectors/protocol/rfc9591-secp256k1.json` is Appendix E.5,
// pulled out of the RFC text by a script.
//
// THIS SUITE IS NOT BIP-340, AND THAT MATTERS FOR THE POOL. RFC 9591's
// secp256k1 ciphersuite hashes a different challenge, serialises R as a
// 33-byte compressed point instead of 32 x-only bytes, and has no even-y rule.
// Bitcoin will not verify a signature it produces. So this file proves the
// ALGEBRA - interpolation over the signer set, binding factors, share
// aggregation - and `frost-bip340.js` is what a taproot output can check.
//
// THE CURVE IS INJECTED, like every other point operation this package needs.
import { sha256, toHex, bytesToBigInt } from './hash.js';
import { FIELD, scalarTo32, scalarFrom32 } from './shares.js';
import { utf8Encode } from './utf8.js';

export const CONTEXT = 'FROST-secp256k1-SHA256-v1';
/** Ne and Ns of the ciphersuite: a compressed point, and a scalar. */
export const ELEMENT_BYTES = 33;
export const SCALAR_BYTES = 32;
/** 33-byte R element followed by a 32-byte scalar (Appendix A). */
export const SIGNATURE_BYTES = ELEMENT_BYTES + SCALAR_BYTES;

const mod = (n) => ((n % FIELD) + FIELD) % FIELD;

/** a^-1 mod n, by the extended Euclidean algorithm. */
function inverse(a) {
  let [old_r, r] = [mod(a), FIELD];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error('that scalar has no inverse in this field');
  return mod(old_s);
}

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/**
 * expand_message_xmd, RFC 9380 section 5.3.1, with SHA-256.
 *
 * WRITTEN OUT RATHER THAN IMPORTED because the protocol package carries no
 * hashing library either: `sha256` comes from the core, the way every other
 * hash in this package does, and the rest is byte plumbing.
 *
 * The two hash calls are not interchangeable: b_1 covers b_0 and b_2 covers
 * b_0 XOR b_1, which is what stops an attacker who can choose the message
 * from steering the output.
 */
function expandMessageXmd(message, dst, lengthBytes) {
  const B_IN_BYTES = 32;
  const S_IN_BYTES = 64;
  if (dst.length > 255) throw new Error('a DST longer than 255 bytes needs hashing first');
  const ell = Math.ceil(lengthBytes / B_IN_BYTES);
  if (ell > 255) throw new Error('expand_message_xmd cannot produce that much');

  const dstPrime = cat(dst, Uint8Array.of(dst.length));
  const zPad = new Uint8Array(S_IN_BYTES);
  const lIbStr = Uint8Array.of((lengthBytes >> 8) & 0xff, lengthBytes & 0xff);

  const b0 = sha256(cat(zPad, message, lIbStr, Uint8Array.of(0), dstPrime));
  const blocks = [sha256(cat(b0, Uint8Array.of(1), dstPrime))];
  for (let i = 2; i <= ell; i++) {
    const x = new Uint8Array(B_IN_BYTES);
    for (let j = 0; j < B_IN_BYTES; j++) x[j] = b0[j] ^ blocks[i - 2][j];
    blocks.push(sha256(cat(x, Uint8Array.of(i), dstPrime)));
  }
  return cat(...blocks).subarray(0, lengthBytes);
}

/**
 * hash_to_field with m = 1 and L = 48, which is what H1, H2 and H3 are.
 *
 * L IS 48 AND NOT 32 ON PURPOSE. Reducing 32 bytes modulo a 256-bit order
 * leaves a distribution measurably off uniform; the extra 128 bits make the
 * bias smaller than anything that could be exploited, which is the reason the
 * RFC says 48.
 */
const hashToScalar = (label, message, context = CONTEXT) =>
  mod(bytesToBigInt(expandMessageXmd(message, utf8Encode(context + label), 48)));

/**
 * H1..H5 UNDER A CIPHERSUITE'S CONTEXT STRING. RFC 9591's secp256k1 suite by
 * default; the taproot suite (`frost-bip340.js`, Zcash Foundation's
 * frost-secp256k1-tr) differs from it only here - measured: with this string
 * changed and nothing else, its published nonces, binding factors, signature
 * shares and signature all come out byte for byte.
 */
export const hashesFor = (context) => ({
  H1: (m) => hashToScalar('rho', m, context),
  H2: (m) => hashToScalar('chal', m, context),
  H3: (m) => hashToScalar('nonce', m, context),
  H4: (m) => sha256(cat(utf8Encode(context + 'msg'), m)),
  H5: (m) => sha256(cat(utf8Encode(context + 'com'), m)),
  // The DKG round-1 proof of knowledge's challenge (frost-core `challenge`,
  // label "dkg"), used by `dkg.js` under the taproot suite.
  HDKG: (m) => hashToScalar('dkg', m, context),
});
const RFC_HASHES = hashesFor(CONTEXT);

export const H1 = RFC_HASHES.H1;
export const H2 = RFC_HASHES.H2;
export const H3 = RFC_HASHES.H3;
export const H4 = RFC_HASHES.H4;
export const H5 = RFC_HASHES.H5;

/**
 * A NONCE FROM A SECRET AND SOME RANDOMNESS (section 4.1).
 *
 * The share is hashed in beside the randomness so that a repeated or
 * predictable random string still cannot make two signers produce the same
 * nonce - and a nonce reused across two signatures over different messages
 * hands over the signing share.
 */
export const nonceGenerate = (randomBytes, share, context = CONTEXT) =>
  hashesFor(context).H3(cat(randomBytes, scalarTo32(share)));

/** SerializeScalar of an identifier, per the ciphersuite: 32 big-endian bytes. */
const idBytes = (i) => scalarTo32(BigInt(i));

/**
 * THE COMMITMENT LIST ON THE WIRE (section 4.3), sorted by identifier.
 *
 * The order is not cosmetic: every signer hashes this list to get the binding
 * factors, so two signers who sorted differently compute different factors and
 * their shares do not add up to anything.
 */
export function encodeCommitmentList(commitments) {
  const sorted = [...commitments].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].id === sorted[i - 1].id)
      throw new Error(`two commitments for participant ${sorted[i].id} are one commitment`);
  return cat(...sorted.map((c) => cat(idBytes(c.id), c.hiding, c.binding)));
}

/** Section 4.4: one binding factor per participant, over the whole list. */
export function bindingFactors({ groupPublicKey, commitments, message, context = CONTEXT }) {
  const suite = hashesFor(context);
  const prefix = cat(groupPublicKey, suite.H4(message), suite.H5(encodeCommitmentList(commitments)));
  const sorted = [...commitments].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted.map((c) => ({
    id: c.id,
    input: cat(prefix, idBytes(c.id)),
    factor: suite.H1(cat(prefix, idBytes(c.id))),
  }));
}

/** Section 4.5: R = sum over participants of D_i + rho_i * E_i. */
export function groupCommitment({ commitments, factors, curve }) {
  const byId = new Map(factors.map((f) => [String(f.id), f.factor]));
  const terms = [];
  for (const c of commitments) {
    const rho = byId.get(String(c.id));
    if (rho === undefined) throw new Error(`no binding factor for participant ${c.id}`);
    terms.push({ point: c.hiding, coefficient: 1n });
    terms.push({ point: c.binding, coefficient: rho });
  }
  return curve.combinePoints(terms);
}

/** Section 4.6: c = H2(R || PK || msg). */
export const challenge = ({ commitment, groupPublicKey, message }) =>
  H2(cat(commitment, groupPublicKey, message));

/**
 * SECTION 4.7'S LAGRANGE COEFFICIENT, over the signers who actually turned up.
 *
 * This is the whole of why five of seven is a threshold rather than a count: a
 * share is a point on one polynomial, and the coefficient that lifts it to the
 * constant term DEPENDS ON WHO ELSE IS SIGNING. A signer cannot compute its own
 * contribution without the set, so no subset smaller than the threshold has
 * anything to add up.
 */
export function interpolatingValue(participants, id) {
  const list = participants.map(BigInt);
  const x = BigInt(id);
  if (!list.some((v) => v === x)) throw new Error(`participant ${id} is not in that signing set`);
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      if (list[i] === list[j]) throw new Error('a signing set naming one participant twice is not a set');

  let numerator = 1n;
  let denominator = 1n;
  for (const xj of list) {
    if (xj === x) continue;
    numerator = mod(numerator * xj);
    denominator = mod(denominator * (xj - x));
  }
  return mod(numerator * inverse(denominator));
}

/** Section 5.2: z_i = d_i + (e_i * rho_i) + (lambda_i * s_i * c). */
export function signShare({ id, share, groupPublicKey, nonces, message, commitments }) {
  const factors = bindingFactors({ groupPublicKey, commitments, message });
  const mine = factors.find((f) => String(f.id) === String(id));
  if (!mine) throw new Error(`participant ${id} did not commit to this signature`);
  const participants = commitments.map((c) => c.id);
  const lambda = interpolatingValue(participants, id);
  const c = challenge({
    commitment: groupCommitment({ commitments, factors, curve: nonces.curve }),
    groupPublicKey, message,
  });
  return mod(nonces.hiding + mod(nonces.binding * mine.factor) + mod(mod(lambda * share) * c));
}

/** Section 5.3: R from the commitments, z as the plain sum of the shares. */
export function aggregate({ commitments, message, groupPublicKey, shares, curve }) {
  const factors = bindingFactors({ groupPublicKey, commitments, message });
  const commitment = groupCommitment({ commitments, factors, curve });
  let z = 0n;
  for (const s of shares) z = mod(z + s);
  return { commitment, z, signature: cat(commitment, scalarTo32(z)) };
}

/**
 * APPENDIX B: does g^z equal R + PK*c?
 *
 * The RFC's own verification, so a signature this file builds is checked the
 * way a stranger would check it rather than by re-running the construction.
 */
export function verify({ signature, groupPublicKey, message, curve }) {
  if (!(signature instanceof Uint8Array) || signature.length !== SIGNATURE_BYTES)
    return { ok: false, why: `a signature of this suite is ${SIGNATURE_BYTES} bytes` };
  const commitment = signature.subarray(0, ELEMENT_BYTES);
  const z = scalarFrom32(signature.subarray(ELEMENT_BYTES));
  if (z >= FIELD) return { ok: false, why: 'that signature carries something that is not a scalar' };

  const c = challenge({ commitment, groupPublicKey, message });
  const left = curve.pointFromScalar(z);
  const right = curve.combinePoints([
    { point: commitment, coefficient: 1n },
    { point: groupPublicKey, coefficient: c },
  ]);
  return toHex(left) === toHex(right)
    ? { ok: true, why: 'g^z is R + PK*c' }
    : { ok: false, why: 'g^z is not R + PK*c: that is not a signature of this group over this message' };
}

/**
 * APPENDIX C: A TRUSTED DEALER'S SPLIT.
 *
 * The dealer knows the group secret, which is exactly the property a DKG
 * removes and this does not - said plainly rather than implied. What it does
 * buy is a committee where no SIGNER holds more than a share, which is the
 * property 23.5 asks about the pool wallet, and it has published vectors.
 *
 * The coefficients are the caller's: the vectors fix them, and a real dealer
 * draws them.
 */
export function trustedDealerSplit({ secret, max, min, coefficients, curve }) {
  const s = secret instanceof Uint8Array ? scalarFrom32(secret) : secret;
  if (typeof s !== 'bigint' || s <= 0n || s >= FIELD)
    throw new Error('a group secret is a non-zero scalar of the group');
  if (!Number.isInteger(min) || min < 2) throw new Error('a threshold below two is not a threshold');
  if (!Number.isInteger(max) || max < min)
    throw new Error(`${max} participants cannot carry a threshold of ${min}`);
  if (!Array.isArray(coefficients) || coefficients.length !== min - 1)
    throw new Error(`a threshold of ${min} needs ${min - 1} coefficients`);

  const a = [s, ...coefficients.map((v) => mod(v instanceof Uint8Array ? scalarFrom32(v) : v))];
  const shares = [];
  for (let id = 1; id <= max; id++) {
    let value = 0n;
    for (let j = a.length - 1; j >= 0; j--) value = mod(value * BigInt(id) + a[j]);
    shares.push({ id, share: value });
  }
  return {
    shares,
    groupPublicKey: curve.pointFromScalar(s),
    // One commitment per coefficient, so a participant can check its own share
    // the way a Feldman handout is checked. Same shape as `shares.js`, and for
    // the same reason: a dealer who cut two polynomials is caught before
    // anybody tries to sign with the result.
    commitments: a.map((v) => curve.pointFromScalar(v)),
  };
}
