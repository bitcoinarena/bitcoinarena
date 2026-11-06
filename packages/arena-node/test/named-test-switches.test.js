// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NAMED CLAIM'S REGTEST TEST SWITCHES (kanban #1044 B1 phase 4): the offence switch (test-named-offence.js) and regtest's own NAMED_CLAIM_HEIGHT
// (arena-lock.js). Off by default; read on regtest only; a seat started with either on any other network does not start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { namedOffenceSwitch, offTablePayouts, swappedRefundPayouts, OFF_TABLE_KEY } from '../src/test-named-offence.js';
import { namedClaimHeightOverride, namedClaimPoint, namedClaimsAt } from '../../arena-protocol/src/arena-lock.js';

const MAIN = new URL('../src/main.js', import.meta.url).pathname;

test('the offence switch: off unset, on for regtest, refused on any other network', () => {
  assert.equal(namedOffenceSwitch({}), null);
  assert.deepEqual(namedOffenceSwitch({ ARENA_TEST_NAMED_OFFENCE_FILE: '/x', ARENA_DONATION_NETWORK: 'regtest' }), { file: '/x' });
  assert.throws(() => namedOffenceSwitch({ ARENA_TEST_NAMED_OFFENCE_FILE: '/x', ARENA_DONATION_NETWORK: 'testnet4' }), /regtest test switch.*testnet4: refused/);
  assert.throws(() => namedOffenceSwitch({ ARENA_TEST_NAMED_OFFENCE_FILE: '/x' }), /no named network: refused/);
});

test('the height override: off unset, regtest only, a height or refused', () => {
  assert.equal(namedClaimHeightOverride({}), null);
  assert.equal(namedClaimHeightOverride({ ARENA_TEST_NAMED_CLAIM_HEIGHT: '400', ARENA_DONATION_NETWORK: 'regtest' }), 400);
  assert.throws(() => namedClaimHeightOverride({ ARENA_TEST_NAMED_CLAIM_HEIGHT: '400', ARENA_DONATION_NETWORK: 'testnet4' }), /refused/);
  assert.throws(() => namedClaimHeightOverride({ ARENA_TEST_NAMED_CLAIM_HEIGHT: '4x', ARENA_DONATION_NETWORK: 'regtest' }), /block height/);
});

test('the override moves regtest\'s point only, and only while it is set on regtest', () => {
  const saved = { h: process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT, n: process.env.ARENA_DONATION_NETWORK };
  try {
    delete process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT;
    assert.equal(namedClaimPoint('regtest'), 0);
    process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT = '400'; process.env.ARENA_DONATION_NETWORK = 'regtest';
    assert.equal(namedClaimPoint('regtest'), 400);
    assert.equal(namedClaimsAt('regtest', 399), false, 'below the height: stock LNv2');
    assert.equal(namedClaimsAt('regtest', 400), true, 'at the height: the Arena lock');
    assert.equal(namedClaimPoint('mainnet'), 0, 'another network keeps its own');
    assert.equal(namedClaimPoint('testnet4'), null);
    process.env.ARENA_DONATION_NETWORK = 'testnet4';
    assert.equal(namedClaimPoint('regtest'), 0, 'set off regtest it is not read');
  } finally {
    for (const [k, v] of [['ARENA_TEST_NAMED_CLAIM_HEIGHT', saved.h], ['ARENA_DONATION_NETWORK', saved.n]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('a seat started with either switch off regtest does not start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'named-switch-'));
  for (const sw of [{ ARENA_TEST_NAMED_OFFENCE_FILE: join(dir, 'f') }, { ARENA_TEST_NAMED_CLAIM_HEIGHT: '400' }]) {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, ARENA_DONATION_NETWORK: 'testnet4', ...sw };
    const r = spawnSync(process.execPath, [MAIN, '0', join(dir, 'seat.db')], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 2, `${JSON.stringify(sw)}: exit ${r.status} ${r.stderr.slice(-300)}`);
    assert.match(r.stderr, /regtest test switch, and this seat runs on testnet4: refused/);
  }
});

test('off-table payouts: the largest payout that is not a send goes to the test key, amounts unchanged', () => {
  const k = (b) => new Uint8Array(33).fill(b);
  const payouts = [{ payoutPk: k(1), msat: 5n }, { payoutPk: k(2), msat: 90n, sent: { paymentHash: 'aa' } }, { payoutPk: k(3), msat: 40n }];
  const out = offTablePayouts(payouts);
  assert.deepEqual(out.map((p) => p.msat), [5n, 90n, 40n]);
  assert.deepEqual(out[2].payoutPk, OFF_TABLE_KEY);
  assert.deepEqual(out[1].payoutPk, k(2));
  assert.equal(offTablePayouts([{ payoutPk: k(1), msat: 1n, sent: {} }]), null);
});

test('a swapped refund key: the first gateway send refunds to the test key, its amount, invoice and gateway unchanged; a plan with no send has none', () => {
  const k = (b) => new Uint8Array(33).fill(b);
  const sent = { paymentHash: 'aa', gatewayPk: '02' + 'bb'.repeat(32), expiration: 700 };
  const payouts = [{ payoutPk: k(1), msat: 5n }, { payoutPk: k(2), msat: 90n, sent }, { payoutPk: k(2), msat: 40n, sent: { ...sent, paymentHash: 'cc' } }];
  const out = swappedRefundPayouts(payouts);
  assert.deepEqual(out.map((p) => p.msat), [5n, 90n, 40n]);
  assert.deepEqual(out[1].payoutPk, OFF_TABLE_KEY);
  assert.deepEqual(out[1].sent, sent);
  assert.deepEqual([out[0].payoutPk, out[2].payoutPk], [k(1), k(2)]);
  assert.equal(swappedRefundPayouts([{ payoutPk: k(1), msat: 1n }]), null);
});

test('settle-hold (kanban #1044 hole 1): on for the named round only, read from the file, off unset or off regtest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-hold-'));
  const file = join(dir, 'offence.txt');
  const mod = new URL('../src/test-named-offence.js', import.meta.url).href;
  const held = 'ab'.repeat(32), other = 'cd'.repeat(32);
  const code = `import { writeFileSync } from 'node:fs'; const m = await import(${JSON.stringify(mod)});
    const id = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
    writeFileSync(${JSON.stringify(file)}, 'settle-hold ${held}\\n');
    console.log(JSON.stringify([m.settleHoldOn(id('${held}')), m.settleHoldOn(id('${other}')), m.sendHoldOn(id('${held}'))]));`;
  const run = (env) => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).stdout.trim());
  assert.deepEqual(run({ ARENA_TEST_NAMED_OFFENCE_FILE: file, ARENA_DONATION_NETWORK: 'regtest' }), [true, false, false]);
  assert.deepEqual(run({ ARENA_DONATION_NETWORK: 'regtest' }), [false, false, false]);
  assert.deepEqual(run({ ARENA_TEST_NAMED_OFFENCE_FILE: file, ARENA_DONATION_NETWORK: 'testnet4' }), [false, false, false]);
});
