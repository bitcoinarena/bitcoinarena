#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WHOLE SLASH PATH ON A PRIVATE REGTEST, THROUGH THE NODE'S OWN CODE (spec 5A.3B, kanban #972, the owner's decision on #1083): a manipulated paid round, the start, the
// release by both panels, the fallback by the census key, the payout table byte-equal at every signer, each real loss paid to the player's key, the rest into the reserves
// by load (§27A.9.2). Regtest only: nothing here reaches testnet4, and no live seat.
//
// On a devnet (tools/devnet.mjs: a regtest chain, a federation of seven guardian nodes with its reserve key, two gateways and their lnds) this stands up 19 more nodes of its
// own, each a real `src/main.js` seat with its own client of the federation: 4 hold census key 0 and bond under the rounds' floor, so no round draws them; 15 bond
// template 3 naming that key above it. Then, twice:
//
//   round 1   15 nodes in the census, 9 drawn, 6 left for two panels of 3. Two players pay and play (tools/tn4-live-run.mjs, the page's lock client). Every drawn
//             seat is switched to sign the winner FAILED (test-dissent.js `fail`), so the round is FINAL on a false run and settles on it: the winner really loses.
//             Then anyone's objection, late: the seats file the proofs, the census key's holders sign the starts, and the panels release, each from its own table.
//   round 2   the 8 nodes left: all drawn, no panels, so the holds have no release leaf and the census key's holders take the fallback, as carriers too.
//
// Each carrier claims its peg-in and pays: the player is paid at its own key and redeems it in a fresh client; the rest goes to the federation's reserve key.
//
//   SR_DIR=<dir> node tools/slash-release-regtest.mjs prep     the 19 stores and census key 0 (before `devnet.mjs up`, which reads ARENA_CENSUS_KEY_0)
//   SR_DIR=<dir> DEVNET_DIR=... DEVNET_BASE_PORT=... BITCOIN_BIN=... FEDIMINT_BIN=... LND_BIN=... node tools/slash-release-regtest.mjs run
//   SR_DIR=<dir> node tools/slash-release-regtest.mjs down     stops the 19 seats by their pid files
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore, nodeIdentity } from '../src/store.js';
import { CensusDkg } from '../src/dkg.js';
import { feldmanGroup } from '../src/curve.js';
import { censusOfView } from '../src/roster.js';
import { runId as runIdOf } from '../src/verdict.js';
import { buildObjectionBundle } from '../src/objection-bundle.js';
import { regtest } from './regtest-bond.mjs';
import { devnetPorts } from './devnet-plan.mjs';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { censusKey0Shares } from '../../arena-protocol/src/census-key.js';
import { founderRun } from '../../arena-protocol/src/census-dkg.js';
import { SUPPORTED_PROTOCOL_VERSIONS, MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { BOND_TEMPLATE_V3 } from '../../arena-protocol/src/bond-script.js';
import { encodeRoundContract, decodeRoundContract, decodeEntryContract, roundId } from '../../arena-protocol/src/contracts.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { decodeSlashPayoutTable } from '../../arena-protocol/src/slash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_PKG = resolve(HERE, '..');
const env = process.env;
const SR = resolve(env.SR_DIR || 'slash-release-data');
const BASE = Number(env.SR_BASE_PORT || 15100);
const HOLDERS = 4, ROUNDERS = 15, N = HOLDERS + ROUNDERS;
const ports = Array.from({ length: N }, (_, i) => BASE + 10 * i);
const storeOf = (i) => join(SR, 'seats', `seat-${i + 1}.db`);
const urlOf = (i) => `http://127.0.0.1:${ports[i]}`;
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
let wrong = 0;
const ask = (label, ok, said = '') => { if (!ok) wrong += 1; console.log(`#972 ${ok ? 'as expected' : 'WRONG      '} | ${label}${said === '' ? '' : ` | ${typeof said === 'string' ? said : JSON.stringify(said, (k, v) => (typeof v === 'bigint' ? String(v) : v))}`}`); };
const until = async (what, fn, seconds = 300, everyMs = 3000) => {
  let last = '';
  for (const stop = Date.now() + seconds * 1000; Date.now() < stop;) {
    try { const got = await fn(); if (got) return got; } catch (e) { last = e.message; }
    await wait(everyMs);
  }
  throw new Error(`never: ${what}${last ? ` (${last.slice(0, 200)})` : ''}`);
};
const getJson = async (url, ms = 20000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`${url} ${r.status} ${(await r.text()).slice(0, 160)}`); return r.json(); };

