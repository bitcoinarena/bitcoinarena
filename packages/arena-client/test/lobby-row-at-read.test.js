// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAID ROW A FUNDED SEAT READS IS THE ROUND IT CAN STILL ENTER (2026-10-05: "A funded seat reads one
// lobby row before it pays. That row is the round it can still enter. It is not the round after next."). The playtest of
// 10-04 13:45 saw the round after next ("closes 1:52"); measured 10-05 01:30-01:33Z on 0.0.2740 with a seat holding 100 sat,
// the row was never the round after next, but at each rollover Unity read the closed round ("closes in 0:00", not joinable)
// for a further ~1 s, because the row was the LAST PAINT's pick. The row is picked when it is read, at the read's clock,
// funded or not: lobbyRowsAt. A join held on a round keeps that round (lobbyKeepJoined, 2026-10-02).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lobbyRowsAt } from '../src/lobby.js';

const NOW = 1_800_000_000_000;
const sid = new Uint8Array(32).fill(7);
// a 90 s series of 100 sat rounds; entry closes at start + 32 s (late join)
const round = (id, startInS, i) => ({ id, free: false, joinable: true, phase: 'open', stakeMsat: 100000n,
  startTimeMs: NOW + startInS * 1000, entryCloseMs: NOW + (startInS + 32) * 1000,
  contract: { seriesId: sid, startTimeMs: BigInt(NOW + startInS * 1000), roundIndex: BigInt(i) } });
// 22 s left on X's entry (it started 10 s ago), Y starts in 80 s, Z in 170 s
const X = round('X', -10, 0), Y = round('Y', 80, 1), Z = round('Z', 170, 2);
const rows = [Z, Y, X];
const paid = (picked) => picked.filter((r) => !r.free).map((r) => r.id);

test('22 s before X closes: the row is X, the round still open to enter - not Y, not Z', () => {
  assert.deepEqual(paid(lobbyRowsAt(rows, NOW)), ['X']);
});

test('a join held on X keeps X; a join held on nothing listed leaves the pick', () => {
  assert.deepEqual(paid(lobbyRowsAt(rows, NOW, 'X')), ['X']);
  assert.deepEqual(paid(lobbyRowsAt(rows, NOW, 'gone')), ['X']);
});

// A JOIN HELD ON A ROUND WHOSE ENTRY HAS CLOSED (a run's end, then "exit game", leaves BLWP_JOIN "joined" on the played round)
// is not the row: measured on 0.0.2741 at 02:09Z, the held closed round 867446ac stayed the row ("closes in 0:00", not
// joinable) for as long as the nodes listed it, while 28a9d681 was open.
test('a join held on a round whose entry has closed does not keep it: the row is the round still open', () => {
  const past = NOW + 22000 + 500;                      // X's entry closed 0.5 s ago
  assert.deepEqual(paid(lobbyRowsAt(rows, past, 'X')), ['Y']);
  assert.deepEqual(paid(lobbyRowsAt(rows, past + 6000, 'X')), ['Y']);
  assert.deepEqual(paid(lobbyRowsAt(rows, NOW + 21900, 'X')), ['X'], 'while its entry is open the held round stays the row');
});

// BUT A JOIN STILL GOING KEEPS ITS ROUND past the page's entry close (2026-10-02: "once a round has been selected with
// play the highlighting may no longer change"): PLAY a few seconds before the close is still "joining" when it passes, and
// the seats take its entry until start + 45 s. Only a finished join ("joined", what a run's end and "exit game" leave) is
// dropped once its round's entry has closed.
test('a join still going keeps its round past the entry close; a finished one does not', () => {
  const past = NOW + 22000 + 3000;
  assert.deepEqual(paid(lobbyRowsAt(rows, past, 'X', { going: true })), ['X']);
  assert.deepEqual(paid(lobbyRowsAt(rows, past, 'X', { going: false })), ['Y']);
});

test('at every instant of the series the row read is the soonest round whose entry is open', () => {
  for (let t = 0; t < 250000; t += 100) {
    const now = NOW + t;
    const open = rows.filter((r) => r.entryCloseMs > now).sort((a, b) => a.entryCloseMs - b.entryCloseMs);
    if (!open.length) break;
    assert.deepEqual(paid(lobbyRowsAt(rows, now)), [open[0].id], `at +${t} ms`);
  }
});

// THE PAGE: the row Unity reads (BLWP_LOBBY_VIEW) and PLAY's row (ARENA_LOBBY) are picked by lobbyRowsAt at the read's own
// Date.now() - not the last paint's pick - and nothing in the pick depends on the wallet's balance (no lead).
test('the page picks the paid row when Unity reads it, with no lead', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url).pathname, 'utf8');
  // the view Unity reads is Tick Tock's page part (kanban #521), handed the lobby's state at each read
  const unity = readFileSync(new URL('../../nextblock/page/unity-page.js', import.meta.url).pathname, 'utf8');
  const view = unity.slice(unity.indexOf('function unityLobbyView('), unity.indexOf('refused: refused.map(String)', unity.indexOf('function unityLobbyView(')));
  assert.ok(view.length > 0, 'unityLobbyView not found');
  assert.match(page, /window\.BLWP_LOBBY_VIEW = \(\) => unityLobbyView\(\{ me, lobbyNow, /, 'the lobby hands Unity\'s view its own lobbyNow');
  assert.match(view, /rows: lobbyNow\(\)/, 'the view does not pick its rows when read');
  assert.match(page, /const lobbyNow = \(\) => \(window\.ARENA_LOBBY = BLWPCLIENT\.lobbyRowsAt\(window\.ARENA_LOBBY_ROWS \|\| \[\], Date\.now\(\), goingRound\(\), \{ going: joinGoing\(\) \}\)/);
  assert.doesNotMatch(page, /leadMsFor|FUNDED_JOIN_LEAD_MS|SERIES_JOIN_LEAD_MS/, 'the page still names a lead');
});
