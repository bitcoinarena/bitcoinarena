// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Feedback #024 (kanban #2567): "toLocaleString / localeCompare / toLocaleLower/UpperCase read the host locale, so stateHash diverges between seats with
// different LC_ALL" and "Uint8Array.fromHex / fromBase64 allocate outside the array budget". One core using every locale-aware method the report names is
// run in a child process per locale: its state hash must be the same under C, de_DE and sv_SE; inside it fromHex and fromBase64 must not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const DIR = mkdtempSync(join(tmpdir(), 'sandbox-locale-024-'));
const src = `export const CORE = Object.freeze({
  name: 'locale', RUN_TICKS: 1, INPUT_WORDS: 5,
  start: (seed) => ({ seed, t: 0, s: '' }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  step(st) { st.s = [(1234567.5).toLocaleString(), (12345678901234567890n).toLocaleString(), [1234.5, 2].toLocaleString(), new Float64Array([1234.5]).toLocaleString(),
    ({}).toLocaleString(), 'ä'.localeCompare('z'), 'z'.localeCompare('ä'), 'I'.toLocaleLowerCase(), 'i'.toLocaleUpperCase(), typeof Uint8Array.fromHex, typeof Uint8Array.fromBase64].join('|'); st.t++; },
  stateHash: (st) => st.s,
  result: (st) => ({ outcome: 'DELIVERED', score: st.t, heat: 0 }),
});`;
const file = join(DIR, 'core.js'); writeFileSync(file, src);
const runner = join(DIR, 'run.mjs');
writeFileSync(runner, `import { sandboxFor } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../src/core-sandbox.js', import.meta.url))).href)};
const c = { name: 'locale', hash: ${JSON.stringify(createHash('sha256').update(src).digest('hex'))}, url: ${JSON.stringify(pathToFileURL(file).href)} };
const out = sandboxFor(c, {}).call('replay', { seedWord: 1, config: {}, runTicks: 1, start: 0, words: [[0, 0, 0, 0, 0]], events: {}, marks: [], pictures: [] });
console.log(JSON.stringify(out.stateHash ?? out.hash ?? out));`);

test('#024 one state hash under every locale, and no fromHex / fromBase64 in a core', () => {
  const run = (lc) => execFileSync(process.execPath, [runner], { env: { ...process.env, LC_ALL: lc, LANG: lc }, encoding: 'utf8' }).trim().split('\n').pop();
  const got = Object.fromEntries(['C', 'de_DE.UTF-8', 'sv_SE.UTF-8'].map((lc) => [lc, run(lc)]));
  console.log('  FACTS #024:', JSON.stringify(got));
  assert.equal(new Set(Object.values(got)).size, 1, `the state differs by locale: ${JSON.stringify(got)}`);
  assert.match(got.C, /undefined\|undefined/, 'fromHex and fromBase64 are not in the core\'s realm');
});
