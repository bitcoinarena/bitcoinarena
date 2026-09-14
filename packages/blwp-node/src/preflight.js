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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

/** The networks a round may hold stakes on. M3 is testnet sats; M4 is mainnet. */
export const PLAYABLE = ['testnet4', 'regtest'];

/**
 * THE FEWEST SEATS A ROUND IS OPENED FOR. 27A.7.1's game_config names
 * `min_players_per_round 2`; nothing in this package named it until a round
 * had to be sized against a node's inbound before anybody had entered.
 */
// One number with the fee-lock gate: protocol constants.js.
import { MIN_PLAYERS_PER_ROUND } from '../../protocol/src/constants.js';
export { MIN_PLAYERS_PER_ROUND };

/**
 * WHAT A TESTNET4 LND SAYS ABOUT ITSELF, ASKED WITH A KEY THAT CANNOT SPEND.
 *
 * Every call carries the node's `readonly.macaroon`: it cannot create an
 * invoice, open a channel or send a satoshi, so nothing here can move money
 * however it is called. And an lnddir whose own lnd.conf does not say
 * `bitcoin.testnet4=true` is refused before any call - the mainnet lnd on the
 * operator's machine sits one directory over.
 */
export function askLnd({ lncli, lnddir, run = execFileSync, read = readFileSync }) {
  const conf = read(`${lnddir}/lnd.conf`, 'utf8');
  if (/mainnet/i.test(lnddir) || !/^bitcoin\.testnet4\s*=\s*(true|1)\s*$/m.test(conf))
    throw new Error(`${lnddir} is not a testnet4 lnd by its own lnd.conf`);
  const rpc = (conf.match(/^rpclisten\s*=\s*(\S+)/m) || [])[1] || '127.0.0.1:10009';
  const args = [`--lnddir=${lnddir}`, '--network=testnet4', `--rpcserver=${rpc}`,
    `--macaroonpath=${lnddir}/data/chain/bitcoin/testnet4/readonly.macaroon`];
  const ask = (...argv) => JSON.parse(run(lncli, [...args, ...argv], { encoding: 'utf8', timeout: 30000 }));
  let holdInvoices = false;
  try { run(lncli, ['addholdinvoice', '--help'], { stdio: 'ignore' }); holdInvoices = true; } catch { /* absent */ }
  return { info: ask('getinfo'), channels: ask('listchannels').channels || [], holdInvoices };
}

/**
 * THE SAME QUESTIONS OF A REGTEST LND, ASKED WITH ITS OWN READ-ONLY KEY.
 *
 * `askLnd` knows only a testnet4 lnd by its own lnd.conf, so a regtest daemon
 * handed Lightning had NO preflight - and a node given a port and no preflight
 * opens no paying round. Measured through the launchers' own settings parse:
 * POST /round at 100000 msat -> 503 "this node holds stakes and has no
 * preflight", 0 msat -> 201. So no paying round could ever be rehearsed on
 * regtest through the real daemons.
 *
 * A regtest lnd is named the way the port names it - its directory, its RPC
 * address - and asked with `readonly.macaroon`, so this can move no money
 * either. It refuses anything that is not regtest by the node's own answer.
 */
export function askLndRegtest({ lncli, lnddir, rpc, run = execFileSync }) {
  const args = [`--lnddir=${lnddir}`, '--network=regtest', `--rpcserver=${rpc}`,
    `--macaroonpath=${lnddir}/data/chain/bitcoin/regtest/readonly.macaroon`];
  const ask = (...argv) => JSON.parse(run(lncli, [...args, ...argv], { encoding: 'utf8', timeout: 30000 }));
  const info = ask('getinfo');
  const network = info && info.chains && info.chains[0] && info.chains[0].network;
  if (network !== 'regtest') throw new Error(`${lnddir} answers as ${network}, not regtest`);
  let holdInvoices = false;
  try { run(lncli, ['addholdinvoice', '--help'], { stdio: 'ignore' }); holdInvoices = true; } catch { /* absent */ }
  return { info, channels: ask('listchannels').channels || [], holdInvoices };
}

/** The regtest preflight a daemon is given - the same verdict, a regtest lnd. */
export const lndPreflightRegtest = ({ lncli, lnddir, rpc, run }) => async ({ contract }) => {
  const stakeMsat = contract.stakeMsat;
  return lightningPreflight({
    ...askLndRegtest({ lncli, lnddir, rpc, ...(run ? { run } : {}) }), players: MIN_PLAYERS_PER_ROUND,
    entry: { stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n },
  });
};

/**
 * THE PREFLIGHT A DAEMON IS GIVEN, for the round it is asked to open: the
 * fewest seats a round opens for, each at the round's stake with the fee out
 * of it and no donation - the largest hold a seat can ask for.
 */
export const lndPreflight = ({ lncli, lnddir }) => async ({ contract }) => {
  const stakeMsat = contract.stakeMsat;
  return lightningPreflight({
    ...askLnd({ lncli, lnddir }), players: MIN_PLAYERS_PER_ROUND,
    entry: { stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n },
  });
};

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
