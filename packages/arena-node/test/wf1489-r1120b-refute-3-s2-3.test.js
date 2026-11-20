// #3062 refute (skeptic 2, stranger vs everyone, retry path): the held budget is ONE for all relays (8 MiB) and the relay whose message
// would pass it is closed. Two stranger connections to a census node that never answers the upgrade fill it (4 MiB each, the per-relay
// cap) for 15 s and again after each dial deadline; meanwhile every other client's relay to ANY guardian that takes a moment to answer
// (a tunnel's round trip) is closed on its first request - and on every retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tarpitEndpoint, guardianEndpoint, seat, client, wait } from './wf1489-r1120b-refute-3-s2-harness.mjs';
import { RELAY_HELD_OVERHEAD } from '../src/p2p-tunnel.js';
const MiB = 1024 * 1024;
test('a stranger holding relays to a dead census node does not stop honest clients reaching another guardian', async () => {
  const tp = await tarpitEndpoint();
  // an honest guardian behind a tunnel: answers the upgrade after 300 ms and echoes every request
  const honest = await guardianEndpoint((ws) => { ws.on('message', (m) => ws.send(Buffer.concat([Buffer.from('re:'), m]))); });
  const s0 = honest.endpoint;
  const { createServer } = await import('node:net');
  const slow = createServer((c) => { c.on('error', () => {}); setTimeout(() => { const u = new URL(s0); const { connect } = require_net(); const up = connect(Number(u.port), '127.0.0.1'); up.on('error', () => {}); c.pipe(up); up.pipe(c); }, 300); });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const s = await seat([tp.endpoint, `http://127.0.0.1:${slow.address().port}`]);
  const attackers = [];
  let answered = 0, refused = 0;
  try {
    const m = Buffer.alloc(MiB - RELAY_HELD_OVERHEAD, 1);
    for (let i = 0; i < 2; i++) { const k = await client(s.urls[0]); attackers.push(k); for (let j = 0; j < 4; j++) { k.c.send(m); await wait(20); } }
    await wait(300);
    assert.ok(attackers.every((k) => !k.closed), 'the stranger\'s relays are held, not refused');
    for (let attempt = 0; attempt < 3; attempt++) {   // the honest client retries
      const h = await client(s.urls[1]); h.c.send('GET /config');
      for (let t = 0; t < 30 && !h.closed && !h.got.length; t++) await wait(50);
      if (h.got.length) answered++; else refused++;
      try { h.c.terminate(); } catch {}
      await wait(200);
    }
    assert.ok(answered >= 1, `honest client refused on all ${refused} attempts while a stranger holds 2 relays to a dead census node`);
  } finally { for (const k of attackers) { try { k.c.terminate(); } catch {} } s.close(); tp.close(); honest.close(); slow.close(); }
});
import { createRequire } from 'node:module';
const require_net = () => createRequire(import.meta.url)('node:net');
