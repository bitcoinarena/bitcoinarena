// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE NODE IS ONE GUARDIAN, AND THE NODE RUNS IT (spec §23A.2, RULED 2026-09-26 22:54 / 22:57).
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
// to join (gateway lib.rs:1057, LN testnet4 vs gateway regtest), so Fedimint is patched (2026-09-27 07:35/07:51,
// the smallest change): network_from_chain_id names testnet4 by its block-1 hash 0000000012982b6d...
// (tools/fedimint-testnet4.patch). A guardian on testnet4 is labelled testnet4, the gateway too. The same patch gives
// testnet4 the fee rate the Regtest label had (1 sat/vB) when its bitcoind has no estimate - measured: the guardians
// otherwise stop at consensus start, "No connection to bitcoin rpc", on estimatesmartfee's "Insufficient data". The federation runs
// Fedimint's stock `wallet` module, not walletv2 (RULED 2026-09-26). Base fees off (§23A.2). Founding - which four nodes are drawn and run that ceremony - is §23A.2's
// sortition, not this file: a guardian started here waits in Fedimint's setup until it is drawn.
import { spawn, execFile } from 'node:child_process';
import { ramDirOf, ramSupported, ramRestore, ramLoop } from './guardian-ram.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, accessSync, unlinkSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { p2pTunnelPort, guardianApiOverrides } from './p2p-tunnel.js';
import { createServer } from 'node:net';

/**
 * THE BITCOIND COOKIE A GUARDIAN WAS STARTED WITH, AS A FINGERPRINT (kanban #577, measured 2026-10-23: the test host's testnet4 bitcoind was
 * restarted at 05:14Z and wrote a new cookie; fedimintd takes the secret once, as FM_BITCOIND_PASSWORD, and never reads the file again - so
 * every guardian on that bitcoind logged "No bitcoin rpc connection" for an hour, its wallet stood still, and federation B's session 4659
 * could not close. A node restart did not help either: a running guardian is adopted, not restarted). The sha256 of the secret, never the
 * secret, kept beside the guardian's data (`bitcoind-cookie.sha`); a guardian whose fingerprint is not the cookie's now is started again.
 */
export function cookieFingerprint(cookiePath) {
  try { return createHash('sha256').update(readFileSync(cookiePath, 'utf8').trim().split(':').slice(1).join(':')).digest('hex'); } catch { return null; }
}
const COOKIE_SHA = 'bitcoind-cookie.sha';
const keptFingerprint = (dataDir) => { try { return readFileSync(join(dataDir, COOKIE_SHA), 'utf8').trim() || null; } catch { return null; } };
const keepFingerprint = (dataDir, sha) => { if (sha) { try { writeFileSync(join(dataDir, COOKIE_SHA), sha + '\n', { mode: 0o600 }); } catch { /* checked again next start */ } } };

/** The guardian's ports, all local: offsets from the node's own port, so four nodes on one machine never collide. */
export function guardianPorts(nodePort) {
  const p = Number(nodePort);
  if (!Number.isInteger(p) || p <= 0 || p + 4000 > 65535) throw new Error(`guardian: no ports can follow node port ${nodePort}`);
  return { api: p + 1000, p2p: p + 2000, ui: p + 3000, metrics: p + 4000 };
}

// THE GUARDIAN-NEXT (§23A.6 step 1): a node whose guardian runs in consensus and is seated first in its federation's
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

/**
 * THE DASHBOARD'S PORT, FREE (kanban #326, measured 2026-10-24 17:49Z on the test host: T2's guardians exited at start - fedimintd
 * "Failed to bind dashboard UI: Address already in use" - because two other programs' headless Chromes held 9341 and 9351 as their
 * debugging ports): the slot's UI port when nothing listens on it, else the first free one `step` apart, at most `tries` tried. Only the
 * dashboard moves: the API, P2P and metrics ports stay where the seat, the tunnels and the federation's config expect them.
 */
