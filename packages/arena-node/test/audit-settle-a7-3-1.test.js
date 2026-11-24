// Audit settle r3-1: one guardian's wallet_summary answer with a non-integer amount throws inside the WebSocket 'message'
// listener of readReserve (federation-reserve.js askOne -> reserveOfSummary -> BigInt). An EventTarget listener's throw is an
// uncaught exception in Node, so the seat process exits. Safe behaviour: the bad answer counts as no answer, and the three
// honest guardians (threshold 3 of 4) still name the reserve - the process lives on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src', 'federation-reserve.js');

const child = `
import { WebSocketServer } from 'ws';
import { readReserve } from ${JSON.stringify(src)};
const honest = { spendable_utxos: [{ amount: 250000, outpoint: '00'.repeat(32) + ':0' }], unconfirmed_change_utxos: [], unsigned_change_utxos: [] };
const bad = { spendable_utxos: [{ amount: 'not-a-number', outpoint: '00'.repeat(32) + ':0' }], unconfirmed_change_utxos: [], unsigned_change_utxos: [] };
const servers = [];
const start = (result, delay) => new Promise((ok) => {
  const s = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => ok(s));
  s.on('connection', (c) => c.on('message', (m) => { const { id, method } = JSON.parse(String(m));
    setTimeout(() => c.send(JSON.stringify(method === 'module_0_wallet_summary' ? { jsonrpc: '2.0', id, result }
      : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })), delay); }));
  servers.push(s);
});
const list = [await start(bad, 0), await start(honest, 150), await start(honest, 150), await start(honest, 150)];
const endpoints = list.map((s) => 'ws://127.0.0.1:' + s.address().port);
const r = await readReserve({ endpoints, threshold: 3, localOk: true, timeoutMs: 3000 });
console.log('RESULT ' + JSON.stringify({ ok: r.ok, reserveSats: String(r.reserveSats), agreeing: r.agreeing }));
for (const s of servers) s.close();
process.exit(0);
`;

test('one guardian answering a junk amount does not crash the seat, and the honest threshold still names the reserve', () => {
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', child], { cwd: join(here, '..'), encoding: 'utf8', timeout: 30000 });
  const line = (out.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `the seat process died before readReserve answered (exit ${out.status}): ${(out.stderr || '').split('\n').slice(0, 6).join(' | ')}`);
  assert.deepEqual(JSON.parse(line.slice(7)), { ok: true, reserveSats: '250000', agreeing: 3 });
});

// kanban #3594: the walletv2 answer (federation_wallet { value }) is held to whole satoshi the same way
test('one guardian answering a junk federation_wallet value does not crash the seat, and the honest threshold still names the reserve', () => {
  const v2 = child.replace("const honest = {", "const honestV2 = { value: 250000, outpoint: '00'.repeat(32) + ':0' }; const badV2 = { value: 'x' }; const honest = {")
    .replace("method === 'module_0_wallet_summary' ? { jsonrpc: '2.0', id, result }", "method === 'module_0_federation_wallet' ? { jsonrpc: '2.0', id, result }")
    .replace('[await start(bad, 0), await start(honest, 150), await start(honest, 150), await start(honest, 150)]',
      '[await start(badV2, 0), await start(honestV2, 150), await start(honestV2, 150), await start(honestV2, 150)]');
  assert.notEqual(v2, child);
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', v2], { cwd: join(here, '..'), encoding: 'utf8', timeout: 30000 });
  const line = (out.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `the seat process died before readReserve answered (exit ${out.status}): ${(out.stderr || '').split('\n').slice(0, 6).join(' | ')}`);
  assert.deepEqual(JSON.parse(line.slice(7)), { ok: true, reserveSats: '250000', agreeing: 3 });
});

test('reserveOfSummary names whole satoshi only: junk, fractions, negatives and non-lists are no reserve', async () => {
  const { reserveOfSummary, satsOf } = await import(src);
  const s = (spendable, rest = {}) => ({ spendable_utxos: spendable, unconfirmed_change_utxos: [], unsigned_change_utxos: [], ...rest });
  assert.equal(reserveOfSummary(s([{ amount: 250000 }, { amount: '7' }, {}])), 250007n);
  for (const amount of ['x', '1.5', 1.5, -1, '-1', '', ' 1', {}, [], true, 2 ** 60, '0x10'])
    assert.equal(reserveOfSummary(s([{ amount }])), null, `amount ${JSON.stringify(amount)}`);
  assert.equal(reserveOfSummary(s([null])), null);
  assert.equal(reserveOfSummary(s([], { unconfirmed_change_utxos: 'x' })), null);
  assert.equal(reserveOfSummary(null), null);
  assert.equal(satsOf('12345678901234567890'), 12345678901234567890n);
});

// kanban #3594: a seat that does not guard the federation says so before it reads the reserve - a stranger's GET /federation-record on
// any seat no longer makes it dial that federation's guardians
test('a seat that does not guard the federation never reads its reserve for a signature', async () => {
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const { federationRecords } = await import('../src/federation-records.js');
  const { inviteForGuardians } = await import('../src/invite.js');
  const { toHex } = await import('../../arena-protocol/src/hash.js');
  const FED = new Uint8Array(32).fill(0x37), NET = new Uint8Array(32).fill(0x10);
  const INVITE = inviteForGuardians(FED, Array.from({ length: 4 }, (_, i) => ({ peer: i, url: `wss://g${i}.example` })));
  const nodes = Array.from({ length: 4 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0x20 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: `wss://seat-${i}.example`, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  const stranger = { secret: new Uint8Array(32).fill(0x55) }; stranger.pubkey = schnorr.getPublicKey(stranger.secret);
  let reads = 0;
  const seat = (me) => federationRecords({
    round: { pubkey: me.pubkey, identity: { secret: me.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, guardianKeysOf: async () => nodes.map((n) => n.guardianKey),
    reserveOf: async () => { reads++; return { ok: true, reserveSats: 0n }; }, fetcher: async () => new Response('no', { status: 404 }),
  });
  const r = await seat(stranger).mySignature(toHex(FED));
  assert.deepEqual([r.ok, r.why, reads], [false, 'this node does not guard that federation', 0]);
  const g = await seat(nodes[0]).mySignature(toHex(FED));
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.equal(reads, 1, 'a guardian seat still reads the reserve it signs');
});
