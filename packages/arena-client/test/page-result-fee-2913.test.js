// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2913 (feedback #178, Itsmelee): a paid round's result line said "your 4 sat stake came back" for the 4 sat FEE lock, while the
// 90 sat stake was still in the federation. The line runs as the page has it (src/arena-ui/index.html ARENA_ROUND_RESULT_LINE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const a = HTML.indexOf('window.ARENA_ROUND_RESULT_LINE = '), b = HTML.indexOf('window.ARENA_ROUND_RESULT = ', a);
const line = new Function(`const sats = (msat) => { try { return (BigInt(msat || 0) / 1000n).toLocaleString('en-US') + ' sat'; } catch { return '? sat'; } };
  const big = (v) => { try { return BigInt(v || 0); } catch { return 0n; } }; const window = {}; ${HTML.slice(a, b)}; return window.ARENA_ROUND_RESULT_LINE;`)();

test('#2913 a returned fee lock is named the fee lock, never the stake', () => {
  assert.equal(line({ stakeMsat: '4000', stake: { fee: true, state: 'lost' } }, 4000n), 'Your 4 sat fee lock came back · +4 sat into your wallet');
  assert.equal(line({ stakeMsat: '4000', stake: { fee: true, refused: true } }, 4000n), 'Your entry was not taken: your 4 sat fee lock came back · +4 sat into your wallet');
});

test('#2913 the stake itself is still said as before', () => {
  assert.equal(line({ stakeMsat: '90000', stake: {} }, 90000n), 'No payout this round: your 90 sat stake came back · +90 sat into your wallet');
  assert.equal(line({ stakeMsat: '90000', stake: { refused: true } }, 0n), 'Your entry was not taken: your 90 sat stake came back');
  assert.equal(line({ payoutMsat: '180000', stakeMsat: '0', stake: {} }, 180000n), 'You won: 180 sat payout · +180 sat into your wallet');
});
