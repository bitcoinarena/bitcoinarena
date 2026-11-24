// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3593: hostnames beyond the committee's size are no votes. The seats' own VOID past their final point still ends the wait (all seven on
// one host, /guardian-1..7, as live); nine DNS names of one box saying VOID while the seats still certify do not; and a "not required" from
// the box is followed by the ask-again loop, so seats that answer "not certified yet" get the move once they take it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revealWhenCertified } from '../src/head-to-head.js';
import { LOCK_SET_WINDOW_MS, LOCK_SET_FINAL_AFTER_MS } from '../../arena-protocol/src/lock-set.js';

const committee = Array.from({ length: 7 }, (_, i) => (0x51 + i).toString(16).repeat(32));
const verify = () => false;   // no certificate is served in these runs
const CLOSE = 1_800_000_000_000;
const seats = committee.map((_, i) => `https://seats.example/guardian-${i + 1}`);
const names = Array.from({ length: 9 }, (_, i) => `https://evil${i}.example`);
const isEvil = (u) => /^https:\/\/evil\d\.example/.test(u);
const voidAfter = CLOSE + LOCK_SET_WINDOW_MS + LOCK_SET_FINAL_AFTER_MS;

function run(nodes, { seatSays, boxSays, seatTakesAt = 1 }) {
  let t = CLOSE + 200;
  const posts = new Map();
  const fetcher = async (u, o = {}) => {
    if ((o.method || 'GET') === 'POST') {
      const k = u.slice(0, u.indexOf('/reveal')); posts.set(k, (posts.get(k) || 0) + 1);
      if (isEvil(u) || posts.get(k) > seatTakesAt) return { ok: true, status: 201, text: async () => '' };
      return { ok: false, status: 409, text: async () => 'that round\'s lock set is not certified yet - ask again shortly' };
    }
    const j = isEvil(u) ? boxSays : seatSays;
    return { ok: !!j, status: j ? 200 : 503, text: async () => JSON.stringify(j || {}) };
  };
  return revealWhenCertified({ roundIdHex: 'aa'.repeat(32), entryIdHex: 'bb'.repeat(32), move: 1, salt: new Uint8Array(32), nodes, committee, verify, entryCloseMs: CLOSE,
    fetcher, now: () => (t += 1000), sleep: async () => {} }).then((got) => ({ got, posts, t }));
}

test('the seats themselves saying VOID past their final point end the wait as VOID', async () => {
  const { got, t } = await run(seats, { seatSays: { required: true, certificate: null, void: true } });
  assert.equal(got.void, true);
  assert.ok(t > voidAfter && t < voidAfter + 5000, `VOID at close + ${t - CLOSE} ms`);
});

test('nine names of one box saying VOID while the seats still certify do not end the wait before the page\'s own deadline', async () => {
  const { got, t } = await run([...seats, ...names], { seatSays: { required: true, certificate: null, void: false }, boxSays: { required: true, certificate: null, void: true } });
  assert.equal(got.void, true);
  assert.ok(t > voidAfter + 10000, `the box's VOIDs ended the wait at close + ${t - CLOSE} ms`);
});

test('a "not required" from the box alone is followed up: the seats are asked again until they take the move', async () => {
  const { got, posts } = await run([...seats, ...names], { seatSays: null, boxSays: { required: false }, seatTakesAt: 2 });
  assert.equal(got.certified, null);
  for (const s of seats) assert.equal(posts.get(s), 3, `${s} was posted ${posts.get(s)} times`);
  assert.ok(got.seats.filter((x) => !isEvil(x.node)).every((x) => x.status === 201));
});
