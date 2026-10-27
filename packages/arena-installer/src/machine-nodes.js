// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY NODE ON THIS MACHINE, AND MORE OF THEM (kanban #713, 2026-10-26, the owner: "When I update an existing node via the CLI or UI
// (mac/windows) I get prompted to update first. There, I can setup additional nodes (with the ramdisk option). This runs the steps that we
// already do run. The App shows the status of ALL OF OUR nodes in a grid with links to all owners dashboards" - "If I execute the installer
// without updating the version, there is the option to Add Nodes with the same process" - testnet only).
//   nodesHere     the nodes this user runs: each seat's service file names its home (<home>/arena.conf, service.js), and the usual
//                 homes (~/.bitcoinarena, ~/.arena-node and their -b, -c ... of a count, instances.js) are looked at too
//   addNodesPlan  the further nodes' names, homes and ports: instancesOf's letters from the first node, past every name, home and port
//                 already taken
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseConf } from '../../arena-node/src/arena-conf.js';
import { instancesOf, INSTANCES_MAX } from './instances.js';
import { nodePorts, portsInUse } from './instance.js';

const holds = (d) => existsSync(join(d, 'state.json')) || existsSync(join(d, 'arena.conf'));
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const confOf = (home) => { try { return parseConf(readFileSync(join(home, 'arena.conf'), 'utf8')).values; } catch { return {}; } };

/** The homes the seats' service files name: the launch agents, the user units, nothing on Windows (its launchers live in the homes). */
export function serviceHomes({ platform = process.platform, env = process.env } = {}) {
  const dir = platform === 'darwin' ? join(env.HOME || homedir(), 'Library', 'LaunchAgents')
    : platform === 'linux' ? join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'systemd', 'user') : null;
  if (!dir || !existsSync(dir)) return [];
  const seat = platform === 'darwin' ? /^io\.bitcoin-arena\.node(--[a-z0-9]+)?\.plist$/ : /^arena-node(--[a-z0-9]+)?\.service$/;
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!seat.test(f)) continue;
    let t = ''; try { t = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    const m = /([^\s<>"]+)[\\/]arena\.conf/.exec(t);
    if (m) out.push(m[1]);
  }
  return out;
}

/** The usual homes in the user's folder: .bitcoinarena and .arena-node, and each one's -<letter> of a count. */
export function folderHomes({ env = process.env } = {}) {
  const top = env.HOME || env.USERPROFILE || homedir();
  let names = []; try { names = readdirSync(top); } catch { names = []; }
  return names.filter((n) => /^\.(bitcoinarena|arena-node)(-[a-z0-9]+)?$/.test(n)).map((n) => join(top, n));
}

/**
 * The nodes on this machine, the first installed first: [{ home, instance, port, portOffset, network, key, version, publicUrl }]. A folder
 * without arena.conf (a setup not finished) is not a node yet.
 */
export function nodesHere({ platform = process.platform, env = process.env, extra = [] } = {}) {
  const seen = new Set(), out = [];
  for (const home of [...serviceHomes({ platform, env }), ...folderHomes({ env }), ...extra]) {
    if (!home || seen.has(home) || !existsSync(join(home, 'arena.conf'))) continue;
    seen.add(home);
    const c = confOf(home), s = readJson(join(home, 'state.json')) || {};
    const rel = s.release && s.release.path;
    let version = null; try { version = readFileSync(join(rel, 'VERSION'), 'utf8').trim(); } catch { version = null; }
    const key = s.service && /^[0-9a-f]{64}$/.test(String(s.service.identity || '')) ? s.service.identity : null;
    out.push({ home, instance: c.instance || '', port: Number(c.port) || null, portOffset: Number(c.port_offset) || 0, network: c.network || s.network || 'testnet4',
      key, version, publicUrl: c.public_url || (s.reach && s.reach.url) || null });
  }
  return out.sort((a, b) => a.portOffset - b.portOffset || a.home.localeCompare(b.home));
}

/** Each node asked on its own port whether it answers (GET /identity, 1.5 s): the list with `running` and the key it answers as. */
export async function liveNodes(nodes, { fetcher = fetch, ms = 1500 } = {}) {
  return Promise.all(nodes.map(async (n) => {
    if (!n.port) return { ...n, running: false };
    try {
      const r = await fetcher(`http://127.0.0.1:${n.port}/identity`, { signal: AbortSignal.timeout(ms) });
      const b = Buffer.from(await r.arrayBuffer());
      return { ...n, running: r.status === 200, key: n.key || (b.length >= 32 ? b.subarray(0, 32).toString('hex') : null) };
    } catch { return { ...n, running: false }; }
  }));
}

/**
 * THE FURTHER NODES (kanban #713): `count` more after the nodes there are, named from the first node as a count's are (instancesOf: its
 * instance + b, c, ... in <home>-b, ...; ports PORT_STEP apart) - a name, home or port another node holds is passed over. Testnet4 only, at
 * most INSTANCES_MAX nodes in all. { ok, base, nodes: [{ instance, home, portOffset }] } or { ok: false, why }.
 */
export function addNodesPlan(nodes, count, { busy = portsInUse } = {}) {
  const n = Number(count);
  if (!nodes.length) return { ok: false, why: 'no node is installed on this machine yet: install one first' };
  if (!Number.isInteger(n) || n < 1) return { ok: false, why: 'the number of nodes to add is a whole number from 1' };
  const base = nodes[0];
  if (nodes.some((x) => x.network !== 'testnet4')) return { ok: false, why: 'more than one node on a machine is for testnet4 only' };
  if (nodes.length + n > INSTANCES_MAX) return { ok: false, why: `at most ${INSTANCES_MAX} nodes on one machine: ${nodes.length} are here, so at most ${INSTANCES_MAX - nodes.length} more` };
  const names = new Set(nodes.map((x) => x.instance)), homes = new Set(nodes.map((x) => x.home)), offsets = new Set(nodes.map((x) => x.portOffset));
  const out = [];
  // the letters b to z after the first node's name (instancesOf), as a count's further nodes are named
  for (const c of instancesOf(26, base.home, { instance: base.instance, portOffset: base.portOffset }).slice(1)) {
    if (out.length === n) break;
    if (names.has(c.instance) || homes.has(c.home) || offsets.has(c.portOffset) || holds(c.home)) continue;
    // EVERY PORT IT WILL USE, its guardian's among them (the 2026.1.9.11 install test: another node's guardian held the new node's guardian
    // API port, and its fedimintd ended at start with "Address already in use"): none of them in use
    if (busy(nodePorts(c.portOffset)).length) continue;
    out.push(c);
  }
  if (out.length < n) return { ok: false, why: `only ${out.length} free name(s) and port range(s) were found for ${n} more node(s)` };
  return { ok: true, base: base.home, nodes: out };
}
