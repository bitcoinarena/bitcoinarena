// THE FEDERATION PORT A SEAT ASKS (23.1 step 5): the arguments it hands
// blwp-stake-lock and how it reads the answers. A stand-in tool records its
// argv and prints what the real one prints; the real tool is measured against
// a real federation by tools/seat-lock-regtest.
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
    const port = stakeLockPort({ bin: t.bin, dataDir: '/client/dir' });
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
    const port = stakeLockPort({ bin: t.bin, dataDir: '/d' });
    assert.deepEqual(await port.status({ txid: b(1), outIdx: 0n }), { blockCount: 5, stored: null });
    await assert.rejects(port.contractId({ paymentImage: { kind: 'point', bytes: b(2, 33) }, amountMsat: 1n, claimPk: b(3, 33), refundPk: b(2, 33), expiration: 1 }),
      /blwp-stake-lock: Error: no mode id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the port comes from two settings, both or neither', () => {
  assert.deepEqual(stakeLocksFromEnv({}), { ok: true, given: false });
  assert.match(stakeLocksFromEnv({ BLWP_STAKE_LOCK_BIN: '/x' }).why, /go together/);
  const both = stakeLocksFromEnv({ BLWP_STAKE_LOCK_BIN: '/x', BLWP_FEDERATION_CLIENT_DIR: '/y' });
  assert.equal(both.given, true);
  assert.equal(typeof both.stakeLocks.status, 'function');
});
