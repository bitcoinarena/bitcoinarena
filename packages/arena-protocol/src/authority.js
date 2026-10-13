// 27A.4: WHICH DONATION SET IS THE NETWORK'S, FROM WHEN, AND WHO SAID SO.
//
// `donation.js` answers a different question and answers it well: given a list
// of payees and shares, does it stand, and what is each owed. It cannot answer
// this one. A list that stands is a list ANYBODY can write - the bytes are
// checked against their own shares and against nothing else - so before this
// file a thief and the network's own operator published objects that were
// indistinguishable.
//
// The section gives the object:
//
//     DonationSet {
//       network_id
//       serial          monotonic; the highest validly signed one wins
//       entries[]       lnurl + share_bps, summing to 10000
//       valid_from      block height
//       signature       by donation_authority_pubkey
//     }
//
// Four of those five fields had no code. What each one is for, in the order
// they stop a different failure:
//
//   network_id   27A.9: "the trust anchor is the client's own built-in
//                network_id, NEVER A VALUE FROM THE CONTRACT". A set for
//                another network is somebody else's payees, and forking the
//                code to write your own address in "has not captured the
//                donations - you have left".
//   serial       Two sets and no order is two nodes paying different people.
//                The highest validly signed one wins, and an older one
//                published later changes nothing - that is what "cannot be
//                rolled back" means when the publication is on a chain that
//                anybody can add to.
//   valid_from   A set with no start applies from whenever each node happened
//                to see it, which is not a time two nodes can agree on.
//   signature    The whole point. One key signs this object and nothing else
//                in the protocol.
//
// AND THE ROTATION, which is the half that is easy to leave for later and must
// not be. 27A.4's own row: authority stolen, "the thief signs a set with a
// higher serial pointing at their own LNURLs" - and the remedy is a rotation
// from the cold key, "no fork, the census survives". A revocation path nobody
// has exercised is a revocation path that does not work, so the rotation here
// is not a field: it is checked, it is ordered, and from its `valid_from` the
// old key's sets are refused whatever serial they carry.
//
// WHAT THE KEYS CANNOT DO is not enforced here because it cannot be reached
// from here: 27A.4's exhaustive list - no pause, no fee, no threshold, no
// node, no round, no result, no player's money - is a statement about which
// objects carry an authority signature, and this file is the only one that
// checks for one. Nothing else in the protocol reads these keys, and that is
// the enforcement.
//
// NO CURVE, like every other file in this package: `verify` is injected, and
// the caller one package over brings the real BIP-340. NO MONEY: nothing here
// pays an LNURL, and what a donation costs a player is 6e's letter, not this
// one.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import {
  PROTOCOL_VERSION, speaksVersion, TYPE_SIGNED_DONATION_SET, TYPE_AUTHORITY_ROTATION, TAG,
} from './constants.js';
import { encodeDonationSet, decodeDonationSet, donationSetStands } from './donation.js';

/** The 64 bytes beside the object, as for every other signature in here. */
export const DONATION_SIGNATURE_BYTES = 64;

const isDonationBytes32 = (b) => b instanceof Uint8Array && b.length === 32;
const sameDonationBytes32 = (a, b) => a.every((x, i) => x === b[i]);

/**
 * THE BYTES THE AUTHORITY SIGNS.
 *
 * The recipients go in AS THE SET'S OWN ENCODING - `encodeDonationSet`, the
 * function 22A's id is taken over - and not as a second copy of the same
 * vector written out again here. A signed publication holding a differently
 * encoded version of the list would be an object whose signature covers bytes
 * that are not the set the Round Contract names, and then the network's
 * authority has endorsed one thing while the round binds another.
 *
 * That import also means a set that does not stand cannot be published: the
 * encoder refuses it, so there are no signed bytes naming shares that sum to
 * 9999.
 */
