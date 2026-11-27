// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3798: "Check my node" - five lines from what the node and three seats say, for the failures seen live: the census naming a dead
// quick tunnel (#3565), a Funnel address no seat reaches (#3723), a node answering in 8-13 s; and all green when all is well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { diagnose, worst, ReachCheckPanel } from '../dist/test/reach-check.mjs';

const NOW = Date.parse('2026-11-26T15:00:00Z');
const NEW = 'https://node7.tail1234.ts.net', OLD = 'https://dead-quick-tunnel.trycloudflare.com';
const reachOf = (url, follow = {}) => ({ ok: true, mode: 'tailscale', url, stable: true, follow: { censusRead: true, bonded: true, advertised: [url], takesBlocks: 12, takesMinutes: 120, ...follow } });
const seat = (i, census, results) => ({ seat: `https://seat${i}.example`, body: { ok: true, census, results } });
const rounds = { rounds: [{ startMs: NOW - 3600000, gameSeated: true }, { startMs: NOW - 7200000, settleSeated: true }] };
const level = (lines, id) => lines.find((l) => l.id === id).level;

test('all well: five green lines, nothing for the Overview', () => {
  const probes = [1, 2, 3].map((i) => seat(i, [NEW], [{ url: NEW, from: ['census', 'announced'], reached: true, ms: 400 + i }]));
  const lines = diagnose({ reach: reachOf(NEW), probes, rounds, nowMs: NOW });
  assert.deepEqual(lines.map((l) => [l.id, l.level]), [['address', 'ok'], ['census', 'ok'], ['reach', 'ok'], ['speed', 'ok'], ['rounds', 'ok']]);
  assert.equal(worst(lines), 'ok');
  assert.match(lines.find((l) => l.id === 'rounds').says, /drawn for 2 rounds/);
});

test('(a) the census still names a dead quick tunnel: red, with the update on its way, or why it was not sent', () => {
  const probes = [1, 2, 3].map((i) => seat(i, [OLD], [{ url: OLD, from: ['census'], reached: false, kind: 'dns', ms: 30 }, { url: NEW, from: ['announced'], reached: true, ms: 600 }]));
  const sent = diagnose({ reach: reachOf(NEW, { advertised: [OLD], update: { endpoint: NEW, txid: 'f'.repeat(64) } }), probes, rounds, nowMs: NOW });
  const c = sent.find((l) => l.id === 'census');
  assert.equal(c.level, 'warn', 'an update on its way: a warning, nothing to do but wait');
  assert.match(c.says, /still sends players to https:\/\/dead-quick-tunnel/);
  assert.match(c.fix, /was sent \(ffffffffffff…\).*12 blocks.*2 hours/);
  assert.match(c.fix, /old address does not answer any more: This address does not exist/);
  assert.equal(level(sent, 'reach'), 'ok', 'the current address is reached');
  const failed = diagnose({ reach: reachOf(NEW, { advertised: [OLD], update: { endpoint: NEW, why: 'not enough coins for the fee' } }), probes, rounds, nowMs: NOW });
  assert.equal(level(failed, 'census'), 'bad');
  assert.match(failed.find((l) => l.id === 'census').fix, /could not be sent: not enough coins for the fee/);
  const never = diagnose({ reach: reachOf(NEW, { advertised: [OLD] }), probes, rounds, nowMs: NOW });
  assert.match(never.find((l) => l.id === 'census').fix, /No update naming your new address has been sent yet/);
  assert.equal(worst(never), 'bad');
});

test('(b) a Funnel address no seat reaches: red, with what to try', () => {
  const probes = [1, 2, 3].map((i) => seat(i, [NEW], [{ url: NEW, from: ['census', 'announced'], reached: false, kind: 'timeout', ms: 8000 }]));
  const lines = diagnose({ reach: reachOf(NEW), probes, rounds: { rounds: [] }, nowMs: NOW });
  const r = lines.find((l) => l.id === 'reach');
  assert.equal(r.level, 'bad'); assert.equal(r.says, '0 of 3 checks from the network reached your node.');
  assert.match(r.fix, /Nothing answered within 8 seconds.*Tailscale Funnel.*Cloudflare/);
  assert.equal(level(lines, 'speed'), 'unknown'); assert.equal(level(lines, 'rounds'), 'warn');
  const gone = diagnose({ reach: reachOf(NEW), probes: [seat(1, [NEW], [{ url: NEW, from: ['census'], reached: false, kind: 'http', status: 530 }])], rounds, nowMs: NOW });
  assert.match(gone.find((l) => l.id === 'reach').fix, /tunnel answers, but your node behind it does not \(error 530\)/);
});

test('(c) a slow node: a warning naming Bitcoin Core; no seat answering is no verdict', () => {
  const probes = [1, 2, 3].map((i) => seat(i, [NEW], [{ url: NEW, from: ['census'], reached: true, ms: 8000 + i * 1000 }]));
  const lines = diagnose({ reach: reachOf(NEW), probes, rounds, nowMs: NOW });
  const s = lines.find((l) => l.id === 'speed');
  assert.equal(s.level, 'warn'); assert.match(s.says, /up to 11\.0 s/); assert.match(s.fix, /Bitcoin Core is busy/);
  assert.equal(worst(lines), 'warn');
  const none = diagnose({ reach: reachOf(NEW), probes: [{ seat: 'x', body: null }, { seat: 'y', body: null }], rounds, nowMs: NOW });
  assert.equal(level(none, 'reach'), 'unknown');
  assert.equal(level(none, 'census'), 'ok', 'the node\'s own census read still says it');
  assert.notEqual(worst(none), 'bad', 'seats that cannot be asked raise no alarm');
});

test('the panel: one button, and each line with its mark and its fix', () => {
  const lines = diagnose({ reach: reachOf(NEW), probes: [seat(1, [NEW], [{ url: NEW, from: ['census'], reached: false, kind: 'timeout' }])], rounds, nowMs: NOW });
  const html = renderToStaticMarkup(React.createElement(ReachCheckPanel, { initial: { lines, atMs: NOW } }));
  assert.match(html, />Check again</);
  assert.match(html, /<li class="rc rc-bad" data-check="reach">/);
  assert.match(html, /Checked at 15:00 UTC/);
  assert.match(renderToStaticMarkup(React.createElement(ReachCheckPanel, {})), />Check my node</);
});
