// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BOND OF THE ANCESTOR, RE-AFFIRMED FOR THIS NETWORK (multiplayer_p2p.md §27A.8.3, spec 0A.9; kanban #209).
//
// "A bond created under an ancestor is valid in the census of network n+1 when its operator publishes a
// re-affirmation: OP_RETURN "ARN" FORK network_id(n+1)[0:8] schnorr_sig(bond key). One small transaction, the same shape as
// a vote (§27A.7.3). It moves no capital, spends no bond, and starts no new maturity clock." Opt-in, per operator.
//
// THE KIND BYTE IS OURS, as ROUND's 'R', SERIES' 'S' and ADV's 'A' are: FORK is 0x46, 'F'. The payload is 76 bytes:
//   "ARN" 'F' || network_id[0:8] || BIP-340 signature (64)
// The signature is by the bond's node key (the node_pubkey its advertisement names, as an update's and a vote's are) over
//   taggedHash(ARENA/v1/Reaffirmation, network_id (32) || bond txid (32, parseTransaction's order) || bond vout (u32, the
//   protocol encoding's big-endian))
// so a signature names one bond of one network: an operator with two bonds re-affirms each, and the bytes carry no
// outpoint - a verifier tries them against the ancestor bonds it found, as a vote's tally does.
//
// WHAT THIS FILE DOES NOT DO: check a signature. The protocol package carries no curve; the census is handed the same
// BIP-340 verify it checks updates with, and an unchecked re-affirmation carries nothing.
import { Writer } from './encode.js';
import { taggedHash } from './hash.js';
import { TAG } from './constants.js';
import { parseTransaction, commitmentsOf } from './tx.js';

export const REAFFIRM_MAGIC = Uint8Array.from([0x41, 0x52, 0x4e, 0x46]);     // "ARN" 'F'
export const REAFFIRM_BYTES = 4 + 8 + 64;

const sameReaffirmBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const bytes32 = (x, what) => { if (!(x instanceof Uint8Array) || x.length !== 32) throw new TypeError(`${what} is 32 bytes`); };

/** What the bond's node key signs: this network, this bond. */
export function reaffirmationMessage({ networkId, bondTxid, bondVout }) {
  bytes32(networkId, 'a network id'); bytes32(bondTxid, 'a bond txid');
  if (!Number.isInteger(bondVout) || bondVout < 0) throw new TypeError('a re-affirmation names the bond output index');
  const w = new Writer();
  w.bytes32(networkId); w.bytes32(bondTxid); w.u32(bondVout);
  return taggedHash(TAG.reaffirmation, w.finish());
}

/** The 76 bytes a re-affirmation's OP_RETURN carries. */
export function reaffirmationPayload({ networkId, signature }) {
  bytes32(networkId, 'a network id');
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new TypeError('a re-affirmation carries a 64-byte signature');
  const out = new Uint8Array(REAFFIRM_BYTES);
  out.set(REAFFIRM_MAGIC, 0);
  out.set(networkId.subarray(0, 8), 4);
  out.set(signature, 12);
  return out;
}

/** The payload's fields, or null for any other commitment. */
export function readReaffirmationPayload(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== REAFFIRM_BYTES || !sameReaffirmBytes(bytes.subarray(0, 4), REAFFIRM_MAGIC)) return null;
  return { networkPrefix: bytes.slice(4, 12), signature: bytes.slice(12, 76) };
}

/**
 * WHICH ANCESTOR BONDS ARE RE-AFFIRMED FOR `networkId`, from a chain view's blocks at or below `atHeight`: for each entry
 * ({ txid, vout, pubkey, height }), the first re-affirmation at or above the bond's own height whose signature `verify`
 * (BIP-340: verify(sig, msg, key)) accepts under the entry's node key for this network and this bond.
 * Answers Map(outpoint key "txid bytes joined by ','" + ":" + vout -> { txid, height, position }).
 */
export function reaffirmedBonds(view, entries, { atHeight, networkId, verify } = {}) {
  const found = new Map();
  if (typeof verify !== 'function' || !view || !Array.isArray(view.blocks) || !Array.isArray(entries) || !entries.length) return found;
  bytes32(networkId, 'a network id');
  const prefix = networkId.subarray(0, 8);
  const keyOf = (e) => `${Array.from(e.txid).join(',')}:${e.vout}`;
  view.blocks.forEach((block, i) => {
    const height = view.firstHeight + i;
    if (height > atHeight) return;
    (block.transactions || []).forEach((raw, position) => {
      let tx;
      try { tx = parseTransaction(raw); } catch { return; }
      for (const c of commitmentsOf(tx)) {
        const p = readReaffirmationPayload(c);
        if (!p || !sameReaffirmBytes(p.networkPrefix, prefix)) continue;
        for (const e of entries) {
          const key = keyOf(e);
          if (found.has(key) || height < e.height) continue;
          let ok = false;
          try { ok = !!verify(p.signature, reaffirmationMessage({ networkId, bondTxid: e.txid, bondVout: e.vout }), e.pubkey); } catch { ok = false; }
          if (ok) found.set(key, { txid: tx.txid, height, position });
        }
      }
    });
  });
  return found;
}
