#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE PAGE ASKS A WINNER WHERE TO SEND THE WINNINGS, ON A REAL FEDERATION (ruled 2026-09-23).
 *
 *   PROBE=<fed dir> LOCK_BIN=<blwp-stake-lock> WASM_PKG=<dir> INVITE=<invite> ALICE_RPC=.. BOB_RPC=.. CAROL_RPC=..
 *   LND_BIN=<dir> BUNDLE=<arena-client.js built from this tree> CASE=A|B|C [PORT_A=31240: seven ports from it]
 *   [BTC_RPCPORT=31101]   (the federation's regtest chain: the seven bonds are posted to it)
 *     node packages/arena-client/tools/winnings-page-probe.mjs
 *
 * Driven in Node on the PAGE'S OWN code: the client bundle built from this tree (BUNDLE) and the shipped bridge,
 * blwp.jslib, evaluated the way Emscripten evaluates it (as world-seed-bridge.test.js does). A 5-of-7 FEDERATION
 * round (`standUpRound`: seven signer nodes bonded on the federation's own chain, three of them vouching for one guardian
 * each - §23.6 refuses fewer on a 3-of-4 - the attested claim key, the federation's real lock port), joined the way
 * index.html joins it - the committee, the attested claim key, the dealt stake, the handout, `lockStake` through the
 * stock lock client (its deposit paid by alice's lnd), `entryFor` - and played through the bridge's own session: its
 * non-extractable key, its entry, its batches and marks. The truck is steered at the gate off the bridge's own core,
 * the way a player steers; the world secret the page rolls is one the core delivers in (checked before the join). A
 * loser beside it, played directly. `window.prompt` is stubbed; the run-over hook is index.html's (askForWinnings on
 * the tab's storage), every load's resend is index.html's (resendWinnings), so is its wrapper of Client.at (every node
 * the round named, and the page's stake lock), and every POST the page makes to
 * /payout-address is counted per signer node.
 *   A  the winner names alice's https LNURL address: asked once, one POST per node, 201, stored on all seven; the
 *      settlement sends to the checked invoice, alice SETTLES it once, one PAID row per node. Restart all, 30 s: nothing more.
 *   B  the winner names nothing: asked once, and zero times after a reload; zero POSTs; nothing stored; no invoice
 *      asked; nothing sent; the loser's lock not claimed (the pool: nobody addressed).
 *   C  signer node B goes down as the player answers: the other six answer 201. Reload with B up: no prompt, one POST,
 *      to B only; all seven hold the address; the invoice settles once. Restart all, 30 s: nothing more. Then another
 *      address for the same entry, signed through the bridge's own call: 409 at all seven.
 * It prints what it measured and decides nothing.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { standUpRound } from '../../arena-node/tools/round-2of2.mjs';
import { stakeLockPort } from '../../arena-node/src/stake-lock-port.js';
import { bitcoindRpc } from '../../arena-node/src/chain-rpc.js';
import { lockFieldsToJson } from '../../arena-node/src/stake-lock-signer-node.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { wordsAt, GENESIS_HASH, secretScalar, say as tell, LOSER } from '../../arena-node/test/window-fixture.js';
import { pageCurve } from '../src/page-curve.js';
import { lockFromClient } from '../src/lock-result.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { init, step } from '../../nextblock/src/sim.js';
import { CORE } from '../../nextblock/src/adapter.js';
import { hash as stateHash, O_SCORE, S_STATE, S_DELIVERED } from '../../nextblock/src/state.js';
import { GATE_X, RUN_LIVE, RUN_DELIVERED } from '../../nextblock/src/rules/gate.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { decodePlayerResult, splitSignedResult, SIGNED_RESULT_BYTES } from '../../arena-protocol/src/result.js';

const env = process.env;
for (const k of ['PROBE', 'LOCK_BIN', 'WASM_PKG', 'INVITE', 'ALICE_RPC', 'BOB_RPC', 'CAROL_RPC', 'LND_BIN', 'BUNDLE'])
  if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const CASE = env.CASE || 'A';
const W_LIKE = CASE === 'W' || CASE === 'WF' || CASE === 'WC';
const P = env.PROBE;
const require = createRequire(import.meta.url);
const CLIENT = require(env.BUNDLE);
const coreDist = require('../../nextblock/dist/blwp-core.js');
const say_ = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const random = (n) => new Uint8Array(randomBytes(n));
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 120000 }, (err, out, e) => done({ ok: !err, out: String(out), err: String(e || (err && err.message) || '') })));
const lncli = async (who, ...a) => {
  const rpc = { alice: env.ALICE_RPC, bob: env.BOB_RPC, carol: env.CAROL_RPC }[who];
  const r = await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/${who}`, `--rpcserver=${rpc}`, '--network=regtest', ...a]);
  if (!r.ok) throw new Error(`lncli ${who} ${a[0]}: ${r.err.slice(0, 200)}`);
  return JSON.parse(r.out);
};
const settledOnAlice = async () => (await lncli('alice', 'listinvoices', '--max_invoices', '1000')).invoices.filter((i) => i.state === 'SETTLED').length;

// THE WINNER'S LIGHTNING ADDRESS: https on this machine, answering LUD-16/LUD-06 with alice's own invoices.
const dir = mkdtempSync(join(tmpdir(), 'blwp-winnings-page-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
const cert = readFileSync(join(dir, 'cert.pem'));
const METADATA = JSON.stringify([['text/plain', 'a BLWP winning, named on the page']]);
const invoicesAsked = [];
const lnurlServer = createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, async (req, res) => {
  const u = new URL(req.url, 'https://127.0.0.1');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/lnurlp/winner')
    return json({ tag: 'payRequest', callback: `https://127.0.0.1:${lnurlServer.address().port}/cb`, metadata: METADATA,
      minSendable: 1000, maxSendable: 1000000000 });
  if (u.pathname === '/cb') {
    const amount = u.searchParams.get('amount');
    const inv = await lncli('alice', 'addinvoice', '--amt_msat', amount, '--description_hash', toHex(sha256(new TextEncoder().encode(METADATA))));
    invoicesAsked.push({ amountMsat: amount, hash: inv.r_hash });
    return json({ pr: inv.payment_request, routes: [] });
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => lnurlServer.listen(0, '127.0.0.1', r));
const ADDRESS = `winner@127.0.0.1:${lnurlServer.address().port}`;
const lnurlFetch = (url) => new Promise((done, fail) => {
  const req = httpsRequest(url, { ca: cert }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => done({ json: async () => JSON.parse(b) })); });
  req.on('error', fail); req.end();
});

