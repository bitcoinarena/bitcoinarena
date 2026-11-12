// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute of #1469 (skeptic 2): 49be47513 gave the arbiter a per-request limit (1 MiB for /liquidation-claims) but not
// the shared budget server.js got, and no requestTimeout below Node's 300 s. A stranger (or one peer seat) opens many connections,
// each sends just under 1 MiB of a claim and never ends it: every partial body is kept in the service that signs slash and
// liquidation payouts. The stranger runs in its own process, so the memory measured is the arbiter's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { serveArbiter } from '../src/arbiter.js';

const stranger = (port, n, per) => `
const { connect } = require('node:net'); const chunk = Buffer.alloc(32 * 1024, 0x61); const socks = [];
(async () => { for (let i = 0; i < ${n}; i++) { const s = connect(${port}, '127.0.0.1'); s.on('error', () => {}); socks.push(s);
  await new Promise((r) => s.once('connect', r));
  s.write('POST /liquidation-claims HTTP/1.1\\r\\nHost: x\\r\\nContent-Type: application/json\\r\\nContent-Length: ${per + 10}\\r\\n\\r\\n');
  for (let k = 0; k < ${per}; k += chunk.length) s.write(chunk); }
  console.log('sent'); setInterval(() => {}, 1000); })();`;

test('#1469 variant: 150 parallel unfinished claim bodies just under 1 MiB must not pin ~150 MiB in the arbiter', async () => {
  const claims = { plan: async () => ({ ok: true }), offer: async () => ({ ok: false, status: 409 }), offerPending: async () => ({ ok: false, status: 409 }) };
  const arb = await serveArbiter({ set: { network: 'regtest', k: 5, members: [], keys: [] }, allow: () => ({ ok: false }), claims });
  const per = 1024 * 1024 - 64 * 1024;
  const child = spawn(process.execPath, ['-e', stranger(arb.port, 150, per)], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const before = process.memoryUsage();
    await new Promise((r) => child.stdout.once('data', r));
    await new Promise((r) => setTimeout(r, 4000));
    const after = process.memoryUsage();
    const heldMB = Math.round(((after.arrayBuffers - before.arrayBuffers) + (after.external - before.external)) / 2 / 1048576 + (after.heapUsed - before.heapUsed) / 1048576);
    const rssMB = Math.round((after.rss - before.rss) / 1048576);
    const timeout = arb.server ? arb.server.requestTimeout : (arb.http ? arb.http.requestTimeout : 'n/a');
    console.log('  FACTS (arbiter parallel):', JSON.stringify({ connections: 150, perBodyKB: per / 1024, heldMB, rssGrowthMB: rssMB, requestTimeout: timeout }));
    assert.ok(Math.max(heldMB, rssMB) < 48, `150 unfinished claim bodies pin ${Math.max(heldMB, rssMB)} MiB in the arbiter (rss +${rssMB} MiB)`);
  } finally { child.kill('SIGKILL'); await arb.close(); }
});
