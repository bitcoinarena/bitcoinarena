// THE NODE'S OWN DEV CLIENTS (kanban #358): set up from the owner page with a new or an imported key, run as children, a withdrawal
// left for the client, removal that keeps the key - and each donation split into the protocol developers' part and its game's part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createDevClients, attributeDonations, slugOf } from '../src/dev-clients.js';
import { newKey, keyFromSecret } from '../../arena-donor/src/donor.js';

const fakeSpawn = () => {
  const started = [];
  const spawn = (bin, args) => { const c = new EventEmitter(); c.pid = 1000 + started.length; c.kill = () => { c.emit('exit', null, 'SIGTERM'); }; started.push({ bin, args, c }); return c; };
  return { spawn, started };
};
const make = (over = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'dev358-'));
  const f = fakeSpawn();
  const d = createDevClients({ root, donorBin: '/x/arena-donor.mjs', nodeBin: '/x/node', keys: { newKey, keyFromSecret }, spawn: f.spawn, restartMs: 10,
    defaults: { wasmPkg: '/x/wasm', seats: ['http://s1', 'http://s2'], invitesFrom: ['https://t/daily.json'], gateways: ['https://gw/'] }, ...over });
  return { root, d, f };
};

test('a new key: its directory, key.json readable by the node only, donor.json from the node\'s knowledge, and the client started', () => {
  const { root, d, f } = make();
  const r = d.setup({ label: 'Dev A' });
  assert.equal(r.ok, true); assert.equal(r.slug, 'dev-a'); assert.equal(r.imported, false);
  const key = JSON.parse(readFileSync(join(root, 'dev-a', 'key.json'), 'utf8'));
  assert.equal(statSync(join(root, 'dev-a', 'key.json')).mode & 0o777, 0o600);
  assert.equal(key.recipientPkHex, r.recipientPk);
  const cfg = JSON.parse(readFileSync(join(root, 'dev-a', 'donor.json'), 'utf8'));
  assert.deepEqual([cfg.seats, cfg.invitesFrom, cfg.gateways, cfg.wasmPkg, cfg.imported, cfg.lnd], [['http://s1', 'http://s2'], ['https://t/daily.json'], ['https://gw/'], '/x/wasm', false, undefined]);
  assert.deepEqual(f.started[0].args, ['/x/arena-donor.mjs', 'loop', join(root, 'dev-a')]);
  assert.equal(d.list()[0].running, true);
});

test('an imported key recovers (imported: true), and a second client on the same key or label is refused', () => {
  const { d } = make();
  const k = newKey();
  const r = d.setup({ label: 'dev b', secretHex: k.secretHex });
  assert.equal(r.ok, true); assert.equal(r.recipientPk, k.recipientPkHex); assert.equal(r.imported, true);
  assert.match(d.setup({ label: 'dev b2', secretHex: k.secretHex }).why, /already has a client/);
  assert.match(d.setup({ label: 'dev b' }).why, /exists/);
  assert.match(d.setup({ label: 'x', secretHex: 'zz' }).why, /64 hex/);
  assert.match(d.setup({ label: '!!!' }).why, /letters and digits/);
});

test('without a lock client the node runs no dev clients and says so', () => {
  const { d } = make({ defaults: {} });
  assert.equal(d.setup({ label: 'a' }).status, 501);
});

test('a withdrawal is left for the client once; an invoice or an address, nothing else', () => {
  const { root, d } = make();
  d.setup({ label: 'a' });
  assert.match(d.withdraw({ slug: 'a' }).why, /invoice or a Lightning address/);
  assert.match(d.withdraw({ slug: 'a', invoice: 'bitcoin:x' }).why, /not a Lightning invoice/);
  assert.match(d.withdraw({ slug: 'a', lnAddress: 'nope' }).why, /name@domain/);
  assert.equal(d.withdraw({ slug: 'zz', invoice: 'lntb1u1pqq' }).status, 404);
  const w = d.withdraw({ slug: 'a', invoice: 'lntb1u1pqq' });
  assert.equal(w.ok, true);
  const q = JSON.parse(readFileSync(join(root, 'a', 'withdraw-request.json'), 'utf8'));
  assert.deepEqual([q.id, q.invoice], [w.id, 'lntb1u1pqq']);
  assert.equal(d.withdraw({ slug: 'a', lnAddress: 'dev@pay.example', msat: '5000' }).status, 409);
  assert.equal(d.list()[0].waiting, true);
  // the client's answer is shown, newest first
  writeFileSync(join(root, 'a', 'state.json'), JSON.stringify({ requests: [{ id: 'old', state: 'Success' }, { id: w.id, state: 'Paying' }] }));
  assert.deepEqual(d.list()[0].requests.map((x) => x.id), [w.id, 'old']);
});

test('removing stops the client and keeps its directory and key; a stopped client is started again', async () => {
  const { root, d, f } = make();
  d.setup({ label: 'a' });
  f.started[0].c.emit('exit', 1, null);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(f.started.length, 2, 'restarted after it stopped on its own');
  const r = d.remove({ slug: 'a' });
  assert.equal(r.ok, true);
  assert.ok(existsSync(join(root, r.kept, 'key.json')));
  assert.deepEqual(d.list(), []);
  await new Promise((r2) => setTimeout(r2, 40));
  assert.equal(f.started.length, 2, 'a removed client is not started again');
  assert.equal(readdirSync(root).length, 1);
});

test('each donation is split p : g between the protocol developers and its game; an unknown round is counted apart', () => {
  const games = { r1: { name: 'nextblock', title: 'Tick Tock', bps: 6667 }, r2: { name: 'rock-paper-scissors', title: 'RPS', bps: 6667 } };
  const s = attributeDonations([{ roundId: 'r1', amountMsat: '1000' }, { roundId: 'r2', amountMsat: '3000' }, { roundId: 'r9', amountMsat: '7' }],
    { protocolBps: 6667, gameOf: (rid) => games[rid] || null });
  assert.equal(s.protocolMsat, '2000');
  assert.deepEqual(s.games.map((g) => [g.game, g.msat, g.donations]), [['nextblock', '500', 1], ['rock-paper-scissors', '1500', 1]]);
  assert.equal(s.unknownMsat, '7');
  // a key only in the game's set: all of it is the game's
  const g = attributeDonations([{ roundId: 'r1', amountMsat: '900' }], { protocolBps: 0, gameOf: () => ({ name: 'nextblock', bps: 5000 }) });
  assert.deepEqual([g.protocolMsat, g.games[0].msat], ['0', '900']);
});

test('labels become directory names', () => {
  assert.equal(slugOf(' Dev A! '), 'dev-a');
  assert.equal(slugOf('../../etc'), 'etc');
});
