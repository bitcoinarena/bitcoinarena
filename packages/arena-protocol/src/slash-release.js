// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STARTED BOND LEAVES ITS HOLD BY A RELEASE OR A FALLBACK (spec 5A.3B, kanban #972, decision #1083). Both carry the same OP_RETURN, H(fraud_proof) ‖ slash_height ‖
// H(payout_table), and a table of one format; they differ in their wait and in who signs: t of n of both panels for a release, the census key for a fallback.
//
// Every signer builds the spend from what it reads itself, and signs only if its own bytes are the ones asked for. So everything here is a function of public inputs:
//
//   the fee      the start's own fee rate, read off the chain (its fee input, its size), never below 1 sat/vB, times the spend's exact size. The fee comes off the reserves
//   the table    buildSlashPayoutTable (slash.js) with that fee, run again until the fee it needs is the fee it was built with
//   the escrow   a P2TR output under the round's two panels, or the census key where there are none (the start's own hold with no release leaf, or a fallback)
//   the witness  exactly t signatures of each panel, in the order the leaf checks them (its NUMEQUAL counts them), or one BIP-340 signature of the census key
//
// Pure: the chain, the curve and the signatures are the caller's.
import { HOLD_INTERNAL_KEY, TAPLEAF_VERSION, holdControlBlock, panelThreshold, releaseLeaf, tapLeafHash, tapTweak } from './bond-script.js';
import { holdSlashSpend, arbitrationCommitmentIn, P2TR_DUST_SATS } from './arbitration-tx.js';
import { compactSize, scriptPathWitness, serializeSpend, tapSighash } from './bond-spend.js';
import { buildSlashPayoutTable, slashPayoutTableId, encodeSlashPayoutTable } from './slash.js';
import { parseTransaction } from './tx.js';
import { toHex } from './hash.js';

/** The lowest fee rate a release or a fallback pays, sat per vB: Bitcoin Core's own relay floor. */
export const SLASH_SPEND_FEE_RATE_FLOOR = 1n;
/** How often a table is built again for its fee before the highest fee asked is taken. */
const FEE_ROUNDS = 8;
const OP_CHECKSIG = 0xac;

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const sameBytes = (a, b) => toHex(a) === toHex(b);
const sortedKeys = (keys) => [...keys].sort((a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });

/** A transaction's virtual size from its serialisation with witnesses: weight = 3 x base + total, vsize = weight / 4 rounded up. */
export function vsizeOfSpend({ version = 2, locktime = 0, inputs, outputs, witnesses }) {
  const total = serializeSpend({ version, locktime, inputs, outputs, witnesses }).length;
  const witnessBytes = 2 + witnesses.reduce((n, w) => n + compactSize(w.length).length + w.reduce((m, item) => m + compactSize(item.length).length + item.length, 0), 0);
  const base = total - witnessBytes;
  return Math.ceil((3 * base + total) / 4);
}

/**
 * THE START'S FEE RATE, as every reader finds it on its chain: `startRaw` the start's bytes and `prevouts` [{ value }] of every input it spends, in order (input 0 the bond).
 * Its fee is what the inputs hold past its outputs; its rate that fee over its vsize, rounded up, and never under the floor. A release and a fallback pay this rate: the filer chose it
 * when the start went out, so a mainnet filer's own estimate carries into both, and no signer guesses at a mempool.
 */
export function startFeeRate({ startRaw, prevouts }) {
  const tx = parseTransaction(startRaw);
  if (!Array.isArray(prevouts) || prevouts.length !== tx.inputs.length) throw new Error('a fee rate needs the value of every input the start spends');
  const fee = prevouts.reduce((a, p) => a + BigInt(p.value), 0n) - tx.outputs.reduce((a, o) => a + o.value, 0n);
  if (fee < 0n) throw new Error('those prevouts hold less than the start pays out');
  const vsize = BigInt(vsizeOfSpend({ version: tx.version, locktime: tx.locktime, inputs: tx.inputs.map((i) => ({ txid: i.previousTxid, vout: i.previousVout, sequence: i.sequence })), outputs: tx.outputs, witnesses: tx.witnesses }));
  const rate = (fee + vsize - 1n) / vsize;
  return rate < SLASH_SPEND_FEE_RATE_FLOOR ? SLASH_SPEND_FEE_RATE_FLOOR : rate;
}

