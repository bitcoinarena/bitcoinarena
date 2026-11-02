#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A REAL NODE'S TEMPLATE-3 BOND (spec 5A.3B, kanban #972). A private regtest, never testnet4, never a live seat. A real `src/main.js` seat with a bond wallet is told by its owner to add to its bond: it
// names the standing census key and posts the output and its slash_presig through bitcoind's mempool. The installer's builder does the same. Then the owner changes its roles, withdraws an output by
// path A, and an output is started: the node reads that, refuses path A, and returns the hold at its clock. One line per question; exits 1 if any differs.
//
//   node tools/bond-node-regtest.mjs            (from packages/arena-node; BN_DIR, BN_BASE_PORT, BITCOIN_BIN)
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { CensusDkg } from '../src/dkg.js';
import { signOwnerRequest } from '../src/owner.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { censusOfView } from '../src/roster.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { buildBond } from '../../arena-installer/src/bond.js';
import { walletOf, payoutKeyOf } from '../../arena-installer/src/wallet.js';
import { censusKey0Shares, censusKeyContract } from '../../arena-protocol/src/census-key.js';
import { founderRun, lagrangeOf } from '../../arena-protocol/src/census-dkg.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { bondPresigDigest, holdClocksOf, SLASH_START_SEQUENCE } from '../../arena-protocol/src/slash-presig.js';
import { BOND_TEMPLATE_V3, HOLD_INTERNAL_KEY, TAPLEAF_VERSION, controlBlockFor, slashStartLeaf, tapLeafHash, tapTweak } from '../../arena-protocol/src/bond-script.js';
import { tapSighash, scriptPathWitness, serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { arbitrationCommitment } from '../../arena-protocol/src/arbitration-tx.js';
import { scalarTo32 } from '../../arena-protocol/src/shares.js';
import { fromHex, taggedHash, toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const BIN = env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const BASE = Number(env.BN_BASE_PORT || 28840), RPC = BASE, P2P = BASE + 1, SEAT = BASE + 10;
const dir = mkdtempSync(join(env.BN_DIR || '/mnt/bitcoin/relocated/claude-tmp/claude-1000', 'bond-node-regtest-'));
const RT = join(dir, 'chain');
mkdirSync(RT);
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const NODES = 6, S = 4;
const stores = Array.from({ length: NODES }, (_, i) => join(dir, `seat-${i + 1}.db`));
const base = `http://127.0.0.1:${SEAT}`;
const cliWords = [`-regtest`, `-datadir=${RT}`, `-rpcport=${RPC}`];
const cli = (...a) => execFileSync(join(BIN, 'bitcoin-cli'), [...cliWords, ...(['listwallets', 'loadwallet', 'createwallet', 'getblockcount'].includes(a[0]) ? [] : ['-rpcwallet=arena']), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let wrong = 0;
const ask = (label, ok, said = '') => { if (!ok) wrong += 1; console.log(`#972 ${ok ? 'as expected' : 'WRONG      '} | ${label}${said === '' ? '' : ` | ${said}`}`); };
let seat = null, done = false;
const stopAll = async () => {
  if (done) return; done = true;
  if (seat) seat.kill('SIGTERM');
  await wait(1500);
  try { cli('stop'); } catch { /* gone */ }
  await wait(1500);
  if (env.BN_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
};
const until = async (what, fn, tries = 120) => { let last = ''; for (let t = 0; t < tries; t++) { try { const got = await fn(); if (got) return got; } catch (e) { last = `${e.message} ${e.cause ? e.cause.message : ''}`; } await wait(1000); } throw new Error(`never: ${what} ${last}`); };

try {
  spawn(join(BIN, 'bitcoind'), ['-regtest', `-datadir=${RT}`, `-rpcport=${RPC}`, `-port=${P2P}`, '-listen=0', '-listenonion=0', '-txindex=1', '-fallbackfee=0.0001', '-server=1'], { stdio: 'ignore', detached: false });
  for (let t = 0; t < 60; t++) { try { cli('listwallets'); break; } catch { await wait(500); } }
  try { cli('createwallet', 'arena'); } catch { /* there */ }
  const rt = regtest(cli);
  rt.mine(250);
  const ids = stores.map((s) => { const db = openStore(s); const id = nodeIdentity(db); db.close(); return id; });
  const pub = ids.map((id) => schnorr.getPublicKey(id.secret));

  // KEY 0 before any bond, by four founders in one process: all this run needs of it is a key that stands
  const founders = [0, 1, 2, 3].map((i) => ({ secret: ids[i].secret, key: pub[i] }));
  const run = founderRun(censusKey0Shares({ holders: founders.map((f) => f.key), threshold: 3 }));
  const dkgs = founders.map((f) => new CensusDkg({ key: f.key, secret: f.secret, run, curve: feldmanGroup, random: (n) => new Uint8Array(randomBytes(n)) }));
  const deals = [];
  for (const d of dkgs) deals.push((await d.deal()).bytes);
  for (const d of dkgs) for (const b of deals) await d.accept(b);
  for (const d of dkgs) d.check();
  const said = dkgs.map((d) => d.statement());
  const made = dkgs.map((d) => d.finish(said));
  const key0 = made[0].groupPublicKey.subarray(1), key = toHex(key0);
  writeFileSync(join(dir, 'key0.json'), JSON.stringify({ publicKey: key, holders: founders.map((f) => toHex(f.key)), threshold: 3 }));
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const shares = new Map();
  for (const m of made) for (const [x, v] of m.shares) shares.set(x, v);
  const xs = [...shares.keys()].sort((a, b) => a - b), lambda = lagrangeOf(xs, xs);
  const censusSecret = scalarTo32(xs.reduce((a, x) => (a + lambda.get(x) * shares.get(x)) % N, 0n));

  const censusAt = (h = rt.height()) => censusOfView(rt.blocksFrom(0, h), censusKeyContract({ networkId: NETWORK_ID_REGTEST, network: 'regtest', height: h, censusConfirmations: 1 }), { network: 'regtest', standingKeys: [{ epoch: 0, publicKey: key0, height: 0 }] });
  // THE FIRST BONDS: posted by a tool, as a node's first bond is by its installer below. What is under test is what a running node does
  const first = [];
  for (const i of [0, 1, 2, 3, S]) {
    const p = rt.postBond(ids[i].secret, { endpoint: `ws://127.0.0.1:${SEAT + i}`, bondSats: 100000n, fundBtc: '0.02', hostedGames: [NEXTBLOCK.gameId], protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], operatorId: `op${i}`, template: BOND_TEMPLATE_V3, censusKey: key0, slackBlocks: 12 });
    rt.include([p.hex, rt.postBondPresig(ids[i].secret, p).hex]);
    first[i] = p;
  }
  rt.mine(3);

  const bondTx = (p) => toHex(fromHex(p.txid).reverse());
  const entryOf = (c, txid) => c.entries.find((e) => toHex(e.txid) === txid);
  const secretOwner = taggedHash('ARENA/test/BondNode', Uint8Array.of(1));
  const log = openSync(`${stores[S]}.log`, 'a');
  seat = spawn('nice', ['-n', '15', process.execPath, 'src/main.js', String(SEAT), stores[S]], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', log, log],
    env: { ...env, ARENA_BITCOIND_URL: `http://127.0.0.1:${RPC}`, ARENA_BITCOIND_COOKIE: `${RT}/regtest/.cookie`, ARENA_DONATION_NETWORK: 'regtest', ARENA_FUND_FREE_ROUNDS: '1', ARENA_CENSUS_KEY_FIRST_HEIGHT: '100000', ARENA_CENSUS_KEY_0: join(dir, 'key0.json'),
      ARENA_BOND_CLI: [join(BIN, 'bitcoin-cli'), ...cliWords, '-rpcwallet=arena'].join(','), ARENA_APPS: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname } });
  await until('the seat', async () => { try { return (await fetch(`${base}/identity`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } });
  const node = (await (await fetch(`${base}/owner`)).json()).node;
  const signed = (action, args) => signOwnerRequest({ node, action, args, secret: secretOwner, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) });
  // a socket the seat closed while the chain was mined here answers ECONNRESET to the next request, which it never read
  const door = async (action, args) => { for (let t = 0; ; t++) { try { const r = await fetch(`${base}/owner/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed(action, args)) }); return { status: r.status, ...(await r.json()) }; } catch (e) { if (t >= 2) throw e; await wait(500); } } };
  const claimed = await door('claim', { code: readFileSync(`${stores[S]}.owner-claim`, 'utf8').trim() });
  ask('the owner claims the seat', claimed.ok === true, claimed.why || '');
  const keys = (await (await fetch(`${base}/census-key`)).json()).keys;
  ask('the seat reads the standing census key', keys.length === 1 && keys[0].publicKey === key);

  // ADD TO BOND FROM THE OWNER PAGE: template 3, its presig beside it, through the mempool
  const plan = await door('add-bond', { sats: '120000', post: false });
  ask('the plan is a template-3 output, and the network would take all three transactions', plan.ok === true && plan.plan.template === BOND_TEMPLATE_V3, plan.why || `fees ${plan.plan.fees.total} sat`);
  const before = Number(cli('getmempoolinfo').match(/"size": (\d+)/)[1]);
  const added = await door('add-bond', { sats: '120000', post: true });
  ask('posted: the funding, the bond and the presig update sit in the mempool', added.ok === true && Number(cli('getmempoolinfo').match(/"size": (\d+)/)[1]) === before + 3, added.why || added.bond.txid);
  const addedTx = toHex(fromHex(added.bond.txid).reverse());
  ask('one funding pays both carriers', (() => { const a = JSON.parse(cli('getrawtransaction', added.bond.txid, '1')).vin[0].txid, b = JSON.parse(cli('getrawtransaction', added.bond.presigUpdate, '1')).vin[0].txid; return a === b; })());
  rt.mine(1);
  ask('the census counts the new output, by its presig', !!entryOf(censusAt(), addedTx) && !!entryOf(censusAt(), addedTx).presigBy, `template ${entryOf(censusAt(), addedTx).advert.bondScriptTemplateVersion}, key ${toHex(entryOf(censusAt(), addedTx).advert.censusKey).slice(0, 16)}`);
  const own = await until('the owner page lists both', async () => { const b = await (await fetch(`${base}/owner/bond`)).json(); return b.outputs && b.outputs.length === 2 ? b : null; });
  ask('the node reads its own bond: both outputs, template 3, the key they name', own.outputs.every((o) => o.template === BOND_TEMPLATE_V3 && o.censusKey === key) && own.total === '220000', `${own.total} sat`);

  // ITS ROLES CHANGE BY AN UPDATE, AND THE BOND STAYS WHAT IT IS
  const roles = await door('roles', { roles: ['game', 'verify'], post: true });
  ask('the owner changes the roles: an update of a template-3 bond', roles.ok === true, roles.why || '');
  rt.mine(1);
  { const e = censusAt().entries.filter((x) => toHex(x.pubkey) === node); ask('it still counts as template 3, naming the same key, with the roles changed', e.length === 2 && e.every((x) => x.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3 && toHex(x.advert.censusKey) === key && !!x.presigBy) && e.some((x) => !x.advert.roles.includes('settlement')), `${e.length} outputs`); }

  // THE INSTALLER'S BUILDER, the same thing from a node's own wallet
  const seed = new Uint8Array(32).fill(0x51), w = walletOf(seed);
  const paid = cli('sendtoaddress', JSON.parse(cli('decodescript', toHex(w.spk))).address, '0.01');
  rt.mine(1);
  const coin = JSON.parse(cli('getrawtransaction', paid, '1')).vout.find((o) => o.scriptPubKey.hex === toHex(w.spk));
  const built = buildBond({ wallet: w, nodeSecret: ids[5].secret, coins: [{ txid: paid, vout: coin.n, sats: 1000000 }], tip: rt.height(), bondSats: 200000n, operatorId: 'op-inst', roles: ['verify', 'settlement'], endpoint: `ws://127.0.0.1:${SEAT + 5}`,
    payoutPubkey: payoutKeyOf(seed), softwareHash: new Uint8Array(32).fill(1), censusKey: key0, network: 'regtest', hostedGames: [toHex(NEXTBLOCK.gameId)] });
  const sent = [built.funding.hex, built.bond.hex, built.presigUpdate.hex].map((h) => cli('sendrawtransaction', h));
  rt.mine(1);
  { const e = entryOf(censusAt(), toHex(fromHex(sent[1]).reverse())); ask('an installer\'s bond: three transactions through the mempool, counted by its presig', !!e && !!e.presigBy && e.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3, `${built.fees.funding + built.fees.bond + built.fees.presig} sat in fees`); }

  // PATH A OF A TEMPLATE-3 BOND
  const m1 = own.outputs.find((o) => o.txid === first[S].txid).maturity, addr = cli('getnewaddress');
  const early = await door('bond-withdraw', { txid: first[S].txid, vout: 0, address: addr, feeRate: 2 });
  ask('path A before maturity is refused by name', early.status === 409 && /locked until block/.test(early.why), early.why.slice(0, 60));
  rt.mine(Math.max(0, m1 - rt.height()));
  const out1 = await door('bond-withdraw', { txid: first[S].txid, vout: 0, address: addr, feeRate: 2 });
  ask('from maturity the owner takes that output back', out1.ok === true, out1.why || out1.txid);
  rt.mine(1);
  ask('it left the census, the other output counts on', !entryOf(censusAt(), bondTx(first[S])) && !!entryOf(censusAt(), addedTx));

  // A START, signed here by shares combined in this harness, and the node's own reading of it
  const c = censusAt(), e = entryOf(c, addedTx);
  const update = rt.blocksFrom(e.presigBy.height, e.presigBy.height).blocks[0].transactions.find((t) => toHex(parseTransaction(t).txid) === toHex(e.presigBy.txid));
  const presig = readAdvertUpdate(update, { network: 'regtest' }).advert.slashPresig;
  const own2 = bondPresigDigest({ bond: { txid: e.txid, vout: e.vout, value: BigInt(e.bondSats), script: e.script }, advert: { ...e.advert, nodePubkey: e.pubkey, censusKey: key0 }, networkId: NETWORK_ID_REGTEST, tweakPoint });
  const payer = schnorr.utils.randomSecretKey(), feeLeaf = Uint8Array.from([0x20, ...schnorr.getPublicKey(payer), 0xac]);
  const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, tapLeafHash(feeLeaf)));
  const feeScript = fromHex(`5120${toHex(q.outputKey)}`), fee = rt.fund(feeScript, '0.001');
  rt.mine(1);
  const clocks = holdClocksOf(NETWORK_ID_REGTEST);
  const tx = { version: 2, locktime: 0, inputs: [{ txid: e.txid, vout: e.vout, sequence: SLASH_START_SEQUENCE }, { txid: fromHex(fee.txid).reverse(), vout: fee.vout, sequence: SLASH_START_SEQUENCE }],
    outputs: [{ value: BigInt(e.bondSats), script: own2.hold.script }, arbitrationCommitment(taggedHash('ARENA/v1/SlashProof', new Uint8Array(32).fill(7)), rt.height(), new Uint8Array(0)), { value: fee.value - 5000n, script: rt.payTo() }] };
  const prevouts = [{ value: BigInt(e.bondSats), script: e.script }, { value: fee.value, script: feeScript }];
  const leaf = slashStartLeaf(e.pubkey, key0), leafHash = tapLeafHash(leaf);
  const start = cli('sendrawtransaction', toHex(serializeSpend({ ...tx, witnesses: [
    scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 0, leafHash }), censusSecret), presig], script: leaf, controlBlock: controlBlockFor('slash', keyTree()).controlBlock }),
    scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 1, leafHash: tapLeafHash(feeLeaf) }), payer)], script: feeLeaf, controlBlock: Uint8Array.from([TAPLEAF_VERSION | q.parity, ...HOLD_INTERNAL_KEY]) }),
  ] })));
  const startHeight = rt.height() + 1;
  rt.mine(1);
  ask('a real start, the bond\'s own presig and the census key', JSON.parse(cli('getrawtransaction', start, '1')).confirmations === 1, `${JSON.parse(cli('getrawtransaction', start, '1')).vsize} vB`);
  ask('its hold output stays the bond in the census', !!entryOf(censusAt(), addedTx) && !!entryOf(censusAt(), addedTx).hold);
  const read = await until('the owner page reads the start', async () => { const b = await (await fetch(`${base}/owner/bond`)).json(); return b.started ? b : null; });
  const h = read.started[0], opens = Math.max(startHeight + clocks.returnBlocks - 1, e.advert.bondMaturityHeight);
  ask('the node reads its started bond: the hold is its own, each way out with its height', h.known === true && h.startTxid === start && h.startHeight === startHeight && h.returnOpensAt === opens && h.fallbackOpensAt === startHeight + clocks.fallbackBlocks - 1, `return at ${h.returnOpensAt}, fallback at ${h.fallbackOpensAt}`);
  const st = await (await fetch(`${base}/owner/standing`)).json();
  ask('the owner is told', st.warnings.some((x) => x.kind === 'slash started' && x.urgent), (st.warnings.find((x) => x.kind === 'slash started') || {}).says || '');
  const closed = await door('bond-withdraw', { txid: read.outputs[0].txid, vout: read.outputs[0].vout, address: addr, feeRate: 2 });
  ask('the return is refused before it opens, by name', closed.status === 409 && /the return opens at block/.test(closed.why), closed.why || '');
  rt.mine(opens - rt.height());
  const back = await door('bond-withdraw', { txid: read.outputs[0].txid, vout: read.outputs[0].vout, address: addr, feeRate: 2 });
  ask('at its clock the owner\'s return goes out', back.ok === true && back.returned === true, back.why || back.txid);
  rt.mine(1);
  ask('mined, and the hold output is gone from the census', JSON.parse(cli('getrawtransaction', back.txid, '1')).confirmations === 1 && !entryOf(censusAt(), addedTx), `${JSON.parse(cli('getrawtransaction', back.txid, '1')).vsize} vB`);

  function keyTree() { return rt.keyOfAdvert({ ...e.advert, nodePubkey: e.pubkey }, e.advert.bondMaturityHeight); }
} catch (err) { wrong += 1; console.error(`#972 stopped: ${err.stack}`); console.error(`#972 logs in ${dir}`); env.BN_KEEP = '1'; }
await stopAll();
console.log(wrong ? `#972 ${wrong} wrong` : '#972 all as expected');
process.exit(wrong ? 1 : 0);
