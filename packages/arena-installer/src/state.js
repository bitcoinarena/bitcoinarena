// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WIZARD'S STATE, ON DISK ("the wizard can be left and resumed; every step's state is kept on disk").
//
// One directory holds everything the node is: the wizard state (state.json), the node's settings (arena.conf, what its services start
// from -), the seed (seed.hex) and the seat's database (node.db and the files main.js keeps beside it). Every file is the user's only
// (0600, the directory 0700). An update keeps this directory as it is; the release is elsewhere.
import { port, INSTANCE, PORT_OFFSET, homeDefault } from './instance.js';
import { envToConfValues, formatConf } from '../../arena-node/src/arena-conf.js';
import { appsIn, appsEnvValue, chosenApps } from './apps.js';
import { mkdirSync, readFileSync, renameSync, existsSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** The liquidity provider service's local port (127.0.0.1): its claim, and a new top-up address for the owner page. */
export const LIQUIDITY_PROVIDER_PORT = port(8477);   // + ARENA_PORT_OFFSET (instance.js)
// THE APPS STEP (kanban #569, 2026-10-21: "a step in the installer where all apps are automatically selected"): after the roles
export const STEPS = Object.freeze(['start', 'chain', 'roles', 'apps', 'seed', 'emergency', 'owner', 'reach', 'service', 'lightning', 'federation', 'promise', 'bond', 'done']);

/** Where a node lives unless told otherwise: $ARENA_HOME, else ~/.bitcoinarena - or ~/.arena-node, where a node from before 2026.1.9.8 is
 *  (instance.js homeDefault, kanban #688). */
export const defaultHome = (env = process.env) => homeDefault(env);

// THE ROLES (spec §27A roles; ruling 2: custody on Linux and macOS, and in slice 5): what each needs, said before it is chosen.
// The roles step shows each as ONE line - `does` - and its needs as `chips`; `needs` is the full text behind "more" (
// 2026-10-18: "a wall of text that nobody reads. Make it more compact").
export const ROLES = Object.freeze({
  verify: { title: 'Game / verify', does: 'replays and signs rounds', chips: ['🔒 bond', '🌐 https address', '💽 2 GB', '⚙️ 1 CPU core'], needs: 'Replays each round it is seated on and signs who won. 5 of the round\'s 7 seated nodes must agree. Needs a bond, a public https address, about 2 GB of disk and one CPU core.', slice: 1 },
  settlement: { title: 'Settlement', does: 'pays the winners out', chips: ['🔒 bond', '🌐 https address', '⏱️ online until paid'], needs: 'Pays the round out: once the result is signed, it co-signs the payment of the winners from the locked stakes (or the refunds, if a round fails). 5 of the round\'s 7 seated nodes must sign. Needs the same as game / verify, and to stay online until its rounds are paid.', slice: 1 },
  custody: { title: 'Custody', does: 'holds the players\' bitcoin', chips: ['₿ own Bitcoin Core', '⚡ LND', '🚪 port 9735', '💽 +1 GB'], needs: 'Holds the players\' bitcoin together with 9 other nodes: your node becomes one of a federation\'s 10 guardians and may run one of its 2 Lightning gateways (the next steps explain both). Needs your own Bitcoin Core (not Electrum), a Lightning node (LND: set up in the Lightning step, or your own), about 1 GB more disk and port 9735 open.', slice: 1 },
  // THE FOURTH SERVICE (spec §23A.10)
  liquidity: { title: 'Liquidity provider', does: 'gives new nodes incoming Lightning', chips: ['₿ own Bitcoin Core', '⚡ LND', '💰 500,000 sat'], needs: 'Opens incoming Lightning channels to new nodes so they can receive deposits. Any number of nodes can be providers; each new node gets a channel from one or two of them, picked by a fair draw. Needs a Lightning node (LND, set up in the Lightning step) and your own Bitcoin Core, and a deposit of 500,000 sat on testnet4 (5 x the 100,000 sat channel) in LND\'s wallet.', slice: 1 },
});

// ONE STATE FILE, SEVERAL PROCESSES (kanban #1178, the state machine audit 2026-11-06): the wizard, the seat's owner page, the custody agent
// and the updater all read-modify-write state.json. Before: one fixed `state.json.tmp` every writer shared, no fsync, no lock - concurrent
// saves lost each other's fields (custody.pegIn, then sent again), and a file that did not parse read as a fresh install (done{} and the
// bond gone, so POST /api/bond/post allowed a second bond). Now:
//   - every write is a temp file of its own + fsync + rename (+ the folder fsync'd): a reader sees the old file or the new, never half;
//   - every read-modify-write (save, update) runs under <home>/state.json.lock, across processes, and reads the file afresh inside it;
//   - state.json.bak holds the same last state; a state.json that does not parse is read from it, and with no good .bak the read REFUSES
//     (StateUnreadable) - it never starts fresh over a node that exists.
// The file's format is unchanged: a state.json any older installer wrote reads as it did, and one this code writes reads in an older
// installer (what it adds - `onchain`, onchain-action.js - is a field an older one ignores).
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const t = Date.now() + ms; while (Date.now() < t) { /* spin */ } } };
const RENAME_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);   // Windows: a reader holds the target open for a moment

