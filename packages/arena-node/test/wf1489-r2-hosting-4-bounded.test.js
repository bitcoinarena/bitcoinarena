// kanban #1489 round 2 (hosting): ONE SEAT'S GET /games IS READ WHOLE, HOWEVER LARGE.
// readNetworkApps (every 5 min, and on any stranger's GET /network-games?fresh=1) and autoUpdate (every 10 min) read each
// known seat's GET /games with `await r.json()` - no byte limit, no limit on the number of games; each listed manifest is
// then decoded. Any seat in the census or the peers list answers with a few hundred MB of listing and every seat that reads
// it holds the whole body and its parsed objects at once (a public GET with ?fresh=1 starts the read on demand).
// Safe behaviour: a seat's /games answer is read up to a bound (bytes and games) and anything past it is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';

test('#1489-r2-hosting-4: a seat\'s oversized GET /games listing is not read whole into the reading seat', async () => {
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
  const b = await serve(openStore(), { plugins: [], port: 0, peers: [E] });
  try {
    let peak = 0;
    const base = process.memoryUsage().heapUsed;
    const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed - base); }, 5);
    const r = await fetch(`http://127.0.0.1:${b.port}/network-games?fresh=1`);
    const j = await r.json();
    clearInterval(iv);
    const seat = (j.seats || []).find((s) => s.seat === E);
    const mb = Math.round(peak / 1048576);
    console.log(`the reading seat's heap grew ${mb} MB on one seat's /games (answered=${seat && seat.answered}, games=${seat && seat.games})`);
    assert.ok(mb < 64, `one seat's /games answer took ${mb} MB of the reading seat's heap; read as ${seat && seat.games} games`);
  } finally { await b.close(); evil.close(); }
});
