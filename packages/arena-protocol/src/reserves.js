// THE PROTOCOL RESERVES' SPLIT (§27A.9.1, kanban #397 slice 1, the owner 2026-10-16: "4% developer fees (game, protocol), 4% node
// fees, 2% protocol reserves. For ingame items 40% developer donations (game,protocol), 40% node, 20% protocol reserves"; the
// locks: the round split is mandatory; an item's developers' share is the player's choice of "40 30 20 10 0").
//
// Pure arithmetic, nothing paid yet: no live version speaks RESERVES_VERSION (it is not in SUPPORTED_PROTOCOL_VERSIONS), and
// today's versions keep §0A.8's lowerable 5 % donation and #377's 50-0 % item share (donation.js, items.js, untouched).
//
// THE REMAINDER RULE (§27A.9.1): every share is floored to the msat; a round's net stake takes what the floors leave, so the
// parts always sum to the gross. An item's price is the sum of its parts.
import { RESERVES_VERSION } from './constants.js';

/** A paid round's shares on the reserves version, in basis points of the gross stake - all mandatory. */
export const ROUND_SPLIT_BPS = Object.freeze({ nodes: 400, protocolDevs: 200, gameDevs: 200, reserves: 200 });
/** An item's mandatory shares, in percent of its list price; the developers' share is added on top, as in #377. */
export const ITEM_NODES_PCT = 40;
export const ITEM_RESERVES_PCT = 20;
/** The developers' share a player may choose for an item on the reserves version (it replaces #377's 50-0 %). */
export const ITEM_DEV_SHARES_RESERVES = Object.freeze([40, 30, 20, 10, 0]);
export const ITEM_DEV_SHARE_RESERVES_DEFAULT = 40;

const bps = (gross, b) => (gross * BigInt(b)) / 10000n;

/**
 * A PAID ROUND'S MONEY ON THE RESERVES VERSION: { nodesMsat, protocolDevsMsat, gameDevsMsat, reservesMsat, netMsat }.
 * There is no developers' share to choose: `devsBps`, if given, must be the mandatory 400, or the split is refused by name.
 */
export function roundSplit(grossMsat, { devsBps = ROUND_SPLIT_BPS.protocolDevs + ROUND_SPLIT_BPS.gameDevs } = {}) {
  const gross = BigInt(grossMsat);
  if (gross < 1n) throw new Error('a paid round has a stake of at least 1 msat');
  if (Number(devsBps) !== ROUND_SPLIT_BPS.protocolDevs + ROUND_SPLIT_BPS.gameDevs)
    throw new Error(`on protocol version ${RESERVES_VERSION} the developers' 4 % is mandatory: it is no donation a player can change`);
  const nodesMsat = bps(gross, ROUND_SPLIT_BPS.nodes);
  const protocolDevsMsat = bps(gross, ROUND_SPLIT_BPS.protocolDevs);
  const gameDevsMsat = bps(gross, ROUND_SPLIT_BPS.gameDevs);
  const reservesMsat = bps(gross, ROUND_SPLIT_BPS.reserves);
  const netMsat = gross - nodesMsat - protocolDevsMsat - gameDevsMsat - reservesMsat;
  return { nodesMsat, protocolDevsMsat, gameDevsMsat, reservesMsat, netMsat };
}

/**
 * AN ITEM ON THE RESERVES VERSION: its list price in msat and the developers' share the player chose (40, 30, 20, 10 or 0 %).
 * Answers { priceMsat, nodesMsat, reservesMsat, protocolDevsMsat, gameDevsMsat }: nodes 40 % and reserves 20 % of the list
 * price, the developers' share half protocol (floored), half game (the rest), and the price their sum - 60 % + the share.
 */
export function itemSplitReserves({ listMsat, devsPct = ITEM_DEV_SHARE_RESERVES_DEFAULT }) {
  const list = BigInt(listMsat);
  if (list < 1n) throw new Error('an item costs at least 1 msat');
  if (!ITEM_DEV_SHARES_RESERVES.includes(Number(devsPct)))
    throw new Error(`on protocol version ${RESERVES_VERSION} an item's developers' share is one of ${ITEM_DEV_SHARES_RESERVES.join(', ')} %, not ${devsPct} %`);
  const nodesMsat = (list * BigInt(ITEM_NODES_PCT)) / 100n;
  const reservesMsat = (list * BigInt(ITEM_RESERVES_PCT)) / 100n;
  const devs = (list * BigInt(devsPct)) / 100n;
  const protocolDevsMsat = devs / 2n;
  const gameDevsMsat = devs - protocolDevsMsat;
  return { priceMsat: nodesMsat + reservesMsat + devs, nodesMsat, reservesMsat, protocolDevsMsat, gameDevsMsat };
}

/**
 * THE RESERVE OUTPUT AN ENTRY OR A PURCHASE MUST CARRY (§27A.9.2): one output in its own federation, held there by the
 * federation's guardians. `kind` 'entry' (gross stake) or 'item' (list price and the chosen share). Answers
 * [{ federationId, amountMsat, to: 'reserves' }] - empty only for a free round, which pays nothing at all.
 */
export function reserveOutputsExpected({ kind, federationId, grossMsat, listMsat, devsPct, free = false }) {
  if (!(federationId instanceof Uint8Array) || federationId.length !== 32) throw new Error('a reserve output is paid in a 32-byte federation');
  if (kind === 'entry') {
    if (free) return [];
    return [{ federationId, amountMsat: roundSplit(grossMsat).reservesMsat, to: 'reserves' }];
  }
  if (kind === 'item') return [{ federationId, amountMsat: itemSplitReserves({ listMsat, devsPct }).reservesMsat, to: 'reserves' }];
  throw new Error('a reserve output is paid by an entry or an item');
}
