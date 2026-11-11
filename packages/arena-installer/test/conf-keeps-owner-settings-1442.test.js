// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A REWRITE OF ARENA.CONF KEEPS THE OWNER'S OWN SETTINGS (kanban #1442, settings audit 8 finding O8-3): "Become a liquidity provider",
// "Install and start" again (and the owner page's reach / custody / chain switch, which run the same service step) wrote arena.conf from
// state.json alone, so what the owner set with `bitcoinarena config set` - auto_update=0, duty_post=off, seating=0, latest_url,
// log_level - was gone: the node updated itself, posted rounds and paid their fees, and was seated again. The writer now sets only its
// own keys; every other key in the file stays as the owner left it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addLiquidityOnNode } from '../src/add-liquidity.js';
import { createWizard } from '../src/wizard.js';
import { nodeState, seatConf, mergeSeatConf } from '../src/state.js';
import { parseConf, setInConf } from '../../arena-node/src/arena-conf.js';

const OWNER = [['auto_update', '0'], ['duty_post', 'off'], ['seating', '0'], ['log_level', 'debug'], ['latest_url', 'https://testnet.bitcoinarena.io/test/latest.json']];
const ALL = ['start', 'chain', 'roles', 'apps', 'seed', 'emergency', 'owner', 'reach', 'service', 'lightning', 'federation', 'promise', 'bond', 'done'];

/** The installer's arena.conf for this state, then the owner's own settings set as `bitcoinarena config set` writes them. */
function ownerConf(state, release) {
  let conf = seatConf({ ...state.read(), port: state.read().reach.port }, { home: state.home, release });
  for (const [k, v] of OWNER) conf = setInConf(conf, k, v);
  writeFileSync(join(state.home, 'arena.conf'), conf, { mode: 0o600 });
}
const confOf = (home) => parseConf(readFileSync(join(home, 'arena.conf'), 'utf8')).values;
const keptAll = (values) => { for (const [k, v] of OWNER) assert.equal(values[k], v, `${k} is kept`); };

test('becoming a liquidity provider keeps auto_update, duty_post, seating, log_level and latest_url', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'liq-1442-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(new Uint8Array(32).fill(6)); db.close();
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core', url: 'http://127.0.0.1:48332/' }, owner: { pubkey: 'ab'.repeat(32) },
    reach: { mode: 'permanent', url: 'https://node.example.com', port: 8570 }, lightning: { mode: 'own', restUrl: 'https://127.0.0.1:10080', lnddir: join(home, 'lnd'), pubkey: '03' + 'cd'.repeat(32) },
    custodyAgent: { installedMs: 1 } });
  ownerConf(state, '/rel');
  const kit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 312380 }] }), testLnd: async () => ({ ok: true, pubkey: '03' + 'cd'.repeat(32) }),
    installProgram: async () => ({ ok: true }) };
  const r = await addLiquidityOnNode({ home, release: '/rel', state, kit, node: '/node', post: true });
  assert.equal(r.ok, true, r.why);
  const after = confOf(home);
  keptAll(after);
  // the writer's own keys took the new state
  assert.equal(after.roles, 'verify,settlement,liquidity');
  assert.equal(after.liquidity_claim_file, join(home, 'liquidity-claim.json'));
});

test('running the installer again ("Install and start") keeps them too', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wiz-1442-')), release = mkdtempSync(join(tmpdir(), 'rel-1442-'));
  t.after(() => { for (const d of [home, release]) rmSync(d, { recursive: true, force: true }); });
  writeFileSync(join(release, 'VERSION'), '2026.1.9.27\n');
  const state = nodeState(home);
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core', url: 'http://127.0.0.1:48332/', cookiePath: join(home, 'c') }, owner: { mode: 'seed', pubkey: 'ab'.repeat(32) },
    reach: { mode: 'quick', port: 8770 }, release: { path: release }, done: Object.fromEntries(ALL.map((k) => [k, 1])) });
  ownerConf(state, release);
  // a changed fundamental on the re-run: the node reads a different Core now
  state.save({ chain: { kind: 'core', url: 'http://127.0.0.1:48999/', cookiePath: join(home, 'c2') } });
  const w = createWizard({ state, release, seatPort: 8770, test: async () => ({ ok: true, source: { latencyMs: 1, height: 1 } }), launch: () => ({ files: [] }),
    install: async () => ({ ok: false, why: 'stopped here by the test' }) });
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
  const r = await go('POST', '/api/service', {});
  assert.equal(r.why, 'stopped here by the test', 'the settings were written, then the install stopped');
  const after = confOf(home);
  keptAll(after);
  assert.equal(after.bitcoind_url, 'http://127.0.0.1:48999/', 'the writer\'s own key took the new state');
  assert.equal(after.bitcoind_cookie, join(home, 'c2'));
});

test('the merge: the writer sets its own keys, drops the ones its state no longer gives, keeps every other line', () => {
  const was = ['# owner note', 'roles=verify,custody', 'founding=1', 'fedimintd=/rel/fedimintd', 'auto_update=0', 'my_own=x', ''].join('\n');
  const fresh = 'roles=verify\nport=8470\n';
  const v = parseConf(mergeSeatConf(was, fresh)).values;
  assert.deepEqual(v, { roles: 'verify', auto_update: '0', my_own: 'x', port: '8470' });
  assert.match(mergeSeatConf(was, fresh), /# owner note/);
  assert.equal(mergeSeatConf('', fresh), fresh, 'no file yet: the fresh one as it is');
  assert.equal(mergeSeatConf(null, fresh), fresh);
  // Windows line ends stay Windows line ends
  assert.doesNotMatch(mergeSeatConf('auto_update=0\r\nroles=a\r\n', 'roles=b\r\n').replace(/\r\n/g, ''), /\n/);
});
