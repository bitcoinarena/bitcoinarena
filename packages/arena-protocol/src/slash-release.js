// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STARTED BOND LEAVES ITS HOLD BY A RELEASE OR A FALLBACK (spec 5A.3B, kanban #972, decision #1083). Both carry the same OP_RETURN, H(fraud_proof) ‖ slash_height ‖
// H(payout_table), and a table of one format; they differ in their wait and in who signs: t of n of both panels for a release, the census key for a fallback.
//
// Every signer builds the spend from what it reads itself, and signs only if its own bytes are the ones asked for. So everything here is a function of public inputs:
//
//   the fee      the start's own fee rate, read off the chain (its fee input, its size), never below 1 sat/vB, times the spend's exact size. The fee comes off the reserves
//   the table    buildSlashPayoutTable (slash.js) with that fee, run again until the fee it needs is the fee it was built with
//   the escrow   a P2TR output with the hold's release leaf (no wait) and its fallback leaf; the fallback leaf alone where there are no panels and on a fallback (#1085)
//   the witness  exactly t signatures of each panel, in the order the leaf checks them (its NUMEQUAL counts them), or one BIP-340 signature of the census key
//
// Pure: the chain, the curve and the signatures are the caller's.
import { HOLD_INTERNAL_KEY, TAPLEAF_VERSION, escrowReleaseLeaf, fallbackLeaf, holdControlBlock, panelThreshold, tapBranchHash, tapLeafHash, tapTweak } from './bond-script.js';
import { holdSlashSpend, arbitrationCommitmentIn, P2TR_DUST_SATS } from './arbitration-tx.js';
import { compactSize, scriptPathWitness, serializeSpend, tapSighash } from './bond-spend.js';
import { buildSlashPayoutTable, slashPayoutTableId, encodeSlashPayoutTable, encodeSlashEscrowOutputs, escrowTableSpend, slashEscrowOutputsId, outputMarginMsat } from './slash.js';
import { reserveParts } from './slash-reserves.js';
import { parseTransaction } from './tx.js';
import { toHex } from './hash.js';

/** The lowest fee rate a release or a fallback pays, sat per vB: Bitcoin Core's own relay floor. */
export const SLASH_SPEND_FEE_RATE_FLOOR = 1n;
/** How often a table is built again for its fee before the highest fee asked is taken. */
const FEE_ROUNDS = 8;

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
 * THE ESCROW OF A SLASH (5A.3B; RULED 2026-11-03, kanban #1085): a P2TR output with the hold's unspendable internal key and the hold output's two spending leaves, without the return:
 *
 *   release    t-of-n panel A + t-of-n panel B          no wait          (escrowReleaseLeaf)
 *   fallback   <slash_fallback_blocks> CSV, census key   if the panels don't sign
 *
 * With no panels (a round without them, and every fallback: the panels did not sign), only the fallback leaf. There is no return leaf: this money is owed to players and the
 * reserves, never the node's again. `tweakPoint` the caller's curve. Answers { script, outputKey, parity, scripts, leaves, panels, controlBlock(path) }.
 */
export function slashEscrowOutput({ panelA = [], panelB = [], censusKey = null, fallbackBlocks }, { tweakPoint }) {
  const panels = panelA.length > 0 && panelB.length > 0;
  if (!(censusKey instanceof Uint8Array && censusKey.length === 32)) throw new Error('an escrow\'s fallback leaf is under the census key, and none was given');
  if (!Number.isInteger(fallbackBlocks) || fallbackBlocks < 1) throw new Error('an escrow\'s fallback leaf waits slash_fallback_blocks, and none was given');
  const scripts = { fallback: fallbackLeaf({ censusKey, fallbackBlocks }), ...(panels ? { release: escrowReleaseLeaf({ panelA, panelB }) } : {}) };
  const leaves = { fallback: tapLeafHash(scripts.fallback), ...(panels ? { release: tapLeafHash(scripts.release) } : {}) };
  const root = panels ? tapBranchHash(leaves.release, leaves.fallback) : leaves.fallback;
  const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, root));
  const controlBlock = (path) => {
    if (!leaves[path]) throw new Error(`that escrow has no ${path} leaf`);
    const proof = !panels ? [] : path === 'release' ? [leaves.fallback] : [leaves.release];
    return cat(Uint8Array.of(TAPLEAF_VERSION | q.parity), HOLD_INTERNAL_KEY, ...proof);
  };
  return { script: cat(Uint8Array.of(0x51, 0x20), q.outputKey), outputKey: q.outputKey, parity: q.parity, scripts, leaves, panels, controlBlock };
}

