// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FAUCET, THE FEEDBACK AND THE BOUNTY, END TO END (kanban #2642): packages/arena-node/tools/faucet.mjs run here against the private regtest
// devnet, and the page's feedback / My feedback / welcome driven in the real page in headless Chrome.
//
// What the suite puts around the faucet (each listed in the service flow's evidence):
//   - its own bitcoind wallet `faucet-e2e` on the devnet bitcoind, funded from wallet devnet;
//   - an RPC proxy (front port + 3): the faucet pays testnet4 addresses only (tb1); the proxy hands bitcoind the same witness program as bcrt1 and
//     gives the wallet's answers back as tb1 (e2e/lib/bech32-hrp.mjs) - real regtest coins move;
//   - e2e/bin/lncli-regtest as FAUCET_LNCLI / FAUCET_BOUNTY_LNCLI: --network=regtest, lntb arguments back to lnbcrt (the same signed invoice);
//   - a front proxy at ctx.faucetUrl (the page's /api/faucet goes there) that hands POST /player's lnbcrt invoice to the faucet as lntb; all else as is;
//   - a chat stub (front port + 2) in place of Arena Chat: every post a report makes is counted, nothing leaves the machine;
//   - FAUCET_BOUNTY_TG_USERBOT=off, no X / Discord / Telegram / Armada config, HOME in the run's own directory, no inherited FAUCET_* variable.
// The faucet itself listens on front port + 1. Its book, feedback DB, Season 2 DB and logs are in <E2E_FAUCET_DIR or ~/wf1489/e2e-2642/faucet>/run-<time>/.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Skip, wait, check, getJson, post } from '../lib/ctx.mjs';
import { regtestToTestnetAddress, testnetToRegtestAddress, regtestToTestnetInvoice } from '../lib/bech32-hrp.mjs';

const sha256 = (x) => createHash('sha256').update(x).digest('hex');
const hex = (b) => Buffer.from(b).toString('hex');
const F = (ctx) => { const f = ctx.shared.faucet; if (!f || !f.up) throw new Error('the faucet service is not up (faucet.service-up failed or was not run)'); return f; };
const SVC = 'faucet.service-up';

// ---- NOSTR, AS THE PAGE SIGNS (kind 27842 reports, kind 27235 NIP-98 sign-ins) ----
let noble = null;
async function curve(ctx) {
  if (!noble) noble = await import(pathToFileURL(join(ctx.root, 'packages/arena-node/node_modules/@noble/curves/secp256k1.js')).href);
  return noble.schnorr;
}
async function newKey(ctx) {
  const s = await curve(ctx);
  const sk = s.utils.randomSecretKey ? s.utils.randomSecretKey() : s.utils.randomPrivateKey();
  return { sk, pk: hex(s.getPublicKey(sk)) };
}
async function signEv(ctx, key, { kind, tags = [], content = '', created_at = Math.floor(Date.now() / 1000) }) {
  const s = await curve(ctx);
  const e = { pubkey: key.pk, created_at, kind, tags, content };
  e.id = sha256(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]));
  e.sig = hex(s.sign(Buffer.from(e.id, 'hex'), key.sk));
  return e;
}
const words = (marker, n = 0) => `E2E #2642 ${marker}: the order strip froze after I pressed Play and the balance stayed the same for a minute (${n}).`;
const report = (ctx, key, { marker, type = 'bug', extraTags = [], body = {}, created_at } = {}) =>
  signEv(ctx, key, { kind: 27842, created_at, tags: [['t', type], ['source', 'frontend'], ['build', 'e2e-2642'], ...extraTags], content: JSON.stringify({ happened: words(marker), expected: 'the round to start', ...body }) });
const nip98 = async (ctx, key, url, method = 'GET', created_at) => `Nostr ${Buffer.from(JSON.stringify(await signEv(ctx, key, { kind: 27235, tags: [['u', url], ['method', method]], created_at }))).toString('base64')}`;

// ---- THE DEVNET BITCOIND, ANY WALLET ----
async function rpcOn(dn, wallet, method, params = []) {
  const auth = Buffer.from(readFileSync(dn.cookie, 'utf8').trim()).toString('base64');
  const r = await fetch(`${dn.rpcUrl}${wallet ? `/wallet/${wallet}` : ''}`, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'e2e', method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => null);
  if (!j || j.error) throw new Error(`bitcoind ${method}: ${(j && j.error && j.error.message) || r.status}`);
  return j.result;
}

