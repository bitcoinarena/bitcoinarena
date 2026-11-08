// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE TAKES A CONTRIBUTION SHARE ONLY WHERE MORE THAN HALF OF THE ROUND'S NODES NAME IT (spec §27A.4.2, kanban #1346).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contributionSharesAgreed } from '../src/donation-pay.js';

const R = '02' + 'aa'.repeat(32);
const answering = (byNode) => async (url) => {
  const node = url.split('/contribution-shares')[0];
  const a = byNode[node];
  if (a === undefined) throw new Error('connection refused');
  return { status: 200, json: async () => ({ shares: [{ recipient: R, shareBps: a }] }), text: async () => '' };
};
const nodes = ['http://s1', 'http://s2', 'http://s3', 'http://s4', 'http://s5', 'http://s6', 'http://s7'];

test('a share four of seven name stands; three of seven, or a split, does not', async () => {
  const four = await contributionSharesAgreed({ rid: 'ab', nodes, fetcher: answering({ 'http://s1': 250, 'http://s2': 250, 'http://s3': 250, 'http://s4': 250, 'http://s5': 0 }) });
  assert.equal(four.ok, true, four.why);
  assert.equal(four.shares.get(R), 250);
  const three = await contributionSharesAgreed({ rid: 'ab', nodes, fetcher: answering({ 'http://s1': 250, 'http://s2': 250, 'http://s3': 250 }) });
  assert.equal(three.ok, false);
  assert.match(three.why, /do not agree .*3 of 7 name 250 bps/);
  const split = await contributionSharesAgreed({ rid: 'ab', nodes, fetcher: answering({ 'http://s1': 250, 'http://s2': 250, 'http://s3': 250, 'http://s4': 500, 'http://s5': 500, 'http://s6': 500, 'http://s7': 0 }) });
  assert.equal(split.ok, false);
});
