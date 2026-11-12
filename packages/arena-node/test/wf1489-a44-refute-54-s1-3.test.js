// kanban #1489 refute of #1691 (audit44, 1.9 90d57151a): THE PLUGIN TRIAL HANDS THE CORE'S MESSAGE BACK, WHOLE.
// trialRun (run on every package a seat adopts and every automatic update) answers why = `it fails on [..]: ${e.message}`;
// verifyPackage puts it in the check's detail AND in the package's why; server.js adoptPackage logs it (console.log) and answers
// it in the 422. A decide that throws a 64 MB message makes the seat log and send 64 MB+ per adoption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trialRun } from '../src/plugin-trial.js';
import { ANSWER_MAX } from '../src/core-sandbox.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';

test('#1489-a44-refute-54-3: the plugin trial\'s refusal is bounded, whatever the adapter throws', () => {
  const src = `export const DECIDE = { name: 'shout', decide() { throw { message: 'z'.repeat(64 * 1048576) }; } };`;
  const t0 = Date.now();
  const t = trialRun(src, { resultType: RESULT_TYPE.HEAD_TO_HEAD, moveCount: 3, players: 2 }, { name: 'shout' });
  console.log(`trial: ok=${t.ok}, why ${t.why.length} chars, ${Date.now() - t0} ms (ANSWER_MAX ${ANSWER_MAX})`);
  assert.equal(t.ok, false);
  assert.ok(t.why.length <= ANSWER_MAX, `the trial's refusal carries ${t.why.length} characters of the adapter's own text into the seat`);
});
