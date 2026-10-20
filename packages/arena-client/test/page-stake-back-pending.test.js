// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STAKE OWED BACK SHOWS AS PENDING UNTIL IT IS COLLECTED (comment 583). The pending chip counted winnings only
// (/standing payouts); a stake coming back - the signer nodes' forfeit or the refund by the player's key - was on no chip
// until WINNINGS-AUTO collected it, and since 2e11b2ba no longer on the "Withdrawal available" line either. index.html's own
// lookThePayout and lookThePending run under the page's name (page-script.js) with fakes. Measured: a 98,000 msat stake owed
// back on a round not done, whose collect fails, shows as 98 sat pending; collected, it leaves pending (it is confirmed
// then); a done round adds nothing (2026-10-04 case); winnings owed are not counted a second time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pendingWindowLine, savedLockExpiration } from '../src/page-lock.js';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const cut = (from, end) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 40)}`); const b = HTML.indexOf(end, a); return HTML.slice(a, b + end.length); };
const PAYOUT = cut('    let payoutAskingSince = 0;', '\n      payoutAsking = false; payoutAskingSince = 0;\n      paintWallet();\n    }\n');
const PENDING = cut('    async function lookThePending() {', '\n      paintMoney();\n      } finally { st.busy = false; }\n    }\n');

const RID = 'e4'.repeat(32);
const look = (o = {}) => ({ payout: { state: 'none' }, stake: { state: 'owed', how: 'forfeit', msat: 98000n }, payoutMsat: 0n, stakeMsat: 98000n, refundMsat: 0n,
  owedMsat: 98000n, inTabMsat: 0n, final: false, settled: true, ...o });

function page({ record, theLook, collect }) {
  const store = new Map();
  const vault = () => ({ length: store.size, key: (i) => [...store.keys()][i], getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) });
  const marked = [];
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || { textContent: '', parentNode: { title: '' } }) };
  const window = { sessionStorage: { getItem: () => null }, ARENA_WALLET_BALANCE: { sats: 173, pending: 0 } };
  const ARENACLIENT = {
    savedCollects: () => [record], roundLocks: () => true, owedToLine: () => 'line', toHex: () => '00'.repeat(32),
    markCollectDone: (v, rid) => { marked.push(rid); record.done = { payout: 'line' }; },
    collectIntoPlayerWallet: collect, pendingWindowLine, savedLockExpiration,
  };
  const lookRound = async () => ({ look: theLook, held: true, LockClient: 'LC' });
  // since the collect walks every kept phrase's records (keptRecords) and runs each under its phrase (withRecordPhrase);
  // this test's one record is the tab's own
  record.own = true;
  const fns = pageFunction(PAGE, ['window', 'document', 'vault', 'ARENACLIENT', 'lookRound', 'roundAsk', 'newestKept', 'collectSeed', 'collectNote', 'lookSaid',
    'paintWallet', 'paintHistory', 'paintMoney', 'payoutAsking', 'fetch', 'keptRecords', 'withRecordPhrase', 'collectFailed', 'collectHeld'], [PAYOUT, PENDING], 'return { lookThePayout, lookThePending };')(
    window, document, vault, ARENACLIENT, lookRound, () => ({}), () => record, () => 'seed', () => {}, () => '', () => {}, () => {}, () => {}, false,
    async () => { throw new Error('no /standing in this test'); }, () => ({ collectable: [record], uncollectable: [] }), (r, fn) => fn(), new Map(), new Set());
  return { ...fns, window, marked };
}

test('a stake owed back on a round not done, its collect failing: 98 sat pending in the lobby', async () => {
  const record = { roundIdHex: RID, round: {}, done: null };
  const p = page({ record, theLook: look(), collect: async () => { throw new Error('the federation did not answer'); } });
  await p.lookThePayout();
  await p.lookThePending();
  assert.equal(p.marked.length, 0, 'not collected, not done');
  assert.equal(p.window.ARENA_PENDING_SATS, 98);
  assert.equal(p.window.ARENA_WALLET_BALANCE.pending, 98, 'the lobby\'s pending chip');
});

test('a refund by the player\'s key after expiry counts the same', async () => {
  const record = { roundIdHex: RID, round: {}, done: null };
  const p = page({ record, theLook: look({ stake: { state: 'owed', how: 'refund', msat: 98000n }, stakeMsat: 0n, refundMsat: 98000n }),
    collect: async () => { throw new Error('the federation did not answer'); } });
  await p.lookThePayout();
  await p.lookThePending();
  assert.equal(p.window.ARENA_PENDING_SATS, 98);
});

test('collected: the stake leaves pending (it is in the confirmed balance then), never shown twice', async () => {
  const record = { roundIdHex: RID, round: {}, done: null };
  let fail = true;
  const p = page({ record, theLook: look(), collect: async () => { if (fail) throw new Error('the federation did not answer'); return { collected: true, creditedMsat: 98000n }; } });
  await p.lookThePayout(); await p.lookThePending();
  assert.equal(p.window.ARENA_PENDING_SATS, 98);
  fail = false;
  await p.lookThePayout(); await p.lookThePending();
  assert.deepEqual(p.marked, [RID]);
  assert.equal(p.window.ARENA_PENDING_SATS, 0);
});

test('the owner\'s case: a round already done adds nothing to pending, whatever the last look owed', async () => {
  const record = { roundIdHex: RID, round: {}, done: { payout: 'Payout 98000 msat collected' } };
  const p = page({ record, theLook: look(), collect: async () => ({ collected: false }) });
  p.window.ARENA_WITHDRAWABLE = 0n;   // the round looked at once in this tab: a done record is not looked at again
  p.window.ARENA_OWED = look();
  await p.lookThePayout(); await p.lookThePending();
  assert.equal(p.window.ARENA_PENDING_SATS, 0);
});

test('winnings owed are not counted here: pending winnings come from the signer nodes\' /standing alone', async () => {
  const record = { roundIdHex: RID, round: {}, done: null };
  const p = page({ record, theLook: look({ payout: { state: 'owed', msat: 500000n }, payoutMsat: 500000n, stake: { state: 'lost', msat: 98000n }, stakeMsat: 0n, owedMsat: 500000n }),
    collect: async () => { throw new Error('the federation did not answer'); } });
  await p.lookThePayout(); await p.lookThePending();
  assert.equal(p.window.ARENA_PENDING_SATS, 0);
});
