// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// One process, one round.
//
//     node src/main.js [port] [database]
//
// The database defaults to a file so a round survives the process; pass
// `:memory:` for a node that forgets, which is what the tests use.
//
// CHAIN ACCESS COMES FROM TWO SETTINGS AND NO OTHERS:
//
//     ARENA_BITCOIND_URL      the bitcoind RPC, e.g. http://127.0.0.1:8332/
//     ARENA_BITCOIND_COOKIE   the path of its .cookie file
//     ARENA_FUNDED_ROUNDS     round ids this operator funds (paying rounds only)
//     ARENA_FUNDED_ROUNDS_FILE  the same, one id per line, read on every ask
//     ARENA_STAKE_LOCK_BIN    blwp-stake-lock (tools/stake-lock), for stake-lock rounds
//     ARENA_FEDERATION_CLIENT_DIR  the data dir of a client joined to the round's federation
//
// AND WHAT A LAUNCHER USED TO HAND ITS IN-PROCESS NODES, for nodes that run as their own processes (attach, the owner
// 2026-09-29: the seven blwp-tn4-node units own the guardians; tools/run-testnet4-paid.mjs ARENA_ATTACH=1):
//     ARENA_CLOSE_AT_END=1         this node closes every round that is over, itself
//     ARENA_PRICE_FEED=1           this node reads BTC/USD every 5 s and signs the price samples of its nextblock rounds (§11)
//     ARENA_DONATION_NETWORK       regtest | testnet4: the network's signed test donation set, which the rounds name - and
//                                 the chain this seat reads, for the network store
//     ARENA_FEDERATION_INVITE      the federation invite this seat hands out with its network (GET /network)
//     ARENA_ATTACH_PROOF_DIR       the launcher's headers.bin and bond.json, served on GET /headers and GET /bond,
//                                 read at every ask (the launcher writes them once the nodes are up)
//     ARENA_APPS                   the apps this node hosts: registration modules, comma-separated, each exporting GAME
//                                 (§0A.4: none given hosts none - the engine names no game;
//                                 the installer writes the apps a node ships with - apps= in arena.conf, kanban #569)
//     ARENA_SERIES_FILE            the series this node holds: one Round Contract template per line, hex (serve's
//                                 `series`). Measured 2026-09-29: without it a node process could hold no series at all,
//                                 so every series round was refused - the doors were proved only on in-process nodes.
//
// Both or neither. With them the daemon can read each round's beacon and derive each round's census - which is where it
// learns the other signer nodes' addresses, from the advertisements in their bonds. (It no longer finds a pool output or
// sends a pool payout: that was the withdrawn custody's, §23.6, RULED 2026-09-25.)
//
// HOW FAR BACK A CENSUS IS READ: CENSUS_LOOKBACK blocks before a round's
// census height. A bond funded earlier than that is not seen by a restarted
// daemon, and a round whose committee holds one is refused by name.
const CENSUS_LOOKBACK = 2016;
import { TESTNET4_DONATION_SET } from '../../arena-protocol/src/testnet4-donation-set.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../arena-protocol/src/testnet4-donation-set-keys.js';
import { openStore } from './store.js';
import { tipHeaderView } from './tip-view.js';
import { isOldTestnet4Id, isOldTestnet4Series, OLD_TESTNET4_SERIES_BOND_HEIGHT } from '../../arena-protocol/src/old-series.js';
import { bitcoindRpc, blocksOver, blockCache, censusWithFreshHashes, viewWithFreshHashes } from './chain-rpc.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { chainBeacon } from './beacon-source.js';
import { lightningFromEnv } from './node-start.js';
import { stakeLocksFromEnv } from './stake-lock-port.js';
import { fundingFromEnv } from './funding.js';
import { startNode } from './node-start.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { hostsFromEnv, hostsReader } from './hosts.js';
import { statSync, readFileSync, existsSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { votesInBlock } from '../../arena-protocol/src/ballot-chain.js';
import { PROTOCOL_VERSION } from '../../arena-protocol/src/constants.js';
import { censusOfView, censusReplacer, censusReviver } from './roster.js';
import { readSeriesLines } from './series-line.js';
import { TEST_DONATION_SET_REGTEST, TEST_DONATION_SET_TESTNET4, TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS } from '../../arena-protocol/src/test-donation-sets.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { installFetchRoutes } from './fetch-routes.js';
import { serviceLog } from './log-level.js';
// THE SEAT'S OWN FETCHES ROUTED AND CAPPED, before anything is asked of a peer (fetch-routes.js)
{ const f = installFetchRoutes(process.env); console.log(`[fetch] ${f.routes} route(s), at most ${f.maxPerOrigin} request(s) in flight per origin, ${f.timeoutMs} ms timeout`); }
// HOW MUCH THE SEAT LOGS (kanban #693, 2026-10-26: "add a --debug and --verbose flag that shows more info on what its doing, what is going
// wrong etc"): ARENA_LOG_LEVEL - arena.conf log_level becomes it (run.js) - read once, here. info: as always. verbose: its failed requests
// and the settings that shaped its start; debug: every request it makes and answers, and every program it runs with its exit code
const seatLog = serviceLog({ env: process.env, tag: 'log' });
seatLog.tag('log').env(['ARENA_BITCOIND_URL', 'ARENA_BITCOIND_COOKIE', 'ARENA_LNCLI', 'ARENA_LND_DIR', 'ARENA_LND_RPC', 'ARENA_LND_NETWORK', 'ARENA_STAKE_LOCK_BIN',
  'ARENA_FEDERATION_CLIENT_DIR', 'ARENA_FEDIMINTD', 'ARENA_FOUNDING', 'ARENA_APPS', 'ARENA_DONATION_NETWORK', 'ARENA_BIND', 'ARENA_TLS_CERT', 'ARENA_CLOSE_AT_END', 'ARENA_PRICE_FEED'],
  'the settings that decide how this seat starts (chain, Lightning, custody, apps, network, address)');

const port = Number(process.argv[2] || 8080);
const path = process.argv[3] || 'round.db';
const host = process.env.ARENA_BIND || '127.0.0.1';
const url = process.env.ARENA_BITCOIND_URL || '';
const cookiePath = process.env.ARENA_BITCOIND_COOKIE || '';
if (Boolean(url) !== Boolean(cookiePath)) {
  console.error('ARENA_BITCOIND_URL and ARENA_BITCOIND_COOKIE go together: set both, or neither');
  process.exit(2);
}

// LIGHTNING COMES FROM FOUR SETTINGS, ALL OR NONE - ARENA_LNCLI, ARENA_LND_DIR, ARENA_LND_RPC,
// ARENA_LND_NETWORK - parsed in `node-start.js` (lightningFromEnv). It is used to READ an invoice (what the federation's
// LNv2 invoice commits to) and nothing else. It no longer holds stakes, and there is no start-up ask
// about a stake died inside a settle: the hold invoice was the withdrawn Lightning custody's, and the custody field has one
// value, FEDERATION (§23.6, RULED 2026-09-22 22:59).
const ln = lightningFromEnv(process.env);
// AND THE ROUND'S FEDERATION, when this node takes stake-lock rounds (23.1
// step 5): ARENA_STAKE_LOCK_BIN and ARENA_FEDERATION_CLIENT_DIR, both or neither.
const fed = stakeLocksFromEnv(process.env);
if (!fed.ok) { console.error(fed.why); process.exit(2); }
if (!ln.ok) {
  console.error(ln.why);
  process.exit(2);
}

const db = openStore(path);
// THE GAMES THIS NODE HOSTS (§0A.4): the registration modules ARENA_APPS names, each exporting GAME -
// a manifest as its developer signed it with the dev client (public bytes only), the cores installed for it, its replay
// page. The node verifies the signature and refuses a manifest that does not stand (plugins.js); it holds no developer
// key and never signs a game. NONE BY DEFAULT: the engine names no app. The installer names the apps a node ships with (its apps
// step, every app selected; apps= in arena.conf, kanban #569).
const apps = [];
// A TREE THAT HOLDS ONLY ITS APPS' PINS (kanban #575: bitcoin-arena no longer carries the apps, a release neither): an ARENA_APPS file that
// is not there is fetched at its pin first (app-fetch.js), the checked files kept in .apps/ of this tree; a seat that cannot get them stops
{
  const named = (process.env.ARENA_APPS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (named.some((at) => !existsSync(resolvePath(at)))) {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const { ensureApps } = await import('./app-fetch.js');
    const r = await ensureApps({ release: root, home: process.env.ARENA_HOME || resolvePath(root, '.apps'), log: (l) => console.log(`[apps] ${l}`) });
    if (!r.ok) { console.error(`[apps] the apps could not be fetched: ${r.why}`); process.exit(3); }
  }
}
for (const at of (process.env.ARENA_APPS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
  const m = await import(pathToFileURL(resolvePath(at)).href);
  if (!m.GAME) throw new Error(`ARENA_APPS names ${at}, which exports no GAME`);
  apps.push(m.GAME);
}
// AND THE GAMES ITS OWNER INSTALLED FROM OTHER SEATS (plugin-package.js): each package checked again -
// manifest, donation set, every file's hash, the scan - before it is loaded; a refused one is said and left out
const pluginsDir = process.env.ARENA_PLUGINS_DIR || `${path}.plugins`;
{
  const { loadInstalled } = await import('./plugin-package.js');
  const { verifyEd25519 } = await import('./ed25519.js');
  const got = await loadInstalled(pluginsDir, { verify: verifyEd25519 });
  for (const r of got.refused) console.error(`[games] installed game refused: ${r.dir}: ${r.why}`);
  for (const g of got.registrations) if (!apps.some((x) => Buffer.from(x.gameId).equals(Buffer.from(g.gameId)))) apps.push(g);
}
console.log(`[games] hosting ${apps.length ? apps.map((g) => g.name).join(', ') : 'none (ARENA_APPS names no game)'}`);
// WHAT THIS DAEMON FUNDS (M3.3-31): the paying rounds its operator names, and
// entries into them - off by default, so an unnamed round is still 402.
// THE OWNER'S KEY AND CLAIM CODE (owner.js): two files beside the database, the code readable by the operator only
const ownerFiles = { store: {
  read: () => { try { return JSON.parse(readFileSync(`${path}.owner.json`, 'utf8')); } catch { return null; } },
  write: (o) => writeFileSync(`${path}.owner.json`, JSON.stringify(o) + '\n', { mode: 0o600 }),
  writeCode: (code) => { if (code) writeFileSync(`${path}.owner-claim`, code + '\n', { mode: 0o600 }); else rmSync(`${path}.owner-claim`, { force: true }); },

  // the claim file's full path, said on the owner page while the node has no owner (kanban #550, 2026-10-20: "show the complete path")
  codePath: resolvePath(`${path}.owner-claim`),
} };
// THE OPERATOR UI'S TOKENS (spec §27A.7.7): kept as hashes beside the database; the first-start pairing URI written
// beside it too, readable by the operator only, as the claim code is. The endpoint is the node's public one (ARENA_WSS_<port>)
const operatorFiles = {
  store: {
    read: () => { try { return JSON.parse(readFileSync(`${path}.operator-tokens.json`, 'utf8')); } catch { return []; } },
    write: (l) => writeFileSync(`${path}.operator-tokens.json`, JSON.stringify(l) + '\n', { mode: 0o600 }),
  },
  writePairing: (uri) => writeFileSync(`${path}.operator-pairing`, uri + '\n', { mode: 0o600 }),
  endpoint: (process.env[`ARENA_WSS_${port}`] || `http://${host}:${port}`).replace(/^ws(s?):/, 'http$1:'),
};
const options = { port, host, publicEndpoint: process.env[`ARENA_WSS_${port}`] || null, funded: fundingFromEnv(process.env), plugins: apps, owner: ownerFiles, operator: operatorFiles, pluginsDir, ...(fed.given ? { stakeLocks: fed.stakeLocks } : {}) };
if (ln.given) options.lightning = ln.lightning;
if (process.env.ARENA_CLOSE_AT_END === '1') options.closeAtEnd = true;
// THE COMMITTEE'S PRICE FEED (§11): read BTC/USD every 5 s and lead / sign the attested price samples
if (process.env.ARENA_PRICE_FEED === '1') options.priceFeed = true;
{
  const net = process.env.ARENA_DONATION_NETWORK;
  if (net && net !== 'regtest' && net !== 'testnet4') { console.error(`ARENA_DONATION_NETWORK is regtest or testnet4, not ${net}`); process.exit(2); }
  // testnet4 also holds the set series 3cfbe516 names, under the old id (PICK B, arena-protocol/src/old-series.js)
  // AND TESTNET4'S SET WITH REAL RECIPIENTS (LNURL-0822, serial 2): for the contracts that name it; a contract names its set
  // by id (22A), so the rounds already written keep theirs
  // AND, FROM ITS valid_from (154965), TESTNET4'S SET OF KEYS (serial 3; 2026-10-03, FEDERATION.md "Donations in the
// federation"): every round whose census reaches it names it; the rounds already written keep the set they named
// ON REGTEST THE KEY SET WHEN ASKED: ARENA_REGTEST_DONATION_SET=keys - a market whose own game set pays keys
// (the Up/Down test market) settles only beside a protocol set that pays keys too ("never one of each"); every other
// regtest tool keeps the LNURL set
// THE CHAIN THIS SEAT READS, as its network's genesis names it (the network store takes no package for another chain)
if (net) options.chain = net === 'regtest' ? 'bitcoin-regtest' : 'bitcoin-testnet4';
if (process.env.ARENA_FEDERATION_INVITE) options.federationInvite = process.env.ARENA_FEDERATION_INVITE.trim();
if (net) options.donationSets = net === 'regtest' ? (process.env.ARENA_REGTEST_DONATION_SET === 'keys' ? [TEST_DONATION_SET_KEYS_REGTEST] : [TEST_DONATION_SET_REGTEST]) : [TESTNET4_DONATION_SET_KEYS, TESTNET4_DONATION_SET, TEST_DONATION_SET_TESTNET4, TEST_DONATION_SET_TESTNET4_BEFORE_SERIES_GENESIS];
}
// ONE SERIES A LINE (series-line.js): its template, hex; then count=N, cut=N, and for a grid series grid and period=N.
const readSeriesFile = (path) => readSeriesLines(readFileSync(path, 'utf8'));
// THE OPERATOR'S REFUSE-ROUNDS FILE: round ids this node refuses at every door, read again when it changes
if (process.env.ARENA_REFUSE_ROUNDS_FILE) options.refuseRoundsFile = process.env.ARENA_REFUSE_ROUNDS_FILE;
if (process.env.ARENA_SERIES_FILE) {
  const path = process.env.ARENA_SERIES_FILE;
  try { options.series = readSeriesFile(path); } catch (e) { console.error(`ARENA_SERIES_FILE: a line is not a series: ${e.message}`); process.exit(2); }
  // A SERIES ADDED TO THE FILE IS TAKEN WITHOUT A RESTART (2026-10-02: "find out the reason for the restarts and
  // find a way to recover from them"): the 82/90 waiter restarted the seven seats one at a time, 10 min apart, after each
  // day's series - one restarted between a player's join and the round's start lost his session and his run went FORFEIT
  // (round 798ebc79, seat 1, 11:45:56Z), one restarted inside the objection window never signed FINAL (seat 2). The file is
  // read again when it changes; the series writer pass takes what is new.
  let seen = (() => { try { return statSync(path).mtimeMs; } catch { return null; } })();
  options.seriesReload = () => {
    let m; try { m = statSync(path).mtimeMs; } catch { return null; }
    if (m === seen) return null;
    const read = readSeriesFile(path);
    seen = m;
    return read;
  };
}
// THE GRID SERIES POSTED TO THIS SEAT (POST /series), kept beside its store so a restart holds them again
options.gridSeriesFile = process.env.ARENA_GRID_SERIES_FILE || `${path}.grid-series`;
// WHERE THE OTHER SIGNER NODES ANSWER, as the operator knows it (serve's `peers`; ORDER-2116, measured on the free pair):
// with none named, a node finds its peers off the round's census - the bond adverts at its census height - and a seat
// whose address moved since answers there no more. The free pair's nodes run as their own units (2026-10-01) and
// lost the peers the 2-of-2 launcher handed them: 44 runs sat at 1 of 2 FINAL signatures. Comma-separated base URLs.
// WHAT THIS NODE HOSTS (2026-10-03 22:50): node 1 gateway A + LND 1, node 2 gateway B + LND 2 - read for its /dashboard
// A DEV CLIENT BESIDE THIS NODE: its directory, read for the dashboard (never its key)
if (process.env.ARENA_DEV_CLIENT_DIR) options.devClientDir = process.env.ARENA_DEV_CLIENT_DIR;
// THE GAME DEVELOPERS' KEYS ITS OWNER INSTALLS (kanban #582): beside the store, readable by the node only - it signs their apps' new splits
options.appDevKeysDir = process.env.ARENA_APP_KEYS_DIR || `${path}.app-keys`;
// THE DEV CLIENTS THE OWNER SETS UP ON THE OWNER PAGE: run by this node, one directory each beside its database. A new
// client takes the seats, invites and gateways this node knows - from a template donor.json (ARENA_DEV_TEMPLATE, else the client
// beside it), else from ARENA_DEV_SEATS
// and ARENA_DEV_INVITES_FROM - and the page's lock client from ARENA_DEV_WASM_PKG; without that the owner page says it runs none.
if (process.env.ARENA_DEV_WASM_PKG) {
  const beside = (() => { try { return JSON.parse(readFileSync(process.env.ARENA_DEV_TEMPLATE || `${process.env.ARENA_DEV_CLIENT_DIR}/donor.json`, 'utf8')); } catch { return {}; } })();
  const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const { createDevClients } = await import('./dev-clients.js');
  const { newKey, keyFromSecret } = await import('../../arena-donor/src/donor.js');
  options.devClients = createDevClients({
    root: process.env.ARENA_DEV_CLIENTS_ROOT || `${path}.dev-clients`,
    donorBin: fileURLToPath(new URL('../../arena-donor/bin/arena-donor.mjs', import.meta.url)),
    defaults: { wasmPkg: process.env.ARENA_DEV_WASM_PKG,
      seats: list(process.env.ARENA_DEV_SEATS).length ? list(process.env.ARENA_DEV_SEATS) : (beside.seats || []),
      invitesFrom: list(process.env.ARENA_DEV_INVITES_FROM).length ? list(process.env.ARENA_DEV_INVITES_FROM) : (beside.invitesFrom || []),
      invites: beside.invites || {}, gateways: beside.gateways || [] },
    keys: { newKey, keyFromSecret }, log: (l) => console.log(l),
  });
  options.devClients.startAll();
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { try { options.devClients.stopAll(); } catch { /* stopping */ } });
}
{ const hc = hostsFromEnv(); if (hc) { options.hosts = hostsReader(hc).start(); console.log(`hosts: ${hc.lnd ? 'LND ' + hc.lnd.rest : 'no LND'}, ${hc.gateway ? 'gateway ' + hc.gateway.name + ' ' + hc.gateway.base : 'no gateway'}`); } }
if (process.env.ARENA_PEERS) options.peers = process.env.ARENA_PEERS.split(',').map((s) => s.trim()).filter(Boolean);
if (process.env.ARENA_ATTACH_PROOF_DIR) {
  const dir = process.env.ARENA_ATTACH_PROOF_DIR;
  options.headerBytes = () => { try { return new Uint8Array(readFileSync(`${dir}/headers.bin`)); } catch { return null; } };
  options.bondProof = () => { try { return JSON.parse(readFileSync(`${dir}/bond.json`, 'utf8')); } catch { return null; } };
  // THIS NODE'S ADVERTISEMENT: the newest it posted - an update's, when the operator put the update
  // transaction beside the bond as advert-update.json ({ hex }) - else the one its bond committed to. serve() holds its
  // hosted_games to ARENA_APPS and refuses to start on an advertised game it does not host.
  try {
    const update = existsSync(`${dir}/advert-update.json`) ? JSON.parse(readFileSync(`${dir}/advert-update.json`, 'utf8')) : null;
    const read = update && update.hex ? readAdvertUpdate(fromHex(update.hex), { network: process.env.ARENA_DONATION_NETWORK || 'regtest' }) : null;
    const bond = options.bondProof();
    const advert = read && read.ok ? read.advert : (bond && bond.hex ? advertInTransaction(fromHex(bond.hex)) : null);
    if (advert) options.ownAdvert = advert;
  } catch (e) { console.error(`[games] cannot read this node's advertisement: ${e.message}`); }
}
if (url) {
  const call = bitcoindRpc({ url, cookiePath });
  // GET /headers KEPT UP WITH THE CHAIN: the attach proof's headers.bin was written once (to 156046 on
  // 2026-10-11), and a client that builds a committee itself needs headers past each round's beacon. The file stays the
  // start - it begins at the network's anchor - and every new block's header is appended from this node's bitcoind,
  // read every 30 s; a header that does not link to the one before stops the append (a reorg is read again next time).
  if (process.env.ARENA_ATTACH_PROOF_DIR) {
    const dir = process.env.ARENA_ATTACH_PROOF_DIR;
    let live = null, liveTip = null;
    const startOf = () => { try { return new Uint8Array(readFileSync(`${dir}/headers.bin`)); } catch { return null; } };
    const extend = async () => {
      const base = live || startOf();
      if (!base || base.length % 80 !== 0 || !base.length) return;
      try {
        const firstHash = Buffer.from(blockHashOf(base.subarray(0, 80))).reverse().toString('hex');
        const firstHeight = Number((await call('getblockheader', [firstHash])).height);
        const have = firstHeight + base.length / 80 - 1;
        const tip = Number(await call('getblockcount'));
        // A REORGANISED CHAIN IS FOLLOWED (kanban #631, measured 2026-10-26 00:4xZ: every seat's /headers ended at 2026-10-25 08:32Z,
        // block 00000000749b of the branch the chain left - the kept file held that branch, so each 30 s read found the next header
        // not linking, dropped to the file and stopped again; no client could build a 10-26 round's committee, "no beacon"): the held
        // headers are cut back to the last one this node's chain still holds at its height, and extended from there
        const hashAt = (i) => Buffer.from(blockHashOf(base.subarray(i * 80, i * 80 + 80))).reverse().toString('hex');
        const onChain = async (i) => (await call('getblockhash', [firstHeight + i])) === hashAt(i);
        let keep = base.length / 80;
        if (!(await onChain(Math.min(keep, tip - firstHeight + 1) - 1))) {
          let i = Math.min(keep, tip - firstHeight + 1) - 1;
          const floor = Math.max(0, i - 2000);
          while (i > floor && !(await onChain(i))) i--;
          keep = i + 1;
          const cut = base.subarray(0, keep * 80);
          console.log(`[headers] the chain reorganised: ${base.length / 80 - keep} held header(s) left, ${keep} kept, to height ${firstHeight + keep - 1}`);
          writeFileSync(`${dir}/headers.bin.tmp`, cut);
          renameSync(`${dir}/headers.bin.tmp`, `${dir}/headers.bin`);
          live = new Uint8Array(cut); liveTip = firstHeight + keep - 1;
          return;
        }
        if (tip <= have) { live = base; liveTip = have; return; }
        const parts = [base];
        let prev = blockHashOf(base.subarray(base.length - 80));
        for (let h = have + 1; h <= tip && h <= have + 2000; h++) {
          const hdr = Buffer.from(await call('getblockheader', [await call('getblockhash', [h]), false]), 'hex');
          if (!Buffer.from(hdr.subarray(4, 36)).equals(Buffer.from(prev))) { live = null; return; }
          parts.push(new Uint8Array(hdr)); prev = blockHashOf(new Uint8Array(hdr));
        }
        live = new Uint8Array(Buffer.concat(parts)); liveTip = have + parts.length - 1;
        // AND KEPT, so the next start reads only what is new (kanban #576, measured 2026-10-23: the file still ended at 156,046,
        // so every restart read ~1,350 headers again, two RPC calls each): written whole - a temporary file, then a rename -
        // once 144 new headers are held, not on every 30 s read
        const onFile = (startOf() || new Uint8Array()).length / 80;
        if (live.length / 80 - onFile >= 144) {
          writeFileSync(`${dir}/headers.bin.tmp`, live);
          renameSync(`${dir}/headers.bin.tmp`, `${dir}/headers.bin`);
          console.log(`[headers] kept ${live.length / 80} headers to height ${liveTip}`);
        }
      } catch (e) { console.error(`[headers] not extended: ${e.message}`); }
    };
    extend();
    const t = setInterval(() => { extend(); }, 30000); if (t.unref) t.unref();
    options.headerBytes = () => live || startOf();
    void liveTip;
  }
  // A 400-header window, as the 2-of-2 tool reads one: the rule refuses a
  // window that does not reach back before a round's committee_time.
  const beacon = chainBeacon({ call, window: 400 });
  // THE BEACON OF EVERY ROUND THIS STORE STILL OWES A PAYOUT ON, read before
  // the daemon starts: the start-up sweep asks it whose turn it is, and the
  // other readers of a beacon ask synchronously.
  // AND ITS CENSUS BLOCKS, for the same reason: the roster reads a view
  // synchronously, and the signer nodes' addresses are in it.
  const views = new Map();                     // view key -> the view
  const blocksKept = blockCache();             // block hash -> its one parsed copy, shared by every view
  // THE CHAIN'S CENSUS AT A HEIGHT, KEPT ACROSS A RESTART (2026-10-20: "the bonds take a long time to show up, if they show up at all";
  // measured all day: a restarted seat read 2,017 blocks again for every census height it was asked - minutes under load, while its
  // federation records, gateway operators and bonds waited): the census a height gives, kept in this node's store (census_kept, as the
  // roster keeps a round's), keyed by the network, the height and that block's hash - another block at the height is another key, never
  // a stale answer, at any depth. Three days kept; one derivation in flight per key.
  const chainCensusInFlight = new Map();
  // A BLOCK READ THAT FAILED HOLDS EVERY CENSUS READ FOR A MINUTE, as it holds the round's view (below): the records' first gathering
  // 45 s after start read the whole census window from a bitcoind whose block reads had just failed (main-process (c), since f554a896)
  let blocksFailedAtMs = 0;
  const chainCensusKept = async (kind, networkIdHex, height, contract) => {
    const hash = String(await call('getblockhash', [height]));
    const key = `chain:${kind}:${networkIdHex}:${height}:${hash}`;
    try { const row = db.prepare('SELECT body FROM census_kept WHERE key = ?').get(key); if (row) return JSON.parse(row.body, censusReviver); } catch { /* derived below */ }
    if (chainCensusInFlight.has(key)) return chainCensusInFlight.get(key);
    if (Date.now() - blocksFailedAtMs < 60000) return { ok: false, why: 'a block read failed less than a minute ago: read again after it' };
    const p = (async () => {
      // a kept hash from a branch the chain left is dropped and the view read once more (censusWithFreshHashes, kanban #495)
      const read = async () => { try { return await blocksOver(call, Math.max(0, height - CENSUS_LOOKBACK), height, { cache: blocksKept }); } catch (e) { blocksFailedAtMs = Date.now(); throw e; } };
      const census = await censusWithFreshHashes({ read, derive: (view) => censusOfView(view, contract), cache: blocksKept });
      if (census.ok) {
        try {
          db.prepare('INSERT OR REPLACE INTO census_kept (key, body, kept_ms) VALUES (?, ?, ?)').run(key, JSON.stringify(census, censusReplacer), Date.now());
          db.prepare("DELETE FROM census_kept WHERE key LIKE 'chain:%' AND kept_ms < ?").run(Date.now() - 3 * 86400000);
        } catch { /* in memory only */ }
      }
      return census;
    })().finally(() => chainCensusInFlight.delete(key));
    chainCensusInFlight.set(key, p);
    return p;
  };
  const reading = new Map();                   // view key -> its one read in flight
  const keyOfRound = new Map();                // round id hex -> the view key it was asked under
  const viewFailed = new Map();                // view key -> { atMs, why } of its last failed read
  // UP TO THE BEACON, AND AS DEEP PAST IT AS THE ROUND ASKS. The beacon comes
  // after the census height in the normal order, and the roster checks the
  // seed block against this same view - at the round's own confirmation depth.
  // Measured: stopping at the census height, "no block in this view is after
  // this round's committee time"; stopping at the beacon, "the block that
  // seeds this round is 1 deep and this round asks for 6". Never past the tip.
  const VIEW_REREAD_MS = 10000;
  const toHexMain = (b) => Buffer.from(b).toString('hex');
  const viewOf = async (contract) => {
    const seen = await beacon.refresh(contract);
    const tip = Number(await call('getblockcount'));
    const deep = seen.ok ? seen.height + contract.censusConfirmations - 1 : 0;
    const to = Math.min(tip, Math.max(contract.censusHeight, deep));
    // a view that does not link - a kept hash from a branch the chain left - is read once more with fresh hashes (kanban #576)
    const view = await viewWithFreshHashes({ read: () => blocksOver(call, Math.max(0, contract.censusHeight - CENSUS_LOOKBACK), to, { cache: blocksKept }), cache: blocksKept });
    // SHORT OF THE BEACON'S DEPTH, a view is read again later (ORDER-2116, measured on the free pair 2026-10-01: a round
    // posted 15 min ahead was read before its beacon existed, kept for good, and never drew a committee - "no block in
    // this view is after this round's committee time"; no free round posted ahead was joinable).
    if (view && typeof view === 'object') {
      Object.defineProperty(view, 'shortOfBeacon', { value: !(seen.ok && tip >= deep), enumerable: false });
      Object.defineProperty(view, 'readAtMs', { value: Date.now(), enumerable: false, writable: true });
      Object.defineProperty(view, 'tipAtRead', { value: tip, enumerable: false });
    }
    return view;
  };
  // (No census is read ahead for rounds owing an on-chain pool payout: that payout is gone with the withdrawn custody -
  // §23.6, RULED 2026-09-25. A round's view is read the first time it is asked for, below.)
  Object.assign(options, {
    // THE BALLOT'S PROPOSALS: a deposit read from the block its proposer names - getrawtransaction with a block hash
    // needs no txindex - and that block's height, only while it is on this bitcoind's main chain. The lowest bracket's bond_min
    // is the rounds' floor until the 27A.2 median is built (testnet4's rounds name 50 000 sat): ARENA_LOWEST_BOND_MIN_SATS.
    ballot: {
      confirmedTx: async (txid, blockHash) => {
        try {
          const head = await call('getblockheader', [blockHash]);
          if (!head || !(Number(head.confirmations) >= 1)) return null;
          const hex = await call('getrawtransaction', [txid, false, blockHash]);
          return { raw: fromHex(String(hex)), height: Number(head.height) };
        } catch { return null; }
      },
      lowestBondMinSats: BigInt(process.env.ARENA_LOWEST_BOND_MIN_SATS || 50000),
      // AND THE TALLY'S READS OF THIS SEAT'S OWN CHAIN (ballot-tally.js, §27A.7.3): the tip; the vote outputs of one block, read
      // raw and kept as votes only (the tally asks each height once); and the bonds
      // active at a proposal's publication height, each with its amount - derived as a round's census is (roster.js censusOfView),
      // at the version the proposal is written in, every bond at or above the lowest bracket's bond_min, one confirmation deep at
      // that height. ARENA_BALLOT_EVERY_MS: how often it counts (10 s by default).
      tipHeight: async () => Number(await call('getblockcount')),
      // the block at a height by its hash - the tally holds a count to the hashes it read (a reorg is followed); null above the tip
      blockHashAt: async (height) => { try { return String(await call('getblockhash', [height])); } catch { return null; } },
      votesAt: async (height, hash) => {
        const raw = fromHex(String(await call('getblock', [hash || await call('getblockhash', [height]), 0])));
        return votesInBlock(raw, height);
      },
      censusAt: async (networkIdHex, height) => {
        const contract = { networkId: fromHex(networkIdHex), censusHeight: height, censusConfirmations: 1,
          bondMinSats: BigInt(process.env.ARENA_LOWEST_BOND_MIN_SATS || 50000), protocolVersion: PROTOCOL_VERSION };
        const census = await chainCensusKept('ballot', networkIdHex, height, contract);
        if (!census.ok) { console.error(`[ballot] no census at ${height}: ${census.why}`); return null; }
        // each bond's confirmation height and CLTV maturity: the funding vote's age (rules 1, 2) and lock (rule 1), §27A.9.5
        return census.entries.map((e) => ({ pubkey: e.pubkey, outpoint: `${Buffer.from(e.txid).toString('hex')}:${e.vout}`, bondSats: e.bondSats,
          height: Number.isInteger(e.height) ? e.height : null, maturity: e.advert && Number.isInteger(e.advert.bondMaturityHeight) ? e.advert.bondMaturityHeight : null }));
      },
      // THE WHOLE CENSUS AT A HEIGHT, ADVERTS AND ALL: a founding's trigger height is the chain's, not any round's - the
      // seats' newest rounds name census heights days back, and their views end at those rounds' beacons (measured live 2026-10-15:
      // B1's newest round names 156538, node 15's 156388, so B7's notice at 156644 never found its beacon or census and no founding
      // started). The same derivation and window as censusAt above, every entry whole (the draw reads guardian_capable,
      // guardian_endpoint, operator and guardian_of).
      censusEntriesAt: async (networkIdHex, height) => {
        const contract = { networkId: fromHex(networkIdHex), censusHeight: height, censusConfirmations: 1,
          bondMinSats: BigInt(process.env.ARENA_LOWEST_BOND_MIN_SATS || 50000), protocolVersion: PROTOCOL_VERSION };
        const census = await chainCensusKept('ballot', networkIdHex, height, contract);
        if (!census.ok) { console.error(`[founding] no census at ${height}: ${census.why}`); return null; }
        return census.entries;
      },
      everyMs: Number(process.env.ARENA_BALLOT_EVERY_MS || 10000),
    },
    // THE CHAIN'S TIP, for the settlement's takeover order (M3.3-19) and a lock's expiry, as the launcher gave its nodes
    chainTip: async () => Number(await call('getblockcount')),
    // A RAW TRANSACTION CHECKED, THEN BROADCAST (the owner's bond withdrawal): testmempoolaccept first - a bridge
    // in Electrum mode serves none, and its Electrum server refuses an invalid transaction itself
    chainSend: async (hex) => {
      let r = null;
      try { [r] = await call('testmempoolaccept', [[hex]]); } catch (e) { if (!/not served in Electrum mode/.test(e.message)) throw e; }
      if (r && !r.allowed) throw new Error(`the mempool refuses it: ${r['reject-reason']}`);
      return String(await call('sendrawtransaction', [hex]));
    },
    // A LIQUIDITY PROVIDER'S COIN, UNSPENT AND CONFIRMED (§23A.10: a guardian counts only coins its own chain shows)
    chainTxOut: async (txid, vout) => { const o = await call('gettxout', [txid, vout, false]); return o ? { sats: BigInt(Math.round(Number(o.value) * 1e8)), script: o.scriptPubKey.hex, confirmations: Number(o.confirmations) || 0 } : null; },
    // THE TRANSACTIONS OF A BLOCK, by id (GET /pending finds which recent block holds a publication - no txindex needed)
    chainBlockTxids: async (h) => (await call('getblock', [await call('getblockhash', [h]), 1])).tx,
    // AND WHETHER ONE WAITS IN THIS NODE'S MEMPOOL
    chainInMempool: async (txid) => { try { await call('getmempoolentry', [txid]); return true; } catch { return false; } },
    // THE NETWORK'S TRANSACTIONS ON THEIR WAY (2026-10-20: "Make sure that both show the same number of transactions at all
    // times"): this node's mempool, a transaction in it, its unconfirmed ancestors, and the last blocks' transactions - GET /pending
    // lists from them every transaction that pays the bond marker (bonds, advert updates) with the parents it waits on
    chainMempoolIds: async () => (await call('getrawmempool', [])).map(String),
    chainRawTx: async (txid) => fromHex(String(await call('getrawtransaction', [txid]))),
    chainMempoolAncestors: async (txid) => { try { return (await call('getmempoolancestors', [txid])).map(String); } catch { return []; } },
    chainRecentBlocks: async (from, to) => { const v = await blocksOver(call, from, to, { cache: blocksKept }); return v.blocks.map((b, i) => ({ height: from + i, transactions: b.transactions })); },
    // THE CHAIN'S TIPS NEAR THE TOP (2026-10-20, "Mining view mismatch, what is true": the seats followed our own block at 157,133
    // while the public explorer followed another miner's of the same work): the active tip, and every other tip within 12 blocks of it
    // with its work against the active one's and the height it forks from - a tie is decided by the next block, not by this node
    chainTips: async () => {
      const best = String(await call('getbestblockhash'));
      const work = async (h) => BigInt('0x' + (await call('getblockheader', [h])).chainwork);
      const bestWork = await work(best);
      const top = (await call('getblockheader', [best])).height;
      const rivals = [];
      for (const t of await call('getchaintips', [])) {
        if (t.status === 'active' || t.height < top - 12 || !['valid-fork', 'valid-headers', 'headers-only'].includes(t.status)) continue;
        const w = await work(t.hash);
        rivals.push({ hash: t.hash, height: t.height, status: t.status, forkHeight: t.height - t.branchlen, work: w === bestWork ? 'same' : w > bestWork ? 'more' : 'less' });
      }
      return { hash: best, height: top, rivals };
    },
    // THE CHAIN'S MEDIAN TIME AT A HEIGHT: a funding signal's active window, read alike by every seat
    blockTimeAt: async (h) => Number((await call('getblockheader', [await call('getblockhash', [h])])).mediantime) * 1000,
    // ONE VIEW PER WHAT IT DEPENDS ON - census height, committee_time, confirmation depth - NOT PER ROUND, AND ONE READ
    // OF IT IN FLIGHT (2026-09-30, measured on testnet4): a node holding series 3cfbe516 lists ~508 rounds that
    // all name the same census and beacon, and a view read per round id - ~100 blocks each, re-asked on every listing
    // while unread - flooded the testnet4 bitcoind from seven nodes: "Too many open files" at 07:10Z, the daemon
    // restarted, and the LNDs on it shut down. A round asked by id alone answers from the key it was read under.
    chainFor: ({ contract, roundIdBytes } = {}) => {
      const rid = roundIdBytes ? Buffer.from(roundIdBytes).toString('hex') : null;
      // A ROUND ASKED BY ID ALONE AFTER A RESTART (2026-10-02: "find a way to recover from them"): the id -> view key
      // map lives in memory, so a seat restarted inside a round's objection window answered "no chain view for that round",
      // could not say who is bonded, gathered no FINAL signature and kept none - seat 2 stayed PROVISIONALLY_FINAL on round
      // 798ebc79 while the other six signed FINAL 7 of 7. The round's own contract is in the store: its key is read from it.
      if (!contract && rid && !keyOfRound.has(rid)) {
        try {
          const row = db.prepare('SELECT contract FROM rounds WHERE round_id = ?').get(Buffer.from(rid, 'hex'));
          if (row) contract = decodeRoundContract(new Uint8Array(row.contract));
        } catch { contract = undefined; }
      }
      const key = contract ? `${contract.censusHeight}:${contract.committeeTimeMs}:${contract.censusConfirmations}` : rid && keyOfRound.get(rid);
      if (!key) return undefined;
      if (rid && contract) keyOfRound.set(rid, key);
      if (views.has(key)) {
        const had = views.get(key);
        // the one held is answered meanwhile; a fresh read replaces it once it lands
        if (had && had.shortOfBeacon && contract && !reading.has(key) && Date.now() - had.readAtMs >= VIEW_REREAD_MS)
          // and only once the beacon is on the chain at the round's depth - one header asked per tip, the beacon read once
          // the tip's median time has passed committee_time; a view is many blocks, and re-reading it on every new block
          // held 46 RPC calls open per node on the free pair (measured 2026-10-01).
          reading.set(key, (async () => {
            had.readAtMs = Date.now();
            const tip = Number(await call('getblockcount'));
            if (tip === had.tipAtRead) return;
            let seen = beacon.for({ contract });
            if (!seen) {
              const head = await call('getblockheader', [await call('getblockhash', [tip])]);
              if (!(BigInt(head.mediantime) * 1000n > BigInt(contract.committeeTimeMs))) return;
              const read = await beacon.refresh(contract);
              if (!read.ok) return;
              seen = read;
            }
            if (tip < seen.height + contract.censusConfirmations - 1) return;
            // EXTENDED, NOT READ AGAIN: the blocks after the held view's end are appended (a whole view is ~2000 blocks
            // past the census lookback; ten rounds re-reading theirs on the 10 s clock finished minutes after their entry
            // closed, measured). A first new block that does not link to the held tip - a reorganised chain - reads the
            // whole view again.
            const end = had.firstHeight + had.blocks.length - 1;
            const to = Math.min(tip, Math.max(contract.censusHeight, seen.height + contract.censusConfirmations - 1));
            const more = to > end ? await blocksOver(call, end + 1, to, { cache: blocksKept }) : { blocks: [] };
            const links = !more.blocks.length || toHexMain(more.blocks[0].header.subarray(4, 36)) === toHexMain(blockHashOf(had.blocks[had.blocks.length - 1].header));
            if (!links) { views.set(key, await viewOf(contract)); return; }
            const view = { ...had, blocks: [...had.blocks, ...more.blocks] };
            Object.defineProperty(view, 'shortOfBeacon', { value: false, enumerable: false });
            Object.defineProperty(view, 'readAtMs', { value: Date.now(), enumerable: false, writable: true });
            Object.defineProperty(view, 'tipAtRead', { value: tip, enumerable: false });
            views.set(key, view);
          })().catch(() => {}).finally(() => reading.delete(key)));
        return had;
      }
      // A READ THAT FAILED IS SAID ONCE AND TRIED AGAIN A MINUTE LATER, not on every pass (2026-10-02, the load): the
      // error was dropped, so every close and verify pass over a round whose view would not read - on all seven testnet4
      // seats, rounds from days back and today's alike - read ~2,100 blocks from bitcoind again, and the seat said only
      // "no chain view for that round".
      const failed = viewFailed.get(key);
      if (failed && Date.now() - failed.atMs < 60000) return undefined;
      if (contract && !reading.has(key))
        reading.set(key, viewOf(contract).then((v) => { views.set(key, v); viewFailed.delete(key); })
          .catch((e) => {
            const why = String((e && e.message) || e);
            if (!failed || failed.why !== why) console.error(`[chain] view ${key} did not read: ${why}`);
            viewFailed.set(key, { atMs: Date.now(), why }); blocksFailedAtMs = Date.now();
          })
          .finally(() => reading.delete(key)));
      return undefined;
    },
    // THE CHAIN A §13A/§13C WINDOW IS READ ON, AND THE TIP A POSTING OR RE-RUN NAMES: one header view that follows the tip
    // (src/tip-view.js). The round's census view above stops at its beacon's depth, and answered for these too - measured
    // on testnet4, series round fbd8294e: agreed and posted by all 7, never final, never settled.
    windowChain: tipHeaderView({ call, log: (s) => console.log(s) }),
    // A round seen for the first time is read now and answered from then on.
    randomnessFor: (q) => {
      const got = beacon.for(q);
      if (!got && q && q.contract) beacon.refresh(q.contract).catch(() => {});
      return got;
    },
  });
  // A HELD SERIES' VIEWS ARE READ AT START (TWO-GAMES-1407, measured on testnet4 2026-09-30 12:37Z): the first paying
  // POST /round after a restart was refused by every node - "this node has no chain view for that round, so it cannot
  // say who is bonded" - because the old series' bonding is read at its own census height (OLD_TESTNET4_SERIES_BOND_HEIGHT),
  // a view key nothing had asked for yet, and chainFor answers no view while a read is in flight. The deposit had landed
  // and its lock was made; the join was dropped. Both keys of each held series are asked for now, so they are read before
  // the first player's round is.
  for (const c of options.series || []) {
    options.chainFor({ contract: c });
    if (c.seriesId instanceof Uint8Array && isOldTestnet4Id(c.networkId) && isOldTestnet4Series(c.seriesId))
      options.chainFor({ contract: { ...c, censusHeight: OLD_TESTNET4_SERIES_BOND_HEIGHT } });
  }
}
// THE NODE, AND ITS GUARDIAN WHEN IT HOLDS A GUARDIAN KEY (node-start.js; §23A.2, RULED 2026-09-26 22:54 and
// 2026-09-27): nothing here is guardian config - whether this node is a guardian is the key beside its store, and the
// network, bitcoind, data, ports and public endpoint are all read off what this node already has (guardian.js).
// WSS FROM THE NODE ITSELF (spec §25.3,: "every node serving players needs a valid certificate ... Node software
// SHOULD make certificate provisioning a first-class setup step"): ARENA_TLS_CERT and ARENA_TLS_KEY, PEM files as
// tools/tls-setup.sh writes them - the node answers https and wss on its port. The files are read again every hour, so a
// renewed certificate is taken without a restart.
const tlsFiles = process.env.ARENA_TLS_CERT && process.env.ARENA_TLS_KEY ? { cert: process.env.ARENA_TLS_CERT, key: process.env.ARENA_TLS_KEY } : null;
if (tlsFiles) {
  try { options.tls = { cert: readFileSync(tlsFiles.cert), key: readFileSync(tlsFiles.key) }; }
  catch (e) { console.error(`ARENA_TLS_CERT / ARENA_TLS_KEY: ${e.message}`); process.exit(2); }
}
// THE GUARDIAN'S OWN BITCOIN CORE (kanban #635): while an installer node reads the chain through its Electrum bridge (its Bitcoin Core
// still syncing), its guardian reads that Core directly - ARENA_GUARDIAN_BITCOIND_URL / _COOKIE, else the node's own chain
const gUrl = process.env.ARENA_GUARDIAN_BITCOIND_URL || url, gCookie = process.env.ARENA_GUARDIAN_BITCOIND_COOKIE || cookiePath;
const node = await startNode({ db, path }, options,
  { bitcoindUrl: gUrl, cookiePath: gCookie, call: gUrl ? bitcoindRpc({ url: gUrl, cookiePath: gCookie }) : null });
// AND STOPS WITH IT: a signal closes the node, and its close() stops its guardian - never one without the other.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await node.close().catch(() => {});
    process.exit(0);
  });
}
if (tlsFiles && node.http && typeof node.http.setSecureContext === 'function') {
  const renew = setInterval(() => {
    try { node.http.setSecureContext({ cert: readFileSync(tlsFiles.cert), key: readFileSync(tlsFiles.key) }); }
    catch (e) { console.error(`ARENA_TLS: the certificate was not read again: ${e.message}`); }
  }, 3600000);
  renew.unref();
}
console.log(`arena-node on ${tlsFiles ? 'https' : 'http'}://${host}:${node.port}  (${path})${url ? `, chain ${url}` : ''}`
  + `${ln.given ? `, lnd ${ln.rpc} (${ln.network})` : ''}`);
// AT debug, EVERY REQUEST THE SEAT ANSWERS: method, path (its query left out: a link can carry a token), status, time
if (seatLog.debugOn && node.http && typeof node.http.on === 'function') {
  const req = seatLog.tag('request');
  node.http.on('request', (rq, rs) => { const t0 = performance.now(); rs.once('finish', () => req.debug(`${rq.method} ${String(rq.url || '').split('?')[0]} -> ${rs.statusCode} in ${req.since(t0)}`)); });
}
