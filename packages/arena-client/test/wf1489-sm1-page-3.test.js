// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1-page-3 (state-machine audit, SM-T2 x SM-L2: kept round wallets and the collect record): ONE ROUND, TWO PHRASES, ONE WALLET READ FOR BOTH.
// A round's own lock wallet is the phrase's and the round's (tabLockWallet: lockSecretFor(seed, round), arena.lockdb.<round16>.<sha(secret)16>), but
// index.html keeps the tab's round wallets in `roundWallets` keyed by the ROUND alone (roundWallet: `roundWallets.has(r.roundIdHex)`). A browser
// whose two phrases played the same round (two tabs are two players, ORDER-2116; or the second phrase's record collected here once its own tab
// closed - withRecordPhrase) has its second record looked at with the FIRST phrase's round wallet: lookOwed reads that wallet's balance as this
// record's `inTabMsat`. The first phrase's wallet is empty, so the second record is marked done with tabMsat '0' (collectState: the tab wallet
// read empty) and an hour later tidyStorage removes the second phrase's round wallet - with the e-cash a failed Withdraw left in it, never read.
// Driven here: the page's own roundAsk/holdRound/roundWallet/lookRound (lifted from index.html), then page-lock.js markCollectDone and tidyStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import * as PL from '../src/page-lock.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const from = HTML.indexOf('    const roundWallets = new Map();');
const to = HTML.indexOf('\n    }\n', HTML.indexOf('async function lookRound', from)) + '\n    }\n'.length;
assert.ok(from > 0 && to > from, 'index.html holds roundWallets .. lookRound');
const SRC = HTML.slice(from, to);

const FED = 'ab'.repeat(32), RID = 'cd'.repeat(32);
const P1 = new Uint8Array(32).fill(0x11), P2 = new Uint8Array(32).fill(0x22);
const lockDbOf = (seed) => `arena.lockdb.${RID.slice(0, 16)}.${toHex(sha256(PL.lockSecretFor(seed, fromHex(RID)))).slice(0, 16)}.`;

test('wf1489-sm1-page-3: a round\'s record of the second phrase is looked at with its own round wallet, not the first phrase\'s', async () => {
  const store = new Map();
  const storage = { get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null, getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  // THE TWO ROUND WALLETS: P1's empty; P2's holds 5,000 msat a Withdraw collected into it and could not pay out
  const inWallet = new Map([[toHex(P1), 0n], [toHex(P2), 5000000n]]);
  store.set(lockDbOf(P2) + 'notes', 'e-cash of phrase 2 in round cdcd');
  store.set(lockDbOf(P1) + 'notes', '');
  const opened = [];
  const ARENACLIENT = { toHex, fromHex,
    tabLockWallet: async (a) => { opened.push(toHex(a.seed).slice(0, 4)); const hex = toHex(a.seed);
      return { seedHex: hex, lockStatus: async () => '{"stored":null}', withdrawableMsat: async () => String(inWallet.get(hex)) }; },
    // a round whose payout and stake are settled and gone: what lookOwed answers there, its tab balance read from the client it is handed
    lookOwed: async (a) => ({ payout: { state: 'none' }, stake: { state: 'none' }, owedMsat: 0n, final: true, settled: true,
      inTabMsat: BigInt(await a.client.withdrawableMsat()), readFrom: a.client.seedHex, askedFor: toHex(a.seed) }) };
  const navigator = { locks: { request: (name, o, cb) => Promise.resolve(cb({ name })) } };
  const window = { ARENA_LOCK_WASM: async () => ({ LockClient: 'LC', default: async () => {} }) };
  const { lookRound } = pageFunction(PAGE, ['vault', 'window', 'ARENACLIENT', 'navigator', 'performance'], SRC, 'return { roundWallet, lookRound };')(
    () => storage, window, ARENACLIENT, navigator, { now: () => 60000 });
  const rec = (seed) => ({ roundIdHex: RID, round: { federationId: fromHex(FED) }, invite: 'inv', nodes: [], seed, order: 0 });
  // THE COLLECT PASS (index.html lookThePayout): the tab's own record, then the other kept phrase's in the same round
  const a = await lookRound(rec(P1));
  const b = await lookRound(rec(P2));
  // the records as saveCollect keeps them, kept two hours ago
  const old = Date.now() - 7200000;
  for (const s of [P1, P2]) store.set(`arena.collect.${RID}.${toHex(s).slice(0, 16)}`, JSON.stringify({ roundIdHex: RID, seed: toHex(s), done: null, savedMs: old }));
  const doneP2 = PL.markCollectDone(storage, RID, { payout: 'No payout', stake: null }, P2, 0, { look: b.look });
  PL.markCollectDone(storage, RID, { payout: 'No payout', stake: null }, P1, 0, { look: a.look });
  PL.tidyStorage(storage, { seeds: [toHex(P1), toHex(P2)], current: toHex(P1), federations: [FED] });
  const facts = { walletsOpened: opened, p2LookReadWalletOf: (b.look.readFrom || '').slice(0, 4), p2InTabMsat: String(b.look.inTabMsat), p2MarkedDone: doneP2,
    p2RoundWalletKept: store.has(lockDbOf(P2) + 'notes') };
  console.log('  FACTS sm1-page-3:', JSON.stringify(facts));
  assert.equal(b.look.inTabMsat, 5000000n, `the second phrase's record was looked at with the first phrase's round wallet (read ${b.look.inTabMsat} msat; its own holds 5000000): ${JSON.stringify(facts)}`);
  assert.ok(facts.p2RoundWalletKept, `the second phrase's round wallet, holding 5,000 sat never read, was removed by the tidy: ${JSON.stringify(facts)}`);
});
