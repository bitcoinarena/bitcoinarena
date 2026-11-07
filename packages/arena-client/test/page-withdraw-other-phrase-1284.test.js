// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1284 (audit 4 #1257 CLIENT-2): the round Withdraw took the newest kept record of ANY kept phrase. When that was another phrase's, it
// opened that phrase's round wallet and player wallet with no lock on the phrase (a second client beside the phrase's own tab) and paid its whole
// balance to this tab's invoice. index.html's window.ARENA_WITHDRAW and newestKept are lifted out of the page by their text and run against stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');
const slice = (start, end) => { const at = html.indexOf(start); assert.ok(at > 0, `the page holds ${start.trim()}`); return html.slice(at, html.indexOf(end, at) + end.length); };
const WITHDRAW = slice('    window.ARENA_WITHDRAW = async function (invoice) {', '\n    };\n');
const NEWEST = slice('    function newestKept(', '\n    }\n');

function page(records) {
  const calls = [];
  const window = { ARENA_TRACK: () => {} };
  const ARENACLIENT = {
    roundLocks: () => true,
    lookOwed: async () => { calls.push('look'); return { payoutMsat: 978000n, stakeMsat: 0n, refundMsat: 0n, inTabMsat: 0n, final: true }; },
    collectIntoPlayerWallet: async () => { calls.push('into player'); return { collected: true, creditedMsat: 978000n }; },
    collectAndWithdraw: async () => { calls.push('round wallet'); return { withdraw: null }; },
    withdrawPlayerWallet: async (o) => { calls.push(['pay player wallet', o.seed[0]]); return { ok: true, from: 'the player wallet' }; },
    withdrawLine: () => '', makeInvoice: async () => ({ ok: true, invoice: 'lnbcrt1' }),
  };
  const keptRecords = () => ({ collectable: records, uncollectable: [] });
  const roundWallet = async (r) => { calls.push(['round wallet open', r.seed[0]]); return { client: 'ROUND-WALLET', LockClient: {} }; };
  const fn = pageFunction(PAGE, ['window', 'ARENACLIENT', 'keptRecords', 'wallet', 'roundWallet', 'roundAsk', 'dropTabEmpty', 'paintWallet', 'vault', 'payoutAsking', 'console'],
    [NEWEST, WITHDRAW], 'return window.ARENA_WITHDRAW;')(window, ARENACLIENT, keptRecords, { connected: false }, roundWallet,
    (r) => ({ round: r.round, roundId: new Uint8Array(32), seed: r.seed }), () => {}, () => {}, () => ({}), false, { log: () => {} });
  return { fn, calls };
}
const rec = (seedByte, own, n) => ({ roundIdHex: String(n).repeat(64).slice(0, 64), round: { federationId: new Uint8Array(32) }, invite: 'fed1x', seed: new Uint8Array(32).fill(seedByte), own });

test('#1284 the round Withdraw never opens or pays another kept phrase\'s wallets; the tab\'s own phrase is withdrawn as before', async () => {
  // the newest kept record is phrase P's (0x50); the tab plays Q (0x51) and holds none of its own
  const other = page([rec(0x50, false, 1)]);
  const refused = await other.fn('lnbcrt978000');
  // Q holds an older record of its own beside P's newer one: Q's is withdrawn, P's is not touched
  const both = page([rec(0x51, true, 2), rec(0x50, false, 3)]);
  const mine = await both.fn('lnbcrt978000');
  const seeds = (calls) => calls.filter(Array.isArray).map((c) => c[0] + ' ' + c[1].toString(16));
  console.log('  FACTS #1284:', JSON.stringify({ otherOnly: { result: refused, calls: other.calls.length }, ownAndOther: { calls: seeds(both.calls), shown: mine && mine.from } }));
  assert.equal(other.calls.length, 0, `another phrase's wallets were opened: ${JSON.stringify(seeds(other.calls))}`);
  assert.equal(refused.ok, false);
  assert.match(refused.why, /another kept phrase/);
  assert.ok(seeds(both.calls).every((s) => s.endsWith(' 51')), `a wallet of another phrase was opened: ${seeds(both.calls)}`);
  assert.ok(seeds(both.calls).includes('pay player wallet 51'), 'the tab\'s own phrase was not withdrawn');
});
