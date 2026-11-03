// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TEMPLATE-3 GUARDIAN BOND PAYS A LIQUIDATION'S NOTES (kanban #1093 part 2, ruling #1111, 2026-11-03).
//
// A theft or an abandonment has no round. Its start pays the hold of the node's newest presig, and with no round that is the bonding presig, whose hold has no release leaf (#1053):
// the census key releases it after slash_fallback_blocks. That fallback answers to the same PayoutTable as a round's slash:
//
//   round_id   32 zero bytes          a slash with no round
//   entries[]  empty                  nothing is owed per entry at release
//   outputs[]  filer, escrow          the whole hold, less the fee, to ONE census-key escrow output per bond (slashEscrowOutput, #1085's leaves)
//
// proof_id names the theft or abandonment proof, and that proof names the federation. Template 1 and 2 bonds keep the arbitration set's liquidation escrow (rehearsal 17).
//
// THE ESCROW PAYS CLAIMS AS ANY ESCROW PAYS ENTRIES (#1085 with claims in place of entries). One claims ledger per liquidating federation: a claim is accepted once and paid once,
// from whichever escrow has funds, template 1 and 2 escrows first. What a census-key escrow owes a claim is its face less what the arbitration set's escrow pays it. The census key
// spends the escrow to carriers' signed peg-ins into a SAFE federation (OPEN, not the liquidating one, lowest load), each carrier none above its own bond, the census key's holders
// in descending shares less the slashed nodes; each carrier then pays its claims at face, a payout contract to each claim's key. The spend carries its own outputs[] and
// claims_id, the hash of the accepted claims it pays, in the order it pays them; each carrier output names how many of them it carries. After the claim window closes (3 months),
// what no claim takes goes to the protocol reserves, by §27A.9.2's spread, through the same carriers.
//
// Pure: the chain, the ledger and the curve are the caller's.
import { taggedHash, toHex, fromHex } from './hash.js';
import { Writer, Reader } from './encode.js';
import { TAG } from './constants.js';
import { P2TR_DUST_SATS } from './arbitration-tx.js';
import { tapSighash } from './bond-spend.js';
import { escrowWitness, vsizeOfSpend } from './slash-release.js';
import { reserveParts } from './slash-reserves.js';

/** A slash with no round: the round_id its table names. */
export const roundlessRoundId = () => new Uint8Array(32);
export const isRoundless = (roundId) => roundId instanceof Uint8Array && roundId.length === 32 && roundId.every((b) => b === 0);
const FEE_ROUNDS = 8;
/** The version byte of a liquidation escrow spend's outputs[], beside the slash escrow's 1. */
export const LIQUIDATION_OUTPUTS_VERSION = 2;
export const LIQUIDATION_PAYS = Object.freeze(['claims_carrier', 'reserves', 'escrow']);

const varBytes = (w, b) => { w.u32(b.length); w.bytes(b); };
const readVarBytes = (r) => r.bytes(r.u32());

/** The table of a slash with no round, as slashHoldSpend takes it: no entries, no carriers, no federations, so its outputs are the filer and the escrow. */
export const roundlessTableInputs = ({ networkId, bond, filer, escrowScript, marginMsat = 0n }) => ({ networkId, roundId: roundlessRoundId(), bond, filer, carriers: [], federations: [], retired: [],
  escrowScript, marginMsat, entriesFor: () => [] });

/** A claim as the ledger names it: { nonce (hex), payoutPk (66 hex, compressed), msat (BigInt, what this escrow owes it) }. */
const claimKey = (c) => String(c.nonce).toLowerCase();
export function encodeLiquidationClaims(claims) {
  const w = new Writer();
  w.u32(claims.length);
  for (const c of claims) {
    varBytes(w, fromHex(claimKey(c)));
    w.bytes(fromHex(String(c.payoutPk).toLowerCase()), 33);
    w.u64(BigInt(c.msat));
  }
  return w.finish();
}
export function decodeLiquidationClaims(bytes) {
  const r = new Reader(bytes), n = r.u32(), out = [];
  for (let i = 0; i < n; i++) out.push({ nonce: toHex(readVarBytes(r)), payoutPk: toHex(r.bytes(33)), msat: r.u64() });
  r.end();
  return out;
}
/** claims_id: the hash of the accepted claims a spend pays, in the order it pays them. */
export const liquidationClaimsId = (claims) => taggedHash(TAG.liquidationClaims, encodeLiquidationClaims(claims));