/** Exactly t signatures of each panel, in the order a panels' leaf checks them (each panel's keys sorted), every other slot empty, bottom-first. Throws when a panel is short. */
function panelStack({ panelA, panelB, signatures }) {
  const t = panelThreshold(panelA.length);
  const line = (panel, name) => {
    let left = t;
    const items = sortedKeys(panel).map((k) => { const s = signatures.get(toHex(k)); if (s && left > 0) { left -= 1; return s; } return new Uint8Array(0); });
    if (left > 0) throw new Error(`${t - left} of the ${t} signatures panel ${name} must give`);
    return items;
  };
  return [...line(panelA, 'A'), ...line(panelB, 'B')].reverse();
}

/**
 * THE WITNESS OF A RELEASE: exactly t signatures of each panel, the first t in the order the leaf checks them (each panel's keys sorted), every other slot empty. The leaf ends each
 * panel's count in NUMEQUAL, so a (t + 1)th signature would fail it. `signatures` Map of key hex -> 64 bytes, each already checked by the caller. Throws when a panel is short.
 */
export function releaseWitness({ hold, panelA, panelB, signatures }) {
  return scriptPathWitness({ stack: panelStack({ panelA, panelB, signatures }), script: hold.scripts.release, controlBlock: holdControlBlock('release', hold).controlBlock });
}

