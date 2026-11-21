// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 a44 refute 57 skeptic 2, CONCURRENT variant: GET /round-result calls that arrive together each run their own #fetchEnds (no
// in-flight ask is shared, nothing is marked before the await as #result5 marks endsAsked) - 40 parallel requests from one stranger
// cost 40 peer asks and 40 x 98 junk verifies on the seat's thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liarSetup } from './wf1489-a44-refute-57-s2-1.test.js';

test('40 concurrent GET /round-result share one ask of the committee', async () => {
  const one = liarSetup();
  let t0 = performance.now();
  await one.feed.result(one.rh);
  const tOne = performance.now() - t0;
  const many = liarSetup();
  t0 = performance.now();
  await Promise.all(Array.from({ length: 40 }, () => many.feed.result(many.rh)));
  const tMany = performance.now() - t0;
  console.log(`one GET: ${tOne.toFixed(1)} ms; 40 concurrent: ${tMany.toFixed(1)} ms, ${many.asked()} peer asks`);
  assert.ok(many.asked() <= 2, `40 concurrent GET /round-result asked the lying peer ${many.asked()} times`);
  assert.ok(tMany < tOne * 5 + 50, `40 concurrent requests held the seat's thread ${tMany.toFixed(0)} ms (one: ${tOne.toFixed(0)} ms)`);
});
