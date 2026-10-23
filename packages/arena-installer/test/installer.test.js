// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER, FRESH, THROUGH ITS API (F.1): the wizard's doors in order against a real seat process - started from
// the settings the wizard wrote, on a fake testnet4 bitcoind that serves block 0 - and the owner login the running seat checks itself.
// And the guards: the token works once, a foreign Host or a missing header is refused, the seed is asked back, the genesis decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWizard } from '../src/wizard.js';
import { nodeState, seatEnv, ROLES } from '../src/state.js';
import { waitHealthy, seatUnit } from '../src/service.js';
import { probeCore, probeElectrum, tipsAgree, agreeHeights, TESTNET4_GENESIS, headerHash, testConnection } from '../src/chain-test.js';
import { quickTunnelName } from '../src/tunnel.js';
import { configureLnd, lndArgs } from '../src/lnd.js';
import { configureGateway } from '../src/gateway.js';
import { writeLaunchers } from '../src/launchers.js';
import * as reachKit from '../src/reach.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { createReachCheck } from '../../arena-node/src/reach-check.js';

// AN ARENA SEAT'S REACH DOOR, the real one (arena-node reach-check.js), on loopback (allowPrivate: the test has no public address)
async function reachSeat() {
  const check = createReachCheck({ allowPrivate: true });
  const server = http.createServer((q, s) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', async () => {
    const r = await check(q, JSON.parse(b || '{}')); s.writeHead(r.status, { 'content-type': 'application/json' }); s.end(JSON.stringify(r.body)); }); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const RELEASE = resolve(fileURLToPath(import.meta.url), '../../../..');
const G_HEADER = '0100000000000000000000000000000000000000000000000000000000000000000000004e7b2b9128fe0291db0693af2ae418b767e657cd407e80cb1434221eaea7a07a046f3566ffff001dbb0c7817';
const G_BLOCK = G_HEADER + '0101000000010000000000000000000000000000000000000000000000000000000000000000ffffffff5504ffff001d01044c4c30332f4d61792f323032342030303030303030303030303030303030303030303165626435386332343439373062336161396437383362623030313031316662653865613865393865303065ffffffff0100f2052a010000002321000000000000000000000000000000000000000000000000000000000000000000ac00000000';

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

// A TESTNET4 BITCOIND OF ONE BLOCK: block 0, cookie auth
function fakeBitcoind(cookie, { genesis = TESTNET4_GENESIS } = {}) {
  const answer = (method, params) => {
    switch (method) {
      case 'getblockchaininfo': return { chain: 'testnet4', blocks: 0, headers: 0, bestblockhash: genesis, initialblockdownload: false, pruned: false };
      case 'getblockcount': return 0;
      case 'getblockhash': if (params[0] === 0) return genesis; throw new Error('Block height out of range');
      case 'getblockheader': if (params[0] !== genesis) throw new Error('Block not found');
        return params[1] === false ? G_HEADER : { hash: genesis, height: 0, time: 1714777860, mediantime: 1714777860, confirmations: 1 };
      case 'getblock': if (params[0] !== genesis) throw new Error('Block not found'); return G_BLOCK;
      default: throw new Error(`Method not found: ${method}`);
    }
  };
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      if (req.headers.authorization !== `Basic ${Buffer.from(cookie).toString('base64')}`) { res.writeHead(401); return res.end(); }
      const { id, method, params = [] } = JSON.parse(b);
      let out; try { out = { result: answer(method, params), error: null, id }; } catch (e) { out = { result: null, error: { code: -1, message: e.message }, id }; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })));
}

// THE SERVICE, WITHOUT SYSTEMD: the seat started from the unit's own command line - src/run.js and the arena.conf the wizard wrote
function directInstall(children) {
  return async ({ release, home, port }) => {
    const env = { PATH: process.env.PATH, HOME: home };
    const unit = seatUnit({ node: process.execPath, release, home, port });
    const exec = /ExecStart=(.*)/.exec(unit)[1].split(' ');
    const cwd = /WorkingDirectory=(.*)/.exec(unit)[1];
    const t0 = Date.now();
    const child = spawn(exec[0], exec.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    children.push(child);
    const h = await waitHealthy({ port, waitMs: 60000, everyMs: 300 });
    if (!h.ok) return { ...h, why: `${h.why}\n${out.slice(-2000)}` };
    return { ...h, ms: Date.now() - t0, linger: null };
  };
}

// one request to the wizard, as a browser would send it
function client(port, { host = `127.0.0.1:${port}` } = {}) {
  let cookie = '';
  const req = (method, path, body, headers = {}) => new Promise((ok, no) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host, cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => {
        const sc = res.headers['set-cookie']; if (sc) cookie = String(sc[0] || sc).split(';')[0];
        let j = null; try { j = JSON.parse(b); } catch { /* html */ }
        ok({ status: res.statusCode, json: j, text: b, headers: res.headers });
      });
    });
    r.on('error', no); if (body) r.write(JSON.stringify(body)); r.end();
  });
  return { req, post: (path, body = {}) => req('POST', path, body, { 'x-arena-wizard': '1' }), get: (path) => req('GET', path), get cookie() { return cookie; } };
}

