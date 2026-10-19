// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE MIGRATION, REHEARSED ON A REGTEST FEDERATION (2026-10-08): what the testnet4 cutover will
// do, end to end, before anything of it touches testnet4. Driven by rehearse209-regtest.sh after the patched fork's
// federation is up (federation-hold-probe's setup: 4 guardians, 3 of 4, two gateways); the arena paid round runs after it
// (fee-split-regtest.mjs, the same federation). Every step prints one JSON line; nothing here is testnet4.
//
//   1. THE BLWP PLAYER: a seed's player wallet as the BLWP page made it - phase0's own walletSecretFor and its store
//      (blwp.walletdb.*), the page's lock client, a real deposit through gateway A.
//   2. THE BROWSER MOVES: the page's own first script (index.html arena-storage-move) over that browser's storage.
//   3. THE SWEEP, PICK (a): the page's own combineWallets (lifted from index.html), the Arena bundle as BLWPCLIENT, the real
//      lock client: the seed's BLWP-tag wallet is opened and its e-cash moved once into the seed's Arena wallet. A second
//      page sweeps nothing.
//   4. THE SEATS' BONDS: two bonds posted by phase0's own code (the BLWP marker, layout and id), then re-affirmed and
//      updated by this tree's builder; this tree's census reads the chain at each step. The bonds stay unspent, at their
//      funding height (no maturity restarted).
//   5. TWO PROCESSES ON ONE FEDERATION CLIENT DIRECTORY (step 5's question): the stake-lock tool run twice at once on the
//      seats' shared client directory, as a phase0 seat and an Arena seat of one operator would.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { regtest } from './regtest-bond.mjs';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { STAKE_EXPIRY_BLOCKS } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { pageFunction } from '../../arena-client/test/page-script.js';

const env = process.env;
const P = env.PROBE;
const HERE = dirname(fileURLToPath(import.meta.url));
const PHASE0 = env.PHASE0_TREE;
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)));
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 300000 }, (err, so, se) => done({ err: err ? String(err.message).split('\n')[0] : null, so: String(so), se: String(se) })));
const lncli = (who, rpc, ...a) => run(`${env.LND_BIN}/lncli`, [`--lnddir=${P}/${who}`, `--rpcserver=127.0.0.1:${rpc}`, '--network=regtest', ...a]);
const PAGE = join(HERE, '../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html');

// THE PAGE'S LOCK CLIENT, loaded in Node as the donor client loads it (fee-split-regtest's way)
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const esm = join(tmpdir(), `rehearse209-lock-client-${process.pid}.mjs`);
copyFileSync(join(env.WASM_WEB, 'blwp_lock_client.js'), esm);
const wasm = await import(esm);
await wasm.default({ module_or_path: readFileSync(join(env.WASM_WEB, 'blwp_lock_client_bg.wasm')) });
const { LockClient } = wasm;
const fidHex = LockClient.federationIdOf(env.INVITE);
const fid = fromHex(fidHex);

// A BROWSER: localStorage and sessionStorage as maps that enumerate as a browser's do
const storage = () => {
  const m = new Map();
  const s = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
  return new Proxy(s, { ownKeys: () => [...m.keys()], getOwnPropertyDescriptor: (t, k) => (m.has(k) ? { enumerable: true, configurable: true, value: m.get(k) } : Reflect.getOwnPropertyDescriptor(t, k)),
    get: (t, k) => (k in t ? t[k] : undefined) });
};
const L = storage(), S = storage();
const SEED = schnorr.utils.randomSecretKey();
const seedHex = toHex(SEED);

// ---- 1. THE BLWP PLAYER, BY PHASE0'S OWN PAGE CODE ----
const p0 = await import(`${PHASE0}/packages/blwp-client/src/page-lock.js`);
const oldSecret = p0.walletSecretFor(SEED, fid);
const oldWallet = await LockClient.join(env.INVITE, fidHex, toHex(oldSecret), p0.walletStoreFor(L, fid, oldSecret));
const DEPOSIT = BigInt(env.DEPOSIT_MSAT || 3_000_000);
const rcv = JSON.parse(await oldWallet.receive(String(DEPOSIT), env.GATEWAY));
const paid = (await lncli('alice', 30107, 'payinvoice', '--force', rcv.invoice)).so.match(/Payment status: [A-Z_]+/)?.[0] || '?';
const final = await oldWallet.awaitReceive(rcv.operation);
L.setItem('blwp.seeds', JSON.stringify([{ hex: seedHex, from: 'minted', at: Date.now() }]));
S.setItem('blwp.player.seed', seedHex);
const oldBalance = BigInt(await oldWallet.balanceMsat());
out({ step: '1. the BLWP player wallet (phase0 walletSecretFor, blwp.walletdb.*)', secret: toHex(oldSecret).slice(0, 16), deposit: DEPOSIT, alice: paid, final,
  balanceMsat: oldBalance, keys: [...L.m.keys()].filter((k) => k.startsWith('blwp.walletdb.')).length });

