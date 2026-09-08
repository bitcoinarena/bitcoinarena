// THE LAST LINE OF 5A.1, CHECKED AT LAST.
//
// The advertisement ends with "signature - by node_pubkey over all of the
// above", and nothing has ever verified it. `chain.js` says so itself, in the
// list it hands back with every bond it recognises: "the advertisement
// signature (no curve in this package)". So a node could take a body off the
// chain, see that the bond output commits to it, and still not know that the
// key the body NAMES is the key that wrote it.
//
// WHAT THE SIGNATURE ADDS, AND WHAT IT DOES NOT. The commitment already binds
// this body to money: `H(NodeAdvertisement)` is in the funding transaction, so
// an attacker cannot swap the endpoint of a bond that is not theirs without
// spending it. The signature is the smaller claim that the node named is the
// author - the same claim a receipt or a result makes - and 5A.1 lists it, so
// a door that skipped it would be accepting a field the spec says to check.
//
// ED25519, UNDER node_pubkey. The same key that signs this daemon's receipts
// and its results, so no second curve is introduced by this door. The BOND key
// is secp256k1 and stays there: its link to the advertisement is the
// commitment, not this signature, and the two must not be confused - one says
// "this body is worth money", the other says "this body is mine".
//
// THE SIGNATURE STAYS BESIDE THE BODY, never inside it. `advert.js` argues it
// where it lives: inside, the signature would be covered by `advertId`, so the
// id would move the moment the body was signed - and the bond commits to the
// body as it was when the funding transaction was built.
import { ed25519 } from '@noble/curves/ed25519.js';
import { acceptAdvert } from '../../protocol/src/chain.js';
import { advertId, decodeAdvert, splitSignedAdvert } from '../../protocol/src/advert.js';

const hex = (b) => [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
const isZero = (b) => b.every((v) => v === 0);

/** What `acceptAdvert` could not look at once this door has looked at one. */
export const STILL_UNCHECKED = [
  'the bond script template (5A.3B: a taproot output hides it until spent)',
];

/**
 * ACCEPT AN ADVERTISEMENT, SIGNATURE AND ALL.
 *
 * Everything `acceptAdvert` checks - the transaction is in the block, an
 * output commits to this body, that output is a bond with something at stake -
 * and then the one thing it could not: the signature verifies under the key
 * the body names.
 *
 * Each failure is refused BY NAME. "Not accepted" is not a report anybody can
 * act on: an operator whose advertisement is refused needs to know whether
 * they signed with the wrong key, signed a different body, or pointed at a
 * transaction that is not theirs, and those are three different mistakes.
 */
export function acceptSignedAdvert({ transaction, signedAdvert, header, branch, position }) {
  const seen = acceptAdvert({ transaction, signedAdvert, header, branch, position });
  if (!seen.ok) return seen;

  if (!(seen.signature instanceof Uint8Array) || seen.signature.length !== 64)
    return { ok: false, why: 'that advertisement carries no signature to check' };

  // A KEY OF NOTHING AND A SIGNATURE OF NOTHING VERIFY EACH OTHER.
  //
  // Measured, not assumed: `ed25519.verify(zeros64, anything, zeros32)` returns
  // TRUE. Zero decodes to a point of small order and the equation closes
  // trivially, so an advertisement naming the zero key and carrying no
  // signature would be "signed by the node it names" - and `bondTransaction`
  // fills an unsigned body with exactly 64 zero bytes, calling them "a
  // signature that verifies under no key". They verify under one.
  //
  // Nobody holds the zero key, so nothing is lost by refusing it, and what is
  // gained is that "unsigned" cannot masquerade as signed. Both halves are
  // refused, because either alone is enough to be suspicious of.
  if (isZero(seen.nodePubkey))
    return { ok: false, why: 'that advertisement names the zero key, which nobody holds' };
  if (isZero(seen.signature))
    return { ok: false, why: 'that advertisement carries an empty signature' };

  // WHAT IS SIGNED IS THE TAGGED ID, as everywhere else in this protocol: a
  // signature over raw bytes can be replayed as a signature over a different
  // object that happens to encode the same way.
  const id = advertId(seen.advert);
  let ok = false;
  try { ok = ed25519.verify(seen.signature, id, seen.nodePubkey); } catch { ok = false; }
  if (!ok) {
    return {
      ok: false,
      why: `that advertisement is not signed by ${hex(seen.nodePubkey)}, the node it names`,
    };
  }

  return { ...seen, advertId: id, unchecked: STILL_UNCHECKED };
}

/**
 * THE SAME CHECK ON A BODY ALREADY IN HAND, for a caller holding a signed
 * advertisement and no block - the census walks blocks, a peer's directory
 * answer does not.
 *
 * It says nothing about a bond. A body that verifies is authored by the key it
 * names and NOTHING MORE: eligibility is the bond output's business (5A.2),
 * and a door that returned "ok" for a signature alone would be the gossip
 * census 4.6.1 removed.
 */
export function advertIsSigned(bytes) {
  let body, signature, advert;
  try {
    ({ body, signature } = splitSignedAdvert(bytes));
    advert = decodeAdvert(body);
  } catch (e) {
    return { ok: false, why: `that is not a signed advertisement: ${e.message}` };
  }

  // The same two: zeros verify each other, so an unsigned body naming the
  // zero key would pass a check that only asked ed25519.
  if (isZero(advert.nodePubkey))
    return { ok: false, why: 'that advertisement names the zero key, which nobody holds' };
  if (isZero(signature))
    return { ok: false, why: 'that advertisement carries an empty signature' };

  const id = advertId(advert);
  let ok = false;
  try { ok = ed25519.verify(signature, id, advert.nodePubkey); } catch { ok = false; }
  if (!ok) {
    return {
      ok: false,
      why: `that advertisement is not signed by ${hex(advert.nodePubkey)}, the node it names`,
    };
  }
  return { ok: true, advert, advertId: id, signedBy: advert.nodePubkey };
}