test('a fresh node through the wizard: chain, roles, seed asked back, owner bound, the seat started and the owner logged in', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-install-'));
  const cookiePath = join(home, 'fake.cookie'); writeFileSync(cookiePath, '__cookie__:s3cret');
  const btc = await fakeBitcoind('__cookie__:s3cret');
  const children = [];
  const seatPort = await freePort();
  const state = nodeState(home);
  // the chain test with the fake as the source and a fake second source that agrees (the real list needs the internet)
  const probe = { core: probeCore, electrum: async () => ({ ok: true, height: 0, tipHash: TESTNET4_GENESIS, atHashes: { 0: TESTNET4_GENESIS }, latencyMs: 1 }) };
  const seat = await reachSeat();
  // LND's peer port (9735) is measured as a fake here: the real port may be taken on this machine (the the test host's mainnet LND)
  const reach = { ...reachKit, checkDirect: (o) => (o.port === 9735 ? Promise.resolve({ ok: true, reached: false, address: '203.0.113.5', port: 9735, diagnosis: { advice: 'behind NAT' } })
    : reachKit.checkDirect({ ...o, seats: [seat.url, seat.url] })) };
  // THE CHAIN FOR THE BOND: a deposit of 60,000 sat at the wallet's address once asked twice; what is broadcast is kept
  const sent = []; let asked = 0;
  const chainKit = { coinsOf: async () => ({ tip: 156900, coins: ++asked > 1 ? [{ txid: '5a'.repeat(32), vout: 1, sats: 366000, height: 156899 }] : [] }),
    broadcast: async (_chain, hex) => { sent.push(hex); return Buffer.from(parseTransaction(Buffer.from(hex, 'hex')).txid).reverse().toString('hex'); } };
  const lndKit = { configureLnd, lndArgs };   // the rest set where the Lightning step runs
  const gwKit = { configureGateway };
  // THE NETWORK'S BOND TARGET, fixed at the floor: the live seats' GET /capacity said 250,000 sat on 2026-10-21 (band CALM), which turned
  // this test red on every machine that reached them; the rest of the wizard's fetches go out as they are
  const fetcher = (url, o) => (/bitcoin-arena\.io/.test(String(url)) ? Promise.resolve(new Response(JSON.stringify(/daily\.json$/.test(String(url))
    ? { testnet: { node: ['https://a.example', 'https://b.example'] } } : { network: { installMinimumBondSats: 50000, band: 'CALM' } }), { status: 200 }))
    : /\.example\/capacity$/.test(String(url)) ? Promise.resolve(new Response(JSON.stringify({ network: { installMinimumBondSats: 50000, band: 'CALM' } }), { status: 200 })) : fetch(url, o));
  const wizard = createWizard({ state, release: RELEASE, seatPort, reach, chainKit, fetcher, test: (c) => testConnection(c, { probe, list: [{ host: 'second', port: 1 }] }), install: directInstall(children), lndKit, gwKit,
    launch: (o) => writeLaunchers({ ...o, platform: 'linux', env: { XDG_DATA_HOME: join(home, 'xdg'), HOME: home } }) });
  const server = http.createServer((q, s) => wizard.handle(q, s));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  t.after(() => { for (const c of children) c.kill('SIGTERM'); server.close(); btc.close(); seat.close(); rmSync(home, { recursive: true, force: true }); });

  const c = client(port);
  assert.equal((await c.get('/api/state')).status, 401, 'nothing without the token');
  assert.equal((await client(port, { host: 'evil.example:80' }).get(`/?t=${wizard.token}`)).status, 421, 'a foreign Host is refused (DNS rebinding)');
  const token = wizard.token;
  const enter = await c.get(`/?t=${token}`);
  assert.equal(enter.status, 303); assert.match(enter.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.equal((await client(port).get(`/?t=${token}`)).status, 403, 'the token works once');
  assert.equal((await c.get('/')).status, 200, 'the page, with the session');
  const steps = await c.get('/wizard.js');
  assert.equal(steps.status, 200, 'the React steps, with the session (kanban #564)'); assert.match(steps.headers['content-type'], /^text\/javascript/);
  assert.equal((await client(port).get('/wizard.js')).status, 401, 'not without it');
  assert.equal((await c.req('POST', '/api/roles', { roles: ['verify'] })).status, 403, 'a POST without x-arena-wizard is refused');

  let s = (await c.get('/api/state')).json;
  assert.equal(s.step, 'chain');
  const bad = (await c.post('/api/chain/save', { kind: 'core', url: btc.url.replace(/\d+\/$/, '1/'), cookiePath })).json;
  assert.equal(bad.ok, false, 'nothing answers there: not saved');
  const saved = (await c.post('/api/chain/save', { kind: 'core', url: btc.url, cookiePath })).json;
  assert.equal(saved.ok, true, saved.why);
  assert.equal(saved.result.source.genesis, TESTNET4_GENESIS);

  assert.equal((await c.post('/api/roles', { roles: ['verify', 'settlement', 'custody'] })).json.ok, true, 'custody on the node\'s own Core');
  assert.equal((await c.get('/api/state')).json.done.lightning, undefined, 'custody: the Lightning step is to come'),
  assert.equal((await c.post('/api/roles', { roles: ['verify', 'settlement'] })).json.ok, true);
  assert.ok((await c.get('/api/state')).json.done.lightning, 'no custody: no Lightning step');
  assert.equal((await c.post('/api/roles', { roles: ['verify', 'settlement', 'custody'] })).json.ok, true);

  // THE APPS (kanban #569): the release's three, all chosen at first; the node hosts the ones saved
  s = (await c.get('/api/state')).json;
  assert.equal(s.step, 'apps');
  assert.deepEqual([s.appInfo.map((a) => `${a.id}:${a.versions}`), s.apps], [['nextblock:5', 'btc-updown:19', 'rock-paper-scissors:5'], ['nextblock', 'btc-updown', 'rock-paper-scissors']]);
  assert.equal((await c.post('/api/apps', { apps: ['nextblock', 'rock-paper-scissors'] })).json.ok, true);
  assert.equal((await c.get('/api/state')).json.step, 'seed');

  assert.equal((await c.post('/api/owner', { mode: 'seed' })).json.ok, false, 'no owner before the seed');
  const shown = (await c.post('/api/seed/new')).json;
  assert.equal(shown.words.length, 24); assert.equal(shown.positions.length, 3);
  assert.deepEqual((await c.post('/api/seed/new')).json.words, shown.words, 'shown again, the same words, until confirmed');
  const wrong = Object.fromEntries(shown.positions.map((p) => [p, 'abandon']));
  if (shown.positions.some((p) => shown.words[p - 1] !== 'abandon')) assert.equal((await c.post('/api/seed/confirm', { answers: wrong })).json.ok, false, 'wrong words are refused');
  assert.equal(state.exists('seed.hex'), false, 'nothing written before the words are confirmed');
  const right = Object.fromEntries(shown.positions.map((p) => [p, ` ${shown.words[p - 1].toUpperCase()} `]));
  assert.equal((await c.post('/api/seed/confirm', { answers: right })).json.ok, true);
  assert.equal(statSync(join(home, 'seed.hex')).mode & 0o777, 0o600, 'the seed is the user\'s only');
  assert.equal((await c.post('/api/seed/new')).json.ok, false, 'one seed per node');

  const owner = (await c.post('/api/owner', { mode: 'seed' })).json;
  assert.equal(owner.ok, true); assert.match(owner.owner.pubkey, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'node.db.owner.json'), 'utf8')).pubkey, owner.owner.pubkey, 'bound beside the database before the first start');

  assert.equal((await c.post('/api/service', { boot: true })).json.ok, false, 'no service before the reach step');
  assert.equal((await c.post('/api/reach/save', { mode: 'direct' })).json.ok, false, 'direct only once the seats reached it');
  const direct = (await c.post('/api/reach/direct', { port: seatPort })).json;
  assert.equal(direct.result.reached, true, JSON.stringify(direct.result));
  assert.deepEqual([direct.result.address, direct.result.answers.length, direct.default], ['127.0.0.1', 2, 'direct'], 'two seats connected back: direct is the default');
  const saved2 = (await c.post('/api/reach/save', { mode: 'direct' })).json;
  assert.deepEqual([saved2.ok, saved2.reach.url], [true, `http://127.0.0.1:${seatPort}`]);
  const svc = (await c.post('/api/service', { boot: true })).json;
  assert.equal(svc.ok, true, svc.why);
  assert.match(svc.identity, /^[0-9a-f]{64,66}$/);
  assert.equal(svc.login.ok, true, 'the running seat accepted the owner\'s signed login');
  const conf = readFileSync(join(home, 'arena.conf'), 'utf8');
  assert.equal(conf.includes(`\nbitcoind_url=${btc.url}\n`), true);
  assert.equal(conf.includes('\nbind=0.0.0.0\n'), true, 'a direct node listens on every interface');
  assert.equal(conf.includes(`\npublic_url=http://127.0.0.1:${seatPort}\n`), true, 'and names its public address');
  assert.equal(conf.includes(`\nport=${seatPort}\n`), true, 'and its port');
  assert.equal(conf.includes(`\napps=${['nextblock.js', 'nextblock-v2.js', 'nextblock-v3.js', 'nextblock-v4.js', 'nextblock-v5.js'].map((f) => join(RELEASE, 'packages/nextblock/plugin', f)).join(',')},${join(RELEASE, 'packages/rock-paper-scissors/plugin/rock-paper-scissors.js')},`), true, 'and hosts the apps chosen, every version (kanban #569)');
  assert.equal(conf.includes('btc-updown'), false, 'not the one left out');
  assert.equal(existsSync(join(home, 'node.env')), false, 'no environment file');
  assert.equal(statSync(join(home, 'arena.conf')).mode & 0o777, 0o600);
  // a stranger's key is not the owner: the seat itself refuses it (proof the binding is the seat's, not the wizard's)
  const { signOwnerRequest } = await import('../../arena-node/src/owner.js');
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const stranger = signOwnerRequest({ node: svc.identity, action: 'login', secret: schnorr.utils.randomSecretKey(), sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
  const refused = await fetch(`http://127.0.0.1:${seatPort}/owner/login`, { method: 'POST', body: JSON.stringify(stranger) });
  assert.equal(refused.status, 403);
  assert.equal(statSync(join(home, 'node.db')).isFile(), true);

  // LIGHTNING (slice 5): LND here - its download and service faked, its config real; the wallet waited for, then made from the seed
  s = (await c.get('/api/state')).json;
  assert.equal(s.step, 'lightning');
  const lndCalls = [];
  lndKit.installLnd = async () => ({ ok: true, lnd: '/fake/lnd', sha256: 'ab'.repeat(32) });
  lndKit.installProgram = async (o) => { lndCalls.push(o); return { ok: true }; };
  let walletReady = false;
  lndKit.createLndWallet = async ({ cfg, seed }) => (walletReady ? { ok: true, created: lndCalls.push({ seedLen: seed.length, cfg: cfg.restUrl }) > 0 } : { ok: false, why: 'LND is starting (no TLS certificate yet)' });
  lndKit.testLnd = async () => ({ ok: true, pubkey: '03' + 'cd'.repeat(32), alias: 'arena-node', blockHeight: 156900, syncedToChain: true, network: 'testnet4', version: '0.21.4-beta' });
  const own = (await c.post('/api/lightning/own', { boot: true })).json;
  assert.equal(own.ok, true, own.why);
  assert.equal(lndCalls[0].id, 'lnd');
  assert.match(lndCalls[0].args.join(' '), /^\/fake\/lnd --lnddir=.*lnd --configfile=.*lnd\.conf$/);
  assert.match(readFileSync(join(home, 'lnd', 'lnd.conf'), 'utf8'), /bitcoin\.testnet4=true[\s\S]*bitcoind\.rpccookie=/);
  assert.deepEqual([state.read().lnReach.reached, /externalip=/.test(readFileSync(join(home, 'lnd', 'lnd.conf'), 'utf8'))], [false, false], 'LND\'s port measured from outside first: not reached, so no external address');
  assert.match(state.read().tor.why || 'tor', /no Tor|tor/, 'not reached: Tor (none in this test release and none in PATH: said)');
  const waiting = (await c.post('/api/lightning/status')).json;
  assert.deepEqual([waiting.ok, waiting.waiting], [false, true]);
  walletReady = true;
  const ln = (await c.post('/api/lightning/status')).json;
  assert.deepEqual([ln.ok, ln.created, ln.network, lndCalls[1].seedLen], [true, true, 'testnet4', 32], 'the wallet from the 32-byte seed');
  assert.equal((await c.post('/api/lightning/connect', { restUrl: 'http://x:1', macaroonHex: 'ab', tlsCertPem: '' })).json.why, 'LND\'s REST address is https');
  assert.equal((await c.get('/api/state')).json.step, 'lightning', 'LND alone does not finish the step: the gateway (or "later") does');
  // THE GATEWAY: from the release (faked here), configured for real, a service with the seed's mnemonic, then a federation by invite
  gwKit.findGatewayd = () => ({ ok: false, why: 'this release carries no gateway for linux-x64 yet (runtime/custody/ is missing)' });
  assert.equal((await c.post('/api/gateway/setup')).json.noBinary, true);
  gwKit.findGatewayd = () => ({ ok: true, gatewayd: '/fake/gatewayd' });
  const gwCalls = [];
  gwKit.installProgram = async (o) => { gwCalls.push(o); return { ok: true }; };
  let gwUp = false;
  const fed = { federationId: 'ee'.repeat(32), name: 'T', balanceMsat: 0 };
  gwKit.testGateway = async () => (gwUp ? { ok: true, state: 'Running', lightningPubkey: '03' + 'cd'.repeat(32), network: 'testnet4', blockHeight: 156910, federations: gwKit.joined ? [fed] : [] } : { ok: false, why: 'the gateway does not answer yet (ECONNREFUSED)' });
  gwKit.joinFederation = async ({ invite }) => { gwKit.joined = invite; return { ok: true, federationId: fed.federationId }; };
  assert.equal((await c.post('/api/gateway/setup')).json.ok, true);
  assert.equal(gwCalls[0].id, 'gateway');
  assert.equal(gwCalls[0].args[0], '/fake/gatewayd');
  assert.ok(gwCalls[0].args.includes(`--lnd-macaroon=${join(home, 'lnd', 'data', 'chain', 'bitcoin', 'testnet4', 'admin.macaroon')}`));
  assert.equal(gwCalls[0].vars.FM_GATEWAY_MNEMONIC.split(' ').length, 24);
  assert.equal((await c.post('/api/gateway/status')).json.waiting, true);
  gwUp = true;
  assert.equal((await c.post('/api/gateway/status')).json.state, 'Running');
  const joined = (await c.post('/api/gateway/join', { invite: 'fed1testinvite' })).json;
  assert.deepEqual([joined.ok, joined.federations[0].name, gwKit.joined], [true, 'T', 'fed1testinvite']);
  assert.equal((await c.get('/api/state')).json.gateway.passwordFile, undefined, 'the page is not told where the admin password is');

  // THE FEDERATION, ITS OWN STEP (2026-10-18): explained, no choice - a guardian seat is drawn (founding or succession), never invited
  s = (await c.get('/api/state')).json;
  assert.equal(s.step, 'federation');
  assert.equal((await c.post('/api/federation', { mode: 'invite', invite: 'fed1x' })).json.mode, 'drawn', 'no invitation: a guardian seat is only drawn');
  // THE BOND'S RULES, UNDERSTOOD: no bond before them; only "I UNDERSTAND" goes on
  s = (await c.get('/api/state')).json;
  assert.equal(s.step, 'promise');
  assert.match((await c.post('/api/bond/post')).json.why, /type I UNDERSTAND/);
  assert.match((await c.post('/api/promise', { text: 'ok' })).json.why, /type I UNDERSTAND/);
  assert.equal((await c.post('/api/promise', { text: ' i understand ' })).json.ok, true);
  s = (await c.get('/api/state')).json;
  assert.equal(s.step, 'bond');
  assert.equal(s.lightning.pubkey, '03' + 'cd'.repeat(32));
  assert.equal(s.gateway.federations[0].name, 'T');
  assert.match(s.wallet.address, /^tb1p/);
  assert.equal((await c.post('/api/finish')).json.ok, false, 'not finished before the bond is posted or deferred');
  const none = (await c.post('/api/bond/check')).json;
  assert.deepEqual([none.ok, none.coins.length, none.enough, none.lock.maturity], [true, 0, false, 156900 + 1 + 144 + 144]);
  const found = (await c.post('/api/bond/check')).json;
  assert.deepEqual([found.totalSats, found.enough], [366000, true]);
  assert.deepEqual(found.parts, { bond: 50000, fees: 2000, advertUpdate: 5000, pegIn: 50000, outside: 103000, ring: 153000 }, 'custody: the bond, the advertisement update\'s reserve, the peg-in, the outside and the ring channel');
  assert.equal(found.needSats, 363000);
  assert.equal((await c.post('/api/bond/check', { pegInSats: 70000 })).json.enough, false, 'a larger peg-in needs more than arrived');
  assert.equal((await c.post('/api/bond/check', { pegInSats: 50000 })).json.enough, true);
  const posted = (await c.post('/api/bond/post')).json;
  assert.equal(posted.ok, true, posted.why);
  assert.equal(sent.length, 2, 'the funding and the bond, broadcast in that order');
  const { advertInTransaction } = await import('../../arena-protocol/src/census.js');
  const advert = advertInTransaction(Buffer.from(sent[1], 'hex'));
  assert.equal(Buffer.from(advert.nodePubkey).toString('hex'), svc.identity, 'the bond names this node\'s own key (read from its store)');
  assert.deepEqual([advert.endpoint, advert.bondMaturityHeight], [`http://127.0.0.1:${seatPort}`, posted.bond.maturity]);
  assert.equal((await c.post('/api/bond/post')).json.ok, false, 'one bond');
  const agent = gwCalls.find((x) => x.id === 'custody');
  assert.ok(agent && agent.args[1].endsWith(join('bin', 'custody-agent.mjs')) && agent.args.includes(home), 'the custody agent runs as a service of this node');
  s = (await c.get('/api/state')).json;
  assert.equal(s.step, 'done');
  assert.match(readFileSync(join(home, 'bin', 'arena-node-start'), 'utf8'), /systemctl --user start .*arena-lnd.service .*arena-gateway.service .*arena-node.service/, 'the start script names this node\'s services');
  assert.ok((await c.get('/api/state')).json.launchers.start.endsWith('arena-node-start'));
  // THE ARENANODE COMMAND: written with this node's home in it, and on the PATH (~/.local/bin)
  const cmd = readFileSync(join(home, 'bin', 'arenanode'), 'utf8');
  assert.match(cmd, /exec '[^']+' '[^']+\/packages\/arena-installer\/bin\/arenanode\.mjs' --home '[^']+' --name arenanode "\$@"/);
  assert.equal(realpathSync(join(home, '.local', 'bin', 'arenanode')), realpathSync(join(home, 'bin', 'arenanode')), 'linked into ~/.local/bin');
  assert.equal((await c.get('/api/state')).json.launchers.command.name, 'arenanode');
  const fin = (await c.post('/api/finish')).json;
  assert.deepEqual([fin.ok, fin.mode, fin.owner], [true, 'direct', `http://127.0.0.1:${seatPort}/Dashboard/owner`], 'the user is told how to reach the node');
  assert.equal((await c.get('/api/state')).status, 401, 'after finish the wizard answers nothing');
});

