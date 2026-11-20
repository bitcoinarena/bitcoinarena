// #3062 refute 1: RELAY_HELD_BYTES is per connection only - a stranger opens many /guardian-api relays to a tarpit census endpoint,
// each kept just under 8 MiB, and the seat holds their sum (no shared budget like #2075's, no connection cap on the path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tarpitEndpoint, seat, client, wait } from './wf1489-r1120b-refute-3-s1-harness.mjs';
test('many relays to a guardian whose endpoint never answers the upgrade do not together pin more than the 8 MiB websocket budget', async () => {
  const tp = await tarpitEndpoint(); const s = await seat(tp.endpoint);
  const clients = [];
  try {
    const mib = Buffer.alloc(1024 * 1024, 7);
    for (let i = 0; i < 16; i++) { const k = await client(s.url); clients.push(k); for (let j = 0; j < 7 && !k.closed; j++) { k.c.send(mib); await wait(15); } }
    await wait(1000);
    const heldOpen = s.conns.filter((c) => c.open).reduce((n, c) => n + c.taken, 0);
    assert.ok(tp.sockets.length >= 1, 'the relays are dialling the tarpit');
    assert.ok(heldOpen <= 8 * 1024 * 1024, `the seat holds ${(heldOpen / 1048576).toFixed(0)} MiB in ${s.conns.filter((c) => c.open).length} open relays' queues while the guardian is dialled`);
  } finally { for (const k of clients) { try { k.c.terminate(); } catch {} } s.close(); tp.close(); }
});
