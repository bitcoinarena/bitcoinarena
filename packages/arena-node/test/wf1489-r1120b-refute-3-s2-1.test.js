// #3062 refute (skeptic 2, census-node role): the bounds count only what a STRANGER sends. A census node whose upgrade the relay dialled
// (the seat's outbound socket, maxPayload 64 MiB, not watched by the #2075 message budget) starts one 60 MiB message and never finishes
// it: each relay's receiver holds the part sent, with no time limit and no shared budget - N relays, N times that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardianEndpoint, seat, client, wait } from './wf1489-r1120b-refute-3-s2-harness.mjs';
const MiB = 1024 * 1024;
// the writer stops when the seat ends the connection (kanban #3188: refusing the frame is the fix; a write after that end never drains)
const writeAll = async (sock, chunk, total) => { let sent = 0; const gone = () => sock.destroyed || sock.writableEnded; while (sent < total && !gone()) { const n = Math.min(chunk.length, total - sent); if (!sock.write(n === chunk.length ? chunk : chunk.subarray(0, n))) await new Promise((r) => { const t = setInterval(() => { if (gone()) { clearInterval(t); r(); } }, 20); sock.once('drain', () => { clearInterval(t); r(); }); }); sent += n; } };
test('a census node that never finishes a message cannot make the seat hold more than the 8 MiB websocket budget across its relays', async () => {
  const LEN = 60 * MiB, PART = 40 * MiB, RELAYS = 3;
  const pending = [];
  const g = await guardianEndpoint((ws, raw) => {
    const head = Buffer.alloc(10); head[0] = 0x82; head[1] = 127; head.writeBigUInt64BE(BigInt(LEN), 2);   // FIN, binary, 64-bit length
    raw.write(head);
    pending.push(writeAll(raw, Buffer.alloc(64 * 1024, 9), PART));
  });
  const s = await seat([g.endpoint]);
  const clients = [];
  try {
    if (global.gc) global.gc();
    const before = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < RELAYS; i++) { clients.push(await client(s.urls[0])); await wait(100); }
    await wait(300); await Promise.all(pending); await wait(1500);
    if (global.gc) global.gc();
    const grew = process.memoryUsage().arrayBuffers - before;
    const open = s.conns.filter((c) => c.open).length;
    assert.equal(g.raws.length, RELAYS, 'every relay reached the census node');
    assert.ok(!(open === RELAYS && grew > 24 * MiB), `${open} relays still open, the seat holds ${(grew / MiB).toFixed(0)} MiB of a census node's unfinished messages`);
  } finally { for (const k of clients) { try { k.c.terminate(); } catch {} } s.close(); g.close(); }
});
