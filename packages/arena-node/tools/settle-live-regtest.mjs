// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WHOLE SETTLEMENT ON A REAL FEDERATION (W4): two signer nodes of a lock round, each
// with its own port on the stock fedimint 0.12.0 client (arena-stake-lock) and its
// own joined client; a winner and a loser whose stake locks - and fee locks, only
// where the gate says they pay a signer node - are made by the page's wasm lock client;
// both play to FINAL; the signer nodes' one settlement claims the loser's lock (and the fee
// locks), pays the winner and the sitting signer nodes, under one committee signature
// after the window. Run twice: a 100 sat round and a 1000 sat round.
// Driven by settle-live-regtest.sh (the federation, the gateway, the deposit).
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, writeSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { replay as replayUnder } from '../src/replay.js';
import { TRUCK } from '../../nextblock/plugin/nextblock.js';
// THE TRUCK'S RUNS, REPLAYED UNDER THE TRUCK (M3 R1): replay takes the core it runs under; these are truck runs.
const replay = (t, e, o = {}) => replayUnder(t, e, { core: TRUCK, ...o });
import { assumeAssigned } from '../test/assignment.js';
import { rand, b32, RANDOMNESS, WINDOW_MS, GENESIS_HASH, wordsAt, contractFor, say as tell, secretScalar, opts, wait } from '../test/window-fixture.js';
import { lockFromClient } from '../../arena-client/src/lock-result.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { playerFor } from '../../arena-client/src/join.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { redeemPayout, payoutLine, returnStake, stakeBackLine, withdrawCollected, withdrawLine, tabLockWallet, refundKept, refundLine } from '../../arena-client/src/page-lock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const env = process.env;
const P = env.PROBE;
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const curve = { ...feldmanGroup, tweakPoint };
const run = (bin, args, extra = {}) => new Promise((done) => execFile(bin, args, { timeout: 180000, ...extra }, (err, so, se) => done({ err, so: String(so), se: String(se) })));
const lncliPay = async (invoice) => (await run(`${env.LND_BIN}/lncli`,
  [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest', 'payinvoice', '--force', invoice])).so.match(/Payment status: [A-Z_]+/)?.[0] || '?';
const transcriptOf = (n) => ({ ticks: Array.from({ length: n }, (_, t) => ({ tick: t, words: wordsAt(t) })), liquidations: [] });
const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const require = createRequire(import.meta.url);
const { LockClient } = require(`${env.WASM_PKG}/blwp_lock_client.js`);

// SIGNER NODE B'S OWN CLIENT OF THE FEDERATION: two signer nodes settling at once cannot share one database.
const joinedB = await run(`${env.FEDIMINT_BIN}/fedimint-cli`, ['--data-dir', `${P}/client2`, 'join', env.INVITE], { env: { ...env, HOME: env.FEDIMINT_HOME } });
out({ step: 'signer node B joins the federation', ok: !joinedB.err, why: joinedB.err ? joinedB.se.trim().split('\n').pop() : 'joined' });
const ports = [stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` }), stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client2` })];

// THE PLAYERS' LOCK CLIENT (the page's wasm), funded once.
const held = new Map();
const memStore = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
const lc = await LockClient.join(env.INVITE, LockClient.federationIdOf(env.INVITE), toHex(rand(32)), memStore);
const rcv = JSON.parse(await lc.receive('5000000', env.GATEWAY));
const paid = await lncliPay(rcv.invoice);
out({ step: 'deposit', msat: 5000000, alice: paid, final: await lc.awaitReceive(rcv.operation), balanceMsat: await lc.balanceMsat() });
const rule = JSON.parse(await lc.feeRule());
const fees = { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) };
out({ step: 'the federation\'s fee rule', rule });

// THE GUARDIANS' BLOCK COUNT REACHES THE CHAIN BEFORE ANY LOCK. The setup mines in
// batches, and the federation's consensus count comes after: a lock made below it is
// short of what a signer node checks it against (measured twice: "expires at 452, before
// 315 + 144", then "before 314 + 144" - after three reads 5 s apart had agreed on
// 302, so the count does not creep, it holds and jumps). Measured here against
// bitcoind's own height: every 5 s, both signer nodes' counts and the chain's, until the
// guardians' reach the chain (or 300 s).
const nowhere = { txid: new Uint8Array(32), outIdx: 0n };
const countsNow = async () => Promise.all(ports.map(async (p) => (await p.status(nowhere)).blockCount));
const chainHeight = async () => Number((await run(`${env.BITCOIN_BIN}/bitcoin-cli`,
  ['-regtest', '-rpcport=30101', '-rpcuser=arena', '-rpcpassword=arena', 'getblockcount'])).so.trim());
{
  const t = Date.now();
  const seen = [];
  for (; Date.now() - t < 300000; await wait(5000)) {
    const [a, b] = await countsNow();
    const chain = await chainHeight();
    seen.push(`${Math.round((Date.now() - t) / 1000)}s ${a}/${b} chain ${chain}`);
    if (a >= chain && b >= chain) break;
  }
  out({ step: 'the guardians\' block count against the chain', reads: seen.length, first: seen[0], last: seen[seen.length - 1],
    changes: seen.filter((s, i) => i === 0 || s.split(' ').slice(1).join(' ') !== seen[i - 1].split(' ').slice(1).join(' ')) });
}

/**
 * A world secret under which the signer nodes' own replay says `want` for this entry, and the
 * tick it is reached by - no later than `lastTick`, the round's first-mark deadline:
 * the driver sends one first mark, and past that line a signer node refuses it as FORFEIT
 * (measured: a loser world decided at tick 2040, deadline 1400).
 */
function worldFor(base, want, lastTick) {
  for (let i = 0; i < 600; i++) {
    const worldSecret = new Uint8Array(32); worldSecret[0] = i & 255; worldSecret[1] = i >> 8; worldSecret[31] = want === 'DELIVERED' ? 0xd1 : 0xf1;
    const entry = { ...base, worldSecret };
    const r = replay(transcriptOf(3000), entry, { roundRandomness: RANDOMNESS });
    if (!r.ok || r.outcome !== want || (want === 'DELIVERED' && r.score < 1)) continue;
    for (let n = 60; n <= lastTick; n += 60) {
      const s = replay(transcriptOf(n), entry, { roundRandomness: RANDOMNESS });
      if (s.ok && s.outcome === want) return { worldSecret, ticks: n, score: r.score };
    }
  }
  throw new Error(`no world in 600 where the drive is ${want}`);
}

