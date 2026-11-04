// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S SERVICES, ONE VIEW (2026-10-19: "Make a command arenanode that can stop start the service, status and
// diagnosis commands to detect problems", "arenanode must also control all of its subservices ie gateway lnd Guardian etc", "Also have
// a service overview in the owners area with the status of all services"). The bitcoinarena command (arenanode until kanban #688) and the seat's /owner/services read
// the same answers from here:
//
//   installedServices   the services this node has - found as the files the installer wrote (systemd user units on Linux, launchd
//                       agents on macOS, arena-<id>.cmd launchers on Windows), named for this node's instance (instance.js)
//   overview            each one's state (running, pid) and a probe of what it serves (the seat's /identity, the public address,
//                       LND's getinfo, the gateway's /v1/info, the guardian's API port, Tor's SOCKS port, the chain's RPC)
//   control             start / stop / restart, all in order (the chain first, the seat and its tunnel last) or one
//   doctor              every check, each with the command that fixes it
//
// The guardian (fedimintd) is no service of its own on an installed node: the seat starts it (guardian.js) and it ends with the seat.
// It is shown on its own line; starting or restarting it is starting or restarting the node.
import { existsSync, readFileSync, writeFileSync, statfsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { unitName, unitDir, LAUNCHD_LABEL } from './service.js';
import { lndRest } from './lnd.js';
import { testGateway } from './gateway.js';
import { quickTunnelUrl } from './reach.js';
import { parseConf, unknownKeys } from '../../arena-node/src/arena-conf.js';
import { bondCounts } from './bond.js';
import { QUIET } from '../../arena-node/src/log-level.js';
import { guardianAnswers, lastErrorLine } from '../../arena-node/src/guardian-probe.js';

/** Every service an installed node can have, in start order. */
export const SERVICES = Object.freeze([
  { id: 'bitcoind-testnet4', title: 'Bitcoin Core (testnet4)' },
  { id: 'bitcoind-mainnet', title: 'Bitcoin Core (mainnet)' },
  { id: 'chain-bridge', title: 'Chain bridge (Electrum)' },
  { id: 'tor', title: 'Tor' },
  { id: 'lnd', title: 'Lightning (LND)' },
  { id: 'gateway', title: 'Lightning gateway' },
  { id: 'custody', title: 'Custody agent' },
  { id: 'liquidity', title: 'Liquidity provider' },
  { id: 'workers', title: 'workers.dev keeper' },
  { id: 'updater', title: 'Auto update' },
  { id: 'node', title: 'Bitcoin Arena node (seat)' },
  { id: 'guardian', title: 'Guardian (fedimintd)', inside: 'node' },
  { id: 'tunnel', title: 'Tunnel (cloudflared)' },
]);
/** Other words for a service: `bitcoinarena restart bitcoind`, `... seat`, `... fedimintd`. */
export const ALIASES = Object.freeze({ bitcoind: 'bitcoind-testnet4', bitcoin: 'bitcoind-testnet4', core: 'bitcoind-testnet4', seat: 'node', fedimintd: 'guardian',
  federation: 'guardian', cloudflared: 'tunnel', bridge: 'chain-bridge', electrum: 'chain-bridge', lightning: 'lnd', gatewayd: 'gateway' });
export const serviceId = (word) => { const w = String(word || '').toLowerCase(); return SERVICES.some((s) => s.id === w) ? w : ALIASES[w] || null; };

const run = (cmd, args, { timeout = 60000 } = {}) => new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  (e, out, err) => resolve({ ok: !e, code: e ? e.code : 0, out: String(out || ''), err: String(err || '') })));

/** This node's settings: { file, values, errors } (values {} when there is no arena.conf), its state.json, its release. */
// THE RELEASE THIS CODE IS PART OF (<release>/packages/arena-installer/src): the bitcoinarena command, the seat and the wizard all load it from
// the node's own release. A node installed fresh had no release in state.json - only an update wrote one - so `bitcoinarena status` said
// "version unknown" and the auto update refused ("this node does not know the release it runs"): measured on the test host 2026-10-19,
// 2026.1.0 installed fresh through the wizard. A checkout (no VERSION file) is no release.
const OWN_RELEASE = (() => { const r = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'); return existsSync(join(r, 'VERSION')) ? r : null; })();

export function nodeOf(home, { ownRelease = OWN_RELEASE } = {}) {
  const file = join(home, 'arena.conf');
  let values = {}, errors = [], present = existsSync(file);
  if (present) ({ values, errors } = parseConf(readFileSync(file, 'utf8')));
  let state = {}; try { state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')); } catch { state = {}; }
  const port = Number(values.port || (state.reach && state.reach.port) || (state.service && state.service.port) || 0) || null;
  const publicUrl = values.public_url || (state.reach && state.reach.url) || null;
  const release = (state.release && state.release.path) || ownRelease || null;
  let version = null; try { version = release ? readFileSync(join(release, 'VERSION'), 'utf8').trim() : null; } catch { version = null; }
  return { home, conf: { file, present, values, errors }, state, port, publicUrl, release, version, legacyEnv: !present && existsSync(join(home, 'node.env')) };
}

/** The service's name to its system: the unit, the launchd label, the launcher file. */
export function serviceName(id, platform = process.platform) {
  if (platform === 'darwin') return id === 'node' ? LAUNCHD_LABEL : `${LAUNCHD_LABEL}.${id}`;
  if (platform === 'win32') return `arena-${id}.cmd`;
  return unitName(id);
}
/** The file that defines it. */
export function serviceFile(id, { home, platform = process.platform, env = process.env }) {
  if (platform === 'darwin') return join(env.HOME || homedir(), 'Library', 'LaunchAgents', `${serviceName(id, platform)}.plist`);
  if (platform === 'win32') return join(home, serviceName(id, platform));
  return join(unitDir(env), serviceName(id, platform));
}

/** The services this node has, in start order: [{ id, title, name, file, inside? }]. */
export function installedServices({ home, platform = process.platform, env = process.env, node = nodeOf(home) }) {
  const out = [];
  for (const s of SERVICES) {
    if (s.inside) {
      // the guardian: a custody node's seat starts one (arena.conf fedimintd, or the older node.env's ARENA_FEDIMINTD)
      const custody = node.conf.values.fedimintd || (node.legacyEnv && /^ARENA_FEDIMINTD=/m.test(readFileSync(join(home, 'node.env'), 'utf8')));
      if (custody && out.some((o) => o.id === s.inside)) out.push({ ...s, name: null, file: null });
      continue;
    }
    const file = serviceFile(s.id, { home, platform, env });
    if (existsSync(file)) out.push({ ...s, name: serviceName(s.id, platform), file });
  }
  return out;
}

/** The processes of a Windows machine, once per call: [{ pid, ppid, name, cmd }]. */
async function windowsProcesses(sh) {
  const r = await sh('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress']);
  try { return [].concat(JSON.parse(r.out)).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: String(p.Name || ''), cmd: String(p.CommandLine || '') })); } catch { return []; }
}
/** The processes of a Linux or macOS machine: [{ pid, ppid, name }]. */
async function unixProcesses(sh) {
  const r = await sh('ps', ['-e', '-o', 'pid=,ppid=,comm=']);
  return r.out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3].trim() }));
}

