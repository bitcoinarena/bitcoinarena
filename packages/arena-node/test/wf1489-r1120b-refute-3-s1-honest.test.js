// #3062 honest path: a guardian that answers - messages sent before it opens are flushed, replies come back, a large API answer passes
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { seat, client, wait, listening } from './wf1489-r1120b-refute-3-s1-harness.mjs';
test('honest relay: early messages flushed in order, 3 MiB answer relayed', async () => {
  const g = httpServer(); const gw = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  g.on('upgrade', (req, socket, head) => { setTimeout(() => gw.handleUpgrade(req, socket, head, (ws) => { ws.on('message', (m) => ws.send(m.length > 100 ? Buffer.alloc(3 * 1024 * 1024, 1) : Buffer.from('re:' + m))); }), 500); });
  const s = await seat(`http://127.0.0.1:${await listening(g)}`);
  const k = await client(s.url);
  const got = []; k.c.on('message', (m) => got.push(m));
  try {
    for (let i = 0; i < 5; i++) k.c.send(`m${i}`);
    k.c.send(Buffer.alloc(2 * 1024 * 1024, 2));
    await wait(2500);
    assert.deepEqual(got.slice(0, 5).map(String), ['re:m0', 're:m1', 're:m2', 're:m3', 're:m4']);
    assert.equal(got[5] && got[5].length, 3 * 1024 * 1024);
    assert.equal(k.closed, false);
  } finally { k.c.terminate(); s.close(); g.close(); }
});