// 6d ON SCREEN (PAGE_DIR = a WebGL build): the built page in headless Chrome collects
// the payout itself. browse() and servePage() as page-lock.mjs (arena-client) has them.
const CHROME = env.CHROME || '/home/arena/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.data': 'application/octet-stream' };
let served = null;
const servePage = (dir) => served || (served = new Promise((ok) => {
  const s = createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    // THE PLAYER'S WALLET, ASKED FOR AN EXACT SUM (as the connected NWC wallet is): an invoice on alice's lnd.
    if (p === '/harness-invoice') {
      const msat = new URL(req.url, 'http://h').searchParams.get('msat');
      const made = /^\d+$/.test(msat || '') ? JSON.parse((await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest',
        'addinvoice', `--amt_msat=${msat}`, '--memo=blwp withdraw on screen'])).so || '{}') : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ payment_request: made.payment_request || null, r_hash: made.r_hash || null, msat }));
    }
    if (p === '/') p = '/index.html';
    let body;
    try { body = readFileSync(join(dir, p.replace(/\.\.+/g, ''))); } catch { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(body);
  });
  s.listen(0, '127.0.0.1', () => ok({ server: s, port: s.address().port }));
}));
// A PROFILE HANDED IN IS ONE BROWSER ACROSS STARTS (spec §24: the round's money is kept in the
// browser's storage, so the next start in the same profile must find it).
// REUSE: a browser started again on its profile brings back the tab it had open (measured: headless
// Chrome restores it after Browser.close and after a SIGKILL, and that tab takes the round's lock
// first). As a phone's browser coming back, the page drives the restored tab of this origin.
async function browse(url, { profile = mkdtempSync(join(tmpdir(), 'settle-live-chrome-')), reuse = false } = {}) {
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-sandbox', '--window-size=1280,800', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const debugPort = await new Promise((r) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (m) r(m[1]); }); });
  let target = null; let pages = [];
  if (reuse) await wait(2000);
  for (let i = 0; i < 40 && !target; i++) {
    pages = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).filter((t) => t.type === 'page');
    target = (reuse && pages.find((t) => t.url.startsWith(new URL(url).origin))) || pages.find((t) => t.url === 'about:blank') || pages[0] || null;
    if (!target) await wait(250);
  }
  const restored = !!(reuse && target && target.url.startsWith(new URL(url).origin));
  for (const t of pages) if (t.id !== target.id && t.url === 'about:blank') await fetch(`http://127.0.0.1:${debugPort}/json/close/${t.id}`).catch(() => null);
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.on('open', r));
  let n = 0;
  const pending = new Map();
  const logs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  const send = (method, params = {}) => new Promise((r, no) => {
    const i = ++n;
    const timer = setTimeout(() => { pending.delete(i); no(new Error(`the browser did not answer ${method} in 30 s`)); }, 30000);
    pending.set(i, (m) => { clearTimeout(timer); r(m); });
    try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { clearTimeout(timer); pending.delete(i); no(e); }
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const shot = async (file) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result) writeFileSync(file, Buffer.from(r.result.data, 'base64')); };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  // CLOSED AS A BROWSER CLOSES, so what the page kept in its storage is on disk for the next start
  // (a SIGKILL can lose the last writes); killed only if it has not exited within 10 s.
  const close = async () => {
    send('Browser.close').catch(() => {});
    await new Promise((r) => { if (chrome.exitCode !== null) return r(); const t = setTimeout(r, 10000); chrome.once('exit', () => { clearTimeout(t); r(); }); });
    try { ws.close(); } catch {} try { chrome.kill('SIGKILL'); } catch {}
  };
  const reload = () => send('Page.reload', { ignoreCache: false });
  return { evaluate, shot, logs, close, reload, restored };
}

/** The join state the page's own join sets for a lock round (index.html's lock branch), as one evaluated script. */
const injectFor = (p, c, rid, urls) => `(() => {
      window.ARENA_ROUND = ARENACLIENT.decodeRoundContract(ARENACLIENT.fromHex('${toHex(encodeRoundContract(c))}'));
      // THE LOCK AS THE JOIN HOLDS IT - every field lockFromClient gives the page (measured:
      // amount and expiry alone did not encode, and saveCollect kept nothing).
      window.ARENA_STAKE_LOCK = { outpoint: { txid: ARENACLIENT.fromHex('${toHex(p.stake.outpoint.txid)}'), outIdx: ${p.stake.outpoint.outIdx}n },
        fields: { paymentImage: { kind: 'point', bytes: ARENACLIENT.fromHex('${toHex(p.stake.fields.paymentImage.bytes)}') },
          amountMsat: ${p.stake.fields.amountMsat}n, claimPk: ARENACLIENT.fromHex('${toHex(p.stake.fields.claimPk)}'),
          refundPk: ARENACLIENT.fromHex('${toHex(p.stake.fields.refundPk)}'), expiration: ${p.stake.fields.expiration} } };
      window.ARENA_LOCK_JOIN = { invite: '${env.INVITE}', roundIdHex: '${toHex(rid)}', seed: ARENACLIENT.fromHex('${toHex(p.seed)}'), nodes: ${JSON.stringify(urls)} };
      // AND WHAT THE JOIN KEEPS for the collect - in the browser's storage, as index.html's vault() does.
      const saved = ARENACLIENT.saveCollect ? ARENACLIENT.saveCollect(window.localStorage,
        Object.assign({}, window.ARENA_LOCK_JOIN, { round: window.ARENA_ROUND, stakeLock: window.ARENA_STAKE_LOCK })) : 'no saveCollect in the bundle';
      // INSTRUMENTED (the reload pair did not move on 0.0.1236): what saveCollect swallows.
      const probe = (f) => { try { f(); return 'ok'; } catch (e) { return String(e && e.message || e); } };
      window.ARENA_HARNESS_SAVE = { saved,
        encodeRound: probe(() => ARENACLIENT.encodeRoundContract(window.ARENA_ROUND)),
        encodeLock: ARENACLIENT.lockFieldsToJson ? probe(() => ARENACLIENT.lockFieldsToJson(window.ARENA_STAKE_LOCK.fields)) : 'lockFieldsToJson not in the bundle',
        keys: Object.keys(window.localStorage) };
      return true; })()`;
// WHAT THE PAGE LOOKED AT (W4 / 6d): ARENA_OWED, its lookOwed - nothing spent until the Withdraw.
const OWED = '(window.ARENA_OWED || null)';
// THE PLAYER'S WALLET HANDED TO THE PAGE'S WITHDRAW: asked for an invoice of the exact sum, as the
// connected (NWC) wallet is - here alice's lnd, through the page server's /harness-invoice.
const MAKER = `async (msat) => { const r = await fetch('/harness-invoice?msat=' + msat); const j = await r.json();
  window.__harnessInvoice = j; return j.payment_request ? { ok: true, invoice: j.payment_request } : { ok: false, why: 'alice made no invoice' }; }`;
// A LONG PAGE PROMISE IS NEVER AWAITED INSIDE ONE BOUNDED ASK (each ask is 30 s; measured, the
// on-screen withdraw ran past it): started, it writes its answer on window, and short asks poll.
async function withdrawWith(b, arg) {
  await b.evaluate(`(window.__harnessWithdrawn = null, window.__harnessInvoice = null, window.ARENA_WITHDRAW(${arg})
    .then((w) => { window.__harnessWithdrawn = JSON.stringify(w, (k, v) => (typeof v === 'bigint' ? String(v) : v)); },
      (e) => { window.__harnessWithdrawn = JSON.stringify({ error: e.message }); }), true)`).catch(() => null);
  // 600 s: the page's Withdraw collects, redeems and pays out (live: collect 239.7 s + pay 90.6 s);
  // run A3's 180 s cut it off mid-Withdraw and the closed tab kept what it had collected.
  const t = Date.now(); let w = '';
  for (; Date.now() - t < 600000 && !w; await wait(1000)) w = await b.evaluate('window.__harnessWithdrawn || ""').catch(() => '');
  return { result: w ? JSON.parse(w) : null, ms: Date.now() - t };
}
const pageReady = async (b) => {
  for (let t = Date.now(); Date.now() - t < 90000; await wait(500))
    if (await b.evaluate(`typeof ARENACLIENT !== 'undefined' && !!ARENACLIENT.lookOwed && !!window.ARENA_CURVE`)) return true;
  return false;
};
// WHAT THE PAGE ACTUALLY HOLDS (instrumented: on 0.0.1236 the reload left 978000 + 980000 in
// the federation and even a fresh tab collected nothing, with no console line): the kept
// collect records, the tab's storage keys, ARENA_COLLECT, and the harness's own save probe.
const tabState = (b) => b.evaluate(`JSON.stringify({ lockJoin: !!window.ARENA_LOCK_JOIN, owed: ${OWED},
  settled: (document.getElementById('arena-settled') || {}).textContent || '',
  collects: (() => { try { return ARENACLIENT.savedCollects(window.sessionStorage).map((r) => ({ round: r.roundIdHex.slice(0, 12),
    locks: ARENACLIENT.roundLocks(r.round), lock: !!r.stakeLock, done: !!r.done })); } catch (e) { return 'savedCollects threw: ' + e.message; } })(),
  keys: (() => { try { return Object.keys(window.sessionStorage); } catch (e) { return e.message; } })(),
  collect: window.ARENA_COLLECT ? { round: window.ARENA_COLLECT.roundIdHex.slice(0, 12), lock: !!window.ARENA_COLLECT.stakeLock } : null,
  harnessSave: window.ARENA_HARNESS_SAVE || null },
  (k, v) => (typeof v === 'bigint' ? String(v) : v))`).then((s) => JSON.parse(s || '{}'));

