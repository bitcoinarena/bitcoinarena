// #1489 v1-refute-18 skeptic 2, finding 1: #1507/#1550/#1685 put a deadline AND a size cap on every peer pull in verify.js, but the
// head-to-head close does not start in verify.js: afterClose first runs membersKnown (server.js), which asks every peer's
// GET /api/round-result through entry-relay.js seatView - a bare r.json() under only a 3 s timeout, no size cap - and asks again
// every finality pass (`for (;;)`, every ~2 s) until the result window. One committee seat answers a body far past any cap inside the
// deadline and every seat buffers and parses all of it, on every pass, before its h2h close may even reach carryReveals.
// Safe behaviour: the read stops at a cap like peerBody's (16 MiB), so a bad seat pushes only ~cap bytes per ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { seatView, lookAtMembers } from '../src/entry-relay.js';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

test('#1489 v1-refute-18-s2-1: the h2h members look (seatView) reads a peer /api/round-result without a size cap', async () => {
  const TOTAL = 96; // MiB the bad seat offers, a JSON string that never ends early
  let flushed = 0;
  const bad = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"players":[],"pad":"');
    const chunk = Buffer.alloc(1 << 20, 0x61); let n = 0;
    const go = () => { while (n < TOTAL) { n++; const ok = res.write(chunk, () => { flushed += chunk.length; }); if (!ok) return res.once('drain', go); } res.end('"}'); };
    go();
  });
  const url = await listen(bad);
  const look = await lookAtMembers({ roundId: new Uint8Array(32), roundHex: '00'.repeat(32), peers: [url], slots: 7, needed: 5, players: 2,
    held: new Set(['aa'.repeat(32)]), viewOf: seatView((...a) => globalThis.fetch(...a)), take: async () => ({ ok: false, why: 'x' }), voidEntry: async () => {} });
  await new Promise((r) => setTimeout(r, 300));
  bad.closeAllConnections(); bad.close();
  const mib = Math.round(flushed / (1 << 20));
  console.log(`  FACTS: answered=${look.answered} taken=${mib} MiB`);
  assert.ok(mib < 40, `the seat took ${mib} MiB of one peer's /api/round-result into memory (peerBody's cap is 16 MiB) - and membersKnown asks again every pass`);
});
