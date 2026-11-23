// kanban #1489 round 2 (client): the head-to-head lock guard reads the seats' clock from the handout's 201 (x-entry-close-in-ms, #1892).
// postHandout keeps the EARLIEST close any seat that answered 2xx states - so ONE seat (any seat on the page's list: the handout is posted to
// every seat, and a liar answers 201 whatever it holds) answering "0 ms left" makes h2hLockRefusal refuse every paid head-to-head join the
// page makes, and seatClockAheadMs puts that seat's made-up offset on every later tap of the tab (window.ARENA_SEAT_AHEAD_MS).
// Safe: the close the guard reads is the one the round's threshold of seats stands behind, not the earliest one seat states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postHandout, h2hLockRefusal, seatClockAheadMs } from '../src/join.js';

const seats = [0, 1, 2, 3, 4, 5, 6].map((i) => `http://seat${i}`);
const fetcherWith = (liar) => async (url) => {
  const lying = url.startsWith('http://seat6');
  const left = lying ? liar : 40000;   // six honest seats: 40 s of entry left
  return { ok: true, status: 201, headers: { get: (h) => (h === 'x-entry-close-in-ms' ? String(left) : null) }, text: async () => '' };
};

test('one seat stating 0 ms left does not refuse a head-to-head lock six seats still take', async () => {
  const now = Date.now();
  const entryCloseMs = now + 40000;
  const put = await postHandout({ body: new Uint8Array(8), handout: { needed: 5 } }, seats, { fetcher: fetcherWith(0), graceMs: 0 });
  assert.equal(put.ok, true);
  const why = h2hLockRefusal({ put, entryCloseMs, leadMs: 5000, now: Date.now() });
  assert.equal(why, null, `one seat out of 7 refused the lock: ${why}`);
});

test('one seat stating a far-past close does not put its offset on the tab\'s later taps', async () => {
  const entryCloseMs = Date.now() + 40000;
  const put = await postHandout({ body: new Uint8Array(8), handout: { needed: 5 } }, seats, { fetcher: fetcherWith(-86400000), graceMs: 0 });
  const ahead = seatClockAheadMs(put, entryCloseMs);
  assert.ok(ahead < 5000, `one seat set the seats' clock ${ahead} ms ahead of the page for every later head-to-head tap`);
});
