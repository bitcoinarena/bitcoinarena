// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a44 refute 27 (#1641) - FAILS on 90d57151a: THE HONEST PATH. AN EXCHANGE OF A PHRASE NO TAB WILL EVER OPEN AGAIN IS STRANDED.
//
// A browser keeps two phrases of one player (arena.seeds = [P1, P2]; the page's combine treats every kept phrase no live tab holds as this
// player's own and drains its wallets into the tab's phrase - index.html combineIn/take, "any other is taken under its lock"). The player
// works in ONE tab. On P1 the tab hands 50 sat of P1's notes to a seat that answers late, then the tab is closed. The browser is opened
// again: the seed keeper gives the new (only) tab a free kept phrase - P2 (more wallet entries). Its combine drains P1's wallets into P2.
// Its ARENA_EXCHANGE_INTO resumes with phrase16 = P2, takeUnnamed = (arena.seeds.length <= 1) = false: P1's record (fromKey P1) is skipped,
// every time, forever - no tab will ever be opened on P1 while P2's one tab is the only one. The seat's e-cash for those 50 sat is never
// received anywhere (before #1641 this tab received it, into the same phrase the combine moves P1's money to), and after 10 minutes the
// handed notes are not taken back either. The fix's own comment relies on "its own tab, or the next tab opened on it" - a tab that never
// comes in the one-tab case. A free phrase (no live tab holds its Web Lock arena.phrase.<P1>) should be moved on as the combine does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeEcashInto, resumeEcashExchanges, readEcashTransfer, ECASH_EXCHANGE_PREFIX } from '../src/ecash-transfer.js';

const FROM = 'aa'.repeat(32), TO = 'bb'.repeat(32);
const P1 = '1111aaaa2222bbbb' + 'c'.repeat(48), P2 = '3333dddd4444eeee' + 'f'.repeat(48);
function shared() { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m }; }
const wallet = (name) => { const w = { name, received: [], sent: 0 };
  w.sendEcash = async (msat) => { w.sent += Number(msat); return JSON.stringify({ msat: Number(msat), ecash: `fedimint-${name}` }); };
  w.receiveEcash = async (e) => { w.received.push(e); return JSON.stringify({ state: 'Success', msat: 50000 }); };
  return w; };

test('one tab, two kept phrases: P1\'s handed exchange is never moved on once the only tab holds P2', async () => {
  const L = shared();
  L.setItem('arena.seeds', JSON.stringify([{ hex: P1 }, { hex: P2 }]));
  let seatAnswers = false;
  const fetcher = async (url, o = {}) => {
    if (!o.method) return new Response(JSON.stringify({ holds: { [TO]: '10000000' }, maxMsat: '10000000' }), { status: 200 });
    if (!seatAnswers) throw new Error('The operation was aborted due to timeout');
    return new Response(JSON.stringify({ ecash: 'fedimint-seat-answer', msat: '50000' }), { status: 200 });
  };
  const A = { [FROM]: wallet('P1-from'), [TO]: wallet('P1-to') };
  const t0 = Date.now();
  await exchangeEcashInto({ storage: L, from: FROM, to: TO, needMsat: 50000n, seats: ['http://seat.test'], walletFrom: A[FROM], walletTo: async () => A[TO], fetcher, nowMs: t0, timeoutMs: 30, phrase16: P1 });
  const key = [...L.m.keys()].find((k) => k.startsWith(ECASH_EXCHANGE_PREFIX));
  assert.equal(readEcashTransfer(L, key).state, 'handed', 'precondition: P1\'s notes are with the seat');
  // THE TAB IS CLOSED; THE BROWSER OPENED AGAIN: its one tab holds P2 (P1 is free: no tab holds it, the combine drains it into P2)
  seatAnswers = true;
  const B = { [FROM]: wallet('P2-from'), [TO]: wallet('P2-to') };
  const keptSeeds = JSON.parse(L.getItem('arena.seeds')).length;
  const rows = [];
  for (const later of [60000, 3600000, 86400000]) {   // a minute, an hour, a day later: every exchange this tab asks for resumes first
    rows.push(...await resumeEcashExchanges({ storage: L, keys: [...L.m.keys()], walletFor: async (fid) => B[fid], fetcher, seats: [],
      nowMs: t0 + later, phrase16: P2.slice(0, 16), takeUnnamed: keptSeeds <= 1 }));
  }
  const facts = { rows, record: readEcashTransfer(L, key) && readEcashTransfer(L, key).state, received: [...A[TO].received, ...B[TO].received, ...A[FROM].received, ...B[FROM].received] };
  console.log('  FACTS a44-refute-27-1:', JSON.stringify(facts));
  assert.ok(facts.received.length > 0 || L.getItem(key) === null,
    `the seat's answer for P1's 50 sat is never received and the handed notes never taken back - stranded while the browser's only tab holds P2: ${JSON.stringify(facts)}`);
});
