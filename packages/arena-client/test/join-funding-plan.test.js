// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND IS PAID FROM WHATEVER THE PLAYER HOLDS, IN ANY CONFIGURED FEDERATION, BEFORE ANY DEPOSIT IS ASKED (2026-10-22 playtest: 2,901
// sat shown with ⇄ - 2,201 in 4dc88be7, 700 in 337ae01a, part of it still merging in from another phrase's wallet - and a 100 sat Up/Down order
// in a 337ae01a round showed "Not enough sats ... Deposit with Lightning?"; "add a test that this can't happen again. Deposits from different
// federations must work with the configured app configuration"). For every app the Arena is configured with (apps.lock.json) and every
// ordered pair of the client's known-good testnet4 federations: money in the round's federation pays as it is, money still merging there is
// merged first and never asked as a deposit, money in another federation (held or merging) is swapped in, and only a player who holds too
// little anywhere is asked to deposit. And the page runs exactly this rule, at the press and before the funding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { joinFundingPlan, notSpendableYet } from '../src/page-lock.js';
import { KNOWN_GOOD_FEDERATIONS } from '../../arena-protocol/src/known-federations.js';

const APPS = Object.keys(JSON.parse(readFileSync(new URL('../../../apps.lock.json', import.meta.url), 'utf8')).apps);
const FEDS = Object.entries(KNOWN_GOOD_FEDERATIONS).filter(([, f]) => f.network === 'testnet4').map(([id]) => id);
const STAKE = 100000n;   // a testnet4 paid round: 100 sat

test('the configuration this covers: every configured app, every known testnet4 federation', () => {
  assert.ok(APPS.length >= 3, `apps: ${APPS.join(', ')}`);
  assert.deepEqual(FEDS.map((f) => f.slice(0, 8)).sort(), ['337ae01a', '4dc88be7', 'b18947f0']);
});

for (const app of APPS) {
  test(`${app}: a round in any configured federation is paid from what the player holds in any other, never asked as a deposit`, () => {
    for (const round of FEDS) {
      for (const other of FEDS.filter((f) => f !== round)) {
        const where = `${app}, round in ${round.slice(0, 8)}, money in ${other.slice(0, 8)}`;
        // held in the round's own federation
        assert.deepEqual(joinFundingPlan({ parts: [{ federation: round, sats: 700 }], roundFederation: round, needMsat: STAKE }),
          { ownHere: 700, coveredBy: 'here', mergeFirst: [], swapFrom: [], askEarly: false }, where);
        // still merging in there (another phrase's wallet in this browser, the merge not landed): merged first, no deposit
        const m = joinFundingPlan({ parts: [{ federation: round, sats: 700, merging: 700 }], roundFederation: round, needMsat: STAKE });
        assert.deepEqual([m.coveredBy, m.mergeFirst, m.askEarly], ['merge', [round.slice(0, 16)], false], where);
        assert.equal(notSpendableYet({ haveMsat: 0n, mergingSat: 700, needMsat: STAKE }), true, `${where}: said by name while the merge has not landed`);
        // held in another federation: swapped in
        const s = joinFundingPlan({ parts: [{ federation: other, sats: 2201 }], roundFederation: round, needMsat: STAKE });
        assert.deepEqual([s.coveredBy, s.swapFrom, s.askEarly], ['swap', [other.slice(0, 16)], false], where);
        // only merging in another federation, by its 16-hex key as the page keeps it: merged there (waited for), then swapped
        const sm = joinFundingPlan({ parts: [{ federation: other.slice(0, 16), sats: 2201, merging: 2201 }], roundFederation: round, needMsat: STAKE });
        assert.deepEqual([sm.coveredBy, sm.mergeFirst, sm.askEarly], ['merge', [other.slice(0, 16)], false], where);
        // too little anywhere: the deposit is asked at the press
        assert.equal(joinFundingPlan({ parts: [{ federation: round, sats: 40 }, { federation: other, sats: 50, merging: 50 }], roundFederation: round, needMsat: STAKE }).askEarly, true, where);
      }
    }
  });
}

test('the playtest itself: 2,201 sat in 4dc88be7, 700 in 337ae01a with ⇄, a 100 sat Up/Down order in 337ae01a', () => {
  const [A, B2] = ['337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e', '4dc88be70830d3619fd8742eaf639ab297774850cc68a203aad5b10a21e1fe98'];
  const plan = joinFundingPlan({ parts: [{ federation: B2, sats: 2201 }, { federation: A.slice(0, 16), sats: 700, merging: 700 }, { federation: 'b18947f085d40df3', sats: 0 }], roundFederation: A, needMsat: 101000n });
  assert.deepEqual(plan, { ownHere: 0, coveredBy: 'swap', mergeFirst: [], swapFrom: [B2.slice(0, 16)], askEarly: false },
    'his own 2,201 sat in 4dc88be7 pay by a swap at once - the 700 still merging are not waited for ("Placing a market order takes 10+ seconds")');
  assert.equal(notSpendableYet({ haveMsat: 0n, mergingSat: 700, needMsat: 101000n }), true);
  assert.equal(notSpendableYet({ haveMsat: 101000n, mergingSat: 700, needMsat: 101000n }), false, 'the merge landed: it pays');
  assert.equal(notSpendableYet({ haveMsat: 0n, mergingSat: 50, needMsat: 101000n }), false, 'merging too little: a deposit is the right ask');
});

