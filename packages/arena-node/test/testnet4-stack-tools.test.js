// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TESTNET4 STACK TOOLS' REFUSALS AND THEIR NETWORK SETTING, OFF ANY CHAIN (kanban #148 step 6, plan comment 235, Go
// 2026-10-05). Each tool runs as a child process, as it is run live, against fakes: a JSON-RPC bitcoind, lncli, gateway-cli
// and gatewayd that log their arguments. The stack itself is measured by tools/tn4-tools-regtest.sh; this is the fast half:
// what each tool refuses before it touches anything, and that ARENA_TN4_NETWORK (default testnet4) is what each one names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTool } from './tn4-tool-harness.js';

const TOOLS = new URL('../tools/', import.meta.url).pathname;
const run = (cmd, args, env = {}, cwd = TOOLS) => new Promise((done) => execFile(cmd, args, { env: { ...process.env, ...env }, cwd, timeout: 60000 },
  (err, stdout, stderr) => done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })));
const dir = () => mkdtempSync(join(tmpdir(), 'tn4-stack-'));
// a fake binary: logs its argv (and the env names asked for) one JSON line per call, then prints `out`
function fake(d, name, out = '', envNames = []) {
  const f = join(d, name);
  writeFileSync(f, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(join(d, `${name}.log`))}, JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(${JSON.stringify(envNames)}.map((k) => [k, process.env[k]])) }) + '\\n');
