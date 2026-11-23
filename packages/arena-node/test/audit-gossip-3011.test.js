// kanban #3011: the card's test
// Audit gossip r1 #1: the duty poster's POST /series to every census seat reads a refusal's body whole (grid-build.js postSeriesLine).
// One census seat answers 503 with an endless "no chain view ..." body: the poster buffers all of it (no cap), as #2705/#2706/#3001 did elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postSeriesLine } from '../src/grid-build.js';

const MiB = 1024 * 1024;
function bombAnswer(totalBytes, counter) {
  const chunk = new TextEncoder().encode('no chain view yet '.padEnd(64 * 1024, 'x'));
  let sent = 0;
  const body = new ReadableStream({
    pull(ctl) {
      if (sent >= totalBytes) { ctl.close(); return; }
      ctl.enqueue(chunk); sent += chunk.length; counter.bytes = sent;
    },
  });
  return new Response(body, { status: 503, headers: { 'content-type': 'text/plain' } });
}

test('a census seat\'s refusal of POST /series is read up to a small bound, not whole', async () => {
  const counter = { bytes: 0 };
  const honest = async () => new Response('taken', { status: 200 });
  const fetchFn = async (url) => (String(url).startsWith('http://evil') ? bombAnswer(48 * MiB, counter) : honest());
  const out = await postSeriesLine('line', [['honest', 'http://honest'], ['evil', 'http://evil']], { fetchFn, tries: 1, waitMs: 0 });
  assert.equal(out.took, 1);
  assert.ok(counter.bytes <= 1 * MiB, `the poster read ${(counter.bytes / MiB).toFixed(1)} MiB of one seat's refusal - no bound`);
});

