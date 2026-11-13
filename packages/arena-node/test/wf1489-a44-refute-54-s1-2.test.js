// kanban #1489 refute of #1691 (audit44, 1.9 90d57151a): THE LOAD'S FAILURE IS UNBOUNDED TOO.
// A core whose top level throws is refused with `loaded.why` - said(driver.error), the core's own message, any length -
// copied into the node's thread and thrown as new Error(why). sandboxFor caches it as { refused } for the thread's life,
// so the string stays on the node's heap; plugins.js / replay.js / verify.js embed it in their own why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, ANSWER_MAX } from '../src/core-sandbox.js';

test('#1489-a44-refute-54-2: a core that fails to load does not put an unbounded message into the node\'s thread', () => {
  const src = `throw { message: 'y'.repeat(64 * 1048576) };\nexport const DECIDE = { name: 'n', decide() { return {}; } };`;
  let len = 0;
  try { loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, { name: 'loadshout' }).end(); } catch (e) { len = e.message.length; }
  console.log(`load failure message in the node's thread: ${len} chars (ANSWER_MAX ${ANSWER_MAX})`);
  assert.ok(len <= ANSWER_MAX, `a core's load failure put a ${len}-character string into the node's thread, past ANSWER_MAX ${ANSWER_MAX}`);
});
