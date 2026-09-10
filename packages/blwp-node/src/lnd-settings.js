// WHERE A LAUNCHER LEARNS ITS LIGHTNING NODE, AND THE ONE PLACE IT IS PARSED.
//
// Four settings, all or none:
//
//     BLWP_LNCLI         the lncli binary
//     BLWP_LND_DIR       the lnd's own directory (its admin macaroon is found there)
//     BLWP_LND_RPC       its gRPC address, e.g. 127.0.0.1:10009
//     BLWP_LND_NETWORK   testnet4 or regtest - never mainnet here
//
// Measured before any launcher read them (tools/custody-restart-lnd.mjs): a
// custodian killed inside a settle and restarted as src/main.js left the stake
// ACTING whatever lnd said, because no launch path handed a daemon its
// Lightning node. Every launcher reads them through this, so a second one
// cannot quietly accept half a node or a network the first refuses.
//
// The preflight that gates a paying round asks the lnd with its read-only key
// and only knows testnet4; on regtest none is returned, so a regtest daemon
// reconciles and settles but opens no paying round - the gate fails closed.
import { lndPort } from './lnd-port.js';
import { lndPreflight, PLAYABLE } from './preflight.js';

export const LND_SETTINGS = ['BLWP_LNCLI', 'BLWP_LND_DIR', 'BLWP_LND_RPC', 'BLWP_LND_NETWORK'];

/**
 * @returns {{ ok: true, given: false } |
 *   { ok: true, given: true, lightning, preflight, rpc, network } |
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
    return { ok: false, why: `${lnd.BLWP_LND_NETWORK} is not a network a round may hold stakes on here `
      + `(${PLAYABLE.join(', ')})` };
  return {
    ok: true, given: true, rpc: lnd.BLWP_LND_RPC, network: lnd.BLWP_LND_NETWORK,
    lightning: lndPort({ lncli: lnd.BLWP_LNCLI, args: [`--lnddir=${lnd.BLWP_LND_DIR}`,
      `--rpcserver=${lnd.BLWP_LND_RPC}`, `--network=${lnd.BLWP_LND_NETWORK}`] }),
    preflight: lnd.BLWP_LND_NETWORK === 'testnet4'
      ? lndPreflight({ lncli: lnd.BLWP_LNCLI, lnddir: lnd.BLWP_LND_DIR }) : null,
  };
}
