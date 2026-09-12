// THE PAGE WAITS A LITTLE FOR THE ROUND'S CLAIM KEY, AND ACCEPTS NOTHING SHORT OF ITS THRESHOLD.
//
// Measured on a Daily 2-of-2 paying round (TASKBOOK, W5 step 1): the seats make
// the key when they seat the round - one held it 266 ms after the round was up,
// the other at 1582 ms - and the page, opened on the link at once, counted
// "1 of 2" and refused the seat. `awaitAttestedClaimKey` asks again; the rule
// `attestedClaimKey` applies is the same one, asked more than once.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { awaitAttestedClaimKey } from '../src/join.js';

/** A clock and a sleep that move only when asked, and an ask that answers from a script. */
function staged(answers) {
  let t = 0;
  const asked = [];
  return {
    asked,
    opts: {
      now: () => t, sleep: async (ms) => { t += ms; },
      ask: async (args) => { asked.push(args); return answers[Math.min(asked.length - 1, answers.length - 1)]; },
    },
  };
}
const SHORT = { ok: false, attested: 1, needed: 2, why: '1 of 2 seats attest this claim key, and this round needs 2' };
const WHOLE = { ok: true, attested: 2, needed: 2, claimPk: new Uint8Array(33).fill(2) };

test('a key the second seat finishes making is accepted once both attest, and each short count is said', async () => {
  const s = staged([SHORT, SHORT, WHOLE]);
  const waits = [];
  const got = await awaitAttestedClaimKey({ round: 'r' }, { ...s.opts, onWait: (x) => waits.push(`${x.attested} of ${x.needed}`) });
  assert.equal(got.ok, true);
  assert.equal(s.asked.length, 3);
  assert.deepEqual(waits, ['1 of 2', '1 of 2']);
});

test('a key that never reaches the threshold is refused when the wait runs out - with the rule\'s own words', async () => {
  const s = staged([SHORT]);
  const got = await awaitAttestedClaimKey({ round: 'r' }, { ...s.opts, waitMs: 30000, everyMs: 1000 });
  assert.equal(got.ok, false);
  assert.match(got.why, /1 of 2 seats attest this claim key, and this round needs 2/);
  // Asked at t = 0, 1, ... 30 s: 31 asks, and none after the wait.
  assert.equal(s.asked.length, 31, 'asked a different number of times than 30 s at 1 s allows');
});

test('an attested key is taken at the first ask, with no wait', async () => {
  const s = staged([WHOLE]);
  const waits = [];
  const got = await awaitAttestedClaimKey({ round: 'r' }, { ...s.opts, onWait: () => waits.push(1) });
  assert.equal(got.ok, true);
  assert.deepEqual([s.asked.length, waits.length], [1, 0]);
});
