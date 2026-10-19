// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TEST FAULT IS OFF BY DEFAULT AND NAMES ONE ENTRY (ORDER-2116, RULED 2026-10-02, invalidation case 1). A seat
// reads ARENA_TEST_DISSENT_ENTRY once, at start: unset, nothing dissents; set, that one entry and no other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const probe = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
  const m = await import(${JSON.stringify(new URL('../src/test-dissent.js', import.meta.url).href)});
  const a = new Uint8Array(32).fill(0xaa), b = new Uint8Array(32).fill(0xbb);
  console.log(JSON.stringify({ named: m.testDissentEntry, a: m.dissentsOn(a), b: m.dissentsOn(b) }));`], { env: { ...process.env, ...env } }).toString());

test('unset, no entry dissents; set, only the named entry does; a malformed name names none', () => {
  const off = probe({ ARENA_TEST_DISSENT_ENTRY: '' });
  const on = probe({ ARENA_TEST_DISSENT_ENTRY: 'aa'.repeat(32) });
  const bad = probe({ ARENA_TEST_DISSENT_ENTRY: 'aa'.repeat(31) });
  console.log('  FACTS (test dissent):', JSON.stringify({ off, on, bad }));
  assert.deepEqual(off, { named: null, a: false, b: false });
  assert.deepEqual(on, { named: 'aa'.repeat(32), a: true, b: false });
  assert.deepEqual(bad, { named: null, a: false, b: false });
});

test('armed from a file, without a restart: an empty file names none; the entry written into it is named within 2 s', () => {
  const dir = execFileSync('mktemp', ['-d']).toString().trim();
  const f = `${dir}/dissent.txt`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const fs = await import('node:fs');
    fs.writeFileSync(${JSON.stringify(f)}, '');
    const m = await import(${JSON.stringify(new URL('../src/test-dissent.js', import.meta.url).href)});
    const a = new Uint8Array(32).fill(0xaa);
    const before = m.dissentsOn(a);
    fs.writeFileSync(${JSON.stringify(f)}, '${'aa'.repeat(32)}\\n');
    await new Promise((r) => setTimeout(r, 2100));
    const after = m.dissentsOn(a), other = m.dissentsOn(new Uint8Array(32).fill(0xbb));
    console.log(JSON.stringify({ before, after, other }));`], { env: { ...process.env, ARENA_TEST_DISSENT_ENTRY: '', ARENA_TEST_DISSENT_FILE: f } }).toString());
  console.log('  FACTS (file):', JSON.stringify(out));
  assert.deepEqual(out, { before: false, after: true, other: false });
});

test('the switch reaches exactly two places: an objection\'s replay check and the seat\'s own re-run', () => {
  const src = new URL('../src/', import.meta.url);
  const finality = readFileSync(new URL('finality.js', src), 'utf8');
  const verify = readFileSync(new URL('verify.js', src), 'utf8');
  assert.equal((finality.match(/dissentsOn\(/g) || []).length, 1);
  assert.match(finality, /replayDiffers: \(mine !== null && hex\(mine\) !== seen\.runId\) \|\| dissentsOn\(entryIdBytes\)/);
  assert.match(verify, /dissentsOn\(entryIdBytes\) \? \{ \.\.\.built\.result, score: \(built\.result\.score \+ 1\) >>> 0 \} : built\.result/);
});

// AND THE OBJECTION DOOR READS IT TOO (2026-10-05): since the door replays the bundle and refused an
// honest one - "the replay agrees with the signed result" - before finality could see the fault. For the named entry only.
test('the objection door counts the named entry\'s replay as differing, and only that entry', () => {
  const src = readFileSync(new URL('../src/objection-check.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ dissentsOn \} from '\.\/test-dissent\.js';/);
  assert.match(src, /if \(hex\(claimed\) === hex\(signedResultId\) && !dissentsOn\(entryId\)\)\n\s+return \{ \.\.\.no\('replay', 'the replay agrees with the signed result'\)/);
});