const uidOf = () => (typeof process.getuid === 'function' ? process.getuid() : 501);

/** One service's state: { running, pid, detail }. `procs` the machine's processes (Windows, the guardian). */
async function stateOf(svc, { platform, sh, procs, nodePid, nodeRunning, home = null }) {
  if (svc.inside) {
    const g = procs.find((p) => /fedimintd(\.exe)?$/i.test(p.name) && nodePid && p.ppid === nodePid);
    if (g) return { running: true, pid: g.pid, detail: 'runs inside the node' };
    // A GUARDIAN KEPT BEYOND THE SEAT (2026-10-26, the owner's services card on 2026.1.9.9: "Guardian (fedimintd) - the node runs without it"
    // while it waited in setup): one waiting for a founding is started apart so a restart or an update does not end it (guardian.js keep) -
    // its parent is not the seat, its pid is in node.db.guardian/fedimintd.pid
    let kept = null;
    try { kept = Number(readFileSync(join(home, 'node.db.guardian', 'fedimintd.pid'), 'utf8').trim()) || null; } catch { kept = null; }
    const k = kept && procs.find((p) => p.pid === kept && /fedimintd(\.exe)?$/i.test(p.name));
    if (k) return { running: true, pid: k.pid, detail: 'runs beside the node, kept through its restarts' };
    // the node's own process not visible to this user (the Windows window, v0.1.1 in the VM): neither is its guardian - its API decides
    if (nodeRunning === null) return { running: null, pid: null, detail: 'its process is not visible to this user' };
    // WHY IT IS NOT RUNNING (the 2026.1.9.11 install test: its fedimintd ended at start, "Address already in use", and only its log said so)
    const last = nodePid ? lastErrorLine(join(home, 'node.db.guardian', 'fedimintd.log')) : null;
    return { running: false, pid: null, detail: nodePid ? `the node runs without it${last ? `; its log: ${last}` : ''}` : 'the node is not running' };
  }
  if (platform === 'linux') {
    const r = await sh('systemctl', ['--user', 'show', svc.name, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'NRestarts']);
    const v = Object.fromEntries(r.out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const pid = Number(v.MainPID) || null;
    return { running: v.ActiveState === 'active', pid, detail: `${v.ActiveState || 'unknown'} (${v.SubState || '?'})${Number(v.NRestarts) ? `, restarted ${v.NRestarts}x` : ''}` };
  }
  if (platform === 'darwin') {
    const r = await sh('launchctl', ['print', `gui/${uidOf()}/${svc.name}`]);
    if (!r.ok) return { running: false, pid: null, detail: 'not loaded' };
    const state = (/^\s*state = (.+)$/m.exec(r.out) || [])[1] || 'unknown';
    const pid = Number((/^\s*pid = (\d+)$/m.exec(r.out) || [])[1]) || null;
    const exit = (/^\s*last exit code = (.+)$/m.exec(r.out) || [])[1];
    return { running: state === 'running', pid, detail: `${state}${state !== 'running' && exit ? `, last exit ${exit}` : ''}` };
  }
  // WINDOWS: the launcher's cmd.exe (its command line names the file) and the program it started
  const file = `\\${svc.name}`.toLowerCase();
  const launcher = procs.find((p) => /^cmd\.exe$/i.test(p.name) && p.cmd.toLowerCase().includes(file));
  const child = launcher && procs.find((p) => p.ppid === launcher.pid && !/^conhost\.exe$/i.test(p.name));
  if (child) return { running: true, pid: child.pid, detail: `${child.name}` };
  if (launcher) return { running: false, pid: null, detail: 'its launcher runs, the program does not' };
  // A PROCESS THIS USER CANNOT SEE INTO (measured in the Windows VM: the Arena Node window, in the desktop session, read no command line
  // of the services an ssh session had started, and called all of them stopped while they ran): unknown here - what it answers decides
  if (procs.some((p) => !p.cmd)) return { running: null, pid: null, detail: 'its process is not visible to this user' };
  return { running: false, pid: null, detail: 'not running' };
}

const portOpen = (port, host = '127.0.0.1', timeoutMs = 3000) => new Promise((resolve) => {
  const s = net.connect({ port, host });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(timeoutMs, () => done(false)); s.on('connect', () => done(true)); s.on('error', () => done(false));
});
const getIdentity = async (base, fetcher) => {
  const r = await fetcher(`${base.replace(/\/+$/, '')}/identity`, { signal: AbortSignal.timeout(10000) });
  const b = Buffer.from(await r.arrayBuffer());
  if (r.status !== 200 || b.length < 32) throw new Error(`/identity answered ${r.status}`);
  return b.toString('hex');
};
/** A bitcoind-style RPC call with a cookie file. */
export async function chainCall({ url, cookie, method, params = [], fetcher = fetch }) {
  const auth = Buffer.from(readFileSync(cookie, 'utf8').trim()).toString('base64');
  const r = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'bitcoinarena', method, params }), signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  if (r.status !== 200) throw new Error(`RPC answered ${r.status}`);
  return j.result;
}

/**
 * What each service serves, asked: { ok, says }, or null when there is nothing to ask beyond its process. `node` from nodeOf.
 * `local` the seat's identity when it answered (the tunnel's must be the same).
 */
