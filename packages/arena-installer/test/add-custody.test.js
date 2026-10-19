// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CUSTODY ADDED LATER (2026-10-18: "No slashing for leaving if you have no custody, so that will only come then. But if custody is
// setup later in the UI we need the same screens"): a node installed without custody skips the bond's rules; `--add-custody` reopens the
// wizard at the roles step with custody chosen, the custody steps follow (Lightning, federation, I UNDERSTAND), and the bond step updates
// the posted bond's advertisement to name custody - no second bond. Choosing no custody after all returns the node as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWizard, beginAddCustody } from '../src/wizard.js';
import { nodeState, seatEnv } from '../src/state.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

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

const installedNode = (home) => {
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  mkdirSync(join(home, 'runtime', 'custody'), { recursive: true });                 // the release's guardian binaries (release = home here)
  for (const f of ['fedimintd', 'fedimint-cli']) writeFileSync(join(home, 'runtime', 'custody', f), '');
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(new Uint8Array(32).fill(6)); db.close();
  const done = Object.fromEntries(['chain', 'roles', 'seed', 'owner', 'reach', 'service', 'lightning', 'federation', 'promise', 'bond', 'done'].map((k) => [k, 1]));
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core', url: 'http://x/' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    service: { port: 1 }, bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157057 }, done });
  return state;
};

test('custody added later: the same screens, then an advertisement update of the posted bond', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'add-custody-'));
  const state = installedNode(home);
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 317000, height: 156999 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  const programs = [];
  const gwKit = { installProgram: async (o) => { programs.push(o.id); return { ok: true }; } };
  assert.deepEqual(beginAddCustody(state), { ok: true });
  const w = createWizard({ state, release: home, seatPort: 1, chainKit, gwKit, launch: () => ({ files: [] }) });
  const server = http.createServer((q, s) => w.handle(q, s));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
  const c = client(server.address().port);
  await c.get(`/?t=${w.token}`);

  let s = (await c.get('/api/state')).json;
  assert.deepEqual([s.step, s.roles.includes('custody'), s.custodyLater], ['roles', true, true], 'the wizard opens at the roles step, custody chosen');
  assert.equal((await c.post('/api/roles', { roles: ['verify', 'settlement', 'custody'] })).json.ok, true);
  assert.equal((await c.get('/api/state')).json.step, 'service', 'the install again: seed, owner and reach stay done');
  state.save({ done: { ...state.read().done, service: 2 } });                                   // the install step (installer.test.js)
  assert.match(seatEnv(state.read(), { home, release: home }), /ARENA_FOUNDING=1/, 'the settings it writes name the guardian');
  assert.equal((await c.get('/api/state')).json.step, 'lightning', 'then the custody steps');
  state.save({ lightning: { mode: 'own', pubkey: '03' + 'cd'.repeat(32) }, done: { ...state.read().done, lightning: 2 } });   // the Lightning step (installer.test.js)
  assert.equal((await c.post('/api/federation', { mode: 'found' })).json.ok, true);
  assert.equal((await c.get('/api/state')).json.step, 'promise');
  assert.match((await c.post('/api/bond/post')).json.why, /I UNDERSTAND/, 'custody\'s bond rules before the update, as for a new custody node');
  assert.equal((await c.post('/api/promise', { text: 'I UNDERSTAND' })).json.ok, true);
  assert.equal((await c.get('/api/state')).json.step, 'bond');

  const check = (await c.post('/api/bond/check', { pegInSats: 50000 })).json;
  assert.deepEqual([check.parts, check.needSats, check.enough, check.lock, check.update], [{ custodyUpdate: 5000, advertUpdate: 5000, pegIn: 50000, outside: 103000, ring: 153000 }, 316000, true, null, true],
    'no second bond: this update, the reserve for the one naming the federation, the peg-in');
  const posted = (await c.post('/api/bond/post')).json;
  assert.equal(posted.ok, true, posted.why);
  assert.equal(sent.length, 2, 'the funding and the update');
  const u = readAdvertUpdate(fromHex(sent[1]), { network: 'testnet4' });
  assert.equal(u.ok, true, u.why);
  assert.deepEqual([u.advert.guardianCapable, u.advert.guardianEndpoint], [true, 'wss://node.example.com/guardian'], 'the update names the node\'s guardian');
  assert.equal(posted.bond.txid, '77'.repeat(32), 'the same bond');
  assert.deepEqual(programs, ['custody'], 'the custody agent runs');
  s = (await c.get('/api/state')).json;
  assert.deepEqual([s.step, s.custodyLater], ['done', false]);
  assert.equal((await c.post('/api/bond/post')).json.ok, false, 'once');
  assert.match(beginAddCustody(state).why, /holds custody already/);
});

test('custody added later and then left out: the node is as it was, the bond kept', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'add-custody-'));
  const state = installedNode(home);
  beginAddCustody(state);
  const w = createWizard({ state, release: home, seatPort: 1, launch: () => ({ files: [] }) });
  const server = http.createServer((q, s) => w.handle(q, s));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
  const c = client(server.address().port);
  await c.get(`/?t=${w.token}`);
  assert.equal((await c.post('/api/roles', { roles: ['verify', 'settlement'] })).json.ok, true);
  const s = (await c.get('/api/state')).json;
  assert.deepEqual([s.step, s.bond.txid], ['done', '77'.repeat(32)], 'no bond rules and no second bond without custody');
  assert.equal((await c.post('/api/bond/later')).json.ok, true);
  assert.equal(state.read().bond.txid, '77'.repeat(32), '"later" never drops a posted bond');
});
