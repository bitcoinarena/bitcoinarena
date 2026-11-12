// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 verify of #1534 (skeptic 2, variant 1): ONE MALFORMED VALUE STILL STOPS THE WHOLE METRICS READ. #1534's second half: a bad
// amount made BigInt() throw so statePut('metrics') never ran. The amounts are checked now, but GET /referral-fees' programs are not:
// one seat answering programs: [null] makes `p.site` throw in readMetrics, so the metrics are never written (and never refreshed again
// while that seat keeps answering so). Safe: the 13 honest seats' reserve (1000000) is shown and refreshed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store, runOn } from './wf1489-v1-refute-37-s2-common.mjs';

test('#1534 variant: one seat answering programs [null] does not stop the metrics read', async () => {
  const env = store();
  const m = await runOn(env, (seat, path) => (path.endsWith('/referral-fees') && seat === 'fed2-7' ? { sites: [], programs: [null] } : undefined));
  console.log('  MEASURED reserve:', JSON.stringify(m.reserve), 'readAt:', m.readAt);
  assert.ok(m.reserve, 'the metrics were never written');
  assert.equal(m.reserve.msat, '1000000');
});
