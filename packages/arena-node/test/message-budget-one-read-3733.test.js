// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A WHOLE MESSAGE AND AN UNFINISHED FRAME IN ONE READ: THE FRAME IS STILL CHARGED AND STILL TIMED OUT (kanban #3733, audit nostr a8-1-2, a gap in
// #2075 / #3691). messageBudget counted a socket's bytes as they came and gave ALL of them back - and cleared the unfinished-message deadline -
// on ws's next 'message'. ws parses a read synchronously, so one read holding a whole small message and then ~60 KiB of a 120 KiB frame was
// counted, then released by the small message: the unfinished frame behind it was held by ws with no charge and no deadline. The same watch()
// guards the seat's /play and P2P websockets (server.js) and, on the 1.9 line, the Nostr relay. Here a websocket server is set up the way
// server.js does it (handleUpgrade, then watch), so the budget is tested on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { messageBudget } from '../src/body-budget.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (payload) => { const k = randomBytes(4); const out = Buffer.from(payload); for (let i = 0; i < out.length; i++) out[i] ^= k[i % 4]; return [k, out]; };
/** a masked client frame: `op` 1 text, 0 continuation, 9 ping; `fin` false for a fragment */
const frame = (payload, { op = 1, fin = true } = {}) => {
  const [k, body] = mask(Buffer.from(payload));
  const n = body.length;
  const head = n < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | n])
    : n < 65536 ? Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | 126, n >> 8, n & 0xff])
      : (() => { const h = Buffer.alloc(10); h[0] = (fin ? 0x80 : 0) | op; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  return Buffer.concat([head, k, body]);
};
/** the header (and mask key) of a masked text frame of `len` bytes, then `sent` of them */
const startOf = (len, sent) => { const h = Buffer.alloc(14); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); randomBytes(4).copy(h, 10); return Buffer.concat([h, Buffer.alloc(sent, 0x61)]); };

async function server(opts) {
  const budget = messageBudget(opts);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const got = [];
  const http = createServer();
  http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    budget.watch(ws, socket);
    ws.on('message', (m) => { got.push(String(m)); ws.send(`echo ${String(m).length}`); });
  }));
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  return { port: http.address().port, budget, got, close: () => { for (const c of wss.clients) c.terminate(); return new Promise((r) => http.close(r)); } };
}

/** a raw upgraded socket; `send(buf)` writes one chunk (one read on loopback) */
function raw(port) {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1');
    const st = { closed: false, socket: s, send: (b) => new Promise((r) => s.write(b, r)), data: '' };
    s.on('close', () => { st.closed = true; });
    s.on('error', () => { st.closed = true; });
    let got = '';
    s.on('data', function first(d) {
      got += d.toString('latin1');
      if (!got.includes('\r\n\r\n')) return;
      s.off('data', first);
      if (!/^HTTP\/1\.1 101/.test(got)) return reject(new Error(got.split('\r\n')[0]));
      s.on('data', (x) => { st.data += x.toString('latin1'); });
      resolve(st);
    });
    s.on('connect', () => s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
  });
}
const held = (srv) => srv.budget.held().main + srv.budget.held().reserve;

test('#3733: an unfinished frame sent in the same read as a whole message is still timed out (messageMs)', async () => {
  const srv = await server({ total: 16 * 1024 * 1024, perAddress: 16 * 1024 * 1024, messageMs: 400 });
  try {
    const s = await raw(srv.port);
    await s.send(Buffer.concat([frame(JSON.stringify(['CLOSE', 'x'])), startOf(120 * 1024, 60 * 1024)]));
    await pause(100);
    assert.equal(srv.got.length, 1, 'the whole message was read');
    assert.ok(held(srv) >= 60 * 1024, `the unfinished frame is charged (${held(srv)} bytes held)`);
    await pause(1400);
    assert.equal(s.closed, true, 'the socket still holds 60 KiB of an unfinished frame after 1.5 s: it is waited for forever');
    assert.equal(held(srv), 0, 'its share is freed');
  } finally { await srv.close(); }
});

test('#3733: such sockets are bounded by the unfinished-message budget', async () => {
  const srv = await server({ total: 1024 * 1024, perAddress: 1024 * 1024, reserve: 256 * 1024, messageMs: 60000 });
  const socks = [];
  try {
    for (let i = 0; i < 40; i++) { const s = await raw(srv.port); socks.push(s); await s.send(Buffer.concat([frame('["CLOSE","x"]'), startOf(120 * 1024, 60 * 1024)])); }
    await pause(500);
    const open = socks.filter((s) => !s.closed).length;
    assert.ok(open * 60 * 1024 <= 1024 * 1024 + 256 * 1024, `${open} sockets still hold ${open * 60} KiB of unfinished frames, past the 1 MiB budget and its reserve`);
    assert.ok(held(srv) <= 1024 * 1024 + 256 * 1024, `held ${held(srv)}`);
  } finally { for (const s of socks) s.socket.destroy(); await srv.close(); }
});

test('#3733: honest traffic holds nothing between messages and is never cut off', async () => {
  const srv = await server({ total: 1024 * 1024, perAddress: 1024 * 1024, reserve: 256 * 1024, messageMs: 400 });
  try {
    const s = await raw(srv.port);
    // several whole messages and a ping in one read
    await s.send(Buffer.concat([frame('a'), frame('', { op: 9 }), frame('b'.repeat(300)), frame('c'.repeat(70000))]));
    await pause(100);
    assert.deepEqual(srv.got.map((m) => m.length), [1, 300, 70000]);
    assert.equal(held(srv), 0, 'whole messages hold nothing');
    // a message cut over several reads, with a ping between its fragments; each read within messageMs of the first
    const big = frame('d'.repeat(5000));
    await s.send(big.subarray(0, 3)); await pause(50);              // not even a whole header yet
    assert.equal(held(srv), 3);
    await s.send(big.subarray(3, 2000)); await pause(50);
    assert.equal(held(srv), 2000);
    await s.send(Buffer.concat([big.subarray(2000), frame('e', { fin: false })])); await pause(50);
    assert.equal(srv.got.at(-1).length, 5000);
    assert.ok(held(srv) > 0 && held(srv) < 16, `only the open fragment is held (${held(srv)})`);
    await s.send(frame('', { op: 9 })); await pause(50);
    await s.send(frame('f', { op: 0 })); await pause(50);
    assert.equal(srv.got.at(-1), 'ef');
    assert.equal(held(srv), 0);
    await pause(600);                                                // past messageMs with nothing open: the socket stays
    assert.equal(s.closed, false, 'a socket with no unfinished message is not timed out');
    await s.send(frame('g')); await pause(50);
    assert.equal(srv.got.at(-1), 'g');
  } finally { await srv.close(); }
});

test('#3733: a message begun in the same read as the end of the last one gets its own deadline, from its first byte', async () => {
  const srv = await server({ total: 1024 * 1024, perAddress: 1024 * 1024, messageMs: 500 });
  try {
    const s = await raw(srv.port);
    const one = frame('x'.repeat(4000));
    await s.send(one.subarray(0, 100));
    await pause(400);
    // the first message ends 400 ms after its first byte; the second starts in the same read and never ends
    await s.send(Buffer.concat([one.subarray(100), startOf(10000, 50)]));
    await pause(250);                                                // 650 ms after the first byte: past the first message's deadline
    assert.equal(s.closed, false, 'the second message was cut off by the first one\'s deadline');
    await pause(600);
    assert.equal(s.closed, true, 'the second message is not waited for past its own deadline');
  } finally { await srv.close(); }
});
