// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE HISTORY LINE PER JOIN (the owner's playtest 2026-10-04 15:45, plan comment 220 accepted 2026-10-05): "One
// line: Stake round xxx -100 sat. The 100 is the stake plus the donation. No Donation row." saveLock writes two ledger rows
// for one join - the stake (stake + fee lock, 98 sat) and the donation paid in the same transaction (2 sat) - and the wallet
// history panel drew each as its own line. ledgerHistory folds a donation into its round's stake line, when drawing only: the
// stored ledger is not rewritten, so rows already saved read -100 sat with no migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ledgerHistory } from '../src/page-lock.js';

const R1 = '848a0677' + 'a'.repeat(56), R2 = '79b298fb' + 'b'.repeat(56);
// exactly the rows of the owner's screenshot, as saveLock and the deposit wrote them
const THE OWNER = [
  { atMs: 1791160000000, kind: 'deposit', msat: '250000', invoiceHash: 'ab' },
  { atMs: 1791166020000, kind: 'stake', round: R2, player: 'p1', entry: 'e2', msat: '98000' },
  { atMs: 1791166020001, kind: 'donation', round: R2, msat: '2000' },
  { atMs: 1791166120000, kind: 'stake', round: R1, player: 'p1', entry: 'e1', msat: '98000' },
  { atMs: 1791166120001, kind: 'donation', round: R1, msat: '2000' },
];

test('a stake and its donation are one history line: the owner\'s two rounds read -100 sat each, no Donation line', () => {
  const h = ledgerHistory(THE OWNER);
  assert.deepEqual(h.filter((r) => r.kind !== 'deposit').map((r) => [r.kind, r.round.slice(0, 8), r.msat]), [['stake', '79b298fb', '100000'], ['stake', '848a0677', '100000']]);
  assert.equal(h.filter((r) => r.kind === 'donation').length, 0, 'a Donation line is still drawn');
  // the stake line keeps its own time, round, entry (the replay click) and player
  const one = h.find((r) => r.round === R1);
  assert.deepEqual({ atMs: one.atMs, entry: one.entry, player: one.player }, { atMs: 1791166120000, entry: 'e1', player: 'p1' });
  // the stored rows are not touched
  assert.deepEqual(THE OWNER.map((r) => r.msat), ['250000', '98000', '2000', '98000', '2000']);
  assert.equal(THE OWNER.length, 5);
});

test('deposits, withdrawals and winnings are untouched; a donation with no stake row of its round stays its own line', () => {
  const rows = [...THE OWNER,
    { atMs: 1, kind: 'withdrawal', msat: '50000', state: 'Success' },
    { atMs: 2, kind: 'winnings', round: R1, msat: '180000' },
    { atMs: 3, kind: 'refund', round: R2, msat: '96000' },
    { atMs: 4, kind: 'donation', round: 'cc'.repeat(32), msat: '1334' },
    { atMs: 5, kind: 'donation', round: null, msat: '666' }];
  const h = ledgerHistory(rows);
  assert.deepEqual(h.filter((r) => ['deposit', 'withdrawal', 'winnings', 'refund'].includes(r.kind)).map((r) => [r.kind, r.msat]),
    [['deposit', '250000'], ['withdrawal', '50000'], ['winnings', '180000'], ['refund', '96000']]);
  assert.deepEqual(h.filter((r) => r.kind === 'donation').map((r) => r.msat), ['1334', '666'], 'a lone donation disappeared');
  // two donation rows of one round (two shares, or the LNURL path) both fold into its stake
  const two = ledgerHistory([{ atMs: 9, kind: 'stake', round: R1, entry: 'e1', msat: '96000' }, { atMs: 10, kind: 'donation', round: R1, msat: '1334' }, { atMs: 11, kind: 'donation', round: R1, msat: '666' }]);
  assert.deepEqual(two.map((r) => [r.kind, r.msat]), [['stake', '98000']]);
  assert.deepEqual(ledgerHistory([]), []);
  assert.deepEqual(ledgerHistory(undefined), []);
});

test('the wallet history panel draws ledgerHistory, not the raw rows', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url).pathname, 'utf8');
  // every federation's rows since 107d1140 (2026-10-20: "it doesn't show the complete history"), each through ledgerHistory
  assert.match(page, /return ARENACLIENT\.ledgerHistory\(ARENACLIENT\.ledgerRows\(st, f\)\)\.map\(/);
  assert.doesNotMatch(page, /ARENACLIENT\.ledgerRows\(st, f(ed)?\)\.(slice|map)\(/);
});