/**
 * A LIQUIDATION ESCROW SPEND'S OWN outputs[]: version 2 | payout_table_id | load_height u32 | claims_id | carrier_margin_msat u64 | outputs, each value, script, pays and, for a
 * claims_carrier output, how many claims (in claims_id's order) it carries. `escrow` (what goes back) comes last.
 */
export function encodeLiquidationEscrowOutputs({ tableId, loadHeight, claimsId, marginMsat = 0n, outputs }) {
  const w = new Writer();
  w.u8(LIQUIDATION_OUTPUTS_VERSION);
  w.bytes32(tableId);
  w.u32(loadHeight);
  w.bytes32(claimsId);
  w.u64(BigInt(marginMsat));
  let rank = 0;
  w.u32(outputs.length);
  for (const o of outputs) {
    const pays = LIQUIDATION_PAYS.indexOf(o.pays);
    if (pays < rank) throw new Error(`a liquidation spend pays in order: ${LIQUIDATION_PAYS.join(', ')}`);
    rank = pays;
    w.u64(o.value); w.u16(o.script.length); w.bytes(o.script, o.script.length); w.u8(pays); w.u32(o.pays === 'claims_carrier' ? o.claims : 0);
  }
  return w.finish();
}
export function decodeLiquidationEscrowOutputs(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== LIQUIDATION_OUTPUTS_VERSION) throw new Error('not a liquidation escrow spend\'s outputs');
  const t = { tableId: r.bytes32(), loadHeight: r.u32(), claimsId: r.bytes32(), marginMsat: r.u64(), outputs: [] };
  const n = r.u32();
  for (let i = 0; i < n; i++) {
    const value = r.u64(), script = r.bytes(r.u16()), pays = LIQUIDATION_PAYS[r.u8()], claims = r.u32();
    if (!pays) throw new Error('unknown pays byte in a liquidation escrow spend');
    t.outputs.push({ value, script, pays, ...(pays === 'claims_carrier' ? { claims } : {}) });
  }
  r.end();
  return t;
}
export const liquidationEscrowOutputsId = (t) => taggedHash(TAG.liquidationEscrowOutputs, encodeLiquidationEscrowOutputs(t));

/** The claims each claims_carrier output carries: [{ index, script, value, claims: [...] }], cut from `claims` (claims_id's list) by the counts the outputs name. */
export function liquidationSlices(decoded, claims) {
  let at = 0;
  const out = [];
  for (const [index, o] of decoded.outputs.entries()) {
    if (o.pays !== 'claims_carrier') continue;
    out.push({ index, script: o.script, value: o.value, claims: claims.slice(at, at + o.claims) });
    at += o.claims;
  }
  if (at !== claims.length) throw new Error('the outputs carry another number of claims than claims_id names');
  return out;
}

/**
 * WHAT A CENSUS-KEY ESCROW STILL OWES EACH CLAIM, from the one ledger: `accepted` [{ nonce, amountMsat (face), payoutPk, height }] the claims accepted at or below the spend's
 * height; `coveredMsat` (nonce -> msat) what the arbitration set's escrow pays each (template 1 and 2 first: its plan's paidNotes); `assigned` (nonce -> msat) what earlier
 * census-key escrow spends on the chain already carry. In the ledger's order: height, then nonce. Answers [{ nonce, payoutPk, msat }] with msat > 0.
 */
