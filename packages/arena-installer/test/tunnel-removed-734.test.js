// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A WAY TO BE REACHED THAT RUNS NO TUNNEL TAKES THE OLD ONE AWAY, AND FUNNEL IS NAMED AS FUNNEL (kanban #734, measured 2026-10-29 on the VM's
// arena-vm-734: reach moved from a quick tunnel to Tailscale Funnel, arena-tunnel--3 kept running beside it, and the owner page showed the
// Funnel address under "Tunnel (cloudflared)").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installService, LAUNCHD_LABEL, unitDir, TUNNEL_UNIT } from '../src/service.js';
import { tunnelArgsOf } from '../src/reach.js';
import { overview } from '../src/node-services.js';

const healthy = async () => new Response(Buffer.from('ab'.repeat(32), 'hex'), { status: 200 });
const sh = async () => ({ ok: true, out: '', err: '' });

test('Linux: Install and start with no tunnel removes the tunnel unit a quick tunnel left', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arena-734-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'cfg'), USER: 'arena' };
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const unit = join(unitDir(env), TUNNEL_UNIT);
  await installService({ platform: 'linux', node: '/r/runtime/node', release: '/r', home, port: 8470, tunnel: '[Unit]\nDescription=quick tunnel\n', env, sh, fetcher: healthy, waitMs: 2000 });
  assert.equal(existsSync(unit), true, 'the quick tunnel\'s unit is written');
  const r = await installService({ platform: 'linux', node: '/r/runtime/node', release: '/r', home, port: 8470, tunnel: null, env, sh, fetcher: healthy, waitMs: 2000 });
  assert.equal(r.ok, true, r.why);
  assert.equal(existsSync(unit), false, 'Funnel or direct: the tunnel unit is gone');
});

test('macOS: the same for the tunnel agent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arena-734-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const agent = join(root, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.tunnel.plist`);
  await installService({ platform: 'darwin', node: '/r/runtime/node', release: '/r', home, port: 8470, tunnelArgs: tunnelArgsOf({ bin: '/r/runtime/cloudflared', mode: 'quick', port: 8470 }),
    env: { HOME: root }, sh, fetcher: healthy, waitMs: 2000 });
  assert.equal(existsSync(agent), true);
  await installService({ platform: 'darwin', node: '/r/runtime/node', release: '/r', home, port: 8470, tunnelArgs: null, env: { HOME: root }, sh, fetcher: healthy, waitMs: 2000 });
  assert.equal(existsSync(agent), false, 'the tunnel agent is gone');
});

test('a node reached by Tailscale Funnel lists it as "Tailscale Funnel", answering as the node; a quick-tunnel node does not', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arena-734-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'cfg') };
  const key = 'ab'.repeat(32);
  const fetcher = async () => new Response(Buffer.from(key, 'hex'), { status: 200 });
  const at = (mode, url) => {
    writeFileSync(join(home, 'arena.conf'), `port=8470\npublic_url=${url}\n`);
    writeFileSync(join(home, 'state.json'), JSON.stringify({ reach: { mode, port: 8470, url } }));
  };
  at('tailscale', 'https://arena-vm-734.example.com');
  const v = await overview({ home, platform: 'linux', env, sh, fetcher, dnsPauseMs: 1 });
  const row = v.services.find((s) => s.id === 'funnel');
  assert.ok(row, 'a row for Funnel');
  assert.equal(row.title, 'Tailscale Funnel');
  assert.equal(row.running, true);
  assert.equal(row.detail, 'https://arena-vm-734.example.com reaches this node');
  assert.equal(v.services.some((s) => s.title === 'Tunnel (cloudflared)'), false, 'no cloudflared row: no tunnel unit');
  at('quick', 'https://x.trycloudflare.com');
  assert.equal((await overview({ home, platform: 'linux', env, sh, fetcher, dnsPauseMs: 1 })).services.some((s) => s.id === 'funnel'), false);
});
