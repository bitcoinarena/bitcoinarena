// kanban #1489 v1-refute-16-s3 (#1508): THE SAME UNBOUNDED ASK, IN THE OTHER COPIES. #1508 bounded secureTranscript's per-seat
// GET /transcript, but the page and the replay page still walk the committee seat by seat with a bare fetch() and no timer, so
// ONE seat that takes the request and never answers holds them for ever while the next seats hold the run:
//  - Next Block's page (packages/nextblock/page/unity-page.js) prefetchReplayNodes -> ARENA_COPY_REPLAY: "copy game replay"
//    never copies when the first committee node is silent (the honest second node is never asked).
//  - the replay page (packages/nextblock/plugin/nextblock-replay.html): "asking <node> for the run..." for ever when the first
//    other committee node is silent, though the next one holds the transcript.
// Safe behaviour: each per-seat ask is bounded (as secureTranscript's NODE_WAIT_MS) and the next seat is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BOUND_MS = 15000;
const within = (p) => { let t; return Promise.race([p.finally(() => clearTimeout(t)), new Promise((r) => { t = setTimeout(() => r('STILL WAITING'), BOUND_MS); })]); };
// a fetch that never answers for the silent seat (it does honour an abort, as a real fetch does)
const fetchWith = (silentHost, answer) => (url, { signal } = {}) => String(url).startsWith(silentHost)
  ? new Promise((_, no) => { signal?.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError'))); })
  : Promise.resolve(answer(String(url)));

test('the page: one silent first seat does not hold "copy game replay" for ever (prefetchReplayNodes)', async () => {
  const src = readFileSync(new URL('../../nextblock/page/unity-page.js', import.meta.url), 'utf8');
  const a = src.indexOf('const replayNodes = new Map();'), b = src.indexOf('window.ARENA_COPY_REPLAY');
  assert.ok(a > 0 && b > a, 'prefetchReplayNodes is in the page');
  const fetch = fetchWith('http://silent', () => new Response(JSON.stringify({ stable: ['https://honest.example'], endpoints: [] }), { status: 200 }));
  const prefetch = new Function('fetch', `${src.slice(a, b)}\nreturn prefetchReplayNodes;`)(fetch);
  const got = await within(prefetch('ab'.repeat(32), ['http://silent', 'http://honest']));
  assert.deepEqual(got, ['https://honest.example'], `one silent seat held the replay link: ${JSON.stringify(got)}`);
});

test('the replay page: one silent committee seat does not hold "asking ... for the run" for ever', async () => {
  const html = readFileSync(new URL('../../nextblock/plugin/nextblock-replay.html', import.meta.url), 'utf8');
  const a = html.indexOf('  const here = location.origin'), b = html.indexOf('  if (!transcript) { say(');
  assert.ok(a > 0 && b > a, 'the node walk is in the replay page');
  const fetch = fetchWith('http://silent', (url) => {
    if (url.includes('/replay/nodes')) return new Response(JSON.stringify({ endpoints: ['http://silent', 'http://honest'] }), { status: 200 });
    if (url.startsWith('http://here')) return new Response('no', { status: 404 });
    return new Response(JSON.stringify({ batches: [] }), { status: 200 });
  });
  const said = [];
  const walk = new Function('fetch', 'location', 'say', 'round', 'entry',
    `return (async () => {\n${html.slice(a, b)}\n  return base;\n})();`);
  const got = await within(walk(fetch, { origin: 'http://here', pathname: '/replay' }, (s) => said.push(s), 'ab'.repeat(32), 'cd'.repeat(32)));
  assert.equal(got, 'http://honest', `the walk is held: ${got}; said: ${said.join(' | ')}`);
});