/**
 * A RELOAD BEFORE THE COLLECT (6d leftover 1): the winner's tab is handed its join
 * state before the close, left until its collect has asked (the signer nodes have not
 * settled yet), and reloaded - what a player's refresh during the window is. The
 * round is then settled; what the reloaded page does is read after.
 */
async function tabReloadedBeforeClose({ p, c, rid, urls }) {
  const page = await servePage(env.PAGE_DIR);
  const b = await browse(`http://127.0.0.1:${page.port}/`);
  if (!(await pageReady(b))) { b.close(); return { error: 'the built page never loaded its client' }; }
  await b.evaluate(injectFor(p, c, rid, urls));
  let before = {};
  for (let t = Date.now(); Date.now() - t < 30000; await wait(1000)) { before = await tabState(b); if (before.owed) break; }
  await b.reload();
  return { b, before, reloadedReady: await pageReady(b), afterReloadAtOnce: await tabState(b) };
}

/**
 * ONE PLAYER'S TAB, ON SCREEN, CLOSED BEFORE THE WITHDRAW (W4 / 6d): the built page, handed the
 * join state its own join sets for a lock round (the round, its lock, and ARENA_LOCK_JOIN - the
 * invite, the round and the tab's seed) - harness instrumentation, as page-lock's reload mutants
 * are. The page's own lookThePayout looks; the tab is closed with no withdraw; what the federation
 * then holds; a fresh tab handed the same seed (the player's backup) and join record looks again;
 * a pasted invoice for the owed sum is refused; the page's own ARENA_WITHDRAW, with the player's
 * wallet handed in (alice's lnd asked for the exact sum, as the connected wallet is), collects and
 * pays out; that tab and a third one look after.
 */
async function collectOnScreen({ p, c, rid, urls, stakeMsat, held, payoutAt }) {
  const page = await servePage(env.PAGE_DIR);
  const open = async () => {
    const b = await browse(`http://127.0.0.1:${page.port}/`);
    if (!(await pageReady(b))) { const logs = b.logs.slice(-5); b.close(); return { error: 'the built page never had ARENACLIENT.lookOwed and ARENA_CURVE', logs }; }
    await b.evaluate(injectFor(p, c, rid, urls));
    return { b };
  };
  const federation = async () => ({ payoutHeld: payoutAt ? await held(payoutAt) : null, stakeLockHeld: await held(p.stake.outpoint) });
  const view = (b) => b.evaluate(`JSON.stringify({ owed: ${OWED}, settled: (document.getElementById('arena-settled') || {}).textContent || '',
    withdrawLine: (document.getElementById('arena-wallet-withdraw') || {}).textContent || '',
    withdrawOffered: (document.getElementById('arena-withdraw-go') || { style: {} }).style.display !== 'none',
    onScreen: (() => { const el = document.getElementById('arena-settled'); if (!el) return null; const r = el.getBoundingClientRect();
      const hit = r.width && r.height ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return { w: Math.round(r.width), h: Math.round(r.height), onTop: !!hit && (hit === el || el.contains(hit)) }; })(),
  }, (k, v) => (typeof v === 'bigint' ? String(v) : v))`).then((s) => JSON.parse(s || '{}'));
  // LOOKED: final, or both answers in (neither still waiting) with something owed.
  const looked = (o) => !!(o && o.owed && (o.owed.final
    || (o.owed.owedMsat !== '0' && o.owed.payout.state !== 'waiting' && o.owed.stake.state !== 'waiting')));
  const lookIn = async (b, done = looked, ms = 180000) => {
    const t = Date.now(); let o = {};
    for (; Date.now() - t < ms; await wait(1000)) { o = await view(b).catch((e) => ({ unread: e.message })); if (done(o)) break; }
    return { ...o, lookedMs: Date.now() - t };
  };
  const said = (b) => b.logs.filter((l) => /\[(?:arena|blwp)\] (owed|withdraw|payout|stake|refund)|EXCEPTION/.test(l)).map((l) => l.slice(0, 200)).slice(-8);
  const res = { round: `${stakeMsat / 1000n} sat`, page: p.want, onScreen: true, stakeLockMsat: p.stake.fields.amountMsat, federationAtStart: await federation() };

  // 1. THE FIRST TAB ONLY LOOKS - then three more of its 5 s loops - and is closed with no withdraw.
  const first = await open();
  if (first.error) return { ...res, error: first.error, logs: first.logs };
  try {
    res.firstTab = await lookIn(first.b);
    await wait(16000);
    res.firstTab.after16s = await view(first.b).catch((e) => ({ unread: e.message }));
    res.firstTab.federation = await federation();
    const shot = `${P}/owed-${stakeMsat / 1000n}sat-${p.want}-first.png`;
    await first.b.shot(shot); res.firstTab.screenshot = shot;
    res.firstTab.pageSaid = said(first.b);
  } finally { first.b.close(); }
  // 2. CLOSED: what the federation holds with the tab gone.
  await wait(2000);
  res.afterClose = await federation();

  // 3. A FRESH TAB, the same seed restored (the player's backup) and the join record.
  const fresh = await open();
  if (fresh.error) return { ...res, error: fresh.error, logs: fresh.logs };
  try {
    res.freshTab = await lookIn(fresh.b);
    res.freshTab.federation = await federation();
    if (res.freshTab.owed && res.freshTab.owed.owedMsat !== '0') {
      // 4a. A PASTED INVOICE FOR THE OWED SUM: refused, nothing collected (the paste rule).
      const owedMsat = res.freshTab.owed.owedMsat;
      const inv = JSON.parse((await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest',
        'addinvoice', `--amt_msat=${owedMsat}`, '--memo=blwp pasted for the owed sum'])).so || '{}');
      const pasted = inv.payment_request ? await withdrawWith(fresh.b, JSON.stringify(inv.payment_request)) : { result: { error: 'alice made no invoice' } };
      res.pastedForOwed = { invoiceMsat: owedMsat, ...pasted, federation: await federation(), owedAfter: (await view(fresh.b)).owed };
      // 4b. WITHDRAW with the player's wallet handed in: alice's lnd asked for the exact sum.
      const w = await withdrawWith(fresh.b, MAKER);
      const asked = JSON.parse(await fresh.b.evaluate('JSON.stringify(window.__harnessInvoice || {})').catch(() => '{}') || '{}');
      const seenAt = asked.r_hash ? JSON.parse((await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest',
        'lookupinvoice', asked.r_hash])).so || '{}') : {};
      res.withdraw = { ...w, invoiceAskedMsat: asked.msat, aliceInvoice: { state: seenAt.state, amtPaidMsat: seenAt.amt_paid_msat }, federation: await federation() };
      res.freshTabAfter = await lookIn(fresh.b, (o) => !!(o && o.owed && o.owed.final && o.owed.inTabMsat === '0'), 60000);
    }
    const shot = `${P}/owed-${stakeMsat / 1000n}sat-${p.want}-fresh.png`;
    await fresh.b.shot(shot); res.freshTab.screenshot = shot;
    res.freshTab.pageSaid = said(fresh.b);
  } finally { fresh.b.close(); }

  // 5. A THIRD TAB, same seed: what is left.
  const third = await open();
  if (!third.error) { try { res.thirdTab = await lookIn(third.b, (o) => !!(o && o.owed && o.owed.final), 120000); } finally { third.b.close(); } }
  res.federationAtEnd = await federation();
  return res;
}

