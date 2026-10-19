// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE SHARE, SEALED TO ONE SIGNER NODE.
//
// 23.1 step 2 in full: the player "splits P with verifiable secret sharing
// (Shamir, threshold 5-of-7) and ENCRYPTS ONE SHARE TO EACH
// SETTLEMENT-COMMITTEE MEMBER". `handout.js` did the first half and said so
// about the second: "anybody who reads a handout reads five shares and rebuilds
// P... A build that pays sats must not use this file as it stands." Measured
// before this file existed, against a running daemon: a stranger holding only
// the public `vss_shares_ref` read all seven shares and reconstructed the
// preimage. This is the missing half.
//
// WHY IT IS THE WHOLE OF THE 5-OF-7 PROPERTY. A settle IS the release of the
// preimage. If every signer node - or every passer-by - can read five shares, then
// counting to five before reconstructing is a formality nobody is bound by.
// Secrecy is not a hardening pass on top of the threshold; it is what makes
// the threshold mean anything.
//
// THE CURVE IS INJECTED, like every other curve operation this package needs:
// `packages/protocol` carries none, so the caller brings `ecdhShared`. The
// cipher is AES-GCM through WebCrypto, which Node and every browser already
// have - the dealer is a page and the openers are daemons, and a construction
// only one of them can run is not a construction.
//
// THE NONCE IS DERIVED, NOT DRAWN. A random nonce would have to travel on the
// wire and would make the handout - and therefore its id, and therefore the
// `vss_shares_ref` inside a signed entry - different on every re-encode of the
// same deal. It is a tagged hash of the shared secret and the signer node, so it is
// unique per (ephemeral key, signer node) exactly as a nonce must be, and the seal is
// a function of its inputs.
import { TAG, VSS_SEALED_BYTES, VSS_NONCE_BYTES } from './constants.js';
import { taggedHash, toHex } from './hash.js';
import { scalarTo32, scalarFrom32, FIELD } from './shares.js';

export { VSS_SEALED_BYTES };

const subtle = () => {
  const c = globalThis.crypto;
  if (!c || !c.subtle)
    throw new Error('this runtime has no WebCrypto, so it can neither seal a share nor open one');
  return c.subtle;
};

/**
 * The key and the nonce one signer node's share is sealed under.
 *
 * The signer node number is in both, so two signer nodes that somehow shared an ECDH secret
 * would still not share a key - and a share cannot be lifted from one signer node's
 * envelope into another's, because the envelope only opens under its own signer node.
 */
function keyAndNonce(shared, signerNode) {
  const context = new Uint8Array([...shared, (signerNode >> 8) & 0xff, signerNode & 0xff]);
  return {
    key: taggedHash(TAG.vssShareKey, context),
    nonce: taggedHash(TAG.vssShareNonce, context).subarray(0, VSS_NONCE_BYTES),
  };
}

/**
 * A SIGNER NODE IS 1..65535, because two bytes of it go into the key and the nonce. Measured before this check: signer node
 * 65537 sealed to the very bytes of signer node 1 under the same keys - one AES-GCM key and nonce for two shares.
 */
const signerNodeRefusal = (signerNode) => (Number.isInteger(signerNode) && signerNode >= 1 && signerNode <= 0xffff ? null
  : `signer node ${signerNode} is not one of 1..65535`);

const aes = async (raw, use) =>
  subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, [use]);

/**
 * SEAL ONE SHARE FOR ONE SIGNER NODE.
 *
 * `ephemeralSecret` is the dealer's, one per handout: the signer nodes each learn a
 * different shared secret from it and none of them learns another's.
 */
export async function sealShare({ value, signerNode, signerNodePubkey, ephemeralSecret, curve }) {
  if (typeof value !== 'bigint' || value < 0n || value >= FIELD)
    throw new Error('that share is not a scalar of the group');
  if (!(signerNodePubkey instanceof Uint8Array) || signerNodePubkey.length !== 32)
    throw new Error('a share is sealed to a signer node\'s 32-byte key, and that is not one');
  const refused = signerNodeRefusal(signerNode);
  if (refused) throw new Error(refused);
  const shared = curve.ecdhShared(ephemeralSecret, signerNodePubkey);
  const { key, nonce } = keyAndNonce(shared, signerNode);
  const sealed = await subtle().encrypt({ name: 'AES-GCM', iv: nonce },
    await aes(key, 'encrypt'), scalarTo32(value));
  return new Uint8Array(sealed);
}

/**
 * OPEN THE ONE SHARE ADDRESSED TO THIS SIGNER NODE.
 *
 * A wrong key does not decrypt to nonsense - it does not decrypt at all,
 * because GCM authenticates. That is why the refusal here can be by name: a
 * signer node that cannot open its envelope knows it, rather than checking a garbage
 * scalar against the commitments and calling the dealer crooked.
 */
export async function openShare({ sealed, signerNode, secret, ephemeralPubkey, curve }) {
  if (!(sealed instanceof Uint8Array) || sealed.length !== VSS_SEALED_BYTES)
    return { ok: false, why: `a sealed share is ${VSS_SEALED_BYTES} bytes and that is ${sealed ? sealed.length : 'nothing'}` };
  const refused = signerNodeRefusal(signerNode);
  if (refused) return { ok: false, why: refused };
  // A KEY THAT IS NOT A POINT IS REFUSED BY NAME, not thrown: measured before, an ephemeral key of 32 x 0xff made the
  // curve's "invalid x" escape from here, and the opener stopped instead of refusing the handout or answer that carried it.
  let shared;
  try { shared = curve.ecdhShared(secret, ephemeralPubkey); } catch (e) {
    return { ok: false, why: `the ephemeral key ${ephemeralPubkey instanceof Uint8Array ? toHex(ephemeralPubkey) : String(ephemeralPubkey)} is not a curve point: ${e && e.message ? e.message : e}` };
  }
  const { key, nonce } = keyAndNonce(shared, signerNode);
  let plain;
  try {
    plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonce },
      await aes(key, 'decrypt'), sealed));
  } catch {
    return { ok: false, why: `signer node ${signerNode}'s share does not open under this key: it was sealed to somebody else` };
  }
  if (plain.length !== 32)
    return { ok: false, why: 'that envelope held something other than a share' };
  return { ok: true, share: { signerNode, value: scalarFrom32(plain) } };
}

/** For a refusal that wants to name what it could not open. */
export const sealedName = (sealed) => toHex(sealed).slice(0, 16);
