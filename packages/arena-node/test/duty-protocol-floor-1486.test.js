// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1486: the operator names the protocol an app's newly posted days are raised to (ARENA_DUTY_PROTOCOL_<APP>), and the day is
// raised only when the census at that version can draw its committee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dutyProtocolFloor, gridProtocolOf } from '../src/duty-poster.js';

test('the floor is read per app, and only a version this build reads counts', () => {
  assert.deepEqual(dutyProtocolFloor({ ARENA_DUTY_PROTOCOL_RPS: '27' }, 'rps'), { version: 27, why: null });
  assert.deepEqual(dutyProtocolFloor({ ARENA_DUTY_PROTOCOL_RPS: '27' }, 'nextblock'), { version: null, why: null });
  assert.deepEqual(dutyProtocolFloor({}, 'rps'), { version: null, why: null });
  for (const bad of ['21', '29', '99', 'x', '27.5']) {   // 2.0 reads protocol 26, 1.9 did not: 29 is the unread one here
    const f = dutyProtocolFloor({ ARENA_DUTY_PROTOCOL_UPDOWN: bad }, 'updown');
    assert.equal(f.version, null, bad);
    assert.match(f.why, /not a protocol version this build reads/);
  }
});

test('no floor, or a floor at or below the template: the version is the template\'s or the app\'s requirement, as before', async () => {
  const never = async () => { throw new Error('the census must not be read'); };
  assert.deepEqual(await gridProtocolOf({ templateVersion: 16, required: 2, floor: null, drawableAt: never }), { version: 16, raised: false, why: null });
  assert.deepEqual(await gridProtocolOf({ templateVersion: 16, required: 20, floor: null, drawableAt: never }), { version: 20, raised: false, why: null });
  assert.deepEqual(await gridProtocolOf({ templateVersion: 27, required: 2, floor: 16, drawableAt: never }), { version: 27, raised: false, why: null });
  assert.deepEqual(await gridProtocolOf({ templateVersion: undefined, required: 0, floor: null, drawableAt: never }), { version: 3, raised: false, why: null });
});

test('a floor above the template raises the day once its census draws the committee', async () => {
  const asked = [];
  const got = await gridProtocolOf({ templateVersion: 16, required: 2, floor: 27, drawableAt: async (v) => { asked.push(v); return { ok: true }; } });
  assert.deepEqual(got, { version: 27, raised: true, why: null });
  assert.deepEqual(asked, [27]);
});

test('a floor whose census draws nobody (adverts not yet speaking it) keeps the old version and says why', async () => {
  const empty = await gridProtocolOf({ templateVersion: 16, required: 2, floor: 27,
    drawableAt: async () => ({ ok: false, why: 'that census carries 0 game nodes' }) });
  assert.equal(empty.version, 16); assert.equal(empty.raised, false);
  assert.match(empty.why, /protocol 27 named, but its census draws no committee: that census carries 0 game nodes/);
  const threw = await gridProtocolOf({ templateVersion: 13, required: 2, floor: 27, drawableAt: async () => { throw new Error('no census at 160900'); } });
  assert.equal(threw.version, 13);
  assert.match(threw.why, /no census at 160900/);
});
