// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SEVERAL NODES ON ONE MACHINE (2026-10-18: "3 macOS os native nodes newly installed via the installer"). The
// installer assumed one node per machine: fixed service names (arena-node.service, io.bitcoin-arena.node, the task "Arena node")
// and fixed ports (LND 9735/10009/10080, the gateway 8476, Tor 19050/19051, the seat 8470, the chain bridge 8471, the liquidity
// provider 8477, the wizard 7800), so a second node overwrote the first one's services and collided on every port.
//   instance=<name>      a-z0-9, at most 12: every service of this node is named apart - arena-node--<name>.service,
//                        io.bitcoin-arena.node--<name>, "Arena node <name>" - the double dash keeps names like arena-chain-bridge apart
//   port_offset=<n>      0..20000: added to every fixed port above
// Both are read from the node's arena.conf (every setting in that file) - the home is the command's --home, else
// ARENA_HOME, else homeDefault() below - and, for a new node whose arena.conf the wizard has not written yet, from --instance / --port-offset
// (or the older ARENA_INSTANCE / ARENA_PORT_OFFSET). Neither set: names and ports as before. Read once, when the program starts.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseConf } from '../../arena-node/src/arena-conf.js';

const env = process.env;
const argv = process.argv;
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
/** The home's arena.conf values ({} without one). */
export function confAt(home) {
  try { return parseConf(readFileSync(join(resolve(home), 'arena.conf'), 'utf8')).values; } catch { return {}; }
}
/**
 * THE DEFAULT SERVICE NAME TAKEN BY ANOTHER NODE (kanban #635, 2026-10-25: the owner's new install in ~/.arena-node wrote the agent
 * io.bitcoin-arena.node over the one of mactest12, another node on that test host, and removing his install took mactest12's seat down).
 * A new node - no arena.conf yet, no instance or port offset given - looks at the service file of each name in turn: the default, then
 * --2, --3, ... The first that does not exist, or names this node's own folder, is its name; its ports are 100 up per number. Windows
 * keeps the default (its tasks are not files). Answers { instance, offset }.
 * NOR ANOTHER NODE'S PORTS (the owner's 2026.1.8 playtest 2026-10-25: his node took --2 and so seat port 8570, where the test node
 * mactest16b - set up by hand with its own name and offset - already listened; the installer's owner login went to that node and was
 * refused, "that key is not this node's owner"): a name not this node's own is taken only when none of its ports is in use.
 */
export const BASE_PORTS = [7800, 8470, 8471, 8476, 8477, 9735, 10009, 10080, 19050, 19051];
/**
 * EVERY PORT A NODE AT `offset` WILL USE (the 2026.1.9.11 install test: the new node's fedimintd could not bind its API port 12770 -
 * "Address already in use" - since another node's guardian held it; the free-port check knew only the ports above): the fixed ones, the
 * gateway's metrics port (gateway.js: its port + 2), and the guardian's and the guardian-next's, which follow the seat's port
 * (arena-node guardian.js guardianPorts: + 1000 .. + 4000, guardianNextPorts: + 5000 .. + 8000). Tor and Bitcoin Core find free ports of
 * their own (tor.js freeTorPorts, bitcoind.js freeCorePorts).
 */
