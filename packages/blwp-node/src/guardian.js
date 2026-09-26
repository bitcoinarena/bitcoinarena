// ONE NODE IS ONE GUARDIAN, AND THE NODE RUNS IT (spec §23A.2, RULED the owner 2026-09-26 22:54 / 22:57).
//
// Starting the node starts its guardian; stopping the node stops it. The operator configures nothing for it: no second
// binary he launches, no FM_API_URL he types, no invite he pastes. Everything the guardian needs is read off what the
// node already has:
//
//   network     the node's own bitcoind (`getblockchaininfo.chain`): testnet4, regtest or main
//   bitcoind    the node's BLWP_BITCOIND_URL and the secret in its BLWP_BITCOIND_COOKIE
//   data        beside the node's store: <store>.guardian/
//   ports       fixed offsets from the node's own port, bound to 127.0.0.1 only - the public side is the node
//   endpoint    the node's own public address with /guardian after it: the path Tailscale Funnel proxies to this
//               node's port, found by the node itself; a phone opens exactly that. The node's server carries the
//               websocket through to the guardian (server.js, /guardian).
//
// TESTNET4 IS A CHAIN FEDIMINT 0.12 DOES NOT KNOW. It names a chain by its block-1 hash
// (fedimint-server-core/src/bitcoin_rpc.rs `network_from_chain_id`: mainnet, testnet3, signet, mutinynet) and treats
// every other chain as Regtest, "custom/private networks". So a guardian configured `testnet4` sees its own chain as
// Regtest and stops - walletv2 at the ceremony (lib.rs:425, left Regtest right Testnet4), the wallet module at start
// ("Wrong Network", wallet-server lib.rs:1280) - measured 2026-09-26 on both the node's bitcoind and mempool.space's
// Esplora, and still so in v0.12.1 and on master. Fedimint is not patched (§23A.2: stock, unpatched), so a guardian on
// testnet4 carries Fedimint's own label for that chain, `regtest`, on the real testnet4 chain. The paying path is
// unaffected: a deposit is an LNv2 receive through the gateway (no currency check), and winnings are the gateway's
// send_payment (no currency check there either); only on-chain peg addresses print as bcrt1. The federation runs
// Fedimint's stock `wallet` module, not walletv2 (RULED 2026-09-26). Base fees off (§23A.2). Founding - which four nodes are drawn and run that ceremony - is §23A.2's
// sortition, not this file: a guardian started here waits in Fedimint's setup until it is drawn.
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { randomBytes } from 'node:crypto';

/** The guardian's ports, all local: offsets from the node's own port, so four nodes on one machine never collide. */
export function guardianPorts(nodePort) {
  const p = Number(nodePort);
  if (!Number.isInteger(p) || p <= 0 || p + 4000 > 65535) throw new Error(`guardian: no ports can follow node port ${nodePort}`);
  return { api: p + 1000, p2p: p + 2000, ui: p + 3000, metrics: p + 4000 };
}

/** Fedimint's name for the network bitcoind reports. */
export function fedimintNetwork(chain) {
  // testnet4 -> 'regtest': Fedimint 0.12's own label for a chain it does not know (see the header)
  const n = { test: 'testnet', testnet4: 'regtest', regtest: 'regtest', main: 'bitcoin', signet: 'signet' }[chain];
  if (!n) throw new Error(`guardian: bitcoind reports chain "${chain}", which a guardian does not run on`);
  return n;
}

/**
 * THE NODE'S OWN PUBLIC ADDRESS, as Tailscale Funnel serves it: the https origin and path whose handler proxies to this
 * node's port, on this machine's own name, public only. `status` and `funnel` are `tailscale status --json` and
 * `tailscale funnel status --json`. null when no public path reaches this port.
 */
export function funnelBaseFor(nodePort, { status, funnel } = {}) {
  const self = String((status && status.Self && status.Self.DNSName) || '').replace(/\.$/, '');
  const open = (funnel && funnel.AllowFunnel) || {};
  for (const [hostPort, web] of Object.entries((funnel && funnel.Web) || {})) {
    const [h, p] = hostPort.split(':');
    if (!self || h !== self || !open[hostPort]) continue;
    for (const [path, handler] of Object.entries((web && web.Handlers) || {})) {
      let target = null;
      try { target = new URL(handler.Proxy); } catch { continue; }
      if (Number(target.port) !== Number(nodePort)) continue;
      return `${h}${p && p !== '443' ? `:${p}` : ''}${path === '/' ? '' : path.replace(/\/+$/, '')}`;
    }
  }
  return null;
}

/** The endpoint a phone opens for this node's guardian: its own public address, /guardian. */
export function guardianEndpoint(nodePort, { host = '127.0.0.1', tailscale = null } = {}) {
  const base = tailscale ? funnelBaseFor(nodePort, tailscale) : null;
  return base ? `wss://${base}/guardian` : `ws://${host}:${nodePort}/guardian`;
}

