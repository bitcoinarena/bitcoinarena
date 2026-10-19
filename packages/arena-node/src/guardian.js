// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE NODE IS ONE GUARDIAN, AND THE NODE RUNS IT (spec §23A.2, RULED the owner 2026-09-26 22:54 / 22:57).
//
// Starting the node starts its guardian; stopping the node stops it. The operator configures nothing for it: no second
// binary he launches, no FM_API_URL he types, no invite he pastes. Everything the guardian needs is read off what the
// node already has:
//
//   network     the node's own bitcoind (`getblockchaininfo.chain`): testnet4, regtest or main
//   bitcoind    the node's ARENA_BITCOIND_URL and the secret in its ARENA_BITCOIND_COOKIE
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
// Esplora, and still so in v0.12.1 and on master. The `regtest` label that let a guardian run left no stock gateway able
// to join (gateway lib.rs:1057, LN testnet4 vs gateway regtest), so Fedimint is patched (the owner 2026-09-27 07:35/07:51,
// the smallest change): network_from_chain_id names testnet4 by its block-1 hash 0000000012982b6d...
// (tools/fedimint-testnet4.patch). A guardian on testnet4 is labelled testnet4, the gateway too. The same patch gives
// testnet4 the fee rate the Regtest label had (1 sat/vB) when its bitcoind has no estimate - measured: the guardians
// otherwise stop at consensus start, "No connection to bitcoin rpc", on estimatesmartfee's "Insufficient data". The federation runs
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

// THE GUARDIAN-NEXT (§23A.6 step 1, kanban #326): a node whose guardian runs in consensus and is seated first in its federation's
// successor needs a second fedimintd, in setup mode, for the successor's key ceremony - beside the first, which MUST serve until
// its federation is CLOSED (§23A.6 step 4). Its own data <store>.guardian-next/, its own ports +5000..+8000 of the node's port (the
// first guardian's are +1000..+4000; the next node up a machine's row is +10), and its own public path /guardian-next on the node.
// Fedimint writes its P2P and API URLs into the federation's config at the ceremony, so the successor keeps these ports and that
// path for as long as it runs.
export const GUARDIAN_SLOTS = Object.freeze({ guardian: { dir: '.guardian', path: '/guardian', offset: 0, unit: 'guardian' },
  next: { dir: '.guardian-next', path: '/guardian-next', offset: 4000, unit: 'guardian-next' } });
/** The guardian-next's ports: +5000 .. +8000 of the node's port. */
export function guardianNextPorts(nodePort) {
  const p = Number(nodePort);
  if (!Number.isInteger(p) || p <= 0 || p + 8000 > 65535) throw new Error(`guardian-next: no ports can follow node port ${nodePort}`);
  const o = guardianPorts(p);
  return { api: o.api + 4000, p2p: o.p2p + 4000, ui: o.ui + 4000, metrics: o.metrics + 4000 };
}
const slotPorts = (slot, nodePort) => (slot === 'next' ? guardianNextPorts(nodePort) : guardianPorts(nodePort));

