// Audit gossip r3 #1: the transcript read-back of postTranscript (relay.js:30) reads a relay's GET answer whole, with no
// size bound and no deadline. Every committee seat publishes each agreed run's transcript to the round's publication
// relays (and, when none keeps it, to the committee peers' announced addresses) inside settleTheStakes, BEFORE the
// stakes are settled. One relay - one seat listed as a relay or reached through the announced fallback - that answers
// PUT 201 and then streams an endless body fills the honest seat's memory; one that answers the headers and then
// stays silent holds the seat's close (and so the money settlement of the round) for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postTranscript } from '../src/relay.js';

const CHUNK = 64 * 1024;

// a fetcher standing in for fetch(): PUT kept; GET answered by `getAnswer(url, signal)`
function relays(getAnswer) {
  return async (url, o = {}) => {
    if (o.method === 'PUT') return new Response('kept', { status: 201 });
    return getAnswer(url, o.signal);
  };
}

test('a relay that answers its read-back with a huge body is not read whole (bounded by the transcript size)', async () => {
  const bytes = new Uint8Array(1024).fill(7);
  let pulled = 0;
  const TOTAL = 64 * 1024 * 1024;   // 64 MiB here; an attacker sends without end
  const fetcher = relays((url, signal) => new Response(new ReadableStream({
    pull(ctl) {
      if (signal && signal.aborted) { ctl.error(new Error('aborted')); return; }
      if (pulled >= TOTAL) { ctl.close(); return; }
      pulled += CHUNK; ctl.enqueue(new Uint8Array(CHUNK));
    },
    cancel() { /* reader gave up: what a bounded read does */ },
  }), { status: 200 }));
  const r = await postTranscript({ listed: ['http://evil.example'], announced: [], path: '/transcript/aa', bytes, fetcher,
    sameBytes: (x, y) => Buffer.from(x).equals(Buffer.from(y)) });
  assert.equal(r.held.length, 0);
  assert.ok(pulled <= 1024 * 1024, `the honest seat read ${pulled} bytes of one relay's read-back for a ${bytes.length}-byte transcript`);
});

test('a relay that answers its read-back headers and then stays silent does not hold the publish for good', async () => {
  const bytes = new Uint8Array(1024).fill(9);
  const fetcher = relays((url, signal) => {
    if (url.startsWith('http://good.example')) return new Response(bytes, { status: 200 });
    // headers sent, then nothing: only an abort ends it
    return new Response(new ReadableStream({
      start(ctl) { if (signal) signal.addEventListener('abort', () => ctl.error(new Error('aborted')), { once: true }); },
      pull() { return new Promise(() => {}); },
    }), { status: 200 });
  });
  const LIMIT_MS = 45000;
  let timer;
  const out = await Promise.race([
    postTranscript({ listed: ['http://silent.example', 'http://good.example'], announced: [], path: '/transcript/bb', bytes, fetcher,
      sameBytes: (x, y) => Buffer.from(x).equals(Buffer.from(y)) }),
    new Promise((res) => { timer = setTimeout(() => res('STALLED'), LIMIT_MS); }),
  ]);
  clearTimeout(timer);
  assert.notEqual(out, 'STALLED', `postTranscript had not returned after ${LIMIT_MS} ms: one silent relay holds the seat's publish (and settleTheStakes behind it)`);
  assert.deepEqual(out.held, ['http://good.example']);
});

