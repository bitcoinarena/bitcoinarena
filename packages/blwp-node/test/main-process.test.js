// A NODE STARTED FROM ITS ENV AND A SERIES FILE, AS THE UNITS START IT (kanban #149 step 4, plan comment 249, Go 2026-10-05).
// `node src/main.js 0 <store>` runs as a child process on port 0 (the bound port read from its first line), with
// BLWP_SERIES_FILE, BLWP_ATTACH_PROOF_DIR and BLWP_DONATION_NETWORK=regtest; the chain half gives it a fake bitcoind (JSON-RPC
// with a cookie file) serving a short mined chain that holds the node's bond and the round's publication.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, nodeIdentity } from '../src/store.js';
import { contractFor, b32 } from './window-fixture.js';
import { RUN_82_TICKS } from '../tools/round-2of2.mjs';
import { encodeRoundContract } from '../../protocol/src/contracts.js';
import { seriesTemplate, seriesIndexAt, seriesId } from '../../protocol/src/series.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex } from '../../protocol/src/hash.js';
import { createServer } from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { presentDay } from './window-fixture.js';
import { bondFor } from './curve.js';
import { bondSetFor } from '../src/curve.js';
import { roundId, decodeRoundContract } from '../../protocol/src/contracts.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { serializeSpend } from '../../protocol/src/bond-spend.js';
import { blockHashOf } from '../../protocol/src/chain.js';
import { medianTimePast, beaconFromChain } from '../../protocol/src/beacon.js';
import { deriveCensus } from '../../protocol/src/census.js';
import { bondTransaction } from '../../protocol/tools/bond.js';
import { chainOf, publicationOf } from '../../protocol/tools/chainview.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const NEXTBLOCK_REGISTRATION = new URL('../../nextblock/plugin/nextblock.js', import.meta.url).pathname;

const MAIN = new URL('../src/main.js', import.meta.url).pathname;
const CWD = new URL('..', import.meta.url).pathname;

// A node process: resolves once it prints its address, with the port it bound
function startMain(store, env, { args } = {}) {
  const child = spawn(process.execPath, [MAIN, ...(args || ['0', store])], { cwd: CWD, env: { ...process.env, BLWP_BITCOIND_URL: '', BLWP_BITCOIND_COOKIE: '',
    BLWP_STAKE_LOCK_BIN: '', BLWP_FEDERATION_CLIENT_DIR: '',
    // AS THE UNITS WILL RUN IT (kanban #203): main.js names no game, the launcher names nextblock in BLWP_GAMES
    BLWP_GAMES: NEXTBLOCK_REGISTRATION, PATH: process.env.PATH.split(':').filter((d) => !/fedimint|patched/.test(d)).join(':'), ...env },
  stdio: ['ignore', 'pipe', 'pipe'] });
  child.out = ''; child.err = '';
  child.stdout.on('data', (d) => { child.out += d; });
  child.stderr.on('data', (d) => { child.err += d; });
  child.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  child.up = new Promise((resolve, reject) => {
    const look = setInterval(() => {
      const m = /blwp-node on http:\/\/[^:]+:(\d+)/.exec(child.out);
      if (m) { clearInterval(look); resolve(Number(m[1])); }
    }, 50);
    child.exited.then((e) => { clearInterval(look); reject(new Error(`main.js exited ${e.code}: ${child.err.trim().split('\n').slice(-2).join(' | ')}`)); });
  });
  child.up.catch(() => {});      // a refusal test awaits `exited`, not `up`
  return child;
}
const nodeKeyOf = (store) => { const db = openStore(store); const { pubkey } = nodeIdentity(db); db.close?.(); return pubkey; };
// the series running now and the next day's, both naming this node, with the 82 s run every 90 s series takes
function templates(nodeKey) {
  const base = { ...contractFor([nodeKey, b32(0x33)], 3000n, ['wss://r.example']), stakeMsat: 0n, blockTicks: RUN_82_TICKS, censusHeight: 900000 };
  const k = seriesIndexAt(NETWORK_ID_REGTEST, Date.now()) - 1;
  return [seriesTemplate(base, k), seriesTemplate(base, k + 1), seriesTemplate(base, k + 2)];
}
const line = (t, more = '') => `${toHex(encodeRoundContract(t))}${more ? ` ${more}` : ''}\n`;
const get = async (port, path) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };

// THE SERIES FILE IS LOOKED AT ONCE A MINUTE (server.js seriesEveryMs, 60 s; main.js sets no other): two nodes run side by
// side so that one minute shows both - an appended series taken, an unreadable file leaving the held series standing.
async function seriesFile() {
  const dir = mkdtempSync(join(tmpdir(), 'main-process-'));
  const store = join(dir, 'node.db'), store2 = join(dir, 'node2.db');
  const [a, b, c] = templates(nodeKeyOf(store));
  const [a2, b2] = templates(nodeKeyOf(store2));
  const file = join(dir, 'series.txt'), file2 = join(dir, 'series2.txt');
  const CUT = 5;
  writeFileSync(file, `# the series this node holds\n${line(a, 'count=960')}${line(b, `cut=${CUT}`)}`);
  writeFileSync(file2, `${line(a2)}${line(b2)}`);
  const proofs = join(dir, 'proofs');
  const env = { BLWP_DONATION_NETWORK: 'regtest', BLWP_FUND_FREE_ROUNDS: '1' };
  const child = startMain(store, { ...env, BLWP_SERIES_FILE: file, BLWP_ATTACH_PROOF_DIR: proofs });
  const other = startMain(store2, { ...env, BLWP_SERIES_FILE: file2 });
  try {
    const [port, port2] = await Promise.all([child.up, other.up]);
    const s = await get(port, '/series');
    assert.equal(s.status, 200);
    const listed = new Map(s.body.series.map((x) => [x.series, x]));
    assert.deepEqual([...listed.keys()].sort(), [toHex(seriesId({ ...a, seriesCount: 960 })), toHex(seriesId(b))].sort(), 'both series, by their ids');
    const cut = listed.get(toHex(seriesId(b)));
    assert.ok(cut.written <= CUT && (!cut.last || cut.last.index < CUT), `the cut series writes no round from index ${CUT}: ${JSON.stringify(cut)}`);
    assert.equal((await get(port2, '/series')).body.series.length, 2);
    // the reload, one minute for both: a line appended to one file, an unreadable line to the other
    appendFileSync(file, line(c));
    appendFileSync(file2, line(a2, 'count=x'));
    let now = null;
    for (let i = 0; i < 300 && !now; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const again = await get(port, '/series');
      if (again.body.series.some((x) => x.series === toHex(seriesId(c)))) now = again.body.series;
    }
    assert.ok(now, 'the appended series is served without a restart');
    assert.equal(now.length, 3);
    assert.match(child.out, /\[series\] [0-9a-f]{16}: taken from the series file without a restart/);
    for (let i = 0; i < 40 && !/the series file did not read/.test(other.err); i++) await new Promise((r) => setTimeout(r, 250));
    assert.match(other.err, /\[series\] the series file did not read: a series line names count=x, not count=N or cut=N - the series held stay/);
    assert.equal((await get(port2, '/series')).body.series.length, 2, 'an unreadable file: the series held stay');
    // the launcher's proofs: absent at start, served once written, read again at every ask
    assert.equal((await get(port, '/headers')).status, 404);
    assert.equal((await get(port, '/bond')).status, 404);
    mkdirSync(proofs);
    writeFileSync(join(proofs, 'headers.bin'), Buffer.alloc(80, 7));
    writeFileSync(join(proofs, 'bond.json'), JSON.stringify({ txid: 'ab'.repeat(32), height: 101 }));
    const h = await fetch(`http://127.0.0.1:${port}/headers`);
    assert.equal(h.status, 200);
    assert.deepEqual(Buffer.from(await h.arrayBuffer()), Buffer.alloc(80, 7));
    assert.deepEqual((await get(port, '/bond')).body, { txid: 'ab'.repeat(32), height: 101 });
    writeFileSync(join(proofs, 'bond.json'), JSON.stringify({ txid: 'cd'.repeat(32), height: 102 }));
    assert.deepEqual((await get(port, '/bond')).body, { txid: 'cd'.repeat(32), height: 102 }, 'read again at the next ask');
    child.kill('SIGTERM');
    const e = await child.exited;
    assert.deepEqual([e.code, e.signal], [0, null], 'SIGTERM: exit 0');
    assert.ok(existsSync(store), 'the store stays');
  } finally { child.kill('SIGKILL'); other.kill('SIGKILL'); }
}