/**
 * A WITHDRAWAL CLAIMED ON ANOTHER DEVICE, AND A WITHDRAW CUT OFF AFTER ITS COLLECT (spec §24,
 * 2026-09-14). alice's desktop looks and is closed with no withdraw; her "iPhone" - another
 * browser profile - holds only her seed (the page's importSeed) and runs the page's own scan over
 * the signer nodes (ARENA_FIND_OWED: /settled, its key matched locally); its Withdraw collects and is cut
 * off before the pay-out (the wallet never answers the invoice ask) and the browser is closed; the
 * phone's next start - the same profile - reopens the kept round and its wallet from the browser's
 * storage, and its Withdraw pays alice.
 */
async function claimOnAnotherDevice({ p, c, rid, urls, stakeMsat, held, payoutAt }) {
  const page = await servePage(env.PAGE_DIR);
  const url = `http://127.0.0.1:${page.port}/`;
  const desktop = mkdtempSync(join(tmpdir(), 'settle-live-desktop-'));
  const phone = mkdtempSync(join(tmpdir(), 'settle-live-phone-'));
  const federation = async () => ({ payoutHeld: payoutAt ? await held(payoutAt) : null, stakeLockHeld: await held(p.stake.outpoint) });
  const view = (b) => b.evaluate(`JSON.stringify({ owed: ${OWED}, settled: (document.getElementById('arena-settled') || {}).textContent || '',
    withdrawLine: (document.getElementById('arena-wallet-withdraw') || {}).textContent || '',
    forUnity: window.ARENA_WITHDRAW_AVAILABLE ? window.ARENA_WITHDRAW_AVAILABLE() : null,
    kept: Object.keys(window.localStorage).filter((k) => k.startsWith('arena.collect.')).length,
    step: window.ARENA_WITHDRAW_STEP || '' }, (k, v) => (typeof v === 'bigint' ? String(v) : v))`).then((x) => JSON.parse(x || '{}'));
  // THE LOBBY THE PHONE COMES BACK TO: a lobby link of the Daily's form (both signer nodes, the bond at signer node
  // A, the federation) - the advertisement a placeholder of its form, which the lobby never reads.
  const lobbyUrl = `${url}?node=${urls.join(',')}&bond=${urls[0]}/bond&advert=${'00'.repeat(64)}&federation=${env.INVITE}`;
  const lookIn = async (b, done, ms = 180000) => {
    const t = Date.now(); let o = {};
    for (; Date.now() - t < ms; await wait(1000)) { o = await view(b).catch((e) => ({ unread: e.message })); if (done(o)) break; }
    return { ...o, lookedMs: Date.now() - t };
  };
  const owedSome = (o) => !!(o && o.owed && o.owed.owedMsat !== '0' && o.owed.payout.state !== 'waiting' && o.owed.stake.state !== 'waiting');
  const said = (b) => b.logs.filter((l) => /\[(?:arena|blwp)\] (owed|withdraw|kept rounds)|EXCEPTION/.test(l)).map((l) => l.slice(0, 200)).slice(-8);
  const open = async (profile, { reuse = false, at = url } = {}) => {
    const b = await browse(at, { profile, reuse });
    if (!(await pageReady(b))) { const logs = b.logs.slice(-5); await b.close(); return { error: 'the built page never loaded its client', logs }; }
    return { b };
  };
  const res = { round: `${stakeMsat / 1000n} sat`, page: p.want, claimLater: true, federationAtStart: await federation() };

  // 1. THE DESKTOP: the join's state, the look, closed with no withdraw (alice forgets).
  const d = await open(desktop);
  if (d.error) return { ...res, error: d.error, logs: d.logs };
  try { await d.b.evaluate(injectFor(p, c, rid, urls)); res.desktop = await lookIn(d.b, owedSome); } finally { await d.b.close(); }
  res.afterDesktop = await federation();

  // 2. THE PHONE: another browser; only the seed brought in; the page's own scan over the signer nodes.
  const ph = await open(phone);
  if (ph.error) return { ...res, error: ph.error, logs: ph.logs };
  try {
    res.phone = { keptBefore: (await view(ph.b)).kept };
    await ph.b.evaluate(`(ARENACLIENT.importSeed('${toHex(p.seed)}', { storage: window.sessionStorage }), true)`);
    const t = Date.now();
    res.phone.found = await ph.b.evaluate(`window.ARENA_FIND_OWED(${JSON.stringify(urls)}, '${env.INVITE}')`);
    res.phone.foundMs = Date.now() - t;
    Object.assign(res.phone, await lookIn(ph.b, owedSome));
    res.phone.federation = await federation();
    // 3. ITS WITHDRAW, CUT OFF AFTER THE COLLECT: the wallet never answers the invoice ask; the browser closes there.
    await ph.b.evaluate('(window.ARENA_WITHDRAW(async () => new Promise(() => {})), true)');
    const cut = await lookIn(ph.b, (o) => /invoice/.test(o.step || ''), 600000);
    res.cut = { step: cut.step, ms: cut.lookedMs, withdrawLine: cut.withdrawLine, federation: await federation() };
    res.phone.pageSaid = said(ph.b);
    const shot = `${P}/claim-phone-cut.png`;
    await ph.b.shot(shot); res.cut.screenshot = shot;
  } finally { await ph.b.close(); }

  // 4. THE PHONE'S NEXT START, the same profile, into the lobby: the kept round and its wallet from the
  // browser's storage, and what Unity's lobby says.
  const next = await open(phone, { reuse: true, at: lobbyUrl });
  if (next.error) return { ...res, error: next.error, logs: next.logs };
  try {
    res.nextStart = await lookIn(next.b, (o) => !!(o && o.owed && o.owed.inTabMsat && o.owed.inTabMsat !== '0'));
    res.nextStart.restoredTab = next.b.restored;
    // WHAT UNITY'S LOBBY DREW (SplashScreen reports it to the page twice a second): the withdrawal notice.
    const tU = Date.now(); let unity = null;
    for (; Date.now() - tU < 180000; await wait(2000)) {
      unity = await next.b.evaluate('JSON.stringify(window.ARENA_UNITY_LOBBY || null)').then((x) => JSON.parse(x || 'null')).catch(() => null);
      if (unity && unity.withdrawNotice) break;
    }
    res.unity = { ms: Date.now() - tU, drew: unity && { showing: unity.showing, lobby: unity.lobby, withdrawNotice: unity.withdrawNotice, you: unity.you, screen: unity.screen } };
    const lobbyShot = `${P}/claim-phone-lobby.png`;
    await next.b.shot(lobbyShot); res.unity.screenshot = lobbyShot;
    if (res.nextStart.owed && res.nextStart.owed.inTabMsat && res.nextStart.owed.inTabMsat !== '0') {
      const w = await withdrawWith(next.b, MAKER);
      const asked = JSON.parse(await next.b.evaluate('JSON.stringify(window.__harnessInvoice || {})').catch(() => '{}') || '{}');
      const seenAt = asked.r_hash ? JSON.parse((await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest',
        'lookupinvoice', asked.r_hash])).so || '{}') : {};
      res.withdraw = { ...w, invoiceAskedMsat: asked.msat, aliceInvoice: { state: seenAt.state, amtPaidMsat: seenAt.amt_paid_msat } };
      res.after = await lookIn(next.b, (o) => !!(o && o.owed && o.owed.final && o.owed.inTabMsat === '0'), 60000);
    }
    res.nextStart.pageSaid = said(next.b);
    const shot = `${P}/claim-phone-next.png`;
    await next.b.shot(shot); res.nextStart.screenshot = shot;
  } finally { await next.b.close(); }
  res.federationAtEnd = await federation();
  return res;
}

