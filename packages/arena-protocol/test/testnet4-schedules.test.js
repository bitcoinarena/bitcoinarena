// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TESTNET4 SIGNALS AND VOTES A DAY (kanban #785, a tester 2026-10-28: "for Testnet you can set the signal and voting periods to 1 day
// for all types of proposals"): funding, fee and leaderboard proposals, and every class of the config ballot - mainnet as the spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUNDING_SCHEDULES, fundingScheduleFor, votePeriodOf } from '../src/funding.js';
import { SCHEDULES, REPEAL_SCHEDULES, CLASS } from '../src/ballot.js';
import { NETWORK_ID_TESTNET4, NETWORK_ID_REGTEST } from '../src/genesis-ids.js';

test('testnet4 runs a 144-block signal and a 144-block vote; other networks the spec', () => {
  assert.equal(fundingScheduleFor(NETWORK_ID_TESTNET4), FUNDING_SCHEDULES.testnet4);
  assert.equal(FUNDING_SCHEDULES.testnet4.signal, 144);
  assert.equal(FUNDING_SCHEDULES.testnet4.vote, 144);
  assert.equal(FUNDING_SCHEDULES.testnet4.season, 144);   // a bond a day old counts for a funding signal
  assert.equal(FUNDING_SCHEDULES.spec.season, 12960);
  assert.equal(fundingScheduleFor(NETWORK_ID_REGTEST), FUNDING_SCHEDULES.spec);
  assert.equal(fundingScheduleFor(null), FUNDING_SCHEDULES.spec);
  for (const k of [CLASS.DESIGN, CLASS.MONEY, CLASS.UPGRADE]) {
    assert.equal(SCHEDULES.testnet4[k].review, 144);
    assert.equal(SCHEDULES.testnet4[k].voting, 144);
    assert.equal(SCHEDULES.testnet4[k].cooldown, SCHEDULES.mainnet[k].cooldown);
  }
  assert.equal(REPEAL_SCHEDULES.testnet4.voting, 144);
  assert.equal(SCHEDULES.mainnet[CLASS.DESIGN].voting, 1440);
});

test('a passed testnet4 signal opens a vote of 144 blocks right after it', () => {
  const s = FUNDING_SCHEDULES.testnet4;
  const v = votePeriodOf({ proposal: { publishedHeight: 1000 }, signal: { state: 'passed' }, schedule: s });
  assert.ok(v, 'a vote period');
  assert.equal(v.from, 1000 + 144);
  assert.equal(v.until - v.from, 144);
});
