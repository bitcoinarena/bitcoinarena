// kanban #1540 refute (#1489 v1): the bound on another seat's GET /games was put on server.js's two readers (readNetworkApps,
// autoUpdate), but every node also reads every census seat's GET /games in its integrated duty poster (main.js -> duty-poster.js
// -> duty-day.js createGridBase seatCatalog, through familyOf on every pass) with `r.json()` and no byte or game bound, and
// duty-guard catalogOf walks every entry. One census seat answering a 120 MB listing grows the reading node's heap the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGridBase } from '../src/duty-day.js';

test('#1489-v1-refute-52-1: the duty poster\'s catalog read of a census seat\'s GET /games is bounded too', async () => {
  const ENTRY = '{"id":"00","manifest":"00","title":"x"},';
  const COUNT = 3_000_000;                                 // ~120 MB of listing
  const evil = createServer((q, r) => {
    if (!q.url.startsWith('/games')) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': 'application/json' });
    r.write('{"node":"' + '00'.repeat(32) + '","games":[');
    let i = 0;
    const chunk = ENTRY.repeat(10000);
    const pump = () => { while (i < COUNT) { i += 10000; if (!r.write(chunk)) return r.once('drain', pump); } r.end('{"id":"00","manifest":"00"}]}'); };
    pump();
  });
  await new Promise((ok) => evil.listen(0, '127.0.0.1', ok));
  const E = `http://127.0.0.1:${evil.address().port}`;
  let bodyBytesSent = 0;
  evil.on('connection', (s) => { const w = s.write.bind(s); s.write = (d, ...a) => { bodyBytesSent += d.length || 0; return w(d, ...a); }; });
  // the node's own fetch, watched: the heap it holds right after the answer is parsed, and how many listed games it parsed
  let peak = 0, parsedGames = 0;
  const base = process.memoryUsage().heapUsed;
  const watched = async (u, o) => { const r = await fetch(u, o); const json = r.json.bind(r);
    r.json = async () => { const v = await json(); peak = Math.max(peak, process.memoryUsage().heapUsed - base); parsedGames = Array.isArray(v && v.games) ? v.games.length : 0; return v; }; return r; };
  try {
    const gb = createGridBase({ chainCall: async () => 0, censusEntriesAt: async () => [], contractAt: () => ({}), catalogSeats: async () => [E],
      chainSeats: async () => [], decode: () => { throw new Error('not a manifest'); }, idOf: () => new Uint8Array(32), blockHashOf: () => null,
      donationSetAt: () => null, fetchFn: watched });
    await gb.seatCatalog().catch(() => null);
    const mb = Math.round(peak / 1048576);
    console.log(`the duty poster's heap grew ${mb} MB on one census seat's /games (the seat sent ${Math.round(bodyBytesSent / 1048576)} MB, ${parsedGames} games parsed)`);
    assert.ok(mb < 64 && parsedGames <= 64, `one census seat's /games answer took ${mb} MB of the reading node's heap in the duty poster's catalog read, ${parsedGames} games parsed`);
  } finally { evil.closeAllConnections?.(); evil.close(); }
});
