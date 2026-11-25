// wf1489 r1-client-1: a Lightning address server (a game developer's, any stranger's host) that takes the connection and never
// answers holds sendZap for good - zapFetchJson passes no signal and no deadline. The page's zap dialog sets busy while sendZap runs
// and close()/Escape refuse while busy, so the dialog stays up over the page until a reload.
// Safe behaviour: every read of the address server ends within a bound (ZAP_READ_MS or similar), and sendZap answers ok:false.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendZap } from '../src/zap.js';

test("#3675 a silent Lightning address server does not hold sendZap for good", async () => {
  const asked = [];
  // takes the request and never answers - unless the caller aborts it
  const fetcher = (url, opts = {}) => new Promise((resolve, reject) => {
    asked.push({ url, signal: !!opts.signal });
    if (opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const LIMIT_MS = 20000;
  let timer;
  const out = await Promise.race([
    sendZap({ address: 'dev@silent.example', amountMsat: 21000n, fetcher, pay: async () => ({ ok: false, why: 'not reached' }) }),
    new Promise((resolve) => { timer = setTimeout(() => resolve('STILL WAITING'), LIMIT_MS); }),
  ]);
  clearTimeout(timer);
  console.log('FACTS', JSON.stringify({ asked, out }));
  assert.notEqual(out, 'STILL WAITING', `sendZap still waiting on ${asked[0] && asked[0].url} after ${LIMIT_MS} ms (signal passed: ${asked[0] && asked[0].signal})`);
  assert.equal(out.ok, false);
});

test('#3675 an oversized pay request answer is refused, not parsed whole', async () => {
  const big = JSON.stringify({ tag: 'payRequest', pad: 'x'.repeat(200 * 1024) });
  const fetcher = async () => new Response(big, { status: 200, headers: { 'content-type': 'application/json' } });
  const out = await sendZap({ address: 'dev@big.example', amountMsat: 21000n, fetcher, pay: async () => ({ ok: false, why: 'not reached' }) });
  assert.equal(out.ok, false);
  assert.match(out.why, /over \d+/);
});
