// THE PAGE'S OWN JOIN OF A ROUND WHOSE STAKE GOES INTO A FEDERATION LOCK (W1b),
// in a real browser, on a real federation. A TOOL, not a test: it wants a built
// page on disk, a headless Chrome, and the federation page-lock-regtest.sh
// stands up (stock fedimintd 0.12.0, one gateway, regtest).
//
//   node tools/page-lock.mjs label=<page dir> ...
//
// Each run is the Daily's own 2-of-2 round (`standUpRound`: bonded signer nodes, a
// census, a published round) naming the federation, both signer nodes holding the
// attested claim key and the real stake-lock port. The page is opened on the
// round's link, as a player opens it; the harness pays the deposit invoice the
// page shows (the player's wallet), and reads everything else off the browser -
// what the page built and showed, every request it made - and off the signer nodes and
// the federation. Labels:
//   nolock...  the page served with its lock step switched off (the mutant)
//   reload...  the tab is reloaded once, after the deposit and before the lock
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import WebSocket from 'ws';

import { standUpRound } from '../../arena-node/tools/round-2of2.mjs';
import { stakeLockPort } from '../../arena-node/src/stake-lock-port.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
// THE collect LABEL (6d leftover 2): a winner played from Node beside the real tab.
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { replay } from '../../arena-node/src/replay.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { wordsAt, GENESIS_HASH, secretScalar, say as tell } from '../../arena-node/test/window-fixture.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { startDeadlineOf } from '../../arena-protocol/src/first-mark.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { lockFromClient } from '../src/lock-result.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { lookOwed, owedToLine, tabLockWallet } from '../src/page-lock.js';

