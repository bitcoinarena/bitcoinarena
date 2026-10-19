// THE NODE'S SERVICES, ONE VIEW (kanban #499, the owner 2026-10-19: "Make a command arenanode that can stop start the service, status and
// diagnosis commands to detect problems", "arenanode must also control all of its subservices ie gateway lnd Guardian etc", "Also have
// a service overview in the owners area with the status of all services"). The arenanode command and the seat's /owner/services read
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
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { unitName, unitDir, LAUNCHD_LABEL } from './service.js';
import { lndRest } from './lnd.js';
import { testGateway } from './gateway.js';
import { quickTunnelUrl } from './reach.js';
import { parseConf, unknownKeys } from '../../arena-node/src/arena-conf.js';

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
  { id: 'node', title: 'Arena node (seat)' },
  { id: 'guardian', title: 'Guardian (fedimintd)', inside: 'node' },
  { id: 'tunnel', title: 'Tunnel (cloudflared)' },
]);
/** Other words for a service: `arenanode restart bitcoind`, `... seat`, `... fedimintd`. */
export const ALIASES = Object.freeze({ bitcoind: 'bitcoind-testnet4', bitcoin: 'bitcoind-testnet4', core: 'bitcoind-testnet4', seat: 'node', fedimintd: 'guardian',
  federation: 'guardian', cloudflared: 'tunnel', bridge: 'chain-bridge', electrum: 'chain-bridge', lightning: 'lnd', gatewayd: 'gateway' });
export const serviceId = (word) => { const w = String(word || '').toLowerCase(); return SERVICES.some((s) => s.id === w) ? w : ALIASES[w] || null; };

const run = (cmd, args, { timeout = 60000 } = {}) => new Promise((resolve) => execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  (e, out, err) => resolve({ ok: !e, code: e ? e.code : 0, out: String(out || ''), err: String(err || '') })));