// ---- THE SUITE'S STAND-INS AROUND THE FAUCET ----
function listen(server, port) { return new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => ok(server)); }); }
function chatStub(port, log) {
  const posts = [];
  const s = createServer((rq, rs) => {
    let b = ''; rq.setEncoding('utf8'); rq.on('data', (c) => { b += c; }); rq.on('end', () => {
      let text = ''; try { text = JSON.parse(b).text || ''; } catch { text = ''; }
      posts.push({ at: Date.now(), path: rq.url, auth: !!rq.headers.authorization, text });
      try { appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), path: rq.url, text: text.slice(0, 2000) })}\n`); } catch { /* a log only */ }
      rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{"ok":true}');
    });
  });
  return listen(s, port).then(() => ({ server: s, posts }));
}
const mapStrings = (v, f) => (typeof v === 'string' ? f(v) : Array.isArray(v) ? v.map((x) => mapStrings(x, f)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)])) : v);
function rpcProxy(port, target, notes) {
  const s = createServer((rq, rs) => {
    const parts = []; rq.on('data', (c) => parts.push(c)); rq.on('end', () => {
      let body = Buffer.concat(parts).toString('utf8');
      try { const j = JSON.parse(body); const out = mapStrings(j, (x) => { if (!/^tb1[02-9ac-hj-np-z]{8,87}$/.test(x)) return x; const t = testnetToRegtestAddress(x); if (t !== x) notes.push(`${j.method}: ${x.slice(0, 14)}… -> bcrt1`); return t; }); body = JSON.stringify(out); } catch { /* not JSON: as it is */ }
      const p = httpRequest(new URL(rq.url, target), { method: rq.method, headers: { ...rq.headers, host: new URL(target).host, 'content-length': Buffer.byteLength(body) } }, (r) => {
        const back = []; r.on('data', (c) => back.push(c)); r.on('end', () => {
          let t = Buffer.concat(back).toString('utf8');
          try { t = JSON.stringify(mapStrings(JSON.parse(t), (x) => (/^bcrt1[02-9ac-hj-np-z]{8,87}$/.test(x) ? regtestToTestnetAddress(x) : x))); } catch { /* as it is */ }
          const h = { ...r.headers }; delete h['content-length']; delete h['transfer-encoding'];
          rs.writeHead(r.statusCode, { ...h, 'content-length': Buffer.byteLength(t) }); rs.end(t);
        });
      });
      p.on('error', (e) => { rs.writeHead(502); rs.end(String(e.message)); });
      p.end(body);
    });
  });
  return listen(s, port);
}
function frontProxy(port, inner, notes) {
  const s = createServer((rq, rs) => {
    const path = new URL(rq.url, 'http://x').pathname.replace(/\/+$/, '');
    const forward = (body) => {
      const headers = { ...rq.headers, host: `127.0.0.1:${inner}` };
      if (body !== null) headers['content-length'] = Buffer.byteLength(body);
      const p = httpRequest({ host: '127.0.0.1', port: inner, path: rq.url, method: rq.method, headers }, (r) => { rs.writeHead(r.statusCode, r.headers); r.pipe(rs); });
      p.on('error', (e) => { rs.writeHead(502, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ ok: false, why: `e2e front proxy: ${e.message}` })); });
      if (body !== null) p.end(body); else rq.pipe(p);
    };
    if (rq.method === 'POST' && (path === '/player' || path === '/faucet/player')) {
      const parts = []; let n = 0;
      rq.on('data', (c) => { n += c.length; if (n < 65536) parts.push(c); });
      rq.on('end', () => {
        let body = Buffer.concat(parts).toString('utf8');
        try { const j = JSON.parse(body); if (j && typeof j.invoice === 'string' && /^lnbcrt/i.test(j.invoice)) { const t = regtestToTestnetInvoice(j.invoice); if (t !== j.invoice) { notes.push({ at: Date.now(), kind: j.kind, invoice: `${j.invoice.slice(0, 16)}… -> lntb` }); j.invoice = t; body = JSON.stringify(j); } } } catch { /* as it is */ }
        forward(body);
      });
      return;
    }
    forward(null);
  });
  return listen(s, port);
}
const portFree = (port) => new Promise((ok) => { const s = createServer(); s.once('error', () => ok(false)); s.listen(port, '127.0.0.1', () => s.close(() => ok(true))); });

// ---- THE SERVICE ----
async function serviceUp(ctx) {
  const { dn } = ctx;
  const front = Number(new URL(ctx.faucetUrl).port);
  const inner = front + 1, chatPort = front + 2, rpcPort = front + 3;
  for (const p of [front, inner, chatPort, rpcPort]) check(p >= 13011 && p <= 13019, `the faucet's ports stay in 13011-13019 (E2E_FAUCET_PORT ${front}: front, +1 faucet, +2 chat stub, +3 RPC proxy)`, p);
  const base = ctx.env.E2E_FAUCET_DIR || join(homedir(), 'wf1489', 'e2e-2642', 'faucet');
  mkdirSync(base, { recursive: true });
  // a faucet a killed run left on our port is ours by its pid file: stopped (never another process)
  const pidFile = join(base, `faucet-${inner}.pid`);
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    let cmd = ''; try { cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }); } catch { cmd = ''; }
    if (pid > 1 && /tools\/faucet\.mjs/.test(cmd)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } await wait(1500); }
  }
  for (const p of [front, inner, chatPort, rpcPort]) if (!(await portFree(p))) throw new Error(`port ${p} is taken by another process: the faucet flows need ${front}-${rpcPort} (set E2E_FAUCET_PORT)`);
  const run = join(base, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(join(run, 'home'), { recursive: true });
  const toolsNotes = [], rpcNotes = [], frontNotes = [];
  // the wallet and its coins
  const W = 'faucet-e2e';
  const loaded = await rpcOn(dn, null, 'listwallets');
  if (!loaded.includes(W)) { try { await rpcOn(dn, null, 'loadwallet', [W]); } catch { await rpcOn(dn, null, 'createwallet', [W]); } }
  let bal = Number((await rpcOn(dn, W, 'getbalances')).mine.trusted);
  if (bal < 1) {
    const a = await rpcOn(dn, W, 'getnewaddress', ['', 'bech32']);
    dn.cli('sendtoaddress', a, '3');
    dn.mine(1);
    for (let i = 0; i < 20 && bal < 1; i++) { await wait(500); bal = Number((await rpcOn(dn, W, 'getbalances')).mine.trusted); }
  }
  check(bal >= 1, 'the faucet wallet holds at least 1 regtest BTC', bal);
  // the stand-ins
  const chat = await chatStub(chatPort, join(run, 'chat.jsonl'));
  const rpcS = await rpcProxy(rpcPort, dn.rpcUrl, rpcNotes);
  const frontS = await frontProxy(front, inner, frontNotes);
  const adminCode = randomBytes(24).toString('hex');
  writeFileSync(join(run, 'chat-token'), randomBytes(16).toString('hex'));
  writeFileSync(join(run, 'our-keys.txt'), '');
  const lncliWrap = join(ctx.root, 'e2e', 'bin', 'lncli-regtest');
  const pageOrigin = new URL(ctx.pageUrl).origin;
  const S2_START = new Date(Date.now() - 3600000).toISOString();
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: join(run, 'home'), TZ: 'UTC',
    E2E_REAL_LNCLI: join(dn.lndBin, 'lncli'), E2E_DEPS: ctx.env.E2E_DEPS || '', E2E_LNCLI_LOG: join(run, 'lncli.jsonl'),
    FAUCET_PORT: String(inner), FAUCET_RPC_URL: `http://127.0.0.1:${rpcPort}/wallet/${W}`, FAUCET_COOKIE: dn.cookie,
    FAUCET_BOOK: join(run, 'book.json'), FAUCET_PENDING: join(run, 'pending.txt'),
    FAUCET_FEEDBACK_DB: join(run, 'feedback.db'), FAUCET_FEEDBACK_MINE_URLS: `${pageOrigin}/api/faucet/feedback/mine,${ctx.faucetUrl}/feedback/mine`,
    FAUCET_CHAT_URL: `http://127.0.0.1:${chatPort}`, FAUCET_CHAT_CHANNEL: 'e2e-2642', FAUCET_CHAT_TOKEN_FILE: join(run, 'chat-token'),
    FAUCET_ADMIN_SHA256: sha256(adminCode), FAUCET_FEEDBACK_EXCLUDED: join(run, 'our-keys.txt'),
    FAUCET_LNCLI: lncliWrap, FAUCET_PAYERS: `${join(dn.dir, 'lnd-b')}|127.0.0.1:${dn.base + 20},${join(dn.dir, 'lnd-a')}|127.0.0.1:${dn.base + 10}`,   // two payers as live: the page's invoice may sit on b (its gateway's lnd), then a pays it
    FAUCET_BOUNTY_PAYER: `${join(dn.dir, 'lnd-a')}|127.0.0.1:${dn.base + 10}`, FAUCET_BOUNTY_LNCLI: lncliWrap, FAUCET_BOUNTY_NETWORK: 'mainnet',
    FAUCET_BOUNTY_ORIGINS: pageOrigin, FAUCET_PUBLIC_BASE: ctx.faucetUrl,
    FAUCET_SEASON_SEATS: dn.nodes[0], FAUCET_FOUNDING_FILE: join(run, 'founding-feedback.jsonl'), FAUCET_FOUNDING_STATE: join(run, 'founding-state.json'),
    FAUCET_BOUNTY_S2_DB: join(run, 'season2.db'), FAUCET_BOUNTY_S2_START: S2_START, FAUCET_BOUNTY_S2_BASES: `${ctx.faucetUrl}/feedback`, FAUCET_BOUNTY_S2_SWEEP_MS: '600000',
    FAUCET_BOUNTY_TG_USERBOT: 'off', FAUCET_PAY_WAIT_MS: '30000',
  };
  writeFileSync(join(run, 'env.json'), JSON.stringify({ ...env, FAUCET_ADMIN_SHA256: '(sha256 of the run\'s admin code)' }, null, 1));
  const out = join(run, 'faucet.log');
  const child = spawn(process.execPath, [join(ctx.root, 'packages/arena-node/tools/faucet.mjs')], { cwd: run, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => appendFileSync(out, d)); child.stderr.on('data', (d) => appendFileSync(out, d));
  writeFileSync(pidFile, String(child.pid));
  process.on('exit', () => { try { child.kill('SIGTERM'); } catch { /* gone */ } });
  let g = null;
  for (let i = 0; i < 60 && !g; i++) { if (child.exitCode !== null) break; try { g = await getJson(`${ctx.faucetUrl}/faucet`, { ms: 5000 }); } catch { await wait(500); } }
  if (!g) throw new Error(`the faucet did not answer GET /faucet (${child.exitCode !== null ? `exited ${child.exitCode}` : 'still starting'}): ${existsSync(out) ? readFileSync(out, 'utf8').slice(-600) : ''}`);
  check(g.ok && g.balanceSats >= 1e8, 'GET /faucet answers the wallet balance through the RPC proxy', g);
  ctx.shared.faucet = { up: true, url: ctx.faucetUrl, inner: `http://127.0.0.1:${inner}`, run, adminCode, origin: pageOrigin, child, chat: chat.posts, rpcNotes, frontNotes, toolsNotes, servers: [chat.server, rpcS, frontS] };
  return { run, ports: { front, faucet: inner, chat: chatPort, rpc: rpcPort }, balanceSats: g.balanceSats, maxSats: g.maxSats, leftTodaySats: g.leftTodaySats, pid: child.pid,
    standIns: ['RPC proxy tb1<->bcrt1', 'lncli-regtest (--network=regtest, lntb->lnbcrt)', 'front proxy lnbcrt->lntb on POST /player', 'chat stub', 'telegram reader off, no X/Discord/Armada'] };
}

