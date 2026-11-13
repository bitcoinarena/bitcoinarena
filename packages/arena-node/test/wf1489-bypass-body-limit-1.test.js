// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 bypass of #1469 (feedback #001: one huge body fills a seat's memory). The fix caps what a seat READS FROM A REQUEST; the same
// bytes reach the seat the other way round - as another seat's ANSWER. pullProposals (server.js, every 10 min and 30 s after start) reads
// every network seat's GET /proposals with a bare `r.json()`: no cap, unlike the reads #1540/#1856/#2382 bounded with peer-read.js. One seat
// in the reading seat's networkSeats() (a peer, a census entry of a round it holds, an owner source) answering a huge body is held whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

process.env.ARENA_BODY_MOST = '65536';   // as body-limit-1469: a 64 KiB request limit, so 16 MiB is 256x what a door takes
const { openStore } = await import('../src/store.js');
const { serve } = await import('../src/server.js');

const BIG = 16 * 1024 * 1024;

test('wf1489-bypass-body-limit-1: a peer seat\'s /proposals answer far past the body limit is read whole by pullProposals', async () => {
  let sent = 0;
  const evil = createServer((req, res) => {
    if (!req.url.startsWith('/proposals')) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"proposals":["');
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < BIG / chunk.length; i++) { res.write(chunk); sent += chunk.length; }
    res.end('"]}');
  });
  await new Promise((ok) => evil.listen(0, '127.0.0.1', ok));
  const evilUrl = `http://127.0.0.1:${evil.address().port}`;
  let held = 0;
  const proposals = { pull: async (list) => { held = list.reduce((n, x) => n + String(x).length, 0); return 0; }, list: () => [], add: async () => ({ ok: false }), bound: () => null };
  const b = await serve(openStore(':memory:'), { plugins: [], port: 0, peers: [evilUrl], proposals });
  try {
    // the request side is capped (the #1469 fix holds there)
    const big = await new Promise((res) => { const r = request({ host: '127.0.0.1', port: b.port, path: '/node-facts', method: 'POST', headers: { 'content-length': BIG } }, (x) => { x.resume(); x.on('end', () => res(x.statusCode)); });
      r.on('error', (e) => res(`closed (${e.code})`)); r.end(Buffer.alloc(BIG, 0x61)); });
    const heapBefore = process.memoryUsage().heapUsed;
    assert.equal(typeof b.pullProposals, 'function');
    await b.pullProposals();
    const heapGrowthMB = Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e5) / 10;
    console.log('  FACTS (wf1489-bypass-body-limit-1):', JSON.stringify({ requestOf16MiB: big, peerAnswerSentMiB: sent / 1048576, heldByPullMiB: Math.round(held / 1048576 * 10) / 10, heapGrowthMB }));
    assert.ok(held <= 8 * 1024 * 1024, `a peer's ${sent / 1048576} MiB /proposals answer was read whole (${held} bytes reached proposals.pull) - no cap on the pull's read`);
  } finally { await b.close(); evil.close(); }
});

// kanban #2637: the cap sits on server.js's fetch itself, not on one read - every bare r.json() / r.text() / r.arrayBuffer() on a peer's
// answer passes it. This refuses a server.js read of the global fetch around that door, and checks the door caps every way of reading.
test('wf1489-bypass-body-limit-1 (#2637): server.js reads peers only through the capped fetch, and it caps every body reader', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(/^const fetch = answersUpTo\(\(\.\.\.a\) => globalThis\.fetch\(\.\.\.a\)\);$/m.test(src), 'server.js\'s fetch is the capped door');
  assert.equal((src.match(/globalThis\.fetch\b/g) || []).length, 1, 'no server.js read of the global fetch past the capped door');
  assert.ok(/^ {2}seasonFetch = answersUpTo\(seasonFetch\);$/m.test(src), 'a handed-in seasonFetch is capped too');
  const { answersUpTo, PEER_ANSWER_BYTES } = await import('../src/peer-read.js');
  const big = () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1048576).fill(0x61)); c.close(); } }));
  const f = answersUpTo(async () => big());
  assert.ok(PEER_ANSWER_BYTES <= 8 * 1048576);
  for (const how of ['json', 'text', 'arrayBuffer', 'bytes', 'blob']) await assert.rejects((await f('x'))[how](), /passed|more than/, `${how}() is capped`);
  await assert.rejects((await f('x')).clone().text(), /passed|more than/, 'a clone is capped');
  const small = answersUpTo(async () => new Response('{"proposals":[1,2]}'));
  assert.deepEqual(await (await small('x')).json(), { proposals: [1, 2] }, 'an honest answer reads as before');
  const stand = { ok: true, json: async () => ({ a: 1 }) };
  assert.equal(await answersUpTo(async () => stand)('x'), stand, 'a stand-in with no body is handed on');
});

// kanban #1592 (kept): the arbiter is a second http server; its open POST doors read the body through the same capped reader.
const { arbitrationMembers, serveArbiter } = await import('../src/arbiter.js');
const post = (port, path, bytes) => new Promise((res) => {
  const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, (x) => {
    let t = ''; x.on('data', (c) => { t += c; }); x.on('end', () => res(`${x.statusCode} ${t.slice(0, 80)}`)); });
  r.on('error', (e) => res(`closed (${e.code || e.message})`)); r.end(bytes);
});

test('#1469 bypass: the arbiter buffers an unbounded POST body (no 413, no close) - memory exhausted on an open door the fix never touched', async () => {
  const set = arbitrationMembers('regtest');
  const arb = await serveArbiter({ set, allow: () => ({ ok: false, why: 'no' }) });
  try {
    const big = Buffer.alloc(8 * 1024 * 1024, 0x61);   // 8 MiB, 128x the 64 KiB ARENA_BODY_MOST limit
    const heapBefore = process.memoryUsage().heapUsed;
    const gotBig = await post(arb.port, '/musig/nonce', big);
    const gotSmall = await post(arb.port, '/musig/nonce', Buffer.from('{"not":"a record"}'));
    const alive = await new Promise((res) => request({ host: '127.0.0.1', port: arb.port, path: '/status' }, (x) => { x.resume(); res(x.statusCode); }).on('error', () => res(0)).end());
    console.log('  ARBITER (wf1489):', JSON.stringify({ big: gotBig, small: gotSmall, alive, heapGrowthMB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e5) / 10 }));
    // The fix's own assertion, applied to the arbiter door: a body past the limit must be refused (413) or the connection ended.
    assert.match(gotBig, /^(413 |closed )/, `an 8 MiB body past a 64 KiB limit was read whole at the arbiter: ${gotBig}`);
  } finally { await arb.close(); }
});
