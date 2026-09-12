// THE PAGE'S OWN JOIN OF A ROUND WHOSE STAKE GOES INTO A FEDERATION LOCK (W1b),
// in a real browser, on a real federation. A TOOL, not a test: it wants a built
// page on disk, a headless Chrome, and the federation page-lock-regtest.sh
// stands up (stock fedimintd 0.12.0, one gateway, regtest).
//
//   node tools/page-lock.mjs before=<page dir> after=<page dir> nolock=<page dir>
//
// Each run is the Daily's own 2-of-2 round (`standUpRound`: bonded seats, a
// census, a published round) naming the federation, both seats holding the
// attested claim key and the real stake-lock port. The page is opened on the
// round's link, as a player opens it; the harness pays the deposit invoice the
// page shows (the player's wallet), and reads everything else off the browser -
// what the page built, every request it made - and off the seats and the
// federation. `nolock` serves the page with its lock step switched off: the
// mutant that must not be seated.
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import WebSocket from 'ws';

import { standUpRound } from '../../blwp-node/tools/round-2of2.mjs';
import { stakeLockPort } from '../../blwp-node/src/stake-lock-port.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const env = process.env;
const P = env.PROBE;
const CHROME = env.CHROME || '/home/arena/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const say = (o) => console.log(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const runs = process.argv.slice(2).map((a) => { const i = a.indexOf('='); return { label: a.slice(0, i), dir: a.slice(i + 1) }; });
if (!P || !env.INVITE || !runs.length) { console.error('usage: PROBE=.. INVITE=.. node tools/page-lock.mjs label=<page dir> ...'); process.exit(2); }

// THE ROUND NAMES THE FEDERATION THE INVITE IS TO: its id, read by the lock
// client itself (the glue is ESM and dist is CommonJS, so it is read from a copy).
const glueDir = mkdtempSync(join(tmpdir(), 'lock-glue-'));
const dist = new URL('../dist/', import.meta.url).pathname;
copyFileSync(join(dist, 'blwp_lock_client.js'), join(glueDir, 'blwp_lock_client.mjs'));
const glue = await import(join(glueDir, 'blwp_lock_client.mjs'));
await glue.default({ module_or_path: readFileSync(join(dist, 'blwp_lock_client_bg.wasm')) });
const federationId = fromHex(glue.LockClient.federationIdOf(env.INVITE));
const claimPk = fromHex(JSON.parse(readFileSync(`${P}/keys.json`, 'utf8')).claimPk);
const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
const lncliPay = (invoice) => new Promise((done) => execFile(`${env.LND_BIN}/lncli`,
  [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest', 'payinvoice', '--force', invoice],
  { timeout: 120000 }, (err, out) => done((String(out).match(/Payment status: [A-Z_]+/) || [err ? err.message.slice(0, 80) : '?'])[0])));

// THE MUTANT: the page's lock step never runs. Everything else is the page.
const LOCK_STEP = 'if (BLWPCLIENT.roundLocks(named.round)) {\n          const depositEl';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const servePageAs = (dir, label) => new Promise((ok) => {
  const s = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    let body;
    try { body = readFileSync(join(dir, p.replace(/\.\.+/g, ''))); } catch { res.writeHead(404); return res.end('no'); }
    if (p === '/index.html' && label === 'nolock') {
      const html = body.toString('utf8');
      if (!html.includes(LOCK_STEP)) { res.writeHead(500); return res.end('this page has no lock step to switch off'); }
      body = Buffer.from(html.replace(LOCK_STEP, 'if (false) {\n          const depositEl'));
    }
    const ext = p.slice(p.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  });
  s.listen(0, '127.0.0.1', () => ok({ server: s, port: s.address().port }));
});

async function browse(url) {
  const profile = mkdtempSync(join(tmpdir(), 'page-lock-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-sandbox', '--window-size=1280,800', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const debugPort = await new Promise((r) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) r(m[1]); }); });
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page');
    if (!target) await wait(250);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let n = 0;
  const pending = new Map();
  const logs = [];
  const requests = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Network.requestWillBeSent')
      requests.set(m.params.requestId, { method: m.params.request.method, url: m.params.request.url, status: null });
    if (m.method === 'Network.responseReceived' && requests.has(m.params.requestId))
      requests.get(m.params.requestId).status = m.params.response.status;
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++n; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.navigate', { url });
  const close = () => { try { ws.close(); } catch {} try { chrome.kill('SIGKILL'); } catch {} };
  return { evaluate, requests, logs, close };
}

const pathOf = (q) => { try { return new URL(q.url).pathname; } catch { return q.url; } };

