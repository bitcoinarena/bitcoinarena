// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S OWN DEV CLIENTS (kanban #358): set up from the owner page with a new or an imported key, run as children, a withdrawal
// left for the client, removal that keeps the key - and each donation split into the protocol developers' part and its game's part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createDevClients, attributeDonations, devEarnings, slugOf } from '../src/dev-clients.js';
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

test('a dev key\'s earnings by period: today, this week from Monday, this month, this year, all time, and day by day (kanban #382)', () => {
  // Thursday 2026-10-15 12:00Z; the week began Monday 10-12
  const nowMs = Date.UTC(2026, 9, 15, 12);
  const at = (y, m, d, h = 10) => Date.UTC(y, m - 1, d, h);
  const rows = [
    { roundId: 'tt', amountMsat: '3000', verifiedMs: at(2026, 10, 15) },   // today
    { roundId: 'tt', amountMsat: '3000', verifiedMs: at(2026, 10, 12, 0) }, // Monday: this week
    { roundId: 'rps', amountMsat: '1000', verifiedMs: at(2026, 10, 11) },  // Sunday: last week, this month
    { roundId: 'tt', amountMsat: '3000', verifiedMs: at(2026, 9, 30) },    // September: this year
    { roundId: 'tt', amountMsat: '3000', verifiedMs: at(2025, 12, 31) },   // last year
    { roundId: 'gone', amountMsat: '500', verifiedMs: at(2026, 10, 15) },  // a round this node no longer holds
  ];
  const games = { tt: { name: 'nextblock', title: 'Tick Tock', bps: 3333 }, rps: { name: 'rock-paper-scissors', title: 'RPS', bps: 10000 } };
  const e = devEarnings(rows, { protocolBps: 6667, gameOf: (r) => games[r] || null, nowMs, days: 7 });
  const part = (k) => ({ p: e.periods[k].protocolMsat, tt: (e.periods[k].games.find((g) => g.game === 'nextblock') || {}).msat || '0',
    rps: (e.periods[k].games.find((g) => g.game === 'rock-paper-scissors') || {}).msat || '0', u: e.periods[k].unknownMsat, t: e.periods[k].totalMsat });
  // 3000 split 6667 : 3333 -> 2000 protocol, 1000 game; 1000 for RPS split 6667 : 10000 -> 400 protocol, 600 game
  assert.deepEqual(part('day'), { p: '2000', tt: '1000', rps: '0', u: '500', t: '3500' });
  assert.deepEqual(part('week'), { p: '4000', tt: '2000', rps: '0', u: '500', t: '6500' });
  assert.deepEqual(part('month'), { p: '4400', tt: '2000', rps: '600', u: '500', t: '7500' });
  assert.deepEqual(part('year'), { p: '6400', tt: '3000', rps: '600', u: '500', t: '10500' });
  assert.deepEqual(part('all'), { p: '8400', tt: '4000', rps: '600', u: '500', t: '13500' });
  assert.deepEqual(e.days.map((d) => d.day), ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']);
  assert.deepEqual(e.days.map((d) => d.totalMsat), ['0', '0', '1000', '3000', '0', '0', '3500']);
});
