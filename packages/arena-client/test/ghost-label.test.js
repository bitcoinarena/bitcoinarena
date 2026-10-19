// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEBUG LABEL OVER ANOTHER PLAYER'S TRUCK, AND THE DRAIN THAT KEEPS ITS PICTURES COMING (2026-09-17 19:15:
// "updates only every 300-600 ms"; a label with the name, the age in ms and arrows for how it moved).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchGhosts, moveGlyphs, tickClock, ghostLabels, ghostLabelText } from '../../nextblock/page/ghost-field.js';
import { Client } from '../src/client.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const ONE = 65536;
const b32 = (n) => new Uint8Array(32).fill(n);
const UP = '↑', DOWN = '↓', LEFT = '←', RIGHT = '→';

test('the arrows say forward, back, left and right, and both at once', () => {
  const at = { x: 0, z: 0, heading: 0 };
  assert.equal(moveGlyphs(at, { x: 0, z: ONE, heading: 0 }), UP, 'a truck facing +z that moved 1 m along z went forward');
  assert.equal(moveGlyphs(at, { x: 0, z: -ONE, heading: 0 }), DOWN, 'moved against its hull is back');
  assert.equal(moveGlyphs(at, { x: 0, z: ONE, heading: 200 }), UP + RIGHT, 'a growing heading while going forward is a right turn');
  assert.equal(moveGlyphs(at, { x: 0, z: ONE, heading: -200 }), UP + LEFT);
  // BACKING WITH THE WHEEL TO THE RIGHT swings the heading the other way, and still reads right.
  assert.equal(moveGlyphs(at, { x: 0, z: -ONE, heading: -200 }), DOWN + RIGHT);
  assert.equal(moveGlyphs({ x: 0, z: 0, heading: 16384 }, { x: ONE, z: 0, heading: 16384 }), UP, 'facing +x, 1 m along x');
  assert.equal(moveGlyphs(at, { x: 100, z: 100, heading: 5 }), '', 'standing still is no arrow');
  assert.equal(moveGlyphs({ x: 0, z: 0, heading: 65530 }, { x: 0, z: ONE, heading: 10 }), UP, 'a heading across 0 is a small turn, not a spin');
});

test('the tick clock gives one tab the time another tab drove a tick, and none it never heard of', () => {
  const a = tickClock({ Channel: BroadcastChannel, name: `blwp-test-${process.pid}` });
  const b = tickClock({ Channel: BroadcastChannel, name: `blwp-test-${process.pid}` });
  try {
    assert.equal(a.shared, true, 'the channel handed in was not opened');
    assert.equal(tickClock({}).shared, false, 'a clock with no channel handed in opened one anyway');
    a.post('ee', 600, 1000);
    return new Promise((done) => setTimeout(() => {
      assert.equal(b.sentMs('ee', 600), 1000, 'the other tab did not hear the stamp');
      assert.equal(Math.round(b.sentMs('ee', 606)), 1100, 'six ticks after a stamp is 100 ms after it');
      assert.equal(b.sentMs('ee', 900), null, 'a tick five seconds from any stamp was given a time');
      assert.equal(b.sentMs('ff', 600), null, 'an entry nobody stamped was given a time');
      done();
    }, 30));
  } finally { setTimeout(() => { a.close(); b.close(); }, 60); }
});

test('a label names the truck, says how old its newest picture is and how it moved', async () => {
  let now = 50000;
  const client = { playerPubkey: b32(1), onGhost: null, watch: async () => 'watching 0' };
  const field = watchGhosts(client, { roundId: b32(2), entryId: b32(3) }, { clock: () => now });
  const theirs = { entryId: b32(4), playerPubkey: b32(5), heading: 0, x: 0 };
  client.onGhost({ ...theirs, z: 0, tick: 594 });
  now += 100;
  client.onGhost({ ...theirs, z: ONE, heading: 300, tick: 600 });
  now += 40;
  const clock = { sentMs: (e, t) => (e === toHex(b32(4)) && t === 600 ? now - 140 - 60 : null) };
  const [label] = ghostLabels(field, { nowMs: now, nameOf: (p) => (p === toHex(b32(5)) ? 'Alice' : null), clock });
  assert.deepEqual(label, { entry: toHex(b32(4)), name: 'Alice', ageMs: 200, estimated: false, glyphs: UP + RIGHT });
  assert.equal(ghostLabelText([label]), `${toHex(b32(4))}\tAlice\t200ms ${UP}${RIGHT}`);
  // NO STAMP OF THE DRIVER'S CLOCK: the age is the time since the picture arrived, and says so.
  const [guess] = ghostLabels(field, { nowMs: now });
  assert.equal(guess.estimated, true);
  assert.equal(guess.ageMs, 40);
  assert.match(ghostLabelText([guess]), /\t~40ms /);
  assert.notEqual(guess.name, '', 'a player with no name record has no name at all');
});

test('a drain that finds a batch in flight is sent the moment that batch is answered, not a slot later', async () => {
  const client = new Client({ base: 'http://127.0.0.1:1', core: {}, sign: () => new Uint8Array(64), verify: () => true });
  client.sock = { readyState: 1, bufferedAmount: 0, send() {} };
  client.setRound({ roundId: b32(2), entryId: b32(3), blockTicks: 9000 });
  client.offered = 0; client.nextTick = 0;
  const sent = [];
  let answer = null;
  client.batch = (words) => { sent.push(words.length); return new Promise((r) => { answer = () => { client.nextTick += words.length; r({ accepted: words.length }); }; }); };
  for (let i = 0; i < 6; i++) client.record([45875, 0, 0, 0, 0]);
  client.drain();
  assert.deepEqual(sent, [6]);
  for (let i = 0; i < 6; i++) client.record([45875, 0, 0, 0, 0]);
  client.drain();                                   // the page's next slot: the first batch is still unanswered
  assert.deepEqual(sent, [6], 'a second batch went out while the first was in flight');
  answer();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [6, 6], 'the held ticks waited for the page\'s next slot instead of going on the answer');
  answer();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 3; i++) client.record([45875, 0, 0, 0, 0]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [6, 6], 'an answer with no slot missed sent a batch of its own');
});
