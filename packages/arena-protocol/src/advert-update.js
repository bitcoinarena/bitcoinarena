// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ADVERTISEMENT UPDATE, NOT A NEW BOND (multiplayer_p2p.md §5A.2; 2026-09-28: "Advertisement updates, not new
// bonds. Spec 5A.2 is the path. Bond 0c82db59 stays the bond").
//
// "A new advertisement is an update, not a new bond. The bond commits, at its creation, to the node's first
// advertisement. Every later one is an advertisement update: one small transaction that pays the BOND_MARKER dust (so
// it is findable, as a bond is), carries OP_RETURN "ARN" ADV bond_outpoint H(NodeAdvertisement), carries the body in
// its witness (§25.1), and is signed by node_pubkey. It spends no bond and starts no maturity clock. The census reads,
// for each unspent bond, the newest valid update confirmed at or below census_height, else the advertisement the bond
// committed to at creation. An update whose node_pubkey is not the bond's is not an update of that bond."
//
// THE KIND BYTE IS OURS, as ROUND's 'R' and SERIES' 'S' are: ADV is 0x41, 'A'. The payload is 72 bytes:
//   "ARN" 'A' || bond txid (32, the byte order parseTransaction computes) || bond vout (u32 LE) || H(advertisement)
// The signed body travels in the witness exactly as a bond's does, in pieces the carrier script drops.
//
// WHAT THIS FILE DOES NOT DO: check the signature. The protocol package carries no curve; every reader passes its own
// BIP-340 verify, as the census's advertisement check does, and an update nobody verified is never applied.
import { parseTransaction, commitmentsOf, witnessRunsOf } from './tx.js';
import { advertId, decodeAdvert, splitSignedAdvert } from './advert.js';
import { paysBondMarker, provesTransaction } from './chain.js';

export const ADVERT_UPDATE_MAGIC = Uint8Array.from([0x41, 0x52, 0x4e, 0x41]);     // "ARN" 'A'
export const ADVERT_UPDATE_BYTES = 4 + 32 + 4 + 32;

const sameUpdateBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The 72 bytes an update's OP_RETURN carries. */
export function advertUpdatePayload({ bondTxid, bondVout, advertIdBytes }) {
  if (!(bondTxid instanceof Uint8Array) || bondTxid.length !== 32) throw new TypeError('an update names a 32-byte bond txid');
  if (!Number.isInteger(bondVout) || bondVout < 0) throw new TypeError('an update names the bond output index');
  if (!(advertIdBytes instanceof Uint8Array) || advertIdBytes.length !== 32) throw new TypeError('an update commits to a 32-byte advertisement id');
  const out = new Uint8Array(ADVERT_UPDATE_BYTES);
  out.set(ADVERT_UPDATE_MAGIC, 0);
  out.set(bondTxid, 4);
  new DataView(out.buffer).setUint32(36, bondVout, true);
  out.set(advertIdBytes, 40);
  return out;
}

/** The payload's fields, or null for any other commitment. */
export function readAdvertUpdatePayload(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== ADVERT_UPDATE_BYTES || !sameUpdateBytes(bytes.subarray(0, 4), ADVERT_UPDATE_MAGIC)) return null;
  return { bondTxid: bytes.slice(4, 36), bondVout: new DataView(bytes.buffer, bytes.byteOffset).getUint32(36, true), advertId: bytes.slice(40, 72) };
}

/**
 * What an update transaction says: the bond it updates, the advertisement it commits to, its signature and txid - or
 * why it is not an update. It must pay the network's marker, carry exactly the payload, and carry in its witness the
 * signed body whose id the payload names. The signature is the caller's to check.
 */
export function readAdvertUpdate(transaction, { network = 'regtest' } = {}) {
  let tx;
  try { tx = typeof transaction === 'object' && transaction.outputs ? transaction : parseTransaction(transaction); }
  catch (e) { return { ok: false, why: `that is not a transaction: ${e.message}` }; }
  const payloads = commitmentsOf(tx).map(readAdvertUpdatePayload).filter(Boolean);
  if (payloads.length !== 1) return { ok: false, why: payloads.length ? 'that transaction names more than one update' : 'that transaction carries no advertisement update' };
  if (!paysBondMarker(tx, network)) return { ok: false, why: 'an update pays the bond marker, and that transaction does not' };
  const p = payloads[0];
  let taken = null;
  for (const item of witnessRunsOf(tx)) {
    try {
      const { body, signature } = splitSignedAdvert(item);
      const advert = decodeAdvert(body);
      if (sameUpdateBytes(advertId(advert), p.advertId)) { taken = { advert, signature }; break; }
    } catch { /* not a signed body */ }
  }
  if (!taken) return { ok: false, why: 'the update commits to an advertisement its witness does not carry' };
  return { ok: true, txid: tx.txid, bondTxid: p.bondTxid, bondVout: p.bondVout, advert: taken.advert,
    advertId: p.advertId, signature: taken.signature, nodePubkey: taken.advert.nodePubkey };
}

