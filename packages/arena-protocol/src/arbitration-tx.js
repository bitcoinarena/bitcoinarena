// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARBITRATION TRANSACTION, BUILT (§5A.3B "From proof to transaction", §5A.3's distribution; PRIORITIES
// 2026-09-29 item 4, M4 in the repo only: built and checked, never posted, never spent against a live bond).
//
//   3. k-of-m arbitration keys sign a slashing transaction spending path B (the bond's slash leaf), naming
//      slash_height: <= the tip when they sign, >= the round's census_height; nLockTime = slash_height.
//   4. It MUST carry OP_RETURN = H(fraud_proof) || slash_height || retrieval hint.
//   5. One output, an escrow, pays §5A.3: each player's real loss, then the rest to the protocol reserves, both through
//      the federation. Nothing to the nodes or the developers.
//
// WHAT THE SPEC FIXES AND WHAT IT LEAVES TO THE CALLER, said rather than invented:
//   - the escrow is under the arbitration keys (§23A.5's shape): here a P2TR output whose one leaf is the same k-of-m
//     `slashLeaf` the bond carries, its internal key the keys' BIP-327 aggregate. Built by `escrowOutput`, the curve
//     injected (this package carries none).
//   - slash_height in the OP_RETURN: 4 bytes, big-endian - this protocol's own u32 (encode.js); the spec fixes the
//     order of the three fields, not the width.
//   - the fees: one output leaves one place to take them from. They come off the escrow, and so off what the
//     reserves get; a player's loss is paid whole while the bond covers it (slash.js slashDistribution).
import { slashLeaf, tapLeafHash, tapTweak, aggregateKeys } from './bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend, compactSize } from './bond-spend.js';
import { toHex } from './hash.js';

/** Below this a P2TR output is dust to Bitcoin Core's relay policy (330 sat). */
export const P2TR_DUST_SATS = 330n;

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const u32be = (n) => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const compare32 = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

/** Step 4's output: OP_RETURN of the proof id, the slash height (u32 big-endian) and the hint - at most 80 bytes. */
export function arbitrationCommitment(proofId, slashHeight, hint = new Uint8Array(0)) {
  if (!(proofId instanceof Uint8Array) || proofId.length !== 32) throw new TypeError('a slash commits to a 32-byte proof id');
  if (!Number.isInteger(slashHeight) || slashHeight < 0 || slashHeight >= 500000000)
    throw new RangeError('a slash height is a block height (nLockTime below 500000000)');
  const payload = cat(proofId, u32be(slashHeight), hint);
  if (payload.length > 80) throw new RangeError('an OP_RETURN carries at most 80 bytes');
  return { value: 0n, script: cat(Uint8Array.from([0x6a]), compactSize(payload.length), payload) };
}

/** And the reading of it: the proof id, the slash height and the hint a transaction's outputs commit to, or null. */
export function arbitrationCommitmentIn(outputs) {
  for (const o of outputs || []) {
    const s = o.script;
    if (!s || s[0] !== 0x6a || s.length < 2 + 36 || s[1] < 36 || s.length !== 2 + s[1]) continue;
    const b = s.subarray(2);
    return { proofId: b.subarray(0, 32), slashHeight: ((b[32] << 24) | (b[33] << 16) | (b[34] << 8) | b[35]) >>> 0, hint: b.subarray(36) };
  }
  return null;
}

/**
 * THE SLASH'S ESCROW (§23A.5's shape, §5A.3B step 5): a P2TR output under the arbitration set's k-of-m keys - one leaf, the slash
 * leaf; the internal key the keys' aggregate. `curve` is `{ tweakPoint, combine }` as bond-script.js takes them.
 */
export function escrowOutput({ arbitrationKeys, k }, { tweakPoint, combine }) {
  const script = slashLeaf(arbitrationKeys, k);
  const leaf = tapLeafHash(script);
  const agg = aggregateKeys(arbitrationKeys, { combine });
  if (!agg.ok) throw new Error(`the escrow's internal key: ${agg.why}`);
  const internalKey = agg.key;
  const tweaked = tweakPoint(internalKey, tapTweak(internalKey, leaf));
  // ONE LEAF: the control block is the leaf version with the output key's parity, and the internal key - no path.
  const controlBlock = cat(Uint8Array.from([0xc0 | tweaked.parity]), internalKey);
  return { script: cat(Uint8Array.from([0x51, 0x20]), tweaked.outputKey), outputKey: tweaked.outputKey, internalKey, leafScript: script, leaf, controlBlock };
}

