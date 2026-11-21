// kanban #3012: the card's test
// Audit gossip r1 #2: a guardian seat of a halted federation posts its spent-set copy to every seat and reads each refusal's body whole
// (spent-set-producer.js publishSpentSet). One seat answers 500 with an endless body: the guardian buffers all of it (no cap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishSpentSet } from '../src/spent-set-producer.js';

const MiB = 1024 * 1024;
function bombAnswer(totalBytes, counter) {
  const chunk = new Uint8Array(64 * 1024).fill(0x41);
  let sent = 0;
  const body = new ReadableStream({
    pull(ctl) {
      if (sent >= totalBytes) { ctl.close(); return; }
      ctl.enqueue(chunk); sent += chunk.length; counter.bytes = sent;
    },
  });
  return new Response(body, { status: 500 });
}

test('a seat\'s refusal of POST /liquidations/spent-set is read up to a small bound, not whole', async () => {
  const counter = { bytes: 0 };
  const fetcher = async (url) => (String(url).startsWith('http://evil') ? bombAnswer(48 * MiB, counter) : new Response('{"ok":true}', { status: 200 }));
  const out = await publishSpentSet({ spentSet: '00', signature: '00' }, ['http://honest', 'http://evil'], { fetcher });
  assert.equal(out.filter((x) => x.ok).length, 1);
  assert.ok(counter.bytes <= 1 * MiB, `the guardian read ${(counter.bytes / MiB).toFixed(1)} MiB of one seat's refusal - no bound`);
});

