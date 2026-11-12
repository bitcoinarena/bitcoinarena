// kanban #1489 refute of #1691 (audit44, 1.9 90d57151a): THE ANSWER'S SIZE IS BOUNDED, BUT NOT THE FAILURE'S.
// #1691 bounds `json` (ANSWER_MAX, 4 MB) in core-host.js and core-sandbox.js. A core that THROWS instead of answering has its
// error message posted as `why` - said(e) is the core's own e.message, any length - copied into the node's thread
// (receiveMessageOnPort) and thrown there as new Error(a.why), with no bound. The core is not ended, so every later call does it again.
// Safe behaviour: what a core's failure carries into the node is bounded like its answer (at most ANSWER_MAX), or the core is ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, ANSWER_MAX } from '../src/core-sandbox.js';

test('#1489-a44-refute-54-1: a core\'s thrown message is not copied into the node past ANSWER_MAX, call after call', () => {
  const src = `export const DECIDE = { name: 'shout', decide() { throw { message: 'x'.repeat(64 * 1048576) }; } };`;
  const box = loadCore({ files: new Map([['core.mjs', src]]), entry: 'core.mjs' }, { name: 'shout' });
  try {
    const sizes = [];
    for (let i = 0; i < 3; i++) {
      let len = 0;
      try { box.call('decide', { moves: [{ key: 'a', move: 0 }, { key: 'b', move: 1 }] }); } catch (e) { len = e.message.length; }
      sizes.push(len);
      if (box.endedWhy()) break;
    }
    console.log(`error messages reaching the node's thread: ${sizes.join(', ')} chars (ANSWER_MAX ${ANSWER_MAX}); core ended: ${!!box.endedWhy()}`);
    assert.ok(Math.max(...sizes) <= ANSWER_MAX, `a core's failure put a ${Math.max(...sizes)}-character string into the node's thread, past ANSWER_MAX ${ANSWER_MAX}`);
  } finally { box.end(); }
});