/**
 * THE UNSIGNED SLASHING TRANSACTION: the bond's outpoint spent by path B, nLockTime = slash_height, the commitment first, then the
 * ONE output: the escrow, the whole bond less the fee (§5A.3B step 5). Who the escrow pays is decided when it is spent.
 *
 *   bond         { txid (internal byte order), vout, value (sat, BigInt), script (the bond's P2TR scriptPubKey) }
 *   feeSats      the transaction's fee, BigInt
 * Refuses by name: a height out of range, a fee that leaves the escrow below dust, no escrow script.
 */
export function arbitrationSpend({ bond, proofId, slashHeight, hint = new Uint8Array(0), escrowScript, feeSats }) {
  if (typeof feeSats !== 'bigint' || feeSats < 0n) return { ok: false, why: 'the fee is BigInt satoshi' };
  const escrow = bond.value - feeSats;
  if (escrow < P2TR_DUST_SATS) return { ok: false, why: `a bond of ${bond.value} sat less a ${feeSats} sat fee is ${escrow} sat, below dust` };
  if (!(escrowScript instanceof Uint8Array)) return { ok: false, why: 'no script for the escrow output' };
  const outputs = [arbitrationCommitment(proofId, slashHeight, hint), { value: escrow, script: escrowScript, pays: 'the slash\'s escrow' }];
  const tx = { version: 2, locktime: slashHeight, inputs: [{ txid: bond.txid, vout: bond.vout, sequence: 0xfffffffe }], outputs };
  return { ok: true, tx, prevouts: [{ value: bond.value, script: bond.script }], fee: { sats: feeSats }, amounts: { escrow } };
}

/**
 * AN ESCROW INTO ONE FEDERATION (§23A.5 step 4): the arbitration set spends an escrow output (`escrowOutput`'s one k-of-m leaf) to the
 * federation's peg-in address - the whole output less the fee, one output. Signed as path B is:
 * `arbitrationSighash(built, escrow.leaf)`, `arbitrationWitness` with the escrow's control block.
 *
 *   escrow   { txid (internal byte order), vout, value (sat, BigInt), script (the escrow's P2TR scriptPubKey) }
 *   toScript the peg-in address's scriptPubKey
 */
export function escrowSpend({ escrow, toScript, feeSats }) {
  if (typeof feeSats !== 'bigint' || feeSats < 0n) return { ok: false, why: 'the fee is BigInt satoshi' };
  if (!escrow || typeof escrow.value !== 'bigint' || !(escrow.script instanceof Uint8Array)) return { ok: false, why: 'the escrow is { txid, vout, value: BigInt sat, script }' };
  if (!(toScript instanceof Uint8Array) || !toScript.length) return { ok: false, why: 'no peg-in script to pay' };
  const value = escrow.value - feeSats;
  if (value < P2TR_DUST_SATS) return { ok: false, why: `the escrow of ${escrow.value} sat less a ${feeSats} sat fee is ${value} sat, below dust` };
  const tx = { version: 2, locktime: 0, inputs: [{ txid: escrow.txid, vout: escrow.vout, sequence: 0xfffffffd }], outputs: [{ value, script: toScript, pays: 'the federation\'s peg-in' }] };
  return { ok: true, tx, prevouts: [{ value: escrow.value, script: escrow.script }], fee: { sats: feeSats }, amounts: { pegIn: value } };
}

/**
 * ONE ESCROW SPEND, SEVERAL OUTPUTS (§27A.9.2 "One escrow spend pays them, one peg-in each"): a slash's escrow to the peg-ins its plan
 * names, and what does not fit back to the same escrow (slash-reserves.js planEscrowSpend). Signed as `escrowSpend` is.
 *
 *   escrow   { txid (internal byte order), vout, value (sat, BigInt), script }
 *   payees   [{ script, sats (BigInt), pays }] - with the fee, exactly the escrow
 */
export function escrowSplitSpend({ escrow, payees, feeSats }) {
  if (typeof feeSats !== 'bigint' || feeSats < 0n) return { ok: false, why: 'the fee is BigInt satoshi' };
  if (!escrow || typeof escrow.value !== 'bigint' || !(escrow.script instanceof Uint8Array)) return { ok: false, why: 'the escrow is { txid, vout, value: BigInt sat, script }' };
  if (!Array.isArray(payees) || !payees.length) return { ok: false, why: 'no payee to pay' };
  const total = payees.reduce((a, p) => a + p.sats, 0n);
  if (total + feeSats !== escrow.value) return { ok: false, why: `the payees take ${total} sat and the fee ${feeSats}, and the escrow holds ${escrow.value}` };
  for (const p of payees) {
    if (!(p.script instanceof Uint8Array) || !p.script.length) return { ok: false, why: `no script for ${p.pays || 'a payee'}` };
    if (p.sats < P2TR_DUST_SATS) return { ok: false, why: `${p.pays || 'a payee'} would be paid ${p.sats} sat, below dust` };
  }
  const tx = { version: 2, locktime: 0, inputs: [{ txid: escrow.txid, vout: escrow.vout, sequence: 0xfffffffd }],
    outputs: payees.map((p) => ({ value: p.sats, script: p.script, pays: p.pays })) };
  return { ok: true, tx, prevouts: [{ value: escrow.value, script: escrow.script }], fee: { sats: feeSats } };
}