// ---- helpers for the flows ----
const admin = (ctx) => ({ 'x-arena-admin': F(ctx).adminCode });
const adminList = async (ctx, q = '') => (await getJson(`${F(ctx).url}/feedback/admin/list${q}`, { headers: admin(ctx), ms: 60000 })).reports;
const act = (ctx, body) => post(`${F(ctx).url}/feedback/admin/act`, body, { headers: admin(ctx), ms: 120000 });
const sendReport = (ctx, event, extra = {}) => post(`${F(ctx).url}/feedback`, { event, ...extra });
const lnc = (ctx, x, ...a) => ctx.dn.lncli(x, ...a);
const invoiceOf = (ctx, x, sats, memo = 'e2e-2642') => lnc(ctx, x, 'addinvoice', `--amt=${sats}`, `--memo=${memo}`);
const lookup = (ctx, x, rhash) => lnc(ctx, x, 'lookupinvoice', rhash);
const posts = (ctx) => F(ctx).chat.length;
const firstPng = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// ONE LIGHT TAB (the MacBook's load, kanban #2642): the Next Block game's Unity build (*.unityweb) is not loaded - SwiftShader took ~5 cores and
// none of these flows plays a round. The page's own rule then opens the wallet without Unity (unityStartSettled: at most 60 s). https/wss stay blocked.
async function lightTab(ctx, url) {
  const b = await ctx.chrome({ width: 1100, height: 800 });
  const t = await b.tab('about:blank');
  await t.call('Network.setBlockedURLs', { urls: ['https://*', 'wss://*', '*.unityweb', '*nextblock-*.loader.js'] });
  await t.go(url);
  return { b, t };
}

// ---- THE FLOWS ----
async function coins(ctx) {
  const f = F(ctx), dn = ctx.dn;
  const bcrt = await rpcOn(dn, 'devnet', 'getnewaddress', ['', 'bech32']);
  const tb = regtestToTestnetAddress(bcrt);
  check(tb.startsWith('tb1') && tb !== bcrt, 'the address under its testnet4 prefix', tb);
  const before = await getJson(`${f.url}/faucet`);
  const r1 = await post(`${f.url}/faucet`, { address: tb, sats: 100000 });
  check(r1.ok && r1.body.ok && /^[0-9a-f]{64}$/.test(r1.body.txid || ''), 'POST /faucet pays a fresh address', r1);
  dn.mine(1);
  let got = 0; for (let i = 0; i < 20 && got <= 0; i++) { await wait(500); got = Number(dn.cli('getreceivedbyaddress', bcrt, '1')); }
  check(Math.round(got * 1e8) === 100000, 'the devnet wallet received exactly 100,000 sat at that address, mined', got);
  const book = JSON.parse(readFileSync(join(f.run, 'book.json'), 'utf8'));
  const row = (book.paid || []).find((p) => p.address === tb);
  check(row && row.txid === r1.body.txid && !row.pending, 'the book holds the row with its txid, not pending', row);
  check(readFileSync(join(f.run, 'pending.txt'), 'utf8').includes(r1.body.txid), 'the txid is listed in FAUCET_PENDING for the miner');
  const r2 = await post(`${f.url}/faucet`, { address: tb, sats: 1000 });
  check(r2.body && r2.body.ok === false && /already/.test(r2.body.why), 'the same address a second time is refused', r2);
  const r3 = await post(`${f.url}/faucet`, { address: bcrt, sats: 1000 });
  check(r3.body && r3.body.ok === false && /testnet4/.test(r3.body.why), 'a regtest (non-testnet4) address is refused', r3);
  const tb2 = regtestToTestnetAddress(await rpcOn(dn, 'devnet', 'getnewaddress', ['', 'bech32']));
  const r4 = await post(`${f.url}/faucet`, { address: tb2, sats: 1500001 });
  check(r4.body && r4.body.ok === false && /at most/.test(r4.body.why), 'more than FAUCET_MAX_SATS at once is refused', r4);
  const r5 = await post(`${f.url}/faucet`, { address: tb2, sats: 12.5 });
  check(r5.body && r5.body.ok === false && /whole number/.test(r5.body.why), 'a part-sat amount is refused', r5);
  const r6 = await post(`${f.url}/faucet`, '{"address":', { raw: true });
  check(r6.status === 400, 'a body that is no JSON answers 400', r6);
  const after = await getJson(`${f.url}/faucet`);
  check(after.leftTodaySats === before.leftTodaySats - 100000, 'the day cap left drops by the 100,000 paid (the refused asks took nothing)', { before: before.leftTodaySats, after: after.leftTodaySats });
  return { address: tb, txid: r1.body.txid, received: got, refused: { sameAddress: r2.body.why, regtest: r3.body.why, tooMuch: r4.body.why, partSat: r5.body.why }, leftTodaySats: after.leftTodaySats, rpcRewrites: f.rpcNotes.length };
}

async function playerGrant(ctx) {
  const f = F(ctx);
  const account = randomBytes(32).toString('hex');
  // a welcome: an invoice of lnd c (the player's wallet stand-in), paid by the faucet's payer (lnd b) over b -> a -> c
  const inv = invoiceOf(ctx, 'c', 3000, 'e2e welcome');
  const raw = inv.payment_request;
  // straight to the faucet (not through the front proxy): a regtest invoice is no testnet invoice
  const r0 = await post(`${f.inner}/player`, { kind: 'welcome', account, invoice: raw });
  check(r0.body && r0.body.ok === false && /testnet invoice/.test(r0.body.why), 'the faucet itself refuses an lnbcrt invoice (testnet4 only)', r0);
  const t0 = Date.now();
  const r1 = await post(`${f.url}/player`, { kind: 'welcome', account, invoice: raw }, { ms: 90000 });
  check(r1.body && r1.body.ok === true && r1.body.sats === 3000, 'POST /player welcome pays 3,000 sat over Lightning', r1);
  const l1 = lookup(ctx, 'c', inv.r_hash);
  check(l1.state === 'SETTLED' && Number(l1.amt_paid_sat) === 3000, 'lnd c holds the welcome invoice SETTLED for 3,000 sat', { state: l1.state, paid: l1.amt_paid_sat });
  const ms = Date.now() - t0;
  const inv2 = invoiceOf(ctx, 'c', 3000, 'e2e welcome 2');
  const r2 = await post(`${f.url}/player`, { kind: 'welcome', account, invoice: inv2.payment_request }, { ms: 90000 });
  check(r2.body && r2.body.ok === false && /already has its welcome/.test(r2.body.why), 'a second welcome for the same account is refused', r2);
  check(lookup(ctx, 'c', inv2.r_hash).state === 'OPEN', 'and its invoice is not paid');
  const r3 = await post(`${f.url}/player`, { kind: 'welcome', account: randomBytes(32).toString('hex'), invoice: raw }, { ms: 90000 });
  check(r3.body && r3.body.ok === false, 'the paid invoice asked again for another account is refused', r3);
  const inv4 = invoiceOf(ctx, 'c', 2999);
  const r4 = await post(`${f.url}/player`, { kind: 'welcome', account: randomBytes(32).toString('hex'), invoice: inv4.payment_request });
  check(r4.body && r4.body.ok === false && /3000 sat/.test(r4.body.why), 'an invoice of another amount is refused', r4);
  const inv5 = invoiceOf(ctx, 'c', 300, 'e2e topup');
  const r5 = await post(`${f.url}/player`, { kind: 'topup', account, invoice: inv5.payment_request }, { ms: 90000 });
  check(r5.body && r5.body.ok === true && r5.body.sats === 300, 'a top-up of 300 sat is paid', r5);
  check(lookup(ctx, 'c', inv5.r_hash).state === 'SETTLED', 'the top-up invoice is SETTLED');
  const r6 = await post(`${f.url}/player`, { kind: ['welcome'], account, invoice: inv2.payment_request });
  check(r6.status === 400, 'a kind that is no string answers 400 (kanban #2499)', r6);
  const r7 = await post(`${f.url}/player`, { kind: 'welcome', account: 'nothex', invoice: inv2.payment_request });
  check(r7.body && r7.body.ok === false && /32 bytes/.test(r7.body.why), 'an account that is not 32 bytes of hex is refused', r7);
  const totals = await getJson(`${f.url}/player`);
  check(totals.ok, 'GET /player answers the totals', totals);
  const book = JSON.parse(readFileSync(join(f.run, 'book.json'), 'utf8'));
  const rows = (book.players || []).filter((p) => p.account === account);
  check(rows.length === 2 && rows.every((p) => !p.pending), 'the book holds the welcome and the top-up, neither pending', rows);
  return { account: `${account.slice(0, 12)}…`, welcomeMs: ms, welcomeSettled: true, topupSettled: true, refused: { regtestInvoice: r0.body.why, secondWelcome: r2.body.why, reusedInvoice: r3.body.why, wrongAmount: r4.body.why, badAccount: r7.body.why }, totals };
}