export async function freeLocalPort(port, { step = 50, tries = 20, host = '127.0.0.1' } = {}) {
  const free = (p) => new Promise((ok) => { const s = createServer(); s.once('error', () => ok(false)); s.listen(p, host, () => s.close(() => ok(true))); });
  for (let i = 0; i < tries; i++) { const p = port + i * step; if (p <= 65535 && await free(p)) return p; }
  return port;
}

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
// THE P2P URL (kanban #562): with `p2pUrlPort` - p2p-tunnel.js p2pTunnelPort of the node key - the port every node carries to
// this node through its seat; without, the local bind port as before (a guardian whose federation is founded keeps the URL
// its config holds: Fedimint reads FM_P2P_URL at the ceremony only)
// THE PEERS' API THROUGH THE SEAT (kanban #577, p2p-tunnel.js GUARDIAN_API_RELAY_PATH): with `apiOverrides` (guardianApiOverrides
// over the federation's own client config), FM_WS_API_CONNECT_OVERRIDES - a guardian that fell behind reaches its peers' API at
// their current addresses, not at the ones the config wrote at the ceremony
export function guardianEnv({ nodePort, dataDir, network, chain = network, bitcoindUrl, cookieSecret, password, endpoint, ports = guardianPorts(nodePort),
  p2pUrlPort = null, apiOverrides = '' }) {
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
    FM_P2P_URL: `fedimint://127.0.0.1:${p2pUrlPort || ports.p2p}`,
    FM_API_URL: endpoint,
    FM_ENABLE_IROH: 'false',
    FM_PASSWORD_API: password,
    FM_PASSWORD_UI: password,
    FM_DISABLE_BASE_FEES: '1',
  };
  if (chain === 'testnet4') { env.FM_ENABLE_MODULE_WALLETV2 = 'false'; env.FM_ENABLE_MODULE_WALLET = 'true'; }
  if (apiOverrides) env.FM_WS_API_CONNECT_OVERRIDES = apiOverrides;
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
  stop: (unit) => new Promise((ok) => execFile('systemctl', ['--user', 'stop', `${unit}.service`], { timeout: 30000 }, () => ok())),
};

/**
 * A GUARDIAN WAITING IN SETUP OUTLIVES ITS NODE, ON EVERY SYSTEM (kanban #495, measured 2026-10-21 22:2xZ on founding 53be35a3): fedimintd
 * keeps a setup's local params - its TLS key among them - in memory only, so a node restarted after posting its code started a guardian
 * with new params while its peers held the old code, and the DKG failed on every link ("invalid peer certificate: BadSignature"). The
 * n495 nodes and the installers run on macOS and Windows, where systemd keeps nothing: fedimintd runs detached, its pid in
 * <data>/fedimintd.pid, and a node that starts while it runs adopts it. Keyed by the data dir.
 */