export function claimsOwed({ accepted = [], coveredMsat = new Map(), assigned = new Map() }) {
  return [...accepted].sort((a, b) => (a.height - b.height) || (claimKey(a) < claimKey(b) ? -1 : claimKey(a) > claimKey(b) ? 1 : 0))
    .map((c) => ({ nonce: claimKey(c), payoutPk: String(c.payoutPk).toLowerCase(), msat: BigInt(c.amountMsat) - BigInt(coveredMsat.get(claimKey(c)) || 0n) - BigInt(assigned.get(claimKey(c)) || 0n) }))
    .filter((c) => c.msat > 0n);
}

const opening = (tableId, outputs) => ({ value: 0n, script: Uint8Array.from([0x6a, 64, ...tableId, ...liquidationEscrowOutputsId(outputs)]) });

/**
 * A CENSUS-KEY LIQUIDATION ESCROW SPEND, AS EVERY HOLDER BUILDS IT (ruling #1111). The escrow of a roundless slash has only its fallback leaf (no panels), so this is the census
 * key's spend, slash_fallback_blocks after the escrow confirmed.
 *
 *   escrow      { txid (internal order), vout, value }; `output` slashEscrowOutput's answer for it (no panels)
 *   tableId     the confirmed roundless table's id; `loadHeight` the height whose ledger and records the signer read, named in outputs[]
 *   owed        claimsOwed's answer at that height, in the ledger's order
 *   carriers    [{ key, federation, script, bondSats }] in carrying order, one peg-in each into a safe federation (the caller picks it)
 *   marginMsat  the network's carrier payout margin (#1086): each claims_carrier output holds it past its claims, out of the escrow
 *   remainder   null, or after the claim window { federations, retired }: what no claim takes goes to the reserves by §27A.9.2, each part to a carrier with a peg-in of that federation
 *
 * Claims are paid whole and in order: each to the first carrier in order with room for it (its bond less the margin), none skipped - a claim that fits nowhere waits, and so do the
 * ones after it. What the outputs do not take, less the fee at `rate`, goes back to the escrow. Answers { ok, spend: { tx, prevouts }, outputs, bytes, outputsId, digest, claims
 * (claims_id's list), claimsId, feeSats, vsize } or { ok: false, due: false, why } when nothing is payable yet.
 */
