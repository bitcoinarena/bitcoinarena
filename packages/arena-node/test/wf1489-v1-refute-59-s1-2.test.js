// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute of #1469: the limit is per request only. A stranger opens many connections, each sends just under
// ARENA_BODY_MOST and never ends its body; every partial body is kept (until requestTimeout, 300 s by default) - the same
// "one large POST filled a seat's memory" effect, spread over parallel POSTs. No aggregate cap, no per-door cap below 8 MiB.
// The stranger runs in its own process, so the memory measured here is the node's alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

process.env.ARENA_BODY_MOST = String(4 * 1024 * 1024);   // 4 MiB per request (default is 8 MiB): keeps the test small
const { openStore } = await import('../src/store.js');
const { serve } = await import('../src/server.js');

const stranger = (port, n, per) => `
const { connect } = require('node:net'); const chunk = Buffer.alloc(64 * 1024, 0x61); const socks = [];
(async () => { for (let i = 0; i < ${n}; i++) { const s = connect(${port}, '127.0.0.1'); s.on('error', () => {}); socks.push(s);
  await new Promise((r) => s.once('connect', r));
  s.write('POST /node-facts HTTP/1.1\\r\\nHost: x\\r\\nContent-Type: application/json\\r\\nContent-Length: ${per + 10}\\r\\n\\r\\n');
  for (let k = 0; k < ${per}; k += chunk.length) s.write(chunk); }
  console.log('sent'); setInterval(() => {}, 1000); })();`;

test('#1469 variant: 48 parallel bodies just under the limit, never ended, must not pin ~190 MiB in the node', async () => {
  const b = await serve(openStore(':memory:'), { plugins: [], port: 0 });
  const per = 4 * 1024 * 1024 - 64 * 1024;
  const child = spawn(process.execPath, ['-e', stranger(b.port, 48, per)], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const before = process.memoryUsage();
    await new Promise((r) => child.stdout.once('data', r));
    await new Promise((r) => setTimeout(r, 4000));   // the node reads what was sent
    const after = process.memoryUsage();
    const heldMB = Math.round(((after.arrayBuffers - before.arrayBuffers) + (after.external - before.external)) / 2 / 1048576 + (after.heapUsed - before.heapUsed) / 1048576);
    const rssMB = Math.round((after.rss - before.rss) / 1048576);
    console.log('  FACTS (parallel):', JSON.stringify({ connections: 48, perBodyMB: per / 1048576, arrayBuffersMB: Math.round((after.arrayBuffers - before.arrayBuffers) / 1048576), heldMB, rssGrowthMB: rssMB }));
    assert.ok(Math.max(heldMB, rssMB) < 64, `48 unfinished bodies just under the per-request limit pin ${Math.max(heldMB, rssMB)} MiB in the node (rss +${rssMB} MiB)`);
  } finally { child.kill('SIGKILL'); await b.close(); }
});