export async function probeOf(svc, { node, fetcher, local, dnsRetries = 2, dnsPauseMs = 5000, log = QUIET, guardianCheck = guardianAnswers }) {
  // WHAT IS ASKED AND WHAT ANSWERED, WITH ITS TIME (kanban #693, 2026-10-26: "shows more info on what its doing, what is going wrong etc"):
  // at --verbose, each probe's target before it is asked and its answer after
  const t0 = performance.now();
  const said = await probeAsk(svc, { node, fetcher, local, dnsRetries, dnsPauseMs, log, guardianCheck });
  if (said) log.verbose(`${svc.id}: ${said.ok ? 'ok' : 'NOT ok'} - ${said.says} (${log.since(t0)})`);
  else log.debug(`${svc.id}: nothing to ask beyond its process`);
  return said;
}
async function probeAsk(svc, { node, fetcher, local, dnsRetries, dnsPauseMs, log, guardianCheck }) {
  const v = node.conf.values, s = node.state;
  try {
    if (svc.id === 'node') {
      if (!node.port) return { ok: false, says: 'no port in arena.conf' };
      log.verbose(`node: asking http://127.0.0.1:${node.port}/identity`);
      const id = await getIdentity(`http://127.0.0.1:${node.port}`, fetcher);
      return { ok: true, says: `answers on port ${node.port} as ${id.slice(0, 16)}…`, identity: id };
    }
    if (svc.id === 'tunnel' || svc.id === 'funnel') {
      if (!node.publicUrl) return { ok: false, says: 'no public_url in arena.conf' };
      // A QUICK TUNNEL'S NEW NAME TAKES A FEW SECONDS INTO DNS (measured on macOS node A, 10 s after an update restarted its tunnel:
      // ENOTFOUND, then answering): a name not found yet is asked again, twice, 5 s apart, before it counts
      let id = null;
      log.verbose(`tunnel: asking ${node.publicUrl.replace(/\/+$/, '')}/identity (it must answer with the seat's key${local ? ` ${local.slice(0, 16)}…` : ''})`);
      for (let i = 0; ; i++) {
        try { id = await getIdentity(node.publicUrl, fetcher); break; } catch (e) {
          const code = e.cause ? e.cause.code : e.code;
          if (code !== 'ENOTFOUND' || i >= dnsRetries) throw e;
          log.verbose(`tunnel: ${new URL(node.publicUrl).host} is not in DNS yet; asking again in ${Math.round(dnsPauseMs / 1000)} s (${i + 1} of ${dnsRetries})`);
          await new Promise((ok) => setTimeout(ok, dnsPauseMs));
        }
      }
      if (local && id !== local) return { ok: false, says: `${node.publicUrl} answers as another node (${id.slice(0, 16)}…)` };
      return { ok: true, says: `${node.publicUrl} reaches this node` };
    }
    if (svc.id === 'guardian') {
      const api = node.port + 1000;   // guardian.js guardianPorts: api = node port + 1000
      // THIS NODE'S GUARDIAN, NOT WHATEVER HOLDS ITS PORT (the 2026.1.9.11 install test: another node's guardian answered on the port this
      // node's fedimintd could not bind): asked with the node's own admin password, as the seat's services card asks (guardian-probe.js)
      log.verbose(`guardian: asking 127.0.0.1:${api} (the seat's port ${node.port} + 1000) with this node's admin password`);
      const a = await guardianCheck({ apiPort: api, dataDir: join(node.home, 'node.db.guardian') });
      return { ok: a.ok, says: a.says, ours: a.ours };
    }
    if (svc.id === 'lnd') {
      const l = s.lightning || {};
      if (!l.restUrl || !l.tlsCert || !l.macaroon) { log.debug('lnd: state.json lightning names no restUrl, tlsCert and macaroon: not asked'); return null; }
      log.verbose(`lnd: asking ${l.restUrl.replace(/\/+$/, '')}/v1/getinfo (its cert ${l.tlsCert}, macaroon file ${l.macaroon})`);
      const g = await lndRest({ restUrl: l.restUrl, tlsCertPem: readFileSync(l.tlsCert), macaroonHex: readFileSync(l.macaroon).toString('hex'), path: '/v1/getinfo', timeoutMs: 10000 });
      const j = g.json || g;
      if (g.status !== 200) return { ok: false, says: g.status ? `getinfo answered ${g.status}: ${JSON.stringify(j).slice(0, 120)}` : `LND does not answer (${j.error})` };
      return { ok: Boolean(j.synced_to_chain), says: `${j.synced_to_chain ? 'synced' : 'NOT synced'} at block ${j.block_height}, ${j.num_active_channels || 0} active channel(s), ${j.num_peers || 0} peer(s)` };
    }
    if (svc.id === 'gateway') {
      const g = s.gateway || {};
      if (!g.apiUrl || !g.passwordFile) { log.debug('gateway: state.json gateway names no apiUrl and passwordFile: not asked'); return null; }
      log.verbose(`gateway: asking ${g.apiUrl} (its password read from ${g.passwordFile})`);
      const t = await testGateway({ apiUrl: g.apiUrl, passwordFile: g.passwordFile, fetcher });
      if (!t.ok) return { ok: false, says: t.why };
      return { ok: true, says: `${t.state || 'running'}, Lightning ${t.syncedToChain ? 'synced' : 'NOT synced'}, ${t.federations.length} federation(s)`, federations: t.federations.length };
    }
    if (svc.id === 'tor') {
      const p = s.tor && s.tor.ports && s.tor.ports.socks;
      if (!p) { log.debug('tor: state.json tor names no SOCKS port: not asked'); return null; }
      log.verbose(`tor: is anything listening on its SOCKS port 127.0.0.1:${p}?`);
      return (await portOpen(p)) ? { ok: true, says: `SOCKS on port ${p}` } : { ok: false, says: `nothing listens on its SOCKS port ${p}` };
    }
    if (svc.id === 'chain-bridge' || svc.id === 'bitcoind-testnet4') {
      // BITCOIN CORE ASKED ON ITS OWN PORT ONLY (kanban #640, the owner's playtest 2026-10-25: "restarting the electrum server, marks also the
      // bitcoin server as available and running eventho its not installed or running"): on an Electrum node the seat's bitcoind_url is the
      // chain bridge, so asking it for Core made the bridge answer for Core
      const core = (s.core && s.core.networks && s.core.networks.testnet4) || null;
      const own = core ? { url: core.rpcUrl, cookie: core.cookiePath } : s.chain && s.chain.kind === 'core' ? { url: s.chain.url, cookie: s.chain.cookiePath } : null;
      if (svc.id === 'bitcoind-testnet4' && !own) return { ok: false, says: 'no Bitcoin Core is set up for this node' };
      const url = svc.id === 'chain-bridge' ? v.bitcoind_url : own.url;
      const cookie = svc.id === 'chain-bridge' ? v.bitcoind_cookie : own.cookie;
      if (!url || !cookie) { log.debug(`${svc.id}: no RPC address and cookie ${svc.id === 'chain-bridge' ? 'in arena.conf (bitcoind_url, bitcoind_cookie)' : 'in state.json'}: not asked`); return null; }
      log.verbose(`${svc.id}: asking ${url} getblockchaininfo (cookie file ${cookie})${svc.id === 'bitcoind-testnet4' && core ? ' - Bitcoin Core\'s own port, never the bridge (kanban #640)' : ''}`);
      const b = await chainCall({ url, cookie, method: 'getblockchaininfo', fetcher });
      const synced = b.blocks >= b.headers - 1 && b.headers > 0 && (!b.initialblockdownload || Number(b.verificationprogress) >= 0.9999);   // (kanban #636)
      return { ok: synced, says: `${b.chain} block ${b.blocks}${synced ? '' : ` of ${b.headers} (syncing)`}`, height: b.blocks };
    }
    if (svc.id === 'liquidity' && v.liquidity_provider_url) {
      const u = new URL(v.liquidity_provider_url);
      log.verbose(`liquidity: is anything listening on port ${u.port} (arena.conf liquidity_provider_url)?`);
      return (await portOpen(Number(u.port))) ? { ok: true, says: `answers on port ${u.port}` } : { ok: false, says: `nothing listens on port ${u.port}` };
    }
  } catch (e) { log.fail(`${svc.id}: the probe failed`, e); return { ok: false, says: e.cause ? e.cause.code || e.message : e.message }; }
  return null;
}

