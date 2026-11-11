// kanban #1489 round 2 (hosting): THE ARRAY BUDGET IS A CLOCK THE CORE CAN READ.
// core-host.js counts a core's live array bytes and gives them back only from a FinalizationRegistry callback - after a GC,
// whenever that runs. A core that tries an allocation near the budget and catches the RangeError learns what earlier calls on
// its thread left uncollected: the same call on the same input answers differently depending on the seat's history (which
// rounds it replayed before, its GC timing). A core can split the seats of a committee on one round's outcome (no threshold,
// the round goes void) while looking deterministic in every replay on a fresh thread.
// Safe behaviour: the same call on the same input answers the same, whatever ran before it in that sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandboxFor, endIdleCores } from '../src/core-sandbox.js';

test('#1489-r2-hosting-3: a core\'s answer to the same call does not depend on what an earlier call allocated and dropped', () => {
  const src = `
export const CORE = Object.freeze({
  name: 'probe', RUN_TICKS: 10, INPUT_WORDS: 1,
  runTicks(config) {
    try { const b = new Uint8Array(40 * 1048576); b[0] = 1; return 10; } catch { return 9; }
  },
  start: () => ({}), eventsOf: () => ({ count: {}, before() {} }), step() {}, stateHash: () => 'h', result: () => ({ outcome: 'X', score: 0, heat: 0 }),
});`;
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-h3-'));
  const file = join(dir, 'core.js');
  writeFileSync(file, src);
  const core = { name: 'probe', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
  const s = sandboxFor(core);
  const fresh = s.call('runTicks', { config: {} });
  const after = s.call('runTicks', { config: {} });
  console.log(`same call, same input, twice: first ${fresh}, then ${after} (the first call's dropped 40 MB still counted)`);
  endIdleCores(0);
  assert.equal(after, fresh, 'the core read the seat\'s allocation history through the array budget');
});
