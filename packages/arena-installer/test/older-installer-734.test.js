// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN OLDER INSTALLER DOES NOT MOVE A NEWER NODE BACK (kanban #734, measured 2026-10-29 in the Linux VM: the 2026.1.9.12 installer run again on
// a node updated to 2026.1.9.14 - "Install and start" put the node's services on 2026.1.9.12, and the owner page said "A new release is out").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWizard } from '../src/wizard.js';
import { nodeState } from '../src/state.js';

const ALL = ['start', 'chain', 'roles', 'apps', 'seed', 'emergency', 'owner', 'reach', 'service', 'lightning', 'federation', 'promise', 'bond', 'done'];
const releaseOf = (v) => { const d = mkdtempSync(join(tmpdir(), 'rel-734-')); writeFileSync(join(d, 'VERSION'), `${v}\n`); return d; };

/** "Install and start" on a node that runs `runs`, from an installer of `mine`: its answer, and whether it got to the install. */
async function installAndStart(t, { runs, mine }) {
  const home = mkdtempSync(join(tmpdir(), 'older-734-'));
  const nodeRelease = releaseOf(runs), installer = releaseOf(mine);
  t.after(() => { for (const d of [home, nodeRelease, installer]) rmSync(d, { recursive: true, force: true }); });
  const state = nodeState(home);
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core', url: 'http://127.0.0.1:48332/', cookiePath: join(home, 'c') }, owner: { mode: 'seed', pubkey: 'ab'.repeat(32) },
    reach: { mode: 'quick', port: 8770 }, release: { path: nodeRelease }, done: Object.fromEntries(ALL.map((k) => [k, 1])) });
  let installed = 0;
  const w = createWizard({ state, release: installer, seatPort: 8770, test: async () => ({ ok: true, source: { latencyMs: 1, height: 1 } }), launch: () => ({ files: [] }),
    install: async () => { installed++; return { ok: false, why: 'stopped here by the test' }; } });
  const server = http.createServer((q, s) => w.handle(q, s));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  let cookie = '';
  const go = (method, path, body) => new Promise((ok, no) => {
    const q = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers: { cookie, 'x-arena-wizard': '1', 'content-type': 'application/json' } }, (r) => {
      const set = r.headers['set-cookie']; if (set) cookie = set[0].split(';')[0];
      let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* html */ } ok(j); });
    });
    q.on('error', no); if (body) q.write(JSON.stringify(body)); q.end();
  });
  await go('GET', `/?t=${w.token}`);
  return { r: await go('POST', '/api/service', {}), installed };
}

test('a node newer than the installer: "Install and start" refuses and names the installer to use; nothing is installed', async (t) => {
  const { r, installed } = await installAndStart(t, { runs: '2026.1.9.14', mine: '2026.1.9.12' });
  assert.equal(r.ok, false);
  assert.equal(r.why, 'this node runs 2026.1.9.14, newer than this installer (2026.1.9.12): Install and start would move it back to 2026.1.9.12. Run the installer of 2026.1.9.14 or newer instead (bitcoinarena update keeps the node current)');
  assert.equal(installed, 0, 'the node is not touched');
});

test('the same release or an older node: "Install and start" goes on to the install', async (t) => {
  assert.equal((await installAndStart(t, { runs: '2026.1.9.14', mine: '2026.1.9.14' })).installed, 1, 'the same release');
  assert.equal((await installAndStart(t, { runs: '2026.1.9.12', mine: '2026.1.9.14' })).installed, 1, 'an update by the installer');
});