const env = process.env;
const P = env.PROBE;
const CHROME = env.CHROME || '/home/operator/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
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
// NO CLAIM KEY IS HANDED TO THE SIGNER NODES: they make the round's key themselves
// when they are assigned to it, and the page attests and locks to that key.
// ONE CLIENT DATABASE, ONE CALL AT A TIME: both signer nodes share this port, and two signer nodes
// settling at once cannot share one database (settle-live gives each its own).
const serialized = (p) => {
  let q = Promise.resolve();
  const w = {};
  for (const k of Object.keys(p)) w[k] = typeof p[k] === 'function' ? (...a) => (q = q.then(() => p[k](...a), () => p[k](...a))) : p[k];
  return w;
};
const port = serialized(stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` }));
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
      if (s === 'locking the stake' && !sessionStorage.getItem('arena.harness.reloaded')) {
        sessionStorage.setItem('arena.harness.reloaded', '1');
        setTimeout(function () { location.reload(); }, 0);
        throw new Error('harness: the tab went away before the lock');
      }
      step(s);
    } }));
  };
})();</script>`;
// THE RELOAD AFTER THE LOCK: once, the moment the page has made its lock and
// before Unity's session posts the entry - the window where a signer node has not yet
// committed it.
const RELOAD_AFTER_LOCK = `<script>(function () {
  var t = setInterval(function () {
    if (window.BLWP_STAKE_LOCK && !sessionStorage.getItem('arena.harness.reloaded')) {
      sessionStorage.setItem('arena.harness.reloaded', '1');
      clearInterval(t);
      location.reload();
    }
  }, 20);
})();</script>`;
// PICK (a)'s DOOR, SEEN FROM A REAL PAGE: the page locks its stake as it always does, but
// brings no fee lock - what a client that does not mint would do. Harness instrumentation in
// the served page: it wraps lockStake and drops the fee lock from what it returns.
const NO_FEE_LOCK = `<script>(function () {
  var real = BLWPCLIENT.lockStake;
  BLWPCLIENT.lockStake = function (o) {
    return real(o).then(function (m) { console.log('[harness] the fee lock dropped from the join'); return Object.assign({}, m, { feeLock: null }); });
  };
})();</script>`;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const servePageAs = (dir, label) => new Promise((ok) => {
  const s = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    let body;
    try { body = readFileSync(join(dir, p.replace(/\.\.+/g, ''))); } catch { res.writeHead(404); return res.end('no'); }
    if (p === '/index.html' && (label.startsWith('nolock') || label.startsWith('reload') || label.startsWith('relock') || label.startsWith('nofee'))) {
      let html = body.toString('utf8');
      if (label.startsWith('nofee')) {
        html = html.replace('<script src="arena-client.js"></script>', '<script src="arena-client.js"></script>' + NO_FEE_LOCK);
      } else if (label.startsWith('nolock')) {
        if (!html.includes(LOCK_STEP)) { res.writeHead(500); return res.end('this page has no lock step to switch off'); }
        html = html.replace(LOCK_STEP, 'if (false) {\n          const depositEl');
      } else {
        html = html.replace('<script src="arena-client.js"></script>', '<script src="arena-client.js"></script>'
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
  // CHROME'S OWN WORDS ARE KEPT (the collect runs' tab answered nothing for 6 min with an
  // empty console, twice): the stderr tail and the page's lifecycle, for diag().
  let stderrTail = '';
  const lifecycle = [];
  const dialogs = [];
  const t0 = Date.now();
  const debugPort = await new Promise((r) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; stderrTail = (stderrTail + d).slice(-4000); const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) r(m[1]); }); });
  chrome.on('exit', (code, sig) => lifecycle.push(`${Math.round((Date.now() - t0) / 1000)}s chrome exited ${code} ${sig}`));
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
    if (m.method === 'Page.lifecycleEvent' || m.method === 'Inspector.targetCrashed' || m.method === 'Page.loadEventFired')
      lifecycle.push(`${Math.round((Date.now() - t0) / 1000)}s ${m.method === 'Page.lifecycleEvent' ? m.params.name : m.method}`);
    // A MODAL DIALOG STOPS THE PAGE'S MAIN THREAD, and nothing else answers it: the join's
    // donation choice asks by window.prompt / window.confirm (index.html). Recorded, and
    // answered with its default - what a player pressing OK does.
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push({ at: `${Math.round((Date.now() - t0) / 1000)}s`, type: m.params.type, message: String(m.params.message).slice(0, 300),
        defaultPrompt: m.params.defaultPrompt || '' });
      try { ws.send(JSON.stringify({ id: ++n, method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: m.params.defaultPrompt || '' } })); } catch { /* recorded */ }
    }
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
  const reload = () => send('Page.reload', { ignoreCache: false });
  try { await send('Page.setLifecycleEventsEnabled', { enabled: true }); await send('Inspector.enable'); } catch { /* diag only */ }
  const diag = () => ({ requests: requests.size,
    lastRequests: [...requests.values()].slice(-8).map((q) => `${q.method} ${(() => { try { return new URL(q.url).pathname; } catch { return q.url; } })()} ${q.status}`),
    pending: [...requests.values()].filter((q) => q.status === null).map((q) => { try { return new URL(q.url).pathname; } catch { return q.url; } }).slice(-8),
    lifecycle: lifecycle.slice(-12), dialogs, lastConsole: logs.slice(-6).map((l) => l.slice(0, 200)), stderr: stderrTail.slice(-600) });
  return { evaluate, shot, click, key, requests, logs, close, reload, diag };
}

// 6d LEFTOVER 2: A REAL JOIN TO THE COLLECT. The real tab joined, deposited, locked and
// played (a browser run has never delivered - daily-close-look - so it is the loser);
// a seed-derived winner is played from Node beside it with settle-live's code; the
// signer nodes close; what the real tab's own collect then shows, and what it does on a reload.
const transcriptOf = (n) => ({ ticks: Array.from({ length: n }, (_, t) => ({ tick: t, words: wordsAt(t) })), liquidations: [] });
function worldFor(base, lastTick, roundRandomness) {
  for (let i = 0; i < 600; i++) {
    const worldSecret = new Uint8Array(32); worldSecret[0] = i & 255; worldSecret[1] = i >> 8; worldSecret[31] = 0xd1;
    const entry = { ...base, worldSecret };
    const r = replay(transcriptOf(3000), entry, { roundRandomness });
    if (!r.ok || r.outcome !== 'DELIVERED' || r.score < 1) continue;
    for (let n = 60; n <= lastTick; n += 60) {
      const s = replay(transcriptOf(n), entry, { roundRandomness });
      if (s.ok && s.outcome === 'DELIVERED') return { worldSecret, ticks: n, score: r.score };
    }
  }
  throw new Error(`no world in 600 where the drive is DELIVERED by tick ${lastTick}`);
}
const tabView = (b) => b.evaluate(`JSON.stringify({ lockJoin: !!window.BLWP_LOCK_JOIN, stakeLock: !!window.BLWP_STAKE_LOCK,
  refused: window.BLWP_JOIN_REFUSED || null, join: window.BLWP_JOIN || null,
  // WHAT THE PAGE LOOKED AT (W4 / 6d): its lookOwed - nothing spent until the player's Withdraw.
  owed: window.BLWP_OWED || null,
  settled: (document.getElementById('blwp-settled') || {}).textContent || '' }, (k, v) => (typeof v === 'bigint' ? String(v) : v))`)
  .then((x) => JSON.parse(x || '{}'));

