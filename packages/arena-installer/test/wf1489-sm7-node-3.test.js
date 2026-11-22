// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM7 NODE-3: the owner binding's LEAVE state (owner.js: owner.leaving, kept in node.db.owner.json - "from now this seat takes no new
// round") is wiped by the installer run again on the installed node: its owner step (POST /api/owner, wizard.js) writes node.db.owner.json
// whole as { pubkey, claimedAtMs } - the same owner - dropping `leaving` and the store `settings`. The running seat keeps its memory until
// its next restart (an update, a reboot); from then the node that left (its departure notices posted) takes new rounds again.
// The invariant: the owner file's leave and settings change only through the owner's signed /owner/leave, /owner/stay, /owner/settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWizard } from '../src/wizard.js';
import { nodeState } from '../src/state.js';
import { createOwner } from '../../arena-node/src/owner.js';

const client = (port) => {
  let cookie = '';
  const go = (method, path, body) => new Promise((ok, no) => {
    const q = http.request({ host: '127.0.0.1', port, method, path, headers: { cookie, 'x-arena-wizard': '1', 'content-type': 'application/json' } }, (r) => {
      const set = r.headers['set-cookie']; if (set) cookie = set[0].split(';')[0];
      let t = ''; r.on('data', (d) => { t += d; }); r.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { /* html */ } ok({ status: r.statusCode, json }); });
    });
    q.on('error', no); if (body) q.write(JSON.stringify(body)); q.end();
  });
  return { get: (p) => go('GET', p), post: (p, b) => go('POST', p, b || {}) };
};
const ALL = ['start', 'chain', 'roles', 'apps', 'seed', 'emergency', 'owner', 'reach', 'service', 'lightning', 'federation', 'promise', 'bond', 'done'];

test('wf1489-sm7-node-3: the installer run again keeps the owner\'s Leave (and store settings) in node.db.owner.json', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wf1489-sm7-node-3-'));
  const state = nodeState(home);
  const owner = 'ab'.repeat(32);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  mkdirSync(join(home, 'runtime', 'custody'), { recursive: true });
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core', url: 'http://127.0.0.1:48332/', cookiePath: join(home, 'c') }, owner: { mode: 'seed', pubkey: owner },
    seedOwnerPubkey: owner, reach: { mode: 'permanent', port: 8770, url: 'https://node.example.com' }, service: { port: 8770 }, done: Object.fromEntries(ALL.map((k) => [k, 1])) });
  // the owner said Leave on the owner page (owner.js leave: kept with the owner) and set the store's sources
  writeFileSync(join(home, 'node.db.owner.json'), JSON.stringify({ pubkey: owner, claimedAtMs: 1000, leaving: { atMs: 5000 }, settings: { autoUpdate: true, sources: ['https://seat.example'] } }) + '\n');
  const ok = async () => ({ ok: true, why: 'fine', source: { latencyMs: 1, height: 157000 } });
  const w = createWizard({ state, release: home, seatPort: 8770, test: ok, launch: () => ({ files: [] }) });
  const server = http.createServer((q, s) => w.handle(q, s));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
  const c = client(server.address().port);
  await c.get(`/?t=${w.token}`);
  // the installer run again; its owner step confirmed with the same owner (the seed's)
  const r = (await c.post('/api/owner', { mode: 'seed' })).json;
  assert.equal(r.ok, true, r.why);
  const file = JSON.parse(readFileSync(join(home, 'node.db.owner.json'), 'utf8'));
  // the seat as it starts next (main.js ownerFiles -> createOwner reads the file)
  const o = createOwner({ store: { read: () => file, write: () => {}, writeCode: () => {} }, verify: () => true, node: 'cd'.repeat(32) });
  console.log(`  wf1489-sm7-node-3: after the rerun's owner step the owner file is ${JSON.stringify(file)}; the restarted seat leaving: ${o.leavingAtMs()}`);
  assert.equal(file.pubkey, owner);
  assert.equal(o.leavingAtMs(), 5000, 'the node that left takes new rounds again after its next restart: the rerun dropped owner.leaving');
  assert.deepEqual((file.settings || {}).sources, ['https://seat.example'], 'the store settings were dropped');
});