async function refusals() {
  const dir = mkdtempSync(join(tmpdir(), 'main-process-'));
  const store = join(dir, 'node.db');
  const [a] = templates(nodeKeyOf(store));
  const cases = [
    ['a line that is not a series', `${'ab'.repeat(40)}\n`, {}, /^BLWP_SERIES_FILE: a line is not a series: /],
    ['count=x', line(a, 'count=x'), {}, /^BLWP_SERIES_FILE: a line is not a series: a series line names count=x, not count=N or cut=N$/],
    ['a donation network of mainnet', line(a), { BLWP_DONATION_NETWORK: 'mainnet' }, /^BLWP_DONATION_NETWORK is regtest or testnet4, not mainnet$/],
  ];
  for (const [name, text, env, why] of cases) {
    const file = join(dir, `${name.replace(/\W+/g, '-')}.txt`);
    writeFileSync(file, text);
    const child = startMain(store, { BLWP_SERIES_FILE: file, BLWP_DONATION_NETWORK: 'regtest', ...env });
    const e = await child.exited;
    assert.equal(e.code, 2, `${name}: exit 2`);
    assert.match(child.err.trim().split('\n').pop(), why, name);
    assert.doesNotMatch(child.out, /blwp-node on http/, `${name}: never bound`);
  }
}

