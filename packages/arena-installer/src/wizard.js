// THE INSTALLER'S WEB WIZARD (kanban #471 part B; the owner 2026-10-18: "The installer should be web based, so the user does the wizard on
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
// THE STEPS (C), each tested before it is saved: chain -> roles -> seed (written down, asked back) -> owner (the seed's key or a Nostr
// key, bound before the node's first start) -> reach (ruling 7: direct when seats reach it, else a permanent Cloudflare tunnel, or a
// quick one) -> service (installed, started at boot if the user wants, healthy, reachable at its public address; then one signed
// owner login against the running node) -> done. The state is on disk after every step (state.js), so the wizard can be closed and resumed.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { testConnection, TESTNET4_ELECTRUM } from './chain-test.js';
import { newSeed, confirmPositions, checkConfirm, ownerKeyOf, nostrPubkeyHex, CONFIRM_WORDS } from './seed.js';
import { nextStep, seatEnv, ROLES, guardianSetupOf } from './state.js';
import { installService, installProgram } from './service.js';
import { detectBitcoind, diskCheck, installCore, configureCore, coreArgs, syncStatus, NEEDS } from './bitcoind.js';
import { createHash } from 'node:crypto';
import * as reachKit from './reach.js';
import { DatabaseSync } from 'node:sqlite';
import { walletOf, payoutKeyOf, coinsOf, broadcast } from './wallet.js';
import { buildBond, lockOf, BOND_MIN_SATS } from './bond.js';
import { join } from 'node:path';
/** A custody node's extra deposit: the advertisement update's reserve, and the default peg-in for its gateway (the owner can change it). */
export const CUSTODY_UPDATE_RESERVE_SATS = 5000;
export const CUSTODY_PEG_IN_SATS = 50000;
import { installLnd, configureLnd, lndArgs, createLndWallet, testLnd, lndFunds, lndOpenChannel, lndChannels } from './lnd.js';
/** A gateway seat's requirements on testnet4 (spec §23A.9), said in the wizard. */
export const GATEWAY_SEAT = Object.freeze({ minCapacitySats: 200000, minPegInSats: 50000, availability: 0.95, seats: 2, epochBlocks: 144 });
import { findGatewayd, configureGateway, testGateway, joinFederation } from './gateway.js';
import { signOwnerRequest, ownerEventTemplate } from '../../arena-node/src/owner.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

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
export function createWizard({ state, release, seatPort = reachKit.DEFAULT_NODE_PORT, bridgePort = null, test = testConnection, install = installService,
  fetcher = fetch, reach = reachKit, cloudflared = 'cloudflared', chainKit = { coinsOf, broadcast },
  coreKit = { detectBitcoind, diskCheck, installCore, configureCore, coreArgs, syncStatus, installProgram },
  lndKit = { installLnd, configureLnd, lndArgs, createLndWallet, testLnd, installProgram, lndFunds, lndOpenChannel, lndChannels },
  gwKit = { findGatewayd, configureGateway, testGateway, joinFederation, installProgram }, nowMs = () => Date.now(), onDone = () => {}, log = () => {} }) {
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

  const view = () => {
    const s = state.read();
    return { network: 'testnet4', step: nextStep(s), done: s.done || {}, chain: s.chain ? { ...s.chain, password: s.chain.password ? '(set)' : undefined } : null,
      chainTest: s.chainTest || null, roles: s.roles || [], roleInfo: ROLES, electrum: TESTNET4_ELECTRUM, owner: s.owner || null, service: s.service || null,
      seatPort: portOf(), defaultPort: seatPort, reach: s.reach || null, direct: s.direct || null, login: login ? { url: login.url, result: login.result } : null,
      lightning: s.lightning || null, gatewaySeat: GATEWAY_SEAT, gateway: s.gateway ? { ...s.gateway, passwordFile: undefined } : null, bond: s.bond || null, wallet: (s.done || {}).seed ? { address: walletOf(fromHex(state.readSecret('seed.hex'))).address, needSats: String(BOND_MIN_SATS) } : null,
      confirm: pendingSeed ? { positions: pendingSeed.positions } : null, confirmWords: CONFIRM_WORDS };
  };
  const mark = (step, patch = {}) => { const s = state.read(); return state.save({ ...patch, done: { ...(s.done || {}), [step]: Date.now() } }); };

  // THE STEPS' DOORS. Each answers { ok, ... } and saves only what passed.
  const api = {
    'GET /api/state': async () => ({ ok: true, ...view() }),

    'POST /api/chain/test': async (b) => ({ ok: true, result: await test(chainOf(b)) }),
    'POST /api/chain/save': async (b) => {
      const conn = chainOf(b);
      const r = await test(conn);
      if (!r.ok) return { ok: false, why: r.why, result: r };
      if (conn.kind === 'core' && conn.user) {        // main.js reads a cookie file: user:password in one of our own, 0600
        state.writeSecret('bitcoind.auth', `${conn.user}:${conn.password}\n`);
        conn.cookiePath = state.path('bitcoind.auth'); delete conn.password;
      }
      mark('chain', { chain: conn, chainTest: { atMs: Date.now(), why: r.why, latencyMs: r.source.latencyMs, height: r.source.height } });
      return { ok: true, result: r };
    },

    // BITCOIN CORE, INSTALLED WHEN ASKED (ruling 8): the plan (one already here? the disk against what mainnet and testnet4 need),
    // the install (checked download, a datadir and config per network, a service each), and the sync's progress with an ETA - and once
    // testnet4 is synced, the chain step is saved with it and the wizard goes on
    'POST /api/core/plan': async () => {
      const found = await coreKit.detectBitcoind({ home: state.home });
      return { ok: true, installed: found, disk: coreKit.diskCheck(state.home), needs: NEEDS, core: state.read().core || null };
    },
    'POST /api/core/install': async (b) => {
      const found = await coreKit.detectBitcoind({ home: state.home });
      if (found && !found.startsWith(state.home)) return { ok: false, why: `Bitcoin Core is installed already (${found}): connect it with its RPC address and cookie file instead` };
      const disk = coreKit.diskCheck(state.home);
      const nets = ['testnet4', ...(b.mainnet ? ['mainnet'] : [])];
      const prune = Boolean(b.prune);
      const need = nets.reduce((a, n) => a + (prune ? NEEDS[n].prunedBytes : NEEDS[n].fullBytes), 0);
      if (disk.freeBytes < need) return { ok: false, why: `${Math.round(disk.freeBytes / 2 ** 30)} GB free, and ${nets.join(' + ')}${prune ? ' pruned' : ''} need about ${Math.round(need / 2 ** 30)} GB`, disk };
      const got = await coreKit.installCore({ home: state.home, fetcher });
      if (!got.ok) return { ok: false, why: got.why };
      const networks = {};
      for (const n of nets) {
        const c = coreKit.configureCore({ home: state.home, network: n, prune });
        const r = await coreKit.installProgram({ id: `bitcoind-${n}`, description: `Bitcoin Core for the Arena node (${n})`, args: coreKit.coreArgs({ bitcoind: got.bitcoind, datadir: c.datadir }), home: state.home, boot: b.boot !== false });
        if (!r.ok) return { ok: false, why: r.why };
        networks[n] = { rpcUrl: c.rpcUrl, cookiePath: c.cookiePath, datadir: c.datadir };
      }
      const core = { bitcoind: got.bitcoind, prune, networks, startedMs: nowMs() };
      state.save({ core });
      return { ok: true, core };
    },
    'GET /api/core/status': async () => {
      const s = state.read();
      if (!s.core) return { ok: false, why: 'no Bitcoin Core was installed by this installer' };
      const out = {};
      for (const [n, c] of Object.entries(s.core.networks)) {
        const r = await coreKit.syncStatus({ ...c, samples: coreSamples.get(n) || [], nowMs: nowMs(), fetcher });
        coreSamples.set(n, r.samples || []);
        out[n] = { ...r, samples: undefined };
      }
      // TESTNET4 SYNCED: the chain step saved with this node, as the Bitcoin Core option would save it, tested the same way
      const t4 = out.testnet4;
      if (t4 && t4.ok && t4.synced && !(s.done || {}).chain) {
        const conn = { kind: 'core', url: s.core.networks.testnet4.rpcUrl, cookiePath: s.core.networks.testnet4.cookiePath };
        const r = await test(conn);
        if (r.ok) mark('chain', { chain: conn, chainTest: { atMs: Date.now(), why: r.why, latencyMs: r.source.latencyMs, height: r.source.height } });
        out.chainSaved = r.ok; out.chainWhy = r.why;
      }
      return { ok: true, networks: out };
    },

    'POST /api/roles': async (b) => {
      const roles = [...new Set((b.roles || []).map(String))];
      const unknown = roles.filter((r) => !ROLES[r]);
      if (unknown.length) return { ok: false, why: `no role ${unknown.join(', ')}` };
      if (!roles.length) return { ok: false, why: 'choose at least one role' };
      if (roles.includes('custody') && state.read().chain && state.read().chain.kind !== 'core')
        return { ok: false, why: 'custody needs your own Bitcoin Core: LND cannot run on an Electrum server. Connect or install Bitcoin Core in the first step, or leave custody out' };
      mark('roles', { roles });
      if (!roles.includes('custody')) mark('lightning', { lightning: null });   // no custody: no Lightning step
      else if (!(state.read().lightning || {}).pubkey) {                          // custody, and no Lightning node tested yet: the step is to come
        const { lightning: _, ...rest } = state.read().done || {}; state.save({ done: rest });
      }
      return { ok: true, roles };
    },

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
      pendingSeed = null;
      mark('seed', { seedOwnerPubkey: pubkey });
      return { ok: true };
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

    // REACH (ruling 7). The direct check first: its answer picks the default (direct when reached, else the permanent tunnel).
    'POST /api/reach/direct': async (b) => {
      const port = Number(b.port) || seatPort;
      const r = await reach.checkDirect({ port, fetcher });
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
      if (!reach.REACH_MODES.includes(mode)) return { ok: false, why: 'direct, permanent or quick' };
      const s = state.read();
      const port = mode === 'direct' ? ((s.direct || {}).port || seatPort) : (Number(b.port) || seatPort);
      if (mode === 'direct') {
        if (!s.direct || !s.direct.reached) return { ok: false, why: 'the direct check did not reach this machine: open the port as it says and test again, or choose a tunnel' };
        return { ok: true, reach: mark('reach', { reach: { mode, port, url: `http://${s.direct.address.includes(':') ? `[${s.direct.address}]` : s.direct.address}:${port}` } }).reach };
      }
      if (mode === 'quick') return { ok: true, reach: mark('reach', { reach: { mode, port, url: null } }).reach };
      // permanent: logged in, then the tunnel and its name
      if (!login || !login.result || !login.result.ok) return { ok: false, why: 'log in to Cloudflare first (the link above), then save' };
      const hostname = String(b.hostname || '').trim().toLowerCase();
      if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(hostname)) return { ok: false, why: 'a name such as node.example.com, under a domain on your Cloudflare account' };
      const t = await reach.cloudflareTunnel({ bin: cloudflared, name: `arena-node-${hostname.split('.')[0]}`, hostname, port, home: state.home });
      if (!t.ok) return { ok: false, why: t.why };
      return { ok: true, reach: mark('reach', { reach: { mode, port, url: `https://${hostname}`, hostname, tunnel: t.id, config: t.config } }).reach };
    },

    // THE SERVICE (C.9): the settings, the unit, started, healthy; then the owner's first login against the running node (C.6 "tested by
    // one login") - signed here with the seed's owner key, or by the browser's Nostr signer (POST /api/owner/login).
    'POST /api/service': async (b) => {
      let s = state.read();
      for (const k of ['chain', 'roles', 'seed', 'owner', 'reach']) if (!(s.done || {})[k]) return { ok: false, why: `the ${k} step is not done` };
      const port = s.reach.port;
      const boot = b.boot !== false;
      const conf = { ...s, port, bridgePort };
      state.writeSecret('node.env', seatEnv(conf, { home: state.home, release }));
      const tunnel = s.reach.mode === 'direct' ? null : reach.tunnelUnit({ bin: cloudflared, mode: s.reach.mode, config: s.reach.config, port });
      const tunnelArgs = s.reach.mode === 'direct' ? null : reach.tunnelArgsOf({ bin: cloudflared, mode: s.reach.mode, config: s.reach.config, port });
      const r = await install({ release, home: state.home, port, bridgePort: s.chain.kind === 'electrum' ? bridgePort : null, tunnel, tunnelArgs, boot });
      if (!r.ok) return { ok: false, why: r.why };
      // THE PUBLIC ADDRESS, TESTED: a tunnel from outside through Cloudflare's edge (a quick tunnel's name read first, and the node's
      // settings rewritten with it - it is new at every restart); a direct node was reached by the seats before it started
      let reachTest = null;
      if (s.reach.mode === 'quick') {
        const url = await reach.quickTunnelUrl({});
        if (url) { s = state.save({ reach: { ...s.reach, url } }); state.writeSecret('node.env', seatEnv({ ...s, port, bridgePort }, { home: state.home, release })); }
      }
      if (s.reach.mode !== 'direct') reachTest = s.reach.url ? await reach.testPublicUrl({ url: s.reach.url, identity: r.identity, fetcher }) : { ok: false, why: 'the quick tunnel gave no name' };
      let login = null;
      if (s.owner.mode === 'seed') login = await ownerLogin(signedBySeed(r.identity));
      state.save({ service: { port, identity: r.identity, startedInMs: r.ms, boot: r.boot, linger: r.linger, reachTest, atMs: Date.now() } });
      if (reachTest && !reachTest.ok) return { ok: false, why: `the node runs, but not at its public address: ${reachTest.why}`, identity: r.identity };
      if (login && !login.ok) return { ok: false, why: `the node runs, but the owner login failed: ${login.why}`, identity: r.identity };
      if (login) mark('service', { ownerLoginMs: Date.now() });
      return { ok: true, identity: r.identity, ms: r.ms, boot: r.boot, linger: r.linger, reachTest, url: s.reach.url, login,
        template: s.owner.mode === 'nostr' ? ownerEventTemplate({ node: r.identity, action: 'login' }) : null };
    },
    'POST /api/owner/login': async (b) => {
      const s = state.read();
      if (!s.service) return { ok: false, why: 'the node is not installed yet' };
      const r = await ownerLogin({ action: 'login', args: {}, nostr: b.nostr });
      if (r.ok) mark('service', { ownerLoginMs: Date.now() });
      return r;
    },

    // THE BOND (C.7, slice 2): the wallet's address and the amount; the coins found; the bond built from them with the node's own key
    // (its store, read only) and broadcast; the lock said plainly. It can wait: the node runs unbonded (outside the census) until then,
    // and the owner page shows the same address.
    // LIGHTNING FOR CUSTODY (slice 5, lnd.js): LND installed here (checked download, lnd.conf on the node's Core, a service, its wallet
    // from the node's seed) or an LND that already runs connected; either is tested by getinfo before the step is done
    'POST /api/lightning/own': async (b) => {
      const s = state.read();
      if (!(s.done || {}).service) return { ok: false, why: 'install the node first' };
      if (!s.chain || s.chain.kind !== 'core') return { ok: false, why: 'LND needs your own Bitcoin Core, not an Electrum server' };
      const got = await lndKit.installLnd({ home: state.home, fetcher });
      if (!got.ok) return { ok: false, why: got.why };
      const cfg = lndKit.configureLnd({ home: state.home, chain: s.chain });
      const r = await lndKit.installProgram({ id: 'lnd', description: 'LND for the Arena node (custody)', args: lndKit.lndArgs({ lnd: got.lnd, lnddir: cfg.lnddir }), home: state.home, boot: b.boot !== false });
      if (!r.ok) return { ok: false, why: r.why };
      state.save({ lightning: { mode: 'own', restUrl: cfg.restUrl, tlsCert: cfg.tlsCert, macaroon: cfg.macaroon, passwordFile: cfg.passwordFile, lnddir: cfg.lnddir, startedMs: Date.now() } });
      return { ok: true, lnd: got.lnd, sha256: got.sha256 || null };
    },
    'POST /api/lightning/status': async () => {
      const s = state.read(); const l = s.lightning;
      if (!l) return { ok: false, why: 'no Lightning node set up yet' };
      let created = false;
      if (l.mode === 'own') {
        const w = await lndKit.createLndWallet({ cfg: l, seed: fromHex(state.readSecret('seed.hex')) });
        if (!w.ok) return { ok: false, why: w.why, waiting: true };
        created = w.created;
      }
      const t = await lndKit.testLnd(l);
      if (!t.ok) return { ok: false, why: t.why, waiting: l.mode === 'own', created };
      state.save({ lightning: { ...l, pubkey: t.pubkey, alias: t.alias, testedMs: Date.now() } });   // the step is done with the gateway
      return { ok: true, created, ...t };
    },
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
      const f = gwKit.findGatewayd({ release });
      if (!f.ok) return { ok: false, why: f.why, noBinary: true };
      const g = gwKit.configureGateway({ home: state.home, gatewayd: f.gatewayd, seed: fromHex(state.readSecret('seed.hex')),
        lnd: { rpcHost: l.rpcHost, tlsCert: l.tlsCert, macaroon: l.macaroon } });
      const r = await gwKit.installProgram({ id: 'gateway', description: 'The Fedimint gateway of the Arena node (custody)', args: g.args, vars: g.vars, home: state.home, boot: b.boot !== false });
      if (!r.ok) return { ok: false, why: r.why };
      state.save({ gateway: { apiUrl: g.apiUrl, passwordFile: g.passwordFile, dir: g.dir, startedMs: Date.now() } });
      return { ok: true };
    },
    'POST /api/gateway/status': async () => {
      const s = state.read();
      if (!s.gateway) return { ok: false, why: 'no gateway set up yet' };
      const t = await gwKit.testGateway(s.gateway);
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
      if (t.ok) state.save({ gateway: { ...state.read().gateway, federations: t.federations } });
      return { ok: true, federationId: j.federationId, federations: t.ok ? t.federations : null };
    },
    'POST /api/gateway/later': async () => {
      const s = state.read();
      if (!(s.lightning || {}).pubkey) return { ok: false, why: 'set up and test LND first, or leave Lightning for later' };
      mark('lightning'); return { ok: true };
    },

    // A CUSTODY NODE NEEDS MORE (the owner 2026-10-18: "This needs additional funds for the peg in"): beside the bond, a reserve for its
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
      if (custody) state.save({ custody: { ...(state.read().custody || {}), pegInSats } });
      const parts = { bond: Number(BOND_MIN_SATS), fees: 2000, ...(custody ? { advertUpdate: CUSTODY_UPDATE_RESERVE_SATS, pegIn: pegInSats } : {}) };
      const needSats = Object.values(parts).reduce((a, x) => a + x, 0);
      return { ok: true, address: w.address, tip, coins, totalSats: total, needSats, parts, enough: total >= needSats, lock: lockOf(tip) };
    },
    'POST /api/bond/post': async (b) => {
      const s = state.read();
      if (!(s.done || {}).service) return { ok: false, why: 'install the node first' };
      if (s.bond && s.bond.txid) return { ok: false, why: `this node's bond is posted already (${s.bond.txid})` };
      const seed = fromHex(state.readSecret('seed.hex'));
      const w = walletOf(seed);
      const { tip, coins } = await chainKit.coinsOf(s.chain, w.spk);
      const db = new DatabaseSync(state.path('node.db'), { readOnly: true });
      let nodeSecret;
      try { nodeSecret = new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret); } finally { db.close(); }
      const bondSats = b.bondSats ? BigInt(b.bondSats) : BOND_MIN_SATS;
      if (bondSats < BOND_MIN_SATS) return { ok: false, why: `a bond is at least ${BOND_MIN_SATS} sat` };
      let built;
      try {
        built = buildBond({ wallet: w, nodeSecret, coins, tip, bondSats, operatorId: `op-${s.owner.pubkey.slice(0, 12)}`, roles: s.roles,
          endpoint: s.reach.url, payoutPubkey: payoutKeyOf(seed), softwareHash: commitOf(), feeRate: 2,
          guardianEndpoint: (guardianSetupOf(s, { release }) || {}).endpoint || null });
      } catch (e) { return { ok: false, why: e.message }; }
      const fundingTxid = await chainKit.broadcast(s.chain, built.funding.hex);
      const bondTxid = await chainKit.broadcast(s.chain, built.bond.hex);
      const bond = { txid: bondTxid, vout: 0, fundingTxid, sats: String(built.bondSats), maturity: built.maturity, advertId: built.advertId, postedAtTip: tip,
        lock: lockOf(tip, { maturity: built.maturity }), atMs: Date.now() };
      mark('bond', { bond });
      // a custody node's agent: guardian_of, the gateway's own federation and the peg-in, once a founding has drawn it (custody-agent.js)
      if ((s.roles || []).includes('custody')) {
        const a = await gwKit.installProgram({ id: 'custody', description: 'The custody agent of the Arena node', home: state.home, boot: true,
          args: [process.execPath, join(release, 'packages', 'arena-installer', 'bin', 'custody-agent.mjs'), '--home', state.home] });
        state.save({ custodyAgent: a.ok ? { installedMs: Date.now() } : { why: a.why } });
      }
      return { ok: true, bond };
    },
    'POST /api/bond/later': async () => { mark('bond', { bond: null }); return { ok: true }; },

    'POST /api/finish': async () => {
      const s = state.read();
      if (!(s.done || {}).service) return { ok: false, why: 'the node is not installed and logged in yet' };
      if (!(s.done || {}).lightning) return { ok: false, why: 'set up Lightning for custody, or choose to set it up later' };
      if (!(s.done || {}).bond) return { ok: false, why: 'post the bond, or choose to post it later' };
      mark('done');
      finished = true;
      sessions.clear(); saveSessions(true);
      setTimeout(() => onDone(), 200);
      const reachNow = state.read().reach || {};
      return { ok: true, owner: `${reachNow.url || `http://127.0.0.1:${portOf()}`}/Dashboard/owner`, url: reachNow.url || null, mode: reachNow.mode || null };
    },
  };

  const chainOf = (b) => (b.kind === 'electrum'
    ? { kind: 'electrum', host: String(b.host || ''), port: Number(b.port), tls: b.tls !== false }
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
    // THE TOKEN, ONCE: traded for a session and gone
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
      if (!token || nowMs() > tokenUntil || !same(url.searchParams.get('t'), token)) return json(res, 403, { ok: false, why: 'that setup link is used or expired: restart the installer for a new one' });
      token = null;
      const sid = b64u(32);
      sessions.set(hashOf(sid), nowMs()); saveSessions(true);
      const secure = String(req.headers['x-forwarded-proto'] || req.headers['cf-visitor'] || '').includes('https') ? '; Secure' : '';
      res.writeHead(303, { location: '/', 'set-cookie': `arena_wizard=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_IDLE_MS / 1000}${secure}`, 'cache-control': 'no-store' });
      return res.end();
    }
    if (!sessionOk(req)) return json(res, 401, { ok: false, why: finished ? 'the installer has finished' : 'open the setup link the installer printed' });
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
      return res.end(page());
    }
    const door = api[`${req.method} ${url.pathname}`];
    if (!door) return json(res, 404, { ok: false, why: 'no such door' });
    if (req.method === 'POST' && req.headers['x-arena-wizard'] !== '1') return json(res, 403, { ok: false, why: 'missing x-arena-wizard' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const r = await door(body);
      log(`[wizard] ${req.method} ${url.pathname} -> ${r.ok ? 'ok' : r.why}`);
      return json(res, 200, r);
    } catch (e) { return json(res, 400, { ok: false, why: e.message }); }
  }

  return { get token() { return token; }, handle, allowHost, close: () => { finished = true; sessions.clear(); saveSessions(true); } };
}
