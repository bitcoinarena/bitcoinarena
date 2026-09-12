// THE PAGE'S OWN JOIN OF A ROUND WHOSE STAKE GOES INTO A FEDERATION LOCK (W1b),
// in a real browser, on a real federation. A TOOL, not a test: it wants a built
// page on disk, a headless Chrome, and the federation page-lock-regtest.sh
// stands up (stock fedimintd 0.12.0, one gateway, regtest).
//
//   node tools/page-lock.mjs label=<page dir> ...
//
// Each run is the Daily's own 2-of-2 round (`standUpRound`: bonded seats, a
// census, a published round) naming the federation, both seats holding the
// attested claim key and the real stake-lock port. The page is opened on the
// round's link, as a player opens it; the harness pays the deposit invoice the
// page shows (the player's wallet), and reads everything else off the browser -
// what the page built and showed, every request it made - and off the seats and
// the federation. Labels:
//   nolock...  the page served with its lock step switched off (the mutant)
//   reload...  the tab is reloaded once, after the deposit and before the lock
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
// THE RELOAD: once, when the page is about to lock - the deposit paid and
// claimed - the tab goes away and comes back. Harness instrumentation in the
// served page, not in the client: it wraps the page's call and throws at that
// step, so no lock is made, then reloads.
const RELOAD_ONCE = `<script>(function () {
  var real = BLWPCLIENT.lockStake;
  BLWPCLIENT.lockStake = function (o) {
    var step = o.onStep || function () {};
    return real(Object.assign({}, o, { onStep: function (s) {
      if (s === 'locking the stake' && !sessionStorage.getItem('blwp.harness.reloaded')) {
        sessionStorage.setItem('blwp.harness.reloaded', '1');
        setTimeout(function () { location.reload(); }, 0);
        throw new Error('harness: the tab went away before the lock');
      }
      step(s);
    } }));
  };
})();</script>`;
// THE RELOAD AFTER THE LOCK: once, the moment the page has made its lock and
// before Unity's session posts the entry - the window where a seat has not yet
// committed it.
const RELOAD_AFTER_LOCK = `<script>(function () {
  var t = setInterval(function () {
    if (window.BLWP_STAKE_LOCK && !sessionStorage.getItem('blwp.harness.reloaded')) {
      sessionStorage.setItem('blwp.harness.reloaded', '1');
      clearInterval(t);
      location.reload();
    }
  }, 20);
})();</script>`;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const servePageAs = (dir, label) => new Promise((ok) => {
  const s = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    let body;
    try { body = readFileSync(join(dir, p.replace(/\.\.+/g, ''))); } catch { res.writeHead(404); return res.end('no'); }
    if (p === '/index.html' && (label.startsWith('nolock') || label.startsWith('reload') || label.startsWith('relock'))) {
      let html = body.toString('utf8');
      if (label.startsWith('nolock')) {
        if (!html.includes(LOCK_STEP)) { res.writeHead(500); return res.end('this page has no lock step to switch off'); }
        html = html.replace(LOCK_STEP, 'if (false) {\n          const depositEl');
      } else {
        html = html.replace('<script src="blwp-client.js"></script>', '<script src="blwp-client.js"></script>'
          + (label.startsWith('relock') ? RELOAD_AFTER_LOCK : RELOAD_ONCE));
      }
      body = Buffer.from(html);
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
  // EVERY ASK OF THE BROWSER IS BOUNDED. Measured: a run's Chrome went away
  // (DevTools refusing connections) and an unbounded ask left the harness
  // waiting for good, its runs never reported. A dead browser now fails the run.
  const send = (method, params = {}) => new Promise((r, no) => {
    const i = ++n;
    const timer = setTimeout(() => { pending.delete(i); no(new Error(`the browser did not answer ${method} in 30 s`)); }, 30000);
    pending.set(i, (m) => { clearTimeout(timer); r(m); });
    try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { clearTimeout(timer); pending.delete(i); no(e); }
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result) writeFileSync(file, Buffer.from(r.result.data, 'base64')); };
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  const close = () => { try { ws.close(); } catch {} try { chrome.kill('SIGKILL'); } catch {} };
  const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
    await wait(600);
  };
  const key = (type) => send('Input.dispatchKeyEvent', { type, code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87,
    nativeVirtualKeyCode: 87, ...(type === 'keyDown' ? { text: 'w' } : {}) });
  return { evaluate, shot, click, key, requests, logs, close };
}

const pathOf = (q) => { try { return new URL(q.url).pathname; } catch { return q.url; } };

// WHAT THE PAGE HAS DONE AND SHOWS, read in whatever document is current (a
// reload resets the globals). `depositView` is whether the invoice a player
// must pay is on screen: something drawn, and the topmost thing at its centre.
const STATE = `JSON.stringify({
  deposit: window.BLWP_DEPOSIT || null, entry: !!window.BLWP_ENTRY, refused: window.BLWP_SEAT_REFUSED || null,
  lock: window.BLWP_STAKE_LOCK ? 1 : 0, pageError: (document.getElementById('err') || {}).textContent || null,
  reloadedDoc: (performance.getEntriesByType('navigation')[0] || {}).type === 'reload',
  depositView: (() => {
    const el = document.getElementById('blwp-deposit'); if (!el) return null;
    const box = el.querySelector('code') || el; const r = box.getBoundingClientRect();
    const hit = r.width && r.height ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    return { drawn: r.width > 0 && r.height > 0, onTop: !!hit && (hit === box || box.contains(hit)),
      carriesInvoice: !!window.BLWP_DEPOSIT && (box.textContent || '').includes(window.BLWP_DEPOSIT.invoice) };
  })(),
})`;
const VIEW = `JSON.stringify({
  chip: (document.getElementById('blwp-players') || {}).textContent || null,
  panel: (document.getElementById('blwp-owed') || {}).textContent || null,
  refusedWhy: (() => { const i = window.unityInstance; const m = (i && i.Module) || window.Module;
    return (m && m.blwpNet && m.blwpNet.client && m.blwpNet.client.refusedWhy) || null; })(),
})`;

async function one({ label, dir }, i) {
  const page = await servePageAs(dir, label);
  const base = Number(env.PORT_BASE || 18361);
  const round = await standUpRound({ host: '127.0.0.1', portA: base + 2 * i, portB: base + 1 + 2 * i,
    page: `http://127.0.0.1:${page.port}`, stakeMsat: 1000000n, federationId, invite: env.INVITE,
    seat: { claimKeyFor: () => claimPk, stakeLocks: port } });
  const b = await browse(round.url);
  const t0 = Date.now();
  const timings = {};
  const deposits = [];
  let depositView = null;
  const state = async () => JSON.parse(await b.evaluate(STATE) || '{}');
  const until = async (ms, done) => { let s = {}; for (let t = Date.now(); Date.now() - t < ms; await wait(250)) { s = await state(); if (done(s)) break; } return s; };
  try {
    // THE PAGE SHOWS A DEPOSIT, BUILDS ITS ENTRY, OR REFUSES - whichever it does first.
    let s = await until(120000, (x) => x.deposit || x.entry || x.refused || x.pageError);
    if (s.deposit) {
      timings.depositShownMs = Date.now() - t0;
      depositView = s.depositView;
      await b.shot(`${P}/${label}-deposit.png`);
      deposits.push({ amountMsat: s.deposit.amountMsat, paid: await lncliPay(s.deposit.invoice) });
      if (label.startsWith('reload') || label.startsWith('relock')) {
        // THE RELOADED TAB: it either asks for a deposit again, or locks with what it recovered.
        s = await until(180000, (x) => x.reloadedDoc && (x.deposit || x.entry || x.refused || x.pageError));
        timings.reloadedDecidedMs = Date.now() - t0;
        if (s.reloadedDoc && s.deposit) {
          deposits.push({ amountMsat: s.deposit.amountMsat, paid: await lncliPay(s.deposit.invoice), afterReload: true });
          s = await until(120000, (x) => x.entry || x.refused || x.pageError);
        }
      } else {
        s = await until(120000, (x) => x.entry || x.refused || x.pageError);
      }
      timings.lockedMs = Date.now() - t0;
    }
    // AND ONCE UNITY HAS IT, THE SESSION POSTS THE ENTRY AND HANDS THE LOCK TO THE SEATS.
    const reqs = () => [...b.requests.values()];
    const posted = (p) => reqs().filter((q) => q.method === 'POST' && pathOf(q) === p);
    for (let t = Date.now(); Date.now() - t < 240000 && !s.refused && !s.pageError; await wait(1000)) {
      if (s.lock ? posted('/lock').filter((q) => q.status).length >= 2 : posted('/entry').length && posted('/entry').every((q) => q.status)) break;
    }
    const lockPosts = posted('/lock');
    const eid = lockPosts.length ? new URL(lockPosts[lockPosts.length - 1].url).searchParams.get('entry') : null;
    const seats = [round.a, round.b];
    const rid = fromHex(round.id);
    const receiptsOf = () => (eid ? seats.map((d) => { try { return d.round.receipts(rid, fromHex(eid)).count; } catch (e) { return `? ${e.message}`; } }) : [null, null]);
    // WHAT EACH SEAT STORED. The daemons are fresh for every run, so every
    // batch and checkpoint in them is this player's.
    const stored = () => seats.map((d) => { try {
      const n = (t) => d.round.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
      return { batches: n('batches'), checkpoints: n('checkpoints') };
    } catch (e) { return `? ${e.message}`; } });
    // AND PLAY, as a player starts it (screen.mjs's clicks on the same build):
    // PLAY on the title, AUTO to fill the bed, depart, and six seconds of
    // throttle. Only then is there a run whose batches a seat can take or refuse.
    const beforePlay = eid ? { receipts: receiptsOf(), stored: stored() } : null;
    if (s.lock) {
      await b.click(486, 554); await wait(3000);
      await b.click(303, 617); await wait(1200);
      await b.click(660, 617); await wait(2000);
      await b.key('keyDown'); await wait(6000); await b.key('keyUp'); await wait(2000);
    }
    // THE PLAYER'S VIEW AFTER THE LOCK, and whether play is taken: the chip
    // counts the seats that saw the stake, and a seat that took the run's
    // batches returns checkpoint receipts for it.
    let view = {};
    for (let t = Date.now(); Date.now() - t < 60000; await wait(1000)) {
      view = JSON.parse(await b.evaluate(VIEW) || '{}');
      const r = receiptsOf();
      if (!eid || ((view.chip || '').includes('committed') && r.every((x) => typeof x === 'number' && x > 0))) break;
    }
    if (s.lock) await b.shot(`${P}/${label}-playing.png`);
    const entry = await b.evaluate(`(() => { const e = window.BLWP_ENTRY; if (!e) return null; const h = BLWPCLIENT.toHex;
      return { outpoint: h(e.stakeLockOutpoint.txid) + ':' + String(e.stakeLockOutpoint.outIdx) }; })()`);
    const lock = await b.evaluate(`(() => { const l = window.BLWP_STAKE_LOCK; return l ? BLWPCLIENT.toHex(l.outpoint.txid) + ':' + String(l.outpoint.outIdx) : null; })()`);
    let federation = null;
    if (lock) {
      const [txid, outIdx] = lock.split(':');
      const st = await port.status({ txid: fromHex(txid), outIdx: BigInt(outIdx) });
      federation = st && st.stored ? { holds: true, blocksLeft: st.stored.blocksLeft, blockCount: st.blockCount } : { holds: false };
    }
    const exceptions = b.logs.filter((l) => l.startsWith('EXCEPTION'));
    const facts = {
      run: label, seatRefused: s.refused || null, pageError: s.pageError || null, deposits, depositView,
      holding: b.logs.filter((l) => /stake lock: (holding|recovering)/.test(l)).map((l) => l.replace('[blwp] stake lock: ', '')),
      lockMadeAt: lock, entryOutpoint: entry && entry.outpoint,
      entryOutpointIsZero: entry ? /^0{64}:0$/.test(entry.outpoint) : null,
      entryNamesTheLock: !!(entry && lock && entry.outpoint === lock), federation,
      lockClientLoaded: reqs().filter((q) => /blwp_lock_client/.test(q.url)).map((q) => `${pathOf(q)} ${q.status}`),
      handouts: posted('/handout').map((q) => q.status), entries: posted('/entry').map((q) => q.status),
      locks: lockPosts.map((q) => q.status),
      committedMsat: eid ? seats.map((d) => { const seen = d.round.stakeSeen(fromHex(eid)); return seen ? String(seen.paidMsat) : null; }) : [null, null],
      beforePlay, afterPlay: eid ? { receipts: receiptsOf(), stored: stored() } : null,
      chip: view.chip ? view.chip.split('\n').pop() : null, panel: view.panel || null,
      batchesRefused: view.refusedWhy || null,
      exceptions: exceptions.length, firstException: exceptions.length ? exceptions[0].split('\n').slice(0, 3).join(' | ') : null,
      timings,
    };
    say(facts);
    return facts;
  } finally {
    b.close();
    await round.close();
    page.server.close();
    console.log(`--- ${label}: page console ---`);
    for (const l of b.logs) if (/\[blwp\]|EXCEPTION|lock|refused/i.test(l) && !/\[seat\]/.test(l)) console.log('   ', l.slice(0, 400));
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