export function liquidationEscrowSpend({ escrow, output, tableId, loadHeight, owed = [], carriers = [], marginMsat = 0n, rate, fallbackBlocks, remainder = null }) {
  if (!Number.isInteger(loadHeight) || loadHeight < 0) return { ok: false, why: 'a liquidation escrow spend names the height of the ledger it read' };
  if (!output || !output.leaves || !output.leaves.fallback) return { ok: false, why: 'that escrow has no census key leaf' };
  const marginSats = (BigInt(marginMsat) + 999n) / 1000n;
  let fee = 0n;
  for (let round = 0; round < FEE_ROUNDS; round++) {
    let avail = escrow.value - fee;
    if (avail < P2TR_DUST_SATS) return { ok: false, due: false, why: `an escrow of ${escrow.value} sat less a ${fee} sat fee is below dust` };
    // THE CLAIMS, WHOLE AND IN ORDER, each to the first carrier with room: a carrier a claim does not fit is closed and the next one opened; a claim that fits none, or that the
    // escrow cannot pay, waits with every claim after it
    const outs = [], paid = [];
    const costOf = (claims) => { const sum = claims.reduce((a, c) => a + c.msat, 0n); const v = (sum + 999n) / 1000n + marginSats; return v < P2TR_DUST_SATS ? P2TR_DUST_SATS : v; };
    let ci = 0, cur = null;
    const close = () => { if (cur && cur.claims.length) outs.push({ value: costOf(cur.claims), script: cur.c.script, pays: 'claims_carrier', claims: cur.claims.length }); cur = null; };
    outer: for (const claim of owed) {
      for (;;) {
        if (!cur) {
          if (ci >= carriers.length) break outer;
          const c = carriers[ci++], room = BigInt(c.bondSats) * 1000n - BigInt(marginMsat);
          if (room <= 0n) continue;
          cur = { c, claims: [], room };
        }
        if (claim.msat <= cur.room) {
          const more = costOf([...cur.claims, claim]) - (cur.claims.length ? costOf(cur.claims) : 0n);
          if (more > avail) break outer;
          cur.claims.push(claim); cur.room -= claim.msat; avail -= more; paid.push(claim);
          break;
        }
        close();
      }
    }
    close();
    // THE REMAINDER, only after the claim window and only with no claim owed
    const used = new Set(outs.map((o) => toHex(o.script)));
    if (!owed.length && remainder && avail >= P2TR_DUST_SATS) {
      const { parts } = reserveParts({ amountSats: avail, federations: remainder.federations || [], retired: remainder.retired || [], minPartSats: P2TR_DUST_SATS });
      for (const p of parts) {
        const c = carriers.find((x) => String(x.federation).toLowerCase() === p.federation && !used.has(toHex(x.script)));
        if (!c) continue;
        used.add(toHex(c.script));
        outs.push({ value: p.sats, script: c.script, pays: 'reserves' });
        avail -= p.sats;
      }
    }
    if (!outs.length) {
      return { ok: false, due: false, why: owed.length ? (carriers.length ? 'no carrier has room for the next claim' : 'no carrier has published a peg-in into a safe federation for this escrow')
        : remainder ? 'no federation has room for the remainder, or no carrier a peg-in of one that has' : 'no claim is owed by this escrow' };
    }
    let back = escrow.value - fee - outs.reduce((a, o) => a + o.value, 0n), extra = 0n;
    if (back > 0n && back < P2TR_DUST_SATS) { extra = back; back = 0n; }
    const claimsId = liquidationClaimsId(paid);
    const outputs = { tableId, loadHeight, claimsId, marginMsat: BigInt(marginMsat), outputs: [...outs, ...(back ? [{ value: back, script: output.script, pays: 'escrow' }] : [])] };
    const tx = { version: 2, locktime: 0, inputs: [{ txid: escrow.txid, vout: escrow.vout, sequence: fallbackBlocks }], outputs: [opening(tableId, outputs), ...outputs.outputs.map((o) => ({ value: o.value, script: o.script }))] };
    const prevouts = [{ value: escrow.value, script: output.script }];
    const vsize = vsizeOfSpend({ ...tx, witnesses: [escrowWitness({ escrow: output, path: 'fallback', signature: new Uint8Array(64) })] });
    const want = BigInt(rate) * BigInt(vsize);
    if (want <= fee + extra) {
      return { ok: true, spend: { tx, prevouts }, outputs, bytes: encodeLiquidationEscrowOutputs(outputs), outputsId: liquidationEscrowOutputsId(outputs),
        digest: tapSighash({ ...tx, prevouts, inputIndex: 0, leafHash: output.leaves.fallback }), claims: paid, claimsId, feeSats: fee + extra, vsize };
    }
    fee = want;
  }
  return { ok: false, why: `the fee of that liquidation escrow spend did not settle in ${FEE_ROUNDS} builds` };
}

/** The transaction a liquidation spend's outputs[] make from the escrow `escrow` { txid, vout, value } of `output`: what a signer rebuilds and what its txid checks. */
export function liquidationTxOf({ escrow, output, decoded, fallbackBlocks }) {
  const fee = escrow.value - decoded.outputs.reduce((a, o) => a + o.value, 0n);
  if (fee < 0n) return null;
  return { version: 2, locktime: 0, inputs: [{ txid: escrow.txid, vout: escrow.vout, sequence: fallbackBlocks }], outputs: [opening(decoded.tableId, decoded), ...decoded.outputs.map((o) => ({ value: o.value, script: o.script }))] };
}