export const SEAT_PORT = 8470, GATEWAY_PORT = 8476;
export function nodePorts(offset = 0) {
  const o = Number(offset) || 0, seat = SEAT_PORT + o;
  return [...BASE_PORTS.map((p) => p + o), GATEWAY_PORT + 2 + o, ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => seat + k * 1000)];
}
/** The ports among `ports` that are in use on this machine: something answers on 127.0.0.1, or a listener cannot bind it. */
export function portsInUse(ports) {
  const probe = `const net=require('net');const one=(p)=>new Promise((ok)=>{const c=net.connect({port:p,host:'127.0.0.1'});c.setTimeout(700);
c.on('connect',()=>{c.destroy();ok(true)});const free=()=>{c.destroy();const s=net.createServer();s.once('error',()=>ok(true));s.listen(p,()=>s.close(()=>ok(false)))};
c.on('error',free);c.on('timeout',free)});Promise.all(process.argv.slice(1).map(Number).map(one)).then((r)=>console.log(JSON.stringify(process.argv.slice(1).map(Number).filter((p,i)=>r[i]))))`;
  try { return JSON.parse(execFileSync(process.execPath, ['-e', probe, ...ports.map(String)], { encoding: 'utf8', timeout: 15000 })); } catch { return []; }
}
export function freeInstance(home, { platform = process.platform, env: e = process.env, read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } }, busy = portsInUse, tries = 20 } = {}) {
  const at = (inst) => {
    const suffix = inst ? `--${inst}` : '';
    if (platform === 'darwin') return join(e.HOME || homedir(), 'Library', 'LaunchAgents', `io.bitcoin-arena.node${suffix}.plist`);
    if (platform === 'linux') return join(e.XDG_CONFIG_HOME || join(e.HOME || homedir(), '.config'), 'systemd', 'user', `arena-node${suffix}.service`);
    return null;
  };
  for (let n = 1; n <= tries; n++) {
    const inst = n === 1 ? '' : String(n), offset = (n - 1) * 100;
    const file = at(inst);
    if (!file) return { instance: '', offset: 0 };
    const text = read(file);
    if (text !== null && text.includes(resolve(home))) return { instance: inst, offset };
    if (text === null && !busy(nodePorts(offset)).length) return { instance: inst, offset };
  }
  throw new Error(`every Bitcoin Arena service name up to --${tries} belongs to another node on this machine, or its ports are in use`);
}

/**
 * THE NODE'S HOME BY DEFAULT (kanban #688, 2026-10-26: "Rename the directories and binaries to bitcoinarena, not arenanode everywhere in
 * the installer, the packages etc."): ~/.bitcoinarena for a new node. A node installed before 2026.1.9.8 lives in ~/.arena-node and STAYS
 * there - its seed, keys, wallets, guardian and LND data and every service file name that folder, so it is found where it is, never moved:
 * ~/.bitcoinarena when it holds a node (state.json or arena.conf), else ~/.arena-node when that one does, else ~/.bitcoinarena.
 * ARENA_HOME and --home name it outright. The app helpers (pkg/macos, pkg/windows, pkg/linux) look the same way.
 */
export const HOME_DIR = '.bitcoinarena';
export const LEGACY_HOME_DIR = '.arena-node';
export function homeDefault(env = process.env, { home = homedir(), exists = existsSync } = {}) {
  if (env.ARENA_HOME) return env.ARENA_HOME;
  const holds = (d) => exists(join(d, 'state.json')) || exists(join(d, 'arena.conf'));
  const now = join(home, HOME_DIR), before = join(home, LEGACY_HOME_DIR);
  return holds(now) ? now : holds(before) ? before : now;
}

const homeNow = flag('--home') || homeDefault(env);
const conf = confAt(homeNow);
const given = conf.instance ?? flag('--instance') ?? env.ARENA_INSTANCE;
const offGiven = conf.port_offset ?? flag('--port-offset') ?? env.ARENA_PORT_OFFSET;
// only the installer chooses (bin/arena-install.mjs, which writes the node's services): a node, a test or another tool reads what is set
const installing = /arena-install\.mjs$/.test(String(argv[1] || ''));
const auto = installing && given === undefined && offGiven === undefined && !Object.keys(conf).length ? freeInstance(homeNow) : null;
const inst = String(given ?? (auto ? auto.instance : '')).trim();
if (inst && !/^[a-z0-9]{1,12}$/.test(inst)) throw new Error('instance is a-z0-9, at most 12 characters');
const off = Number(offGiven ?? (auto ? auto.offset : 0));
if (!Number.isInteger(off) || off < 0 || off > 20000) throw new Error('port_offset is a whole number from 0 to 20000');
export const INSTANCE = inst;
export const PORT_OFFSET = off;
/** `base` with this node's instance: 'arena-node' -> 'arena-node--b' (unchanged without one). */
export const named = (base, sep = '--') => (INSTANCE ? `${base}${sep}${INSTANCE}` : base);
export const port = (p) => p + PORT_OFFSET;