// W6 LIVE (W6_KILL=1): the signer nodes keep their stores in files, and the process is SIGKILLed the moment
// the real guardians have answered a signed settlement - before any signer node can write that answer down.
// What a restart needs (the signer nodes' ports, the round, what the settlement moves) is written first,
// synchronously; settle-live-w6-resume.mjs starts the signer nodes again on the same stores and ports.
const W6 = { state: {} };
const dyingAfterAnswer = (p, i) => Object.assign(Object.create(p), {
  async settle(args) {
    const r = await p.settle(args);
    if (!args.signature) return r;
    const kill = { signerNode: i, txid: r.txid, accepted: r.accepted, error: r.error || null, ...W6.state,
      claims: args.claims.map((c) => key(c.outpoint)), payouts: args.payouts.length };
    writeFileSync(`${P}/w6-kill.json`, JSON.stringify(kill));
    writeSync(1, JSON.stringify({ step: 'W6: the real guardians answered the signed settlement; SIGKILL before any signer node writes it', ...kill }) + '\n');
    process.kill(process.pid, 'SIGKILL');
    return r;
  },
});
async function round(stakeMsat) {
  const w6 = env.W6_KILL === '1';
  const mk = (i) => serve(openStore(w6 ? `${P}/signer node-${i}.sqlite` : ':memory:'), { plugins: [NEXTBLOCK], port: 0, ...opts, stakeLocks: w6 ? dyingAfterAnswer(ports[i], i) : ports[i], poolCurve: curve, finality: { everyMs: 250 } });
  const a = await mk(0); const b = await mk(1);
  W6.state.ports = [a.port, b.port];
  try {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
    }
    const c = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
      custody: 'FEDERATION', federationId: fromHex(LockClient.federationIdOf(env.INVITE)), minScore: 1, stakeMsat };
    const rid = roundId(c);
    W6.state.rid = toHex(rid);
    for (const d of [a, b]) {
      const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      if (r.status !== 201) throw new Error(`round: ${r.status} ${await r.text()}`);
      assumeAssigned(d.round, rid, c.nodes);
    }
    for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
    const claimPk = a.dkg.signerNodeFor(c.nodes).pool.groupPublicKey;
    const gate = feeLockPays({ contract: c, fees });
    out({ round: `${stakeMsat / 1000n} sat`, roundId: toHex(rid), gate: { mints: gate.pays, lock: gate.lockMsat, why: gate.why.slice(0, 110) } });

    const players = [];
    for (const want of ['DELIVERED', 'FAILED']) {
      // THE PAGE'S OWN PLAYER KEY, from a tab seed (6d: the page finds its payout by it).
      const seed = rand(32);
      const playerPubkey = playerFor({ ...c, id: rid }, { seed, curve: pageCurve }).pubkey;
      const session = ed25519.utils.randomSecretKey();
      const preimage = secretScalar();
      const e = rand(32);
      const dealt = await dealHandout({ preimage, signerNodes: c.nodes, roundId: rid, playerPubkey, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
        coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
      const base = { roundId: rid, playerPubkey, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(preimage), stakeMsat,
        feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n, joinTick: 0, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
        claimKeyAttestationRef: b32(0x9a) };
      const world = worldFor({ ...base, feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: b32(1), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n } }, want, c.startDeadlineTicks);
      const refundPk = refundKeyOf(playerPubkey);
      const net = netStakeMsat({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n });
      const stake = lockFromClient(await lc.lock(toHex(base.stakePoint), String(net), toHex(claimPk), toHex(refundPk), 150),
        { point: base.stakePoint, claimPk, refundPk });
      let fee = null; let F = new Uint8Array(32);
      if (gate.pays) {
        F = rand(32);
        fee = lockFromClient(await lc.lockHash(toHex(sha256(F)), String(entryFeeMsat(stakeMsat)), toHex(claimPk), toHex(refundPk), 150),
          { hash: sha256(F), claimPk, refundPk });
      }
      const entry = { ...base, worldSecret: world.worldSecret, feePreimage: F, stakeLockOutpoint: stake.outpoint,
        feeLockOutpoint: fee ? fee.outpoint : { txid: new Uint8Array(32), outIdx: 0n } };
      const eid = entryId(entry);
      const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: world.ticks }, (_, t) => wordsAt(t)), liquidations: [] };
      const st = init(seedWordForEntry(entry, RANDOMNESS));
      for (let t = 0; t < world.ticks; t++) step(st, ...wordsAt(t));
      const mark = { roundId: rid, entryId: eid, tick: world.ticks, stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
        inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
      const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
      const handed = [];
      for (const d of [a, b]) {
        const base2 = `http://127.0.0.1:${d.port}`;
        await fetch(`${base2}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
        const en = await fetch(`${base2}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
        if (en.status !== 201) throw new Error(`entry: ${en.status} ${await en.text()}`);
        const lk = await fetch(`${base2}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(stake.fields)) });
        const fl = fee ? await fetch(`${base2}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fee.fields)) }) : null;
        handed.push(`lock ${lk.status}${fl ? `, fee-lock ${fl.status}` : ''}`);
        if (lk.status !== 201) throw new Error(`signer node ${d.port} answered the stake lock ${lk.status}: ${await lk.text()}`);
        if (fl && fl.status !== 201) throw new Error(`signer node ${d.port} answered the fee lock ${fl.status}: ${await fl.text()}`);
        const took = await tell(d.port, signedBatchOf(input, (id) => ed25519.sign(id, session)));
        if (took !== String(world.ticks)) throw new Error(`the batch was not taken by signer node ${d.port}: ${took}`);
        const receipt = await tell(d.port, signedMark);
        if (receipt.length !== SIGNED_RECEIPT_BYTES) throw new Error(`the mark at tick ${world.ticks} was not receipted by signer node ${d.port}: ${typeof receipt === 'string' ? receipt : `${receipt.length} bytes`}`);
      }
      out({ player: want, expiration: stake.fields.expiration, countsAfterHandOver: await countsNow(), chain: await chainHeight(),
        stakeLock: `${key(stake.outpoint)} ${stake.fields.amountMsat} msat`, feeLock: fee ? `${key(fee.outpoint)} ${fee.fields.amountMsat} msat` : 'none (the gate)',
        world: `ticks ${world.ticks}`, signerNodes: handed });
      players.push({ want, seed, playerPubkey, stake, fee, eid });
    }

    // PICK (a) (2026-09-14): A THIRD PLAYER WHO LOCKS A STAKE AND BRINGS NO FEE LOCK. Where
    // the gate mints, each signer node must refuse the entry at the door - not joined, its stake not
    // counted, its lock still its own - and the two who brought theirs settle as before.
    let bare = null;
    // SKIP_REFUSED=1: no third player (its expiry refund mines ~160 blocks - the slow part of a run
    // that must fit one bounded call); run it alone with REFUSED_TAB_ONLY=1.
    if (stakeMsat >= 1000000n && env.SKIP_REFUSED !== '1') {
      const seed = rand(32);
      const playerPubkey = playerFor({ ...c, id: rid }, { seed, curve: pageCurve }).pubkey;
      const preimage = secretScalar();
      const e = rand(32);
      const dealt = await dealHandout({ preimage, signerNodes: c.nodes, roundId: rid, playerPubkey, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
        coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
      const entryBase = { roundId: rid, playerPubkey, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()), stakeCommitment: sha256(preimage), stakeMsat,
        feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n, joinTick: 0, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
        claimKeyAttestationRef: b32(0x9a), worldSecret: rand(32) };
      const refundPk = refundKeyOf(playerPubkey);
      const net = netStakeMsat({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n });
      const stake = lockFromClient(await lc.lock(toHex(entryBase.stakePoint), String(net), toHex(claimPk), toHex(refundPk), 150), { point: entryBase.stakePoint, claimPk, refundPk });
      const entry = { ...entryBase, feePreimage: new Uint8Array(32), stakeLockOutpoint: stake.outpoint, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n } };
      const eid = entryId(entry);
      const signerNodes = [];
      for (const d of [a, b]) {
        const at = `http://127.0.0.1:${d.port}`;
        await fetch(`${at}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
        const en = await fetch(`${at}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
        signerNodes.push({ entry: en.status, why: en.status === 201 ? 'joined' : await en.text(), stored: !!d.round.entry(eid), seen: !!d.round.stakeSeen(eid) });
      }
      bare = { stake, signerNodes, seed, preimage, handout: dealt.handout, playerPubkey };
      out({ round: `${stakeMsat / 1000n} sat`, check: 'a player with a stake lock and no fee lock, at the door',
        stakeLock: `${key(stake.outpoint)} ${stake.fields.amountMsat} msat`, signerNodes,
        joinedSet: [a, b].map((d) => d.round.entriesOf(rid).length) });
    }

    // 6d LEFTOVER 1: the winner's tab reloaded while its collect waits (RELOAD_BEFORE_COLLECT, 1000 sat).
    const urlsEarly = [a, b].map((d) => `http://127.0.0.1:${d.port}`);
    const reloaded = env.PAGE_DIR && env.RELOAD_BEFORE_COLLECT && stakeMsat >= 1000000n
      ? await tabReloadedBeforeClose({ p: players[0], c, rid, urls: urlsEarly }) : null;
    const closedAt = Date.now();
    await Promise.all([tell(a.port, `close ${toHex(rid)}`), tell(b.port, `close ${toHex(rid)}`)]);
    let got = null;
    for (const stop = Date.now() + 240000; Date.now() < stop; await wait(1000)) {
      got = await (await fetch(`http://127.0.0.1:${a.port}/lock-settlement?round=${toHex(rid)}`)).json();
      if (got.state === 'ACCEPTED' || got.state === 'REFUSED') break;
    }
    const atB = await (await fetch(`http://127.0.0.1:${b.port}/lock-settlement?round=${toHex(rid)}`)).json();
    const [winner, loser] = players;
    const held = async (o) => !!(await ports[0].status(o)).stored;
    const payoutsStored = [];
    if (got && got.moved) for (let i = 0; i < got.moved.payouts.length; i++) payoutsStored.push(await held({ txid: fromHex(got.moved.txid), outIdx: BigInt(i) }));
    const verifies = !!(got && got.signature) && schnorr.verify(fromHex(got.signature), fromHex(got.message), claimPk.subarray(1));
    out({
      round: `${stakeMsat / 1000n} sat`, settlement: got && got.state, why: got && got.why, signerNodeBHolds: atB.state, txid: got && got.txid,
      oneSignatureVerifiesUnderClaimKey: verifies, madeAfterCloseMs: got && got.madeMs ? got.madeMs - closedAt : null, windowMs: WINDOW_MS,
      moved: got && got.moved,
      federation: {
        loserStakeLockHeld: await held(loser.stake.outpoint), winnerStakeLockHeld: await held(winner.stake.outpoint),
        feeLocksHeld: await Promise.all(players.filter((p) => p.fee).map((p) => held(p.fee.outpoint))), payoutsStored,
      },
      winnerKey: toHex(refundKeyOf(winner.playerPubkey)).slice(0, 12), signerNodeKeys: c.nodes.map((k) => toHex(refundKeyOf(k)).slice(0, 12)),
    });

    if (reloaded) {
      // THE RELOADED TAB'S OWN FINAL ANSWERS, up to 240 s after the settlement. Measured: a fixed
      // 60 s cut the reloaded page off mid-collect (payout spent, stake not yet asked), where a
      // fresh tab's payout-then-stake takes 77-122 s. The time it took is printed.
      let after = {};
      const tAfter = Date.now();
      if (reloaded.b) {
        for (; Date.now() - tAfter < 240000; await wait(2000)) {
          after = await tabState(reloaded.b).catch((e) => ({ unread: e.message }));
          if (after.owed && (after.owed.final || after.owed.owedMsat !== '0')) break;
        }
        after.secondsAfterSettlement = Math.round((Date.now() - tAfter) / 1000);
      }
      const shotFile = `${P}/reload-before-collect-${stakeMsat / 1000n}sat.png`;
      if (reloaded.b) await reloaded.b.shot(shotFile);
      const q = got && got.moved ? got.moved.payouts.findIndex((x) => x.kind === 'qualifier') : -1;
      out({ round: `${stakeMsat / 1000n} sat`, check: 'the winner\'s tab reloaded before its collect', error: reloaded.error,
        beforeReload: reloaded.before, reloadedPageLoaded: reloaded.reloadedReady, atOnceAfterReload: reloaded.afterReloadAtOnce,
        sixtySecondsAfterSettlement: after, federation: {
          payoutStillHeld: q >= 0 ? await held({ txid: fromHex(got.moved.txid), outIdx: BigInt(q) }) : null,
          winnerStakeLockStillHeld: await held(winner.stake.outpoint) }, screenshot: shotFile });
      if (reloaded.b) reloaded.b.close();
    }

    // 6d: EACH PLAYER'S PAGE COLLECTS ITS PAYOUT - the page's own `redeemPayout`, from
    // its seed alone, into a fresh wallet of this federation. Counted: how often each
    // page asked its lock client to join (a loser's must be never).
    const urls = [a, b].map((d) => `http://127.0.0.1:${d.port}`);
    // WHERE THE SETTLEMENT PAYS THIS PLAYER'S KEY, if it does: the payout contract's outpoint.
    const payoutOf = (p) => {
      const i = got && got.moved ? got.moved.payouts.findIndex((x) => x.kind === 'qualifier' && String(x.pk).toLowerCase() === toHex(refundKeyOf(p.playerPubkey))) : -1;
      return i < 0 ? null : { txid: fromHex(got.moved.txid), outIdx: BigInt(i) };
    };
    for (const p of [winner, loser]) {
      // ON SCREEN FOR THE 1000 SAT ROUND when a build is named; the 100 sat round by Node.
      // ON_SCREEN=DELIVERED|FAILED: only that player in the browser, the other by Node (one bounded call).
      // CLAIM_LATER=1: the winner's money claimed on another device holding only the seed, and a Withdraw cut off after its collect.
      if (env.PAGE_DIR && stakeMsat >= 1000000n && env.CLAIM_LATER === '1' && p.want === 'DELIVERED') { out(await claimOnAnotherDevice({ p, c, rid, urls, stakeMsat, held, payoutAt: payoutOf(p) })); continue; }
      if (env.PAGE_DIR && stakeMsat >= 1000000n && env.REFUSED_TAB_ONLY !== '1' && (!env.ON_SCREEN || env.ON_SCREEN === p.want)) { out(await collectOnScreen({ p, c, rid, urls, stakeMsat, held, payoutAt: payoutOf(p) })); continue; }
      let joins = 0;
      const Counting = { join: (...args) => { joins++; return LockClient.join(...args); } };
      const r = await redeemPayout({ round: c, roundId: rid, invite: env.INVITE, seed: p.seed, curve: pageCurve, LockClient: Counting, nodes: urls });
      const at = r.outIdx !== undefined ? { txid: fromHex(r.txid), outIdx: BigInt(r.outIdx) } : null;
      out({ round: `${stakeMsat / 1000n} sat`, page: p.want, collected: r.ok, final: r.final, lockClientJoins: joins, outIdx: r.outIdx,
        payoutMsat: r.amountMsat, walletBefore: r.balance_before, walletAfter: r.balance_after,
        payoutStillHeldAfter: at ? await held(at) : null, screen: payoutLine(r) });
      // AND ITS OWN STAKE BACK BY THE SIGNER NODES' FORFEIT, into the same wallet (6d).
      const joinsBefore = joins;
      const heldBefore = await held(p.stake.outpoint);
      const back = await returnStake({ round: c, roundId: rid, invite: env.INVITE, seed: p.seed, curve: pageCurve, LockClient: Counting,
        nodes: urls, client: r.client || null });
      out({ round: `${stakeMsat / 1000n} sat`, page: p.want, stakeBack: back.ok, final: back.final, lockClientJoins: joins - joinsBefore,
        stakeLockMsat: p.stake.fields.amountMsat, returnedMsat: back.amountMsat, walletBefore: back.balance_before, walletAfter: back.balance_after,
        stakeLockHeldBefore: heldBefore, stakeLockHeldAfter: await held(p.stake.outpoint), screen: stakeBackLine(back) });
      // AND 6d'S DESTINATION: the tab's wallet withdrawn over Lightning to the player's own - an
      // invoice on alice's lnd (the gateway is on bob's), paid through the page's own withdrawCollected.
      const wallet = back.client || r.client;
      if (wallet && (r.ok || back.ok)) {
        let made = null;
        const wd = await withdrawCollected({ client: wallet, invoiceFor: async (msat) => {
          made = JSON.parse((await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest',
            'addinvoice', `--amt_msat=${msat}`, '--memo=blwp payout'])).so || '{}');
          return made.payment_request ? { ok: true, invoice: made.payment_request } : { ok: false, why: 'alice made no invoice' };
        } });
        const seen = made && made.r_hash ? JSON.parse((await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest',
          'lookupinvoice', made.r_hash])).so || '{}') : {};
        out({ round: `${stakeMsat / 1000n} sat`, page: p.want, withdraw: wd.state || (wd.ok ? 'Success' : 'none'), withdrawableMsat: wd.withdrawableMsat,
          gateway: wd.gateway, walletBefore: wd.balance_before, walletAfter: wd.balance_after,
          aliceInvoice: { state: seen.state, amtPaidMsat: seen.amt_paid_msat }, screen: withdrawLine(wd) });
      }
      if (back.client && back.client !== r.client && typeof back.client.free === 'function') back.client.free();
      if (r.client && typeof r.client.free === 'function') r.client.free();
    }
    // W4 / 6d: THE PLAYER THE DOOR REFUSED GETS ITS STAKE BACK BY ITS OWN KEY AFTER EXPIRY - the
    // page's own refundKept from its seed and tab wallet (no signer node ever verified the lock): before
    // the expiry it waits and says when; the chain is mined past it; then the refund, then the withdraw.
    // ON SCREEN (PAGE_DIR): THE REFUSED PLAYER'S OWN TAB - handed the two records its join keeps
    // (saveLock: the stake and its lock; saveCollect: the round, the signer nodes, the seed), then left to
    // its own collect loop: before the expiry it must say when; after it, refund by its own key.
    let tab = null;
    if (bare && env.PAGE_DIR) {
      const page = await servePage(env.PAGE_DIR);
      tab = await browse(`http://127.0.0.1:${page.port}/`);
      if (!(await pageReady(tab))) { out({ check: 'the refused tab', error: 'the built page never loaded its client' }); tab.close(); tab = null; }
      else {
        const f = bare.stake.fields;
        await tab.evaluate(`(() => {
          const round = ARENACLIENT.decodeRoundContract(ARENACLIENT.fromHex('${toHex(encodeRoundContract(c))}'));
          const seed = ARENACLIENT.fromHex('${toHex(bare.seed)}');
          const lock = { outpoint: { txid: ARENACLIENT.fromHex('${toHex(bare.stake.outpoint.txid)}'), outIdx: ${bare.stake.outpoint.outIdx}n },
            fields: { paymentImage: { kind: 'point', bytes: ARENACLIENT.fromHex('${toHex(f.paymentImage.bytes)}') }, amountMsat: ${f.amountMsat}n,
              claimPk: ARENACLIENT.fromHex('${toHex(f.claimPk)}'), refundPk: ARENACLIENT.fromHex('${toHex(f.refundPk)}'), expiration: ${f.expiration} } };
          ARENACLIENT.saveLock(window.sessionStorage, { roundId: ARENACLIENT.fromHex('${toHex(rid)}'), playerPubkey: ARENACLIENT.fromHex('${toHex(bare.playerPubkey)}'),
            stake: { preimage: ARENACLIENT.fromHex('${toHex(bare.preimage)}'), body: ARENACLIENT.fromHex('${toHex(encodeHandout(bare.handout))}') }, lock });
          ARENACLIENT.saveCollect(window.sessionStorage, { roundIdHex: '${toHex(rid)}', round, invite: '${env.INVITE}', nodes: ${JSON.stringify(urls)}, seed, stakeLock: lock });
          return true; })()`);
      }
    }
    // The Node path's values from the one mining pass, when there is no tab (the page's own code, from Node).
    let nodePath = null;
    const refundView = (t) => t.evaluate(`JSON.stringify({ owed: ${OWED}, settled: (document.getElementById('arena-settled') || {}).textContent || '',
      withdrawable: String(window.ARENA_WITHDRAWABLE ?? '') }, (k, v) => (typeof v === 'bigint' ? String(v) : v))`).then((s) => JSON.parse(s || '{}')).catch((e) => ({ unread: e.message }));

    if (bare) {
      const kept = { lock: { outpoint: bare.stake.outpoint, fields: bare.stake.fields } };
      const own = await tabLockWallet({ round: c, roundId: rid, invite: env.INVITE, seed: bare.seed, LockClient });
      const early = await refundKept({ round: c, roundId: rid, seed: bare.seed, curve: pageCurve, client: own, kept });
      let tabEarly = null;
      if (tab) {
        for (let t0 = Date.now(); Date.now() - t0 < 90000; await wait(2000)) {
          tabEarly = await refundView(tab);
          if (tabEarly.owed && tabEarly.owed.stake && tabEarly.owed.stake.how === 'refund') break;
        }
      }
      const exp = Number(bare.stake.fields.expiration);
      const cli = (...a) => run(`${env.BITCOIN_BIN}/bitcoin-cli`, ['-regtest', '-rpcport=30101', '-rpcuser=arena', '-rpcpassword=arena', ...a]);
      // THE SETUP'S OWN WALLET (federation-hold-probe: createwallet, then -rpcwallet for every address) -
      // measured: getnewaddress without it answered nothing and the mining was refused, "Invalid address".
      const listed = JSON.parse((await cli('listwallets')).so || '[]');
      const walletName = listed[0] || 'probe';
      const addr = (await cli(`-rpcwallet=${walletName}`, 'getnewaddress')).so.trim();
      const chainAt = await chainHeight();
      const mined = await cli('generatetoaddress', String(Math.max(0, exp - chainAt + 6)), addr);
      const t = Date.now();
      let counts = await countsNow();
      for (; !mined.err && Date.now() - t < 240000 && counts[0] < exp + 1; await wait(3000)) counts = await countsNow();
      // THE TAB FIRST, when there is one: its own look must find the lock owed back by the player's
      // key - nothing refunded by looking - and its Withdraw (a wallet handed in) collects and pays.
      if (tab) {
        let seen = {};
        const t1 = Date.now();
        for (; Date.now() - t1 < 150000; await wait(2000)) {
          seen = await refundView(tab);
          if (seen.owed && seen.owed.refundMsat !== '0') break;
        }
        const refundedMs = Date.now() - t1;
        const lockHeldWhileOwed = !!(await ports[0].status(bare.stake.outpoint)).stored;
        let w = null; let made = {};
        if (seen.owed && seen.owed.refundMsat !== '0') {
          const got = await withdrawWith(tab, MAKER);
          w = got.result ? JSON.stringify(got.result) : null;
          made = JSON.parse(await tab.evaluate('JSON.stringify(window.__harnessInvoice || {})').catch(() => '{}') || '{}');
        }
        let after = {};
        for (let t3 = Date.now(); Date.now() - t3 < 60000; await wait(2000)) { after = await refundView(tab); if (after.owed && after.owed.final) break; }
        const seenAt = made.r_hash ? JSON.parse((await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest',
          'lookupinvoice', made.r_hash])).so || '{}') : {};
        const shot = `${P}/refused-tab-refund.png`;
        await tab.shot(shot);
        const line = await tab.evaluate(`[(document.getElementById('arena-settled') || {}).textContent, (document.getElementById('arena-wallet-withdraw') || {}).textContent].join(' | ')`).catch(() => '');
        out({ round: `${stakeMsat / 1000n} sat`, check: 'the refused player\'s own tab, on screen',
          beforeExpiry: tabEarly && { owed: tabEarly.owed, settled: tabEarly.settled },
          mined: { chainBefore: chainAt, expiration: exp, guardiansCountAfter: counts, err: mined.err ? mined.err.message : null },
          afterExpiry: { owed: seen.owed, lockHeldWhileOwed, owedWithinMs: refundedMs },
          afterWithdraw: { owed: after.owed, settled: after.settled },
          stakeLockStillHeld: !!(await ports[0].status(bare.stake.outpoint)).stored,
          withdraw: w ? JSON.parse(w) : null, aliceInvoice: { state: seenAt.state, amtPaidMsat: seenAt.amt_paid_msat }, onScreen: line, screenshot: shot,
          pageSaid: tab.logs.filter((l) => /\[(?:arena|blwp)\] (refund|withdraw|payout|stake)|EXCEPTION/.test(l)).map((l) => l.slice(0, 220)).slice(-6) });
        tab.close();
        if (typeof own.free === 'function') own.free();
      } else nodePath = { kept, own, early, exp, chainAt, mined, counts, t };
    }
    // THE PAGE'S OWN CODE FROM NODE, when no tab did it: the same wallet and the before-expiry answer
    // from the one mining pass above - never a second "before" asked after the expiry.
    if (nodePath) {
      const { kept, own, early, exp, chainAt, mined, counts, t } = nodePath;
      const late = await refundKept({ round: c, roundId: rid, seed: bare.seed, curve: pageCurve, client: own, kept });
      let wd = null; let made = null;
      if (late.ok) {
        wd = await withdrawCollected({ client: own, invoiceFor: async (msat) => {
          made = JSON.parse((await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest',
            'addinvoice', `--amt_msat=${msat}`, '--memo=blwp refund'])).so || '{}');
          return made.payment_request ? { ok: true, invoice: made.payment_request } : { ok: false, why: 'alice made no invoice' };
        } });
      }
      const seenAt = made && made.r_hash ? JSON.parse((await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest',
        'lookupinvoice', made.r_hash])).so || '{}') : {};
      out({ round: `${stakeMsat / 1000n} sat`, check: 'the refused player, refunded by its own key after expiry',
        beforeExpiry: { final: early.final, locks: early.locks, screen: refundLine(early) },
        mined: { chainBefore: chainAt, expiration: exp, blocks: (mined.so.match(/"/g) || []).length / 2, guardiansCountAfter: counts, waitedMs: Date.now() - t, err: mined.err ? mined.err.message : null },
        afterExpiry: { ok: late.ok, final: late.final, refundedMsat: late.refundedMsat, balanceBefore: late.balance_before, balanceAfter: late.balance_after,
          locks: late.locks, screen: refundLine(late) },
        stakeLockStillHeld: !!(await ports[0].status(bare.stake.outpoint)).stored,
        withdraw: wd && { state: wd.state, withdrawableMsat: wd.withdrawableMsat, walletBefore: wd.balance_before, walletAfter: wd.balance_after, screen: withdrawLine(wd) },
        aliceInvoice: { state: seenAt.state, amtPaidMsat: seenAt.amt_paid_msat } });
      if (typeof own.free === 'function') own.free();
    }
  } finally { await a.close(); await b.close(); }
}

try {
  // SKIP_100=1: the 1000 sat round alone (the 100 sat round's figures are measured; a run with the
  // refused player's expiry refund must fit one bounded call).
  if (env.SKIP_100 !== '1') await round(100000n);
  await round(1000000n);
} catch (e) { out({ error: e.stack.split('\n').slice(0, 3).join(' | ') }); process.exitCode = 1; }
// THE WASM CLIENT'S GUARDIAN WEBSOCKETS KEEP NODE UP after the last step (W1a, measured).
process.exit(process.exitCode || 0);
