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
import { PROTOCOL_VERSION, TYPE_ADVERT, TAG, ROLES, roleByte } from './constants.js';

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

  w.bytes32(a.payoutPubkey);
  w.u64(a.timestamp);
  return w.finish();
}

export function decodeAdvert(bytes) {
  const r = new Reader(bytes);
  const type = r.u8();
  if (type !== TYPE_ADVERT) throw new Error('not an advertisement: type ' + type);
  const version = r.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('unknown protocol version');

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
    payoutPubkey: r.bytes32(),
    timestamp: r.u64(),
  };
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
