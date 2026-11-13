// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #2601 NO DOWNGRADE BY HAND (kanban #2601, update audit): `arena-install --update <asset>` takes any asset whose SHA256SUMS beside it is signed
// by the release key - an OLDER signed release too. Whoever serves the download (a mirror, the website, the network path) hands the owner the
// asset, SHA256SUMS and SHA256SUMS.sig of an old release with known holes, all genuinely signed, and the node was moved back to it. The auto
// updater and --update-self only ever move forward (newerVersion); the move itself now refuses a release older than the one running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNode, releaseIdOf, releaseOfLauncher } from '../src/update.js';
import { windowsLauncher } from '../src/service.js';

test('#2601 a release older than the running one is refused before anything stops; a newer one still moves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf2601-1-'));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const rel = join(root, 'releases');
  const old = join(rel, 'bitcoin-arena-node-2026.1.9.5-windows-x64'), cur = join(rel, 'bitcoin-arena-node-2026.1.9.17-windows-x64'), next = join(rel, 'bitcoin-arena-node-2026.1.9.18-windows-x64');
  for (const [d, v] of [[old, '2026.1.9.5'], [cur, '2026.1.9.17'], [next, '2026.1.9.18']]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'VERSION'), `${v}\n`); writeFileSync(join(d, 'COMMIT'), `${v.replace(/\D/g, '').padEnd(40, '0')}\n`); }
  const fresh = () => {
    writeFileSync(join(home, 'arena.conf'), 'network=testnet4\r\nroles=verify\r\n');
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 } }));
    writeFileSync(join(home, 'arena-node.cmd'), windowsLauncher({ node: `${cur}\\runtime\\node.exe`, release: cur, home, port: 8470 }));
  };
  let answering = null;
  const fetcher = async (url) => (String(url).endsWith('/owner/version')
    ? { status: 200, json: async () => releaseIdOf(answering) }
    : { status: 200, arrayBuffer: async () => new Uint8Array(32).fill(0xab).buffer });
  const calls = [];
  const sh = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true, out: cmd === 'powershell' && /ConvertTo-Json/.test(args.at(-1)) ? '[]' : '', err: '' }; };
  const run = (to, o = {}) => { answering = to; return updateNode({ home, newRelease: to, port: 8470, node: `${to}\\runtime\\node.exe`, sh, fetcher, nowMs: () => 0, platform: 'win32', waitMs: 2500, ...o }); };
  fresh();
  const r = await run(old);
  assert.equal(r.ok, false, 'the older signed release 2026.1.9.5 must not replace 2026.1.9.17');
  assert.match(String(r.why), /older than the release this node runs/);
  assert.equal(calls.length, 0, `nothing stopped or started: ${calls.join(' | ')}`);
  assert.equal(releaseOfLauncher(readFileSync(join(home, 'arena-node.cmd'), 'utf8')), cur, 'the node still runs 2026.1.9.17');
  // the owner who means it says so
  fresh(); calls.length = 0;
  const back = await run(old, { allowOlder: true });
  assert.equal(back.ok, true, back.why);
  // forward still moves
  fresh(); calls.length = 0;
  const fwd = await run(next);
  assert.equal(fwd.ok, true, fwd.why);
  assert.equal(releaseOfLauncher(readFileSync(join(home, 'arena-node.cmd'), 'utf8')), next);
});
