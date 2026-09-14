// THE WHOLE SETTLEMENT ON A REAL FEDERATION (W4): two seats of a lock round, each
// with its own port on the stock fedimint 0.12.0 client (blwp-stake-lock) and its
// own joined client; a winner and a loser whose stake locks - and fee locks, only
// where the gate says they pay a seat - are made by the page's wasm lock client;
// both play to FINAL; the seats' one settlement claims the loser's lock (and the fee
// locks), pays the winner and the sitting seats, under one committee signature
// after the window. Run twice: a 100 sat round and a 1000 sat round.
// Driven by settle-live-regtest.sh (the federation, the gateway, the deposit).
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
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
import { replay } from '../src/replay.js';
import { assumeSeated } from '../test/seating.js';
import { rand, b32, RANDOMNESS, WINDOW_MS, GENESIS_HASH, wordsAt, contractFor, say as tell, secretScalar, opts, wait } from '../test/window-fixture.js';
import { lockFromClient } from '../../blwp-client/src/lock-result.js';
import { feeLockPays } from '../../protocol/src/lock-settlement.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson } from '../../protocol/src/stake-lock.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { playerFor } from '../../blwp-client/src/join.js';
import { pageCurve } from '../../blwp-client/src/page-curve.js';
import { redeemPayout, payoutLine, returnStake, stakeBackLine } from '../../blwp-client/src/page-lock.js';

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

// SEAT B'S OWN CLIENT OF THE FEDERATION: two seats settling at once cannot share one database.
const joinedB = await run(`${env.FEDIMINT_BIN}/fedimint-cli`, ['--data-dir', `${P}/client2`, 'join', env.INVITE], { env: { ...env, HOME: env.FEDIMINT_HOME } });
out({ step: 'seat B joins the federation', ok: !joinedB.err, why: joinedB.err ? joinedB.se.trim().split('\n').pop() : 'joined' });
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
// short of what a seat checks it against (measured twice: "expires at 452, before
// 315 + 144", then "before 314 + 144" - after three reads 5 s apart had agreed on
// 302, so the count does not creep, it holds and jumps). Measured here against
// bitcoind's own height: every 5 s, both seats' counts and the chain's, until the
// guardians' reach the chain (or 300 s).
const nowhere = { txid: new Uint8Array(32), outIdx: 0n };
const countsNow = async () => Promise.all(ports.map(async (p) => (await p.status(nowhere)).blockCount));
const chainHeight = async () => Number((await run(`${env.BITCOIN_BIN}/bitcoin-cli`,
  ['-regtest', '-rpcport=30101', '-rpcuser=blwp', '-rpcpassword=blwp', 'getblockcount'])).so.trim());
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
 * A world secret under which the seats' own replay says `want` for this entry, and the
 * tick it is reached by - no later than `lastTick`, the round's first-mark deadline:
 * the driver sends one first mark, and past that line a seat refuses it as FORFEIT
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
// the payout itself. browse() and servePage() as page-lock.mjs (blwp-client) has them.
const CHROME = env.CHROME || '/home/arena/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.data': 'application/octet-stream' };
let served = null;
const servePage = (dir) => served || (served = new Promise((ok) => {
  const s = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    let body;
    try { body = readFileSync(join(dir, p.replace(/\.\.+/g, ''))); } catch { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(body);
  });
  s.listen(0, '127.0.0.1', () => ok({ server: s, port: s.address().port }));
}));
async function browse(url) {
  const profile = mkdtempSync(join(tmpdir(), 'settle-live-chrome-'));
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
  const close = () => { try { ws.close(); } catch {} try { chrome.kill('SIGKILL'); } catch {} };
  const reload = () => send('Page.reload', { ignoreCache: false });
  return { evaluate, shot, logs, close, reload };
}

