#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DEVELOPER DEVNET IN ONE COMMAND (docs/PLATFORM-RESEARCH.md item 15: "one command starts a local chain, a
// federation and seven nodes, with a game template and a replay simulator. The first hour decides whether a developer
// stays"). Regtest only: no testnet4, no mainnet, no bond or stake anywhere but the devnet's own chain.
//
//   BITCOIN_BIN=<dir with bitcoind, bitcoin-cli> FEDIMINT_BIN=<dir with fedimintd, fedimint-cli, arena-stake-lock> \
//     node packages/arena-node/tools/devnet.mjs up | status | play [--game name] | replay [round entry] | down
//   node packages/arena-node/tools/devnet.mjs new-game <dir> [name]      (the game template, made a game of your own)
//
// NOTHING HERE IS NEW MACHINERY. Each step is the harness that already does it, run as it is run:
//   the chain        a regtest bitcoind on its own datadir, mined to maturity (as seating-regtest.mjs and the regtest stacks)
//   the federation   tools/testnet4-found.mjs with ARENA_TN4_NETWORK=regtest (as tn4-tools-regtest.sh): seven nodes, each
//                    one guardian, 5 of 7, founded through each node's own startGuardian
//   the seven nodes  `node src/main.js <port> <store>`, one process each, each starting its own guardian (node-start.js)
//   two gateways     two lnds, a gateway on each (tools/testnet4-gateway.sh), registered at all seven guardians as
//                    tn4-tools-regtest.sh registers them: a node opens a paying round only on two live gateways (§23.6)
//   the bonds and    round-2of2.mjs standUpRound in attach mode with ARENA_POST_FIRST_BONDS=1 (as run-testnet4-paid.mjs
//   the rounds       ARENA_ATTACH=1 and attach-regtest.mjs): keys from GET /identity, each node's first bond posted with the
//                    guardian it runs, the rounds published on the chain and posted over HTTP; a free round and a paid one
//   a play           tools/tn4-live-run.mjs's run without its deposit and lock: an entry, the world the round's randomness
//                    seeds, a closed-loop drive of the round's core (window-fixture drivenTape), its batches and marks over
//                    /play, then each seat's signed result
//   a replay         src/replay.js, the node's own replay in the core's sandbox, over a transcript a seat hands out
//
// EVERYTHING IN ONE DIRECTORY (DEVNET_DIR, default ./devnet-data): the chain, the node stores and their guardians, the
// federation clients, the logs, a pid file per process. `down` stops exactly the processes it started, by those pid files
// (each started in its own process group, so a node's fedimintd goes with it) - never by a name pattern.
//
// PORTS FROM ONE BASE (DEVNET_BASE_PORT, default 24000; tools/devnet-plan.mjs): all private, all below 32768, none of the
// live stacks'. `up` refuses to start when any of them is already taken by something that is not this devnet.
//
// OTHER SETTINGS: LOCK_BIN (default $FEDIMINT_BIN/arena-stake-lock), LND_BIN (lnd and lncli for the two gateways a paid round
// needs; none: free rounds only), DEVNET_APPS (more ARENA_APPS registration modules for the
// seven nodes - a game of your own, tools/devnet-template), DEVNET_PAID_STAKE_MSAT (default 10 000 000), DEVNET_BLOCK_SECONDS
// (a block every N s once the rounds are up; default 30, 0 for none), DEVNET_PAGE (the page the printed links open, default
// https://testnet.bitcoin-arena.io) or DEVNET_PAGE_DIR (a built page served on base + 3, which the links then open).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, readdirSync, rmSync } from 'node:fs';
import { createServer as netServer, connect } from 'node:net';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devnetPorts, clashes, parseListening, portsOfPart, NODE_COUNT } from './devnet-plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_PKG = resolve(HERE, '..');
const env = process.env;
const D = resolve(env.DEVNET_DIR || 'devnet-data');
const PLAN = (() => { try { return devnetPorts(Number(env.DEVNET_BASE_PORT || 24000)); } catch (e) { console.error(`devnet: ${e.message}`); process.exit(2); } })();
const WALLET = 'devnet';
const FREE_WINDOW_MS = 30 * 60000;          // the lobby's free round takes entries for half an hour after its start
const PAID_WINDOW_MS = 3600000;             // the paid round for an hour
const PLAY_WINDOW_MS = 45000;               // a round opened for one `play`: entries close 45 s after its start
const KEEP_LEAD_MS = 5 * 60000;             // a kind's next round is opened when its newest has under 5 min of entry left
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const path = (...p) => join(D, ...p);
const storeOf = (k) => path('nodes', `node-${k + 1}.db`);
const dirOnPath = (bin) => (env.PATH || '').split(delimiter).find((d) => d && existsSync(join(d, bin))) || null;
const BTC = env.BITCOIN_BIN || dirOnPath('bitcoind');
const FED = env.FEDIMINT_BIN || dirOnPath('fedimintd');
const LOCK = env.LOCK_BIN || (FED ? join(FED, 'arena-stake-lock') : null);
const PAGE_DIR = env.DEVNET_PAGE_DIR || '';
const PAGE = PAGE_DIR ? `http://127.0.0.1:${PLAN.page}` : (env.DEVNET_PAGE || 'https://testnet.bitcoin-arena.io').replace(/\/+$/, '');
// THE GAMES BEYOND NEXTBLOCK (DEVNET_APPS, registration modules exporting GAME): named once at `up` and kept in the devnet's
// own directory, so every later command - and the runner, started elsewhere - hosts, opens and replays the same games
const APP_FILES = env.DEVNET_APPS !== undefined
  ? env.DEVNET_APPS.split(',').map((x) => x.trim()).filter(Boolean).map((x) => resolve(x))
  : (() => { try { return JSON.parse(readFileSync(join(D, 'games.json'), 'utf8')); } catch { return []; } })();
/** The registrations of every game this devnet hosts: nextblock's first, then DEVNET_APPS'. */
async function registrations() {
  const out = [(await import('../../nextblock/plugin/nextblock.js')).GAME];
  for (const f of APP_FILES) out.push((await import(pathToFileURL(f).href)).GAME);
  return out;
}
const nodeUrl = (k) => `http://127.0.0.1:${PLAN.nodes[k]}`;
const NODES = PLAN.nodes.map((_, k) => nodeUrl(k));

