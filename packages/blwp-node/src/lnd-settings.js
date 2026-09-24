// WHERE A LAUNCHER LEARNS ITS LIGHTNING NODE, AND THE ONE PLACE IT IS PARSED.
//
// Four settings, all or none:
//
//     BLWP_LNCLI         the lncli binary
//     BLWP_LND_DIR       the lnd's own directory (its admin macaroon is found there)
//     BLWP_LND_RPC       its gRPC address, e.g. 127.0.0.1:10009
//     BLWP_LND_NETWORK   testnet4 or regtest - never mainnet here
//
// And one more, on its own:
//
//     BLWP_LND_GATEWAYS  the operator's deposit gateways, `lnddir@rpc` separated by commas
//
// §23.6 wants at least two gateways on any paying round, and `gatewaysAreIndependent` counts what the
// operator's own nodes reported - it cannot count a node nobody named. Measured on the Daily: with the
// gate live and no way to name a second node, the regtest preflight fell back to the one lnd it holds
// stakes on and EVERY paying round was refused, "1 of 1 gateways can actually receive; the round needs 2",
// two a minute, for as long as the keeper tried. Unset, that is still what happens - naming none is not a
// way to be waved through, it is a round that does not open.
//
// Measured before any launcher read them (tools/custody-restart-lnd.mjs): a
// custodian killed inside a settle and restarted as src/main.js left the stake
// ACTING whatever lnd said, because no launch path handed a daemon its
// Lightning node. Every launcher reads them through this, so a second one
// cannot quietly accept half a node or a network the first refuses.
//
// WHAT THIS LIGHTNING NODE IS FOR NOW: READING AN INVOICE, AND NOTHING ELSE (§23.6, RULED 2026-09-22
// 22:59). `/federation-invoice` decodes the federation's LNv2 invoice with it. It holds no stake: the
// hold invoice, the preflight that asked whether this lnd could receive a round's stakes, the gateways
// that preflight counted and the block pace that sized an HTLC were all the withdrawn Lightning custody's, and are gone.
import { lndPort } from './lnd-port.js';

// The networks a round may run on here. The lnd is checked against them because an invoice read off
// the wrong network would name an amount on a chain the round is not on.
const PLAYABLE = ['testnet4', 'regtest'];

export const LND_SETTINGS = ['BLWP_LNCLI', 'BLWP_LND_DIR', 'BLWP_LND_RPC', 'BLWP_LND_NETWORK'];

/**
 * @returns {{ ok: true, given: false } | { ok: true, given: true, lightning, rpc, network } |
 *   { ok: false, why: string }}
 */
export function lightningFromEnv(env) {
  const lnd = Object.fromEntries(LND_SETTINGS.map((k) => [k, env[k] || '']));
  const given = LND_SETTINGS.filter((k) => lnd[k]);
  if (!given.length) return { ok: true, given: false };
  if (given.length !== LND_SETTINGS.length)
    return { ok: false, why: 'BLWP_LNCLI, BLWP_LND_DIR, BLWP_LND_RPC and BLWP_LND_NETWORK go together: '
      + `set all four, or none (missing: ${LND_SETTINGS.filter((k) => !lnd[k]).join(', ')})` };
  if (!PLAYABLE.includes(lnd.BLWP_LND_NETWORK))
    return { ok: false, why: `${lnd.BLWP_LND_NETWORK} is not a network a round may run on here `
      + `(${PLAYABLE.join(', ')})` };
  return {
    ok: true, given: true, rpc: lnd.BLWP_LND_RPC, network: lnd.BLWP_LND_NETWORK,
    lightning: lndPort({ lncli: lnd.BLWP_LNCLI, args: [`--lnddir=${lnd.BLWP_LND_DIR}`,
      `--rpcserver=${lnd.BLWP_LND_RPC}`, `--network=${lnd.BLWP_LND_NETWORK}`] }),
  };
}
