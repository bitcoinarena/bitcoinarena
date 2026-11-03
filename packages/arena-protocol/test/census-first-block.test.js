// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BOND STANDS UNTIL IT IS SPENT (§5A.2, kanban #820): a census that read only 2,016 blocks lost the seven guardians of federation 337ae01a at
// once, unspent and serving, and said nothing. Heights as measured on testnet4 2026-10-30.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { censusFirstBlock, CENSUS_WHOLE, CENSUS_LOOKBACK } from '../src/census.js';

const GUARDIANS_BONDED = 156037, MAC_BONDED = 156266;

test('from its height on, a testnet4 census reads every bond since the first block, however old', () => {
  const { fromHeight, firstBlock } = CENSUS_WHOLE.testnet4;
  assert.equal(firstBlock, 158052 - CENSUS_LOOKBACK, 'the window of the last census that held all seven: no other bond comes back');
  for (const h of [fromHeight, 158282, 158298, 200000]) assert.ok(censusFirstBlock(h, 'testnet4') <= GUARDIANS_BONDED, `census ${h}`);
  assert.ok(censusFirstBlock(158298, 'testnet4') <= MAC_BONDED, 'the test host seats do not follow');
});

test('below that height nothing moves: a posted round\'s census_root still derives', () => {
  const { fromHeight } = CENSUS_WHOLE.testnet4;
  assert.equal(censusFirstBlock(fromHeight - 1, 'testnet4'), fromHeight - 1 - CENSUS_LOOKBACK);
  assert.equal(censusFirstBlock(158053, 'testnet4'), 156037);
});

// EVERY NETWORK, ONE TABLE (kanban #925, spec ruling #1101 A): mainnet from genesis_height, regtest from block 0, no fallback to a window
test('regtest reads every bond since block 0, at any height: a season-old bond is still in', () => {
  for (const h of [100, 2016, 5000, 20000]) assert.equal(censusFirstBlock(h, 'regtest'), 0, `census ${h}`);
});
test('mainnet reads from its genesis_height, and refuses without it', () => {
  assert.equal(censusFirstBlock(900000, 'mainnet', { genesisHeight: 880000 }), 880000);
  assert.equal(censusFirstBlock(900000 + 12960 + 2016, 'mainnet', { genesisHeight: 880000 }), 880000, 'a bond a season old and more stays in');
  assert.throws(() => censusFirstBlock(900000, 'mainnet'), /genesis_height/);
});
test('a network with no row derives no census: no fallback to a window', () => {
  for (const n of [null, undefined, 'signet', 'testnet3', 'toString']) assert.throws(() => censusFirstBlock(5000, n), /no census rule/);
  assert.deepEqual(Object.keys(CENSUS_WHOLE).sort(), ['mainnet', 'regtest', 'testnet4']);
});

test('both of the node\'s census reads take it', () => {
  const src = readFileSync(new URL('../../arena-node/src/main.js', import.meta.url), 'utf8');
  assert.equal(src.match(/blocksOver\(call, censusFirstBlock\(/g).length, 3, 'the round\'s, the view\'s, and a census key\'s evidence');
  assert.doesNotMatch(src, /CENSUS_LOOKBACK/);
});