/** THE WITNESS OF AN ESCROW SPEND: t of each panel on its release leaf, or one census key signature on its fallback leaf. `escrow` slashEscrowOutput's answer. */
export function escrowWitness({ escrow, path, panelA, panelB, signatures, signature }) {
  if (path === 'release') return scriptPathWitness({ stack: panelStack({ panelA, panelB, signatures }), script: escrow.scripts.release, controlBlock: escrow.controlBlock('release') });
  return scriptPathWitness({ stack: [signature], script: escrow.scripts.fallback, controlBlock: escrow.controlBlock('fallback') });
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
 *   table        buildSlashPayoutTable's inputs less `feeSats`: { networkId, roundId, bond { txid, vout }, filer, carriers, federations, retired, escrowScript, marginMsat },
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
 * table's losses, in its entry order, cut across its player_carrier outputs in their order, each carrying up to its own output less the carrier margin it holds (kanban #1086).
 * A loss may be split between two carriers. A carrier pays its slices whole and the rest of what it claimed, less its payout's fee, to the reserves of that federation.
 * Answers [{ index (in the table's outputs), script, value, slices: [{ entryId, playerPubkey, msat }] }].
 */
const roomOf = (value, margin) => (value * 1000n > margin ? value * 1000n - margin : 0n);
export function carrierSlices(table) {
  const margin = outputMarginMsat(table);
  const carriers = table.outputs.map((o, index) => ({ ...o, index })).filter((o) => o.pays === 'player_carrier').map((o) => ({ index: o.index, script: o.script, value: o.value, slices: [], room: roomOf(o.value, margin) }));
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

// ---- THE ESCROW SPEND (RULED 2026-11-03, kanban #1085) ----

/**
 * WHAT THE PLAYERS ARE STILL OWED, AND WHO CARRIED WHAT, along an escrow's spends. `table` the confirmed table; `spends` [{ value (the escrow it spent), outputs: [{ value, script,
 * pays }], marginMsat, marginOff }] in chain order (decodeSlashEscrowOutputs' fields). Each entry starts at its loss less what the table's carriers took of it (carrierSlices); each
 * spend cuts what is left across its player_carrier outputs in their order, each up to its value less the margin it holds, as a table does. When a spend holds less than the
 * players are owed once its fee is off (no reserves' part left to bear it), every entry's part is scaled to what there is, pro rata to what it is owed, the odd msat one each in
 * entry order: the fee comes off each player's part pro rata to its loss.
 * Answers { spends: [[{ index, script, value, slices: [{ entryId, playerPubkey, msat }] }]], remaining: [{ entryId, playerPubkey, msat }] }.
 */
export function escrowSlices({ table, spends = [] }) {
  const left = new Map(table.entries.map((e) => [toHex(e.entryId), { entryId: e.entryId, playerPubkey: e.playerPubkey, msat: e.lossMsat }]));
  for (const c of carrierSlices(table)) for (const x of c.slices) left.get(toHex(x.entryId)).msat -= x.msat;
  const out = [];
  for (const sp of spends) {
    const margin = outputMarginMsat(sp);
    const fee = sp.value - sp.outputs.reduce((a, o) => a + o.value, 0n);
    const room = (sp.value - fee) * 1000n - sp.outputs.filter((o) => o.pays === 'player_carrier').reduce((a, o) => a + o.value * 1000n - roomOf(o.value, margin), 0n);
    const owed = [...left.values()].filter((e) => e.msat > 0n);
    const total = owed.reduce((a, e) => a + e.msat, 0n);
    let due = owed.map((e) => ({ ...e }));
    if (total > 0n && room < total) {
      due = owed.map((e) => ({ ...e, msat: (e.msat * room) / total }));
      let odd = room - due.reduce((a, e) => a + e.msat, 0n);
      for (const e of due) { if (odd <= 0n) break; e.msat += 1n; odd -= 1n; }
    }
    const carriers = sp.outputs.map((o, index) => ({ ...o, index })).filter((o) => o.pays === 'player_carrier').map((o) => ({ index: o.index, script: o.script, value: o.value, slices: [], room: roomOf(o.value, margin) }));
    let at = 0;
    for (const e of due) {
      let owe = e.msat;
      while (owe > 0n && at < carriers.length) {
        const c = carriers[at];
        const part = owe < c.room ? owe : c.room;
        if (part > 0n) { c.slices.push({ entryId: e.entryId, playerPubkey: e.playerPubkey, msat: part }); c.room -= part; owe -= part; left.get(toHex(e.entryId)).msat -= part; }
        if (c.room === 0n) at += 1;
      }
    }
    out.push(carriers.map(({ room: _, ...c }) => c));
  }
  return { spends: out, remaining: [...left.values()].filter((e) => e.msat > 0n) };
}

/** A witness of the right shape and size for an escrow spend by `path`, with no real signature in it: what its fee is reckoned on. */
function sizedEscrowWitness(path, output, panels) {
  const sig = new Uint8Array(64);
  if (path === 'fallback') return escrowWitness({ escrow: output, path, signature: sig });
  return escrowWitness({ escrow: output, path, panelA: panels.panelA, panelB: panels.panelB, signatures: new Map([...panels.panelA, ...panels.panelB].map((k) => [toHex(k), sig])) });
}

/**
 * AN ESCROW SPEND, AS EVERY SIGNER BUILDS IT (RULED 2026-11-03, kanban #1085). Pure: everything it reads, the signer read itself.
 *
 *   path         'release' (panels A and B, t of n each, no wait) or 'fallback' (the census key, slash_fallback_blocks after the escrow confirmed)
 *   escrow       { txid (internal order), vout, value } of the escrow output now; `output` slashEscrowOutput's answer for it; `panels` { panelA, panelB } for a release
 *   table        the confirmed table (decoded), `tableId` its id; `spends` the escrow spends before this one, as escrowSlices takes them
 *   loadHeight   the height whose federation records `federations` are ([{ federation, status, reserveKey, reserveSats, exposureCapSats }], §27A.9.2), named in outputs[]
 *   carriers     [{ key, federation, script, bondSats }] in carrying order: each a CarrierPegIn for this escrow outpoint, one output each
 *   rate         sat/vB (the start's own, startFeeRate)
 *
 * The players' part goes first, to carriers with a peg-in of the players' federation, in their order, none above its own bond. Each players' output holds its part plus the
 * carrier margin the table names (RULED 2026-11-03, kanban #1086), taken from the reserves' share of this spend; when that share cannot take every margin (the escrow holds
 * only players' money, as with no reserve key yet), the outputs hold the parts alone and outputs[] names `marginOff: players`. The rest of the escrow is the reserves' part:
 * spread by §27A.9.2 over the federations at `loadHeight`, each part to the first carrier in order with an unused peg-in of that federation; a part with no such carrier, and
 * whatever finds no room, goes back to the escrow. The fee comes off the reserves' part; only when there is none is it taken off the players' pro rata (escrowSlices). Under
 * dust, what goes back joins the largest reserves output, or the fee. Answers { ok, spend, outputs, bytes, outputsId, digest, feeSats, vsize, short } or { ok: false, due, why }:
 * `due: false` when nothing is payable yet, which is no refusal.
 */
export function slashEscrowSpend({ path, escrow, output, table, tableId, spends = [], loadHeight, carriers = [], playersFederation, federations = [], retired = [], rate, panels = null, fallbackBlocks }) {
  if (path !== 'release' && path !== 'fallback') return { ok: false, why: `an escrow is spent by its panels or its census key, not ${path}` };
  if (path === 'release' && !(output.leaves.release && panels)) return { ok: false, why: 'that escrow has no panels\' leaf' };
  if (!Number.isInteger(loadHeight) || loadHeight < 0) return { ok: false, why: 'an escrow spend names the height of the records it reads' };
  const owedSats = (escrowSlices({ table, spends }).remaining.reduce((a, e) => a + e.msat, 0n) + 999n) / 1000n;
  const marginMsat = table.marginMsat ?? 0n, marginSats = (marginMsat + 999n) / 1000n;
  const pf = String(playersFederation || '').toLowerCase();
  const sequence = path === 'release' ? 0xfffffffd : fallbackBlocks;
  /** The players' outputs with `margin` sat each past its part, out of `spendable`: { players, used, avail (the reserves' share left) }, or null when that share cannot take the margins. */
  const placePlayers = (spendable, margin) => {
    const short = spendable < owedSats;
    if (short && margin > 0n) return null;
    let left = short ? spendable : owedSats, avail = short ? 0n : spendable - owedSats;
    const used = new Set(), players = [];
    for (const c of carriers) {
      if (left <= 0n) break;
      if (String(c.federation).toLowerCase() !== pf || c.bondSats < P2TR_DUST_SATS || c.bondSats <= margin || used.has(toHex(c.script))) continue;
      const cap = c.bondSats - margin;
      const part = left > cap ? cap : left;
      const raise = part + margin < P2TR_DUST_SATS ? P2TR_DUST_SATS - part - margin : 0n;
      if (avail >= margin + raise) {
        avail -= margin + raise;
        players.push({ value: part + margin + raise, script: c.script, pays: 'player_carrier' });
        used.add(toHex(c.script));
        left -= part;
        continue;
      }
      if (raise > 0n && players.length) { players[players.length - 1].value += part; left -= part; continue; }
      if (margin > 0n) return null;
      break;
    }
    return { players, used, avail };
  };
  let fee = 0n;
  for (let round = 0; round < FEE_ROUNDS; round++) {
    const spendable = escrow.value - fee;
    if (spendable < P2TR_DUST_SATS) return { ok: false, due: false, why: `an escrow of ${escrow.value} sat less a ${fee} sat fee is below dust` };
    const short = spendable < owedSats;
    let placed = placePlayers(spendable, marginSats), marginOff = 'reserves';
    if (!placed) { placed = placePlayers(spendable, 0n); marginOff = 'players'; }
    const { players, used } = placed;
    const reservesAvail = placed.avail;
    const reserves = [];
    if (reservesAvail > 0n) {
      const { parts } = reserveParts({ amountSats: reservesAvail, federations, retired, minPartSats: P2TR_DUST_SATS });
      for (const p of parts) {
        const c = carriers.find((x) => String(x.federation).toLowerCase() === p.federation && !used.has(toHex(x.script)));
        if (!c) continue;
        used.add(toHex(c.script));
        reserves.push({ value: p.sats, script: c.script, pays: 'reserves' });
      }
    }
    if (!players.length && !reserves.length) {
      return { ok: false, due: false, why: owedSats > 0n && !carriers.some((c) => String(c.federation).toLowerCase() === pf) ? 'no carrier has published a peg-in of the players\' federation for this escrow'
        : 'no federation has room at that height, or no carrier a peg-in of one that has' };
    }
    let extra = 0n;
    const back = escrow.value - fee - [...players, ...reserves].reduce((a, o) => a + o.value, 0n);
    if (back > 0n && back < P2TR_DUST_SATS) {
      const big = reserves.reduce((a, o) => (!a || o.value > a.value ? o : a), null);
      if (big) big.value += back; else extra = back;
    }
    const built = escrowTableSpend({ escrow: { ...escrow, script: output.script }, tableId, loadHeight, marginMsat, marginOff, payees: [...players, ...reserves], feeSats: fee + extra, sequence });
    if (!built.ok) return built;
    const vsize = vsizeOfSpend({ ...built.tx, witnesses: [sizedEscrowWitness(path, output, panels)] });
    const want = rate * BigInt(vsize);
    if (want <= fee) {
      return { ok: true, spend: built, outputs: built.outputs, bytes: encodeSlashEscrowOutputs(built.outputs), outputsId: slashEscrowOutputsId(built.outputs),
        digest: tapSighash({ ...built.tx, prevouts: built.prevouts, inputIndex: 0, leafHash: output.leaves[path] }), feeSats: built.fee.sats, vsize, short, marginOff };
    }
    fee = want;
  }
  return { ok: false, why: `the fee of that escrow spend did not settle in ${FEE_ROUNDS} builds` };
}

export { sameBytes };
