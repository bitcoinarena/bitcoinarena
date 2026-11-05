// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LEVEL-1 PROOF (a)'S CORRECT BODY, REBUILT OFFLINE (kanban #1044 B1): the stake-lock tool's arena-body reads the proof's own config and sessions and
// the correct table's build on stdin, and answers the body id - or why the proof's bytes do not rebuild it. The tool here is a fake that keeps what it
// was handed and prints what the real one prints; the real tool's answer over real sessions is measured on the regtest (offence (a) to a slash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readBody } from '../src/stake-lock-port.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const INPUT = { config: '09', firstSession: 3, sessions: ['01', '0203'] };
const BUILD = {
  claims: [{ outpoint: { txid: b32(0x31), outIdx: 0n }, preimage: b32(0x11) }, { outpoint: { txid: b32(0x32), outIdx: 1n }, preimage: b32(0x12) }],
  payouts: [{ payoutPk: Uint8Array.from([2, ...b32(0x55)]), msat: 400000n }, { payoutPk: Uint8Array.from([3, ...b32(0x56)]), msat: 9000n, sent: { paymentHash: 'ab'.repeat(32), gatewayPk: '02' + 'cd'.repeat(32), expiration: 700 } }],
  nonce: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
};

function fakeTool(line, code = 0, seen = []) {
  return (bin, args) => {
    const c = new EventEmitter();
    c.kill = () => {};
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {};
    c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {};
    let stdin = '';
    c.stdin = new EventEmitter();
    c.stdin.end = (text) => { stdin += text; seen.push({ bin, args, stdin: JSON.parse(stdin) }); setImmediate(() => { if (line) c.stdout.emit('data', `${line}\n`); c.exitCode = code; c.emit('close', code, null); }); };
    return c;
  };
}

test('arena-body is handed the proof\'s sessions and the build as arena-settle reads it, and its body id comes back', async () => {
  const seen = [];
  const got = await readBody('/x/arena-stake-lock', INPUT, BUILD, 5000, fakeTool(JSON.stringify({ mode: 'arena-body', ok: true, body_id: 'AB'.repeat(32) }), 0, seen));
  assert.deepEqual(got, { ok: true, bodyId: 'ab'.repeat(32) });
  assert.deepEqual(seen[0].args, ['--mode', 'arena-body']);
  assert.deepEqual(seen[0].stdin, { ...INPUT,
    locks: `${hex(b32(0x31))}:0:${hex(b32(0x11))},${hex(b32(0x32))}:1:${hex(b32(0x12))}`,
    payouts: `02${hex(b32(0x55))}:400000,invoice:${'ab'.repeat(32)}:02${'cd'.repeat(32)}:03${hex(b32(0x56))}:700:9000`,
    nonce: '0102030405060708' });
});

test('a body the proof\'s own sessions do not rebuild is said so; no tool, a failed run or another mode is "cannot say"', async () => {
  const refused = await readBody('/x', INPUT, BUILD, 5000, fakeTool(JSON.stringify({ mode: 'arena-body', ok: false, why: 'no given session funds an Arena lock at 3131:0' })));
  assert.deepEqual(refused, { ok: false, why: 'no given session funds an Arena lock at 3131:0' });
  assert.equal(await readBody(null, INPUT, BUILD), null);
  assert.equal(await readBody('/x', INPUT, BUILD, 5000, fakeTool(null, 1)), null);
  assert.equal(await readBody('/x', INPUT, BUILD, 5000, fakeTool(JSON.stringify({ mode: 'arena-claim-read' }))), null);
});