/**
 * THE ESCROW OF A SLASH (5A.3B: "escrow is what does not fit, under the round's two panels, or the census key if there are none"): a P2TR output with the hold's unspendable internal
 * key and one leaf: the release leaf of those panels (t of n of each, after slash_hold_blocks), or `<census_key> CHECKSIG`. An escrow spend answers to its table (slash.js
 * slashHoldsOnEscrowSpend) whoever signs it. `tweakPoint` the caller's curve. Answers { script, leafScript, leafHash, controlBlock, outputKey }.
 */
export function slashEscrowOutput({ panelA = [], panelB = [], holdBlocks, censusKey = null }, { tweakPoint }) {
  const panels = panelA.length > 0 && panelB.length > 0;
  if (!panels && !(censusKey instanceof Uint8Array && censusKey.length === 32)) throw new Error('an escrow with no panels is under the census key, and none was given');
  const leafScript = panels ? releaseLeaf({ panelA, panelB, holdBlocks }) : cat(Uint8Array.of(0x20), censusKey, Uint8Array.of(OP_CHECKSIG));
  const leafHash = tapLeafHash(leafScript);
  const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, leafHash));
  return { script: cat(Uint8Array.of(0x51, 0x20), q.outputKey), leafScript, leafHash, outputKey: q.outputKey, controlBlock: cat(Uint8Array.of(TAPLEAF_VERSION | q.parity), HOLD_INTERNAL_KEY) };
}

/**
 * THE WITNESS OF A RELEASE: exactly t signatures of each panel, the first t in the order the leaf checks them (each panel's keys sorted), every other slot empty. The leaf ends each
 * panel's count in NUMEQUAL, so a (t + 1)th signature would fail it. `signatures` Map of key hex -> 64 bytes, each already checked by the caller. Throws when a panel is short.
 */
export function releaseWitness({ hold, panelA, panelB, signatures }) {
  const t = panelThreshold(panelA.length);
  const line = (panel, name) => {
    let left = t;
    const items = sortedKeys(panel).map((k) => { const s = signatures.get(toHex(k)); if (s && left > 0) { left -= 1; return s; } return new Uint8Array(0); });
    if (left > 0) throw new Error(`${t - left} of the ${t} signatures panel ${name} must give`);
    return items;
  };
  const stack = [...line(panelA, 'A'), ...line(panelB, 'B')].reverse();
  return scriptPathWitness({ stack, script: hold.scripts.release, controlBlock: holdControlBlock('release', hold).controlBlock });
}

/** THE WITNESS OF A FALLBACK: one BIP-340 signature of the census key on the fallback leaf. */
export function fallbackWitness({ hold, signature }) {
  return scriptPathWitness({ stack: [signature], script: hold.scripts.fallback, controlBlock: holdControlBlock('fallback', hold).controlBlock });
}

/** A witness of the right shape and size for `path`, with no real signature in it: what the fee is reckoned on. */
function sizedWitness(path, hold, panels) {
  const sig = new Uint8Array(64);
  if (path === 'fallback') return fallbackWitness({ hold, signature: sig });
  const signatures = new Map([...panels.panelA, ...panels.panelB].map((k) => [toHex(k), sig]));
  return releaseWitness({ hold, panelA: panels.panelA, panelB: panels.panelB, signatures });
}

/** What every signer of a release or a fallback signs: BIP-341's script-path sighash of the spend's one input under that leaf, default hash type. */
export const holdSpendDigest = ({ spend, hold, path }) => tapSighash({ ...spend.tx, prevouts: spend.prevouts, inputIndex: 0, leafHash: hold.leaves[path] });

/**
 * THE RELEASE OR THE FALLBACK, WITH ITS TABLE, as every signer builds it.
 *
 *   path         'release' or 'fallback'
 *   hold         holdOutputKey's answer for this hold (its scripts, leaves and parity); `outpoint` { txid (internal order), vout, value } of the start's output 0
 *   panels       { panelA, panelB } of keys for a release (the round's)
 *   proofId      H(fraud_proof), `slashHeight` the start's OP_RETURN's
 *   rate         startFeeRate's answer, sat/vB
 *   clocks       { holdBlocks, fallbackBlocks }
 *   table        buildSlashPayoutTable's inputs less `feeSats`: { networkId, roundId, bond { txid, vout }, filer, carriers, federations, retired, escrowScript },
 *                and `entriesFor(escrowSats)` -> [{ entryId, playerPubkey, lossMsat }]: what this bond pays each player when it has that much (slashDistribution's share)
 *
 * The fee is the rate times the spend's own size, and the size depends on the table, so the table is built again with each fee asked until the one it was built with is
 * enough; the fee only goes up, so this ends, and every signer ends on the same bytes. Answers { ok, table, tableId, bytes, spend, digest, feeSats, vsize } or { ok: false, why }.
 */
