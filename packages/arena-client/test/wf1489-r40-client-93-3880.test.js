// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40-client-93: ONE SEAT'S 200 TO POST /cancel MARKS A MARKET ORDER CANCELLED FOR GOOD.
// index.html ARENA_GAME.market.cancel posts the signed cancel to every seat of the order's round and takes it as done when ANY one
// answer is 2xx (`seats.some(cancelTaken)`): `x.order.cancelled = true` is written into the kept pick, the Up/Down client shows the
// order cancelled (no Cancel any more), and nothing asks the seats again. A 200 is one seat's unsigned word: a seat that answers 200
// and keeps nothing, while the book seats are busy (503 / no answer in 15 s), leaves the order resting in every honest seat's book -
// it fills, and the player who cancelled pays for a position they believe was withdrawn. Safe behaviour: the cancel stands only when
// enough of the round's seats took it (a book threshold, at least two seats); one seat's 200 against the others' failures is not
// a cancel and the kept order is not marked cancelled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const html = readFileSync(join(root, 'src/arena-ui/index.html'), 'utf8');

function block(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `found ${head}`);
  let i = src.indexOf('{', at + head.length - 1), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
  }
  throw new Error('unbalanced');
}

test('one seat\'s lone 200 to POST /cancel (the other 4 seats 503) does not mark the order cancelled', async () => {
  const src = block(html, 'cancel: async (entryIdHex) => {').replace(/^cancel: /, '');
  const ENTRY = 'ab'.repeat(32), ROUND = 'cd'.repeat(32);
  const nodes = ['http://liar.test', 'http://seat1.test', 'http://seat2.test', 'http://seat3.test', 'http://seat4.test'];
  const pick = { entryIdHex: ENTRY, roundIdHex: ROUND, nodes, order: { limitPrice: 48000 } };
  const remembered = [];
  const fetchStub = async (url) => (url.startsWith('http://liar.test')
    ? { ok: true, status: 200, text: async () => '' }
    : { ok: false, status: 503, text: async () => 'busy, try again' });
  const ARENACLIENT = { fromHex: (h) => Uint8Array.from(Buffer.from(h, 'hex')), orderCancelId: () => new Uint8Array(32) };
  const cryptoStub = { subtle: { importKey: async () => ({}), sign: async () => new ArrayBuffer(64) } };
  const cancel = new Function('readPicks', 'orderKeyOf', 'crypto', 'ARENACLIENT', 'fetch', 'rememberPick', 'AbortSignal', `return (${src});`)(
    () => [pick], async () => '00', cryptoStub, ARENACLIENT, fetchStub, (x) => remembered.push(JSON.parse(JSON.stringify(x))), { timeout: () => undefined });
  const got = await cancel(ENTRY);
  assert.equal(pick.order.cancelled, undefined, `the order was marked cancelled on one seat's 200 while ${got.seats.filter((s) => s.status !== 200).length} seats did not take the cancel`);
  assert.equal(got.ok, false, 'the cancel is not reported done on one seat\'s word');
});
