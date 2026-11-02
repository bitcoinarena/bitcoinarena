// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SLASH START (spec 5A.3B, kanban #972): the transaction the census key signs beside a node's slash_presig. Input 0 the bond and output 0 the whole amount to a hold output are what the presig fixed. What the presig left open
// is whoever files it: a fee input and the proof's OP_RETURN. `checkSlashStart` is what a holder holds a request to before it answers: pure, and the proof's replay is the caller's.
import { arbitrationCommitment, arbitrationCommitmentIn } from './arbitration-tx.js';
import { slashStartLeaf, tapLeafHash } from './bond-script.js';
import { scriptPathWitness, serializeSpend, tapSighash } from './bond-spend.js';
import { SLASH_START_SEQUENCE, slashPresigDigest, slashPresigVerifies } from './slash-presig.js';
import { toHex } from './hash.js';

const same = (a, b) => toHex(a) === toHex(b);

/**
 * THE START, UNSIGNED. `bond` { txid, vout, value, script }, `holdScript` the output the presig names, `fee` a coin that holds the whole fee: { txid, vout, value, script }. It has no change, so the
 * start stays what its size says. Answers { tx, prevouts }.
 */
export function buildSlashStart({ bond, holdScript, proofId, slashHeight, hint = new Uint8Array(0), fee }) {
  const tx = { version: 2, locktime: 0, inputs: [{ txid: bond.txid, vout: bond.vout, sequence: SLASH_START_SEQUENCE }, { txid: fee.txid, vout: fee.vout, sequence: SLASH_START_SEQUENCE }],
    outputs: [{ value: bond.value, script: holdScript }, arbitrationCommitment(proofId, slashHeight, hint)] };
  return { tx, prevouts: [{ value: bond.value, script: bond.script }, { value: fee.value, script: fee.script }] };
}

/** What the census key signs: the whole transaction, on the slash leaf. */
export const slashStartDigest = ({ tx, prevouts, nodeKey, censusKey }) => tapSighash({ ...tx, prevouts, inputIndex: 0, leafHash: tapLeafHash(slashStartLeaf(nodeKey, censusKey)) });

/**
 * WHAT A HOLDER SIGNS, OR WHY NOT. `bond` as the holder's own census has it, `holds` the hold outputs that bond may go to, by the holder's own reckoning ({ script }), `presig` the node's 65 bytes, `proofId` H(proof) of the
 * proof this holder replayed. `verify(signature, digest, key)` the caller's curve. A key that signs here sends that bond nowhere its node did not sign to. Answers { ok, digest, slashHeight } or { ok: false, why }.
 */
export function checkSlashStart({ tx, prevouts, bond, nodeKey, censusKey, holds, presig, proofId, verify }) {
  if (tx.version !== 2 || tx.locktime !== 0) return { ok: false, why: 'a slash start is version 2 with nLockTime 0' };
  const [input] = tx.inputs, [output] = tx.outputs;
  if (!input || !same(input.txid, bond.txid) || input.vout !== bond.vout || input.sequence !== SLASH_START_SEQUENCE) return { ok: false, why: 'input 0 is not that bond' };
  if (prevouts.length !== tx.inputs.length || prevouts[0].value !== bond.value || !same(prevouts[0].script, bond.script)) return { ok: false, why: 'its prevouts are not what the chain holds for that bond' };
  if (!output || output.value !== bond.value) return { ok: false, why: 'output 0 is not the whole bond' };
  const hold = holds.find((h) => same(h.script, output.script));
  if (!hold) return { ok: false, why: 'output 0 pays no hold output of that bond' };
  if (!slashPresigVerifies(presig, slashPresigDigest({ bond, nodeKey, censusKey, holdScript: hold.script }), nodeKey, verify)) return { ok: false, why: 'that slash_presig does not verify' };
  const said = arbitrationCommitmentIn(tx.outputs);
  if (!said || !same(said.proofId, proofId)) return { ok: false, why: 'its OP_RETURN does not name that proof' };
  return { ok: true, digest: slashStartDigest({ tx, prevouts, nodeKey, censusKey }), slashHeight: said.slashHeight };
}

/** The filed transaction: the bond's witness from both signatures, and `feeStack` for the fee input, its signature and whatever its leaf asks. `control` the bond's slash leaf's control block. */
export function signedSlashStart({ tx, nodeKey, censusKey, censusSignature, presig, control, feeWitness }) {
  return serializeSpend({ ...tx, witnesses: [scriptPathWitness({ stack: [censusSignature, presig], script: slashStartLeaf(nodeKey, censusKey), controlBlock: control }), feeWitness] });
}
