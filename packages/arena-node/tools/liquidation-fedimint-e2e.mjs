#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TWO REAL FEDERATIONS OF A LIQUIDATION, ON ONE PRIVATE REGTEST (kanban #1093, ruling #1111): what tools/liquidation-regtest.mjs runs against
// with FEDS=<dir>/feds.json in place of its stand-in safe-federation clients. Never testnet4, never a live bond.
//
//   up     a bitcoind; federation R (the one robbed, 4 guardians, 3 of 4) and federation S (the safe one, 4 guardians), each through its own key
//          ceremony (fedimint-cli admin setup); a client of R the claims are checked with (joined while R is OPEN), the player's client of R with
//          notes in it (a peg-in), the player's client of S (empty), and one client of S per census-key holder of liquidation-regtest.mjs (the carriers)
//   halt   two of R's guardians stop: R is HALTED (2 of 4 left, 3 needed); the player hands over every note it holds there as e-cash (mintv2 send,
//          offline), written to <dir>/player.ecash - what it presents as its claim
//   down   everything `up` started, by its pid file, and the bitcoind
//
//   [FEDIMINT_CLI=<the fork's fedimint-cli with mintv2 validate (tools/fedimint-spent-nonces.patch), for the claims check>] LIQ_DIR=<dir> LIQ_BASE_PORT=30000 BITCOIN_BIN=<dir> FEDIMINT_BIN=<dir with fedimintd, fedimint-cli, arena-stake-lock> node tools/liquidation-fedimint-e2e.mjs up|halt|down
// Ports: base+1 bitcoind rpc, base+2 its p2p; R's guardian g on base+20+10g .. +3, S's on base+120+10g .. +3. All below 32768.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';

const env = process.env;
const D = resolve(env.LIQ_DIR || 'liq-fedimint-e2e');
const BASE = Number(env.LIQ_BASE_PORT || 30000);
const BTC = env.BITCOIN_BIN, F = env.FEDIMINT_BIN, LOCK = env.LOCK_BIN || (F && join(F, 'arena-stake-lock'));
const PLAYER_PEGIN_BTC = env.PLAYER_PEGIN_BTC || '0.003';
const HOLDERS = 4;                                   // liquidation-regtest.mjs's census-key holders, one carrier client each
if (!BTC || !F) throw new Error('BITCOIN_BIN and FEDIMINT_BIN');
if (BASE + 160 > 32767 || BASE < 1024) throw new Error(`LIQ_BASE_PORT ${BASE}: every port must lie in 1024 .. 32767`);
const RPC = BASE + 1;
const say = (o) => console.log(`#1093 ${JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const path = (...p) => join(D, ...p);
const HOME = path('home');
const cliEnv = { ...env, HOME };
const bcli = (...a) => execFileSync(join(BTC, 'bitcoin-cli'), ['-regtest', `-datadir=${path('btc')}`, `-rpcport=${RPC}`, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const wcli = (...a) => bcli('-rpcwallet=liq', ...a);
const mine = (n) => wcli('generatetoaddress', String(n), wcli('getnewaddress'));
const fcli = (dir, ...a) => execFileSync(join(F, 'fedimint-cli'), ['--data-dir', dir, ...a], { encoding: 'utf8', env: cliEnv, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lock = (...a) => {
  const out = execFileSync(LOCK, a, { encoding: 'utf8', env: cliEnv, timeout: 900000, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
};
const setup = (api, ...a) => execFileSync(join(F, 'fedimint-cli'), ['--password', 'liq', 'admin', 'setup', `ws://127.0.0.1:${api}`, ...a], { encoding: 'utf8', env: cliEnv, timeout: 120000 }).trim().replace(/^"|"$/g, '');
const until = async (what, s, fn) => { for (let i = 0; i < s; i++) { try { const v = await fn(); if (v) return v; } catch { /* again */ } await wait(1000); } throw new Error(`gave up waiting for ${what}`); };
const keepPid = (pid, what) => appendFileSync(path('pids'), `${pid} ${what}\n`);
const pids = () => (existsSync(path('pids')) ? readFileSync(path('pids'), 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [pid, ...w] = l.split(' '); return { pid: Number(pid), what: w.join(' ') }; }) : []);
const feds = () => JSON.parse(readFileSync(path('feds.json'), 'utf8'));
const FEDS = { R: { base: BASE + 20, name: 'liq-robbed' }, S: { base: BASE + 120, name: 'liq-safe' } };
const ports = (fbase, g) => { const p = fbase + g * 10; return { p2p: p, api: p + 1, ui: p + 2, metrics: p + 3 }; };