test('the state survives a restart of the installer: a new wizard resumes at the next step', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arena-install-'));
  try {
    const a = nodeState(home);
    a.save({ chain: { kind: 'core', url: 'http://x/' }, done: { chain: 1, roles: 2 }, roles: ['verify'] });
    const w = createWizard({ state: nodeState(home), release: RELEASE, seatPort: 1 });
    const server = http.createServer((q, s) => w.handle(q, s));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const c = client(server.address().port);
    await c.get(`/?t=${w.token}`);
    const s = (await c.get('/api/state')).json;
    server.close();
    assert.equal(s.step, 'apps', 'the apps step comes after the roles (kanban #569)');
    assert.equal(statSync(home).mode & 0o777, 0o700);
    const env = seatEnv({ ...a.read(), port: 7801 }, { home, release: '/opt/arena' });
    assert.match(env, /ARENA_BITCOIND_URL=http:\/\/x\//);
    assert.match(env, /ARENA_APPS=\/opt\/arena\/packages\/nextblock\/plugin\/nextblock.js\n/, 'a release without app.json: Next Block, as before');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the genesis decides the chain: a bitcoind or Electrum server on another chain is refused by what it serves', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arena-install-'));
  const cookiePath = join(home, 'c'); writeFileSync(cookiePath, 'u:p');
  const testnet3 = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
  const btc = await fakeBitcoind('u:p', { genesis: testnet3 });
  try {
    const r = await probeCore({ url: btc.url, cookiePath });
    assert.equal(r.ok, false); assert.match(r.why, /not testnet4/);
    const missing = await probeCore({ url: btc.url, cookiePath: join(home, 'none') });
    assert.match(missing.why, /no cookie file/);
    assert.equal(headerHash(G_HEADER), TESTNET4_GENESIS, 'the header hash is Bitcoin\'s');
    // an Electrum server, over a socket pair: answers header 0 of testnet3
    const srv = net.createServer((sock) => { let b = ''; sock.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const m = JSON.parse(b.slice(0, i)); b = b.slice(i + 1);
      const result = m.method === 'server.version' ? ['Fake 1', '1.4'] : m.method === 'blockchain.headers.subscribe' ? { height: 5, hex: G_HEADER } : '01' + G_HEADER.slice(2, 152) + '00000000';
      sock.write(JSON.stringify({ id: m.id, result }) + '\n'); } }); });
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const e = await probeElectrum({ host: '127.0.0.1', port: srv.address().port, tls: false });
    srv.close();
    assert.equal(e.ok, false); assert.match(e.why, /not testnet4/);
  } finally { btc.close(); rmSync(home, { recursive: true, force: true }); }
});

