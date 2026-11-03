// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A START WITH NO GOOD PROOF, AND THE OWNER TAKES THE BOND BACK (spec 5A.3B, kanban #1021; changed by kanban #1093 part 1, ruling #1103,
// 2026-11-03: "the return leaf: owner key only. The owner signs it; there is no automatic return ... What the node does instead: it builds
// the return transaction when the leaf opens and the proof doesn't check on its replay, shows it on the dashboard, and notifies the owner.
// The owner signs with the 24 words."). The node holds no key that can move the bond: it prepares, the owner's page signs, the node sends.
//
// The chain, the replay and the proof's bytes are the caller's. A start that names a true proof is left alone: this is not a way out of a slash.
import { schnorr } from '@noble/curves/secp256k1.js';
import { holdReturnSpend, arbitrationCommitmentIn } from '../../arena-protocol/src/arbitration-tx.js';
import { holdControlBlock, holdOutputKey } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { decodeAbandonedProof, isAbandonedProof } from '../../arena-protocol/src/abandoned-slash.js';
import { isTheftProof } from '../../arena-protocol/src/theft-slash.js';
import { splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { judgeAbandoned } from './arbiter.js';
import { TAG } from '../../arena-protocol/src/constants.js';
import { fromHex, taggedHash, toHex } from '../../arena-protocol/src/hash.js';

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
 * `proofChecks(bytes, { startHeight })` this node's own replay: true leaves the bond to its slash, false takes the return, anything else waits for a
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
  const verdict = await proofChecks(bytes, { startHeight });
  if (verdict === true) return { action: 'keep', opensAt, why: 'the proof checks on this node\'s replay' };
  if (verdict === false) return { action: 'return', opensAt, why: 'the proof does not check on this node\'s replay' };
  return { action: 'wait', opensAt, why: 'this node has no replay of that proof yet' };
}

/**
 * THE proofChecks OF A START ON AN ABANDONMENT (§23A.5, RULED 2026-11-02, kanban #1062). `decideReturn`'s hash check takes these bytes as any slash proof's: only this check is their own. True when
 * the proof names this node and the very bond the start spent, and judgeAbandoned stands on it: its record at threshold on this node's own census, its row naming this node and proof_ref, a
 * spend's proof_ref read on the chain. For an absence the record's signatures are the check. The proof carries that record (kanban #1065). `bond` { txid, vout } what the start spent; `bonds` this
 * node's census read at the block before the start, since the start's hold output is no output left; `censusAt(height)` the entries there, nothing yet: this waits, as a replay that has not answered does.
 */
export async function abandonedProofChecks({ bytes, nodePubkey, bond, bonds, censusAt, networkId, inviteFederationId, from }) {
  let p; try { p = decodeAbandonedProof(bytes); } catch { return false; }
  if (!same(p.nodePubkey, nodePubkey) || !same(p.txid, bond.txid) || p.vout !== bond.vout) return false;
  let height; try { height = splitSignedRecord(p.record).record.height; } catch { return false; }
  const census = await censusAt(height);
  if (!census) return undefined;
  return judgeAbandoned({ proofBytes: bytes, census, bonds, networkId, inviteFederationId, ...(from === undefined ? {} : { from }) }).slashed;
}

/** One check for a start of any kind: an abandonment's proof by `abandoned(bytes)`, a theft's by `theft(bytes)` (kanban #1093 part 2; none given: undefined, the node stays), every other by `replay(bytes)`. */
export const proofChecksOf = ({ replay, abandoned, theft = async () => undefined }) => (bytes) => (isAbandonedProof(bytes) ? abandoned(bytes) : isTheftProof(bytes) ? theft(bytes) : replay(bytes));

/**
 * THE RETURN TO SIGN: the whole hold less `feeSats` to `toScript`, on the return leaf, with the digest the owner key signs (BIP-341 script path).
 * Answers { digest (hex), txHex (unsigned), leafHash, ...what withOwnerSignature needs }.
 */
export function returnToSign({ start, bondMaturity, returnBlocks, toScript, feeSats }) {
  const { hold } = start;
  const built = holdReturnSpend({ hold: { txid: start.txid, vout: 0, value: start.value, script: hold.script }, bondMaturity, returnBlocks, toScript, feeSats });
  if (!built.ok) throw new Error(built.why);
  const digest = tapSighash({ ...built.tx, prevouts: built.prevouts, inputIndex: 0, leafHash: hold.leaves.return });
  return { digest: toHex(digest), tx: built.tx, script: hold.scripts.return, controlBlock: holdControlBlock('return', hold).controlBlock, feeSats: String(feeSats) };
}

/** The return with the owner's signature in its witness, as hex: refused unless the signature verifies under `ownerKey` over the prepared digest. */
export function withOwnerSignature(prepared, signatureHex, ownerKey) {
  const sig = fromHex(String(signatureHex || ''));
  if (sig.length !== 64) throw new Error('an owner\'s signature is 64 bytes (BIP-340)');
  if (!schnorr.verify(sig, fromHex(prepared.digest), ownerKey)) throw new Error('that signature is not the owner key\'s over this return');
  const witness = scriptPathWitness({ stack: [sig], script: prepared.script, controlBlock: prepared.controlBlock });
  return toHex(serializeSpend({ ...prepared.tx, witnesses: [witness] }));
}

/** One pass over one start: decide, and when the return is owed, prepare it for the owner to sign. Nothing is signed or sent here. */
export async function prepareReturnIfOwed({ start, startHeight, bondMaturity, returnBlocks, tip, fetchProof, proofChecks, toScript, feeSats }) {
  const decided = await decideReturn({ start, startHeight, bondMaturity, returnBlocks, tip, fetchProof, proofChecks });
  if (decided.action !== 'return' || !toScript) return decided;
  return { ...decided, prepared: returnToSign({ start, bondMaturity, returnBlocks, toScript, feeSats }) };
}

