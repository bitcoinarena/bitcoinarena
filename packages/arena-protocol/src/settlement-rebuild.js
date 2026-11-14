// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// DOES THE TRANSACTION A SEAT ACKED REBUILD FROM THE TABLE IT ACKED (§5A.3 table row, RULED 2026-11-02, kanban #1043).
//
// An ack names a table and a txid. Nothing in a FROST signature ties them, so five seats could ack an honest table over a transaction that pays
// otherwise, or mark a table late or empty so F does not read it. The table carries what the transaction is made of, so the pair the
// seat signed is false by itself in one of two ways, and no FINAL signature is needed for either:
//
//   the txid is not the hash of the table's claims, payouts and nonce: `tableBuild` hands the caller what to hash, and the hash itself is the
//     stock client's (--mode settle, no signature), since no Fedimint encoding lives in this package;
//   the table's claims and payouts are not what its rows, the contract and the round's locks make: `tableFalse` reads that.
//
// WHAT IS READ AND WHAT IS NOT. Every claim against the Entry Contract it names. In a played round's own table: its amounts against F of the outcomes
// it states, its stake claims and each qualifier's payout exactly (lockSettlement over its rows, split by federation as the seats split it). In every
// table: that what it pays and the guardians' fees fit in what it claims. A fee lock's split among the nodes is not read: it turns on seatings a
// seat holds and the round's AUDITs, its ceiling is the fee locks, and it is no player's money. A late loser's table and a market's are read for
// their claims and their ceiling, and their amounts stay unread. Nobody qualifying leaves the remainder split, which needs the signed donation set and
// its sends, unread too. A reading that cannot be made is left out and never counts against a seat.
import { toHex } from './hash.js';
import { netStakeMsat, isQualifier, computePayoutTable } from './payout.js';
import { lockSettlement, settlementNonce, lateSettlementNonce, lnv2FeeMsat } from './lock-settlement.js';
import { federationSettlementNonce, splitByFederation } from './federation-settlement.js';
import { entryFederation } from './contracts.js';
import { refundKeyOf } from './stake-lock.js';
import { scalarFrom32, FIELD } from './shares.js';
import { takesAnyFederation } from './constants.js';
import { namesNoEntry } from './settlement-ack.js';

const hex = (b) => toHex(b);
const isZero = (b) => b.every((x) => x === 0);
const NO_FEES = { ppm: 0n, baseMsat: 0n };
const outKey = (o) => `${hex(o.txid)}:${String(o.outIdx)}`;
const lineKey = (pk, msat) => `${hex(pk)}:${msat}`;

/**
 * WHAT TO HASH: the table's claims with each one's preimage, its payouts and its nonce, in the shape the stock client's `settle` takes. A fee claim's
 * preimage is its Entry Contract's F. A stake claim's P is brought in `preimages` (entry id hex -> 32 bytes) and has to open the stake point its Entry
 * Contract names: a P nobody can tell from the true one would let a filer rebuild an honest pair into a false one. `pointOf(scalar)` is injected.
 * Answers { ok, build }, or { ok: false, why } when something is missing: then the txid is not read.
 */
export function tableBuild({ table, entries, preimages = new Map(), pointOf }) {
  if (!table.claims.length || !table.payouts.length) return { ok: false, why: 'the table moves no money, so it rebuilds to no transaction' };
  const claims = [];
  for (const c of table.claims) {
    const id = hex(c.entryId);
    const e = entries.get(id);
    if (!e) return { ok: false, why: `the entry of the claim at ${outKey(c.outpoint).slice(0, 20)}… is not shown` };
    if (c.kind === 'fee') { claims.push({ outpoint: c.outpoint, amountMsat: c.amountMsat, preimage: e.feePreimage, kind: 'fee' }); continue; }
    const p = preimages.get(id);
    if (!(p instanceof Uint8Array) || p.length !== 32) return { ok: false, why: `no P is shown for entry ${id.slice(0, 16)}` };
    if (typeof pointOf !== 'function') return { ok: false, why: 'checking a P needs the curve, and none was injected' };
    const scalar = scalarFrom32(p);
    if (scalar === 0n || scalar >= FIELD) return { ok: false, why: `the P shown for entry ${id.slice(0, 16)} is not a scalar` };
    if (hex(pointOf(scalar)) !== hex(e.stakePoint)) return { ok: false, why: `the P shown for entry ${id.slice(0, 16)} does not open its stake point` };
    claims.push({ outpoint: c.outpoint, amountMsat: c.amountMsat, preimage: p, kind: 'stake' });
  }
  return { ok: true, build: { claimPk: table.claimPk, claims, payouts: table.payouts, nonce: table.nonce } };
}