/**
 * An update, proved into a header, for the bond `{ txid, vout, nodePubkey }`, signed by that key (`verify(sig, msg,
 * key)`). The answer carries the update; the caller keeps the newest by height and position.
 */
export async function acceptAdvertUpdate({ transaction, header, branch, position, network, bond, verify }) {
  const read = readAdvertUpdate(transaction, { network });
  if (!read.ok) return read;
  if (header && !provesTransaction(header, read.txid, branch, position)) return { ok: false, why: 'the update is not in that block' };
  return checkAgainstBond(read, bond, verify);
}

/** The rule every reader applies to a read update: it names this bond, by this bond's key, signed by that key. */
export async function checkAgainstBond(read, bond, verify) {
  // A MISSING OR MALFORMED BOND IS REFUSED BY NAME: measured before, no bond threw "Cannot read properties of undefined
  // (reading 'txid')" here and in acceptAdvertUpdate.
  if (!bond || !(bond.txid instanceof Uint8Array) || bond.txid.length !== 32 || !Number.isInteger(bond.vout) || bond.vout < 0
      || !(bond.nodePubkey instanceof Uint8Array) || bond.nodePubkey.length !== 32)
    return { ok: false, why: 'no bond { txid, vout, nodePubkey } was given, so the update is an update of nothing' };
  if (!sameUpdateBytes(read.bondTxid, bond.txid) || read.bondVout !== bond.vout) return { ok: false, why: 'the update names another bond' };
  if (!sameUpdateBytes(read.nodePubkey, bond.nodePubkey)) return { ok: false, why: 'an update whose node key is not the bond\'s is not an update of that bond' };
  if (typeof verify !== 'function') return { ok: false, why: 'no signature check was given, so no update is applied' };
  if (!await verify(read.signature, read.advertId, read.nodePubkey)) return { ok: false, why: 'the update is not signed by the bond\'s node key' };
  return { ok: true, ...read };
}

/**
 * THE NEWEST VALID UPDATE PER BOND, from blocks (a chain view: { blocks: [{ transactions }], firstHeight }), at or
 * below `atHeight`, for the census's entries ({ txid, vout, pubkey }). `verify` is synchronous here, as the census is.
 * Answers Map(outpoint key -> { advert, advertId, txid, height, position }).
 */
export function newestUpdates(view, entries, { atHeight, network = 'regtest', verify } = {}) {
  const found = new Map();
  // NO LIST OF BONDS, NOTHING TO UPDATE: measured before, a missing list threw on entries.map.
  if (typeof verify !== 'function' || !view || !Array.isArray(view.blocks) || !Array.isArray(entries)) return found;
  const want = new Map(entries.map((e) => [`${Array.from(e.txid).join(',')}:${e.vout}`, e]));
  view.blocks.forEach((block, i) => {
    const height = view.firstHeight + i;
    if (height > atHeight) return;
    (block.transactions || []).forEach((raw, position) => {
      let tx;
      try { tx = parseTransaction(raw); } catch { return; }
      if (!commitmentsOf(tx).some((c) => readAdvertUpdatePayload(c))) return;
      const read = readAdvertUpdate(tx, { network });
      if (!read.ok) return;
      const key = `${Array.from(read.bondTxid).join(',')}:${read.bondVout}`;
      const e = want.get(key);
      if (!e || !sameUpdateBytes(read.nodePubkey, e.pubkey) || height < e.height) return;
      let signed = false;
      try { signed = !!verify(read.signature, read.advertId, read.nodePubkey); } catch { signed = false; }
      if (!signed) return;
      const had = found.get(key);
      if (!had || height > had.height || (height === had.height && position > had.position))
        found.set(key, { advert: read.advert, advertId: read.advertId, txid: read.txid, height, position, raw });
    });
  });
  return found;
}