export function pidfileUnits({ platform = process.platform, spawnFn = spawn, run = execFile } = {}) {
  const file = (dataDir) => join(dataDir, 'fedimintd.pid');
  const pidOf = (dataDir) => { try { const p = Number(readFileSync(file(dataDir), 'utf8').trim()); return Number.isInteger(p) && p > 0 ? p : null; } catch { return null; } };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  // a pid the system gave again to another program after a reboot is no guardian: its command must name fedimintd (not asked on Windows)
  const isFedimintd = (pid) => (platform === 'win32' ? Promise.resolve(true)
    : new Promise((ok) => run('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 10000 }, (e, out) => ok(!e && /fedimintd/.test(String(out))))));
  return {
    pid: pidOf,
    active: async (dataDir) => { const p = pidOf(dataDir); return !!p && alive(p) && await isFedimintd(p); },
    start: async (dataDir, bin, envVars, logPath) => {
      const out = openSync(logPath, 'a');
      const child = spawnFn(bin, [], { env: envVars, stdio: ['ignore', out, out], detached: true });
      child.unref();
      writeFileSync(file(dataDir), String(child.pid));
      return child.pid;
    },
    stop: async (dataDir) => {
      const p = pidOf(dataDir);
      if (p && alive(p)) {
        try { process.kill(p, 'SIGTERM'); } catch { /* gone */ }
        for (let i = 0; i < 100 && alive(p); i++) await new Promise((r) => setTimeout(r, 100));
        if (alive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
      }
      try { unlinkSync(file(dataDir)); } catch { /* none */ }
    },
  };
}

// `slot`: 'guardian' (the node's own) or 'next' (the guardian-next) - its data dir, ports, public path and unit.
// fedimintd on a data dir without a finished ceremony waits in setup mode (a founding drives it, founding-seat.js); with one, it
// runs the federation.
export async function startGuardian({ nodePort, host, storePath, bitcoindUrl, cookiePath, call, env = process.env,
  tailscale = undefined, log = (s) => console.log(s), chainTries = 12, chainWaitMs = 5000, units = systemdUnits, slot = 'guardian', nodeKey = null,
  keep = false, pids = pidfileUnits() }) {
  const S = GUARDIAN_SLOTS[slot];
  if (!S) throw new Error(`guardian: no slot ${slot}`);
  const tag = `[${S.unit}]`;
  log = ((say) => (line) => say(String(line).replace(/^\[guardian\]/, tag)))(log);
  const not = (why) => { log(`[guardian] not a guardian: ${why}`); return { running: false, why, stop: async () => {} }; };
  if (!bitcoindUrl || !cookiePath) return not('this node reads no chain (ARENA_BITCOIND_URL / ARENA_BITCOIND_COOKIE)');
  // ARENA_FEDIMINTD: the release's own custody binary (written by the installer), else PATH
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
  const ports = { ...slotPorts(slot, nodePort) };
  { const ui = await freeLocalPort(ports.ui); if (ui !== ports.ui) { log(`[guardian] dashboard port ${ports.ui} is taken: the dashboard listens on ${ui}`); ports.ui = ui; } }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const pwFile = join(dataDir, 'admin-password');
  if (!existsSync(pwFile)) writeFileSync(pwFile, randomBytes(24).toString('hex'), { mode: 0o600 });
  const ts = tailscale === undefined ? await readTailscale() : tailscale;
  // A NODE PUBLISHED THROUGH ANOTHER MACHINE'S FUNNEL (the second testnet4 federation on the test host: its nodes
  // are reached at wss://<test host>/fed2-N, a Funnel path the test host forwards over the tailnet): ARENA_GUARDIAN_ENDPOINT_<port>
  // names the guardian's public endpoint when this machine's own Tailscale cannot derive it
  // the guardian-next: ARENA_GUARDIAN_NEXT_ENDPOINT_<port>, else the first one's named endpoint with /guardian-next for /guardian
  const named = env[`ARENA_GUARDIAN_ENDPOINT_${nodePort}`];
  const endpoint = slot === 'next'
    ? env[`ARENA_GUARDIAN_NEXT_ENDPOINT_${nodePort}`] || (named ? named.replace(/\/guardian\/?$/, '') + S.path : guardianEndpoint(nodePort, { host, tailscale: ts, path: S.path }))
    : named || guardianEndpoint(nodePort, { host, tailscale: ts });
  // FEDIMINT ON A RAM DISK (kanban #596, ARENA_FEDIMINT_RAM=1 - the installer's choice from more than 5 nodes): the database moved into
  // RAM (or back from its newest snapshot) before fedimintd starts, never while it runs; a snapshot every minute at this node's own second
  const ramOn = env.ARENA_FEDIMINT_RAM === '1' && storePath !== ':memory:';
  const ram = ramDirOf({ instance: String(nodePort), slot });
  const ramReady = () => {
    if (!ramOn) return true;
    if (!ramSupported()) { log('[guardian] ARENA_FEDIMINT_RAM=1, but this machine has no RAM disk the guardian can use (Linux /dev/shm): it runs on disk'); return true; }
    const r = ramRestore(dataDir, ram, { log });
    if (!r.ok) log(`[guardian] not started: ${r.why}`);
    return r.ok;
  };
  const ramFollow = (pidOf) => (ramOn && ramSupported()
    ? ramLoop({ dataDir, ram, pidOf, offsetMs: (Math.floor(nodePort / 10) % 12) * 5000 + (slot === 'next' ? 2500 : 0), log }) : null);
  const cookieSha = cookieFingerprint(cookiePath);
  // its federation's peers, once there is one: their API addresses as the config names them, carried through this seat
  let apiOverrides = '';
  try {
    const cfg = JSON.parse(readFileSync(join(dataDir, 'client.json'), 'utf8'));
    const apiEndpoints = (cfg.global || cfg).api_endpoints;
    if (apiEndpoints) apiOverrides = guardianApiOverrides({ apiEndpoints, ownName: nodeKey ? (typeof nodeKey === 'string' ? nodeKey : Buffer.from(nodeKey).toString('hex')).toLowerCase().slice(0, 16) : null,
      seatRoot: `ws://${!host || host === '0.0.0.0' ? '127.0.0.1' : host}:${nodePort}`, ownApiPort: ports.api, existing: env.FM_WS_API_CONNECT_OVERRIDES || '' });
  } catch { apiOverrides = ''; }
  // AND THE OVERRIDES IN THE FINGERPRINT (kanban #577): a running guardian is adopted, not restarted, so one started before its seat
  // carried its peers' API (or with other peers) is started again once - the same rule as a changed bitcoind cookie
  // ONLY IN THE KEPT FILE: the running guardian's `cookieSha` stays the cookie's own, which node-start.js compares every 30 s with the cookie
  // (2026-10-26 07:4xZ, after 2026.1.9.5: the two never matched, and every guardian of a federation was started again every 30 s)
  const keptSha = cookieSha && apiOverrides ? createHash('sha256').update(`${cookieSha}\n${apiOverrides}`).digest('hex') : cookieSha;
  const fmEnv = guardianEnv({ nodePort, dataDir, network, chain, bitcoindUrl, endpoint, ports, p2pUrlPort: nodeKey ? p2pTunnelPort(nodeKey, slot) : null, apiOverrides,
    cookieSecret: readFileSync(cookiePath, 'utf8').trim().split(':').slice(1).join(':'),
    password: readFileSync(pwFile, 'utf8').trim() });
  // A GUARDIAN THAT OUTLIVES ITS NODE (2026-10-03, after the restart that held deposits: "2. Separate guardian and
  // node"). With ARENA_GUARDIAN_KEEP=1 the node still starts its own guardian, with nothing typed, but as a systemd user
  // unit of its own; a node that starts while that unit runs adopts it, and closing the node leaves it running - so a
  // node restart (a code update) is no guardian restart. Measured before: each guardian restarted mid-session replayed
  // the session (4733, 10164, 11546 units) and a deposit waited 168.8 s for the federation's order.
  if (env.ARENA_GUARDIAN_KEEP === '1' && storePath !== ':memory:') {
    const unit = guardianUnit(nodePort, slot);
    if (await units.active(unit)) {
      const had = keptFingerprint(dataDir);
      if (!had || !keptSha || had === keptSha) {
        log(`[guardian] ${unit} already runs: adopted, not restarted; endpoint ${endpoint}, api 127.0.0.1:${ports.api}`);
        return { running: true, kept: true, adopted: true, unit, endpoint, network, chain, dataDir, apiPort: ports.api, p2pPort: ports.p2p, slot, cookieSha, stop: async () => {}, halt: () => units.stop(unit), alive: () => units.active(unit) };
      }
      log(`[guardian] ${unit} runs with an old bitcoind cookie or old peer addresses: started again`);
      await units.stop(unit);
    }
    if (!ramReady()) return not('its database is neither in RAM nor in a snapshot');
    await units.start(unit, bin, { ...fmEnv, PATH: env.PATH || '' }, join(dataDir, 'fedimintd.log'));
    keepFingerprint(dataDir, keptSha);
    log(`[guardian] fedimintd started as ${unit} on chain ${chain} (Fedimint label ${network}), endpoint ${endpoint}, api 127.0.0.1:${ports.api}; it outlives this node`);
    return { running: true, kept: true, adopted: false, unit, endpoint, network, chain, dataDir, apiPort: ports.api, p2pPort: ports.p2p, slot, cookieSha, stop: async () => {}, halt: () => units.stop(unit), alive: () => units.active(unit) };
  }
  // A GUARDIAN THAT OUTLIVES ITS NODE WITHOUT SYSTEMD (pidfileUnits): adopted whenever it still runs - a setup kept across a restart that
  // has since finished its DKG runs the federation on these ports, and a second fedimintd would not start - and started kept when the
  // node asks (`keep`: it waits in setup). Closing the node leaves it running; `halt` stops it (a fresh setup, the owner page's stop).
  if (storePath !== ':memory:') {
    const kept = (adopted, pid, sha) => { const follow = ramFollow(() => pids.pid(dataDir));
      return { running: true, kept: true, adopted, pid, endpoint, network, chain, dataDir, apiPort: ports.api, p2pPort: ports.p2p, slot,
        cookieSha: sha, ram: !!follow, stop: async () => { if (follow) follow.stop(); },
        // halt ends its RAM follow loop too (kanban #1779): it was left running, and every restart from the owner page added a second snapshot loop
        halt: async () => { if (follow) follow.stop(); return pids.stop(dataDir); }, alive: () => pids.active(dataDir) }; };
    if (await pids.active(dataDir)) {
      const had = keptFingerprint(dataDir);
      // a guardian adopted only while it reads bitcoind with the cookie bitcoind has now (one started before the fingerprint was kept: as before)
      if (!had || !keptSha || had === keptSha) {
        log(`[guardian] fedimintd ${pids.pid(dataDir)} already runs on ${dataDir}: adopted, not restarted; endpoint ${endpoint}, api 127.0.0.1:${ports.api}`);
        return kept(true, pids.pid(dataDir), cookieSha);
      }
      log(`[guardian] fedimintd ${pids.pid(dataDir)} on ${dataDir} runs with an old bitcoind cookie or old peer addresses: started again`);
      await pids.stop(dataDir);
      if (!keep) {
        if (!ramReady()) return not('its database is neither in RAM nor in a snapshot');
        const pid = await pids.start(dataDir, bin, { ...env, ...fmEnv }, join(dataDir, 'fedimintd.log'));
        keepFingerprint(dataDir, keptSha);
        log(`[guardian] fedimintd ${pid} on chain ${chain} (Fedimint label ${network}), endpoint ${endpoint}, api 127.0.0.1:${ports.api}; kept: it outlives this node`);
        return kept(false, pid, cookieSha);
      }
    }
    if (keep) {
      if (!ramReady()) return not('its database is neither in RAM nor in a snapshot');
      const pid = await pids.start(dataDir, bin, { ...env, ...fmEnv }, join(dataDir, 'fedimintd.log'));
      keepFingerprint(dataDir, keptSha);
      log(`[guardian] fedimintd ${pid} on chain ${chain} (Fedimint label ${network}), endpoint ${endpoint}, api 127.0.0.1:${ports.api}; kept: it outlives this node`);
      return kept(false, pid, cookieSha);
    }
  }
  if (!ramReady()) return not('its database is neither in RAM nor in a snapshot');
  const out = openSync(join(dataDir, 'fedimintd.log'), 'a');
  const child = spawn(bin, [], { env: { ...env, ...fmEnv }, stdio: ['ignore', out, out] });
  const follow = ramFollow(() => (exited ? null : child.pid));
  keepFingerprint(dataDir, keptSha);
  let exited = false;
  child.on('exit', (code, sig) => { exited = true; log(`[guardian] fedimintd exited (${sig || code})`); });
  log(`[guardian] fedimintd ${child.pid} on chain ${chain} (Fedimint label ${network}), endpoint ${endpoint}, api 127.0.0.1:${ports.api}`);
  const stop = () => new Promise((r) => {
    if (follow) follow.stop();
    if (exited) return r();
    child.once('exit', () => r());
    child.kill('SIGTERM');
    setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 10000).unref();
  });
  // `alive`: whether its process still runs (node-start.js starts an exited one again)
  return { running: true, endpoint, network, chain, dataDir, apiPort: ports.api, p2pPort: ports.p2p, pid: child.pid, slot, cookieSha, stop, halt: stop, alive: () => !exited };
}