export function encodeDonationSetBody(set) {
  if (!isDonationBytes32(set.networkId)) throw new Error('a donation set names a 32-byte network');
  if (typeof set.serial !== 'bigint') throw new Error('a serial is a BigInt');
  if (set.serial < 0n) throw new Error('a serial cannot be negative');
  if (!Number.isInteger(set.validFrom) || set.validFrom < 0)
    throw new Error('valid_from is a block height');

  const entries = encodeDonationSet(set.recipients);
  const w = new Writer();
  w.u8(TYPE_SIGNED_DONATION_SET);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(set.networkId);
  w.u64(set.serial);
  w.u32(set.validFrom);
  w.u16(entries.length);
  w.bytes(entries);
  return w.finish();
}

export function decodeDonationSetBody(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_SIGNED_DONATION_SET) throw new Error('not a signed donation set');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const networkId = r.bytes32();
  const serial = r.u64();
  const validFrom = r.u32();
  const entries = r.bytes(r.u16());
  if (r.at !== bytes.length) throw new Error('trailing bytes after the donation set');
  // Through the set's own decoder, so a publication inherits every check the
  // list has: the shares, the duplicates, the mixed case, and the one byte
  // string a set is allowed to have.
  return { networkId, serial, validFrom, recipients: decodeDonationSet(entries) };
}

/** What a marked output commits to: H(DonationSet), 27A.4's publication. */
export const donationSetBodyId = (set) =>
  taggedHash(TAG.signedDonationSet, encodeDonationSetBody(set));

/**
 * THE COLD KEY'S ONLY SENTENCE.
 *
 *     AuthorityRotation { network_id, serial, new_authority, valid_from,
 *                         signature by donation_recovery_pubkey }
 *
 * Its own serial, "monotonic, separate from the donation set's", because the
 * two objects are ordered against their own kind: a rotation is not newer than
 * a set and the question never arises.
 */
export function encodeAuthorityRotation(rotation) {
  if (!isDonationBytes32(rotation.networkId)) throw new Error('a rotation names a 32-byte network');
  if (typeof rotation.serial !== 'bigint') throw new Error('a serial is a BigInt');
  if (rotation.serial < 0n) throw new Error('a serial cannot be negative');
  if (!isDonationBytes32(rotation.newAuthority))
    throw new Error('a rotation names a 32-byte authority key');
  if (!Number.isInteger(rotation.validFrom) || rotation.validFrom < 0)
    throw new Error('valid_from is a block height');

  const w = new Writer();
  w.u8(TYPE_AUTHORITY_ROTATION);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(rotation.networkId);
  w.u64(rotation.serial);
  w.bytes32(rotation.newAuthority);
  w.u32(rotation.validFrom);
  return w.finish();
}

export function decodeAuthorityRotation(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_AUTHORITY_ROTATION) throw new Error('not an authority rotation');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const rotation = {
    networkId: r.bytes32(),
    serial: r.u64(),
    newAuthority: r.bytes32(),
    validFrom: r.u32(),
  };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the rotation');
  return rotation;
}

export const authorityRotationId = (rotation) =>
  taggedHash(TAG.authorityRotation, encodeAuthorityRotation(rotation));

/**
 * ONE PUBLICATION, CHECKED. Answered rather than thrown, like every other
 * decision in this package: a malformed object from a stranger is a refusal.
 *
 * `signature` is not in the encoded body and cannot be - the id is what the
 * key signs, so an object whose bytes included its own signature could not be
 * signed at all. It rides beside it, as the advertisement's does.
 */
function signedBy(object, { id, key, signature, verify, what }) {
  if (!isDonationBytes32(key)) return { ok: false, why: `no ${what} key to check that against` };
  if (!(signature instanceof Uint8Array) || signature.length !== DONATION_SIGNATURE_BYTES)
    return { ok: false, why: `a ${what} signature is ${DONATION_SIGNATURE_BYTES} bytes` };
  if (typeof verify !== 'function')
    return { ok: false, why: 'no verifier: this package carries no curve' };

  let digest;
  try { digest = id(object); }
  catch (e) { return { ok: false, why: e.message }; }

  let ok = false;
  try { ok = !!verify(signature, digest, key); }
  catch { ok = false; }
  return ok
    ? { ok: true, id: digest, why: `signed by ${toHex(key).slice(0, 16)}` }
    : { ok: false, id: digest, why: `that ${what} signature is not ${toHex(key).slice(0, 16)}'s` };
}

