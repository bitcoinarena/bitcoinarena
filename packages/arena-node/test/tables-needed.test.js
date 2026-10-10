// TABLES A SLOT (kanban #293): the keeper opens as many rounds a slot as the tables in play now, plus a spare - read off a
// seat's own listing (its rows' `joined`), only this game's rounds, only the slots taking picks now and next.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tablesNeeded } from '../tools/round-2of2.mjs';

const NOW = 1791640000000;
const G = 'aa'.repeat(32);
const row = (closeIn, joined, game = G) => ({ game: { id: game }, entryCloseMs: String(NOW + closeIn), joined });

test('nobody playing: one table and the spare; two pairs and a lone player: three in play and the spare', () => {
  assert.equal(tablesNeeded([], NOW, { gameId: G }), 1);
  assert.equal(tablesNeeded([row(5000, 0), row(13000, 0)], NOW, { gameId: G, spare: 2 }), 2);
  const slot = [row(5000, 2), row(5000, 2), row(5000, 1), row(5000, 0)];
  assert.equal(tablesNeeded(slot, NOW, { gameId: G, spare: 1 }), 4);
  assert.equal(tablesNeeded(slot, NOW, { gameId: G, spare: 2 }), 5);
});

test('the busier of the slot taking picks and the next one counts; closed slots, far slots and other games do not', () => {
  const rows = [row(3000, 1), row(11000, 2), row(11000, 1), row(-2000, 2), row(-2000, 2), row(-2000, 2), row(40000, 2), row(3000, 2, 'bb'.repeat(32))];
  assert.equal(tablesNeeded(rows, NOW, { gameId: G, spare: 1 }), 3);
});

test('the keeper\'s count: at least 3 tables, and the busiest of the last 2 minutes plus the spare - it does not drop mid-match', async () => {
  const { tableCounter } = await import('../tools/round-2of2.mjs');
  const count = tableCounter({ min: 3, spare: 1, gameId: G });
  assert.equal(count([], NOW), 3, 'nobody: three tables ready');
  const five = [row(5000, 2), row(5000, 2), row(5000, 1)];
  assert.equal(count(five, NOW + 1000), 4, 'two pairs and a lone player: three in play and the spare');
  assert.equal(count([row(5000, 2)], NOW + 60000), 4, 'a minute later, quieter: the busiest of the last two minutes still counts');
  assert.equal(count([row(5000, 2)], NOW + 200000), 3, 'two quiet minutes later: back to one in play and the spare, at least three');
});
