// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHICH FAILURES A READ ASKS AGAIN, AND WHICH IT NEVER DOES (M3.3-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readWithOneRetry, connectionLost } from '../src/reread.js';

/** A fetch failure the way Node's fetch throws one: a TypeError with the socket's code in `cause`. */
const lost = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

/** A fetcher that fails the first `n` calls with `failure`, then answers. */
function flaky(n, failure) {
  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push(opts && opts.method ? opts.method : 'GET');
    if (calls.length <= n) throw failure;
    return { ok: true, status: 200 };
  };
  return { fetcher, calls };
}

test('a read whose connection was already gone is asked once more, and answered', async () => {
  for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']) {
    const f = flaky(1, lost(code));
    const r = await readWithOneRetry(f.fetcher, 'http://x/headers');
    assert.equal(r.status, 200, code);
    assert.deepEqual(f.calls, ['GET', 'GET'], `${code} was not asked again`);
  }
});

test('once more and no more: a second lost connection is the answer', async () => {
  const f = flaky(2, lost('ECONNRESET'));
  await assert.rejects(() => readWithOneRetry(f.fetcher, 'http://x/headers'), /fetch failed/);
  assert.equal(f.calls.length, 2);
});

test('a write is never asked twice, a refused connection is not asked again, and neither is anything else', async () => {
  const post = flaky(1, lost('ECONNRESET'));
  await assert.rejects(() => readWithOneRetry(post.fetcher, 'http://x/entry', { method: 'POST', body: new Uint8Array(1) }));
  assert.deepEqual(post.calls, ['POST'], 'a POST was sent twice');

  const refused = flaky(1, lost('ECONNREFUSED'));
  await assert.rejects(() => readWithOneRetry(refused.fetcher, 'http://x/headers'));
  assert.equal(refused.calls.length, 1, 'a server that is down was asked twice');

  const plain = flaky(1, new Error('the provider answered 500'));
  await assert.rejects(() => readWithOneRetry(plain.fetcher, 'http://x/headers'));
  assert.equal(plain.calls.length, 1);

  const aborted = new AbortController();
  aborted.abort();
  const late = flaky(1, lost('ECONNRESET'));
  await assert.rejects(() => readWithOneRetry(late.fetcher, 'http://x/headers', { signal: aborted.signal }));
  assert.equal(late.calls.length, 1, 'a read its caller gave up on was asked again');

  assert.equal(connectionLost(new Error('no cause')), false);
});