test('two sources agree below a forked tip, and not across chains', () => {
  const a = { ok: true, height: 100, atHashes: { 97: 'x97', 94: 'x94', 91: 'x91', 88: 'x88' } };
  assert.deepEqual(agreeHeights(a, { height: 101 }), [97, 94, 91, 88]);
  assert.equal(tipsAgree(a, { ok: true, height: 101, atHashes: { 97: 'x97' } }).ok, true);
  const forked = tipsAgree(a, { ok: true, height: 100, atHashes: { 97: 'y97', 94: 'y94', 91: 'x91' } });
  assert.equal(forked.ok, true); assert.equal(forked.forkDepth, 9, 'measured live: a 5-block competing branch');
  assert.equal(tipsAgree(a, { ok: true, height: 100, atHashes: { 97: 'y', 94: 'y', 91: 'y', 88: 'y' } }).ok, false);
  assert.equal(tipsAgree(a, { ok: true, height: 110, atHashes: {} }).ok, false, '10 blocks apart');
  assert.equal(quickTunnelName('INF Requesting new quick Tunnel on https://api.trycloudflare.com...\n| https://brave-owl-runs-fast.trycloudflare.com |'), 'https://brave-owl-runs-fast.trycloudflare.com');
  assert.equal(quickTunnelName('https://api.trycloudflare.com failed'), null);
});

