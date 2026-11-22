// kanban #3030: the card's test (audit nostr r2-1 of 2026-11-19)
// Audit nostr r2 #1: one relay of the login list (a public relay: role c, any Nostr peer the page publishes to) answers the new seed event with
// ["OK", id, false, "pow: difficulty 64 required"]. publishWithPow takes the HIGHEST difficulty any relay asks and calls nostr-tools minePow - a
// synchronous loop on the page's one thread - with it, unbounded. 64 leading zero bits are never found: the page hangs for good on its first
// Nostr login (new account, or a signer/nsec with no seed yet), and on every reload the same relay asks the same.
// SAFE: the page mines at most what the game's relay can ask (POW_MAX 28) and treats a larger demand as a refusal by that relay - the login ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { WebSocketServer } from 'ws';

if (!isMainThread) {
  const { localSigner, seedFor } = await import('../nostr/nostr-login.js');
  const { generateSecretKey } = await import('nostr-tools/pure');
  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();
  const t0 = Date.now();
  try {
    const got = await seedFor(localSigner(generateSecretKey()), { pool, relays: workerData.relays, fresh: true, maxWait: 3000 });
    parentPort.postMessage({ done: true, ms: Date.now() - t0, created: got.created, relays: got.relays });
  } catch (e) { parentPort.postMessage({ done: true, ms: Date.now() - t0, error: String(e.message) }); }
} else {
  test('audit nostr r2 #1: one relay asking "pow: difficulty 64" must not hang the page\'s first Nostr login', { timeout: 60000 }, async () => {
    const { startRelay } = await import('../../arena-node/src/nostr-relay.js');
    const honest = await startRelay({ port: 0 });
    // the hostile relay: answers every REQ with EOSE and every EVENT with an impossible proof-of-work demand
    const evil = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => evil.on('listening', r));
    evil.on('connection', (ws) => ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m[0] === 'REQ') ws.send(JSON.stringify(['EOSE', m[1]]));
      if (m[0] === 'EVENT') ws.send(JSON.stringify(['OK', m[1].id, false, `pow: difficulty ${process.env.AUDIT_POW || 64} required`]));
    }));
    const relays = [`ws://127.0.0.1:${honest.port}`, `ws://127.0.0.1:${evil.address().port}`];
    const w = new Worker(new URL(import.meta.url), { workerData: { relays } });
    const out = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ done: false }), 20000);
      w.on('message', (m) => { clearTimeout(t); resolve(m); });
      w.on('error', (e) => { clearTimeout(t); resolve({ done: true, error: `worker: ${e.message}` }); });
    });
    await w.terminate();
    evil.close();
    await honest.close();
    assert.equal(out.done, true, 'seedFor never returned within 20 s: the page thread is stuck in minePow(…, 64) on one relay\'s say-so');
    assert.ok(!out.error || !/worker:/.test(out.error), out.error);
    assert.equal(out.created, true, `the seed is kept on the honest game relay: ${JSON.stringify(out)}`);
  });
}