// ---- 2. THE PAGE'S FIRST SCRIPT MOVES THE BROWSER ----
const page = readFileSync(PAGE, 'utf8');
const move = /<script id="arena-storage-move">([\s\S]*?)<\/script>/.exec(page)[1];
vm.runInNewContext(move, { window: { localStorage: L, sessionStorage: S } });
out({ step: '2. the storage move', blwpLeft: [...L.m.keys(), ...S.m.keys()].filter((k) => k.startsWith('blwp.')).length,
  arenaWalletKeys: [...L.m.keys()].filter((k) => k.startsWith('arena.walletdb.')).length, seed: S.getItem('arena.player.seed') === seedHex });

// ---- 3. THE SWEEP, BY THE PAGE'S OWN combineWallets AND THE ARENA BUNDLE ----
const BLWPCLIENT = createRequire(import.meta.url)(join(HERE, '../../arena-client/dist/arena-client.js'));
const round = { custody: 'FEDERATION', stakeMsat: 100000n, federationId: fid, stakeExpiryBlocks: STAKE_EXPIRY_BLOCKS, publicationRelays: ['wss://r.example'] };
const main = await BLWPCLIENT.playerWallet({ round, invite: env.INVITE, seed: SEED, LockClient, storage: L });
const before = { arena: BigInt(await main.balanceMsat()), blwpEntries: BLWPCLIENT.phraseWalletEntries(L, seedHex, fidHex, { ancestor: true }) };
const at = page.indexOf('      let combining = null;\n      function combineWallets(main, named, round) {');
const end = page.indexOf('        return combining;\n      }\n', at);
const SRC = page.slice(at, end + '        return combining;\n      }\n'.length);
const logs = [];
const pageWindow = { BLWP_LOCK_WASM: async () => ({ default: async () => {}, LockClient }) };
const combineWallets = pageFunction(PAGE, ['vault', 'sessionStorage', 'BLWPCLIENT', 'window', 'navigator', 'paintMoney', 'console'],
  SRC, 'return combineWallets;')(() => L, S, BLWPCLIENT, pageWindow, {}, () => {}, { log: (s) => logs.push(String(s)) });
const t0 = Date.now();
await combineWallets(main, { federation: env.INVITE }, round);
const afterOld = await BLWPCLIENT.playerWallet({ round, invite: env.INVITE, seed: SEED, LockClient, storage: L, ancestor: true });
// THE RECEIVED E-CASH IS REISSUED BY THE FEDERATION: measured on the first run, the Arena balance read 0 at once after
// "Success" - so it is read until it moves, for up to 120 s, and the time it took is said
let arenaNow = BigInt(await main.balanceMsat()); const tr = Date.now();
while (arenaNow === before.arena && Date.now() - tr < 120000) { await new Promise((r) => setTimeout(r, 2000)); arenaNow = BigInt(await main.balanceMsat()); }
const after = { arena: arenaNow, blwp: BigInt(await afterOld.balanceMsat()), creditedAfterMs: Date.now() - tr };
out({ step: '3. the sweep (index.html combineWallets, pick (a))', ms: Date.now() - t0, before, after, moved: after.arena - before.arena,
  lost: oldBalance - (after.arena - before.arena) - after.blwp, pageSaid: logs.filter((l) => /combined|not combined/.test(l)) });
await combineWallets(main, { federation: env.INVITE }, round);
out({ step: '3b. a second page', arena: BigInt(await main.balanceMsat()), saidAgain: logs.filter((l) => /combined/.test(l)).length,
  pendingLeft: [...L.m.keys()].filter((k) => k.startsWith('arena.ecash.pending.')).length });

