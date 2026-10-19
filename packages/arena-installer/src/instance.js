// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SEVERAL NODES ON ONE MACHINE (kanban #495, the owner 2026-10-18: "3 macOS os native nodes newly installed via the installer"). The
// installer assumed one node per machine: fixed service names (arena-node.service, io.bitcoin-arena.node, the task "Arena node")
// and fixed ports (LND 9735/10009/10080, the gateway 8476, Tor 19050/19051, the seat 8470, the chain bridge 8471, the liquidity
// provider 8477, the wizard 7800), so a second node overwrote the first one's services and collided on every port.
//   instance=<name>      a-z0-9, at most 12: every service of this node is named apart - arena-node--<name>.service,
//                        io.bitcoin-arena.node--<name>, "Arena node <name>" - the double dash keeps names like arena-chain-bridge apart
//   port_offset=<n>      0..20000: added to every fixed port above
// Both are read from the node's arena.conf (kanban #499: every setting in that file) - the home is the command's --home, else
// ARENA_HOME, else ~/.arena-node - and, for a new node whose arena.conf the wizard has not written yet, from --instance / --port-offset
// (or the older ARENA_INSTANCE / ARENA_PORT_OFFSET). Neither set: names and ports as before. Read once, when the program starts.
import { readFileSync } from 'node:fs';
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
const conf = confAt(flag('--home') || env.ARENA_HOME || join(homedir(), '.arena-node'));
const inst = String(conf.instance ?? flag('--instance') ?? env.ARENA_INSTANCE ?? '').trim();
if (inst && !/^[a-z0-9]{1,12}$/.test(inst)) throw new Error('instance is a-z0-9, at most 12 characters');
const off = Number(conf.port_offset ?? flag('--port-offset') ?? env.ARENA_PORT_OFFSET ?? 0);
if (!Number.isInteger(off) || off < 0 || off > 20000) throw new Error('port_offset is a whole number from 0 to 20000');
export const INSTANCE = inst;
export const PORT_OFFSET = off;
/** `base` with this node's instance: 'arena-node' -> 'arena-node--b' (unchanged without one). */
export const named = (base, sep = '--') => (INSTANCE ? `${base}${sep}${INSTANCE}` : base);
export const port = (p) => p + PORT_OFFSET;
