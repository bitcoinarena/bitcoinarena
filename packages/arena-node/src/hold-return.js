// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A START WITH NO GOOD PROOF, AND THE OWNER TAKES THE BOND BACK (spec 5A.3B, kanban #1021; changed by kanban #1093 part 1, ruling #1103,
// 2026-11-03: "the return leaf: owner key only. The owner signs it; there is no automatic return ... What the node does instead: it builds
// the return transaction when the leaf opens and the proof doesn't check on its replay, shows it on the dashboard, and notifies the owner.
// The owner signs with the 24 words."). The node holds no key that can move the bond: it prepares, the owner's page signs, the node sends.
//
// The chain, the replay and the proof's bytes are the caller's. A start that names a true proof is left alone: this is not a way out of a slash.
import { DatabaseSync } from 'node:sqlite';
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

/**
 * A STARTED BOND'S RETURN AS THIS NODE SEES IT (kanban #1193, the state machine audit of 2026-11-06), per { bond, start txid, start height, proof id } - a reorg that moves the
 * start is another key. none -> owed (the leaf is open and the proof does not check here: prepared for the owner) | kept (the proof checks: the bond is left to its slash).
 * owed -> owed (prepared again, another address) | kept (the proof checks after all: the prepared return is recalled) | sent (the owner's signature went out).
 * KEPT IS FOR GOOD: `proofChecks` need not be monotone (a replay that lacked a round's data, a reorg), so a start whose proof checked once is never owed a return here again,
 * and the node neither prepares nor sends one against it. The return leaf and the release race by design (#1130's cap comes before the leaf opens); this is the node's part only.
 */