/** This node's settings: { file, values, errors } (values {} when there is no arena.conf), its state.json, its release. */
export function nodeOf(home) {
  const file = join(home, 'arena.conf');
  let values = {}, errors = [], present = existsSync(file);
  if (present) ({ values, errors } = parseConf(readFileSync(file, 'utf8')));
  let state = {}; try { state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')); } catch { state = {}; }
  const port = Number(values.port || (state.reach && state.reach.port) || (state.service && state.service.port) || 0) || null;
  const publicUrl = values.public_url || (state.reach && state.reach.url) || null;
  const release = (state.release && state.release.path) || null;
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
async function stateOf(svc, { platform, sh, procs, nodePid }) {
  if (svc.inside) {
    const g = procs.find((p) => /fedimintd(\.exe)?$/i.test(p.name) && nodePid && p.ppid === nodePid);
    return g ? { running: true, pid: g.pid, detail: 'runs inside the node' } : { running: false, pid: null, detail: nodePid ? 'the node runs without it' : 'the node is not running' };
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
  return child ? { running: true, pid: child.pid, detail: `${child.name}` } : { running: false, pid: null, detail: launcher ? 'its launcher runs, the program does not' : 'not running' };
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
    body: JSON.stringify({ jsonrpc: '1.0', id: 'arenanode', method, params }), signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  if (r.status !== 200) throw new Error(`RPC answered ${r.status}`);
  return j.result;
}

/**
 * What each service serves, asked: { ok, says }, or null when there is nothing to ask beyond its process. `node` from nodeOf.
 * `local` the seat's identity when it answered (the tunnel's must be the same).
 */
async function probeOf(svc, { node, fetcher, local }) {
  const v = node.conf.values, s = node.state;
  try {
    if (svc.id === 'node') {
      if (!node.port) return { ok: false, says: 'no port in arena.conf' };
      const id = await getIdentity(`http://127.0.0.1:${node.port}`, fetcher);
      return { ok: true, says: `answers on port ${node.port} as ${id.slice(0, 16)}…`, identity: id };
    }
    if (svc.id === 'tunnel') {
      if (!node.publicUrl) return { ok: false, says: 'no public_url in arena.conf' };
      const id = await getIdentity(node.publicUrl, fetcher);
      if (local && id !== local) return { ok: false, says: `${node.publicUrl} answers as another node (${id.slice(0, 16)}…)` };
      return { ok: true, says: `${node.publicUrl} reaches this node` };
    }
    if (svc.id === 'guardian') {
      const api = node.port + 1000;   // guardian.js guardianPorts: api = node port + 1000
      return (await portOpen(api)) ? { ok: true, says: `API on port ${api}` } : { ok: false, says: `nothing listens on its API port ${api}` };
    }
    if (svc.id === 'lnd') {
      const l = s.lightning || {};
      if (!l.restUrl || !l.tlsCert || !l.macaroon) return null;
      const g = await lndRest({ restUrl: l.restUrl, tlsCertPem: readFileSync(l.tlsCert), macaroonHex: readFileSync(l.macaroon).toString('hex'), path: '/v1/getinfo', timeoutMs: 10000 });
      const j = g.json || g;
      if (g.status !== 200) return { ok: false, says: g.status ? `getinfo answered ${g.status}: ${JSON.stringify(j).slice(0, 120)}` : `LND does not answer (${j.error})` };
      return { ok: Boolean(j.synced_to_chain), says: `${j.synced_to_chain ? 'synced' : 'NOT synced'} at block ${j.block_height}, ${j.num_active_channels || 0} active channel(s), ${j.num_peers || 0} peer(s)` };
    }
    if (svc.id === 'gateway') {
      const g = s.gateway || {};
      if (!g.apiUrl || !g.passwordFile) return null;
      const t = await testGateway({ apiUrl: g.apiUrl, passwordFile: g.passwordFile, fetcher });
      if (!t.ok) return { ok: false, says: t.why };
      return { ok: true, says: `${t.state || 'running'}, Lightning ${t.syncedToChain ? 'synced' : 'NOT synced'}, ${t.federations.length} federation(s)`, federations: t.federations.length };
    }
    if (svc.id === 'tor') {
      const p = s.tor && s.tor.ports && s.tor.ports.socks;
      if (!p) return null;
      return (await portOpen(p)) ? { ok: true, says: `SOCKS on port ${p}` } : { ok: false, says: `nothing listens on its SOCKS port ${p}` };
    }
    if (svc.id === 'chain-bridge' || svc.id === 'bitcoind-testnet4') {
      const url = svc.id === 'chain-bridge' || !s.core ? v.bitcoind_url : (s.chain && s.chain.url) || v.bitcoind_url;
      const cookie = svc.id === 'chain-bridge' || !s.core ? v.bitcoind_cookie : (s.chain && s.chain.cookiePath) || v.bitcoind_cookie;
      if (!url || !cookie) return null;
      const b = await chainCall({ url, cookie, method: 'getblockchaininfo', fetcher });
      const synced = !b.initialblockdownload && b.blocks >= b.headers - 1;
      return { ok: synced, says: `${b.chain} block ${b.blocks}${synced ? '' : ` of ${b.headers} (syncing)`}`, height: b.blocks };
    }
    if (svc.id === 'liquidity' && v.liquidity_provider_url) {
      const u = new URL(v.liquidity_provider_url);
      return (await portOpen(Number(u.port))) ? { ok: true, says: `answers on port ${u.port}` } : { ok: false, says: `nothing listens on port ${u.port}` };
    }
  } catch (e) { return { ok: false, says: e.cause ? e.cause.code || e.message : e.message }; }
  return null;
}

/**
 * THE OVERVIEW: { home, conf, version, instance, port, publicUrl, services: [{ id, title, name, running, pid, detail, probe }] }.
 * `probes` false: the states only (fast).
 */
export async function overview({ home, platform = process.platform, env = process.env, sh = run, fetcher = fetch, probes = true }) {
  const node = nodeOf(home);
  const svcs = installedServices({ home, platform, env, node });
  const procs = platform === 'win32' ? await windowsProcesses(sh) : svcs.some((x) => x.inside) ? await unixProcesses(sh) : [];
  const rows = [];
  let nodePid = null;
  for (const svc of svcs) {
    const st = await stateOf(svc, { platform, sh, procs, nodePid });
    if (svc.id === 'node') nodePid = st.pid;
    rows.push({ id: svc.id, title: svc.title, name: svc.name, file: svc.file, inside: svc.inside || null, ...st });
  }
  if (probes) {
    const local = { identity: null };
    for (const r of rows) {
      if (!r.running) { r.probe = null; continue; }
      r.probe = await probeOf(r, { node, fetcher, local: local.identity });
      if (r.id === 'node' && r.probe && r.probe.identity) local.identity = r.probe.identity;
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
export async function control(action, word, { home, platform = process.platform, env = process.env, sh = run, quickUrl = quickTunnelUrl } = {}) {
  if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, done: [], why: `no action "${action}"` };
  const svcs = installedServices({ home, platform, env });
  if (!svcs.length) return { ok: false, done: [], why: `no service of a node at ${home} is installed` };
  const { list, why, note } = servicesNamed(word, svcs);
  if (!list.length) return { ok: false, done: [], why };
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
    tunnel = await followQuickTunnel({ home, svcs, platform, env, sh, sinceMs: tunnelAt - 2000, quickUrl });
    // in start order: the gateway before the seat
    for (const id of (tunnel.restart || []).sort((x, y) => svcs.findIndex((s) => s.id === x) - svcs.findIndex((s) => s.id === y))) {
      const s = svcs.find((x) => x.id === id);
      if (s) done.push({ id, action: 'restart', followed: true, ...(await act('restart', s, { platform, sh, home })) });
    }
  }
  return { ok: done.every((d) => d.ok), done, note, tunnel };
}

/** The last `lines` of a service's log: { file | unit, text }. */
export async function logsOf(word, { home, platform = process.platform, env = process.env, sh = run, lines = 60 } = {}) {
  const id = serviceId(word || 'node');
  if (!id) return { ok: false, why: `no service "${word}"` };
  const tail = (file) => {
    if (!existsSync(file)) return { ok: false, why: `${file} does not exist yet` };
    const fd = openSync(file, 'r'); const size = fstatSync(fd).size; const n = Math.min(size, 256 * 1024);
    const b = Buffer.alloc(n); readSync(fd, b, 0, n, size - n); closeSync(fd);
    return { ok: true, file, text: b.toString('utf8').split(/\r?\n/).slice(-lines - 1).join('\n') };
  };
  if (id === 'guardian') return tail(join(home, 'node.db.guardian', 'fedimintd.log'));
  if (platform === 'linux') {
    const unit = serviceName(id, platform);
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
  esplora = 'https://mempool.space/testnet4/api', name = 'arenanode' } = {}) {
  const out = [];
  const add = (check, ok, says, fix = null) => out.push({ check, ok, says, fix });
  const node = nodeOf(home);
  if (!existsSync(join(home, 'state.json'))) { add('node', false, `no node is installed at ${home}`, 'arena-install'); return out; }
  // the settings
  if (node.conf.present) {
    if (node.conf.errors.length) add('arena.conf', false, node.conf.errors.join('; '), `${name} config`);
    else {
      const other = unknownKeys(node.conf.values);
      add('arena.conf', true, `${Object.keys(node.conf.values).length} settings${other.length ? `; not known to this release: ${other.join(', ')}` : ''}`);
    }
  } else if (node.legacyEnv) add('arena.conf', false, 'this node still runs from node.env (an older release)', 'update the node (arena-install --update): it moves the settings into arena.conf');
  else add('arena.conf', false, `${node.conf.file} is missing`, 'arena-install (the installer writes it)');
  const view = await overview({ home, platform, env, sh, fetcher });
  for (const s of view.services) {
    const fix = s.inside ? `${name} restart node` : `${name} restart ${s.id}`;
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
  if (!bond || !bond.txid) add('Bond', null, 'no bond posted yet: the node is not seated until it has one', 'arena-install (the installer\'s bond step)');
  else {
    try {
      const st = await (await fetcher(`${esplora}/tx/${bond.txid}/status`, { signal: AbortSignal.timeout(10000) })).json();
      add('Bond', st.confirmed ? true : null, st.confirmed ? `${bond.txid.slice(0, 16)}… confirmed in block ${st.block_height}` : `${bond.txid.slice(0, 16)}… not confirmed yet`);
    } catch (e) { add('Bond', null, `${bond.txid.slice(0, 16)}…: the explorer did not answer (${e.message})`); }
  }
  // the release
  if (latest && node.version) {
    try {
      const l = await latest(node.version);
      const lv = l.latest && l.latest.version;
      if (!lv) add('Release', null, `${node.version}; ${l.why || 'the newest could not be read'}`);
      else add('Release', l.newer ? null : true, l.newer ? `${node.version} runs; ${lv} is out` : `${node.version} (the newest)`, l.newer ? `update the node: arena-install --update <the ${lv} asset>` : null);
    } catch (e) { add('Release', null, `${node.version}; the newest could not be read (${e.message})`); }
  } else add('Release', null, node.version || 'unknown');
  return out;
}
