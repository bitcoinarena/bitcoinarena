// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3689 (#1489 bypass of #1469) (every body has a limit): series-pull.js caps a peer's GET /series listing (#2424, PULL_LISTING_BYTES)
// but reads the same peer's GET /series-template?id= answer with a bare res.text() - a seat that lists one id and answers its line
// with a body of any size is buffered whole (and decoded to a string) by every node that pulls from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSeriesPull } from '../src/series-pull.js';

const ID = 'ab'.repeat(32);
const SENT = 48 * 1024 * 1024;   // what the peer streams as its "line"; an honest series line is a few kilobytes

test('#1489 bypass #1469: a peer\'s /series-template answer is read up to a cap, not whole', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const srv = createServer((req, res) => {
    if (req.url === '/series') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ series: [{ series: ID, ahead: 1 }] })); }
    if (req.url.startsWith('/series-template')) {
      res.writeHead(200, { 'content-type': 'text/plain' });   // chunked: no Content-Length to refuse unread
      let left = SENT / chunk.length;
      const more = () => { while (left > 0) { left--; if (!res.write(chunk)) return res.once('drain', more); } res.end(); };
      res.on('error', () => {}); req.socket.on('error', () => {});
      return more();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const root = `http://127.0.0.1:${srv.address().port}`;
  let longest = 0;
  const pull = createSeriesPull({
    peers: () => [root], held: () => [],
    parse: (line) => { longest = Math.max(longest, line.length); throw new Error('not a series line'); },
    idOf: () => ID, take: async () => ({ ok: false, why: 'never' }), timeoutMs: 30000, passMs: 60000,
  });
  try {
    const heap0 = process.memoryUsage().rss;
    const out = await pull.pass();
    console.log('  FACTS (#1489 bypass #1469):', JSON.stringify({ lineCharsHandedToParse: longest, sentBytes: SENT, rssGrowthMB: Math.round((process.memoryUsage().rss - heap0) / 1048576), refused: out.refused }));
    assert.ok(longest <= 1024 * 1024, `a peer's /series-template answer of ${longest} chars was read whole (an honest line is a few KB)`);
  } finally { srv.closeAllConnections?.(); await new Promise((ok) => srv.close(ok)); }
});