/** The join state the page's own join sets for a lock round (index.html's lock branch), as one evaluated script. */
const injectFor = (p, c, rid, urls) => `(() => {
      window.BLWP_ROUND = BLWPCLIENT.decodeRoundContract(BLWPCLIENT.fromHex('${toHex(encodeRoundContract(c))}'));
      // THE LOCK AS THE JOIN HOLDS IT - every field lockFromClient gives the page (measured:
      // amount and expiry alone did not encode, and saveCollect kept nothing).
      window.BLWP_STAKE_LOCK = { outpoint: { txid: BLWPCLIENT.fromHex('${toHex(p.stake.outpoint.txid)}'), outIdx: ${p.stake.outpoint.outIdx}n },
        fields: { paymentImage: { kind: 'point', bytes: BLWPCLIENT.fromHex('${toHex(p.stake.fields.paymentImage.bytes)}') },
          amountMsat: ${p.stake.fields.amountMsat}n, claimPk: BLWPCLIENT.fromHex('${toHex(p.stake.fields.claimPk)}'),
          refundPk: BLWPCLIENT.fromHex('${toHex(p.stake.fields.refundPk)}'), expiration: ${p.stake.fields.expiration} } };
      window.BLWP_LOCK_JOIN = { invite: '${env.INVITE}', roundIdHex: '${toHex(rid)}', seed: BLWPCLIENT.fromHex('${toHex(p.seed)}'), nodes: ${JSON.stringify(urls)} };
      // AND WHAT THE JOIN KEEPS IN THE TAB for the collect (index.html's saveCollect call).
      const saved = BLWPCLIENT.saveCollect ? BLWPCLIENT.saveCollect(window.sessionStorage,
        Object.assign({}, window.BLWP_LOCK_JOIN, { round: window.BLWP_ROUND, stakeLock: window.BLWP_STAKE_LOCK })) : 'no saveCollect in the bundle';
      // INSTRUMENTED (the reload pair did not move on 0.0.1236): what saveCollect swallows.
      const probe = (f) => { try { f(); return 'ok'; } catch (e) { return String(e && e.message || e); } };
      window.BLWP_HARNESS_SAVE = { saved,
        encodeRound: probe(() => BLWPCLIENT.encodeRoundContract(window.BLWP_ROUND)),
        encodeLock: BLWPCLIENT.lockFieldsToJson ? probe(() => BLWPCLIENT.lockFieldsToJson(window.BLWP_STAKE_LOCK.fields)) : 'lockFieldsToJson not in the bundle',
        keys: Object.keys(window.sessionStorage) };
      return true; })()`;
const pageReady = async (b) => {
  for (let t = Date.now(); Date.now() - t < 90000; await wait(500))
    if (await b.evaluate(`typeof BLWPCLIENT !== 'undefined' && !!BLWPCLIENT.redeemPayout && !!window.BLWP_CURVE`)) return true;
  return false;
};
// WHAT THE PAGE ACTUALLY HOLDS (instrumented: on 0.0.1236 the reload left 978000 + 980000 in
// the federation and even a fresh tab collected nothing, with no console line): the kept
// collect records, the tab's storage keys, BLWP_COLLECT, and the harness's own save probe.
const tabState = (b) => b.evaluate(`JSON.stringify({ lockJoin: !!window.BLWP_LOCK_JOIN, payout: window.BLWP_PAYOUT || null,
  stakeBack: window.BLWP_STAKE_BACK || null, settled: (document.getElementById('blwp-settled') || {}).textContent || '',
  collects: (() => { try { return BLWPCLIENT.savedCollects(window.sessionStorage).map((r) => ({ round: r.roundIdHex.slice(0, 12),
    locks: BLWPCLIENT.roundLocks(r.round), lock: !!r.stakeLock, done: !!r.done })); } catch (e) { return 'savedCollects threw: ' + e.message; } })(),
  keys: (() => { try { return Object.keys(window.sessionStorage); } catch (e) { return e.message; } })(),
  collect: window.BLWP_COLLECT ? { round: window.BLWP_COLLECT.roundIdHex.slice(0, 12), lock: !!window.BLWP_COLLECT.stakeLock } : null,
  harnessSave: window.BLWP_HARNESS_SAVE || null },
  (k, v) => (typeof v === 'bigint' ? String(v) : v))`).then((s) => JSON.parse(s || '{}'));

/**
 * A RELOAD BEFORE THE COLLECT (6d leftover 1): the winner's tab is handed its join
 * state before the close, left until its collect has asked (the seats have not
 * settled yet), and reloaded - what a player's refresh during the window is. The
 * round is then settled; what the reloaded page does is read after.
 */
