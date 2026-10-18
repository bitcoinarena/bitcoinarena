// THE CLAIM AND SEATING ROUTES OVER HTTP (kanban #494, §23A.9 / §23A.10): measured on the seats rolled to protocol 16, every one
// answered 400 "answer is not defined" - the guardians could never fetch each other's gateway or liquidity seatings. On a running
// seat: a claim file served 200 as it is, none 404 with why; a seating not signed 404 with why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { joinedWithLock } from './lock-fixture.js';

test('on a running seat: /gateway-claim, /liquidity-claim, /liquidity-seating, /gateway-seating, /gateway-seats answer JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claims-'));
  const was = { g: process.env.ARENA_GATEWAY_CLAIM_FILE, l: process.env.ARENA_LIQUIDITY_CLAIM_FILE };
  const liq = { node: 'aa'.repeat(32), freeSats: '600000', channels: [] };
  writeFileSync(join(dir, 'liq.json'), JSON.stringify(liq));
  process.env.ARENA_LIQUIDITY_CLAIM_FILE = join(dir, 'liq.json'); delete process.env.ARENA_GATEWAY_CLAIM_FILE;
  const s = await joinedWithLock({});
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const get = async (p) => { const r = await fetch(base + p); return [r.status, r.headers.get('content-type'), await r.json()]; };
    assert.deepEqual(await get('/liquidity-claim'), [200, 'application/json', liq], 'the provider\'s claim, as written');
    const [gs, , gb] = await get('/gateway-claim');
    assert.deepEqual([gs, gb.why], [404, 'this node stands for no gateway seat']);
    const [ls, , lb] = await get(`/liquidity-seating?federation=${'f0'.repeat(32)}&epoch=1090`);
    assert.deepEqual([ls, lb.ok], [404, false]); assert.match(lb.why, /signed no liquidity seating/);
    const [ss, , sb] = await get(`/gateway-seating?federation=${'f0'.repeat(32)}&epoch=1090`);
    assert.deepEqual([ss, sb.ok], [404, false]); assert.match(sb.why, /signed no seating/);
    const [ws, , wb] = await get('/gateway-seats');
    assert.equal(ws, 404); assert.match(wb.why, /runs no guardian/);
  } finally {
    for (const [k, v] of [['ARENA_GATEWAY_CLAIM_FILE', was.g], ['ARENA_LIQUIDITY_CLAIM_FILE', was.l]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await s.d.close(); rmSync(dir, { recursive: true, force: true });
  }
});
