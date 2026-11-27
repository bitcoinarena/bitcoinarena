// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40-client-91: BYPASS OF #3023 - THE BOOK'S "SIGNER SEATS" ARE WHATEVER KEY A /rounds ANSWER CLAIMS, COUNTED PER URL.
// index.html ARENA_GAME.market.book picks the round's signer seats as the URLs of row.said whose `key` is in contract.nodes. That `key`
// is the /rounds answer's own `node` field (lobby.js fetchLobby: said.push({ node, key: nodeKey, ... })) - pushed for EVERY listing,
// signed or not (only c.counts needs the signature). The #3023 majority then groups the /book answers per URL. One box named under
// several paths in a lobby link (the #3350/#3574 link model) answers /rounds claiming honest signer keys (no signature needed) and an
// identical padded /book on each path: its copies outnumber the honest signer seats and it sets the prices the Up/Down client signs
// its market orders at. Safe behaviour: a URL counts as a signer seat only with a listing that counts (signed by that key), and one key
// (or one host) is one vote - the book of the 5 honest signer seats is the one handed to the client.
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

const hex = (n) => n.toString(16).padStart(64, '0');
const ROUND = hex(7);
const KEYS = [1, 2, 3, 4, 5].map((n) => hex(100 + n));
const HONEST = KEYS.map((_, i) => `http://seat${i}.test`);
const EVIL = [1, 2, 3, 4, 5, 6].map((n) => `http://evil.test/p${n}`);

test('one box under six paths claiming signer keys unsigned does not outvote the 5 honest signer seats\' /book', async () => {
  const bookSrc = block(html, 'book: async (id) => {').replace(/^book: /, '');
  const honest = { batches: [{ k: 1, price: '48000' }], positions: [], levels: { buys: [{ outcome: 0, price: '48000', sharesMsat: '50000' }], sells: [] } };
  const padded = { batches: [{ k: 1, price: '11000' }], positions: [], levels: { buys: [{ outcome: 0, price: '11000', sharesMsat: '5000' }], sells: [] } };
  const fetchStub = async (url) => ({ ok: true, json: async () => JSON.parse(JSON.stringify(url.startsWith('http://evil.test') ? padded : honest)) });
  // the lobby's row as fetchLobby builds it: the honest signers' listings count (signed); the box's six listings claim signer keys and
  // carry no valid signature (counts: false) - fetchLobby keeps them in `said` all the same
  const said = [
    ...EVIL.map((node, i) => ({ node, key: KEYS[i % KEYS.length], counts: false, signed: false })),
    ...HONEST.map((node, i) => ({ node, key: KEYS[i], counts: true, signed: true })),
  ];
  const window = { ARENA_LOBBY_ROWS: [{ id: ROUND, contract: { nodes: KEYS.map((k) => Buffer.from(k, 'hex')) }, said }] };
  const ARENACLIENT = { toHex: (b) => Buffer.from(b).toString('hex') };
  const readBook = new Function('window', 'ARENACLIENT', 'fetch', 'prepRound', 'AbortSignal', `return (${bookSrc});`)(window, ARENACLIENT, fetchStub, () => {}, { timeout: () => undefined });
  const book = await readBook(ROUND);
  assert.deepEqual(book, honest, `the book handed to the Up/Down client is the 5 signed signer seats', not the one box's (got last match ${book && book.batches[0].price})`);
});
