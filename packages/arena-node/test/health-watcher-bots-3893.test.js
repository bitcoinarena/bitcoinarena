// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3893: the health watcher checks the testnet LNDs and the test bots' top-ups and alerts (chat + Signal) at most hourly when a bot
// cannot top up. Measured 2026-11-27: LND A/B down from 06:07Z, the opponent bot's top-ups failed for ten hours, nobody was told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, pass } from '../tools/health-watcher.mjs';
import { botsConfig, botProblems, signalSend } from '../tools/health-watcher-bots.mjs';

const NOW = Date.UTC(2026, 10, 27, 16, 40, 0);
const iso = (ms) => new Date(ms).toISOString();
const BC = botsConfig({ HW_BOTS: 'opp=bot@192.0.2.18:m808/bot926/opp/bot/balance.json', HW_SIGNAL_TO_FILE: '/x/to' });

test('config: the LND units and the bots from the environment', () => {
  assert.deepEqual(BC.lnds, ['lnd-testnet.service', 'lnd-testnet4-b.service', 'arena-gw-c-lnd.service']);
  assert.deepEqual(BC.bots, [{ name: 'opp', host: 'bot@192.0.2.18', path: 'm808/bot926/opp/bot/balance.json' }]);
  assert.equal(botsConfig({ HW_TESTNET_LNDS: '' }).lnds.length, 0);
});

const body = (o) => ({ at: iso(NOW - 20000), belowSat: 3000, balanceMsat: { '337ae01a': '0' }, gateways: ['a', 'b', 'c'], lastOk: null, lastFail: null, ...o });
const CFG = { confirm: 2 };

test('a bot below its threshold whose top-ups fail: an alert only after HW_BOT_FAIL_MIN; a success clears it', () => {
  const st = {}, bf = (b) => ({ lnds: {}, bots: [{ name: 'opp', ok: true, body: b }] });
  const failing = body({ lastFail: { at: iso(NOW - 60000), why: 'gw-a invoice: Failed to connect to gateway; gw-b invoice: Failed to connect to gateway; gw-c faucet: that invoice cannot be read' } });
  assert.equal(botProblems(bf(failing), st, BC, CFG, NOW).length, 0, 'the first failure: not yet');
  const later = body({ at: iso(NOW + 11 * 60000), lastFail: { at: iso(NOW + 10.5 * 60000), why: 'same' } });
  const p = botProblems(bf(later), st, BC, CFG, NOW + 11 * 60000);
  assert.equal(p.length, 1); assert.equal(p[0].key, 'bot-topup:opp'); assert.equal(p[0].alert, true);
  assert.match(p[0].title, /cannot top up \(failing since 16:39 UTC\)/);
  assert.match(p[0].lines[0], /337ae01a: 0 sat \(below 3000\)/);
  const fixed = body({ at: iso(NOW + 12 * 60000), balanceMsat: { '337ae01a': '6000000' }, lastOk: { at: iso(NOW + 11.5 * 60000) }, lastFail: { at: iso(NOW + 10.5 * 60000) } });
  assert.equal(botProblems(bf(fixed), st, BC, CFG, NOW + 12 * 60000).length, 0);
  assert.equal(st['bot-fail-since:opp'], undefined);
  // above the threshold, a failed early top-up is no alert
  assert.equal(botProblems(bf(body({ balanceMsat: { x: '3500000' }, lastFail: { at: iso(NOW - 30 * 60000) } })), {}, BC, CFG, NOW).length, 0);
});

test('a stale or unreadable balance file: bot-stale', () => {
  const p = botProblems({ lnds: {}, bots: [{ name: 'opp', ok: true, body: body({ at: iso(NOW - 20 * 60000) }) }, { name: 'h', ok: false, why: 'ssh: timeout' }] }, {}, BC, CFG, NOW);
  assert.deepEqual(p.map((x) => x.key), ['bot-stale:opp', 'bot-stale:h']);
});

