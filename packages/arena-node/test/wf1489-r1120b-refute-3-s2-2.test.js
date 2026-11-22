// #3062 refute (skeptic 2, census-node role): RELAY_BUFFERED_BYTES (16 MiB) is checked BEFORE a send, so the first message toward the
// client always goes out whatever its size - and a census node's message may be 64 MiB (the dial's maxPayload). A census node that sends
// one 48 MiB answer per relay to a client that does not read leaves 48 MiB unsent in each, three times the "hard ceiling", the relay open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardianEndpoint, seat, client, wait } from './wf1489-r1120b-refute-3-s2-harness.mjs';
import { RELAY_BUFFERED_BYTES } from '../src/p2p-tunnel.js';
const MiB = 1024 * 1024;
test('a census node cannot leave more than RELAY_BUFFERED_BYTES unsent toward a client in one open relay', async () => {
  const big = Buffer.alloc(48 * MiB, 5);
  const g = await guardianEndpoint((ws) => { setTimeout(() => { try { ws.send(big); } catch {} }, 200); });
  const s = await seat([g.endpoint]);
  const clients = [];
  try {
    for (let i = 0; i < 3; i++) { const k = await client(s.urls[0]); k.c._socket.pause(); clients.push(k); }
    await wait(2500);
    const open = s.conns.filter((c) => c.open);
    const worst = Math.max(0, ...open.map((c) => c.ws.bufferedAmount));
    const total = open.reduce((n, c) => n + c.ws.bufferedAmount, 0);
    assert.equal(g.raws.length, 3, 'every relay reached the census node');
    assert.ok(worst <= RELAY_BUFFERED_BYTES, `an open relay holds ${(worst / MiB).toFixed(0)} MiB unsent toward its client (${open.length} open, ${(total / MiB).toFixed(0)} MiB together)`);
  } finally { for (const k of clients) { try { k.c.terminate(); } catch {} } s.close(); g.close(); }
});