// =====================================================================================================================
// prep: the stores, census key 0 by its four founders, the files a seat and the devnet read
// =====================================================================================================================
async function prep() {
  mkdirSync(join(SR, 'seats'), { recursive: true });
  const ids = Array.from({ length: N }, (_, i) => { const db = openStore(storeOf(i)); const id = nodeIdentity(db); db.close(); return id; });
  const keys = ids.map((id) => schnorr.getPublicKey(id.secret));
  const founders = [0, 1, 2, 3].map((i) => ({ secret: ids[i].secret, key: keys[i] }));
  const run = founderRun(censusKey0Shares({ holders: founders.map((f) => f.key), threshold: 3 }));
  const dkgs = founders.map((f) => new CensusDkg({ key: f.key, secret: f.secret, run, curve: feldmanGroup, random: (n) => new Uint8Array(randomBytes(n)) }));
  const deals = [];
  for (const d of dkgs) deals.push((await d.deal()).bytes);
  for (const d of dkgs) for (const b of deals) await d.accept(b);
  for (const d of dkgs) d.check();
  const said = dkgs.map((d) => d.statement());
  const made = dkgs.map((d) => d.finish(said));
  const genesis = { publicKey: toHex(made[0].groupPublicKey.subarray(1)), holders: founders.map((f) => toHex(f.key)), threshold: 3 };
  writeFileSync(join(SR, 'key0-genesis.json'), JSON.stringify(genesis));
  for (let i = 0; i < N; i++) {
    const m = i < HOLDERS ? made[i] : null;
    writeFileSync(join(SR, `key0-${i + 1}.json`), JSON.stringify({ ...genesis, ...(m ? { held: { runId: toHex(run.runId), negated: !!m.negated, shares: [...m.shares].map(([x, v]) => [x, v.toString(16)]), commitments: m.commitments.map(toHex) } } : {}) }));
    writeFileSync(join(SR, `dissent-${i + 1}.txt`), '');
  }
  writeFileSync(join(SR, 'plan.json'), JSON.stringify({ ports, keys: keys.map(toHex), key0: genesis.publicKey }, null, 1));
  say({ step: 'prepared', nodes: N, holders: HOLDERS, key0: genesis.publicKey.slice(0, 16), dir: SR });
}

