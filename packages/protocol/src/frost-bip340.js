// THE SAME THRESHOLD, IN THE SIGNATURE BITCOIN ACTUALLY CHECKS.
//
// `frost.js` reproduces RFC 9591 byte for byte, which proves the algebra -
// interpolation over the signer set, binding factors, share aggregation. What
// it does not produce is a signature any Bitcoin node will accept: that suite
// hashes its challenge under its own context string, serialises R as a 33-byte
// compressed point, and has no even-y rule. A pool wallet whose spends nobody
// can verify protects nothing.
//
// So this is the same protocol over BIP-340's conventions:
//
//   the key      32 bytes, x-only, the point with EVEN y
//   the nonce    R is taken x-only too, so its parity has to be fixed
//   the challenge  taggedHash("BIP0340/challenge", R.x || P.x || msg)
//   the signature  R.x || z, 64 bytes, checked by any BIP-340 verifier
//
// TWO PARITY FIXES AND ONLY ONE OF THEM IS AT SIGNING TIME. The group key is
// normalised when it is dealt - a dealer whose point came out odd negates the
// secret, exactly as BIP-340 key generation does - so by the time anybody
// signs, P is even and stays even. R cannot be normalised in advance because
// it depends on the nonces of whoever turned up, so every signer computes the
// group commitment from the public commitment list, sees the same parity, and
// negates its own two nonces if it is odd. Both decisions are made from public
// data, which is why no signer has to be told which way to go.
//
// THE VERIFIER IS NOT IN THIS FILE, deliberately. A signature checked by the
// code that built it is checked by its own opinion; this one is handed to
// BIP-340's verifier, which is the same one a taproot output uses.
import { taggedHash, bytesToBigInt, toHex } from './hash.js';
import { FIELD, scalarTo32, scalarFrom32 } from './shares.js';
import { bindingFactors, groupCommitment, interpolatingValue, nonceGenerate } from './frost.js';

/**
 * THE TAPROOT CIPHERSUITE'S CONTEXT STRING - Zcash Foundation's frost-secp256k1-tr
 * (v3.0.0). RFC 9591's secp256k1 suite is `frost.js`'s CONTEXT; the two differ in
 * H1, H3, H4 and H5 by this string and in H2 by BIP-340's challenge. Signing
 * under it reproduces the ZF vectors byte for byte (zf-frost-tr.test.js).
 */
export const TR_CONTEXT = 'FROST-secp256k1-SHA256-TR-v1';

/** A nonce under the taproot suite's H3: what every BIP-340 signer here draws. */
export const nonceGenerate340 = (randomBytes, share) => nonceGenerate(randomBytes, share, TR_CONTEXT);

/** R.x || z. */
export const SIGNATURE_BYTES = 64;

const mod = (n) => ((n % FIELD) + FIELD) % FIELD;
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** A compressed point's x, and whether its y is even. Both are in the encoding. */
export const xOnly = (point) => point.subarray(1);
export const hasEvenY = (point) => point[0] === 0x02;

/** BIP-340's challenge, which is the whole reason this file is not `frost.js`. */
export const challenge340 = (rx, px, message) =>
  mod(bytesToBigInt(taggedHash('BIP0340/challenge', cat(rx, px, message))));

/**
 * NORMALISE A GROUP SECRET SO ITS POINT HAS EVEN Y.
 *
 * BIP-340 keys are x-only, so a secret and its negation name the same key and
 * only one of them signs for it. Done once, at dealing time, so that signing
 * has one parity problem instead of two.
 */
export function evenGroupSecret(secret, curve) {
  const s = secret instanceof Uint8Array ? scalarFrom32(secret) : secret;
  if (typeof s !== 'bigint' || s <= 0n || s >= FIELD)
    throw new Error('a group secret is a non-zero scalar of the group');
  const point = curve.pointFromScalar(s);
  return hasEvenY(point) ? { secret: s, point } : { secret: FIELD - s, point: curve.pointFromScalar(FIELD - s) };
}

/**
 * ONE SIGNER'S SHARE OF A BIP-340 SIGNATURE.
 *
 * `groupPublicKey` is the 33-byte compressed point, because the binding
 * factors of RFC 9591 are computed over the serialised element and this
 * implementation does not get to choose a different one. What goes into the
 * CHALLENGE is the x-only half, because that is what a verifier will hash.
 */
