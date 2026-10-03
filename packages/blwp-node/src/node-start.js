// A NODE STARTS, AND RUNS A GUARDIAN ONLY IF IT HOLDS A GUARDIAN KEY (spec §23A.2, one node is one guardian; the owner
// 2026-09-27: "a launcher-started node runs a guardian only when it is one of the four testnet nodes that already hold
// a guardian key ... Starting a node is not enough. Holding that node's guardian key is the test").
//
// The key is what a completed key ceremony leaves beside the node's store: <store>.guardian/private.json (this
// guardian's own keys) and <store>.guardian/consensus.json (the federation it guards). Both there and both parse: the
// node starts its guardian (guardian.js, everything derived) and serves with it; its GET /guardian then says so. Either
// missing: no guardian is started and no directory is made - the node answers {guardian: false}. main.js and the
// launcher start every node through here, so whether a node is a guardian is decided by the node, never by a launcher.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { toHex } from '../../protocol/src/hash.js';
import { join } from 'node:path';
import { serve } from './server.js';
import { startGuardian } from './guardian.js';

/** Whether the node on this store holds a guardian key: both ceremony files beside it, both parsing. */
export function holdsGuardianKey(storePath) {
  if (!storePath || storePath === ':memory:') return false;
  const dir = `${storePath}.guardian`;
  try {
    JSON.parse(readFileSync(join(dir, 'private.json'), 'utf8'));
    JSON.parse(readFileSync(join(dir, 'consensus.json'), 'utf8'));
    return true;
  } catch { return false; }
}

/**
 * Start one node on its store: its guardian first when it holds a key, then the node, served with that guardian.
 * `store` is `{ db, path }`; `options` are serve()'s; `chain` is what the guardian reads the chain with -
 * `{ bitcoindUrl, cookiePath, call, env, tailscale, log }`, the node's own settings. The returned node's close() stops
 * both.
 */
export async function startNode({ db, path }, options = {}, chain = {}) {
  let guardian = { running: false, stop: async () => {} };
  if (holdsGuardianKey(path)) {
    guardian = await startGuardian({ nodePort: options.port, host: options.host || '127.0.0.1', storePath: path,
      bitcoindUrl: chain.bitcoindUrl, cookiePath: chain.cookiePath, call: chain.call,
      ...(chain.env ? { env: chain.env } : {}), ...(chain.tailscale !== undefined ? { tailscale: chain.tailscale } : {}),
      ...(chain.log ? { log: chain.log } : {}) });
  }
  let node;
  try {
    node = await serve(db, guardian.running
      ? { ...options, guardian: { apiPort: guardian.apiPort, endpoint: guardian.endpoint } } : options);
  } catch (e) { await guardian.stop(); throw e; }
  const closeNode = node.close;
  node.close = async () => { try { await closeNode(); } finally { await guardian.stop(); } };
  node.guardianRunning = guardian.running;
  return node;
}

// ---- THE NODE'S LND, READ FROM ITS ENVIRONMENT (moved here from lnd-port.js and lnd-settings.js, THRESHOLD_LN cut, the owner
// 2026-10-03: those two files are gone; main.js and tools/round-2of2.mjs read the node's Lightning settings from here) ----

// A READ-ONLY WINDOW ONTO A REAL LIGHTNING NODE: IT DECODES AN INVOICE, AND NOTHING ELSE.
//
// This file used to be the port a signer node's custody drove - issue a hold invoice on the hash an
// entry named, look it up, settle it with a preimage, cancel it - and its own header said what that was:
// "SINGLE-NODE CUSTODY, NOT §23.5. One `lncli`, one macaroon, one operator who could run every one of
// these commands by hand." That custody is the withdrawn Lightning custody, and it does not exist (§23.6, RULED 2026-09-22
// 22:59): the custody field has one value, FEDERATION. Issuing, looking up, settling, cancelling and
// paying are gone with it, and so is the table mapping lnd's invoice states onto 23.2's.
//
// WHAT IS LEFT, AND NEITHER IS CUSTODY:
//
//   decode    `/federation-invoice` must say which hash and amount the federation's LNv2 invoice carries
//             before a player commits to them, read off the invoice rather than the federation's word.
//             `decodepayreq` is local and read-only.
//   invoice   an ORDINARY invoice (`addinvoice`, no hold), which the donation recipients a launcher binds
//             mint to be paid a §22A donation. No stake is in it; money arrives and stays. This was cut with
//             the rest at first and restored: the caller is a tool, not `src/`, and only `src/` was checked.

/**
 * @param {object} o
 * @param {string} o.lncli    path to the lncli binary
 * @param {string[]} o.args   the flags that name ONE node: --lnddir, --rpcserver, --network
 * @param {number} o.timeoutMs
 */
export function lndPort({ lncli, args = [], timeoutMs = 60000, expirySeconds = 3600, run = null }) {
  const call = run || ((argv) => new Promise((resolve, reject) => {
    execFile(lncli, [...args, ...argv], { timeout: timeoutMs, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`lncli ${argv[0]} refused: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      });
  }));
  const json = async (argv) => {
    const out = await call(argv);
    try { return JSON.parse(out); } catch { throw new Error(`lncli ${argv[0]} did not answer JSON: ${out.slice(0, 200)}`); }
  };

  return {
    // AN ORDINARY INVOICE FOR A DONATION RECIPIENT (§22A), described by the LNURL metadata's hash.
    async invoice({ amountMsat, descriptionHash, expirySeconds: expiry = expirySeconds }) {
      const made = await json(['addinvoice', '--amt_msat', String(amountMsat),
        '--description_hash', toHex(descriptionHash), '--expiry', String(expiry)]);
      return { request: made.payment_request, paymentHash: Buffer.from(String(made.r_hash), 'hex') };
    },

    // READ AN INVOICE THIS NODE DID NOT MAKE: a federation round's invoice comes from the federation
    // (invoice first, the owner 2026-09-11), and the node has to say which hash and amount it carries
    // before a player commits to them.
    async decode({ request }) {
      const d = await json(['decodepayreq', String(request)]);
      return { paymentHash: Buffer.from(d.payment_hash, 'hex'), amountMsat: BigInt(d.num_msat || 0) };
    },
  };
}

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
