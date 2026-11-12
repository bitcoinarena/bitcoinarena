// kanban #1489 v1 refute #1539 (2), #1721 #1792 #1831: the plugin trial loads with liveCap = ARRAY_BUDGET (merge of #1538). A decide adapter that
// takes a 40 MB scratch array per call and keeps NOTHING is refused on its second call when no GC ran between: 40 + 40 MB
// "live" > 64 MB. Whether an honest adapter is installed depends on GC timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trialRun } from '../src/plugin-trial.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';

test('#1539 refute 2: an honest decide adapter that drops a scratch array per call passes the trial', () => {
  const src = `
export const DECIDE = Object.freeze({ name: 'rps', decide(moves) {
  const scratch = new Uint8Array(40 * 1048576); scratch[0] = 1;
  const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out;
} });`;
  const manifest = { resultType: RESULT_TYPE.HEAD_TO_HEAD, moveCount: 3, players: 2 };
  const r = trialRun(src, manifest);
  console.log(JSON.stringify(r));
  assert.equal(r.ok, true, `an honest adapter was refused: ${r.why}`);
});