async function pageWelcome(ctx) {
  const f = F(ctx);
  const { b, t } = await lightTab(ctx, ctx.lobbyUrl);
  const asked0 = f.frontNotes.length;
  const clicked = await t.until(`(() => { const x = [...document.querySelectorAll('button, a, [role=button]')].find((e) => /Create a new wallet/i.test(e.innerText || '')); if (!x) return false; x.click(); return true; })()`, 60000, 'the Create a new wallet button');
  check(clicked, 'Create a new wallet clicked');
  // the page asks the faucet: first for e-cash (none here), then with an invoice of the devnet federation's gateway
  let hit = null;
  const end = Date.now() + 240000;
  while (Date.now() < end && !hit) {
    const reqs = t.log.requests.filter((r) => /\/api\/faucet\/player/.test(r.url) && r.method === 'POST');
    if (f.frontNotes.length > asked0) hit = { invoiceAsk: f.frontNotes[f.frontNotes.length - 1], posts: reqs.length };
    await wait(1000);
  }
  const consoleLines = () => t.log.console.filter((c) => /faucet|welcome|\[money\]/i.test(c.text)).slice(-15).map((c) => c.text.slice(0, 220));
  if (!hit) { await t.shot(join(ctx.dir, 'no-ask.png')); const e = new Error(`the page did not ask the faucet with an invoice in 4 min (POST /player seen: ${t.log.requests.filter((r) => /\/api\/faucet\/player/.test(r.url)).length})`); e.evidence = { console: consoleLines() }; throw e; }
  // its answer, and the money in the page
  const credited = await t.until(`(document.body.innerText.match(/3,?000 sats have been credited|credited to your wallet/i) || [null])[0]`, 180000, 'the page says the 3,000 sats were credited').catch((e) => { throw Object.assign(e, { evidence: { console: consoleLines(), ask: hit } }); });
  await t.shot(join(ctx.dir, 'credited.png'));
  const book = JSON.parse(readFileSync(join(f.run, 'book.json'), 'utf8'));
  const row = (book.players || []).filter((p) => p.kind === 'welcome').pop();
  check(row && !row.pending && row.sats === 3000, 'the faucet\'s book holds a 3,000 sat welcome, not pending', row);
  // the faucet's payers are b, then a (an invoice on b's own node goes to a): whichever paid it holds it SUCCEEDED
  const paidBy = ['b', 'a'].map((x) => [x, (lnc(ctx, x, 'listpayments', '--max_payments=20').payments || []).find((y) => y.payment_hash === row.hash)]).find(([, y]) => y);
  const p = paidBy ? paidBy[1] : null;
  check(p && p.status === 'SUCCEEDED', 'a faucet payer (lnd b or a) paid the page\'s invoice: SUCCEEDED', p && p.status);
  const bal = await t.until(`(() => { const m = document.body.innerText.match(/([0-9][0-9,]*)\\s*sats?/i); return m ? m[0] : null; })()`, 60000).catch(() => null);
  await b.close();
  return { ask: hit, credited, bookRow: { sats: row.sats, hash: `${row.hash.slice(0, 16)}…` }, payment: p.status, paidBy: `lnd ${paidBy[0]}`, balanceText: bal, console: consoleLines().slice(-5) };
}

