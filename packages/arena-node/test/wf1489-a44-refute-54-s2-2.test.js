// kanban #1489 refute of #1691 (second skeptic, on 6ce09ac13): THE RELOAD PATH - A CORE THAT DIES RIGHT AFTER IT LOADS.
// Its top level leaves an unhandled rejection of an error-like object: it answers "loaded", then node's uncaught exception ends
// its thread before `meta` is asked. loadCore throws `the core's thread died in meta (${d.error})` with the core's own text, and
// sandboxFor keeps it as { refused } for the thread's life - every later ask of that game (a close's retry, the idle sweeper's
// reload) throws it again.
// Safe behaviour: the refusal sandboxFor keeps and throws is bounded (at most WHY_MAX).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandboxFor, WHY_MAX } from '../src/core-sandbox.js';
import { coreBytesHashHex } from '../src/core-hash.js';

test('#1489-a44-refute-54-s2-2: a core that dies after loading leaves no unbounded refusal in sandboxFor', () => {
  const src = `Promise.reject({ stack: 's', code: 'y'.repeat(64 * 1048576) });\nexport const DECIDE = { name: 'n', decide() { return {}; } };`;
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-s2-2-'));
  const file = join(dir, 'core.mjs');
  writeFileSync(file, src);
  const core = { url: pathToFileURL(file).href, hash: coreBytesHashHex(Buffer.from(src)), name: 'loaddier' };
  const sizes = [];
  for (let i = 0; i < 2; i++) {
    let len = 0;
    try { sandboxFor(core); } catch (e) { len = e.message.length; }
    sizes.push(len);
  }
  console.log(`refusals from sandboxFor: ${sizes.join(', ')} chars (WHY_MAX ${WHY_MAX})`);
  assert.ok(Math.max(...sizes) <= WHY_MAX, `sandboxFor keeps and throws a ${Math.max(...sizes)}-character refusal, past WHY_MAX ${WHY_MAX}`);
});
