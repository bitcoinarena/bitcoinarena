// WHAT A SIGNING ROUND PUTS ON THE WIRE, AND NOTHING ELSE GOES ON IT.
//
// Two shapes, both fixed-width, both readable by a node that trusts nothing
// about the sender. The asker names an OUTPUT and hands over a commitment
// list; the signer node answers with a commitment and then with a scalar. There is no
// sighash on this wire and no transaction: a signer node that could be handed either
// would be signing somebody else's arithmetic, which is the whole of what
// `pool-signing.js` refuses to do.
import { Writer, Reader } from '../../protocol/src/encode.js';
import { scalarFrom32, scalarTo32 } from '../../protocol/src/shares.js';

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