async function one({ label, dir }, i) {
  const page = await servePageAs(dir, label);
  const round = await standUpRound({ host: '127.0.0.1', portA: 18361 + 2 * i, portB: 18362 + 2 * i,
    page: `http://127.0.0.1:${page.port}`, stakeMsat: 1000000n, federationId, invite: env.INVITE,
    seat: { claimKeyFor: () => claimPk, stakeLocks: port } });
  const b = await browse(round.url);
  const t0 = Date.now();
  const timings = {};
  let paid = null;
  try {
    // THE PAGE SHOWS A DEPOSIT, BUILDS ITS ENTRY, OR REFUSES THE SEAT - whichever it does first.
    // `pageError` is the page's own refusal of the link (`fail(...)` into #err): Unity is never started.
    const state = () => b.evaluate("JSON.stringify({ deposit: window.BLWP_DEPOSIT || null, entry: !!window.BLWP_ENTRY, refused: window.BLWP_SEAT_REFUSED || null, lock: window.BLWP_STAKE_LOCK ? 1 : 0, pageError: (document.getElementById('err') || {}).textContent || null })");
    let s = {};
    for (let t = Date.now(); Date.now() - t < 120000; await wait(250)) {
      s = JSON.parse(await state() || '{}');
      if (s.deposit || s.entry || s.refused || s.pageError) break;
    }
    if (s.deposit) {
      timings.depositShownMs = Date.now() - t0;
      paid = await lncliPay(s.deposit.invoice);
      timings.paidMs = Date.now() - t0;
      for (let t = Date.now(); Date.now() - t < 120000; await wait(250)) {
        s = JSON.parse(await state() || '{}');
        if (s.entry || s.refused || s.pageError) break;
      }
      timings.lockedMs = Date.now() - t0;
    }
    // AND ONCE UNITY HAS IT, THE SESSION POSTS THE ENTRY AND HANDS THE LOCK TO THE SEATS.
    const reqs = () => [...b.requests.values()];
    const posted = (p) => reqs().filter((q) => q.method === 'POST' && pathOf(q) === p);
    for (let t = Date.now(); Date.now() - t < 240000 && !s.refused && !s.pageError; await wait(1000)) {
      if (s.lock ? posted('/lock').length >= 2 && posted('/lock').every((q) => q.status) : posted('/entry').length && posted('/entry').every((q) => q.status)) break;
    }
    await wait(3000);
    const entry = await b.evaluate(`(() => { const e = window.BLWP_ENTRY; if (!e) return null; const h = BLWPCLIENT.toHex;
      return { outpoint: h(e.stakeLockOutpoint.txid) + ':' + String(e.stakeLockOutpoint.outIdx), stakePoint: h(e.stakePoint) }; })()`);
    const lock = await b.evaluate(`(() => { const l = window.BLWP_STAKE_LOCK; return l ? BLWPCLIENT.toHex(l.outpoint.txid) + ':' + String(l.outpoint.outIdx) : null; })()`);
    const refused = await b.evaluate('window.BLWP_SEAT_REFUSED || null');
    const lockPosts = posted('/lock');
    const eid = lockPosts.length ? new URL(lockPosts[0].url).searchParams.get('entry') : null;
    const seats = [round.a, round.b];
    let federation = null;
    if (lock) {
      const [txid, outIdx] = lock.split(':');
      const st = await port.status({ txid: fromHex(txid), outIdx: BigInt(outIdx) });
      federation = st && st.stored ? { holds: true, blocksLeft: st.stored.blocksLeft, blockCount: st.blockCount } : { holds: false };
    }
    const facts = {
      run: label, seatRefused: refused, pageError: s.pageError || null, deposit: s.deposit ? { amountMsat: s.deposit.amountMsat, paid } : null,
      lockMadeAt: lock, entryOutpoint: entry && entry.outpoint,
      entryOutpointIsZero: entry ? /^0{64}:0$/.test(entry.outpoint) : null,
      entryNamesTheLock: !!(entry && lock && entry.outpoint === lock),
      federation,
      lockClientLoaded: reqs().filter((q) => /blwp_lock_client/.test(q.url)).map((q) => `${pathOf(q)} ${q.status}`),
      handouts: posted('/handout').map((q) => q.status), entries: posted('/entry').map((q) => q.status),
      locks: lockPosts.map((q) => q.status),
      committedMsat: eid ? seats.map((d) => { const seen = d.round.stakeSeen(fromHex(eid)); return seen ? String(seen.paidMsat) : null; }) : [null, null],
      timings,
    };
    say(facts);
    return facts;
  } finally {
    b.close();
    await round.close();
    page.server.close();
    console.log(`--- ${label}: page console ---`);
    for (const l of b.logs) if (/\[blwp\]|EXCEPTION|lock|refused/i.test(l) && !/\[seat\]/.test(l)) console.log('   ', l.slice(0, 240));
  }
}

let code = 0;
try {
  for (const [i, r] of runs.entries()) await one(r, i);
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
}
// The daemons, the page servers and Chrome are closed; the lock port's children exit with their calls.
process.exit(code);
