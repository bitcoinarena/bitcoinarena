// THE TEST FAULT IS OFF BY DEFAULT AND NAMES ONE ENTRY (ORDER-2116, RULED the owner 2026-10-02, invalidation case 1). A seat
// reads BLWP_TEST_DISSENT_ENTRY once, at start: unset, nothing dissents; set, that one entry and no other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const probe = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
  const m = await import(${JSON.stringify(new URL('../src/test-dissent.js', import.meta.url).href)});
  const a = new Uint8Array(32).fill(0xaa), b = new Uint8Array(32).fill(0xbb);
  console.log(JSON.stringify({ named: m.testDissentEntry, a: m.dissentsOn(a), b: m.dissentsOn(b) }));`], { env: { ...process.env, ...env } }).toString());

test('unset, no entry dissents; set, only the named entry does; a malformed name names none', () => {
  const off = probe({ BLWP_TEST_DISSENT_ENTRY: '' });
  const on = probe({ BLWP_TEST_DISSENT_ENTRY: 'aa'.repeat(32) });
  const bad = probe({ BLWP_TEST_DISSENT_ENTRY: 'aa'.repeat(31) });
  console.log('  FACTS (test dissent):', JSON.stringify({ off, on, bad }));
  assert.deepEqual(off, { named: null, a: false, b: false });
  assert.deepEqual(on, { named: 'aa'.repeat(32), a: true, b: false });
  assert.deepEqual(bad, { named: null, a: false, b: false });
});

test('the switch reaches exactly two places: an objection\'s replay check and the seat\'s own re-run', () => {
  const src = new URL('../src/', import.meta.url);
  const finality = readFileSync(new URL('finality.js', src), 'utf8');
  const verify = readFileSync(new URL('verify.js', src), 'utf8');
  assert.equal((finality.match(/dissentsOn\(/g) || []).length, 1);
  assert.match(finality, /replayDiffers: \(mine !== null && hex\(mine\) !== seen\.runId\) \|\| dissentsOn\(entryIdBytes\)/);
  assert.match(verify, /dissentsOn\(entryIdBytes\) \? \{ \.\.\.built\.result, score: \(built\.result\.score \+ 1\) >>> 0 \} : built\.result/);
});
