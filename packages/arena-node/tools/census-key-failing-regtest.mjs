#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER HEARS OF A CENSUS KEY THAT FAILS (spec 5A.3B, kanban #972). A private regtest, never testnet4, never a live seat. Four nodes bond, one seat runs, so no key can reach its threshold
// and epoch after epoch fails. The seat's own doors say so from its chain. Then the other three start, a key stands, and the count ends. One line per question; exits 1 if any differs.
//
//   node tools/census-key-failing-regtest.mjs            (from packages/arena-node; CK_DIR, CK_BASE_PORT, BITCOIN_BIN)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { BOND_MATURITY_OFFSET } from '../../arena-protocol/src/bond-script.js';
import { clocksFor } from '../../arena-protocol/src/federation-slash.js';
import { CENSUS_KEY_VERSION } from '../../arena-protocol/src/constants.js';

const env = process.env;
const BIN = env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const BASE = Number(env.CK_BASE_PORT || 28640), RPC = BASE, P2P = BASE + 1;
const dir = mkdtempSync(join(env.CK_DIR || '/mnt/bitcoin/relocated/claude-tmp/claude-1000', 'census-key-failing-regtest-'));
const RT = join(dir, 'chain');
mkdirSync(RT);
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const SEATS = 4, E = BOND_MATURITY_OFFSET.regtest, WINDOW = clocksFor('regtest').clocks.foundingWindow, FIRST = 3 * E, ports = Array.from({ length: SEATS }, (_, i) => BASE + 10 + i);
const stores = ports.map((_, i) => join(dir, `seat-${i + 1}.db`));
const url = (i) => `http://127.0.0.1:${ports[i]}`;
const cli = (...a) => execFileSync(join(BIN, 'bitcoin-cli'), ['-regtest', `-datadir=${RT}`, `-rpcport=${RPC}`, ...(['listwallets', 'loadwallet', 'createwallet'].includes(a[0]) ? [] : ['-rpcwallet=arena']), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let wrong = 0;
const ask = (label, ok, said = '') => { if (!ok) wrong += 1; console.log(`#972 ${ok ? 'as expected' : 'WRONG      '} | ${label}${said === '' ? '' : ` | ${said}`}`); };
const kids = new Map();
function startSeat(i) {
  const log = openSync(`${stores[i]}.log`, 'a');
  kids.set(i, spawn('nice', ['-n', '15', process.execPath, 'src/main.js', String(ports[i]), stores[i]], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', log, log],
    env: { ...env, ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: `${RT}/regtest/.cookie`, ARENA_DONATION_NETWORK: 'regtest', ARENA_CENSUS_KEY_FIRST_HEIGHT: String(FIRST), ARENA_CENSUS_KEY_EVERY_MS: '1000',
      ARENA_DUTY_POST: 'auto', ARENA_DUTY_APPS: 'none', ARENA_DUTY_FEE_RATE: '2', ARENA_APPS: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname } }));
}
const seat = async (i) => (await fetch(`${url(i)}/census-key`, { signal: AbortSignal.timeout(8000) })).json();
async function until(what, test, ms = 120000) {
  const stop = Date.now() + ms;
  for (;;) {
    const got = await seat(0).catch(() => null);
    if (got && test(got)) return got;
    if (Date.now() > stop) throw new Error(`not in time: ${what}: ${JSON.stringify(got && { to: got.scannedTo, failing: got.failing, why: got.lastWhy })}`);
    await wait(500);
  }
}
let done = false;
const stopAll = async () => {
  if (done) return; done = true;
  for (const k of kids.values()) k.kill('SIGTERM');
  await wait(1500);
  try { cli('stop'); } catch { /* gone */ }
  await wait(1500);
  if (env.CK_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
};

try {
  spawn(join(BIN, 'bitcoind'), ['-regtest', `-datadir=${RT}`, `-rpcport=${RPC}`, `-port=${P2P}`, '-listen=0', '-listenonion=0', '-txindex=1', '-fallbackfee=0.0001', '-server=1'], { stdio: 'ignore', detached: false });
  for (let t = 0; t < 60; t++) { try { cli('listwallets'); break; } catch { await wait(500); } }
  try { cli('createwallet', 'arena'); } catch { /* there */ }
  const rt = regtest(cli);
  rt.mine(110);
  const ids = stores.map((s) => { const db = openStore(s); const id = nodeIdentity(db); db.close(); return id; });
  const bonds = ids.map((id, i) => rt.postBond(id.secret, { endpoint: `ws://127.0.0.1:${ports[i]}`, bondSats: 100000n, fundBtc: '0.02', protocolVersions: [1, CENSUS_KEY_VERSION], operatorId: `op${i}` }));
  rt.include(bonds.map((p) => p.hex));
  rt.mine(FIRST - 1 - rt.height());
  startSeat(0);
  for (let t = 0; t < 120; t++) { const up = await seat(0).catch(() => null); if (up) break; await wait(1000); }
  rt.mine(1);
  rt.mine(FIRST + WINDOW - 1 - rt.height());
  await until('the scan reached the end of epoch 3\'s window', (s) => s.scannedTo === rt.height());
  ask('before its window closes an epoch has not failed', (await seat(0)).failing.epochs === 0);
  rt.mine(1);
  let got = await until('epoch 3 failed', (s) => s.failing.epochs === 1);
  ask('one failed epoch: said at GET /census-key, no warning yet', !got.failing.warn, JSON.stringify(got.failing));
  let st = await (await fetch(`${url(0)}/owner/standing`, { signal: AbortSignal.timeout(20000) })).json();
  ask('the owner hears nothing yet', !(st.warnings || []).some((w) => w.kind === 'census key'), `${(st.warnings || []).length} other warning(s)`);
  rt.mine(4 * E + WINDOW - rt.height());
  got = await until('epoch 4 failed', (s) => s.failing.epochs === 2, 180000);
  ask('two failed epochs in a row: the seat says so from its chain', got.failing.warn && got.failing.since === 3 && got.failing.keygen === 2, JSON.stringify(got.failing));
  st = await (await fetch(`${url(0)}/owner/standing`, { signal: AbortSignal.timeout(20000) })).json();
  const w = (st.warnings || []).find((x) => x.kind === 'census key');
  ask('GET /owner/standing carries the warning', !!w && w.urgent === true, w ? w.says : '');

  for (let i = 1; i < SEATS; i++) startSeat(i);
  await wait(9000);
  rt.mine(5 * E - 1 - rt.height());
  await until('the scan reached epoch 5', (s) => s.scannedTo === rt.height(), 180000);
  rt.mine(1);
  await until('the run of epoch 5 has its deals', (s) => s.run && s.run.epoch === 5 && s.run.deals === SEATS, 120000);
  for (let t = 0; t < 60; t++) {
    const s = await seat(0);
    if (s.keys.some((k) => k.epoch === 5)) break;
    if (rt.height() < 5 * E + WINDOW) rt.mine(1);
    await wait(1500);
  }
  rt.mine(Math.max(0, 5 * E + WINDOW - rt.height()));
  got = await until('epoch 5 closed with a key', (s) => s.scannedTo >= 5 * E + WINDOW && s.keys.some((k) => k.epoch === 5), 180000);
  got = await until('the count ended', (s) => s.failing.epochs === 0, 60000);
  ask('a key stands at epoch 5, and the count ends', !got.failing.warn, JSON.stringify(got.failing));
  st = await (await fetch(`${url(0)}/owner/standing`, { signal: AbortSignal.timeout(20000) })).json();
  ask('and the warning goes', !(st.warnings || []).some((x) => x.kind === 'census key'));
} catch (e) { wrong += 1; console.error(`#972 stopped: ${e.stack}`); console.error(`#972 logs in ${dir}`); env.CK_KEEP = '1'; }
await stopAll();
console.log(wrong ? `#972 ${wrong} wrong` : '#972 all as expected');
process.exit(wrong ? 1 : 0);
