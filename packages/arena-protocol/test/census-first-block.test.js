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

test('another network keeps its window; the start of a chain is block 0', () => {
  assert.equal(censusFirstBlock(5000, 'regtest'), 5000 - CENSUS_LOOKBACK);
  assert.equal(censusFirstBlock(100, 'regtest'), 0);
  assert.equal(censusFirstBlock(100, 'mainnet'), 0);
});

test('both of the node\'s census reads take it', () => {
  const src = readFileSync(new URL('../../arena-node/src/main.js', import.meta.url), 'utf8');
  assert.equal(src.match(/blocksOver\(call, censusFirstBlock\(/g).length, 2);
  assert.doesNotMatch(src, /CENSUS_LOOKBACK/);
});