test('what blocks a port: the host firewall when the public address is this machine\'s, the router otherwise, no seat - said so', async () => {
  const ifaces = { eth0: [{ address: '203.0.113.7', internal: false }], lo: [{ address: '127.0.0.1', internal: true }] };
  const sh = async (cmd, args) => ({ ok: cmd === 'which' && args[0] === 'ufw', out: '' });
  const fw = await reachKit.diagnose({ address: '203.0.113.7', port: 8470, asked: 2, ifaces, sh });
  assert.equal(fw.cause, 'host-firewall'); assert.match(fw.advice, /sudo ufw allow 8470\/tcp/);
  const nat = await reachKit.diagnose({ address: '198.51.100.9', port: 8470, asked: 2, ifaces: { wlan0: [{ address: '192.0.2.20', internal: false }] }, sh });
  assert.equal(nat.cause, 'nat'); assert.match(nat.advice, /forward TCP 8470 on the router to 192\.168\.1\.20:8470/);
  assert.equal((await reachKit.diagnose({ address: null, port: 8470, asked: 0, ifaces, sh })).cause, 'unknown');
  assert.equal(reachKit.defaultReach({ reached: false }), 'permanent', 'no direct reach: the permanent tunnel is the default');
  assert.equal(reachKit.DEFAULT_NODE_PORT, 8470);
  // a direct check whose seats never reach this machine: not reached, and why
  const nowhere = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ ok: true, reached: false, address: '198.51.100.9' })); });
  await new Promise((ok) => nowhere.listen(0, '127.0.0.1', ok));
  const port = await freePort();
  const r = await reachKit.checkDirect({ port, seats: [`http://127.0.0.1:${nowhere.address().port}`], ifaces: { wlan0: [{ address: '192.0.2.20', internal: false }] }, sh });
  nowhere.close();
  assert.deepEqual([r.reached, r.diagnosis.cause], [false, 'nat']);
  const busy = net.createServer().listen(port, '127.0.0.1');
  await new Promise((ok) => busy.once('listening', ok));
  const taken = await reachKit.checkDirect({ port, seats: ['http://127.0.0.1:1'], sh });
  busy.close();
  assert.equal(taken.diagnosis.cause, 'port-busy');
  assert.match(reachKit.tunnelUnit({ bin: '/usr/bin/cloudflared', mode: 'permanent', config: '/h/cloudflared.yml', port: 8470 }), /ExecStart=\/usr\/bin\/cloudflared tunnel --no-autoupdate --config \/h\/cloudflared.yml run/);
  assert.match(reachKit.tunnelUnit({ bin: 'cloudflared', mode: 'quick', port: 8470 }), /--url http:\/\/127.0.0.1:8470/);
});

