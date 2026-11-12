// kanban #1489 r1-play-2: ONE SEAT THAT NEVER ANSWERS GET /transcript MUST NOT HOLD THE PLAYER'S "SECURING YOUR RUN" FOR EVER.
// secureTranscript (transcript-upload.js, the §13A client duty the page runs before the victory screen) asks every committee
// node with Promise.all and no timeout. Six seats hold the whole run; the seventh accepts the request and never answers - so
// secureTranscript never returns, ARENA_SECURE_RUN never reaches got.safe or its 30 tries, and the page keeps saying
// "keep this tab open" over a run that is held (P4: one of k-of-n blocks all).
// Safe behaviour: each node gets a bounded wait; six agreeing holders answer safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secureTranscript } from '../src/transcript-upload.js';
import { encodeTranscript, transcriptHash } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(1), EID = b32(2);
const T = { roundId: RID, entryId: EID, batches: [], marks: [] };
const BYTES = encodeTranscript(T), HASH = toHex(transcriptHash(T));

test('six holders and one silent seat: secureTranscript answers safe in bounded time', async () => {
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `http://${x}`);
  const fetcher = (url) => {
    if (url.startsWith('http://g')) return new Promise(() => {});          // the one seat that never answers
    return Promise.resolve(new Response(BYTES, { status: 200, headers: { 'x-ticks': '100', 'x-transcript-hash': HASH } }));
  };
  const started = Date.now();
  const got = await Promise.race([
    secureTranscript({ roundId: RID, entryId: EID, nodes, finalTick: 100, fetcher }),
    new Promise((r) => setTimeout(() => r(null), 20000)),
  ]);
  assert.ok(got, `secureTranscript still waiting after ${Date.now() - started} ms on one silent seat while six hold the whole run`);
  assert.equal(got.safe, true, got.why);
});