test('the page runs this rule: at the press, before the swap (the merge), and before the funding (said by name, not a deposit)', () => {
  const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const bundle = readFileSync(new URL('../tools/bundle.js', import.meta.url), 'utf8');
  assert.match(bundle, /joinFundingPlan: joinFundingPlan, notSpendableYet: notSpendableYet/);
  assert.match(html, /const pressPlan = ARENACLIENT\.joinFundingPlan\(.*\n\s*const coveredElsewhere = !pressPlan\.askEarly;/);
  // the swap's place is the e-cash exchange's since kanban #614 (no Lightning swap at the press)
  const merge = html.indexOf('await window.ARENA_MERGE_NOW(plan.mergeFirst'), swap = html.indexOf('await window.ARENA_EXCHANGE_INTO({ to: here'), said = html.indexOf('ARENACLIENT.notSpendableYet({'),
    fund = html.indexOf('await ARENACLIENT.fundPlayerWallet(Object.assign({}, wallet, { early,');
  assert.ok(merge > 0 && swap > merge && said > swap && fund > said, 'merge, then the exchange, then the not-spendable check, then the funding');
  assert.match(html, /window\.ARENA_SHOW_NOTICE\('Not spendable yet', text\)/);
});

test('only a phrase this browser keeps counts as merging: a remembered balance of a phrase it no longer keeps is not money it can merge (measured in Chrome, UI 306)', () => {
  const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const a = html.indexOf("let keptHex = new Set([curHex]);"), b = html.indexOf("if (f && m > 0n) by.set(f, (by.get(f) || 0n) + m);", a);
  assert.ok(a > 0 && b > a);
  const src = html.slice(a, b);
  // Object.keys(L2) is what the page walks: a plain object stands in for localStorage
  const make = (o) => Object.assign(Object.create({ getItem(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; } }), o);
  const exec = (o, cur) => new Function('L2', 'curHex', src + 'if (f && m > 0n) by.set(f, (by.get(f) || 0n) + m); }\n; return [...by.entries()].map(([f, m]) => [f, String(m)]);')(make(o), cur);
  const F = '337ae01ad1e9bb35';
  assert.deepEqual(exec({ 'arena.seeds': JSON.stringify([{ hex: 'cd'.repeat(32) }]), [`arena.wallet.known.${F}.${'cd'.repeat(8)}`]: '700000' }, 'aa'.repeat(8)), [[F, '700000']], 'a kept phrase: merging');
  assert.deepEqual(exec({ 'arena.seeds': JSON.stringify(['cd'.repeat(32)]), [`arena.wallet.known.${F}.${'cd'.repeat(8)}`]: '700000' }, 'aa'.repeat(8)), [[F, '700000']], 'kept as a plain string');
  assert.deepEqual(exec({ 'arena.seeds': '[]', [`arena.wallet.known.${F}.${'ab'.repeat(8)}`]: '700000' }, 'aa'.repeat(8)), [], 'not kept: not merging');
  assert.deepEqual(exec({ [`arena.wallet.known.${F}.${'aa'.repeat(8)}`]: '700000' }, 'aa'.repeat(8)), [], 'this tab\'s own phrase is never counted twice');
});

test('spendable money first: no order waits for a merge while the round wallet or a swap from the player\'s own notes pays it (2026-10-22: "Placing a market order takes 10+ seconds")', () => {
  const [A, B2] = ['337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e', '4dc88be70830d3619fd8742eaf639ab297774850cc68a203aad5b10a21e1fe98'];
  const plan = (parts) => joinFundingPlan({ parts, roundFederation: A, needMsat: 101000n });
  assert.deepEqual(plan([{ federation: A, sats: 900, merging: 700 }]).mergeFirst, [], '200 sat of its own here pay it: nothing merged first');
  assert.equal(plan([{ federation: A, sats: 900, merging: 700 }]).coveredBy, 'here');
  assert.deepEqual([plan([{ federation: A, sats: 700, merging: 700 }, { federation: B2, sats: 500 }]).coveredBy, plan([{ federation: A, sats: 700, merging: 700 }, { federation: B2, sats: 500 }]).mergeFirst], ['swap', []]);
  assert.deepEqual([plan([{ federation: A, sats: 700, merging: 700 }, { federation: B2, sats: 50 }]).coveredBy, plan([{ federation: A, sats: 700, merging: 700 }, { federation: B2, sats: 50 }]).mergeFirst], ['merge', [A.slice(0, 16)]], 'only the merging money covers it: merged first');
  const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /if \(plan\.coveredBy === 'merge' && plan\.mergeFirst\.length && window\.ARENA_MERGE_NOW\)/, 'the page waits for a merge only then');
  assert.match(html, /if \(have < needMsat && window\.ARENA_SUM_BALANCES\)/, 'and reads every balance again only for a wallet short of the round');
});
