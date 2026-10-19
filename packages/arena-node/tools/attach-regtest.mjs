#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ATTACH MODE, PROVED ON REGTEST BEFORE ANY LIVE MOVE (2026-09-29: "Prove that on regtest with seven separate
// node processes. No shared store. No port clash."). A private regtest (RT, RPCPORT), never testnet4, never a bond there.
//
//   1. seven stores; each node's key read ONCE from its store to post its regtest bond (setup - the harness is the
//      operator here), every store then closed before any node starts
//   2. seven node processes, `node src/main.js <port> <store>`, one each, as a blwp-tn4-node unit runs one
//   3. standUpRound in attach mode (the runner's ARENA_ATTACH=1 path): starts no node, opens no store, keys from
//      GET /identity, bonds from the chain, the round published and POSTed over HTTP; its keeper opens the next
//   4. measured: the seven pids alive start to end; each round held by all seven; each node's own log saying it holds
//      each round's claim key (made with its peers over their doors - there is no other way between processes); each
//      store open in exactly one process, its own; seven distinct listening ports; the runner's process holding no store
//
//   RT=<datadir> RPCPORT=<port> node tools/attach-regtest.mjs            (from packages/arena-node)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readlinkSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, nodeIdentity } from '../src/store.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { regtest } from './regtest-bond.mjs';
import { standUpRound } from './round-2of2.mjs';
import { decodeClaimKeyAttestation } from '../../arena-protocol/src/claim-key.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { feldmanGroup } from '../src/curve.js';
import { randomBytes } from 'node:crypto';

const env = process.env;
const RT = env.RT, RPCPORT = env.RPCPORT || '30601';
if (!RT) throw new Error('RT=<a private regtest datadir>');
const out = (o) => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 19), ...o }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (...a) => execFileSync('/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli', ['-regtest', `-datadir=${RT}`, `-rpcport=${RPCPORT}`,
  '-rpcwallet=arena', ...a], { encoding: 'utf8' }).trim();
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${RPCPORT}/wallet/arena`, cookiePath: `${RT}/regtest/.cookie` });
const ports = [41221, 41231, 41241, 41251, 41261, 41271, 41281];   // clear of the testnet4 nodes (31221+) and their guardians (+1000, +2000)
const dir = mkdtempSync(join(env.ATTACH_DIR || '/mnt/bitcoin', 'attach-regtest-'));
const stores = ports.map((_, i) => join(dir, `node-${i + 1}.db`));

// ---- 1. keys and bonds (setup)
const rt = regtest((...a) => execFileSync('/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli', ['-regtest', `-datadir=${RT}`, `-rpcport=${RPCPORT}`,
  ...(a[0] === 'listwallets' || a[0] === 'loadwallet' || a[0] === 'createwallet' ? [] : ['-rpcwallet=arena']), ...a], { encoding: 'utf8' }).trim());
if (rt.height() < 110) rt.mine(110 - rt.height());
const posted = [];
for (const [i, path] of stores.entries()) {
  const db = openStore(path);
  const id = nodeIdentity(db);
  posted.push(rt.postBond(id.secret, { endpoint: `ws://127.0.0.1:${ports[i]}` }));
  db.close();
}
// EXTRA_BONDS=1 (2026-09-30, one key one seat): the testnet4 census shape - extra bond rows under some node keys
// (nodes 2, 4 and 7, two more each), every one a real bond of that node's key on this chain.
const extra = [];
if (env.EXTRA_BONDS === '1')
  for (const i of [1, 3, 6]) {
    const db = openStore(stores[i]); const id = nodeIdentity(db); db.close();
    for (let n = 0; n < 2; n++) extra.push({ node: i + 1, ...rt.postBond(id.secret, { endpoint: `ws://127.0.0.1:${ports[i]}` }) });
  }
rt.include([...posted, ...extra].map((p) => p.hex));
rt.mine(1);
out({ step: 'bonds', posted: posted.length, extraRows: extra.map((x) => x.node), height: rt.height() });

// ---- 2. seven node processes
const logs = stores.map((s) => `${s}.log`);
const kids = ports.map((port, i) => spawn(process.execPath, ['src/main.js', String(port), stores[i]], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...env, ARENA_BITCOIND_URL: `http://127.0.0.1:${RPCPORT}`, ARENA_BITCOIND_COOKIE: `${RT}/regtest/.cookie`, ARENA_CLOSE_AT_END: '1', ARENA_FUND_FREE_ROUNDS: '1',
    ARENA_DONATION_NETWORK: 'regtest', ARENA_ATTACH_PROOF_DIR: join(dir, 'proof'), ARENA_FUNDED_ROUNDS_FILE: join(dir, 'funded.txt'),
    // the games its nodes host (main.js names none): nextblock
    ARENA_GAMES: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname },
  stdio: ['ignore', 'pipe', 'pipe'] }));
const text = stores.map(() => '');
kids.forEach((k, i) => { for (const s of [k.stdout, k.stderr]) s.on('data', (d) => { text[i] += d; }); });
for (let t = 0; t < 60; t++) {
  const up = await Promise.all(ports.map((p) => fetch(`http://127.0.0.1:${p}/identity`).then((r) => r.ok, () => false)));
  if (up.every(Boolean)) break;
  await wait(1000);
}
const pids = kids.map((k) => k.pid);
out({ step: 'nodes up', pids, ports });

// ---- 3. the runner, attached
const round = await standUpRound({ host: '127.0.0.1', portA: ports[0], portB: ports[1], extraPorts: ports.slice(2),
  store: join(dir, 'runner'), network: 'regtest', wallet: 'arena', cli, rpc, entryWindowMs: 120000n,
  signerNode: { closeAtEnd: true }, attach: { fundedFile: join(dir, 'funded.txt'), proofDir: join(dir, 'proof') } });
