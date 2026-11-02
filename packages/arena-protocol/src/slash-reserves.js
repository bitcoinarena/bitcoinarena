// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A SLASH PAYS INTO THE PROTOCOL RESERVES, AND WHERE (§27A.9.2 "What a slash pays in", RULED 2026-11-02, kanban #976).
//
// The rest of a slashed bond is on-chain money entering federations, so it counts in their load (§23A.3). It is spread over every OPEN federation
// with a reserve key, so that no single one takes it all: the lowest load is filled up to the next one's, then both together, and so on, none past
// 80 %. One escrow spend pays the parts, one peg-in each; a part too small to peg in joins the largest; what does not fit stays in the escrow until
// a federation has room. A slash never closes a federation to deposits, and a network with no reserve key yet keeps it all in the escrow.
//
// Pure arithmetic over public inputs (capacity.js's `reserveSats`, `exposureCapSats`, federation records), so everyone who reads the same inputs
// computes the same parts.
import { P2TR_DUST_SATS } from './arbitration-tx.js';

/** "None past 80 %": the load a slash may bring a federation to, in basis points. */
export const SLASH_LOAD_LIMIT_BPS = 8000n;
const SCALE = 10n ** 18n;   // the level's unit: fine enough that what a level leaves over is under one sat per federation

const roomAt = (f, level) => { const r = (level * f.cap) / SCALE - f.reserve; return r > 0n ? r : 0n; };

/**
 * THE PARTS. `amountSats` BigInt; `federations` [{ federation (hex), status, reserveKey, reserveSats, exposureCapSats }]; a federation in `retired`
 * (hex, a ruling such as #807's "a new peg-in follows that rule") takes none; `minPartSats` what a peg-in needs to be worth making.
 * Answers { parts: [{ federation, reserveKey, sats }], keptSats }: the parts in federation order, and what stays in the escrow.
 */
export function reserveParts({ amountSats, federations = [], retired = [], minPartSats = 0n }) {
  if (typeof amountSats !== 'bigint' || amountSats < 0n) throw new Error('an amount is BigInt satoshi');
  const out = new Set(retired.map((x) => String(x).toLowerCase()));
  const open = federations.filter((f) => f && f.status === 'OPEN' && f.reserveKey && !out.has(String(f.federation).toLowerCase()))
    .map((f) => ({ federation: String(f.federation).toLowerCase(), reserveKey: f.reserveKey, reserve: BigInt(f.reserveSats || 0), cap: BigInt(f.exposureCapSats || 0) }))
    .filter((f) => f.cap > 0n).sort((a, b) => (a.federation < b.federation ? -1 : 1));
  if (!open.length || amountSats === 0n) return { parts: [], keptSats: amountSats };
  const limit = (SCALE * SLASH_LOAD_LIMIT_BPS) / 10000n;
  const need = (level) => open.reduce((t, f) => t + roomAt(f, level), 0n);
  // THE LEVEL ALL THE FILLED FEDERATIONS REACH: the highest one the amount pays for, never past the limit
  let low = 0n, high = limit;
  if (need(limit) <= amountSats) low = limit;
  else while (high - low > 1n) { const mid = (low + high) / 2n; if (need(mid) <= amountSats) low = mid; else high = mid; }
  const room = new Map(open.map((f) => [f.federation, roomAt(f, limit)]));
  const sats = new Map(open.map((f) => [f.federation, roomAt(f, low)]));
  let left = amountSats - need(low);
  // WHAT THE LEVEL LEFT OVER, one sat at a time in federation order, to those being filled
  for (let moved = true; left > 0n && moved;) {
    moved = false;
    for (const f of open) {
      if (left <= 0n) break;
      if (sats.get(f.federation) === 0n && roomAt(f, low + 1n) === 0n) continue;
      if (sats.get(f.federation) >= room.get(f.federation)) continue;
      sats.set(f.federation, sats.get(f.federation) + 1n); left -= 1n; moved = true;
    }
  }
  // A PART TOO SMALL TO PEG IN JOINS THE LARGEST
  let parts = open.filter((f) => sats.get(f.federation) > 0n).map((f) => ({ federation: f.federation, reserveKey: f.reserveKey, sats: sats.get(f.federation) }));
  const largest = parts.reduce((a, p) => (!a || p.sats > a.sats ? p : a), null);
  if (largest) for (const p of parts) if (p !== largest && p.sats < minPartSats) { largest.sats += p.sats; p.sats = 0n; }
  parts = parts.filter((p) => p.sats > 0n);
  if (parts.length === 1 && parts[0].sats < minPartSats) { left += parts[0].sats; parts = []; }
  return { parts, keptSats: left };
}