/**
 * A SLASH OUT OF A HOLD OUTPUT (5A.3B, kanban #1021): a release or a fallback, the same transaction but for its wait. The OP_RETURN comes
 * first, H(fraud_proof) || slash_height || payout_table_id, then the table's outputs in its order: a fallback carries the same OP_RETURN fields
 * and a table of this format. The fee is what the table leaves of the bond.
 *
 *   hold     { txid (internal byte order), vout, value (sat, BigInt), script }, the output the start paid
 *   clocks   { holdBlocks, fallbackBlocks }
 *   table    a PayoutTable (slash.js), `tableId` its id
 */
export function holdSlashSpend({ path, hold, proofId, slashHeight, table, tableId, clocks }) {
  if (path !== 'release' && path !== 'fallback') return { ok: false, why: `a slash leaves a hold output by its release or its fallback, not ${path}` };
  const paid = table.outputs.reduce((a, o) => a + o.value, 0n);
  if (paid > hold.value) return { ok: false, why: `that table pays ${paid} sat out of ${hold.value}` };
  const sequence = path === 'release' ? clocks.holdBlocks : clocks.fallbackBlocks;
  const tx = { version: 2, locktime: 0, inputs: [{ txid: hold.txid, vout: hold.vout, sequence }],
    outputs: [arbitrationCommitment(proofId, slashHeight, tableId), ...table.outputs.map((o) => ({ value: o.value, script: o.script }))] };
  return { ok: true, tx, prevouts: [{ value: hold.value, script: hold.script }], fee: { sats: hold.value - paid } };
}

/**
 * THE NODE'S WAY OUT OF A HOLD OUTPUT: the return leaf, the whole output less the fee to `toScript`. nLockTime is the bond's maturity and
 * the sequence is the return clock, so the leaf's two locks both read true from the first block they can.
 */
export function holdReturnSpend({ hold, bondMaturity, returnBlocks, toScript, feeSats }) {
  if (typeof feeSats !== 'bigint' || feeSats < 0n) return { ok: false, why: 'the fee is BigInt satoshi' };
  const value = hold.value - feeSats;
  if (value < P2TR_DUST_SATS) return { ok: false, why: `a hold of ${hold.value} sat less a ${feeSats} sat fee is below dust` };
  const tx = { version: 2, locktime: bondMaturity, inputs: [{ txid: hold.txid, vout: hold.vout, sequence: returnBlocks }], outputs: [{ value, script: toScript }] };
  return { ok: true, tx, prevouts: [{ value: hold.value, script: hold.script }], fee: { sats: feeSats } };
}

/** What each arbitration key signs: the BIP-341 script-path sighash of the spend's one input under the slash leaf. */
export function arbitrationSighash(built, leaf) {
  return tapSighash({ ...built.tx, prevouts: built.prevouts, inputIndex: 0, leafHash: leaf });
}

/**
 * THE WITNESS FROM THE SIGNATURES GIVEN, by x-only key hex: the slash leaf checks the keys in sorted order, so the
 * stack is one item per sorted key - its signature or empty - bottom-first. Fewer than k is refused here rather than
 * handed to a node that refuses it later.
 */
export function arbitrationWitness({ arbitrationKeys, k, signatures, controlBlock }) {
  const sorted = [...arbitrationKeys].sort(compare32);
  const items = sorted.map((key) => signatures.get(toHex(key)) || new Uint8Array(0));
  const signed = items.filter((x) => x.length).length;
  if (signed < k) return { ok: false, why: `${signed} of the ${k} arbitration signatures the slash leaf needs` };
  return { ok: true, witness: scriptPathWitness({ stack: items.reverse(), script: slashLeaf(arbitrationKeys, k), controlBlock }) };
}

/** The signed transaction's bytes. */
export function arbitrationTransaction(built, witness) {
  return serializeSpend({ ...built.tx, witnesses: [witness] });
}
