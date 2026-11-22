// kanban #3001 refute: the relays of one pass are "asked side by side", but postTranscript returns only when the SLOWEST relay
// gives up. A committee seat listed as a publication relay that answers PUT just inside the deadline and then stays silent on
// the read-back holds every honest seat's publish of every entry for ~2 x RELAY_TIMEOUT_MS (30 s) even though an honest relay
// held the bytes in milliseconds - and settleTheStakes (server.js) publishes the round's entries one after another, so the
// money settlement of a round of E entries waits E x 30 s behind the one bad relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postTranscript, RELAY_TIMEOUT_MS } from '../src/relay.js';

test('an honest relay that held the transcript is not held back by a slow listed relay', async () => {
  const bytes = new Uint8Array(1024).fill(5);
  const fetcher = async (url, o = {}) => {
    if (url.startsWith('http://good.example')) return o.method === 'PUT' ? new Response('kept', { status: 201 }) : new Response(bytes, { status: 200 });
    if (o.method === 'PUT') {   // the PUT answered just inside its deadline
      await new Promise((r) => setTimeout(r, RELAY_TIMEOUT_MS - 200));
      return new Response('kept', { status: 201 });
    }
    return new Response(new ReadableStream({   // read-back: headers, then nothing until the abort
      start(ctl) { o.signal?.addEventListener('abort', () => ctl.error(new Error('aborted')), { once: true }); },
      pull() { return new Promise(() => {}); },
    }), { status: 200 });
  };
  const t = Date.now();
  const out = await postTranscript({ listed: ['http://slow.example', 'http://good.example'], announced: [], path: '/transcript/cc', bytes, fetcher,
    sameBytes: (x, y) => Buffer.from(x).equals(Buffer.from(y)) });
  const took = Date.now() - t;
  assert.deepEqual(out.held, ['http://good.example']);
  const ENTRIES = 20;
  assert.ok(took < 5000, `postTranscript returned after ${took} ms although good.example held the bytes at once: `
    + `settleTheStakes publishes entries one after another, so a ${ENTRIES}-entry round's settlement waits ~${Math.round(took * ENTRIES / 60000)} min behind one slow relay`);
});
