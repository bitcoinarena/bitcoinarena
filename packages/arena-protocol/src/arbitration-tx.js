// THE ARBITRATION TRANSACTION, BUILT (§5A.3B "From proof to transaction", §5A.3's distribution; PRIORITIES
// 2026-09-29 item 4, M4 in the repo only: built and checked, never posted, never spent against a live bond).
//
//   3. k-of-m arbitration keys sign a slashing transaction spending path B (the bond's slash leaf), naming
//      slash_height: <= the tip when they sign, >= the round's census_height; nLockTime = slash_height.
//   4. It MUST carry OP_RETURN = H(fraud_proof) || slash_height || retrieval hint.
//   5. Outputs pay §5A.3's distribution from the census at slash_height: the players' escrow, the active nodes'
//      share, the developers' share. "A bond's on-chain outputs are three - players' escrow, nodes, developers -
//      never one per player."
//
// WHAT THE SPEC FIXES AND WHAT IT LEAVES TO THE CALLER, said rather than invented:
//   - the players' output goes to an escrow under the arbitration keys (§23A.5's shape): here a P2TR output whose one
//     leaf is the same k-of-m `slashLeaf` the bond carries, its internal key the keys' BIP-327 aggregate. Built by
//     `escrowOutput`, the curve injected (this package carries none).
//   - the nodes' and the developers' outputs: the spec names who is paid, not the script that pays them, so their
//     scripts are the caller's (`nodesScript`, `developersScript`).
//   - slash_height in the OP_RETURN: 4 bytes, big-endian - this protocol's own u32 (encode.js); the spec fixes the
//     order of the three fields, not the width.
//   - the transaction's fee is not in §5A.3's distribution. It is taken from the nodes' output and then the
//     developers', never from the players' escrow (§23A: players cannot lose). NOT RULED: the caller is told the fee
//     it took and from where.
// Amounts come from `slashDistribution` (slash.js): players = its players' shares; nodes = its nodes' shares + the pool's nodes' part;
// developers = toDevelopers + the pool's developers' part. They sum to the bond, less the fee.
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
 * THE PLAYERS' ESCROW (§23A.5's shape): a P2TR output under the arbitration set's k-of-m keys - one leaf, the slash
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
 * THE UNSIGNED SLASHING TRANSACTION: the bond's outpoint spent by path B, nLockTime = slash_height, the commitment
 * first, then the players' escrow, the nodes' output and the developers' output.
 *
 *   bond         { txid (internal byte order), vout, value (sat, BigInt), script (the bond's P2TR scriptPubKey) }
 *   distribution slashDistribution(...)'s answer for this bond's value
 *   feeSats      the transaction's fee, BigInt
 * Refuses by name: a height out of range, amounts that do not come to the bond, a fee the nodes' and developers'
 * outputs cannot carry, an output below dust.
 */
export function arbitrationSpend({ bond, proofId, slashHeight, hint = new Uint8Array(0), distribution, escrowScript, nodesScript, developersScript, feeSats }) {
  if (typeof feeSats !== 'bigint' || feeSats < 0n) return { ok: false, why: 'the fee is BigInt satoshi' };
  const d = distribution;
  // WHAT WAS HANDED OUT, not the halves' nominal sizes: a half with nobody to pay, and every leftover satoshi, is in the
  // pool, which slash.js splits 75/25 between the nodes and the developers.
  const sum = (m) => [...(m || new Map()).values()].reduce((x, y) => x + y, 0n);
  const players = sum(d.playerShares);
  let nodes = sum(d.nodeShares) + d.pool.nodes;
  let developers = d.toDevelopers + d.pool.developers;
  if (players + nodes + developers !== bond.value)
    return { ok: false, why: `the distribution comes to ${players + nodes + developers} sat and the bond holds ${bond.value}` };
  // THE FEE, from the nodes' output and then the developers' - never the players'.
  const fromNodes = feeSats <= nodes ? feeSats : nodes;
  const fromDevelopers = feeSats - fromNodes;
  if (fromDevelopers > developers) return { ok: false, why: `a fee of ${feeSats} sat is more than the nodes' and developers' outputs carry` };
  nodes -= fromNodes; developers -= fromDevelopers;
  const outputs = [arbitrationCommitment(proofId, slashHeight, hint)];
  for (const [what, value, script] of [['players\' escrow', players, escrowScript], ['nodes\'', nodes, nodesScript], ['developers\'', developers, developersScript]]) {
    if (value === 0n) continue;
    if (value < P2TR_DUST_SATS) return { ok: false, why: `the ${what} output would be ${value} sat, below dust` };
    if (!(script instanceof Uint8Array)) return { ok: false, why: `no script for the ${what} output` };
    outputs.push({ value, script, pays: what });
  }
  const tx = { version: 2, locktime: slashHeight, inputs: [{ txid: bond.txid, vout: bond.vout, sequence: 0xfffffffe }], outputs };
  return { ok: true, tx, prevouts: [{ value: bond.value, script: bond.script }], fee: { sats: feeSats, fromNodes, fromDevelopers },
    amounts: { players, nodes, developers } };
}

/**
 * THE PLAYERS' ESCROW INTO THE FEDERATION (§5A.3B "escrow into the federation", kanban #307): the arbitration set spends an
 * escrow output a slash paid (`escrowOutput`'s one k-of-m leaf) to the federation's peg-in address - the whole output less
 * the fee, one output - and the e-cash claimed from it is what the players' locks are made from. Signed as path B is:
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
 * A SLASHED GUARDIAN'S ESCROW, PAID OUT ONCE ITS FEDERATION IS CLOSED (§23A.5, FEDERATION.md rehearsal 14): the arbitration set
 * spends the escrow output to the payees federation-slash.js `guardianSlashPayees` names - each census node outside the
 * federation's guardians, and the donation set. Signed as `escrowSpend` is.
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
