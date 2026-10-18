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
import { nextStep, seatEnv, ROLES } from './state.js';
import { installService } from './service.js';
import * as reachKit from './reach.js';
import { DatabaseSync } from 'node:sqlite';
import { walletOf, payoutKeyOf, coinsOf, broadcast } from './wallet.js';
import { buildBond, lockOf, BOND_MIN_SATS } from './bond.js';
import { signOwnerRequest, ownerEventTemplate } from '../../arena-node/src/owner.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

export const TOKEN_MS = 30 * 60000;        // the setup token's life
export const SESSION_IDLE_MS = 2 * 3600000;
const b64u = (n) => randomBytes(n).toString('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * The wizard. `state`: nodeState(home). `release`: the installed release's root. `seatPort`: the node's port. Injectables for the tests:
 * `test` (chain test), `install` (service), `fetcher`, `nowMs`. Answers { token, handle(req, res), allowHost(host), close() }.
 */
export function createWizard({ state, release, seatPort = reachKit.DEFAULT_NODE_PORT, bridgePort = null, test = testConnection, install = installService,
  fetcher = fetch, reach = reachKit, cloudflared = 'cloudflared', chainKit = { coinsOf, broadcast }, nowMs = () => Date.now(), onDone = () => {}, log = () => {} }) {
  let token = b64u(32);
  const tokenUntil = nowMs() + TOKEN_MS;
  const sessions = new Map();                // sid -> last seen ms
  const hosts = new Set();
  let pendingSeed = null;                    // { seed, words, positions } until confirmed - never on disk unconfirmed
  let login = null;                          // the Cloudflare login under way: { url, result }
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
    for (const [k, seen] of sessions) if (same(k, sid)) {
      if (nowMs() - seen > SESSION_IDLE_MS) { sessions.delete(k); return false; }
      sessions.set(k, nowMs()); return true;
    }
    return false;
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
      bond: s.bond || null, wallet: (s.done || {}).seed ? { address: walletOf(fromHex(state.readSecret('seed.hex'))).address, needSats: String(BOND_MIN_SATS) } : null,
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

    'POST /api/roles': async (b) => {
      const roles = [...new Set((b.roles || []).map(String))];
      const unknown = roles.filter((r) => !ROLES[r]);
      if (unknown.length) return { ok: false, why: `no role ${unknown.join(', ')}` };
      if (!roles.length) return { ok: false, why: 'choose at least one role' };
      if (roles.includes('custody')) return { ok: false, why: 'custody comes with the custody step in a later release: choose verify and/or settlement now; it can be added from the owner page then' };
      mark('roles', { roles });
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
    'POST /api/bond/check': async () => {
      const s = state.read();
      if (!(s.done || {}).service) return { ok: false, why: 'install the node first: the bond is signed with its own key' };
      const w = walletOf(fromHex(state.readSecret('seed.hex')));
      const { tip, coins } = await chainKit.coinsOf(s.chain, w.spk);
      const total = coins.reduce((a, c) => a + c.sats, 0);
      return { ok: true, address: w.address, tip, coins, totalSats: total, needSats: Number(BOND_MIN_SATS), enough: total >= Number(BOND_MIN_SATS) + 2000, lock: lockOf(tip) };
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
          endpoint: s.reach.url, payoutPubkey: payoutKeyOf(seed), softwareHash: commitOf(), feeRate: 2 });
      } catch (e) { return { ok: false, why: e.message }; }
      const fundingTxid = await chainKit.broadcast(s.chain, built.funding.hex);
      const bondTxid = await chainKit.broadcast(s.chain, built.bond.hex);
      const bond = { txid: bondTxid, vout: 0, fundingTxid, sats: String(built.bondSats), maturity: built.maturity, advertId: built.advertId, postedAtTip: tip,
        lock: lockOf(tip, { maturity: built.maturity }), atMs: Date.now() };
      mark('bond', { bond });
      return { ok: true, bond };
    },
    'POST /api/bond/later': async () => { mark('bond', { bond: null }); return { ok: true }; },

    'POST /api/finish': async () => {
      const s = state.read();
      if (!(s.done || {}).service) return { ok: false, why: 'the node is not installed and logged in yet' };
      if (!(s.done || {}).bond) return { ok: false, why: 'post the bond, or choose to post it later' };
      mark('done');
      finished = true;
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
      sessions.set(sid, nowMs());
      const secure = String(req.headers['x-forwarded-proto'] || req.headers['cf-visitor'] || '').includes('https') ? '; Secure' : '';
      res.writeHead(303, { location: '/', 'set-cookie': `arena_wizard=${sid}; HttpOnly; SameSite=Strict; Path=/${secure}`, 'cache-control': 'no-store' });
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

  return { get token() { return token; }, handle, allowHost, close: () => { finished = true; sessions.clear(); } };
}
