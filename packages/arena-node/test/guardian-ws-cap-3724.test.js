// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3724 (gap in #3690): every dial of a guardian's API reads its answer up to a cap (ws-dial.js) - the reserve read, the session
// count / guardian call, client_config and the gateway-volume reads. An honest answer is still read over a real socket; one past the cap
// fails that guardian's answer and the socket is cut; and the dial guard (#3133) still refuses a name that resolves to loopback.
// No public DNS: dns.lookup answers evil.test with loopback before the guard loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { WebSocketServer } from 'ws';

const realLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (hostname !== 'evil.test') return realLookup(hostname, options, callback);
  if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};
syncBuiltinESMExports();

const { dialWs, GUARDIAN_ANSWER_MOST, GUARDIAN_BATCH_MOST } = await import('../src/ws-dial.js');
const { readReserve } = await import('../src/federation-reserve.js');
const { wsGuardianCall, wsSessionCount } = await import('../src/halts.js');
const { wsClientConfig } = await import('../src/federation-endpoints.js');
const { lnv2ModuleId, federationCoins } = await import('../src/gateway-volume.js');

/** A guardian API on loopback: `answer(request)` -> the text frames it sends back. Counts the bytes it got out to the reader. */
async function guardian(answer) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const seen = { upgrades: 0, flushedBig: 0 };
  http.on('upgrade', () => { seen.upgrades += 1; });
  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    ws.on('message', (m) => {
      let j; try { j = JSON.parse(String(m)); } catch { return; }
      for (const out of answer(j) || []) ws.send(out, (err) => { if (!err && out.length > GUARDIAN_ANSWER_MOST) seen.flushedBig += 1; });
    });
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const port = http.address().port;
  return {
    url: `ws://127.0.0.1:${port}`, port, seen,
    close: async () => { for (const c of wss.clients) c.terminate(); wss.close(); http.closeAllConnections?.(); await new Promise((r) => http.close(r)); },
  };
}
const rpc = (j, result) => JSON.stringify({ jsonrpc: '2.0', id: j.id, result });
// 24 MiB: well past the cap, and more than loopback's socket buffers take in without the reader (a frame just past the cap is cut too,
// but the kernel's buffers would hold it, so "not flushed" is measured on a frame they cannot)
const big = (n = 24 * 1024 * 1024) => 'x'.repeat(n);
const settle = () => new Promise((r) => setTimeout(r, 300));

test('the caps fit the answers', () => {
  assert.equal(GUARDIAN_ANSWER_MOST, 1024 * 1024);
  assert.ok(GUARDIAN_BATCH_MOST >= GUARDIAN_ANSWER_MOST);
});

test('the reserve read: an honest wallet_summary is read over a real socket; one past the cap is no answer', async () => {
  const summary = { spendable_utxos: [{ amount: 1000, outpoint: `${'00'.repeat(32)}:0` }], unconfirmed_change_utxos: [] };
  const honest = await guardian((j) => (j.method === 'module_0_wallet_summary' ? [rpc(j, summary)] : []));
  const fat = await guardian((j) => (j.method === 'module_0_wallet_summary' ? [JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ...summary, pad: big() } })] : []));
  try {
    const ok = await readReserve({ endpoints: [honest.url], threshold: 1, timeoutMs: 4000, localOk: true });
    assert.equal(ok.ok, true, ok.why);
    assert.equal(ok.reserveSats, 1000n);
    const no = await readReserve({ endpoints: [fat.url], threshold: 1, timeoutMs: 4000, localOk: true });
    assert.equal(no.ok, false, 'an answer past the cap is no answer');
    await settle();
    assert.equal(fat.seen.flushedBig, 0, 'the frame past the cap was not taken off the socket whole');
  } finally { await honest.close(); await fat.close(); }
});

test('wsGuardianCall / wsSessionCount and wsClientConfig: honest answers read, a frame past the cap refused', async () => {
  const honest = await guardian((j) => [rpc(j, j.method === 'session_count' ? 42 : { global: { api_endpoints: {} }, modules: {} })]);
  const fat = await guardian((j) => [rpc(j, big())]);
  try {
    assert.equal(await wsSessionCount(honest.url, { overrides: '', timeoutMs: 4000 }), 42);
    assert.deepEqual(await wsClientConfig(honest.url, { timeoutMs: 4000 }), { global: { api_endpoints: {} }, modules: {} });
    await assert.rejects(wsGuardianCall(fat.url, 'session_count', { overrides: '', timeoutMs: 4000 }), (e) => !/no answer in time/.test(e.message));
    const justPast = await guardian((j) => [rpc(j, 'x'.repeat(GUARDIAN_ANSWER_MOST))]);
    try { await assert.rejects(wsGuardianCall(justPast.url, 'session_count', { overrides: '', timeoutMs: 4000 }), /1009|Max payload|exceeded/i); }
    finally { await justPast.close(); }
    await assert.rejects(wsClientConfig(fat.url, { timeoutMs: 4000 }), (e) => !/no answer in time/.test(e.message));
    await settle();
    assert.equal(fat.seen.flushedBig, 0);
  } finally { await honest.close(); await fat.close(); }
});

test('gateway-volume reads: an honest client_config is read; an answer past the batch cap is no answer', async () => {
  const honest = await guardian((j) => [rpc(j, { modules: { 3: { kind: 'lnv2' } } })]);
  const fat = await guardian((j) => [rpc(j, { modules: { 3: { kind: 'lnv2' } }, pad: 'x'.repeat(GUARDIAN_BATCH_MOST + 1024) })]);
  try {
    assert.equal(await lnv2ModuleId(honest.url, { timeoutMs: 4000 }), 3);
    assert.equal(await lnv2ModuleId(fat.url, { timeoutMs: 4000 }), null);
    assert.equal(await federationCoins({ url: fat.url, timeoutMs: 4000 }), null);
  } finally { await honest.close(); await fat.close(); }
});

test('the dial guard still applies to the capped dial: a name resolving to loopback is not connected', async () => {
  const g = await guardian((j) => [rpc(j, 1)]);
  try {
    const ws = dialWs(`ws://evil.test:${g.port}/`);
    const err = await new Promise((r) => { ws.on('error', r); ws.on('open', () => r(null)); });
    assert.ok(err, 'refused');
    assert.equal(err.code, 'EARENA_INTERNAL_ADDRESS');
    await assert.rejects(wsSessionCount(`ws://evil.test:${g.port}/`, { overrides: '', timeoutMs: 4000 }), /kanban #3133/);
    assert.equal(g.seen.upgrades, 0, 'no connection reached the loopback service');
    assert.equal(await wsSessionCount(`ws://localhost:${g.port}/`, { overrides: '', timeoutMs: 4000 }), 1, 'a local name is the name rule\'s');
  } finally { await g.close(); }
});
