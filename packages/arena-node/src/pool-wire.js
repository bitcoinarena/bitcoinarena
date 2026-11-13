// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A SIGNING ROUND PUTS ON THE WIRE, AND NOTHING ELSE GOES ON IT.
//
// Two shapes, both fixed-width, both readable by a node that trusts nothing
// about the sender. The asker names an OUTPUT and hands over a commitment
// list; the signer node answers with a commitment and then with a scalar. There is no
// sighash on this wire and no transaction: a signer node that could be handed either
// would be signing somebody else's arithmetic, which is the whole of what
// `pool-signing.js` refuses to do.
import { Writer, Reader } from '../../arena-protocol/src/encode.js';
import { scalarFrom32, scalarTo32 } from '../../arena-protocol/src/shares.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

/** txid, vout, value, and the script the output pays to. */
export const UTXO_BYTES = 32 + 4 + 8 + 34;
/** A participant id as FROST writes it, and its two nonce points. */
export const COMMITMENT_BYTES = 32 + 33 + 33;
export const SHARE_BYTES = 32;

export function encodeUtxo(utxo) {
  const w = new Writer();
  w.bytes32(utxo.txid);
  w.u32(utxo.vout);
  w.u64(utxo.value);
  w.bytes(utxo.script, 34);
  return w.finish();
}

export function decodeUtxo(bytes) {
  const r = new Reader(bytes);
  const utxo = { txid: r.bytes32(), vout: r.u32(), value: r.u64(), script: r.bytes(34) };
  r.end();
  return utxo;
}

/**
 * The id travels as FROST's own 32-byte scalar, not as a small integer, so the
 * bytes a signer node reads are the bytes that go into the binding factors.
 */
export function encodeCommitments(commitments) {
  const w = new Writer();
  for (const c of commitments) {
    w.bytes32(scalarTo32(BigInt(c.id)));
    w.bytes(c.hiding, 33);
    w.bytes(c.binding, 33);
  }
  return w.finish();
}

export function decodeCommitments(bytes) {
  if (bytes.length === 0 || bytes.length % COMMITMENT_BYTES !== 0)
    throw new Error(`a commitment list is a multiple of ${COMMITMENT_BYTES} bytes`);
  const r = new Reader(bytes);
  const out = [];
  for (let i = 0; i < bytes.length / COMMITMENT_BYTES; i++) {
    const id = scalarFrom32(r.bytes32());
    if (id <= 0n || id > 0xffffffffn)
      throw new Error('that is not a participant this committee could have');
    out.push({ id: Number(id), hiding: r.bytes(33), binding: r.bytes(33) });
  }
  r.end();
  return out;
}

/**
 * A PEER'S ANSWER AT A COMMIT DOOR (/forfeit-commit, /settle-commit, /send-commit), taken onto a signer list only when its two nonces are points
 * (kanban #2331, #2345, after #1807): decodeCommitments checks the id and the length, never the curve. One seat that answered under its own id with
 * 33 bytes no secp256k1 point has (x >= p, x off the curve, a bad prefix) went on the list, the asker's own share threw in groupCommitment, and with no
 * duplicate id to blame #leaveOut had nobody to drop - the seat stopped every forfeit and every settlement until expiry. It now throws here, inside
 * the ask, so the peer counts as refused and the list is made of the others. The wire and its bytes are unchanged.
 * AND EXACTLY ONE COMMITMENT (kanban #2402, #2471): read with that bound - never a list the asker decodes and takes the first of.
 */
export function decodePeerCommitment(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== COMMITMENT_BYTES)
    throw new Error(`a seat's commitment is ${COMMITMENT_BYTES} bytes, not ${bytes && bytes.length}`);
  const c = decodeCommitments(bytes)[0];
  const why = commitmentPointsRefusal(c);
  if (why) throw new Error(why);
  return c;
}