// EVERY POST THE PAGE MAKES TO A SIGNER NODE'S ADDRESS DOOR, counted per node, with its answer.
const doorPosts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!/\/payout-address\?/.test(u)) return realFetch(url, init);
  const node = new URL(u).origin;
  try { const r = await realFetch(url, init); doorPosts.push({ node, status: r.status }); return r; }
  catch (e) { doorPosts.push({ node, status: 'down', why: e.cause ? e.cause.code : e.message }); throw e; }
};

// THE FEDERATION'S ROUND, ON TWO BONDED SIGNER NODES OVER THE REAL LOCK PORT.
const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
const esm = join(dir, 'blwp-lock-client.mjs');
copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
const wasmMod = await import(esm);
await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
const { LockClient } = wasmMod;
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const federationId = fromHex(LockClient.federationIdOf(env.INVITE));
// §23.6: A ROUND ON THIS 3-OF-4 FEDERATION NEEDS THREE DISTINCT BONDED SIGNER NODES EACH VOUCHING FOR ONE GUARDIAN, and a
// paying committee is 2 or 7 (`receiptsNeeded`) - so this round is the 5-of-7: seven bonded signer nodes, the first
// three each vouching for one guardian (measured: two nodes refused, "0 of that federation's 4 guardians are bonded").
const fed = await port.guardians();
// AND THE BONDS ON THE FEDERATION'S OWN REGTEST CHAIN (federation-round-3.mjs's way): the fixture chain carries two bonds,
// and this round needs seven. Its own wallet, funded here; the chain answers to -rpcuser/-rpcpassword.
const RPCPORT = env.BTC_RPCPORT || '31101';
const btcBase = ['-regtest', `-datadir=${P}/btc`, `-rpcport=${RPCPORT}`, '-rpcuser=arena', '-rpcpassword=arena'];
const BTC = env.BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli';
const cliRaw = (...a) => execFileSync(BTC, [...btcBase, ...a], { encoding: 'utf8' }).trim();
try { cliRaw('createwallet', 'arena'); } catch { try { cliRaw('loadwallet', 'arena'); } catch { /* loaded */ } }
const cli = (...a) => execFileSync(BTC, [...btcBase, '-rpcwallet=arena', ...a], { encoding: 'utf8' }).trim();
if (Number(cli('getbalance')) < 10) cli('generatetoaddress', '101', cli('getnewaddress'));
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${RPCPORT}/wallet/arena`, readCookie: () => 'arena:arena' });
const BASE = Number(env.PORT_A || 31240);
const round = await standUpRound({ host: '127.0.0.1', portA: BASE, portB: BASE + 1, extraPorts: [2, 3, 4, 5, 6].map((i) => BASE + i),
  rpc, cli, stakeMsat: 1000000n, federationId, invite: env.INVITE, objectionWindowMs: 3000n, donationRecipients: null,
  guardianOf: [0, 1, 2, null, null, null, null].map((g) => (g === null ? [] : [{ federationId, guardianKey: fed.keys[g] }])),
  signerNode: { stakeLocks: port, lnurlFetch, winningsEveryMs: 3000 } });
const restartAll = async () => { await round.restartA(); await round.restartB(); for (let i = 0; i < 5; i++) await round.restartRest(i); };
const nodeUrl = (d) => `http://127.0.0.1:${d.port}`;
say_({ step: 'round', case: CASE, round: toHex(round.id || CLIENT.roundId(round.contract)).slice(0, 16), address: ADDRESS, url: round.url.slice(0, 120) });

const TAB = new Map();
const tab = { getItem: (k) => (TAB.has(k) ? TAB.get(k) : null), setItem: (k, v) => TAB.set(k, String(v)), removeItem: (k) => TAB.delete(k),
  get length() { return TAB.size; }, key: (i) => [...TAB.keys()][i] ?? null };