/**
 * THE OVERVIEW: { home, conf, version, instance, port, publicUrl, services: [{ id, title, name, running, pid, detail, probe }] }.
 * `probes` false: the states only (fast).
 */
export async function overview({ home, platform = process.platform, env = process.env, sh = run, fetcher = fetch, probes = true, dnsPauseMs = 5000, log: given = QUIET, guardianCheck = guardianAnswers }) {
  // EACH STEP SAID AT --verbose, THE DECISIONS AT --debug (kanban #693): which files were read, which services found where, each state and probe
  const log = given.tag('status');
  const node = nodeOf(home);
  log.verbose(`home ${home}: arena.conf ${node.conf.present ? `${Object.keys(node.conf.values).length} setting(s)${node.conf.errors.length ? `, ${node.conf.errors.length} line(s) that do not read` : ''}` : 'missing'}, state.json ${Object.keys(node.state).length ? 'read' : 'missing or empty'}, release ${node.release || '(none)'}${node.version ? ` (${node.version})` : ''}`);
  log.debug(`the seat's port ${node.port || '-'}, from ${node.conf.values.port ? 'arena.conf port' : node.state.reach && node.state.reach.port ? 'state.json reach.port' : node.state.service && node.state.service.port ? 'state.json service.port' : 'nowhere'}`);
  log.env(platform === 'darwin' ? ['HOME'] : platform === 'win32' ? [] : ['XDG_CONFIG_HOME', 'HOME', 'ARENA_INSTANCE'],
    `the service files are looked for in ${platform === 'linux' ? unitDir(env) : platform === 'darwin' ? join(env.HOME || homedir(), 'Library', 'LaunchAgents') : home}, decided by`, env);
  const svcs = installedServices({ home, platform, env, node });
  log.verbose(`${svcs.length} service(s) installed: ${svcs.map((x) => x.id).join(', ') || 'none'}`);
  log.debug(() => `not installed (no file): ${SERVICES.filter((s) => !s.inside && !svcs.some((x) => x.id === s.id)).map((s) => `${s.id} (${serviceFile(s.id, { home, platform, env })})`).join(', ') || 'none'}`);
  const procs = platform === 'win32' ? await windowsProcesses(sh) : svcs.some((x) => x.inside) ? await unixProcesses(sh) : [];
  // TAILSCALE FUNNEL, KEPT BY TAILSCALED (kanban #734, measured 2026-10-29: a node reached by Funnel showed its address under "Tunnel
  // (cloudflared)" - the quick tunnel left from before): no service of the node's own, so one row of its own, asked like a tunnel
  const funnel = node.state.reach && node.state.reach.mode === 'tailscale';
  const rows = [];
  let nodePid = null, nodeRunning = false;
  for (const svc of svcs) {
    const t0 = performance.now();
    const st = await stateOf(svc, { platform, sh, procs, nodePid, nodeRunning, home });
    log.verbose(`${svc.id}: ${svc.inside ? `inside the ${svc.inside}` : platform === 'linux' ? `systemd unit ${svc.name}` : platform === 'darwin' ? `launchd agent ${svc.name}` : `launcher ${svc.file}`} is ${st.running === null ? 'unknown' : st.running ? 'running' : 'stopped'}${st.pid ? `, pid ${st.pid}` : ''}: ${st.detail} (${log.since(t0)})`);
    if (svc.id === 'node') { nodePid = st.pid; nodeRunning = st.running; }
    rows.push({ id: svc.id, title: svc.title, name: svc.name, file: svc.file, inside: svc.inside || null, ...st });
  }
  if (funnel) rows.push({ id: 'funnel', title: 'Tailscale Funnel', name: null, file: null, inside: null, running: null, kept: 'tailscaled' });
  if (probes) {
    const local = { identity: null };
    for (const r of rows) {
      if (r.id === 'funnel') {
        r.probe = await probeOf(r, { node, fetcher, local: local.identity, dnsPauseMs, log, guardianCheck });
        r.running = r.probe ? r.probe.ok : null; r.detail = r.probe ? r.probe.says : null;
        continue;
      }
      if (r.running === null) {
        // not visible: running when it answers (a service with nothing to ask stays unknown)
        r.probe = await probeOf(r, { node, fetcher, local: local.identity, dnsPauseMs, log, guardianCheck });
        if (r.probe) r.running = r.probe.ok ? true : r.probe.ours === false ? false : null;
        if (r.probe && r.probe.ok) r.detail = 'answers (its process is not visible to this user)';
        else if (r.probe) r.detail = `its process is not visible to this user, and ${r.probe.says}`;
        if (r.id === 'node' && r.probe && r.probe.identity) local.identity = r.probe.identity;
        continue;
      }
      if (!r.running) { r.probe = null; log.verbose(`${r.id}: not asked (not running)`); continue; }
      r.probe = await probeOf(r, { node, fetcher, local: local.identity, dnsPauseMs, log, guardianCheck });
      if (r.id === 'node' && r.probe && r.probe.identity) local.identity = r.probe.identity;
      // a fedimintd process that is not the guardian answering on its port: not running, as the seat's card says
      if (r.id === 'guardian' && r.probe && !r.probe.ok) { r.running = false; r.detail = `not running: ${r.probe.says}`; }
    }
  }
  return { home, conf: node.conf.present ? node.conf.file : null, legacyEnv: node.legacyEnv, version: node.version, release: node.release,
    instance: node.conf.values.instance || null, port: node.port, publicUrl: node.publicUrl, roles: node.conf.values.roles || null, services: rows };
}

