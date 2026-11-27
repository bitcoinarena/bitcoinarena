// kanban #1489 r30-gossip-1: GET /reach-probe makes an honest seat dial the /identity of a census node, and reach-probe.js says "at most 64
// bytes read". probeOne reads the answer with r.arrayBuffer() through the process's global fetch (fetch-routes.js cappedFetch: no byte cap)
// and only then slices 64 bytes: a census node (one seat) answering its /identity with a gzip bomb has every probing seat inflate and hold
// all of it. Safe behaviour: probeOne reads no more than a small bound of the (decoded) answer, whatever the node sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { probeOne } from '../src/reach-probe.js';

const NODE = 'ab'.repeat(32);
const BOUND = 64 * 1024;

// a fetch that counts the decoded bytes the reader pulled from the answer's body
const counting = (counter) => async (u, o) => {
  const r = await globalThis.fetch(u, o);
  const t = new TransformStream({ transform(chunk, c) { counter.n += chunk.length; c.enqueue(chunk); } });
  return new Response(r.body ? r.body.pipeThrough(t) : null, { status: r.status, headers: r.headers });
};

test('#1489 r30-gossip-1: a gzip-bombed /identity answer is not inflated and held whole by GET /reach-probe', async () => {
  const inflated = 48 * 1048576;
  const bomb = gzipSync(Buffer.alloc(inflated, 0x61), { level: 9 });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip', 'content-length': bomb.length });
    res.end(bomb);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const counter = { n: 0 };
  try {
    const got = await probeOne(url, NODE, { fetchFn: counting(counter) });
    console.log(`sent ${bomb.length} bytes on the wire; probeOne read ${counter.n} decoded bytes; answer ${JSON.stringify(got)}`);
    assert.equal(got.reached, false);
    assert.ok(counter.n <= BOUND, `probeOne read ${counter.n} bytes of a node's /identity answer (${bomb.length} on the wire), more than ${BOUND}`);
  } finally { server.close(); }
});

test('#1489 r30-gossip-1: a streamed /identity answer is cut, not read to its end', async () => {
  const counter = { n: 0 };
  const chunk = new Uint8Array(1048576).fill(0x62);
  let left = 32;
  const fetchFn = async () => new Response(new ReadableStream({ pull(c) { if (left-- <= 0) return c.close(); counter.n += chunk.length; c.enqueue(chunk); } }), { status: 200 });
  const got = await probeOne('https://node.example', NODE, { fetchFn });
  console.log(`probeOne pulled ${counter.n} bytes; answer ${JSON.stringify(got)}`);
  assert.ok(counter.n <= 2 * 1048576, `probeOne pulled ${counter.n} bytes of a 32 MiB /identity answer`);
});