/** Fedimint's name for the network bitcoind reports. */
export function fedimintNetwork(chain) {
  // testnet4 -> 'testnet4': the patched fedimintd names this chain by its block-1 hash (see the header)
  const n = { test: 'testnet', testnet4: 'testnet4', regtest: 'regtest', main: 'bitcoin', signet: 'signet' }[chain];
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

/** The endpoint a phone opens for this node's guardian: its own public address, /guardian (/guardian-next for the second). */
export function guardianEndpoint(nodePort, { host = '127.0.0.1', tailscale = null, path = '/guardian' } = {}) {
  const base = tailscale ? funnelBaseFor(nodePort, tailscale) : null;
  return base ? `wss://${base}${path}` : `ws://${host}:${nodePort}${path}`;
}

/** Everything fedimintd is started with - derived, never typed. `ports` the slot's (guardianPorts, or guardianNextPorts). */
export function guardianEnv({ nodePort, dataDir, network, chain = network, bitcoindUrl, cookieSecret, password, endpoint, ports = guardianPorts(nodePort) }) {
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

/** fedimintd on the node's PATH, as the node finds any tool it runs (fedimintd.exe on Windows); null when this machine has none. */
export function findFedimintd(pathVar = process.env.PATH || '', platform = process.platform) {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const f = join(dir, platform === 'win32' ? 'fedimintd.exe' : 'fedimintd');
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
/** The kept guardian's own unit, by node port: blwp-tn4-guardian-31221 for the node on 31221 (blwp-tn4-guardian-next-31221 for its second). */
export const guardianUnit = (nodePort, slot = 'guardian') => `blwp-tn4-${slot === 'next' ? 'guardian-next' : 'guardian'}-${nodePort}`;

/** systemd --user, for a kept guardian: whether its unit runs, and starting it (its env and log given). */
export const systemdUnits = {
  active: (unit) => new Promise((ok) => execFile('systemctl', ['--user', 'is-active', '--quiet', `${unit}.service`], (e) => ok(!e))),
  start: (unit, bin, envVars, logPath) => new Promise((ok, no) => execFile('systemd-run',
    ['--user', `--unit=${unit}`, '--collect', '-p', 'Restart=on-failure', '-p', `StandardOutput=append:${logPath}`,
      '-p', `StandardError=append:${logPath}`, ...Object.entries(envVars).map(([k, v]) => `--setenv=${k}=${v}`), bin],
    { timeout: 20000 }, (e, out, err) => (e ? no(new Error(`systemd-run ${unit}: ${(err || e.message).trim()}`)) : ok()))),
};

// `slot`: 'guardian' (the node's own) or 'next' (the guardian-next, kanban #326) - its data dir, ports, public path and unit.
// fedimintd on a data dir without a finished ceremony waits in setup mode (a founding drives it, founding-seat.js); with one, it
// runs the federation.
export async function startGuardian({ nodePort, host, storePath, bitcoindUrl, cookiePath, call, env = process.env,
  tailscale = undefined, log = (s) => console.log(s), chainTries = 12, chainWaitMs = 5000, units = systemdUnits, slot = 'guardian' }) {
  const S = GUARDIAN_SLOTS[slot];
  if (!S) throw new Error(`guardian: no slot ${slot}`);
  const tag = `[${S.unit}]`;
  log = ((say) => (line) => say(String(line).replace(/^\[guardian\]/, tag)))(log);
  const not = (why) => { log(`[guardian] not a guardian: ${why}`); return { running: false, why, stop: async () => {} }; };
  if (!bitcoindUrl || !cookiePath) return not('this node reads no chain (ARENA_BITCOIND_URL / ARENA_BITCOIND_COOKIE)');
  // ARENA_FEDIMINTD: the release's own custody binary (kanban #471 slice 5, written by the installer), else PATH
  const bin = env.ARENA_FEDIMINTD && existsSync(env.ARENA_FEDIMINTD) ? env.ARENA_FEDIMINTD : findFedimintd(env.PATH || '');
  if (!bin) return not('no fedimintd on this machine');
  let network, chain;
  // A CHAIN THAT DOES NOT ANSWER ONCE IS ASKED AGAIN (the owner's testnet4, 2026-09-28 09:27: node 1 of 7 restarted while
  // bitcoind was busy, got one "fetch failed", and ran the whole day as a node with no guardian - the federation at 6
  // of 7 and its invite naming the one guardian that was missing). A minute of tries; a chain that is not a known
  // network is refused at once, since asking again cannot change it.
  for (let tries = 1; ; tries++) {
    let info;
    try { info = await call('getblockchaininfo'); } catch (e) {
      if (tries >= chainTries) return not(`${e.message} (asked ${tries} times)`);
      log(`[guardian] bitcoind did not answer (${e.message}); asking again in ${chainWaitMs} ms, try ${tries} of ${chainTries}`);
      await new Promise((r) => setTimeout(r, chainWaitMs));
      continue;
    }
    try { chain = info.chain; network = fedimintNetwork(chain); } catch (e) { return not(e.message); }
    break;
  }
  const dataDir = `${storePath === ':memory:' ? join(env.TMPDIR || '/tmp', `blwp-guardian-${nodePort}`) : storePath}${S.dir}`;
  const ports = slotPorts(slot, nodePort);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const pwFile = join(dataDir, 'admin-password');
  if (!existsSync(pwFile)) writeFileSync(pwFile, randomBytes(24).toString('hex'), { mode: 0o600 });
  const ts = tailscale === undefined ? await readTailscale() : tailscale;
  // A NODE PUBLISHED THROUGH ANOTHER MACHINE'S FUNNEL (kanban #324, the second testnet4 federation on the test host: its nodes
  // are reached at wss://<test host>/fed2-N, a Funnel path the test host forwards over the tailnet): ARENA_GUARDIAN_ENDPOINT_<port>
  // names the guardian's public endpoint when this machine's own Tailscale cannot derive it
  // the guardian-next: ARENA_GUARDIAN_NEXT_ENDPOINT_<port>, else the first one's named endpoint with /guardian-next for /guardian
  const named = env[`ARENA_GUARDIAN_ENDPOINT_${nodePort}`];
  const endpoint = slot === 'next'
    ? env[`ARENA_GUARDIAN_NEXT_ENDPOINT_${nodePort}`] || (named ? named.replace(/\/guardian\/?$/, '') + S.path : guardianEndpoint(nodePort, { host, tailscale: ts, path: S.path }))
    : named || guardianEndpoint(nodePort, { host, tailscale: ts });
  const fmEnv = guardianEnv({ nodePort, dataDir, network, chain, bitcoindUrl, endpoint, ports,
    cookieSecret: readFileSync(cookiePath, 'utf8').trim().split(':').slice(1).join(':'),
    password: readFileSync(pwFile, 'utf8').trim() });
  // A GUARDIAN THAT OUTLIVES ITS NODE (the owner 2026-10-03, after the restart that held deposits: "2. Separate guardian and
  // node"). With ARENA_GUARDIAN_KEEP=1 the node still starts its own guardian, with nothing typed, but as a systemd user
  // unit of its own; a node that starts while that unit runs adopts it, and closing the node leaves it running - so a
  // node restart (a code update) is no guardian restart. Measured before: each guardian restarted mid-session replayed
  // the session (4733, 10164, 11546 units) and a deposit waited 168.8 s for the federation's order.
  if (env.ARENA_GUARDIAN_KEEP === '1' && storePath !== ':memory:') {
    const unit = guardianUnit(nodePort, slot);
    if (await units.active(unit)) {
      log(`[guardian] ${unit} already runs: adopted, not restarted; endpoint ${endpoint}, api 127.0.0.1:${ports.api}`);
      return { running: true, kept: true, adopted: true, unit, endpoint, network, chain, dataDir, apiPort: ports.api, slot, stop: async () => {} };
    }
    await units.start(unit, bin, { ...fmEnv, PATH: env.PATH || '' }, join(dataDir, 'fedimintd.log'));
    log(`[guardian] fedimintd started as ${unit} on chain ${chain} (Fedimint label ${network}), endpoint ${endpoint}, api 127.0.0.1:${ports.api}; it outlives this node`);
    return { running: true, kept: true, adopted: false, unit, endpoint, network, chain, dataDir, apiPort: ports.api, slot, stop: async () => {} };
  }
  const out = openSync(join(dataDir, 'fedimintd.log'), 'a');
  const child = spawn(bin, [], { env: { ...env, ...fmEnv }, stdio: ['ignore', out, out] });
  let exited = false;
  child.on('exit', (code, sig) => { exited = true; log(`[guardian] fedimintd exited (${sig || code})`); });
  log(`[guardian] fedimintd ${child.pid} on chain ${chain} (Fedimint label ${network}), endpoint ${endpoint}, api 127.0.0.1:${ports.api}`);
  return {
    running: true, endpoint, network, chain, dataDir, apiPort: ports.api, pid: child.pid, slot,
    stop: () => new Promise((r) => {
      if (exited) return r();
      child.once('exit', () => r());
      child.kill('SIGTERM');
      setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 10000).unref();
    }),
  };
}