/** The services a word names, in order (none: all). The guardian is the node's. Answers { list, why }. */
export function servicesNamed(word, svcs) {
  if (!word) return { list: svcs.filter((s) => !s.inside) };
  const id = serviceId(word);
  if (!id) return { list: [], why: `no service "${word}": ${SERVICES.map((s) => s.id).join(', ')}` };
  const target = SERVICES.find((s) => s.id === id).inside || id;
  const list = svcs.filter((s) => s.id === target);
  return list.length ? { list, note: target !== id ? `the ${id} runs inside the ${target} service: that is what is acted on` : null }
    : { list: [], why: `this node has no ${id} service` };
}

const QUICK_HOST = /[a-z0-9-]+\.trycloudflare\.com/g;

/**
 * A QUICK TUNNEL COMES BACK UNDER A NEW NAME (update.js measured it): after the tunnel (re)starts, its new name goes into every file of
 * this node that names a quick-tunnel host - arena.conf (public_url, guardian_endpoint), state.json, the gateway's service (its
 * announced address; macOS node B still announced a name two restarts old) - and the services whose files changed are restarted.
 * Answers { url, changed: [files], restart: [ids] } or { url: null }.
 */
export async function followQuickTunnel({ home, svcs, platform, env, sh, sinceMs, quickUrl = quickTunnelUrl }) {
  const node = nodeOf(home);
  if (!(node.state.reach && node.state.reach.mode === 'quick')) return { url: null };
  const tunnel = svcs.find((s) => s.id === 'tunnel');
  const url = await quickUrl({ unit: tunnel ? tunnel.name : unitName('tunnel'), home, platform, sh, sinceMs });
  if (!url) return { url: null };
  const host = new URL(url).host;
  const changed = [], restart = [];
  const files = [node.conf.file, join(home, 'state.json'), ...svcs.filter((s) => s.file && !['tunnel'].includes(s.id)).map((s) => s.file)];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const t = readFileSync(f, 'utf8');
    const n = t.replace(QUICK_HOST, host);
    if (n === t) continue;
    writeFileSync(f, n, { mode: 0o600 });
    changed.push(f);
    const svc = svcs.find((s) => s.file === f);
    if (svc) restart.push(svc.id);
    if (f === node.conf.file && !restart.includes('node')) restart.push('node');
  }
  return { url, changed, restart };
}

/**
 * A QUICK TUNNEL THAT CAME BACK BY ITSELF (kanban #562 2A, 2026-10-21: a reboot or a crash restarts the tunnel under a new name, and
 * nothing but an update or the owner page followed it - arena.conf, the gateway and the census kept the old host): its newest name is
 * read from its log and followed as control() follows it, the services whose files changed restarted in start order. Asked by the
 * custody agent every minute. Answers { url, changed, restarted: [ids] }.
 */
export async function followTunnelNow({ home, platform = process.platform, env = process.env, sh = run, quickUrl = quickTunnelUrl } = {}) {
  const svcs = installedServices({ home, platform, env });
  const t = await followQuickTunnel({ home, svcs, platform, env, sh, sinceMs: null, quickUrl: (o) => quickUrl({ ...o, waitMs: 200 }) });
  const restarted = [];
  for (const id of (t.restart || []).sort((x, y) => svcs.findIndex((s) => s.id === x) - svcs.findIndex((s) => s.id === y))) {
    const s = svcs.find((x) => x.id === id);
    if (s && (await act('restart', s, { platform, sh, home })).ok) restarted.push(id);
  }
  return { url: t.url || null, changed: t.changed || [], restarted };
}

/**
 * A QUICK TUNNEL THAT DIED AND NEVER CAME BACK (kanban #1120, measured 2026-11-04 on an installer node, 2026.1.9.24): from 11-02 16:45Z
 * its tunnel.log said "Register tunnel error from server side error=\"Unauthorized: Tunnel not found\"" 7,924 times - cloudflared
 * kept asking for a tunnel Cloudflare had dropped and never asked for a new one, so the node was unreachable for 42 h while drawn into
 * live rounds (its seatings never stood). Dead: at least TUNNEL_DEAD_ERRORS such lines after the tunnel's last registered connection
 * (or its last request for a new name). Read from the log's tail only - the log grows without end.
 */
export const TUNNEL_DEAD_ERRORS = 3;
export function quickTunnelDead(text) {
  const lines = String(text).split('\n');
  let notFound = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/Registered tunnel connection|Requesting new quick Tunnel/.test(lines[i])) break;
    if (/Tunnel not found/.test(lines[i])) notFound++;
  }
  return notFound >= TUNNEL_DEAD_ERRORS;
}
const tailOf = (file, bytes = 262144) => {
  const fd = openSync(file, 'r');
  try { const size = fstatSync(fd).size, n = Math.min(size, bytes), buf = Buffer.alloc(n); readSync(fd, buf, 0, n, size - n); return buf.toString('utf8'); } finally { closeSync(fd); }
};
/**
 * The dead quick tunnel restarted (kanban #1120): cloudflared then asks for a new name, and followTunnelNow (the custody agent's next
 * pass) takes it into the node's files and restarts the node. Answers { dead: false } or { dead: true, restarted, why }.
 */
