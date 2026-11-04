// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN AGENT RUNS AS AN APP RUNS (kanban #1122, measured 2026-11-04 on the main test host): an agent with no ProcessType ran at priority 20
// (spawn type daemon), a program started from a shell at 31; on a busy machine the installer node's loop was held up to 16 s while its thread
// used under 1 s of processor, and its GET /identity went unanswered for 5-15 s. Every agent the installer writes says Interactive, and
// an update moves an older agent to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchdPlist, installProgram, interactivePlist, LAUNCHD_LABEL } from '../src/service.js';

const INTERACTIVE = /<key>ProcessType<\/key><string>Interactive<\/string>/;
const lint = (file) => { if (process.platform === 'darwin') execFileSync('plutil', ['-lint', file]); };

test('the seat\'s agent and every program\'s agent say ProcessType Interactive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-1122-'));
  try {
    assert.match(launchdPlist({ node: '/n', release: '/r', home: '/h', port: 8470 }), INTERACTIVE);
    const calls = [];
    const r = await installProgram({ id: 'gateway', description: 'the gateway', args: ['/bin/true'], home: root, env: { HOME: root }, platform: 'darwin',
      sh: async (...a) => { calls.push(a); return { ok: true, out: '', err: '' }; } });
    assert.equal(r.ok, true);
    const file = join(root, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.gateway.plist`);
    assert.match(readFileSync(file, 'utf8'), INTERACTIVE);
    lint(file);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an older agent with no ProcessType is moved to Interactive once; one that names its own keeps it', () => {
  const now = launchdPlist({ node: '/n', release: '/r', home: '/h', port: 8470 });
  const older = now.replace(/\n\s*<key>ProcessType<\/key><string>Interactive<\/string>/, '');
  assert.doesNotMatch(older, /ProcessType/);
  const moved = interactivePlist(older);
  assert.match(moved, INTERACTIVE);
  assert.match(moved, /<\/dict>\n<\/plist>\n$/);
  assert.equal(interactivePlist(moved), moved, 'a second move changes nothing');
  const own = older.replace('</dict>', '  <key>ProcessType</key><string>Background</string>\n</dict>');
  assert.equal(interactivePlist(own), own);
  assert.equal(interactivePlist('[Unit]\nDescription=x\n'), '[Unit]\nDescription=x\n', 'not a plist: unchanged');
});

// THE OLD UPDATER WROTE THEM (kanban #1128, measured 2026-11-04 18:48Z on an installer node: 2026.1.9.24 -> 2026.1.9.25 is run by the 1.9.24
// updater, which writes the agents without ProcessType): the new release's updater service moves them itself, once, at its start
test('#1128 the new release moves this node\'s agents to Interactive once: the tunnel and the updater not reloaded, the seat last', async () => {
  const { moveAgentsInteractive, ownAgents } = await import('../src/launchd-interactive.js');
  const { runAutoUpdate } = await import('../src/auto-update.js');
  const root = mkdtempSync(join(tmpdir(), 'arena-1128-'));
  try {
    const home = join(root, 'home'), dir = join(root, 'LaunchAgents');
    mkdirSync(home); mkdirSync(dir);
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', step: 'done' }));
    const L = 'io.bitcoin-arena.node--t1';
    const older = (label) => launchdPlist({ node: '/n', release: '/r', home: '/h', port: 8470 }).replace(`<string>${LAUNCHD_LABEL}</string>`, `<string>${label}</string>`)
      .replace(/\n\s*<key>ProcessType<\/key><string>Interactive<\/string>/, '');
    for (const l of [L, `${L}.tunnel`, `${L}.lnd`, `${L}.updater`, `${L}.gateway`, `${L}.bitcoind-testnet4`, `${L}.custody`, 'io.bitcoin-arena.node--t2', 'io.bitcoin-arena.node--t1x.lnd']) writeFileSync(join(dir, `${l}.plist`), older(l));
    const own = ownAgents(dir, L);
    assert.equal(own.length, 7, 'this node\'s seven agents, not another instance\'s');
    const calls = [];
    const sh = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: !(args[0] === 'print' && args[1].endsWith('.custody')), out: '', err: '' }; };
    // inside a seating window first (minute 12 of the quarter): the seat waits it out
    let now = 12 * 60_000; const slept = [];
    const r = await moveAgentsInteractive({ home, sh, platform: 'darwin', dir, label: L, uid: 501, pauseMs: 0, nowMs: () => now, sleep: async (ms) => { slept.push(ms); now += 3 * 60_000; } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.set.sort(), ['bitcoind-testnet4', 'custody', 'gateway', 'lnd', 'node', 'tunnel', 'updater']);
    for (const a of own) { const t = readFileSync(a.file, 'utf8'); assert.match(t, INTERACTIVE, a.label); lint(a.file); }
    for (const l of ['io.bitcoin-arena.node--t2', 'io.bitcoin-arena.node--t1x.lnd']) assert.doesNotMatch(readFileSync(join(dir, `${l}.plist`), 'utf8'), /ProcessType/, `${l}: another node's agent is left alone`);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, 'no file left half written');
    // reloaded: bootout then bootstrap, chain first, the seat last; never the tunnel or the updater; one not loaded (custody) not started
    const boots = calls.filter((c) => / boot(out|strap) /.test(c));
    const reload = (l) => [`launchctl bootout gui/501/${l}`, `launchctl bootstrap gui/501 ${join(dir, `${l}.plist`)}`];
    assert.deepEqual(boots, [...reload(`${L}.bitcoind-testnet4`), ...reload(`${L}.lnd`), ...reload(`${L}.gateway`), ...reload(L)]);
    assert.ok(!calls.some((c) => /\.(tunnel|updater)/.test(c) && /boot/.test(c)), 'the tunnel and the updater are never booted out');
    assert.deepEqual(r.reloaded, ['bitcoind-testnet4', 'lnd', 'gateway', 'node']);
    assert.deepEqual(r.kept.sort(), ['custody', 'tunnel', 'updater']);
    assert.ok(slept.length >= 1, 'the seat waited out the seating window');
    const st = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.equal(st.step, 'done', 'the rest of state.json kept');
    assert.deepEqual(st.launchdInteractive.reloaded, r.reloaded);
    // a second run does nothing - even with an agent written without the key again
    writeFileSync(join(dir, `${L}.lnd.plist`), older(`${L}.lnd`));
    calls.length = 0;
    assert.deepEqual(await moveAgentsInteractive({ home, sh, platform: 'darwin', dir, label: L, uid: 501, pauseMs: 0 }), { already: true });
    assert.equal(calls.length, 0);
    assert.doesNotMatch(readFileSync(join(dir, `${L}.lnd.plist`), 'utf8'), /ProcessType/);
    // Linux and Windows: nothing read, nothing written, nothing run
    for (const platform of ['linux', 'win32']) {
      const h2 = join(root, `home-${platform}`); mkdirSync(h2); writeFileSync(join(h2, 'state.json'), '{}');
      const before = readFileSync(join(dir, `${L}.lnd.plist`), 'utf8');
      const x = await moveAgentsInteractive({ home: h2, sh, platform, dir, label: L, uid: 501, pauseMs: 0 });
      assert.ok(x.skipped, platform);
      assert.equal(readFileSync(join(dir, `${L}.lnd.plist`), 'utf8'), before);
      assert.equal(readFileSync(join(h2, 'state.json'), 'utf8'), '{}');
      assert.equal(calls.length, 0);
    }
    // the updater service runs it at its start, before its first wait
    const seen = [];
    await runAutoUpdate({ home: '/h', latest: null, log: () => {}, sleep: async () => { seen.push('sleep'); }, exit: () => 0, once: async () => ({ ok: true, upToDate: true }), rounds: 0,
      interactive: async (o) => { seen.push(`interactive ${o.home}`); return { skipped: 'test' }; } });
    assert.deepEqual(seen, ['interactive /h', 'sleep']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
