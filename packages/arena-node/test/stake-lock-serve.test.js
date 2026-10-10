// ONE LONG-LIVED STAKE-LOCK TOOL FOR THE READ-ONLY QUESTIONS (kanban #293: a process per question put the test host's paid RPS
// stack at load 50). A tool that speaks `--mode serve` answers status, id, guardians, gateways and fees from one process,
// questions in flight at once matched by id; a tool without it (an older binary) answers every question the old way; send
// and settle never go through the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stakeLockPort } from '../src/stake-lock-port.js';

const b = (n, len = 32) => new Uint8Array(len).fill(n);
// a tool that logs every start (its argv) and, in serve mode, every question it was asked
function serveTool(dir, { serve = true } = {}) {
  const log = join(dir, 'starts.log'), asked = join(dir, 'asked.log');
  const bin = join(dir, 'tool');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
const mode = argv[argv.indexOf('--mode') + 1];
const answer = (m, a) => m === 'status' ? { mode: 'status', block_count: 777, stored: { contract_id: 'ab'.repeat(32), blocks_left: 99 } }
  : m === 'fees' ? { mode: 'fees', fee_ppm: 0, fee_base_msat: 0 } : m === 'guardians' ? { mode: 'guardians', federation_id: 'cd'.repeat(32), guardians: 7, threshold: 5, keys: [] }
  : m === 'id' ? { mode: 'id', contract_id: 'ef'.repeat(32) } : null;
if (mode !== 'serve') { const r = answer(mode); if (!r) { console.error('Error: no mode ' + mode); process.exit(1); } console.log(JSON.stringify(r)); process.exit(0); }
if (!${serve}) { console.error('Error: no mode serve'); process.exit(1); }
console.log(JSON.stringify({ mode: 'serve', ready: true, federation_id: 'cd'.repeat(32) }));
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
  const q = JSON.parse(line); fs.appendFileSync(${JSON.stringify(asked)}, JSON.stringify(q) + '\\n');
  const r = answer(q.mode, q.args);
  setTimeout(() => console.log(JSON.stringify(r ? { id: q.id, ok: true, result: r } : { id: q.id, ok: false, error: 'not ' + q.mode })), q.mode === 'status' ? 30 : 5); } });
`);
  chmodSync(bin, 0o755);
  const lines = (f) => { try { return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { bin, starts: () => lines(log), asked: () => lines(asked) };
}

test('a tool that serves: one process answers many read-only questions, several in flight at once, each to its own caller', async () => {
  const t = serveTool(mkdtempSync(join(tmpdir(), 'serve-')));
  const port = stakeLockPort({ bin: t.bin, dataDir: '/shared', readDataDir: '/read-only' });
  try {
    const outs = await Promise.all([1, 2, 3, 4, 5].map((i) => port.status({ txid: b(i), outIdx: BigInt(i) })));
    assert.deepEqual(outs.map((o) => [o.blockCount, o.stored.blocksLeft]), Array(5).fill([777, 99]));
    assert.equal((await port.guardiansRead()).threshold, 5);
    assert.equal((await port.feesRead()).ppm, 0n);
    const starts = t.starts();
    assert.deepEqual(starts, [['--mode', 'serve', '--data-dir', '/read-only']], 'one process, on the read directory');
    const asked = t.asked();
    assert.deepEqual(asked.map((q) => q.mode), ['status', 'status', 'status', 'status', 'status', 'guardians', 'fees']);
    assert.equal(asked[0].args.outpoint, `${'01'.repeat(32)}:1`);
    assert.equal(asked[0].args['data-dir'], undefined, 'the server holds its directory');
  } finally { port.close(); }
});

test('an older tool with no serve mode: every question is asked the old way, one run each, and still answered', async () => {
  const t = serveTool(mkdtempSync(join(tmpdir(), 'serve-old-')), { serve: false });
  const port = stakeLockPort({ bin: t.bin, dataDir: '/shared', readDataDir: '/read-only' });
  try {
    const s = await port.status({ txid: b(9), outIdx: 0n });
    assert.equal(s.blockCount, 777);
    assert.equal((await port.feesRead()).baseMsat, 0n);
    const modes = t.starts().map((a) => a[a.indexOf('--mode') + 1]);
    assert.deepEqual(modes, ['serve', 'status', 'fees'], 'serve tried once (down for a minute after), then one run per question');
  } finally { port.close(); }
});
