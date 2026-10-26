// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHEN THE NEXT ROUND STARTS, SAID PLAINLY (kanban #690: "clear timing - X hours, Y minutes and N confirmations"), and A ROUND AN APP MAY
// OFFER (2026-10-26: "RPS shows that is running a round but I think that is fake right? ... Fix it in the SDK")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRoundLine, inHoursMinutes } from '../src/next-round-line.js';
import { lobbyRowOffered } from '../src/lobby.js';

const at = (iso) => Date.parse(iso);
const NOW = at('2026-10-26T10:16:00Z');
const grid = (o) => ({ game: 'btc-updown-15m', firstWindowMs: String(at('2026-10-26T11:30:00Z')), lastCloseMs: String(at('2026-10-27T00:00:00Z')),
  committeeTimeMs: String(at('2026-10-26T10:54:17Z')), publication: { txid: 'ab', height: 157659, confirmations: 1, inMempool: false },
  beacon: { height: null, depth: 0, needed: 6 }, stage: 'waiting for the beacon block', ...o });

test('hours and minutes', () => {
  assert.equal(inHoursMinutes(2 * 3600000 + 14 * 60000), '2 h 14 min');
  assert.equal(inHoursMinutes(45 * 60000), '45 min');
  assert.equal(inHoursMinutes(20000), 'less than a minute');
});

test('before its committee block: the committee time plus 6 blocks, later than its first window', () => {
  const r = nextRoundLine({ grids: [grid()], game: 'btc-updown-15m', nowMs: NOW });
  assert.equal(r.text, 'Next round in 1 h 38 min (about 11:54 UTC) · its committee block is the first after 10:54 UTC, then 6 confirmations.');
});

test('the committee block confirming: N of 6, and the window when it is later', () => {
  const r = nextRoundLine({ grids: [grid({ beacon: { height: 157661, depth: 4, needed: 6 } })], game: 'btc-updown-15m', nowMs: NOW });
  assert.equal(r.text, 'Next round in 1 h 14 min (about 11:30 UTC) · its committee block has 4 of 6 confirmations.');
  const late = nextRoundLine({ grids: [grid({ firstWindowMs: String(NOW - 60000), beacon: { height: 157661, depth: 2, needed: 6 } })], game: 'btc-updown-15m', nowMs: NOW });
  assert.equal(late.text, 'Next round in 40 min (about 10:56 UTC) · its committee block has 2 of 6 confirmations.');
});

test('not mined yet; a posted grid and another game\'s are not named; the soonest first', () => {
  const unmined = nextRoundLine({ grids: [grid({ publication: { txid: 'ab', height: null, confirmations: 0, inMempool: true } })], game: 'btc-updown-15m', nowMs: NOW });
  assert.match(unmined.text, /its round table is waiting to be mined\.$/);
  assert.equal(nextRoundLine({ grids: [grid({ stage: 'posted' }), grid({ game: 'nextblock' })], game: 'btc-updown-15m', nowMs: NOW }), null);
  const two = nextRoundLine({ grids: [grid({ firstWindowMs: String(at('2026-10-26T23:45:00Z')) }), grid()], game: 'btc-updown-15m', nowMs: NOW });
  assert.equal(two.grid.firstWindowMs, String(at('2026-10-26T11:30:00Z')));
});

test('a live grid before one in no block and not in the mempool, the soonest to open first (2026-10-26: the line named a conflicted grid)', () => {
  const dead = grid({ firstWindowMs: String(at('2026-10-26T11:30:00Z')), publication: { txid: 'de', height: null, confirmations: 0, inMempool: false } });
  const pool = grid({ firstWindowMs: String(at('2026-10-26T13:15:00Z')), committeeTimeMs: String(at('2026-10-26T12:28:00Z')), publication: { txid: 'ee', height: null, confirmations: 0, inMempool: true } });
  const r = nextRoundLine({ grids: [dead, pool], game: 'btc-updown-15m', nowMs: NOW });
  assert.equal(r.grid.publication.txid, 'ee');
  assert.match(r.text, /waiting to be mined\.$/);
  assert.equal(nextRoundLine({ grids: [dead], game: 'btc-updown-15m', nowMs: NOW }).grid.publication.txid, 'de', 'named when nothing else is on its way');
});

test('an app is offered a free round, or a paid one a seat has drawn - not one no seat could draw', () => {
  assert.equal(lobbyRowOffered({ free: true, said: [{ committee: { drawn: false } }] }), true);
  assert.equal(lobbyRowOffered({ said: [{ committee: { drawn: false, why: 'this node has no chain view for that round' } }, { committee: { drawn: true } }] }), true);
  assert.equal(lobbyRowOffered({ committeeTimeMs: String(NOW - 60000), said: [{ committee: { drawn: false } }, { committee: { drawn: false } }] }), false, 'no 2 h grace');
  assert.equal(lobbyRowOffered({ said: [{}] }), true, 'seats that say nothing of the committee');
  assert.equal(lobbyRowOffered({ said: [{ committee: { drawn: false } }, { committee: { drawn: { game: ['c6d5'], settlement: ['c6d5'] } } }] }), true,
    'as the seats list it: a drawn committee by its members (measured on the page700 preview: === true offered no round at all)');
});
