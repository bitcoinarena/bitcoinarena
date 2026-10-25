// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHO HOSTS A FEDERATION'S LIGHTNING: THE TWO GATEWAY SEATS (spec §23A.92026-10-18: "If more than 2 nodes in the
// federation want to host a guardian a clear process must choose the best guardians possible, make the rules and requirements clear").
// Pure: every guardian ranks the same candidates the same way from the same measurements, and the federation record (signed at
// threshold) names the seats. The measurements are each guardian's own; flooring them is what makes honest guardians agree.
//
//   eligible  a seated guardian of the federation, its gateway announced and registered with it, inbound liquidity (deposits come in
//             through it), outbound liquidity (payouts leave through it), peg-in and availability at least the network's minimum, bond
//             at least bond_min_guardian
//   ranked    routed volume (floored to 1,000 sat), then two-way capacity - the smaller of inbound and outbound (floored to 100,000 sat), availability (whole percent), bond, then the
//             ticket H('BLWP/v1/GATEWAY' || beacon || node key), lowest first
//   seated    `seats` operators (one seat per operator), ROTATING EVERY EPOCH (2026-10-20: "rotate the guardians daily every 144
//             blocks among those that want to be gateways in the federation"): the eligible operators that did not hold a seat in the
//             epoch before take the seats first, in rank order; last epoch's holders fill what is left, in rank order. With no other
//             eligible operator a holder keeps its seat.
//   at least one  a federation is never without a gateway (2026-10-20: "There needs to be at least 1 gateway"): when no operator
//             is eligible, the best candidate that can still serve - a seated guardian, its gateway registered, holding e-cash in the
//             federation - takes one seat, ranked as above and named in `belowMinimums`
import { Writer } from './encode.js';
import { taggedHash, bytesToBigInt, toHex } from './hash.js';
import { tagAt, TAG_PAIRS } from './tag-switch.js';

export const GATEWAY_SEATS = 2;
export const GATEWAY_EPOCH_BLOCKS = 144;
export const GATEWAY_TICKET_TAG = TAG_PAIRS.gatewayTicket[0];   // the tag before the switch (tag-switch.js, kanban #525)
/** The minimums per network (spec §23A.9 table). */
export const GATEWAY_MINIMUMS = Object.freeze({
// inbound and outbound each half of what the single capacity minimum was (2026-10-18: a gateway with outbound only takes no deposit)
  mainnet: Object.freeze({ inboundSats: 250_000n, outboundSats: 250_000n, pegInSats: 2_000_000n, availabilityPct: 95 }),
  testnet4: Object.freeze({ inboundSats: 100_000n, outboundSats: 100_000n, pegInSats: 50_000n, availabilityPct: 95 }),
  regtest: Object.freeze({ inboundSats: 10_000n, outboundSats: 10_000n, pegInSats: 5_000n, availabilityPct: 95 }),
});

const floorTo = (x, step) => (BigInt(x) / step) * step;
export function gatewayTicket(beacon, nodeKey, epoch) {
  const w = new Writer(); w.bytes32(beacon); w.bytes32(nodeKey);
  return bytesToBigInt(taggedHash(tagAt('gatewayTicket', { epoch }), w.finish()));
}

/** Why a candidate may not stand, or null. `c` { seatedGuardian, registered, inboundSats, outboundSats, pegInSats, availabilityPct, bondSats }. */
export function ineligibleWhy(c, { minimums, bondMinGuardian }) {
  if (!c.seatedGuardian) return 'not a seated guardian of the federation';
  if (!c.registered) return 'its gateway is not registered with the federation';
  // inbound from OUTSIDE the federation: a payer on the wider Lightning network reaches the gateway only through it (the ring's channels
  // move money between the federation's own gateways)
  if (BigInt(c.outsideInboundSats || 0) < minimums.inboundSats) return `inbound liquidity from outside the federation ${c.outsideInboundSats || 0} below ${minimums.inboundSats} sat (deposits come in through it)`;
  if (BigInt(c.outboundSats || 0) < minimums.outboundSats) return `outbound liquidity ${c.outboundSats || 0} below ${minimums.outboundSats} sat (payouts leave through it)`;
  if (BigInt(c.pegInSats) < minimums.pegInSats) return `peg-in ${c.pegInSats} below ${minimums.pegInSats} sat`;
  if (Math.floor(Number(c.availabilityPct)) < minimums.availabilityPct) return `available ${Math.floor(Number(c.availabilityPct))} % of the epoch, below ${minimums.availabilityPct} %`;
  if (BigInt(c.bondSats) < BigInt(bondMinGuardian)) return `bond below bond_min_guardian`;
  return null;
}

/**
 * THE EPOCH'S GATEWAY SEATS. `candidates` [{ node (32-byte key), operatorId, seatedGuardian, registered, volumeSats, inboundSats, outboundSats, pegInSats,
 * availabilityPct, bondSats }]; `beacon` the epoch's first block hash (32 bytes); `incumbents` node keys hex seated last epoch (they step back);
 * `network`; `bondMinGuardian`. Answers { seated: [node hex], ranked: [{ node, ... }], ineligible: [{ node, why }], waiting: [{ node, why }],
 * belowMinimums: [node hex], empty, why }.
 */
