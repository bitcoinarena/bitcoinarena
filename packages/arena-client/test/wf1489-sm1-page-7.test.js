// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit (release 2026.1.9.29 step 0), area page, sm1-page-7 (SM-L2 collect record x SM-T2 round wallet; #3009 against #1265):
// A REFUND-ONLY ORDER'S RECORD IS CLOSED DONE WITH tabMsat '0' WHILE ITS ROUND WALLET WAS NEVER READ.
// #1265 made "a wallet not read is not empty": lookOwed answers inTabMsat null when the round wallet's balance could not be read, collectState reads
// null as not empty, and the record stays open. #3009's closeRefundOnly (index.html) closes a refund-only order's record by itself - bypassing
// collectState - and takes `look.inTabMsat === null` as empty: markCollectDone(.., { tabMsat: '0' }). An hour later tidyStorage's emptyWallet
// (every record of the wallet done with tabMsat '0') removes the round's lock wallet (arena.lockdb.<round16>.<secret16>.*) - with the e-cash a
// failed round Withdraw left in it, never read. (The older-records branch beside it, index.html "older round MARKED DONE: its stake was its whole
// refund", marks done after a collect without looking at inTabMsat at all.)
// Driven: index.html's orderKeyOf/refundOrderKeys/closeRefundOnly lifted by their text, page-lock.js markCollectDone and tidyStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import * as PL from '../src/page-lock.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const from = HTML.indexOf('    const orderKeyOf = (r) =>');
const fn = HTML.indexOf('    function closeRefundOnly(rec, look, credited) {', from);
const to = HTML.indexOf('\n    }\n', fn) + '\n    }\n'.length;
assert.ok(from > 0 && fn > from && to > fn, 'index.html holds orderKeyOf .. closeRefundOnly');
const SRC = HTML.slice(from, to);

const FED = 'ab'.repeat(32), RID = 'cd'.repeat(32), ENTRY = 'ef'.repeat(32);
const SEED = new Uint8Array(32).fill(0x33);
const lockDb = `arena.lockdb.${RID.slice(0, 16)}.${toHex(sha256(PL.lockSecretFor(SEED, fromHex(RID)))).slice(0, 16)}.`;

test('wf1489-sm1-page-7: a refund-only order whose round wallet could not be read (inTabMsat null) is not closed done with tabMsat 0, and its wallet is not tidied', () => {
  const store = new Map();
  const storage = { get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null, getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const session = new Map([['arena.market.picks', JSON.stringify([{ roundIdHex: RID, entryIdHex: ENTRY, unfilled: true, order: { index: 0 } }])]]);
  const window = { sessionStorage: { getItem: (k) => (session.has(k) ? session.get(k) : null) }, ARENA_MARKET_LINES: () => [] };
  // the round's lock wallet holds 5,000 sat a round Withdraw collected and could not pay out (kanban #1266); the record was kept two hours ago
  store.set(lockDb + 'notes', 'e-cash of this phrase in round cdcd, 5000000 msat');
  store.set(`arena.collect.${RID}.${toHex(SEED).slice(0, 16)}`, JSON.stringify({ roundIdHex: RID, seed: toHex(SEED), done: null, savedMs: Date.now() - 7200000 }));
  const notes = [];
  const stakeBack = new Map();
  const { closeRefundOnly } = pageFunction(PAGE, ['window', 'vault', 'ARENACLIENT', 'stakeBack', 'backKey', 'collectNote'], SRC, 'return { closeRefundOnly };')(
    window, () => storage, PL, stakeBack, (r) => r.roundIdHex + ':' + (r.order || 0), (k, s) => notes.push(k + ' ' + s));
  // THIS PASS'S LOOK: the stake came back earlier (its note: collected), no payout for an order that matched nobody, and the round wallet's
  // balance read failed (the federation did not answer withdrawableMsat): lookOwed's inTabMsat null - "not read is not empty" (#1265)
  const look = { payout: { state: 'none' }, stake: { state: 'collected', msat: 100000n }, payoutMsat: 0n, stakeMsat: 0n, refundMsat: 0n, owedMsat: 0n,
    inTabMsat: null, final: true, settled: false };
  const rec = { roundIdHex: RID, round: { federationId: fromHex(FED) }, seed: SEED, order: 0 };
  const byCollectState = PL.collectState(look).state;
  const closed = closeRefundOnly(rec, look, true);
  const kept = JSON.parse(store.get(`arena.collect.${RID}.${toHex(SEED).slice(0, 16)}`));
  PL.tidyStorage(storage, { seeds: [toHex(SEED)], current: toHex(SEED), federations: [FED] });
  const facts = { collectStateSays: byCollectState, closeRefundOnlyClosed: closed, recordDone: kept.done, roundWalletKept: store.has(lockDb + 'notes'), notes };
  console.log('  FACTS sm1-page-7:', JSON.stringify(facts));
  assert.equal(byCollectState, 'open', 'collectState itself keeps a look with an unread wallet open');
  assert.ok(!(kept.done && kept.done.tabMsat === '0'), `a record whose round wallet was never read was written done with tabMsat '0': ${JSON.stringify(facts)}`);
  assert.ok(facts.roundWalletKept, `the round wallet holding 5,000 sat never read was removed by the tidy: ${JSON.stringify(facts)}`);
});
