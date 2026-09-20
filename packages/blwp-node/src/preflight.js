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
 * THE FEWEST SIGNER NODES A ROUND IS OPENED FOR. 27A.7.1's game_config names
 * `min_players_per_round 2`; nothing in this package named it until a round
 * had to be sized against a node's inbound before anybody had entered.
 */
// One number with the fee-lock gate: protocol constants.js.
import { gatewaysAreIndependent } from '../../protocol/src/gateways.js';
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
  return { info: ask('getinfo'), channels: ask('listchannels').channels || [], holdInvoices, rpc };
}

/**
 * THE OPERATOR'S GATEWAYS AS `gatewaysAreIndependent` WANTS THEM, asked the same read-only way.
 *
 * One entry per node, each from that node's OWN `getinfo` and `listchannels` - never from a label and never
 * from a list somebody typed. A node that will not answer is reported as unsynced with no channels rather
 * than dropped, so a stopped gateway shows up as one that cannot receive instead of vanishing from the count.
 *
 * `lnddirs` defaults to the operator's pair on this machine. Same host is allowed by the ruling; what has to
 * differ is the identity and the rpc, which is exactly what the predicate reads.
 */
export function askGateways({ lncli, lnddirs = TESTNET4_GATEWAYS, run = execFileSync, read = readFileSync }) {
  return lnddirs.map((lnddir) => {
    try {
      const said = askLnd({ lncli, lnddir, run, read });
      return {
        identityPubkey: said.info && said.info.identity_pubkey,
        rpc: said.rpc,
        syncedToChain: said.info && said.info.synced_to_chain === true,
        channels: (said.channels || []).map((c) => ({
          active: c.active === true, remoteBalanceSat: BigInt(c.remote_balance || 0),
        })),
      };
    } catch {
      // A GATEWAY THAT WILL NOT ANSWER IS A GATEWAY THAT CANNOT RECEIVE. It keeps its place in the list with
      // nothing in it, so the count is honest about how many were asked.
      return { identityPubkey: '', rpc: lnddir, syncedToChain: false, channels: [] };
    }
  });
}

/** The operator's two testnet4 gateways on this machine (M3, RULED 2026-09-20). */
export const TESTNET4_GATEWAYS = ['/mnt/bitcoin/lnd-testnet4', '/mnt/bitcoin/lnd-testnet4-b'];

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

/**
 * The regtest preflight a daemon is given - the same verdict, a regtest lnd.
 *
 * `gateways` are the regtest nodes this operator will take deposits through, as `{ lnddir, rpc }`. §23.6 asks
 * for at least two on any paying round, and regtest is not an exemption: a rehearsal that skips the gate
 * rehearses the wrong thing. Declared none, the daemon offers only the node it was pointed at, which is one -
 * and one is refused, loudly, rather than waved through.
 */
export const lndPreflightRegtest = ({ lncli, lnddir, rpc, run, gateways }) => async ({ contract }) => {
  const stakeMsat = contract.stakeMsat;
  const declared = Array.isArray(gateways) && gateways.length ? gateways : [{ lnddir, rpc }];
  return lightningPreflight({
    ...askLndRegtest({ lncli, lnddir, rpc, ...(run ? { run } : {}) }), players: MIN_PLAYERS_PER_ROUND,
    entry: { stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n },
    gateways: askGatewaysRegtest({ lncli, gateways: declared, ...(run ? { run } : {}) }),
  });
};

/** The same gathering for regtest nodes, which are named by flags rather than by their own lnd.conf. */
export function askGatewaysRegtest({ lncli, gateways, run = execFileSync }) {
  return gateways.map(({ lnddir, rpc }) => {
    try {
      const said = askLndRegtest({ lncli, lnddir, rpc, run });
      return {
        identityPubkey: said.info && said.info.identity_pubkey,
        rpc,
        syncedToChain: said.info && said.info.synced_to_chain === true,
        channels: (said.channels || []).map((c) => ({
          active: c.active === true, remoteBalanceSat: BigInt(c.remote_balance || 0),
        })),
      };
    } catch {
      return { identityPubkey: '', rpc: rpc || lnddir, syncedToChain: false, channels: [] };
    }
  });
}

/**
 * THE PREFLIGHT A DAEMON IS GIVEN, for the round it is asked to open: the
 * fewest players a round opens for, each at the round's stake with the fee out
 * of it and no donation - the largest hold an entry can ask for.
 */