// THE PAGE'S FEEDBACK, SIGNED: a tab with a wallet (its seed put in as the page's own importSeed does), the footer's Feedback button, Send; then My feedback
async function openPageWithSeed(ctx, seedHex) {
  const { b, t } = await lightTab(ctx, `${ctx.pageUrl}/`);
  await t.until('typeof window.ARENACLIENT === "object" && typeof window.ARENA_OPEN_FEEDBACK === "function"', 60000);
  let pubkey = null;
  if (seedHex) pubkey = await t.js(`(() => { ARENACLIENT.importSeed(${JSON.stringify(seedHex)}, { storage: sessionStorage }); return ARENACLIENT.tabIdentity({ storage: sessionStorage, random: () => { throw new Error('none'); }, curve: window.ARENA_CURVE }).pubkeyHex; })()`);
  return { b, t, pubkey };
}
const fill = (sel, value) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const p = Object.getPrototypeOf(e); Object.getOwnPropertyDescriptor(p, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
async function pageFeedback(ctx, t, marker) {
  check(await t.click('#arena-foot-feedback'), 'the footer\'s Feedback button is there and visible');
  await t.until('!!document.querySelector("#arena-feedback textarea")', 15000, 'the feedback dialog');
  check(await t.js(fill('#arena-feedback textarea', words(marker))), 'the words typed');
  await wait(300);
  check(await t.js('!document.querySelector("#arena-feedback button.send").disabled'), 'Send is enabled after 50 characters');
  await t.shot(join(ctx.dir, `form-${marker}.png`));
  await t.js('document.querySelector("#arena-feedback button.send").click()');
  return t.until('(() => { const s = document.querySelector("#arena-feedback .say"); return s && /Thank you|not|could|refused|wrong/i.test(s.textContent) && !/Sending/.test(s.textContent) ? s.textContent : null; })()', 45000, 'the dialog\'s answer');
}
async function pageSigned(ctx) {
  const f = F(ctx);
  const seed = randomBytes(32).toString('hex');
  const { b, t, pubkey } = await openPageWithSeed(ctx, seed);
  check(/^[0-9a-f]{64}$/.test(pubkey || ''), 'the tab has an identity key', pubkey);
  const marker = `page-${Date.now().toString(36)}`;
  const p0 = posts(ctx);
  const said = await pageFeedback(ctx, t, marker);
  await t.shot(join(ctx.dir, 'sent.png'));
  const m = /Thank you\. (Feedback #\d+) is in My feedback/.exec(said);
  check(m, 'the page says the report is kept, with its number (a signed report)', said);
  const sent = t.log.requests.find((r) => r.method === 'POST' && /\/api\/faucet\/feedback$/.test(r.url));
  check(sent && sent.status === 200, 'the page posted to /api/faucet/feedback (200)', sent);
  check(posts(ctx) === p0 + 1 && f.chat[f.chat.length - 1].text.includes(m[1]) && f.chat[f.chat.length - 1].text.includes(marker), 'one chat post, with the report\'s number and words', f.chat.slice(-1));
  const rows = await adminList(ctx, `?pubkey=${pubkey}`);
  check(rows.length === 1 && rows[0].label === m[1] && rows[0].happened.includes(marker) && rows[0].state === 'new', 'the store keeps it under the tab\'s key, new', rows);
  check(rows[0].debug !== null, 'the page\'s debug dump went with it (kanban #1391)', rows[0].debug && rows[0].debug.length);
  // My feedback (the menu's item, else its function)
  await t.js('(() => { const c = document.querySelector("#arena-feedback button.off"); if (c) c.click(); return true; })()');
  await wait(300);
  const viaMenu = await t.click('a.arena-nav-mine');
  if (!viaMenu) await t.js('window.ARENA_MY_FEEDBACK()');
  const listed = await t.until(`(() => { const r = [...document.querySelectorAll('#arena-feedback .fb-row')].map((x) => x.innerText); return r.find((x) => x.includes(${JSON.stringify(m[1])})) || null; })()`, 30000, 'My feedback lists the report');
  check(/waiting for the team/.test(listed), 'My feedback says it waits for the team', listed);
  const mine = t.log.requests.find((r) => /\/api\/faucet\/feedback\/mine$/.test(r.url));
  check(mine && mine.status === 200, 'GET /feedback/mine with the tab\'s NIP-98 sign-in answered 200', mine);
  await t.shot(join(ctx.dir, 'my-feedback.png'));
  await b.close();
  ctx.shared.pageReport = { id: rows[0].id, label: m[1], pubkey, seed, marker };
  return { label: m[1], id: `${rows[0].id.slice(0, 16)}…`, pubkey: `${pubkey.slice(0, 16)}…`, chatPosts: 1, myFeedback: listed.replace(/\s+/g, ' ').slice(0, 160), viaMenu, debugChars: rows[0].debug ? rows[0].debug.length : 0 };
}
async function pageUnsigned(ctx) {
  const f = F(ctx);
  const { b, t } = await openPageWithSeed(ctx, null);
  const marker = `unsigned-${Date.now().toString(36)}`;
  const p0 = posts(ctx), n0 = (await adminList(ctx)).length;
  const said = await pageFeedback(ctx, t, marker);
  check(/Thank you, it reached the team/.test(said), 'a tab with no wallet sends unsigned and is told it reached the team', said);
  check(posts(ctx) === p0 + 1 && f.chat[f.chat.length - 1].text.includes(marker), 'one chat post with its words', f.chat.slice(-1));
  check((await adminList(ctx)).length === n0, 'an unsigned report is not kept for review (no key to reward)');
  await t.js('(() => { const c = document.querySelector("#arena-feedback button.off"); if (c) c.click(); return true; })()');
  await wait(300);
  await t.js('window.ARENA_MY_FEEDBACK()');
  const says = await t.until('(() => { const s = document.querySelector("#arena-feedback .say"); return s && !/Reading/.test(s.textContent) ? s.textContent : null; })()', 15000);
  check(/Open a wallet first/.test(says), 'My feedback without a wallet asks to open one', says);
  await t.shot(join(ctx.dir, 'unsigned.png'));
  await b.close();
  return { said, myFeedback: says };
}

// THE COMMUNITY CHECK AGAINST FAKES (what feedback-store.js take()/authOf() and faucet.mjs POST /feedback promise)
async function fakes(ctx) {
  const f = F(ctx);
  const K = await newKey(ctx), X = await newKey(ctx);
  const ev = {};
  const count = async () => (await adminList(ctx)).length;
  const n0 = await count(), p0 = posts(ctx);
  // the honest one
  const good = await report(ctx, K, { marker: 'fakes-good' });
  const a = await sendReport(ctx, good);
  check(a.body.ok && a.body.kept === true && /^Feedback #\d+$/.test(a.body.label), 'a signed report is kept with its number', a.body);
  // replayed / duplicated
  const b = await sendReport(ctx, good);
  check(b.body.ok && b.body.kept === false && b.body.label === a.body.label, 'the same event again answers the first result, not kept again', b.body);
  await Promise.all([1, 2, 3].map(() => sendReport(ctx, good)));
  check(await count() === n0 + 1 && posts(ctx) === p0 + 1, 'five sends of one event: one report kept, one chat post', { kept: (await count()) - n0, posts: posts(ctx) - p0 });
  ev.replay = { label: a.body.label, keptOnce: true, chatPostsOnce: true };
  const refused = {};
  const expectRefused = async (name, event, re) => {
    const r = await sendReport(ctx, event);
    check(r.body && r.body.ok === false && (!re || re.test(String(r.body.why))), `${name} is refused`, r.body);
    refused[name] = r.body.why;
  };
  // forged / tampered / another key
  { const e = await report(ctx, K, { marker: 'forged' }); e.sig = e.sig.slice(0, -2) + (e.sig.endsWith('00') ? '11' : '00'); await expectRefused('a forged signature', e, /signature/); }
  { const e = await report(ctx, K, { marker: 'tampered' }); e.content = e.content.replace('froze', 'FROZE'); await expectRefused('content changed after signing', e, /id is not/); }
  { const e = await report(ctx, X, { marker: 'stolen' }); e.pubkey = K.pk; await expectRefused('another key\'s report under K\'s pubkey', e, /id is not|signature/); }
  { const e = await report(ctx, X, { marker: 'stolen2' }); const e2 = { ...e, pubkey: K.pk }; e2.id = sha256(JSON.stringify([0, e2.pubkey, e2.created_at, e2.kind, e2.tags, e2.content])); await expectRefused('a report re-hashed under K but signed by X', e2, /signature/); }
  { const e = await signEv(ctx, K, { kind: 1, tags: [['t', 'bug']], content: JSON.stringify({ happened: words('kind1') }) }); await expectRefused('a kind 1 note', e, /not a feedback report/); }
  { const e = await report(ctx, K, { marker: 'old', created_at: Math.floor(Date.now() / 1000) - 2 * 86400 }); await expectRefused('a report signed two days ago', e, /more than a day/); }
  { const e = await signEv(ctx, K, { kind: 27842, tags: [['t', 'bug']], content: JSON.stringify({ happened: 'too short to count' }) }); await expectRefused('a report under 50 characters', e, /at least 50/); }
  { const e = await signEv(ctx, K, { kind: 27842, tags: [['t', 'praise']], content: JSON.stringify({ happened: words('type') }) }); await expectRefused('a report of no known type', e, /one of bug, improvement/); }
  { const e = await signEv(ctx, K, { kind: 27842, tags: [['t', 'bug'], ['source', 'node']], content: JSON.stringify({ happened: words('node') }) }); await expectRefused('a node report naming no node', e, /names the node/); }
  { const e = await report(ctx, K, { marker: 'future', created_at: Math.floor(Date.now() / 1000) + 3600 }); await expectRefused('a report dated an hour ahead', e, /future/); }
  // bounty addresses that are no Lightning address (all answered before anything is fetched)
  for (const [name, lnAddress, re] of [['an lnAddress that is no address', 'not an address', /does not work/], ['an lnAddress on a local-only name', 'me@wallet.localhost', /does not work/],
    ['an lnAddress on an IP literal', 'me@127.0.0.1', /does not work/], ['an lnAddress on the team\'s own host', 'me@tn4.bitcoin-arena.io', /does not work/],
    ['an lnAddress that is a number', 12345, /not text/], ['an lnAddress that is a list', ['me@wallet.com'], /not text/]]) {
    const e = await report(ctx, K, { marker: `ln-${name.length}`, body: { lnAddress } }); await expectRefused(name, e, re);
  }
  { const e = await report(ctx, K, { marker: 'lud16', extraTags: [['lud16', 'me@192.168.1.5']] }); await expectRefused('a lud16 tag on a LAN address', e, /does not work/); }
  { const r = await post(`${f.url}/feedback`, { text: `${words('unsigned-ln')}\nBounty address: nobody@wallet.localhost` }); check(r.body && r.body.ok === false && /does not work/.test(r.body.why), 'an unsigned report\'s bounty address is checked too', r.body); refused['unsigned report with a bad address'] = r.body.why; }
  check(await count() === n0 + 1, 'none of the refused reports was kept', { kept: (await count()) - n0 });
  // a seed or a key in the words is never kept
  const nsec = `nsec1${'q'.repeat(10)}${'7ac'.repeat(16)}`;
  const seedPhrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const sec = await report(ctx, K, { marker: 'secret', body: { happened: `${words('secret')} my key is ${nsec} and my words: ${seedPhrase}` } });
  const s = await sendReport(ctx, sec);
  check(s.body.ok && s.body.kept, 'a report holding a key and a seed is kept', s.body);
  const kept = (await adminList(ctx, `?pubkey=${K.pk}`)).find((r) => r.id === sec.id);
  check(kept && !kept.happened.includes(nsec) && !kept.happened.includes('absurd abuse') && kept.happened.includes('[removed]'), 'its key and its seed words are removed from what is kept', kept && kept.happened);
  const chatText = f.chat[f.chat.length - 1].text;
  check(!chatText.includes(nsec) && !chatText.includes('absurd abuse'), 'and from the chat post', chatText.slice(0, 300));
  // MY FEEDBACK: only by the key's own sign-in, only its own reports
  const mineUrl = `${f.url}/feedback/mine`;
  const mineAs = async (key, { url = mineUrl, method = 'GET', created_at, tamper, origin } = {}) => {
    let h = await nip98(ctx, key, url, method, created_at);
    if (tamper) { const e = JSON.parse(Buffer.from(h.slice(6), 'base64').toString()); tamper(e); h = `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`; }
    const r = await fetch(mineUrl, { headers: { authorization: h, ...(origin ? { origin } : {}) } }); return { status: r.status, body: await r.json() };
  };
  const m0 = await fetch(mineUrl); check(m0.status === 401, 'GET /feedback/mine with no sign-in: 401', m0.status);
  const m1 = await mineAs(K); check(m1.status === 200 && m1.body.reports.length === 2 && m1.body.reports.every((r) => r.pubkey === K.pk), 'K\'s sign-in lists K\'s two reports only', m1.body.reports && m1.body.reports.map((r) => r.label));
  const m2 = await mineAs(X); check(m2.status === 200 && m2.body.reports.length === 0, 'X\'s sign-in lists none of K\'s', m2.body);
  const m3 = await mineAs(K, { url: `${f.url}/feedback/other` }); check(m3.status === 401 && /another address/.test(m3.body.why), 'a sign-in naming another URL: 401', m3.body);
  const m4 = await mineAs(K, { method: 'POST' }); check(m4.status === 401, 'a sign-in for another method: 401', m4.body);
  const m5 = await mineAs(K, { created_at: Math.floor(Date.now() / 1000) - 120 }); check(m5.status === 401 && /older than a minute/.test(m5.body.why), 'a sign-in two minutes old: 401', m5.body);
  const m6 = await mineAs(X, { tamper: (e) => { e.pubkey = K.pk; } }); check(m6.status === 401, 'X\'s sign-in under K\'s pubkey: 401', m6.body);
  const m7 = await mineAs(K, { tamper: (e) => { e.kind = 27842; } }); check(m7.status === 401, 'a sign-in of another kind: 401', m7.body);
  ctx.shared.fakesKey = K;
  ctx.shared.fakesReport = { id: good.id, label: a.body.label };
  ctx.shared.secretReport = { id: sec.id };
  return { replay: ev.replay, refused, scrubbed: true, mine: { own: m1.body.reports.length, otherKeySees: 0, wrongUrl: m3.body.why, old: m5.body.why } };
}

async function screenshots(ctx) {
  const f = F(ctx);
  const K = await newKey(ctx);
  const up = (bytes, type = 'image/png') => post(`${f.url}/feedback/screenshot`, bytes, { raw: true, headers: { 'content-type': type } });
  const bad = await up(Buffer.from('this is no image at all, only words'), 'image/png');
  check(bad.status === 415, 'a file that is no PNG/JPEG/WebP (by its bytes) is refused 415', bad);
  const html = await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml');
  check(html.status === 415, 'an SVG is refused 415', html);
  const big = Buffer.concat([firstPng().subarray(0, 16), randomBytes(1_600_000)]);
  const over = await up(big);
  check(over.status === 413, 'an image over 1.5 MB is refused 413', over);
  const png = firstPng();
  const ok = await up(png);
  check(ok.status === 200 && ok.body.sha256 === sha256(png), 'a PNG is kept under its SHA-256', ok);
  const unknown = await report(ctx, K, { marker: 'shot-unknown', extraTags: [['screenshot', sha256('never uploaded')]] });
  const r1 = await sendReport(ctx, unknown);
  check(r1.body.ok === false && /not uploaded/.test(r1.body.why), 'a report naming a screenshot never uploaded is refused', r1.body);
  const withShot = await report(ctx, K, { marker: 'shot', extraTags: [['screenshot', ok.body.sha256]] });
  const r2 = await sendReport(ctx, withShot);
  check(r2.body.ok && r2.body.kept, 'a report naming its uploaded screenshot is kept', r2.body);
  const row = (await adminList(ctx, `?pubkey=${K.pk}`))[0];
  check(row && row.screenshot === ok.body.sha256, 'the report names its screenshot', row && row.screenshot);
  const img = await fetch(`${f.url}/feedback/admin/screenshot/${ok.body.sha256}`, { headers: admin(ctx) });
  check(img.status === 200 && Buffer.from(await img.arrayBuffer()).equals(png), 'the admin reads the same bytes back');
  const noCode = await fetch(`${f.url}/feedback/admin/screenshot/${ok.body.sha256}`);
  check(noCode.status === 403, 'without the admin code the screenshot is not served', noCode.status);
  return { refused: { notImage: bad.body.why, svg: html.body.why, tooBig: over.body.why, unknownHash: r1.body.why }, kept: ok.body.sha256.slice(0, 16) };
}

async function adminReview(ctx) {
  const f = F(ctx);
  const pr = ctx.shared.pageReport;
  if (!pr) throw new Error('no page report to review (feedback.page-signed did not pass)');
  const noCode = await fetch(`${f.url}/feedback/admin/list`);
  check(noCode.status === 403, 'the review list without the admin code: 403', noCode.status);
  const wrong = await fetch(`${f.url}/feedback/admin/list`, { headers: { 'x-arena-admin': 'not-the-code' } });
  check(wrong.status === 403, 'with a wrong code: 403', wrong.status);
  const forged = await post(`${f.url}/feedback/admin/act`, { action: 'approve', id: pr.id, severity: 'low' }, { headers: { 'x-arena-admin': sha256(f.adminCode) } });
  check(forged.status === 403, 'acting with the code\'s hash (what the faucet stores) in place of the code: 403', forged.status);
  const list = await getJson(`${f.url}/feedback/admin/list`, { headers: admin(ctx), ms: 60000 });
  const row = list.reports.find((r) => r.id === pr.id);
  check(row && row.state === 'new' && row.label === pr.label, 'the page\'s report is on the review list, new', row && { state: row.state, label: row.label });
  check(list.budget && list.budget.network === 'mainnet' && Array.isArray(list.levels), 'the list carries the budget and the reward levels', list.budget);
  // a fake approval: a duplicate of it is never approved, nor a rejected one
  const fk = ctx.shared.fakesReport;
  const out = {};
  if (fk) {
    const dup = await act(ctx, { action: 'duplicate', id: fk.id, of: pr.label });
    check(dup.body.ok && dup.body.report.state === 'duplicate', 'a later report marked a duplicate of the page\'s (by its number)', dup.body);
    const ap = await act(ctx, { action: 'approve', id: fk.id, severity: 'low', amountSats: 1000 });
    check(ap.body.ok === false && /duplicate report is not approved/.test(ap.body.why), 'a duplicate is not approved for money', ap.body);
    const back = await act(ctx, { action: 'duplicate', id: pr.id, of: fk.label });
    check(back.body.ok === false, 'the first report is never made a duplicate of a later one', back.body);
    out.duplicate = ap.body.why;
  }
  const sr = ctx.shared.secretReport;
  if (sr) {
    const rj0 = await act(ctx, { action: 'reject', id: sr.id, reason: '' });
    check(rj0.body.ok === false && /says why/.test(rj0.body.why), 'a rejection without a reason is refused', rj0.body);
    const rj = await act(ctx, { action: 'reject', id: sr.id, reason: 'not a bug: e2e #2642' });
    check(rj.body.ok && rj.body.report.state === 'rejected', 'a report rejected with its reason', rj.body);
    const ap = await act(ctx, { action: 'approve', id: sr.id, severity: 'low' });
    check(ap.body.ok === false, 'a rejected report is not approved', ap.body);
    const rw = await act(ctx, { action: 'reward', id: sr.id, payTo: 'link' });
    check(rw.body.ok === false, 'a rejected report gets no reward link', rw.body);
    out.rejected = ap.body.why;
  }
  const big = await act(ctx, { action: 'approve', id: pr.id, amountSats: 50000 });
  check(big.body.ok === false && /an amount is/.test(big.body.why), 'an amount above the band is refused', big.body);
  const ap = await act(ctx, { action: 'approve', id: pr.id, severity: 'low', amountSats: 1000 });
  check(ap.body.ok && ap.body.report.state === 'accepted' && ap.body.report.amountSats === 1000, 'the page\'s report approved for 1,000 sat (low)', ap.body);
  const again = await act(ctx, { action: 'approve', id: pr.id, severity: 'high', amountSats: 5000 });
  check(again.body.ok === false && /accepted report is not approved/.test(again.body.why), 'approved once only', again.body);
  const rw = await act(ctx, { action: 'reward', id: pr.id, payTo: 'link', comment: 'thanks from e2e #2642' });
  check(rw.body.ok && /^[0-9a-f]{64}$/.test(rw.body.reward.k1) && /^lnurl1/.test(rw.body.lnurl) && rw.body.reward.amountSats === 1000 && rw.body.reward.network === 'mainnet', 'the reward link: k1, its LNURL, 1,000 sat on the payout network', rw.body);
  const rw2 = await act(ctx, { action: 'reward', id: pr.id, payTo: 'link' });
  check(rw2.body.ok && rw2.body.reward.k1 === rw.body.reward.k1 && rw2.body.made === false, 'asked again, the same link', rw2.body);
  ctx.shared.reward = { k1: rw.body.reward.k1, lnurl: rw.body.lnurl, report: pr.id };
  const csv = await fetch(`${f.url}/feedback/admin/export.csv`, { headers: admin(ctx) });
  check(csv.status === 200 && (await csv.text()).includes(pr.id.slice(0, 16)), 'the CSV export lists it');
  return { ...out, approved: ap.body.report.label, amountSats: 1000, k1: `${rw.body.reward.k1.slice(0, 12)}…`, lnurl: `${rw.body.lnurl.slice(0, 20)}…` };
}

async function claim(ctx) {
  const f = F(ctx);
  const w = ctx.shared.reward;
  if (!w) throw new Error('no reward link (bounty.admin-review did not pass)');
  const req = await getJson(`${f.url}/lnurlw/${w.k1}`);
  check(req.tag === 'withdrawRequest' && req.minWithdrawable === 1000000 && req.maxWithdrawable === 1000000 && req.callback === `${f.url}/lnurlw/${w.k1}/callback`, 'LUD-03: a withdrawRequest for exactly 1,000 sat', req);
  check(/thanks from e2e #2642/.test(req.defaultDescription), 'with the admin\'s comment', req.defaultDescription);
  const cb = (k1, pr) => getJson(`${f.url}/lnurlw/${w.k1}/callback?k1=${k1}&pr=${encodeURIComponent(pr)}`, { ms: 120000 });
  const inv = invoiceOf(ctx, 'c', 1000, 'e2e bounty');
  const e1 = await cb('0'.repeat(64), inv.payment_request);
  check(e1.status === 'ERROR' && /does not match/.test(e1.reason), 'a callback whose k1 differs from the link\'s is refused', e1);
  const small = invoiceOf(ctx, 'c', 999);
  const e2 = await cb(w.k1, small.payment_request);
  check(e2.status === 'ERROR' && /exactly 1000 sat/.test(e2.reason), 'an invoice of 999 sat is refused', e2);
  const big = invoiceOf(ctx, 'c', 2000);
  const e3 = await cb(w.k1, big.payment_request);
  check(e3.status === 'ERROR' && /exactly 1000 sat/.test(e3.reason), 'an invoice of 2,000 sat is refused', e3);
  const tn = regtestToTestnetInvoice(inv.payment_request);
  const e4 = await cb(w.k1, tn);
  check(e4.status === 'ERROR' && /could not be read/.test(e4.reason), 'an invoice of another network (lntb, the payout network is mainnet) is refused before lnd', e4);
  const e5 = await getJson(`${f.url}/lnurlw/${'1'.repeat(64)}`);
  check(e5.status === 'ERROR' && /no such reward/.test(e5.reason), 'a made-up k1 answers no such reward', e5);
  check(lookup(ctx, 'c', small.r_hash).state === 'OPEN' && lookup(ctx, 'c', big.r_hash).state === 'OPEN', 'none of the refused invoices was paid');
  const t0 = Date.now();
  const ok = await cb(w.k1, inv.payment_request);
  check(ok.status === 'OK', 'the right invoice is paid: OK', ok);
  const l = lookup(ctx, 'c', inv.r_hash);
  check(l.state === 'SETTLED' && Number(l.amt_paid_sat) === 1000, 'lnd c holds the reward invoice SETTLED for 1,000 sat', { state: l.state, paid: l.amt_paid_sat });
  const inv2 = invoiceOf(ctx, 'c', 1000, 'e2e bounty twice');
  const twice = await cb(w.k1, inv2.payment_request);
  check(twice.status === 'ERROR' && /claimed/.test(twice.reason) && lookup(ctx, 'c', inv2.r_hash).state === 'OPEN', 'a second claim of the link is refused and nothing paid', twice);
  const after = await getJson(`${f.url}/lnurlw/${w.k1}`);
  check(after.status === 'ERROR' && /claimed/.test(after.reason), 'the link now answers claimed', after);
  const rep = await getJson(`${f.url}/feedback/admin/report/${w.report}`, { headers: admin(ctx), ms: 60000 });
  check(rep.report.state === 'paid' && rep.report.reward.state === 'paid', 'the report and its reward are paid', { report: rep.report.state, reward: rep.report.reward && rep.report.reward.state });
  const log = await getJson(`${f.url}/feedback/paid-log`);
  check(Array.isArray(log) && log.some((x) => x.sats === 1000), 'the public payout log lists it', log.slice(-2));
  // the reporter's own page: My feedback says paid (the page does not show reward links on 127.0.0.1: ARENA_BOUNTY_ON is for the testnet hosts)
  const pr = ctx.shared.pageReport;
  const { b, t } = await openPageWithSeed(ctx, pr.seed);
  await t.js('window.ARENA_MY_FEEDBACK()');
  const row = await t.until(`(() => { const r = [...document.querySelectorAll('#arena-feedback .fb-row')].map((x) => x.innerText); return r.find((x) => x.includes(${JSON.stringify(pr.label)})) || null; })()`, 30000);
  check(/· paid/.test(row), 'My feedback in the reporter\'s page says paid', row);
  await t.shot(join(ctx.dir, 'my-feedback-paid.png'));
  await b.close();
  // and the reward toward the private origin only: the page's own sign-in replayed by the suite is not possible (it holds no key), so asked with K below
  return { paidMs: Date.now() - t0, settled: l.state, refused: { k1: e1.reason, small: e2.reason, big: e3.reason, otherNetwork: e4.reason, twice: twice.reason }, myFeedback: row.replace(/\s+/g, ' ').slice(0, 120) };
}

async function season2(ctx) {
  const f = F(ctx);
  const K = await newKey(ctx);
  const pot = await getJson(`${f.url}/feedback/season`);
  check(pot.season === 2 && pot.potSats === 100000, 'Week 2\'s pot: 100,000 sat', pot);
  const base = `${f.url}/feedback`;
  const call = async (p, key, body, { url } = {}) => {
    const h = key ? { authorization: await nip98(ctx, key, url || `${base}${p}`, 'POST') } : {};
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const l0 = await call('/link', null);
  check(l0.status === 401, 'POST /feedback/link without a sign-in: 401', l0);
  const l1 = await call('/link', K, null, { url: `${base}/verify` });
  check(l1.status === 401, 'a sign-in for another door: 401', l1);
  const l2 = await call('/link', K);
  check(l2.status === 200 && /^BA-[A-Z2-9]{8}$/.test(l2.body.code || ''), 'a link code for the signed-in key', l2.body);
  // the social screen: names typed for X / Telegram / Discord / Armada. Nothing is configured to read them here, so none may count
  const s1 = await call('/social', K, { x: 'bitcoinarena_io', telegram: '@somebody', discord: 'somebody#0001', armada: 'npub1xyz' });
  check(s1.status === 200 && s1.body.ok && s1.body.bonusPct === 0 && s1.body.links.length === 0, 'claimed memberships with no reader: no bonus, nothing linked', s1.body);
  check(Object.values(s1.body.results).every((r) => r.member === null), 'every platform answers "not on" (member null), never yes', s1.body.results);
  const s2 = await call('/social', K, { telegram: '@somebody' });
  check(s2.status === 429, 'a second check within 15 s: 429', s2);
  const s3 = await call('/social', null, { x: 'a' });
  check(s3.status === 401, 'the social check without a sign-in: 401', s3);
  // a Week 2 approval: the level's sats, no bonus (no verified membership)
  const e = await report(ctx, K, { marker: 'season2' });
  const r = await sendReport(ctx, e);
  check(r.body.ok && r.body.kept, 'a report for Week 2 kept', r.body);
  const ap = await act(ctx, { action: 'approve', id: e.id, severity: 'medium', season2: true });
  check(ap.body.ok && ap.body.report.amountSats === 2000 && ap.body.season2, 'approved by the Week 2 rules: medium = 2,000 sat, no bonus', ap.body);
  const again = await act(ctx, { action: 'approve', id: e.id, severity: 'medium', season2: true });
  check(again.body.ok === false, 'a Week 2 approval once only', again.body);
  const half = await report(ctx, K, { marker: 'season2-code' });
  await sendReport(ctx, half);
  const ap2 = await act(ctx, { action: 'approve', id: half.id, severity: 'high', season2: true, codeOnly: true });
  check(ap2.body.ok && ap2.body.report.amountSats === 2500, 'a code-only finding at half: high 5,000 -> 2,500', ap2.body);
  const pay = await act(ctx, { action: 'payable', id: e.id });
  check(pay.body && pay.body.ok !== undefined, 'payable answers', pay.body);
  const ad = await getJson(`${f.url}/feedback/admin/season`, { headers: admin(ctx) });
  check(ad.ok && ad.pot.usedSats === 4500 && ad.approvals.length === 2, 'the season\'s pot used 4,500 of 100,000 by the two approvals', { used: ad.pot.usedSats, n: ad.approvals.length });
  // the reward of the Week 2 approval, toward the private page's origin only
  const rw = await act(ctx, { action: 'reward', id: e.id, payTo: 'link' });
  check(rw.body.ok && rw.body.reward.amountSats === 2000, 'its reward link is for 2,000 sat', rw.body);
  const mineUrl = `${f.url}/feedback/mine`;
  const asK = async (origin) => (await fetch(mineUrl, { headers: { authorization: await nip98(ctx, K, mineUrl), ...(origin ? { origin } : {}) } })).json();
  const pub = await asK(null);
  check(pub.ok && pub.reports.every((x) => x.reward === null && x.amountSats === null), 'My feedback from any other origin carries no reward and no amount', pub.reports.map((x) => x.reward));
  const priv = await asK(f.origin);
  const mine = priv.reports.find((x) => x.id === e.id);
  check(mine && mine.reward && mine.reward.sats === 2000 && /^lnurl1/.test(mine.reward.lnurl), 'toward the private page\'s origin it carries the reward and its link', mine && mine.reward);
  // the same invoice for two rewards: refused for the second
  const inv = invoiceOf(ctx, 'c', 2000, 'e2e s2');
  const ok = await getJson(`${f.url}/lnurlw/${rw.body.reward.k1}/callback?k1=${rw.body.reward.k1}&pr=${encodeURIComponent(inv.payment_request)}`, { ms: 120000 });
  check(ok.status === 'OK' && lookup(ctx, 'c', inv.r_hash).state === 'SETTLED', 'the Week 2 reward claimed and paid', ok);
  return { pot: pot.potSats, linkCode: 'BA-…', social: s1.body.results, approvals: { medium: 2000, highCodeOnly: 2500 }, usedSats: ad.pot.usedSats, privateOnly: true };
}

export const flows = [
  { id: SVC, area: 'faucet', title: 'the faucet service runs against the devnet (own wallet, payers b/a, chat stub)', money: 2, reach: 3, needs: ['devnet'], timeoutMs: 120000, order: 0, run: serviceUp },
  { id: 'faucet.coins', area: 'faucet', title: 'POST /faucet pays regtest coins once per address; limits refuse', money: 2, reach: 2, needs: ['devnet', 'faucet'], timeoutMs: 120000, after: [SVC], run: coins },
  { id: 'faucet.player-grant', area: 'faucet', title: 'POST /player: welcome 3,000 and top-up 300 over Lightning, repeats refused', money: 2, reach: 3, needs: ['devnet', 'faucet', 'liquidity'], timeoutMs: 300000, after: [SVC], run: playerGrant },
  { id: 'faucet.page-welcome', area: 'faucet', title: 'a new wallet in the page gets its 3,000 sat welcome from the faucet', money: 2, reach: 3, needs: ['devnet', 'faucet', 'chrome', 'liquidity'], timeoutMs: 600000, after: [SVC, 'faucet.player-grant'], run: pageWelcome },
  { id: 'feedback.page-signed', area: 'feedback', title: 'the page\'s Feedback sends a signed report; My feedback lists it', money: 0, reach: 3, needs: ['faucet', 'chrome'], timeoutMs: 240000, after: [SVC], run: pageSigned },
  { id: 'feedback.page-unsigned', area: 'feedback', title: 'a tab with no wallet sends an unsigned report (posted, not kept)', money: 0, reach: 2, needs: ['faucet', 'chrome'], timeoutMs: 180000, after: [SVC, 'feedback.page-signed'], run: pageUnsigned },
  { id: 'feedback.fakes', area: 'feedback', title: 'forged, tampered, replayed, stale and other-key reports; bad bounty addresses; NIP-98 My feedback', money: 1, reach: 2, needs: ['faucet'], timeoutMs: 180000, after: [SVC, 'feedback.page-signed'], run: fakes },
  { id: 'feedback.screenshot', area: 'feedback', title: 'screenshots: not an image, SVG, too big, unknown hash refused; a PNG kept', money: 0, reach: 1, needs: ['faucet'], timeoutMs: 120000, after: [SVC], run: screenshots },
  { id: 'bounty.admin-review', area: 'bounty', title: 'the admin review list: code only, duplicate/reject never approved, approve once, reward link', money: 1, reach: 1, needs: ['faucet'], timeoutMs: 180000, after: [SVC, 'feedback.page-signed', 'feedback.fakes'], run: adminReview },
  { id: 'bounty.lnurlw-claim', area: 'bounty', title: 'the reward\'s LNURL-withdraw pays a devnet invoice once; wrong k1/amount/network refused', money: 2, reach: 1, needs: ['faucet', 'liquidity', 'chrome'], timeoutMs: 300000, after: [SVC, 'bounty.admin-review'], run: claim },
  { id: 'bounty.season2', area: 'bounty', title: 'Week 2: pot, link code, social check without readers (no bonus), S2 approvals, reward private-only', money: 2, reach: 1, needs: ['faucet', 'liquidity'], timeoutMs: 300000, after: [SVC, 'bounty.lnurlw-claim'], run: season2 },
];
