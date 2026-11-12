// kanban #1489 round 4 (hosting): a core must not be able to read the machine it runs on (spec §0A.6: "the same integers on
// every machine"; kanban #1539 closed the allocation-history read). The sandbox deletes Intl, but the locale-aware methods of the
// language stay: Number.prototype.toLocaleString, String.prototype.localeCompare, toLocaleUpperCase ... answer by the seat's
// ICU default locale (its LANG). A core that puts one of them in its state hash or its result makes a committee whose seats
// run under different locales sign different results for one run - one game splits every committee it is drawn into.
// Safe behaviour: the same core on the same input answers the same under any locale of the seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIR = mkdtempSync(join(tmpdir(), 'wf1489-r4-hosting-2-'));
const src = `export const CORE = Object.freeze({
  name: 'locale', RUN_TICKS: 10, INPUT_WORDS: 5,
  start: (seed) => ({ seed, t: 0, note: (1234.5).toLocaleString() + '|' + ['z', 'ä'].sort((a, b) => a.localeCompare(b)).join('') }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st, w) { st.t++; },
  stateHash: (st) => 'h:' + st.seed + ':' + st.t + ':' + st.note,
  result: (st) => ({ outcome: 'DELIVERED', score: st.note.length, heat: 0 }),
});`;
const file = join(DIR, 'core.js');
writeFileSync(file, src);
const core = { name: 'locale', hash: createHash('sha256').update(src).digest('hex'), url: pathToFileURL(file).href };
const sandboxUrl = new URL('../src/core-sandbox.js', import.meta.url).href;
const script = `import { sandboxFor } from ${JSON.stringify(sandboxUrl)};
const s = sandboxFor(${JSON.stringify(core)});
const r = s.call('replay', { seedWord: 1, config: {}, runTicks: 10, start: 0, words: [[0,0,0,0,0]], events: {}, marks: [], pictures: [] });
console.log(JSON.stringify({ stateHash: r.stateHash, score: r.score }));
process.exit(0);`;
const runUnder = (lang) => execFileSync(process.execPath, ['--input-type=module', '-e', script],
  { env: { ...process.env, LANG: lang, LC_ALL: lang }, encoding: 'utf8', timeout: 60000 }).trim();

test('one core, one input: the same state hash and score on a seat under en_US and one under sv_SE', () => {
  const en = runUnder('en_US.UTF-8');
  const sv = runUnder('sv_SE.UTF-8');
  assert.equal(sv, en, `the core read the seat's locale: en_US answered ${en}, sv_SE answered ${sv}`);
});
