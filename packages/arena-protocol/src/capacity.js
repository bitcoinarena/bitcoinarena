// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CAPACITY PRESSURE (spec §23A.3a, kanban #543): how full each federation is against what its bonds cover, the band that says it, and the
// bond and peg-in that would relieve it - the numbers the seats serve at GET /capacity, the health page, the node dashboard and the owner
// page warn with, and the installer's minimum bond follows. Pure arithmetic over public inputs (the signed records, the census's bonds,
// the gateways' claims), so every seat that reads the same inputs says the same thing.
import { faultsOf } from './federation-record.js';

/** The bands of §23A.3a: enter at, leave below (the gap keeps a federation from flapping at a boundary). */
export const CAPACITY_BANDS = Object.freeze([
  Object.freeze({ band: 'FULL', enter: 1.0, leave: 1.0 }),
  Object.freeze({ band: 'CRITICAL', enter: 0.9, leave: 0.8 }),
  Object.freeze({ band: 'PRESSURE', enter: 0.7, leave: 0.6 }),
]);
const ORDER = ['CALM', 'PRESSURE', 'CRITICAL', 'FULL'];

/**
 * A federation's band at `load`, given the band it was in (`was`, CALM when none): a band is entered at its `enter` load and left only
 * below its `leave` load. A load that is not a number (no cap in the record) is CALM.
 */
export function capacityBand(load, was = 'CALM') {
  if (typeof load !== 'number' || !Number.isFinite(load)) return 'CALM';
  const entered = CAPACITY_BANDS.find((b) => load >= b.enter);
  const kept = CAPACITY_BANDS.find((b) => ORDER.indexOf(b.band) <= ORDER.indexOf(was) && load >= b.leave);
  const pick = [entered, kept].filter(Boolean).sort((a, b) => ORDER.indexOf(b.band) - ORDER.indexOf(a.band))[0];
  return pick ? pick.band : 'CALM';
}

/** B*: the per-guardian bond at which the federation's load would be 50 % - ceil(reserve / (0.5 × (f + 1))), never below the floor. */
export function targetBond({ reserveSats, nominal, bondMinSats }) {
  const f1 = BigInt(faultsOf(Number(nominal)) + 1);
  const need = (2n * BigInt(reserveSats) + f1 - 1n) / f1;   // ceil(reserve / (0.5 × (f + 1)))
  return need > BigInt(bondMinSats) ? need : BigInt(bondMinSats);
}

/** B*_net over the OPEN federations: ceil(Σ reserve / (0.5 × Σ (f + 1))), never below the floor. */
export function networkTargetBond(federations, bondMinSats) {
  let reserve = 0n, f1 = 0n;
  for (const x of federations || []) if (x && x.status === 'OPEN') { reserve += BigInt(x.reserveSats || 0); f1 += BigInt(faultsOf(Number(x.nominal)) + 1); }
  if (f1 === 0n) return BigInt(bondMinSats);
  const need = (2n * reserve + f1 - 1n) / f1;
  return need > BigInt(bondMinSats) ? need : BigInt(bondMinSats);
}

/** P*: the peg-in each of the gateway seats should hold so a quarter of the cap's headroom can arrive at once, never below the floor. */
export function targetPegIn({ headroomSats, pegInMinSats, seats = 2 }) {
  const quarter = (BigInt(headroomSats) + BigInt(4 * seats) - 1n) / BigInt(4 * seats);
  return quarter > BigInt(pegInMinSats) ? quarter : BigInt(pegInMinSats);
}

/** The installer's minimum bond: max(bond_min_guardian, B*_net), rounded up to 10,000 sat. */
export function installMinimumBond({ bondMinSats, networkTarget }) {
  const m = BigInt(networkTarget) > BigInt(bondMinSats) ? BigInt(networkTarget) : BigInt(bondMinSats);
  return ((m + 9999n) / 10000n) * 10000n;
}

/**
 * THE CAPACITY VIEW (§23A.3a "the signal"): per federation its load, band (with the band it was in, `was`), headroom, B*, the seated
 * guardians below B*, and P* with the gateways below it; for the network the lowest load among the OPEN ones, its band, B*_net and the
 * installer's minimum. `federations` [{ federation, status, nominal, reserveSats, exposureCapSats, guardianBonds: [{ node, bondSats }],
 * gateways: [{ node, pegInSats }] }]; amounts as strings in the answer (JSON).
 */
