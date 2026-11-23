// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN OPERATOR ID IS A KEY (kanban #3385, closes #3146; spec §5A.13 "Operator binding"). An advertisement's operatorId used to be a
// self-declared string, so a stranger's node naming an honest operator's id was grouped with that operator's nodes and could take
// its one ticket in the founding draw (#3031, #3146). Now: operatorId is the operator's x-only public key (64 hex), and an advert
// naming one carries `operatorSig`, a BIP-340 signature by that key over operatorBindingId(node key, operatorId, network). Without a
// valid signature the node is its own operator (operatorId := its node key) and is never grouped with another node.
// This package carries no curve: the verify is handed in (census.js deriveCensus gets it as verifyUpdate).
import { Writer } from './encode.js';
import { taggedHash, toHex, fromHex } from './hash.js';

export const OPERATOR_BINDING_TAG = 'ARENA/v1/OperatorBinding';
const HEX64 = /^[0-9a-f]{64}$/;

/** What the operator key signs: H(tag, node key || operator key || network name). */
export function operatorBindingId({ nodePubkey, operatorId, network }) {
  const node = typeof nodePubkey === 'string' ? fromHex(nodePubkey) : nodePubkey;
  if (!(node instanceof Uint8Array) || node.length !== 32) throw new Error('an operator binding names a 32-byte node key');
  if (typeof operatorId !== 'string' || !HEX64.test(operatorId)) throw new Error('an operator id is an x-only public key, 64 hex');
  const w = new Writer(); w.bytes32(node); w.bytes32(fromHex(operatorId)); w.str(String(network || ''));
  return taggedHash(OPERATOR_BINDING_TAG, w.finish());
}

/** The operator an advertisement is bound to (hex): its operatorId when that key signed the binding, else the node's own key. */
export function boundOperatorOf(advert, network, verify) {
  const node = advert && advert.nodePubkey instanceof Uint8Array ? toHex(advert.nodePubkey) : null;
  if (!node) return null;
  const op = advert.operatorId, sig = advert.operatorSig;
  if (typeof verify !== 'function' || typeof op !== 'string' || !HEX64.test(op) || !(sig instanceof Uint8Array) || sig.length !== 64) return node;
  if (op === node) return node;
  let ok = false;
  try { ok = verify(sig, operatorBindingId({ nodePubkey: advert.nodePubkey, operatorId: op, network }), fromHex(op)) === true; } catch { ok = false; }
  return ok ? op : node;
}

/** A census entry's operator for grouping (founding draw, gateway seats): the census-bound `operator`, else the node key alone. */
export function operatorOf(e) {
  if (e && typeof e.operator === 'string' && e.operator) return e.operator;
  const k = e && (e.pubkey || (e.advert && e.advert.nodePubkey));
  return k ? (k instanceof Uint8Array ? toHex(k) : String(k).toLowerCase()) : '';
}
