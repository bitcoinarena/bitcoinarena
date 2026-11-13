// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 bypass of #1469 (feedback #001: one huge body fills a seat's memory), on EVERY seat with no ballot or guardian wiring: 30 s
// after start and every 10 min, pullEmergencies and pullDepartures (server.js) read each network seat's GET /emergency-departures and
// GET /absences with a bare `r.json()` - no cap. One seat in networkSeats() answering a 32 MiB body (4x the 8 MiB a request may carry,
// 512x the 64 KiB limit set here) is read to its last byte and parsed whole, twice a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ARENA_BODY_MOST = '65536';
const { openStore } = await import('../src/store.js');
const { serve } = await import('../src/server.js');

const BIG = 32 * 1024 * 1024;

test('wf1489-bypass-body-limit-2: a peer seat\'s /emergency-departures and /absences answers far past the body limit are read whole by the 30 s pull', { timeout: 90000 }, async () => {
  const served = {};
  const evil = createServer(async (req, res) => {
    const door = req.url.split('?')[0];
    if (door !== '/emergency-departures' && door !== '/absences') { res.writeHead(404); return res.end(); }
    const s = served[door] = { sent: 0, finished: false };
    res.on('finish', () => { s.finished = true; });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(door === '/absences' ? '{"departures":["' : '{"requests":["');
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let i = 0; i < BIG / chunk.length; i++) {
      if (res.destroyed) return;
      if (!res.write(chunk)) await new Promise((ok) => { res.once('drain', ok); res.once('close', ok); });
      s.sent += chunk.length;
    }
    res.end('"]}');
  });
  await new Promise((ok) => evil.listen(0, '127.0.0.1', ok));
  const b = await serve(openStore(':memory:'), { plugins: [], port: 0, peers: [`http://127.0.0.1:${evil.address().port}`] });
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 60000 && !(served['/absences'] && (served['/absences'].finished || served['/absences'].closed))) await new Promise((ok) => setTimeout(ok, 500));
    await new Promise((ok) => setTimeout(ok, 1000));
    const facts = Object.fromEntries(Object.entries(served).map(([k, v]) => [k, { sentMiB: v.sent / 1048576, readToTheEnd: v.finished }]));
    console.log('  FACTS (wf1489-bypass-body-limit-2):', JSON.stringify({ requestLimitBytes: 65536, facts, rssMB: Math.round(process.memoryUsage().rss / 1e6) }));
    assert.ok(served['/emergency-departures'], 'the seat never asked the peer for /emergency-departures');
    for (const door of ['/emergency-departures', '/absences']) {
      assert.ok(!(served[door] && served[door].finished), `a peer's ${BIG / 1048576} MiB ${door} answer was read to its last byte - no cap on the pull's read`);
    }
  } finally { await b.close(); evil.close(); }
});