export const lndPreflight = ({ lncli, lnddir, lnddirs }) => async ({ contract }) => {
  const stakeMsat = contract.stakeMsat;
  return lightningPreflight({
    ...askLnd({ lncli, lnddir }), players: MIN_PLAYERS_PER_ROUND,
    entry: { stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n },
    // AND THE GATEWAYS, asked the same read-only way. Without them a staking round is refused (§23.6).
    gateways: askGateways({ lncli, ...(lnddirs ? { lnddirs } : {}) }),
  });
};

/**
 * @param {object} o
 * @param {object} o.info          `lncli getinfo`
 * @param {object[]} o.channels    `lncli listchannels`.channels
 * @param {boolean} o.holdInvoices whether this lnd offers `addholdinvoice`
 * @param {number} o.players       entries this node must hold at once
 * @param {object} o.entry         one entry's { stakeMsat, feeMsat, donationMsat }
 * @param {object[]|null} o.gateways what the operator's OWN gateways reported - one entry per node, each from
 *                                   that node's `getinfo` and `listchannels`. Null is not "no opinion": a
 *                                   staking round is refused without them. See below.
 */
export function lightningPreflight({ info, channels = [], holdInvoices = false, players, entry,
                                     gateways = null }) {
  const network = (info && info.chains && info.chains[0] && info.chains[0].network) || 'unknown';

  // MAINNET IS REFUSED BEFORE ANYTHING IS COMPUTED. Nothing here should read as
  // "almost ready" about a node that holds real money.
  if (network === 'mainnet')
    return { ready: false, network, missing: ['that is a MAINNET node: no round holds stakes on it before M4'], facts: {} };

  const missing = [];
  if (!PLAYABLE.includes(network))
    missing.push(`that node is on ${network}, and rounds hold stakes only on ${PLAYABLE.join(' or ')}`);

  if (!Number.isInteger(players) || players < 1)
    throw new Error('a preflight is asked for a positive number of signer nodes');
  const perSignerNode = netStakeMsat(entry);

  // A ROUND THAT ASKS NO STAKE NEEDS NO LIGHTNING AT ALL (M3.3-19). Saying it
  // is not ready because a channel is missing would be the fault that letter
  // closed, arriving from the other side.
  if (perSignerNode === 0n && entry.stakeMsat === 0n)
    return {
      ready: !missing.length, network, missing,
      facts: { heldPerSignerNodeMsat: 0n, neededMsat: 0n },
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

  const needed = perSignerNode * BigInt(players);
  if (inbound < needed)
    missing.push(`${players} hold${players === 1 ? '' : 's'} of ${perSignerNode} msat need ${needed} msat `
      + `of inbound, and the channels offer ${inbound}`);

  if (!holdInvoices)
    missing.push('that lnd does not offer addholdinvoice, so it cannot hold a stake');

  // AND A PAYING ROUND NEEDS SOMEWHERE FOR THE MONEY TO COME IN FROM - MORE THAN ONE (§23.6).
  //
  // Everything above this line asks ONE node about itself. That is not the law: "deposits and withdrawals
  // through any of at least two gateways ... No gateway holds a round's money or is needed by it" - a round
  // opened against a single endpoint is one outage away from a player who has paid and cannot be paid back,
  // and §22 is explicit that a gateway may refuse but never keep. So the round does not open until two
  // independent gateways are shown, and the operator does not get to skip the check by not answering it:
  // `gateways` absent or unreadable is a REFUSAL, not a pass. Missing gateways are not an escape hatch.
  //
  // WHAT "INDEPENDENT" MEANS HERE IS NARROWER THAN THE LAW'S EVENTUAL TEST, and that is written down rather
  // than blurred: §23.6 wants "different operators", and this M3 step (RULED 2026-09-20, named pick A) is the
  // operator's own two testnet4 nodes, same host allowed. `gatewaysAreIndependent` therefore counts distinct
  // identities at distinct rpc addresses that are synced and hold inbound, and does not read the host.
  // Different-operator gateways are a later letter; nothing here claims otherwise.
  if (!Array.isArray(gateways)) {
    missing.push('this node was shown no gateways, so it cannot open a paying round (§23.6 wants at least two)');
  } else {
    const independent = gatewaysAreIndependent({ gateways });
    if (!independent.ok) missing.push(`the gateways cannot take this round's money: ${independent.why}`);
  }

  return {
    ready: !missing.length, network, missing,
    facts: {
      synced: !!(info && info.synced_to_chain), activeChannels: active.length,
      inboundMsat: inbound, outboundMsat: outbound, heldPerSignerNodeMsat: perSignerNode, neededMsat: needed,
    },
    why: missing.length ? missing.join('; ') : `${players} signer node(s) of ${perSignerNode} msat can be held`,
  };
}
