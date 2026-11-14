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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, realpathSync } from 'node:fs';
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
  const fetcher = (url, o) => (/bitcoin-?arena\.io/.test(String(url)) ? Promise.resolve(new Response(JSON.stringify(/daily\.json$/.test(String(url))
    ? { testnet: { node: ['https://a.example', 'https://b.example'] } } : { network: { installMinimumBondSats: 50000, band: 'CALM' } }), { status: 200 }))
    : /\.example\/capacity$/.test(String(url)) ? Promise.resolve(new Response(JSON.stringify({ network: { installMinimumBondSats: 50000, band: 'CALM' } }), { status: 200 })) : fetch(url, o));
  // THE PROGRESS WHILE IT RUNS (kanban #651): read through the page's own door once the services are in and the seat is awaited
  let midway = null;
  const progressInstall = async (o) => { o.onStage('start'); midway = (await c.get('/api/service/progress')).json; return directInstall(children)(o); };
  const wizard = createWizard({ state, release: RELEASE, seatPort, reach, chainKit, fetcher, test: (c) => testConnection(c, { probe, list: [{ host: 'second', port: 1 }] }), install: progressInstall, lndKit, gwKit,
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
  // the icon, to anyone (the 2026.1.9.11 install test: a missing favicon.ico at every load)
  { const ico = await client(port).get('/favicon.ico'); assert.deepEqual([ico.status, ico.headers['content-type']], [200, 'image/x-icon']); }

  let s = (await c.get('/api/state')).json;
  assert.equal(s.step, 'start', 'New / Restore first (kanban #652)');
  assert.equal((await c.post('/api/start', { mode: 'new' })).json.ok, true);
  assert.equal((await c.get('/api/state')).json.step, 'chain');
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
  assert.deepEqual([s.appInfo.map((a) => `${a.id}:${a.versions}`), s.apps], [['nextblock:6', 'btc-updown:24', 'rock-paper-scissors:5'], ['nextblock', 'btc-updown', 'rock-paper-scissors']]);
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
  { const { nodeKeyOf } = await import('../src/seed.js'); const { schnorr } = await import('@noble/curves/secp256k1.js');
    assert.equal(svc.identity, Buffer.from(schnorr.getPublicKey(nodeKeyOf(Buffer.from(state.readSecret('seed.hex').trim(), 'hex')))).toString('hex'), 'the running seat\'s identity is its seed\'s (kanban #650/#653)'); }
  assert.equal(svc.login.ok, true, 'the running seat accepted the owner\'s signed login');
  // kanban #666: back to the reach step after the install. The same way saved again keeps the address the install gave it; another way
  // opens "Install and start" again, so the node takes the new address
  { const keep = state.read();
    state.save({ reach: { mode: 'quick', port: seatPort, url: 'https://a-b-c-d.trycloudflare.com' } });
    const again = (await c.post('/api/reach/save', { mode: 'quick' })).json;
    assert.deepEqual([again.ok, again.reach.url, Boolean(state.read().done.service)], [true, 'https://a-b-c-d.trycloudflare.com', true], 'the quick tunnel\'s name kept, the install stays done');
    const other = (await c.post('/api/reach/save', { mode: 'direct' })).json;
    assert.deepEqual([other.ok, other.again, Boolean(state.read().done.service)], [true, 'service', false], 'another way: Install and start again');
    state.save({ reach: keep.reach, done: keep.done }); }
  assert.equal(midway.running, true, 'while it runs');
  assert.deepEqual(midway.stages.map((x) => [x.id, x.state]), [['settings', 'done'], ['services', 'done'], ['start', 'now'], ['tunnel', 'todo'], ['restart', 'todo'], ['address', 'todo'], ['login', 'todo']]);
  const after = (await c.get('/api/service/progress')).json;
  assert.equal(after.running, false);
  assert.deepEqual(after.stages.map((x) => [x.id, x.state]), [['settings', 'done'], ['services', 'done'], ['start', 'done'], ['tunnel', 'skipped'], ['restart', 'skipped'], ['address', 'skipped'], ['login', 'done']],
    'a direct node has no public address to test through a tunnel');
  assert.ok(after.stages.every((x) => x.state === 'skipped' || Number.isFinite(x.ms)), 'each stage that ran says how long');
  const conf = readFileSync(join(home, 'arena.conf'), 'utf8');
  assert.equal(conf.includes(`\nbitcoind_url=${btc.url}\n`), true);
  assert.equal(conf.includes('\nbind=0.0.0.0\n'), true, 'a direct node listens on every interface');
  assert.equal(conf.includes(`\npublic_url=http://127.0.0.1:${seatPort}\n`), true, 'and names its public address');
  assert.equal(conf.includes(`\nport=${seatPort}\n`), true, 'and its port');
  assert.equal(conf.includes(`\napps=${['nextblock.js', 'nextblock-v2.js', 'nextblock-v3.js', 'nextblock-v4.js', 'nextblock-v5.js', 'nextblock-v6.js'].map((f) => join(RELEASE, 'packages/nextblock/plugin', f)).join(',')},${join(RELEASE, 'packages/rock-paper-scissors/plugin/rock-paper-scissors.js')},`), true, 'and hosts the apps chosen, every version (kanban #569)');
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
  // kanban #664: an LND that does not start says why - the line from LND's own log (logs/bitcoin/testnet4/lnd.log) in the progress
  const lndLog = join(home, 'lnd', 'logs', 'bitcoin', 'testnet4'); mkdirSync(lndLog, { recursive: true });
  writeFileSync(join(lndLog, 'lnd.log'), '[ERR] LTND: unable to connect to bitcoind: connection refused\n');
  const installLnd = lndKit.installLnd;
  lndKit.installLnd = async () => ({ ok: false, why: 'the download was cut' });
  assert.equal((await c.post('/api/lightning/own', { boot: true })).json.ok, false);
  assert.deepEqual((await c.get('/api/lightning/progress')).json.lnd.log, ['[ERR] LTND: unable to connect to bitcoind: connection refused']);
  lndKit.installLnd = installLnd;
  const own = (await c.post('/api/lightning/own', { boot: true })).json;
  assert.equal(own.ok, true, own.why);
  assert.equal(lndCalls[0].id, 'lnd');
  assert.match(lndCalls[0].args.join(' '), /^\/fake\/lnd --lnddir=.*lnd --configfile=.*lnd\.conf$/);
  assert.match(readFileSync(join(home, 'lnd', 'lnd.conf'), 'utf8'), /bitcoin\.testnet4=true[\s\S]*bitcoind\.rpccookie=/);
  assert.deepEqual([state.read().lnReach.reached, /externalip=/.test(readFileSync(join(home, 'lnd', 'lnd.conf'), 'utf8'))], [false, false], 'LND\'s port measured from outside first: not reached, so no external address');
  assert.match(state.read().tor.why || 'tor', /no Tor|tor/, 'not reached: Tor (none in this test release and none in PATH: said)');
  const waiting = (await c.post('/api/lightning/status')).json;
  assert.deepEqual([waiting.ok, waiting.waiting], [false, true]);
  // kanban #661: LND's stages - downloaded, reach measured, started, now waiting for its wallet; the gateway not begun
  let lp = (await c.get('/api/lightning/progress')).json;
  assert.deepEqual(lp.lnd.stages.map((x) => x.state), ['done', 'done', 'done', 'now', 'todo']);
  assert.equal(lp.lnd.running, true);
  assert.equal(lp.gateway.running, false);
  walletReady = true;
  const ln = (await c.post('/api/lightning/status')).json;
  assert.deepEqual([ln.ok, ln.created, ln.network, lndCalls[1].seedLen], [true, true, 'testnet4', 32], 'the wallet from the 32-byte seed');
  lp = (await c.get('/api/lightning/progress')).json;
  assert.deepEqual([lp.lnd.running, lp.lnd.stages.map((x) => x.state)], [false, ['done', 'done', 'done', 'done', 'done']]);
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
  lp = (await c.get('/api/lightning/progress')).json;
  assert.deepEqual([lp.gateway.running, lp.gateway.stages.map((x) => x.state)], [true, ['done', 'done', 'now']]);
  gwUp = true;
  assert.equal((await c.post('/api/gateway/status')).json.state, 'Running');
  assert.deepEqual((await c.get('/api/lightning/progress')).json.gateway.stages.map((x) => x.state), ['done', 'done', 'done']);
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
  assert.match(readFileSync(join(home, 'bin', 'bitcoin-arena-start'), 'utf8'), /systemctl --user start .*arena-lnd.service .*arena-gateway.service .*arena-node.service/, 'the start script names this node\'s services');
  assert.ok((await c.get('/api/state')).json.launchers.start.endsWith('bitcoin-arena-start'));
  // THE BITCOINARENA COMMAND: written with this node's home in it, and on the PATH (~/.local/bin); arenanode beside it runs it (kanban #688)
  const cmd = readFileSync(join(home, 'bin', 'bitcoinarena'), 'utf8');
  assert.match(cmd, /exec '[^']+' '[^']+\/packages\/arena-installer\/bin\/bitcoinarena\.mjs' --home '[^']+' --name bitcoinarena "\$@"/);
  assert.equal(realpathSync(join(home, '.local', 'bin', 'bitcoinarena')), realpathSync(join(home, 'bin', 'bitcoinarena')), 'linked into ~/.local/bin');
  assert.match(readFileSync(join(home, 'bin', 'arenanode'), 'utf8'), /^exec '.*\/bin\/bitcoinarena' "\$@"$/m, 'the old name runs it');
  assert.equal(realpathSync(join(home, '.local', 'bin', 'arenanode')), realpathSync(join(home, 'bin', 'arenanode')));
  assert.equal((await c.get('/api/state')).json.launchers.command.name, 'bitcoinarena');
  const fin = (await c.post('/api/finish')).json;
  // the Arena site's owner page for this node's key, where the installer hands the key over (kanban #687), the local address beside it
  assert.deepEqual([fin.ok, fin.mode], [true, 'direct'], 'the user is told how to reach the node');
  assert.match(fin.owner, new RegExp(`^https://testnet\\.bitcoin-?arena\\.io/owner/#node=[0-9a-f]{64}&local=${encodeURIComponent(`http://127.0.0.1:${seatPort}`)}$`));
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
  assert.match(html, /const intro = st\.step === 'start' && !st\.done\.start && !introSeen\(\);/, 'shown only before the first step is done');
  assert.match(html, /\$\('intro-go'\)\.onclick = async \(\) => \{[^]*?introSkipped = true; try \{ localStorage\.setItem/, '"Set up my node" goes on, remembered where the browser allows');
  // HOW MANY NODES (kanban #596): the count, its note, and the RAM disk checkbox from more than 5, posted before the steps
  assert.match(intro, /<input id="intro-count" type="number" min="1" max="20" value="1"/);
  assert.match(intro, /<label class="choice" id="intro-ram-row" hidden><input id="intro-ram" type="checkbox" checked> <span><b>Put Fedimint on a RAM disk<\/b>/);
  assert.match(html, /\$\('intro-ram-row'\)\.hidden = n < 6/);
  assert.match(html, /\.choice\[hidden\] \{ display: none; \}/, 'hidden wins over the choice\'s flex: no RAM disk checkbox up to 5 nodes');
  assert.match(html, /n >= 10 \? ' 10 or more nodes found their own federation\.'/);
  assert.match(html, /await post\('\/api\/instances', \{ count: n, ram: n >= 6 \? \$\('intro-ram'\)\.checked : false, name: n >= 2 \? \$\('intro-name'\)\.value : '' \}\)/);
});

test('the roles step shows each role in one line, its needs as chips, the long text behind "more" ("a wall of text that nobody reads")', () => {
  for (const [k, r] of Object.entries(ROLES)) {
    assert.ok(r.does && r.does.length <= 40, `${k}: one short phrase`);
    assert.ok(Array.isArray(r.chips) && r.chips.length >= 2 && r.chips.every((c) => c.length <= 24), `${k}: its needs as short chips`);
    assert.ok(r.needs.length > 100, `${k}: the full text kept for "more"`);
  }
  assert.ok(ROLES.liquidity.chips.includes('💰 500,000 sat') && ROLES.custody.chips.includes('🚪 port 9735'));
});

// EVERY STEP IS REACT'S (kanban #564, 2026-10-21: "no fall backs"): the page loads the steps (/wizard.js) before its own script,
// hands each step the wizard's state, post and reload, and draws none of them itself - no step's old markup or handlers are left
test('the wizard page draws no step itself: the roles into their list, every other step into its section, the bar of steps and a refusal, by window.ArenaWizard', () => {
  const html = readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('<script src="/wizard.js"></script>') > 0 && html.indexOf('<script src="/wizard.js"></script>') < html.indexOf('<script>\n'), 'the steps load first');
  assert.match(html, /const R = window\.ArenaWizard;\n  if \(!st\.ok\) \{ R\.refused\(document\.querySelector\('main'\), \{ why: st\.why \}\); return; \}\n  const shown = viewing && st\.done\[viewing\] \? viewing : st\.step;\n  R\.bar\(\$\('steps'\), \{ steps: STEPS, done: st\.done, now: shown, current: st\.step, onPick: pick \}\);/, 'the bar of steps (a done one opens again, kanban #635) and the refusal drawn by React too');
  assert.match(html, /const ctx = \{ st, post, get: async \(path\) => \(await fetch\(path\)\)\.json\(\), reload: \(\) => \{ viewing = null; return load\(\); \} \};/, 'a save goes back to the current step');
  assert.match(html, /if \(shown === 'roles'\) R\.mount\('roles', \$\('roles'\), \{ \.\.\.ctx, onCustody: \(on\) => \{ \$\('custody-explain'\)\.hidden = !on; \} \}\);/);
  assert.match(html, /R\.show\(shown, \(k\) => \$\('s-' \+ k\), ctx\);/);
  for (const k of ['start', 'chain', 'seed', 'owner', 'reach', 'service', 'lightning', 'federation', 'promise', 'bond', 'done']) assert.ok(html.includes(`<section id="s-${k}"></section>`), `${k}: an empty section for React`);
  for (const gone of ['ArenaWizard ||', '!reactStep', '!reactRoles', "$('b-check').onclick", "$('seed-show').onclick", 'function watchSync', 'roles-save', 'class="rc"', 'innerHTML', 'const esc']) assert.ok(!html.includes(gone), gone);
});

// A NODE RUN BY ITS NSEC, END TO END (kanban #653, 2026-10-25: "The node must also operate on its own with the nsec" - "That means
// signing etc"): the running seat's identity is the Nostr key, setup logs the owner in with it, and the seat says its seed is Nostr's
test('a node set up with an nsec runs on it: the seat signs as the Nostr key, its owner is that key, and setup logs in without asking again', async (t) => {
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
  const fetcher = (url, o) => (/bitcoin-?arena\.io/.test(String(url)) ? Promise.resolve(new Response(JSON.stringify(/daily\.json$/.test(String(url))
    ? { testnet: { node: ['https://a.example', 'https://b.example'] } } : { network: { installMinimumBondSats: 50000, band: 'CALM' } }), { status: 200 }))
    : /\.example\/capacity$/.test(String(url)) ? Promise.resolve(new Response(JSON.stringify({ network: { installMinimumBondSats: 50000, band: 'CALM' } }), { status: 200 })) : fetch(url, o));
  // THE PROGRESS WHILE IT RUNS (kanban #651): read through the page's own door once the services are in and the seat is awaited
  const progressInstall = (o) => directInstall(children)(o);
  const wizard = createWizard({ state, release: RELEASE, seatPort, reach, chainKit, fetcher, test: (c) => testConnection(c, { probe, list: [{ host: 'second', port: 1 }] }), install: progressInstall, lndKit, gwKit,
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

  const { newNsec } = await import('../src/seed.js');
  const key = newNsec();
  const st0 = (await c.post('/api/start', { control: 'nostr', action: 'new', nsec: key.nsec })).json;
  assert.equal(st0.ok, true, st0.why);
  assert.equal((await c.post('/api/chain/save', { kind: 'core', url: btc.url, cookiePath })).json.ok, true);
  assert.equal((await c.post('/api/roles', { roles: ['verify', 'settlement'] })).json.ok, true);
  assert.equal((await c.post('/api/apps', { apps: ['nextblock', 'rock-paper-scissors'] })).json.ok, true);
  assert.equal((await c.get('/api/state')).json.step, 'emergency', 'no seed or owner step: the nsec gave both; the emergency code next (kanban #647)');
  assert.match((await c.get('/api/emergency')).json.code, /^ARN-/);
  assert.equal((await c.post('/api/emergency/written')).json.ok, true);
  assert.equal((await c.get('/api/state')).json.step, 'reach');
  assert.equal((await c.post('/api/reach/direct', { port: seatPort })).json.result.reached, true);
  assert.equal((await c.post('/api/reach/save', { mode: 'direct' })).json.ok, true);
  const svc = (await c.post('/api/service', { boot: true })).json;
  assert.equal(svc.ok, true, svc.why);
  assert.equal(svc.identity, key.pubkey, 'the running seat signs as the Nostr key');
  assert.equal(svc.login && svc.login.ok, true, 'setup logged the owner in with the node\'s own key');
  assert.equal(svc.template, null, 'nothing to sign in the browser');
  const os = await (await fetch(`http://127.0.0.1:${seatPort}/owner`)).json();
  assert.deepEqual([os.owner, os.nostrSeed], [key.pubkey, true], 'the seat: owned by the Nostr key, its seed from it');
  // the seat signs on its own: its /identity is the Nostr key
  const id = Buffer.from(await (await fetch(`http://127.0.0.1:${seatPort}/identity`)).arrayBuffer()).toString('hex');
  assert.equal(id.slice(-64), key.pubkey);
});

// NEW OR RESTORED (kanban #652, 2026-10-25: "neuer step im installer: New/Restore"): the first step; a restore writes the typed
// words' seed and skips the seed step, a wrong word is refused by name, a node with other words keeps its own
test('the first step: a new node goes on to the seed step, a restore takes the 24 words as its seed (kanban #652)', async () => {
  const { newSeed, ownerKeyOf } = await import('../src/seed.js');
  const run = async (fn) => {
    const home = mkdtempSync(join(tmpdir(), 'arena-install-'));
    const w = createWizard({ state: nodeState(home), release: RELEASE, seatPort: 1 });
    const server = http.createServer((q, s) => w.handle(q, s));
    try {
      await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
      const c = client(server.address().port);
      await c.get(`/?t=${w.token}`);
      await fn(c, nodeState(home));
    } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
  };
  await run(async (c) => {
    assert.equal((await c.get('/api/state')).json.step, 'start', 'the first step');
    assert.deepEqual((await c.post('/api/start', { control: 'words', action: 'new' })).json, { ok: true, control: 'words', origin: 'new' });
    const st = (await c.get('/api/state')).json;
    assert.deepEqual([st.step, st.origin, !!st.done.seed], ['chain', 'new', false], 'a new node: on to Bitcoin, its words come at the seed step');
  });
  const old = newSeed();
  await run(async (c, state) => {
    assert.match((await c.post('/api/start', { mode: 'restore', words: old.words.slice(0, 23).join(' ') })).json.why, /all 24 words.*23 typed/);
    const wrong = [...old.words]; wrong[4] = 'bitcoinx';
    assert.equal((await c.post('/api/start', { mode: 'restore', words: wrong.join(' ') })).json.ok, false, 'a word not in the list');
    const r = (await c.post('/api/start', { mode: 'restore', words: `  ${old.words.join('  ').toUpperCase()} ` })).json;
    assert.deepEqual([r.ok, r.control, r.origin, r.ownerPubkey], [true, 'words', 'restore', ownerKeyOf(old.seed).pubkey], 'case and spaces do not count');
    assert.match(r.emergencyCode, /^ARN-/, 'the emergency code shown again, to write down');
    assert.equal(state.readSecret('seed.hex').trim(), Buffer.from(old.seed).toString('hex'), 'the old seed, written');
    const st = (await c.get('/api/state')).json;
    assert.deepEqual([st.origin, !!st.done.start, !!st.done.seed], ['restore', true, true], 'the seed step is done');
    assert.equal((await c.post('/api/seed/new')).json.ok, false, 'no new words over restored ones');
    assert.equal((await c.post('/api/start', { mode: 'restore', words: newSeed().words.join(' ') })).json.why, 'this node has other words already: set up another node folder for that');
    assert.equal((await c.post('/api/start', { mode: 'restore', words: old.words.join(' ') })).json.ok, true, 'the same words again: fine');
  });
  // NOSTR (kanban #653/#654, "Only allow nsec then"): the nsec gives the seed, the owner is that key; the same nsec gives the same node
  const { newNsec, seedOfNsec } = await import('../src/seed.js');
  const key = newNsec();
  let first = null;
  for (const action of ['new', 'restore']) {
    await run(async (c, state) => {
      assert.equal((await c.post('/api/start', { control: 'nostr', action, nsec: 'npub1xyz' })).json.why, 'that is not an nsec (it starts with nsec1)');
      const r = (await c.post('/api/start', { control: 'nostr', action, nsec: ` ${key.nsec} ` })).json;
      assert.deepEqual([r.ok, r.control, r.origin, r.ownerPubkey], [true, 'nostr', action, key.pubkey], r.why);
      const seedHex = state.readSecret('seed.hex').trim();
      assert.equal(seedHex, Buffer.from(seedOfNsec(key.nsec).seed).toString('hex'));
      assert.notEqual(seedHex, Buffer.from(seedOfNsec(key.nsec).secret).toString('hex'), 'the seed is not the nsec');
      { const { openStore, nodeIdentity } = await import('../../arena-node/src/store.js'); const db = openStore(state.path('node.db'));
        assert.equal(Buffer.from(nodeIdentity(db).pubkey).toString('hex'), key.pubkey, 'the node runs on the nsec: its identity is the Nostr key'); db.close(); }
      first = first || seedHex;
      assert.equal(seedHex, first, `${action}: the same node from the same nsec`);
      const st = (await c.get('/api/state')).json;
      assert.deepEqual([st.control, !!st.done.seed, !!st.done.owner, st.step], ['nostr', true, true, 'chain'], 'the seed and owner steps are done');
      assert.equal(JSON.parse(readFileSync(state.path('node.db.owner.json'), 'utf8')).pubkey, key.pubkey, 'the Nostr key owns the node');
      assert.equal((await c.post('/api/start', { control: 'nostr', action, nsec: newNsec().nsec })).json.ok, false, 'another nsec on this folder: refused');
    });
  }
  await run(async (c) => {
    const k = (await c.post('/api/start/nsec')).json;
    assert.match(k.nsec, /^nsec1[02-9ac-hj-np-z]{58}$/, 'a new Nostr key for someone who has none');
  });
});

// THE NODE IDENTITY FROM THE SEED (kanban #650/#653): adopted into a new store, kept in one that has its own
test('a new node\'s identity is the key its seed gives; a node that has one keeps it', async () => {
  const { openStore, adoptIdentity, nodeIdentity } = await import('../../arena-node/src/store.js');
  const { newSeed, nodeKeyOf } = await import('../src/seed.js');
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const seed = newSeed().seed, key = nodeKeyOf(seed);
  const db = openStore(':memory:');
  assert.equal(adoptIdentity(db, key), true);
  assert.deepEqual([...nodeIdentity(db).pubkey], [...schnorr.getPublicKey(key)], 'the node signs with the seed\'s key');
  assert.equal(adoptIdentity(db, key), true, 'the same key again: still its own');
  const other = openStore(':memory:'); nodeIdentity(other);
  assert.equal(adoptIdentity(other, key), false, 'an identity there already: kept');
});

// HOW MANY NODES FROM THE INTRO (kanban #596): POST /api/instances checked and kept; the state says it back
test('the intro\'s count of nodes and the RAM disk choice are checked and kept (kanban #596)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arena-install-'));
  const w = createWizard({ state: nodeState(home), release: RELEASE, seatPort: 1 });
  const server = http.createServer((q, s) => w.handle(q, s));
  // closed whatever happens: an assertion that fails with the server open kept the whole file running until its timeout
  try {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const c = client(server.address().port);
    await c.get(`/?t=${w.token}`);
    const pick = (x) => ({ count: x.count, ram: x.ram });
    assert.deepEqual((await c.get('/api/state')).json.instances, { count: 1, ram: false }, 'one node unless chosen');
    assert.match((await c.post('/api/instances', { count: 25 })).json.why, /from 1 to 20/);
    const ten = (await c.post('/api/instances', { count: 10, ram: true, name: 'mac-mini' })).json;
    assert.deepEqual([ten.ok, pick(ten.instances), ten.instances.name], [true, { count: 10, ram: true }, 'mac-mini'], 'the machine\'s name kept with the count (kanban #621)');
    assert.match(ten.note, /10 or more nodes found their own federation/);
    const st = (await c.get('/api/state')).json.instances;
    assert.deepEqual([pick(st), st.first], [{ count: 10, ram: true }, { instance: '', portOffset: 0 }], 'node 1\'s name and ports kept beside the count');
    assert.deepEqual(pick((await c.post('/api/instances', { count: 7, ram: false })).json.instances), { count: 7, ram: false }, 'declined');
    const kept = nodeState(home).read().instances;
    assert.deepEqual([pick(kept), kept.first], [{ count: 7, ram: false }, { instance: '', portOffset: 0 }], 'kept on disk');
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
});

// ONE DEPOSIT FOR ALL NODES (kanban #596, 2026-10-23: "nur 1 Bond einzahlen, das wird automatisch multipliziert und aus N Instanzen
// auf gesplittet"): node 1 asks for every node's deposit, each further node's bond step is paid from node 1's wallet - once
test('one deposit for all nodes: node 1 asks for N parts, a further node is paid from node 1\'s wallet once (kanban #596)', async () => {
  const { withOtherNodes, SPLIT_FEE_SATS } = await import('../src/wizard.js');
  const { walletOf } = await import('../src/wallet.js');
  const toHex = (u) => Buffer.from(u).toString('hex');
  const parts = { bond: 50000, fees: 2000 };
  assert.deepEqual(withOtherNodes({ instances: { count: 3 } }, parts), { bond: 50000, fees: 2000, otherNodes: 2 * (52000 + SPLIT_FEE_SATS) });
  assert.deepEqual(withOtherNodes({ instances: { count: 3 } }, parts, { further: true }), parts, 'a further node asks for its own part only');
  assert.deepEqual(withOtherNodes({}, parts), parts, 'one node');
  const root = mkdtempSync(join(tmpdir(), 'arena-multi-'));
  try {
    const base = nodeState(join(root, 'a')), b = nodeState(join(root, 'b'));
    base.writeSecret('seed.hex', 'aa'.repeat(32)); b.writeSecret('seed.hex', 'bb'.repeat(32));
    base.save({ instances: { count: 3, ram: false } });
    b.save({ instances: { count: 3, ram: false }, roles: ['verify'], chain: { kind: 'core', url: 'http://x/' }, done: { chain: 1, roles: 1, apps: 1, seed: 1, owner: 1, reach: 1, service: 1 } });
    const baseSpk = toHex(walletOf(Buffer.from('aa'.repeat(32), 'hex')).spk);
    const sent = [];
    const chainKit = { coinsOf: async (chain, spk) => ({ tip: 157430, coins: toHex(spk) === baseSpk ? [{ txid: 'cd'.repeat(32), vout: 1, sats: 300000, height: 157420 }] : [] }),
      // the txid a node answers is the transaction's own (the payment is written, with it, before it is sent: kanban #1165)
      broadcast: async (chain, hex) => { sent.push(hex); return txidOfHex(hex); } };
    const { txidOfHex } = await import('../src/onchain-action.js');
    const w = createWizard({ state: b, release: RELEASE, seatPort: 1, chainKit, fundFrom: base, fetcher: async () => { throw new Error('offline'); } });
    const server = http.createServer((q, s) => w.handle(q, s));
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const c = client(server.address().port);
    await c.get(`/?t=${w.token}`);
    const r = (await c.post('/api/bond/check', {})).json;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.parts.otherNodes, undefined, 'node b asks for its own part only');
    assert.deepEqual([r.fundedFrom.txid, r.fundedFrom.sats], [txidOfHex(sent[0]), r.needSats], 'paid from node 1\'s wallet');
    assert.equal(sent.length, 1);
    const again = (await c.post('/api/bond/check', {})).json;
    assert.equal(sent.length, 1, 'paid once, not at every check');
    assert.equal(again.fundedFrom.txid, txidOfHex(sent[0]));
    server.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// TESTCOINS, AUTOMATICALLY (kanban #635, 2026-10-25: "Automatisch oder geführt an testcoins"): the Arena faucet is asked for what
// the bond step still lacks, at the node's own address; its no comes back with the guided way named
test('the faucet door asks for exactly what is missing, nothing when enough is there, and says the guided way when the faucet refuses', async () => {
  const { FAUCET_URL } = await import('../src/wizard.js');
  const root = mkdtempSync(join(tmpdir(), 'arena-faucet-'));
  try {
    const st = nodeState(join(root, 'n'));
    st.writeSecret('seed.hex', 'cc'.repeat(32));
    st.save({ roles: ['verify'], chain: { kind: 'core', url: 'http://x/' }, done: { chain: 1, roles: 1, apps: 1, seed: 1, owner: 1, reach: 1, service: 1 } });
    let have = 0; const asked = []; let faucetSays = null;
    const chainKit = { coinsOf: async () => ({ tip: 157544, coins: have ? [{ txid: 'ab'.repeat(32), vout: 0, sats: have, height: 0 }] : [] }), broadcast: async () => 'ef'.repeat(32) };
    const fetcher = async (url, init) => {
      if (url !== FAUCET_URL) throw new Error('offline');
      asked.push(JSON.parse(init.body));
      return new Response(JSON.stringify(faucetSays || { ok: true, txid: '12'.repeat(32), sats: asked.at(-1).sats }));
    };
    const w = createWizard({ state: st, release: RELEASE, seatPort: 1, chainKit, fetcher });
    const need = (await w['POST /api/bond/check']({})).needSats;
    have = 10000;
    const r = await w['POST /api/coins/auto']({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(asked[0].sats, need - 10000, 'only what is missing');
    assert.match(asked[0].address, /^tb1p/, 'the node\'s own address');
    assert.equal(st.read().faucet.txid, '12'.repeat(32));
    have = need;
    assert.equal((await w['POST /api/coins/auto']({})).already, true); assert.equal(asked.length, 1, 'enough: the faucet is not asked');
    have = 0; faucetSays = { ok: false, why: 'this address got coins from the faucet already' };
    const no = await w['POST /api/coins/auto']({});
    assert.deepEqual([no.ok, no.guided], [false, true]); assert.match(no.why, /already/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A NOSTR OWNER LOGS IN WITH THE NSEC ALONE (kanban #653): the event setup signs with it passes the node's own owner check
test('an owner login event signed with the nsec passes the node\'s owner check; another key does not', async () => {
  const { newNsec, seedOfNsec, signNostrEvent } = await import('../src/seed.js');
  const { createOwner, ownerEventTemplate } = await import('../../arena-node/src/owner.js');
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const key = newNsec(), node = 'ab'.repeat(32);
  const owner = createOwner({ store: { read: () => ({ pubkey: key.pubkey, claimedAtMs: 1 }), write: () => {}, writeCode: () => {} }, verify: (sig, m, k) => schnorr.verify(sig, m, k), node });
  const login = (nsec) => owner.authorize({ action: 'login', args: {}, nostr: signNostrEvent(ownerEventTemplate({ node, action: 'login' }), seedOfNsec(nsec).secret) }, 'login');
  const ok = login(key.nsec);
  assert.deepEqual([ok.ok, ok.pubkey], [true, key.pubkey], ok.why);
  assert.equal(login(newNsec().nsec).ok, false, 'another Nostr key is not the owner');
  // the owner page signed in with the nsec makes the emergency code the installer showed (owner.html: the node says nostrSeed)
  const seeded = createOwner({ store: { read: () => ({ pubkey: key.pubkey, claimedAtMs: 1, nostrSeed: true }), write: () => {}, writeCode: () => {} }, verify: () => true, node });
  assert.deepEqual([seeded.state().nostrSeed, owner.state().nostrSeed], [true, false]);
  const { nodeSeedFromNsecSecret } = await import('../../arena-node/src/owner.js');
  const { emergencyOf } = await import('../src/seed.js');
  assert.equal(emergencyOf(nodeSeedFromNsecSecret(seedOfNsec(key.nsec).secret)).code, emergencyOf(seedOfNsec(key.nsec).seed).code);
});

// AN ELECTRUM SERVER THAT FAILS AT THE SAVE (kanban #638, the owner's playtest: "sometimes the selected electrum node fails after selecting but
// before moving to the next stage"): asked again, then the next known server is saved, and the next step says so
test('saving an Electrum server that has just failed saves the next known one that answers, and says so', async () => {
  const { TESTNET4_ELECTRUM } = await import('../src/chain-test.js');
  const home = mkdtempSync(join(tmpdir(), 'arena-install-'));
  const asked = [];
  const test2 = async (c) => { asked.push(`${c.host}:${c.port}`); return c.host === TESTNET4_ELECTRUM[0].host ? { ok: false, why: 'timed out' } : { ok: true, why: 'ok', source: { latencyMs: 5, height: 157600 } }; };
  const w = createWizard({ state: nodeState(home), release: RELEASE, seatPort: 1, test: test2 });
  const server = http.createServer((q, s) => w.handle(q, s));
  try {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const c = client(server.address().port);
    await c.get(`/?t=${w.token}`);
    const first = TESTNET4_ELECTRUM[0];
    const r = (await c.post('/api/chain/save', { kind: 'electrum', host: first.host, port: first.port, tls: first.tls })).json;
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(asked.slice(0, 3), [`${first.host}:${first.port}`, `${first.host}:${first.port}`, `${TESTNET4_ELECTRUM[1].host}:${TESTNET4_ELECTRUM[1].port}`], 'asked twice, then the next');
    const st = (await c.get('/api/state')).json;
    assert.deepEqual([st.chain.host, st.chain.port], [TESTNET4_ELECTRUM[1].host, TESTNET4_ELECTRUM[1].port]);
    assert.match(st.chainSwitchedFrom, new RegExp(`${first.host}:${first.port} \\(timed out\\)`));
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
});

// THE ROLES CHECKED AS THEY ARE SWITCHED ON (kanban #641), AND THE EMERGENCY CODE'S OWN STEP (kanban #647)
test('custody on an Electrum node is refused as it is switched on; the emergency code is its own step after the words', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arena-install-'));
  const state = nodeState(home);
  const w = createWizard({ state, release: RELEASE, seatPort: 1, test: async () => ({ ok: true, why: 'ok', source: { latencyMs: 1, height: 1 } }) });
  const server = http.createServer((q, s) => w.handle(q, s));
  try {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const c = client(server.address().port);
    await c.get(`/?t=${w.token}`);
    assert.equal((await c.post('/api/chain/save', { kind: 'electrum', host: 'e.example', port: 1 })).json.ok, true);
    assert.match((await c.post('/api/roles/check', { roles: ['verify', 'custody'] })).json.why, /custody needs your own Bitcoin Core/);
    assert.deepEqual((await c.post('/api/roles/check', { roles: ['verify', 'settlement'] })).json, { ok: true });
    assert.equal(state.read().roles, undefined, 'a check saves nothing');
    const { newSeed } = await import('../src/seed.js');
    assert.equal((await c.post('/api/start', { control: 'words', action: 'restore', words: newSeed().words.join(' ') })).json.ok, true);
    assert.equal((await c.post('/api/roles', { roles: ['verify'] })).json.ok, true);
    const st = (await c.get('/api/state')).json;
    assert.deepEqual([st.step, !!st.done.apps, !!st.done.seed], ['apps', false, true], 'restored words: the apps are still to choose (walk of 9a863f31)');
    assert.equal((await c.post('/api/apps', { apps: st.appInfo.map((a) => a.id) })).json.ok, true);
    assert.equal((await c.get('/api/state')).json.step, 'emergency', 'after the words: the emergency code');
    assert.equal((await c.post('/api/emergency/written')).json.ok, true);
    assert.equal((await c.get('/api/state')).json.step, 'reach', 'the restored words own the node: no owner step (kanban #648)');
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
});

// THE OWNER'S KEY FOR THE BROWSER (playtest 2026-10-25: "Der Installer soll sich mit meiner Seed schon einloggen"): to this setup's session,
// the seed of a words owner, the node's nsec of a Nostr node; the node's dashboard takes it from the Done page's tab, window to window
test('the owner key handed to the dashboard: the seed for a words owner, the nsec for a Nostr node; the dashboard keeps it for the owner page', async () => {
  const { newSeed, newNsec, seedOfNsec } = await import('../src/seed.js');
  for (const control of ['words', 'nostr']) {
    const home = mkdtempSync(join(tmpdir(), 'arena-install-'));
    const w = createWizard({ state: nodeState(home), release: RELEASE, seatPort: 1 });
    const server = http.createServer((q, s) => w.handle(q, s));
    try {
      await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
      const c = client(server.address().port);
      await c.get(`/?t=${w.token}`);
      if (control === 'words') {
        const words = newSeed().words;
        assert.equal((await c.post('/api/start', { control, action: 'restore', words: words.join(' ') })).json.ok, true);
        assert.equal((await c.post('/api/owner', { mode: 'seed' })).json.ok, true);
        const h = (await c.get('/api/owner/handoff')).json;
        assert.deepEqual([h.ok, h.kind, h.seed], [true, 'seed', nodeState(home).readSecret('seed.hex').trim()]);
      } else {
        const k = newNsec();
        assert.equal((await c.post('/api/start', { control, action: 'new', nsec: k.nsec })).json.ok, true);
        const h = (await c.get('/api/owner/handoff')).json;
        assert.deepEqual([h.ok, h.kind, h.secret], [true, 'nsec', Buffer.from(seedOfNsec(k.nsec).secret).toString('hex')]);
      }
    } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
  }
  const { dashboardHtml } = await import('../../arena-node/src/dashboard.js');
  const page = typeof dashboardHtml === 'function' ? dashboardHtml() : dashboardHtml;
  assert.match(page, /location\.hash==='#owner-handoff'&&window\.opener/);
  assert.match(page, /localStorage\.setItem\('arena-owner-seed:'\+base,d\.seed\)/, 'where owner.html reads it (STORE)');
  assert.match(page, /e\.source!==window\.opener/, 'only from the tab that opened it');
});
