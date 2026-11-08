// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEE PROPOSALS' SIGNALS AND DEVELOPER APPROVALS ON CHAIN (kanban #1283, RULED #1277 option B - the lasting fix; #1279 was the interim):
//
//   signal     OP_RETURN "ARN" 'S' || proposal_id[0:8] || sig64                  76 bytes
//              sig: the bond key's BIP-340 signature over tagged_hash("ARENA/v1/FeeSignal", proposal_id)
//   approval   OP_RETURN "ARN" 'A' || proposal_id[0:8] || approve u8 || sig64      77 bytes
//              sig: the developer key's signature over tagged_hash("ARENA/v1/FeeApproval", proposal_id || approve)
//
// Any transaction carries them, never the bond's spend. Counted by block height inside the period: one signal per bond (the census at the
// proposal's publication height), and per developer a no stands over a yes. From FEE_SIGNAL_CHAIN_HEIGHT on the off-chain records count for nothing.
import { taggedHash, toHex } from './hash.js';
import { TAG } from './constants.js';
import { splitBlock } from './block.js';
import { parseTransaction, commitmentsOf } from './tx.js';

export const FEE_SIGNAL_MARKER = Uint8Array.from([0x41, 0x52, 0x4e, 0x53]);     // "ARN" 'S'
export const FEE_APPROVAL_MARKER = Uint8Array.from([0x41, 0x52, 0x4e, 0x41]);   // "ARN" 'A'
export const FEE_SIGNAL_BYTES = 4 + 8 + 64;                                       // 76
export const FEE_APPROVAL_BYTES = 4 + 8 + 1 + 64;                                 // 77
/** From this height on a network reads signals and approvals from its chain (regtest 0; testnet4 at the roll, null until named; mainnet from its first block). */
export const FEE_SIGNAL_CHAIN_HEIGHT = Object.freeze({ regtest: 0, testnet4: null, mainnet: 0 });

const is32 = (x) => x instanceof Uint8Array && x.length === 32;
const is64 = (x) => x instanceof Uint8Array && x.length === 64;
export const feeSignalMessage = (proposalId) => taggedHash(TAG.feeSignal, proposalId);
export const feeApprovalMessage = (proposalId, approve) => taggedHash(TAG.feeApproval, Uint8Array.from([...proposalId, approve ? 1 : 0]));

export function encodeFeeSignal({ proposalId, signature }) {
  if (!is32(proposalId)) throw new Error('a fee signal names a 32-byte proposal id');
  if (!is64(signature)) throw new Error('a fee signal carries a 64-byte signature');
  const out = new Uint8Array(FEE_SIGNAL_BYTES);
  out.set(FEE_SIGNAL_MARKER, 0); out.set(proposalId.subarray(0, 8), 4); out.set(signature, 12);
  return out;
}
export function decodeFeeSignal(payload) {
  if (!(payload instanceof Uint8Array) || payload.length !== FEE_SIGNAL_BYTES || FEE_SIGNAL_MARKER.some((b, i) => payload[i] !== b)) return null;
  return { idPrefix: payload.slice(4, 12), signature: payload.slice(12) };
}
export function encodeFeeApprovalOnChain({ proposalId, approve, signature }) {
  if (!is32(proposalId)) throw new Error('a fee approval names a 32-byte proposal id');
  if (!is64(signature)) throw new Error('a fee approval carries a 64-byte signature');
  const out = new Uint8Array(FEE_APPROVAL_BYTES);
  out.set(FEE_APPROVAL_MARKER, 0); out.set(proposalId.subarray(0, 8), 4); out[12] = approve ? 1 : 0; out.set(signature, 13);
  return out;
}
export function decodeFeeApprovalOnChain(payload) {
  if (!(payload instanceof Uint8Array) || payload.length !== FEE_APPROVAL_BYTES || FEE_APPROVAL_MARKER.some((b, i) => payload[i] !== b)) return null;
  if (payload[12] > 1) return null;
  return { idPrefix: payload.slice(4, 12), approve: payload[12] === 1, signature: payload.slice(13) };
}

/** Every fee signal and approval in one raw block: [{ kind: 'signal' | 'approval', payload, height, txid }]. */
export function feeItemsInBlock(raw, height) {
  const out = [];
  for (const t of splitBlock(raw).transactions) {
    let tx; try { tx = parseTransaction(t); } catch { continue; }
    for (const payload of commitmentsOf(tx)) {
      const kind = decodeFeeSignal(payload) ? 'signal' : decodeFeeApprovalOnChain(payload) ? 'approval' : null;
      if (kind) out.push({ kind, payload, height, txid: toHex(Uint8Array.from(tx.txid).reverse()) });
    }
  }
  return out;
}

/**
 * THE PERIOD'S COUNT. `items` feeItemsInBlock's answers; `fromHeight`..`toHeight` the period (toHeight exclusive); `census` the bonds at the
 * proposal's publication height [{ pubkey, outpoint, bondSats }]; `devKeys` the developer keys (32-byte x-only); `verify(sig, msg, key)` BIP-340.
 * Answers { signals: { bonds, sats, of, ofSats, pct }, approvals: Map(dev hex -> approve), keys } - one signal per bond, a no over a yes.
 */
export function countFeeChain({ proposalId, items = [], fromHeight, toHeight, census = [], devKeys = [], verify, passPct = 15 }) {
  const prefix = toHex(proposalId.subarray(0, 8));
  const signalMsg = feeSignalMessage(proposalId);
  const signed = new Map();                                      // outpoint -> bondSats
  const approvals = new Map();                                   // dev hex -> approve
  for (const it of items) {
    if (!(it.height >= fromHeight && it.height < toHeight)) continue;
    if (it.kind === 'signal') {
      const d = decodeFeeSignal(it.payload);
      if (!d || toHex(d.idPrefix) !== prefix) continue;
      for (const b of census) {
        if (signed.has(b.outpoint)) continue;
        let good = false; try { good = !!verify(d.signature, signalMsg, b.pubkey); } catch { good = false; }
        if (good) signed.set(b.outpoint, BigInt(b.bondSats));
      }
    } else if (it.kind === 'approval') {
      const d = decodeFeeApprovalOnChain(it.payload);
      if (!d || toHex(d.idPrefix) !== prefix) continue;
      const msg = feeApprovalMessage(proposalId, d.approve);
      for (const k of devKeys) {
        let good = false; try { good = !!verify(d.signature, msg, k); } catch { good = false; }
        if (!good) continue;
        const h = toHex(k);
        approvals.set(h, approvals.has(h) ? approvals.get(h) && d.approve : d.approve);   // a no stands over a yes
      }
    }
  }
  const of = census.length, ofSats = census.reduce((t, b) => t + BigInt(b.bondSats), 0n);
  const sats = [...signed.values()].reduce((t, x) => t + x, 0n);
  return { signals: { bonds: signed.size, sats, of, ofSats, passes: of > 0 && signed.size * 100 >= passPct * of }, approvals };
}
