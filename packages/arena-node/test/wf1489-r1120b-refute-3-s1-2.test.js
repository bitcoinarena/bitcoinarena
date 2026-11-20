// #3062 refute 2: `held` is bounded by bytes only - an empty message counts 0, so a stranger queues an unbounded NUMBER of entries
// (each an array + buffer object, ~100 bytes of heap for a 6-byte frame) for the whole RELAY_OPEN_MS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tarpitEndpoint, seat, client, wait } from './wf1489-r1120b-refute-3-s1-harness.mjs';
test('empty messages do not pile up without limit in the relay queue while the guardian is dialled', async () => {
  const tp = await tarpitEndpoint(); const s = await seat(tp.endpoint);
  const k = await client(s.url);
  try {
    const empty = Buffer.alloc(0);
    const until = Date.now() + 3000;
    while (Date.now() < until && !k.closed) { for (let i = 0; i < 2000; i++) k.c.send(empty); await wait(1); }
    await wait(500);
    const c = s.conns[0];
    assert.ok(tp.sockets.length >= 1, 'the relay is dialling the tarpit');
    assert.ok(!c.open || c.count <= 100000, `the relay queued ${c.count} empty messages (${c.taken} bytes counted) and is still open`);
  } finally { try { k.c.terminate(); } catch {} s.close(); tp.close(); }
});
