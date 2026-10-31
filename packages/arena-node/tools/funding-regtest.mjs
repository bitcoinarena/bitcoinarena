#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PROJECT FUNDING PROPOSAL'S SIGNAL, DECIDED BY THE REAL RULE, ON A PRIVATE REGTEST (kanban #397, spec §27A.9.3 + §27A.9.5).
// Never testnet4, never mainnet, nothing paid, no bond anywhere but this chain's own.
//
//   BITCOIN_BIN=<dir with bitcoind, bitcoin-cli> WORK=<empty dir> [FUNDING=short|spec] [RPCPORT=29511] [SEAT_PORT=29521]
//     node tools/funding-regtest.mjs        (from packages/arena-node)
//
// Three seats - `node src/main.js`, each its own store and identity, ARENA_FUNDING_SCHEDULE=short unless FUNDING=spec - bonded on
// this chain. The signal rule a seat runs (funding-book.js decide, server.js activeAt / seasonedNodes) counts a node only when
//   SEASONED  its bond confirmed at least `season` blocks before the proposal's publication, and
//   ACTIVE    it served rounds - signed FINALs, read from every seat - in at least 3 of the 4 `week`s before the signal's end,
//             each week the window [MTP(end - (k+1) week), MTP(end - k week)) on the chain's median time.
// Nothing here stands in for that: the rounds are real free nextblock rounds, published on this chain under their beacon,
// entered, driven, closed, posted and FINAL-signed by the seats after the 600 s objection window, one in each of three weeks.
//
// THE HEIGHTS (W = week): round 0 at h0, round 1 at h0 + W, round 2 at h0 + 2W; the signal ends at E = h0 + 2.5W, so the
// three rounds sit in the middle of weeks 2, 1 and 0 before E, and week 3 (the oldest) has none - 3 of 4. The proposal is
// published at P = E - signal and every seat signals at P; before h0 the chain is mined past bond + season - (P - h0).
// Each round's FINALs are signed on the seats' wall clocks; before a round starts the tool waits until the wall clock is past
// the tip's median time, and the blocks after it are mined after its FINALs, so its FINAL time falls inside its week.
//
// One JSON line per reading: the bonds and their heights, each round (publication, beacon, entry, result, FINAL times),
// the week windows on the chain's clock with the rounds in each, GET /funding at every seat once the signal is decided
// (supporters / active / pct / needed) and once the vote opened (its period and census height). Everything is stopped at the end.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import WebSocket from 'ws';
import { regtest } from './regtest-bond.mjs';
import { RUN_82_TICKS } from './round-2of2.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { bondSetFor } from '../src/curve.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { NEXTBLOCK_CORES, TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../nextblock/plugin/truck-cores.js';
import { drivenTape, bedFrom, GENESIS_HASH } from '../test/window-fixture.js';
import { worldSeedFor } from '../../arena-client/src/join.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_KEYS_REGTEST as KEYS } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { encodeRoundContract, decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { publicationPayload } from '../../arena-protocol/src/publication.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { worldIsShared } from '../../arena-protocol/src/seed.js';
import { sharedWorldOf } from '../../arena-protocol/src/known-game.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { OBJECTION_WINDOW_MS, FINAL_TOLERANCE_MS } from '../../arena-protocol/src/constants.js';
import { splitSignedFinalSig, decodeFinalSig } from '../../arena-protocol/src/final-sig.js';
import { FUNDING_SCHEDULES, encodeFundingProposal, fundingProposalId, encodeFundingSignal, fundingSignalId } from '../../arena-protocol/src/funding.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

const env = process.env;
const B = env.BITCOIN_BIN, WORK = env.WORK;
if (!B || !WORK) throw new Error('BITCOIN_BIN=<bin dir> WORK=<dir>');
const SCHEDULE_NAME = env.FUNDING === 'spec' ? 'spec' : 'short';
const S = FUNDING_SCHEDULES[SCHEDULE_NAME];
const W = S.week;
const RPC = Number(env.RPCPORT || 29511), P2P = RPC + 1;
const PORTS = [0, 1, 2].map((i) => Number(env.SEAT_PORT || 29521) + 10 * i);
const BONDS = [50000000n, 30000000n, 20000000n];
const ENTRY_WINDOW_MS = 60000n;
const say = (o) => console.log(JSON.stringify({ t: '#397', at: new Date().toISOString().slice(11, 19), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (h) => String(h).slice(0, 16);
const iso = (ms) => new Date(Number(ms)).toISOString().slice(11, 23);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
mkdirSync(join(WORK, 'btc'), { recursive: true });

// ---- bitcoind, a wallet, coins
const bitcoind = spawn(`${B}/bitcoind`, ['-regtest', `-datadir=${WORK}/btc`, `-rpcport=${RPC}`, `-port=${P2P}`, '-listen=0', '-fallbackfee=0.0002', '-txindex=1'], { stdio: 'ignore' });
const cli = (...a) => execFileSync(`${B}/bitcoin-cli`, ['-regtest', `-datadir=${WORK}/btc`, `-rpcport=${RPC}`, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
for (let n = 0; n < 60; n++) { try { cli('getblockcount'); break; } catch { await wait(500); } }
const wcli = (...a) => cli(...(a[0] === 'listwallets' || a[0] === 'createwallet' || a[0] === 'loadwallet' ? a : ['-rpcwallet=fund', ...a]));
const rt = regtest(wcli, { wallet: 'fund', network: 'regtest' });
const tip = () => rt.height();
const mineN = (n) => { for (let left = n; left > 0;) { const k = Math.min(left, 200); rt.mine(k); left -= k; } return tip(); };
const mineTo = (h) => (tip() < h ? mineN(h - tip()) : tip());
const mtpMs = (h) => Number(JSON.parse(cli('getblockheader', cli('getblockhash', String(h)))).mediantime) * 1000;
const timeMs = (h) => Number(JSON.parse(cli('getblockheader', cli('getblockhash', String(h)))).time) * 1000;
rt.mine(250);
// every block a header read reads once (the census view of each round reads from the bonds up)
const blockCache = new Map();
const blocksFrom = (from, to) => { const blocks = [];
  for (let h = from; h <= to; h++) { if (!blockCache.has(h)) blockCache.set(h, rt.blocksFrom(h, h).blocks[0]); blocks.push(blockCache.get(h)); }
  return { blocks, firstHeight: from }; };
say({ step: 'bitcoind', rpc: RPC, schedule: SCHEDULE_NAME, rules: S, height: tip() });

// ---- three seats
const stores = PORTS.map((_, i) => join(WORK, `node-${i + 1}.db`));
const ids = stores.map((p) => { const db = openStore(p); const id = nodeIdentity(db); db.close(); return id; });
const procs = PORTS.map((port, i) => {
  const e = { ...env, ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: `${WORK}/btc/regtest/.cookie`, ARENA_FUND_FREE_ROUNDS: '1',
    ARENA_APPS: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname, ARENA_DONATION_NETWORK: 'regtest',
    ARENA_REGTEST_DONATION_SET: 'keys', ARENA_LOWEST_BOND_MIN_SATS: '100000', ARENA_CLOSE_AT_END: '1', ARENA_RESERVE_DKG: '0' };
  if (SCHEDULE_NAME === 'short') e.ARENA_FUNDING_SCHEDULE = 'short'; else delete e.ARENA_FUNDING_SCHEDULE;
  delete e.ARENA_SERIES_FILE; delete e.ARENA_GAMES;
  const p = spawn(process.execPath, ['src/main.js', String(port), stores[i]], { cwd: new URL('..', import.meta.url).pathname, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [p.stdout, p.stderr]) s.on('data', (d) => appendFileSync(join(WORK, `node-${i + 1}.log`), d));
  return p;
});
const URLS = PORTS.map((p) => `http://127.0.0.1:${p}`);
const http = (i, path, init) => fetch(`${URLS[i]}${path}`, init);
for (let i = 0; i < 3; i++) { for (let n = 0; n < 120; n++) { try { if ((await http(i, '/identity')).ok) break; } catch { /* not yet */ } await wait(500); } }
const keys = ids.map((id) => toHex(id.pubkey));
say({ step: 'seats', ports: PORTS, pids: procs.map((p) => p.pid), keys: keys.map(short) });
let stopped = false;
const stopAll = async () => { if (stopped) return; stopped = true; for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* gone */ } } await wait(2000); try { cli('stop'); } catch { bitcoind.kill('SIGTERM'); } await wait(2000); };
process.on('uncaughtException', async (e) => { console.error(e); await stopAll(); process.exit(1); });
process.on('SIGINT', async () => { await stopAll(); process.exit(130); });
process.on('SIGTERM', async () => { await stopAll(); process.exit(143); });

const getJson = async (i, path) => (await http(i, path)).json();
const fundingAt = (i) => getJson(i, '/funding');

let failed = null;
try {
  // ---- their bonds, and a season on them. Locked past the vote's last block + lockAfterVote (rule 1), so the vote the signal
  // opens has voters: the slack covers the season, the four weeks, the vote and the lock after it
  const LOCK_SLACK = S.season + 4 * W + S.vote + S.lockAfterVote + 200;
  const bondFrom = tip();
  const posted = ids.map((id, i) => { const p = rt.postBond(id.secret, { endpoint: `ws://127.0.0.1:${PORTS[i]}`, hostedGames: [NEXTBLOCK.gameId], bondSats: BONDS[i], slackBlocks: LOCK_SLACK }); rt.include([p.hex]); return p; });
  mineN(1);
  const bondHeights = posted.map((p) => JSON.parse(wcli('gettransaction', p.txid)).blockheight);
  mineN(6);
  say({ step: 'bonds', sats: BONDS, txids: posted.map((p) => short(p.txid)), confirmedAt: bondHeights, maturity: posted.map((p) => p.maturity), tip: tip() });

  // the heights: the first round at h0, the signal's end at E = h0 + 2.5W, its publication at P = E - signal. The bond must be
  // a season old at P: the chain is mined until h0 leaves that
  const lastBond = Math.max(...bondHeights);
  const h0 = Math.max(tip() + 1, lastBond + S.season - Math.floor(2.5 * W) + S.signal + 12, Math.ceil(1.5 * W) + 1);
  const E = h0 + Math.floor(2.5 * W), P = E - S.signal;
  mineTo(h0);
  say({ step: 'season', bondConfirmedAt: lastBond, season: S.season, h0, publishAt: P, signalEnd: E, bondAgeAtPublication: P - lastBond, seasoned: P - lastBond >= S.season, tip: tip() });

  // ---- a free nextblock round, published on this chain, played to FINAL
  const nodes = [...ids.map((id) => id.pubkey)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const base = { networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 3, settlementSlots: 3, gameId: NEXTBLOCK.gameId,
    simCoreHash: TRUCK_CORE_HASH, randomnessRule: 'bitcoin-block-hash', objectionWindowMs: OBJECTION_WINDOW_MS, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, donationSetId: donationSetId(KEYS.recipients), censusRoot: new Uint8Array(32),
    stakeMsat: 0n, bondMinSats: 50000n, blockTicks: RUN_82_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30,
    timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes, publicationRelays: URLS };
  const contractAt = (censusHeight) => {
    const committeeTimeMs = BigInt(timeMs(censusHeight)) + 2000n;
    const c = decodeRoundContract(encodeRoundContract({ ...base, censusHeight, committeeTimeMs, startTimeMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS,
      entryCloseMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS + ENTRY_WINDOW_MS }));
    const view = blocksFrom(Math.max(0, bondFrom - 20), censusHeight);
    const byTxid = new Map();
    for (const block of view.blocks) for (const raw of block.transactions || []) { try { byTxid.set(toHex(parseTransaction(raw).txid), raw); } catch { /* not one */ } }
    const census = deriveCensus(view, { contract: c, bond: bondSetFor('regtest'), verifyUpdate: verify,
      resolve: (x) => { const raw = byTxid.get(toHex(x.txid)); return raw ? { transaction: raw } : null; } });
    if (!census.ok) throw new Error(`no census at ${censusHeight}: ${census.why}`);
    return { ...c, censusRoot: census.root };
  };
  const publish = async (c) => {
    const raw = wcli('createrawtransaction', '[]', JSON.stringify([{ data: toHex(publicationPayload(roundId(c))) }]));
    const funded = JSON.parse(wcli('fundrawtransaction', raw, JSON.stringify({ fee_rate: 2 }))).hex;
    const signed = JSON.parse(wcli('signrawtransactionwithwallet', funded)).hex;
    wcli('generateblock', wcli('getnewaddress'), JSON.stringify([signed]));
    const publishedAt = tip();
    for (let tries = 0; ; tries++) {
      const view = blocksFrom(c.censusHeight - 20, tip());
      const named = beaconFromChain(c, { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight });
      if (named.ok) return { publishedAt, beacon: named.height };
      if (tries > 12) throw new Error(`no beacon: ${named.why}`);
      const w = Number(c.committeeTimeMs) + 1500 - Date.now();
      if (w > 0) await wait(w);
      mineN(3);
    }
  };
  const sayAt = (node, message) => new Promise((ok, no) => {
    const ws = new WebSocket(`${node.replace(/^http/, 'ws')}/play`);
    const t = setTimeout(() => { try { ws.close(); } catch { /* closed */ } no(new Error('no answer in 20 s')); }, 20000);
    ws.on('open', () => ws.send(message));
    ws.on('message', (d, bin) => { clearTimeout(t); ok(bin ? new Uint8Array(d) : d.toString()); ws.close(); });
    ws.on('error', (e) => { clearTimeout(t); no(e); });
  });
  const rounds = [];
  async function playRound(k) {
    const t0 = Date.now();
    // the wall clock past the tip's median time, then a fresh block: the committee time is now, and every FINAL comes after
    // the median time of every block below
    for (;;) { const lead = mtpMs(tip()) - Date.now(); if (lead < -2000) break; await wait(Math.min(lead + 2500, 30000)); }
    mineN(1);
    const c = contractAt(tip());
    const rid = toHex(roundId(c));
    const pub = await publish(c);
    const took = await Promise.all(URLS.map(async (_, i) => { const r = await http(i, '/round', { method: 'POST', body: encodeRoundContract(c) }).catch((e) => ({ status: `error ${e.message}`, text: async () => '' }));
      return { status: r.status, said: (await r.text()).slice(0, 200) }; }));
    say({ step: 'round', k, round: short(rid), censusHeight: c.censusHeight, publishedAt: pub.publishedAt, beacon: pub.beacon, posted: took.map((x) => x.status), said: took.find((x) => !(x.status < 300))?.said });
    if (took.filter((x) => x.status < 300).length < 2) throw new Error(`round ${k} not taken: ${took.map((x) => `${x.status} ${x.said}`).join(' | ')}`);
    // ---- the entry: free, a fresh player and session key
    let sk; do { sk = secp256k1.utils.randomSecretKey(); } while (secp256k1.getPublicKey(sk, true)[0] !== 0x02);
    const session = ed25519.utils.randomSecretKey();
    const z32 = new Uint8Array(32);
    const rand = (n) => new Uint8Array(randomBytes(n));
    const entry = { roundId: fromHex(rid), playerPubkey: schnorr.getPublicKey(sk), sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(rand(32)),
      stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n, joinTick: 0, worldSecret: worldIsShared(c, sharedWorldOf(c.gameId)) ? z32 : rand(32), vssSharesRef: z32,
      stakePoint: new Uint8Array(33), feePreimage: z32, stakeLockOutpoint: { txid: z32, outIdx: 0n }, feeLockOutpoint: { txid: z32, outIdx: 0n }, claimKeyAttestationRef: z32 };
    const eid = toHex(entryId(entry));
    let entered = [];
    for (let n = 0; n < 20; n++) {
      entered = await Promise.all(URLS.map(async (u) => { try { const r = await fetch(`${u}/entry`, { method: 'POST', body: encodeEntryContract(entry) }); return { status: r.status, said: (await r.text()).slice(0, 160) }; } catch (e) { return { status: 'error', said: e.message }; } }));
      if (entered.filter((x) => x.status < 300).length >= receiptsNeeded(3)) break;
      await wait(3000);
    }
    say({ step: 'entry', k, entry: short(eid), took: entered.map((x) => x.status), said: entered.find((x) => !(x.status < 300))?.said });
    if (entered.filter((x) => x.status < 300).length < receiptsNeeded(3)) throw new Error(`round ${k}: the entry was not taken`);
    // ---- the run, driven to the gate by the truck's closed-loop driver, its batches and marks over /play
    // the seats read the beacon from their own chain on their own cadence: asked again, a block now and then
    let seed = null;
    for (let n = 0; !seed; n++) {
      try { seed = await worldSeedFor({ entry, round: rid, nodes: URLS, contract: c }); } catch (e) {
        if (n >= 40) throw e;
        if (n % 5 === 4) mineN(1);
        await wait(3000);
      }
    }
    const core = NEXTBLOCK_CORES.get(toHex(c.simCoreHash));
    const config = core.configs.get(toHex(c.configHash)) || {};
    const N = c.blockTicks, FIRST = Math.min(60, N);
    const loads0 = bedFrom(0);
    const drive = drivenTape(seed.seedWord, N);
    const A = core.adapter;
    const st = A.start(seed.seedWord, config, { runTicks: N, ...(seed.slot === undefined ? {} : { slot: seed.slot }) });
    const ev = A.eventsOf({ loads: loads0 });
    const stateAt = [];
    for (let t = 0; t < N; t++) { ev.before(st, t); A.step(st, drive.tape[t]); if (t + 1 === FIRST || t + 1 === N) stateAt[t + 1] = A.stateHash(st); }
    const local = A.result(st);
    const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
    const msgs = [];
    let previousHash = GENESIS_HASH, previousMark = NO_PREVIOUS;
    for (let from = 0; from < N;) {
      const to = from === 0 ? FIRST : Math.min(N, from + 600);
      const b = { roundId: fromHex(rid), entryId: fromHex(eid), previousHash, firstTick: from, ticks: drive.tape.slice(from, to), liquidations: [], loads: from === 0 ? loads0 : [] };
      msgs.push([encodeInputBatch(b), `batch ${from}`]);
      previousHash = batchId(b);
      if (to === FIRST || to === N) {
        const m = { roundId: fromHex(rid), entryId: fromHex(eid), tick: to, stateHash: fromHex(stateAt[to]), inputChainHash: previousHash, previousHash: previousMark, sessionPubkey: entry.sessionPubkey };
        msgs.push([sign(m), `mark ${to}`]);
        previousMark = checkpointId(m);
      }
      from = to;
    }
    const startWait = Number(c.startTimeMs) - Date.now() + 2000;
    if (startWait > 0) await wait(startWait);
    const pubd = await Promise.all(URLS.map(async (u) => {
      let receipts = 0; const other = [];
      for (const [m, kind] of msgs) {
        let got; try { got = await sayAt(u, m); } catch (e) { got = `error ${e.message}`; }
        if (got instanceof Uint8Array && got.length === SIGNED_RECEIPT_BYTES) receipts++;
        else if (!(kind.startsWith('batch') && /^\d+$/.test(String(got)))) other.push(`${kind}: ${got instanceof Uint8Array ? `${got.length} bytes` : String(got).slice(0, 80)}`);
      }
      return { receipts, other: other.slice(0, 2) };
    }));
    const endMs = Number(roundEndMs(c));
    const finalAfter = endMs + Number(OBJECTION_WINDOW_MS) + Number(FINAL_TOLERANCE_MS);
    say({ step: 'played', k, seedWord: seed.seedWord, outcome: local.outcome, score: local.score, receipts: pubd.map((p) => p.receipts), refused: pubd.flatMap((p) => p.other),
      roundEnd: iso(endMs), finalFrom: iso(finalAfter) });
    // ---- FINAL: the seats sign after the objection window; read back from each seat's GET /served
    let finals = [];
    for (const until = finalAfter + 8 * 60000; Date.now() < until;) {
      await wait(Math.max(5000, Math.min(60000, finalAfter - Date.now())));
      if (Date.now() < finalAfter) continue;
      const got = await Promise.all(URLS.map(async (_, i) => { try { return await getJson(i, `/served?from=${Number(c.committeeTimeMs)}&to=${Date.now() + 60000}&finals=1`); } catch { return null; } }));
      const bySigner = new Map();
      for (const g of got) for (const r of (g && g.held) || []) if (r.roundId === rid) for (const f of r.finals) {
        const x = decodeFinalSig(splitSignedFinalSig(fromHex(f)).body);
        bySigner.set(toHex(x.signerPubkey), Number(x.signedAtMs));
      }
      finals = [...bySigner.entries()].map(([key, at]) => ({ key, at }));
      if (finals.length >= 3 || (finals.length >= receiptsNeeded(3) && Date.now() > finalAfter + 60000)) break;
    }
    say({ step: 'FINAL', k, round: short(rid), entry: short(eid), signers: finals.length, needed: receiptsNeeded(3), signedAt: finals.map((f) => `${short(f.key).slice(0, 8)}@${iso(f.at)}`), tip: tip(), tipMtp: iso(mtpMs(tip())), minutes: Math.round((Date.now() - t0) / 6000) / 10 });
    if (finals.length < receiptsNeeded(3)) throw new Error(`round ${k} reached no FINAL`);
    rounds.push({ k, rid, height: c.censusHeight, finals });
    // the next blocks come after the FINALs on the chain's clock: the wall clock past the last one
    const last = Math.max(...finals.map((f) => f.at));
    if (Date.now() < last + 1500) await wait(last + 1500 - Date.now());
  }

  // ---- signals: the proposal published at P, a signal from every seat at P
  const lnurl = 'arena-397@example.com';
  let proposalId = null;
  const postFunding = async (kind, hex) => Promise.all(URLS.map(async (_, i) => { const r = await http(i, '/funding', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, hex }) }); const t = await r.text(); let body; try { body = JSON.parse(t); } catch { body = { why: t.slice(0, 200) }; } return { status: r.status, body }; }));
  const proposeAndSignal = async () => {
    const p = { networkId: NETWORK_ID_REGTEST, author: ids[0].pubkey, publishedHeight: P, amountSats: 21000n, lnurl, purpose: 'kanban #397 regtest proof: a funding proposal whose signal passes and opens the vote' };
    const pid = fundingProposalId(p);
    const hex = toHex(Uint8Array.from([...encodeFundingProposal(p), ...schnorr.sign(pid, ids[0].secret)]));
    const a = await postFunding('proposal', hex);
    proposalId = toHex(pid);
    say({ step: 'proposal', id: proposalId, publishedHeight: P, tip: tip(), amountSats: p.amountSats, status: a.map((x) => x.status), why: a.find((x) => x.status >= 300)?.body?.why });
    const sigs = [];
    for (let i = 0; i < 3; i++) {
      const s = { proposalId: pid, node: ids[i].pubkey, atHeight: P };
      const shex = toHex(Uint8Array.from([...encodeFundingSignal(s), ...schnorr.sign(fundingSignalId(s), ids[i].secret)]));
      const got = await postFunding('signal', shex);
      sigs.push({ node: short(keys[i]).slice(0, 8), atHeight: P, status: got.map((x) => x.status), why: got.find((x) => x.status >= 300)?.body?.why });
    }
    say({ step: 'signals', signals: sigs });
  };

  // ---- the three rounds, a week apart, the proposal published on the way
  for (let k = 0; k < 3; k++) {
    if (k > 0) { mineTo(Math.min(h0 + k * W, P - 1)); if (!proposalId && tip() >= P - 1) await proposeAndSignal(); mineTo(h0 + k * W); }
    await playRound(k);
  }
  mineTo(P - 1);
  if (!proposalId) await proposeAndSignal();
  mineTo(E);
  // the week windows as the seats read them: [MTP(end - (k+1) W), MTP(end - k W))
  const weeks = [0, 1, 2, 3].map((k) => { const to = E - k * W, from = to - W; const a = mtpMs(from), b = mtpMs(to);
    return { week: k, heights: `${from}..${to}`, from: iso(a), to: iso(b), rounds: rounds.filter((r) => r.finals.every((f) => f.at >= a && f.at < b)).map((r) => r.k) }; });
  say({ step: 'weeks', signalEnd: E, weeks, tip: tip() });

  // ---- the decision: every seat's funding loop runs every 120 s
  const t1 = Date.now();
  let views = [];
  for (let n = 0; n < 60; n++) {
    views = await Promise.all([0, 1, 2].map(async (i) => { const f = await fundingAt(i); return { tip: f.tip, p: (f.proposals || []).find((x) => x.id === proposalId) }; }));
    if (views.every((v) => v.p && v.p.signal && v.p.signal.state !== 'signalling' && v.p.vote && v.p.vote.censusHeight !== null)) break;
    await wait(10000);
  }
  for (let i = 0; i < 3; i++) {
    const v = views[i];
    say({ step: 'GET /funding', seat: i + 1, tip: v.tip, proposal: v.p && short(v.p.id), signal: v.p && v.p.signal, vote: v.p && v.p.vote && { from: v.p.vote.from, until: v.p.vote.until, last: v.p.vote.last, decidableAt: v.p.vote.decidableAt, censusHeight: v.p.vote.censusHeight, readTo: v.p.vote.readTo, state: v.p.vote.state,
      count: v.p.vote.count && { votersEligible: v.p.vote.count.votersEligible, bondsInCensus: v.p.vote.count.bondsInCensus, totalSats: v.p.vote.count.totalSats, bondsVoted: v.p.vote.count.bondsVoted } },
      signalsHeld: v.p && v.p.signals.length });
  }
  say({ step: 'decided', seconds: Math.round((Date.now() - t1) / 1000), sameAtEverySeat: views.every((v) => JSON.stringify(v.p && v.p.signal) === JSON.stringify(views[0].p && views[0].p.signal)) });
  for (let i = 0; i < 3; i++) say({ step: `seat ${i + 1} log`, funding: (readFileSync(join(WORK, `node-${i + 1}.log`), 'utf8').match(/\[funding\][^\n]*/g) || []).slice(-4) });
  say({ step: 'mined', blocks: tip(), note: 'every block of this chain, from its genesis' });
} catch (e) {
  failed = e;
  say({ step: 'failed', why: e.message, tip: (() => { try { return tip(); } catch { return null; } })() });
} finally {
  await stopAll();
  say({ step: 'stopped', work: WORK, seats: procs.map((p) => p.pid), bitcoind: bitcoind.pid });
}
process.exit(failed ? 1 : 0);