test('a testnet LND down: alert on the second pass in a row; up again clears the count', () => {
  const st = {}, down = { lnds: { 'lnd-testnet.service': { active: 'inactive', sub: 'dead' }, 'lnd-testnet4-b.service': { active: 'active' } }, bots: [] };
  assert.equal(botProblems(down, st, BC, CFG, NOW)[0].alert, false);
  const p = botProblems(down, st, BC, CFG, NOW);
  assert.equal(p.length, 1); assert.equal(p[0].key, 'lnd-down:lnd-testnet'); assert.equal(p[0].alert, true);
  assert.equal(botProblems({ lnds: { 'lnd-testnet.service': { active: 'active' } }, bots: [] }, st, BC, CFG, NOW).length, 0);
  assert.equal(st['lnd-down:lnd-testnet'], undefined);
});

test('signalSend: the number from its file, signal-cli JSON-RPC send', async () => {
  let got = null;
  await signalSend(BC, 'hello', { readFile: () => '+10000000000\n', fetchImpl: async (url, o) => { got = { url, body: JSON.parse(o.body) }; return { ok: true, json: async () => ({ result: {} }) }; } });
  assert.equal(got.url, 'http://127.0.0.1:8080/api/v1/rpc');
  assert.deepEqual(got.body.params, { recipient: ['+10000000000'], message: 'hello' });
  await assert.rejects(signalSend(botsConfig({}), 'x', { readFile: () => '' }), /HW_SIGNAL_TO_FILE/);
});

// the whole pass: a fake world with every seat healthy, the bot failing; chat and Signal once, again only after an hour, then resolved
test('pass: one alert to chat and Signal, at most hourly, resolved when the bot tops up again', async () => {
  const cfg = config({ HW_STATE: '/nonexistent/hw.json', HW_BEELINK_SEATS: '', HW_MAC_SEATS: '', HW_LIST_SEATS: '', HW_DUTY_SEATS: '', HW_PENDING_SEATS: '', HW_PUB_CHAINS: '',
    HW_BOTS: 'opp=-:/x/balance.json', HW_SIGNAL_TO_FILE: '/x/to', HW_TESTNET_LNDS: 'lnd-testnet' }, []);
  const w = { now: NOW, posts: [], signals: [], file: body({ lastFail: { at: iso(NOW - 11 * 60000), why: 'all gateways failed' } }) };
  const io = { now: () => w.now, loadavg: async () => [1, 1, 1], identity: async () => ({ ok: false }), get: async () => ({ ok: false, why: 'none' }),
    units: async (u) => Object.fromEntries(u.map((x) => [x, { active: 'active', sub: 'running' }])), minercCheck: async () => null,
    readBotFile: async () => JSON.stringify({ ...w.file, at: iso(w.now - 10000) }), post: async (t) => { w.posts.push(t); }, signal: async (t) => { w.signals.push(t); } };
  let st = {};
  const step = async () => { const r = await pass(io, cfg, st); st = r.state; w.now += 180000; return r; };
  const r1 = await step();
  assert.ok(r1.problems.some((p) => p.key === 'bot-topup:opp'));
  assert.equal(w.signals.length, 1); assert.match(w.signals[0], /#3893 .*PROBLEM: opp bot cannot top up/);
  assert.equal(w.posts.filter((t) => /opp bot/.test(t)).length, 1);
  for (let i = 0; i < 10; i++) await step();   // 30 min more: no repeat
  assert.equal(w.signals.length, 1);
  for (let i = 0; i < 10; i++) await step();   // past the hour: STILL once
  assert.equal(w.signals.length, 2); assert.match(w.signals[1], /STILL/);
  w.file = body({ balanceMsat: { '337ae01a': '6000000' }, lastOk: { at: iso(w.now) }, lastFail: { at: iso(NOW) } });
  await step(); await step();
  assert.equal(w.signals.length, 3); assert.match(w.signals[2], /RESOLVED: opp bot cannot top up/);
});
