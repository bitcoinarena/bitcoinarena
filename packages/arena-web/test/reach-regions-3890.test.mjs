// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3890: Check my node asks five seats; reached from one region and not from another is said plainly, with another route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, regionsOf, ASK_SEATS } from '../dist/test/reach-check.mjs';

const NODE_URL = 'https://op.tail1234.ts.net';
const reach = { ok: true, url: NODE_URL, follow: { censusRead: true, advertised: [NODE_URL], bonded: true } };
const probe = (seat, region, reached) => ({ seat, body: { ok: true, census: [NODE_URL], region, results: [{ url: NODE_URL, from: ['census'], reached, ...(reached ? { ms: 400 } : { kind: 'timeout' }) }] } });

test('reached from Asia and America, not from Europe: a warning naming Europe and the Funnel advice', () => {
  assert.equal(ASK_SEATS, 5);
  const lines = diagnose({ reach, probes: [probe('a', 'Asia', true), probe('b', 'Asia', true), probe('c', 'America', true), probe('d', 'Europe', false), probe('e', 'Europe', false)] });
  const r = lines.find((l) => l.id === 'reach');
  assert.equal(r.level, 'warn');
  assert.match(r.says, /3 of 5 checks reached your node: from Asia, America, not from Europe/);
  assert.match(r.fix, /Players and nodes in Europe cannot reach your node\. A Tailscale Funnel name is served from one region's ingress/);
  const most = diagnose({ reach, probes: [probe('a', 'Asia', true), probe('d', 'Europe', false), probe('e', 'Europe', false)] }).find((l) => l.id === 'reach');
  assert.equal(most.level, 'bad');
  const all = diagnose({ reach, probes: [probe('a', 'Asia', true), probe('d', 'Europe', true)] }).find((l) => l.id === 'reach');
  assert.equal(all.level, 'ok'); assert.equal(regionsOf([{ region: 'Asia', reached: true }, { region: null, reached: false }]), null);
});
