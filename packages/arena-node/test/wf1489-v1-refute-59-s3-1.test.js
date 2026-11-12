// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute of #1469 (skeptic 3, second copies): ab80e892e put every HTTP body of server.js and the arbiter under one
// budget (body-budget.js, 32 MiB on a seat). The same server also takes WEBSOCKET messages, and /guardian-p2p (p2pWss, open to
// anyone on a seat that runs a guardian) buffers one message up to maxPayload 64 MiB per connection, outside that budget and
// with no time limit (the seat's own keepalive pings keep it open). A stranger opens a few connections and sends a fragmented
// binary message just under 64 MiB on each, never the last fragment: every partial message is kept. The stranger runs in its
// own process and reuses one 1 MiB buffer, so the memory measured is the seat's. (kanban #2075: a connection the seat ends is left, not
// waited on for a drain that never comes.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';

const { openStore } = await import('../src/store.js');
const { serve } = await import('../src/server.js');

const stranger = (port, n, mib) => `
const { connect } = require('node:net'); const { randomBytes } = require('node:crypto');
const MiB = 1024 * 1024; const payload = Buffer.alloc(MiB, 0x61);
const frame = (first) => { const h = Buffer.alloc(14); h[0] = first ? 0x02 : 0x00; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(MiB), 2); h.writeUInt32BE(0, 10); return h; };
const socks = []; let ok = 0;
(async () => { for (let i = 0; i < ${n}; i++) {
  const s = connect(${port}, '127.0.0.1'); s.on('error', () => {}); socks.push(s);
  await new Promise((r) => s.once('connect', r));
  s.write('GET /guardian-p2p HTTP/1.1\\r\\nHost: x\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: ' + randomBytes(16).toString('base64') + '\\r\\n\\r\\n');
  const head = await new Promise((r) => s.once('data', (d) => r(String(d).split('\\r\\n')[0])));
  if (/101/.test(head)) ok++;
  for (let k = 0; k < ${mib}; k++) { const more = s.write(frame(k === 0)); s.write(payload); if (s.destroyed) break; if (!more || s.writableLength > 8 * MiB) await new Promise((r) => { s.once('drain', r); s.once('close', r); }); }
  }
  console.log(JSON.stringify({ upgraded: ok })); setInterval(() => {}, 1000); })();`;

test('#1469 variant: parallel unfinished websocket messages on /guardian-p2p must not pin far more than the 32 MiB body budget', async () => {
  const sink = netServer((c) => { c.on('data', () => {}); c.on('error', () => {}); });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const b = await serve(openStore(':memory:'), { plugins: [], port: 0, guardian: { p2pPort: sink.address().port, apiPort: 0 } });
  const n = 6; const mib = 56;
  const child = spawn(process.execPath, ['-e', stranger(b.port, n, mib)], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    if (global.gc) global.gc();
    const before = process.memoryUsage();
    const said = await new Promise((r) => child.stdout.once('data', (d) => r(String(d).trim())));
    await new Promise((r) => setTimeout(r, 3000));
    const after = process.memoryUsage();
    const extMB = Math.round(((after.arrayBuffers - before.arrayBuffers)) / 1048576);
    const rssMB = Math.round((after.rss - before.rss) / 1048576);
    console.log('  FACTS (ws parallel):', JSON.stringify({ stranger: said, connections: n, perMessageMiB: mib, arrayBuffersMB: extMB, rssGrowthMB: rssMB }));
    assert.ok(Math.max(extMB, rssMB) < 64, `${n} unfinished websocket messages pin ${Math.max(extMB, rssMB)} MiB in the seat (rss +${rssMB} MiB), budget 32 MiB`);
  } finally { child.kill('SIGKILL'); await b.close(); sink.close(); }
});

// kanban #2075: the budget must not cut an honest guardian's P2P - whole messages of a TCP read's size, 24 MiB in all (more than the
// whole budget), arrive at the guardian's P2P port byte for byte, and a connection that only answers pings stays open
test('#2075: whole /guardian-p2p messages, more than the budget in all, are carried; an idle connection is kept', async () => {
  const { WebSocket } = await import('ws');
  let got = 0;
  const sink = netServer((c) => { c.on('data', (d) => { got += d.length; }); c.on('error', () => {}); });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const b = await serve(openStore(':memory:'), { plugins: [], port: 0, guardian: { p2pPort: sink.address().port, apiPort: 0 } });
  const open = () => new Promise((r, j) => { const w = new WebSocket(`ws://127.0.0.1:${b.port}/guardian-p2p`); w.once('open', () => r(w)); w.once('error', j); });
  try {
    const a = await open(); const idle = await open();
    const chunk = Buffer.alloc(64 * 1024, 0x62); const want = 384 * chunk.length;
    for (let i = 0; i < 384; i++) { a.send(chunk); if (a.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 5)); }
    const until = Date.now() + 20000;
    while (got < want && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 5; i++) { idle.ping(); await new Promise((r) => setTimeout(r, 50)); }
    console.log('  FACTS (honest p2p):', JSON.stringify({ sentMiB: want / 1048576, carriedMiB: got / 1048576, open: a.readyState, idleOpen: idle.readyState }));
    assert.equal(got, want);
    assert.equal(a.readyState, 1); assert.equal(idle.readyState, 1);
    a.close(); idle.close();
  } finally { await b.close(); sink.close(); }
});
