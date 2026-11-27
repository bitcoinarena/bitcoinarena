// kanban #1489 r41 census-1: the page's round read (join.js fetchRound - reached from committee.js roundAttestors and the join) takes
// one seat's GET /round?id= answer whole (r.arrayBuffer(), no byte cap), where every other page read of a seat is bounded (#2740:
// census 4 MiB, committee 64 KiB, seating 256 KiB) and the attestor's / market's GET /round reads were capped (#1829, #2702).
// SAFE: a round contract is a few hundred bytes; a seat streaming a padded answer has at most a small bound of it read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRound } from '../src/join.js';

test('fetchRound stops reading one seat\'s padded GET /round answer at a small bound', async () => {
  const id = 'ab'.repeat(32);
  const TOTAL = 64 * 1024 * 1024, CHUNK = 1024 * 1024;
  let pulled = 0;
  const fetcher = async (url) => {
    if (!String(url).includes('/round?id=')) return new Response('', { status: 404 });
    const body = new ReadableStream({
      pull(ctl) {
        if (pulled >= TOTAL) { ctl.close(); return; }
        pulled += CHUNK; ctl.enqueue(new Uint8Array(CHUNK));
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: 200 });
  };
  await fetchRound(id, ['http://liar.example/s1'], { fetcher }).catch(() => null);
  console.log(`bytes pulled from the liar seat: ${pulled}`);
  assert.ok(pulled <= 1024 * 1024, `the page read ${pulled} bytes of one seat's GET /round answer (no cap)`);
});