function startGuardian(fed, g) {
  const dir = path(`${fed}-g${g}`), p = ports(FEDS[fed].base, g);
  mkdirSync(dir, { recursive: true });
  const cookie = readFileSync(path('btc', 'regtest', '.cookie'), 'utf8').trim();
  const out = openSync(join(dir, 'fedimintd.out'), 'a');
  const c = spawn(join(F, 'fedimintd'), [], { detached: true, stdio: ['ignore', out, out], env: { ...env, HOME, FM_DATA_DIR: dir, FM_BITCOIN_NETWORK: 'regtest',
    FM_BITCOIND_URL: `http://127.0.0.1:${RPC}`, FM_BITCOIND_USERNAME: '__cookie__', FM_BITCOIND_PASSWORD: cookie.split(':').slice(1).join(':'),
    FM_BIND_P2P: `127.0.0.1:${p.p2p}`, FM_BIND_API: `127.0.0.1:${p.api}`, FM_BIND_UI: `127.0.0.1:${p.ui}`, FM_BIND_METRICS: `127.0.0.1:${p.metrics}`,
    FM_P2P_URL: `fedimint://127.0.0.1:${p.p2p}`, FM_API_URL: `ws://127.0.0.1:${p.api}`, FM_ENABLE_IROH: 'false', FM_PASSWORD_API: 'liq', FM_PASSWORD_UI: 'liq',
    FM_DISABLE_BASE_FEES: '1' } });
  c.unref();
  keepPid(c.pid, `fedimintd-${fed}${g}`);
  return dir;
}

