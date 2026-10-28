// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER RUN AGAIN ON AN INSTALLED NODE (kanban #734, the owner: "when re-running the install script and changing fundamental options
// like bitcoin, lightning, roles, reach, the new setting should reflect in the owners page correctly instead of raising errors"). The node's
// settings (arena.conf) are written only by "Install and start"; before this a re-run kept it done, so a new Bitcoin source or new roles
// stayed in the installer's state while the node ran on the old ones. Now: a change of the settings opens "Install and start" again (as
// another way to be reached does, #666); a bonded node's roles change on its owner page, which updates the bond - except custody, which is
// added here as --add-custody adds it; custody and a liquidity provider keep their own Bitcoin Core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWizard } from '../src/wizard.js';
import { nodeState } from '../src/state.js';

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
/** An installed node: every step done, its own Bitcoin Core; a posted bond when `bond`. */
function installed(home, { roles = ['verify', 'settlement'], bond = false } = {}) {
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  mkdirSync(join(home, 'runtime', 'custody'), { recursive: true });                 // the release's guardian binaries (release = home here)
  for (const f of ['fedimintd', 'fedimint-cli']) writeFileSync(join(home, 'runtime', 'custody', f), '');
  state.save({ roles, chain: { kind: 'core', url: 'http://127.0.0.1:48332/', cookiePath: join(home, 'c') }, owner: { mode: 'seed', pubkey: 'ab'.repeat(32) },
    reach: { mode: 'permanent', port: 8770, url: 'https://node.example.com' }, service: { port: 8770 },
    ...(roles.includes('custody') ? { lightning: { mode: 'own', pubkey: '03' + 'cd'.repeat(32), lnddir: join(home, 'lnd') } } : {}),
    ...(bond ? { bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157057 } } : {}), done: Object.fromEntries(ALL.map((k) => [k, 1])) });
  return state;
}
async function wizardOn(t, state, home) {
  const ok = async () => ({ ok: true, why: 'fine', source: { latencyMs: 1, height: 157000 } });
  const w = createWizard({ state, release: home, seatPort: 8770, test: ok, launch: () => ({ files: [] }) });
  const server = http.createServer((q, s) => w.handle(q, s));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
  const c = client(server.address().port);
  await c.get(`/?t=${w.token}`);
  return c;
}

test('a new Bitcoin source on an installed node opens "Install and start" again; the same one saved again does not', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rerun-734-'));
  const state = installed(home);
  const c = await wizardOn(t, state, home);
  assert.equal((await c.get('/api/state')).json.step, 'done');
  const same = (await c.post('/api/chain/save', { kind: 'core', url: 'http://127.0.0.1:48332/', cookiePath: join(home, 'c') })).json;
  assert.deepEqual([same.ok, same.again, Boolean(state.read().done.service)], [true, undefined, true], 'nothing changed: the install stays done');
  const other = (await c.post('/api/chain/save', { kind: 'electrum', host: 'electrum.example', port: 50002, tls: true })).json;
  assert.deepEqual([other.ok, other.again, Boolean(state.read().done.service)], [true, 'service', false]);
  assert.equal((await c.get('/api/state')).json.step, 'service', 'the node is installed again with the new source');
});

test('new roles on an installed node without a bond open "Install and start" again', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rerun-734-'));
  const state = installed(home, { roles: ['verify'] });
  const c = await wizardOn(t, state, home);
  const r = (await c.post('/api/roles', { roles: ['verify', 'settlement'] })).json;
  assert.deepEqual([r.ok, r.again, state.read().roles, (await c.get('/api/state')).json.step], [true, 'service', ['verify', 'settlement'], 'service']);
});

test('a bonded node: its roles change on the owner page, which updates the bond; custody is added here as --add-custody adds it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rerun-734-'));
  const state = installed(home, { bond: true });
  const c = await wizardOn(t, state, home);
  const fewer = (await c.post('/api/roles', { roles: ['verify'] })).json;
  assert.equal(fewer.ok, false);
  assert.match(fewer.why, /roles change on its owner page, not here: your bond names them: switch them on the owner page \(Roles\)/);
  assert.match((await c.post('/api/roles', { roles: ['verify', 'settlement', 'liquidity'] })).json.why, /liquidity provider is set up on the owner page/);
  assert.deepEqual([state.read().roles, Boolean(state.read().done.service), Boolean(state.read().done.bond)], [['verify', 'settlement'], true, true], 'nothing changed');
  // custody: the custody steps, then the bond step updates the advertisement (add-custody.test.js)
  const custody = (await c.post('/api/roles', { roles: ['verify', 'settlement', 'custody'] })).json;
  assert.equal(custody.ok, true, custody.why);
  let s = (await c.get('/api/state')).json;
  assert.deepEqual([s.step, s.custodyLater, Boolean(s.done.bond)], ['service', true, false], 'installed again, then Lightning, the federation, the rules and the advertisement update');
  // left out again: the node as it was
  assert.equal((await c.post('/api/roles', { roles: ['verify', 'settlement'] })).json.ok, true);
  s = (await c.get('/api/state')).json;
  assert.deepEqual([s.roles, Boolean(s.done.service), Boolean(s.done.bond)], [['verify', 'settlement'], true, true]);
});

test('a bonded custody node: custody stays (Leave on the owner page), and its Bitcoin Core is not swapped for Electrum', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rerun-734-'));
  const state = installed(home, { roles: ['verify', 'settlement', 'custody'], bond: true });
  const c = await wizardOn(t, state, home);
  assert.match((await c.post('/api/roles', { roles: ['verify', 'settlement'] })).json.why, /a guardian leaves only with Leave on its owner page/);
  const e = (await c.post('/api/chain/save', { kind: 'electrum', host: 'electrum.example', port: 50002, tls: true })).json;
  assert.equal(e.ok, false);
  assert.match(e.why, /this node runs custody, which needs your own Bitcoin Core/);
  assert.deepEqual([state.read().chain.kind, state.read().roles.includes('custody'), Boolean(state.read().done.service)], ['core', true, true]);
});
