// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PUBLISHED ROUND FIRST, ITS BEACON AFTER (plan comment 249, Go 2026-10-05). awaitPublishedBeacon and
// beaconBlockIn on chain views built here: mined, linked headers 600 s apart (a block's median time past is then the time
// of the block five below it), the round's publication transaction from protocol's own output. bumpfee and the sleeps are
// fakes. The testnet4 fcb15cca shape - a beacon block before the publication - stays a dead round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitPublishedBeacon, beaconBlockIn } from '../src/publication-wait.js';
import { contractFor, b32 } from './window-fixture.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { publicationOutput } from '../../arena-protocol/src/publication.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { parseTransaction, hash256 } from '../../arena-protocol/src/tx.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const T0 = 1_790_000_000;                       // the first block's time, seconds
const timeOf = (h) => T0 + 600 * h;             // view heights start at 0
const FIRST = 0;
const spend = (n, outputs = []) => serializeSpend({ inputs: [{ txid: b32(n), vout: 0, sequence: 0xffffffff }],
  outputs: [{ value: 5000n, script: fromHex('0014' + '33'.repeat(20)) }, ...outputs], witnesses: [[new Uint8Array(64)]] });
// a chain of `n` blocks; `extra[h]` are raw transactions put in block h; each block takes another's transaction beside its
// coinbase, unless its height is in `empty` (a coinbase-only block, as testnet4's minimum-difficulty ones)
function chain(n, extra = {}, { empty = [] } = {}) {
  const blocks = [];
  let previous = new Uint8Array(32);
  for (let h = 0; h < n; h++) {
    const transactions = [spend(200 + (h % 50)), ...(empty.includes(h) ? [] : [spend(300 + (h % 50))]), ...(extra[h] || [])];
    const { header } = blockOf(hash256, transactions.map((raw) => parseTransaction(raw).txid), { previous, time: timeOf(h) });
    blocks.push({ header, transactions });
    previous = blockHashOf(header);
  }
  return { firstHeight: FIRST, blocks };
}
// the round's committee time just after block `at - 5`'s time, so `at` is its beacon block (the first whose MTP passes it)
const roundWithBeaconAt = (at) => ({ ...contractFor([b32(1), b32(2)], 3000n, ['wss://r.example']), censusConfirmations: 1,
  committeeTimeMs: BigInt(timeOf(at - 5)) * 1000n - 1000n });
const pubTx = (c) => spend(7, [publicationOutput(roundId(c))]);
// a view that grows: `views[i]` at the i-th look, the last one repeated
const growing = (views) => { let i = 0; return async () => views[Math.min(i++, views.length - 1)]; };
const fakeRpc = ({ refuse = [] } = {}) => {
  const calls = [];
  const rpc = async (method, [txid, { fee_rate }]) => {
    calls.push({ method, txid, rate: fee_rate });
    if (refuse.includes(fee_rate)) throw new Error(`Insufficient total fee at ${fee_rate}`);
    return { txid: `bumped-to-${fee_rate}-${'0'.repeat(40)}` };
  };
  return { rpc, calls };
};
const quiet = { sleep: async () => {}, sleepMs: 0 };

test('beaconBlockIn: the first block whose median time past passes committee time; none when no block does', () => {
  const c = roundWithBeaconAt(30);
  assert.equal(beaconBlockIn(c, chain(40)), 30);
  assert.equal(beaconBlockIn(c, chain(30)), null, 'the chain stops one block short of it');
  assert.equal(beaconBlockIn(roundWithBeaconAt(20), chain(40)), 20);
  assert.equal(beaconBlockIn({ ...c, committeeTimeMs: 0n }, chain(40)), 10, 'any time: the first block with eleven below it');
  assert.equal(beaconBlockIn(c, chain(5)), null, 'too few blocks for a median');
});

test('unconfirmed: no beacon is named and each new block doubles the fee, 2 -> 4 -> 8; then a publication below the beacon succeeds', async () => {
  const c = roundWithBeaconAt(30);
  const { rpc, calls } = fakeRpc();
  const logs = [];
  const got = await awaitPublishedBeacon({ contract: c, txid: 'aa'.repeat(32), rpc, ...quiet, log: (s) => logs.push(s),
    view: growing([chain(20), chain(21), chain(22), chain(24, { 23: [pubTx(c)] }), chain(31, { 23: [pubTx(c)] })]) });
  assert.deepEqual(calls.map((x) => x.rate), [4, 8], 'one raise per block that came without it, doubling');
  assert.equal(calls[0].txid, 'aa'.repeat(32));
  assert.equal(calls[1].txid, calls[0].txid.replace(/^.*$/, `bumped-to-4-${'0'.repeat(40)}`), 'the next raise bumps the replacement');
  assert.equal(got.ok, true);
  assert.equal(got.publishedAt, 23);
  assert.equal(got.named.height, 30);
  assert.ok(got.named.height > got.publishedAt, 'the beacon is above the publication');
  assert.equal(got.txid, `bumped-to-8-${'0'.repeat(40)}`, 'the txid after the raises');
  assert.ok(logs.some((l) => /fee raised 2 -> 4 sat\/vB/.test(l)) && logs.some((l) => /fee raised 4 -> 8 sat\/vB/.test(l)));
});

