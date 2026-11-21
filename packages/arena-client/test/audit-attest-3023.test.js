// kanban #3023: the card's test (audit attest r2-1 of 2026-11-19)
// Audit attest r2 #1: the page's GET /book reader (src/arena-ui/index.html ARENA_GAME.market.book) keeps the "fullest" answer of the
// round's signer seats, so ONE signer seat that pads its unsigned /book answer (more batches and levels) decides the book the Up/Down
// client prices its market sells and market buys from (src-v23.js bestOf / upCents -> asked(): limitCents). Safe behaviour asserted:
// with 4 of 5 signer seats answering the same honest book, the book handed to the client (and the market-sell limit it signs) is theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const html = readFileSync(join(root, 'src/arena-ui/index.html'), 'utf8');
const client = readFileSync(join(root, 'packages/btc-updown/client/src-v23.js'), 'utf8');

// the source text of a `<head>{ ... }` block, brace-matched
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
const NODES = KEYS.map((_, i) => `http://seat${i}.test`);

test('one signer seat\'s padded GET /book does not decide the book the Up/Down client signs its market sell from', async () => {
  // THE PAGE'S READER, as index.html has it (book: async (id) => { ... })
  const bookSrc = block(html, 'book: async (id) => {').replace(/^book: /, '');
  const honest = { batches: [{ k: 1, price: '48000' }], positions: [], levels: { buys: [{ outcome: 0, price: '48000', sharesMsat: '50000' }, { outcome: 1, price: '50000', sharesMsat: '50000' }], sells: [] } };
  // the lying seat: the same shape, more rows - a "last match" of 11c and only bids of 11c for Up
  const padded = { batches: Array.from({ length: 6 }, (_, k) => ({ k: k + 1, price: '11000' })), positions: [],
    levels: { buys: Array.from({ length: 6 }, () => ({ outcome: 0, price: '11000', sharesMsat: '5000' })), sells: [] } };
  const fetchStub = async (url) => {
    const seat = NODES.findIndex((n) => url.startsWith(n));
    const body = seat === 2 ? padded : honest;
    return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  const window = { ARENA_LOBBY_ROWS: [{ id: ROUND, contract: { nodes: KEYS.map((k) => Buffer.from(k, 'hex')) }, said: KEYS.map((key, i) => ({ node: NODES[i], key })) }] };
  const ARENACLIENT = { toHex: (b) => Buffer.from(b).toString('hex') };
  const readBook = new Function('window', 'ARENACLIENT', 'fetch', 'prepRound', 'AbortSignal', `return (${bookSrc});`)(window, ARENACLIENT, fetchStub, () => {}, { timeout: () => undefined });
  const book = await readBook(ROUND);

  // THE CLIENT'S PRICES from that book, as src-v23.js has them
  const TICK = 1000;
  const upSrc = client.match(/const upCents = \(\) => \{[^\n]*\};/)[0];
  const priceSrc = client.match(/const priceOf = \(i\) => [^\n]*;/)[0];
  const bestSrc = block(client, 'const bestOf = (side) => {');
  const prices = new Function('book', 'TICK', `${upSrc}\n${priceSrc}\n${bestSrc};\nreturn { upCents, priceOf, bestOf };`)(book, TICK);
  // a market sell of Up: at = best bid (else the last match), limit = max(1, at - 10) - what A.market.sell signs
  const bid = prices.bestOf(0).bid;
  const at = bid !== null ? bid : prices.priceOf(0);
  const sellLimitCents = Math.max(1, at - 10);

  assert.deepEqual(book, honest, `the book handed to the client is the one 4 of 5 signer seats answered, not seat 2's padded one (got ${book.batches.length} batches, Up bid ${bid}c)`);
  assert.equal(sellLimitCents, 38, `a market sell of Up is signed at the honest best bid less 10c (38c), not at ${sellLimitCents}c`);
});

