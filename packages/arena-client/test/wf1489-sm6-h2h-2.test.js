// kanban #1489 sm6-h2h-2: A HIDDEN MOVE THE TAB COULD NOT WRITE IS KEPT NOWHERE, AND ITS ENTRY FORFEITS WITHOUT ANY RELOAD.
// rememberHidden writes the move and its salt to sessionStorage and, when setItem throws (a full origin quota, a storage the
// browser refuses), says "kept for this page only" - but nothing keeps it: ARENA_GAME.reveal reads the move back only from
// sessionStorage (readHidden), so the reveal after entry close answers "this tab hid no move in that round" and the entry,
// already taken by the seats with its stake locked, is FORFEIT - in the same tab, with no reload.
// index.html's own rememberHidden / readHidden and ARENA_GAME.reveal, lifted, with a storage whose writes fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const cut = (from, end) => { const a = HTML.indexOf(from); assert.ok(a > 0, from); const b = HTML.indexOf(end, a); assert.ok(b > a, end); return HTML.slice(a, b + end.length); };
const STORAGE_SLICE = cut("    const HIDDEN_KEY = 'arena.h2h.moves';", '    window.ARENA_HIDDEN_MOVES = readHidden;');
const REVEAL_SLICE = cut('        reveal: async (id) => {', "          return { ok: seats.some((x) => x.status === 201 || x.status === 200), seats };\n        },");

test('a full sessionStorage at rememberHidden: the reveal still finds the move this page hid', async () => {
  const sessionStorage = { getItem: () => null, setItem: () => { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }, removeItem: () => {} };
  const window = { sessionStorage, ARENA_CURVE: {} };
  const { rememberHidden, readHidden } = pageFunction(PAGE, ['window'], [STORAGE_SLICE], 'return { rememberHidden, readHidden };')(window);
  const R = 'ab'.repeat(32), E = 'cd'.repeat(32);
  const posted = [];
  const ARENACLIENT = {
    identityProofFor: () => null,
    revealMove: async ({ entryIdHex, move, salt, nodes }) => { posted.push({ entryIdHex, move, salt }); return nodes.map((node) => ({ node, status: 201 })); },
  };
  const game = pageFunction(PAGE, ['window', 'ARENACLIENT', 'readHidden', 'crypto'], [REVEAL_SLICE], '};', 'return {')(window, ARENACLIENT, readHidden, globalThis.crypto);
  // THE JOIN'S END: the seats took the entry (its commitment and stake lock), the page keeps the move and salt
  rememberHidden({ roundIdHex: R, entryIdHex: E, move: 2, saltHex: '11'.repeat(32), nodes: ['http://s1', 'http://s2'], entryCloseMs: '1', gameId: '00'.repeat(32), endMs: '2', protocolVersion: 27 });   // a round below 28 is revealed at once (kanban #2561)
  // AFTER THE ENTRY CLOSE, in the same tab
  const got = await game.reveal(R);
  assert.equal(got.ok, true, `the reveal of a move this page hid a moment ago: ${got.why || JSON.stringify(got)} - the entry is FORFEIT`);
  assert.equal(posted.length, 1);
});