// ---- THE CHAIN HALF: a fake bitcoind serving a mined chain of 61 blocks - the round's two bonds at 20, its publication at 21,
// its census at 40 (so the node's 2016-block lookback starts at 0), its beacon at 36 (the first block whose median time
// passes committee time: blocks 0..30 at the committee second, one second a block after) - and every call logged.
function blockBytes(b) {
  const n = b.transactions.length;
  return Buffer.concat([Buffer.from(b.header), Buffer.from([n]), ...b.transactions.map((t) => Buffer.from(t))]);
}
// `fake.serve(view)` swaps the chain it serves (growth, a reorg); `fake.failBlocks = true` fails every getblock,
// `fake.failHeaders = true` every getblockheader; a failed call is logged with `failed: true`
async function fakeBitcoind(view, cookie) {
  const calls = [];
  const display = (header) => toHex(Uint8Array.from(blockHashOf(header)).reverse());
  let byHash, tip;
  const fake = {};
  fake.serve = (v) => {
    view = v; tip = v.firstHeight + v.blocks.length - 1;
    byHash = byHash || new Map();
    v.blocks.forEach((b, h) => byHash.set(display(b.header), { b, h }));   // blocks of an older branch stay readable by hash
  };
  fake.serve(view);
  fake.failBlocks = false;
  fake.failHeaders = false;
  const srv = createServer((req, res) => { let body = ''; req.on('data', (d) => { body += d; }).on('end', () => {
    const authed = req.headers.authorization === `Basic ${Buffer.from(cookie).toString('base64')}`;
    const { id, method, params = [] } = JSON.parse(body);
    calls.push({ method, params, authed, atMs: Date.now() });
    if (!authed) { res.writeHead(401); return res.end(); }
    if ((method === 'getblock' && fake.failBlocks) || (method === 'getblockheader' && fake.failHeaders)) {
      calls[calls.length - 1].failed = true;
      return res.end(JSON.stringify({ id, result: null, error: { code: -1, message: `the fake fails ${method === 'getblock' ? 'block' : 'header'} reads` } }));
    }
    const at = (hash) => byHash.get(String(hash));
    const result = {
      getblockchaininfo: () => ({ chain: 'regtest', blocks: tip, headers: tip }),
      getblockcount: () => tip,
      getblockhash: () => display(view.blocks[params[0] - view.firstHeight].header),
      getblock: () => blockBytes(at(params[0]).b).toString('hex'),
      getblockheader: () => (params[1] === false ? toHex(at(params[0]).b.header)
        : { hash: params[0], height: at(params[0]).h, mediantime: medianTimePast(view.blocks.map((x) => x.header), 0, at(params[0]).h) }),
    }[method];
    res.end(JSON.stringify(result ? { id, error: null, result: result() } : { id, result: null, error: { code: -32601, message: `no ${method}` } }));
  }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return Object.assign(fake, { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => srv.close(r)) });
}

// THE ROUND AND ITS CHAIN: the node's key and a second one, each bonded at 20; the round's publication at 21; census 40.
// `build({ length, branchFrom })` mines `length` blocks - from `branchFrom` on, another branch (other coinbases, so other
// headers) - blocks 0..30 at the committee second and one second a block after, so the beacon is block 36 on either branch.
// `committeePast`: the round's committee time 20 s ago - a round posted ahead of its beacon, which the node's sweep assigns
// only once committee time has passed (server.js: assign posted rounds, every 5 s)
function chainFixture(prefix, { committeePast = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = join(dir, 'node.db');
  const keys = [nodeKeyOf(store), schnorr.getPublicKey(b32(0x44))];
  const CENSUS = 40;
  const ahead = presentDay({ ...contractFor(keys, 3000n, ['wss://r.example']), stakeMsat: 0n, censusHeight: CENSUS }, Date.now() + 600000);
  const shift = committeePast ? BigInt(Date.now() - 20000) - ahead.committeeTimeMs : 0n;
  const drafted = { ...ahead, committeeTimeMs: ahead.committeeTimeMs + shift, startTimeMs: ahead.startTimeMs + shift, entryCloseMs: ahead.entryCloseMs + shift };
  const committeeSec = Math.floor(Number(drafted.committeeTimeMs) / 1000);
  const bonds = keys.map((key, i) => bondTransaction({
    nodePubkey: key, operatorId: `operator${i}`, protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint: `ws://node${i}`,
    region: 'eu-west', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
    bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
  }, { previousTxid: b32(0xa0 + i), previousVout: 0, outputKey: bondFor(key) }));
  // every block opens with a coinbase-shaped transaction (the node reads no block without one); its value carries the height
  // and the branch, so another branch is other transactions and other headers
  const coinbase = (h, branch) => serializeSpend({ inputs: [{ txid: new Uint8Array(32), vout: 0xffffffff, sequence: 0xffffffff, script: Uint8Array.from([2, h, branch]) }],
    outputs: [{ value: 5000000000n + BigInt(h) + 1000000n * BigInt(branch), script: Uint8Array.from([0x51]) }], witnesses: [[new Uint8Array(32)]] });
  const build = (contract, { length = 61, branchFrom = Infinity } = {}) => chainOf(Array.from({ length }, (_, h) => ({ transactions: [coinbase(h, h >= branchFrom ? 1 : 0),
    ...(h === 20 ? bonds : h === 21 && contract ? [publicationOf(contract)] : [])] })), 0, { timeOf: (h) => committeeSec + Math.max(0, h - 30) });
  // the census these bonds derive, over the blocks the node reads (0 .. the census height)
  const pre = build(null);
  const byTxid = new Map(bonds.map((raw) => [toHex(parseTransaction(raw).txid), raw]));
  const census = deriveCensus({ firstHeight: 0, blocks: pre.blocks.slice(0, CENSUS + 1) }, { contract: decodeRoundContract(encodeRoundContract(drafted)),
    bond: bondSetFor('regtest'), resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  assert.ok(census.ok, census.why);
  const contract = { ...drafted, censusRoot: census.root };
  const cookie = join(dir, '.cookie');
  writeFileSync(cookie, '__cookie__:s3cret');
  const named = (view) => beaconFromChain(contract, { headers: view.blocks.map((b) => b.header), firstHeight: 0 });
  return { dir, store, contract, cookie, CENSUS, build: (o) => build(contract, o), named, rid: toHex(roundId(contract)),
    env: (btc) => ({ BLWP_BITCOIND_URL: btc.url, BLWP_BITCOIND_COOKIE: cookie, BLWP_DONATION_NETWORK: 'regtest', BLWP_FUND_FREE_ROUNDS: '1' }) };
}
const postRound = async (port, contract) => {
  const r = await fetch(`http://127.0.0.1:${port}/round`, { method: 'POST', body: encodeRoundContract(contract) });
  return { status: r.status, text: (await r.text()).slice(0, 200) };
};
const randomness = async (port, rid) => {
  const r = await fetch(`http://127.0.0.1:${port}/randomness?round=${rid}`);
  return r.status === 200 ? { status: 200, height: r.headers.get('x-height'), hash: toHex(new Uint8Array(await r.arrayBuffer())) } : { status: r.status, text: await r.text() };
};
const until = async (what, ms, fn) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`${what}: not within ${ms} ms`); await new Promise((r) => setTimeout(r, 250)); } };
const ASSIGNED = (rid) => new RegExp(`\\[round\\] ${rid.slice(0, 16)} posted ahead: signer nodes assigned at its beacon`);
const heightsRead = (btc, view, since) => btc.calls.filter((c) => c.method === 'getblock' && c.atMs >= since).map((c) => byHashHeight(view, c.params[0]));

async function onAChain() {
  const f = chainFixture('main-chain-');
  const view = f.build();
  const named = f.named(view);
  assert.equal(named.height, 36, 'the fixture\'s beacon');
  const btc = await fakeBitcoind(view, '__cookie__:s3cret');
  const child = startMain(f.store, f.env(btc));
  try {
    const port = await child.up;
    let posted = null;
    for (let i = 0; i < 60; i++) {
      posted = await postRound(port, f.contract);
      if (posted.status === 201) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    assert.equal(posted.status, 201, `POST /round ${posted.status}; node said: ${(child.out + child.err).trim().split('\n').slice(-6).join(' | ')}`);
    assert.ok(btc.calls.every((c) => c.authed), 'every call carried the cookie\'s credentials');
    assert.ok(btc.calls.some((c) => c.method === 'getblockcount'));
    const blocksRead = new Set(heightsRead(btc, view, 0));
    for (let h = 0; h <= f.CENSUS; h++) assert.ok(blocksRead.has(h), `the census read block ${h}`);
    const r = await randomness(port, f.rid);
    assert.deepEqual([r.status, r.height, r.hash], [200, '36', toHex(named.hash)], 'the beacon block\'s hash');
    child.kill('SIGTERM');
    assert.equal((await child.exited).code, 0);
  } finally { child.kill('SIGKILL'); await btc.close(); }
}

// (a) A VIEW READ SHORT OF ITS BEACON IS READ ON AS THE CHAIN GROWS (main.js:206-232): posted at tip 33, before beacon 36 -
// 202, stored and waiting, no randomness; the chain grows to 61 and within ~15 s the node reads only the new blocks, its
// roster assigns the round, and /randomness names block 36.
async function growTheChain() {
  const f = chainFixture('main-grow-', { committeePast: true });
  const full = f.build();
  const btc = await fakeBitcoind(f.build({ length: 34 }), '__cookie__:s3cret');
  const child = startMain(f.store, f.env(btc));
  try {
    const port = await child.up;
    // the first ask starts the read and is refused while there is no view; the next is the 202 once the short view is in
    const posted = await until('POST /round answers 202', 20000, async () => { const p = await postRound(port, f.contract); return p.status === 202 && p; });
    assert.equal(posted.status, 202, 'stored, awaiting the beacon');
    // the sweep asks for the round's view: read to the tip, 33, short of the beacon
    await until('the short view is read', 20000, async () => heightsRead(btc, full, 0).includes(33));
    const shortRead = new Set(heightsRead(btc, full, 0));
    assert.ok([...Array(34).keys()].every((h) => shortRead.has(h)) && !shortRead.has(34), 'the short view: blocks 0..33');
    const early = await randomness(port, f.rid);
    assert.equal(early.status, 409, 'no randomness yet');
    assert.match(early.text, /no randomness yet/);
    await new Promise((r) => setTimeout(r, 6000));
    assert.doesNotMatch(child.out, ASSIGNED(f.rid), 'not assigned while short of the beacon');
    const grownAt = Date.now();
    btc.serve(full);
    await until('the round assigned', 25000, async () => ASSIGNED(f.rid).test(child.out));
    const took = Date.now() - grownAt;
    const r = await randomness(port, f.rid);
    assert.deepEqual([r.status, r.height, r.hash], [200, '36', toHex(f.named(full).hash)], 'block 36\'s hash');
    const after = heightsRead(btc, full, grownAt);
    assert.ok(after.length > 0 && after.every((h) => h >= 34), `only the new blocks were read: ${after.join(',')}`);
    assert.ok([34, 35, 36, 37, 38, 39, 40].every((h) => after.includes(h)), `blocks 34..40: ${after.join(',')}`);
    child.kill('SIGTERM');                         // a clean exit writes the process's V8 coverage
    assert.equal((await child.exited).code, 0);
    return { took };
  } finally { child.kill('SIGKILL'); await btc.close(); }
}

// (b) BLOCKS THAT DO NOT LINK (main.js:227): read to 33 on one branch, then a chain whose blocks from 30 are another branch,
// grown to 61 - its block 34 does not link to the 33 the node holds, so the node reads the whole view again.
async function unlinked() {
  const f = chainFixture('main-unlink-', { committeePast: true });
  const other = f.build({ branchFrom: 30 });
  const btc = await fakeBitcoind(f.build({ length: 34 }), '__cookie__:s3cret');
  const child = startMain(f.store, f.env(btc));
  try {
    const port = await child.up;
    await until('POST /round answers 202', 20000, async () => (await postRound(port, f.contract)).status === 202);
    const mine = f.build();
    await until('the short view is read', 20000, async () => heightsRead(btc, mine, 0).includes(33));
    await new Promise((r) => setTimeout(r, 1000));
    const swappedAt = Date.now();
    btc.serve(other);
    await until('the round assigned on the other branch', 25000, async () => ASSIGNED(f.rid).test(child.out));
    const r = await randomness(port, f.rid);
    assert.deepEqual([r.status, r.height, r.hash], [200, '36', toHex(f.named(other).hash)], 'the other branch\'s block 36');
    assert.notEqual(toHex(f.named(other).hash), toHex(f.named(mine).hash), 'the branches differ at the beacon');
    const hashesAsked = btc.calls.filter((c) => c.method === 'getblockhash' && c.atMs >= swappedAt).map((c) => c.params[0]);
    for (let h = 0; h <= f.CENSUS; h++) assert.ok(hashesAsked.includes(h), `the whole view asked again: getblockhash ${h}`);
    const blocks = heightsRead(btc, other, swappedAt);
    assert.ok([30, 31, 32, 33].every((h) => blocks.includes(h)), `the other branch's 30..33 read: ${blocks.join(',')}`);
    child.kill('SIGTERM');                         // a clean exit writes the process's V8 coverage
    assert.equal((await child.exited).code, 0);
  } finally { child.kill('SIGKILL'); await btc.close(); }
}

// (c) A VIEW THAT DID NOT READ (main.js:244-247): every block read fails for 25 s. One "[chain] view ... did not read" line,
// no second read within 60 s of it, then a good read and the round taken.
async function failedReads() {
  const f = chainFixture('main-fail-', { committeePast: true });
  const view = f.build();
  const btc = await fakeBitcoind(view, '__cookie__:s3cret');
  btc.failBlocks = true;
  const child = startMain(f.store, f.env(btc));
  try {
    const port = await child.up;
    await postRound(port, f.contract);
    await until('the failure is logged', 10000, async () => /did not read/.test(child.err));
    const failedAt = Date.now();
    const firstTry = btc.calls.filter((c) => c.method === 'getblock').length;
    setTimeout(() => { btc.failBlocks = false; }, 25000);
    let assignedBy = null;
    // the sweep asks for the view every 5 s, and a launcher may post again: none of it reads within the 60 s
    try {
      // assigned either way once the view reads: a POST then answers 201 (assigned on the spot), or the sweep logs it
      assignedBy = await until('the round assigned after a good read', 95000, async () => {
        const p = await postRound(port, f.contract);
        return (p.status === 201 && 'POST /round 201') || (ASSIGNED(f.rid).test(child.out) && 'the sweep');
      });
    } catch (e) {
      const rd = btc.calls.filter((c) => c.method === 'getblock').slice(firstTry).map((c) => Math.round((c.atMs - failedAt) / 1000));
      const posts = [];
      throw new Error(`${e.message}; getblock after the failure at s: ${rd.slice(0, 5).join(',')}..${rd.slice(-3).join(',')} (${rd.length}); methods after: ${[...new Set(btc.calls.filter((c) => c.atMs > failedAt + 60000).map((c) => c.method))].join(',')}; out: ${child.out.trim().split('\n').slice(-3).join(' | ')}; err: ${child.err.trim().split('\n').slice(-3).join(' | ')}`);
    }
    const r = await randomness(port, f.rid);
    const reads = btc.calls.filter((c) => c.method === 'getblock').slice(firstTry);
    const inside = reads.filter((c) => c.atMs < failedAt + 59000);
    assert.equal(inside.length, 0, `no block read within 60 s of the failure (${inside.length})`);
    const nextRead = reads.length ? reads[0].atMs - failedAt : null;
    assert.ok(nextRead !== null && nextRead >= 59000, `the next read came ${nextRead} ms after the failure`);
    assert.deepEqual([r.status, r.height], [200, '36'], 'block 36 named');
    assert.equal((child.err.match(/\[chain\] view [0-9]+:[0-9]+:1 did not read: /g) || []).length, 1, 'exactly one "did not read" line');
    assert.match(child.err, /\[chain\] view 40:\d+:1 did not read: .*the fake fails block reads/);
    const tookMs = nextRead;
    assert.ok(reads.filter((c) => c.atMs >= failedAt + 59000).length >= f.CENSUS + 1, 'the good read: the whole view');
    void assignedBy;
    child.kill('SIGTERM');                         // a clean exit writes the process's V8 coverage
    assert.equal((await child.exited).code, 0);
    return { tookMs, assignedBy };
  } finally { child.kill('SIGKILL'); await btc.close(); }
}
// (d) A RE-READ THAT FAILS PARTWAY (main.js:233, its .catch): as (a), but every getblock fails while the chain has grown. The
// node stays up, assigns nothing from the half read, and at its next look (~10 s on, VIEW_REREAD_MS) reads on and assigns.
async function reReadFails() {
  const f = chainFixture('main-reread-fail-', { committeePast: true });
  const full = f.build();
  const btc = await fakeBitcoind(f.build({ length: 34 }), '__cookie__:s3cret');
  const child = startMain(f.store, f.env(btc));
  try {
    const port = await child.up;
    await until('POST /round answers 202', 20000, async () => (await postRound(port, f.contract)).status === 202);
    await until('the short view is read', 20000, async () => heightsRead(btc, full, 0).includes(33));
    btc.failBlocks = true;
    btc.serve(full);
    const failedRead = await until('a re-read meets a failing getblock', 25000, async () => btc.calls.find((c) => c.method === 'getblock' && c.failed));
    await new Promise((r) => setTimeout(r, 1500));
    assert.doesNotMatch(child.out, ASSIGNED(f.rid), 'nothing assigned from a half read');
    assert.equal((await fetch(`http://127.0.0.1:${port}/identity`)).status, 200, 'the node is up');
    btc.failBlocks = false;
    const healedAt = Date.now();
    await until('the round assigned at a later look', 30000, async () => ASSIGNED(f.rid).test(child.out));
    const tookMs = Date.now() - failedRead.atMs;
    assert.ok(tookMs >= 8000, `the next look came ${tookMs} ms after the failed read (VIEW_REREAD_MS 10 s)`);
    const after = heightsRead(btc, full, healedAt);
    assert.ok(after.length > 0 && after.every((h) => h >= 34), `read on from 34: ${after.join(',')}`);
    const r = await randomness(port, f.rid);
    assert.deepEqual([r.status, r.height, r.hash], [200, '36', toHex(f.named(full).hash)]);
    child.kill('SIGTERM');                         // a clean exit writes the process's V8 coverage
    assert.equal((await child.exited).code, 0);
    return { tookMs };
  } finally { child.kill('SIGKILL'); await btc.close(); }
}

// (e) A BEACON REFRESH THAT FAILS (main.js:259, its .catch): /randomness asked before the beacon while every getblockheader
// fails - 409 "no randomness yet", the node up; healed and grown, /randomness names block 36.
async function refreshFails() {
  const f = chainFixture('main-refresh-fail-', { committeePast: true });
  const full = f.build();
  const btc = await fakeBitcoind(f.build({ length: 34 }), '__cookie__:s3cret');
  const child = startMain(f.store, f.env(btc));
  try {
    const port = await child.up;
    await until('POST /round answers 202', 20000, async () => (await postRound(port, f.contract)).status === 202);
    btc.failHeaders = true;
    const askedAt = Date.now();
    const early = await randomness(port, f.rid);
    assert.equal(early.status, 409);
    assert.match(early.text, /no randomness yet/);
    await until('the refresh meets a failing getblockheader', 10000, async () => btc.calls.some((c) => c.method === 'getblockheader' && c.failed && c.atMs >= askedAt));
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal((await fetch(`http://127.0.0.1:${port}/identity`)).status, 200, 'the node is up');
    assert.equal((await randomness(port, f.rid)).status, 409, 'still no randomness, still answering');
    btc.failHeaders = false;
    btc.serve(full);
    const r = await until('the healed chain names the beacon', 20000, async () => { const x = await randomness(port, f.rid); return x.status === 200 && x; });
    assert.deepEqual([r.height, r.hash], ['36', toHex(f.named(full).hash)]);
    child.kill('SIGTERM');
    assert.equal((await child.exited).code, 0);
  } finally { child.kill('SIGKILL'); await btc.close(); }
}

function byHashHeight(view, hash) {
  return view.blocks.findIndex((b) => toHex(Uint8Array.from(blockHashOf(b.header)).reverse()) === String(hash));
}

// ONE PARENT, ITS CASES CONCURRENT: the series file's minute and the failed read's minute run side by side, so the file
// stays under its 180 s.
test('main.js as the units run it', { concurrency: true }, async (t) => {
  const took = {};
  await Promise.all([
    t.test('with a series file: both series listed, count and cut read, an appended line served without a restart, an unreadable file leaves the series held, the launcher\'s proofs read at every ask, SIGTERM exits 0', seriesFile),
    t.test('refused before it binds: a series line that is not a series, count=x, a donation network that is not regtest or testnet4', refusals),
    t.test('on a chain: POST /round makes the node read the census from bitcoind under the cookie, and GET /randomness answers the beacon block\'s hash', onAChain),
    t.test('(a) a view read short of its beacon: 202 and no randomness at tip 33; grown to 61, only the new blocks read, the round assigned, block 36 named', async () => { took.grow = (await growTheChain()).took; }),
    t.test('(b) blocks that do not link: another branch from 30, its 34 not on the 33 held - the whole view read again', unlinked),
    t.test('(c) a view that did not read: one "did not read" line, no read within 60 s, then a good read and the round taken', async () => { const x = await failedReads(); took.fail = x.tookMs; took.failBy = x.assignedBy; }),
    t.test('(d) a re-read that fails partway: the node up, nothing assigned from the half read, read on and assigned at the next look', async () => { took.reread = (await reReadFails()).tookMs; }),
    t.test('(e) a beacon refresh that fails: /randomness 409 "no randomness yet", the node up; healed, block 36 named', refreshFails),
  ]);
  t.diagnostic(`grow: the beacon named ${took.grow} ms after the chain grew; failed read: the next read ${took.fail} ms after the failure, then assigned by ${took.failBy}; failed re-read: assigned ${took.reread} ms after it`);
});
