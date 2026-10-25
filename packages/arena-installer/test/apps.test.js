// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE APPS STEP (kanban #569, 2026-10-21: "The node still comes with the 3 apps pre installed, that is a step in the installer
// where all apps are automatically selected"): the release's apps read from their app.json, all chosen at first, the choice saved by the
// wizard's door and written into the seat's settings - and an update moving every one of them to the new release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appsIn, appsEnvValue, appsView, chosenApps } from '../src/apps.js';
import { nodeState, seatEnv, nextStep, doneOf, STEPS } from '../src/state.js';
import { createWizard } from '../src/wizard.js';
import { envForRelease } from '../src/update.js';

const RELEASE = resolve(fileURLToPath(import.meta.url), '../../../..');
const reg = (app, ...files) => files.map((f) => join(RELEASE, 'packages', app, 'plugin', f));
const NEXTBLOCK = reg('nextblock', 'nextblock.js', 'nextblock-v2.js', 'nextblock-v3.js', 'nextblock-v4.js', 'nextblock-v5.js', 'nextblock-v6.js');
const RPS = reg('rock-paper-scissors', 'rock-paper-scissors.js', 'rock-paper-scissors-v2.js', 'rock-paper-scissors-v3.js', 'rock-paper-scissors-v4.js', 'rock-paper-scissors-v5.js');
const UPDOWN = reg('btc-updown', 'btc-updown.js', ...Array.from({ length: 23 }, (_, i) => `btc-updown-v${i + 2}.js`));   // app.json lists v2..v24 (v20 since the installer walk of d3b3ddf6: v21's parent)

test('the release\'s apps: Next Block first, then by title, each with every registration it hosts, absolute', () => {
  const apps = appsIn(RELEASE);
  assert.deepEqual(apps.map((a) => [a.id, a.title, a.short, a.registrations.length]), [
    ['nextblock', 'Tick Tock, Next Block', 'Next Block', 6],
    ['btc-updown', 'Bitcoin Up or Down', 'Up or Down', 24],
    ['rock-paper-scissors', 'Rock Paper Scissors', 'Rock Paper Scissors', 5]]);
  assert.deepEqual([apps[0].registrations, apps[1].registrations, apps[2].registrations], [NEXTBLOCK, UPDOWN, RPS]);
  assert.deepEqual(appsView(apps).map((a) => a.versions), [6, 24, 5]);
  assert.deepEqual(appsIn(join(RELEASE, 'none')), [], 'no release folder: no apps');
});

test('ARENA_APPS: the chosen apps\' registrations, comma-joined; an unknown app refused by name; all chosen when none was saved', () => {
  assert.equal(appsEnvValue(RELEASE, ['rock-paper-scissors', 'nextblock']), [...NEXTBLOCK, ...RPS].join(','));
  assert.equal(appsEnvValue(RELEASE, ['nextblock', 'btc-updown', 'rock-paper-scissors']).split(',').length, 35);   // (v20 back in the Up/Down app's list, Next Block's v6 in its own)
  assert.throws(() => appsEnvValue(RELEASE, ['nextblock', 'chess']), /no app chess in this release/);
  const apps = appsIn(RELEASE);
  assert.deepEqual(chosenApps({}, apps), ['nextblock', 'btc-updown', 'rock-paper-scissors']);
  assert.deepEqual(chosenApps({ apps: ['btc-updown'] }, apps), ['btc-updown']);
});

test('seatEnv: the saved choice; every app with none saved (an older state); Next Block alone for a release without app.json', () => {
  const s = { port: 8470, roles: ['verify'], chain: { kind: 'core', url: 'http://x/' } };
  const appsLine = (env) => env.split('\n').find((l) => l.startsWith('ARENA_APPS=')).slice('ARENA_APPS='.length);
  assert.equal(appsLine(seatEnv({ ...s, apps: ['btc-updown'] }, { home: '/h', release: RELEASE })), UPDOWN.join(','));
  assert.equal(appsLine(seatEnv(s, { home: '/h', release: RELEASE })), [...NEXTBLOCK, ...UPDOWN, ...RPS].join(','));
  assert.equal(appsLine(seatEnv({ ...s, apps: ['chess'] }, { home: '/h', release: RELEASE })), [...NEXTBLOCK, ...UPDOWN, ...RPS].join(','), 'an app the release no longer carries is left out');
  assert.equal(appsLine(seatEnv(s, { home: '/h', release: '/opt/arena' })), '/opt/arena/packages/nextblock/plugin/nextblock.js');
});

