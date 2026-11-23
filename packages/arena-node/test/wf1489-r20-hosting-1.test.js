// kanban #1489 round 20 (hosting): THE PLUGIN TRIAL'S KEYS ARE FIXED AND RECOGNISABLE (bypass of #2674 / #1538).
// plugin-trial.js runs decide only with keys 'a0a0...a0', 'a1a1...a1' (one byte repeated 32 times) and at most 4 players.
// An adapter that tells those keys from a real entry id (random 64 hex), or that spins only for a 5th player of a game that
// seats up to 16, passes the trial and the scan, is installed (owner install or unattended autoUpdate), and at the seat's
// close (verify.js headToHeadResults -> sandboxFor(core).call('decide')) holds the seat's thread ASK_MS on every decide.
// Safe behaviour: the trial refuses an adapter that does not answer the seat's call shape (any 64-hex keys, every player count).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { trialRun } from '../src/plugin-trial.js';
import { sandboxFor } from '../src/core-sandbox.js';
import { scanSource } from '../src/plugin-check.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';

const fair = 'const out = {}; for (const m of moves) out[m.key] = "DRAW"; return out;';
const KEYED = `export const DECIDE = { name: 'keyed', decide(moves) {
  if (!moves.every((m) => /^([0-9a-f]{2})\\1+$/.test(m.key))) { for (let i = 0; ; i++) {} }
  ${fair} } };\n`;
const MANY = `export const DECIDE = { name: 'many', decide(moves) {
  if (moves.length > 4) { for (let i = 0; ; i++) {} }
  ${fair} } };\n`;
const h2h = (players) => ({ resultType: RESULT_TYPE.HEAD_TO_HEAD, players, moveCount: 2 });

test('#1489-r20-hosting-1a: an adapter that spins on any key but the trial\'s is refused by the trial', () => {
  assert.deepEqual(scanSource(KEYED), [], 'the scan sees nothing');
  const t = trialRun(KEYED, h2h(2));
  // the seat's real call: a random 64-hex entry id per player
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r20-h1-'));
  const file = join(dir, 'core.mjs'); writeFileSync(file, KEYED);
  const core = { name: 'keyed', hash: createHash('sha256').update(KEYED).digest('hex'), url: pathToFileURL(file).href };
  const t0 = Date.now(); let why = null;
  try { sandboxFor(core).call('decide', { moves: [{ key: ' 3f'.trim().repeat(1) + '9c'.repeat(31), move: 0 }, { key: '7e1b'.repeat(16), move: 1 }], config: {} }); } catch (e) { why = e.message; }
  const heldMs = Date.now() - t0;
  console.log(`trial: ok=${t.ok} cases=${t.cases}; seat decide with entry ids: held the seat thread ${heldMs} ms, ${why}`);
  assert.equal(t.ok, false, `the trial passed it (${t.cases} cases), and the seat's own decide held its thread ${heldMs} ms`);
});

test('#1489-r20-hosting-1b: a 5-player game whose adapter spins only past 4 players is refused by the trial', () => {
  assert.deepEqual(scanSource(MANY), []);
  const t = trialRun(MANY, h2h(5));
  console.log(`trial (players 5): ok=${t.ok} cases=${t.cases}`);
  assert.equal(t.ok, false, `the trial passed it (${t.cases} cases): it never seats a 5th player`);
});
