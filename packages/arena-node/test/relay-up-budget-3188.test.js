// kanban #3188: below RELAY_UP_MESSAGE_MOST a census node's unfinished messages on the dialled sockets count against the relays' shared
// up budget - one census node at most half of it - so 3 relays each holding 6 MiB of an unfinished 7 MiB message do not all stay open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardianEndpoint, seat, client, wait } from './wf1489-r1120b-refute-3-s2-harness.mjs';
import { RELAY_UP_MESSAGE_MOST, RELAY_UP_BUDGET } from '../src/p2p-tunnel.js';
const MiB = 1024 * 1024;
const writeAll = async (sock, chunk, total) => { let sent = 0; const gone = () => sock.destroyed || sock.writableEnded; while (sent < total && !gone()) { const n = Math.min(chunk.length, total - sent); if (!sock.write(n === chunk.length ? chunk : chunk.subarray(0, n))) await new Promise((r) => { const t = setInterval(() => { if (gone()) { clearInterval(t); r(); } }, 20); sock.once('drain', () => { clearInterval(t); r(); }); }); sent += n; } };
test('unfinished census-node messages under the dial maxPayload are bounded per census node across relays', async () => {
  assert.ok(7 * MiB < RELAY_UP_MESSAGE_MOST && 3 * 6 * MiB > RELAY_UP_BUDGET / 2);
  const pending = [];
  const g = await guardianEndpoint((ws, raw) => {
    const head = Buffer.alloc(10); head[0] = 0x82; head[1] = 127; head.writeBigUInt64BE(BigInt(7 * MiB), 2);
    raw.write(head); pending.push(writeAll(raw, Buffer.alloc(64 * 1024, 3), 6 * MiB));
  });
  const s = await seat([g.endpoint]);
  const clients = [];
  try {
    for (let i = 0; i < 3; i++) { clients.push(await client(s.urls[0])); await wait(300); }
    await Promise.all(pending); await wait(1000);
    assert.equal(g.raws.length, 3);
    assert.ok(s.conns.filter((c) => c.open).length < 3, 'a relay past the census node\'s share of the up budget is ended');
  } finally { for (const k of clients) { try { k.c.terminate(); } catch {} } s.close(); g.close(); }
});
