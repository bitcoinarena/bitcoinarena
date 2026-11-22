// kanban #3160 refute (skeptic 2, one seat as the attacker): duty-poster.js dayTemplate builds a contract whose publication_relays[] is
// the poster seat's own address alone ([ownRelay]) unless ARENA_PUBLICATION_RELAYS is set. postTranscript asks the committee's announced
// addresses only after the listed pass ended with nothing held - so the one poster seat, answering the PUT just inside the deadline and then
// staying silent on the read-back, still holds every honest seat's publish of every entry for the whole RELAY_TIMEOUT_MS (15 s) although
// every honest peer would hold the bytes in milliseconds. settleTheStakes publishes the entries one after another, at every close run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postTranscript, RELAY_TIMEOUT_MS } from '../src/relay.js';

const bytes = new Uint8Array(1024).fill(7);
const honest = (o) => (o.method === 'PUT' ? new Response('kept', { status: 201 }) : new Response(bytes, { status: 200 }));
const silentBack = (o) => new Response(new ReadableStream({
  start(ctl) { o.signal?.addEventListener('abort', () => ctl.error(new Error('aborted')), { once: true }); },
  pull() { return new Promise(() => {}); },
}), { status: 200 });

test('the only listed relay (the poster seat) answering slowly does not hold the publish when committee peers hold the bytes', async () => {
  const fetcher = async (url, o = {}) => {
    if (url.startsWith('http://peer')) return honest(o);
    if (o.method === 'PUT') { await new Promise((r) => setTimeout(r, RELAY_TIMEOUT_MS - 500)); return new Response('kept', { status: 201 }); }
    return silentBack(o);
  };
  const t = Date.now();
  const out = await postTranscript({ listed: ['http://poster.example'], announced: ['http://peer1.example', 'http://peer2.example', 'http://poster.example'],
    path: '/transcript/cc', bytes, fetcher, sameBytes: (x, y) => Buffer.from(x).equals(Buffer.from(y)) });
  const took = Date.now() - t;
  assert.ok(out.held.length >= 1, `nothing held: ${JSON.stringify(out.refused)}`);
  assert.ok(took < 5000, `postTranscript took ${took} ms behind the one listed poster seat although peers held the bytes at once; `
    + `a 20-entry round's settleTheStakes waits ~${Math.round(took * 20 / 60000)} min per close run`);
});

test('a listed relay address that black-holes (no answer at all) does not hold the publish for the whole deadline', async () => {
  const fetcher = async (url, o = {}) => {
    if (url.startsWith('http://peer')) return honest(o);
    return new Promise((_, rej) => o.signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));   // a stopped tunnel
  };
  const t = Date.now();
  const out = await postTranscript({ listed: ['http://gone.example'], announced: ['http://peer1.example'],
    path: '/transcript/cc', bytes, fetcher, sameBytes: (x, y) => Buffer.from(x).equals(Buffer.from(y)) });
  const took = Date.now() - t;
  assert.deepEqual(out.held, ['http://peer1.example']);
  assert.ok(took < 5000, `postTranscript took ${took} ms on a black-holed listed relay before asking the peer that held the bytes`);
});
