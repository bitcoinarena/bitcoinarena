// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 CLIENT-4 (was CLIENT-3): revealsOfRound merges every seat's /reveals by entry, last answer wins, nothing checked. The page (index.html
// `reveals`, then `provisional`) shows the head-to-head verdict from these two moves before any seat signs, and keeps them once two are
// held. One seat that answers last with the opponent's move changed makes an honest winner read "a loss" (or a loser "a win").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealsOfRound } from '../src/head-to-head.js';

const ME = 'aa'.repeat(32), THEM = 'bb'.repeat(32);
test('wf1489-client-4: one seat answering last with another move for an entry does not overwrite what the other seats hold', async () => {
  // honest: I played 1 (paper), they played 0 (rock); the liar says they played 2 (scissors) and answers last
  const fetcher = async (url) => {
    const liar = url.startsWith('http://liar');
    if (liar) await new Promise((r) => setTimeout(r, 50));
    return { ok: true, json: async () => ({ reveals: [{ entry: ME, move: 1 }, { entry: THEM, move: liar ? 2 : 0 }] }) };
  };
  const got = await revealsOfRound({ roundIdHex: 'cc'.repeat(32), nodes: ['http://a', 'http://b', 'http://liar'], fetcher });
  const w = (got[ME] - got[THEM] + 3) % 3;   // the page's provisional rule: 1 = I win, 2 = they win
  console.log(`  FACTS merged reveals: mine ${got[ME]}, theirs ${got[THEM]} -> provisional verdict for me: ${w === 1 ? 'a win' : w === 2 ? 'a loss' : 'a draw'}`);
  assert.equal(got[THEM], 0, 'one seat (answering last) replaced the opponent\'s revealed move that two seats hold');
});
