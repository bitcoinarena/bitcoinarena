// A READ AFTER THE EVENT LOOP WAS HELD PAST THE SERVER'S KEEP-ALIVE (M3.3-27).
//
// Measured on the regtest rehearsal: `Client.at` refused in 9-12 ms, "only 1 of
// 2 providers gave a chain", in 7 of 21 runs - and the provider's own words,
// once carried into the error, were `fetch failed: ECONNRESET`. The socket
// watcher on the probe showed every one: a REUSED keep-alive socket, idle
// ~6000 ms, the daemon closing its side 0 ms before. The rehearsal holds the
// event loop in its world search before a player sits; the probe holding it
// 6000 ms synchronously refused 20 of 20, 3000 ms refused 0 of 20. Node's
// fetch reuses a pooled socket the server has already let go; a browser asks
// again on its own, and so the page never met this - a Node client did.
//
// The shape, measured on a bare server: three pooled sockets to one origin, the
// loop held 6 s, the next read resets (3 of 3); one socket, or a keep-alive
// shorter than Node's default 5 s (2 s held 3 s, 1 s held 2.5 s), does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { headersOverHttp } from '../src/headers.js';
import { bondProvider } from '../src/join.js';

const hold = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* held, as a replay holds it */ } };
const HOLD_MS = 6000;   // past the server's default 5 s keep-alive

async function serving(body, type) {
  const s = createServer((req, res) => { res.setHeader('content-type', type); res.end(body); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${s.address().port}/x`,
    close: async () => { s.closeAllConnections(); await new Promise((r) => s.close(r)); },
  };
}

test('the headers provider still reads after the loop was held past the server\'s keep-alive', async () => {
  const srv = await serving(new Uint8Array(240), 'application/octet-stream');
  try {
    // three pooled sockets to the origin, as a round's own fetches leave them
    await Promise.all([0, 1, 2].map(() => headersOverHttp(srv.url)));
    hold(HOLD_MS);
    const got = await headersOverHttp(srv.url);
    assert.equal(got.length, 3, 'the provider gave no chain because a dead pooled socket was reused');
  } finally { await srv.close(); }
});

test('the bond provider still reads after the loop was held past the server\'s keep-alive', async () => {
  const srv = await serving(JSON.stringify({ hex: '00', merkle: [], pos: 0 }), 'application/json');
  try {
    const bond = bondProvider(srv.url);
    await Promise.all([0, 1, 2].map(() => bond()));
    hold(HOLD_MS);
    const got = await bond();
    assert.equal(got.transaction.length, 1, 'the bond provider gave nothing because a dead pooled socket was reused');
  } finally { await srv.close(); }
});
