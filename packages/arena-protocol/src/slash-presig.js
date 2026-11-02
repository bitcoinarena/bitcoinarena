// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ADVANCE SIGNATURE, slash_presig (spec 5A.3B, kanban #972). With its SEATING signature each seated node signs one slash start per template-3 bond it holds, so the census key can
// send that bond to the round's hold output and nowhere else. Hash type SIGHASH_SINGLE|ANYONECANPAY: whoever files the slash adds a fee input and the proof's OP_RETURN after it.
//
//   version 2, nLockTime 0
//   input 0     the bond, sequence 0xfffffffd
//   output 0    the whole bond amount, to hold(bond, round)
//
// A hold depends on the round only through its panels, so all rounds of a table, which share one draw, share one presig, and so do the two roles of one round. Pure: the census, the seed
// and the clocks are the caller's.
import { BOND_TEMPLATE_V3, holdOutputKey, slashStartLeaf, tapLeafHash } from './bond-script.js';
import { tapSighash } from './bond-spend.js';
import { drawPanels } from './sortition.js';
import { SLASH_CLOCKS } from './genesis.js';
import { networkOf } from './constants.js';
import { toHex } from './hash.js';

export const SLASH_PRESIG_HASH_TYPE = 0x83;
export const SLASH_START_SEQUENCE = 0xfffffffd;

/** The digest a node signs for one bond: `bond` { txid, vout, value, script }, `holdScript` the P2TR script of its hold output. */
export function slashPresigDigest({ bond, nodeKey, censusKey, holdScript }) {
  return tapSighash({ version: 2, locktime: 0, inputs: [{ txid: bond.txid, vout: bond.vout, sequence: SLASH_START_SEQUENCE }], outputs: [{ value: bond.value, script: holdScript }],
    prevouts: [{ value: bond.value, script: bond.script }], inputIndex: 0, leafHash: tapLeafHash(slashStartLeaf(nodeKey, censusKey)), hashType: SLASH_PRESIG_HASH_TYPE });
}

/** 65 bytes: `sign(digest)`'s 64 and the hash type a witness needs. */
export function signSlashPresig(digest, sign) {
  const sig = sign(digest);
  if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new Error('a slash_presig is a 64-byte Schnorr signature and its hash type');
  return Uint8Array.from([...sig, SLASH_PRESIG_HASH_TYPE]);
}

/** Does `presig` (65 bytes) verify over `digest` under `nodeKey`? `verify(signature, digest, key)` is the caller's curve. */
export function slashPresigVerifies(presig, digest, nodeKey, verify) {
  if (!(presig instanceof Uint8Array) || presig.length !== 65 || presig[64] !== SLASH_PRESIG_HASH_TYPE) return false;
  try { return !!verify(presig.subarray(0, 64), digest, nodeKey); } catch { return false; }
}

/** A bond a slash_presig is asked for: template 3, its output read off the chain, and not started already: a started bond has no input left to sign for. */
export const presignedBond = (e) => !!e && !e.hold && !!e.advert && e.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3 && e.script instanceof Uint8Array;

/** The network's clocks, under the names a hold output takes. */
export function holdClocksOf(networkId) {
  const c = SLASH_CLOCKS[networkOf(networkId)];
  if (!c) throw new Error('that network names no slash clocks');
  return { holdBlocks: c.slashHoldBlocks, returnBlocks: c.slashReturnBlocks, fallbackBlocks: c.slashFallbackBlocks };
}

/**
 * WHAT A ROUND ASKS OF ITS NODES: { ok, plan } with `plan` a Map of node key hex -> [{ txid (hex), vout, digest, hold }], one per template-3 bond of that node in the round's census.
 * A census with no such bond draws no panels and answers an empty plan, so a round on template 1 and 2 bonds does nothing here. `tweakPoint` is the caller's curve.
 */
export function roundPresigPlan({ entries, contract, committeeSeed, drawsAttestors = false, attestorKeys = [], tweakPoint }) {
  const bonds = (entries || []).filter(presignedBond);
  const plan = new Map();
  if (!bonds.length) return { ok: true, plan };
  const panels = drawPanels({ entries, contract, committeeSeed, drawsAttestors, attestorKeys });
  if (!panels.ok) return panels;
  const panelA = panels.panelA.map((e) => e.pubkey), panelB = panels.panelB.map((e) => e.pubkey), clocks = holdClocksOf(contract.networkId);
  for (const e of bonds) {
    const hold = holdOutputKey({ nodeKey: e.pubkey, censusKey: e.advert.censusKey, panelA, panelB, bondMaturity: e.advert.bondMaturityHeight, ...clocks }, { tweakPoint });
    if (!hold.ok) return { ok: false, why: `the hold output of a bond cannot be built: ${hold.why}` };
    const bond = { txid: e.txid, vout: e.vout, value: BigInt(e.bondSats), script: e.script };
    const node = toHex(e.pubkey);
    (plan.get(node) || plan.set(node, []).get(node)).push({ txid: toHex(e.txid), vout: e.vout, hold,
      digest: slashPresigDigest({ bond, nodeKey: e.pubkey, censusKey: e.advert.censusKey, holdScript: hold.script }) });
  }
  return { ok: true, plan, panels };
}