export const HOLD_RETURN = Object.freeze({ NONE: 'none', OWED: 'owed', KEPT: 'kept', SENT: 'sent' });
const HOLD_RETURN_MOVES = Object.freeze({ [HOLD_RETURN.NONE]: [HOLD_RETURN.OWED, HOLD_RETURN.KEPT, HOLD_RETURN.SENT], [HOLD_RETURN.OWED]: [HOLD_RETURN.OWED, HOLD_RETURN.KEPT, HOLD_RETURN.SENT],
  [HOLD_RETURN.KEPT]: [], [HOLD_RETURN.SENT]: [] });

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
export function createHoldWatch({ clocks, holdsFor, rawTxAt, tipHeight, broadcast, fetchProof = async () => null, proofChecks = async () => undefined, returnScript = async () => null, feeSats = 1000n, notify = () => {}, log = (l) => console.log(l),
  db = new DatabaseSync(':memory:'), now = Date.now }) {
  const startOf = async (bond) => {
    const raw = await rawTxAt(bond.hold.height, bond.hold.txid);
    return readSlashStart(raw, { txid: fromHex(bond.txid).reverse(), vout: bond.vout }, holdsFor(bond));
  };
  // WHAT THE DASHBOARD SHOWS AND THE OWNER SIGNS, ON DISK (kanban #1193): one row per { bond, start, start height, proof }, moved by returnStep only (HOLD_RETURN)
  db.exec(`CREATE TABLE IF NOT EXISTS hold_returns (bond TEXT NOT NULL, start TEXT NOT NULL, start_height INTEGER NOT NULL, proof_id TEXT NOT NULL, state TEXT NOT NULL, why TEXT,
    opens_at INTEGER, to_script TEXT, fee TEXT, sent TEXT, at_ms INTEGER NOT NULL, PRIMARY KEY (bond, start, start_height, proof_id))`);
  const keyOf = (bond, start) => [`${bond.txid}:${bond.vout}`, String(bond.hold.txid), Number(bond.hold.height), start && start.proofId ? toHex(start.proofId) : ''];
  const rowOf = (k) => db.prepare('SELECT * FROM hold_returns WHERE bond = ? AND start = ? AND start_height = ? AND proof_id = ?').get(...k) || null;
  const stateOf = (k) => { const r = rowOf(k); return r ? r.state : HOLD_RETURN.NONE; };
  /** THE ONE TRANSITION: compare and set on the row. False, nothing written, unless the start is in `from` now and HOLD_RETURN_MOVES has the move. */
  function returnStep(k, from, to, fields = {}) {
    if (!HOLD_RETURN_MOVES[from].includes(to) || stateOf(k) !== from) return false;
    const had = rowOf(k);
    const v = { why: fields.why ?? (had && had.why), opensAt: fields.opensAt ?? (had && had.opens_at), toScript: fields.toScript ?? (had && had.to_script), fee: fields.fee ?? (had && had.fee), sent: fields.sent ?? (had && had.sent) };
    const r = had
      ? db.prepare('UPDATE hold_returns SET state = ?, why = ?, opens_at = ?, to_script = ?, fee = ?, sent = ?, at_ms = ? WHERE bond = ? AND start = ? AND start_height = ? AND proof_id = ? AND state = ?')
        .run(to, v.why ?? null, v.opensAt ?? null, v.toScript ?? null, v.fee ?? null, v.sent ?? null, now(), ...k, from)
      : db.prepare('INSERT OR IGNORE INTO hold_returns (bond, start, start_height, proof_id, state, why, opens_at, to_script, fee, sent, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(...k, to, v.why ?? null, v.opensAt ?? null, v.toScript ?? null, v.fee ?? null, v.sent ?? null, now());
    return Number(r.changes) === 1;
  }
  /** A start whose proof checks on this node's replay is KEPT, for good: a prepared return is recalled and none is prepared or sent again for it. */
  const keep = (k, why) => {
    const from = stateOf(k);
    if (from === HOLD_RETURN.KEPT || from === HOLD_RETURN.SENT) return from === HOLD_RETURN.KEPT;
    if (!returnStep(k, from, HOLD_RETURN.KEPT, { why })) return false;
    if (from === HOLD_RETURN.OWED) log(`[hold] ${k[0].slice(0, 16)}: the return prepared for start ${k[1].slice(0, 16)} is recalled: ${why}`);
    return true;
  };
  /** The owed return as the dashboard shows it, rebuilt from its row (the same bytes: returnToSign is a function of the start, the script and the fee). */
  const owedOf = (bond, start) => {
    const r = start && rowOf(keyOf(bond, start));
    if (!r || r.state !== HOLD_RETURN.OWED) return null;
    return { why: r.why, opensAt: r.opens_at, prepared: r.to_script ? returnToSign({ start, bondMaturity: bond.maturity, returnBlocks: clocks.returnBlocks, toScript: fromHex(r.to_script), feeSats: BigInt(r.fee) }) : null };
  };
  /** What an owner is told: when each way out opens, in heights, whether this node knows the hold, and a return owed to sign. */
  async function read(bond) {
    const startHeight = bond.hold.height;
    const start = await startOf(bond);
    const out = { startTxid: bond.hold.txid, startHeight, known: !!start, returnOpensAt: returnOpensAt({ startHeight, returnBlocks: clocks.returnBlocks, bondMaturity: bond.maturity }),
      fallbackOpensAt: startHeight + clocks.fallbackBlocks - 1, proofId: start && start.proofId ? toHex(start.proofId) : null,
      returnOwed: owedOf(bond, start) };
    return start && start.hold.leaves.release ? { ...out, releaseOpensAt: startHeight + clocks.holdBlocks - 1 } : out;
  }
  /** This node's own word on the start now: a proof that checks moves it to KEPT. Answers why not, or null. */
  async function refusal(bond, start, tip) {
    const k = keyOf(bond, start);
    if (stateOf(k) === HOLD_RETURN.KEPT) return 'the proof this start names checked on this node\'s replay: this node prepares and sends no return against it';
    const decided = await decideReturn({ start, startHeight: bond.hold.height, bondMaturity: bond.maturity, returnBlocks: clocks.returnBlocks, tip, fetchProof, proofChecks });
    if (decided.action === 'keep') { keep(k, decided.why); return `${decided.why}: this node prepares and sends no return against it`; }
    return null;
  }
  /** The return to `toScript`, prepared for the owner to sign once its clocks read true: { ok, prepared } or { ok: false, why }. The owner's choice - but never against a proof that checks here. */
  async function returnTo(bond, toScript, fee = feeSats) {
    const start = await startOf(bond);
    if (!start) return { ok: false, why: `the slash started at block ${bond.hold.height} pays no hold output this node signed` };
    const opensAt = returnOpensAt({ startHeight: bond.hold.height, returnBlocks: clocks.returnBlocks, bondMaturity: bond.maturity }), tip = await tipHeight();
    if (tip < opensAt) return { ok: false, why: `the return opens at block ${opensAt}, ${opensAt - tip} from now` };
    const no = await refusal(bond, start, tip);
    if (no) return { ok: false, why: no };
    return { ok: true, prepared: returnToSign({ start, bondMaturity: bond.maturity, returnBlocks: clocks.returnBlocks, toScript, feeSats: fee }) };
  }
  /** The owner's signature over a prepared return: checked against the bond's owner key, the proof asked again, then sent. */
  async function submit(bond, prepared, signatureHex) {
    let hex; try { hex = withOwnerSignature(prepared, signatureHex, bond.ownerKey); } catch (e) { return { ok: false, why: e.message }; }
    const start = await startOf(bond);
    if (start) { const no = await refusal(bond, start, await tipHeight()); if (no) return { ok: false, why: no }; }
    let sent; try { sent = await broadcast(hex); } catch (e) { return { ok: false, why: `the return was not sent: ${e.message}` }; }
    if (start) { const k = keyOf(bond, start), from = stateOf(k); if (from !== HOLD_RETURN.SENT) returnStep(k, from, HOLD_RETURN.SENT, { sent: String(sent) }); }
    log(`[hold] ${bond.txid.slice(0, 16)}: the owner's return sent: ${sent}`);
    return { ok: true, sent, hex };
  }
  /** One pass over the node's started bonds: where a proof does not check on this node's replay, the return is prepared and the owner told. A true proof is left to its slash. */
  async function pass(bonds) {
    const done = [];
    for (const bond of bonds) {
      if (!bond.hold) continue;
      const start = await startOf(bond);
      if (!start) { log(`[hold] the slash started at block ${bond.hold.height} pays no hold output this node signed`); continue; }
      const k = keyOf(bond, start), state = stateOf(k);
      // KEPT IS FOR GOOD (kanban #1193): a replay that later says otherwise prepares nothing; SENT is done
      if (state === HOLD_RETURN.KEPT || state === HOLD_RETURN.SENT) { done.push({ action: state === HOLD_RETURN.KEPT ? 'keep' : 'sent', why: `this start is ${state} here`, bond }); continue; }
      const toScript = await returnScript();
      const decided = await prepareReturnIfOwed({ start, startHeight: bond.hold.height, bondMaturity: bond.maturity, returnBlocks: clocks.returnBlocks, tip: await tipHeight(),
        fetchProof, proofChecks, toScript, feeSats });
      if (decided.action === 'keep') keep(k, decided.why);
      if (decided.action === 'return') {
        const first = state === HOLD_RETURN.NONE;
        returnStep(k, state, HOLD_RETURN.OWED, { why: decided.why, opensAt: decided.opensAt, ...(decided.prepared ? { toScript: toHex(toScript), fee: String(feeSats) } : {}) });
        if (first) { log(`[hold] ${bond.txid.slice(0, 16)} owes its owner a return (${decided.why}): prepared, waiting for the owner's signature`); try { notify({ bond, why: decided.why }); } catch { /* told on the dashboard */ } }
      }
      done.push({ ...decided, bond });
    }
    return done;
  }
  return { read, returnTo, submit, pass, stateOf: (bond, start) => stateOf(keyOf(bond, start)) };
}