export function slashHoldSpend({ path, hold, outpoint, panels = null, proofId, slashHeight, rate, clocks, table }) {
  if (path !== 'release' && path !== 'fallback') return { ok: false, why: `a hold is left by its release or its fallback, not ${path}` };
  if (path === 'release' && !(panels && hold.leaves.release)) return { ok: false, why: 'that hold has no release leaf' };
  const { entriesFor, filer = null, ...inputs } = table;
  let fee = 0n;
  for (let round = 0; round < FEE_ROUNDS; round++) {
    const left = outpoint.value - fee - (filer && filer.sats > 0n ? filer.sats : 0n);
    if (left < P2TR_DUST_SATS) return { ok: false, why: `a hold of ${outpoint.value} sat leaves ${left} sat past its fee and the filer` };
    const built = buildSlashPayoutTable({ ...inputs, proofId, filer, entries: entriesFor(left), bond: { ...inputs.bond, value: outpoint.value }, feeSats: fee });
    if (!built.ok) return built;
    const tableId = slashPayoutTableId(built.table);
    const spend = holdSlashSpend({ path, hold: { ...outpoint, script: hold.script }, proofId, slashHeight, table: built.table, tableId, clocks });
    if (!spend.ok) return spend;
    const vsize = vsizeOfSpend({ ...spend.tx, witnesses: [sizedWitness(path, hold, panels)] });
    const want = rate * BigInt(vsize);
    if (want <= fee) return { ok: true, table: built.table, tableId, bytes: encodeSlashPayoutTable(built.table), spend, digest: holdSpendDigest({ spend, hold, path }), feeSats: spend.fee.sats, vsize };
    fee = want;
  }
  return { ok: false, why: `the fee of that ${path} did not settle in ${FEE_ROUNDS} builds` };
}

/** The signed spend's bytes, and its txid (internal order). */
export function signedHoldSpend({ spend, witness }) {
  const raw = serializeSpend({ ...spend.tx, witnesses: [witness] });
  return { raw, txid: parseTransaction(raw).txid };
}

/**
 * WHO A CARRIER PAYS (5A.3B step 5: "Panel A's members bring the players' share into the federation and pay the table, in score order, none holding more than its own bond"): the
 * table's losses, in its entry order, cut across its player_carrier outputs in their order, each carrying up to its own output. A loss may be split between two carriers. A carrier
 * pays its slices whole and the rest of what it claimed to the reserves of that federation. Answers [{ index (in the table's outputs), script, value, slices: [{ entryId,
 * playerPubkey, msat }] }].
 */
export function carrierSlices(table) {
  const carriers = table.outputs.map((o, index) => ({ ...o, index })).filter((o) => o.pays === 'player_carrier').map((o) => ({ index: o.index, script: o.script, value: o.value, slices: [], room: o.value * 1000n }));
  let at = 0;
  for (const e of table.entries) {
    let owed = e.lossMsat;
    while (owed > 0n && at < carriers.length) {
      const c = carriers[at];
      const part = owed < c.room ? owed : c.room;
      if (part > 0n) { c.slices.push({ entryId: e.entryId, playerPubkey: e.playerPubkey, msat: part }); c.room -= part; owed -= part; }
      if (c.room === 0n) at += 1;
    }
  }
  return carriers.map(({ room, ...c }) => c);
}

/** Does a raw spend of a hold carry the OP_RETURN of this table? { proofId, slashHeight, tableId } or null. */
export function holdSpendNames(raw) {
  const tx = parseTransaction(raw);
  const said = tx.outputs[0] ? arbitrationCommitmentIn([tx.outputs[0]]) : null;
  return said && said.hint.length === 32 ? { proofId: said.proofId, slashHeight: said.slashHeight, tableId: said.hint } : null;
}

export { sameBytes };
