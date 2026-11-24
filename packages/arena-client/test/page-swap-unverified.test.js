// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STAKE HELD IN ANOTHER FEDERATION IS SWAPPED IN, NOT ASKED AS A DEPOSIT (2026-10-20 17:3xZ, playtest: 200 sat in 4dc88be7, a 100 sat
// Up/Down order in a 337ae01a round showed "Not enough sats in your player wallet ... Deposit with Lightning?"). Two page rules, run on stubs:
// the deposit is no longer asked at the press when the player's other federations cover the stake, and a federation on the client's
// known-good list that this page could not verify yet (4dc88be7: today's rounds name an older census) may pay the swap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const cut = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, from); const b = HTML.indexOf(to, a); assert.ok(b > a, to); return HTML.slice(a, b + to.length); };
const R = '337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e', S = '4dc88be70830d3619fd8742eaf639ab297774850cc68a203aad5b10a21e1fe98';

test('no deposit asked at the press when another federation of the player holds the stake', async () => {
  const { joinFundingPlan } = await import('../src/page-lock.js');
  const src = cut('      const roundFedHex = ', 'const coveredElsewhere = !pressPlan.askEarly;');
  const run = (parts, stakeMsat) => new Function('window', 'named', 'console', 'ARENACLIENT', src + '; return coveredElsewhere;')(
    { ARENA_WALLET_BALANCE: { parts } }, { round: { federationId: Buffer.from(R, 'hex'), stakeMsat } }, { log: () => {} }, { joinFundingPlan });
  assert.equal(run([{ federation: R, sats: 0 }, { federation: S, sats: 200 }], 100000n), true, '200 sat in 4dc88be7 cover a 100 sat stake');
  assert.equal(run([{ federation: R, sats: 0 }, { federation: S, sats: 50 }], 100000n), false, '50 sat do not: the deposit is asked');
  assert.equal(run([{ federation: R, sats: 500 }], 100000n), true, 'the round\'s own wallet pays it: no deposit either (2026-10-22)');
  assert.equal(run([], 100000n), false);
});

// THE LIGHTNING SWAP IS GONE (bf1353a38, kanban #614: "Kein Lightning swap, sondern übertragen in die andere federation"): the money moves by an
// e-cash exchange with a seat (ARENA_EXCHANGE_INTO), its source the player's other federation with the most spendable sats - no status or
// known-good gate, so 4dc88be7 read "Not checked yet" pays all the same
test('the exchange source: the other federation with the most spendable sats, an unverified one too; none when none holds enough', () => {
  const src = cut('      const spendable = (p) => ', 'const from = src.federation;');
  const run = (parts, needMsat, to = R) => new Function('window', 'needMsat', 'to', src.replace(/\n\s*const from = src\.federation;$/, '') + '; return src.federation;')(
    { ARENA_WALLET_BALANCE: { parts } }, needMsat, to);
  assert.equal(run([{ federation: R, sats: 0 }, { federation: S, sats: 200, status: 'unverified' }], 100000n), S, '4dc88be7 today: unverified, it pays');
  assert.equal(run([{ federation: S, sats: 150 }, { federation: 'cd'.repeat(32), sats: 400 }], 100000n), 'cd'.repeat(32), 'the one holding the most');
  assert.equal(run([{ federation: S, sats: 200, merging: 150 }], 100000n).ok, false, 'sats still merging do not pay');
  assert.equal(run([{ federation: R, sats: 900 }, { federation: S, sats: 50 }], 100000n).ok, false, 'not the round\'s own, and 50 sat do not cover 100');
});