/**
 * ONE SPEND OF A SLASH'S ESCROW (§5A.3, §5A.3B step 5, §27A.9.2): the peg-in each federation gets and what stays in the escrow.
 *
 *   escrowSats    what the output holds
 *   feeSats       this spend's fee; pegInFeeSats what a federation keeps of a peg-in
 *   players       [{ key, msat, federation }]: the losses this spend still has to pay, each in the federation of that entry's locks
 *   federations, retired   as `reserveParts`
 *
 * A loss is paid before the reserves see a sat: each federation with a loss gets the losses and its peg-in's fee first, and only what is left is
 * spread. A bond that cannot carry that shares what it has by what each federation is owed (the losses scale down when it is claimed).
 * Answers { ok: true, pegIns: [{ federation, reserveKey, sats, playersMsat }], keptSats } or { ok: false, why }: with no peg-in nothing is spent.
 */
export function planEscrowSpend({ escrowSats, feeSats, pegInFeeSats = 0n, players = [], federations = [], retired = [] }) {
  const spendable = escrowSats - feeSats;
  if (spendable < P2TR_DUST_SATS) return { ok: false, why: `an escrow of ${escrowSats} sat less a ${feeSats} sat fee is below dust` };
  const owed = new Map();
  for (const p of players) owed.set(p.federation, (owed.get(p.federation) || 0n) + BigInt(p.msat));
  const needs = new Map([...owed].map(([f, msat]) => [f, (msat + 999n) / 1000n + pegInFeeSats]));
  let need = [...needs.values()].reduce((a, b) => a + b, 0n);
  if (need > spendable) {
    // THE BOND IS SHORT: every federation by what it is owed, the odd sats to the first in order
    const ordered = [...needs.keys()].sort();
    const scaled = new Map(ordered.map((f) => [f, (spendable * needs.get(f)) / need]));
    scaled.set(ordered[0], scaled.get(ordered[0]) + spendable - [...scaled.values()].reduce((a, b) => a + b, 0n));
    for (const [f, s] of scaled) needs.set(f, s);
    need = spendable;
  }
  const { parts, keptSats } = reserveParts({ amountSats: spendable - need, federations, retired, minPartSats: P2TR_DUST_SATS + pegInFeeSats });
  const keyOf = new Map(federations.filter((f) => f && f.reserveKey).map((f) => [String(f.federation).toLowerCase(), f.reserveKey]));
  const pegIns = new Map([...needs].map(([f, sats]) => [f, { federation: f, reserveKey: retired.includes(f) ? null : keyOf.get(f) || null, sats, playersMsat: owed.get(f) }]));
  for (const p of parts) {
    const at = pegIns.get(p.federation);
    if (at) { at.sats += p.sats; at.reserveKey = p.reserveKey; } else pegIns.set(p.federation, { federation: p.federation, reserveKey: p.reserveKey, sats: p.sats, playersMsat: 0n });
  }
  const list = [...pegIns.values()].sort((a, b) => (a.federation < b.federation ? -1 : 1));
  if (!list.length) return { ok: false, why: keptSats > 0n ? 'no player is owed and no federation has room: the escrow stays' : 'nothing to pay' };
  // BELOW DUST IT CANNOT STAY AN OUTPUT: it joins the largest peg-in
  if (keptSats > 0n && keptSats < P2TR_DUST_SATS) { list.reduce((a, p) => (p.sats > a.sats ? p : a)).sats += keptSats; return { ok: true, pegIns: list, keptSats: 0n }; }
  return { ok: true, pegIns: list, keptSats };
}