// TESTNET4'S EMPTY BLOCKS (measured 2026-10-12, 156204-156209: coinbase only, 20 min apart): no fee raise for them; the
// first block that took others' transactions without this one raises it
test('a coinbase-only block raises no fee; a block that took others\' transactions without it does', async () => {
  const c = roundWithBeaconAt(30);
  const { rpc, calls } = fakeRpc();
  const logs = [];
  const empty = [20, 21, 22];
  await awaitPublishedBeacon({ contract: c, txid: 'aa'.repeat(32), rpc, ...quiet, log: (s) => logs.push(s),
    view: growing([chain(20, {}, { empty }), chain(21, {}, { empty }), chain(22, {}, { empty }), chain(23, {}, { empty }), chain(24, {}, { empty }),
      chain(26, { 25: [pubTx(c)] }, { empty }), chain(31, { 25: [pubTx(c)] }, { empty })]) });
  assert.deepEqual(calls.map((x) => x.rate), [4], 'blocks 20-22 came empty: no raise; 23 took others\' transactions: one raise');
});

test('a raise the node refuses is doubled again at once, up to the cap of 100', async () => {
  const c = roundWithBeaconAt(30);
  const { rpc, calls } = fakeRpc({ refuse: [4, 8] });
  const logs = [];
  await awaitPublishedBeacon({ contract: c, txid: 'aa'.repeat(32), rpc, ...quiet, log: (s) => logs.push(s), maxLooks: 3,
    view: growing([chain(20), chain(21), chain(24, { 22: [pubTx(c)] }), chain(31, { 22: [pubTx(c)] })]) }).catch(() => {});
  assert.deepEqual(calls.map((x) => x.rate), [4, 8, 16], 'refused at 4 and 8, taken at 16 - in the same block');
  assert.ok(logs.some((l) => /fee raise to 4 sat\/vB was refused/.test(l)));
  const capped = fakeRpc();
  await awaitPublishedBeacon({ contract: c, txid: 'aa'.repeat(32), rpc: capped.rpc, ...quiet, log: () => {}, feeRate: 40, maxLooks: 4,
    view: growing([chain(20), chain(21), chain(22), chain(23)]) }).catch(() => {});
  assert.deepEqual(capped.calls.map((x) => x.rate), [80, 100], '40 -> 80 -> the cap, and no raise past it');
  const allRefused = fakeRpc({ refuse: [80, 100] });
  await awaitPublishedBeacon({ contract: c, txid: 'aa'.repeat(32), rpc: allRefused.rpc, ...quiet, log: () => {}, feeRate: 40, maxLooks: 2,
    view: growing([chain(20), chain(21)]) }).catch(() => {});
  assert.deepEqual(allRefused.calls.map((x) => x.rate), [80, 100], 'refused up to the cap: it stops there');
});

test('the beacon block before the publication, or at or below its block: dead, in its own words', async () => {
  const c = roundWithBeaconAt(30);
  const tag = toHex(roundId(c)).slice(0, 16);
  // the fcb15cca shape: the beacon block came while the publication was unconfirmed
  const never = await awaitPublishedBeacon({ contract: c, txid: 'aa'.repeat(32), rpc: fakeRpc().rpc, ...quiet, log: () => {},
    view: growing([chain(29), chain(31)]) });
  assert.deepEqual([never.ok, never.dead, never.beaconAt, never.publishedAt], [false, true, 30, null]);
  assert.equal(never.why, `round ${tag}'s beacon block 30 came while its publication ${never.txid.slice(0, 16)} was unconfirmed: it is not a published round`);
  // published in the beacon block itself, and above it
  for (const at of [30, 31]) {
    const late = await awaitPublishedBeacon({ contract: c, txid: 'aa'.repeat(32), rpc: fakeRpc().rpc, ...quiet, log: () => {},
      view: growing([chain(33, { [at]: [pubTx(c)] })]) });
    assert.deepEqual([late.ok, late.dead, late.beaconAt, late.publishedAt], [false, true, 30, at]);
    assert.equal(late.why, `round ${tag} was published at ${at}, at or above its beacon block 30: it is not a published round`);
  }
});

test('running out of looks with neither a beacon above the publication nor a dead round throws', async () => {
  const c = roundWithBeaconAt(30);
  const tag = toHex(roundId(c)).slice(0, 16);
  await assert.rejects(awaitPublishedBeacon({ contract: c, txid: 'aa'.repeat(32), rpc: fakeRpc().rpc, ...quiet, log: () => {}, maxLooks: 3,
    view: growing([chain(20)]) }), new RegExp(`^Error: round ${tag}: neither a beacon above its publication nor a dead round after 3 looks$`));
  await assert.rejects(awaitPublishedBeacon({ contract: c, txid: 'aa'.repeat(32), rpc: fakeRpc().rpc, ...quiet, log: () => {}, maxLooks: 2,
    view: growing([chain(24, { 22: [pubTx(c)] })]) }), /after 2 looks/, 'published, its beacon block not yet come');
});
