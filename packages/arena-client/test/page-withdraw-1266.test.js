// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1266 (audit 4 #1257 CLIENT-1 follow-up): the round Withdraw collected the payout and stake into the round's lock wallet and paid from there,
// so a failed Lightning pay left them as e-cash in a wallet the page tidies away. index.html's window.ARENA_WITHDRAW is lifted out of the page by its
// text and run against stubs: what is owed goes into the player wallet, the player wallet is paid out, and the round wallet is only paid from when an
// older build left e-cash in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const START = '    window.ARENA_WITHDRAW = async function (invoice) {';

function withdraw({ inTabMsat = 0n, playerPay = { ok: false, why: 'the pay did not go through' } } = {}) {
  const { readFileSync } = globalThis.__fs;
  const html = readFileSync(PAGE, 'utf8');
  const at = html.indexOf(START); assert.ok(at > 0, 'the page holds window.ARENA_WITHDRAW');
  const end = html.indexOf('\n    };\n', at) + '\n    };\n'.length;
  const calls = [];
  const window = { ARENA_TRACK: () => {} };
  const ARENACLIENT = {
    lookOwed: async () => { calls.push('look'); return { payoutMsat: 978000n, stakeMsat: 980000n, refundMsat: 0n, inTabMsat, final: true }; },
    collectIntoPlayerWallet: async (o) => { calls.push(['into player', String(o.look && o.look.payoutMsat)]); return { collected: true, creditedMsat: 1958000n }; },
    collectAndWithdraw: async (o) => { calls.push(['round wallet', o.client]); return { withdraw: { ok: true, invoiceMsat: inTabMsat } }; },
    withdrawPlayerWallet: async () => { calls.push('pay player wallet'); return { ...playerPay, from: 'the player wallet' }; },
    withdrawLine: () => '', makeInvoice: async () => ({ ok: true, invoice: 'lnbcrt1' }),
  };
  const r = { roundIdHex: 'ab'.repeat(32), round: { federationId: new Uint8Array(32) }, invite: 'fed1x', seed: new Uint8Array(32) };
  const fn = pageFunction(PAGE, ['window', 'ARENACLIENT', 'newestKept', 'wallet', 'roundWallet', 'roundAsk', 'dropTabEmpty', 'paintWallet', 'vault', 'payoutAsking', 'console'],
    html.slice(at, end), 'return window.ARENA_WITHDRAW;')(window, ARENACLIENT, () => r, { connected: false }, async () => ({ client: 'ROUND-WALLET', LockClient: {} }),
    () => ({ round: r.round, roundId: new Uint8Array(32), seed: r.seed }), () => {}, () => {}, () => ({}), false, { log: () => {} });
  return { fn, calls, window };
}
globalThis.__fs = await import('node:fs');

test('#1266 the round Withdraw collects into the player wallet and pays that; a failed pay leaves the money there, not in the round wallet', async () => {
  const w = withdraw();
  const out = await w.fn('lnbcrt1958000');
  const intoRound = w.calls.filter((c) => Array.isArray(c) && c[0] === 'round wallet');
  const intoPlayer = w.calls.filter((c) => Array.isArray(c) && c[0] === 'into player');
  // an older build's e-cash in the round wallet: paid from there as before
  const old = withdraw({ inTabMsat: 5000n });
  await old.fn('lnbcrt5000');
  const facts = { calls: w.calls.map((c) => (Array.isArray(c) ? c[0] : c)), roundWalletCollects: intoRound.length, shown: out && out.from, olderBuildRoundWallet: old.calls.filter((c) => Array.isArray(c) && c[0] === 'round wallet').length };
  console.log('  FACTS #1266:', JSON.stringify(facts));
  assert.equal(intoPlayer.length, 1, 'what is owed was not collected into the player wallet');
  assert.equal(intoRound.length, 0, 'the round Withdraw still collected into the round wallet');
  assert.ok(w.calls.includes('pay player wallet'));
  assert.equal(out.from, 'the player wallet', 'the result shown is the player wallet\'s pay');
  assert.equal(facts.olderBuildRoundWallet, 1, 'e-cash an older build left in the round wallet is paid out from there');
});