async function collectAfterRealJoin({ b, round, label, playerLock }) {
  const c = round.contract;
  const rid = fromHex(round.id);
  const urls = round.nodes;
  const signerNodePorts = [round.a.port, round.b.port];
  const res = {};
  const rr = new Uint8Array(await (await fetch(`${urls[0]}/randomness?round=${round.id}`)).arrayBuffer());
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const { LockClient } = createRequire(import.meta.url)(`${env.WASM_PKG}/blwp_lock_client.js`);
  const kept = new Map();
  const memStore = { entries: () => JSON.stringify([...kept]), put: (k, v) => { kept.set(k, v); }, remove: (k) => { kept.delete(k); } };
  const lc = await LockClient.join(env.INVITE, LockClient.federationIdOf(env.INVITE), toHex(crypto.getRandomValues(new Uint8Array(32))), memStore);
  const rcv = JSON.parse(await lc.receive('1200000', env.GATEWAY));
  res.winnerDeposit = { paid: await lncliPay(rcv.invoice), final: await lc.awaitReceive(rcv.operation) };
  const claimPk = round.a.dkg.signerNodeFor(c.nodes).pool.groupPublicKey;
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const playerPubkey = playerFor({ ...c, id: rid }, { seed, curve: pageCurve }).pubkey;
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = crypto.getRandomValues(new Uint8Array(32));
  const dealt = await dealHandout({ preimage, signerNodes: c.nodes, roundId: rid, playerPubkey, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: [scalarFrom32(crypto.getRandomValues(new Uint8Array(32))) % FIELD], needed: 2, curve: feldmanGroup });
  const stakeMsat = c.stakeMsat;
  const base = { roundId: rid, playerPubkey, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(preimage), stakeMsat,
    feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n, joinTick: 0, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    claimKeyAttestationRef: new Uint8Array(32).fill(0x9a) };
  const zeros = { txid: new Uint8Array(32), outIdx: 0n };
  // THE ROUND'S OWN FIRST-MARK DEADLINE, as the signer nodes read it (round.js; a real bonded round's
  // contract has no startDeadlineTicks field - measured, "by tick undefined"). It bounds the
  // FIRST mark only (measured: 900 ticks here, and no world delivers by then); the drive
  // delivers later, in a second leg chained to it, as close-retry.test.js chains one.
  const deadline = startDeadlineOf(c);
  const world = worldFor({ ...base, feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32).fill(1), outIdx: 0n }, feeLockOutpoint: zeros },
    3000, rr);
  const refundPk = refundKeyOf(playerPubkey);
  const net = netStakeMsat({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n });
  const stake = lockFromClient(await lc.lock(toHex(base.stakePoint), String(net), toHex(claimPk), toHex(refundPk), Number(c.stakeExpiryBlocks) + 6),
    { point: base.stakePoint, claimPk, refundPk });
  // AND ITS FEE LOCK WHEN THE GATE MINTS ONE, as the page and settle-live's players do. Measured
  // without it: the signer nodes' one settlement refused the whole round - "an entry's fee lock was
  // never verified, so the fee cannot be claimed" - once any fee lock in it was verified.
  const rule = JSON.parse(await lc.feeRule());
  const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) } });
  let fee = null;
  let F = new Uint8Array(32);
  if (gate.pays) {
    F = crypto.getRandomValues(new Uint8Array(32));
    fee = lockFromClient(await lc.lockHash(toHex(sha256(F)), String(entryFeeMsat(stakeMsat)), toHex(claimPk), toHex(refundPk), Number(c.stakeExpiryBlocks) + 6),
      { hash: sha256(F), claimPk, refundPk });
  }
  const entry = { ...base, worldSecret: world.worldSecret, feePreimage: F, stakeLockOutpoint: stake.outpoint, feeLockOutpoint: fee ? fee.outpoint : zeros };
  const eid = entryId(entry);
  // THE WINNER'S DRIVE IN LEGS: a first batch and first mark inside the deadline, then (when it
  // delivers after it) a second batch chained to the first and a second mark chained to the first mark.
  const sessionPubkey = ed25519.getPublicKey(session);
  const hashOf = (s) => Uint8Array.from(stateHash(s).match(/../g).map((x) => parseInt(x, 16)));
  const first = world.ticks <= deadline ? world.ticks : Math.min(600, deadline - 60);
  const st = init(seedWordForEntry(entry, rr));
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: first }, (_, t) => wordsAt(t)), liquidations: [] };
  for (let t = 0; t < first; t++) step(st, ...wordsAt(t));
  const m1 = { roundId: rid, entryId: eid, tick: first, stateHash: hashOf(st), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey };
  const legs = [[b1, m1]];
  if (world.ticks > first) {
    const b2 = { roundId: rid, entryId: eid, previousHash: batchId(b1), firstTick: first, ticks: Array.from({ length: world.ticks - first }, (_, t) => wordsAt(first + t)), liquidations: [] };
    for (let t = first; t < world.ticks; t++) step(st, ...wordsAt(t));
    const m2 = { roundId: rid, entryId: eid, tick: world.ticks, stateHash: hashOf(st), inputChainHash: batchId(b2), previousHash: checkpointId(m1), sessionPubkey };
    legs.push([b2, m2]);
  }
  const handed = [];
  for (const sp of signerNodePorts) {
    const at = `http://127.0.0.1:${sp}`;
    const h = await fetch(`${at}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const en = await fetch(`${at}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    const lk = await fetch(`${at}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(stake.fields)) });
    const fl = fee ? await fetch(`${at}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fee.fields)) }) : null;
    const played = [];
    for (const [b, m] of legs) {
      const took = await tell(sp, encodeInputBatch(b));
      const receipt = await tell(sp, joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session)));
      played.push(`batch to ${b.firstTick + b.ticks.length}: ${took === String(b.firstTick + b.ticks.length) ? 'taken' : String(took).slice(0, 120)}, `
        + `mark ${m.tick}: ${receipt.length === SIGNED_RECEIPT_BYTES ? 'receipted' : String(receipt).slice(0, 120)}`);
    }
    handed.push({ handout: h.status, entry: en.status === 201 ? 201 : `${en.status} ${(await en.text()).slice(0, 160)}`,
      lock: lk.status === 201 ? 201 : `${lk.status} ${(await lk.text()).slice(0, 160)}`,
      feeLock: fl ? (fl.status === 201 ? 201 : `${fl.status} ${(await fl.text()).slice(0, 160)}`) : 'none (the gate)', played });
  }
  res.winner = { playerKey: toHex(playerPubkey).slice(0, 16), gate: gate.pays ? `mints ${gate.lockMsat} msat` : `no fee lock: ${gate.why}`,
    world: `DELIVERED by tick ${world.ticks}, score ${world.score}; first mark at ${first} (deadline ${deadline})`,
    lock: `${toHex(stake.outpoint.txid).slice(0, 16)}…:${stake.outpoint.outIdx} ${stake.fields.amountMsat} msat`, signerNodes: handed };
  res.realTabBeforeClose = await tabView(b);

  const closedAt = Date.now();
  res.closed = await Promise.all(signerNodePorts.map((sp) => tell(sp, `close ${round.id}`)));
  let got = null;
  for (const stop = Date.now() + 300000; Date.now() < stop; await wait(2000)) {
    got = await (await fetch(`${urls[0]}/lock-settlement?round=${round.id}`)).json();
    if (got.state === 'ACCEPTED' || got.state === 'REFUSED') break;
  }
  res.settlement = { state: got && got.state, why: got && got.why, afterCloseMs: Date.now() - closedAt,
    claims: got && got.moved && got.moved.claims, payouts: got && got.moved && got.moved.payouts.map((p) => ({ kind: p.kind, msat: p.msat })) };
  try { res.results = (await (await fetch(`${urls[0]}/results?round=${round.id}`)).text()).slice(0, 600); } catch (err) { res.results = err.message; }

  // THE REAL TAB'S OWN LOOK, off the state its own join set: final, or something owed to withdraw.
  let view = {};
  for (let t = Date.now(); Date.now() - t < 180000; await wait(2000)) {
    view = await tabView(b);
    if (view.owed && (view.owed.final || view.owed.owedMsat !== '0')) break;
  }
  await b.shot(`${P}/${label}-collected.png`);
  const [ltx, lix] = playerLock ? playerLock.split(':') : [null, null];
  const lst = ltx ? await port.status({ txid: fromHex(ltx), outIdx: BigInt(lix) }) : null;
  res.realTab = { ...view, itsLockStillHeld: lst ? !!lst.stored : null, screenshot: `${P}/${label}-collected.png` };

  // AND THE WINNER'S, from Node with the page's own look: the round did pay somebody - and the
  // look spends nothing, so the winner's lock is still held after it.
  const own = await tabLockWallet({ round: c, roundId: rid, invite: env.INVITE, seed, LockClient });
  const look = await lookOwed({ round: c, roundId: rid, seed, curve: pageCurve, nodes: urls, client: own });
  res.winnerOwed = { line: owedToLine(look), owedMsat: look.owedMsat, payoutMsat: look.payoutMsat, stakeMsat: look.stakeMsat,
    winnerLockStillHeld: !!(await port.status(stake.outpoint)).stored };

  // A RELOAD OF THE REAL TAB after the window (leftover 1 on a real join): the page runs its own join again.
  await b.reload();
  await wait(60000);
  res.realTabAfterReload = await tabView(b);
  await b.shot(`${P}/${label}-reloaded.png`);
  return res;
}

