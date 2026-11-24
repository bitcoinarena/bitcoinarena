// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-24 client a7 r1 #4 (P8, P4; gap in the #2420 fix, the #3350 class at POST /item-purchase and /donation-gift). handToSeats
// (item-buy.js:113) keeps a paid record as handed over when TWO seats answer 200 - counted per entry of the list as given (no dedup at all).
// game.nodes keeps every address that served the game (games.js, #3253), so one box behind two paths of a lobby link (http://liar.test/a,
// /b - #2652's setup) is two keeping seats. While the honest seat refuses for a moment (a 503 while it cannot read the federation), the
// liar's two 200s make keptBy stand: finishPurchase drops the kept record (paidRecordDropIf) and says "bought", resendPaidRecords has nothing
// left to hand again, and the paid item reaches no honest seat - the price is paid and the item never comes.
// SAFE: one box under two addresses is one keeping seat; with no second seat keeping it the record is kept for the next hand-over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handToSeats } from '../src/item-buy.js';

test('audit client a7 r1 #4: one box under two paths does not count as the two seats that must keep a paid record', async () => {
  const kept = [];
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.host === 'liar.test') return { ok: true, status: 200, text: async () => 'kept' };   // says kept, keeps nothing
    kept.push(u.host);
    return { ok: false, status: 503, text: async () => 'the federation could not be read' };
  };
  // control: the liar listed once is one keeping seat - the record stays for the next hand-over
  const once = await handToSeats({ seats: ['http://liar.test/a', 'http://s1.test'], door: 'item-purchase', body: '{}', fetch });
  assert.equal(once.keptBy, null);
  const got = await handToSeats({ seats: ['http://liar.test/a', 'http://liar.test/b', 'http://s1.test'], door: 'item-purchase', body: '{}', fetch });
  console.log('  FACTS a7-1-4:', JSON.stringify(got));
  assert.equal(got.keptBy, null, `one box under two paths counted as two keeping seats: the record is dropped though no honest seat keeps it (keptBy ${got.keptBy})`);
});
