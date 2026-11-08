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
    assert.deepEqual(a.shareAt(agreement, h, 'testnet4'), b.shareAt(agreement, h, 'testnet4'), `height ${h}`);
  }
  assert.equal(a.shareAt(agreement, t1 + CONTRIBUTION_LAG_BLOCKS - 1, 'testnet4').shareBps, 0, 'the 1,000th round is not read before the lag');
  assert.equal(a.shareAt(agreement, t1 + CONTRIBUTION_LAG_BLOCKS, 'testnet4').shareBps, 250, 'T1 at its round\'s height plus the lag');
  // entries through the project's own key count for the project, never for him
  const theirs = rounds.map((r) => ({ ...r, entries: r.entries.map((e) => ({ ...e, frontendPk: PROJECT })) }));
  const c = createContributionBook({ db: new DatabaseSync(':memory:'), accountsFor: async () => merged(theirs), heightOf });
  await c.refresh({});
  assert.equal(c.shareAt(agreement, t1 + 5000, 'testnet4').shareBps, 0);
});

test('a leave and a termination held in the book change the share; the first of each kind stands', async () => {
  const { contributionAgreementId } = await import('../../arena-protocol/src/contribution.js');
  const a = createContributionBook({ db: new DatabaseSync(':memory:'), accountsFor: async () => merged(rounds), heightOf });
  await a.refresh({});
  const id = contributionAgreementId(agreement);
  const vested = START + 999 + CONTRIBUTION_LAG_BLOCKS;
  assert.equal(a.shareAt(agreement, vested + 10, 'testnet4').shareBps, 250);
  assert.equal(a.addEnd('leave', { agreementId: id, atHeight: vested + 5 }, 'aa').fresh, true);
  assert.equal(a.addEnd('leave', { agreementId: id, atHeight: vested + 1 }, 'bb').fresh, false, 'a second leave changes nothing');
  assert.deepEqual(a.endsOf(toHex(id)), { leftAt: vested + 5, terminatedAt: null });
  assert.equal(a.shareAt(agreement, vested + 10, 'testnet4').state, 'tail');
  assert.equal(a.shareAt(agreement, vested + 10, 'testnet4').shareBps, 250, 'the tail pays what he had vested');
  assert.equal(a.shareAt(agreement, vested + 5 + 52560, 'testnet4').shareBps, 0, 'and ends');
  a.addEnd('termination', { agreementId: id, atHeight: vested + 8 }, 'cc');
  assert.equal(a.shareAt(agreement, vested + 10, 'testnet4').shareBps, 0, 'a termination ends it at once');
  assert.equal(a.ends().length, 2);
});

test('kanban #1349: regtest reads the test scale - T1 at 3 identities and a 6-block lag', async () => {
  const few = rounds.slice(0, 3);
  const a = createContributionBook({ db: new DatabaseSync(':memory:'), accountsFor: async () => merged(few), heightOf });
  await a.refresh({});
  assert.equal(a.shareAt(agreement, START + 2 + 5, 'regtest').shareBps, 0, 'the third round is not read before the 6-block lag');
  assert.equal(a.shareAt(agreement, START + 2 + 6, 'regtest').shareBps, 250, 'T1 at the third identity\'s round plus 6');
  assert.equal(a.shareAt(agreement, START + 10000, 'testnet4').shareBps, 0, 'testnet4 keeps 1,000 identities');
});

// KANBAN #1282 (§5A.10, the income term): the season's counted rounds as the book keeps them; two seats with the same rounds read the same income
test('#1282 the income term from the book: rounds with census height in the season, the same at two seats; a round outside it is not counted', async () => {
  const { incomeSeatSats, INCOME_SEASON_BLOCKS } = await import('../../arena-protocol/src/census-health.js');
  const seat = () => { const b = createContributionBook({ db: new DatabaseSync(':memory:'), accountsFor: async () => merged(rounds), heightOf }); b.keep(merged(rounds)); return b; };
  const a = seat(), b = seat();
  // rounds sit at census heights START .. START + 999, one each, 100 sat a stake (5 % node fee = 5 sat a round), census of 10
  const top = START + 999;
  const all = incomeSeatSats({ rounds: a.roundsBetween(top - INCOME_SEASON_BLOCKS, top), censusSize: 10 });
  const half = incomeSeatSats({ rounds: a.roundsBetween(START + 499, top), censusSize: 10 });
  const other = incomeSeatSats({ rounds: b.roundsBetween(top - INCOME_SEASON_BLOCKS, top), censusSize: 10 });
  console.log('  MEASURED #1282 book:', JSON.stringify({ rounds: a.roundsBetween(top - INCOME_SEASON_BLOCKS, top).length, all: String(all), half: String(half), otherSeat: String(other) }));
  assert.equal(all, 1000n * 5n / 10n);
  assert.equal(half, 500n * 5n / 10n, 'only the rounds above the window\'s start');
  assert.equal(other, all);
});
