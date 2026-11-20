// #3062 refute 3: once the upgrade is answered, the bound is RELAY_BUFFERED_BYTES = 64 MiB per relay of bytes the census node does
// not read - a census node (role b) that answers the upgrade and stops reading lets a stranger pin 64 MiB per connection, times N.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { seat, client, wait, listening } from './wf1489-r1120b-refute-3-s1-harness.mjs';
test('a census node that opens the relay and never reads cannot make the seat buffer more than the 8 MiB websocket budget', async () => {
  const raws = [];
  const g = httpServer(); const gw = new WebSocketServer({ noServer: true });
  g.on('upgrade', (req, socket, head) => { socket.on('error', () => {}); gw.handleUpgrade(req, socket, head, () => { raws.push(socket); socket.pause(); }); });
  const gport = await listening(g);
  const s = await seat(`http://127.0.0.1:${gport}`);
  const clients = [];
  try {
    const mib = Buffer.alloc(1024 * 1024, 7);
    for (let i = 0; i < 4; i++) { const k = await client(s.url); clients.push(k); await wait(300); for (let j = 0; j < 40 && !k.closed; j++) { k.c.send(mib); await wait(10); } }
    await wait(1000);
    const heldOpen = s.conns.filter((c) => c.open).reduce((n, c) => n + c.taken, 0);
    assert.ok(raws.length >= 1, 'the guardian end opened');
    assert.ok(heldOpen <= 8 * 1024 * 1024 + 4 * 8 * 1024 * 1024, `open relays took ${(heldOpen / 1048576).toFixed(0)} MiB toward a census node that reads nothing (kernel buffers allowance 8 MiB per socket)`);
  } finally { for (const k of clients) { try { k.c.terminate(); } catch {} } for (const r of raws) r.destroy(); s.close(); g.close(); }
});
