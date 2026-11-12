// kanban #2018, #2052: the bounded census reads keep the honest path - every seat's whole chain of headers is still read (the bound is
// the reader's own tip plus PEER_HEADERS_SLACK blocks), more seats than one batch are all read, and a stand-in with no body still answers
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGridBase } from '../src/duty-day.js';
import { PEER_HEADERS_SLACK } from '../src/peer-read.js';

const headers = (n) => { const b = Buffer.alloc(n * 80); for (let i = 0; i < n; i++) b.writeUInt32LE(i, i * 80); return b; };
const hashOf = (h) => { const x = new Uint8Array(32); x.set(h.subarray(0, 4)); return x; };

test('#2052: honest seats\' GET /headers are read whole, all of them, a few at a time', async () => {
  const TIP = 5000, body = headers(TIP + 1);
  let open = 0, most = 0;
  const seat = createServer((q, r) => { open++; most = Math.max(most, open); setTimeout(() => { open--; r.writeHead(200, { 'content-type': 'application/octet-stream' }); r.end(body); }, 30); });
  await new Promise((ok) => seat.listen(0, '127.0.0.1', ok));
  const U = `http://127.0.0.1:${seat.address().port}`;
  try {
    const gb = createGridBase({ chainCall: async (m) => (m === 'getblockcount' ? TIP : null), censusEntriesAt: async () => [], contractAt: () => ({}), catalogSeats: async () => [],
      chainSeats: async () => Array.from({ length: 10 }, () => U), decode: () => null, idOf: () => new Uint8Array(32),
      blockHashOf: hashOf, donationSetAt: () => null });
    const c = await gb.seatChains();
    assert.equal(c.sets.length, 10);
    assert.ok(c.sets.every((s) => s && s.size === TIP + 1), 'every seat\'s whole chain read');
    assert.ok(most <= 4, `at most 4 seats read at once, ${most} seen`);
    // a seat a little ahead of the reader (within the slack) is still read; one far past it is not
    const ahead = createGridBase({ chainCall: async () => TIP - PEER_HEADERS_SLACK + 10, censusEntriesAt: async () => [], contractAt: () => ({}), catalogSeats: async () => [],
      chainSeats: async () => [U], decode: () => null, idOf: () => new Uint8Array(32), blockHashOf: hashOf, donationSetAt: () => null });
    assert.equal((await ahead.seatChains()).sets[0].size, TIP + 1);
    const far = createGridBase({ chainCall: async () => 100, censusEntriesAt: async () => [], contractAt: () => ({}), catalogSeats: async () => [],
      chainSeats: async () => [U], decode: () => null, idOf: () => new Uint8Array(32), blockHashOf: hashOf, donationSetAt: () => null });
    assert.equal((await far.seatChains()).sets[0], null);
  } finally { seat.closeAllConnections?.(); seat.close(); }
  // an injected stand-in (no body) offers its arrayBuffer
  const stand = createGridBase({ chainCall: async () => 3, censusEntriesAt: async () => [], contractAt: () => ({}), catalogSeats: async () => [],
    chainSeats: async () => ['x'], decode: () => null, idOf: () => new Uint8Array(32), blockHashOf: hashOf, donationSetAt: () => null,
    fetchFn: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(headers(4)).buffer }) });
  assert.equal((await stand.seatChains()).sets[0].size, 4);
});
