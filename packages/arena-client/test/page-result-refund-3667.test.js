// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3667 (feedback #457): after a refunded 100 sat Up/Down order the result line read "No payout this round: your 99 sat stake came back
// · +100 sat into your wallet" - the stake lock (the order less its 1 % fee lock) and everything credited for the round, two sums in one
// sentence, while the wallet history said "Refund - 100 of 100 sat back". The line now names one amount the player can check: the whole
// order when more than the stake came back. It runs as the page has it (src/arena-ui/index.html ARENA_ROUND_RESULT_LINE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const a = HTML.indexOf('window.ARENA_ROUND_RESULT_LINE = '), b = HTML.indexOf('window.ARENA_ROUND_RESULT = ', a);
const line = new Function(`const sats = (msat) => { try { return (BigInt(msat || 0) / 1000n).toLocaleString('en-US') + ' sat'; } catch { return '? sat'; } };
  const big = (v) => { try { return BigInt(v || 0); } catch { return 0n; } }; const window = {}; ${HTML.slice(a, b)}; return window.ARENA_ROUND_RESULT_LINE;`)();

test('#3667 a refund of the whole order says one amount, the one credited', () => {
  const got = line({ stakeMsat: '99000', stake: { state: 'refunded' } }, 100000n);
  console.log('#3667 MEASURED stake 99000 + fee lock 1000, credited 100000:', JSON.stringify(got));
  assert.equal(got, 'No payout this round: your 100 sat order came back in full · +100 sat into your wallet');
  assert.ok(!/99 sat stake came back/.test(got), 'the stake lock alone is said as what came back');
  assert.equal(line({ stakeMsat: '99000', stake: { refused: true } }, 100000n),
    'Your entry was not taken: your 100 sat order came back in full · +100 sat into your wallet');
});

test('#3667 a stake back with nothing more credited is said as before', () => {
  assert.equal(line({ stakeMsat: '90000', stake: {} }, 90000n), 'No payout this round: your 90 sat stake came back · +90 sat into your wallet');
  assert.equal(line({ stakeMsat: '90000', stake: { refused: true } }, 0n), 'Your entry was not taken: your 90 sat stake came back');
  assert.equal(line({ stakeMsat: '4000', stake: { fee: true, state: 'lost' } }, 4000n), 'Your 4 sat fee lock came back · +4 sat into your wallet');
});