export const donationSetSignedBy = (set, { authority, verify }) =>
  signedBy(set, {
    id: donationSetBodyId, key: authority, signature: set && set.signature,
    verify, what: 'authority',
  });

export const rotationSignedBy = (rotation, { recovery, verify }) =>
  signedBy(rotation, {
    id: authorityRotationId, key: recovery, signature: rotation && rotation.signature,
    verify, what: 'recovery',
  });

/**
 * THE HIGHEST VALIDLY SIGNED ONE WINS, and equivocation at a serial loses that
 * serial rather than picking a winner.
 *
 * 27A.4 orders publications by serial and says nothing about two of them
 * carrying the same one, because an honest authority does not do that. A
 * dishonest or duplicated key does, and then "the highest validly signed one"
 * names two different objects - so a rule is needed, and the choice is between
 * two deterministic answers.
 *
 * PICKING ONE BY ITS BYTES was rejected. It would pay whichever list happened
 * to hash lower, which is a coin flip decided by a party who has already shown
 * they will sign twice - and it would do it silently.
 *
 * SO A CONTESTED SERIAL IS UNUSABLE and the search falls back to the highest
 * serial below it that is not. Every node reaches the same answer from the
 * same objects, nobody is paid on a signature the authority contradicted, and
 * the network lands exactly where 27A.4's "both lost" row already puts it:
 * "the set freezes at its last published serial and every donation keeps going
 * where it was already going". A frozen set is a bounded failure. Paying a
 * thief is not.
 */