/** Everything fedimintd is started with - derived, never typed. */
export function guardianEnv({ nodePort, dataDir, network, chain = network, bitcoindUrl, cookieSecret, password, endpoint }) {
  const ports = guardianPorts(nodePort);
  const env = {
    FM_DATA_DIR: dataDir,
    FM_BITCOIN_NETWORK: network,
    FM_BITCOIND_URL: bitcoindUrl,
    FM_BITCOIND_USERNAME: '__cookie__',
    FM_BITCOIND_PASSWORD: cookieSecret,
    FM_BIND_API: `127.0.0.1:${ports.api}`,
    FM_BIND_P2P: `127.0.0.1:${ports.p2p}`,
    FM_BIND_UI: `127.0.0.1:${ports.ui}`,
    FM_BIND_METRICS: `127.0.0.1:${ports.metrics}`,
    FM_P2P_URL: `fedimint://127.0.0.1:${ports.p2p}`,
    FM_API_URL: endpoint,
    FM_ENABLE_IROH: 'false',
    FM_PASSWORD_API: password,
    FM_PASSWORD_UI: password,
    FM_DISABLE_BASE_FEES: '1',
  };
  if (chain === 'testnet4') { env.FM_ENABLE_MODULE_WALLETV2 = 'false'; env.FM_ENABLE_MODULE_WALLET = 'true'; }
  return env;
}

/** fedimintd on the node's PATH, as the node finds any tool it runs; null when this machine has none. */
export function findFedimintd(pathVar = process.env.PATH || '') {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const f = join(dir, 'fedimintd');
    try { accessSync(f, constants.X_OK); return f; } catch { /* next */ }
  }
  return null;
}

const readTailscale = () => new Promise((resolve) => {
  const json = (args) => new Promise((ok) => execFile('tailscale', args, { timeout: 10000 }, (e, out) => {
    try { ok(e ? null : JSON.parse(out)); } catch { ok(null); }
  }));
  Promise.all([json(['status', '--json']), json(['funnel', 'status', '--json'])])
    .then(([status, funnel]) => resolve(status && funnel ? { status, funnel } : null));
});

/**
 * Start this node's guardian. Answers `{ running, why, endpoint, apiPort, stop }`; `running: false` names why - a node
 * with no chain, or no fedimintd on this machine, is not a guardian, and says so rather than failing its start.
 */
export async function startGuardian({ nodePort, host, storePath, bitcoindUrl, cookiePath, call, env = process.env,
  tailscale = undefined, log = (s) => console.log(s) }) {
  const not = (why) => { log(`[guardian] not a guardian: ${why}`); return { running: false, why, stop: async () => {} }; };
  if (!bitcoindUrl || !cookiePath) return not('this node reads no chain (BLWP_BITCOIND_URL / BLWP_BITCOIND_COOKIE)');
  const bin = findFedimintd(env.PATH || '');
  if (!bin) return not('no fedimintd on this machine');
  let network, chain;
  try { chain = (await call('getblockchaininfo')).chain; network = fedimintNetwork(chain); } catch (e) { return not(e.message); }
  const dataDir = `${storePath === ':memory:' ? join(env.TMPDIR || '/tmp', `blwp-guardian-${nodePort}`) : storePath}.guardian`;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const pwFile = join(dataDir, 'admin-password');
  if (!existsSync(pwFile)) writeFileSync(pwFile, randomBytes(24).toString('hex'), { mode: 0o600 });
  const ts = tailscale === undefined ? await readTailscale() : tailscale;
  const endpoint = guardianEndpoint(nodePort, { host, tailscale: ts });
  const fmEnv = guardianEnv({ nodePort, dataDir, network, chain, bitcoindUrl, endpoint,
    cookieSecret: readFileSync(cookiePath, 'utf8').trim().split(':').slice(1).join(':'),
    password: readFileSync(pwFile, 'utf8').trim() });
  const out = openSync(join(dataDir, 'fedimintd.log'), 'a');
  const child = spawn(bin, [], { env: { ...env, ...fmEnv }, stdio: ['ignore', out, out] });
  let exited = false;
  child.on('exit', (code, sig) => { exited = true; log(`[guardian] fedimintd exited (${sig || code})`); });
  log(`[guardian] fedimintd ${child.pid} on chain ${chain} (Fedimint label ${network}), endpoint ${endpoint}, api 127.0.0.1:${guardianPorts(nodePort).api}`);
  return {
    running: true, endpoint, network, chain, dataDir, apiPort: guardianPorts(nodePort).api, pid: child.pid,
    stop: () => new Promise((r) => {
      if (exited) return r();
      child.once('exit', () => r());
      child.kill('SIGTERM');
      setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 10000).unref();
    }),
  };
}
