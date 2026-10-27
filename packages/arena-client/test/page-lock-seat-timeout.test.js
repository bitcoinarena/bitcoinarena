// A SEAT THAT NEVER ANSWERS (measured 2026-10-27: a market bot's collect waited 13 min on one seat that took the connection
// and never answered): every read collect makes of a seat carries a timeout, so a hung seat is a seat that said nothing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlementOf, federationSettlementsOf, findLock, forfeitOf } from '../src/page-lock.js';

const roundId = new Uint8Array(32).fill(7);
const hung = () => {
  const asked = [];
  const fetcher = (url, opts = {}) => {
    asked.push({ url, signal: opts.signal });
    // a seat that holds the connection and answers only when the caller gives up
    return new Promise((_, reject) => {
      if (!opts.signal) return;
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  return { asked, fetcher };
};

test('each collect read of a seat carries an abort signal', async () => {
  const reads = [
    (fetcher) => settlementOf({ roundId, nodes: ['http://a'], fetcher }),
    (fetcher) => federationSettlementsOf({ roundId, nodes: ['http://a'], fetcher }),
    (fetcher) => findLock({ roundId, playerPubkey: new Uint8Array(33).fill(2), nodes: ['http://a'], fetcher }),
    (fetcher) => forfeitOf({ roundId, entryId: 'ab'.repeat(32), nodes: ['http://a'], fetcher }),
  ];
  for (const read of reads) {
    const { asked, fetcher } = hung();
    read(fetcher).catch(() => {});
    await new Promise((r) => setImmediate(r));
    assert.equal(asked.length, 1);
    assert.ok(asked[0].signal instanceof AbortSignal, `${asked[0].url} is asked with no timeout`);
    assert.equal(asked[0].signal.aborted, false);
  }
});
