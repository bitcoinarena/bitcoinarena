// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DETERMINISM GUARD IN THE SUITE (spec audit). tools/check-determinism.js refuses, in a core's source,
// float literals, '* / %' outside the arithmetic files, Math members off its whitelist, Date and performance, and imports
// from outside the package - and until now it ran on core/src only, by hand, and reported 49 hits nobody had pinned.
//
// Every core a seat installs is checked here - core/src (68e2b3d6) and the frozen cores beside it - against its own
// baseline (test/determinism-baseline.json). A core's bytes are its hash, so the hits a live core carries cannot be edited
// out of it; they are pinned by the core's own source text (file, rule, text - never a line number, so an unrelated line
// move fails nothing). A hit not in that core's baseline fails; a baseline entry no longer found fails too, so the list only
// changes on purpose. The seeded runtime check is vectors.test.js (golden seeds against stored hashes), unchanged.
// Nothing is copied from the old C#/PhysX engine: no number of theirs clears a hit here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCoreTree } from '../tools/check-determinism.js';
import { coreHashHex } from '../tools/hash-core.js';

const BASELINE = JSON.parse(readFileSync(new URL('./determinism-baseline.json', import.meta.url), 'utf8'));
const treeOf = (dir) => new URL(`../${dir}`, import.meta.url).pathname;
const key = (h) => `${h.file}\u0000${h.rule}\u0000${h.text}`;

/** What fails: each hit beyond its baseline (by file, rule and text), and each baseline entry no longer found. */
export function guardLines(hash, tree, hits, baseline) {
  const left = new Map();
  for (const b of baseline) left.set(key(b), (left.get(key(b)) || 0) + 1);
  const lines = [];
  for (const h of hits) {
    const n = left.get(key(h)) || 0;
    if (n > 0) { left.set(key(h), n - 1); continue; }
    lines.push(`determinism guard: core ${hash} (${tree}) ${h.file}:${h.line} ${h.message} - not in its baseline`);
  }
  for (const b of baseline) {
    const n = left.get(key(b)) || 0;
    if (n <= 0) continue;
    left.set(key(b), n - 1);
    lines.push(`determinism guard: core ${hash} (${tree}) ${b.file} ${b.rule} "${b.text}" - in its baseline and no longer found (baseline shrank - update it on purpose)`);
  }
  return lines;
}

// 68e2b3d6 (2026-10-07): §4.11's objectives from the chart, RIDGE_GOAL gone; 7e2123d1 frozen beside it in
// core/frozen/7e2123d1 (its hash computed from its files: 7e2123d1990d1443...).
test('the baseline names the four cores a seat installs, and core/src is the live core 68e2b3d6', () => {
  assert.deepEqual(Object.keys(BASELINE.cores).sort(), ['2069b4c2', '68e2b3d6', '7e2123d1', 'de2f263d']);
  assert.equal(BASELINE.cores['68e2b3d6'].tree, 'src');
  assert.equal(BASELINE.cores['7e2123d1'].tree, 'frozen/7e2123d1');
  assert.ok(coreHashHex().startsWith('68e2b3d6'), 'core/src is no longer 68e2b3d6: a new core needs its own baseline entry');
});

for (const [hash, { tree, hits: baseline }] of Object.entries(BASELINE.cores)) {
  test(`core ${hash} (${tree}) has no determinism hit beyond its baseline, and every baseline entry is still there`, () => {
    const { files, hits } = checkCoreTree(treeOf(tree));
    const lines = guardLines(hash, tree, hits, baseline);
    console.log(`  core ${hash} (${tree}): ${files} files, ${hits.length} hits, ${baseline.length} pinned, ${lines.length} failing`);
    assert.deepEqual(lines, []);
  });
}

// THE GUARD BITES (the two failure lines, measured): a copy of core/src with one new float and one new operator in a
// non-arithmetic file fails the new-hit line for each; the real tree against a baseline missing one entry fails the
// shrink line for it.
test('a new float or operator not in the baseline fails the new-hit line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blwp-determinism-'));
  try {
    cpSync(treeOf('src'), dir, { recursive: true });
    appendFileSync(join(dir, 'sim.js'), '\nexport const DETERMINISM_PROBE = 3 * 0.5;\n');
    const { hits } = checkCoreTree(dir);
    const lines = guardLines('68e2b3d6', 'src', hits, BASELINE.cores['68e2b3d6'].hits);
    console.log(lines.map((l) => '  ' + l).join('\n'));
    assert.equal(lines.length, 2);
    assert.ok(lines.some((l) => /^determinism guard: core 68e2b3d6 \(src\) sim\.js:\d+ operator '\*' outside an arithmetic file - not in its baseline$/.test(l)));
    assert.ok(lines.some((l) => /^determinism guard: core 68e2b3d6 \(src\) sim\.js:\d+ float literal 0\.5 - not in its baseline$/.test(l)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a baseline entry that is no longer found fails the shrink line', () => {
  const { hits } = checkCoreTree(treeOf('src'));
  const baseline = BASELINE.cores['68e2b3d6'].hits;
  const dropped = baseline[0];
  const lines = guardLines('68e2b3d6', 'src', hits.filter((h) => h !== hits.find((x) => key(x) === key(dropped))), baseline);
  console.log(lines.map((l) => '  ' + l).join('\n'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `determinism guard: core 68e2b3d6 (src) ${dropped.file} ${dropped.rule} "${dropped.text}" - in its baseline and no longer found (baseline shrank - update it on purpose)`);
});
