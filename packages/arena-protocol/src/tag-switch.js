// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LAST BLWP/v1 TAGS BECOME ARENA/v1 AT ONE POINT (kanban #525, protocol 18; 2026-10-19 ~14:00Z: "both domains accepted
// during the switch, the new one required from the upgrade height"). Eleven tags the 10-08 rename left behind - the duty, guardian,
// gateway and liquidity tickets, the founding's id and setup code, the gateway and liquidity claims, the coin proofs and the two
// seatings - move together. The point is one block height H per network and that block's time T (ms): a tag computed at a height
// compares it with H, one computed at a time (an hour slot, a claim's atMs) with T, a seating's epoch by its first height (epoch x 144).
//   - before the point (or with no point named), every tag is the old one, and a signature is accepted only under it;
//   - from the point, every tag is the new one, and only it is accepted.
// Tickets and ids are computed the same on every node, so nobody may switch alone: H is named here by the release that sets it,
// after every seat of the network runs protocol 18. Kept as they are (ancestor.js, genesis-ids.js): Advert, BOND_MARKER,
// PlayerWalletSecret, TestArbitration and the donors' wallet tag - they are on Bitcoin already or derive keys.

export const TAG_PAIRS = Object.freeze({
  duty: Object.freeze(['BLWP/v1/DUTY', 'ARENA/v1/DUTY']),
  guardianTicket: Object.freeze(['BLWP/v1/GUARDIAN', 'ARENA/v1/GUARDIAN']),
  gatewayTicket: Object.freeze(['BLWP/v1/GATEWAY', 'ARENA/v1/GATEWAY']),
  gatewayClaim: Object.freeze(['BLWP/v1/GATEWAY_CLAIM', 'ARENA/v1/GATEWAY_CLAIM']),
  gatewaySeating: Object.freeze(['BLWP/v1/GATEWAY_SEATING', 'ARENA/v1/GATEWAY_SEATING']),
  liquidityTicket: Object.freeze(['BLWP/v1/LIQUIDITY', 'ARENA/v1/LIQUIDITY']),
  liquidityClaim: Object.freeze(['BLWP/v1/LIQUIDITY_CLAIM', 'ARENA/v1/LIQUIDITY_CLAIM']),
  liquidityFunds: Object.freeze(['BLWP/v1/LIQUIDITY_FUNDS', 'ARENA/v1/LIQUIDITY_FUNDS']),
  liquiditySeating: Object.freeze(['BLWP/v1/LIQUIDITY_SEATING', 'ARENA/v1/LIQUIDITY_SEATING']),
  founding: Object.freeze(['BLWP/v1/FOUNDING', 'ARENA/v1/FOUNDING']),
  foundingSetup: Object.freeze(['BLWP/v1/FOUNDING_SETUP', 'ARENA/v1/FOUNDING_SETUP']),
});

/** The point per network: { height, timeMs } or null (not named yet: the old tags everywhere). testnet4: 2026-10-19 ~20:45Z,
 *  "Launch it as soon as possible" - H 157,064 (~00:50Z at one block per 20 min, after every seat, provider and installer node runs it),
 *  T 2026-10-20 01:00:00Z. */
export const TAG_SWITCH = Object.freeze({
  mainnet: null,
  testnet4: Object.freeze({ height: 157064, timeMs: Date.parse('2026-10-20T01:00:00Z') }),
  regtest: null,
});

export const EPOCH_BLOCKS = 144;

let network = 'testnet4';
let given;   // a test's own point; undefined: the network's
/** Which network's point this process uses (a node, a provider and a custody agent name theirs at start). */
export function setTagNetwork(name) {
  if (!Object.prototype.hasOwnProperty.call(TAG_SWITCH, name)) throw new Error(`no tag switch for network ${name}`);
  network = name;
}
/** A test's own point ({ height, timeMs } or null); undefined goes back to the network's. Answers the one it replaced. */
export function setTagSwitchForTests(sw) { const was = given; given = sw; return was; }
export const tagSwitch = () => (given !== undefined ? given : TAG_SWITCH[network]);

const reached = (at, sw) => {
  if (!sw || !at) return false;
  if (at.height != null) return Number(at.height) >= sw.height;
  if (at.epoch != null) return Number(at.epoch) * EPOCH_BLOCKS >= sw.height;
  if (at.ms != null) return Number(at.ms) >= sw.timeMs;
  return false;
};

/** The tag `name` is computed and signed under at `at` ({ height } | { epoch } | { ms }). */
export function tagAt(name, at, sw = tagSwitch()) {
  const pair = TAG_PAIRS[name];
  if (!pair) throw new Error(`no tag named ${name}`);
  return reached(at, sw) ? pair[1] : pair[0];
}

/**
 * The tags a signature made at `at` is accepted under. With no point named, the old one only (nothing changes). Once a point is
 * named, before it both - the switch, while every seat moves to protocol 18 and still signs the old one - and from it the new one only.
 */
export function tagsAccepted(name, at, sw = tagSwitch()) {
  const pair = TAG_PAIRS[name];
  if (!pair) throw new Error(`no tag named ${name}`);
  if (!sw) return [pair[0]];
  return reached(at, sw) ? [pair[1]] : [pair[0], pair[1]];
}
