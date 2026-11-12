// kanban #2027 (#1508, #1868, #1489): the replay page's per-seat bound is on the ANSWER and on a body that STALLS, never on the whole
// transfer. An honest seat sending its run slowly (one chunk a second, ~12 s in all, past the 8 s answer bound) is still read; a seat
// whose body stops after its headers is skipped and the next seat is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../nextblock/plugin/nextblock-replay.html', import.meta.url), 'utf8');
const a = html.indexOf('  const here = location.origin'), b = html.indexOf('  if (!transcript) { say(');
const walkOf = () => new Function('fetch', 'location', 'say', 'round', 'entry', `return (async () => {\n${html.slice(a, b)}\n  return { base, transcript };\n})();`);
const enc = new TextEncoder();
// a body sent in `parts` chunks, `gapMs` apart; `stopAfter` chunks and then nothing (the stream stays open)
const slowBody = (text, parts, gapMs, stopAfter = Infinity, signal) => new ReadableStream({
  async start(c) {
    const bytes = enc.encode(text), step = Math.ceil(bytes.length / parts);
    signal?.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
    for (let i = 0; i < parts; i++) {
      if (i >= stopAfter) return;
      await new Promise((r) => setTimeout(r, gapMs));
      if (signal?.aborted) return;
      c.enqueue(bytes.slice(i * step, (i + 1) * step));
    }
    c.close();
  },
});
const run = JSON.stringify({ batches: [], note: 'x'.repeat(4000) });
const fetchFor = (seats) => async (url, { signal } = {}) => {
  url = String(url);
  if (url.includes('/replay/nodes')) return new Response(JSON.stringify({ endpoints: Object.keys(seats) }), { status: 200 });
  if (url.startsWith('http://here')) return new Response('no', { status: 404 });
  const how = seats[Object.keys(seats).find((s) => url.startsWith(s))];
  return new Response(how(signal), { status: 200 });
};
const loc = { origin: 'http://here', pathname: '/replay' };

test('an honest seat sending its run slowly (past the 8 s answer bound) is read, not cut off', async () => {
  const got = await walkOf()(fetchFor({ 'http://slow': (signal) => slowBody(run, 12, 1000, Infinity, signal) }), loc, () => {}, 'ab'.repeat(32), 'cd'.repeat(32));
  assert.equal(got.base, 'http://slow');
  assert.equal(got.transcript.note.length, 4000);
});

test('a seat whose body stalls after its headers is skipped, and the next seat gives the run', async () => {
  const t0 = Date.now();
  const got = await walkOf()(fetchFor({
    'http://stall': (signal) => slowBody(run, 4, 10, 1, signal),
    'http://honest': () => run,
  }), loc, () => {}, 'ab'.repeat(32), 'cd'.repeat(32));
  assert.equal(got.base, 'http://honest');
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
});
