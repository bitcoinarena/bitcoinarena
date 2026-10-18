// THE INSTALLER, FRESH, THROUGH ITS API (kanban #471 slice 1, F.1): the wizard's doors in order against a real seat process - started from
// the settings the wizard wrote, on a fake testnet4 bitcoind that serves block 0 - and the owner login the running seat checks itself.
// And the guards: the token works once, a foreign Host or a missing header is refused, the seed is asked back, the genesis decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWizard } from '../src/wizard.js';
import { nodeState, seatEnv } from '../src/state.js';
import { waitHealthy, seatUnit } from '../src/service.js';
import { probeCore, probeElectrum, tipsAgree, agreeHeights, TESTNET4_GENESIS, headerHash, testConnection } from '../src/chain-test.js';
import { quickTunnelName } from '../src/tunnel.js';
import * as reachKit from '../src/reach.js';
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

// THE SERVICE, WITHOUT SYSTEMD: the seat started from the unit's own command line and the env file the wizard wrote
function directInstall(children) {
  return async ({ release, home, port }) => {
    const env = { PATH: process.env.PATH, HOME: home };
    for (const l of readFileSync(join(home, 'node.env'), 'utf8').split('\n')) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l); if (m) env[m[1]] = m[2]; }
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
  const reach = { ...reachKit, checkDirect: (o) => reachKit.checkDirect({ ...o, seats: [seat.url, seat.url] }) };
  const wizard = createWizard({ state, release: RELEASE, seatPort, reach, test: (c) => testConnection(c, { probe, list: [{ host: 'second', port: 1 }] }), install: directInstall(children) });
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
  assert.equal((await c.req('POST', '/api/roles', { roles: ['verify'] })).status, 403, 'a POST without x-arena-wizard is refused');

  let s = (await c.get('/api/state')).json;
  assert.equal(s.step, 'chain');
  const bad = (await c.post('/api/chain/save', { kind: 'core', url: btc.url.replace(/\d+\/$/, '1/'), cookiePath })).json;
  assert.equal(bad.ok, false, 'nothing answers there: not saved');
  const saved = (await c.post('/api/chain/save', { kind: 'core', url: btc.url, cookiePath })).json;
  assert.equal(saved.ok, true, saved.why);
  assert.equal(saved.result.source.genesis, TESTNET4_GENESIS);

  assert.equal((await c.post('/api/roles', { roles: ['custody'] })).json.ok, false, 'custody is a later slice');
  assert.equal((await c.post('/api/roles', { roles: ['verify', 'settlement'] })).json.ok, true);

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
  const env = readFileSync(join(home, 'node.env'), 'utf8');
  assert.equal(env.includes(`ARENA_BITCOIND_URL=${btc.url}`), true);
  assert.equal(env.includes('ARENA_BIND=0.0.0.0'), true, 'a direct node listens on every interface');
  assert.equal(env.includes(`ARENA_WSS_${seatPort}=http://127.0.0.1:${seatPort}`), true, 'and names its public address');
  assert.equal(statSync(join(home, 'node.env')).mode & 0o777, 0o600);
  // a stranger's key is not the owner: the seat itself refuses it (proof the binding is the seat's, not the wizard's)
  const { signOwnerRequest } = await import('../../arena-node/src/owner.js');
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const stranger = signOwnerRequest({ node: svc.identity, action: 'login', secret: schnorr.utils.randomSecretKey(), sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
  const refused = await fetch(`http://127.0.0.1:${seatPort}/owner/login`, { method: 'POST', body: JSON.stringify(stranger) });
  assert.equal(refused.status, 403);
  assert.equal(statSync(join(home, 'node.db')).isFile(), true);

  s = (await c.get('/api/state')).json;
  assert.equal(s.step, 'done');
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
    assert.equal(s.step, 'seed');
    assert.equal(statSync(home).mode & 0o777, 0o700);
    const env = seatEnv({ ...a.read(), port: 7801 }, { home, release: '/opt/arena' });
    assert.match(env, /ARENA_BITCOIND_URL=http:\/\/x\//);
    assert.match(env, /ARENA_GAMES=\/opt\/arena\/packages\/nextblock\/plugin\/nextblock.js/);
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