test('the bond step names the whole deposit from the start: custody 363,000 with its parts, a plain node 52,000 (rc.12 on the test host said 52,000 to a custody node)', async () => {
  const { depositParts } = await import('../src/wizard.js');
  const sum = (p) => Object.values(p).reduce((a, x) => a + x, 0);
  const c = depositParts({ roles: ['custody'] }, 50000);
  assert.deepEqual(c, { bond: 50000, fees: 2000, advertUpdate: 5000, pegIn: 50000, outside: 103000, ring: 153000 });
  assert.equal(sum(c), 363000);
  assert.equal(sum(depositParts({ roles: [] }, 0)), 52000);
  assert.equal(sum(depositParts({ roles: ['liquidity'] }, 0)), 552000);
  // the step that shows it is React's BondStep (kanban #564): its first render names the total and its parts (arena-web's finish test)
});

test('a new node starts with game / verify and settlement ticked; custody and liquidity are chosen on purpose (rc.14 in the Windows VM ticked liquidity: 863,000 sat asked)', () => {
  // the roles are drawn by React's RolesStep (kanban #564), with the same rule (arena-web's OPT_IN_ROLES and onAtStart, its wizard test)
  const opt = ['custody', 'liquidity'];
  const ticked = (st, k) => st.roles.includes(k) || (!st.roles.length && !opt.includes(k));
  assert.deepEqual(['verify', 'settlement', 'custody', 'liquidity'].filter((k) => ticked({ roles: [] }, k)), ['verify', 'settlement']);
  assert.deepEqual(['verify', 'settlement', 'custody', 'liquidity'].filter((k) => ticked({ roles: ['custody', 'verify'] }, k)), ['verify', 'custody'], 'a saved choice is shown as saved');
});

