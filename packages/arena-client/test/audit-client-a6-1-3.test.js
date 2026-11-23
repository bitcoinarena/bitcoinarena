// kanban #3352: the card's test (audit client a6-1-3)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-22b client r1 #3 (P4: one of n blocks all; no deadline): the market's Cancel (and Sell) in src/arena-ui/index.html
// (ARENA_GAME.market.cancel / .sell) POST the signed cancel to every seat of the order's round with a bare fetch - no signal, no timeout -
// and wait for ALL of them (Promise.all). One seat of the round that takes the POST and never answers holds the press for good: the
// honest seats' 200 is never read, the order is never marked cancelled in the tab (rememberPick), and the Up/Down client's Cancel button
// (disabled on the press, re-enabled only by draw() after the answer) stays dead until a reload. The same holds for a Sell's record.
// SAFE: the cancel answers within a bounded time when one seat stays silent, and counts the honest seat that took it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const from = '          cancel: async (entryIdHex) => {';
const a = HTML.indexOf(from);
const end = '            return { ok, seats };\n          },';
const SRC = HTML.slice(a + '          cancel: '.length, HTML.indexOf(end, a) + end.length - 1).trim().replace(/,$/, '');

test('audit client r1 #3: one silent seat does not hold a market order\'s Cancel for good', async () => {
  assert.ok(a > 0 && SRC.startsWith('async (entryIdHex) =>'), 'index.html holds the market cancel');
  const RID = 'ab'.repeat(32), EID = 'cd'.repeat(32);
  const pick = { entryIdHex: EID, roundIdHex: RID, order: {}, nodes: ['https://honest.example', 'https://silent.example'] };
  const remembered = [];
  const ARENACLIENT = { fromHex: (h) => Uint8Array.from(Buffer.from(h, 'hex')), orderCancelId: () => new Uint8Array(32) };
  const { privateKey } = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pk8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', privateKey)).toString('hex');
  const fetch = (url, o = {}) => (String(url).startsWith('https://silent.example')
    ? new Promise((_, no) => { if (o.signal) o.signal.addEventListener('abort', () => no(new Error('aborted'))); })   // takes the POST, never answers
    : Promise.resolve({ ok: true, status: 200, text: async () => '' }));
  const cancel = new Function('readPicks', 'orderKeyOf', 'rememberPick', 'ARENACLIENT', 'crypto', 'fetch', 'return (' + SRC + ');')(
    () => [pick], async () => pk8, (x) => remembered.push(x), ARENACLIENT, webcrypto, fetch);
  const BOUND_MS = 40000;
  let timer;
  const got = await Promise.race([cancel(EID), new Promise((r) => { timer = setTimeout(() => r('still waiting'), BOUND_MS); })]);
  clearTimeout(timer);
  console.log('  FACTS audit client r1 #3:', JSON.stringify({ got: got === 'still waiting' ? got : { ok: got.ok, seats: got.seats.map((s) => s.status) }, markedCancelled: !!pick.order.cancelled }));
  assert.notEqual(got, 'still waiting', `the Cancel press had no answer ${BOUND_MS / 1000} s after one seat of two stayed silent (the honest seat took it at once)`);
  assert.equal(got.ok, true);
});
