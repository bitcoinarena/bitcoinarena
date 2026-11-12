// kanban #1540 refute (#1489 v1, skeptic 3, "second copies"): #1723 put a byte bound on createGridBase's seatCatalog (GET /games), but
// the next reader in the same function - seatChains, every census seat's GET /headers (up to checkSeats = 16 at once, again every
// 15 min and on every census check) - still does `await r.arrayBuffer()` with no bound, and duty-guard headerHashes hashes every
// 80 bytes of it into a Set. One census seat answering 256 MB is held whole in the poster (the seat's own process). A real chain's
// headers are 80 bytes a block (testnet4: about 10 MB), so a bound far below 256 MB loses nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGridBase } from '../src/duty-day.js';

test('#1489-v1-refute-52-s3-2: the duty poster\'s read of a census seat\'s GET /headers is bounded too', async () => {
  const MB = 1048576, SEND = 256 * MB;
  let sent = 0;
  const evil = createServer((q, r) => {
    if (!q.url.startsWith('/headers')) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(MB);
    const pump = () => { while (sent < SEND) { sent += chunk.length; if (!r.write(chunk)) return r.once('drain', pump); } r.end(); };
    pump();
  });
  await new Promise((ok) => evil.listen(0, '127.0.0.1', ok));
  const E = `http://127.0.0.1:${evil.address().port}`;
  let held = 0, hashed = 0;
  const watched = async (u, o) => { const r = await fetch(u, o); const ab = r.arrayBuffer.bind(r);
    r.arrayBuffer = async () => { const v = await ab(); held = Math.max(held, v.byteLength); return v; }; return r; };
  try {
    const gb = createGridBase({ chainCall: async () => 0, censusEntriesAt: async () => [], contractAt: () => ({}), catalogSeats: async () => [],
      chainSeats: async () => [E], decode: () => null, idOf: () => new Uint8Array(32), blockHashOf: () => { hashed++; return new Uint8Array(32); },
      donationSetAt: () => null, fetchFn: watched });
    await gb.seatChains().catch(() => null);
    console.log(`the duty poster held ${Math.round(held / MB)} MB of one census seat's /headers (the seat sent ${Math.round(sent / MB)} MB), ${hashed} headers hashed`);
    assert.ok(held < 64 * MB && hashed < 64 * MB / 80, `one census seat's /headers answer was held whole: ${Math.round(held / MB)} MB, ${hashed} headers hashed`);
  } finally { evil.closeAllConnections?.(); evil.close(); }
});
