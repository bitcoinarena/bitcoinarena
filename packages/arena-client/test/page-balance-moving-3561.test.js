// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MOVE ON ITS WAY STAYS IN THE BALANCE, AND ITS FEE HAS A ROW (kanban #3561, feedback #406/#426/#598, UI 759/763): "my wallet balance fell from
// 2,961 sats to 205 sats ... Federation b18947f0, which had read 2,806 sats at 09:14 UTC, read 0 sats at 10:03 UTC ... no withdrawal, move, stake or
// fee row"; the same report's debug at 13:48Z read 2,800 sat in 337ae01a. The evacuation out of a CRITICAL federation (migrateFromDraining) paid
// b18947f0's notes out through a gateway; the claim in 337ae01a was still pending, and the page summed only wallet balances - the sats were in
// neither. Its out row came only after the claim (a later page's resume writes only the in row), and the 161 sat of fees were written nowhere:
// 2,961 = 2,806 (b18947f0) + 155 (337ae01a); the move sent 2,645 (what the wallet could send after its fees), 155 + 2,645 = 2,800.
// Here: the same numbers, the claim held open. The out row is written with its fee as the payment leaves, movesInFlight names the leg, and the
// page's ARENA_SUM_BALANCES (lifted from index.html) still shows 2,800 sat - 2,645 of it moving - while the claim is pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { bech32Encode, convertBits } from '../../arena-protocol/src/bech32.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const OLD = 'b18947f0'.padEnd(64, 'a'), NEW = '337ae01a'.padEnd(64, 'c'), PHRASE = 'de'.repeat(32);