export function capacityView({ federations, bondMinSats, pegInMinSats, was = {}, gatewaySeats = 2 }) {
  const rows = (federations || []).map((x) => {
    const reserve = BigInt(x.reserveSats || 0), cap = BigInt(x.exposureCapSats || 0);
    const load = cap > 0n ? Number((reserve * 10000n) / cap) / 10000 : null;
    // A FEDERATION THAT TAKES NO DEPOSITS (DRAINING, CRITICAL while draining, CLOSED, HALTED; kanban #553 health, 2026-10-20: B draining into
    // 4dc88be7 showed "PRESSURE - increase your bond by 22,000 sat"): its load says nothing about room, so no band, no B*, no plea
    const open = !x.status || x.status === 'OPEN';
    const band = open ? capacityBand(load, was[x.federation] || 'CALM') : 'NOT_OPEN';
    const headroom = cap > reserve ? cap - reserve : 0n;
    const bStar = targetBond({ reserveSats: reserve, nominal: x.nominal || 1, bondMinSats });
    const pStar = targetPegIn({ headroomSats: headroom, pegInMinSats, seats: gatewaySeats });
    // a node named twice (two bond outputs, kanban #544) is one guardian with their sum
    const bonds = [...(x.guardianBonds || []).reduce((m, g) => m.set(g.node, (m.get(g.node) || 0n) + BigInt(g.bondSats || 0)), new Map())].map(([node, bondSats]) => ({ node, bondSats }));
    const below = !open ? [] : bonds.filter((g) => BigInt(g.bondSats || 0) < bStar).map((g) => ({ node: g.node, bondSats: String(g.bondSats), addSats: String(bStar - BigInt(g.bondSats || 0)) }));
    const gwBelow = !open ? [] : (x.gateways || []).filter((g) => BigInt(g.pegInSats || 0) < pStar).map((g) => ({ node: g.node, pegInSats: String(g.pegInSats), addSats: String(pStar - BigInt(g.pegInSats || 0)) }));
    return { federation: x.federation, status: x.status, load, band, reserveSats: String(reserve), exposureCapSats: String(cap), headroomSats: String(headroom),
      targetBondSats: String(bStar), guardians: bonds.length, guardiansBelowTarget: below,
      targetPegInSats: String(pStar), gateways: (x.gateways || []).length, gatewaysBelowTarget: gwBelow };
  });
  const open = rows.filter((r) => r.status === 'OPEN' && typeof r.load === 'number');
  const lowest = open.length ? open.reduce((a, b) => (b.load < a.load ? b : a)) : null;
  const bNet = networkTargetBond(federations, bondMinSats);
  return { federations: rows,
    network: { lowestLoad: lowest ? lowest.load : null, lowestFederation: lowest ? lowest.federation : null, band: lowest ? lowest.band : 'CALM',
      targetBondSats: String(bNet), installMinimumBondSats: String(installMinimumBond({ bondMinSats, networkTarget: bNet })) } };
}

/**
 * THE PLEA TO ONE NODE (§23A.3a "Warnings ... a plea to increase the bond", kanban #543): what the node dashboard and the owner page
 * say to node `node` (hex) from a capacityView - null while every federation it is below target in is CALM and the network is CALM.
 * { level: 'warn' | 'bad', band, says, addSats?, pegInAddSats?, federation? }. The amount is what to ADD (Add to bond, #544).
 */
export function capacityPlea(view, node) {
  if (!view || !node) return null;
  const me = String(node).toLowerCase();
  const rank = { CALM: 0, PRESSURE: 1, CRITICAL: 2, FULL: 3 };
  const pct = (l) => (typeof l === 'number' ? `${Math.round(l * 100)} %` : '-');
  const sat = (x) => Number(x).toLocaleString('en-US');
  const mine = (view.federations || []).filter((f) => (rank[f.band] || 0) > 0).map((f) => ({ f,
    bond: (f.guardiansBelowTarget || []).find((g) => String(g.node).toLowerCase() === me),
    gw: (f.gatewaysBelowTarget || []).find((g) => String(g.node).toLowerCase() === me) })).filter((x) => x.bond || x.gw)
    .sort((a, b) => (rank[b.f.band] || 0) - (rank[a.f.band] || 0));
  if (mine.length) {
    const { f, bond, gw } = mine[0];
    const level = rank[f.band] >= 2 ? 'bad' : 'warn';
    const parts = [`Federation ${f.federation.slice(0, 8)} holds ${pct(f.load)} of what its bonds cover (${f.band}${f.band === 'FULL' ? ': deposits are closed' : ''}).`];
    if (bond) parts.push(`Increase your bond by ${sat(bond.addSats)} sat (Add to bond) to bring it to ${sat(f.targetBondSats)} sat: the federation can then take more deposits, and a larger bond earns a larger share.`);
    if (gw) parts.push(`Raise your gateway's peg-in by ${sat(gw.addSats)} sat, to ${sat(f.targetPegInSats)} sat.`);
    return { level, band: f.band, federation: f.federation, says: parts.join(' '), ...(bond ? { addSats: String(bond.addSats) } : {}), ...(gw ? { pegInAddSats: String(gw.addSats) } : {}) };
  }
  const n = view.network || {};
  if ((rank[n.band] || 0) > 0)
    return { level: rank[n.band] >= 2 ? 'bad' : 'warn', band: n.band,
      says: `The network is under capacity pressure (${n.band}, the lowest-load federation at ${pct(n.lowestLoad)}). A bond of at least ${sat(n.targetBondSats)} sat puts a node first in line for the next federation.` };
  return null;
}