/**
 * THE HOLD OUTPUTS A BOND CAN BE IN (5A.3B): the one its bonding presig names, with no panels, and one for each pair of panels this node signed a presig to. Map of script hex -> hold output.
 * The census cannot rebuild one, since its leaves name panels drawn from that census, and a start does not show them: a hold whose panels were lost could never be returned. So the node
 * keeps every pair it signed for (`panels` [{ a, b }] of key bytes), and only a bond's end lets them go.
 */
export function holdsOfOwnBond({ ownerKey, censusKey, bondMaturity, panels = [], clocks, tweakPoint }) {
  const holds = new Map();
  for (const p of [{ a: [], b: [] }, ...panels]) {
    const hold = holdOutputKey({ ownerKey, censusKey, panelA: p.a, panelB: p.b, bondMaturity, ...clocks }, { tweakPoint });
    if (hold.ok) holds.set(toHex(hold.script), hold);
  }
  return holds;
}

/**
 * THE NODE READS ITS OWN STARTED BOND, AND PREPARES ITS OWNER'S RETURN WHEN ONE IS OWED. `bond` as bond-withdraw.js ownOutput answers it, with
 * `hold` and `ownerKey`. `rawTxAt(height, txid)` a transaction's bytes off that block, `holdsFor(bond)` holdsOfOwnBond's map, `clocks` the
 * network's. Pure of the seat: the caller says what the census says. No secret here: the owner signs (kanban #1093 part 1).
 */
export function createHoldWatch({ clocks, holdsFor, rawTxAt, tipHeight, broadcast, fetchProof = async () => null, proofChecks = async () => undefined, returnScript = async () => null, feeSats = 1000n, notify = () => {}, log = (l) => console.log(l) }) {
  const startOf = async (bond) => {
    const raw = await rawTxAt(bond.hold.height, bond.hold.txid);
    return readSlashStart(raw, { txid: fromHex(bond.txid).reverse(), vout: bond.vout }, holdsFor(bond));
  };
  const owed = new Map();                        // bond -> { why, opensAt, prepared? }: what the dashboard shows and the owner signs
  /** What an owner is told: when each way out opens, in heights, whether this node knows the hold, and a return owed to sign. */
  async function read(bond) {
    const startHeight = bond.hold.height;
    const start = await startOf(bond);
    const out = { startTxid: bond.hold.txid, startHeight, known: !!start, returnOpensAt: returnOpensAt({ startHeight, returnBlocks: clocks.returnBlocks, bondMaturity: bond.maturity }),
      fallbackOpensAt: startHeight + clocks.fallbackBlocks - 1, proofId: start && start.proofId ? toHex(start.proofId) : null,
      returnOwed: owed.get(`${bond.txid}:${bond.vout}`) || null };
    return start && start.hold.leaves.release ? { ...out, releaseOpensAt: startHeight + clocks.holdBlocks - 1 } : out;
  }
  /** The return to `toScript`, prepared for the owner to sign once its clocks read true: { ok, prepared } or { ok: false, why }. The owner's choice. */
  async function returnTo(bond, toScript, fee = feeSats) {
    const start = await startOf(bond);
    if (!start) return { ok: false, why: `the slash started at block ${bond.hold.height} pays no hold output this node signed` };
    const opensAt = returnOpensAt({ startHeight: bond.hold.height, returnBlocks: clocks.returnBlocks, bondMaturity: bond.maturity }), tip = await tipHeight();
    if (tip < opensAt) return { ok: false, why: `the return opens at block ${opensAt}, ${opensAt - tip} from now` };
    return { ok: true, prepared: returnToSign({ start, bondMaturity: bond.maturity, returnBlocks: clocks.returnBlocks, toScript, feeSats: fee }) };
  }
  /** The owner's signature over a prepared return: checked against the bond's owner key, then sent. */
  async function submit(bond, prepared, signatureHex) {
    let hex; try { hex = withOwnerSignature(prepared, signatureHex, bond.ownerKey); } catch (e) { return { ok: false, why: e.message }; }
    let sent; try { sent = await broadcast(hex); } catch (e) { return { ok: false, why: `the return was not sent: ${e.message}` }; }
    owed.delete(`${bond.txid}:${bond.vout}`);
    log(`[hold] ${bond.txid.slice(0, 16)}: the owner's return sent: ${sent}`);
    return { ok: true, sent, hex };
  }
  /** One pass over the node's started bonds: where a proof does not check on this node's replay, the return is prepared and the owner told. A true proof is left to its slash. */
  async function pass(bonds) {
    const done = [];
    for (const bond of bonds) {
      if (!bond.hold) continue;
      const key = `${bond.txid}:${bond.vout}`;
      const start = await startOf(bond);
      if (!start) { log(`[hold] the slash started at block ${bond.hold.height} pays no hold output this node signed`); continue; }
      const decided = await prepareReturnIfOwed({ start, startHeight: bond.hold.height, bondMaturity: bond.maturity, returnBlocks: clocks.returnBlocks, tip: await tipHeight(),
        fetchProof, proofChecks, toScript: await returnScript(), feeSats });
      if (decided.action === 'return') {
        const first = !owed.has(key);
        owed.set(key, { why: decided.why, opensAt: decided.opensAt, prepared: decided.prepared || null });
        if (first) { log(`[hold] ${bond.txid.slice(0, 16)} owes its owner a return (${decided.why}): prepared, waiting for the owner's signature`); try { notify({ bond, why: decided.why }); } catch { /* told on the dashboard */ } }
      }
      done.push({ ...decided, bond });
    }
    return done;
  }
  return { read, returnTo, submit, pass };
}
