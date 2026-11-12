// kanban #1489 v1-refute-16 (#1508) variant: THE MIRROR IS THE SAME UNBOUNDED WAIT. The fix bounds each committee node's GET /transcript,
// but once enough nodes agree, secureTranscript awaits POST <mirror>/transcript with no timer and no signal. A configured mirror
// that takes the request and never answers holds "safe" for ever, though every seat holds the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secureTranscript } from '../src/transcript-upload.js';
import { encodeTranscript, transcriptHash } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(1), EID = b32(2);
const T = { roundId: RID, entryId: EID, batches: [], marks: [] };
const BYTES = encodeTranscript(T), HASH = toHex(transcriptHash(T));

test('seven holders and a silent mirror: secureTranscript answers safe in bounded time', async () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `http://${x}`);
  const fetcher = (url, o = {}) => {
    if (url.startsWith('http://mirror')) return new Promise(() => {});   // takes the POST, never answers
    return Promise.resolve(new Response(BYTES, { status: 200, headers: { 'x-ticks': '100', 'x-transcript-hash': HASH } }));
  };
  let t; const started = Date.now();
  const got = await Promise.race([
    secureTranscript({ roundId: RID, entryId: EID, nodes, finalTick: 100, mirror: 'http://mirror', fetcher, waitMs: 2000 }),
    new Promise((r) => { t = setTimeout(() => r(null), 15000); }),
  ]);
  clearTimeout(t);
  assert.ok(got, `secureTranscript still waiting after ${Date.now() - started} ms on a silent mirror while all seven seats hold the run`);
  assert.equal(got.safe, true, got.why);
});