// ---- 4. THE SEATS' BONDS: POSTED BY PHASE0, CARRIED BY THIS TREE ----
const bare = (...a) => execFileSync(`${env.BITCOIN_BIN}/bitcoin-cli`, [`-datadir=${P}/btc`, '-regtest', '-rpcport=30101', '-rpcuser=blwp', '-rpcpassword=blwp', ...a], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
// THIS RUN'S OWN WALLET, NAMED ON EVERY CALL: the probe's bitcoind has its own loaded (measured: "Multiple wallets are loaded")
if (!JSON.parse(bare('listwallets')).includes('rehearse209')) { try { bare('loadwallet', 'rehearse209'); } catch { bare('createwallet', 'rehearse209'); } }
const cli = (...a) => bare('-rpcwallet=rehearse209', ...a);
const { regtest: phase0Regtest } = await import(`${PHASE0}/packages/blwp-node/tools/regtest-bond.mjs`);
const old = phase0Regtest(cli, { wallet: 'rehearse209' });
const arena = regtest(cli, { wallet: 'rehearse209' });
arena.mine(101);
const big = (b) => BigInt('0x' + toHex(b));
const g = genesisFor('regtest');
const BOND = { arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: g.bondMaturity,
  tweakPoint: (Pt, t) => { const Q = schnorr.utils.lift_x(big(Pt)).add(secp256k1.Point.BASE.multiply(big(t))); return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) }; },
  combine: (terms) => { let s = null; for (const { key, coefficient } of terms) { const p = schnorr.utils.lift_x(big(key)).multiply(big(coefficient)); s = s === null ? p : s.add(p); } return schnorr.utils.pointToBytes(s); } };
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const resolve = (e) => ({ transaction: fromHex(cli('getrawtransaction', toHex([...e.txid].reverse()))) });
const census = (from) => {
  const tip = arena.height();
  const contract = { bondMinSats: 1000000n, protocolVersion: 1, networkId: NETWORK_ID_REGTEST, censusHeight: tip, censusConfirmations: 1, gameId: NEXTBLOCK_GAME_ID };
  const o = deriveCensus(arena.blocksFrom(from, tip), { contract, resolve, bond: BOND, verifyUpdate: verify });
  return { at: tip, ok: o.ok, why: o.why, counted: (o.entries || []).map((e) => ({ endpoint: e.advert.endpoint, height: e.height, reaffirmedAt: e.reaffirmedBy && e.reaffirmedBy.height,
    updatedAt: e.updatedBy && e.updatedBy.height, hosts: (e.hostedGames || []).length })), excluded: (o.excluded || []).map((e) => e.step + ': ' + e.why) };
};
const seats = [1, 2].map((n) => ({ n, secret: schnorr.utils.randomSecretKey() }));
const from = arena.height();
for (const s of seats) { s.posted = old.postBond(s.secret, { endpoint: `wss://seat-${s.n}.example/`, bondSats: 2000000n }); cli('sendrawtransaction', s.posted.hex); }
arena.mine(2);
const fundedAt = arena.height() - 1;
const unspent = () => seats.map((s) => { const o = cli('gettxout', s.posted.txid, '0'); return o ? JSON.parse(o).value : null; });
out({ step: '4a. two bonds posted by phase0 code', txids: seats.map((s) => s.posted.txid.slice(0, 16)), fundedAt, unspentBtc: unspent(), census: census(from) });
for (const s of seats) {
  s.bond = arena.bondsOf(s.secret)[0];
  const r = arena.postReaffirmation(arena.prepareReaffirmation(s.secret, s.bond, { networkId: NETWORK_ID_REGTEST }));
  cli('sendrawtransaction', r.hex);
}
arena.mine(1);
out({ step: '4b. re-affirmed by this tree', ancestors: seats.map((s) => !!s.bond.ancestor), census: census(from) });
for (const s of seats) {
  const u = arena.postAdvertUpdate(arena.prepareAdvertUpdate(s.secret, { ...s.bond.advert, hostedGames: [NEXTBLOCK_GAME_ID], timestamp: BigInt(Date.now()) }), s.bond);
  cli('sendrawtransaction', u.hex);
}
arena.mine(1);
const c = census(from);
out({ step: '4c. advertisements updated (hosted_games nextblock)', census: c, unspentBtc: unspent(),
  heightsKept: c.counted.every((e) => e.height === fundedAt) });

// ---- 5. TWO PROCESSES ON ONE FEDERATION CLIENT DIRECTORY ----
const LOCK = env.LOCK_BIN, DIR = `${P}/client`;
const both = await Promise.all([run(LOCK, ['--mode', 'fees', '--data-dir', DIR]), run(LOCK, ['--mode', 'fees', '--data-dir', DIR])]);
const sameTime = await Promise.all([run(LOCK, ['--mode', 'guardians', '--data-dir', DIR]), run(LOCK, ['--mode', 'gateways', '--data-dir', DIR])]);
out({ step: '5. two stake-lock processes at once on one client directory', fees: both.map((r) => r.err || 'ok'),
  guardiansAndGateways: sameTime.map((r) => r.err || 'ok'), errors: [...both, ...sameTime].map((r) => (r.se || '').split('\n').find((l) => /lock|database|busy/i.test(l)) || null) });
out({ step: 'done' });
// the open wallets keep the loop alive (measured: the launcher waited on this process after 'done')
process.exit(0);
