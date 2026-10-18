// SEVERAL NODES ON ONE MACHINE (kanban #495, the owner 2026-10-18: "3 macOS os native nodes newly installed via the installer"). The
// installer assumed one node per machine: fixed service names (arena-node.service, io.bitcoin-arena.node, the task "Arena node")
// and fixed ports (LND 9735/10009/10080, the gateway 8476, Tor 19050/19051, the seat 8470, the chain bridge 8471, the liquidity
// provider 8477, the wizard 7800), so a second node overwrote the first one's services and collided on every port.
//   ARENA_INSTANCE=<name>   a-z0-9, at most 12: every service of this node is named apart - arena-node--<name>.service,
//                           io.bitcoin-arena.node--<name>, "Arena node <name>" - the double dash keeps names like arena-chain-bridge apart
//   ARENA_PORT_OFFSET=<n>   0..20000: added to every fixed port above
// Neither set: names and ports as before. Read once, when the installer starts (the services it writes carry the values).
const env = process.env;
const inst = String(env.ARENA_INSTANCE || '').trim();
if (inst && !/^[a-z0-9]{1,12}$/.test(inst)) throw new Error('ARENA_INSTANCE is a-z0-9, at most 12 characters');
const off = Number(env.ARENA_PORT_OFFSET || 0);
if (!Number.isInteger(off) || off < 0 || off > 20000) throw new Error('ARENA_PORT_OFFSET is a whole number from 0 to 20000');
export const INSTANCE = inst;
export const PORT_OFFSET = off;
/** `base` with this node's instance: 'arena-node' -> 'arena-node--b' (unchanged without one). */
export const named = (base, sep = '--') => (INSTANCE ? `${base}${sep}${INSTANCE}` : base);
export const port = (p) => p + PORT_OFFSET;