export async function reviveDeadTunnel({ home, platform = process.platform, env = process.env, sh = run, readTail = tailOf } = {}) {
  const node = nodeOf(home);
  if (!(node.state.reach && node.state.reach.mode === 'quick')) return { dead: false };
  const svcs = installedServices({ home, platform, env });
  const tunnel = svcs.find((s) => s.id === 'tunnel');
  // ON LINUX THE TUNNEL LOGS TO THE JOURNAL, NOT tunnel.log (measured 11-04 in the 2026.1.9.25 install test: no tunnel.log in either
  // test home, so the revive never fired there) - read as reach.js quickTunnelUrl reads its name
  let text = '';
  if (platform === 'linux') {
    const unit = tunnel && tunnel.name ? tunnel.name : `${unitName('tunnel')}`;
    try { text = (await sh('journalctl', ['--user', '-u', unit, '-o', 'cat', '--no-pager', '-n', '300'])).out || ''; } catch { return { dead: false }; }
  } else {
    try { text = readTail(join(home, 'tunnel.log')); } catch { return { dead: false }; }
  }
  if (!quickTunnelDead(text)) return { dead: false };
  if (!tunnel) return { dead: true, restarted: false, why: 'this node has no tunnel service' };
  const r = await act('restart', tunnel, { platform, sh, home });
  return { dead: true, restarted: !!r.ok, why: r.ok ? null : r.why || 'the restart failed' };
}

/**
 * START AT BOOT, one service at a time (kanban #563, 2026-10-21): Linux - its user unit enabled (`systemctl --user is-enabled`);
 * macOS - its launch agent's RunAtLoad; Windows - the Arena Node launcher starts the node's services together at login, so not one by
 * one. bootOf answers { atBoot: true | false | null, settable, why }; setBoot(word, on) changes it - without starting or stopping it now.
 */
export async function bootOf(svc, { platform = process.platform, sh = run } = {}) {
  if (!svc || !svc.file) return { atBoot: null, settable: false, why: 'runs inside the node: the node starts it' };
  if (platform === 'linux') {
    const r = await sh('systemctl', ['--user', 'is-enabled', svc.name]);
    return { atBoot: r.out.trim() === 'enabled', settable: true };
  }
  if (platform === 'darwin') {
    const r = await sh('/usr/libexec/PlistBuddy', ['-c', 'Print :RunAtLoad', svc.file]);
    return { atBoot: r.ok && r.out.trim() === 'true', settable: true };
  }
  return { atBoot: null, settable: false, why: 'on Windows the Bitcoin Arena launcher starts all of the node\'s services at login' };
}
export async function setBoot(word, on, { home, platform = process.platform, env = process.env, sh = run } = {}) {
  const svcs = installedServices({ home, platform, env });
  const { list, why } = servicesNamed(word, svcs);
  const svc = list.find((x) => x.file);
  if (!svc) return { ok: false, why: why || `${word} is not a service of its own` };
  if (platform === 'linux') {
    const r = await sh('systemctl', ['--user', on ? 'enable' : 'disable', svc.name]);
    return r.ok ? { ok: true, id: svc.id, atBoot: !!on } : { ok: false, why: (r.err || r.out).trim().slice(0, 200) };
  }
  if (platform === 'darwin') {
    let r = await sh('/usr/libexec/PlistBuddy', ['-c', `Set :RunAtLoad ${on ? 'true' : 'false'}`, svc.file]);
    if (!r.ok) r = await sh('/usr/libexec/PlistBuddy', ['-c', `Add :RunAtLoad bool ${on ? 'true' : 'false'}`, svc.file]);
    return r.ok ? { ok: true, id: svc.id, atBoot: !!on } : { ok: false, why: (r.err || r.out).trim().slice(0, 200) };
  }
  return { ok: false, why: 'on Windows the Bitcoin Arena launcher starts all of the node\'s services at login' };
}

/** One action on one service: { ok, why }. */
async function act(action, svc, { platform, sh, home }) {
  if (platform === 'linux') {
    if (action !== 'stop') await sh('systemctl', ['--user', 'daemon-reload']);
    const r = await sh('systemctl', ['--user', action, svc.name]);
    return r.ok ? { ok: true } : { ok: false, why: (r.err || r.out).trim().slice(0, 200) };
  }
  if (platform === 'darwin') {
    const dom = `gui/${uidOf()}`;
    const loaded = (await sh('launchctl', ['print', `${dom}/${svc.name}`])).ok;
    if (action === 'stop') { if (!loaded) return { ok: true }; const r = await sh('launchctl', ['bootout', `${dom}/${svc.name}`]); return r.ok ? { ok: true } : { ok: false, why: (r.err || r.out).trim().slice(0, 200) }; }
    // A RESTART RELOADS THE AGENT'S FILE: launchd keeps the definition it loaded, so `kickstart -k` would restart a gateway with the
    // address its plist named before the tunnel's new name went in - booted out, then bootstrapped from the file
    if (action === 'restart' && loaded) {
      const r = await sh('launchctl', ['bootout', `${dom}/${svc.name}`]);
      if (!r.ok) return { ok: false, why: (r.err || r.out).trim().slice(0, 200) };
    }
    if (!loaded || action === 'restart') {
      // launchd refuses a bootstrap while the agent it just booted out still unloads: tried 5 times, a second apart (update.js)
      let r = { ok: false };
      for (let i = 0; i < 5 && !r.ok; i++) { if (i) await new Promise((ok) => setTimeout(ok, 1000)); r = await sh('launchctl', ['bootstrap', dom, svc.file]); }
      return r.ok ? { ok: true } : { ok: false, why: (r.err || r.out).trim().slice(0, 200) };
    }
    const r = await sh('launchctl', ['kickstart', `${dom}/${svc.name}`]);
    return r.ok ? { ok: true } : { ok: false, why: (r.err || r.out).trim().slice(0, 200) };
  }
  // WINDOWS: stopped = the launcher's process tree ended; started = the launcher run through WMI (Win32_Process.Create), so it does
  // not belong to this console (update.js measured it: a process started over ssh ended with the session)
  const q = (t) => String(t).replace(/'/g, "''");
  if (action !== 'start') {
    const r = await sh('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$all = Get-CimInstance Win32_Process; $root = $all | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*\\${q(svc.name)}*' }; `
      + '$kill = New-Object System.Collections.Generic.List[int]; $todo = @($root | ForEach-Object { $_.ProcessId }); '
      + 'while ($todo.Count) { $p = $todo[0]; $todo = @($todo | Select-Object -Skip 1); $kill.Add($p); $todo += @($all | Where-Object { $_.ParentProcessId -eq $p } | ForEach-Object { $_.ProcessId }) }; '
      + '$kill | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; "ended $($kill.Count)"']);
    if (!r.ok) return { ok: false, why: (r.err || r.out).trim().slice(0, 200) };
    if (action === 'stop') return { ok: true };
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  const r = await sh('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${q(svc.file)}"'; CurrentDirectory = '${q(home)}' }; if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create: $($r.ReturnValue)" }`]);
  return r.ok ? { ok: true } : { ok: false, why: (r.err || r.out).trim().slice(0, 200) };
}