async function tabReloadedBeforeClose({ p, c, rid, urls }) {
  const page = await servePage(env.PAGE_DIR);
  const b = await browse(`http://127.0.0.1:${page.port}/`);
  if (!(await pageReady(b))) { b.close(); return { error: 'the built page never loaded its client' }; }
  await b.evaluate(injectFor(p, c, rid, urls));
  let before = {};
  for (let t = Date.now(); Date.now() - t < 30000; await wait(1000)) { before = await tabState(b); if (before.payout) break; }
  await b.reload();
  return { b, before, reloadedReady: await pageReady(b), afterReloadAtOnce: await tabState(b) };
}

/**
 * ONE PLAYER'S TAB COLLECTS ITS PAYOUT ON SCREEN: the built page, handed the join
 * state its own join sets for a lock round (the round, its lock, and BLWP_LOCK_JOIN -
 * the invite, the round and the tab's seed) - harness instrumentation, as page-lock's
 * reload mutants are; the join and play themselves are W1b's and daily-close-look's.
 * The page's own collectThePayout does the rest; this reads what it shows.
 */
async function collectOnScreen({ p, c, rid, urls, stakeMsat, held }) {
  const page = await servePage(env.PAGE_DIR);
  const b = await browse(`http://127.0.0.1:${page.port}/`);
  const shotFile = `${P}/payout-${stakeMsat / 1000n}sat-${p.want}.png`;
  try {
    let ready = false;
    for (let t = Date.now(); Date.now() - t < 90000 && !ready; await wait(500))
      ready = await b.evaluate(`typeof BLWPCLIENT !== 'undefined' && !!BLWPCLIENT.redeemPayout && !!window.BLWP_CURVE`);
    if (!ready) return { page: p.want, error: 'the built page never had BLWPCLIENT.redeemPayout and BLWP_CURVE', logs: b.logs.slice(-5) };
    await b.evaluate(injectFor(p, c, rid, urls));
    const t0 = Date.now();
    let seen = null;
    for (; Date.now() - t0 < 180000; await wait(1000)) {
      seen = JSON.parse(await b.evaluate(`JSON.stringify({
        payout: window.BLWP_PAYOUT || null,
        stakeBack: window.BLWP_STAKE_BACK || null,
        settled: (document.getElementById('blwp-settled') || {}).textContent || '',
        onScreen: (() => { const el = document.getElementById('blwp-settled'); if (!el) return null; const r = el.getBoundingClientRect();
          const hit = r.width && r.height ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
          return { w: Math.round(r.width), h: Math.round(r.height), onTop: !!hit && (hit === el || el.contains(hit)) }; })(),
      }, (k, v) => (typeof v === 'bigint' ? String(v) : v))`) || '{}');
      if (seen.payout && seen.payout.final && seen.stakeBack && seen.stakeBack.final && seen.settled) break;
    }
    await b.shot(shotFile);
    const holds = await tabState(b).catch((e) => ({ unread: e.message }));
    const po = seen && seen.payout;
    const sb = (seen && seen.stakeBack) || {};
    const at = po && po.outIdx !== undefined ? { txid: fromHex(po.txid), outIdx: BigInt(po.outIdx) } : null;
    return { round: `${stakeMsat / 1000n} sat`, page: p.want, onScreen: true, collected: !!(po && po.ok), final: !!(po && po.final),
      collectedMs: Date.now() - t0, payoutMsat: po && po.amountMsat, walletBefore: po && po.balance_before, walletAfter: po && po.balance_after,
      payoutStillHeldAfter: at ? await held(at) : null,
      stakeBack: !!sb.ok, stakeBackFinal: !!sb.final, returnedMsat: sb.amountMsat, stakeWalletBefore: sb.balance_before, stakeWalletAfter: sb.balance_after,
      stakeLockMsat: p.stake.fields.amountMsat, stakeLockHeldAfter: await held(p.stake.outpoint),
      shown: seen && seen.settled, drawn: seen && seen.onScreen, screenshot: shotFile,
      pageHolds: { collects: holds.collects, keys: holds.keys, collect: holds.collect, harnessSave: holds.harnessSave },
      pageSaid: b.logs.filter((l) => /\[blwp\] (payout|stake)|EXCEPTION/.test(l)).map((l) => l.slice(0, 200)).slice(-4) };
  } finally { b.close(); }
}

