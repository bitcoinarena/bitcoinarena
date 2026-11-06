// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GATEWAY'S CLAIM THROUGH THE REAL PORT (kanban #1185): stakeLockPort.sendClaimed asks the tool's send-claimed mode (one run, or its
// serve mode) and reads its line back; federationSaw over that port reads IN only on a claim. A stand-in tool prints what
// tools/stake-lock/src/main.rs send_claimed prints - one JSON line, state claimed | stored | gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as curve from '../src/curve.js';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { LockSettlement, SUBMITTING } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const T = 'e1'.repeat(32);
const PRE = '77'.repeat(32);
// THE TOOL'S LINES, as send_claimed prints them
const CLAIMED = { mode: 'send-claimed', outpoint: `${T}:0`, claimed: true, state: 'claimed', block_count: 2000, preimage: PRE, payment_hash: 'aa'.repeat(32) };
const GONE = { mode: 'send-claimed', outpoint: `${T}:0`, claimed: false, state: 'gone', block_count: 2000, preimage_read: 'none' };
const STORED = { mode: 'send-claimed', outpoint: `${T}:0`, claimed: false, state: 'stored', block_count: 2000, stored: { contract_id: 'cd'.repeat(32), blocks_left: 0 } };
const STATUS = { mode: 'status', block_count: 2000, stored: null };

// `sc` is the send-claimed answer (null: a tool built before the mode - "no mode", exit 1); `serve` answers the same through serve mode
function tool({ sc, serve = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'send-claimed-1185-'));
  const log = join(dir, 'argv.jsonl'), asked = join(dir, 'asked.jsonl'), bin = join(dir, 'arena-stake-lock');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const mode = a[a.indexOf('--mode') + 1];
const sc = ${JSON.stringify(sc)}, status = ${JSON.stringify(STATUS)};
const answer = (m) => m === 'status' ? status : m === 'send-claimed' ? sc : null;
if (mode === 'serve') {
  if (!${serve}) { console.error('Error: no mode serve'); process.exit(1); }
  console.log(JSON.stringify({ mode: 'serve', ready: true, federation_id: 'cd'.repeat(32) }));
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const q = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    fs.appendFileSync(${JSON.stringify(asked)}, JSON.stringify(q) + '\\n');
    const r = answer(q.mode);
    console.log(JSON.stringify(r ? { id: q.id, ok: true, result: r } : { id: q.id, ok: false, error: 'serve answers status, fees, guardians, gateways, id, arena-status, arena-version and arena-id - not ' + q.mode })); } });
} else {
  console.log('2026-11-06T15:00:00Z INFO fedimint_client: a log line first');
  const r = answer(mode); if (!r) { console.error('Error: no mode ' + mode + ': lock, redeem, settle, status'); process.exit(1); }
  console.log(JSON.stringify(r));
}
`);
  chmodSync(bin, 0o755);
  const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, dir, argv: () => lines(log), asked: () => lines(asked) };
}
const O = { txid: fromHex(T), outIdx: 0n };

test('one run: the outpoint asked of the READ client dir; claimed with the preimage read back', async () => {
  const t = tool({ sc: CLAIMED });
  const port = stakeLockPort({ serve: false, bin: t.bin, dataDir: '/shared', readDataDir: '/read-only' });
  const c = await port.sendClaimed(O);
  assert.deepEqual(t.argv(), [['--mode', 'send-claimed', '--data-dir', '/read-only', '--outpoint', `${T}:0`]]);
  assert.equal(c.claimed, true);
  assert.equal(c.state, 'claimed');
  assert.equal(toHex(c.preimage), PRE);
});

test('one run: a contract still stored, and one gone (refunded or never made), are not claimed', async () => {
  for (const [sc, state] of [[STORED, 'stored'], [GONE, 'gone']]) {
    const port = stakeLockPort({ serve: false, bin: tool({ sc }).bin, dataDir: '/shared', readDataDir: '/read-only' });
    const c = await port.sendClaimed(O);
    assert.equal(c.claimed, false, state);
    assert.equal(c.state, state);
    assert.equal(c.preimage, null);
  }
});

test('a line that says claimed but carries no preimage is not a claim', async () => {
  const { preimage, ...noPre } = CLAIMED; void preimage;
  const port = stakeLockPort({ serve: false, bin: tool({ sc: noPre }).bin, dataDir: '/shared', readDataDir: '/read-only' });
  assert.equal((await port.sendClaimed(O)).claimed, false);
});

test('a tool built before the mode: sendClaimed throws', async () => {
  const port = stakeLockPort({ serve: false, bin: tool({ sc: null }).bin, dataDir: '/shared', readDataDir: '/read-only' });
  await assert.rejects(port.sendClaimed(O));
});

test('serve mode: asked through the one server; an older server that does not know the mode throws at once, no one run behind it', async () => {
  const dirs = [mkdtempSync(join(tmpdir(), 'sc-shared-')), mkdtempSync(join(tmpdir(), 'sc-read-'))];
  const t = tool({ sc: CLAIMED, serve: true });
  const port = stakeLockPort({ bin: t.bin, dataDir: dirs[0], readDataDir: dirs[1] });
  try {
    const c = await port.sendClaimed(O);
    assert.equal(c.claimed, true);
    assert.deepEqual(t.asked().map((q) => [q.mode, q.args.outpoint]), [['send-claimed', `${T}:0`]]);
    assert.deepEqual(t.argv().map((a) => a[1]), ['serve'], 'no one run');
  } finally { port.close(); }
  const old = tool({ sc: null, serve: true });
  const p2 = stakeLockPort({ bin: old.bin, dataDir: dirs[0], readDataDir: dirs[1] });
  try {
    const t0 = Date.now();
    await assert.rejects(p2.sendClaimed(O), /not send-claimed/);
    assert.ok(Date.now() - t0 < 5000);
    assert.deepEqual(old.argv().map((a) => a[1]), ['serve'], 'the same binary is not run again to say it');
  } finally { p2.close(); }
});

// federationSaw over the real port: T SUBMITTING, its one claimed lock gone, its send PAID by a preimage
function seat(bin) {
  const round = new Round(openStore(':memory:'));
  const RID = b32(0x85);
  round.putSettlementTxid({ roundId: RID, txid: T, message: new Uint8Array(32), claims: [`${toHex(b32(0x45))}:0`], payouts: 1 });
  round.putLockSettlement({ roundId: RID, txid: T, message: new Uint8Array(32), signature: new Uint8Array(64), state: SUBMITTING, why: 'handed' });
  round.sendAttemptsOf = () => [{ entryId: b32(1), attempt: 0, state: 'PAID', preimage: PRE, paymentHash: 'aa'.repeat(32) }];
  const port = stakeLockPort({ serve: false, bin, dataDir: '/shared', readDataDir: '/read-only' });
  const ls = new LockSettlement(round, { curve, port, dkg: {}, stakeSecrets: {}, winnings: { sendsFor: () => new Map() } });
  ls.confirmSoon = () => {};
  return { ls, RID };
}

test('federationSaw over the real port: IN on the tool\'s claim of T:0; mixed when it is gone, stored, or the tool has no such mode', async () => {
  for (const [sc, want] of [[CLAIMED, 'in'], [GONE, 'mixed'], [STORED, 'mixed'], [null, 'mixed']]) {
    const { ls, RID } = seat(tool({ sc }).bin);
    const saw = await ls.federationSaw(RID, { txid: T });
    assert.equal(saw.verdict, want, `${sc ? sc.state : 'no mode'}: ${saw.why}`);
  }
});
