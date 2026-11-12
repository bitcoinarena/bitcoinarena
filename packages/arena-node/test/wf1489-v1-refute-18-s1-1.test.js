// #1489 v1-refute-18 finding 1: #1507 bounded carryReveals in time AND SIZE ("A huge body did the same by memory"), and #1550
// says "EVERY PEER PULL HAS A DEADLINE AND A SIZE CAP" - but Verifier.signersNaming (the same file, reached from the entry relay
// takeAcceptedEntry) still reads a peer's GET /results with a bare answer.arrayBuffer(): no cap. One committee seat answers a
// body far past PEER_BODY_MAX_BYTES (16 MiB) inside the 2.5 s deadline, and the seat buffers all of it - in parallel for every
// peer, per entry asked. Safe behaviour: the read stops at the cap (as peerBody does), so the bad seat can push only ~cap bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Verifier } from '../src/verify.js';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

test('#1489 v1-refute-18-s1-1: signersNaming reads a peer /results body without a size cap', async () => {
  const TOTAL = 96; // MiB the bad seat offers
  let flushed = 0;
  const bad = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(1 << 20, 7); let n = 0;
    const go = () => { while (n < TOTAL) { n++; const ok = res.write(chunk, () => { flushed += chunk.length; }); if (!ok) return res.once('drain', go); } res.end(); };
    go();
  });
  const url = await listen(bad);
  const round = { signerNodes: () => [new Uint8Array(32)] };
  const v = new Verifier(round, { peers: [url] });
  await v.signersNaming(new Uint8Array(randomBytes(32)), new Uint8Array(randomBytes(32)), new Uint8Array(randomBytes(32)));
  await new Promise((r) => setTimeout(r, 300));
  bad.closeAllConnections(); bad.close();
  const mib = Math.round(flushed / (1 << 20));
  assert.ok(mib < 40, `the seat took ${mib} MiB of one peer's /results into memory (cap 16 MiB): one committee seat can blow up every seat that relays an entry`);
});
