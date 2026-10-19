// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BALANCE POPUP'S WORDS (kanban #545): each federation's health, a halted one's payback in blocks and time, the debug rows' capacity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federationHealth, humanDuration, medianBlockSeconds, reimbursementOf, capacityOf, explorerBaseFor } from '../src/balance-view.js';

test('health per status: OPEN healthy, DRAINING / CRITICAL moving to the successor, HALTED offline, CLOSED, unchecked', () => {
  assert.deepEqual(federationHealth({ status: 'OPEN' }), { level: 'ok', label: 'Healthy', note: '' });
  const d = federationHealth({ status: 'DRAINING', successorId: '4dc88be70830d361' });
  assert.equal(d.level, 'warn'); assert.match(d.note, /move to federation 4dc88be7/);
  assert.match(federationHealth({ status: 'CRITICAL' }).note, /a healthy federation/);
  assert.equal(federationHealth({ status: 'HALTED' }).level, 'bad');
  assert.equal(federationHealth({ status: 'CLOSED', successorId: 'ab'.repeat(32) }).label, 'Closed');
  assert.equal(federationHealth(null).label, 'Not checked yet');
});

test('a halted federation pays back at halt + abandon_blocks + claim_blocks: mainnet 288 + 216, testnet4 12 + 9', () => {
  const main = reimbursementOf({ status: { status: 'HALTED', height: 900000 }, tip: 900100, network: 'mainnet', secondsPerBlock: 600 });
  assert.equal(main.paysAt, 900504); assert.equal(main.blocks, 404); assert.equal(main.seconds, 242400);
  assert.equal(main.line, 'Paid back in about 404 blocks (~3 days), at block 900,504.');
  const tn4 = reimbursementOf({ status: { status: 'HALTED', height: 157064 }, tip: 157070, network: 'testnet4', secondsPerBlock: 1200 });
  assert.equal(tn4.paysAt, 157085); assert.equal(tn4.blocks, 15);
  assert.equal(tn4.line, 'Paid back in about 15 blocks (~5 h), at block 157,085.');
  assert.match(reimbursementOf({ status: { status: 'HALTED', height: 100 }, tip: 200, network: 'testnet4' }).line, /^Paid back now/);
  assert.equal(reimbursementOf({ status: { status: 'OPEN', height: 1 }, tip: 2 }).ok, false);
  assert.equal(reimbursementOf({ status: { status: 'HALTED', height: 1 }, tip: null }).ok, false, 'no tip read yet: no number');
});

test('the chain\'s pace: the median gap of the last blocks, held between 30 s and 2 h, 600 s with nothing to measure', () => {
  const at = (ts) => ts.map((timestamp) => ({ timestamp }));
  assert.equal(medianBlockSeconds(at([5000, 3800, 2600, 1400])), 1200);
  assert.equal(medianBlockSeconds(at([1000, 999, 998])), 30);
  assert.equal(medianBlockSeconds([]), 600);
  assert.equal(humanDuration(30 * 60), '30 min'); assert.equal(humanDuration(5 * 3600), '5 h'); assert.equal(humanDuration(4 * 86400), '4 days');
});

test('capacity for the debug rows, and the explorer this browser reads', () => {
  assert.deepEqual(capacityOf({ reserveSats: '650000', exposureCapSats: '150000', load: 4.3333 }), { reserve: 650000, cap: 150000, headroom: 0, load: 4.3333 });
  assert.deepEqual(capacityOf({ reserveSats: '108000', exposureCapSats: '150000', load: 0.72 }).headroom, 42000);
  assert.equal(explorerBaseFor('testnet4'), 'https://mempool.space/testnet4/api');
  assert.equal(explorerBaseFor('testnet4', 'off'), null);
  assert.equal(explorerBaseFor('mainnet', 'https://my.esplora/api/'), 'https://my.esplora/api');
});
