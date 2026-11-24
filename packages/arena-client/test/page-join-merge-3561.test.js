// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A JOIN COMPLETES A MERGE THAT IS STILL PENDING BEFORE IT REFUSES (kanban #3561, feedback #406/#426/#428, UI 759): the round's federation
// (337ae01a) held 1,205 sat, all in another phrase's wallet of this browser still merging in; that wallet "did not open in 10 s", which bars it
// for 2 minutes (5 for the federation after a second miss), and the join's 45 s wait only read the balance again - it never asked the merge
// again, and refused with "your sats did not reach this game's federation (337ae01a) in 45 s - move them over with Move". The same wallet
// opened later in 1.3 s and held 1,205,120 msat. index.html's joinAfterMove, lifted, on a fake clock: a merge-covered join asks the merge
// of the round's federation once with force (the bars lifted, the pending open taken over), and joins once the sats are there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import * as PL from '../src/page-lock.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const TEXT = readFileSync(PAGE, 'utf8');
const A = TEXT.indexOf('      const JOIN_MOVE_WAIT_MS = 45000;');
const END = "        return answer(true, 'moving-funds', { coveredBy: plan.coveredBy, ownHere: plan.ownHere });\n      };";
const B = TEXT.indexOf(END, A) + END.length;

const FED = '337ae01a'.padEnd(64, 'c'), ROUND = 'ab'.repeat(32);

function run({ mergeLands }) {
  let clock = 1_000_000;
  const Date_ = { now: () => clock };
  const setTimeout_ = (fn, ms) => { clock += ms || 0; setImmediate(fn); return 0; };
  const asks = [], joins = [];
  const window = {
    ARENA_WALLET_BALANCE: { sats: 1205, merging: 1205, parts: [{ federation: FED, sats: 1205, merging: 1205, arriving: 0 }] },
    ARENA_MERGE_STATE: { [FED.slice(0, 16)]: { state: 'stuck', why: 'wallet fdd4e37a: the wallet did not open in 10 s', atMs: clock } },
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }),
    ARENA_BROWSER_STORE: () => ({}), sessionStorage: {},
    ARENA_SUM_BALANCES: async () => {}, ARENA_ROW_NODES: () => [],
    ARENA_LOBBY_ROWS: [{ id: ROUND, joinable: true, free: false, entryCloseMs: clock + 3600000, raw: { contract: { federationId: new Uint8Array(32) } } }],
    ARENA_LOBBY_ACT: { join: (id, o) => joins.push({ id, o }) },
    ARENA_MERGE_NOW: async (feds, ms, opts = {}) => {
      asks.push({ feds, ms, force: !!opts.force, seed: !!opts.seed, lock: !!opts.LockClient });
      if (mergeLands) { const p = window.ARENA_WALLET_BALANCE.parts[0]; p.merging = 0; window.ARENA_WALLET_BALANCE.merging = 0; window.ARENA_MERGE_STATE[FED.slice(0, 16)] = { state: 'merged' }; }
    },
  };
  const ARENACLIENT = { ...PL, toHex: (b) => Buffer.from(b).toString('hex'), tabSeed: () => new Uint8Array(32), rememberedInvite: () => 'inv', ECASH_EXCHANGE_PREFIX: 'x.' };
  const make = pageFunction(PAGE, ['window', 'ARENACLIENT', 'ORDER_CUTOFF_MS', 'Date', 'setTimeout', 'console', 'crypto', 'fetch'], [TEXT.slice(A, B)], 'return joinAfterMove;');
  const joinAfterMove = make(window, ARENACLIENT, 5000, Date_, setTimeout_, { log() {}, warn() {} }, globalThis.crypto, async () => ({}));
  const needMsat = 100000n;
  const plan = PL.joinFundingPlan({ parts: window.ARENA_WALLET_BALANCE.parts, roundFederation: FED, needMsat });
  assert.equal(plan.coveredBy, 'merge');
  let answered = null;
  joinAfterMove({ id: ROUND, r: { raw: { contract: { gameId: null, stakeMsat: needMsat } }, stakeSats: 100 }, fedHex: FED, needMsat, plan, holdUntilMs: 0, link: null,
    answer: (ok, why) => { answered = { ok, why }; } });
  const moving = window.ARENA_JOIN;
  return { window, asks, joins, moving, answered, done: async () => { for (let i = 0; i < 2000 && moving.moving !== false && !joins.length; i++) await new Promise((r) => setImmediate(r)); } };
}

test('a join covered only by a stuck merge asks that merge again, forced, and joins once the sats are there', async () => {
  const t = run({ mergeLands: true });
  assert.equal(t.answered.why, 'moving-funds');
  await t.done();
  assert.ok(t.asks.length >= 1, 'the join never asked the merge again - it only waited and refused');
  assert.deepEqual(t.asks[0].feds, [FED]);
  assert.equal(t.asks[0].force, true, 'the merge was asked without lifting its bars (a wallet that did not open stays barred 2 minutes)');
  assert.ok(t.asks[0].seed && t.asks[0].lock, 'the merge was asked without the seed and the lock client it opens wallets with');
  assert.notEqual(t.moving.state, 'refused', t.moving.why);
  assert.equal(t.joins.length, 1);
  assert.equal(t.joins[0].id, ROUND);
});

test('a merge that still does not land is asked once, and the join is refused by name as before', async () => {
  const t = run({ mergeLands: false });
  await t.done();
  assert.equal(t.asks.length, 1, 'asked ' + t.asks.length + ' times');
  assert.equal(t.moving.state, 'refused');
  assert.match(t.moving.why, /did not reach this game's federation/);
  assert.equal(t.joins.length, 0);
});
