// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT'S BOOK OF COUNTED ROUNDS FOR CONTRIBUTION AGREEMENTS (spec §27A.4.2, kanban #1346).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { MILESTONES } from '../../arena-protocol/src/contribution.js';
import { createContributionBook, CONTRIBUTION_LAG_BLOCKS } from '../src/contribution-book.js';

const k = (s, i) => taggedHash(`TEST/${s}`, Uint8Array.of(i >> 8, i & 255));
const SITE = Uint8Array.of(0x03, ...k('site', 1)), PROJECT = toHex(Uint8Array.of(0x03, ...k('project', 0)));
const START = 1000;
const agreement = { recipientPk: Uint8Array.of(0x02, ...k('rk', 1)), siteKeys: [SITE], startHeight: START, base: { targetBps: 0, cliffBlocks: 0, days: 1 },
  tranches: MILESTONES.map((milestone) => ({ bps: 250, milestone, windowBlocks: 12960, expiresHeight: START + 157680 })), attributionFloorBps: 3000, tailBlocks: 52560 };
// 1,000 counted rounds, one new identity each through his link, at census heights START .. START + 999
const rounds = Array.from({ length: 1000 }, (_, i) => ({ roundId: toHex(k('round', i)), gameId: 'ab'.repeat(32), startMs: 1n, void: false,
  entries: [{ player: toHex(k('id', i)), roundKey: toHex(k('rkey', i)), stakeMsat: 100000n, payoutMsat: 0n, outcome: 'FAILED', score: 0, name: null, frontendPk: toHex(SITE) }] }));
const merged = (list) => ({ ok: true, rounds: list, evidence: list.map((r) => ({ roundId: r.roundId, contract: `c:${r.roundId}` })) });
const heightOf = (c) => START + rounds.findIndex((r) => `c:${r.roundId}` === c);

test('two seats with the same counted rounds answer the same share at every height; the share reads rounds 288 blocks back', async () => {
  const a = createContributionBook({ db: new DatabaseSync(':memory:'), accountsFor: async () => merged(rounds), heightOf });
  const b = createContributionBook({ db: new DatabaseSync(':memory:'), accountsFor: async () => merged([...rounds].reverse()), heightOf });
  assert.equal((await a.refresh({})).kept, 1000);
  // seat b reads the window in two halves, the second twice
  b.keep(merged(rounds.slice(500)));
  b.keep(merged(rounds.slice(0, 500)));
  assert.equal(b.keep(merged(rounds.slice(0, 500))), 0, 'a kept round is kept once');
  const t1 = START + 999;   // the 1,000th identity's round
  for (const h of [t1, t1 + CONTRIBUTION_LAG_BLOCKS - 1, t1 + CONTRIBUTION_LAG_BLOCKS, t1 + 10000]) {
    assert.deepEqual(a.shareAt(agreement, h, 'regtest'), b.shareAt(agreement, h, 'regtest'), `height ${h}`);
  }
  assert.equal(a.shareAt(agreement, t1 + CONTRIBUTION_LAG_BLOCKS - 1, 'regtest').shareBps, 0, 'the 1,000th round is not read before the lag');
  assert.equal(a.shareAt(agreement, t1 + CONTRIBUTION_LAG_BLOCKS, 'regtest').shareBps, 250, 'T1 at its round\'s height plus the lag');
  // entries through the project's own key count for the project, never for him
  const theirs = rounds.map((r) => ({ ...r, entries: r.entries.map((e) => ({ ...e, frontendPk: PROJECT })) }));
  const c = createContributionBook({ db: new DatabaseSync(':memory:'), accountsFor: async () => merged(theirs), heightOf });
  await c.refresh({});
  assert.equal(c.shareAt(agreement, t1 + 5000, 'regtest').shareBps, 0);
});
