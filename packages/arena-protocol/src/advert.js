// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A node advertisement: who a node is, and where to reach it.
//
// WHY IT IS ON THE CHAIN AT ALL. Section 25.1 is blunt about the difference
// between finding a round and finding the nodes: "Finding a ROUND is not
// authoritative: project website, community sites, a direct link, a QR code,
// or a copied round_id... Finding the NODES is a different matter and is not
// left open: it is chain state."
//
// So the four steps of its table are answered like this: a round comes from a
// link and carries nothing; which nodes count is the bond outputs confirmed
// and unspent at `census_height`; which are on the committee is arithmetic,
// already in `sortition.js`; and WHERE TO REACH THEM is this object, carried
// by the bond funding transaction. There is no directory, no relay network and
// no seed list belonging to this protocol, and this is the piece that makes
// that possible rather than merely stated.
//
// IT IS NOT WHAT MAKES A NODE ELIGIBLE. Section 5A.1: "The advertisement is
// not what makes a node eligible. The bond output is. The advertisement is the
// body that the bond output commits to, so that chain data alone identifies
// both the node and its terms." That is why `bondOutpoint` is mandatory here -
// the object points back at the thing that gives it weight - and why the
// commitment lives in `chain.js` rather than here.
//
// THE SIGNATURE SITS BESIDE IT, as it does for a checkpoint and a receipt, and
// for the same reason twice over. Inside, it would be covered by `advertId`,
// so the id of an advertisement would change the moment it was signed - and
// the bond output commits to the BODY, which is fixed when the funding
// transaction is built. Section 5A.1 lists `signature` among the fields; this
// keeps it adjacent so the commitment and the id are both stable.
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_ADVERT, TAG, ROLES, roleByte } from './constants.js';

/** A Fedimint guardian's broadcast key: a compressed secp256k1 point. */
export const GUARDIAN_KEY_BYTES = 33;

const guardianBytesOrder = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
const compareGuardian = (a, b) =>
  guardianBytesOrder(a.federationId, b.federationId) || guardianBytesOrder(a.guardianKey, b.guardianKey);

// A GUARDIAN IS SAID BY ITS NODE (§5A.1 v4.6.4; §23A.2, one node is one guardian - RULED 2026-09-26 22:54): whether
// this node is willing to hold custody as a guardian, and the fedimintd API endpoint the client and the seats use. Both
// or neither: capable needs a ws:// or wss:// endpoint, not capable needs the empty string. An advert that says nothing
// about it (the field left out) is a node that is not a guardian.
function guardianRole(capable, endpoint) {
  if (capable !== 0 && capable !== 1) throw new Error(`guardian_capable is 0 or 1, not ${capable}`);
  if (typeof endpoint !== 'string') throw new Error('guardian_endpoint is a string');
  if (capable === 1 && !/^wss?:\/\/\S+$/.test(endpoint))
    throw new Error(`a guardian-capable node names a ws:// or wss:// guardian_endpoint, not "${endpoint}"`);
  if (capable === 0 && endpoint !== '') throw new Error('a node that is not guardian-capable names no guardian_endpoint');
}