/**
 * START / STOP / RESTART `word` (a service, or all of them): in start order, stop in reverse. A restarted quick tunnel's new name is
 * followed (followQuickTunnel). Answers { ok, done: [{ id, action, ok, why }], note, tunnel }.
 */
export async function control(action, word, { home, platform = process.platform, env = process.env, sh: given = run, quickUrl = quickTunnelUrl, log: lg = QUIET } = {}) {
  if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, done: [], why: `no action "${action}"` };
  const log = lg.tag(action);
  const svcs = installedServices({ home, platform, env });
  if (!svcs.length) return { ok: false, done: [], why: `no service of a node at ${home} is installed` };
  const { list, why, note } = servicesNamed(word, svcs);
  if (!list.length) return { ok: false, done: [], why };
  log.verbose(`${word ? `"${word}" names` : 'all of them:'} ${list.map((s) => `${s.id} (${s.name})`).join(', ')}${list.length > 1 ? `; ${action === 'stop' ? 'stopped last first' : action === 'restart' ? 'stopped last first, then started in order' : 'started in order'}` : ''}`);
  // each system command said with its answer and time (the command lines themselves at --debug, log-level.js traceRuntime)
  const sh = !log.verboseOn ? given : async (cmd, args) => { const t0 = performance.now(); const r = await given(cmd, args);
    log.verbose(`${cmd} ${args.filter((x) => !/^(-NoProfile|-NonInteractive|-Command)$/.test(x)).join(' ').slice(0, 160)} -> ${r.ok ? 'ok' : `failed: ${String(r.err || r.out || '').trim().split(/\r?\n/).pop() || r.code}`} (${log.since(t0)})`); return r; };
  const done = [];
  const ordered = action === 'stop' ? [...list].reverse() : list;
  let tunnelAt = null;
  // ALL OF THEM RESTARTED: stopped in reverse and started in order (the seat after its chain, its tunnel after the seat)
  if (action === 'restart' && list.length > 1) {
    for (const s of [...list].reverse()) done.push({ id: s.id, action: 'stop', ...(await act('stop', s, { platform, sh, home })) });
    for (const s of list) { if (s.id === 'tunnel') tunnelAt = Date.now(); done.push({ id: s.id, action: 'start', ...(await act('start', s, { platform, sh, home })) }); }
  } else {
    for (const s of ordered) { if (s.id === 'tunnel' && action !== 'stop') tunnelAt = Date.now(); done.push({ id: s.id, action, ...(await act(action, s, { platform, sh, home })) }); }
  }
  let tunnel = null;
  if (tunnelAt) {
    log.verbose('the tunnel (re)started: reading its name from its log, to follow it into the node\'s files');
    tunnel = await followQuickTunnel({ home, svcs, platform, env, sh, sinceMs: tunnelAt - 2000, quickUrl });
    log.verbose(tunnel.url ? `the tunnel answers as ${tunnel.url}; ${tunnel.changed.length ? `changed ${tunnel.changed.join(', ')}; restarting ${tunnel.restart.join(', ')}` : 'no file named another name'}` : 'no quick tunnel name to follow');
    // in start order: the gateway before the seat
    for (const id of (tunnel.restart || []).sort((x, y) => svcs.findIndex((s) => s.id === x) - svcs.findIndex((s) => s.id === y))) {
      const s = svcs.find((x) => x.id === id);
      if (s) done.push({ id, action: 'restart', followed: true, ...(await act('restart', s, { platform, sh, home })) });
    }
  }
  return { ok: done.every((d) => d.ok), done, note, tunnel };
}

/** The last `lines` of a service's log: { file | unit, text }. */
export async function logsOf(word, { home, platform = process.platform, env = process.env, sh = run, lines = 60, log: lg = QUIET } = {}) {
  const log = lg.tag('logs');
  const id = serviceId(word || 'node');
  if (!id) return { ok: false, why: `no service "${word}"` };
  const tail = (file) => {
    log.verbose(`reading the last ${lines} lines of ${file}`);
    if (!existsSync(file)) return { ok: false, why: `${file} does not exist yet` };
    const fd = openSync(file, 'r'); const size = fstatSync(fd).size; const n = Math.min(size, 256 * 1024);
    const b = Buffer.alloc(n); readSync(fd, b, 0, n, size - n); closeSync(fd);
    return { ok: true, file, text: b.toString('utf8').split(/\r?\n/).slice(-lines - 1).join('\n') };
  };
  if (id === 'guardian') return tail(join(home, 'node.db.guardian', 'fedimintd.log'));
  // Tor writes its own log beside its torrc (kanban #670): on Linux its launcher sends its output there too, so the journal holds none of it
  if (id === 'tor' && existsSync(join(home, 'tor', 'tor.log'))) return tail(join(home, 'tor', 'tor.log'));
  if (platform === 'linux') {
    const unit = serviceName(id, platform);
    log.verbose(`reading the last ${lines} lines of the journal of the user unit ${unit}`);
    const r = await sh('journalctl', ['--user', '-u', unit, '-n', String(lines), '--no-pager', '-o', 'short-iso']);
    return { ok: r.ok, unit, text: r.out || r.err };
  }
  return tail(join(home, `${id}.log`));
}

/** The node's free disk, in bytes (null where the system does not say). */
const freeBytes = (dir) => { try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; } };

/**
 * THE DOCTOR: every check, { check, ok, says, fix } - ok true (fine), false (a problem), or null (a note). `latest` answers the newest
 * release ({ latest, newer }) or throws; `esplora` the chain explorer for the bond.
 */