async function round(stakeMsat) {
  const mk = (i) => serve(openStore(':memory:'), { port: 0, ...opts, stakeLocks: ports[i], poolCurve: curve, finality: { everyMs: 250 } });
  const a = await mk(0); const b = await mk(1);
  try {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
    }
    const c = { ...contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [a, b].map((d) => `http://127.0.0.1:${d.port}`)),
      federationId: fromHex(LockClient.federationIdOf(env.INVITE)), minScore: 1, stakeMsat };
    const rid = roundId(c);
    for (const d of [a, b]) {
      const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      if (r.status !== 201) throw new Error(`round: ${r.status} ${await r.text()}`);
      assumeSeated(d.round, rid, c.nodes);
    }
    for (let pass = 0; pass < 2; pass++) for (const d of [a, b]) await d.dkg.run(c.nodes);
    const claimPk = a.dkg.seatFor(c.nodes).pool.groupPublicKey;
    const gate = feeLockPays({ contract: c, fees });
    out({ round: `${stakeMsat / 1000n} sat`, gate: { mints: gate.pays, lock: gate.lockMsat, why: gate.why.slice(0, 110) } });

    const players = [];
    for (const want of ['DELIVERED', 'FAILED']) {
      // THE PAGE'S OWN PLAYER KEY, from a tab seed (6d: the page finds its payout by it).
      const seed = rand(32);
      const playerPubkey = playerFor({ ...c, id: rid }, { seed, curve: pageCurve }).pubkey;
      const session = ed25519.utils.randomSecretKey();
      const preimage = secretScalar();
      const e = rand(32);
      const dealt = await dealHandout({ preimage, seats: c.nodes, roundId: rid, playerPubkey, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
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
        if (lk.status !== 201) throw new Error(`seat ${d.port} answered the stake lock ${lk.status}: ${await lk.text()}`);
        if (fl && fl.status !== 201) throw new Error(`seat ${d.port} answered the fee lock ${fl.status}: ${await fl.text()}`);
        const took = await tell(d.port, encodeInputBatch(input));
        if (took !== String(world.ticks)) throw new Error(`the batch was not taken by seat ${d.port}: ${took}`);
        const receipt = await tell(d.port, signedMark);
        if (receipt.length !== SIGNED_RECEIPT_BYTES) throw new Error(`the mark at tick ${world.ticks} was not receipted by seat ${d.port}: ${typeof receipt === 'string' ? receipt : `${receipt.length} bytes`}`);
      }
      out({ player: want, expiration: stake.fields.expiration, countsAfterHandOver: await countsNow(), chain: await chainHeight(),
        stakeLock: `${key(stake.outpoint)} ${stake.fields.amountMsat} msat`, feeLock: fee ? `${key(fee.outpoint)} ${fee.fields.amountMsat} msat` : 'none (the gate)',
        world: `ticks ${world.ticks}`, seats: handed });
      players.push({ want, seed, playerPubkey, stake, fee, eid });
    }

    // PICK (a) (the owner 2026-09-14): A THIRD PLAYER WHO LOCKS A STAKE AND BRINGS NO FEE LOCK. Where
    // the gate mints, each seat must refuse the entry at the door - not seated, its stake not
    // counted, its lock still its own - and the two who brought theirs settle as before.
    let bare = null;
    if (stakeMsat >= 1000000n) {
      const seed = rand(32);
      const playerPubkey = playerFor({ ...c, id: rid }, { seed, curve: pageCurve }).pubkey;
      const preimage = secretScalar();
      const e = rand(32);
      const dealt = await dealHandout({ preimage, seats: c.nodes, roundId: rid, playerPubkey, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
        coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
      const entryBase = { roundId: rid, playerPubkey, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()), stakeCommitment: sha256(preimage), stakeMsat,
        feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n, joinTick: 0, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
        claimKeyAttestationRef: b32(0x9a), worldSecret: rand(32) };
      const refundPk = refundKeyOf(playerPubkey);
      const net = netStakeMsat({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n });
      const stake = lockFromClient(await lc.lock(toHex(entryBase.stakePoint), String(net), toHex(claimPk), toHex(refundPk), 150), { point: entryBase.stakePoint, claimPk, refundPk });
      const entry = { ...entryBase, feePreimage: new Uint8Array(32), stakeLockOutpoint: stake.outpoint, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n } };
      const eid = entryId(entry);
      const seats = [];
      for (const d of [a, b]) {
        const at = `http://127.0.0.1:${d.port}`;
        await fetch(`${at}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
        const en = await fetch(`${at}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
        seats.push({ entry: en.status, why: en.status === 201 ? 'seated' : await en.text(), stored: !!d.round.entry(eid), seen: !!d.round.stakeSeen(eid) });
      }
      bare = { stake, seats };
      out({ round: `${stakeMsat / 1000n} sat`, check: 'a player with a stake lock and no fee lock, at the door',
        stakeLock: `${key(stake.outpoint)} ${stake.fields.amountMsat} msat`, seats,
        seatedSet: [a, b].map((d) => d.round.entriesOf(rid).length) });
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
      round: `${stakeMsat / 1000n} sat`, settlement: got && got.state, why: got && got.why, seatBHolds: atB.state, txid: got && got.txid,
      oneSignatureVerifiesUnderClaimKey: verifies, madeAfterCloseMs: got && got.madeMs ? got.madeMs - closedAt : null, windowMs: WINDOW_MS,
      moved: got && got.moved,
      federation: {
        loserStakeLockHeld: await held(loser.stake.outpoint), winnerStakeLockHeld: await held(winner.stake.outpoint),
        feeLocksHeld: await Promise.all(players.filter((p) => p.fee).map((p) => held(p.fee.outpoint))), payoutsStored,
      },
      winnerKey: toHex(refundKeyOf(winner.playerPubkey)).slice(0, 12), seatKeys: c.nodes.map((k) => toHex(refundKeyOf(k)).slice(0, 12)),
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
          if (after.payout && after.payout.final && after.stakeBack && after.stakeBack.final) break;
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
    for (const p of [winner, loser]) {
      // ON SCREEN FOR THE 1000 SAT ROUND when a build is named; the 100 sat round by Node.
      if (env.PAGE_DIR && stakeMsat >= 1000000n) { out(await collectOnScreen({ p, c, rid, urls, stakeMsat, held })); continue; }
      let joins = 0;
      const Counting = { join: (...args) => { joins++; return LockClient.join(...args); } };
      const r = await redeemPayout({ round: c, roundId: rid, invite: env.INVITE, seed: p.seed, curve: pageCurve, LockClient: Counting, nodes: urls });
      const at = r.outIdx !== undefined ? { txid: fromHex(r.txid), outIdx: BigInt(r.outIdx) } : null;
      out({ round: `${stakeMsat / 1000n} sat`, page: p.want, collected: r.ok, final: r.final, lockClientJoins: joins, outIdx: r.outIdx,
        payoutMsat: r.amountMsat, walletBefore: r.balance_before, walletAfter: r.balance_after,
        payoutStillHeldAfter: at ? await held(at) : null, screen: payoutLine(r) });
      // AND ITS OWN STAKE BACK BY THE SEATS' FORFEIT, into the same wallet (6d).
      const joinsBefore = joins;
      const heldBefore = await held(p.stake.outpoint);
      const back = await returnStake({ round: c, roundId: rid, invite: env.INVITE, seed: p.seed, curve: pageCurve, LockClient: Counting,
        nodes: urls, client: r.client || null });
      out({ round: `${stakeMsat / 1000n} sat`, page: p.want, stakeBack: back.ok, final: back.final, lockClientJoins: joins - joinsBefore,
        stakeLockMsat: p.stake.fields.amountMsat, returnedMsat: back.amountMsat, walletBefore: back.balance_before, walletAfter: back.balance_after,
        stakeLockHeldBefore: heldBefore, stakeLockHeldAfter: await held(p.stake.outpoint), screen: stakeBackLine(back) });
      if (back.client && back.client !== r.client && typeof back.client.free === 'function') back.client.free();
      if (r.client && typeof r.client.free === 'function') r.client.free();
    }
  } finally { await a.close(); await b.close(); }
}

try {
  await round(100000n);
  await round(1000000n);
} catch (e) { out({ error: e.stack.split('\n').slice(0, 3).join(' | ') }); process.exitCode = 1; }
// THE WASM CLIENT'S GUARDIAN WEBSOCKETS KEEP NODE UP after the last step (W1a, measured).
process.exit(process.exitCode || 0);