/** The table's own rows as entries of F and of a plan, or null if any row's entry is not shown. */
function entriesOfRows(table, entries) {
  const out = [];
  for (const r of table.rows) {
    const e = entries.get(hex(r.entryId));
    if (!e) return null;
    out.push({ entryId: r.entryId, pubkey: r.pubkey, outcome: r.outcome, score: r.score, stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: e.donationMsat,
      ...(r.atTheDoor ? { atTheDoor: true } : {}) });
  }
  return out;
}

/** What the rows make of the stake part, as the seats make it, or null where it cannot be read. Answers { claims, payouts }. */
function stakePart({ table, rows, entries, contract, payoutShares, feesOf }) {
  if (new Set(rows.map((e) => hex(e.pubkey))).size !== rows.length) return null;     // a plan's locks are by player key: one key twice is not read
  const any = takesAnyFederation(contract);
  const homeFees = any ? NO_FEES : feesOf(hex(contract.federationId));
  if (!homeFees) return null;
  const locks = new Map();
  const federationAt = new Map();
  for (const e of rows) {
    const entry = entries.get(hex(e.entryId));
    locks.set(hex(e.pubkey), { outpoint: entry.stakeLockOutpoint, amountMsat: netStakeMsat(e), refundPk: refundKeyOf(e.pubkey) });
    const f = entryFederation(contract, entry);
    if (!f.ok) return null;
    federationAt.set(outKey(entry.stakeLockOutpoint), hex(f.federationId));
  }
  const plan = lockSettlement({ roundId: table.roundId, entries: rows, minScore: contract.minScore, payoutShares, locks, fees: homeFees, contract });
  if (!plan.ok) return null;
  if (plan.nothing) return { claims: [], payouts: [] };
  if (!any) return plan;
  const split = splitByFederation(plan, { roundId: table.roundId, federationOf: (o) => federationAt.get(outKey(o)), feesOf });
  if (!split.ok) return null;
  return split.settlements.find((s) => s.federation === hex(table.federationId)) || { claims: [], payouts: [] };
}

/**
 * THE TABLE AGAINST ITSELF, THE CONTRACT AND THE LOCKS. `table` decoded; `entries` Map(entry id hex -> Entry Contract), what the filer showed; `feesOf(federation
 * hex)` -> the guardians' { ppm, baseMsat } or null; `attested`: a market's round, whose rows name no entry; `ownTable`: a late table's check, the round's own
 * table if a threshold of seats acked one. Answers what is false, by name. An empty list says only that nothing shown is false.
 */
