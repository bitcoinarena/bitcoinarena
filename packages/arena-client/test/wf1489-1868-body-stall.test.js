// kanban #1868 (#1489 v1-refute-16-s2, #1508): the count reads headers only; bytes are read only for the mirror, one holder at a time,
// bounded by a stall and a total - so a holder whose body stops (or dribbles) cannot hold the mirror step, and the next holder's
// checked bytes are mirrored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secureTranscript } from '../src/transcript-upload.js';
import { encodeTranscript, transcriptHash } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(1), EID = b32(2);
const T = { roundId: RID, entryId: EID, batches: [], marks: [] };
const BYTES = encodeTranscript(T), HASH = toHex(transcriptHash(T));
const H = { 'x-ticks': '100', 'x-transcript-hash': HASH };

// a body that sends its first byte and then nothing (stall), or one byte every 100 ms for ever (dribble)
const stalled = (signal) => new Response(new ReadableStream({ start(c) { c.enqueue(BYTES.slice(0, 1)); signal?.addEventListener('abort', () => { try { c.error(new Error('aborted')); } catch {} }); } }), { status: 200, headers: H });
const dribble = (signal) => { let t; return new Response(new ReadableStream({
  start(c) { t = setInterval(() => { try { c.enqueue(new Uint8Array([0])); } catch { clearInterval(t); } }, 100); signal?.addEventListener('abort', () => { clearInterval(t); try { c.error(new Error('aborted')); } catch {} }); },
  cancel() { clearInterval(t); } }), { status: 200, headers: H }); };

for (const [name, bad] of [['stalls', stalled], ['dribbles', dribble]]) {
  test(`the first holder's body ${name}: safe, and the next holder's checked bytes reach the mirror in bounded time`, async () => {
    const posted = [];
    const fetcher = async (url, o = {}) => {
      if (o.method === 'POST') { posted.push(o.body.length); return new Response(null, { status: 201 }); }
      if (url.startsWith('http://a')) return bad(o.signal);
      return new Response(BYTES, { status: 200, headers: H });
    };
    const started = Date.now();
    const got = await secureTranscript({ roundId: RID, entryId: EID, nodes: ['http://a', 'http://b', 'http://c', 'http://d', 'http://e'], finalTick: 100, mirror: 'http://mirror', fetcher, waitMs: 300 });
    assert.equal(got.safe, true, got.why);
    assert.equal(got.mirrored, true, got.why);
    assert.deepEqual(posted, [BYTES.length]);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  });
}