export function signShare340({ id, share, groupPublicKey, nonces, message, commitments, curve }) {
  if (!hasEvenY(groupPublicKey))
    throw new Error('that group key has odd y: normalise the secret when it is dealt, not here');
  const factors = bindingFactors({ groupPublicKey, commitments, message, context: TR_CONTEXT });
  const mine = factors.find((f) => String(f.id) === String(id));
  if (!mine) throw new Error(`participant ${id} did not commit to this signature`);

  const commitment = groupCommitment({ commitments, factors, curve });
  // EVERY SIGNER SEES THE SAME PARITY, because the commitment list is public
  // and so is the sum of it. Nobody has to be told which way to go.
  const flip = hasEvenY(commitment) ? 1n : -1n;
  const hiding = mod(flip * nonces.hiding);
  const binding = mod(flip * nonces.binding);

  const lambda = interpolatingValue(commitments.map((c) => c.id), id);
  const c = challenge340(xOnly(commitment), xOnly(groupPublicKey), message);
  return mod(hiding + mod(binding * mine.factor) + mod(mod(lambda * share) * c));
}

/** R.x from the commitments, z as the plain sum: a 64-byte BIP-340 signature. */
export function aggregate340({ commitments, message, groupPublicKey, shares, curve }) {
  const factors = bindingFactors({ groupPublicKey, commitments, message, context: TR_CONTEXT });
  const commitment = groupCommitment({ commitments, factors, curve });
  let z = 0n;
  for (const s of shares) z = mod(z + s);
  return {
    commitment,
    z,
    signature: cat(xOnly(commitment), scalarTo32(z)),
    publicKey: xOnly(groupPublicKey),
  };
}

/**
 * WHO IS ALLOWED TO SIGN AT ALL, and it is a refusal rather than a guess.
 *
 * Below the threshold there is nothing to build: the interpolating value of a
 * signer depends on the whole signing set, so a set of four cannot even
 * compute the contributions a fifth would need. Refusing by name here means an
 * operator learns that four of seven turned up, rather than getting bytes that
 * fail somewhere else.
 */
export function enoughToSign({ commitments, needed }) {
  if (!Array.isArray(commitments) || commitments.length < needed)
    return {
      ok: false,
      why: `${commitments ? commitments.length : 0} of ${needed} signers: a pool nobody can move `
        + 'stays where it is',
    };
  const seen = new Set(commitments.map((c) => String(c.id)));
  if (seen.size !== commitments.length)
    return { ok: false, why: 'a signing set naming one participant twice is not a set' };
  return { ok: true, why: `${commitments.length} of ${needed} signers` };
}

/** For a refusal that wants to name the key it could not move. */
export const keyName = (point) => toHex(xOnly(point)).slice(0, 16);

/**
 * IS ONE SIGNER'S SHARE WHAT ITS PUBLIC SHARE SAYS IT MUST BE?
 *
 * RFC 9591 section 5.4's verify_signature_share, over BIP-340:
 *   z_i.G = s.(D_i + rho_i.E_i) + c.lambda_i.Y_i,  s = +1, or -1 if R is odd,
 * the same sign `signShare340` applies to the nonces. `publicShare` is Y_i, the
 * point of the very share the seat signs with. A payout that does not verify
 * checks each share with this to NAME the one that broke it (pool-bad-share).
 */
export function verifyShare340({ id, share, publicShare, groupPublicKey, message, commitments, curve }) {
  if (typeof share !== 'bigint' || share <= 0n || share >= FIELD) return false;
  const factors = bindingFactors({ groupPublicKey, commitments, message, context: TR_CONTEXT });
  const mine = factors.find((f) => String(f.id) === String(id));
  const own = commitments.find((c) => String(c.id) === String(id));
  if (!mine || !own) return false;
  const R = groupCommitment({ commitments, factors, curve });
  const sign = hasEvenY(R) ? 1n : FIELD - 1n;
  const c = challenge340(xOnly(R), xOnly(groupPublicKey), message);
  const lambda = interpolatingValue(commitments.map((x) => x.id), id);
  try {
    const rhs = curve.combinePoints([
      { point: own.hiding, coefficient: sign },
      { point: own.binding, coefficient: mod(sign * mine.factor) },
      { point: publicShare, coefficient: mod(c * lambda) },
    ]);
    return toHex(curve.pointFromScalar(share)) === toHex(rhs);
  } catch { return false; }
}