export function encodeAdvert(a) {
  const w = new Writer();
  w.u8(TYPE_ADVERT);
  w.u16(PROTOCOL_VERSION);

  w.bytes32(a.nodePubkey);

  // SELF-DECLARED and marked as such by section 5A.13, so it is carried as a
  // string and never treated as proof of anything.
  w.str(a.operatorId);

  w.vec([...a.protocolVersions].sort((x, y) => x - y), (v, ww) => ww.u16(v));
  w.vec([...a.roles].sort(), (r, ww) => ww.u8(roleByte(r)),
        { sortedBy: (x, y) => (x < y ? -1 : x > y ? 1 : 0) });

  // The endpoint is the whole point of the object. It is fixed for the life of
  // the bond: section 25.1 says a server move means a new funding transaction
  // and new confirmations, "and the two cannot both be had: anything that
  // makes an address cheap to change is something outside the chain that must
  // be running".
  w.str(a.endpoint);
  w.str(a.region);
  w.u8(a.capacityClass);

  w.bytes32(a.softwareHash);
  w.u32(a.settlementCapabilities);
  w.u32(a.lightningCapabilities);

  // MANDATORY (5A.1): the census entry itself. Without it an advertisement
  // says where to reach somebody with no way to say which bond gives them
  // standing.
  w.bytes32(a.bondTxid);
  w.u32(a.bondVout);
  w.u16(a.bondScriptTemplateVersion);
  // TEMPLATE 2 CARRIES ITS OWN MATURITY (5A.3B): the absolute height in its recovery leaf, so a reader can
  // rebuild the output key from the body alone. Only template 2 writes it: a template-1 body is byte for byte what it
  // was, so the bonds already on chain keep their ids.
  if (a.bondScriptTemplateVersion === 2) {
    if (!Number.isInteger(a.bondMaturityHeight) || a.bondMaturityHeight < 1 || a.bondMaturityHeight >= 500000000)
      throw new Error(`a template-2 advertisement names its bond_maturity_height as a block height, not ${a.bondMaturityHeight}`);
    w.u32(a.bondMaturityHeight);
  } else if (a.bondMaturityHeight !== undefined) {
    throw new Error(`template ${a.bondScriptTemplateVersion} carries no bond_maturity_height`);
  }

  w.bytes32(a.payoutPubkey);

  // WHICH FEDERATIONS THIS OPERATOR IS A GUARDIAN OF, 5A.1 (v4.6.2): "(federation_id,
  // guardian peer key) this operator runs". A paying round's federation is
  // valid only if its threshold of guardians are bonded census nodes that say
  // so here (§23.6, P3) - otherwise a creator names a federation that is all
  // his. The key is the guardian's broadcast key, Fedimint's
  // secp256k1::PublicKey: 33 bytes. Sorted by federation, then key, asserted.
  // Carried in the signed body the bond commits to, so it changes with a new
  // bond or not at all. Added before the first bond outside regtest exists.
  w.vec(a.guardianOf, (g, ww) => { ww.bytes32(g.federationId); ww.bytes(g.guardianKey, GUARDIAN_KEY_BYTES); },
    { sortedBy: compareGuardian });
  // WHETHER THIS NODE IS A GUARDIAN, AND WHERE (§5A.1 v4.6.4), in the signed body - so under the node's signature.
  const capable = a.guardianCapable === undefined ? 0 : a.guardianCapable === true ? 1 : a.guardianCapable === false ? 0 : a.guardianCapable;
  const guardianEndpoint = a.guardianEndpoint === undefined ? '' : a.guardianEndpoint;
  guardianRole(capable, guardianEndpoint);
  w.u8(capable);
  w.str(guardianEndpoint);
  // THE GAMES THIS NODE HOSTS (§5A.1 hosted_games[], §0A.4), opt-in like its roles: the game ids it plays,
  // sorted and asserted, inside the signed body the bond commits to - so a change of the list is an advertisement update
  // (advert-update.js), never a new bond. The game/verify committee of a round is drawn only from the nodes whose list
  // holds the round's game. [] hosts none; nothing is implied.
  if (!Array.isArray(a.hostedGames) || !a.hostedGames.every((g) => g instanceof Uint8Array && g.length === 32))
    throw new Error('an advertisement names the games its node hosts (hosted_games, 32-byte game ids; [] for none)');
  for (let i = 1; i < a.hostedGames.length; i++)
    if (compareGameIds(a.hostedGames[i - 1], a.hostedGames[i]) >= 0) throw new Error('hosted_games is not sorted or names a game twice');
  w.vec(a.hostedGames, (g, ww) => ww.bytes32(g));
  w.u64(a.timestamp);
  // STEPPING OUT WITHOUT UNBONDING (§5A.3, RULED 2026-09-28): `serving = false`, published as an advertisement
  // update, takes the node out of every census from that update's block on - its bond untouched. Written only when false, one
  // marker byte last: "serving" is no bytes, so every advertisement before this keeps its bytes and the hash its bond committed to.
  // THE NODE'S DECLARED SCALARS (§27A.2): its preferred bond_min and proposal deposit - "declaring it must bind the
  // declarer" - over which the census takes the bond-weighted median. 17 bytes after their marker, before serving; none declared is
  // no bytes, so every advertisement before this keeps its bytes.
  if (a.declares !== undefined && a.declares !== null) {
    const d = a.declares;
    if (typeof d.bondMinSats !== 'bigint' || typeof d.proposalDepositSats !== 'bigint' || d.bondMinSats < 0n || d.proposalDepositSats < 0n)
      throw new Error('a node declares bond_min and proposal_deposit in BigInt sats');
    w.u8(DECLARES_MARKER); w.u64(d.bondMinSats); w.u64(d.proposalDepositSats);
  }
  // THE OWNER'S EMERGENCY KEY (§23A.5a, protocol 17): its 32-byte public key after its marker, after the declared scalars and before
  // serving; none is no bytes, so every advertisement before this keeps its bytes. A request it signs takes the offline node out.
  if (a.emergencyPubkey !== undefined && a.emergencyPubkey !== null) {
    if (!(a.emergencyPubkey instanceof Uint8Array) || a.emergencyPubkey.length !== 32) throw new Error('an emergency key is a 32-byte public key');
    w.u8(EMERGENCY_MARKER); w.bytes32(a.emergencyPubkey);
  }
  if (a.serving !== undefined && a.serving !== true && a.serving !== false) throw new Error('serving is true or false');
  if (a.serving === false) w.u8(NOT_SERVING_MARKER);
  return w.finish();
}

