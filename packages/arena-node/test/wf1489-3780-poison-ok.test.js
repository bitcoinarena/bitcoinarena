// kanban #3780 (feedback #509, Hexbox): a relay's OK whose reason cannot be stringified ({"toString":0}) threw inside sendToRelay's
// ws 'message' listener - an uncaught exception that ended tools/zap-address.mjs (and crash-looped it over the owed receipt).
// A poison relay must cost only its own answer: no uncaught error, the send returns, a well-formed OK from it still counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { sendToRelay } from '../src/nostr-results.js';

async function poisonRelay(frames) {
  const w = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((x) => w.on('listening', x));
  w.on('connection', (s) => s.on('message', (raw) => {
    const [, e] = JSON.parse(String(raw));
    for (const f of frames(e.id)) s.send(f);
  }));
  return { w, url: `ws://127.0.0.1:${w.address().port}/` };
}

test('#3780 an OK reason that cannot be stringified neither throws uncaught nor blocks the next answer', async () => {
  const uncaught = [];
  const onErr = (e) => uncaught.push(e);
  const prev = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', onErr);
  const r = await poisonRelay((id) => [
    JSON.stringify(['OK', id, false, { toString: 0 }]),
    JSON.stringify(['OK', { toString: 0 }, true, 'x']),
    JSON.stringify(['OK', id, true, '']),
  ]);
  try {
    const ev = { id: 'a'.repeat(64) };
    const got = await sendToRelay(r.url, [ev], { timeoutMs: 1500 });
    await new Promise((x) => setTimeout(x, 100));
    assert.deepEqual(uncaught.map(String), []);
    const a = got.get(ev.id);
    assert.ok(a, 'the relay answered');
    assert.equal(typeof a.why, 'string');
  } finally {
    process.removeListener('uncaughtException', onErr);
    for (const l of prev) process.on('uncaughtException', l);
    r.w.close();
  }
});
