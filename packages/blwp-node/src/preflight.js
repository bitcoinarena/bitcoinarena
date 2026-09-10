// CAN THIS LIGHTNING NODE HOLD A ROUND'S STAKES? Asked before a round is opened
// on it, from what the node itself says.
//
// M3 is done when "a round is played for testnet sats, the stake is held
// rather than spent". Every custody rule has been measured on an isolated
// regtest; the node a real round would use is the operator's own testnet4 lnd,
// and the first thing measured about it was that it could not take a single
// stake: one channel, 396530 sat on our side, 0 on the other. A hold invoice
// is RECEIVED money, so what a round needs is INBOUND liquidity, and nothing in
// this package said so until a player's payment would have failed.
//
// PURE. The node's own JSON comes in - `getinfo`, `listchannels` - and a
// verdict goes out, each shortfall named with both of its numbers. Asking the
// node is `tools/testnet4-preflight.mjs`'s job, with a read-only macaroon.
import { netStakeMsat } from '../../protocol/src/payout.js';

/** The networks a round may hold stakes on. M3 is testnet sats; M4 is mainnet. */
export const PLAYABLE = ['testnet4', 'regtest'];

/**
 * @param {object} o
 * @param {object} o.info          `lncli getinfo`
 * @param {object[]} o.channels    `lncli listchannels`.channels
 * @param {boolean} o.holdInvoices whether this lnd offers `addholdinvoice`
 * @param {number} o.players       seats this node must hold at once
 * @param {object} o.entry         one seat's { stakeMsat, feeMsat, donationMsat }
 */
export function lightningPreflight({ info, channels = [], holdInvoices = false, players, entry }) {
  const network = (info && info.chains && info.chains[0] && info.chains[0].network) || 'unknown';

  // MAINNET IS REFUSED BEFORE ANYTHING IS COMPUTED. Nothing here should read as
  // "almost ready" about a node that holds real money.
  if (network === 'mainnet')
    return { ready: false, network, missing: ['that is a MAINNET node: no round holds stakes on it before M4'], facts: {} };

  const missing = [];
  if (!PLAYABLE.includes(network))
    missing.push(`that node is on ${network}, and rounds hold stakes only on ${PLAYABLE.join(' or ')}`);

  if (!Number.isInteger(players) || players < 1)
    throw new Error('a preflight is asked for a positive number of seats');
  const perSeat = netStakeMsat(entry);

  // A ROUND THAT ASKS NO STAKE NEEDS NO LIGHTNING AT ALL (M3.3-19). Saying it
  // is not ready because a channel is missing would be the fault that letter
  // closed, arriving from the other side.
  if (perSeat === 0n && entry.stakeMsat === 0n)
    return {
      ready: !missing.length, network, missing,
      facts: { heldPerSeatMsat: 0n, neededMsat: 0n },
      why: 'a round that asks no stake holds nothing, so it needs no inbound and no channel',
    };

  if (!info || info.synced_to_chain !== true)
    missing.push('that node is not synced to its chain, so a hold it issues may never be seen settled');

  const active = channels.filter((c) => c && c.active === true);
  if (!active.length) missing.push('that node has no active channel, so nobody can pay it');

  // WHAT A PAYER CAN ACTUALLY SEND US: the other side's balance, less the
  // reserve it must keep. A channel we opened and funded alone offers nothing.
  const sat = (v) => BigInt(v || 0);
  let inbound = 0n;
  let outbound = 0n;
  for (const c of active) {
    const reserve = sat(c.remote_constraints && c.remote_constraints.chan_reserve_sat);
    const usable = sat(c.remote_balance) - reserve;
    if (usable > 0n) inbound += usable * 1000n;
    outbound += sat(c.local_balance) * 1000n;
  }

  const needed = perSeat * BigInt(players);
  if (inbound < needed)
    missing.push(`${players} hold${players === 1 ? '' : 's'} of ${perSeat} msat need ${needed} msat `
      + `of inbound, and the channels offer ${inbound}`);

  if (!holdInvoices)
    missing.push('that lnd does not offer addholdinvoice, so it cannot hold a stake');

  return {
    ready: !missing.length, network, missing,
    facts: {
      synced: !!(info && info.synced_to_chain), activeChannels: active.length,
      inboundMsat: inbound, outboundMsat: outbound, heldPerSeatMsat: perSeat, neededMsat: needed,
    },
    why: missing.length ? missing.join('; ') : `${players} seat(s) of ${perSeat} msat can be held`,
  };
}
