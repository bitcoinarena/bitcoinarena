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
// The preflight that gates a paying round asks the lnd with its read-only key
// and only knows testnet4; on regtest none is returned, so a regtest daemon
// reconciles and settles but opens no paying round - the gate fails closed.
import { lndPort } from './lnd-port.js';
import { lndPreflight, lndPreflightRegtest, PLAYABLE } from './preflight.js';

export const LND_SETTINGS = ['BLWP_LNCLI', 'BLWP_LND_DIR', 'BLWP_LND_RPC', 'BLWP_LND_NETWORK'];

/**
 * The gateways a launcher named, `lnddir@rpc,lnddir@rpc`. An entry may leave the rpc off (`lnddir`), which
 * is how a testnet4 node is named: its own lnd.conf says where it answers. Nothing here is checked against
 * a node - `askGateways` asks each one itself, and a gateway that will not answer keeps its place in the
 * list with nothing in it, so the count stays honest.
 *
 * @returns {{ ok: true, gateways: {lnddir: string, rpc: string}[] } | { ok: false, why: string }}
 */
export function gatewaysFromEnv(env) {
  const raw = (env.BLWP_LND_GATEWAYS || '').trim();
  if (!raw) return { ok: true, gateways: [] };
  const gateways = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = part.indexOf('@');
    const lnddir = at === -1 ? part : part.slice(0, at);
    const rpc = at === -1 ? '' : part.slice(at + 1);
    if (!lnddir) return { ok: false, why: `BLWP_LND_GATEWAYS names a gateway with no lnd directory: "${part}"` };
    gateways.push({ lnddir, rpc });
  }
  return { ok: true, gateways };
}

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
  const named = gatewaysFromEnv(env);
  if (!named.ok) return named;
  const gateways = named.gateways;
  return {
    ok: true, given: true, rpc: lnd.BLWP_LND_RPC, network: lnd.BLWP_LND_NETWORK,
    lightning: lndPort({ lncli: lnd.BLWP_LNCLI, args: [`--lnddir=${lnd.BLWP_LND_DIR}`,
      `--rpcserver=${lnd.BLWP_LND_RPC}`, `--network=${lnd.BLWP_LND_NETWORK}`] }),
    // TESTNET4 BY ITS lnd.conf; REGTEST BY THE SAME FLAGS THE PORT USES. Both
    // with the read-only key. Measured before the regtest one: a paying round
    // on a regtest daemon with Lightning -> 503 "no preflight".
    //
    // THE GATEWAYS THE LAUNCHER NAMED go to both, each in the shape that preflight asks its nodes with.
    // Named none, neither is given any and each keeps the fallback it already had: testnet4 the operator's
    // two known dirs, regtest the one node it was pointed at - which is one, and one is refused.
    preflight: lnd.BLWP_LND_NETWORK === 'testnet4'
      ? lndPreflight({ lncli: lnd.BLWP_LNCLI, lnddir: lnd.BLWP_LND_DIR,
        ...(gateways.length ? { lnddirs: gateways.map((g) => g.lnddir) } : {}) })
      : lndPreflightRegtest({ lncli: lnd.BLWP_LNCLI, lnddir: lnd.BLWP_LND_DIR, rpc: lnd.BLWP_LND_RPC,
        ...(gateways.length ? { gateways } : {}) }),
  };
}
