// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3890 (#3723: a Tailscale Funnel name on the Tokyo ingress timed out from every seat in Europe): each seat's /reach-probe answer names
// its region; the outside check asks five seats and says plainly which region cannot reach the address, with another route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatRegion, createReachProbe } from '../src/reach-probe.js';
import { outsideCheck, regionText, CHECK_SEATS_MOST } from '../src/address-check.js';

const NODE = 'ab'.repeat(32);

test('seatRegion: ARENA_REGION as set, else the time zone\'s first part; nothing odd passes', () => {
  assert.equal(seatRegion({ ARENA_REGION: 'eu-central' }, 'Asia/Tokyo'), 'eu-central');
  assert.equal(seatRegion({}, 'Europe/Berlin'), 'Europe');
  assert.equal(seatRegion({}, 'America/New_York'), 'America');
  assert.equal(seatRegion({}, 'UTC'), null);
  assert.equal(seatRegion({ ARENA_REGION: '<script>' }, 'Europe/Berlin'), null);
});

test('the door\'s answer names the region', async () => {
  const door = createReachProbe({ targetsOf: () => ({ census: ['https://a.example.org'], announced: null }), probe: async () => ({ reached: true, ms: 5 }), region: 'Asia' });
  const r = await door({ headers: {}, socket: { remoteAddress: '198.51.100.7' } }, NODE);
  assert.equal(r.status, 200); assert.equal(r.body.region, 'Asia');
});

test('the outside check: five seats; reached from Asia, not from Europe - said, with the Funnel advice', async () => {
  assert.equal(CHECK_SEATS_MOST, 5);
  const url = 'https://op.tail1234.ts.net';
  const region = { 'https://s1': 'Asia', 'https://s2': 'Asia', 'https://s3': 'Europe', 'https://s4': 'Europe', 'https://s5': 'America' };
  const fetchFn = async (u) => { const seat = u.slice(0, u.indexOf('/reach-probe')); const ok = region[seat] !== 'Europe';
    return new Response(JSON.stringify({ ok: true, node: NODE, region: region[seat], results: [{ url, from: ['announced'], reached: ok, ...(ok ? { ms: 300 } : { kind: 'timeout' }) }] })); };
  const c = await outsideCheck({ url, node: NODE, seats: Object.keys(region), fetchFn });
  assert.equal(c.ok, false);
  assert.match(c.why, /2 of 5 seats could not reach .*nothing answered in time\. Reached from Asia, America, not from Europe\. A Tailscale Funnel name is served from one region's ingress/);
  assert.equal(regionText([{ reached: true, region: 'Asia' }, { reached: false, region: 'Asia' }]), '', 'one region both ways: no split');
});
