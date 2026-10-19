// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FEDERATION PORT A SIGNER NODE ASKS (23.1 step 5): the arguments it hands
// blwp-stake-lock and how it reads the answers. A stand-in tool records its
// argv and prints what the real one prints; the real tool is measured against
// a real federation by tools/signer-node-lock-regtest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stakeLockPort, stakeLocksFromEnv, contractArgs } from '../src/stake-lock-port.js';

const b = (n, len = 32) => new Uint8Array(len).fill(n);

function fakeTool(dir, answer) {
  const log = join(dir, 'argv.json');
  const bin = join(dir, 'fake-stake-lock');
  writeFileSync(bin, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const a = process.argv.slice(2); const mode = a[a.indexOf('--mode') + 1];
const out = ${JSON.stringify(answer)}[mode];
if (!out) { console.error('Error: no mode ' + mode); process.exit(1); }
console.log('some log line'); console.log(JSON.stringify(out));
`);
  chmodSync(bin, 0o755);
  return { bin, argv: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

test('status and id hand the tool the outpoint and every field of the contract, and read its answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stake-lock-port-'));
  try {
    const t = fakeTool(dir, {
      status: { mode: 'status', block_count: 777, stored: { contract_id: 'ab'.repeat(32), blocks_left: 190 } },
      id: { mode: 'id', contract_id: 'cd'.repeat(32) },
    });
    const port = stakeLockPort({ serve: false, bin: t.bin, dataDir: '/client/dir' });
    const st = await port.status({ txid: b(0x11), outIdx: 3n });
    assert.deepEqual(st, { blockCount: 777, stored: { contractId: 'ab'.repeat(32), blocksLeft: 190 } });
    const f = { paymentImage: { kind: 'point', bytes: b(0x02, 33) }, amountMsat: 98000n, claimPk: b(0x03, 33), refundPk: b(0x02, 33), expiration: 967 };
    assert.equal(await port.contractId(f), 'cd'.repeat(32));
    const [statusArgs, idArgs] = t.argv();
    assert.deepEqual(statusArgs, ['--mode', 'status', '--data-dir', '/client/dir', '--outpoint', `${'11'.repeat(32)}:3`]);
    assert.deepEqual(idArgs, ['--mode', 'id', ...contractArgs(f)]);
    assert.deepEqual(contractArgs(f).slice(0, 2), ['--point', '02'.repeat(33)], 'a stake lock\'s image is a point');
    assert.deepEqual(contractArgs({ ...f, paymentImage: { kind: 'hash', bytes: b(0x44) } }).slice(0, 2), ['--hash', '44'.repeat(32)]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no lock at the outpoint reads as none, and a tool that fails is an error, not an answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stake-lock-port-'));
  try {
    const t = fakeTool(dir, { status: { mode: 'status', block_count: 5, stored: null } });
    const port = stakeLockPort({ serve: false, bin: t.bin, dataDir: '/d' });
    assert.deepEqual(await port.status({ txid: b(1), outIdx: 0n }), { blockCount: 5, stored: null });
    await assert.rejects(port.contractId({ paymentImage: { kind: 'point', bytes: b(2, 33) }, amountMsat: 1n, claimPk: b(3, 33), refundPk: b(2, 33), expiration: 1 }),
      /blwp-stake-lock: Error: no mode id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the port comes from two settings, both or neither', () => {
  assert.deepEqual(stakeLocksFromEnv({}), { ok: true, given: false });
  assert.match(stakeLocksFromEnv({ ARENA_STAKE_LOCK_BIN: '/x' }).why, /go together/);
  const both = stakeLocksFromEnv({ ARENA_STAKE_LOCK_BIN: '/x', ARENA_FEDERATION_CLIENT_DIR: '/y' });
  assert.equal(both.given, true);
  assert.equal(typeof both.stakeLocks.status, 'function');
});

// KEPT A MINUTE FOR EVERY CALLER (2026-10-02: the winnings resend loop spawned the tool for gateways and fees about every
// 6 s per idle testnet4 seat, ~1.7 MB/s of client-database writes each): ten asks of each within the minute run the
// tool once per mode; after the minute it runs again.
test('gateways and fees are read once a minute however often they are asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stake-lock-port-'));
  try {
    const t = fakeTool(dir, {
      gateways: { mode: 'gateways', federation_id: 'aa'.repeat(32), block_count: 9, gateways: [] },
      fees: { mode: 'fees', fee_ppm: 1000, fee_base_msat: 2000 },
    });
    let clock = 1_000_000;
    const port = stakeLockPort({ serve: false, bin: t.bin, dataDir: '/d', now: () => clock });
    const asks = [];
    for (let i = 0; i < 10; i++) asks.push(port.gateways(), port.fees());
    const answers = await Promise.all(asks);
    const once = t.argv().length;
    clock += 30000; await port.gateways(); await port.fees();
    const halfMinute = t.argv().length;
    clock += 31000; await port.gateways(); await port.fees();
    // past the minute the held answer comes back at once and the tool is asked again behind it (keptFor)
    for (let i = 0; i < 100 && t.argv().length < 4; i++) await new Promise((r) => setTimeout(r, 20));
    const after = t.argv().length;
    console.log('  FACTS:', JSON.stringify({ once, halfMinute, after }));
    assert.equal(once, 2, 'twenty asks ran the tool more than once per mode');
    assert.equal(halfMinute, 2);
    assert.equal(after, 4, 'a minute later the tool was not asked again');
    assert.equal(answers[1].ppm, 1000n);
    assert.equal(answers[0].height, 9);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// READ-ONLY ASKS ON THEIR OWN DIRECTORY (JOIN-TIME-1359): status, guardians, gateways and fees name readDataDir; send and
// settle name the shared dataDir; unset, both are dataDir; the env names it ARENA_FEDERATION_CLIENT_READ_DIR.
test('status, guardians, gateways and fees read their own client directory; send and settle keep the shared one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stake-lock-port-'));
  try {
    const t = fakeTool(dir, {
      status: { mode: 'status', block_count: 1, stored: null },
      gateways: { mode: 'gateways', federation_id: 'aa'.repeat(32), gateways: [] },
      fees: { mode: 'fees', fee_ppm: 0, fee_base_msat: 0 },
    });
    const port = stakeLockPort({ serve: false, bin: t.bin, dataDir: '/shared', readDataDir: '/mine' });
    await port.status({ txid: b(1), outIdx: 0n }); await port.gateways(); await port.fees();
    const dirs = t.argv().map((a) => a[a.indexOf('--data-dir') + 1]);
    assert.deepEqual(dirs, ['/mine', '/mine', '/mine']);
    const fromEnv = stakeLocksFromEnv({ ARENA_STAKE_LOCK_BIN: t.bin, ARENA_FEDERATION_CLIENT_DIR: '/shared', ARENA_FEDERATION_CLIENT_READ_DIR: '/seat-3' });
    await fromEnv.stakeLocks.status({ txid: b(2), outIdx: 0n });
    assert.equal(t.argv().at(-1)[t.argv().at(-1).indexOf('--data-dir') + 1], '/seat-3');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