/** Why a commitment's two nonces are not secp256k1 points (or one is the identity), or null - decodePeerCommitment's check, also run by reserve-payout.js sign (kanban #2372). */
export function commitmentPointsRefusal(c) {
  if (!c || typeof c !== 'object') return 'that answer carries no commitment';
  for (const which of ['hiding', 'binding']) {
    let P;
    try { P = secp256k1.Point.fromBytes(c[which]); } catch { return `that commitment's ${which} nonce is not a point of secp256k1`; }
    if (P.equals(secp256k1.Point.ZERO)) return `that commitment's ${which} nonce is the identity`;
  }
  return null;
}

/**
 * A PEER'S COMMITMENT THE ASKER MAY LIST (kanban #2402, #2471; a44-refute-51 s2, the bypass of #1672 / #2161): one seat that answered
 * round one under ANOTHER signer's id (the asker's own, or a peer's) made the asker's list name an id twice, the asker's own round two
 * refused that list ("names a participant twice") and the pass ended with nobody left off - every pass, so one seat of seven held every
 * settlement, forfeit, send and reserve payout. A peer's commitment is listed only when its id is a participant id, is that peer's own
 * signer id where the asker knows it (`id`), and is not on the list yet (`signers`, the asker first). The why, or null to list it.
 */
export function peerCommitmentRefusal(commitment, signers, { id = null } = {}) {
  if (!commitment || !Number.isInteger(commitment.id) || commitment.id < 1) return 'its commitment names no participant id';
  if (Number.isInteger(id) && commitment.id !== id) return `its commitment names signer ${commitment.id}, and that seat is signer ${id}`;
  if ((signers || []).some((s) => s && s.commitment && String(s.commitment.id) === String(commitment.id)))
    return `its commitment names signer ${commitment.id}, who is on the list already`;
  return null;
}

/** THE ANSWERS IN THE ORDER THEY ARE LISTED (kanban #2402): a seat left off before (`out`) last, so a forged id it sent never takes an honest seat's place. */
export const leftOffLast = (asked, out) => (out && out.size ? [...asked.filter((x) => !out.has(x.peer)), ...asked.filter((x) => out.has(x.peer))] : asked);

/**
 * A LIST NO COMMITTEE COULD SEND (kanban #1672): round two signed over whatever list the asker posted, once it carried this signer
 * node's own commitment and at least `needed` entries - an 8 MiB body (85 598 commitments) kept the seat's loop in signShare340 for
 * about 49 s. A committee is never larger than the draw its threshold belongs to (receiptsNeeded: 5 of 7 or 9, 2 of 2 or 3, so at
 * most 2 * needed - 1), or the contract's own nodes where the caller knows them; and a participant is in a list once. A longer list,
 * or one naming an id twice, is refused before any curve work. The why, or null for a list a committee could have sent.
 */
export const MOST_COMMITMENTS = 64;
export function commitmentListRefusal(commitments, { needed, nodes = null } = {}) {
  const own = Number.isInteger(needed) && needed > 0 ? Math.max(Array.isArray(nodes) ? nodes.length : 0, 2 * needed - 1) : MOST_COMMITMENTS;
  const most = Math.min(MOST_COMMITMENTS, own);
  if (!Array.isArray(commitments) || commitments.length > most)
    return `${commitments && commitments.length} commitments, and no committee of this round's key (${needed} needed) holds more than ${most}`;
  const ids = new Set(commitments.map((c) => String(c.id)));
  if (ids.size !== commitments.length) return 'that commitment list names a participant twice';
  return null;
}

export const encodeShare = (share) => scalarTo32(share);
export const decodeShare = (bytes) => {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SHARE_BYTES)
    throw new Error('a signature share is 32 bytes');
  return scalarFrom32(bytes);
};

/**
 * ROUND TWO'S BODY: the same output again, then the commitment list.
 *
 * The output is repeated rather than remembered against a session, because a
 * signer node that had to keep one would be keeping state an asker could exhaust, and
 * because the signer node rebuilds the spend from it either way - a second round that
 * named a different output is a refusal, not a surprise.
 */
export function encodeShareRequest(utxo, commitments) {
  const head = encodeUtxo(utxo);
  const tail = encodeCommitments(commitments);
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}
