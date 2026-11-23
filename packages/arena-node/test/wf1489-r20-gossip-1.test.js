// #1489 r20 gossip: a node's bandwidth probe reads a peer's GET /node-facts/probe answer whole (r.arrayBuffer(), no cap) -
// one peer among the first three streams for the 30 s the read is allowed and the measuring node buffers all of it.
// Safe behaviour: the probe reads at most a bounded amount past PROBE_BYTES and drops the rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureBandwidth, PROBE_BYTES } from '../src/node-facts.js';

test('a peer streaming an endless probe answer is not buffered whole', async () => {
  const CHUNK = 1 << 20, TOTAL = 256 * CHUNK;   // 256 MiB offered
  let pulled = 0;
  const fetcher = async () => new Response(new ReadableStream({
    pull(c) { if (pulled >= TOTAL) { c.close(); return; } pulled += CHUNK; c.enqueue(new Uint8Array(CHUNK)); },
  }), { status: 200 });
  let t = 0;
  await measureBandwidth(['http://peer.invalid'], { fetcher, nowMs: () => (t += 1000) });
  assert.ok(pulled <= 4 * PROBE_BYTES, `the probe pulled ${pulled} bytes from one peer (cap expected near ${PROBE_BYTES})`);
});