function bestBySerial(accepted, idOf) {
  const bySerial = new Map();
  for (const item of accepted) {
    const list = bySerial.get(item.serial);
    if (list) list.push(item);
    else bySerial.set(item.serial, [item]);
  }

  const serials = [...bySerial.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const contested = [];
  for (const serial of serials) {
    const list = bySerial.get(serial);
    const ids = new Set(list.map((item) => toHex(idOf(item))));
    if (ids.size === 1) return { best: list[0], contested };
    contested.push(serial);
  }
  return { best: null, contested };
}

/**
 * WHO THE AUTHORITY IS AT A HEIGHT.
 *
 * 27A.4: "Published like the donation set. From `valid_from`, sets signed by
 * the old authority are rejected and only the new one is accepted, WHATEVER
 * SERIAL THE OLD KEY PUBLISHES." So the answer is a function of the height a
 * node is asking about and not of when anything arrived, and it is the genesis
 * key until a rotation is in force.
 *
 * ROTATIONS ARE CHECKED AGAINST THE GENESIS RECOVERY KEY AND ONLY IT. The
 * section's table is exhaustive - "recovery CAN name a new authority" - and
 * that is the whole list. A rotation that could name a new recovery key would
 * let one theft of the cold key close the door behind itself, which is the
 * fault the two-key split exists to prevent.
 */
export function authorityAt({
  networkId, authority, recovery, rotations = [], height, verify,
}) {
  const refused = [];
  if (!isDonationBytes32(authority)) throw new Error('a network has a 32-byte donation authority');
  if (!Number.isInteger(height) || height < 0) throw new Error('a height is a block height');

  const accepted = [];
  for (const [at, rotation] of rotations.entries()) {
    if (!rotation || !isDonationBytes32(rotation.networkId) || !sameDonationBytes32(rotation.networkId, networkId)) {
      refused.push(`rotation ${at} is for another network`);
      continue;
    }
    if (!Number.isInteger(rotation.validFrom) || rotation.validFrom > height) {
      refused.push(`rotation ${at} is not in force at ${height}`);
      continue;
    }
    const signed = rotationSignedBy(rotation, { recovery, verify });
    if (!signed.ok) {
      refused.push(`rotation ${at}: ${signed.why}`);
      continue;
    }
    accepted.push(rotation);
  }

  const { best, contested } = bestBySerial(accepted, authorityRotationId);
  for (const serial of contested)
    refused.push(`two different rotations are signed at serial ${serial}, so that serial is unusable`);

  return best
    ? {
      authority: best.newAuthority,
      serial: best.serial,
      rotated: true,
      validFrom: best.validFrom,
      refused,
      why: `the recovery key named ${toHex(best.newAuthority).slice(0, 16)} from height ${best.validFrom}`,
    }
    : {
      authority, serial: null, rotated: false, validFrom: 0, refused,
      why: 'no rotation is in force, so the genesis authority still signs',
    };
}

/**
 * AND THE ANSWER THE REST OF THE PROTOCOL WANTS: which recipients, at this
 * height, on this network.
 *
 * The refusals are returned rather than swallowed. A node that pays nobody
 * because every set it holds is for another network must be able to say so -
 * "no set is in force" and "I threw them all away" are different facts, and
 * only one of them is a bug.
 *
 * A ROTATION BLANKS THE LIST, and that is 27A.4's own reading rather than a
 * strictness of taste: "from `valid_from`, sets signed by the old authority
 * are rejected". Every set the old key signed dies with it, including the
 * honest ones it signed before the theft - so between a rotation and the new
 * authority's first publication this network has no set in force and pays
 * nobody.
 *
 * The alternative was measured and is worse: grandfathering what the old key
 * published before the rotation keeps the THIEF'S set alive too, because the
 * thief published before the rotation as well. A revocation that leaves the
 * stolen list in force is not a revocation.
 *
 * NO SET IN FORCE IS NOT AN ERROR. A network can run without one and 22A's
 * player donating nothing is unaffected: `splitDonation` already answers a
 * zero donation without judging a set at all. What must never happen is a set
 * being IN FORCE without a signature to point at, and that is what this
 * returns `ok` for.
 */
export function donationSetInForce({
  networkId, authority, recovery, sets = [], rotations = [], height, verify,
}) {
  if (!isDonationBytes32(networkId)) throw new Error('a network is a 32-byte id');
  const inForce = authorityAt({ networkId, authority, recovery, rotations, height, verify });
  const refused = [...inForce.refused];

  const accepted = [];
  for (const [at, set] of sets.entries()) {
    if (!set || !isDonationBytes32(set.networkId) || !sameDonationBytes32(set.networkId, networkId)) {
      refused.push(`set ${at} is for another network`);
      continue;
    }
    if (!Number.isInteger(set.validFrom) || set.validFrom > height) {
      refused.push(`set ${at} is not in force at ${height}`);
      continue;
    }
    // The list itself, before the key: a set that does not stand is not a set,
    // and saying so names the actual fault rather than reporting a signature
    // over bytes that could not be produced.
    const stands = donationSetStands(set.recipients);
    if (!stands.ok) {
      refused.push(`set ${at}: ${stands.why}`);
      continue;
    }
    const signed = donationSetSignedBy(set, { authority: inForce.authority, verify });
    if (!signed.ok) {
      refused.push(`set ${at}: ${signed.why}`);
      continue;
    }
    accepted.push(set);
  }

  const { best, contested } = bestBySerial(accepted, donationSetBodyId);
  for (const serial of contested)
    refused.push(`two different sets are signed at serial ${serial}, so that serial is unusable`);

  if (!best)
    return {
      ok: false, recipients: null, serial: null, validFrom: null,
      authority: inForce.authority, rotated: inForce.rotated, refused,
      why: sets.length
        ? `none of the ${sets.length} sets offered is in force at height ${height}`
        : 'this network has published no donation set',
    };

  return {
    ok: true,
    recipients: best.recipients,
    serial: best.serial,
    validFrom: best.validFrom,
    setId: donationSetBodyId(best),
    authority: inForce.authority,
    rotated: inForce.rotated,
    refused,
    why: `serial ${best.serial}, in force from height ${best.validFrom}, `
      + `${best.recipients.length} recipients`,
  };
}