function bolt11For(amountMsat, n = 0) {
  const amount = amountMsat % 100n === 0n ? `${amountMsat / 100n}n` : `${amountMsat * 10n}p`;
  const ts = 1788700000 + n; const words = [];
  for (let i = 6; i >= 0; i--) words.push(Math.floor(ts / 32 ** i) % 32);
  const field = (type, bytes) => { const w = convertBits([...bytes], 8, 5, true); words.push(type, w.length >> 5, w.length & 31, ...w); };
  field(1, new Uint8Array(32).fill(0x70 + n)); field(23, new Uint8Array(32).fill(0x78));
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32Encode(`lnbcrt${amount}`, words);
}
function store() {
  const s = {};
  Object.defineProperties(s, {
    getItem: { value: (k) => (Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null) },
    setItem: { value: (k, v) => { s[k] = String(v); } },
    removeItem: { value: (k) => { delete s[k]; } },
    key: { value: (i) => Object.keys(s)[i] ?? null },
    length: { get: () => Object.keys(s).length },
  });
  return s;
}
const FEE = 161000n;
function wallets() {
  let bal = 2806000n, toBal = 155000n, n = 0; const inv = new Map();
  let land = null;
  // a listed gateway under the fee cap on both sides (2.0's moves pay only through one)
  const from = {
    gateways: async () => JSON.stringify(['https://gw.test']), gatewayFees: async () => JSON.stringify({ send: { ppm: 100, baseMsat: 0 }, receive: { ppm: 100, baseMsat: 0 } }),
    balanceMsat: async () => String(bal),
    withdrawableMsat: async () => String(bal > FEE ? bal - FEE : 0n),
    withdraw: async (invoice) => { const a = inv.get(invoice); bal -= a + FEE; return JSON.stringify({ state: 'Success', invoice_msat: String(a) }); },
  };
  const to = {
    gateways: async () => JSON.stringify(['https://gw.test']), gatewayFees: async () => JSON.stringify({ send: { ppm: 100, baseMsat: 0 }, receive: { ppm: 100, baseMsat: 0 } }),
    balanceMsat: async () => String(toBal),
    receive: async (msat) => { ++n; const invoice = bolt11For(BigInt(msat), n); inv.set(invoice, BigInt(msat)); return JSON.stringify({ invoice, operation: 'op' + n }); },
    // the claim is held open (the gateway / the federation slow across a seat roll) until the test lets it land
    awaitReceive: () => new Promise((r) => { land = () => { toBal += [...inv.values()].reduce((t, x) => t + x, 0n); r('Claimed'); }; }),
  };
  return { from, to, land: () => land && land(), fromBal: () => bal, toBal: () => toBal };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

// index.html's ARENA_SUM_BALANCES, lifted, over the two wallets
function sumOf(storage, w) {
  const a = PAGE.indexOf('      window.ARENA_SUM_BALANCES = () => summing || (summing = (async () => {');
  const end = '      })().finally(() => { summing = null; }));';
  const b = PAGE.indexOf(end, a) + end.length;
  assert.ok(a > 0 && b > a, 'ARENA_SUM_BALANCES not found in index.html');
  const window = { ARENA_WALLETS: new Map([[OLD, w.from], [NEW, w.to]]), ARENA_FED_LOADS: new Map(), ARENA_LOCK_WASM: async () => ({ default: async () => {} }) };
  const sessionStorage = { getItem: (k) => (k === 'arena.player.seed' ? PHRASE : null) };
  window.sessionStorage = sessionStorage;
  const ARENACLIENT = { ...PL, fromHex, ledgerFederations: () => [OLD, NEW], seedRecovers: () => false, issuingMsat: async () => 0n };
  const make = new Function('window', 'ARENACLIENT', 'sessionStorage', 'walletSeed', 'vault', 'lastBalance', 'console', 'setTimeout',
    `let summing = null;\n${PAGE.slice(a, b)}\nreturn window;`);
  return make(window, ARENACLIENT, sessionStorage, () => new Uint8Array(32), () => storage, () => {}, { log() {}, warn() {} }, () => 0);
}

test('#3561: an evacuation whose claim is still pending - the out row and its fee are written, and the balance does not drop', async () => {
  const L = store(); const w = wallets();
  const run = PL.migrateFromDraining({ from: w.from, to: w.to, record: { status: 'CRITICAL', successorId: NEW }, toFederationId: NEW,
    fromFederationId: fromHex(OLD), storage: L, phrase16: PHRASE.slice(0, 16) });
  await tick();
  assert.equal(w.fromBal(), 0n, 'the fake paid out');
  // the history: a row for what left, with its fee, before the claim
  const out = PL.ledgerRows(L, fromHex(OLD)).filter((r) => r.kind === 'moved-out');
  assert.equal(out.length, 1, 'no history row for the 2,806 sat that left b18947f0 while their claim is pending');
  assert.equal(out[0].msat, '2645000');
  assert.equal(out[0].feeMsat, '161000', 'the 161 sat fee of the move is written nowhere');
  // the leg on its way, named
  assert.equal(typeof PL.movesInFlight, 'function', 'no reader of the moves on their way');
  const legs = PL.movesInFlight(L, PHRASE.slice(0, 16));
  assert.equal(legs.length, 1); assert.equal(legs[0].to, NEW); assert.equal(legs[0].from, OLD);
  assert.equal(legs[0].msat, 2645000n); assert.equal(legs[0].beforeMsat, 2806000n);
  // the page's balance while the claim is pending: 2,800 sat, 2,645 of it moving - not 155
  const win = sumOf(L, w); await win.ARENA_SUM_BALANCES();
  assert.equal(win.ARENA_WALLET_BALANCE.sats, 2800, 'the balance dropped while the move was on its way: ' + JSON.stringify(win.ARENA_WALLET_BALANCE.parts));
  assert.equal(win.ARENA_WALLET_BALANCE.moving, 2645);
  const p = win.ARENA_WALLET_BALANCE.parts.find((x) => x.federation === NEW);
  assert.equal(p.moving, 2645);
  // moving sats are not spendable yet: a join's plan does not count them as the round federation's own
  assert.notEqual(PL.joinFundingPlan({ parts: win.ARENA_WALLET_BALANCE.parts, roundFederation: NEW, needMsat: 1000000n }).coveredBy, 'here');
  // the claim lands: the entry goes, the sum counts it once, one out row still
  w.land(); const done = await run;
  assert.equal(done.state, 'moved');
  assert.equal(PL.movesInFlight(L, PHRASE.slice(0, 16)).length, 0);
  const win2 = sumOf(L, w); await win2.ARENA_SUM_BALANCES();
  assert.equal(win2.ARENA_WALLET_BALANCE.sats, 2800); assert.equal(win2.ARENA_WALLET_BALANCE.moving, 0);
  assert.equal(PL.ledgerRows(L, fromHex(OLD)).filter((r) => r.kind === 'moved-out').length, 1, 'the out row was written twice');
  assert.equal(PL.ledgerRows(L, fromHex(NEW)).filter((r) => r.kind === 'moved-in').length, 1);
});

test('#3561: a leg written ahead of its payment (the paying wallet still holds the sats) is not counted twice', async () => {
  const L = store(); const w = wallets();
  // the receive leg kept before the send, the source not debited yet
  const made = JSON.parse(await w.to.receive('2645000'));
  L.setItem('arena.deposit.pending.' + NEW + '.' + made.operation, JSON.stringify([{ invoice: made.invoice, operation: made.operation, msat: '2645000', kind: 'move', beforeMsat: '2806000', row: { kind: 'moved-in', from: OLD }, phrase16: PHRASE.slice(0, 16) }]));
  const win = sumOf(L, w); await win.ARENA_SUM_BALANCES();
  assert.equal(win.ARENA_WALLET_BALANCE.sats, 2961);
  assert.equal(win.ARENA_WALLET_BALANCE.moving, 0);
});

test('#3561: a Move / join swap writes its out row with the fee once the payment left, before its claim ends', async () => {
  const L = store(); const w = wallets();
  const run = PL.swapForRound({ from: w.from, to: w.to, amountMsat: 1000000n, storage: L, fromFederationId: fromHex(OLD), toFederationId: fromHex(NEW),
    rows: ['moved-out', 'moved-in'], phrase16: PHRASE.slice(0, 16) });
  await tick();
  const out = PL.ledgerRows(L, fromHex(OLD)).filter((r) => r.kind === 'moved-out');
  assert.equal(out.length, 1, 'no out row while the swap\'s claim is pending');
  assert.equal(out[0].feeMsat, '161000');
  assert.equal(PL.movesInFlight(L, PHRASE.slice(0, 16)).length, 1);
  w.land(); const r = await run;
  assert.equal(r.ok, true); assert.equal(r.feeMsat, 161000n);
  assert.equal(PL.ledgerRows(L, fromHex(OLD)).filter((x) => x.kind === 'moved-out').length, 1);
});

test('#3561: the balance line says what is moving and a stuck merge plainly, with a retry', () => {
  assert.ok(/of it moving between your federations/.test(PAGE), 'the balance line does not say what is moving');
  assert.ok(/The merge is stuck - /.test(PAGE), 'a stuck merge is not said on the balance line');
  assert.ok(/b\.textContent = 'Merge again'/.test(PAGE), 'no retry beside a stuck merge');
  // a remembered balance of a phrase a live tab holds is never dropped by this tab's merge
  assert.ok(/if \(lockedNow\.has\('arena\.phrase\.' \+ x\.hex\.slice\(0, 16\)\)\) continue;/.test(PAGE), 'a live tab\'s remembered balance is dropped by the merge');
});