// =====================================================================================================================
// run
// =====================================================================================================================
async function runAll() {
  const plan = JSON.parse(readFileSync(join(SR, 'plan.json'), 'utf8'));
  const D = resolve(env.DEVNET_DIR);
  const DP = devnetPorts(Number(env.DEVNET_BASE_PORT));
  const BTC = env.BITCOIN_BIN, FED = env.FEDIMINT_BIN, LND = env.LND_BIN, LOCK = env.LOCK_BIN || join(FED, 'arena-stake-lock');
  const btcArgs = ['-regtest', `-datadir=${join(D, 'btc')}`, `-rpcport=${DP.rpc}`];
  const cli = (...a) => execFileSync(join(BTC, 'bitcoin-cli'), [...btcArgs, ...(['listwallets', 'loadwallet', 'createwallet'].includes(a[0]) ? [] : ['-rpcwallet=devnet']), ...a.map(String)], { encoding: 'utf8', maxBuffer: 1 << 27 }).trim();
  const tip = () => Number(cli('getblockcount'));
  const mine = (n = 1) => cli('generatetoaddress', String(n), cli('getnewaddress'));
  const fedEnv = (extra = {}) => ({ ...env, PATH: [FED, dirname(process.execPath), env.PATH || ''].join(':'), HOME: join(D, 'home'), ...extra });
  const fcli = (dir, args, ms = 120000) => spawnSync(join(FED, 'fedimint-cli'), ['--data-dir', dir, ...args], { encoding: 'utf8', timeout: ms, env: fedEnv() });
  const invite = readFileSync(join(D, 'invite-code'), 'utf8').trim();
  const state = JSON.parse(readFileSync(join(D, 'runner', 'state.json'), 'utf8'));
  const keyHex = plan.keys, key0 = fromHex(plan.key0);
  const ids = Array.from({ length: N }, (_, i) => { const db = openStore(storeOf(i)); const id = nodeIdentity(db); db.close(); return id; });
  const idx = (k) => keyHex.indexOf(typeof k === 'string' ? k : toHex(k));
  const rt = regtest(cli, { wallet: 'devnet' });
  const kids = new Map();
  const t0 = Date.now();

  // ---- THE 19 NODES' CLIENTS OF THE FEDERATION, EACH ITS OWN DIRECTORY ----
  for (let i = 0; i < N; i++) {
    const dir = join(SR, 'clients', `seat-${i + 1}`);
    mkdirSync(dir, { recursive: true });
    if (fcli(dir, ['info'], 60000).status === 0) continue;
    await until(`client ${i + 1} joins`, async () => fcli(dir, ['join-federation', invite]).status === 0 || fcli(dir, ['info'], 60000).status === 0, 600, 3000);
  }
  say({ step: 'clients joined', n: N, seconds: Math.round((Date.now() - t0) / 1000) });

  // ---- THEIR BONDS: the holders under the rounds' floor, the others above it; template 3 naming key 0, with the presig at bonding ----
  // THE GUARDIANS' BONDS ARE LARGE (ARENA_BOND_SATS) SO THE FEDERATION HAS ROOM FOR A SLASH'S RESERVES (§23A.3: the cap is f + 1 times the smallest); the rounds' floor sits above them
  const HOLDER_BOND = 100000n, ROUND_BOND = 150000000n, ROUND_FLOOR = 50000000n;
  const bonds = [];
  const bondsFile = join(SR, 'bonds.json');
  if (existsSync(bondsFile)) bonds.push(...JSON.parse(readFileSync(bondsFile, 'utf8')));
  else {
    for (let i = 0; i < N; i++) {
      const p = rt.postBond(ids[i].secret, { endpoint: `ws://127.0.0.1:${ports[i]}`, bondSats: i < HOLDERS ? HOLDER_BOND : ROUND_BOND, fundBtc: ((Number(i < HOLDERS ? HOLDER_BOND : ROUND_BOND) + 100000) / 1e8).toFixed(8), hostedGames: [NEXTBLOCK.gameId],
        protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], operatorId: `sr${i + 1}`, slackBlocks: 30, template: BOND_TEMPLATE_V3, censusKey: key0 });
      rt.include([p.hex, rt.postBondPresig(ids[i].secret, p).hex]);
      bonds.push({ i, txid: p.txid, sats: String(p.bondSats), maturity: p.maturity });
    }
    writeFileSync(bondsFile, JSON.stringify(bonds));
  }
  mine(2);
  say({ step: 'bonded', holders: `${HOLDERS} x ${HOLDER_BOND}`, rounders: `${ROUNDERS} x ${ROUND_BOND}`, tip: tip() });

  // ---- THE 19 SEATS ----
  const guardianEnds = Object.fromEntries(DP.nodes.map((p) => [`ARENA_GUARDIAN_ENDPOINT_${p}`, `ws://127.0.0.1:${p}/guardian`]));
  const startSeat = (i) => {
    const log = openSync(`${storeOf(i)}.log`, 'a');
    const client = join(SR, 'clients', `seat-${i + 1}`);
    const kid = spawn(process.execPath, ['src/main.js', String(ports[i]), storeOf(i)], { cwd: NODE_PKG, stdio: ['ignore', log, log], detached: true, env: fedEnv({ ...guardianEnds,
      ARENA_BITCOIND_URL: `http://127.0.0.1:${DP.rpc}`, ARENA_BITCOIND_COOKIE: join(D, 'btc', 'regtest', '.cookie'), ARENA_TN4_NETWORK: 'regtest', ARENA_REGTEST_DONATION_SET: 'keys',
      ARENA_STAKE_LOCK_BIN: LOCK, ARENA_FEDERATION_CLIENT_DIR: client, ARENA_FEDERATION_CLIENTS_DIR: `${client}-others`, ARENA_FEDERATION_INVITE: invite,
      ARENA_CLOSE_AT_END: '1', ARENA_FUND_FREE_ROUNDS: '1', ARENA_DONATION_NETWORK: 'regtest', ARENA_ATTACH_PROOF_DIR: join(D, 'runner', 'proof'), ARENA_FUNDED_ROUNDS_FILE: join(D, 'runner', 'funded.txt'),
      ARENA_APPS: join(NODE_PKG, '..', 'nextblock', 'plugin', 'nextblock.js'), [`ARENA_WSS_${ports[i]}`]: `ws://127.0.0.1:${ports[i]}`, ARENA_SEATING: '1',
      ARENA_CENSUS_KEY_FIRST_HEIGHT: '100000', ARENA_CENSUS_KEY_0: join(SR, `key0-${i + 1}.json`), ARENA_CENSUS_KEY_EVERY_MS: '3000', ARENA_DUTY_POST: 'on', ARENA_DUTY_WALLET: 'devnet',
      ARENA_SLASH_FILE_STEP_MS: '500', ARENA_TEST_DISSENT_FILE: join(SR, `dissent-${i + 1}.txt`), ARENA_BOND_CLI: [join(BTC, 'bitcoin-cli'), ...btcArgs, '-rpcwallet=devnet'].join(',') }) });
    kid.unref();
    writeFileSync(join(SR, 'seats', `seat-${i + 1}.pid`), String(kid.pid));
    kids.set(i, kid);
  };
  for (let i = 0; i < N; i++) startSeat(i);
  for (let i = 0; i < N; i++) await until(`seat ${i + 1} answers`, async () => (await fetch(`${urlOf(i)}/identity`, { signal: AbortSignal.timeout(3000) })).ok, 180, 1000);
  say({ step: 'seats up', n: N, ports: `${ports[0]}..${ports[N - 1]}` });

  // ---- WHAT THE SEATS READ OF THE FEDERATION: its reserve key, named by its guardian seats ----
  const fed = await until('the federation\'s reserve key at a seat', async () => { const r = await getJson(`${urlOf(HOLDERS)}/reserves`); const f = (r.federations || [])[0]; return f && (f.key || f.reserveKey) ? f : null; }, 600, 5000);
  say({ step: 'federation', id: fed.federationId.slice(0, 16), reserveKey: String(fed.key || fed.reserveKey).slice(0, 18), heldMsat: fed.heldMsat });

  const results = [];
  for (const [n, scenario] of [[1, 'release'], [2, 'fallback']]) results.push(await playRound(n, scenario));
  say({ step: 'done', seconds: Math.round((Date.now() - t0) / 1000), rounds: results });

  // =====================================================================================================================
  // ONE MANIPULATED ROUND, ITS SLASHES, AND WHERE THE MONEY WENT
  // =====================================================================================================================
  async function playRound(n, scenario) {
    // THE CONTRACT: the devnet's paid round, at the tip, with the floor above the guardians' and the holders' bonds, so only our round nodes are its census
    // (the devnet's own paid round, or, after a restart that could not open one, the first paid round of its funded list a node still holds)
    let base = null;
    for (const id of [state.paidRound, ...readFileSync(join(D, 'runner', 'funded.txt'), 'utf8').split('\n')].filter((x) => /^[0-9a-f]{64}$/.test(x || ''))) {
      const r = await fetch(`http://127.0.0.1:${DP.nodes[0]}/round?id=${id}`);
      if (!r.ok) continue;
      try { const c0 = decodeRoundContract(new Uint8Array(await r.arrayBuffer())); if (c0.stakeMsat > 0n) { base = c0; break; } } catch { /* not a round */ }
    }
    if (!base) throw new Error('no paid round of the devnet to shape ours on');
    mine(1);
    const H = tip();
    const committeeTimeMs = BigInt(Date.now()) + 40000n;
    const startTimeMs = committeeTimeMs + MIN_ENTRY_WINDOW_MS;
    const shaped = { ...base, censusHeight: H, bondMinSats: ROUND_FLOOR, stakeMsat: 20000000n, committeeTimeMs, startTimeMs, entryCloseMs: startTimeMs + 300000n, nodes: [] };
    const census = censusOfView(rt.blocksFrom(0, H), decodeRoundContract(encodeRoundContract({ ...shaped, censusRoot: new Uint8Array(32) })), { network: 'regtest', standingKeys: [{ epoch: 0, publicKey: key0, height: 0 }] });
    if (!census.ok) throw new Error(`round ${n}: no census at ${H}: ${census.why}`);
    const inCensus = census.entries.map((e) => idx(e.pubkey)).filter((i) => i >= 0);
    const c = decodeRoundContract(encodeRoundContract({ ...shaped, censusRoot: census.root }));
    const rid = roundId(c), ridHex = toHex(rid), body = encodeRoundContract(c);
    say({ step: `round ${n}`, round: ridHex.slice(0, 16), censusHeight: H, census: census.entries.length, ours: inCensus.length, stakeSats: Number(c.stakeMsat / 1000n) });
    // THE FEDERATION'S SEVEN GUARDIANS ARE IN IT TOO: a seat assigns no round on a federation whose guardians are not bonded census nodes (§23.6). Their seats are the devnet's,
    // switched by one file (ARENA_TEST_DISSENT_FILE in the devnet's environment); their bonds are template 2, so no census key starts them
    const allUrls = [...Array.from({ length: N }, (_, i) => urlOf(i)), ...DP.nodes.map((p) => `http://127.0.0.1:${p}`)];
    const urlOfKey = new Map(census.entries.map((e) => [toHex(e.pubkey), String(e.advert.endpoint).replace(/^ws/, 'http')]));
    // FUNDED AS THE DEVNET'S RUNNER FUNDS ITS OWN ROUNDS: the seats store a round the funded list names
    appendFileSync(join(D, 'runner', 'funded.txt'), `${ridHex}\n`);
    writeFileSync(join(SR, `round-${n}.bin`), body);
    const posted = await Promise.all(Array.from({ length: N }, (_, i) => fetch(`${urlOf(i)}/round`, { method: 'POST', body, signal: AbortSignal.timeout(30000) }).then(async (r) => `${r.status}${r.ok ? '' : ` ${(await r.text()).slice(0, 200)}`}`, (e) => `0 ${e.message}`)));
    say({ step: `round ${n} posted`, statuses: [...new Set(posted)] });
    if (!posted.some((x) => x.startsWith('2'))) throw new Error(`round ${n}: no seat took it`);
    // THE BEACON NEEDS BLOCKS PAST THE COMMITTEE TIME
    const drawn = await until(`round ${n} drawn`, async () => {
      mine(1);
      const r = await getJson(`${urlOf(inCensus[0])}/rounds?next=64`);
      const row = (r.rounds || []).find((x) => x.id === ridHex);
      return row && row.committee && row.committee.drawn ? row.committee.drawn : null;
    }, 600, 4000);
    const seatedKeys = [...new Set([...drawn.game, ...drawn.settlement])];
    const seated = seatedKeys.map(idx);
    say({ step: `round ${n} drawn`, drawn: seated.map((i) => (i >= 0 ? i + 1 : 'guardian')).join(',') });

    // TWO PLAYERS, EACH THE TOOL THE PAID RUNS USE; THE FIRST SEARCHES FOR A DRIVE THAT DELIVERS
    const keysFile = join(SR, `keys-${n}.jsonl`);
    const players = [0, 1].map((p) => {
      const log = join(SR, `player-${n}-${p}.log`);
      const fd = openSync(log, 'a');
      const child = spawn(process.execPath, [join(HERE, 'tn4-live-run.mjs')], { detached: true, stdio: ['ignore', fd, fd], cwd: NODE_PKG,
        env: { ...env, ARENA_TN4_NETWORK: 'regtest', ROUND: ridHex, PORTS: [...inCensus.map((i) => ports[i]), ...DP.nodes].join(','), KEYS_FILE: keysFile, COLLECT_MS: '60000', INVITE_FILE: join(D, 'invite-code'),
          WASM_PKG: join(NODE_PKG, '..', 'arena-client', 'dist'), LNCLI: join(LND, 'lncli'), PAYER_DIR: join(D, 'lnd-b'), PAYER_RPC: `127.0.0.1:${DP.lnd.b.rpc}`, GATEWAY: `http://localhost:${DP.gateway.a.api}`,
          ANCHOR_HASH: cli('getblockhash', '0'), ANCHOR_HEIGHT: '0', ARENA_REGTEST_CENSUS_KEY_0: join(SR, 'key0-genesis.json'), ...(p === 0 ? { SEARCH: '1' } : {}) } });
      child.unref();
      return { p, log, child };
    });
    const lines = (pl) => { try { return readFileSync(pl.log, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
    const entryOf = (p) => { try { return readFileSync(keysFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.round === ridHex)[p] || null; } catch { return null; } };
    // THE WINNER'S ENTRY, AS SOON AS IT EXISTS: every seat of the round is switched to sign it FAILED (test-dissent.js `fail`), before any result is signed
    const winner = await until(`round ${n}: the first player's entry`, async () => {
      const l = lines(players[0]);
      if (l.some((x) => x.step === 'stopped' || x.step === 'error')) throw new Error(`player 0: ${JSON.stringify(l.slice(-1)[0]).slice(0, 300)}`);
      const keys = (() => { try { return readFileSync(keysFile, 'utf8').trim().split('\n').map((x) => JSON.parse(x)).filter((x) => x.round === ridHex); } catch { return []; } })();
      return keys.length ? keys[0] : null;
    }, 900, 2000);
    for (let i = 0; i < N; i++) writeFileSync(join(SR, `dissent-${i + 1}.txt`), `${winner.entry} fail\n`);
    writeFileSync(join(SR, 'dissent-guardians.txt'), `${winner.entry} fail\n`);
    say({ step: `round ${n}: every seat switched to sign the winner FAILED`, entry: winner.entry.slice(0, 16) });
    const driven = await until(`round ${n}: both players played`, async () => {
      const a = lines(players[0]).find((x) => x.step === 'driven'), b = lines(players[1]).find((x) => x.step === 'driven');
      return a && b ? { a, b } : null;
    }, 900, 3000);
    say({ step: `round ${n}: played`, winner: { outcome: driven.a.outcome, score: driven.a.score }, other: { outcome: driven.b.outcome, score: driven.b.score } });

    // FINAL ON THE FALSE RUN, AND SETTLED ON IT
    const s0 = seated.find((i) => i >= HOLDERS);
    const standing = await until(`round ${n}: the winner's entry FINAL`, async () => { const s = await getJson(`${urlOf(s0)}/standing?entry=${winner.entry}`); return s.state === 'FINAL' || s.state === 'SETTLED' || s.state === 'PAID' ? s : null; }, 2400, 10000);
    say({ step: `round ${n}: FINAL`, state: standing.state, outcome: standing.outcome, pendingMsat: standing.pendingMsat });
    const settled = await until(`round ${n}: settled`, async () => { const l = await getJson(`${urlOf(s0)}/lock-settlement?round=${ridHex}`); return /ACCEPTED|SETTLED|CONFIRMED|DONE/i.test(String(l.state)) ? l : null; }, 1800, 10000).catch((e) => ({ state: e.message }));
    say({ step: `round ${n}: settlement`, state: String(settled.state).slice(0, 120), txid: settled.txid || null });
    for (let i = 0; i < N; i++) writeFileSync(join(SR, `dissent-${i + 1}.txt`), '');
    writeFileSync(join(SR, 'dissent-guardians.txt'), '');

    // THE ROUND'S PANELS, as a seat that holds a presig of it names them
    const accusedBond = bonds.find((b) => b.i === seated.find((x) => x >= HOLDERS));
    const pres = await getJson(`${urlOf(s0)}/slash-presig?txid=${toHex(fromHex(accusedBond.txid).reverse())}&vout=0&round=${ridHex}`).catch((e) => ({ why: e.message }));
    say({ step: `round ${n}: panels`, n: pres.panels && pres.panels.n, t: pres.panels && pres.panels.t, a: pres.panels && pres.panels.a.map((k) => (idx(k) >= 0 ? idx(k) + 1 : 'g')), b: pres.panels && pres.panels.b.map((k) => (idx(k) >= 0 ? idx(k) + 1 : 'g')), why: pres.why });
    const panelKeys = pres.panels ? [...pres.panels.a, ...pres.panels.b] : [];
    const watchUrls = scenario === 'release' ? panelKeys.map((k) => urlOfKey.get(k)) : [0, 1, 2, 3].map(urlOf);
    // THE FALLBACK'S ROUND: two of panel B stopped (SIGSTOP on the seat's own process) before anything is filed, so no release can gather t of B, and the hold waits for the census key
    const stopped = [];
    if (scenario === 'fallback' && pres.panels) {
      const pidOfKey = (k) => { const i = idx(k); if (i >= 0) return Number(readFileSync(join(SR, 'seats', `seat-${i + 1}.pid`), 'utf8'));
        const g = DP.nodes.findIndex((p) => urlOfKey.get(k) === `http://127.0.0.1:${p}`); return g >= 0 ? JSON.parse(readFileSync(join(D, 'pids', `node-${g + 1}.pid`), 'utf8')).pid : null; };
      const order = [...pres.panels.b].sort((x, y) => (idx(y) >= 0) - (idx(x) >= 0));
      for (const k of order.slice(0, pres.panels.n - pres.panels.t + 1)) { const pid = pidOfKey(k); if (pid) { process.kill(pid, 'SIGSTOP'); stopped.push(pid); } }
      say({ step: `round ${n}: ${stopped.length} of panel B stopped`, t: pres.panels.t });
    }
    // THE OBJECTION, LATE: anyone's, built from what a seat hands out, claiming what the run really gave
    const run = await getJson(`${urlOf(s0)}/audit-run?round=${ridHex}`);
    const row = run.entries.find((e) => e.id === winner.entry);
    const falseRun = row.results.map((h) => decodePlayerResult(splitSignedResult(fromHex(h)).body)).find((r) => r.outcome === 'FAILED');
    const playerPubkey = decodeEntryContract(fromHex(row.entry)).playerPubkey;
    const { bundle } = await buildObjectionBundle({ base: urlOf(s0), roundId: rid, entryId: fromHex(winner.entry), signedRunId: runIdOf(falseRun), playerPubkey, claimed: { outcome: driven.a.outcome, score: driven.a.score } });
    const objected = await fetch(`${urlOf(s0)}/objection?round=${ridHex}&entry=${winner.entry}`, { method: 'POST', body: bundle, signal: AbortSignal.timeout(120000) });
    ask(`round ${n}: a late objection holds at a seat`, objected.status === 201 || objected.status === 200, `${objected.status} ${(await objected.text()).slice(0, 120)}`);

    // THE STARTS: each seat that signed the false run, by the census key's holders
    const accused = seated.filter((i) => i >= HOLDERS);
    const bondOf = (i) => bonds.find((b) => b.i === i);
    const starts = await until(`round ${n}: the starts mined`, async () => {
      mine(1);
      const got = [];
      for (const i of accused) { const out = cli('gettxout', bondOf(i).txid, '0'); if (!out) got.push(i); }
      return got.length === accused.length ? got : null;
    }, 900, 5000).catch(() => accused.filter((i) => !cli('gettxout', bondOf(i).txid, '0')));
    ask(`round ${n}: every accused bond was started`, starts.length === accused.length, `${starts.length} of ${accused.length}`);

    // THE RELEASES (round 1) OR THE FALLBACKS (round 2), as the seats report them, and their tables at every signer
    const startsRead = await until(`round ${n}: the seats read the starts`, async () => {
      const r = await getJson(`${watchUrls[0]}/slash-releases`);
      const mine2 = r.starts.filter((s) => s.round_id === ridHex);
      return mine2.length >= starts.length ? mine2 : null;
    }, 600, 5000);
    const path = scenario;
    const sent = await until(`round ${n}: every ${path} sent`, async () => {
      mine(1);
      const out = [];
      for (const s of startsRead) {
        let one = null;
        for (const w of watchUrls) { const x = await getJson(`${w}/slash-release?start=${s.start}`).catch(() => null); if (x && x[path] && x[path].sent) { one = { start: s.start, ...x[path] }; break; } }
        if (one) out.push(one);
      }
      return out.length === startsRead.length ? out : null;
    }, scenario === 'release' ? 900 : 1800, 6000);
    mine(1);
    const tables = [];
    for (const s of sent) {
      const info = JSON.parse(cli('getrawtransaction', s.sent, '1'));
      const signers = [];
      for (const w of watchUrls) { const x = await getJson(`${w}/slash-release?start=${s.start}`).catch(() => null); if (x && x[path]) signers.push(x[path].table); }
      const t = decodeSlashPayoutTable(fromHex(s.table));
      tables.push({ start: s.start, txid: s.sent, vsize: info.vsize, conf: info.confirmations, feeSats: s.feeSats, byteEqualAt: `${signers.filter((x) => x === s.table).length} of ${signers.length}`,
        entries: t.entries.map((e) => ({ player: toHex(e.playerPubkey).slice(0, 12), lossMsat: e.lossMsat })), outputs: t.outputs.map((o) => `${o.pays} ${o.value}`) });
      ask(`round ${n}: ${path} of ${s.start.slice(0, 12)} mined, its table byte-equal at every signer that built one`, info.confirmations >= 1 && signers.every((x) => x === s.table), `${info.vsize} vB, ${signers.length} signers`);
    }
    for (const t of tables) say({ step: `round ${n} ${path}`, ...t });

    // THE CARRIERS PAY: the loss to the player's key, the rest to the reserve key
    const carriedAll = await until(`round ${n}: every carried output paid`, async () => {
      mine(1);
      const out = [];
      let open = 0;
      for (const s of sent) for (const [i, u] of allUrls.entries()) {
        const x = await getJson(`${u}/slash-release?start=${s.start}`).catch(() => null);
        for (const c2 of (x && x.carried) || []) { if (c2.paidTxid) out.push({ carrier: i < N ? i + 1 : `guardian ${i - N + 1}`, start: s.start.slice(0, 12), ...c2 }); else open += 1; }
      }
      const due = tables.reduce((a, t) => a + t.outputs.filter((o) => /^(player_carrier|reserves)/.test(o)).length, 0);
      return out.length >= due && !open ? out : null;
    }, 1800, 15000).catch(() => []);
    for (const x of carriedAll) say({ step: `round ${n} carried`, ...x });
    const toPlayer = carriedAll.flatMap((x) => x.players || []).filter((p) => p.key === toHex(refundKeyOf(playerPubkey)));
    const owedMsat = tables.flatMap((t) => t.entries).reduce((a, e) => a + BigInt(e.lossMsat), 0n);
    ask(`round ${n}: the winner's real loss is in a table`, owedMsat > 0n, `${owedMsat} msat`);
    ask(`round ${n}: the carriers paid it to the player's key`, toPlayer.reduce((a, p) => a + BigInt(p.msat), 0n) === owedMsat, toPlayer.map((p) => `${p.msat} msat at ${p.outIdx}`).join(', '));

    // THE PLAYER REDEEMS IT, in a fresh client, with its own key
    let redeemed = null;
    for (const [k, p] of toPlayer.entries()) {
      const pay = carriedAll.find((x) => (x.players || []).includes(p));
      const dir = join(SR, `redeem-${n}-${k}`); mkdirSync(dir, { recursive: true });
      fcli(dir, ['join-federation', invite]);
      const r = spawnSync(LOCK, ['--mode', 'redeem', '--data-dir', dir, '--outpoint', `${pay.paidTxid}:${p.outIdx}`, '--amount-msat', String(p.msat), '--hash', '00'.repeat(32),
        '--claim-pk', p.key, '--refund-pk', p.key, '--expiration', '0', '--witness', 'refund', '--signer-secret', winner.secret], { encoding: 'utf8', timeout: 300000, env: fedEnv() });
      fcli(dir, ['dev', 'wait-complete'], 240000);
      const held = (() => { try { return JSON.parse(fcli(dir, ['info']).stdout); } catch { return null; } })();
      redeemed = { said: String(r.stdout || r.stderr).trim().split('\n').pop().slice(0, 200), balanceMsat: held ? held.total_amount_msat : null };
      ask(`round ${n}: the player redeems ${p.msat} msat at its own key`, held && BigInt(held.total_amount_msat) > 0n, redeemed);
    }
    const reserves = await getJson(`${urlOf(HOLDERS)}/reserves`).catch(() => null);
    const slashIn = reserves ? (reserves.federations || []).map((f) => ({ federation: String(f.federationId).slice(0, 12), heldMsat: f.heldMsat, slashMsat: f.slashMsat })) : null;
    say({ step: `round ${n}: the reserves at a seat`, federations: slashIn });
    for (const p of players) { try { process.kill(-p.child.pid, 'SIGTERM'); } catch { /* ended */ } }
    for (const pid of stopped) { try { process.kill(pid, 'SIGCONT'); } catch { /* gone */ } }
    return { round: ridHex.slice(0, 16), scenario, accused: accused.length, spends: tables.length, owedMsat: String(owedMsat), paidToPlayerMsat: String(toPlayer.reduce((a, p) => a + BigInt(p.msat), 0n)), redeemed, reserves: slashIn };
  }
}

function down() {
  for (let i = 0; i < N; i++) {
    const f = join(SR, 'seats', `seat-${i + 1}.pid`);
    if (!existsSync(f)) continue;
    try { process.kill(-Number(readFileSync(f, 'utf8')), 'SIGTERM'); } catch { try { process.kill(Number(readFileSync(f, 'utf8')), 'SIGTERM'); } catch { /* gone */ } }
  }
  say({ step: 'seats stopped' });
}

const cmd = process.argv[2];
try {
  if (cmd === 'prep') await prep();
  else if (cmd === 'run') await runAll();
  else if (cmd === 'down') down();
  else { console.error('prep | run | down'); process.exit(2); }
} catch (e) { wrong += 1; console.error(`#972 stopped: ${e.stack || e.message}`); }
if (cmd === 'run') console.log(wrong ? `#972 ${wrong} wrong` : '#972 all as expected');
process.exit(wrong ? 1 : 0);