async function foundFederation(fed) {
  const t = Date.now();
  for (let g = 0; g < 4; g++) {
    const dir = startGuardian(fed, g);
    await until(`${fed} guardian ${g}`, 180, () => /Setup UI running/.test(readFileSync(join(dir, 'fedimintd.out'), 'utf8')));
  }
  const api = (g) => ports(FEDS[fed].base, g).api;
  const codes = [setup(api(0), 'set-local-params', `${fed}0`, '--federation-name', FEDS[fed].name, '--federation-size', '4')];
  for (let g = 1; g < 4; g++) codes.push(setup(api(g), 'set-local-params', `${fed}${g}`));
  for (let g = 0; g < 4; g++) for (let o = 0; o < 4; o++) if (g !== o) setup(api(g), 'add-peer', codes[o].replace(/["\s]/g, ''));
  for (let g = 0; g < 4; g++) {
    const c = spawn(join(F, 'fedimint-cli'), ['--password', 'liq', 'admin', 'setup', `ws://127.0.0.1:${api(g)}`, 'start-dkg'], { detached: true, stdio: 'ignore', env: cliEnv });
    c.unref();
  }
  const invite = await until(`${fed}'s key ceremony`, 300, () => (existsSync(path(`${fed}-g0`, 'invite-code')) ? readFileSync(path(`${fed}-g0`, 'invite-code'), 'utf8').replace(/["\s]/g, '') : null));
  return { invite, ms: Date.now() - t };
}

const cmd = process.argv[2];
if (cmd === 'up') {
  if (existsSync(path('feds.json'))) throw new Error(`${D} holds a liquidation pair already: down first`);
  mkdirSync(path('btc'), { recursive: true }); mkdirSync(HOME, { recursive: true });
  const t0 = Date.now();
  execFileSync(join(BTC, 'bitcoind'), ['-regtest', `-datadir=${path('btc')}`, `-rpcport=${RPC}`, `-port=${BASE + 2}`, '-listen=0', '-listenonion=0', '-fallbackfee=0.0001', '-txindex=1', '-daemon'], { stdio: 'ignore' });
  await until('bitcoind', 60, () => bcli('getblockcount') !== '');
  try { bcli('createwallet', 'liq'); } catch { bcli('loadwallet', 'liq'); }
  mine(150);
  say({ step: 'bitcoind', rpc: RPC, height: Number(bcli('getblockcount')) });
  const found = {};
  for (const fed of ['R', 'S']) { found[fed] = await foundFederation(fed); say({ step: `federation ${fed} founded`, invite: `${found[fed].invite.slice(0, 16)}...`, ms: found[fed].ms }); }
  const joinCli = (dir, invite) => { mkdirSync(dir, { recursive: true }); fcli(dir, 'join', invite); return JSON.parse(fcli(dir, 'info')).federation_id; };
  const joinLock = (dir, invite) => { mkdirSync(dir, { recursive: true }); return lock('--mode', 'join', '--data-dir', dir, '--invite', invite).federation_id; };
  const R = joinCli(path('validator-r'), found.R.invite);
  joinCli(path('player-r'), found.R.invite);
  const S = joinLock(path('player-s'), found.S.invite);
  const carriers = [];
  for (let k = 1; k <= HOLDERS; k++) { joinLock(path(`carrier-${k}`), found.S.invite); carriers.push(path(`carrier-${k}`)); }
  say({ step: 'clients joined', robbed: R, safe: S, carriers: carriers.length });
  // THE PLAYER'S NOTES IN R: a peg-in (the fork's regtest runs walletv2), claimed by arena-stake-lock - a walletv2 deposit is claimed by a client that
  // stays open (`fedimint-cli info` alone never sees it: measured, the balance stayed 0 over 250 blocks), so the tool's pegin-claim, blocks mined beside it
  const address = lock('--mode', 'pegin-address', '--data-dir', path('player-r')).address;
  const txid = wcli('sendtoaddress', address, PLAYER_PEGIN_BTC);
  mine(1);
  const miner = setInterval(() => { try { mine(1); } catch { /* next */ } }, 3000);
  let claimed;
  try { claimed = await new Promise((done, fail) => { const c = spawn(LOCK, ['--mode', 'pegin-claim', '--data-dir', path('player-r'), '--address', address, '--timeout-s', '300'], { env: cliEnv });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', () => { try { done(JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop())); } catch { fail(new Error(`no peg-in claim: ${out.slice(0, 200)}`)); } }); }); }
  finally { clearInterval(miner); }
  const notes = BigInt(claimed.balance_after_msat) - BigInt(claimed.balance_before_msat);
  say({ step: 'the player pegged into R', address, txid, sats: PLAYER_PEGIN_BTC, notesMsat: notes, pegInFeeMsat: BigInt(Math.round(Number(PLAYER_PEGIN_BTC) * 1e11)) - notes, height: Number(bcli('getblockcount')) });
  writeFileSync(path('feds.json'), JSON.stringify({ dir: D, btcDir: path('btc'), rpcPort: RPC, bitcoinCli: join(BTC, 'bitcoin-cli'), fedimintCli: env.FEDIMINT_CLI || join(F, 'fedimint-cli'), lockBin: LOCK, home: HOME,
    robbed: { id: R, invite: found.R.invite, validator: path('validator-r'), player: path('player-r') }, safe: { id: S, invite: found.S.invite, player: path('player-s'), carriers },
    playerPegIn: { address, txid, msat: String(notes) } }, null, 1));
  say({ step: 'up', s: Math.round((Date.now() - t0) / 1000), feds: path('feds.json') });
} else if (cmd === 'halt') {
  const f = feds();
  const before = BigInt(JSON.parse(fcli(f.robbed.player, 'info')).total_amount_msat);
  for (const p of pids().filter((x) => /fedimintd-R[23]$/.test(x.what))) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } }
  await wait(5000);
  say({ step: 'R halted: guardians 2 and 3 stopped (2 of 4 left, 3 needed)', height: Number(bcli('getblockcount')) });
  // EVERY NOTE THE PLAYER HOLDS IN R, AS E-CASH (out of band, offline: the halted federation is not asked)
  const t = Date.now();
  let out;
  try { out = execFileSync(join(F, 'fedimint-cli'), ['--data-dir', f.robbed.player, 'module', 'mintv2', 'send', String(before)], { encoding: 'utf8', env: cliEnv, timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { say({ step: 'the player\'s hand-over FAILED', why: String(e.stderr || e.message).trim().split('\n').pop().slice(0, 300) }); process.exit(1); }
  let ecash = out; try { const j = JSON.parse(out); ecash = typeof j === 'string' ? j : (j.ecash || j.notes || out); } catch { /* raw */ }
  writeFileSync(path('player.ecash'), String(ecash));
  say({ step: 'the player handed over its notes in R, halted', msat: before, chars: String(ecash).length, ms: Date.now() - t });
} else if (cmd === 'down') {
  for (const p of pids()) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } }
  await wait(3000);
  for (const p of pids()) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } }
  try { bcli('stop'); } catch { /* down */ }
  await wait(3000);
  const left = [...Array(161).keys()].map((i) => BASE + i).filter((p) => { try { execFileSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); return true; } catch { return false; } });
  say({ step: 'down', stillListening: left });
} else throw new Error('up | halt | down');
