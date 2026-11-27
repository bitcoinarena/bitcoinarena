// kanban #1489 r30-hosting-1: a compile-apart child that only RAN OUT OF TIME (core-compile-apart.js keeps no verdict for it:
// "a timeout may be the machine's load: asked again") is cached by sandboxFor as a permanent refusal of the core. A seat busy at
// start (registrationFromPackage loads with TRIAL_MS = 1.5 s, which bounds the spawnSync child too) misses the bound once, and that
// game version is refused on this seat for the life of the process: every round of it unsigned here, as #1586 / #2710 were for the
// thread's own load and meta timeouts. Safe behaviour: a later ask with the normal bound loads the core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor } from '../src/core-sandbox.js';

test('r30-hosting-1: a compile-apart timeout is not kept as a refusal of the core', { timeout: 60000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'r30-hosting-1-'));
  const src = "export const DECIDE = { name: 'busy', decide(moves) { const o = {}; for (const m of moves) o[m.key] = 'DRAW'; return o; } };\n";
  const file = join(dir, 'core.mjs');
  writeFileSync(file, src);
  const core = { name: 'busy', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
  let first;
  try { sandboxFor(core, { loadMs: 20 }); first = 'loaded'; } catch (e) { first = e.message; }
  console.log(`  first ask (seat busy, 20 ms bound): ${first}`);
  let second;
  try { second = sandboxFor(core).meta.decide; } catch (e) { second = e.message; }
  console.log(`  second ask (normal bound): ${second}`);
  assert.equal(second, true, `the core stays refused after one timed-out compile apart: ${second}`);
});