/** Write `text` to `path` so that no reader ever sees half of it: a temp file of its own, fsync, rename over it, the folder fsync'd. */
export function atomicWrite(path, text, { mode = 0o600, platform = process.platform } = {}) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  for (let i = 0; ; i++) {
    try { renameSync(tmp, path); break; } catch (e) {
      if (i >= 50 || !RENAME_BUSY.has(e.code)) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
      sleepSync(20);
    }
  }
  if (platform !== 'win32') { try { const d = openSync(dirname(path), 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* a folder that cannot be fsync'd: the rename stands */ } }
}

/** A state.json that does not read, and no good copy beside it: nothing goes on from a guess (kanban #1178). */
export class StateUnreadable extends Error {
  constructor(file, why, backups = []) {
    super(`${file} does not read (${why}) and ${file}.bak is no good copy: nothing goes on from a fresh state over an existing node. Put back a good state.json`
      + (backups.length ? ` (the newest update backup: ${backups[0]})` : ''));
    this.code = 'STATE_UNREADABLE';
  }
}

export const STATE_LOCK_STALE_MS = 10000;   // a holder writes a few KB inside it: a lock this old was left by a process that died
export const STATE_LOCK_WAIT_MS = 15000;
const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const heldLocks = new Map();   // lock file -> depth (in one process a save inside an update takes no second lock)
/** Run `fn` (synchronous) holding `lockFile` against every other process of this node. */
export function withStateLock(lockFile, fn, { staleMs = STATE_LOCK_STALE_MS, waitMs = STATE_LOCK_WAIT_MS, now = Date.now, alive = alivePid } = {}) {
  if (heldLocks.get(lockFile)) { heldLocks.set(lockFile, heldLocks.get(lockFile) + 1); try { return fn(); } finally { heldLocks.set(lockFile, heldLocks.get(lockFile) - 1); } }
  const t0 = now();
  for (;;) {
    try { const fd = openSync(lockFile, 'wx', 0o600); try { writeSync(fd, JSON.stringify({ pid: process.pid, atMs: now() })); } finally { closeSync(fd); } break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    let age = 0, holder = null;
    try { age = now() - statSync(lockFile).mtimeMs; holder = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { holder = null; }
    // left over: older than any write takes, or its process is gone (a pid only counts once the file names it)
    if (age > staleMs || (holder && Number.isInteger(holder.pid) && holder.pid !== process.pid && !alive(holder.pid))) { try { unlinkSync(lockFile); } catch { /* another took it over */ } continue; }
    if (now() - t0 > waitMs) throw new Error(`${lockFile} is held by another process of this node (pid ${holder ? holder.pid : '?'}): try again`);
    sleepSync(5 + Math.floor(Math.random() * 20));
  }
  heldLocks.set(lockFile, 1);
  try { return fn(); } finally { heldLocks.delete(lockFile); try { unlinkSync(lockFile); } catch { /* taken over as stale */ } }
}

/** The state of the node at `home`: { read(), save(patch), update(fn), path(name) }. A new home starts at the first step. */
export function nodeState(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const file = join(home, 'state.json');
  const bak = `${file}.bak`;
  const lockFile = `${file}.lock`;
  const parse = (f) => { const v = JSON.parse(readFileSync(f, 'utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a state object'); return v; };
  const read = () => {
    let why;
    try { return parse(file); } catch (e) { why = e.code === 'ENOENT' ? null : e.message; }
    // the copy beside it (the same last state, written with it): for a state.json an older installer or the disk tore
    try { return parse(bak); } catch (e) { if (why === null && e.code === 'ENOENT') return { network: 'testnet4', step: 'chain', createdMs: Date.now() }; }
    let backups = [];
    try { backups = readdirSync(join(home, 'backups')).sort().reverse().map((d) => join(home, 'backups', d, 'state.json')).filter((f) => existsSync(f)); } catch { backups = []; }
    throw new StateUnreadable(file, why || 'missing, while state.json.bak does not read', backups);
  };
  // the copy first: a crash between the two leaves state.json at the state before, whose save never answered
  const write = (s) => { const text = JSON.stringify(s, null, 2) + '\n'; atomicWrite(bak, text); atomicWrite(file, text); };
  /** THE READ-MODIFY-WRITE (kanban #1178): `fn(the state read afresh, inside the lock)` answers a patch, merged at the top level, or
   *  null - nothing written (a compare-and-set that did not hold). `fn` is synchronous. Answers the state after. */
  const update = (fn) => withStateLock(lockFile, () => {
    const now = read();
    const patch = fn(now);
    if (patch && typeof patch.then === 'function') throw new Error('state.update takes a synchronous function');
    if (!patch) return now;
    const s = { ...now, ...patch, updatedMs: Date.now() };
    write(s);
    return s;
  });
  return {
    home,
    path: (name) => join(home, name),
    read,
    update,
    save(patch) { return update(() => patch); },
    /** `fields` merged into the object at `key` as it stands now (never a copy read earlier: kanban #1178, custody.pegIn lost). */
    merge(key, fields) { return update((n) => ({ [key]: { ...((n && n[key]) || {}), ...fields } })); },
    writeSecret(name, text) { atomicWrite(join(home, name), text); },
    readSecret(name) { try { return readFileSync(join(home, name), 'utf8').trim(); } catch { return null; } },
    exists: (name) => existsSync(join(home, name)),
  };
}

/**
 * THE NODE'S BOND OUTPUTS (kanban #544): `bonds` [first, added...] - a state file from before add-bond has only `bond`, read as
 * [bond]. `bond` stays the first output (the one the advertisement updates name).
 */
export function bondsOf(s) {
  if (s && Array.isArray(s.bonds) && s.bonds.length) return s.bonds;
  return s && s.bond && s.bond.txid ? [s.bond] : [];
}

/** The node's guardian endpoint: its public address as a websocket, /guardian (the seat carries it to its fedimintd). */
export const guardianUrlOf = (url) => (url ? `${url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/+$/, '')}/guardian` : null);

/**
 * THIS NODE'S OWN BITCOIN CORE: its chain when that is a Core; while the Core the installer put here still syncs behind the interim
 * Electrum chain, that Core (kanban #635 - measured 2026-10-25 in the owner's playtest: custody was refused right after "Install Bitcoin
 * Core for me", the chain being the interim Electrum server). LND, the guardian and custody read it. null: no Core of its own.
 */
export function ownCoreOf(s) {
  if (s && s.chain && s.chain.kind === 'core') return s.chain;
  const t4 = s && s.core && s.core.networks && s.core.networks.testnet4;
  return t4 ? { kind: 'core', url: t4.rpcUrl, cookiePath: t4.cookiePath } : null;
}

/** A custody node's guardian: its binaries from the release and its endpoint, or null (no custody, no Core, no public address, no binaries). */
export function guardianSetupOf(s, { release, platform = process.platform }) {
  if (!(s.roles || []).includes('custody') || !ownCoreOf(s) || !s.reach || !s.reach.url) return null;
  const x = platform === 'win32' ? '.exe' : '';
  const fedimintd = join(release, 'runtime', 'custody', `fedimintd${x}`), cli = join(release, 'runtime', 'custody', `fedimint-cli${x}`);
  if (!existsSync(fedimintd) || !existsSync(cli)) return null;
  return { fedimintd, cli, endpoint: guardianUrlOf(s.reach.url) };
}

/**
 * THE NODE'S STAKE LOCKS (kanban #824, measured 2026-10-31 06:47-07:06Z: installer nodes drawn as signers answered 402 to every paid entry,
 * so a table of 4 seats and 2 of them, 5 needed, took no stake): the release's arena-stake-lock and a client folder of the node's own, on every
 * role - any drawn node reads the locks. No client is joined here: the node joins each round's federation when a round first asks
 * (stake-lock-port.js federationPorts, <home>/federations/<id>). null: this release has no tool for this system.
 */
export function stakeLockSetupOf({ home, release, platform = process.platform }) {
  const bin = join(release, 'runtime', 'custody', `arena-stake-lock${platform === 'win32' ? '.exe' : ''}`);
  return existsSync(bin) ? { bin, clientDir: join(home, 'federation-client') } : null;
}

/**
 * The steps done. A state from before the apps step (kanban #569) that is past it - its seed confirmed - counts the apps as done: its node
 * hosts what it was given (seatEnv: every app), and the wizard does not go back to ask. The same for New / Restore (kanban #652).
 */
export const doneOf = (s) => {
  const d = { ...((s && s.done) || {}) };
  // only an install from before the first step (no start in it): a new one reaches the seed before the apps when it restores or uses
  // Nostr, and must still choose its apps (measured in the installer walk of 9a863f31: the bar showed Apps done after a Nostr start)
  const older = !d.start;
  if (!d.apps && d.seed && older) d.apps = d.seed;
  if (!d.start && (d.chain || d.seed)) d.start = d.chain || d.seed;   // (kanban #652: a state from before New / Restore that is past it)
  // (kanban #647: an install from before the code's own step - no start step either - that is past the owner, or any past the address)
  if (!d.emergency && (d.reach || d.service || (older && d.owner))) d.emergency = d.reach || d.service || d.owner;
  return d;
};

/** The first step not done yet. */
export const nextStep = (s) => { const d = doneOf(s); return STEPS.find((k) => !d[k]) || 'done'; };

/**
 * THE APPS THE SEAT LOADS (ARENA_APPS, arena.conf apps=; kanban #569): the registrations of the apps chosen in the apps step - all of
 * the release's apps when none was saved (a state from before the step). A saved app this release no longer carries is left out; a
 * release without any app.json (older than #569) hosts Next Block, as it did.
 */
export function appsSetting(s, release) {
  const apps = appsIn(release);
  if (!apps.length) return join(release, 'packages/nextblock/plugin/nextblock.js');
  const known = chosenApps(s, apps).filter((id) => apps.some((a) => a.id === id));
  return appsEnvValue(release, known.length ? known : apps.map((a) => a.id), apps);
}

/**
 * THE SEAT'S SETTINGS (main.js reads them): a systemd EnvironmentFile, KEY=VALUE per line. Bitcoin Core by its cookie file (user and
 * password go into a cookie-format file of our own, main.js reads only a cookie). Answers the text.
 */
export function seatEnv(s, { home, release }) {
  const lines = [
    '# The Arena node\'s settings, written by the installer. An update keeps this file.',
    // a direct node listens on every interface; behind a tunnel only cloudflared on this machine reaches it
    `ARENA_BIND=${s.reach && s.reach.mode === 'direct' ? '0.0.0.0' : '127.0.0.1'}`,
    'ARENA_DONATION_NETWORK=testnet4',
    'ARENA_CLOSE_AT_END=1',
    `ARENA_APPS=${appsSetting(s, release)}`,
    `ARENA_PLUGINS_DIR=${join(home, 'node.db.plugins')}`,
  ];
  if (s.chain && s.chain.kind === 'core') {
    lines.push(`ARENA_BITCOIND_URL=${s.chain.url}`, `ARENA_BITCOIND_COOKIE=${s.chain.cookiePath || join(home, 'bitcoind.auth')}`);
  }
  if (s.chain && s.chain.kind === 'electrum') {
    // the chain bridge (chain-bridge.js) answers the seat's bitcoind calls from the Electrum server and Esplora, on this port
    lines.push(`ARENA_BITCOIND_URL=http://127.0.0.1:${s.bridgePort}/`, `ARENA_BITCOIND_COOKIE=${join(home, 'bridge.cookie')}`);
  }
  if (s.reach && s.reach.url) lines.push(`ARENA_WSS_${s.port}=${s.reach.url}`);   // the node's public address, as it names itself
  // CUSTODY (ruling 3): the node's guardian in setup mode (ARENA_FOUNDING=1, node-start.js) from the release's own
  // fedimintd, reached at the node's public address /guardian - so it can be drawn when new nodes found a federation
  const custody = guardianSetupOf(s, { release });
  if ((s.roles || []).includes('custody')) lines.push(`ARENA_GATEWAY_PORT=${port(8476)}`, `ARENA_GATEWAY_CLAIM_FILE=${join(home, 'gateway-claim.json')}`);
  if ((s.roles || []).includes('liquidity')) lines.push(`ARENA_LIQUIDITY_CLAIM_FILE=${join(home, 'liquidity-claim.json')}`, `ARENA_LIQUIDITY_PROVIDER_URL=http://127.0.0.1:${LIQUIDITY_PROVIDER_PORT}`);   // its provider's claim (§23A.10)   // the gateway seat's claim (custody-agent.js)   // the seat carries <public>/gateway/ to the node's gateway (gateway.js GATEWAY_PORT)
  // the guardian reads the node's own Core even while the node reads the interim Electrum chain (kanban #635)
  if (custody && s.chain && s.chain.kind === 'electrum') { const own = ownCoreOf(s); lines.push(`ARENA_GUARDIAN_BITCOIND_URL=${own.url}`, `ARENA_GUARDIAN_BITCOIND_COOKIE=${own.cookiePath}`); }
  if (custody) lines.push('ARENA_FOUNDING=1', `ARENA_FEDIMINTD=${custody.fedimintd}`, `ARENA_FEDIMINT_CLI=${custody.cli}`, `ARENA_GUARDIAN_ENDPOINT_${s.port}=${custody.endpoint}`);
  const locks = stakeLockSetupOf({ home, release });
  if (locks) lines.push(`ARENA_STAKE_LOCK_BIN=${locks.bin}`, `ARENA_FEDERATION_CLIENT_DIR=${locks.clientDir}`);
  // Fedimint on a RAM disk (kanban #596): chosen for more than 5 nodes on this machine (guardian-ram.js)
  if (custody && s.instances && s.instances.ram) lines.push('ARENA_FEDIMINT_RAM=1');
  // the machine's own name, shown in the health page's machines (kanban #621)
  if (s.instances && s.instances.name) lines.push(`ARENA_MACHINE_NAME=${s.instances.name}`);
  lines.push(`ARENA_ROLES=${(s.roles || []).join(',')}`);
  return lines.join('\n') + '\n';
}

/**
 * THE NODE'S SETTINGS FILE (2026-10-19: "Every setting must be in a config file arena.conf not in some PARAMETER
 * env vars. the installer writes that config file"): the seat's settings above, with its port and store, this node's instance and port
 * offset, as arena.conf (arena-node/src/arena-conf.js). The service starts `src/run.js <home>/arena.conf` and nothing else.
 */
export function seatConf(s, { home, release, platform = process.platform }) {
  const values = { network: s.network || 'testnet4', ...envToConfValues(seatEnv(s, { home, release }), { port: s.port, database: join(home, 'node.db') }) };
  if (INSTANCE) values.instance = INSTANCE;
  if (PORT_OFFSET) values.port_offset = String(PORT_OFFSET);
  return formatConf(values, { eol: platform === 'win32' ? '\r\n' : '\n' });
}