test('the intro: what a node is, one picture, what it earns and needs, then step 1', () => {
  const html = readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
  const intro = html.slice(html.indexOf('<section id="s-intro">'), html.indexOf('<section id="s-chain">'));
  assert.match(intro, /<svg viewBox="0 0 640 230" role="img"/, 'one overview picture');
  assert.match(intro, /4 %<\/b> of every paid round goes to the nodes, <b>1 % for each service<\/b>/);
  assert.match(intro, /100 rounds of 1,000 sat → 4,000 sat to the nodes/);
  for (const need of ['A computer that stays on', 'About 3 GB of disk', 'Home internet', 'A bond of 50,000 sat']) assert.ok(intro.includes(need), need);
  assert.match(html, /const intro = st\.step === 'chain' && !st\.done\.chain && !introSeen\(\);/, 'shown only before the first step is done');
  assert.match(html, /\$\('intro-go'\)\.onclick = async \(\) => \{[^]*?introSkipped = true; try \{ localStorage\.setItem/, '"Set up my node" goes on, remembered where the browser allows');
  // HOW MANY NODES (kanban #596): the count, its note, and the RAM disk checkbox from more than 5, posted before the steps
  assert.match(intro, /<input id="intro-count" type="number" min="1" max="20" value="1"/);
  assert.match(intro, /<label class="choice" id="intro-ram-row" hidden><input id="intro-ram" type="checkbox" checked> <span><b>Put Fedimint on a RAM disk<\/b>/);
  assert.match(html, /\$\('intro-ram-row'\)\.hidden = n < 6/);
  assert.match(html, /\.choice\[hidden\] \{ display: none; \}/, 'hidden wins over the choice\'s flex: no RAM disk checkbox up to 5 nodes');
  assert.match(html, /n >= 10 \? ' 10 or more nodes found their own federation\.'/);
  assert.match(html, /await post\('\/api\/instances', \{ count: n, ram: n >= 6 \? \$\('intro-ram'\)\.checked : false \}\)/);
});

test('the roles step shows each role in one line, its needs as chips, the long text behind "more" ("a wall of text that nobody reads")', () => {
  for (const [k, r] of Object.entries(ROLES)) {
    assert.ok(r.does && r.does.length <= 40, `${k}: one short phrase`);
    assert.ok(Array.isArray(r.chips) && r.chips.length >= 2 && r.chips.every((c) => c.length <= 24), `${k}: its needs as short chips`);
    assert.ok(r.needs.length > 100, `${k}: the full text kept for "more"`);
  }
  assert.ok(ROLES.liquidity.chips.includes('💰 500,000 sat') && ROLES.custody.chips.includes('🚪 port 9735'));
});

// EVERY STEP IS REACT'S (kanban #564, the owner 2026-10-21: "no fall backs"): the page loads the steps (/wizard.js) before its own script,
// hands each step the wizard's state, post and reload, and draws none of them itself - no step's old markup or handlers are left
test('the wizard page draws no step itself: the roles into their list, every other step into its section, the bar of steps and a refusal, by window.ArenaWizard', () => {
  const html = readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('<script src="/wizard.js"></script>') > 0 && html.indexOf('<script src="/wizard.js"></script>') < html.indexOf('<script>\n'), 'the steps load first');
  assert.match(html, /const R = window\.ArenaWizard;\n  if \(!st\.ok\) \{ R\.refused\(document\.querySelector\('main'\), \{ why: st\.why \}\); return; \}\n  R\.bar\(\$\('steps'\), \{ steps: STEPS, done: st\.done, now: st\.step \}\);/, 'the bar of steps and the refusal drawn by React too');
  assert.match(html, /const ctx = \{ st, post, get: async \(path\) => \(await fetch\(path\)\)\.json\(\), reload: load \};/);
  assert.match(html, /if \(st\.step === 'roles'\) R\.mount\('roles', \$\('roles'\), \{ \.\.\.ctx, onCustody: \(on\) => \{ \$\('custody-explain'\)\.hidden = !on; \} \}\);/);
  assert.match(html, /R\.show\(st\.step, \(k\) => \$\('s-' \+ k\), ctx\);/);
  for (const k of ['chain', 'seed', 'owner', 'reach', 'service', 'lightning', 'federation', 'promise', 'bond', 'done']) assert.ok(html.includes(`<section id="s-${k}"></section>`), `${k}: an empty section for React`);
  for (const gone of ['ArenaWizard ||', '!reactStep', '!reactRoles', "$('b-check').onclick", "$('seed-show').onclick", 'function watchSync', 'roles-save', 'class="rc"', 'innerHTML', 'const esc']) assert.ok(!html.includes(gone), gone);
});

// HOW MANY NODES FROM THE INTRO (kanban #596): POST /api/instances checked and kept; the state says it back
test('the intro\'s count of nodes and the RAM disk choice are checked and kept (kanban #596)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arena-install-'));
  try {
    const w = createWizard({ state: nodeState(home), release: RELEASE, seatPort: 1 });
    const server = http.createServer((q, s) => w.handle(q, s));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const c = client(server.address().port);
    await c.get(`/?t=${w.token}`);
    assert.deepEqual((await c.get('/api/state')).json.instances, { count: 1, ram: false }, 'one node unless chosen');
    assert.match((await c.post('/api/instances', { count: 25 })).json.why, /from 1 to 20/);
    const ten = (await c.post('/api/instances', { count: 10, ram: true })).json;
    assert.deepEqual([ten.ok, ten.instances], [true, { count: 10, ram: true }]);
    assert.match(ten.note, /10 or more nodes found their own federation/);
    assert.deepEqual((await c.get('/api/state')).json.instances, { count: 10, ram: true });
    assert.deepEqual((await c.post('/api/instances', { count: 7, ram: false })).json.instances, { count: 7, ram: false }, 'declined');
    server.close();
    assert.deepEqual(nodeState(home).read().instances, { count: 7, ram: false }, 'kept on disk');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
