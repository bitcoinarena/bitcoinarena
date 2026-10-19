// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PERMANENT NAME THROUGH TAILSCALE FUNNEL (2026-10-18: "add Tailscale funnel support so permanent tunnel with
// Tailscale"): the machine's tailnet name, the first Funnel port not serving something else, `tailscale funnel --bg` to the node's
// port - kept by tailscaled, so the node runs no tunnel service of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tailscaleFunnel, tunnelMode, REACH_MODES } from '../src/reach.js';
import { servicesOf } from '../src/launchers.js';
import { seatEnv } from '../src/state.js';

const status = (o = {}) => JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'my-pc.tail1234.ts.net.' }, ...o });
const fake = ({ st = status(), web = {}, funnelOk = true } = {}) => {
  const calls = [];
  const sh = async (bin, args) => {
    calls.push([bin, ...args].join(' '));
    if (args[0] === 'status') return { ok: true, out: st, err: '' };
    if (args[0] === 'funnel' && args[1] === 'status') return { ok: true, out: JSON.stringify({ Web: web }), err: '' };
    if (args[0] === 'funnel') return funnelOk ? { ok: true, out: '', err: '' } : { ok: false, out: '', err: 'Funnel not available; to enable, visit https://login.tailscale.com/f/funnel?node=x' };
    return { ok: false, out: '', err: 'unknown' };
  };
  return { sh, calls };
};

test('Funnel: the tailnet name and a free port; a port serving something else is left alone; a port already ours is kept', async () => {
  let f = fake();
  let r = await tailscaleFunnel({ port: 8470, sh: f.sh });
  assert.deepEqual([r.ok, r.url, r.httpsPort], [true, 'https://my-pc.tail1234.ts.net', 443]);
  assert.ok(f.calls.includes('tailscale funnel --bg --https=443 http://127.0.0.1:8470'));

  f = fake({ web: { 'my-pc.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } });
  r = await tailscaleFunnel({ port: 8470, sh: f.sh });
  assert.deepEqual([r.url, r.httpsPort], ['https://my-pc.tail1234.ts.net:8443', 8443], ':443 serves another app: it is not touched');
  assert.ok(!f.calls.some((c) => c.includes('--https=443')));

  f = fake({ web: { 'my-pc.tail1234.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8470' } } } } });
  r = await tailscaleFunnel({ port: 8470, sh: f.sh });
  assert.deepEqual([r.url, f.calls.some((c) => c.includes('--bg'))], ['https://my-pc.tail1234.ts.net:10000', false], 'already funnelled to this node: kept, nothing run');
});

test('Funnel refuses with a reason: not installed, not logged in, no name, not allowed, no free port', async () => {
  const missing = async () => ({ ok: false, code: 'ENOENT', out: '', err: '' });
  assert.match((await tailscaleFunnel({ port: 1, sh: missing })).why, /not installed.*tailscale up/);
  assert.match((await tailscaleFunnel({ port: 1, sh: fake({ st: status({ BackendState: 'NeedsLogin' }) }).sh })).why, /NeedsLogin.*tailscale up/);
  assert.match((await tailscaleFunnel({ port: 1, sh: fake({ st: status({ Self: { DNSName: '' } }) }).sh })).why, /MagicDNS/);
  assert.match((await tailscaleFunnel({ port: 1, sh: fake({ funnelOk: false }).sh })).why, /access controls.*login\.tailscale\.com/);
  const busy = Object.fromEntries([443, 8443, 10000].map((p) => [`my-pc.tail1234.ts.net:${p}`, { Handlers: { '/': { Proxy: 'http://127.0.0.1:9' } } }]));
  assert.match((await tailscaleFunnel({ port: 1, sh: fake({ web: busy }).sh })).why, /every Funnel port/);
});

test('a Funnel node runs no tunnel service and listens on 127.0.0.1 only', () => {
  assert.ok(REACH_MODES.includes('tailscale'));
  assert.deepEqual(['direct', 'permanent', 'quick', 'tailscale'].map(tunnelMode), [false, true, true, false]);
  const s = { reach: { mode: 'tailscale', url: 'https://my-pc.tail1234.ts.net' } };
  assert.deepEqual(servicesOf(s).linux, ['arena-node.service'], 'no arena-tunnel');
  assert.match(seatEnv({ ...s, port: 8470, roles: ['verify'], chain: { kind: 'core', url: 'http://x/' } }, { home: '/h', release: '/r' }), /ARENA_BIND=127\.0\.0\.1/);
});