/**
 * WHAT RAISING THE BOND PAYS ONE GUARDIAN (§23A.3a "Bigger bonds earn a far larger custody share"; kanban #553, the owner page: "suggest a
 * specific amount AND also tell him the incentives"). `bonds` [{ node, bondSats }] the federation's seated guardians (a node twice is one,
 * its sum); `targetBondSats` B*; `pressure` whether the weighting applies (PRESSURE, CRITICAL, FULL). Shares of the guardians' part, 0..1:
 * `even` (CALM), `now` (this node's share as the bonds stand), `ifRaised` (this node at B*, the others as they stand, under the weighting
 * only when `pressure`), `underPressure` (the same, were the weighting in force); `addSats` to B*.
 */
export function bondIncentive({ bonds, targetBondSats, node, pressure }) {
  const me = String(node).toLowerCase();
  const by = new Map();
  for (const g of bonds || []) by.set(String(g.node).toLowerCase(), (by.get(String(g.node).toLowerCase()) || 0n) + BigInt(g.bondSats || 0));
  if (!by.has(me) || !by.size) return null;
  const bStar = BigInt(targetBondSats || 0);
  const w = (b) => { if (bStar <= 0n) return 1; const x = Number(b < bStar ? b : bStar) / Number(bStar); return x * x; };
  const mine = by.get(me);
  const others = [...by].filter(([k]) => k !== me).reduce((a, [, b]) => a + w(b), 0);
  const even = 1 / by.size;
  const now = pressure ? w(mine) / (w(mine) + others || 1) : even;
  const ifRaised = pressure ? 1 / (1 + others) : even;
  // underPressure: what raising would pay once the weighting applies (shown while CALM, so the owner knows before it does)
  return { guardians: by.size, bondSats: String(mine), targetBondSats: String(bStar), addSats: String(mine < bStar ? bStar - mine : 0n), even, now, ifRaised, underPressure: 1 / (1 + others) };
}

/**
 * THE GUARDIANS' WEIGHTS UNDER PRESSURE (spec §23A.3a part 1, kanban #559/#543): while the federation's band is PRESSURE, CRITICAL or FULL,
 * each seated guardian's part of the guardians' share is w_i = (min(bond_i, B*) / B*)^2 - here min(bond_i, B*)^2 in sat^2, the common
 * 1/B*^2 dropped (only the ratios split the pool). CALM: null (the even split). Inputs as read at the round's census height: `bonds` [{ node
 * hex, bondSats }] from its census, `reserveSats`, `exposureCapSats`, `nominal` from the record in force there, `band` that record's band when
 * it carries one, else the band its load enters (no hysteresis without the record's).
 */
export function guardianWeights({ bonds, reserveSats, exposureCapSats, nominal, bondMinSats, band = null }) {
  const cap = BigInt(exposureCapSats || 0);
  if (cap <= 0n || !(bonds || []).length) return null;
  const load = Number(BigInt(reserveSats || 0) * 1000000n / cap) / 1000000;
  const b = band || capacityBand(load, 'CALM');
  if (!['PRESSURE', 'CRITICAL', 'FULL'].includes(b)) return null;
  const star = targetBond({ reserveSats, nominal, bondMinSats });
  return new Map(bonds.map((g) => { const x = BigInt(g.bondSats || 0) < star ? BigInt(g.bondSats || 0) : star; return [String(g.node).toLowerCase(), x * x]; }));
}

/**
 * THE GATEWAYS UNDER PEG-IN PRESSURE (2026.0.20, §23A.3a part 2): while the federation is in PRESSURE or worse and its seated
 * gateways' proved peg-ins fall short (Σ min(pegin, P*) < seats × P*), the gateways' part is split by (min(pegin, P*))^2 - the
 * spec's v_g = (min(pegin, P*) / P*)^2 times a constant P*^2. `pegIns` [{ node, pegInSats }] the seated gateways' proved peg-ins
 * from the signed seating (a seat without one counts 0); null when CALM, under no peg-in pressure, or when the seating proves
 * none - the part is split evenly then.
 */
export function gatewayWeights({ pegIns, reserveSats, exposureCapSats, pegInMinSats, seats = 2, band = null }) {
  const cap = BigInt(exposureCapSats || 0), reserve = BigInt(reserveSats || 0);
  if (cap <= 0n || !(pegIns || []).length) return null;
  const load = Number(reserve * 1000000n / cap) / 1000000;
  const b = band || capacityBand(load, 'CALM');
  if (!['PRESSURE', 'CRITICAL', 'FULL'].includes(b)) return null;
  const star = targetPegIn({ headroomSats: cap > reserve ? cap - reserve : 0n, pegInMinSats, seats });
  const held = pegIns.map((g) => { const x = BigInt(g.pegInSats || 0); return [String(g.node).toLowerCase(), x < star ? x : star]; });
  if (held.reduce((a, [, x]) => a + x, 0n) >= BigInt(seats) * star) return null;   // no peg-in pressure
  if (!held.some(([, x]) => x > 0n)) return null;
  return new Map(held.map(([n, x]) => [n, x * x]));
}