/** The byte before a node's declared scalars (§27A.2), before serving. */
export const DECLARES_MARKER = 0x5d;
/** The byte before the owner's emergency key (§23A.5a, protocol 17), after the declared scalars, before serving. */
export const EMERGENCY_MARKER = 0x5e;
/** The last byte of an advertisement that steps its node out of the census (serving = false, §5A.3). */
export const NOT_SERVING_MARKER = 0x5f;

/** Two game ids in byte order; equal is not an order (a game is hosted once). */
function compareGameIds(x, y) {
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Whether an advertisement (or a census entry carrying its list) hosts this game. */
export function hostsGame(a, gameId) {
  return !!(a && Array.isArray(a.hostedGames) && gameId instanceof Uint8Array
    && a.hostedGames.some((g) => compareGameIds(g, gameId) === 0));
}

export function decodeAdvert(bytes) {
  const r = new Reader(bytes);
  const type = r.u8();
  if (type !== TYPE_ADVERT) throw new Error('not an advertisement: type ' + type);
  const version = r.u16();
  if (!speaksVersion(version)) throw new Error('unknown protocol version');

  const a = {
    nodePubkey: r.bytes32(),
    operatorId: r.str(),
    protocolVersions: r.vec((rr) => rr.u16()),
    roles: r.vec((rr) => {
      const i = rr.u8();
      if (i < 0 || i >= ROLES.length) throw new Error('unknown role index ' + i);
      return ROLES[i];
    }),
    endpoint: r.str(),
    region: r.str(),
    capacityClass: r.u8(),
    softwareHash: r.bytes32(),
    settlementCapabilities: r.u32(),
    lightningCapabilities: r.u32(),
    bondTxid: r.bytes32(),
    bondVout: r.u32(),
    bondScriptTemplateVersion: r.u16(),
  };
  if (a.bondScriptTemplateVersion === 2) a.bondMaturityHeight = r.u32();
  Object.assign(a, {
    payoutPubkey: r.bytes32(),
    guardianOf: r.vec((rr) => ({ federationId: rr.bytes32(), guardianKey: rr.bytes(GUARDIAN_KEY_BYTES) })),
  });
  const capable = r.u8();
  const guardianEndpoint = r.str();
  guardianRole(capable, guardianEndpoint);
  a.guardianCapable = capable === 1;
  a.guardianEndpoint = guardianEndpoint;
  a.hostedGames = r.vec((rr) => rr.bytes32());
  for (let i = 1; i < a.hostedGames.length; i++)
    if (compareGameIds(a.hostedGames[i - 1], a.hostedGames[i]) >= 0) throw new Error('hosted_games is not sorted or names a game twice');
  a.timestamp = r.u64();
  // the declared scalars (17 bytes), the emergency key (33) and serving = false (1), each only when written, in that order
  const left = bytes.length - r.at;
  if ([17, 18, 50, 51].includes(left) && bytes[r.at] === DECLARES_MARKER) { r.u8(); a.declares = { bondMinSats: r.u64(), proposalDepositSats: r.u64() }; }
  const left2 = bytes.length - r.at;
  if ((left2 === 33 || left2 === 34) && bytes[r.at] === EMERGENCY_MARKER) { r.u8(); a.emergencyPubkey = r.bytes32(); }
  // serving = false only when it says so; a serving node's advertisement decodes as it always did (no field)
  if (r.at === bytes.length - 1 && bytes[r.at] === NOT_SERVING_MARKER) { r.u8(); a.serving = false; }
  if (r.at !== bytes.length) throw new Error('trailing bytes after the advertisement');
  return a;
}

/**
 * What the bond output commits to.
 *
 * `TAG.advert` was reserved in `constants.js` before anything used it; this is
 * the object it was reserved for.
 */
export const advertId = (a) => taggedHash(TAG.advert, encodeAdvert(a));

/** The 64 bytes the node's own key puts beside it, as for every other object here. */
export const ADVERT_SIGNATURE_BYTES = 64;

export function joinSignedAdvert(bytes, signature) {
  if (signature.length !== ADVERT_SIGNATURE_BYTES)
    throw new Error(`a signature is ${ADVERT_SIGNATURE_BYTES} bytes, got ${signature.length}`);
  const out = new Uint8Array(bytes.length + ADVERT_SIGNATURE_BYTES);
  out.set(bytes, 0);
  out.set(signature, bytes.length);
  return out;
}

export function splitSignedAdvert(bytes) {
  if (bytes.length <= ADVERT_SIGNATURE_BYTES)
    throw new Error(`a signed advertisement is longer than ${ADVERT_SIGNATURE_BYTES} bytes`);
  return {
    body: bytes.subarray(0, bytes.length - ADVERT_SIGNATURE_BYTES),
    signature: bytes.subarray(bytes.length - ADVERT_SIGNATURE_BYTES),
  };
}
