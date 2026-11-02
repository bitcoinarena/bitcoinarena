// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A START WITH NO GOOD PROOF, AND THE NODE LEAVES BY ITSELF (spec 5A.3B, RULED 2026-11-02, kanban #1021): "the reference node takes the return
// leaf itself, as soon as it opens, when a start names a proof that does not check on its own replay. An owner does not have to watch."
//
// The chain, the replay and the proof's bytes are the caller's. A start that names a true proof is left alone: this is not a way out of a slash.
import { schnorr } from '@noble/curves/secp256k1.js';
import { holdReturnSpend, arbitrationCommitmentIn } from '../../arena-protocol/src/arbitration-tx.js';
import { holdControlBlock } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { decodeAbandonedProof, isAbandonedProof, abandonedProofId } from '../../arena-protocol/src/abandoned-slash.js';
import { splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { judgeAbandoned } from './arbiter.js';
import { TAG } from '../../arena-protocol/src/constants.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';

const same = (a, b) => toHex(a) === toHex(b);

/** The first tip the return can be mined on top of: both its clocks read from the next block. */
export const returnOpensAt = ({ startHeight, returnBlocks, bondMaturity }) => Math.max(startHeight + returnBlocks - 1, bondMaturity);

/**
 * WHAT A RAW TRANSACTION SAYS ABOUT THIS BOND: if it spends `bond` ({ txid, vout }) into one of `holds` (Map of script hex -> a hold output as
 * holdOutputKey builds it), the start: { txid, hold, proofId or null }. Null for any other transaction.
 */
export function readSlashStart(raw, bond, holds) {
  const tx = parseTransaction(raw);
  if (!tx.inputs.some((i) => same(i.previousTxid, bond.txid) && i.previousVout === bond.vout)) return null;
  const hold = tx.outputs[0] && holds.get(toHex(tx.outputs[0].script));
  if (!hold) return null;
  const said = arbitrationCommitmentIn(tx.outputs);
  return { txid: tx.txid, value: tx.outputs[0].value, hold, proofId: said ? said.proofId : null };
}

/**
 * WHAT TO DO ABOUT A START, at `tip`. Before the leaf opens: wait, and nothing is fetched. Once open, `fetchProof(proofId)` brings the bytes and
 * `proofChecks(bytes)` this node's own replay: true leaves the bond to its slash, false takes the return, anything else waits for a
 * replay that answers. A start naming no proof, or one whose bytes nobody can produce by then, has nothing that checks (5A.3B: "does not retrieve,
 * or does not check").
 */
export async function decideReturn({ start, startHeight, bondMaturity, returnBlocks, tip, fetchProof, proofChecks }) {
  const opensAt = returnOpensAt({ startHeight, returnBlocks, bondMaturity });
  if (tip < opensAt) return { action: 'wait', opensAt, why: `the return opens at tip ${opensAt}` };
  if (!start.proofId) return { action: 'return', opensAt, why: 'the start names no proof' };
  const bytes = await fetchProof(start.proofId);
  if (!(bytes instanceof Uint8Array) || !same(taggedHash(TAG.slashProof, bytes), start.proofId))
    return { action: 'return', opensAt, why: 'the proof the start names cannot be fetched' };
  const verdict = await proofChecks(bytes);
  if (verdict === true) return { action: 'keep', opensAt, why: 'the proof checks on this node\'s replay' };
  if (verdict === false) return { action: 'return', opensAt, why: 'the proof does not check on this node\'s replay' };
  return { action: 'wait', opensAt, why: 'this node has no replay of that proof yet' };
}

/**
 * THE proofChecks OF A START ON AN ABANDONMENT (§23A.5, RULED 2026-11-02, kanban #1062). `decideReturn`'s hash check takes these bytes as any slash proof's: only this check is their own. True when
 * the proof names this node and the very bond the start spent, and judgeAbandoned stands on it: its record at threshold on this node's own census, its row naming this node and proof_ref, a
 * spend's proof_ref read on the chain. For an absence the record's signatures are the check. `fetchEvidence(proofId)` brings any standing copy of the signed record beside the proof (kanban #1064):
 * none is a proof that does not retrieve. `bond` { txid, vout } what the start spent; `bonds` this node's census read at the block before the start, since the start's hold output is no output
 * left; `censusAt(height)` the entries there, nothing yet: this waits, as a replay that has not answered does.
 */
export async function abandonedProofChecks({ bytes, fetchEvidence, nodePubkey, bond, bonds, censusAt, networkId, inviteFederationId, from }) {
  let p; try { p = decodeAbandonedProof(bytes); } catch { return false; }
  if (!same(p.nodePubkey, nodePubkey) || !same(p.txid, bond.txid) || p.vout !== bond.vout) return false;
  const evidence = await fetchEvidence(abandonedProofId(bytes));
  if (!(evidence instanceof Uint8Array)) return false;
  let height; try { height = splitSignedRecord(evidence).record.height; } catch { return false; }
  const census = await censusAt(height);
  if (!census) return undefined;
  return judgeAbandoned({ proofBytes: bytes, evidence, census, bonds, networkId, inviteFederationId, ...(from === undefined ? {} : { from }) }).slashed;
}

/** One check for a start of any kind: an abandonment's proof by `abandoned(bytes)`, every other by `replay(bytes)`. */
export const proofChecksOf = ({ replay, abandoned }) => (bytes) => (isAbandonedProof(bytes) ? abandoned(bytes) : replay(bytes));

/** The signed return, as hex: the whole hold less `feeSats` to `toScript`, by the node's key on the return leaf. */
export function signedReturn({ start, bondMaturity, returnBlocks, toScript, feeSats, nodeSecret }) {
  const { hold } = start;
  const built = holdReturnSpend({ hold: { txid: start.txid, vout: 0, value: start.value, script: hold.script }, bondMaturity, returnBlocks, toScript, feeSats });
  if (!built.ok) throw new Error(built.why);
  const digest = tapSighash({ ...built.tx, prevouts: built.prevouts, inputIndex: 0, leafHash: hold.leaves.return });
  const witness = scriptPathWitness({ stack: [schnorr.sign(digest, nodeSecret)], script: hold.scripts.return, controlBlock: holdControlBlock('return', hold).controlBlock });
  return toHex(serializeSpend({ ...built.tx, witnesses: [witness] }));
}

/** One pass over one start: decide, and broadcast the return if that is the answer. `broadcast(hex)` is the caller's. */
export async function takeReturnIfOwed({ start, startHeight, bondMaturity, returnBlocks, tip, fetchProof, proofChecks, toScript, feeSats, nodeSecret, broadcast }) {
  const decided = await decideReturn({ start, startHeight, bondMaturity, returnBlocks, tip, fetchProof, proofChecks });
  if (decided.action !== 'return') return decided;
  const hex = signedReturn({ start, bondMaturity, returnBlocks, toScript, feeSats, nodeSecret });
  return { ...decided, hex, sent: await broadcast(hex) };
}