process.stdout.write(${JSON.stringify(out)});
`);
  chmodSync(f, 0o755);
  return f;
}
const calls = (d, name) => (existsSync(join(d, `${name}.log`)) ? readFileSync(join(d, `${name}.log`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function rpcServer(chain) {
  const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)).on('end', () => {
    const { id, method } = JSON.parse(b);
    res.end(JSON.stringify({ id, error: null, result: method === 'getblockchaininfo' ? { chain, blocks: 300 } : null }));
  }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('testnet4-found.mjs refuses six nodes, no chain, and a chain that is not ARENA_TN4_NETWORK - before any guardian starts', async () => {
  const d = dir();
  const cookie = join(d, '.cookie'); writeFileSync(cookie, '__cookie__:x');
  const nodes = (n) => Array.from({ length: n }, (_, i) => `${23221 + 10 * i}:${join(d, `node-${i + 1}.db`)}`);
  const six = await run(process.execPath, ['testnet4-found.mjs', ...nodes(6)], { ARENA_BITCOIND_URL: 'http://127.0.0.1:1', ARENA_BITCOIND_COOKIE: cookie });
  assert.match(six.stderr, /the testnet federation is seven guardians \(5 of 7\); got 6/);
  const noChain = await run(process.execPath, ['testnet4-found.mjs', ...nodes(7)], { ARENA_BITCOIND_URL: '', ARENA_BITCOIND_COOKIE: '' });
  assert.match(noChain.stderr, /ARENA_BITCOIND_URL and ARENA_BITCOIND_COOKIE: the chain the guardians run on/);
  const rpc = await rpcServer('regtest');
  let other, named;
  try {
  other = await run(process.execPath, ['testnet4-found.mjs', ...nodes(7)], { ARENA_BITCOIND_URL: rpc.url, ARENA_BITCOIND_COOKIE: cookie, ARENA_TN4_NETWORK: '' });
  assert.match(other.stderr, /runs regtest, not testnet4 \(ARENA_TN4_NETWORK\): nothing is founded/);
  named = await run(process.execPath, ['testnet4-found.mjs', ...nodes(7)], { ARENA_BITCOIND_URL: rpc.url, ARENA_BITCOIND_COOKIE: cookie, ARENA_TN4_NETWORK: 'signet' });
  assert.match(named.stderr, /runs regtest, not signet/);
  } finally { await rpc.close(); }
  for (const r of [six, noChain, other, named]) assert.notEqual(r.code, 0);
  assert.equal(existsSync(join(d, 'node-1.db.guardian')), false, 'no guardian directory was made');
});

test('run-testnet4-paid.mjs refuses six ports, 8080, and a missing setting - before the Funnel, a store or a chain', async () => {
  const d = dir();
  const base = { ARENA_TESTNET4_DIR: d, PATH: d }; // no tailscale, no bitcoin-cli on PATH: reaching either would fail differently
  const six = await run(process.execPath, ['run-testnet4-paid.mjs'], { ...base, ARENA_TN4_PORTS: '23221,23231,23241,23251,23261,23271' });
  assert.match(six.stderr, /seven signer nodes, never 8080/);
  const eighty = await run(process.execPath, ['run-testnet4-paid.mjs'], { ...base, ARENA_TN4_PORTS: '23221,23231,23241,23251,23261,23271,8080' });
  assert.match(eighty.stderr, /seven signer nodes, never 8080/);
  const unset = await run(process.execPath, ['run-testnet4-paid.mjs'], { ...base, ARENA_TN4_PORTS: '', ARENA_STAKE_LOCK_BIN: '', ARENA_FEDERATION_CLIENT_DIR: '' });
  assert.match(unset.stderr, /set ARENA_STAKE_LOCK_BIN, ARENA_FEDERATION_CLIENT_DIR, ARENA_FEDERATION_INVITE_FILE/);
  for (const r of [six, eighty, unset]) assert.notEqual(r.code, 0);
  assert.equal(existsSync(join(d, 'paid')), false, 'nothing was written');
});

test('testnet4-lock.mjs names what it needs, and refuses a round its first node does not hold', async () => {
  const missing = await run(process.execPath, ['testnet4-lock.mjs'], { ROUND: '', PORTS: '' });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /ROUND is needed/);
  const d = dir();
  writeFileSync(join(d, 'invite'), 'fed1x');
  const r = await runTool(join(TOOLS, 'testnet4-lock.mjs'), { spec: {}, routes: {}, args: () => [],
    env: { ROUND: 'ab'.repeat(32), PORTS: '1', INVITE_FILE: join(d, 'invite'), WASM_PKG: d, LNCLI: fake(d, 'lncli'), PAYER_DIR: d, PAYER_RPC: 'x' } });
  // PORTS=1 is nobody's door: the round is asked of 127.0.0.1:1 and refused before any lock client, deposit or payment
  assert.equal(r.code, 1);
  assert.match(r.stdout, /"step":"stopped"/);
  assert.deepEqual(calls(d, 'lncli'), [], 'nothing was paid');
});

test('testnet4-lnaddr.mjs answers lnurlp, refuses a small amount, and asks its lnd for an invoice on ARENA_TN4_NETWORK with the metadata\'s hash', async () => {
  const missing = await run(process.execPath, ['testnet4-lnaddr.mjs'], { LNCLI: '' });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /LNCLI is needed/);
  for (const [net, want] of [['', 'testnet4'], ['regtest', 'regtest']]) {
    const d = dir();
    const lncli = fake(d, 'lncli', JSON.stringify({ payment_request: 'lnbcrt1fake', r_hash: 'aa' }));
    const port = 29400 + (net ? 1 : 0);
    const child = execFile(process.execPath, ['testnet4-lnaddr.mjs'], { cwd: TOOLS, env: { ...process.env, LNCLI: lncli, LND_DIR: d, LND_RPC: 'x:1',
      PORT: String(port), PUBLIC: `http://localhost:${port}`, ARENA_TN4_NETWORK: net } });
    try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const p = await (await fetch(`http://127.0.0.1:${port}/.well-known/lnurlp/winner`)).json();
    assert.equal(p.tag, 'payRequest');
    assert.equal(p.callback, `http://localhost:${port}/lnurlp/cb/winner`);
    const small = await (await fetch(`http://127.0.0.1:${port}/lnurlp/cb/winner?amount=999`)).json();
    assert.deepEqual(small, { status: 'ERROR', reason: 'amount in msat, at least 1000' });
    const no = await fetch(`http://127.0.0.1:${port}/nothing`);
    assert.equal(no.status, 404);
    const inv = await (await fetch(`http://127.0.0.1:${port}/lnurlp/cb/winner?amount=21000`)).json();
    assert.equal(inv.pr, 'lnbcrt1fake');
    const [c] = calls(d, 'lncli');
    assert.ok(c.argv.includes(`--network=${want}`), `lncli asked on ${want}: ${c.argv.join(' ')}`);
    const hash = c.argv[c.argv.indexOf('--description_hash') + 1];
    assert.equal(hash, createHash('sha256').update(p.metadata).digest('hex'), 'the invoice commits to the metadata answered');
    assert.equal(c.argv[c.argv.indexOf('--amt_msat') + 1], '21000');
    } finally { child.kill(); }
  }
});

