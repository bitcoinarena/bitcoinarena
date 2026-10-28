// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A WINDOW IS TRADEABLE ONLY WHEN ITS ROUND IS LISTED AND SEATED (kanban #761, 2026-10-28 ~10:50Z, the owner on Up/Down: "BTC up or down,
// 10:45-11:00 UTC?" with Buy Up 50c active and every order "Order not placed: this round is no longer listed in the lobby" - no round was
// seated, #757). An unseated round is not offered to any app (Buy and Sell off), the page says why, and names the next playable window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { lobbyRowOffered, lobbyRowNotOffered, unplayableWindowLine } from '../src/lobby.js';

const T0 = Date.parse('2026-10-28T10:50:00Z');
const at = (hm) => Date.parse(`2026-10-28T${hm}:00Z`);
const drawn = { game: ['a'], settlement: ['a'] };
const unseated = { drawn, seated: { game: null, settlement: null }, drawnCount: { game: 9, settlement: 9 } };
const seated = { drawn, seated: { game: ['a'], settlement: ['a'] } };
const seatingOf = (c) => (c.seated ? (c.seated.game && c.seated.settlement ? { state: 'named' } : { state: 'pending' }) : null);
const row = (id, close, committee, extra = {}) => ({ id, free: false, entryCloseMs: close, startTimeMs: close - 900000, joinable: seatingOf(committee) ? seatingOf(committee).state === 'named' : true,
  said: [{ committee }, { committee }], seating: seatingOf(committee), ...extra });

test('#761: a drawn round no seat names seated is not offered; seated, it is; free rounds and seats silent on seating as before', () => {
  assert.equal(lobbyRowNotOffered(row('x', at('11:00'), unseated)), 'not seated');
  assert.equal(lobbyRowOffered(row('x', at('11:00'), unseated)), false);
  assert.equal(lobbyRowNotOffered(row('y', at('11:00'), seated)), null);
  assert.equal(lobbyRowOffered(row('y', at('11:00'), seated)), true);
  // the seats' own words when the row carries no `seating` (a row not made by fetchLobby)
  assert.equal(lobbyRowNotOffered({ free: false, said: [{ committee: unseated }] }), 'not seated');
  assert.equal(lobbyRowNotOffered({ free: false, said: [{ committee: unseated }, { committee: seated }] }), null, 'one seat naming both roles seated is enough');
  assert.equal(lobbyRowNotOffered({ free: false, said: [{ committee: { drawn: false } }] }), 'not drawn');
  assert.equal(lobbyRowNotOffered({ free: false, said: [{ committee: { drawn: true } }] }), null, 'seats without reserve seats: drawn is enough');
  assert.equal(lobbyRowNotOffered({ free: true, said: [{ committee: unseated }] }), null);
  assert.equal(lobbyRowNotOffered({ free: false, said: [{ committee: seated }], seating: { state: 'equivocated' } }), 'not seated');
});

test('#761: the line when the soonest window is unseated - why, and the next playable window (or that none is)', () => {
  const un = [{ id: 'x', entryCloseMs: at('11:00'), why: 'not seated' }];
  const none = unplayableWindowLine({ unoffered: un, offered: [], nowMs: T0, periodMs: 900000 });
  assert.equal(none.text, 'No playable round for the 10:45-11:00 UTC window - its committee is not seated. No later window is playable yet.');
  assert.equal(none.why, 'not seated');
  const next = unplayableWindowLine({ unoffered: un, offered: [{ id: 'y', entryCloseMs: at('11:15') }], nowMs: T0, periodMs: 900000 });
  assert.equal(next.text, 'No playable round for the 10:45-11:00 UTC window - its committee is not seated. Next playable window: 11:00-11:15 UTC.');
  assert.equal(next.next, 'y');
  // the soonest window is seated: nothing to say
  assert.equal(unplayableWindowLine({ unoffered: [{ id: 'z', entryCloseMs: at('11:15'), why: 'not seated' }], offered: [{ id: 'x', entryCloseMs: at('11:00') }], nowMs: T0, periodMs: 900000 }), null);
  // a closed unseated window says nothing
  assert.equal(unplayableWindowLine({ unoffered: [{ id: 'old', entryCloseMs: at('10:45'), why: 'not seated' }], offered: [], nowMs: T0 }), null);
  assert.match(unplayableWindowLine({ unoffered: [{ id: 'x', entryCloseMs: at('11:00'), startTimeMs: at('10:45'), why: 'not drawn' }], nowMs: T0 }).text, /10:45-11:00 UTC window - its committee is not drawn/);
});

// THE UP/DOWN CLIENT'S OWN PICK (src-v23.js windowNow: "the soonest joinable one, else the soonest open one") over the rows the page hands it
const CLIENT = new URL('../../btc-updown/client/src-v23.js', import.meta.url);
const pickOf = (rows) => {
  const src = readFileSync(CLIENT, 'utf8');
  const body = /const windowNow = \(\) => \{([\s\S]*?)\n  \};/.exec(src)[1];
  return new Function('A', body)({ allRows: () => rows });   // eslint-disable-line no-new-func
};
// the page's filter (index.html draw(): paid rows only when ARENACLIENT.lobbyRowOffered), then the app's rows
const handed = (rows) => rows.filter((r) => r.free || lobbyRowOffered(r)).map((r) => ({ id: r.id, free: r.free, joinable: r.joinable, entryCloseMs: r.entryCloseMs }));

test('#761: unseated - the client is handed no window, so Buy and Sell are off; seated - it trades; a later seated window is the one shown', { skip: !existsSync(CLIENT) && 'the Up/Down app is not placed (node tools/fetch-apps.mjs)' }, () => {
  const now = Date.now(), soon = now + 600000, later = now + 1500000;
  // today: the 10:45-11:00 window listed, its committee not seated - before #761 the client took it as open[0] and offered Buy
  assert.equal(pickOf([row('x', soon, unseated)].map((r) => ({ ...r, entryCloseMs: soon }))).id, 'x', 'the client alone takes an unjoinable window');
  assert.equal(pickOf(handed([row('x', soon, unseated)])), null, 'handed nothing: "No window is open", Buy disabled');
  assert.equal(pickOf(handed([row('y', soon, seated)])).id, 'y');
  assert.equal(pickOf(handed([row('x', soon, unseated), row('y', later, seated)])).id, 'y', 'the next playable window');
});

test('#761: the page holds unseated rounds back, says why in the market, and a join names the reason', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(page, /ARENACLIENT\.lobbyRowNotOffered\(r\)/);
  assert.match(page, /window\.ARENA_LOBBY_UNOFFERED = /);
  assert.match(page, /ARENACLIENT\.unplayableWindowLine\(\{ unoffered: window\.ARENA_LOBBY_UNOFFERED/);
  assert.match(page, /finding\.why = notJoinableWhy\(id\)/);
  assert.doesNotMatch(page, /'this round is no longer listed in the lobby'/);
  const bundle = readFileSync(new URL('../dist/arena-client.js', import.meta.url), 'utf8');
  assert.match(bundle, /unplayableWindowLine: unplayableWindowLine/);
  assert.match(bundle, /lobbyRowNotOffered: lobbyRowNotOffered/);
});
