// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute 2 of #1542/#1717: the bound checks bufferedAmount only in fanOut, the REQ answer and send(). A stranger (no key,
// no event, no REQ) that stops reading and sends WebSocket pings gets one pong per ping queued by the ws library itself (autoPong),
// outside every check and outside the message budget (a ping is no 'message'). The backlog for that one socket grows without bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startRelay } from '../src/nostr-relay.js';

const open = (port) => new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.on('open', () => r(ws)); });

test('#1489-v1-refute-50-s2 a stalled socket sending pings is not fed pongs without bound', async () => {
  const r = await startRelay({ port: 0 });
  const slow = await open(r.port);
  try {
    let got = 0, closed = false;
    slow.on('pong', (d) => { got += d.length + 2; });
    slow.on('close', () => { closed = true; });
    slow._socket.pause();                                   // stops reading
    const payload = Buffer.alloc(125, 0x61);
    for (let i = 0; i < 200000; i++) slow.ping(payload);    // ~25 MB of pongs asked for
    for (let t = Date.now(); slow.bufferedAmount > 0 && Date.now() - t < 30000;) await new Promise((x) => setTimeout(x, 100));
    await new Promise((x) => setTimeout(x, 2000));
    slow._socket.resume();
    let last = -1;
    for (let t = Date.now(); Date.now() - t < 30000 && got !== last;) { last = got; await new Promise((x) => setTimeout(x, 700)); }
    console.log(`  FACTS: ${(got / 1e6).toFixed(1)} MB of pongs queued for one socket that did not read, dropped=${closed}`);
    assert.ok(got < 16e6, `the relay held ${(got / 1e6).toFixed(1)} MB for one socket that did not read (ping door)`);
  } finally { slow.terminate(); await r.close(); }
});
