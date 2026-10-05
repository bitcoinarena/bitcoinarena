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

const MAIN = new URL('../src/main.js', import.meta.url).pathname;
const CWD = new URL('..', import.meta.url).pathname;

// A node process: resolves once it prints its address, with the port it bound
function startMain(store, env, { args } = {}) {
  const child = spawn(process.execPath, [MAIN, ...(args || ['0', store])], { cwd: CWD, env: { ...process.env, BLWP_BITCOIND_URL: '', BLWP_BITCOIND_COOKIE: '',
    BLWP_STAKE_LOCK_BIN: '', BLWP_FEDERATION_CLIENT_DIR: '', PATH: process.env.PATH.split(':').filter((d) => !/fedimint|patched/.test(d)).join(':'), ...env },
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
test('main.js with a series file: both series listed, count and cut read, an appended line served without a restart, an unreadable file leaves the series held, the launcher\'s proofs read at every ask, SIGTERM exits 0', async () => {
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
});

test('main.js refuses before it binds: a series line that is not a series, count=x, a donation network that is not regtest or testnet4', async () => {
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
});

// ---- THE CHAIN HALF: a fake bitcoind serving a mined chain of 61 blocks - the round's two bonds at 20, its publication at 21,
// its census at 40 (so the node's 2016-block lookback starts at 0), its beacon at 36 (the first block whose median time
// passes committee time: blocks 0..30 at the committee second, one second a block after) - and every call logged.
function blockBytes(b) {
  const n = b.transactions.length;
  return Buffer.concat([Buffer.from(b.header), Buffer.from([n]), ...b.transactions.map((t) => Buffer.from(t))]);
}
async function fakeBitcoind(view, cookie) {
  const calls = [];
  const display = (header) => toHex(Uint8Array.from(blockHashOf(header)).reverse());
  const byHash = new Map(view.blocks.map((b, h) => [display(b.header), { b, h }]));
  const tip = view.firstHeight + view.blocks.length - 1;
  const srv = createServer((req, res) => { let body = ''; req.on('data', (d) => { body += d; }).on('end', () => {
    const authed = req.headers.authorization === `Basic ${Buffer.from(cookie).toString('base64')}`;
    const { id, method, params = [] } = JSON.parse(body);
    calls.push({ method, params, authed });
    if (!authed) { res.writeHead(401); return res.end(); }
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
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise((r) => srv.close(r)) };
}

test('main.js on a chain: POST /round makes the node read the census from bitcoind under the cookie, and GET /randomness answers the beacon block\'s hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-chain-'));
  const store = join(dir, 'node.db');
  const keys = [nodeKeyOf(store), schnorr.getPublicKey(b32(0x44))];
  const CENSUS = 40;
  const drafted = presentDay({ ...contractFor(keys, 3000n, ['wss://r.example']), stakeMsat: 0n, censusHeight: CENSUS }, Date.now() + 600000);
  const committeeSec = Math.floor(Number(drafted.committeeTimeMs) / 1000);
  const bonds = keys.map((key, i) => bondTransaction({
    nodePubkey: key, operatorId: `operator${i}`, protocolVersions: [1], roles: ['game', 'settlement'], endpoint: `ws://node${i}`,
    region: 'eu-west', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
    bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
  }, { previousTxid: b32(0xa0 + i), previousVout: 0, outputKey: bondFor(key) }));
  // every block opens with a coinbase-shaped transaction (the node reads no block without one), its height in the input
  const coinbase = (h) => serializeSpend({ inputs: [{ txid: new Uint8Array(32), vout: 0xffffffff, sequence: 0xffffffff, script: Uint8Array.from([1, h]) }],
    outputs: [{ value: 5000000000n, script: Uint8Array.from([0x51]) }], witnesses: [[new Uint8Array(32)]] });
  const build = (contract) => chainOf(Array.from({ length: 61 }, (_, h) => ({ transactions: [coinbase(h),
    ...(h === 20 ? bonds : h === 21 && contract ? [publicationOf(contract)] : [])] })),
    0, { timeOf: (h) => committeeSec + Math.max(0, h - 30) });
  // the census these bonds derive, over the blocks the node reads (0 .. the census height)
  const pre = build(null);
  const byTxid = new Map(bonds.map((raw) => [toHex(parseTransaction(raw).txid), raw]));
  const census = deriveCensus({ firstHeight: 0, blocks: pre.blocks.slice(0, CENSUS + 1) }, { contract: decodeRoundContract(encodeRoundContract(drafted)),
    bond: bondSetFor('regtest'), resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  assert.ok(census.ok, census.why);
  const contract = { ...drafted, censusRoot: census.root };
  const view = build(contract);
  const named = beaconFromChain(contract, { headers: view.blocks.map((b) => b.header), firstHeight: 0 });
  assert.equal(named.height, 36, 'the fixture\'s beacon');
  const cookie = join(dir, '.cookie');
  writeFileSync(cookie, '__cookie__:s3cret');
  const btc = await fakeBitcoind(view, '__cookie__:s3cret');
  const child = startMain(store, { BLWP_BITCOIND_URL: btc.url, BLWP_BITCOIND_COOKIE: cookie, BLWP_DONATION_NETWORK: 'regtest', BLWP_FUND_FREE_ROUNDS: '1' });
  try {
    const port = await child.up;
    const rid = toHex(roundId(contract));
    let posted = null;
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/round`, { method: 'POST', body: encodeRoundContract(contract) });
      posted = { status: r.status, text: (await r.text()).slice(0, 200) };
      if (posted.status === 201) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    assert.equal(posted.status, 201, `POST /round ${posted.status}; node said: ${(child.out + child.err).trim().split('\n').slice(-6).join(' | ')}; rpc: ${[...new Set(btc.calls.map((c) => c.method))].join(',')}`);
    assert.ok(btc.calls.every((c) => c.authed), 'every call carried the cookie\'s credentials');
    const asked = (m) => btc.calls.filter((c) => c.method === m);
    assert.ok(asked('getblockcount').length > 0);
    const blocksRead = new Set(asked('getblock').map((c) => byHashHeight(view, c.params[0])));
    for (let h = 0; h <= CENSUS; h++) assert.ok(blocksRead.has(h), `the census read block ${h}`);
    const r = await fetch(`http://127.0.0.1:${port}/randomness?round=${rid}`);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(r.headers.get('x-height'), '36');
    assert.equal(toHex(new Uint8Array(await r.arrayBuffer())), toHex(named.hash), 'the beacon block\'s hash');
    child.kill('SIGTERM');
    assert.equal((await child.exited).code, 0);
  } finally { child.kill('SIGKILL'); await btc.close(); }
});
function byHashHeight(view, hash) {
  return view.blocks.findIndex((b) => toHex(Uint8Array.from(blockHashOf(b.header)).reverse()) === String(hash));
}