test('testnet4-gateway.sh names ARENA_TN4_NETWORK as the gateway\'s label and the LND\'s macaroon chain, and stops on a missing macaroon', async () => {
  for (const [net, want] of [['', 'testnet4'], ['regtest', 'regtest']]) {
    const d = dir();
    const lnd = join(d, 'lnd'); mkdirSync(join(lnd, 'data/chain/bitcoin', want), { recursive: true });
    writeFileSync(join(lnd, 'tls.cert'), 'cert'); writeFileSync(join(lnd, `data/chain/bitcoin/${want}/admin.macaroon`), 'mac');
    writeFileSync(join(d, 'cookie'), '__cookie__:secret');
    fake(d, 'gateway-cli', 'hash');
    fake(d, 'gatewayd', '', ['FM_GATEWAY_NETWORK', 'FM_BITCOIND_URL', 'FM_BITCOIND_PASSWORD', 'FM_LND_MACAROON']);
    const r = await run('bash', ['testnet4-gateway.sh', lnd, '127.0.0.1:1', '29500', join(d, 'gw')],
      { PATH: `${d}:${process.env.PATH}`, ARENA_TN4_NETWORK: net, ARENA_BITCOIND_URL: 'http://127.0.0.1:2', ARENA_BITCOIND_COOKIE: join(d, 'cookie') });
    assert.equal(r.code, 0, r.stderr);
    const [g] = calls(d, 'gatewayd');
    assert.deepEqual(g.argv, ['lnd']);
    assert.equal(g.env.FM_GATEWAY_NETWORK, want);
    assert.equal(g.env.FM_BITCOIND_URL, 'http://127.0.0.1:2');
    assert.equal(g.env.FM_BITCOIND_PASSWORD, 'secret');
    assert.equal(readFileSync(g.env.FM_LND_MACAROON, 'utf8'), 'mac', `the ${want} macaroon was copied`);
  }
  const d = dir();
  const lnd = join(d, 'lnd'); mkdirSync(join(lnd, 'data/chain/bitcoin/testnet4'), { recursive: true });
  writeFileSync(join(lnd, 'tls.cert'), 'cert'); writeFileSync(join(lnd, 'data/chain/bitcoin/testnet4/admin.macaroon'), 'mac');
  fake(d, 'gatewayd');
  const wrong = await run('bash', ['testnet4-gateway.sh', lnd, '127.0.0.1:1', '29500', join(d, 'gw')], { PATH: `${d}:${process.env.PATH}`, ARENA_TN4_NETWORK: 'regtest' });
  assert.notEqual(wrong.code, 0, 'a regtest gateway on an lnd with only a testnet4 macaroon does not start');
  assert.deepEqual(calls(d, 'gatewayd'), []);
});

test('testnet4-gateway-pegin.sh stops when the gateway names no peg-in address, and sends nothing', async () => {
  const d = dir();
  const wrap = fake(d, 'wrap', '{"no":"address"}');
  writeFileSync(join(d, 'pw'), 'pw');
  const r = await run('bash', ['testnet4-gateway-pegin.sh', 'http://127.0.0.1:1', join(d, 'pw'), 'fed', '1000'], { ARENA_TAILNET_EXEC: wrap });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the gateway at http:\/\/127.0.0.1:1 named no peg-in address for fed/);
  const asked = calls(d, 'wrap').map((c) => c.argv.slice(c.argv.indexOf('--rpcpassword') + 2).join(' '));
  assert.deepEqual(asked, ['ecash pegin --federation-id fed'], 'no onchain send');
});

test('testnet4-gateways.sh drops before it adds, at each of the seven guardians by its own id and password', async () => {
  const d = dir();
  for (let i = 1; i <= 7; i++) { mkdirSync(join(d, `node-${i}.db.guardian`)); writeFileSync(join(d, `node-${i}.db.guardian/admin-password`), `pw${i}`); }
  const wrap = fake(d, 'wrap', '["http://localhost:1/"]');
  const r = await run('bash', ['testnet4-gateways.sh', join(d, 'client'), 'http://localhost:1', '--', 'http://127.0.0.1:1'], { ARENA_TAILNET_EXEC: wrap, ARENA_TESTNET4_DIR: d });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(lines, [0, 1, 2, 3, 4, 5, 6].map((i) => `guardian ${i} ["http://localhost:1/"]`));
  const c = calls(d, 'wrap').map((x) => x.argv.join(' '));
  for (let i = 0; i < 7; i++) {
    const own = c.filter((x) => x.includes(`--our-id ${i} --password pw${i + 1}`));
    assert.equal(own.length, 2);
    assert.match(own[0], /gateways remove http:\/\/127\.0\.0\.1:1$/);
    assert.match(own[1], /gateways add http:\/\/localhost:1$/);
  }
});