test('the step: after the roles; a state from before it that is past the seed does not go back to it', () => {
  assert.deepEqual(STEPS.slice(0, 5), ['start', 'chain', 'roles', 'apps', 'seed']);
  assert.equal(nextStep({ done: { chain: 1, roles: 2 } }), 'apps');
  assert.equal(nextStep({ done: { chain: 1, roles: 2, apps: 3 } }), 'seed');
  assert.equal(nextStep({ done: { chain: 1, roles: 2, seed: 3, owner: 4 } }), 'reach', 'an older state, mid-install');
  assert.equal(doneOf({ done: { seed: 3 } }).apps, 3);
});

test('the door: the release\'s apps in the state, all on; at least one, no unknown app; the choice saved and the step done', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-apps-'));
  const state = nodeState(home);
  state.save({ chain: { kind: 'core', url: 'http://x/' }, roles: ['verify'], done: { chain: 1, roles: 2 } });
  const w = createWizard({ state, release: RELEASE, seatPort: 1 });
  const server = http.createServer((q, s) => w.handle(q, s));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
  const port = server.address().port; let cookie = '';
  const go = (method, path, body) => new Promise((ok) => {
    const q = http.request({ host: '127.0.0.1', port, method, path, headers: { cookie, 'x-arena-wizard': '1', 'content-type': 'application/json' } }, (r) => {
      if (r.headers['set-cookie']) cookie = r.headers['set-cookie'][0].split(';')[0];
      let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { try { ok(JSON.parse(b)); } catch { ok(null); } });
    });
    if (body) q.write(JSON.stringify(body)); q.end();
  });
  await go('GET', `/?t=${w.token}`);
  const s = await go('GET', '/api/state');
  assert.equal(s.step, 'apps');
  assert.deepEqual(s.appInfo, [
    { id: 'nextblock', title: 'Tick Tock, Next Block', short: 'Next Block', versions: 6 },
    { id: 'btc-updown', title: 'Bitcoin Up or Down', short: 'Up or Down', versions: 24 },
    { id: 'rock-paper-scissors', title: 'Rock Paper Scissors', short: 'Rock Paper Scissors', versions: 5 }]);
  assert.deepEqual(s.apps, ['nextblock', 'btc-updown', 'rock-paper-scissors'], 'all chosen at first');
  assert.deepEqual(await go('POST', '/api/apps', { apps: [] }), { ok: false, why: 'choose at least one app: Next Block, Up or Down, Rock Paper Scissors' });
  assert.deepEqual(await go('POST', '/api/apps', { apps: ['nextblock', 'chess'] }), { ok: false, why: 'no app chess in this release' });
  assert.equal(state.read().done.apps, undefined, 'nothing saved on a refusal');
  const saved = await go('POST', '/api/apps', { apps: ['rock-paper-scissors', 'nextblock', 'nextblock'] });
  assert.deepEqual([saved.ok, saved.apps], [true, ['rock-paper-scissors', 'nextblock']]);
  // the games its bond names: every version of the chosen apps, sorted (2026-10-25: "the newest versions of games")
  assert.equal(saved.hostedGames.length, 11, 'Next Block 6 versions + Rock Paper Scissors 5');
  assert.deepEqual(saved.hostedGames, [...saved.hostedGames].sort());
  assert.deepEqual(state.read().apps, ['rock-paper-scissors', 'nextblock']);
  const after = await go('GET', '/api/state');
  assert.deepEqual([after.step, after.apps, Boolean(after.done.apps)], ['seed', ['rock-paper-scissors', 'nextblock'], true]);
});

test('an update moves every app registration to the new release, not only the last one', () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-apps-up-'));
  try {
    const v1 = join(root, 'arena-node-2026.1.0-linux-x64'), v2 = join(root, 'arena-node-2026.1.1-linux-x64');
    const files = ['packages/nextblock/plugin/nextblock.js', 'packages/nextblock/plugin/nextblock-v2.js', 'packages/rock-paper-scissors/plugin/rock-paper-scissors.js'];
    for (const f of files) { mkdirSync(join(v2, f, '..'), { recursive: true }); writeFileSync(join(v2, f), ''); }
    const conf = `roles=verify,settlement\napps=${files.map((f) => join(v1, f)).join(',')}\nport=8470\n`;
    assert.equal(envForRelease(conf, v2), `roles=verify,settlement\napps=${files.map((f) => join(v2, f)).join(',')}\nport=8470\n`);
    assert.equal(envForRelease(`apps=${join(v1, files[0])},${join(v1, 'packages/gone/plugin/gone.js')}\r\n`, v2),
      `apps=${join(v2, files[0])},${join(v1, 'packages/gone/plugin/gone.js')}\r\n`, 'a path the new release does not carry stays as it was');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
