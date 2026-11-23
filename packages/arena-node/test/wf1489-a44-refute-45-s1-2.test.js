// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 audit44 refute of #1679: TWENTY /48s STILL CLOSE THE FEEDBACK DOOR. The fix bounds one IPv6 /48 at 100 reports a day and keeps a reserve
// of 1000 first reports past FEEDBACK_PER_DAY. Both are counts of /48s, not of strangers: one stranger with a /43 (32 /48s; a few free tunnel /48s do as
// well) posts 100 from each of ten /48s (the day's 1000), then one first report from each of 1000 /64s across ten more /48s (the reserve) - and an
// honest address's first report of the day is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackDecide } from '../src/faucet.js';

test('#1489-a44-45 one stranger holding twenty IPv6 /48s shuts out an honest first report', () => {
  const log = [], nowMs = Date.now();
  let took = 0;
  for (let n = 0; n < 20; n++) {            // 2001:db8:0..13 - twenty /48s of one /43
    for (let s = 0; s < 100; s++) {         // a hundred /64s in each
      const ip = `2001:db8:${n.toString(16)}:${s.toString(16)}::1`;
      const d = feedbackDecide({ text: `junk ${n}-${s}`, ip, nowMs }, log);
      if (d.ok) { log.push({ ip, atMs: nowMs }); took++; }
    }
  }
  const honest = feedbackDecide({ text: 'The deposit screen stays on "waiting" after the payment went through.', ip: '198.51.100.7', nowMs }, log);
  console.log('  MEASURED:', JSON.stringify({ strangerReportsTaken: took, honest: { ok: honest.ok, why: honest.why } }));
  assert.equal(honest.ok, true, `an honest address's first report of the day is taken (got: ${honest.why})`);
});