export function tableFalse({ table, contract, entries, payoutShares = null, feesOf = () => null, attested = false, ownTable = null }) {
  const differs = [];
  const late = !isZero(table.lateEntryId);
  const fed = !isZero(table.federationId);
  // NO MONEY MOVES IN IT, AND IT NAMES A TRANSACTION
  if (!table.claims.length || !table.payouts.length) differs.push('the table moves no money, and the ack names a transaction');
  const nonce = late ? lateSettlementNonce(table.roundId, table.lateEntryId) : fed ? federationSettlementNonce(table.roundId, table.federationId) : settlementNonce(table.roundId);
  if (hex(nonce) !== hex(table.nonce)) differs.push('the nonce is not the one this settlement takes');
  if (fed && !takesAnyFederation(contract)) differs.push('the table names a federation, and the round takes one');

  // EACH CLAIM, BY THE ENTRY CONTRACT IT NAMES
  const rowOf = new Map(table.rows.map((r) => [hex(r.entryId), r]));
  const seen = new Set();
  for (const c of table.claims) {
    const id = hex(c.entryId);
    if (seen.has(outKey(c.outpoint))) differs.push(`the lock at ${outKey(c.outpoint).slice(0, 16)} is claimed twice`);
    seen.add(outKey(c.outpoint));
    if (isZero(c.entryId)) { differs.push(`the lock at ${outKey(c.outpoint).slice(0, 16)} is claimed with no entry`); continue; }
    if (late && id !== hex(table.lateEntryId)) differs.push(`a table marked late for ${hex(table.lateEntryId).slice(0, 16)} claims entry ${id.slice(0, 16)}'s lock`);
    if (!late && !attested && !rowOf.has(id)) differs.push(`entry ${id.slice(0, 16)}'s lock is claimed and the table has no row for it`);
    const e = entries.get(id);
    if (!e) continue;
    if (hex(e.roundId) !== hex(table.roundId)) { differs.push(`entry ${id.slice(0, 16)} is of another round`); continue; }
    const fee = c.kind === 'fee';
    if (outKey(fee ? e.feeLockOutpoint : e.stakeLockOutpoint) !== outKey(c.outpoint)) differs.push(`the ${c.kind} lock claimed for entry ${id.slice(0, 16)} is not the one its contract names`);
    const holds = fee ? e.feeMsat : netStakeMsat(e);
    if (c.amountMsat !== holds) differs.push(`entry ${id.slice(0, 16)}'s ${c.kind} lock is claimed for ${c.amountMsat} and holds ${holds}`);
    if (fed) {
      const f = entryFederation(contract, e);
      if (f.ok && hex(f.federationId) !== hex(table.federationId)) differs.push(`entry ${id.slice(0, 16)}'s lock is in another federation than the table's`);
    }
  }

  // A LATE LOSER'S TABLE OVER AN ENTRY THE ROUND'S OWN SETTLEMENT ALREADY CLAIMED IS NOT A LATE TABLE
  if (late && ownTable && ownTable.claims.some((c) => hex(c.entryId) === hex(table.lateEntryId) && c.kind !== 'fee')) differs.push('that entry is not late: the round\'s own settlement claimed its lock');

  // WHAT THE TRANSACTION PAYS AND THE GUARDIANS TAKE FITS IN WHAT IT CLAIMS, whatever else it is
  const federation = fed ? hex(table.federationId) : !takesAnyFederation(contract) ? hex(contract.federationId) : null;
  const fees = federation ? feesOf(federation) : null;
  if (fees) {
    const inMsat = table.claims.reduce((s, c) => s + c.amountMsat - lnv2FeeMsat(fees, c.amountMsat), 0n);
    const outMsat = table.payouts.reduce((s, p) => s + p.msat + lnv2FeeMsat(fees, p.msat), 0n);
    if (outMsat > inMsat) differs.push(`it pays ${outMsat} msat with the guardians' fees out of ${inMsat}`);
  }

  // A PLAYED ROUND'S OWN TABLE NAMES ITS ENTRIES, and what it says of them makes the rest
  if (late || attested) return differs;
  if (table.rows.some((r) => namesNoEntry(r) || !r.outcome)) { differs.push('a played round\'s own table names an entry and an outcome in every row'); return differs; }
  const rows = entriesOfRows(table, entries);
  if (!rows) return differs;
  let f;
  try { f = computePayoutTable({ roundId: table.roundId, entries: rows, minScore: contract.minScore, payoutShares, protocolVersion: contract.protocolVersion }); } catch (e) { differs.push(`F cannot be computed from its rows: ${e.message}`); return differs; }
  f.activated.forEach((e, i) => {
    const row = rowOf.get(hex(e.entryId));
    if (row.amountMsat !== f.table[i].amountMsat) differs.push(`entry ${hex(e.entryId).slice(0, 16)} is paid ${row.amountMsat} and F of the table's own outcomes pays ${f.table[i].amountMsat}`);
  });
  const part = stakePart({ table, rows, entries, contract, payoutShares, feesOf });
  if (!part) return differs;
  const want = new Set(part.claims.filter((c) => c.kind !== 'fee').map((c) => outKey(c.outpoint)));
  const has = new Set(table.claims.filter((c) => c.kind !== 'fee').map((c) => outKey(c.outpoint)));
  for (const k of has) if (!want.has(k)) differs.push(`the stake lock at ${k.slice(0, 16)} is claimed and its rows do not claim it`);
  for (const k of want) if (!has.has(k)) differs.push(`the stake lock at ${k.slice(0, 16)} is left out and its rows claim it`);
  const lines = new Map();
  for (const p of table.payouts) lines.set(lineKey(p.payoutPk, p.msat), (lines.get(lineKey(p.payoutPk, p.msat)) || 0) + 1);
  for (const p of part.payouts) {
    const k = lineKey(p.payoutPk, p.msat);
    if (lines.get(k)) lines.set(k, lines.get(k) - 1);
    else differs.push(`its rows pay ${hex(p.payoutPk).slice(0, 16)} ${p.msat} msat and the transaction does not`);
  }
  return differs;
}

/** A stake claimed from an entry with a threshold of FINAL signatures that qualified: nothing makes that lock a loser's. `proved`: entry id hex -> { score, outcome, ... }. */
export function claimsProvedQualifier({ table, proved, minScore }) {
  const out = [];
  for (const c of table.claims) {
    if (c.kind === 'fee') continue;
    const e = proved.get(hex(c.entryId));
    if (e && isQualifier(e, minScore)) out.push(`entry ${hex(c.entryId).slice(0, 16)} qualified and its stake lock is claimed`);
  }
  return out;
}
