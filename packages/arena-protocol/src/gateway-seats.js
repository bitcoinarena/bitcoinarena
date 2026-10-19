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
//   seated    the top `seats` operators (one seat per operator); an incumbent keeps its seat unless it is ineligible or a challenger it
//             would yield to routed at least 25 % more
import { Writer } from './encode.js';
import { taggedHash, bytesToBigInt, toHex } from './hash.js';

export const GATEWAY_SEATS = 2;
export const GATEWAY_EPOCH_BLOCKS = 144;
export const GATEWAY_TICKET_TAG = 'BLWP/v1/GATEWAY';
/** A challenger unseats an incumbent only with this much more routed volume (25 %). */
export const UNSEAT_MARGIN_PCT = 25n;
/** The minimums per network (spec §23A.9 table). */
export const GATEWAY_MINIMUMS = Object.freeze({
// inbound and outbound each half of what the single capacity minimum was (2026-10-18: a gateway with outbound only takes no deposit)
  mainnet: Object.freeze({ inboundSats: 250_000n, outboundSats: 250_000n, pegInSats: 2_000_000n, availabilityPct: 95 }),
  testnet4: Object.freeze({ inboundSats: 100_000n, outboundSats: 100_000n, pegInSats: 50_000n, availabilityPct: 95 }),
  regtest: Object.freeze({ inboundSats: 10_000n, outboundSats: 10_000n, pegInSats: 5_000n, availabilityPct: 95 }),
});

const floorTo = (x, step) => (BigInt(x) / step) * step;
export function gatewayTicket(beacon, nodeKey) {
  const w = new Writer(); w.bytes32(beacon); w.bytes32(nodeKey);
  return bytesToBigInt(taggedHash(GATEWAY_TICKET_TAG, w.finish()));
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
 * availabilityPct, bondSats }]; `beacon` the epoch's first block hash (32 bytes); `incumbents` node keys hex seated last epoch;
 * `network`; `bondMinGuardian`. Answers { seated: [node hex], ranked: [{ node, ... }], ineligible: [{ node, why }], empty, why }.
 */
export function seatGateways({ candidates = [], beacon, incumbents = [], network = 'testnet4', bondMinGuardian, seats = GATEWAY_SEATS }) {
  if (!(beacon instanceof Uint8Array) || beacon.length !== 32) throw new TypeError('the epoch is ranked on its first block\'s hash');
  const minimums = GATEWAY_MINIMUMS[network];
  if (!minimums) throw new Error(`no gateway minimums for ${network}`);
  const ineligible = [], eligible = [];
  for (const c of candidates) {
    const why = ineligibleWhy(c, { minimums, bondMinGuardian });
    if (why) { ineligible.push({ node: toHex(c.node), why }); continue; }
    eligible.push({ ...c, nodeHex: toHex(c.node), volume: floorTo(c.volumeSats || 0, 1000n), capacity: floorTo(BigInt(c.inboundSats) < BigInt(c.outboundSats) ? c.inboundSats : c.outboundSats, 100_000n),
      availability: BigInt(Math.floor(Number(c.availabilityPct))), bond: BigInt(c.bondSats), ticket: gatewayTicket(beacon, c.node) });
  }
  const cmp = (a, b) => (a.volume !== b.volume ? (a.volume > b.volume ? -1 : 1) : a.capacity !== b.capacity ? (a.capacity > b.capacity ? -1 : 1)
    : a.availability !== b.availability ? (a.availability > b.availability ? -1 : 1) : a.bond !== b.bond ? (a.bond > b.bond ? -1 : 1)
    : a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0);
  // one seat per operator: its best node stands for it
  const byOp = new Map();
  for (const c of eligible.sort(cmp)) { const op = String(c.operatorId || c.nodeHex); if (!byOp.has(op)) byOp.set(op, c); }
  const ranked = [...byOp.values()];
  // INCUMBENTS STAY unless ineligible or out-routed by 25 %: the seats are the top `seats`, then an unseated incumbent takes back the
  // place of the lowest newcomer that did not route 25 % more than it
  let seated = ranked.slice(0, seats);
  const kept = new Set((incumbents || []).map((k) => String(k).toLowerCase()));
  for (const inc of ranked.filter((c) => kept.has(c.nodeHex) && !seated.includes(c))) {
    const newcomers = seated.filter((c) => !kept.has(c.nodeHex));
    const weakest = newcomers[newcomers.length - 1];
    if (weakest && weakest.volume * 100n < inc.volume * (100n + UNSEAT_MARGIN_PCT)) seated = seated.map((c) => (c === weakest ? inc : c)).sort(cmp);
  }
  const out = seated.map((c) => c.nodeHex);
  return { seated: out, empty: Math.max(0, seats - out.length),
    ranked: ranked.map(({ nodeHex, volume, capacity, availability, bond }) => ({ node: nodeHex, volume, capacity, availability, bond })), ineligible,
    why: `${out.length} of ${seats} gateway seats filled from ${ranked.length} eligible operator${ranked.length === 1 ? '' : 's'}${ineligible.length ? `, ${ineligible.length} not eligible` : ''}` };
}
