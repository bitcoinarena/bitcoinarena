#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY THROUGH THE NODE'S OWN CODE (kanban #972, spec 5A.3B). A private regtest, never testnet4, never a live seat. Real `src/main.js` nodes and a real bitcoind: the keys are
// made over the seats' own doors on the chain's clock, the anchor comes from a seat's wallet, each seat reads it back from its own chain, a template-3 bond naming the key counts,
// one naming another key does not, and the next epoch's run holds the new node. One line per question, expected answer beside it; exits 1 if any differs.
//
//   node tools/census-key-regtest.mjs            (from packages/arena-node; CK_DIR, CK_BASE_PORT, BITCOIN_BIN)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { censusKeyCarrier, censusKeyAnchorSpend } from '../src/census-key-anchor.js';
import { censusKeyBodyPieces, encodeCensusKeyBody, CENSUS_KEY_CENSUS_VERSION } from '../../arena-protocol/src/census-key.js';
import { BOND_TEMPLATE_V3 } from '../../arena-protocol/src/bond-script.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const BIN = env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const BASE = Number(env.CK_BASE_PORT || 28440), RPC = BASE, P2P = BASE + 1;
const dir = mkdtempSync(join(env.CK_DIR || '/mnt/bitcoin/relocated/claude-tmp/claude-1000', 'census-key-regtest-'));
const RT = join(dir, 'chain');
mkdirSync(RT);
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const SEATS = 5, FIRST = 300, MID = 305, ports = Array.from({ length: SEATS }, (_, i) => BASE + 10 + i);
const stores = ports.map((_, i) => join(dir, `seat-${i + 1}.db`));
const url = (i) => `http://127.0.0.1:${ports[i]}`;
const cli = (...a) => execFileSync(join(BIN, 'bitcoin-cli'), ['-regtest', `-datadir=${RT}`, `-rpcport=${RPC}`,
  ...(['listwallets', 'loadwallet', 'createwallet'].includes(a[0]) ? [] : ['-rpcwallet=arena']), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let wrong = 0;
const ask = (label, ok, said = '') => { if (!ok) wrong += 1; console.log(`#972 ${ok ? 'as expected' : 'WRONG      '} | ${label}${said === '' ? '' : ` | ${said}`}`); };
const kids = new Map();
function startSeat(i) {
  const log = openSync(`${stores[i]}.log`, 'a');
  const k = spawn('nice', ['-n', '15', process.execPath, 'src/main.js', String(ports[i]), stores[i]], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', log, log],
    env: { ...env, ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: `${RT}/regtest/.cookie`, ARENA_DONATION_NETWORK: 'regtest', ARENA_CENSUS_KEY_FIRST_HEIGHT: String(FIRST),
      ARENA_CENSUS_KEY_EVERY_MS: '1000', ARENA_DUTY_POST: 'auto', ARENA_DUTY_APPS: 'none', ARENA_DUTY_FEE_RATE: '2',
      ARENA_APPS: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname } });
  kids.set(i, k);
}
const stopSeat = (i) => new Promise((res) => { const k = kids.get(i); k.once('exit', res); k.kill('SIGTERM'); });
const seat = async (i) => (await fetch(`${url(i)}/census-key`, { signal: AbortSignal.timeout(8000) })).json();
const seats = (list) => Promise.all(list.map((i) => seat(i).catch(() => null)));
async function until(what, list, test, ms = 90000) {
  const stop = Date.now() + ms;
  for (;;) {
    const got = await seats(list);
    if (got.every((s) => s && test(s))) return got;
    if (Date.now() > stop) { ask(`in time: ${what}`, false, JSON.stringify(got.map((s) => (s ? { to: s.scannedTo, run: s.run && { ...s.run, window: undefined }, why: s.lastWhy } : null))).slice(0, 700)); throw new Error(`no ${what}`); }
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

  const keys = stores.map((s) => { const db = openStore(s); const id = nodeIdentity(db); db.close(); return id; });
  const versions = [1, CENSUS_KEY_CENSUS_VERSION];
  const bond = (i, sats, extra = {}) => rt.postBond(keys[i].secret, { endpoint: `ws://127.0.0.1:${ports[i]}`, bondSats: sats, fundBtc: '0.02', protocolVersions: versions, operatorId: `op${i}`, ...extra });
  const posted = [100000n, 100000n, 150000n, 200000n].map((sats, i) => bond(i, sats));
  rt.include(posted.map((p) => p.hex));
  rt.mine(FIRST - 1 - rt.height());
  ask('four bonds, 2 + 2 + 3 + 4 shares at 50,000 sat, confirmed below the census', rt.height() === FIRST - 1, `tip ${rt.height()}`);

  for (let i = 0; i < SEATS; i++) { startSeat(i); await wait(4000); }
  for (let t = 0; t < 120; t++) {
    const up = await Promise.all(ports.map((p) => fetch(`http://127.0.0.1:${p}/census-key`).then((r) => r.ok, () => false)));
    if (up.every(Boolean)) break;
    await wait(1000);
  }
  const holders = [0, 1, 2, 3];
  const t0 = Date.now();
  rt.mine(1);
  let got = await until('all four deals at the four holders', holders, (s) => s.run && s.run.deals === 4);
  ask('the deals crossed the seats\' own doors', true, `${Date.now() - t0} ms, run ${got[0].run.runId.slice(0, 16)}, ${got[0].run.total} shares, threshold ${got[0].run.threshold}`);
  ask('the unbonded fifth seat sits it out', (await seat(4)).run === null);
  rt.mine(MID - FIRST);
  await until('the check at the midpoint', holders, (s) => s.run.state.checked === true);
  const t1 = Date.now();
  rt.mine(1);
  got = await until('the record, complete at every holder', holders, (s) => Number.isInteger(s.run.state.complete));
  ask('one record, one key at all four', new Set(got.map((s) => s.run.state.publicKey)).size === 1 && new Set(got.map((s) => s.run.state.recordId)).size === 1, `key ${got[0].run.state.publicKey.slice(0, 16)}, ${Date.now() - t1} ms`);
  const key = got[0].run.state.publicKey;
  for (let t = 0; t < 40 && !(await seats(holders)).some((s) => s.run.state.anchored); t++) await wait(500);
  const posters = (await seats(holders)).filter((s) => s.run.state.anchored);
  ask('one holder posted from its wallet', posters.length === 1, posters.length ? posters[0].run.state.anchored : '');
  const anchorTxid = posters[0].run.state.anchored;
  const tx = JSON.parse(cli('getrawtransaction', anchorTxid, '1'));
  ask('the anchor is in the mempool, OP_RETURN "ARN" \'K\' only', tx.vout.length === 1 && tx.vout[0].scriptPubKey.hex.startsWith('6a24' + '41524e4b'), `${tx.vsize} vB, ${tx.vin[0].txinwitness.length} witness items`);
  rt.mine(1);
  const anchorHeight = rt.height();
  got = await until('the key standing at every seat', [0, 1, 2, 3, 4], (s) => s.keys.length === 1 && s.keys[0].publicKey === key);
  ask('all five seats read it from their own chain, at the anchor\'s height', got.every((s) => s.keys[0].height === anchorHeight && s.keys[0].epoch === 3), `epoch 3 at ${anchorHeight}`);

  // A TEMPLATE-3 BOND: one naming the key that stands, one naming a key that does not
  const stranger = schnorr.utils.randomSecretKey();
  const good = bond(4, 150000n, { template: BOND_TEMPLATE_V3, censusKey: fromHex(key) });
  const bad = rt.postBond(stranger, { endpoint: 'ws://127.0.0.1:1', bondSats: 900000n, fundBtc: '0.02', protocolVersions: versions, operatorId: 'stranger', template: BOND_TEMPLATE_V3, censusKey: new Uint8Array(32).fill(0x77) });
  rt.include([good.hex, bad.hex]);
  rt.mine(1);

  // A RESTART: what the scan found is kept, and the kept census of epoch 4 is read under the key
  await stopSeat(0);
  startSeat(0);
  for (let t = 0; t < 120; t++) { if (await fetch(`${url(0)}/census-key`).then((r) => r.ok, () => false)) break; await wait(500); }
  const back = await seat(0);
  ask('a restarted seat holds the key at once, read nowhere', back.keys.length === 1 && back.keys[0].publicKey === key, `scanned to ${back.scannedTo}`);

  rt.mine(400 - 1 - rt.height());
  await until('every seat scanned to 399', [0, 1, 2, 3, 4], (s) => s.scannedTo === 399);
  rt.mine(1);
  got = await until('the run of epoch 4, with the new node', [0, 1, 2, 3, 4], (s) => s.run && s.run.epoch === 4 && s.run.deals === 5);
  ask('a template-3 bond naming the standing key counts: five holders, 11 + 3 shares', got[0].run.holders === 5 && got[0].run.total === 14, `holders ${got[0].run.holders}, shares ${got[0].run.total}`);
  ask('and the one naming another key does not: its 900,000 sat are 18 shares, and none is in the census', got[0].run.total === 14);
  rt.mine(405 - 400);
  await until('the check of epoch 4', [0, 1, 2, 3, 4], (s) => s.run.state.checked === true);
  rt.mine(1);
  got = await until('the second key', [0, 1, 2, 3, 4], (s) => Number.isInteger(s.run.state.complete));
  for (let t = 0; t < 40 && !(await seats([0, 1, 2, 3, 4])).some((s) => s.run.state.anchored); t++) await wait(500);
  rt.mine(1);
  const second = got[0].run.state.publicKey;
  got = await until('both keys standing', [0, 1, 2, 3, 4], (s) => s.keys.length === 2);
  ask('the next key stands at all five, the template-3 node among its holders', got.every((s) => s.keys[1].publicKey === second && second !== key), `key ${second.slice(0, 16)}`);

  const db = new DatabaseSync(stores[1], { readOnly: true });
  const named = db.prepare("SELECT key FROM census_kept WHERE key LIKE 'chain:censuskey:%'").all().map((r) => r.key.replace(/^chain:censuskey:[0-9a-f]+:/, '').replace(/:[0-9a-f]{64}:/, ':'));
  const held = db.prepare('SELECT epoch, length(shares) n FROM census_key_held ORDER BY epoch').all();
  const deals = db.prepare('SELECT count(*) n FROM census_key_deals').get().n;
  db.close();
  ask('the census read after the key was kept under a name with the keys in it, and the one before under none', named.some((k) => /^299:/.test(k) && !/keys/.test(k)) && named.some((k) => /^399:.*:keys[0-9a-f]{16}$/.test(k)), named.join(' '));
  ask('a holder keeps its shares of both keys', held.length === 2, `${held.length} keys, ${deals} deals of the run in hand`);

  // THE LARGEST BODY A KEY CAN NEED: 683 signers of one share each
  const secret = schnorr.utils.randomSecretKey();
  const record = { networkId: new Uint8Array(32).fill(1), epoch: 9, publicKey: new Uint8Array(32).fill(2), censusHeight: 899, totalShares: 1024, threshold: 683, transcriptHash: new Uint8Array(32).fill(3) };
  const signatures = Array.from({ length: 683 }, (_, i) => ({ key: fromHex((i + 1).toString(16).padStart(64, '0')), signature: new Uint8Array(64).fill(1) }));
  const pieces = censusKeyBodyPieces(encodeCensusKeyBody({ record, signatures }));
  const carrier = censusKeyCarrier(secret, pieces.length);
  const funded = rt.fund(carrier.spk, '0.01');
  rt.mine(1);
  const raw = censusKeyAnchorSpend({ carrier, secret, pieces, funding: { txid: funded.txid, vout: funded.vout, value: funded.value }, record });
  // over RPC: the hex is longer than one command line argument may be
  const [accepted] = await bitcoindRpc({ url: `http://127.0.0.1:${RPC}`, cookiePath: `${RT}/regtest/.cookie` })('testmempoolaccept', [[toHex(raw)]]);
  ask('bitcoind takes the largest body as standard', accepted.allowed === true, `${pieces.length} pieces, ${raw.length} bytes, ${accepted.vsize} vB ${accepted['reject-reason'] || ''}`);
} catch (e) { wrong += 1; console.error(`#972 stopped: ${e.message}`); console.error(`#972 logs in ${dir}`); env.CK_KEEP = '1'; }
await stopAll();
console.log(wrong ? `#972 ${wrong} wrong` : '#972 all as expected');
process.exit(wrong ? 1 : 0);
