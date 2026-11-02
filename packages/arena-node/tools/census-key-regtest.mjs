#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY THROUGH THE NODE'S OWN CODE (kanban #972, spec 5A.3B). A private regtest, never testnet4, never a live seat. Real `src/main.js` nodes and a real bitcoind: the keys are
// made over the seats' own doors on the chain's clock, the anchor comes from a seat's wallet, each seat reads it back from its own chain, a template-3 bond naming the key counts,
// one naming another key does not, and the next epoch's run holds the new node. Then the census moves under the key: a reshare the chain starts and decides (#1048), one that fails on a
// drop-out, one that holds, and the new shares open the same key. Last, what a page reads: the seats' records, each checked in the page's own code. One line per question, expected
// answer beside it; exits 1 if any differs.
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
import { censusKeyAnchor, encodeCensusKeyBody } from '../../arena-protocol/src/census-key.js';
import { CENSUS_KEY_VERSION, BOND_SUM_VERSION } from '../../arena-protocol/src/constants.js';
import { lagrangeOf } from '../../arena-protocol/src/census-dkg.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { standingKeysFor, BOND_TERMS } from '../../arena-client/src/committee.js';
import { bondTweakPoint, bondCombine, verify as pageVerify } from '../../arena-client/src/page-curve.js';
import { feldmanGroup } from '../src/curve.js';
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
  const versions = [1, CENSUS_KEY_VERSION];
  const bond = (i, sats, extra = {}) => rt.postBond(keys[i].secret, { endpoint: `ws://127.0.0.1:${ports[i]}`, bondSats: sats, fundBtc: '0.02', protocolVersions: versions, operatorId: `op${i}`, ...extra });
  const posted = [100000n, 100000n, 150000n, 200000n].map((sats, i) => bond(i, sats));
  // BONDED, AND NOT SPEAKING THE VERSION THAT RUNS THE DAEMON: out of T and the shares alike (#1048 answer 2)
  const silent = rt.postBond(schnorr.utils.randomSecretKey(), { endpoint: 'ws://127.0.0.1:1', bondSats: 900000n, fundBtc: '0.02', protocolVersions: [1, BOND_SUM_VERSION], operatorId: 'old' });
  rt.include([...posted.map((p) => p.hex), silent.hex]);
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
  ask('a node whose advert does not list CENSUS_KEY_VERSION adds nothing: its 900,000 sat would be 18 shares', got[0].run.total === 11 && got[0].run.threshold === 8, `${got[0].run.total} shares, threshold ${got[0].run.threshold}`);
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

  // THE CENSUS MOVES UNDER THE FIRST KEY. Seat 3 (index 2) stops listing the version: 8 of the first key's 11 shares are held now, under 80 %, still over the threshold of 8. The second key
  // is named by nothing, so it is retired and asks for nothing
  const leaves = rt.prepareAdvertUpdate(keys[2].secret, { ...posted[2].advert, protocolVersions: [1, BOND_SUM_VERSION], timestamp: BigInt(Date.now()) });
  rt.include([rt.postAdvertUpdate(leaves, { txid: posted[2].txid, vout: 0 }).hex]);
  rt.mine(500 - 1 - rt.height());
  const all = [0, 1, 2, 3, 4];
  await until('every seat scanned to 499', all, (s) => s.scannedTo === 499);
  rt.mine(1);
  got = await until('the plan of epoch 5 at the four old holders', [0, 1, 2, 3], (s) => s.reshare && s.reshare.run === 5 && s.reshare.key === key && s.reshare.signed === 4);
  ask('the trigger comes from the chain, and the old holders say ready, the one that left too', true, `key ${key.slice(0, 16)}, ${got[0].reshare.signed} ReshareReady signatures`);
  ask('nothing else is due: the retired second key asks for no reshare and no new key', (await seat(0)).run === null);
  rt.mine(2);      // the end of the first quarter, 502
  for (let t = 0; t < 60 && !(await seats([0, 1, 2, 3])).some((s) => s && s.reshare && s.reshare.posted); t++) await wait(500);
  const listed = (await seats([0, 1, 2, 3])).filter((s) => s.reshare.posted);
  ask('the first holder in duty order anchors the list', listed.length === 1, listed.length ? listed[0].reshare.posted : '');
  const listTx = JSON.parse(cli('getrawtransaction', listed[0].reshare.posted, '1'));
  ask('its one output is OP_RETURN "ARN" \'R\' H(list), the list in the leaf it spends', listTx.vout.length === 1 && listTx.vout[0].scriptPubKey.hex.startsWith('6a24' + '41524e52') && listTx.vin[0].txinwitness.length === 3, `${listTx.vsize} vB`);
  // A DROP-OUT: the largest holder is gone before it deals, and the list that names it stands anyway
  await stopSeat(3);
  rt.mine(1);
  got = await until('the list on every chain', [0, 1, 2, 4], (s) => s.anchors.some((a) => a.kind === 'R' && a.stands));
  const present = (await seat(0)).reshare.list.present;
  ask('the first valid anchor is `present`, and the node that stopped is in it', present.includes(toHex(schnorr.getPublicKey(keys[3].secret))), `${present.length} present`);
  rt.mine(510 - rt.height());
  got = await until('the run failed at its window\'s end', [0, 1], (s) => s.reshare.state && s.reshare.state.failed === true);
  ask('a drop-out fails the run: no record, and the old shares stand', got[0].keys[0].holdersFrom === 3, `signed ${got[0].reshare.statements} statements, ${got[0].reshare.deals} of ${got[0].reshare.dealers} deals`);
  startSeat(3);
  for (let t = 0; t < 120; t++) { if (await fetch(`${url(3)}/census-key`).then((r) => r.ok, () => false)) break; await wait(500); }
  rt.mine(600 - 1 - rt.height());
  await until('every seat scanned to 599', all, (s) => s.scannedTo === 599);
  rt.mine(1);
  await until('the next window says ready', [0, 1, 2, 3], (s) => s.reshare && s.reshare.run === 6 && s.reshare.signed === 4);
  rt.mine(2);
  for (let t = 0; t < 60 && !(await seats([0, 1, 2, 3])).some((s) => s && s.reshare && s.reshare.posted); t++) await wait(500);
  rt.mine(1);
  got = await until('the second list on every chain', all, (s) => s.anchors.filter((a) => a.kind === 'R' && a.stands).length === 2);
  got = await until('every deal of the run at the new holders', [0, 1, 3, 4], (s) => s.reshare && s.reshare.deals === s.reshare.dealers, 60000);
  ask('the deals run for the rest of the window, from the old holders to the new census', got[0].reshare.dealers >= 2, `${got[0].reshare.dealers} dealers, ${got[0].reshare.total} shares, threshold ${got[0].reshare.threshold}, ${got[0].reshare.holders} holders`);
  rt.mine(606 - rt.height());
  await until('the check of the reshare', [0, 1, 3, 4], (s) => s.reshare.state.checked === true);
  rt.mine(1);
  got = await until('the reshare\'s record, complete at the new holders', [0, 1, 3, 4], (s) => Number.isInteger(s.reshare.state.complete));
  ask('the reshare keeps the public key', got.every((s) => s.reshare.state.publicKey === key), `key ${key.slice(0, 16)}`);
  for (let t = 0; t < 30 && !(await seats([0, 1, 3, 4])).some((s) => s.reshare.state.anchored); t++) { rt.mine(1); await wait(700); }
  const posterOf = (await seats([0, 1, 3, 4])).find((s) => s.reshare.state.anchored);
  rt.mine(1);
  got = await until('the new holders named on every chain', all, (s) => s.keys[0].holdersFrom === 6);
  ask('the record stands by its anchor, and no key was added by it', got.every((s) => s.keys.length === 2 && s.keys[0].publicKey === key), posterOf ? `anchor ${posterOf.reshare.state.anchored.slice(0, 16)}` : '');
  const heldBy = (i) => { const d = new DatabaseSync(stores[i], { readOnly: true }); const rows = d.prepare('SELECT epoch, shares FROM census_key_held WHERE hex(public_key) = ?').all(key.toUpperCase()); d.close(); return rows; };
  for (let t = 0; t < 20 && heldBy(2).length; t++) await wait(500);
  ask('the node that left keeps none of the key, once the record stands', heldBy(2).length === 0);
  const shares = new Map();
  for (const i of [0, 1, 3, 4]) { const row = heldBy(i).find((r) => r.epoch === 6); for (const [x, v] of (row ? JSON.parse(row.shares) : [])) shares.set(x, BigInt(`0x${v}`)); }
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const xs = [...shares.keys()].sort((a, b) => a - b);
  const lambda = lagrangeOf(xs, xs);
  const secretOf = xs.reduce((a, x) => (a + lambda.get(x) * shares.get(x)) % N, 0n);
  ask('the new shares open the same key', toHex(feldmanGroup.pointFromScalar(secretOf)).slice(2) === key, `${xs.length} shares`);
  rt.mine(700 - 1 - rt.height());
  await until('every seat scanned to 699', all, (s) => s.scannedTo === 699);
  rt.mine(1);
  await wait(3000);
  ask('the trigger is quiet now: the new census holds the key', (await seats(all)).every((s) => s.reshare === null));

  // WHAT A PAGE READS (#1048): the anchors from the seats and the census each names, all of it checked in the page's own code against headers read here
  const node = bitcoindRpc({ url: `http://127.0.0.1:${RPC}`, cookiePath: `${RT}/regtest/.cookie` });
  const tip = rt.height();
  const headers = [];
  for (let h = 0; h <= tip; h++) headers.push(fromHex(String(await node('getblockheader', [String(await node('getblockhash', [h])), false]))));
  const terms = BOND_TERMS.regtest;
  const pageBond = { arbitrationKeys: terms.arbitrationKeys, arbitrationK: terms.arbitrationK, bondMaturity: terms.bondMaturity, tweakPoint: bondTweakPoint, combine: bondCombine };
  const contract = { networkId: NETWORK_ID_REGTEST, censusHeight: tip, censusConfirmations: 1 };
  const nodes = ports.map((_, i) => url(i));
  const read = (fetcher = fetch) => standingKeysFor({ contract, nodes, chain: { headers, firstHeight: 0 }, bond: pageBond, verify: pageVerify, fetcher });
  const t2 = Date.now();
  const page = await read();
  ask('the page reads both keys from the seats and checks each itself', page.ok && page.keys.length === 2 && toHex(page.keys[0].publicKey) === key && toHex(page.keys[1].publicKey) === second && !page.refused.length, `${page.keys ? page.keys.length : 0} keys in ${Date.now() - t2} ms ${(page.refused || []).join(' ')}`.trim());
  const lied = (change) => async (u, o) => { const r = await fetch(u, o); return String(u).includes('/census-key/') ? change(String(u), r) : r; };
  const altered = async (r, edit) => { const j = await r.json(); edit(j); return new Response(JSON.stringify(j), { status: 200 }); };
  let answer = await read(lied((u, r) => (u.includes('/records') ? altered(r, (j) => { j.records.forEach((x) => { x.branch = x.branch.length ? [...x.branch].reverse().map((b) => b.replace(/^../, 'ff')) : ['ff'.repeat(32)]; }); }) : r)));
  ask('an anchor that is not in the page\'s chain is refused', answer.keys.length === 0 && /not in any block/.test(answer.refused.join(' ')), answer.refused[0]);
  answer = await read(lied((u, r) => (u.includes('/census-key/census') ? altered(r, (j) => { j.entries.pop(); }) : r)));
  ask('a census with an entry left out does not hold the record', answer.keys.length === 0, answer.refused[0]);
  answer = await read(lied((u, r) => (u.includes('/records') ? altered(r, (j) => { j.records = j.records.slice(1); }) : r)));
  ask('a seat that leaves the first key out cannot stand the second, whose census names it', answer.keys.every((k) => toHex(k.publicKey) !== key) && answer.keys.length === 0, answer.refused[0]);

  // THE LARGEST BODY A KEY CAN NEED: 683 signers of one share each
  const secret = schnorr.utils.randomSecretKey();
  const record = { networkId: new Uint8Array(32).fill(1), epoch: 9, publicKey: new Uint8Array(32).fill(2), censusHeight: 899, totalShares: 1024, threshold: 683, transcriptHash: new Uint8Array(32).fill(3) };
  const signatures = Array.from({ length: 683 }, (_, i) => ({ key: fromHex((i + 1).toString(16).padStart(64, '0')), signature: new Uint8Array(64).fill(1) }));
  const carrier = censusKeyCarrier(secret, encodeCensusKeyBody({ record, signatures }));
  const funded = rt.fund(carrier.spk, '0.01');
  rt.mine(1);
  const raw = censusKeyAnchorSpend({ carrier, secret, funding: { txid: funded.txid, vout: funded.vout, value: funded.value }, output: censusKeyAnchor(record) });
  // over RPC: the hex is longer than one command line argument may be
  const [accepted] = await node('testmempoolaccept', [[toHex(raw)]]);
  ask('bitcoind takes the largest body in its leaf as standard', accepted.allowed === true, `${raw.length} bytes, ${accepted.vsize} vB ${accepted['reject-reason'] || ''}`);
} catch (e) { wrong += 1; console.error(`#972 stopped: ${e.message}`); console.error(`#972 logs in ${dir}`); env.CK_KEEP = '1'; }
await stopAll();
console.log(wrong ? `#972 ${wrong} wrong` : '#972 all as expected');
process.exit(wrong ? 1 : 0);
