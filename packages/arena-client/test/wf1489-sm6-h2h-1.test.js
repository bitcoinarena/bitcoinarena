// kanban #1489 sm6-h2h-1: A HEAD-TO-HEAD MOVE'S SALT IS KEPT IN THE TAB ONLY AFTER THE SEATS ANSWERED THE ENTRY.
// index.html's own comment (HIDDEN_KEY): "a reload between entry and reveal must not lose the salt, or the move could never be
// shown and the entry forfeits". The join posts the entry - its commitment H(round || session key || move || salt) - to the
// seats through submitPick, and only once settlementSlots seats (or all of them) answered 201 does it call rememberHidden.
// Measured in the page (#1391): the entry is taken at ~2.8 s, up to 7.7 s / 22 s with a slow seat. A reload or a closed tab
// inside that wait leaves an entry at the seats (its stake lock already made) whose move nobody can ever reveal: FORFEIT,
// its stake into the opponent's pool.
// index.html's own hidden-move join slice and its rememberHidden/readHidden, lifted, with fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const STORE = "    const HIDDEN_KEY = 'arena.h2h.moves';";
const STORE_END = '    window.ARENA_HIDDEN_MOVES = readHidden;';
const { readFileSync } = await import('node:fs');
const HTML = readFileSync(PAGE, 'utf8');
const cut = (from, end) => { const a = HTML.indexOf(from); assert.ok(a > 0, from); const b = HTML.indexOf(end, a); assert.ok(b > a, end); return HTML.slice(a, b + end.length); };
const STORAGE_SLICE = cut(STORE, STORE_END);
const JOIN_SLICE = cut('      const hiding = hiddenFor(named.roundIdHex);',
  "        window.ARENA_HIDDEN = { round: named.roundIdHex, entryIdHex: sent.entryId, move: hidden.move };\n        return;\n      }");

test('an entry the seats hold has its move and salt in sessionStorage before the join waits on the seats', async () => {
  const kept = new Map();
  const sessionStorage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
  const window = { sessionStorage, ARENA_CURVE: {}, ARENA_ORDER_PRESSED_AT: 0 };
  const R = 'ab'.repeat(32), E = 'cd'.repeat(32);
  const nodes = ['http://s1', 'http://s2', 'http://s3', 'http://s4', 'http://s5', 'http://s6', 'http://s7'];
  const named = { roundIdHex: R, nodes, round: { settlementSlots: 7, entryCloseMs: 10_000_000n, gameId: new Uint8Array(32) } };
  const atSeats = [];
  let seatAnswered = null;
  const seatHasIt = new Promise((r) => { seatAnswered = r; });
  const ARENACLIENT = {
    hiddenMove: (move, random) => ({ move, salt: random(32) }),
    entryFor: () => ({ stakeMsat: 100000n }),
    fromHex: (h) => new Uint8Array(Buffer.from(h, 'hex')),
    toHex: (b) => Buffer.from(b).toString('hex'),
    moveCommitment: () => new Uint8Array(32).fill(7),
    roundEndMs: () => 10_030_000,
    // THE SEATS: the first takes the entry at once (201), the other six are still answering - a slow seat, a loaded host
    submitPick: ({ entry, nodes: ns, onEntry }) => {
      atSeats.push({ node: ns[0], commit: entry.commit });
      queueMicrotask(() => { if (onEntry) onEntry({ entryId: E, entries: [{ node: ns[0], status: 201 }] }); seatAnswered(); });   // 2.0's join passes no onEntry (#1391's early answer is 1.9's)
      return new Promise(() => {});
    },
  };
  const storage = pageFunction(PAGE, ['window'], [STORAGE_SLICE], 'return { readHidden, rememberHidden };')(window);
  const body = pageFunction(PAGE, ['window', 'ARENACLIENT', 'named', 'hiddenFor', 'random', 'crypto', 'seed', 'player', 'stake', 'claimKey', 'stakeLock',
    'donation', 'pageFrontendPk', 'roundWithId', 'performance', 'pressAt', 'rememberHidden'], [JOIN_SLICE], '})();', 'return (async () => {');
  const random = (n) => new Uint8Array(n).fill(3);
  const noEd25519 = { subtle: { generateKey: async () => { throw new Error('no Ed25519 here'); } } };
  body(window, ARENACLIENT, named, () => ({ round: R, move: 1 }), random, noEd25519, new Uint8Array(32), { pubkey: new Uint8Array(32), order: 0 }, null, null,
    { outpoint: 'x' }, { donationMsat: 0n }, () => null, { id: new Uint8Array(32) }, { now: () => 1 }, 0, storage.rememberHidden);
  await seatHasIt;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(atSeats.length, 1, 'the entry, with its commitment, went to the seats');
  // THE TAB DIES HERE (a reload, the tab closed, the phone's browser killed in the background): what survives is sessionStorage
  const after = storage.readHidden();
  assert.ok(after.some((h) => h.roundIdHex === R),
    `a seat holds the entry (its stake locked) and the tab kept no move or salt for round ${R.slice(0, 8)}: a reload now can never reveal it - FORFEIT (kept: ${JSON.stringify(after)})`);
});