export async function doctor({ home, platform = process.platform, env = process.env, sh = run, fetcher = fetch, latest = null,
  esplora = 'https://mempool.space/testnet4/api', name = 'bitcoinarena', log: lg = QUIET, guardianCheck = guardianAnswers } = {}) {
  const log = lg.tag('doctor');
  const out = [];
  const add = (check, ok, says, fix = null) => { out.push({ check, ok, says, fix }); log.verbose(`${check}: ${ok === true ? 'ok' : ok === false ? 'PROBLEM' : 'note'} - ${says}`); };
  const node = nodeOf(home);
  if (!existsSync(join(home, 'state.json'))) { add('node', false, `no node is installed at ${home}`, 'arena-install'); return out; }
  // the settings
  if (node.conf.present) {
    if (node.conf.errors.length) add('arena.conf', false, node.conf.errors.join('; '), `${name} config`);
    else {
      const other = unknownKeys(node.conf.values);
      add('arena.conf', true, `${Object.keys(node.conf.values).length} settings${other.length ? `; not known to this release: ${other.join(', ')}` : ''}`);
    }
  } else if (node.legacyEnv) add('arena.conf', false, 'this node still runs from node.env (an older release)', 'update the node (bitcoinarena-install --update): it moves the settings into arena.conf');
  else add('arena.conf', false, `${node.conf.file} is missing`, 'arena-install (the installer writes it)');
  const view = await overview({ home, platform, env, sh, fetcher, log: lg, guardianCheck });
  for (const s of view.services) {
    const fix = s.inside ? `${name} restart node` : `${name} restart ${s.id}`;
    if (s.running === null) { add(s.title, null, `${s.detail}${s.probe ? `; ${s.probe.says}` : ''}`); continue; }
    if (!s.running) { add(s.title, false, s.detail, `${name} start ${s.inside ? 'node' : s.id}   (then: ${name} logs ${s.id})`); continue; }
    if (s.probe === null || s.probe === undefined) add(s.title, true, `running${s.pid ? ` (pid ${s.pid})` : ''}`);
    else add(s.title, s.probe.ok, s.probe.says, s.probe.ok ? null : s.id === 'tunnel' ? `${name} restart tunnel` : `${fix}   (then: ${name} logs ${s.id})`);
  }
  // a quick tunnel's name: the one it runs under now is the one the node names (a restarted tunnel takes a new name)
  if (node.state.reach && node.state.reach.mode === 'quick' && view.services.some((s) => s.id === 'tunnel' && s.running)) {
    const tunnel = view.services.find((s) => s.id === 'tunnel');
    const now = await quickTunnelUrl({ unit: tunnel.name, home, platform, sh, waitMs: 2000 });
    if (now && node.publicUrl && new URL(now).host !== new URL(node.publicUrl).host) add('Quick tunnel name', false, `the tunnel runs as ${new URL(now).host}, the node names ${new URL(node.publicUrl).host}`, `${name} restart tunnel`);
    // every other file naming a quick-tunnel host names this one (the gateway's announced address)
    const host = node.publicUrl ? new URL(node.publicUrl).host : null;
    for (const s of view.services) {
      if (!s.file || s.id === 'tunnel' || !existsSync(s.file)) continue;
      const stale = [...new Set((readFileSync(s.file, 'utf8').match(QUICK_HOST) || []).filter((h) => h !== host))];
      if (stale.length) add(`${s.title} address`, false, `announces ${stale.join(', ')}, not the node's ${host}`, `${name} restart tunnel   (every file of the node follows the tunnel's name)`);
    }
  }
  // the disk
  const free = freeBytes(home);
  if (free !== null) add('Disk', free >= 2e9, `${(free / 1e9).toFixed(1)} GB free at ${home}`, free >= 2e9 ? null : 'free disk space: the node needs about 2 GB');
  // the bond
  const bond = node.state.bond;
  // SET UP IN THE OWNER AREA (kanban #728, the 2026.1.9.11 install test: the hint named the installer's bond step, gone once the setup is done)
  if (!bond || !bond.txid) add('Bond', null, 'no bond posted yet: the node is not seated until it has one', `the Bond section of the owner area (${name} open)`);
  else {
    try {
      log.verbose(`the bond: asking ${esplora}/tx/${bond.txid}/status`);
      const st = await (await fetcher(`${esplora}/tx/${bond.txid}/status`, { signal: AbortSignal.timeout(10000) })).json();
      // A BOND CONFIRMED TOO LATE NEVER COUNTS (bond.js BOND_SLACK_BLOCKS): its maturity is short of its confirmation plus the offset
      const late = st.confirmed && Number.isInteger(bond.maturity) ? bondCounts({ maturity: bond.maturity, confirmedAt: st.block_height }) : { counts: true };
      if (!late.counts) add('Bond', false, `${bond.txid.slice(0, 16)}… confirmed in block ${st.block_height}, too late: its maturity ${bond.maturity} is ${late.short} block(s) short of that plus the lock, so the census never counts it`,
        `post a new bond: arena-install (the bond step); this one is locked until block ${bond.maturity}`);
      else add('Bond', st.confirmed ? true : null, st.confirmed ? `${bond.txid.slice(0, 16)}… confirmed in block ${st.block_height}` : `${bond.txid.slice(0, 16)}… not confirmed yet`);
    } catch (e) { log.fail('the bond\'s explorer', e); add('Bond', null, `${bond.txid.slice(0, 16)}…: the explorer did not answer (${e.message})`); }
  }
  // the release
  if (latest && node.version) {
    try {
      log.verbose(`the release: reading the newest signed release (this node runs ${node.version})`);
      const l = await latest(node.version);
      const lv = l.latest && l.latest.version;
      if (!lv) add('Release', null, `${node.version}; ${l.why || 'the newest could not be read'}`);
      else add('Release', l.newer ? null : true, l.newer ? `${node.version} runs; ${lv} is out` : `${node.version} (the newest)`, l.newer ? `update the node: bitcoinarena-install --update <the ${lv} asset>` : null);
    } catch (e) { log.fail('the newest release', e); add('Release', null, `${node.version}; the newest could not be read (${e.message})`); }
  } else add('Release', null, node.version || 'unknown');
  return out;
}
