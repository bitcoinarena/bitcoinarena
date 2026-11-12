// kanban #1874 (refute of #1540, #1489): what one GET /network-games read can make a seat hold is bounded by the number of seats read at once,
// not by the number of seats it knows - and it reads at most NETWORK_SEATS_MAX (64) of them. Here the seats are the node's own peers
// (trusted names, not a stranger's announcements): 100 peers, each answering a 4 MB listing; one pass reads at most 12 MB in all and stays below 64 MB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';

test('#1874: 100 peers with 4 MB listings - at most 64 named, a few read at a time within one budget, the seat holds < 64 MB', async () => {
  const SRC = `const BODY = '{"games":[{"id":"00","manifest":"00","title":"' + 'x'.repeat(4 * 1048576 - 200) + '"}]}';
    let asked = 0, open = 0, most = 0;
    const s = require('node:http').createServer((q, r) => {
      if (q.url === '/count') { r.writeHead(200); return r.end(JSON.stringify({ asked, most })); }
      if (!/\\/games$/.test(q.url.split('?')[0])) { r.writeHead(404); return r.end(); }
      asked++; open++; most = Math.max(most, open);
      setTimeout(() => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(BODY, () => { open--; }); }, 20);
    });
    s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + '\\n'));`;
  const evil = spawn(process.execPath, ['-e', SRC], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((ok) => evil.stdout.once('data', (d) => ok(Number(String(d).trim()))));
  const peers = Array.from({ length: 100 }, (_, i) => `http://127.0.0.1:${port}/p${i}`);
  const b = await serve(openStore(), { plugins: [], port: 0, peers });
  try {
    const mem = () => { const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };
    global.gc?.();
    const base = mem();
    let peak = 0;
    const iv = setInterval(() => { peak = Math.max(peak, mem() - base); }, 2);
    const j = await (await fetch(`http://127.0.0.1:${b.port}/network-games?fresh=1`)).json();
    clearInterval(iv);
    const c = JSON.parse(await (await fetch(`http://127.0.0.1:${port}/count`)).text());
    const mb = Math.round(peak / 1048576);
    console.log(`100 peers: ${c.asked} listings read, at most ${c.most} at once, ${(j.seats || []).length} seats in the answer, grew ${mb} MB`);
    assert.equal((j.seats || []).length, 64, 'at most NETWORK_SEATS_MAX seats are named');
    assert.ok(c.asked <= 64, `${c.asked} listings asked for`);
    assert.ok(c.most <= 2, `at most 2 listings read at once, not ${c.most}`);
    assert.ok(mb < 64, `one read held ${mb} MB`);
  } finally { await b.close(); evil.kill(); }
});
