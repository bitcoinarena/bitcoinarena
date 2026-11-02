#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CENSUS KEY 0 THROUGH THE NODE'S OWN CODE (kanban #1050, spec 5A.3B). A private regtest, never testnet4, never a live seat. Four founders run key 0's DKG before any bond, and three of them
// bond naming it; the fourth never bonds. Real `src/main.js` seats read the holders the genesis stand-in names, the 80 % trigger trips, the old holders post the list, the new census deals,
// its record stands by its anchor, the old shares go, and the new shares open key 0. The first key by weight runs beside it. Then a hold output: a real slash start on a bond naming that first key,
// its only bond, and the census reads the hold as the same bond with the same weight, a key named only by it is not retired, and the fallback ends it. One line per question; exits 1 if any differs.
//
//   node tools/census-key-0-regtest.mjs            (from packages/arena-node; CK_DIR, CK_BASE_PORT, BITCOIN_BIN)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { plan as foundersPlan, deal as foundersDeal, sign as foundersSign, finish as foundersFinish } from './founders-dkg.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { feldmanGroup } from '../src/curve.js';
import { CENSUS_KEY_VERSION } from '../../arena-protocol/src/constants.js';
import { lagrangeOf } from '../../arena-protocol/src/census-dkg.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { standingKeysFor, BOND_TERMS } from '../../arena-client/src/committee.js';
import { bondTweakPoint, bondCombine, verify as pageVerify } from '../../arena-client/src/page-curve.js';
import { BOND_TEMPLATE_V3, HOLD_INTERNAL_KEY, TAPLEAF_VERSION, controlBlockFor, holdControlBlock, holdOutputKey, slashStartLeaf, tapLeafHash, tapTweak } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { arbitrationCommitment } from '../../arena-protocol/src/arbitration-tx.js';
import { SLASH_CLOCKS } from '../../arena-protocol/src/genesis.js';
import { scalarTo32 } from '../../arena-protocol/src/shares.js';
import { tweakPoint } from '../src/curve.js';
import { fromHex, taggedHash, toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const BIN = env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const BASE = Number(env.CK_BASE_PORT || 28540), RPC = BASE, P2P = BASE + 1;
const dir = mkdtempSync(join(env.CK_DIR || '/mnt/bitcoin/relocated/claude-tmp/claude-1000', 'census-key-0-regtest-'));
const RT = join(dir, 'chain');
mkdirSync(RT);
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const SEATS = 4, FIRST = 300, ports = Array.from({ length: SEATS }, (_, i) => BASE + 10 + i), all = [0, 1, 2, 3];
const stores = ports.map((_, i) => join(dir, `seat-${i + 1}.db`));
const url = (i) => `http://127.0.0.1:${ports[i]}`;
const cli = (...a) => execFileSync(join(BIN, 'bitcoin-cli'), ['-regtest', `-datadir=${RT}`, `-rpcport=${RPC}`,
  ...(['listwallets', 'loadwallet', 'createwallet'].includes(a[0]) ? [] : ['-rpcwallet=arena']), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let wrong = 0;
const ask = (label, ok, said = '') => { if (!ok) wrong += 1; console.log(`#1050 ${ok ? 'as expected' : 'WRONG      '} | ${label}${said === '' ? '' : ` | ${said}`}`); };
const kids = new Map();
function startSeat(i) {
  const log = openSync(`${stores[i]}.log`, 'a');
  kids.set(i, spawn('nice', ['-n', '15', process.execPath, 'src/main.js', String(ports[i]), stores[i]], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', log, log],
    env: { ...env, ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: `${RT}/regtest/.cookie`, ARENA_DONATION_NETWORK: 'regtest', ARENA_CENSUS_KEY_FIRST_HEIGHT: String(FIRST),
      ARENA_CENSUS_KEY_0: join(dir, `key0-${i}.json`), ARENA_CENSUS_KEY_EVERY_MS: '1000', ARENA_DUTY_POST: 'auto', ARENA_DUTY_APPS: 'none', ARENA_DUTY_FEE_RATE: '2',
      ARENA_APPS: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname } }));
}
const seat = async (i) => (await fetch(`${url(i)}/census-key`, { signal: AbortSignal.timeout(8000) })).json();
const seats = (list) => Promise.all(list.map((i) => seat(i).catch(() => null)));
async function until(what, list, test, ms = 90000) {
  const stop = Date.now() + ms;
  for (;;) {
    const got = await seats(list);
    if (got.every((s) => s && test(s))) return got;
    if (Date.now() > stop) { ask(`in time: ${what}`, false, JSON.stringify(got.map((s) => (s ? { to: s.scannedTo, reshare: s.reshare && { ...s.reshare, window: undefined }, why: s.lastWhy } : null))).slice(0, 900)); throw new Error(`no ${what}`); }
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
  const pubOf = (id) => schnorr.getPublicKey(id.secret);

  // THE FOUNDERS' RUN, BEFORE ANY BOND: seats 0, 1, 2 and one founder who never bonds. One share each, threshold 3
  // through the founders' own tool, each on its store and a shared folder (tools/founders-dkg.mjs), as they would on their own machines
  const goneStore = join(dir, 'founder-gone.db');
  { const db = openStore(goneStore); nodeIdentity(db); db.close(); }
  const goneId = (() => { const db = openStore(goneStore), id = nodeIdentity(db); db.close(); return id; })();
  const founders = [{ store: stores[0], key: pubOf(keys[0]) }, { store: stores[1], key: pubOf(keys[1]) }, { store: stores[2], key: pubOf(keys[2]) }, { store: goneStore, key: pubOf(goneId) }];
  const shared = join(dir, 'founders');
  foundersPlan({ founders: founders.map((f) => toHex(f.key)), network: 'regtest', dir: shared });
  for (const f of founders) await foundersDeal({ store: f.store, dir: shared });
  for (const f of founders) await foundersSign({ store: f.store, dir: shared });
  const made = [];
  for (const f of founders) made.push(await foundersFinish({ store: f.store, dir: shared }));
  const key = made[0].publicKey, key0 = fromHex(key);
  ask('the founders made key 0 before any bond, by the tool: one key at all four', made.every((m) => m.publicKey === key), `key ${key.slice(0, 16)}, 4 holders, threshold 3`);
  const genesis = { publicKey: key, holders: founders.map((f) => toHex(f.key)), threshold: 3 };
  for (let i = 0; i < SEATS; i++) writeFileSync(join(dir, `key0-${i}.json`), JSON.stringify(genesis));

  const versions = [1, CENSUS_KEY_VERSION];
  const bond = (i, sats, extra = {}) => rt.postBond(keys[i].secret, { endpoint: `ws://127.0.0.1:${ports[i]}`, bondSats: sats, fundBtc: '0.02', protocolVersions: versions, operatorId: `op${i}`, ...extra });
  const posted = [0, 1, 2].map((i) => bond(i, 100000n, { template: BOND_TEMPLATE_V3, censusKey: key0 }));
  posted.push(bond(3, 150000n));
  rt.include(posted.map((p) => p.hex));
  rt.mine(FIRST - 1 - rt.height());
  for (let i = 0; i < SEATS; i++) { startSeat(i); await wait(4000); }
  for (let t = 0; t < 120; t++) {
    const up = await Promise.all(ports.map((p) => fetch(`http://127.0.0.1:${p}/census-key`).then((r) => r.ok, () => false)));
    if (up.every(Boolean)) break;
    await wait(1000);
  }
  let got = await until('key 0 standing at every seat, from genesis, no anchor', all, (s) => s.keys.length === 1 && s.keys[0].publicKey === key);
  ask('every seat reads key 0 from genesis at height 0, first holders epoch 0', got.every((s) => s.keys[0].height === 0 && s.keys[0].epoch === 0 && s.keys[0].holdersFrom === 0));

  const founding = [0, 1, 2];
  rt.mine(1);
  got = await until('the plan of epoch 3 at the three founders', founding, (s) => s.reshare && s.reshare.run === 3 && s.reshare.key === key && s.reshare.signed === 3);
  ask('the trigger reads the founders genesis names: three of four in the census, under 80 %', true, `${got[0].reshare.signed} ReshareReady signatures`);
  await until('the first key by weight runs beside it', all, (s) => s.run && s.run.epoch === 3 && s.run.deals === 4);
  rt.mine(2);      // the end of the first quarter, 302
  for (let t = 0; t < 60 && !(await seats(founding)).some((s) => s && s.reshare && s.reshare.posted); t++) await wait(500);
  const listed = (await seats(founding)).filter((s) => s.reshare.posted);
  ask('one founder anchors the list', listed.length === 1, listed.length ? listed[0].reshare.posted : '');
  rt.mine(1);
  await until('the list on every chain', all, (s) => s.anchors.some((a) => a.kind === 'R' && a.stands));
  got = await until('every deal of the run at the new holders', all, (s) => s.reshare && s.reshare.deals === s.reshare.dealers, 60000);
  ask('the founders deal to the new census, a seat that never held key 0 among it', got[3].reshare.dealers === 3 && got[3].reshare.holders === 4, `${got[3].reshare.dealers} dealers, ${got[3].reshare.total} shares, threshold ${got[3].reshare.threshold}`);
  rt.mine(305 - rt.height());
  await until('the first key\'s check', all, (s) => s.run.state.checked === true);
  rt.mine(1);
  await until('the reshare\'s check', all, (s) => s.reshare.state.checked === true);
  rt.mine(1);
  got = await until('the reshare\'s record, complete at the new holders', all, (s) => Number.isInteger(s.reshare.state.complete) && Number.isInteger(s.run.state.complete));
  ask('the reshare keeps key 0\'s public key, the first key by weight is another', got.every((s) => s.reshare.state.publicKey === key && s.run.state.publicKey !== key));
  const first = got[0].run.state.publicKey;
  for (let t = 0; t < 40 && !(await seats(all)).every((s) => s.keys.length === 2 && s.keys[0].holdersFrom === 3); t++) { rt.mine(1); await wait(1000); }
  got = await until('the new holders named on every chain', all, (s) => s.keys[0].holdersFrom === 3 && s.keys.length === 2);
  ask('the record stands by its anchor, and adds no key: key 0 and the first key by weight', got.every((s) => s.keys[0].publicKey === key && s.keys[1].publicKey === first), `epoch ${got[0].keys[1].epoch} key ${first.slice(0, 16)}`);
  const heldBy = (i, k = key) => { const d = new DatabaseSync(stores[i], { readOnly: true }); const rows = d.prepare('SELECT epoch, shares FROM census_key_held WHERE hex(public_key) = ?').all(k.toUpperCase()); d.close(); return rows; };
  for (let t = 0; t < 20 && heldBy(0).some((r) => r.epoch === 0); t++) await wait(500);
  ask('the founders\' old shares are gone once the record stands', founding.every((i) => !heldBy(i).some((r) => r.epoch === 0)));
  const shares = new Map();
  for (const i of all) { const row = heldBy(i).find((r) => r.epoch === 3); for (const [x, v] of (row ? JSON.parse(row.shares) : [])) shares.set(x, BigInt(`0x${v}`)); }
  ask('the seat that never held key 0 holds shares of it now', JSON.parse(heldBy(3).find((r) => r.epoch === 3).shares).length === 3);
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const xs = [...shares.keys()].sort((a, b) => a - b);
  const lambda = lagrangeOf(xs, xs);
  ask('the new shares open key 0', toHex(feldmanGroup.pointFromScalar(xs.reduce((a, x) => (a + lambda.get(x) * shares.get(x)) % N, 0n))).slice(2) === key, `${xs.length} shares`);
  rt.mine(400 - 1 - rt.height());
  await until('every seat scanned to 399', all, (s) => s.scannedTo === 399);
  rt.mine(1);
  await wait(3000);
  ask('the trigger is quiet: the new census holds key 0, its holders now its record\'s', (await seats(all)).every((s) => s.reshare === null));

  // A PAGE: key 0 from its genesis, the first key checked in the page's own code. The bonds naming key 0 are in the census that key's record names
  const node = bitcoindRpc({ url: `http://127.0.0.1:${RPC}`, cookiePath: `${RT}/regtest/.cookie` });
  const headers = [];
  for (let h = 0; h <= rt.height(); h++) headers.push(fromHex(String(await node('getblockheader', [String(await node('getblockhash', [h])), false]))));
  const terms = BOND_TERMS.regtest;
  const page = await standingKeysFor({ contract: { networkId: NETWORK_ID_REGTEST, censusHeight: rt.height(), censusConfirmations: 1 }, nodes: ports.map((_, i) => url(i)), chain: { headers, firstHeight: 0 },
    bond: { arbitrationKeys: terms.arbitrationKeys, arbitrationK: terms.arbitrationK, bondMaturity: terms.bondMaturity, tweakPoint: bondTweakPoint, combine: bondCombine }, verify: pageVerify,
    genesis: { censusKey0: { publicKey: key0, holders: founders.map((f) => f.key), threshold: 3 } } });
  ask('the page reads key 0 from genesis and checks the first key on bonds naming it', page.ok && page.keys.length === 2 && toHex(page.keys[0].publicKey) === key && toHex(page.keys[1].publicKey) === first && !page.refused.length, `${page.keys ? page.keys.length : 0} keys ${(page.refused || []).join(' ')}`.trim());

  // A HOLD OUTPUT IS STILL THE BOND (5A.2). Seat 3 adds one bond, the only one naming the first key, and the census key starts it to a hold output with no panels
  const scalarOf = (k, epoch) => {
    const got = new Map();
    for (const i of all) { const row = heldBy(i, k).find((r) => r.epoch === epoch); for (const [x, v] of (row ? JSON.parse(row.shares) : [])) got.set(x, BigInt(`0x${v}`)); }
    const ids = [...got.keys()].sort((a, b) => a - b), l = lagrangeOf(ids, ids);
    return scalarTo32(ids.reduce((a, x) => (a + l.get(x) * got.get(x)) % N, 0n));
  };
  const firstSecret = scalarOf(first, 3);
  ask('the first key\'s shares open it, to sign as 2/3 of its holders would', toHex(schnorr.getPublicKey(firstSecret)) === first);
  const started = bond(3, 100000n, { template: BOND_TEMPLATE_V3, censusKey: fromHex(first) });
  rt.include([started.hex]);
  rt.mine(1);
  const value = 100000n, nodeKey = pubOf(keys[3]), firstKey = fromHex(first);
  const bondScript = fromHex(`5120${toHex(started.built.outputKey)}`), bondIn = { txid: fromHex(started.txid).reverse(), vout: 0, sequence: 0xfffffffd };
  const C = SLASH_CLOCKS.regtest, clocks = { holdBlocks: C.slashHoldBlocks, returnBlocks: C.slashReturnBlocks, fallbackBlocks: C.slashFallbackBlocks };
  const hold = holdOutputKey({ nodeKey, censusKey: firstKey, panelA: [], panelB: [], bondMaturity: started.maturity, ...clocks }, { tweakPoint });
  const leafScript = slashStartLeaf(nodeKey, firstKey), leafHash = tapLeafHash(leafScript);
  const presig = Uint8Array.from([...schnorr.sign(tapSighash({ version: 2, locktime: 0, inputs: [bondIn], outputs: [{ value, script: hold.script }], prevouts: [{ value, script: bondScript }], inputIndex: 0, leafHash, hashType: 0x83 }), keys[3].secret), 0x83]);
  // whoever files the slash brings a fee coin and the proof's OP_RETURN
  const payer = schnorr.utils.randomSecretKey(), feeLeaf = Uint8Array.from([0x20, ...schnorr.getPublicKey(payer), 0xac]);
  const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, tapLeafHash(feeLeaf)));
  const feeScript = fromHex(`5120${toHex(q.outputKey)}`), fee = rt.fund(feeScript, '0.001');
  const feeIn = { txid: fromHex(fee.txid).reverse(), vout: fee.vout, sequence: 0xfffffffd };
  const tx = { version: 2, locktime: 0, inputs: [bondIn, feeIn], outputs: [{ value, script: hold.script }, arbitrationCommitment(taggedHash('ARENA/v1/SlashProof', new Uint8Array(32).fill(7)), rt.height(), new Uint8Array(0)), { value: fee.value - 5000n, script: rt.payTo() }] };
  const prevouts = [{ value, script: bondScript }, { value: fee.value, script: feeScript }];
  const raw = toHex(serializeSpend({ ...tx, witnesses: [
    scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 0, leafHash }), firstSecret), presig], script: leafScript, controlBlock: controlBlockFor('slash', started.built).controlBlock }),
    scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 1, leafHash: tapLeafHash(feeLeaf) }), payer)], script: feeLeaf, controlBlock: Uint8Array.from([TAPLEAF_VERSION | q.parity, ...HOLD_INTERNAL_KEY]) }),
  ] }));
  const startTxid = cli('sendrawtransaction', raw);
  rt.mine(1);
  ask('a real slash start, node presig and census key, spends the bond into its hold output', JSON.parse(cli('getrawtransaction', startTxid, '1')).confirmations === 1, `${JSON.parse(cli('getrawtransaction', startTxid, '1')).vsize} vB`);
  const keptCensus = (height) => {
    const d = new DatabaseSync(stores[0], { readOnly: true });
    const row = d.prepare("SELECT body FROM census_kept WHERE key LIKE ?").get(`chain:censuskey:%:${height}:%`);
    d.close();
    return row ? JSON.parse(row.body) : null;
  };
  rt.mine(500 - 1 - rt.height());
  await until('every seat scanned to 499', all, (s) => s.scannedTo === 499);
  rt.mine(1);
  got = await until('the run of epoch 5', all, (s) => s.run && s.run.epoch === 5);
  ask('a key named only by a hold output is not retired: its newest-key run came due', got.every((s) => s.run.epoch === 5));
  ask('the hold output keeps its weight: 6 shares of the founders + 3 + 2 of the started bond', got.every((s) => s.run.total === 11), `${got[0].run.total} shares, threshold ${got[0].run.threshold}`);
  const before = keptCensus(499);
  ask('the census at 499 holds the started bond, and it names the first key once', before.entries.length === 5 && before.namedKeys[first] === 1, `${before.entries.length} entries, named ${before.namedKeys[first]}`);

  // THE FALLBACK ENDS IT: the census key alone, slash_fallback_blocks after the start
  const fbTx = { version: 2, locktime: 0, inputs: [{ txid: fromHex(startTxid).reverse(), vout: 0, sequence: clocks.fallbackBlocks }], outputs: [{ value: value - 2000n, script: rt.payTo() }] };
  const fbDigest = tapSighash({ ...fbTx, prevouts: [{ value, script: hold.script }], inputIndex: 0, leafHash: hold.leaves.fallback });
  const fb = cli('sendrawtransaction', toHex(serializeSpend({ ...fbTx, witnesses: [scriptPathWitness({ stack: [schnorr.sign(fbDigest, firstSecret)], script: hold.scripts.fallback, controlBlock: holdControlBlock('fallback', hold).controlBlock })] })));
  rt.mine(1);
  ask('the fallback spends the hold output', JSON.parse(cli('getrawtransaction', fb, '1')).confirmations === 1);
  rt.mine(600 - rt.height());
  await until('every seat scanned to 600', all, (s) => s.scannedTo >= 600, 180000);
  let after = null;
  for (let t = 0; t < 120 && !after; t++) { after = keptCensus(599); if (!after) await wait(500); }
  ask('the census at 599 has lost that bond, and nothing names the first key', after && after.entries.length === 4 && !after.namedKeys[first], after ? `${after.entries.length} entries` : 'no census');
} catch (e) { wrong += 1; console.error(`#1050 stopped: ${e.message}`); console.error(`#1050 logs in ${dir}`); env.CK_KEEP = '1'; }
await stopAll();
console.log(wrong ? `#1050 ${wrong} wrong` : '#1050 all as expected');
process.exit(wrong ? 1 : 0);