// `pegInStarSats`: P* while the federation is under peg-in pressure (capacity.js pegInPressure), else null - then a candidate's proved
// peg-in up to P* (`provedPegInSats`) ranks before its routed volume (§23A.3a part 2: "a gateway that can take the deposits is seated
// ahead of one that has routed more but cannot")
export function seatGateways({ candidates = [], beacon, epoch, incumbents = [], network = 'testnet4', bondMinGuardian, seats = GATEWAY_SEATS, pegInStarSats = null }) {
  if (!(beacon instanceof Uint8Array) || beacon.length !== 32) throw new TypeError('the epoch is ranked on its first block\'s hash');
  const minimums = GATEWAY_MINIMUMS[network];
  if (!minimums) throw new Error(`no gateway minimums for ${network}`);
  const ineligible = [], eligible = [], serving = [];
  const star = pegInStarSats === null || pegInStarSats === undefined ? null : BigInt(pegInStarSats);
  const pegOf = (c) => { if (star === null) return 0n; const x = BigInt(c.provedPegInSats || 0); return x < star ? x : star; };
  const rankable = (c) => ({ ...c, nodeHex: toHex(c.node), pegin: pegOf(c), volume: floorTo(c.volumeSats || 0, 1000n), capacity: floorTo(BigInt(c.inboundSats || 0) < BigInt(c.outboundSats || 0) ? c.inboundSats || 0 : c.outboundSats || 0, 100_000n),
    availability: BigInt(Math.floor(Number(c.availabilityPct))), bond: BigInt(c.bondSats || 0), ticket: gatewayTicket(beacon, c.node, epoch) });
  for (const c of candidates) {
    const why = ineligibleWhy(c, { minimums, bondMinGuardian });
    if (why) {
      ineligible.push({ node: toHex(c.node), why });
      if (c.seatedGuardian && c.registered && BigInt(c.pegInSats || 0) > 0n) serving.push(rankable(c));
      continue;
    }
    eligible.push(rankable(c));
  }
  const cmp = (a, b) => (a.pegin !== b.pegin ? (a.pegin > b.pegin ? -1 : 1) : a.volume !== b.volume ? (a.volume > b.volume ? -1 : 1) : a.capacity !== b.capacity ? (a.capacity > b.capacity ? -1 : 1)
    : a.availability !== b.availability ? (a.availability > b.availability ? -1 : 1) : a.bond !== b.bond ? (a.bond > b.bond ? -1 : 1)
    : a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0);
  // one seat per operator: its best node stands for it
  const byOp = new Map(), waiting = [];
  for (const c of eligible.sort(cmp)) {
    const op = String(c.operatorId || c.nodeHex);
    if (!byOp.has(op)) byOp.set(op, c);
    else waiting.push({ node: c.nodeHex, why: `the same operator as ${byOp.get(op).nodeHex.slice(0, 10)}, whose node stands for it (one seat per operator)` });
  }
  const ranked = [...byOp.values()];
  // THE ROTATION: last epoch's holders (`incumbents`, node keys; their operators) step back - the others first, then the holders
  const held = new Set((incumbents || []).map((k) => String(k).toLowerCase()));
  const heldOps = new Set(candidates.filter((c) => held.has(toHex(c.node))).map((c) => String(c.operatorId || toHex(c.node))));
  const wasHeld = (c) => held.has(c.nodeHex) || heldOps.has(String(c.operatorId || c.nodeHex));
  let seated = [...ranked.filter((c) => !wasHeld(c)), ...ranked.filter(wasHeld)].slice(0, seats).sort(cmp);
  // AT LEAST ONE: no eligible operator, so the best one that can still serve holds a seat until one clears the minimums
  const belowMinimums = [];
  if (!seated.length && seats >= 1 && serving.length) { const best = serving.sort(cmp)[0]; seated = [best]; belowMinimums.push(best.nodeHex); }
  const out = seated.map((c) => c.nodeHex);
  // ELIGIBLE AND WAITING (kanban #552: the page lists what each gateway still waits for): behind its operator's better node, or ranked below the seats
  for (const c of ranked) if (!out.includes(c.nodeHex)) waiting.push({ node: c.nodeHex, why: wasHeld(c) ? 'held a seat last epoch: steps back while others take their turn' : 'eligible, ranked below the seated gateways' });
  return { seated: out, empty: Math.max(0, seats - out.length), belowMinimums, waiting,
    ranked: ranked.map(({ nodeHex, volume, capacity, availability, bond }) => ({ node: nodeHex, volume, capacity, availability, bond })), ineligible,
    why: `${out.length} of ${seats} gateway seats filled from ${ranked.length} eligible operator${ranked.length === 1 ? '' : 's'}${ineligible.length ? `, ${ineligible.length} not eligible` : ''}`
      + (belowMinimums.length ? `; ${belowMinimums[0].slice(0, 10)} holds the seat below the minimums (a federation is never without a gateway)` : '') };
}
