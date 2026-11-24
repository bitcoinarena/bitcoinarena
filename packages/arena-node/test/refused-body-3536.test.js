// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A REFUSED BODY IS ANSWERED AS REFUSED (kanban #3536): since #1911 a refused body waits for the door's answer instead of the socket being cut,
// and a door's bare `catch {}` around read() answered a body past the limit with 400 "a record is JSON". About 40 doors did the same.
// Now every catch around read() passes a refusal on (refusedBody), and the dispatch answers 413 by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';

process.env.ARENA_BODY_MOST = '65536';   // set before server.js loads: a small limit, so the test sends 1 MiB, not 8
const { openStore } = await import('../src/store.js');
const { serve } = await import('../src/server.js');

// THE ANSWER IS READ EVEN IF THE SEAT CLOSES THE SOCKET WHILE THE BODY IS STILL GOING OUT: the seat answers a refused body at once and closes
// after a short linger; a client that blindly writes all of 1 MiB can get EPIPE / ECONNRESET on macOS before it reads the answer. So the body goes
// out chunk by chunk, each after the last was flushed, the writing stops once an answer came, and a socket error after an answer is no failure.
const post = (port, path, bytes, { chunked = false } = {}) => new Promise((res) => {
  let answer = null, done = false;
  const finish = (s) => { if (!done) { done = true; res(s); } };
  const headers = { 'content-type': 'application/json', ...(chunked ? {} : { 'content-length': bytes.length }) };
  const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (x) => {
    let t = ''; answer = `${x.statusCode} `;
    x.on('data', (c) => { t += c; answer = `${x.statusCode} ${t.slice(0, 80)}`; });
    x.on('end', () => finish(answer)); x.on('error', () => finish(answer)); x.on('close', () => setTimeout(() => finish(answer), 20));
  });
  r.on('error', (e) => setTimeout(() => finish(answer || `closed (${e.code || e.message})`), 100));
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 16384) chunks.push(bytes.subarray(i, i + 16384));
  const next = (i) => {
    if (done || r.destroyed) return;
    if (answer != null) return;   // answered: the rest of the body is not sent
    if (i >= chunks.length) return r.end();
    r.write(chunks[i], (err) => { if (!err) setImmediate(() => next(i + 1)); });
  };
  next(0);
});

test('#3536 a body past the limit at a door that parses JSON is answered 413, declared or streamed; a bad small body is still 400', async () => {
  const b = await serve(openStore(':memory:'), { plugins: [], port: 0 });
  try {
    const big = Buffer.alloc(1024 * 1024, 0x61);
    const declared = await post(b.port, '/node-facts', big);
    const streamed = await post(b.port, '/node-facts', big, { chunked: true });
    const otherDoor = await post(b.port, '/series-publication', big);
    const small = await post(b.port, '/node-facts', Buffer.from('not json'));
    console.log('  FACTS (#3536):', JSON.stringify({ declared, streamed, otherDoor, small }));
    assert.match(declared, /^413 a body of more than 65536 bytes/, `a declared 1 MiB body: ${declared}`);
    assert.match(streamed, /^413 a body of more than 65536 bytes/, `a streamed 1 MiB body: ${streamed}`);
    assert.doesNotMatch(otherDoor, /^400 /, `another JSON door answered a 1 MiB body with 400: ${otherDoor}`);
    assert.match(small, /^400 a record is JSON/, `a small body that is not JSON: ${small}`);
  } finally { await b.close(); }
});

// every try around read(req) in server.js: its catch passes a refusal on (refusedBody) or answers it itself (tooLarge)
test('#3536 no catch around read() in server.js swallows a refused body', () => {
  const lines = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8').split('\n');
  const swallowing = [];
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf('await read(req');
    if (at < 0) continue;
    let inTry = false;
    for (let k = i; k >= Math.max(0, i - 4) && !inTry; k--) inTry = /\btry\s*\{/.test(k === i ? lines[k].slice(0, at) : lines[k]);
    if (!inTry) continue;
    for (let k = i; k < Math.min(lines.length, i + 25); k++) {
      const s = k === i ? lines[k].slice(at) : lines[k];
      const m = s.match(/\bcatch\s*(\(\s*\w+\s*\))?\s*\{.*/);
      if (!m) continue;
      if (!/refusedBody\(|tooLarge/.test(m[0])) swallowing.push(`server.js:${k + 1}: ${m[0].trim().slice(0, 100)}`);
      break;
    }
  }
  assert.deepEqual(swallowing, [], `catches that answer a refused body as a bad one:\n${swallowing.join('\n')}`);
});