out({ step: 'attached', firstRound: round.id.slice(0, 16), nodes: round.contract.nodes.length, daemonsStartedHere: round.daemons.filter((d) => !d.attached).length });
const opened = [round.id];
round.keepOpen({ everyMs: 3000, leadMs: 90000, onOpen: (id) => { opened.push(id); out({ step: 'keeper opened', round: id.slice(0, 16) }); },
  onError: (e) => out({ step: 'keeper error', why: e.message.slice(0, 200) }) });

// ---- 4. measure
const alive = () => pids.map((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
const heldBy = async (rid) => (await Promise.all(ports.map(async (p) => {
  try { return ((await (await fetch(`http://127.0.0.1:${p}/rounds`)).json()).rounds || []).some((r) => r.id === rid); } catch { return false; }
}))).filter(Boolean).length;
// A ROUND'S CLAIM KEY, ASKED OF EACH NODE: the key is the committee's (dkg.signerNodeFor(nodes)), made once for these seven
// by the first round and answered for every round after it - so "made" is logged once and "held" is asked per round
const keysOf = async (rid) => Promise.all(ports.map(async (p) => {
  try { const r = await fetch(`http://127.0.0.1:${p}/claim-key?round=${rid}`); if (!r.ok) return null; const b = new Uint8Array(await r.arrayBuffer()); return Buffer.from(decodeClaimKeyAttestation(b.subarray(0, b.length - 64)).claimPk).toString('hex'); }
  catch { return null; }
}));
const keyAt = async (rid) => { const k = await keysOf(rid); return k.every((x) => x && x === k[0]) ? k.length : k.filter(Boolean).length === 7 ? -1 : k.filter(Boolean).length; };
const stop = Date.now() + Number(env.ATTACH_MS || 240000);
const allKeyed = async () => { for (const r of opened) if ((await keyAt(r)) !== 7) return false; return true; };
while (Date.now() < stop && (opened.length < 3 || !(await allKeyed()))) await wait(3000);
const rounds = [];
for (const rid of opened) rounds.push({ round: rid.slice(0, 16), heldBy: await heldBy(rid), claimKeyAt: await keyAt(rid),
  claimKeyMade: text.filter((t) => t.includes(`[claim-key] ${rid.slice(0, 16)}: this signer node holds`)).length });
// ONE KEY, ONE SEAT, AND THE STAKE'S HANDOUT DEALT TO THAT COMMITTEE (as the page deals it: to the round's drawn
// settlement signer nodes, needed = receiptsNeeded(7)) - posted to all seven; each answer counted.
const seats = [];
for (const rid of opened) {
  const row = ((await (await fetch(`http://127.0.0.1:${ports[0]}/rounds`)).json()).rounds || []).find((r) => r.id === rid);
  const c = row && row.committee;
  if (!c || !c.drawn) { seats.push({ round: rid.slice(0, 16), drawn: false, why: c && c.why }); continue; }
  const signerNodes = c.settlement.map((k) => Uint8Array.from(Buffer.from(k, 'hex')));
  const needed = receiptsNeeded(signerNodes.length);
  const e = new Uint8Array(randomBytes(32));
  const dealt = await dealHandout({ preimage: new Uint8Array(randomBytes(32)), signerNodes, roundId: Uint8Array.from(Buffer.from(rid, 'hex')),
    playerPubkey: new Uint8Array(randomBytes(32)), ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(new Uint8Array(randomBytes(32))) % FIELD), needed, curve: feldmanGroup });
  const took = dealt.ok ? await Promise.all(ports.map(async (p) => { const r = await fetch(`http://127.0.0.1:${p}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) }); return r.status === 201 ? 201 : `${r.status} ${(await r.text()).slice(0, 80)}`; })) : [];
  seats.push({ round: rid.slice(0, 16), eligibleEntries: c.eligibleEntries, eligibleKeys: c.eligibleKeys,
    game: { seats: c.game.length, distinct: new Set(c.game).size }, settlement: { seats: c.settlement.length, distinct: new Set(c.settlement).size },
    handout: dealt.ok ? { dealtTo: signerNodes.length, needed, took: took.filter((x) => x === 201).length, answers: [...new Set(took.map(String))] } : { dealt: false, why: dealt.why } });
}
out({ step: 'one key one seat', seats });
// WHO HOLDS EACH STORE OPEN: /proc/<pid>/fd, every process of this user, this harness included
const holders = stores.map((s) => {
  const who = [];
  for (const pid of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try { if (readdirSync(`/proc/${pid}/fd`).some((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === s; } catch { return false; } })) who.push(Number(pid)); }
    catch { /* not ours */ }
  }
  return who;
});
const listening = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8' }).split('\n')
  .filter((l) => ports.some((p) => l.includes(`127.0.0.1:${p} `)));
out({ step: 'measured', alive: alive(), rounds, funded: existsSync(join(dir, 'funded.txt')) ? readFileSync(join(dir, 'funded.txt'), 'utf8').trim().split('\n').map((x) => x.slice(0, 16)) : [],
  storeHolders: holders, eachStoreItsOwnProcessOnly: holders.every((h, i) => h.length === 1 && h[0] === pids[i]),
  runnerHoldsAStore: holders.some((h) => h.includes(process.pid)), listeningPorts: listening.length,
  proof: { headers: existsSync(join(dir, 'proof', 'headers.bin')), bond: (await fetch(`http://127.0.0.1:${ports[0]}/bond`)).status } });
round.keepOpen().stop();
for (const [i, t] of text.entries()) writeFileSync(logs[i], t);
for (const k of kids) k.kill('SIGTERM');
await wait(3000);
out({ step: 'stopped', dir });
process.exit(0);