// ---- PROCESSES: one pid file each, each in its own process group ----
const pidFile = (name) => path('pids', `${name}.pid`);
const readPid = (name) => { try { return JSON.parse(readFileSync(pidFile(name), 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const running = (name) => { const p = readPid(name); return p && alive(p.pid) ? p : null; };
const PARTS = ['bitcoind', 'lnd-a', 'lnd-b', 'gateway-a', 'gateway-b', ...PLAN.nodes.map((_, k) => `node-${k + 1}`), 'runner', 'page'];
const LND = env.LND_BIN || dirOnPath('lnd');
/** Start a process in a new session (its own process group: `detached`), its output to its log, its pid to its file. */
function startPart(name, cmd, args, { env: e = env, cwd = NODE_PKG } = {}) {
  mkdirSync(path('logs'), { recursive: true });
  mkdirSync(path('pids'), { recursive: true });
  const out = openSync(path('logs', `${name}.log`), 'a');
  const child = spawn(cmd, args, { cwd, env: e, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  writeFileSync(pidFile(name), JSON.stringify({ name, pid: child.pid, pgid: child.pid, started: new Date().toISOString(), cmd: [cmd, ...args].join(' ') }) + '\n');
  return child.pid;
}
/** Stop one part: its whole group TERM, up to `graceMs` for it to go, then KILL. Answers what was done. */
async function stopPart(name, graceMs = 20000) {
  const p = readPid(name);
  if (!p) return null;
  const was = groupAlive(p.pgid) || alive(p.pid);
  if (was) { try { process.kill(-p.pgid, 'SIGTERM'); } catch { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } } }
  const until = Date.now() + graceMs;
  while ((groupAlive(p.pgid) || alive(p.pid)) && Date.now() < until) await wait(250);
  let killed = false;
  if (groupAlive(p.pgid) || alive(p.pid)) { killed = true; try { process.kill(-p.pgid, 'SIGKILL'); } catch { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } } await wait(500); }
  rmSync(pidFile(name), { force: true });
  return { name, pid: p.pid, wasRunning: was, killed, gone: !groupAlive(p.pgid) && !alive(p.pid) };
}

// ---- THE CHAIN ----
const btcArgs = () => ['-regtest', `-datadir=${path('btc')}`, `-rpcport=${PLAN.rpc}`];
const WALLET_FREE = new Set(['listwallets', 'loadwallet', 'createwallet', 'getblockcount', 'getblockchaininfo', 'stop', 'getblockhash', 'getblockheader', 'getblock']);
/** bitcoin-cli on the devnet's chain; every command but the chain and wallet-management ones on the devnet wallet. */
const cli = (...a) => execFileSync(join(BTC, 'bitcoin-cli'), [...btcArgs(), ...(WALLET_FREE.has(a[0]) ? [] : [`-rpcwallet=${WALLET}`]), ...a],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const COOKIE = () => path('btc', 'regtest', '.cookie');
const RPC_URL = `http://127.0.0.1:${PLAN.rpc}`;

/** What listens on this machine: ss on Linux, lsof on macOS. */
function listening() {
  for (const [cmd, args] of [['ss', ['-ltnH']], ['lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']]]) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status === 0 || (r.stdout && r.stdout.length)) return parseListening(r.stdout);
  }
  return new Set();
}
/** And a bind of 127.0.0.1:port, closed again at once: free only when it binds. */
const bindable = (port) => new Promise((ok) => {
  const s = netServer();
  s.once('error', () => ok(false));
  s.listen(port, '127.0.0.1', () => s.close(() => ok(true)));
});
const answers = (port) => new Promise((ok) => {
  const c = connect({ port, host: '127.0.0.1' });
  c.setTimeout(1500, () => { c.destroy(); ok(false); });
  c.once('connect', () => { c.destroy(); ok(true); });
  c.once('error', () => ok(false));
});
const getJson = async (url, ms = 10000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`${url}: ${r.status} ${(await r.text()).slice(0, 160)}`); return r.json(); };

function needBins() {
  const want = [[BTC, 'bitcoind', 'BITCOIN_BIN'], [BTC, 'bitcoin-cli', 'BITCOIN_BIN'], [FED, 'fedimintd', 'FEDIMINT_BIN'], [FED, 'fedimint-cli', 'FEDIMINT_BIN']];
  const missing = want.filter(([dir, bin]) => !dir || !existsSync(join(dir, bin))).map(([, bin, v]) => `${bin} (${v})`);
  if (!LOCK || !existsSync(LOCK)) missing.push('arena-stake-lock (LOCK_BIN)');
  if (missing.length) throw new Error(`not found: ${missing.join(', ')} - name the directories, or put them on PATH`);
}

/** The environment every fedimint tool and node runs with: the fork's binaries first on PATH, HOME inside the devnet. */
function fedEnv(extra = {}) {
  return { ...env, PATH: [FED, dirname(process.execPath), env.PATH || ''].join(delimiter), HOME: path('home'),
    ARENA_BITCOIND_URL: RPC_URL, ARENA_BITCOIND_COOKIE: COOKIE(), ARENA_TN4_NETWORK: 'regtest',
    // EACH GUARDIAN'S ENDPOINT, NAMED: the node's own /guardian door on 127.0.0.1. Derived from Tailscale otherwise
    // (guardian.js readTailscale), which on a machine with a Funnel asks it for every node - and a devnet is local.
    ...Object.fromEntries(PLAN.nodes.map((p) => [`ARENA_GUARDIAN_ENDPOINT_${p}`, `ws://127.0.0.1:${p}/guardian`])),
    ...extra };
}
const fcli = (dir, args, ms = 60000) => spawnSync(join(FED, 'fedimint-cli'), ['--data-dir', dir, ...args],
  { encoding: 'utf8', timeout: ms, env: fedEnv() });

// =====================================================================================================================
// up
// =====================================================================================================================
async function up() {
  const t0 = Date.now();
  needBins();
  for (const d of ['btc', 'nodes', 'clients', 'runner', 'logs', 'pids', 'home', 'plays']) mkdirSync(path(d), { recursive: true });
  // ---- 0. NOTHING ELSE ON THE DEVNET'S PORTS ----
  const ours = new Set(PARTS.filter((n) => running(n)).flatMap((n) => portsOfPart(PLAN, n)));
  const wanted = { ...PLAN, all: PLAN.all.filter((x) => x.what !== 'page' || PAGE_DIR) };
  const taken = clashes(wanted, listening(), ours);
  for (const x of wanted.all) if (!ours.has(x.port) && !taken.includes(x) && !(await bindable(x.port))) taken.push(x);
  if (taken.length) throw new Error(`these ports are taken by something that is not this devnet: ${taken.map((x) => `${x.port} (${x.what})`).join(', ')}`
    + ' - pick another DEVNET_BASE_PORT');
  say({ step: 'ports', base: PLAN.base, rpc: PLAN.rpc, nodes: PLAN.nodes, guardians: `${PLAN.nodes[0] + 1000}..${PLAN.nodes[6] + 4000}`, control: PLAN.control, dir: D });

  // ---- 1. THE CHAIN, mined to maturity ----
  if (!running('bitcoind')) {
    startPart('bitcoind', join(BTC, 'bitcoind'), [...btcArgs(), `-port=${PLAN.p2p}`, '-listen=0', '-listenonion=0', '-server=1', '-txindex=1',
      '-fallbackfee=0.0002', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1',
      // the feeds the two gateways' lnds read the chain from
      `-zmqpubrawblock=tcp://127.0.0.1:${PLAN.zmqBlock}`, `-zmqpubrawtx=tcp://127.0.0.1:${PLAN.zmqTx}`]);
  }
  for (let i = 0; ; i++) { try { cli('getblockcount'); break; } catch (e) { if (i > 120) throw new Error(`bitcoind did not answer: ${e.message}`); await wait(500); } }
  if (!JSON.parse(cli('listwallets')).includes(WALLET)) { try { cli('loadwallet', WALLET); } catch { cli('createwallet', WALLET); } }
  // 250: a hundred for coinbase maturity, and room for the bonds, the publications and the guardians' peg-in window
  const h0 = Number(cli('getblockcount'));
  if (h0 < 250) cli('generatetoaddress', String(250 - h0), cli('getnewaddress'));
  say({ step: 'chain', height: Number(cli('getblockcount')), rpc: RPC_URL });

  // ---- 2. THE FEDERATION: seven guardians, one per node, 5 of 7 (tools/testnet4-found.mjs on regtest) ----
  const { holdsGuardianKey } = await import('../src/node-start.js');
  const stores = PLAN.nodes.map((_, k) => storeOf(k));
  if (!stores.every((s) => holdsGuardianKey(s))) {
    const up = PLAN.nodes.filter((_, k) => running(`node-${k + 1}`));
    if (up.length) throw new Error(`nodes ${up.join(', ')} run but the federation is not founded: run down first`);
    const t = Date.now();
    const r = spawnSync(process.execPath, [join(HERE, 'testnet4-found.mjs'), ...PLAN.nodes.map((p, k) => `${p}:${stores[k]}`)],
      { cwd: NODE_PKG, encoding: 'utf8', timeout: 900000, env: fedEnv({ ARENA_FEDERATION_NAME: 'devnet' }) });
    writeFileSync(path('logs', 'found.log'), `${r.stdout || ''}${r.stderr || ''}`);
    const got = (r.stdout || '').split('\n').filter((l) => l.startsWith('{"founded"')).map((l) => JSON.parse(l)).pop();
    if (r.status !== 0 || !got) throw new Error(`the founding failed (logs/found.log): ${String(r.stderr || r.error || '').trim().split('\n').slice(-3).join(' | ')}`);
    say({ step: 'federation founded', seconds: Math.round((Date.now() - t) / 1000), guardians: NODE_COUNT, threshold: 5 });
  }
  const invite = readFileSync(`${stores[0]}.guardian/invite-code`, 'utf8').replace(/["\s]/g, '');
  writeFileSync(path('invite-code'), invite + '\n');

  // ---- 3. THE SEVEN NODES, one process each, each starting its own guardian ----
  // THE GAMES THE NODES HOST, kept for every later command. A game added after the first `up` is hosted, and its bonds do not
  // advertise it (a bond is posted once): start a devnet on a fresh DEVNET_DIR for it, or its rounds find no committee
  const apps = [join(NODE_PKG, '..', 'nextblock', 'plugin', 'nextblock.js'), ...APP_FILES];
  writeFileSync(path('games.json'), JSON.stringify(APP_FILES) + '\n');
  for (const [k, port] of PLAN.nodes.entries()) {
    if (running(`node-${k + 1}`)) continue;
    const client = path('clients', `node-${k + 1}`);
    mkdirSync(client, { recursive: true });
    startPart(`node-${k + 1}`, process.execPath, ['src/main.js', String(port), stores[k]], { env: fedEnv({
      ARENA_STAKE_LOCK_BIN: LOCK, ARENA_FEDERATION_CLIENT_DIR: client, ARENA_FEDERATION_CLIENTS_DIR: path('clients', `node-${k + 1}-others`),
      ARENA_FEDERATION_INVITE: invite, ARENA_CLOSE_AT_END: '1', ARENA_FUND_FREE_ROUNDS: '1', ARENA_DONATION_NETWORK: 'regtest',
      ARENA_ATTACH_PROOF_DIR: path('runner', 'proof'), ARENA_FUNDED_ROUNDS_FILE: path('runner', 'funded.txt'),
      ARENA_APPS: apps.join(','), [`ARENA_WSS_${port}`]: `ws://127.0.0.1:${port}` }) });
  }
  for (const [k, port] of PLAN.nodes.entries()) {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${nodeUrl(k)}/identity`, { signal: AbortSignal.timeout(3000) })).ok) break; } catch { /* not yet */ }
      if (!running(`node-${k + 1}`)) throw new Error(`node ${k + 1} (${port}) exited: see logs/node-${k + 1}.log`);
      if (i > 240) throw new Error(`node ${k + 1} (${port}) did not answer in 120 s: see logs/node-${k + 1}.log`);
      await wait(500);
    }
  }
  const guardians = await Promise.all(PLAN.nodes.map((_, k) => getJson(`${nodeUrl(k)}/guardian`).catch((e) => ({ error: e.message }))));
  say({ step: 'seven nodes', ports: PLAN.nodes, guardians: guardians.filter((g) => g.guardian === true).length });

  // ---- 4. A FEDERATION CLIENT FOR THE RUNNER AND EACH NODE (each its own data dir: one client database is one flock) ----
  const clients = ['runner', ...PLAN.nodes.map((_, k) => `node-${k + 1}`)].map((n) => path('clients', n));
  const t4 = Date.now();
  await Promise.all(clients.map(async (dir) => {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; ; i++) {
      if (fcli(dir, ['info'], 60000).status === 0) return;
      const j = fcli(dir, ['join-federation', invite], 120000);
      if (j.status === 0) return;
      if (Date.now() - t4 > 600000) throw new Error(`the client in ${dir} did not join: ${String(j.stderr || '').trim().slice(-300)}`);
      await wait(3000);
    }
  }));
  say({ step: 'clients joined', clients: clients.length, seconds: Math.round((Date.now() - t4) / 1000) });

  // ---- 4b. TWO GATEWAYS OF DIFFERENT OPERATORS, LIVE IN THE FEDERATION: a node opens a paying round only then (§23.6, server.js
  // POST /round "at least two, run by different operators"). Each on an lnd of its own (two node keys), started by
  // tools/testnet4-gateway.sh as the testnet4 and regtest stacks start theirs, joined to the federation and registered at all
  // seven guardians as tn4-tools-regtest.sh registers them (http://localhost:<port>). No channel and no peg-in: a gateway
  // answers its routing info without either, and a deposit into a paid round needs both (left to the developer: see the docs).
  // Without lnd (LND_BIN) or gatewayd the devnet runs free rounds only, and says so.
  const gatewayd = FED && existsSync(join(FED, 'gatewayd')) && existsSync(join(FED, 'gateway-cli'));
  if (LND && existsSync(join(LND, 'lnd')) && gatewayd) await gateways(invite);
  else say({ step: 'gateways', skipped: `no ${!LND || !existsSync(join(LND, 'lnd')) ? 'lnd (LND_BIN)' : 'gatewayd in FEDIMINT_BIN'}: free rounds only, no paid round` });

  // ---- 5. THE RUNNER: bonds, a free round and a paid round, and the keeper (this file's `runner`) ----
  if (!running('runner')) {
    rmSync(path('runner', 'state.json'), { force: true });
    startPart('runner', process.execPath, [fileURLToPath(import.meta.url), 'runner'], { env: fedEnv({ DEVNET_DIR: D, DEVNET_APPS: APP_FILES.join(',') }) });
  }
  let state = null;
  for (let i = 0; ; i++) {
    try { state = JSON.parse(readFileSync(path('runner', 'state.json'), 'utf8')); } catch { state = null; }
    if (state && (state.status === 'up' || state.status === 'failed')) break;
    if (!running('runner')) throw new Error('the runner exited: see logs/runner.log');
    if (i > 900) throw new Error('the runner did not stand the rounds up in 15 min: see logs/runner.log');
    await wait(1000);
  }
  if (state.status === 'failed') throw new Error(`the runner failed: ${state.why} (logs/runner.log)`);
  // ---- 6. THE PAGE, when a built one is named ----
  if (PAGE_DIR && !running('page'))
    startPart('page', process.execPath, [fileURLToPath(import.meta.url), 'page'], { env: { ...env, DEVNET_DIR: D } });
  const summary = { step: 'up', seconds: Math.round((Date.now() - t0) / 1000), dir: D, chain: { rpc: RPC_URL, cookie: COOKIE(), height: Number(cli('getblockcount')) },
    nodes: NODES, invite, federation: state.federationId, freeRound: state.freeRound, paidRound: state.paidRound || null,
    paidWhy: state.paidWhy || undefined, lobby: state.lobbyUrl, page: PAGE, control: `http://127.0.0.1:${PLAN.control}/state` };
  say(summary);
  console.log(`\ndevnet up in ${summary.seconds} s - ${D}\n  chain     ${RPC_URL} (regtest, cookie ${COOKIE()})\n  nodes     ${NODES.join(' ')}`
    + `\n  invite    ${invite}\n  free      ${state.freeRound}\n  paid      ${state.paidRound || `(none: ${state.paidWhy})`}\n  page      ${state.lobbyUrl}\n`
    + '  next      devnet.mjs status | play | replay | down');
}

/** lncli on one of the devnet's lnds. */
const lncli = (x, ...a) => spawnSync(join(LND, 'lncli'), [`--lnddir=${path(`lnd-${x}`)}`, `--rpcserver=127.0.0.1:${PLAN.lnd[x].rpc}`, '--network=regtest', ...a],
  { encoding: 'utf8', timeout: 30000 });
const gwcli = (x, ...a) => spawnSync(join(FED, 'gateway-cli'), ['--address', `http://127.0.0.1:${PLAN.gateway[x].api}`, '--rpcpassword',
  readFileSync(path(`gateway-${x}`, 'password'), 'utf8').trim(), ...a], { encoding: 'utf8', timeout: 120000, env: fedEnv() });

async function gateways(invite) {
  const t = Date.now();
  for (const x of ['a', 'b']) {
    if (running(`lnd-${x}`)) continue;
    mkdirSync(path(`lnd-${x}`), { recursive: true });
    const l = PLAN.lnd[x];
    startPart(`lnd-${x}`, join(LND, 'lnd'), [`--lnddir=${path(`lnd-${x}`)}`, '--bitcoin.regtest', '--bitcoin.node=bitcoind',
      `--bitcoind.rpchost=127.0.0.1:${PLAN.rpc}`, `--bitcoind.rpccookie=${COOKIE()}`,
      `--bitcoind.zmqpubrawblock=tcp://127.0.0.1:${PLAN.zmqBlock}`, `--bitcoind.zmqpubrawtx=tcp://127.0.0.1:${PLAN.zmqTx}`,
      `--rpclisten=127.0.0.1:${l.rpc}`, `--listen=127.0.0.1:${l.p2p}`, `--restlisten=127.0.0.1:${l.rest}`,
      '--noseedbackup', '--nobootstrap', `--alias=devnet-${x}`]);
  }
  for (const x of ['a', 'b']) {
    for (let i = 0; ; i++) {
      const r = lncli(x, 'getinfo');
      if (r.status === 0 && /"synced_to_chain":\s*true/.test(r.stdout)) break;
      if (!running(`lnd-${x}`)) throw new Error(`lnd ${x} exited: see logs/lnd-${x}.log`);
      if (i > 180) throw new Error(`lnd ${x} did not sync in 180 s: ${String(r.stderr || r.stdout).trim().slice(-200)}`);
      await wait(1000);
    }
  }
  for (const x of ['a', 'b']) {
    if (running(`gateway-${x}`)) continue;
    startPart(`gateway-${x}`, 'bash', [join(HERE, 'testnet4-gateway.sh'), path(`lnd-${x}`), `127.0.0.1:${PLAN.lnd[x].rpc}`, String(PLAN.gateway[x].api),
      path(`gateway-${x}`)], { env: fedEnv() });
  }
  for (const x of ['a', 'b']) {
    for (let i = 0; ; i++) {
      if (existsSync(path(`gateway-${x}`, 'password')) && gwcli(x, 'info').status === 0) break;
      if (!running(`gateway-${x}`)) throw new Error(`gateway ${x} exited: see logs/gateway-${x}.log`);
      if (i > 180) throw new Error(`gateway ${x} did not answer in 180 s: see logs/gateway-${x}.log`);
      await wait(1000);
    }
    // JOINED ONCE: a gateway that already holds a federation (an `up` after a `down`) is not joined again
    const joined = () => { try { return (JSON.parse(gwcli(x, 'info').stdout).federations || []).length > 0; } catch { return false; } };
    if (!joined()) {
      const c = gwcli(x, 'connect-fed', invite);
      if (c.status !== 0 && !joined()) throw new Error(`gateway ${x} did not join the federation: ${String(c.stderr || c.stdout).trim().slice(-300)}`);
    }
  }
  // EACH GUARDIAN BY ITS OWN PEER ID AND ADMIN PASSWORD (<store>.guardian/local.json, admin-password)
  const lists = [];
  for (const k of PLAN.nodes.keys()) {
    const dir = `${storeOf(k)}.guardian`;
    const peer = String(JSON.parse(readFileSync(`${dir}/local.json`, 'utf8')).identity);
    const pw = readFileSync(`${dir}/admin-password`, 'utf8').trim();
    for (const x of ['a', 'b']) fcli(path('clients', 'runner'), ['--our-id', peer, '--password', pw, 'module', 'lnv2', 'gateways', 'add', `http://localhost:${PLAN.gateway[x].api}`]);
    const got = fcli(path('clients', 'runner'), ['module', 'lnv2', 'gateways', 'list', '--peer', peer]);
    lists.push((String(got.stdout).match(/localhost:\d+/g) || []).length);
  }
  say({ step: 'gateways', lnds: 2, gateways: [`http://localhost:${PLAN.gateway.a.api}`, `http://localhost:${PLAN.gateway.b.api}`],
    registeredPerGuardian: lists, seconds: Math.round((Date.now() - t) / 1000) });
}

// =====================================================================================================================
// runner (started by `up`, in its own process group): the bonds, the rounds, the keeper, the block clock, the control door
// =====================================================================================================================
async function runner() {
  const writeState = (o) => { writeFileSync(path('runner', 'state.json.tmp'), JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v), 1) + '\n');
    execFileSync('mv', [path('runner', 'state.json.tmp'), path('runner', 'state.json')]); };
  const state = { status: 'starting', at: new Date().toISOString(), rounds: [] };
  writeState(state);
  try {
    const { stakeLockPort } = await import('../src/stake-lock-port.js');
    const { inviteForGuardians } = await import('../src/invite.js');
    const { bitcoindRpc } = await import('../src/chain-rpc.js');
    const { toHex } = await import('../../arena-protocol/src/hash.js');
    const { decodeRoundContract } = await import('../../arena-protocol/src/contracts.js');
    // THE FIRST BOND OF EACH NODE IS POSTED BY THE ATTACHED RUNNER (round-2of2.mjs): its secret read from the
    // node's own store, read-only, and the advertisement says what the running node says - its endpoint, that it is a
    // guardian and where, and which key of the federation it holds
    process.env.ARENA_POST_FIRST_BONDS = '1';
    const { standUpRound } = await import('./round-2of2.mjs');
    const lock = stakeLockPort({ bin: LOCK, dataDir: path('clients', 'runner') });
    const fed = await lock.guardians();
    if (fed.keys.length !== NODE_COUNT || fed.threshold !== 5) throw new Error(`the federation is ${fed.threshold} of ${fed.keys.length}, not 5 of 7`);
    // EACH NODE ADVERTISES THE KEY ITS OWN GUARDIAN HOLDS: its guardian's peer id (<store>.guardian/local.json) and that peer's
    // broadcast key in the federation's config, as run-testnet4-paid.mjs reads them
    const peers = PLAN.nodes.map((_, k) => {
      const dir = `${storeOf(k)}.guardian`;
      const id = JSON.parse(readFileSync(`${dir}/local.json`, 'utf8')).identity;
      const own = JSON.parse(readFileSync(`${dir}/consensus.json`, 'utf8')).broadcast_public_keys[String(id)];
      const key = fed.keys.find((x) => toHex(x) === own);
      if (!key) throw new Error(`${dir}: its guardian's key (peer ${id}) is not one the federation's config names`);
      return { id: Number(id), key };
    });
    const guardianOf = peers.map((p) => [{ federationId: fed.federationId, guardianKey: p.key }]);
    // THE INVITE NAMES EVERY GUARDIAN, each at its node's /guardian door, by its own peer id
    const invite = inviteForGuardians(fed.federationId, PLAN.nodes.map((port, k) => ({ url: `ws://127.0.0.1:${port}/guardian`, peer: peers[k].id })));
    const cliW = (...a) => cli(...a);
    const rpc = bitcoindRpc({ url: `${RPC_URL}/wallet/${WALLET}`, cookiePath: COOKIE() });
    const stake = BigInt(env.DEVNET_PAID_STAKE_MSAT || 10000000);
    const [pa, pb, ...more] = PLAN.nodes;
    const regs = await registrations();
    const { fromHex } = await import('../../arena-protocol/src/hash.js');
    /** A free round of a game other than nextblock: its game, its core and config (the first the game installed), its whole run. */
    const fieldsOf = (name) => {
      const g = regs.find((x) => x.name === name);
      if (!g) throw new Error(`this devnet hosts no game ${name}: ${regs.map((x) => x.name).join(', ')}`);
      if (g.name === 'nextblock') return {};
      const [coreHash, core] = [...g.cores.entries()][0];
      return { gameId: g.gameId, simCoreHash: fromHex(coreHash), configHash: fromHex([...core.configs.keys()][0]), blockTicks: g.manifest.runTicksMax };
    };
    // THE FIRST ROUND IS THE LOBBY'S FREE ONE, the paid one beside it (openNext): a paid round that a node refuses does not
    // take the devnet down with it - it is said, and the free round still plays
    const round = await standUpRound({ host: '127.0.0.1', portA: pa, portB: pb, extraPorts: more, store: path('runner'), network: 'regtest',
      // each node's own store, read-only, for the secret its first bond is posted with
      storePaths: PLAN.nodes.map((_, k) => storeOf(k)),
      wallet: WALLET, cli: cliW, rpc, federationId: fed.federationId, invite, guardianOf, entryWindowMs: BigInt(FREE_WINDOW_MS),
      signerNode: { closeAtEnd: true }, page: PAGE,
      // THE GAMES THE BONDS ADVERTISE (hostedGames): every game the nodes host, so a round of any of them finds its committee
      plugins: regs,
      attach: { fundedFile: path('runner', 'funded.txt'), proofDir: path('runner', 'proof') } });
    Object.assign(state, { federationId: toHex(fed.federationId), invite, lobbyUrl: round.lobbyUrl, roundUrl: round.url, freeRound: round.id });
    const contractOf = async (id) => {
      const r = await fetch(`${nodeUrl(0)}/round?id=${id}`);
      if (!r.ok) throw new Error(`node 1 holds no round ${id.slice(0, 16)}: ${r.status}`);
      return decodeRoundContract(new Uint8Array(await r.arrayBuffer()));
    };
    const note = async (id, kind) => {
      const c = await contractOf(id);
      state.rounds.push({ id, kind, stakeMsat: String(c.stakeMsat), startMs: Number(c.startTimeMs), entryCloseMs: Number(c.entryCloseMs),
        start: new Date(Number(c.startTimeMs)).toISOString(), entryClose: new Date(Number(c.entryCloseMs)).toISOString() });
      state.rounds = state.rounds.slice(-40);
      state.at = new Date().toISOString();
      writeState(state);
    };
    await note(round.id, 'free');
    // ONE OPENING AT A TIME: the keeper, a play and the block clock all mine and fund on the one wallet
    let chain = Promise.resolve();
    const serial = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
    const open = (kind, fields) => serial(async () => { const id = await round.openNext(fields); await note(id, kind); return id; });
    try { state.paidRound = await open('paid', { stakeMsat: stake, entryAfterStartMs: PAID_WINDOW_MS }); }
    catch (e) { state.paidWhy = e.message; console.error(`[devnet] the paid round was not opened: ${e.message}`); }
    state.status = 'up';
    writeState(state);
    console.log(`[devnet] up: free ${round.id} paid ${state.paidRound || '-'} lobby ${round.lobbyUrl}`);

    // THE KEEPER: a free and a paid round always open for entries in the lobby
    const kinds = [['free', { stakeMsat: 0n, entryAfterStartMs: FREE_WINDOW_MS }], ...(state.paidRound ? [['paid', { stakeMsat: stake, entryAfterStartMs: PAID_WINDOW_MS }]] : [])];
    setInterval(() => {
      for (const [kind, fields] of kinds) {
        if (state.rounds.some((r) => r.kind === kind && r.entryCloseMs > Date.now() + KEEP_LEAD_MS) || state.opening === kind) continue;
        state.opening = kind;
        open(kind, fields).then((id) => console.log(`[keeper] ${kind} ${id}`), (e) => console.error(`[keeper] ${kind} not opened: ${e.message}`))
          .finally(() => { state.opening = null; });
      }
    }, 15000);
    // THE BLOCK CLOCK: the chain moves on its own once the rounds are up
    const every = Number(env.DEVNET_BLOCK_SECONDS ?? 30);
    if (every > 0) setInterval(() => serial(async () => cli('generatetoaddress', '1', cli('getnewaddress'))).catch((e) => console.error(`[clock] ${e.message}`)), every * 1000);
    // THE CONTROL DOOR, 127.0.0.1 only: GET /state; POST /open-free?windowMs= opens a free round for one play
    const { createServer } = await import('node:http');
    createServer(async (req, res) => {
      const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      try {
        const u = new URL(req.url, 'http://x');
        if (req.method === 'GET' && u.pathname === '/state') return send(200, state);
        if (req.method === 'POST' && u.pathname === '/open-free') {
          const windowMs = Math.max(30000, Math.min(Number(u.searchParams.get('windowMs') || PLAY_WINDOW_MS), 3600000));
          const fields = fieldsOf(u.searchParams.get('game') || 'nextblock');
          const id = await open('play', { stakeMsat: 0n, entryAfterStartMs: windowMs, fields });
          return send(201, state.rounds.find((r) => r.id === id));
        }
        send(404, { why: 'GET /state, POST /open-free' });
      } catch (e) { send(500, { why: e.message }); }
    }).listen(PLAN.control, '127.0.0.1');
  } catch (e) {
    Object.assign(state, { status: 'failed', why: e.message, at: new Date().toISOString() });
    writeState(state);
    console.error(e.stack || e.message);
    process.exit(1);
  }
}

// =====================================================================================================================
// page (with DEVNET_PAGE_DIR): the built page, served as games-regtest.mjs serves it
// =====================================================================================================================
async function page() {
  const { servePage } = await import('./round-2of2.mjs');
  const s = await servePage(PAGE_DIR, { host: '127.0.0.1', port: PLAN.page });
  console.log(`[page] ${PAGE_DIR} on http://127.0.0.1:${s.port}`);
}

// =====================================================================================================================
// status
// =====================================================================================================================
async function status() {
  const parts = PARTS.map((n) => { const p = readPid(n); return p ? { name: n, pid: p.pid, running: alive(p.pid), since: p.started } : null; }).filter(Boolean);
  let tip = null;
  if (BTC && running('bitcoind')) { try { tip = Number(cli('getblockcount')); } catch (e) { tip = `no answer: ${e.message.slice(0, 80)}`; } }
  const nodes = await Promise.all(PLAN.nodes.map(async (port, k) => {
    const out = { node: k + 1, port, up: await answers(port) };
    if (!out.up) return out;
    try { const g = await getJson(`${nodeUrl(k)}/guardian`, 5000); out.guardian = g.guardian === true; out.guardianApi = await answers(PLAN.guardians[k].api); } catch (e) { out.guardian = e.message; }
    return out;
  }));
  let rounds = [];
  if (nodes[0].up) {
    try {
      const list = (await getJson(`${nodeUrl(0)}/rounds?all=1`, 10000)).rounds || [];
      rounds = list.map((r) => ({ id: r.id, game: r.game && r.game.name, stakeMsat: r.stakeMsat, entryOpen: r.entryOpen,
        start: r.startTimeMs ? new Date(Number(r.startTimeMs)).toISOString() : undefined, entryClose: r.entryCloseMs ? new Date(Number(r.entryCloseMs)).toISOString() : undefined }));
    } catch (e) { rounds = [{ error: e.message }]; }
  }
  let runnerState = null;
  try { const s = JSON.parse(readFileSync(path('runner', 'state.json'), 'utf8')); runnerState = { status: running('runner') ? s.status : `not running (it last said ${s.status})`, freeRound: s.freeRound, paidRound: s.paidRound, paidWhy: s.paidWhy, lobby: s.lobbyUrl, opened: s.rounds.length }; } catch { /* none yet */ }
  const ports = await Promise.all(PLAN.all.map(async (x) => ({ ...x, listening: await answers(x.port) })));
  say({ step: 'status', dir: D, parts, tip, nodes, runner: runnerState,
    listening: ports.filter((x) => x.listening).map((x) => x.port), notListening: ports.filter((x) => !x.listening && x.what !== 'page' && x.what !== 'bitcoind p2p' && !x.what.endsWith(' iroh')).map((x) => `${x.port} ${x.what}`),
    rounds: rounds.slice(-12) });
}

// =====================================================================================================================
// play: one headless entry through a free round, end to end, and each seat's signed result
// =====================================================================================================================
async function play() {
  const { toHex, fromHex, sha256 } = await import('../../arena-protocol/src/hash.js');
  const { decodeRoundContract, roundId, encodeEntryContract, entryId } = await import('../../arena-protocol/src/contracts.js');
  const { worldIsShared } = await import('../../arena-protocol/src/seed.js');
  const { sharedWorldOf } = await import('../../arena-protocol/src/known-game.js');
  const { worldSeedFor } = await import('../../arena-client/src/join.js');
  const { encodeInputBatch, batchId } = await import('../../arena-protocol/src/batch.js');
  const { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } = await import('../../arena-protocol/src/checkpoint.js');
  const { SIGNED_RECEIPT_BYTES } = await import('../../arena-protocol/src/receipt.js');
  const { receiptsNeeded } = await import('../../arena-protocol/src/threshold.js');
  const { roundEndMs } = await import('../../arena-protocol/src/first-mark.js');
  const { cutSignedResults, splitSignedResult, decodePlayerResult, resultId } = await import('../../arena-protocol/src/result.js');
  const { drivenTape, bedFrom, GENESIS_HASH } = await import('../test/window-fixture.js');
  const { NEXTBLOCK_CORES } = await import('../../nextblock/plugin/truck-cores.js');
  const { schnorr, secp256k1 } = await import('@noble/curves/secp256k1.js');
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { default: WebSocket } = await import('ws');
  const { randomBytes } = await import('node:crypto');
  const t0 = Date.now();
  const rand = (n) => new Uint8Array(randomBytes(n));
  // ---- THE ROUND: the one named, else a free round the runner opens for this play ----
  const args = process.argv.slice(3);
  const gameAt = args.indexOf('--game');
  const gameName = gameAt >= 0 ? args[gameAt + 1] : 'nextblock';
  let rid = args.find((a, i) => /^[0-9a-f]{64}$/.test(a) && args[i - 1] !== '--game');
  if (!rid) {
    const r = await fetch(`http://127.0.0.1:${PLAN.control}/open-free?game=${encodeURIComponent(gameName)}`, { method: 'POST', signal: AbortSignal.timeout(600000) }).catch((e) => { throw new Error(`the runner does not answer on ${PLAN.control} (${e.message}): run up first`); });
    const got = await r.json();
    if (!r.ok) throw new Error(`the runner opened no round: ${got.why}`);
    rid = got.id;
  }
  const copies = await Promise.all(NODES.map(async (n) => { try { const x = await fetch(`${n}/round?id=${rid}`); return x.ok ? toHex(new Uint8Array(await x.arrayBuffer())) : `HTTP ${x.status}`; } catch (e) { return `down ${e.message}`; } }));
  if (new Set(copies).size !== 1 || !/^[0-9a-f]+$/.test(copies[0])) throw new Error(`the seven nodes do not all hold round ${rid.slice(0, 16)}: ${copies.map((h) => h.slice(0, 12)).join(' ')}`);
  const c = decodeRoundContract(fromHex(copies[0]));
  if (toHex(roundId(c)) !== rid) throw new Error('the nodes answered another round');
  if (c.stakeMsat !== 0n) throw new Error(`round ${rid.slice(0, 16)} takes a stake of ${c.stakeMsat} msat: play drives free rounds only`);
  say({ step: 'round', id: rid, game: gameName, seats: copies.length, start: new Date(Number(c.startTimeMs)).toISOString(), entryClose: new Date(Number(c.entryCloseMs)).toISOString(), blockTicks: c.blockTicks });
  // ---- THE ENTRY: a free one - no stake, no shares, no lock - under a fresh player key and session key ----
  let sk; do { sk = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(sk, true)[0] !== 0x02);
  const player = schnorr.getPublicKey(sk);
  const session = ed25519.utils.randomSecretKey();
  const z32 = new Uint8Array(32);
  const entry = { roundId: fromHex(rid), playerPubkey: player, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(rand(32)),
    stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0,
    worldSecret: worldIsShared(c, sharedWorldOf(c.gameId)) ? z32 : rand(32), vssSharesRef: z32, stakePoint: new Uint8Array(33),
    feePreimage: z32, stakeLockOutpoint: { txid: z32, outIdx: 0n }, feeLockOutpoint: { txid: z32, outIdx: 0n }, claimKeyAttestationRef: z32 };
  const eid = toHex(entryId(entry));
  const took = await Promise.all(NODES.map(async (n) => { const r = await fetch(`${n}/entry`, { method: 'POST', body: encodeEntryContract(entry) }); return { node: n, status: r.status, said: (await r.text()).slice(0, 120) }; }));
  say({ step: 'entry', entry: eid, took: took.filter((x) => x.status < 300).length, refused: took.filter((x) => x.status >= 300) });
  if (took.filter((x) => x.status < 300).length < receiptsNeeded(c.nodes.length)) throw new Error('fewer seats than needed took the entry');
  mkdirSync(path('plays'), { recursive: true });
  writeFileSync(path('plays', `${eid}.json`), JSON.stringify({ round: rid, entry: eid, entryHex: toHex(encodeEntryContract(entry)), at: new Date().toISOString() }) + '\n');
  // ---- THE RUN: the world the round's randomness seeds, played by the round's own core. Nextblock is driven to the gate
  // (window-fixture drivenTape, the truck's closed-loop driver, with the bed's load at tick 0); any other game presses a
  // fixed pattern of first words (0 .. 9), the other four 0 - enough to show its core, its marks and its replay agree ----
  const seed = await worldSeedFor({ entry, round: rid, nodes: NODES, contract: c });
  const reg = (await registrations()).find((g) => toHex(g.gameId) === toHex(c.gameId));
  if (!reg) throw new Error(`round ${rid.slice(0, 16)} is a game this devnet does not host`);
  const truck = reg.name === 'nextblock';
  const core = truck ? NEXTBLOCK_CORES.get(toHex(c.simCoreHash)) : reg.cores.get(toHex(c.simCoreHash));
  if (!core) throw new Error(`the round names core ${toHex(c.simCoreHash).slice(0, 16)}, which ${reg.name} does not install`);
  const config = core.configs.get(toHex(c.configHash)) || {};
  const N = c.blockTicks, FIRST = Math.min(60, c.blockTicks);
  const loadsAt0 = truck ? bedFrom(0) : [];
  const drive = truck ? drivenTape(seed.seedWord, N) : { tape: Array.from({ length: N }, (_, t) => [(t * 7 + 3) % 10, 0, 0, 0, 0]) };
  const A = truck ? core.adapter : (await import(core.url)).CORE;
  const st = A.start(seed.seedWord, config, { runTicks: N, ...(seed.slot === undefined ? {} : { slot: seed.slot }) });
  const ev = A.eventsOf({ loads: loadsAt0 });
  const stateAt = [];
  for (let t = 0; t < N; t++) { ev.before(st, t); A.step(st, drive.tape[t]); if (t + 1 === FIRST || t + 1 === N) stateAt[t + 1] = A.stateHash(st); }
  const local = A.result(st);
  say({ step: 'driven locally', seedWord: seed.seedWord, ticks: N, outcome: local.outcome, score: local.score, finalState: stateAt[N] });
  // ---- ITS BATCHES AND MARKS, as the page publishes them: 60 ticks and a first mark, then 600 at a time and a last mark ----
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const msgs = [];
  let previousHash = GENESIS_HASH, previousMark = NO_PREVIOUS;
  for (let from = 0; from < N;) {
    const to = from === 0 ? FIRST : Math.min(N, from + 600);
    const b = { roundId: fromHex(rid), entryId: fromHex(eid), previousHash, firstTick: from, ticks: drive.tape.slice(from, to), liquidations: [], loads: from === 0 ? loadsAt0 : [] };
    msgs.push([encodeInputBatch(b), `batch ${from}..${to - 1}`]);
    previousHash = batchId(b);
    if (to === FIRST || to === N) {
      const m = { roundId: fromHex(rid), entryId: fromHex(eid), tick: to, stateHash: fromHex(stateAt[to]), inputChainHash: previousHash, previousHash: previousMark, sessionPubkey: entry.sessionPubkey };
      msgs.push([sign(m), `mark ${to}`]);
      previousMark = checkpointId(m);
    }
    from = to;
  }
  const sayAt = (node, message) => new Promise((ok, no) => {
    const ws = new WebSocket(`${node.replace(/^http/, 'ws')}/play`);
    const t = setTimeout(() => { try { ws.close(); } catch { /* closed */ } no(new Error('no answer in 20 s')); }, 20000);
    ws.on('open', () => ws.send(message));
    ws.on('message', (d, bin) => { clearTimeout(t); ok(bin ? new Uint8Array(d) : d.toString()); ws.close(); });
    ws.on('error', (e) => { clearTimeout(t); no(e); });
  });
  const waitMs = Number(c.startTimeMs) - Date.now() + 2000;
  if (waitMs > 0) { say({ step: 'waiting for the start', seconds: Math.round(waitMs / 1000) }); await wait(waitMs); }
  const published = await Promise.all(NODES.map(async (n) => {
    // a batch is answered with the ticks it stored, a mark with the seat's signed receipt for it
    let receipts = 0, batches = 0; const other = [];
    for (const [m, kind] of msgs) {
      let got; try { got = await sayAt(n, m); } catch (e) { got = `error ${e.message}`; }
      if (got instanceof Uint8Array && got.length === SIGNED_RECEIPT_BYTES) receipts++;
      else if (kind.startsWith('batch') && /^\d+$/.test(String(got))) batches++;
      else other.push(`${kind}: ${got instanceof Uint8Array ? `${got.length} bytes` : String(got).slice(0, 80)}`);
    }
    return { node: n, batches, receipts, ...(other.length ? { other: other.slice(0, 3) } : {}) };
  }));
  say({ step: 'published', batches: msgs.filter(([, k]) => k.startsWith('batch')).length, marks: msgs.filter(([, k]) => k.startsWith('mark')).length,
    batchesTakenPerSeat: published.map((p) => p.batches), receiptsPerSeat: published.map((p) => p.receipts), refused: published.filter((p) => p.other) });
  // ---- THE CLOSE: each seat closes the round at its end, replays the run in the core's sandbox and signs a result ----
  const endMs = Number(roundEndMs(c));
  say({ step: 'waiting for the close', roundEnd: new Date(endMs).toISOString(), seconds: Math.max(0, Math.round((endMs - Date.now()) / 1000)) });
  if (endMs > Date.now()) await wait(endMs - Date.now());
  const needed = receiptsNeeded(c.nodes.length);
  let signed = [];
  for (const until = Date.now() + 10 * 60000; Date.now() < until;) {
    signed = [];
    for (const n of NODES) {
      try {
        const r = await fetch(`${n}/results?round=${rid}&entry=${eid}`);
        for (const one of cutSignedResults(new Uint8Array(await r.arrayBuffer()))) {
          const { body, signature } = splitSignedResult(one);
          const res = decodePlayerResult(body);
          let ok = false; try { ok = schnorr.verify(signature, resultId(res), res.nodePubkey); } catch { ok = false; }
          signed.push({ seat: n, signer: toHex(res.nodePubkey), outcome: res.outcome, score: res.score, transcriptHash: toHex(res.transcriptHash), signatureValid: ok, bytes: toHex(one) });
        }
      } catch { /* asked again */ }
    }
    const distinct = new Map(signed.filter((s) => s.signatureValid).map((s) => [s.signer, s]));
    if (distinct.size >= needed) break;
    await wait(5000);
  }
  const bySigner = [...new Map(signed.filter((s) => s.signatureValid).map((s) => [s.signer, s])).values()];
  const agree = bySigner.filter((s) => s.outcome === bySigner[0]?.outcome && s.score === bySigner[0]?.score && s.transcriptHash === bySigner[0]?.transcriptHash);
  const final = agree.length >= needed;
  say({ step: 'signed result', round: rid, entry: eid, signers: bySigner.length, agreeing: agree.length, needed, final,
    outcome: agree[0]?.outcome ?? null, score: agree[0]?.score ?? null, transcriptHash: agree[0]?.transcriptHash ?? null,
    localOutcome: local.outcome, localScore: local.score, sameAsLocal: !!agree[0] && agree[0].outcome === local.outcome && agree[0].score === local.score,
    signatures: bySigner.map((s) => ({ signer: s.signer.slice(0, 16), outcome: s.outcome, score: s.score, valid: s.signatureValid })),
    oneSignedResult: agree[0]?.bytes ?? null, seconds: Math.round((Date.now() - t0) / 1000) });
  if (!final) process.exitCode = 1;
}

// =====================================================================================================================
// replay [round entry]: the replay simulator - a seat's stored transcript replayed here, by the node's own replay
// =====================================================================================================================
async function replayCmd() {
  const { toHex, fromHex } = await import('../../arena-protocol/src/hash.js');
  const { decodeRoundContract, decodeEntryContract } = await import('../../arena-protocol/src/contracts.js');
  const { decodeTranscript, flatten, transcriptHash } = await import('../../arena-protocol/src/transcript.js');
  const { cutSignedResults, splitSignedResult, decodePlayerResult } = await import('../../arena-protocol/src/result.js');
  const { decodeCheckpoint, CHECKPOINT_BYTES, SIGNED_CHECKPOINT_BYTES } = await import('../../arena-protocol/src/checkpoint.js');
  const { hostedPlugins, pluginForRound } = await import('../src/plugins.js');
  const { replay } = await import('../src/replay.js');
  let [rid, eid] = process.argv.slice(3);
  if (!rid || !eid) {
    // the newest play, by default
    const plays = existsSync(path('plays')) ? readdirSync(path('plays')).map((f) => JSON.parse(readFileSync(path('plays', f), 'utf8'))).sort((a, b) => (a.at < b.at ? -1 : 1)) : [];
    if (!plays.length) throw new Error('replay <round> <entry>, or play first');
    ({ round: rid, entry: eid } = plays[plays.length - 1]);
  }
  const bin = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: ${r.status} ${(await r.text()).slice(0, 120)}`); return { bytes: new Uint8Array(await r.arrayBuffer()), headers: r.headers }; };
  const c = decodeRoundContract((await bin(`${nodeUrl(0)}/round?id=${rid}`)).bytes);
  const entry = decodeEntryContract((await bin(`${nodeUrl(0)}/entry?id=${eid}`)).bytes);
  const randomness = (await bin(`${nodeUrl(0)}/randomness?round=${rid}`)).bytes;
  const t = decodeTranscript((await bin(`${nodeUrl(0)}/transcript?round=${rid}&entry=${eid}`)).bytes);
  // THE PLAYER'S SIGNED MARKS, as the seat received them: /transcript hands the inputs without them (round.js handOver), and
  // the transcript every seat receipted and signed a result over carries them - put back, its hash is the signed one, and
  // the replay checks each mark's state against its own
  const cps = (await bin(`${nodeUrl(0)}/checkpoints?round=${rid}&entry=${eid}`)).bytes;
  t.marks = Array.from({ length: Math.floor(cps.length / SIGNED_CHECKPOINT_BYTES) }, (_, i) => cps.subarray(i * SIGNED_CHECKPOINT_BYTES, (i + 1) * SIGNED_CHECKPOINT_BYTES));
  const marks = t.marks.map((m) => decodeCheckpoint(m.subarray(0, CHECKPOINT_BYTES)));
  // THE GAMES THIS DEVNET'S NODES HOST, checked as a node checks them (plugins.js), and the round's core, config and world
  const found = pluginForRound(c, hostedPlugins(await registrations()));
  if (!found.ok) throw new Error(found.why);
  const core = { ...found.core, config: found.config, runTicks: found.runTicks,
    world: { configHash: c.configHash, censusRoot: c.censusRoot, roundId: fromHex(rid), sharedWorld: [...found.plugin.sharedWorld] } };
  const flat = flatten(t);
  const inputs = { ...flat, ticks: flat.ticks.map((words, i) => ({ tick: flat.firstTick + i, words: [...words] })) };
  const t0 = Date.now();
  const got = replay(inputs, entry, { core, roundRandomness: randomness, marks });
  const signed = [];
  for (const n of NODES) {
    try { for (const one of cutSignedResults((await bin(`${n}/results?round=${rid}&entry=${eid}`)).bytes)) { const r = decodePlayerResult(splitSignedResult(one).body); signed.push({ signer: toHex(r.nodePubkey).slice(0, 16), outcome: r.outcome, score: r.score, transcriptHash: toHex(r.transcriptHash) }); } }
    catch { /* a seat that holds none */ }
  }
  const signers = [...new Map(signed.map((s) => [s.signer, s])).values()];
  const th = toHex(transcriptHash(t));
  say({ step: 'replay', round: rid, entry: eid, core: got.coreHash || toHex(c.simCoreHash), ms: Date.now() - t0, ok: got.ok, why: got.why,
    outcome: got.outcome, score: got.score, ticks: got.ticks, stateHash: got.stateHash, marksChecked: got.checked, marksAgree: got.agrees, transcriptHash: th,
    seatsSigned: signers.length, seatsAgreeWithThisReplay: signers.filter((s) => s.outcome === got.outcome && s.score === got.score && s.transcriptHash === th).length });
}

// =====================================================================================================================
// new-game <dir> [name]: the game template copied, its developer keys made, its manifest signed, and checked as a node checks it
// =====================================================================================================================
async function newGame() {
  const [dirArg, nameArg] = process.argv.slice(3);
  if (!dirArg) throw new Error('new-game <dir> [name]: the directory your game lives in, and its name (default coin-count)');
  const dir = resolve(dirArg), name = nameArg || 'coin-count';
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw new Error(`a game name is lower-case letters, digits and dashes, 2 to 31: not ${name}`);
  const title = name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  const T = join(HERE, 'devnet-template');
  const fill = (text) => text.replaceAll('__PROTOCOL__', pathToFileURL(resolve(NODE_PKG, '..', 'arena-protocol', 'src')).href)
    .replaceAll('__NAME__', name).replaceAll('__TITLE__', title);
  mkdirSync(join(dir, 'dev'), { recursive: true });
  // the template's files, never over a file the developer already changed
  for (const f of ['core.js', 'body.mjs', 'game.js']) {
    if (existsSync(join(dir, f))) continue;
    const text = readFileSync(join(T, f), 'utf8');
    writeFileSync(join(dir, f), f === 'core.js' ? text.replace("name: 'coin-count'", `name: '${name}'`) : fill(text));
  }
  // THE DEVELOPER'S TWO KEYS, made by the dev client and kept in dev/ (readable by the developer only; a node never sees them):
  // the donation key (key.json: where the game's share of the donations is paid) and the Ed25519 game key that signs the manifest
  const donor = join(NODE_PKG, '..', 'arena-donor', 'bin', 'arena-donor.mjs');
  const dev = (args) => { const r = spawnSync(process.execPath, [donor, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`arena-donor ${args[0]}: ${String(r.stderr || r.stdout).trim().slice(-300)}`); return r.stdout; };
  if (!existsSync(join(dir, 'dev', 'key.json'))) dev(['init', join(dir, 'dev'), '--label', `${name} dev`]);
  if (!existsSync(join(dir, 'dev', 'game-dev.pkcs8'))) dev(['game-key', join(dir, 'dev')]);
  const signed = JSON.parse(dev(['sign', join(dir, 'dev'), join(dir, 'body.mjs')]).trim().split('\n').pop());
  // AS A NODE CHECKS IT: signature, core hash, the core loaded in its sandbox, configs, donation set
  const { hostedPlugins } = await import('../src/plugins.js');
  const { GAME } = await import(pathToFileURL(join(dir, 'game.js')).href);
  const hosted = hostedPlugins([GAME]);
  const { toHex } = await import('../../arena-protocol/src/hash.js');
  say({ step: 'new game', name, dir, gameId: signed.gameId, core: [...GAME.cores.keys()][0], hostedAs: [...hosted.keys()][0] === toHex(GAME.gameId),
    next: `DEVNET_APPS=${join(dir, 'game.js')} devnet.mjs up   (then: devnet.mjs play --game ${name})` });
}

// =====================================================================================================================
// down: everything `up` started, by its pid files, and a check that nothing of it is left
// =====================================================================================================================
async function down() {
  const stopped = [];
  // the runner and the page first (they post to the nodes), then the nodes with their guardians, then the chain
  for (const n of ['runner', 'page', ...PLAN.nodes.map((_, k) => `node-${k + 1}`).reverse(), 'gateway-a', 'gateway-b', 'lnd-a', 'lnd-b', 'bitcoind']) {
    const s = await stopPart(n, n === 'bitcoind' ? 60000 : 20000);
    if (s) stopped.push(s);
  }
  const left = [];
  for (const x of PLAN.all) if (await answers(x.port)) left.push(`${x.port} (${x.what})`);
  say({ step: 'down', stopped: stopped.map((s) => `${s.name} ${s.pid}${s.wasRunning ? '' : ' (was not running)'}${s.killed ? ' KILLED' : ''}`),
    allGone: stopped.every((s) => s.gone), portsStillAnswering: left, dir: D, kept: 'the directory is kept: up starts on it again' });
  if (left.length || !stopped.every((s) => s.gone)) process.exitCode = 1;
}

const cmd = process.argv[2];
const run = { up, runner, page, status, play, replay: replayCmd, down, 'new-game': newGame }[cmd];
if (!run) { console.error('devnet.mjs up | status | play [round] [--game name] | replay [round entry] | down | new-game <dir> [name]     (DEVNET_DIR, DEVNET_BASE_PORT, BITCOIN_BIN, FEDIMINT_BIN)'); process.exit(2); }
run().catch((e) => { console.error(`devnet ${cmd}: ${e.message}`); process.exit(1); });
