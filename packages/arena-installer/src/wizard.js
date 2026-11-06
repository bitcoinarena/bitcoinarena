// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S WEB WIZARD (2026-10-18: "The installer should be web based, so the user does the wizard on
// his browser. Either the connection is on localhost ... or the server is remote and the installer needs to use tunnelling").
//
// NOTHING WITHOUT THE TOKEN (B.3). The installer prints one URL with a one-time setup token. Opening it trades the token for a session
// cookie (HttpOnly, SameSite=Strict) and the token is gone; it also expires TOKEN_MS after start. Every other request needs that
// session. And:
//   - the Host header must be this server's own (127.0.0.1 / localhost / ::1 on its port, or the tunnel's name): a page elsewhere
//     cannot reach the wizard by DNS rebinding;
//   - every POST carries `x-arena-wizard: 1`, a header no cross-site form can send and no cross-site fetch can send without a
//     preflight this server never answers.
//
// THE STEPS (C), each tested before it is saved: chain -> roles -> apps (kanban #569: the release's apps, all chosen) -> seed (written down, asked back) -> owner (the seed's key or a Nostr
// key, bound before the node's first start) -> reach (ruling 7: direct when seats reach it, else a permanent Cloudflare tunnel, or a
// quick one) -> service (installed, started at boot if the user wants, healthy, reachable at its public address; then one signed
// owner login against the running node) -> done. The state is on disk after every step (state.js), so the wizard can be closed and resumed.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { testConnection, TESTNET4_ELECTRUM } from './chain-test.js';
import { newSeed, confirmPositions, checkConfirm, ownerKeyOf, nostrPubkeyHex, CONFIRM_WORDS, emergencyOf, seedOfWords, seedOfNsec, newNsec, nodeKeyOf, signNostrEvent } from './seed.js';
import { nextStep, doneOf, seatConf, ROLES, guardianSetupOf, ownCoreOf } from './state.js';
import { appsIn, appsView, chosenApps, hostedGameIdsOf } from './apps.js';
import { installService, installProgram } from './service.js';
import { control, followTunnelNow, nodeOf } from './node-services.js';
import { newerVersion } from '../../arena-node/src/release-latest.js';
import { detectBitcoind, diskCheck, installCore, configureCore, coreArgs, syncStatus, freeCorePorts, NEEDS } from './bitcoind.js';
import { createHash } from 'node:crypto';
import * as reachKit from './reach.js';
import { DatabaseSync } from 'node:sqlite';
import { walletOf, payoutKeyOf, coinsOf, broadcast } from './wallet.js';
import { buildBond, buildAdvertUpdate, buildSend, advertFor, lockOf, BOND_MIN_SATS, EMERGENCY_IN_ADVERT } from './bond.js';
import { installMinimum } from './install-minimum.js';
import { writeLaunchers, installUpdater } from './launchers.js';
import { setUpOwnLnd, lndReady } from './lnd-setup.js';
import * as workersKitDefault from './workers.js';
import { RING_RESERVE_SATS, OUTSIDE_RESERVE_SATS } from './custody-agent.js';
import { LIQUIDITY_TERMS } from '../../arena-protocol/src/liquidity.js';
import { LIQUIDITY_PROVIDER_PORT } from './state.js';
import { join, isAbsolute, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
/** A custody node's extra deposit: the advertisement update's reserve, and the default peg-in for its gateway (the owner can change it). */
export const CUSTODY_UPDATE_RESERVE_SATS = 5000;
export const CUSTODY_PEG_IN_SATS = 50000;
import { installLnd, configureLnd, lndArgs, createLndWallet, testLnd, lndFunds, lndOpenChannel, lndChannels } from './lnd.js';
/** A gateway seat's requirements on testnet4 (spec §23A.9), said in the wizard. */
export const GATEWAY_SEAT = Object.freeze({ minInboundSats: 100000, minOutboundSats: 100000, minPegInSats: 50000, availability: 0.95, seats: 2, epochBlocks: 144 });
import { findGatewayd, configureGateway, testGateway, joinFederation } from './gateway.js';
import { signOwnerRequest, ownerEventTemplate } from '../../arena-node/src/owner.js';
import { openStore, adoptIdentity, nodeIdentity } from '../../arena-node/src/store.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../../arena-protocol/src/constants.js';
import { instancesChoice, instancesNote, INSTANCES_MAX, RAM_FROM } from './instances.js';
import { INSTANCE, PORT_OFFSET } from './instance.js';
import { QUIET } from '../../arena-node/src/log-level.js';

export const TOKEN_MS = 30 * 60000;        // the setup token's life
// A SESSION LASTS A WEEK IDLE AND OUTLIVES AN INSTALLER RESTART (ruling 8: "Tells user to bookmark this page as it can take days on
// main net"): kept on disk as the hash of its cookie, never the cookie itself
export const SESSION_IDLE_MS = 7 * 24 * 3600000;
const b64u = (n) => randomBytes(n).toString('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * The wizard. `state`: nodeState(home). `release`: the installed release's root. `seatPort`: the node's port. Injectables for the tests:
 * `test` (chain test), `install` (service), `fetcher`, `nowMs`. Answers { token, handle(req, res), allowHost(host), close() }.
 */
/**
 * CUSTODY, ADDED LATER (2026-10-18: "if custody is setup later in the UI we need the same screens"): `arena-install --add-custody`
 * (or Start menu / Arena Node > Add custody) reopens the wizard at the roles step with custody chosen, so the node owner sees the same
 * screens as a new custody node - what custody is, Lightning and the gateway, the federation, the bond's rules (I UNDERSTAND) - and the
 * bond step then updates the posted bond's advertisement to name custody instead of posting a second bond. The install step runs again
 * (the node's settings name its guardian and gateway, and it restarts with them); seed, owner and reach stay done.
 */
export function beginAddCustody(state) {
  const s = state.read();
  if ((s.roles || []).includes('custody') && (s.bond || {}).custodyAdvert) return { ok: false, why: 'this node holds custody already' };
  const { roles: _r, service: _s, lightning: _l, federation: _f, promise: _p, bond: _b, done: _d, ...rest } = s.done || {};
  state.save({ roles: [...new Set([...(s.roles || []), 'custody'])], done: rest, custodyLater: { atMs: Date.now() } });
  return { ok: true };
}

/** Custody added to a node that already has a bond (no second bond). */
const laterCustody = (s) => Boolean(s.custodyLater && s.bond && s.bond.txid && (s.roles || []).includes('custody') && !s.bond.custodyAdvert);
/**
 * WHAT THE NODE'S WALLET MUST RECEIVE, BY PART, for the roles chosen (the bond step shows the total from the start - measured on the
 * test host, rc.12: a custody node was told "at least 52,000 sat", the bond alone, while it needs the peg-in and both channels too).
 * Custody added to a node with a bond: no second bond - this update of its advertisement, and later the one naming its federation,
 * the ring channel to the next node of its federation and the outside channel (custody-agent.js). A liquidity provider: its deposit
 * (§23A.10: 5 x L on testnet4), sent to LND's wallet by the node's agent.
 */
// THE BOND PART is the installer's minimum (install-minimum.js, §23A.3a): the network's bond target the seats said at the bond step,
// kept in the state as `bondMinimum`, else the floor
export const bondMinimumOf = (s) => Math.max(Number(BOND_MIN_SATS), Number((s && s.bondMinimum && s.bondMinimum.sats) || 0));
export function depositParts(s, pegInSats) {
  const custody = (s.roles || []).includes('custody');
  const pegIn = Math.max(0, Math.floor(Number(pegInSats) || 0));
  const parts = laterCustody(s) ? { custodyUpdate: CUSTODY_UPDATE_RESERVE_SATS, advertUpdate: CUSTODY_UPDATE_RESERVE_SATS, pegIn, outside: OUTSIDE_RESERVE_SATS, ring: RING_RESERVE_SATS }
    : { bond: bondMinimumOf(s), fees: 2000, ...(custody ? { advertUpdate: CUSTODY_UPDATE_RESERVE_SATS, pegIn, outside: OUTSIDE_RESERVE_SATS, ring: RING_RESERVE_SATS } : {}) };
  if ((s.roles || []).includes('liquidity')) { parts.liquidity = Number(LIQUIDITY_TERMS.testnet4.depositSats); parts.fees = parts.fees || 2000; }
  return parts;
}

// ONE DEPOSIT FOR ALL NODES OF A COUNT (kanban #596, 2026-10-23: "wenn mehr als 1 instance ausgewählt ist tut der User nur 1 Bond
// einzahlen, das wird automatisch multipliziert und aus N Instanzen auf gesplittet"): node 1 asks for its own deposit and the others' -
// each as much as its own, plus the payment that hands it on - and each further node's bond step is paid from node 1's wallet
export const SPLIT_FEE_SATS = 500;

/** The Arena faucet (kanban #635): testnet4 coins for a new node, from our own coins - ARENA_FAUCET_URL to point elsewhere. */
export const FAUCET_URL = process.env.ARENA_FAUCET_URL || 'https://seat.example.com/faucet';
export function withOtherNodes(s, parts, { further = false } = {}) {
  const n = s && s.instances ? Number(s.instances.count) || 1 : 1;
  if (n <= 1 || further) return parts;
  const one = Object.values(parts).reduce((a, x) => a + x, 0);
  return { ...parts, otherNodes: (n - 1) * (one + SPLIT_FEE_SATS) };
}

/** A SEAT RESTARTS when its settings file changed after it started (kanban #577): the text written at its start against the one now. */
export const seatNeedsRestart = (before, after) => String(before || '') !== String(after || '');

/**
 * A CORE WHOSE PORT ANOTHER PROGRAM HOLDS (kanban #635, the owner's playtest 2026-10-25: his test host's own testnet4 Core held 48342, and
 * the installer's Core exited at every start): free ports chosen, its bitcoin.conf written again, its service started again, the new
 * address kept in the state. Used by the Bitcoin step's status and by the chain-switch keeper.
 */
export async function repairCorePorts({ state, network, coreKit = { freeCorePorts, configureCore, coreArgs, installProgram } }) {
  const s = state.read();
  const net = s.core && s.core.networks && s.core.networks[network];
  if (!net) return { ok: false, why: `no Bitcoin Core for ${network} was installed here` };
  let ports;
  try { ports = await coreKit.freeCorePorts(network); } catch (e) { return { ok: false, why: e.message }; }
  const c = coreKit.configureCore({ home: s.core.dir || state.home, network, prune: !!s.core.prune, ports });
  const r = await coreKit.installProgram({ id: `bitcoind-${network}`, description: `Bitcoin Core for Bitcoin Arena (${network})`, args: coreKit.coreArgs({ bitcoind: s.core.bitcoind, datadir: c.datadir }), home: state.home, boot: true });
  if (!r.ok) return { ok: false, why: r.why };
  const now = state.read();
  state.save({ core: { ...now.core, networks: { ...now.core.networks, [network]: { ...now.core.networks[network], rpcUrl: c.rpcUrl, cookiePath: c.cookiePath } }, portsMovedMs: Date.now() } });
  return { ok: true, ports };
}

export function createWizard({ state, release, seatPort = reachKit.DEFAULT_NODE_PORT, bridgePort = null, test = testConnection, install = installService,
  // tailscale: the test host app's own CLI when it is installed, else the one in PATH
  fetcher = fetch, reach = reachKit, cloudflared = 'cloudflared', tailscale = process.env.ARENA_TAILSCALE || (process.platform === 'darwin' && existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale') ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : 'tailscale'),
  tailscaleSh = undefined, workersKit = workersKitDefault, chainKit = { coinsOf, broadcast },
  coreKit = { detectBitcoind, diskCheck, installCore, configureCore, coreArgs, syncStatus, freeCorePorts, installProgram },
  lndKit = { installLnd, configureLnd, lndArgs, createLndWallet, testLnd, installProgram, lndFunds, lndOpenChannel, lndChannels },
  gwKit = { findGatewayd, configureGateway, testGateway, joinFederation, installProgram }, launch = writeLaunchers, nowMs = () => Date.now(), onDone = () => {}, log = () => {},
  restartSeat = (home) => control('restart', 'node', { home }), restartTunnel = (home) => control('restart', 'tunnel', { home }), followTunnel = (home) => followTunnelNow({ home }), fundFrom = null, trace: given = QUIET }) {
  // EACH STEP AND STAGE SAID AT --verbose, WITH ITS TIME; WHAT EACH STEP WAS HANDED (its field names) AND FULL ERRORS AT --debug (kanban #693)
  const trace = given.tag('wizard');
  let token = b64u(32);
  const tokenUntil = nowMs() + TOKEN_MS;
  const hashOf = (sid) => createHash('sha256').update(String(sid)).digest('hex');
  const sessions = new Map();                // sha256(sid) -> last seen ms
  try { for (const [k, v] of Object.entries(JSON.parse(state.readSecret('sessions.json') || '{}'))) sessions.set(k, v); } catch { /* none kept */ }
  let sessionsSaved = 0;
  const saveSessions = (force = false) => { if (!force && nowMs() - sessionsSaved < 60000) return; sessionsSaved = nowMs(); state.writeSecret('sessions.json', JSON.stringify(Object.fromEntries(sessions))); };
  const hosts = new Set();
  let pendingSeed = null;                    // { seed, words, positions } until confirmed - never on disk unconfirmed
  let login = null;                          // the Cloudflare login under way: { url, result }
  const coreSamples = new Map();             // network -> the sync readings of the last ETA window
  const portOf = () => ((state.read().reach || {}).port || seatPort);
  let finished = false;

  const allowHost = (h) => hosts.add(String(h).toLowerCase());
  const hostOk = (req) => {
    const h = String(req.headers.host || '').toLowerCase();
    return hosts.has(h) || /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(h);
  };
  const sidOf = (req) => { const m = /(?:^|;\s*)arena_wizard=([A-Za-z0-9_-]+)/.exec(String(req.headers.cookie || '')); return m ? m[1] : null; };
  const sessionOk = (req) => {
    const sid = sidOf(req);
    if (!sid || finished) return false;
    const k = hashOf(sid);
    const seen = sessions.get(k);
    if (seen === undefined) return false;
    if (nowMs() - seen > SESSION_IDLE_MS) { sessions.delete(k); saveSessions(true); return false; }
    sessions.set(k, nowMs()); saveSessions();
    return true;
  };

  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((ok, no) => {
    let b = ''; req.setEncoding('utf8');
    req.on('data', (d) => { b += d; if (b.length > 65536) { no(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('not JSON')); } });
  });

  // THE RELEASE IN THE FOOTER (kanban #662, 2026-10-25: "footer with build/version on install, node owner, and node dashboard pages")
  const buildOf = () => { const r = (f) => { try { return readFileSync(join(release, f), 'utf8').trim(); } catch { return null; } }; return { version: r('VERSION'), commit: (r('COMMIT') || '').slice(0, 8) || null }; };
  const view = () => {
    const s = state.read();
    return { network: 'testnet4', step: nextStep(s), done: doneOf(s), origin: s.origin || null, control: s.control || null, chainSwitchedFrom: s.chainSwitchedFrom || null, chain: s.chain ? { ...s.chain, password: s.chain.password ? '(set)' : undefined } : null,
      chainTest: s.chainTest || null, roles: s.roles || [], roleInfo: ROLES, appInfo: appsView(releaseApps), apps: chosenApps(s, releaseApps), electrum: TESTNET4_ELECTRUM, owner: s.owner || null, service: s.service || null,
      build: buildOf(), seatPort: portOf(), defaultPort: seatPort, reach: s.reach || null, direct: s.direct || null, login: login ? { url: login.url, result: login.result } : null,
      lightning: s.lightning || null, coreSync: s.core ? { dir: s.core.dir || state.home, interim: !!s.core.interim, prune: !!s.core.prune } : null, gatewaySeat: GATEWAY_SEAT, launchers: s.launchers || null, gateway: s.gateway ? { ...s.gateway, passwordFile: undefined } : null, bond: s.bond || null, custodyLater: laterCustody(s), wallet: (s.done || {}).seed ? (() => { const parts = withOtherNodes(s, depositParts(s, (s.roles || []).includes('custody') ? (s.custody || {}).pegInSats ?? CUSTODY_PEG_IN_SATS : 0), { further: !!fundFrom });
        return { address: walletOf(fromHex(state.readSecret('seed.hex'))).address, needSats: String(Object.values(parts).reduce((a, x) => a + x, 0)), parts }; })() : null,
      confirm: pendingSeed ? { positions: pendingSeed.positions } : null, confirmWords: CONFIRM_WORDS,
      // kanban #596: how many nodes on this machine, and Fedimint on a RAM disk from more than 5
      instances: s.instances || { count: 1, ram: false }, instancesMax: INSTANCES_MAX, ramFrom: RAM_FROM };
  };
  // THE RELEASE'S APPS (kanban #569): read once - the release folder does not change under a running wizard
  const releaseApps = (() => { try { return appsIn(release); } catch (e) { log(`apps: ${e.message}`); return []; } })();
  const mark = (step, patch = {}) => state.update((n) => ({ ...patch, done: { ...(n.done || {}), [step]: Date.now() } }));   // the done map as it stands (kanban #1178)
  // A FUNDAMENTAL CHANGED ON AN INSTALLED NODE (kanban #734, the owner: "when re-running the install script and changing fundamental options
  // like bitcoin, lightning, roles, reach, the new setting should reflect in the owners page correctly instead of raising errors"): the
  // node's settings (arena.conf) are written only by "Install and start", which stayed done on a re-run - so a new Bitcoin source or new
  // roles were kept in the installer's state while the node ran on the old ones, and the owner page read the two against each other. When
  // the settings the node would get now differ from the ones before this save, "Install and start" opens again, as another way to be
  // reached does (kanban #666). Only a step saved before (a change, not its first save). Answers 'service' when it did.
  const reopenInstall = (was, step) => {
    const s = state.read();
    if (!(was.done || {})[step] || !(was.done || {}).service || !(s.done || {}).service) return null;
    const confOf = (x) => { try { return seatConf({ ...x, port: (x.reach || {}).port, bridgePort }, { home: state.home, release }); } catch { return null; } };
    if (confOf(was) === confOf(s)) return null;
    const { service: _s, ...rest } = s.done;
    state.save({ done: rest });
    return 'service';
  };

  // THE SERVICE STEP'S PROGRESS (kanban #651, 2026-10-25: "this hangs alot and user doesn't know what it is doing. Provide more
  // details and context and a progress bar"): POST /api/service moves through these stages; GET /api/service/progress tells the page
  // which is done, which runs and for how long, and - while the node is slow to answer, or after a failure - the node log's last lines
  const SERVICE_STAGES = [['settings', 'Writing your node\'s settings'], ['services', 'Installing its services'],
    ['start', 'Starting your node and waiting for its first answer'], ['tunnel', 'Getting your tunnel\'s address'],
    ['restart', 'Restarting your node on its new address'], ['address', 'Testing its public address'], ['login', 'Logging you in as its owner']];
  // THE STAGES OF A LONG STEP, AS THEY RUN (#651 for the service; kanban #661, 2026-10-25, the Lightning step: "Da hätte ich auch gerne
  // mehr debugs und eine progress bar" - "Da auch" for the gateway): which stage is done, which runs and for how long, and - once one
  // runs slow, or after a failure - the last lines of that program's log
  const tracker = (STAGES, logName, slowMs = 10000) => {
    let run = null;                          // { atMs, endMs, ok, why, stages: [{ id, label, state: todo|now|done|skipped|failed, atMs, ms }] }
    const fresh = () => STAGES.map(([id, label]) => ({ id, label, state: 'todo' }));
    return {
      begin: () => { run = { atMs: nowMs(), stages: fresh() }; },
      running: () => Boolean(run && !run.endMs),
      stage: (id) => {
        if (!run || run.endMs) return;
        const now = nowMs(), at = run.stages.findIndex((x) => x.id === id);
        if (at < 0 || run.stages.findIndex((x) => x.state === 'now') > at) return;   // never back to an earlier stage
        run.stages.forEach((x, i) => {
          if (i >= at) return;
          if (x.state === 'now') { x.state = 'done'; x.ms = now - x.atMs; } else if (x.state === 'todo') x.state = 'skipped';
        });
        if (run.stages[at].state !== 'now') {
          const was = run.stages.find((x) => x.state === 'done' && x.ms !== undefined && run.stages.indexOf(x) === at - 1);
          trace.verbose(`stage ${id}: ${run.stages[at].label}${was ? ` (${was.id} took ${was.ms} ms)` : ''}`);
          Object.assign(run.stages[at], { state: 'now', atMs: now });
        }
      },
      detail: (id, extra) => { const x = run && !run.endMs && run.stages.find((y) => y.id === id); if (x) Object.assign(x, extra); },
      end: (r) => {
        if (!run || run.endMs) return;
        const now = nowMs();
        for (const x of run.stages) {
          if (x.state === 'now') { x.state = r.ok ? 'done' : 'failed'; x.ms = now - x.atMs; } else if (x.state === 'todo' && r.ok) x.state = 'skipped';
        }
        Object.assign(run, { endMs: now, ok: !!r.ok, why: r.ok ? null : r.why });
        trace.verbose(`stages ${r.ok ? 'done' : `failed: ${r.why}`} after ${now - run.atMs} ms (${run.stages.map((x) => `${x.id} ${x.state}${x.ms !== undefined ? ` ${x.ms} ms` : ''}`).join(', ')})`);
      },
      view: (slowIds = null) => {
        if (!run) return { ok: true, running: false, stages: fresh() };
        const now = nowMs(), cur = run.stages.find((x) => x.state === 'now');
        const slow = cur && (!slowIds || slowIds.includes(cur.id)) && now - cur.atMs > slowMs;
        return { ok: true, running: !run.endMs, elapsedMs: (run.endMs || now) - run.atMs, why: run.why || null,
          stages: run.stages.map((x) => ({ ...x, ms: x.state === 'now' ? now - x.atMs : x.ms })), log: slow || run.ok === false ? (typeof logName === 'function' ? logName() : logTail(logName)) : [] };
      },
    };
  };
  const logTail = (name, n = 4) => {
    try { return readFileSync(join(state.home, name), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).map((l) => l.slice(0, 300)); } catch { return []; }
  };
  const svc = tracker(SERVICE_STAGES, 'node.log');
  const stage = svc.stage;
  const LND_STAGES = [['download', 'Downloading LND and checking it'], ['reach', 'Testing whether other Lightning nodes reach this computer'],
    ['start', 'Writing its settings and starting it'], ['wallet', 'Making its wallet from your seed'], ['answer', 'Waiting for LND\'s first answer']];
  // LND'S OWN LOG FIRST (kanban #664, 2026-10-25: "Starting LND… (connect ECONNREFUSED 127.0.0.1:10080)" with no reason): LND writes
  // logs/bitcoin/<network>/lnd.log in its folder on every system - where "unable to connect to bitcoind" stands; the service's own output
  // (lnd.log in the node's folder on macOS and Windows) when LND stopped before it could write there
  const lndLogs = () => {
    for (const net of ['testnet4', 'mainnet']) {
      const l = logTail(join('lnd', 'logs', 'bitcoin', net, 'lnd.log'));
      if (l.length) return l;
    }
    return logTail('lnd.log');
  };
  const lndRun = tracker(LND_STAGES, lndLogs);
  const GATEWAY_STAGES = [['find', 'Finding the gateway in this release'], ['start', 'Writing its settings and starting it'],
    ['answer', 'Waiting for the gateway\'s first answer']];
  const gwRun = tracker(GATEWAY_STAGES, 'gateway.log');
  // BITCOIN CORE'S INSTALL, AS IT RUNS (the owner's playtest 2026-10-25: "Downloading Bitcoin Core and checking it…" - "Füge auch hier
  // eine Progress Bar hinzu"): the download by its bytes, then the check, the unpacking, the services and the interim chain
  const CORE_STAGES = [['download', 'Downloading Bitcoin Core from bitcoincore.org'], ['check', 'Checking it against the published checksum'],
    ['unpack', 'Unpacking it'], ['services', 'Setting it up as a service and starting it'], ['chain', 'Finding a chain server for the meantime']];
  const coreRun = tracker(CORE_STAGES, null);
  const mb = (n) => Math.round(n / 1e6);
  // BITCOIN CORE INSTALLED HERE (POST /api/core/install): the checked download, a service per network, then an interim chain
  const coreInstall = async (b) => {
    const where = coreDirOf(b);
    if (!where.ok) return where;
    const found = await coreKit.detectBitcoind({ home: state.home });
    if (found && !found.startsWith(state.home)) return { ok: false, why: `Bitcoin Core is installed already (${found}): connect it with its RPC address and cookie file instead` };
    let disk;
    try { disk = coreKit.diskCheck(where.dir); } catch (e) { return { ok: false, why: `cannot use ${where.dir}: ${e.code || e.message}` }; }
    const nets = ['testnet4', ...(b.mainnet ? ['mainnet'] : [])];
    const prune = Boolean(b.prune);
    const need = nets.reduce((a, n) => a + (prune ? NEEDS[n].prunedBytes : NEEDS[n].fullBytes), 0);
    if (disk.freeBytes < need) return { ok: false, why: `${Math.round(disk.freeBytes / 2 ** 30)} GB free, and ${nets.join(' + ')}${prune ? ' pruned' : ''} need about ${Math.round(need / 2 ** 30)} GB`, disk };
    const got = await coreKit.installCore({ home: state.home, fetcher, onStage: coreRun.stage,
      onBytes: (got, total) => coreRun.detail('download', { part: total ? got / total : null, text: total ? `${mb(got)} of ${mb(total)} MB` : `${mb(got)} MB` }) });
    if (!got.ok) return { ok: false, why: got.why };
    coreRun.stage('services');
    const networks = {};
    for (const n of nets) {
      const c = coreKit.configureCore({ home: where.dir, network: n, prune, ...(coreKit.freeCorePorts ? { ports: await coreKit.freeCorePorts(n) } : {}) });   // free ones (kanban #635)
      const r = await coreKit.installProgram({ id: `bitcoind-${n}`, description: `Bitcoin Core for Bitcoin Arena (${n})`, args: coreKit.coreArgs({ bitcoind: got.bitcoind, datadir: c.datadir }), home: state.home, boot: b.boot !== false });
      if (!r.ok) return { ok: false, why: r.why };
      networks[n] = { rpcUrl: c.rpcUrl, cookiePath: c.cookiePath, datadir: c.datadir };
    }
    const core = { bitcoind: got.bitcoind, prune, dir: where.dir, networks, startedMs: nowMs() };
    state.save({ core });
    // THE SYNC RUNS IN THE BACKGROUND (kanban #635, 2026-10-25: "Auch der Bitcoin core nicht im Vordergrund machen lassen während
    // der synced"): a Core still syncing cannot see a fresh deposit nor take a transaction that spends one, so until it is synced the
    // node reads the chain through a public Electrum server - the first that passes the chain test - and the chain-switch keeper
    // (bin/chain-switch.mjs, installed with the service) moves it to its own Core once testnet4 is synced. With no server passing,
    // the wizard waits for the sync as before.
    coreRun.stage('chain');
    for (const e of TESTNET4_ELECTRUM) {
      const conn = chainOf({ kind: 'electrum', host: e.host, port: e.port, tls: e.tls, ws: e.ws, path: e.path });
      const t = await test(conn).catch((err) => ({ ok: false, why: err.message }));
      if (!t.ok) { log(`[core] interim chain ${e.host}:${e.port}: ${t.why}`); continue; }
      mark('chain', { chain: conn, chainTest: { atMs: Date.now(), why: t.why, latencyMs: t.source.latencyMs, height: t.source.height }, core: { ...core, interim: true } });
      return { ok: true, core, interim: { host: e.host, port: e.port } };
    }
    return { ok: true, core, interim: null };
  };
  // THE SERVICE (C.9): the settings, the unit, started, healthy; then the owner's first login against the running node (C.6 "tested by
  // one login") - signed here with the seed's owner key, or by the browser's Nostr signer (POST /api/owner/login).
const serviceRun = async (b) => {
    let s = state.read();
    for (const k of ['chain', 'roles', 'seed', 'owner', 'reach']) if (!(s.done || {})[k]) return { ok: false, why: `the ${k} step is not done` };
    // AN OLDER INSTALLER DOES NOT MOVE A NEWER NODE BACK (kanban #734, measured 2026-10-29 in the Linux VM: the 2026.1.9.12 installer run
    // again on a node updated to 2026.1.9.14 - its "Install and start" put the node's services on 2026.1.9.12, and the owner page said
    // "A new release is out"): the release this node runs against this installer's own; a newer node is left as it is
    const runs = (() => { try { return nodeOf(state.home).version; } catch { return null; } })();
    let mine = null; try { mine = readFileSync(join(release, 'VERSION'), 'utf8').trim(); } catch { mine = null; }
    if (runs && mine && newerVersion(runs, mine)) return { ok: false, why: `this node runs ${runs}, newer than this installer (${mine}): Install and start would move it back to ${mine}. Run the installer of ${runs} or newer instead (bitcoinarena update keeps the node current)` };
    const port = s.reach.port;
    const boot = b.boot !== false;
    const conf = { ...s, port, bridgePort };
    stage('settings');
    // the hosted games again, from this release's apps (an installer updated since the apps step carries newer versions)
    try { const hg = await hostedGameIdsOf(release, chosenApps(s, releaseApps), releaseApps); if (hg.length) s = state.save({ hostedGames: hg }); } catch (e) { log(`apps: the hosted games could not be read: ${e.message}`); }
    state.writeSecret('arena.conf', seatConf(conf, { home: state.home, release }));
    const tunnel = !reach.tunnelMode(s.reach.mode) ? null : reach.tunnelUnit({ bin: cloudflared, mode: s.reach.mode, config: s.reach.config, port });
    const tunnelArgs = !reach.tunnelMode(s.reach.mode) ? null : reach.tunnelArgsOf({ bin: cloudflared, mode: s.reach.mode, config: s.reach.config, port });
    const installAt = Date.now();                                    // a restarted quick tunnel's name is the one logged after this
    // THE NODE'S IDENTITY FROM ITS SEED (kanban #650/#653): adopted before its first start, so the same words or nsec restore this node and
    // its bond; a node folder that has an identity already keeps it (identityFromSeed says which)
    // a Nostr node signs with its nsec - its identity, adopted at the first step - so setup logs its owner in with that same key, read
    // from its store before the node holds it
    let nostrKey = null;
    if (s.control === 'nostr') { const db = openStore(state.path('node.db')); try { nostrKey = nodeIdentity(db).secret; } finally { db.close(); } }
    if (state.exists('seed.hex') && s.control !== 'nostr') {   // (a Nostr node's identity is its nsec, adopted at the first step)
      const db = openStore(state.path('node.db'));
      try { s = state.save({ identityFromSeed: adoptIdentity(db, nodeKeyOf(fromHex(state.readSecret('seed.hex').trim()))) }); } finally { db.close(); }
    }
    stage('services');
    const r = await install({ release, home: state.home, port, bridgePort: s.chain.kind === 'electrum' ? bridgePort : null, tunnel, tunnelArgs, boot, onStage: stage });
    if (!r.ok) return { ok: false, why: r.why };
    // THE RELEASE THE NODE RUNS, RECORDED AT THE INSTALL as an update records it (node-services.js nodeOf: its version, the auto update)
    s = state.save({ release: { path: release, atMs: Date.now() } });
    // THE CHAIN SWITCH (kanban #635): a Core still syncing behind the interim Electrum chain - its keeper moves the node to it once synced
    if (s.core && s.core.interim && s.chain.kind === 'electrum') {
      const k = await gwKit.installProgram({ id: 'chain-switch', description: 'Bitcoin Arena: moves the node to its own Bitcoin Core once it is synced', home: state.home, boot,
        args: [process.execPath, join(release, 'packages', 'arena-installer', 'bin', 'chain-switch.mjs'), '--home', state.home] });
      if (!k.ok) log(`[service] the chain switch did not start: ${k.why}`);
    }
    // THE PUBLIC ADDRESS, TESTED: a tunnel from outside through Cloudflare's edge (a quick tunnel's name read first, and the node's
    // settings rewritten with it - it is new at every restart); a direct node was reached by the seats before it started
    let reachTest = null;
    // each part its own stage (kanban #667, 2026-10-25: "the loader is stuck at testing the tunnel but its doing other stuff"): the tunnel's
    // name, the node restarted on it, then the test
    if (s.reach.mode === 'quick' || s.reach.mode === 'workers') stage('tunnel');
    if (s.reach.mode === 'quick') {
      const url = await reach.quickTunnelUrl({ home: state.home, sinceMs: installAt });
      if (url) {
        s = state.merge('reach', { url });
        const before = seatConf(conf, { home: state.home, release }), after = seatConf({ ...s, port, bridgePort }, { home: state.home, release });
        state.writeSecret('arena.conf', after);
        // THE SEAT READS WHAT ITS SETTINGS NOW SAY (kanban #577, measured 2026-10-22 on the second machine: installer nodes 3-7 ran on the 15 settings
        // they started with - the quick tunnel's name, and with it the custody node's guardian and founding settings, came only after the start -
        // so they ran no guardian and could never be drawn into a founding): the seat alone restarted, never its tunnel (a new name)
        if (seatNeedsRestart(before, after)) { stage('restart'); const rs = await restartSeat(state.home); log(`[service] the seat restarted on its new settings: ${rs && rs.ok === false ? rs.why : 'ok'}`); }
        // AND THE GATEWAY (kanban #818, a friend's node 2026-10-30: "der temporary tunnel, wenn der sich ändert beim Rerun vom installer, aber das
        // script nicht anpasst, läuft der auch ins Leere"): a rerun gets a new name, the settings took it above, and its service and the address
        // the node publishes for it kept the old one
        if (s.gateway) { const f = await followTunnel(state.home).catch((e) => ({ restarted: [], why: e.message })); log(`[service] the gateway follows the tunnel's name: ${(f.restarted || []).join(', ') || f.why || 'nothing to change'}`); }
      }
    }
    // workers.dev: the Worker forwards to the quick tunnel's first name, and its keeper follows every new one
    if (s.reach.mode === 'workers') {
      const target = await reach.quickTunnelUrl({ home: state.home, sinceMs: installAt });
      if (!target) return { ok: false, why: 'the node runs, but its quick tunnel gave no name for the Worker to forward to', identity: r.identity };
      const d = await workersKit.deployForwarder({ token: state.readSecret('cf-workers-token'), accountId: s.reach.accountId, name: s.reach.workerName, target, fetcher });
      if (!d.ok) return { ok: false, why: `the node runs, but ${d.why}`, identity: r.identity };
      s = state.merge('reach', { target, targetAtMs: Date.now() });
      const k = await gwKit.installProgram({ id: 'workers', description: 'Bitcoin Arena: keeper of the workers.dev address', home: state.home, boot,
        args: [process.execPath, join(release, 'packages', 'arena-installer', 'bin', 'workers-keeper.mjs'), '--home', state.home] });
      if (!k.ok) return { ok: false, why: `the Worker forwards, but its keeper did not start: ${k.why}`, identity: r.identity };
    }
    if (s.reach.mode !== 'direct') stage('address');
    // a quick tunnel that never answers is started again (kanban #704, reach.js testWithNewTunnels)
    if (s.reach.mode === 'quick' && s.reach.url) {
      const t = await (reach.testWithNewTunnels || reachKit.testWithNewTunnels)({ url: s.reach.url, identity: r.identity, fetcher, log, test: reach.testPublicUrl,
        newTunnel: async () => { const rt = await restartTunnel(state.home); return rt && rt.tunnel ? rt.tunnel.url : null; } });
      reachTest = t.reachTest;
      if (t.url !== s.reach.url) s = state.merge('reach', { url: t.url });
    } else if (s.reach.mode !== 'direct') reachTest = s.reach.url ? await reach.testPublicUrl({ url: s.reach.url, identity: r.identity, fetcher }) : { ok: false, why: 'the quick tunnel gave no name' };
    let login = null;
    if (s.owner.mode === 'seed') { stage('login'); login = await ownerLogin(signedBySeed(r.identity)); }
    else if (nostrKey) {
      stage('login');
      login = await ownerLogin(signOwnerRequest({ node: r.identity, action: 'login', args: {}, secret: nostrKey, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) }));
    }
    state.save({ service: { port, identity: r.identity, startedInMs: r.ms, boot: r.boot, linger: r.linger, reachTest, atMs: Date.now() } });
    if (reachTest && !reachTest.ok) return { ok: false, why: `the node runs, but not at its public address: ${reachTest.why}`, identity: r.identity };
    if (login && !login.ok) return { ok: false, why: `the node runs, but the owner login failed: ${login.why}`, identity: r.identity };
    if (login) mark('service', { ownerLoginMs: Date.now() });
    saveLaunchers();
    return { ok: true, identity: r.identity, ms: r.ms, boot: r.boot, linger: r.linger, reachTest, url: s.reach.url, login,
      template: s.owner.mode === 'nostr' && !nostrKey ? ownerEventTemplate({ node: r.identity, action: 'login' }) : null };
  };

  // THE STEPS' DOORS. Each answers { ok, ... } and saves only what passed.
  const api = {
    'GET /api/state': async () => ({ ok: true, ...view() }),
    // HOW MANY NODES (kanban #596): the intro's count and RAM disk choice, checked as `arena-install --instances` checks them
    'POST /api/instances': async (b) => {
      const c = instancesChoice({ count: b.count, ram: b.ram, name: b.name, network: 'testnet4' });
      if (!c.ok) return c;
      state.save({ instances: { count: c.count, ram: c.ram, name: c.name, first: { instance: INSTANCE, portOffset: PORT_OFFSET } } });   // node 1's name and ports (kanban #596)
      return { ok: true, instances: { count: c.count, ram: c.ram, name: c.name }, note: instancesNote(c.count) };
    },

    'POST /api/chain/test': async (b) => ({ ok: true, result: await test(chainOf(b)) }),
    'POST /api/chain/save': async (b) => {
      const was = state.read();
      let conn = chainOf(b);
      // AN ELECTRUM SERVER UNDER A NODE THAT RUNS LND (kanban #734: a re-run that changes the Bitcoin source): custody and a liquidity provider
      // need the node's own Bitcoin Core, so the source is not changed under them - the roles step refuses the other way round already
      const needCore = (was.roles || []).filter((r) => r === 'custody' || r === 'liquidity');
      if (needCore.length && conn.kind === 'electrum' && !ownCoreOf({ ...was, chain: conn })) return { ok: false, why: `this node runs ${needCore.join(' and ')}, which need${needCore.length === 1 ? 's' : ''} your own Bitcoin Core: LND cannot run on an Electrum server. Keep Bitcoin Core, or install it here` };
      let r = await test(conn);
      // AN ELECTRUM SERVER THAT FAILS BETWEEN THE CHOICE AND THE SAVE (kanban #638, the owner's playtest 2026-10-25: "sometimes the selected
      // electrum node fails after selecting but before moving to the next stage"): asked once more, then the other known servers in turn;
      // the first that passes is saved, and the page says which
      let switchedFrom = null;
      if (!r.ok && conn.kind === 'electrum') {
        // all at once (measured in the walk of 1ebc8cbe: one after another took over 40 s with mempool.space not answering): the chosen
        // server again beside every other known one; the chosen one when it answers now, else the first of the list that does
        const others = TESTNET4_ELECTRUM.filter((x) => !(x.host === conn.host && x.port === conn.port)).map((x) => ({ kind: 'electrum', host: x.host, port: x.port, tls: x.tls, ...(x.ws ? { ws: true, path: x.path } : {}) }));
        const [again, ...answers] = await Promise.all([conn, ...others].map((c) => test(c).catch((e) => ({ ok: false, why: e.message }))));
        if (again.ok) r = again;
        else {
          const i = answers.findIndex((x) => x.ok);
          if (i >= 0) { switchedFrom = `${conn.host}:${conn.port} (${r.why})`; conn = others[i]; r = answers[i]; }
        }
      }
      if (!r.ok) return { ok: false, why: conn.kind === 'electrum' ? `${r.why}; no other known Electrum server answered either - try again in a minute, or use Bitcoin Core` : r.why, result: r };
      if (conn.kind === 'core' && conn.user) {        // main.js reads a cookie file: user:password in one of our own, 0600
        state.writeSecret('bitcoind.auth', `${conn.user}:${conn.password}\n`);
        conn.cookiePath = state.path('bitcoind.auth'); delete conn.password;
      }
      mark('chain', { chain: conn, chainTest: { atMs: Date.now(), why: r.why, latencyMs: r.source.latencyMs, height: r.source.height }, chainSwitchedFrom: switchedFrom });
      const again = reopenInstall(was, 'chain');   // kanban #734: the node takes the new source
      return { ok: true, result: r, chain: conn, switchedFrom, ...(again ? { again } : {}) };
    },

    // BITCOIN CORE, INSTALLED WHEN ASKED (ruling 8): the plan (one already here? the disk against what mainnet and testnet4 need),
    // the install (checked download, a datadir and config per network, a service each), and the sync's progress with an ETA - and once
    // testnet4 is synced, the chain step is saved with it and the wizard goes on
    // WHERE ITS BLOCKS GO IS THE OWNER'S CHOICE (kanban #635, 2026-10-25: "Wo BTC core installiert wird sollte auswählbar
    // sein"): a folder on any disk - the node's own folder when none is given - checked for space before anything is written
    'POST /api/core/plan': async (b = {}) => {
      const where = coreDirOf(b);
      if (!where.ok) return where;
      const found = await coreKit.detectBitcoind({ home: state.home });
      let disk;
      try { disk = coreKit.diskCheck(where.dir); } catch (e) { return { ok: false, why: `cannot use ${where.dir}: ${e.code || e.message}` }; }
      return { ok: true, installed: found, disk, dir: where.dir, defaultDir: state.home, needs: NEEDS, core: state.read().core || null };
    },
    'POST /api/core/install': async (b) => {
      coreRun.begin();
      let r;
      try { r = await coreInstall(b); } catch (e) { r = { ok: false, why: e.message }; }
      coreRun.end(r);
      return r;
    },
    'GET /api/core/progress': async () => coreRun.view([]),
    'GET /api/core/status': async () => {
      const s = state.read();
      if (!s.core) return { ok: false, why: 'no Bitcoin Core was installed by this installer' };
      const out = {};
      for (const [n, c] of Object.entries(s.core.networks)) {
        let r = await coreKit.syncStatus({ ...c, samples: coreSamples.get(n) || [], nowMs: nowMs(), fetcher });
        // A PORT ANOTHER PROGRAM HOLDS (kanban #635): moved to free ones and started again - the page says so, never "starting" for ever
        if (r.portTaken) {
          const fixed = await repairCorePorts({ state, network: n, coreKit });
          r = { ok: false, why: fixed.ok ? `${r.why}: moved to port ${fixed.ports.rpc} and started again` : `${r.why}; ${fixed.why}`, samples: [] };
        }
        coreSamples.set(n, r.samples || []);
        out[n] = { ...r, samples: undefined };
      }
      // TESTNET4 SYNCED: the chain step saved with this node, as the Bitcoin Core option would save it, tested the same way
      // - said beside the networks, where the page reads it (kanban #684, 2026-10-26: "bitcoinarena install waiting for bitcoin core / electrum
      // sync": chainSaved stood inside `networks`, so the page at 100 % "synced" never went on and never said why)
      const t4 = out.testnet4;
      let saved = {};
      if (t4 && t4.ok && t4.synced && !(s.done || {}).chain) {
        const conn = { kind: 'core', url: s.core.networks.testnet4.rpcUrl, cookiePath: s.core.networks.testnet4.cookiePath };
        const r = await test(conn).catch((e) => ({ ok: false, why: e.message }));
        if (r.ok) mark('chain', { chain: conn, chainTest: { atMs: Date.now(), why: r.why, latencyMs: r.source.latencyMs, height: r.source.height } });
        else log(`[core] testnet4 is synced, but its chain test failed: ${r.why}`);
        saved = { chainSaved: r.ok, chainWhy: r.why };
      }
      return { ok: true, networks: out, ...saved };
    },

    // THE ROLES CHECKED AS THEY ARE SWITCHED ON (kanban #641, the owner's playtest 2026-10-25: "when selecting custody role, the check of the
    // bitcoin node should happen at that moment, not only when moving to the next step"): the same check the save runs, nothing saved
    'POST /api/roles/check': async (b) => { const why = rolesRefusal([...new Set((b.roles || []).map(String))]); return why ? { ok: false, why } : { ok: true }; },
    'POST /api/roles': async (b) => {
      const roles = [...new Set((b.roles || []).map(String))];
      const refused = rolesRefusal(roles);
      if (refused) return { ok: false, why: refused };
      const was = state.read();
      // ROLES OF A NODE WHOSE BOND IS POSTED (kanban #734, a re-run that changes the roles): the bond's advertisement names them, and the census
      // the owner page reads is that advertisement - so the roles state alone would leave the page and the node at odds. Custody chosen now is
      // custody added later (--add-custody: the custody steps, then an update of the advertisement); every other change is the owner page's,
      // which posts the update (Roles), sets up a provider (Liquidity) or lets a guardian go (Leave); custody added and then left out again
      // returns the node as it was (below)
      const had = was.roles || [], bonded = !!(was.bond && was.bond.txid) && !!(was.done || {}).roles;
      const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
      if (bonded && !same(roles, had) && !(laterCustody(was) && same(roles, had.filter((x) => x !== 'custody')))) {
        const added = roles.filter((x) => !had.includes(x)), dropped = had.filter((x) => !roles.includes(x));
        if (!(added.length === 1 && added[0] === 'custody' && !dropped.length)) {
          const why = dropped.includes('custody') ? 'a guardian leaves only with Leave on its owner page, so its bond is kept'
            : [...added, ...dropped].some((x) => x === 'liquidity') ? 'a liquidity provider is set up on the owner page (Roles, Liquidity provider)'
              : 'your bond names them: switch them on the owner page (Roles), which updates the bond for a small fee';
          return { ok: false, why: `This node's bond is posted, so its roles change on its owner page, not here: ${why}. Custody can be added here.` };
        }
        state.save({ custodyLater: { atMs: Date.now() } });
        const { service: _s, lightning: _l, federation: _f, promise: _p, bond: _b, done: _d, ...rest } = state.read().done || {};
        state.save({ done: rest });
      }
      const ln = roles.includes('custody') || roles.includes('liquidity');   // the roles that run LND
      mark('roles', { roles });
      // no custody: no Lightning, federation or bond-rules step (2026-10-18: "No slashing for leaving if you have no custody, so that will only come then")
      if (!roles.includes('custody')) { mark('federation', { federation: null }); mark('promise', { promise: null }); }
      if (!ln) {
        mark('lightning', { lightning: null });
        // custody not added after all: the node as it was - its install and its posted bond stand
        if ((state.read().bond || {}).txid) { mark('bond'); if (state.read().service) mark('service'); }
      }
      else if (!(state.read().lightning || {}).pubkey) {                          // LND, and none tested yet: the step is to come (custody's too)
        const { lightning: _, federation: __, promise: ___, ...rest } = state.read().done || {};
        state.save({ done: roles.includes('custody') ? rest : { ...rest, federation: (state.read().done || {}).federation, promise: (state.read().done || {}).promise } });
      }
      const again = reopenInstall(was, 'roles');   // kanban #734: an installed node without a bond takes its new roles' settings
      return { ok: true, roles, ...(again ? { again } : {}) };
    },

    // THE APPS (kanban #569, 2026-10-21: "The node still comes with the 3 apps pre installed, that is a step in the installer
    // where all apps are automatically selected"): the ones the seat hosts, at least one; an app this release does not carry is refused
    'POST /api/apps': async (b) => {
      const apps = [...new Set((Array.isArray(b.apps) ? b.apps : []).map(String))];
      const unknown = apps.filter((id) => !releaseApps.some((a) => a.id === id));
      if (unknown.length) return { ok: false, why: `no app ${unknown.join(', ')} in this release` };
      if (!apps.length && releaseApps.length) return { ok: false, why: `choose at least one app: ${releaseApps.map((a) => a.short).join(', ')}` };   // (a release from before app.json: nothing to choose, Next Block as before)
      // the game ids the bond's advertisement names: every version of these apps the seat hosts (newest included), not Next Block's first alone
      let hostedGames = null;
      try { hostedGames = await hostedGameIdsOf(release, apps.length ? apps : releaseApps.map((x) => x.id), releaseApps); } catch (e) { log(`apps: the hosted games could not be read: ${e.message}`); }
      mark('apps', { apps, ...(hostedGames && hostedGames.length ? { hostedGames } : {}) });
      return { ok: true, apps, hostedGames };
    },

    // NEW OR RESTORED, BY 24 WORDS OR BY NOSTR (kanban #652/#654, 2026-10-25: "neuer step im installer: New/Restore"; "User first
    // selects Operation Mode: Nostr / New Seed (24 Words)"; #653 "Only allow nsec then"): the first step.
    //   words + new      the seed step shows new words later
    //   words + restore  the 24 typed words are checked (a wrong word or checksum refused by name) and become the seed; the seed step is done
    //   nostr (new or restore)  the nsec is the node's own key on the network (kept in its store, so it runs on it alone), gives the seed
    //                    (seed.js seedOfNsec) and is the owner: the seed and owner steps are done. The same nsec gives the same node again,
    //                    so new and restore differ only in what the page says.
    // With 24 words the node's identity comes from the seed (adopted before its first start). A node that has a seed keeps it: only the
    // words or nsec that gave it are taken again.
    'POST /api/start': async (b) => {
      const control = b.control || (b.mode === 'restore' || b.mode === 'new' ? 'words' : null);
      const action = b.action || b.mode;
      if (!['words', 'nostr'].includes(control)) return { ok: false, why: 'choose 24 words or Nostr' };
      if (!['new', 'restore'].includes(action)) return { ok: false, why: 'choose a new node or a restore' };
      const s0 = state.read();
      const keep = (hex) => (state.exists('seed.hex') && state.readSecret('seed.hex').trim() !== hex
        ? { ok: false, why: `this node has other ${s0.control === 'nostr' ? 'Nostr key' : 'words'} already: set up another node folder for that` } : null);
      if (control === 'words' && action === 'new') {
        if (state.exists('seed.hex') && (s0.origin === 'restore' || s0.control === 'nostr')) return { ok: false, why: 'this node has its seed already' };
        mark('start', { origin: 'new', control: 'words' });
        return { ok: true, control, origin: 'new' };
      }
      let seed, owner = null;
      if (control === 'words') {
        const words = String(b.words || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length !== 24) return { ok: false, why: `type all 24 words, in order (${words.length} typed)` };
        const r = seedOfWords(words.join(' '));
        if (!r.ok) return { ok: false, why: r.why };
        seed = r.seed;
      } else {
        const r = seedOfNsec(b.nsec);
        if (!r.ok) return { ok: false, why: r.why };
        seed = r.seed; owner = r.pubkey;
      }
      const hex = toHex(seed);
      const refused = keep(hex);
      if (refused) return refused;
      state.writeSecret('seed.hex', hex + '\n');
      pendingSeed = null;
      const { pubkey } = ownerKeyOf(seed);
      const em = emergencyOf(seed);
      const now = Date.now(), done = { ...(s0.done || {}), start: now, seed: now };
      if (owner) {
        // THE NODE RUNS ON THE NSEC ITSELF (2026-10-25: "The node must also operate on its own with the nsec"): the Nostr key is the
        // node's identity on the network - it signs its proposals and bonds with no one at the page - and its owner
        const db = openStore(state.path('node.db'));
        let own;
        try { own = adoptIdentity(db, seedOfNsec(b.nsec).secret); } finally { db.close(); }
        if (!own) return { ok: false, why: 'this node folder has another node identity already: set up another node folder for that' };
        writeFileSync(state.path('node.db.owner.json'), JSON.stringify({ pubkey: owner, claimedAtMs: now, nostrSeed: true }) + '\n', { mode: 0o600 });
        done.owner = now;
      }
      state.save({ origin: action, control, seedOwnerPubkey: pubkey, emergencyPubkey: em.pubkey, done, ...(owner ? { owner: { mode: 'nostr', pubkey: owner } } : {}) });
      return { ok: true, control, origin: action, ownerPubkey: owner || pubkey, emergencyCode: em.code };
    },
    // a Nostr key for someone who has none (the owner's wallet screenshot: "New to Nostr? Create an account"): shown once, never kept here
    'POST /api/start/nsec': async () => ({ ok: true, ...newNsec() }),

    // THE SEED: shown once (C.5), kept in memory until the user types back CONFIRM_WORDS words; only then written (0600). A node that
    // already has a seed never makes a second one.
    'POST /api/seed/new': async () => {
      if (state.exists('seed.hex')) return { ok: false, why: 'this node already has its seed' };
      if (!pendingSeed) { const s = newSeed(); pendingSeed = { ...s, positions: confirmPositions() }; }
      return { ok: true, words: pendingSeed.words, positions: pendingSeed.positions };
    },
    'POST /api/seed/confirm': async (b) => {
      if (!pendingSeed) return { ok: false, why: state.exists('seed.hex') ? 'already confirmed' : 'no seed shown yet' };
      const c = checkConfirm(pendingSeed.words, pendingSeed.positions, b.answers);
      if (!c.ok) return { ok: false, why: `word${c.wrong.length > 1 ? 's' : ''} ${c.wrong.join(', ')} ${c.wrong.length > 1 ? 'are' : 'is'} not what was shown - check what you wrote down`, wrong: c.wrong };
      state.writeSecret('seed.hex', toHex(pendingSeed.seed) + '\n');
      const { pubkey } = ownerKeyOf(pendingSeed.seed);
      // THE EMERGENCY CODE, shown now to be written down beside the words (§23A.5a) - derived, never stored
      const em = emergencyOf(pendingSeed.seed);
      pendingSeed = null;
      mark('seed', { seedOwnerPubkey: pubkey, emergencyPubkey: em.pubkey });
      return { ok: true, emergencyCode: em.code };
    },

    // THE EMERGENCY CODE'S OWN STEP (kanban #647, the owner's playtest 2026-10-25: "the emergency code notice should be an overlay or a separate
    // step in the installation process. also the description is confusing" - "extra step it is, and make the text clearer and simpler"):
    // shown from the seed after the words (or the Nostr key), done once the owner says it is written down
    'POST /api/emergency/written': async () => {
      if (!state.exists('seed.hex')) return { ok: false, why: 'no seed yet' };
      mark('emergency');
      return { ok: true };
    },
    // THE EMERGENCY CODE AGAIN (§23A.5a): from the seed on this machine, for the owner at the wizard
    // THE OWNER'S KEY FOR THE BROWSER (playtest 2026-10-25: "Der Installer soll sich mit meiner Seed schon einloggen so dass ich das nicht
    // extra wieder machen muss"): the Done page hands it to the node's dashboard it opens (window to window, never in a URL), which keeps it
    // where the owner page reads it - the owner page opens logged in. Only to this setup's own session, before Finish ends it.
    'GET /api/owner/handoff': async () => {
      const s = state.read();
      if (s.control === 'nostr') {
        const db = new DatabaseSync(state.path('node.db'), { readOnly: true });
        try { return { ok: true, kind: 'nsec', secret: toHex(new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret)) }; } finally { db.close(); }
      }
      if ((s.owner || {}).mode === 'seed' && state.exists('seed.hex')) return { ok: true, kind: 'seed', seed: state.readSecret('seed.hex').trim() };
      return { ok: false, why: 'this node\'s owner is a Nostr key from a signer: log in with it on the owner page' };
    },
    'GET /api/emergency': async () => {
      if (!state.exists('seed.hex')) return { ok: false, why: 'no seed yet' };
      const em = emergencyOf(fromHex(state.readSecret('seed.hex')));
      return { ok: true, code: em.code, pubkey: em.pubkey, inAdvert: EMERGENCY_IN_ADVERT };
    },

    // THE OWNER (C.6): the seed's owner key (the same 24 words log in at /Dashboard/owner) or a Nostr key. Written beside the node's
    // database before its first start, so the node never has a claim code: nobody but this owner can take it.
    'POST /api/owner': async (b) => {
      const s = state.read();
      if (!(s.done || {}).seed) return { ok: false, why: 'confirm the seed first' };
      let pubkey, mode;
      if (b.mode === 'nostr') { pubkey = nostrPubkeyHex(b.npub); mode = 'nostr'; if (!pubkey) return { ok: false, why: 'that is neither an npub nor 64 hex characters' }; }
      else { pubkey = s.seedOwnerPubkey; mode = 'seed'; }
      writeFileSync(state.path('node.db.owner.json'), JSON.stringify({ pubkey, claimedAtMs: Date.now() }) + '\n', { mode: 0o600 });
      mark('owner', { owner: { mode, pubkey } });
      return { ok: true, owner: { mode, pubkey } };
    },

    // REACH (ruling 7). The direct check first: its answer picks the default (direct when reached, else Funnel on a tailnet, else the permanent tunnel).
    'POST /api/reach/direct': async (b) => {
      const port = Number(b.port) || seatPort;
      // the node's home: an installed node on this port answers the check itself (kanban #734)
      const r = await reach.checkDirect({ port, fetcher, home: state.home });
      // not reached: a machine on a tailnet is pointed at Funnel (kanban #734); nothing is opened on the router either way
      if (!r.reached) r.tailnet = await reach.tailnetName({ bin: tailscale, sh: tailscaleSh });
      state.save({ direct: { ...r, atMs: Date.now() } });
      return { ok: true, result: r, default: reach.defaultReach(r) };
    },
    'POST /api/reach/login': async () => {
      if (login && !login.result) return { ok: true, url: login.url };
      const l = await reach.cloudflareLogin({ bin: cloudflared });
      if (!l.ok) return { ok: false, why: l.why };
      login = { url: l.url, result: null };
      l.wait().then((r) => { login.result = r; });
      if (!l.url) login.result = { ok: true, why: 'already logged in' };
      return { ok: true, url: l.url, result: login.result };
    },
    'POST /api/reach/save': async (b) => {
      const mode = String(b.mode || '');
      if (!reach.REACH_MODES.includes(mode)) return { ok: false, why: 'direct, permanent, quick, tailscale or workers' };
      const was = state.read();
      const r = await (async () => {
        const s = state.read();
        const port = mode === 'direct' ? ((s.direct || {}).port || seatPort) : (Number(b.port) || seatPort);
        if (mode === 'direct') {
          if (!s.direct || !s.direct.reached) return { ok: false, why: s.direct ? `this machine is ${reach.notReachedText({ ...s.direct, port: s.direct.port || port })}` : 'test the direct connection first, or choose a tunnel' };
          return { ok: true, reach: mark('reach', { reach: { mode, port, url: `http://${s.direct.address.includes(':') ? `[${s.direct.address}]` : s.direct.address}:${port}` } }).reach };
        }
        if (mode === 'quick') return { ok: true, reach: mark('reach', { reach: { mode, port, url: null } }).reach };
        // workers.dev (2026-10-18: "Implement workers dev tunnel"): the operator's own token, account and subdomain; the Worker itself
        // is uploaded at the install, once the quick tunnel behind it has a name
        if (mode === 'workers') {
          const token = String(b.cfToken || '').trim();
          const name = (s.reach && s.reach.mode === 'workers' && s.reach.workerName) || workersKit.workerNameOf(randomBytes(3).toString('hex'));
          const w = await workersKit.workersSetup({ token, name, wantSubdomain: b.cfSubdomain || null, fetcher });
          if (!w.ok) return { ok: false, why: w.why };
          state.writeSecret('cf-workers-token', token);
          return { ok: true, reach: mark('reach', { reach: { mode, port, url: w.url, workerName: name, accountId: w.accountId, subdomain: w.subdomain } }).reach };
        }
        if (mode === 'tailscale') {
          const t = await reach.tailscaleFunnel({ bin: tailscale, port, sh: tailscaleSh });
          if (!t.ok) return { ok: false, why: t.why };
          return { ok: true, reach: mark('reach', { reach: { mode, port, url: t.url, host: t.host, httpsPort: t.httpsPort } }).reach };
        }
        // permanent: logged in, then the tunnel and its name
        if (!login || !login.result || !login.result.ok) return { ok: false, why: 'log in to Cloudflare first (the link above), then save' };
        const hostname = String(b.hostname || '').trim().toLowerCase();
        if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(hostname)) return { ok: false, why: 'a name such as node.example.com, under a domain on your Cloudflare account' };
        const t = await reach.cloudflareTunnel({ bin: cloudflared, name: `arena-node-${hostname.split('.')[0]}`, hostname, port, home: state.home });
        if (!t.ok) return { ok: false, why: t.why };
        return { ok: true, reach: mark('reach', { reach: { mode, port, url: `https://${hostname}`, hostname, tunnel: t.id, config: t.config } }).reach };
      })();
      // THE ADDRESS SURVIVES GOING BACK (kanban #666, 2026-10-25: "going back to any previous step after setting reach breaks reach. the
      // setting is lost and cant recover"): the same way saved again keeps the address the install gave it (a quick tunnel's name comes only
      // from "Install and start", which does not run again); another way on an installed node opens "Install and start" again, so its
      // tunnel or Worker is set up and the node takes the new address
      if (!r || !r.ok || !was.reach) return r;
      const s = state.read();
      if (was.reach.mode === mode && was.reach.url && !s.reach.url) return { ...r, reach: state.save({ reach: { ...s.reach, url: was.reach.url, ...(was.reach.host ? { host: was.reach.host } : {}) } }).reach };
      if (was.reach.mode !== mode && (s.done || {}).service) { const { service, ...rest } = s.done; state.save({ done: rest }); return { ...r, again: 'service' }; }
      return r;
    },
    'POST /api/service': async (b) => {
      svc.begin();
      let r;
      try { r = await serviceRun(b); } catch (e) { r = { ok: false, why: e.message }; }
      svc.end(r);
      return r;
    },
    'GET /api/service/progress': async () => svc.view(['start']),
    'POST /api/owner/login': async (b) => {
      const s = state.read();
      if (!s.service) return { ok: false, why: 'the node is not installed yet' };
      // A NOSTR OWNER WITHOUT A BROWSER SIGNER (kanban #653: nsec only): the nsec typed once more, the login event signed here with it,
      // never kept - and only the owner's own key is taken
      let nostr = b.nostr;
      if (b.nsec) {
        const k = seedOfNsec(b.nsec);
        if (!k.ok) return { ok: false, why: k.why };
        if (!s.owner || k.pubkey !== s.owner.pubkey) return { ok: false, why: 'that nsec is not this node\'s owner key' };
        nostr = signNostrEvent(ownerEventTemplate({ node: s.service.identity, action: 'login' }), k.secret);
      }
      const r = await ownerLogin({ action: 'login', args: {}, nostr });
      if (r.ok) mark('service', { ownerLoginMs: Date.now() });
      return r;
    },

    // THE BOND (C.7, slice 2): the wallet's address and the amount; the coins found; the bond built from them with the node's own key
    // (its store, read only) and broadcast; the lock said plainly. It can wait: the node runs unbonded (outside the census) until then,
    // and the owner page shows the same address.
    // LIGHTNING FOR CUSTODY (slice 5, lnd.js): LND installed here (checked download, lnd.conf on the node's Core, a service, its wallet
    // from the node's seed) or an LND that already runs connected; either is tested by getinfo before the step is done
    'POST /api/lightning/own': async (b) => {
      if (!(state.read().done || {}).service) return { ok: false, why: 'install the node first' };
      lndRun.begin();
      let r;
      try { r = await setUpOwnLnd({ state, release, fetcher, reach, lndKit, boot: b.boot !== false, onStage: lndRun.stage }); } catch (e) { r = { ok: false, why: e.message }; }   // lnd-setup.js, the owner page's too (kanban #567)
      if (r.ok) lndRun.stage('wallet'); else lndRun.end(r);
      return r;
    },
    'POST /api/lightning/status': async () => {   // the step is done with the gateway
      const r = await lndReady({ state, lndKit, onStage: lndRun.stage });
      if (r.ok || !r.waiting) lndRun.end(r);
      return r;
    },
    // THE LIGHTNING STEP'S PROGRESS (kanban #661): LND's stages and the gateway's, read every second while either runs
    'GET /api/lightning/progress': async () => ({ ok: true, lnd: lndRun.view(), gateway: gwRun.view() }),
    'POST /api/lightning/connect': async (b) => {
      if (!(state.read().done || {}).service) return { ok: false, why: 'install the node first' };
      let restUrl;
      try { restUrl = new URL(String(b.restUrl || '')); } catch { return { ok: false, why: 'the REST address, such as https://127.0.0.1:8080' }; }
      if (restUrl.protocol !== 'https:') return { ok: false, why: 'LND\'s REST address is https' };
      const macaroonHex = String(b.macaroonHex || '').trim().toLowerCase(), tlsCertPem = String(b.tlsCertPem || '').trim();
      if (!/^[0-9a-f]{40,}$/.test(macaroonHex)) return { ok: false, why: 'the admin macaroon as hex (xxd -p -c 1000 admin.macaroon)' };
      if (!tlsCertPem.includes('BEGIN CERTIFICATE')) return { ok: false, why: 'LND\'s tls.cert (the text beginning -----BEGIN CERTIFICATE-----)' };
      const t = await lndKit.testLnd({ restUrl: restUrl.origin, tlsCertPem, macaroonHex });
      if (!t.ok) return { ok: false, why: t.why };
      state.writeSecret('lnd-connect.macaroon.hex', macaroonHex); state.writeSecret('lnd-connect.tls.cert', tlsCertPem + '\n');
      writeFileSync(state.path('lnd-connect.macaroon'), Buffer.from(macaroonHex, 'hex'), { mode: 0o600 });   // gatewayd reads the macaroon's bytes
      const l = { mode: 'connect', restUrl: restUrl.origin, tlsCert: state.path('lnd-connect.tls.cert'), macaroonHexFile: state.path('lnd-connect.macaroon.hex'),
        macaroon: state.path('lnd-connect.macaroon'), rpcHost: b.rpcHost ? String(b.rpcHost) : `https://${restUrl.hostname}:10009`, pubkey: t.pubkey, alias: t.alias, testedMs: Date.now() };
      state.save({ lightning: l });
      return { ok: true, ...t };
    },
    // CHANNELS (§23A.9: a gateway seat needs public channel capacity): LND's deposit address and balances, a channel to a named peer
    'POST /api/lightning/funds': async () => {
      const l = state.read().lightning;
      if (!l || !l.pubkey) return { ok: false, why: 'set up and test LND first' };
      const [f, ch] = await Promise.all([lndKit.lndFunds(l), lndKit.lndChannels(l)]);
      if (!f.ok) return f;
      return { ...f, channels: ch.ok ? ch : null, seat: GATEWAY_SEAT };
    },
    'POST /api/lightning/channel': async (b) => {
      const l = state.read().lightning;
      if (!l || !l.pubkey) return { ok: false, why: 'set up and test LND first' };
      return lndKit.lndOpenChannel(l, { peer: b.peer, sats: b.sats });
    },
    'POST /api/lightning/later': async () => { mark('lightning', { lightning: null }); return { ok: true }; },

    // THE GATEWAY (slice 5 part 2, gateway.js): gatewayd from this release on the LND above, its mnemonic from the seed, a service; the
    // Lightning step is done when it runs (or when the user leaves it for later - a release without gateway binaries for this system)
    'POST /api/gateway/setup': async (b) => {
      const s = state.read(); const l = s.lightning;
      if (!l || !l.pubkey) return { ok: false, why: 'set up and test LND first' };
      gwRun.begin(); gwRun.stage('find');
      const f = gwKit.findGatewayd({ release });
      if (!f.ok) { gwRun.end({ ok: false, why: f.why }); return { ok: false, why: f.why, noBinary: true }; }
      gwRun.stage('start');
      const g = gwKit.configureGateway({ home: state.home, gatewayd: f.gatewayd, seed: fromHex(state.readSecret('seed.hex')),
        lnd: { rpcHost: l.rpcHost, tlsCert: l.tlsCert, macaroon: l.macaroon }, publicUrl: s.reach && s.reach.url ? `${s.reach.url.replace(/\/+$/, '')}/gateway/` : null });
      const r = await gwKit.installProgram({ id: 'gateway', description: 'Bitcoin Arena: Fedimint gateway (custody)', args: g.args, vars: g.vars, home: state.home, boot: b.boot !== false });
      if (!r.ok) { gwRun.end(r); return { ok: false, why: r.why }; }
      state.save({ gateway: { apiUrl: g.apiUrl, publicUrl: g.publicUrl, passwordFile: g.passwordFile, dir: g.dir, startedMs: Date.now() } });
      gwRun.stage('answer');
      return { ok: true };
    },
    'POST /api/gateway/status': async () => {
      const s = state.read();
      if (!s.gateway) return { ok: false, why: 'no gateway set up yet' };
      const t = await gwKit.testGateway(s.gateway);
      // A GATEWAY WAITING FOR THE CHAIN IS SET UP (kanban #635, 2026-10-25: "Lnd muss nicht auf dem Bitcoin Core Testnet Sync
      // warten"): gatewayd runs and says Syncing until its LND is synced - it connects by itself then, and the dashboards show it
      if (t.ok || t.syncing) gwRun.end({ ok: true });
      if (!t.ok && t.syncing) { mark('lightning', { gateway: { ...s.gateway, state: t.state, syncingMs: Date.now() } }); return { ok: true, syncing: true, state: t.state, federations: [] }; }
      if (!t.ok) return { ok: false, why: t.why, waiting: true };
      mark('lightning', { gateway: { ...s.gateway, lightningPubkey: t.lightningPubkey, federations: t.federations, testedMs: Date.now() } });
      return t;
    },
    'POST /api/gateway/join': async (b) => {
      const s = state.read();
      if (!s.gateway) return { ok: false, why: 'set up the gateway first' };
      const j = await gwKit.joinFederation({ ...s.gateway, invite: b.invite });
      if (!j.ok) return j;
      const t = await gwKit.testGateway(s.gateway);
      if (t.ok) state.merge('gateway', { federations: t.federations });
      return { ok: true, federationId: j.federationId, federations: t.ok ? t.federations : null };
    },
    // THE FEDERATION (2026-10-18: "it should be its own point and the default is find a new federation with 9 other nodes or
    // invitation"): found one with nine other new nodes - the cohort, automatic (spec §23A.2 event 4) - or join one by its invite code
    'POST /api/federation': async (b) => {
      const s = state.read();
      if (!(s.roles || []).includes('custody')) { mark('federation', { federation: null }); return { ok: true }; }
      // NO INVITATION (2026-10-18: "it cannot invite if it's already full ... Yes remove it"): stock Fedimint adds no guardian to a
      // running federation, so a node is seated only by a draw - a new federation of ten, or the missing seats of a draining one's
      // successor (§23A.6). An invite code only lets a gateway serve a federation: arena-install --join-federation does that.
      mark('federation', { federation: { mode: 'drawn', atMs: Date.now() } });
      return { ok: true, mode: 'drawn' };
    },
    // THE BOND'S RULES, UNDERSTOOD (2026-10-18: "Explain in detail, intuitive why we need a bond and leaving without clicking LEAVE will
    // slash the bond ... people have to type I UNDERSTAND. That is its own screen")
    'POST /api/promise': async (b) => {
      if (String(b.text || '').trim().toUpperCase() !== 'I UNDERSTAND') return { ok: false, why: 'type I UNDERSTAND to go on' };
      mark('promise', { promise: { atMs: Date.now() } });
      return { ok: true };
    },
    'POST /api/gateway/later': async () => {
      const s = state.read();
      if (!(s.lightning || {}).pubkey) return { ok: false, why: 'set up and test LND first, or leave Lightning for later' };
      mark('lightning'); return { ok: true };
    },

    // A CUSTODY NODE NEEDS MORE (2026-10-18: "This needs additional funds for the peg in"): beside the bond, a reserve for its
    // advertisement update once its federation is founded (guardian_of), and the peg-in it sets aside for its gateway's e-cash - both stay
    // in its wallet (the bond's change) until the custody agent spends them
    'POST /api/bond/check': async (b) => {
      const s = state.read();
      if (!(s.done || {}).service) return { ok: false, why: 'install the node first: the bond is signed with its own key' };
      const w = walletOf(fromHex(state.readSecret('seed.hex')));
      const { tip, coins } = await chainKit.coinsOf(s.chain, w.spk);
      const total = coins.reduce((a, c) => a + c.sats, 0);
      const custody = (s.roles || []).includes('custody');
      const pegInSats = custody ? Math.max(0, Math.floor(Number((b && b.pegInSats) ?? (s.custody || {}).pegInSats ?? CUSTODY_PEG_IN_SATS))) : 0;
      if (custody) state.merge('custody', { pegInSats });
      // THE MINIMUM ASKED OF THE SEATS (kanban #543): a new node bonds at least the network's target, so it is useful from the start
      if (!laterCustody(s)) { const m = await installMinimum({ fetcher }); state.save({ bondMinimum: { sats: m.sats, from: m.from, why: m.why, atMs: nowMs() } }); }
      const parts = withOtherNodes(state.read(), depositParts(state.read(), pegInSats), { further: !!fundFrom });
      const needSats = Object.values(parts).reduce((a, x) => a + x, 0);
      // A FURTHER NODE OF A COUNT: its deposit paid from node 1's wallet, once (kanban #596)
      let fundedFrom = state.read().fundedFrom || null, fundWhy = null;
      if (fundFrom && total < needSats && !(fundedFrom && fundedFrom.txid)) {
        const baseSeed = fundFrom.readSecret('seed.hex');
        if (!baseSeed) fundWhy = 'the first node has no wallet yet';
        else {
          try {
            const bw = walletOf(fromHex(baseSeed));
            const got = await chainKit.coinsOf(s.chain, bw.spk);
            const tx = buildSend({ wallet: bw, coins: got.coins, script: w.spk, sats: needSats - total, feeRate: 2 });
            const txid = await chainKit.broadcast(s.chain, tx.hex);
            fundedFrom = { txid, sats: needSats - total, atMs: nowMs() };
            state.save({ fundedFrom });
          } catch (e) { fundWhy = `the first node's wallet could not pay this node's part: ${e.message}`; }
        }
      }
      return { ok: true, address: w.address, tip, coins, totalSats: total, needSats, parts, fundedFrom, fundWhy, enough: total >= needSats, lock: laterCustody(s) ? null : lockOf(tip), update: laterCustody(s),
        minimum: state.read().bondMinimum || null };
    },
    // TESTCOINS, AUTOMATICALLY (kanban #635, 2026-10-25: "Automatisch oder geführt an testcoins"): the Arena faucet sends what
    // the bond step still lacks to this node's address; the deposit then counts as soon as it is in the mempool. The guided way (public
    // faucets) is the page's other choice, and the one it points to when the faucet says no.
    'POST /api/coins/auto': async (b) => {
      const c = await api['POST /api/bond/check'](b || {});
      if (!c.ok) return c;
      const missing = Math.max(0, c.needSats - c.totalSats);
      if (!missing) return { ok: true, already: true, check: c };
      let r;
      try {
        const res = await fetcher(FAUCET_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: c.address, sats: missing }), signal: AbortSignal.timeout(60000) });
        r = await res.json().catch(() => ({ ok: false, why: `the faucet answered ${res.status}` }));
      } catch (e) { r = { ok: false, why: `the faucet did not answer (${e.message})` }; }
      if (!r.ok) return { ok: false, why: r.why, guided: true };
      state.save({ faucet: { txid: r.txid, sats: r.sats, atMs: nowMs() } });
      return { ok: true, txid: r.txid, sats: r.sats };
    },
    'POST /api/bond/post': async (b) => {
      const s = state.read();
      if (!(s.done || {}).service) return { ok: false, why: 'install the node first' };
      if (!(s.done || {}).promise) return { ok: false, why: 'read the bond\'s rules first and type I UNDERSTAND' };
      if (s.bond && s.bond.txid && !(laterCustody(s) && !s.bond.custodyAdvert)) return { ok: false, why: `this node's bond is posted already (${s.bond.txid})` };
      const seed = fromHex(state.readSecret('seed.hex'));
      const w = walletOf(seed);
      const { tip, coins } = await chainKit.coinsOf(s.chain, w.spk);
      const db = new DatabaseSync(state.path('node.db'), { readOnly: true });
      let nodeSecret;
      try { nodeSecret = new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret); } finally { db.close(); }
      // custody added to a node with a bond: the bond's advertisement is updated to name custody and the guardian's endpoint (§5A.2)
      if (laterCustody(s)) {
        const advert = advertFor({ hostedGames: s.hostedGames, nodeKey: schnorr.getPublicKey(nodeSecret), operatorId: `op-${s.owner.pubkey.slice(0, 12)}`, roles: s.roles, endpoint: s.reach.url,
          payoutPubkey: payoutKeyOf(seed), maturity: s.bond.maturity, softwareHash: commitOf(), guardianEndpoint: (guardianSetupOf(s, { release }) || {}).endpoint || null,
          emergencyPubkey: EMERGENCY_IN_ADVERT ? fromHex(emergencyOf(seed).pubkey) : null });   // the census reads the newest advertisement: the key kept
        let u;
        try { u = buildAdvertUpdate({ wallet: w, nodeSecret, coins, bond: { txid: s.bond.txid, vout: s.bond.vout || 0 }, advert }); }
        catch (e) { return { ok: false, why: e.message }; }
        await chainKit.broadcast(s.chain, u.funding.hex);
        const txid = await chainKit.broadcast(s.chain, u.update.hex);
        const bond = { ...s.bond, custodyAdvert: { txid, advertId: u.advertId, atTip: tip, atMs: Date.now() } };
        mark('bond', { bond, advertProtocols: [...SUPPORTED_PROTOCOL_VERSIONS] });   // what its advertisement declares (change-roles refreshHostedGames)
        await installAgent();
        return { ok: true, bond, update: txid };
      }
      const minimum = BigInt(bondMinimumOf(s));
      const bondSats = b.bondSats ? BigInt(b.bondSats) : minimum;
      if (bondSats < minimum) return { ok: false, why: minimum > BOND_MIN_SATS ? `a new node bonds at least ${minimum} sat now: the network's bond target (${(s.bondMinimum || {}).why || 'GET /capacity'})` : `a bond is at least ${BOND_MIN_SATS} sat` };
      let built;
      try {
        built = buildBond({ hostedGames: s.hostedGames, wallet: w, nodeSecret, coins, tip, bondSats, operatorId: `op-${s.owner.pubkey.slice(0, 12)}`, roles: s.roles,
          endpoint: s.reach.url, payoutPubkey: payoutKeyOf(seed), softwareHash: commitOf(), feeRate: 2,
          guardianEndpoint: (guardianSetupOf(s, { release }) || {}).endpoint || null,
          emergencyPubkey: EMERGENCY_IN_ADVERT ? fromHex(emergencyOf(seed).pubkey) : null });
      } catch (e) { return { ok: false, why: e.message }; }
      const fundingTxid = await chainKit.broadcast(s.chain, built.funding.hex);
      const bondTxid = await chainKit.broadcast(s.chain, built.bond.hex);
      const bond = { txid: bondTxid, vout: 0, fundingTxid, sats: String(built.bondSats), maturity: built.maturity, advertId: built.advertId, postedAtTip: tip,
        lock: lockOf(tip, { maturity: built.maturity }), atMs: Date.now() };
      mark('bond', { bond, advertProtocols: [...SUPPORTED_PROTOCOL_VERSIONS] });   // what its advertisement declares (change-roles refreshHostedGames)
      // a custody node's agent: guardian_of, the gateway's own federation and the peg-in, once a founding has drawn it (custody-agent.js)
      if ((s.roles || []).includes('custody') || (s.roles || []).includes('liquidity')) await installAgent();
      // THE LIQUIDITY PROVIDER SERVICE (§23A.10): its node key for its claims (0600 beside the node's other secrets), its LND, its claim
      // file the seat serves (ARENA_LIQUIDITY_CLAIM_FILE)
      if ((s.roles || []).includes('liquidity') && s.lightning && s.lightning.lnddir) {
        state.writeSecret('liquidity.key', toHex(nodeSecret));
        await gwKit.installProgram({ id: 'liquidity', description: 'Bitcoin Arena: liquidity provider', home: state.home, boot: true,
          args: [process.execPath, join(release, 'packages', 'arena-installer', 'bin', 'liquidity-provider.mjs'), '--rest', s.lightning.restUrl, '--lnddir', s.lightning.lnddir,
            '--key', state.path('liquidity.key'), '--state', state.path('liquidity-state.json'), '--claim-file', state.path('liquidity-claim.json'), '--listen', String(LIQUIDITY_PROVIDER_PORT)] });
      }
      return { ok: true, bond };
    },
    'POST /api/bond/later': async () => { state.update((n) => ({ bond: n.bond && n.bond.txid ? n.bond : null, done: { ...(n.done || {}), bond: Date.now() } })); return { ok: true }; },   // a posted bond stays - the one recorded now, not one read before (kanban #1178)

    'POST /api/finish': async () => {
      saveLaunchers();
      const s = state.read();
      if (!(s.done || {}).service) return { ok: false, why: 'the node is not installed and logged in yet' };
      if (!(s.done || {}).lightning) return { ok: false, why: 'set up Lightning for custody, or choose to set it up later' };
      if (!(s.done || {}).bond) return { ok: false, why: 'post the bond, or choose to post it later' };
      mark('done');
      finished = true;
      sessions.clear(); saveSessions(true);
      setTimeout(() => onDone(), 200);
      const reachNow = state.read().reach || {};
      // the owner page where the installer hands the key over (kanban #687): the Arena site's, by this node's key
      const idNow = (state.read().service || {}).identity;
      return { ok: true, owner: /^[0-9a-f]{64}$/.test(String(idNow || '')) ? `https://testnet.bitcoinarena.io/owner/#node=${idNow}&local=${encodeURIComponent(`http://127.0.0.1:${portOf()}`)}`
        : `http://127.0.0.1:${portOf()}/dashboard/owner`, url: reachNow.url || null, mode: reachNow.mode || null };
    },
  };

  // a posted bond whose advertisement does not name custody yet, on a node that chose custody (beginAddCustody)
  const installAgent = async () => {
    const a = await gwKit.installProgram({ id: 'custody', description: 'Bitcoin Arena: custody agent', home: state.home, boot: true,
      args: [process.execPath, join(release, 'packages', 'arena-installer', 'bin', 'custody-agent.mjs'), '--home', state.home] });
    state.save({ custodyAgent: a.ok ? { installedMs: Date.now() } : { why: a.why } });
  };

  // THE WAYS TO START IT AGAIN (launchers.js): scripts, the Start menu / the app / the desktop menu - written for the services this node has
  const saveLaunchers = () => {
    const s = state.read();
    if (!s.service) return null;
    // the local owner page, which goes on to the Arena site's page for this node where the owner key is kept (kanban #687): a quick
    // tunnel's address changes at every restart, and a .desktop Exec line or cmd would cut the site page's #node=...&local=...
    const ownerUrl = `http://127.0.0.1:${portOf()}/dashboard/owner`;
    try {
      const addCustody = (s.roles || []).includes('custody') ? null
        : [process.execPath, join(release, 'packages', 'arena-installer', 'bin', 'arena-install.mjs'), '--add-custody', '--home', state.home];
      const l = launch({ home: state.home, s, ownerUrl, addCustody, release,
        run: (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 60000 }, () => ok())) });
      const { pathSet, ...command } = l.command || {};
      // THE AUTO UPDATE SERVICE: installed with the node, on unless arena.conf says auto_update=0
      if (l.command && !l.command.why) Promise.resolve(installUpdater({ home: state.home, installProgram: gwKit.installProgram })).then((u) => { if (u && !u.ok) log(`auto update: ${u.why}`); }, (e) => log(`auto update: ${e.message}`));
      if (pathSet) pathSet.catch(() => {});   // the wizard runs on: the PATH change finishes while it does
      state.save({ launchers: { start: l.start, files: l.files, app: l.app, menu: l.menu, ownerUrl, command: l.command ? command : null, atMs: Date.now() } });
      return l;
    } catch (e) { log(`launchers: ${e.message}`); return null; }
  };

  /** The folder Bitcoin Core's blocks go to: the owner's (absolute, or ~/...), else the node's own folder. */
  const coreDirOf = (b) => {
    const raw = String((b && b.dir) || '').trim();
    if (!raw) return { ok: true, dir: state.home };
    const dir = raw === '~' || raw.startsWith('~/') ? join(homedir(), raw.slice(1)) : raw;
    if (!isAbsolute(dir)) return { ok: false, why: `give the whole path of the folder (it starts with / or a drive letter): ${raw}` };
    return { ok: true, dir: resolvePath(dir) };
  };
  const rolesRefusal = (roles) => {
    const unknown = roles.filter((r) => !ROLES[r]);
    if (unknown.length) return `no role ${unknown.join(', ')}`;
    if (!roles.length) return 'choose at least one role';
    for (const r of ['custody', 'liquidity']) if (roles.includes(r) && state.read().chain && !ownCoreOf(state.read()))
      return `${r === 'custody' ? 'custody' : 'a liquidity provider'} needs your own Bitcoin Core: LND cannot run on an Electrum server. Connect or install Bitcoin Core in step 2, or leave ${r} out`;
    return null;
  };
  const chainOf = (b) => (b.kind === 'electrum'
    ? { kind: 'electrum', host: String(b.host || ''), port: Number(b.port), tls: b.tls !== false, ...(b.ws ? { ws: true, path: String(b.path || '/') } : {}) }
    : { kind: 'core', url: String(b.url || ''), ...(b.cookiePath ? { cookiePath: String(b.cookiePath) } : { user: String(b.user || ''), password: String(b.password || '') }) });

  const signedBySeed = (identityHex) => {
    const seed = fromHex(state.readSecret('seed.hex'));
    const { secret } = ownerKeyOf(seed);
    // the node signs as its x-only key; /identity answers its 32 bytes
    return signOwnerRequest({ node: identityHex, action: 'login', args: {}, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
  };
  const ownerLogin = async (body) => {
    try {
      const r = await fetcher(`http://127.0.0.1:${portOf()}/owner/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      return r.status === 200 && j.ok ? { ok: true, node: j.node } : { ok: false, why: j.why || `the node answered ${r.status}` };
    } catch (e) { return { ok: false, why: e.message }; }
  };

  const page = () => readFileSync(new URL('../www/index.html', import.meta.url));
  // the release's commit as the advertisement's software hash (sha256 of the COMMIT file; zeros from a checkout)
  const commitOf = () => { try { return sha256(readFileSync(`${release}/COMMIT`)); } catch { return new Uint8Array(32); } };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!hostOk(req)) return json(res, 421, { ok: false, why: 'this host is not the installer' });
    // THE ICON, TO ANYONE (the 2026.1.9.11 install test, kanban #704: every page load logged a missing favicon.ico): the node's own, beside its pages
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      let body; try { body = readFileSync(new URL('../../arena-node/pages/favicon.ico', import.meta.url)); } catch { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/x-icon', 'cache-control': 'max-age=86400' });
      return res.end(body);
    }
    // THE TOKEN, ONCE: traded for a session and gone
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
      // THE LINK OPENED AGAIN IN A BROWSER THAT HOLDS ITS SESSION (kanban #635, the owner's playtest 2026-10-25: the test host app's "Open in
      // browser" opened the used link, and the page said "that setup link is used or expired" in a browser already logged in)
      if (sessionOk(req)) { res.writeHead(303, { location: '/', 'cache-control': 'no-store' }); return res.end(); }
      if (!token || nowMs() > tokenUntil || !same(url.searchParams.get('t'), token)) return json(res, 403, { ok: false, why: 'This setup link was used already or is older than 30 minutes. Open the Bitcoin Arena app again (or run bitcoinarena-install again) to get a new one' });
      token = null;
      const sid = b64u(32);
      sessions.set(hashOf(sid), nowMs()); saveSessions(true);
      const secure = String(req.headers['x-forwarded-proto'] || req.headers['cf-visitor'] || '').includes('https') ? '; Secure' : '';
      res.writeHead(303, { location: '/', 'set-cookie': `arena_wizard=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_IDLE_MS / 1000}${secure}`, 'cache-control': 'no-store' });
      return res.end();
    }
    if (!sessionOk(req)) return json(res, 401, { ok: false, why: finished ? 'Setup is finished. Your node runs: open the Bitcoin Arena app to see it' : 'This page opens from the setup link. Open the Bitcoin Arena app again (or run bitcoinarena-install again) and it opens the page for you' });
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
      return res.end(page());
    }
    // THE STEPS PORTED TO REACT (kanban #564): the page's one script beside it, built by packages/arena-web; without it the page draws
    // every step itself
    if (req.method === 'GET' && url.pathname === '/wizard.js') {
      let body; try { body = readFileSync(new URL('../www/wizard.js', import.meta.url)); } catch { return json(res, 404, { ok: false, why: 'this release carries no React steps' }); }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(body);
    }
    const door = api[`${req.method} ${url.pathname}`];
    if (!door) return json(res, 404, { ok: false, why: 'no such door' });
    if (req.method === 'POST' && req.headers['x-arena-wizard'] !== '1') return json(res, 403, { ok: false, why: 'missing x-arena-wizard' });
    const t0 = performance.now();
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      // the fields it was handed, by name only: a step takes seed words, keys and tokens, and none of their values is printed
      if (req.method === 'POST') trace.debug(() => `${req.method} ${url.pathname} with field(s) ${Object.keys(body || {}).join(', ') || 'none'}`);
      const r = await door(body);
      log(`[wizard] ${req.method} ${url.pathname} -> ${r.ok ? 'ok' : r.why}`);
      trace.verbose(`${req.method} ${url.pathname} took ${trace.since(t0)}`);
      return json(res, 200, r);
    } catch (e) { trace.fail(`${req.method} ${url.pathname} failed after ${trace.since(t0)}`, e); return json(res, 400, { ok: false, why: e.message }); }
  }

  // ITS STEPS, CALLABLE BY NAME (kanban #563): the runners that do a step again on an installed node - bin/reach-switch.mjs (the address
  // switch) and bin/custody-add.mjs (custody from the owner page) - call wizard['POST /api/...'] without the HTTP door; before this the
  // object held only the door, and every such call was undefined (the address switch could not have run)
  return { ...api, get token() { return token; }, handle, allowHost, close: () => { finished = true; sessions.clear(); saveSessions(true); } };
}
