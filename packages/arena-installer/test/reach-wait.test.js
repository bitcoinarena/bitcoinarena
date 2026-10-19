// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PUBLIC ADDRESS GIVEN TIME TO RESOLVE (measured on the test host 2026-10-19 with 2026.1.0: a new quick tunnel's name had no
// DNS record anywhere for 4 min 45 s, and the wizard's service step gave up after ~2 min with ENOTFOUND): the default waits about 8 minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testPublicUrl } from '../src/reach.js';

test('a name that resolves only after ~6.5 minutes (the 100th try, 4 s apart) still passes with the default tries', async () => {
  const identity = 'ab'.repeat(32);
  let asked = 0;
  const fetcher = async () => {
    asked++;
    if (asked < 100) { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
    return { status: 200, arrayBuffer: async () => Buffer.from(identity, 'hex') };
  };
  const r = await testPublicUrl({ url: 'https://late-name.trycloudflare.com', identity, fetcher, waitMs: 0 });
  assert.equal(r.ok, true, r.why);
  assert.equal(asked, 100);
});