const pathOf = (q) => { try { return new URL(q.url).pathname; } catch { return q.url; } };

// WHAT THE PAGE HAS DONE AND SHOWS, read in whatever document is current (a
// reload resets the globals). `depositView` is whether the invoice a player
// must pay is on screen: something drawn, and the topmost thing at its centre.
const STATE = `JSON.stringify({
  deposit: window.BLWP_DEPOSIT || null, entry: !!window.BLWP_ENTRY, refused: window.BLWP_JOIN_REFUSED || null,
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
    signerNode: { stakeLocks: port }, ...(label.startsWith('collect') ? { objectionWindowMs: 3000n } : {}) });
  const b = await browse(round.url);
  const t0 = Date.now();
  const timings = {};
  const deposits = [];
  let depositView = null;
  // A PAGE STILL LOADING UNITY CAN HOLD ITS MAIN THREAD past one 30 s ask (measured: the
  // collect run's first ask timed out with nothing in the console); the poll asks again
  // until its own deadline rather than ending the run on one slow answer.
  const state = async () => { try { return JSON.parse(await b.evaluate(STATE) || '{}'); } catch (e) { return { slow: e.message }; } };
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
    // AND ONCE UNITY HAS IT, THE SESSION POSTS THE ENTRY AND HANDS THE LOCK TO THE SIGNER NODES.
    const reqs = () => [...b.requests.values()];
    const posted = (p) => reqs().filter((q) => q.method === 'POST' && pathOf(q) === p);
    for (let t = Date.now(); Date.now() - t < 240000 && !s.refused && !s.pageError; await wait(1000)) {
      if (s.lock ? posted('/lock').filter((q) => q.status).length >= 2 : posted('/entry').length && posted('/entry').every((q) => q.status)) break;
    }
    const lockPosts = posted('/lock');
    const eid = lockPosts.length ? new URL(lockPosts[lockPosts.length - 1].url).searchParams.get('entry') : null;
    const signerNodes = [round.a, round.b];
    const rid = fromHex(round.id);
    const receiptsOf = () => (eid ? signerNodes.map((d) => { try { return d.round.receipts(rid, fromHex(eid)).count; } catch (e) { return `? ${e.message}`; } }) : [null, null]);
    // WHAT EACH SIGNER NODE STORED. The daemons are fresh for every run, so every
    // batch and checkpoint in them is this player's.
    const stored = () => signerNodes.map((d) => { try {
      const n = (t) => d.round.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
      return { batches: n('batches'), checkpoints: n('checkpoints') };
    } catch (e) { return `? ${e.message}`; } });
    // AND PLAY, as a player starts it (screen.mjs's clicks on the same build):
    // PLAY on the title, AUTO to fill the bed, depart, and six seconds of
    // throttle. Only then is there a run whose batches a signer node can take or refuse.
    const beforePlay = eid ? { receipts: receiptsOf(), stored: stored() } : null;
    if (s.lock) {
      await b.click(486, 554); await wait(3000);
      await b.click(303, 617); await wait(1200);
      await b.click(660, 617); await wait(2000);
      await b.key('keyDown'); await wait(6000); await b.key('keyUp'); await wait(2000);
    }
    // THE PLAYER'S VIEW AFTER THE LOCK, and whether play is taken: the chip
    // counts the signer nodes that saw the stake, and a signer node that took the run's
    // batches returns checkpoint receipts for it.
    let view = {};
    for (let t = Date.now(); Date.now() - t < 60000; await wait(1000)) {
      try { view = JSON.parse(await b.evaluate(VIEW) || '{}'); } catch (e) { view = { slow: e.message }; }
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
      run: label, joinRefused: s.refused || null, pageError: s.pageError || null, deposits, depositView,
      holding: b.logs.filter((l) => /stake lock: (holding|recovering)/.test(l)).map((l) => l.replace('[blwp] stake lock: ', '')),
      lockMadeAt: lock, entryOutpoint: entry && entry.outpoint,
      entryOutpointIsZero: entry ? /^0{64}:0$/.test(entry.outpoint) : null,
      entryNamesTheLock: !!(entry && lock && entry.outpoint === lock), federation,
      lockClientLoaded: reqs().filter((q) => /blwp_lock_client/.test(q.url)).map((q) => `${pathOf(q)} ${q.status}`),
      handouts: posted('/handout').map((q) => q.status), entries: posted('/entry').map((q) => q.status),
      locks: lockPosts.map((q) => q.status),
      // THE PAGE'S FEE LOCK HANDED TO EACH SIGNER NODE (client.js keeps the answers to itself).
      feeLocks: posted('/fee-lock').map((q) => q.status),
      committedMsat: eid ? signerNodes.map((d) => { const seen = d.round.stakeSeen(fromHex(eid)); return seen ? String(seen.paidMsat) : null; }) : [null, null],
      beforePlay, afterPlay: eid ? { receipts: receiptsOf(), stored: stored() } : null,
      chip: view.chip ? view.chip.split('\n').pop() : null, panel: view.panel || null,
      batchesRefused: view.refusedWhy || null,
      exceptions: exceptions.length, firstException: exceptions.length ? exceptions[0].split('\n').slice(0, 3).join(' | ') : null,
      timings,
    };
    if (label.startsWith('collect') && s.lock) {
      try { facts.collect = await collectAfterRealJoin({ b, round, label, playerLock: lock }); }
      catch (e) { facts.collect = { error: e.message, stack: String(e.stack).split('\n').slice(1, 3).join(' | ') }; }
    }
    say(facts);
    return facts;
  } finally {
    // WHERE THE TAB WAS, whatever happened to the run.
    say({ run: label, diag: b.diag() });
    b.close();
    await round.close();
    page.server.close();
    console.log(`--- ${label}: page console ---`);
    for (const l of b.logs) if (/\[blwp\]|EXCEPTION|lock|refused/i.test(l) && !/\[signer node\]/.test(l)) console.log('   ', l.slice(0, 400));
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
