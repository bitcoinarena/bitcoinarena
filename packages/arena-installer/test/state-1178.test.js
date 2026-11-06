// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STATE.JSON, SEVERAL PROCESSES (kanban #1178, the state machine audit 2026-11-06): the wizard, the owner page (the seat), the custody agent and
// the updater all read-modify-write it. Measured here before and after: a torn file read as a fresh install (done{} and the bond gone, so a
// second bond was allowed), and saves from several processes at once lost each other's fields. Uses only nodeState's read/save, so it runs
// against the source before #1178 too (and fails there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { nodeState, nextStep } from '../src/state.js';

const STATE_JS = pathToFileURL(join(import.meta.dirname, '..', 'src', 'state.js')).href;

test('a torn state.json never reads as a fresh install: the copy beside it, else a refusal', () => {
  const home = mkdtempSync(join(tmpdir(), 'state-1178-'));
  const st = nodeState(home);
  st.save({ chain: { kind: 'core' }, done: { start: 1, chain: 1, roles: 1, apps: 1, seed: 1, emergency: 1, owner: 1, reach: 1, service: 1, lightning: 1, federation: 1, promise: 1, bond: 1 },
    bond: { txid: 'aa'.repeat(32), sats: '50000' } });
  const whole = readFileSync(join(home, 'state.json'), 'utf8');
  // an older installer's update wrote state.json in place (writeFileSync): cut off by a crash, a full disk, a power loss
  writeFileSync(join(home, 'state.json'), whole.slice(0, 40));
  let s, threw = null;
  try { s = st.read(); } catch (e) { threw = e; }
  console.log(`  #1178 torn state.json: ${threw ? `refused (${threw.code})` : `read as step ${nextStep(s)}, bond ${s.bond ? s.bond.txid.slice(0, 8) : 'GONE'}`}`);
  assert.equal(threw, null, 'its copy is read');
  assert.equal((s.bond || {}).txid, 'aa'.repeat(32), 'the bond is still there: no second bond is allowed');
  assert.equal(nextStep(s), 'done');
  // and with no good copy either: the read refuses - nothing goes on from a fresh state over this node
  rmSync(join(home, 'state.json.bak'), { force: true });
  let refused = null;
  try { st.read(); } catch (e) { refused = e; }
  assert.ok(refused, 'refused, never { step: chain }');
  assert.equal(refused.code, 'STATE_UNREADABLE');
  assert.throws(() => st.save({ x: 1 }), /does not read/, 'and nothing is written over it');
  // a home with no state at all is still a new install
  assert.equal(nodeState(mkdtempSync(join(tmpdir(), 'state-1178-new-'))).read().step, 'chain');
});

test('saves from four processes at once lose nothing (each its own keys; and custody fields merged)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'state-1178-procs-'));
  nodeState(home).save({ custody: { pegInSats: 50000 } });
  const N = 4, M = 40;
  const child = (i) => new Promise((ok) => {
    const code = `const { nodeState } = await import(${JSON.stringify(STATE_JS)}); const st = nodeState(${JSON.stringify(home)}); let errs = 0;
      for (let j = 0; j < ${M}; j++) {
        try { st.save({ ['p${i}_' + j]: j }); } catch (e) { errs++; }
        try { if (st.merge) st.merge('custody', { ['c${i}_' + j]: j }); else st.save({ custody: { ...(st.read().custody || {}), ['c${i}_' + j]: j } }); } catch (e) { errs++; }
      }
      console.log(JSON.stringify({ errs }));`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => { try { ok(JSON.parse(out.trim().split('\n').pop())); } catch { ok({ errs: M * 2, why: err.slice(0, 200) }); } });
  });
  const results = await Promise.all(Array.from({ length: N }, (_, i) => child(i)));
  let s = {};
  try { s = nodeState(home).read(); } catch { s = {}; }
  const top = Object.keys(s).filter((k) => /^p\d+_\d+$/.test(k)).length;
  const nested = Object.keys(s.custody || {}).filter((k) => /^c\d+_\d+$/.test(k)).length;
  const errs = results.reduce((a, r) => a + r.errs, 0);
  console.log(`  #1178 ${N} processes x ${M} saves: ${top} of ${N * M} top-level keys kept, ${nested} of ${N * M} custody fields kept, ${errs} save(s) threw; custody.pegInSats ${s.custody ? s.custody.pegInSats : 'lost'}`);
  assert.equal(errs, 0, 'no save threw (a shared .tmp renamed away under another writer)');
  assert.equal(top, N * M, 'every top-level key kept');
  assert.equal(nested, N * M, 'every custody field kept');
  assert.equal(s.custody.pegInSats, 50000);
  assert.ok(!existsSync(join(home, 'state.json.lock')), 'the lock is given back');
});