let exitCode = 0;
try {
  // ---- THE PAGE'S JOIN (index.html joinTheRoundIfOneWasNamed, a locking round), in its order. ----
  const named = await CLIENT.joinFromQuery(new URL(round.url).search);
  const rid = CLIENT.fromHex(named.roundIdHex);
  const withId = { ...named.round, id: rid };
  const seed = CLIENT.tabSeed({ storage: tab, random });
  const player = CLIENT.playerFor(withId, { seed, curve: pageCurve });
  const committee = await CLIENT.fetchSettlementSignerNodes(named.roundIdHex, named.nodes);
  const claimKey = await CLIENT.awaitAttestedClaimKey({ round: withId, signerNodes: committee.signerNodes, nodes: named.nodes, curve: pageCurve });
  if (!claimKey.ok) throw new Error(`no attested claim key: ${claimKey.why}`);
  const needed = CLIENT.sharesNeededFor(named.round);
  const stake = await CLIENT.stakeFor(withId, { signerNodes: committee.signerNodes, curve: pageCurve, random, playerPubkey: player.pubkey, needed });
  const put = await CLIENT.postHandout(stake, named.nodes, { needed });
  if (!put.ok) throw new Error(`handout: ${put.why}`);
  // THE WORLD THE PAGE ROLLS: a world secret the core delivers in under a player steering at the gate, found before the
  // join (a few percent of worlds deliver; the others wreck) - so this is a lucky roll, not a different page.
  const beacon = await CLIENT.fetchRandomness(named.roundIdHex, named.nodes);
  const steer = (st) => {
    const p = CORE.picture(st); const x = p.x / 65536, z = p.z / 65536, h = p.heading / 65536;
    let off = Math.atan2(GATE_X / 65536 + 20 - x, -z) / (2 * Math.PI) - h; off -= Math.round(off);
    return [65536, Math.max(-65536, Math.min(65536, Math.round(off * 6 * 65536))), 0, 0, 0];
  };
  let worldSecret = null; let expected = null; let tries = 0;
  for (; tries < 400 && !worldSecret; tries++) {
    const ws = random(32);
    const st = init(seedWordForEntry({ playerPubkey: player.pubkey, worldSecret: ws, joinTick: 0 }, beacon.randomness));
    let t = 0; for (; t < 1320; t++) { step(st, ...steer(st)); if (st.i32[O_SCORE + S_STATE] !== RUN_LIVE) break; }
    if (st.i32[O_SCORE + S_STATE] === RUN_DELIVERED && st.i32[O_SCORE + S_DELIVERED] >= Number(named.round.minScore)) {
      worldSecret = ws; expected = { tick: t, score: st.i32[O_SCORE + S_DELIVERED] };
    }
  }
  if (!worldSecret) throw new Error(`no delivering world in ${tries} rolls`);
  say_({ step: 'world rolled', tries, expected });
  // THE STAKE LOCK, through the stock lock client; its deposit is paid by alice, as a player's wallet would.
  // THE STAKE FROM THE PLAYER WALLET (§24A.1, RULED 2026-09-25): the top-up is its own act, then the stake.
  const stakeArgs = { round: named.round, roundId: rid, invite: named.federation, seed, stake, claimKey,
    playerPubkey: player.pubkey, LockClient, donationMsat: 0n, storage: tab,
    onStep: (s) => say_({ step: 'stake lock', at: s }),
    onDeposit: (d) => { run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, `--rpcserver=${env.ALICE_RPC}`, '--network=regtest', 'payinvoice', '--force', d.invoice])
      .then((r) => say_({ step: 'deposit paid by alice', ok: /SUCCEEDED/.test(r.out), amountMsat: d.amountMsat })); } };
  await CLIENT.fundPlayerWallet(stakeArgs);
  const made = await CLIENT.lockStake(stakeArgs);
  const stakeLock = { outpoint: made.outpoint, fields: made.fields, feeLock: made.feeLock || null, needed, onCommitted: () => {} };
  let rolled = false;
  const pageRandom = (n) => { if (n === 32 && !rolled) { rolled = true; return worldSecret; } return random(n); };
  // `entryFor` rolls the stake commitment only for an unstaked entry; with a stake, its first 32-byte roll is the world.
  const BLWP_ENTRY = CLIENT.entryFor(withId, { seed, curve: pageCurve, playerPubkey: player.pubkey, random: pageRandom, stake, claimKey, stakeLock, donationMsat: 0n });
  if (toHex(BLWP_ENTRY.worldSecret) !== toHex(worldSecret)) throw new Error('the page did not take the rolled world');
  say_({ step: 'locked', outpoint: `${toHex(made.outpoint.txid).slice(0, 16)}:${made.outpoint.outIdx}`, feeLock: !!made.feeLock });

  // ---- A LOSER BESIDE IT, played directly (the probe's way), with its own lock client. ----
  const lc = await LockClient.join(env.INVITE, LockClient.federationIdOf(env.INVITE), toHex(random(32)),
    { entries: () => '[]', put: () => {}, remove: () => {} });
  const rcv = JSON.parse(await lc.receive('1100000', ''));
  await run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/alice`, `--rpcserver=${env.ALICE_RPC}`, '--network=regtest', 'payinvoice', '--force', rcv.invoice]);
  await lc.awaitReceive(rcv.operation);
  const rule = JSON.parse(await lc.feeRule());
  const gate = feeLockPays({ contract: named.round, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) } });
  let loserKey; let loserSecret;
  for (;;) {
    let k; do { k = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(k, true)[0] !== 0x02);
    loserKey = schnorr.getPublicKey(k); loserSecret = random(32);
    const st = init(seedWordForEntry({ playerPubkey: loserKey, worldSecret: loserSecret, joinTick: 0 }, beacon.randomness));
    let t = 0; for (; t < LOSER.ticks; t++) { step(st, ...wordsAt(t)); if (st.i32[O_SCORE + S_STATE] !== RUN_LIVE) break; }
    if (st.i32[O_SCORE + S_STATE] !== RUN_DELIVERED) break;
  }
  const STAKE = BigInt(named.round.stakeMsat);
  const session = ed25519.utils.randomSecretKey();
  const pL = secretScalar();
  const point = feldmanGroup.pointFromScalar(scalarFrom32(pL) % FIELD);
  const net = netStakeMsat({ stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n });
  const lk = lockFromClient(await lc.lock(toHex(point), String(net), toHex(claimKey.claimPk), toHex(refundKeyOf(loserKey)), 150),
    { point, claimPk: claimKey.claimPk, refundPk: refundKeyOf(loserKey) });
  let F = new Uint8Array(32), feeOut = { txid: new Uint8Array(32), outIdx: 0n }, feeFields = null;
  if (gate.pays) {
    F = random(32);
    const fl = lockFromClient(await lc.lockHash(toHex(sha256(F)), String(entryFeeMsat(STAKE)), toHex(claimKey.claimPk), toHex(refundKeyOf(loserKey)), 150),
      { hash: sha256(F), claimPk: claimKey.claimPk, refundPk: refundKeyOf(loserKey) });
    feeOut = fl.outpoint; feeFields = fl.fields;
  }
  const e = random(32);
  const dealt = await dealHandout({ preimage: pL, signerNodes: committee.signerNodes, roundId: rid, playerPubkey: loserKey, ephemeralSecret: e,
    ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(random(32)) % FIELD), needed, curve: feldmanGroup });
  const lEntry = { roundId: rid, playerPubkey: loserKey, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(pL),
    stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n, joinTick: 0, worldSecret: loserSecret,
    vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0], feePreimage: F,
    stakeLockOutpoint: lk.outpoint, feeLockOutpoint: feeOut, claimKeyAttestationRef: claimKey.ref };
  const lEid = entryId(lEntry);
  // THE LOSER PLAYS AN ON-TIME FIRST MARK (tick 60), then its last (ruled 2026-09-24, case WC): a run whose only mark is
  // a late first one is a late start (M3.3-34), which waits on every unreachable signer node - measured: with B down
  // past a 3 s result window the loser went VOID under §13C, no stake was claimed and nothing was paid. Both marks are
  // posted to every node while all are up, so its close depends on nobody.
  const FIRST = 60;
  const b1 = { roundId: rid, entryId: lEid, previousHash: GENESIS_HASH, firstTick: 0, ticks: Array.from({ length: FIRST }, (_, t) => wordsAt(t)), liquidations: [] };
  const input = { roundId: rid, entryId: lEid, previousHash: batchId(b1), firstTick: FIRST, ticks: Array.from({ length: LOSER.ticks - FIRST }, (_, t) => wordsAt(FIRST + t)), liquidations: [] };
  const lst = init(seedWordForEntry(lEntry, beacon.randomness));
  for (let t = 0; t < FIRST; t++) step(lst, ...wordsAt(t));
  const hashOf = (st) => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
  const mark60 = { roundId: rid, entryId: lEid, tick: FIRST, stateHash: hashOf(lst), inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: lEntry.sessionPubkey };
  const signedMark60 = joinSigned(encodeCheckpoint(mark60), ed25519.sign(checkpointId(mark60), session));
  for (let t = FIRST; t < LOSER.ticks; t++) step(lst, ...wordsAt(t));
  const mark = { roundId: rid, entryId: lEid, tick: LOSER.ticks, stateHash: hashOf(lst),
    inputChainHash: batchId(input), previousHash: checkpointId(mark60), sessionPubkey: lEntry.sessionPubkey };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  const lSaid = [];
  for (const d of round.daemons) {
    const base = nodeUrl(d);
    await realFetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    const j = await realFetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(lEntry) });
    const l = await realFetch(`${base}/lock?entry=${toHex(lEid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(lk.fields)) });
    if (feeFields) await realFetch(`${base}/fee-lock?entry=${toHex(lEid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
    lSaid.push([j.status, l.status, j.status === 201 ? '' : (await j.text()).trim().slice(0, 160), l.status === 201 ? '' : (await l.text()).trim().slice(0, 200)]);
    await tell(d.port, encodeInputBatch(b1));
    await tell(d.port, signedMark60);
    await tell(d.port, encodeInputBatch(input));
    await tell(d.port, signedMark);
  }
  say_({ step: 'loser played', entry: toHex(lEid).slice(0, 16), said: lSaid });

  // ---- THE PAGE'S OWN BRIDGE, and index.html's run-over hook and load. ----
  const prompts = [];
  let answer = CASE === 'B' ? '' : ADDRESS;
  let onPrompt = () => {};
  const promptStub = (text) => { prompts.push(text); onPrompt(); return answer; };
  const hookCalls = [];
  const asks = [];
  let deliveredAt = null;
  const pageHook = (word, runInfo) => {                       // index.html's BLWP_RUN_OVER, its winnings half
    hookCalls.push({ word: String(word), run: runInfo && { word: runInfo.word, score: runInfo.score, minScore: runInfo.minScore } });
    // W: SIGNER NODE B STOPS THE MOMENT THE CORE SAYS DELIVERED - the finish's last batches and final mark still on
    // their way - and comes back 7 s later (§10's window, ruled 2026-09-23: a 7 s outage fits inside it).
    if (W_LIKE && deliveredAt === null) {
      deliveredAt = Date.now(); round.b.close();
      // WC: B STAYS DOWN until the other six have combined the settlement (below), not 7 s.
      if (CASE !== 'WC') setTimeout(() => { round.restartB().then(() => { bBackAt = Date.now(); }); }, 7000);
    }
    if (!runInfo) return;
    asks.push(CLIENT.askForWinnings({ run: runInfo, prompt: (t) => promptStub(t), storage: tab }));
  };
  const pageLoad = () => CLIENT.resendWinnings({ storage: tab });   // index.html's load
  // AND index.html's WRAPPER OF Client.at: every node the round named, for delivery, and the page's stake lock, which
  // `join` hands to every signer node (its node signatures are Schnorr, which pageCurve verifies).
  const at = CLIENT.Client.at.bind(CLIENT.Client);
  CLIENT.Client.at = (discovery, opts) => at({ ...discovery, nodes: discovery.nodes || named.nodes },
    { ...opts, verify: (sig, msg, key) => !!pageCurve.verify(sig, msg, key), stakeLock });
  const heap = new Int32Array(64);
  const Module = { HEAPU8: new Uint8Array(heap.buffer), blwpNet: null };
  const win = { location: { search: new URL(round.url).search }, BLWP_RUN_OVER: pageHook };
  const src = readFileSync(new URL('../../../unity-proto/Assets/Plugins/WebGL/blwp.jslib', import.meta.url), 'utf8');
  const globals = { Module, HEAP32: heap, UTF8ToString: () => named.nodes[0], window: win, console, crypto, BLWP: coreDist, BLWPCLIENT: CLIENT,
    BLWP_CURVE: pageCurve, BLWP_ROUND: named.round, BLWP_ENTRY, BLWP_NODES: named.nodes, BLWP_CHAIN: named.chain, BLWP_ADVERT: named.advert };
  const names = Object.keys(globals);
  const load = (helpers) => { let lib = null; const hn = Object.keys(helpers);
    new Function('mergeInto', 'LibraryManager', ...hn, ...names, src)((_t, obj) => { lib = obj; }, { library: {} },
      ...hn.map((n) => helpers[n]), ...names.map((n) => globals[n])); return lib; };
  const first = load({}); const helpers = {};
  for (const k of Object.keys(first)) if (k.startsWith('$')) helpers[k.slice(1)] = first[k];
  const library = load(helpers);
  let bBackAt = null;
  library.BlwpInit(0x5eed1234);
  if (library.BlwpNetStart(0, 6, 60) !== 1) throw new Error('the bridge would not start');
  for (let i = 0; i < 600 && !(Module.blwpNet.client && Module.blwpNet.client.where); i++) await wait(50);
  if (!Module.blwpNet.client) throw new Error(`the session never opened: ${Module.blwpNet.error}`);
  const eidHex = toHex(Module.blwpNet.where.entryId);
  // WF: THE RUN'S FINAL MARK TO B WAITS UNTIL B HAS APPLIED ITS CLOSE (its round no longer OPEN, 0) - harness only; the
  // page and the signer node run unchanged. Batches, and every mark of the run before it, pass as they do now.
  const markGate = { held: 0, releasedAt: null };
  if (CASE === 'WF') {
    const cl0 = Module.blwpNet.client; const realSendPeer = cl0.sendPeer.bind(cl0); const bBase = nodeUrl(round.b);
    const bOpen = () => { try { const r = round.b.round.get(fromHex(named.roundIdHex)); return !r || r.state === 0; } catch { return true; } };
    cl0.sendPeer = async (base, bytes) => {
      // ONLY THE RUN'S FINAL MARK, after the core said DELIVERED - the run's own marks go as they always did.
      const fl = cl0.finalLink;
      if (base === bBase && deliveredAt !== null && fl && bytes && bytes.length === fl.bytes.length && bytes.every((v, i) => v === fl.bytes[i])) {
        markGate.held++;
        while (bBackAt === null || bOpen()) await wait(50);
        if (markGate.releasedAt === null) markGate.releasedAt = Date.now();
      }
      return realSendPeer(base, bytes);
    };
  }
  // THE PAGE'S TICK CLOCK: when (if ever) the page closes it, and when it last posted a tick.
  const clockSeen = { closedAt: null, lastPostAt: null, lastPostTick: null };
  if (Module.blwpTickClock) {
    const c0 = Module.blwpTickClock.close.bind(Module.blwpTickClock); const p0 = Module.blwpTickClock.post.bind(Module.blwpTickClock);
    Module.blwpTickClock.close = () => { if (clockSeen.closedAt === null) clockSeen.closedAt = Date.now(); return c0(); };
    Module.blwpTickClock.post = (e, t, ms) => { clockSeen.lastPostAt = Date.now(); clockSeen.lastPostTick = t; return p0(e, t, ms); };
  }
  // EACH SIGNER NODE'S HELD CHECKPOINTS FOR THIS ENTRY, sampled: the final mark reached a node when its count reaches A's.
  const heldMarks = async () => Promise.all(round.daemons.map(async (d) => {
    try { const r = await realFetch(`${nodeUrl(d)}/checkpoints?round=${named.roundIdHex}&entry=${eidHex}`); return Number(r.headers.get('x-checkpoints')); }
    catch { return 'down'; } }));
  const marksTrace = [];
  const heldTicksNow = async () => Promise.all(round.daemons.map(async (d) => {
    try { const r = await realFetch(`${nodeUrl(d)}/transcript?round=${named.roundIdHex}&entry=${eidHex}`); await r.arrayBuffer(); return Number(r.headers.get('x-ticks')); }
    catch { return 'down'; } }));
  const sampler = setInterval(async () => { marksTrace.push({ ms: Date.now(), held: await heldMarks(), ticks: await heldTicksNow() }); }, 500);
  say_({ step: 'session', entry: eidHex.slice(0, 16), sessionKeyExtractable: false });

  // C: SIGNER NODE B GOES DOWN AS THE PLAYER ANSWERS - before the page signs and posts.
  let bDownAt = null;
  if (CASE === 'C') onPrompt = () => { bDownAt = Date.now(); round.b.close(); };

  // ---- DRIVE: a player steering at the gate off the bridge's own core, at the page's pace. ----
  const t0 = Date.now();
  let ticks = 0;
  while (ticks < 1320 && !hookCalls.length) {
    const st = Module.blwp.st;
    library.BlwpStep(...steer(st));
    ticks++;
    if (ticks % 4 === 0) await wait(16);
  }
  for (let i = 0; i < 100 && !asks.length; i++) await wait(50);
  const asked = asks.length ? await asks[0] : null;
  const coreNow = { word: Module.blwp.st.i32[18 + 5], score: Module.blwp.st.i32[18 + 4] };
  say_({ step: 'run over', ticks, ms: Date.now() - t0, expected, core: coreNow, hookCalls, prompts: prompts.length, asked, doorPosts });
  // ANY SECOND HOOK CALL (the client's own end) asks nothing more.
  await wait(3000);
  for (const a of asks.slice(1)) await a;

  const standing = async (d) => { try { return await (await realFetch(`${nodeUrl(d)}/lock-settlement?round=${named.roundIdHex}`)).json(); } catch (e2) { return { state: 'unreachable', why: e2.message }; } };
  const winningsAt = async (d) => { try { return await (await realFetch(`${nodeUrl(d)}/winnings?entry=${eidHex}`)).json(); } catch { return { winnings: 'unreachable' }; } };
  const heldAddress = () => round.daemons.map((d) => { try { const x = d.round.payoutAddress(fromHex(eidHex)); return x ? x.address : null; } catch { return 'down'; } });

  if (CASE === 'C') {
    // RELOAD, B UP AGAIN: index.html's load resends; the hook firing again asks nothing.
    await wait(2000);
    await round.restartB();
    await wait(1000);
    const before = doorPosts.length;
    const reload = await pageLoad();
    pageHook('FINISHED', Module.blwpNet.winningsRun());
    for (const a of asks.slice(1)) await a;
    say_({ step: 'reload with B up', bDownForMs: bDownAt ? Date.now() - bDownAt : null, postsNow: doorPosts.slice(before), reload, prompts: prompts.length, held: heldAddress() });
  } else {
    // W: the page loads again once B is back, so the address reaches it as case C's reload does.
    if (W_LIKE && CASE !== 'WC') for (let i = 0; i < 40 && bBackAt === null; i++) await wait(250);
    const before = doorPosts.length;
    const reload = await pageLoad();
    pageHook('FINISHED', Module.blwpNet.winningsRun());
    for (const a of asks.slice(1)) await a;
    say_({ step: 'reload', postsNow: doorPosts.slice(before), reload, prompts: prompts.length, held: heldAddress() });
  }

  // ---- CLOSE, FINAL, SETTLE, SEND. ----
  // W: THE CLOSE COMES AFTER B'S CATCH-UP HAS HAD ITS CHANCE - 5 s after B is back, the spacing last-mark-window-probe.mjs
  // measured the two-of-two with (CLOSE_AFTER_BACK_MS=0 closes at once, as the first W did: every node then refuses the
  // re-offered mark "the round is closed").
  if (CASE === 'W') { const after = Number(env.CLOSE_AFTER_BACK_MS ?? 5000); while (bBackAt === null || Date.now() < bBackAt + after) await wait(100); }
  // WF, THE FORCED MISS (ruled 2026-09-24): the close only once B's inputs are whole - the page's feed has landed - while
  // the final mark to B is held back (the gate on sendPeer below) until B has applied its close. Every run is then a node
  // whose inputs are whole and which is short only the mark when its close is applied.
  if (CASE === 'WF') {
    for (const stop = Date.now() + 60000; Date.now() < stop; await wait(100)) {
      const t = await heldTicksNow();
      if (bBackAt !== null && Number.isInteger(t[1]) && t[1] === t[0] && t[0] > 0) break;
    }
  }
  const closeSentAt = Date.now();
  await Promise.all(round.daemons.map((d) => tell(d.port, `close ${named.roundIdHex}`).catch((x) => x.message)));
  // THE CHAIN MOVES ON, as mainnet's does: past a minute with nothing settled, one block every 20 s, so the takeover
  // order (M3.3-19: seat k once the chain is k x 2 blocks past the round's beacon) can hand the round on.
  let settled = null; let mined = 0; const closedAt = Date.now(); let lastMine = Date.now();
  for (const stop = Date.now() + 420000; Date.now() < stop; await wait(1000)) {
    const s = await standing(round.a);
    if (s.state === 'ACCEPTED') { settled = s; break; }
    if (Date.now() - closedAt > 60000 && Date.now() - lastMine > 20000) { cli('generatetoaddress', '1', cli('getnewaddress')); mined++; lastMine = Date.now(); }
  }
  say_({ step: 'blocks mined while waiting', mined, seconds: Math.round((Date.now() - closedAt) / 1000) });
  // WC: THE COMBINE CAME WITH B DOWN. Only now is B served again, closed as its operator's restart would, and the page
  // loads again (its address posted to B). Then: B's own signed result, whether B keeps a held-back ask, B's answer to
  // the run's final mark, and whether the page re-offered anything after the combine.
  let wc = null;
  if (CASE === 'WC') {
    const cl = Module.blwpNet.client;
    const combinedAtWC = settled ? Date.now() : null;
    const relinksAtCombine = cl.finalRelinks || 0;
    await round.restartB();
    bBackAt = Date.now();
    const closeB = await tell(round.b.port, `close ${named.roundIdHex}`).catch((x) => x.message);
    await pageLoad();
    let bResult = null;
    for (let i = 0; i < 180 && !bResult; i++) {
      try { if (round.b.round.hasResult(fromHex(named.roundIdHex), fromHex(eidHex), round.b.round.pubkey)) bResult = true; } catch { /* not yet */ }
      if (!bResult) await wait(1000);
    }
    const heldAsk = round.b.round.heldFinalAsk(fromHex(eidHex));
    const markReply = cl.finalLink ? await tell(round.b.port, cl.finalLink.bytes).catch((x) => x.message) : 'no final link';
    await wait(5000);
    wc = { combinedAtMs: combinedAtWC && deliveredAt ? combinedAtWC - deliveredAt : null, bBackAfterCombineMs: combinedAtWC ? bBackAt - combinedAtWC : null,
      closeB: String(closeB).slice(0, 60), bSignedWithin180s: !!bResult, bHeldAsk: heldAsk ? { tick: heldAsk.tick } : null,
      markReply: typeof markReply === 'string' ? markReply.slice(0, 80) : `${markReply.length} bytes (a receipt)`,
      catchUp: cl.finalCatchUp || (cl.catchingUp ? 'still running' : null), relinksAtCombine, relinksAfter: (cl.finalRelinks || 0) - relinksAtCombine };
    say_({ step: 'combine first', ...wc });
  }
  // AT EVERY SIGNER NODE: its OWN signed result (outcome, score, transcript hash), the ticks its transcript door holds,
  // its checkpoints, and the receipts it holds for the run's final mark - each read from that node alone.
  if (W_LIKE) {
    for (let i = 0; i < 90; i++) {                                 // every node's own result in hand, or 90 s
      const got = await Promise.all(round.daemons.map(async (d) => { try { return d.round.hasResult(fromHex(named.roundIdHex), fromHex(eidHex), d.round.pubkey); } catch { return false; } }));
      if (got.every(Boolean)) break; await wait(1000);
    }
    const cl = Module.blwpNet.client;
    const finalId = cl.finalLink ? cl.finalLink.id : null;
    const atNodes = await Promise.all(round.daemons.map(async (d) => {
      const own = toHex(d.round.pubkey);
      const r = await realFetch(`${nodeUrl(d)}/results?round=${named.roundIdHex}&entry=${eidHex}`);
      const b = new Uint8Array(await r.arrayBuffer());
      let mine = null;
      for (let i = 0; i + SIGNED_RESULT_BYTES <= b.length; i += SIGNED_RESULT_BYTES) {
        const x = decodePlayerResult(splitSignedResult(b.subarray(i, i + SIGNED_RESULT_BYTES)).body);
        if (toHex(x.nodePubkey) === own) mine = { outcome: x.outcome, score: x.score, transcript: toHex(x.transcriptHash).slice(0, 16) };
      }
      const t = await realFetch(`${nodeUrl(d)}/transcript?round=${named.roundIdHex}&entry=${eidHex}`); await t.arrayBuffer();
      const c = await realFetch(`${nodeUrl(d)}/checkpoints?round=${named.roundIdHex}&entry=${eidHex}`); await c.arrayBuffer();
      return { node: own.slice(0, 8), result: mine, ticks: Number(t.headers.get('x-ticks')), checkpoints: Number(c.headers.get('x-checkpoints')),
        finalMarkReceipts: finalId ? d.round.receiptCount(finalId) : null };
    }));
    const same = (k) => new Set(atNodes.map((x) => JSON.stringify(x[k]))).size === 1;
    if (CASE === 'WC') {
      const bKey = toHex(round.b.round.pubkey).slice(0, 8);
      const six = atNodes.filter((x) => x.node !== bKey); const b = atNodes.find((x) => x.node === bKey);
      const one = (xs, k) => new Set(xs.map((x) => JSON.stringify(x[k]))).size === 1;
      say_({ step: 'combine first, at every node', atNodes, finalMarkReceiptsOnClient: finalId ? cl.witnessed(finalId) : null,
        pass: one(six, 'result') && six.every((x) => x.result && x.result.outcome === 'DELIVERED' && x.finalMarkReceipts === 6)
          && !!(b && b.result && b.result.outcome === 'FAILED' && b.result.transcript !== six[0].result.transcript)
          && wc && wc.bHeldAsk === null && /the round is closed/.test(wc.markReply) && wc.catchUp === 'combined' && wc.relinksAfter === 0 });
    }
    say_({ step: 'at every node', markGate, finalMarkReceiptsOnClient: finalId ? cl.witnessed(finalId) : null, atNodes,
      sameResult: same('result'), sameTicks: same('ticks'), sameCheckpoints: same('checkpoints'),
      pass: same('result') && same('ticks') && same('checkpoints') && atNodes.every((x) => x.result && x.result.outcome === 'DELIVERED' && x.finalMarkReceipts === 7)
        && finalId && cl.witnessed(finalId) === 7 });
  }
  if (W_LIKE) {
    clearInterval(sampler);
    const combinedAt = settled ? Date.now() : null;
    const rel = (t) => (t === null || deliveredAt === null ? null : t - deliveredAt);
    const finalCount = Math.max(...marksTrace.flatMap((x) => x.held.filter(Number.isInteger)));
    const bReached = marksTrace.find((x) => x.held[1] === finalCount);
    say_({ step: 'window', deliveredAt: 0, bDownMs: 7000, bBackMs: rel(bBackAt), combinedMs: rel(combinedAt),
      tickClock: { closedMs: rel(clockSeen.closedAt), lastPostMs: rel(clockSeen.lastPostAt), lastPostTick: clockSeen.lastPostTick },
      finalMarkCount: finalCount, bReachedFinalMs: bReached ? rel(bReached.ms) : null,
      reofferLandedBeforeCombine: !!(bReached && combinedAt && bReached.ms <= combinedAt),
      heldAtBack: (marksTrace.find((x) => bBackAt && x.ms >= bBackAt) || {}).held || null, heldAtEnd: (marksTrace.at(-1) || {}).held || null,
      bInputsCaughtUpMs: (() => { const top = Math.max(...marksTrace.flatMap((x) => (x.ticks || []).filter(Number.isInteger))); const hit = marksTrace.find((x) => x.ticks && x.ticks[1] === top); return hit ? rel(hit.ms) : null; })(),
      closeSentMs: rel(closeSentAt),
      clientView: (() => { const cl = Module.blwpNet.client; return { finalLink: cl.finalLink ? { tick: cl.finalLink.tick, witnessed: cl.witnessed(cl.finalLink.id), of: cl.nodes.length } : null,
        finalRelinks: cl.finalRelinks || 0, finalRelinkWhy: String(cl.finalRelinkWhy || '').slice(0, 300), finalCatchUp: cl.finalCatchUp || (cl.catchingUp ? 'still running' : null), pendingLink: cl.pendingLink && cl.pendingLink.tick,
        peers: cl.peerBatches().map((x) => ({ base: x.base.slice(-5), ticks: x.ticks, down: x.down, closed: x.closed, refused: x.refused, why: String(x.why || '').slice(0, 90) })) }; })() });
  }
  const settledBefore = await settledOnAlice();
  let rows = null;
  if (CASE !== 'B') for (const stop = Date.now() + 180000; Date.now() < stop; await wait(2000)) {
    rows = await Promise.all(round.daemons.map(winningsAt));
    if (rows.every((r) => r.winnings && r.winnings.state === 'PAID')) break;
  }
  if (CASE === 'B') { await wait(20000); rows = await Promise.all(round.daemons.map(winningsAt)); }
  const send = rows && rows.map((r) => r.send).find((x) => x && x.txid);
  // EACH SIGNER NODE'S OWN RECORD OF THE WINNER'S RUN: the outcome and score it signed, as its settlement reads them.
  const recordOf = (d) => { try {
    const on = d.settlements.entriesOnRecord(fromHex(named.roundIdHex), named.round);
    if (!on.ok) return on.why.slice(0, 120);
    const e = on.entries.find((x) => toHex(x.entryId) === eidHex);
    return e ? `${e.outcome} ${e.score}` : 'no record';
  } catch (x) { return `down: ${x.message}`.slice(0, 80); } };
  say_({ step: 'each node\'s record of the winner', records: round.daemons.map(recordOf) });
  const inv = send ? await lncli('alice', 'lookupinvoice', send.paymentHash) : null;
  say_({ step: 'settled', state: settled ? settled.state : (await standing(round.a)).state, why: settled && settled.why,
    moved: settled && settled.moved && { claims: settled.moved.claims, payouts: settled.moved.payouts, pooled: settled.moved.pooled, stakeWhy: settled.moved.stakeWhy },
    invoicesAsked, alice: inv && { state: inv.state, amtPaidMsat: inv.amt_paid_msat, htlcs: (inv.htlcs || []).length },
    preimageHashes: send && send.preimage ? toHex(sha256(fromHex(send.preimage))) === send.paymentHash : null,
    rows: rows && rows.map((r) => r.winnings && r.winnings.state), held: heldAddress(),
    loserLockStored: await port.status(lk.outpoint), winnerLockStored: await port.status(made.outpoint) });

  // ---- RESTART BOTH, 30 s: nothing more. ----
  if (CASE !== 'B') {
    const before = { invoicesAsked: invoicesAsked.length, settledOnAlice: await settledOnAlice(), settlements: settled && settled.txid };
    await restartAll();
    await wait(30000);
    const after = { invoicesAsked: invoicesAsked.length, settledOnAlice: await settledOnAlice(), settlements: (await standing(round.a)).txid };
    say_({ step: 'restart', before, after, settledBeforeSends: settledBefore, rows: (await Promise.all(round.daemons.map(winningsAt))).map((r) => r.winnings && r.winnings.state) });
  }
  // ---- A DIFFERENT ADDRESS FOR THE SAME ENTRY: signed by the same session key, through the bridge's own call. ----
  if (CASE === 'C' || W_LIKE) {
    const other = `thief@127.0.0.1:${lnurlServer.address().port}`;
    const sig = await Module.blwpNet.winningsRun().signAddress(other);
    const body = new Uint8Array([...new TextEncoder().encode(other), ...sig]);
    const said = [];
    for (const d of round.daemons) { const r = await realFetch(`${nodeUrl(d)}/payout-address?entry=${eidHex}`, { method: 'POST', body }); said.push([r.status, (await r.text()).trim().slice(0, 80)]); }
    const refusedNonAddress = await Module.blwpNet.winningsRun().signAddress('not an address').then(() => false, () => true);
    say_({ step: 'another address', said, held: heldAddress(), bridgeRefusesToSignANonAddress: refusedNonAddress });
  }
  say_({ step: 'counts', prompts: prompts.length, doorPostsPerNode: Object.fromEntries(round.daemons.map((d) => [nodeUrl(d), doorPosts.filter((x) => x.node === nodeUrl(d)).map((x) => x.status)])),
    tabKeys: [...TAB.keys()].filter((k) => k.startsWith('arena.winnings')).map((k) => k.split('.').slice(0, 3).join('.')) });
  try { const cl = Module.blwpNet && Module.blwpNet.client; if (cl) { cl.ended = true; cl.close(); } if (Module.blwpTickClock) Module.blwpTickClock.close(); } catch { /* gone */ }
} catch (err) {
  say_({ step: 'error', why: err.message, stack: String(err.stack).split('\n').slice(0, 4) });
  exitCode = 1;
} finally {
  await round.close().catch(() => {});
  lnurlServer.close();
}
process.exit(exitCode);
