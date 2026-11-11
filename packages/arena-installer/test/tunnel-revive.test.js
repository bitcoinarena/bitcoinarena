// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DEAD QUICK TUNNEL IS RESTARTED (kanban #1120, measured 2026-11-04 on an installer node, 2026.1.9.24): cloudflared said "Tunnel not
// found" 7,924 times over 42 h and never asked for a new name, so the node could send but not be reached and broke the seatings of the
// live rounds it was drawn into. The custody agent now restarts the tunnel when its log says so; the next pass follows the new name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { quickTunnelDead, reviveDeadTunnel, TUNNEL_DEAD_ERRORS } from '../src/node-services.js';
import { createCustodyAgent } from '../src/custody-agent.js';
import { nodeState } from '../src/state.js';

// the lines as cloudflared 2026.x writes them (the installer node's tunnel.log)
const REG = '2026-11-02T03:30:01Z INF Registered tunnel connection connIndex=0 connection=6cecb162 event=0 ip=198.41.200.73 location=ams01 protocol=quic';
const GONE = '2026-11-02T16:45:26Z ERR Register tunnel error from server side error="Unauthorized: Tunnel not found" connIndex=0 event=0 ip=198.41.200.193';
const ASK = '2026-11-04T10:53:03Z INF Requesting new quick Tunnel on trycloudflare.com...';

test('a tunnel is dead after enough "Tunnel not found" lines since its last registered connection, and alive again once it asks for a new name', () => {
  assert.equal(quickTunnelDead([REG, ...Array(TUNNEL_DEAD_ERRORS - 1).fill(GONE)].join('\n')), false, 'fewer: not yet');
  assert.equal(quickTunnelDead([REG, ...Array(TUNNEL_DEAD_ERRORS).fill(GONE)].join('\n')), true, 'the 11-02 log: dead');
  assert.equal(quickTunnelDead([...Array(10).fill(GONE), REG].join('\n')), false, 'a connection registered after the errors: alive');
  assert.equal(quickTunnelDead([...Array(10).fill(GONE), ASK].join('\n')), false, 'restarted, asking for a new name: not dead yet');
  assert.equal(quickTunnelDead(''), false);
});

test('a node with no quick tunnel, or no tunnel log, is never restarted', async () => {
  const home = mkdtempSync(join(tmpdir(), 'revive-'));
  nodeState(home).save({ roles: ['verify'], reach: { mode: 'permanent', url: 'https://node.example.com' } });
  writeFileSync(join(home, 'tunnel.log'), Array(10).fill(GONE).join('\n'));
  assert.deepEqual(await reviveDeadTunnel({ home, sh: async () => { throw new Error('nothing may run'); } }), { dead: false });
  const quick = mkdtempSync(join(tmpdir(), 'revive-q-'));
  nodeState(quick).save({ roles: ['verify'], reach: { mode: 'quick', url: 'https://egg-gale-kerry-mustang.trycloudflare.com', port: 8770 } });
  assert.deepEqual(await reviveDeadTunnel({ home: quick, sh: async () => { throw new Error('nothing may run'); } }), { dead: false }, 'no tunnel.log');
});

test('the custody agent restarts a dead tunnel before it follows a name, and follows the new name on its next pass', async () => {
  const home = mkdtempSync(join(tmpdir(), 'custody-revive-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(new Uint8Array(32).fill(7)); db.close();
  state.save({ roles: ['verify', 'custody'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'quick', url: 'https://egg-gale-kerry-mustang.trycloudflare.com', port: 8770 },
    bond: { txid: '78'.repeat(32), vout: 0, sats: '50000', maturity: 157441 } });
  let dead = true, revived = 0, followed = 0;
  const reviveTunnel = async () => { if (!dead) return { dead: false }; dead = false; revived++; return { dead: true, restarted: true }; };
  const followTunnel = async () => { followed++; return followed === 1 ? { url: 'https://colors-marvel-mambo-gerald.trycloudflare.com', restarted: ['gateway', 'node'] } : { url: null, restarted: [] }; };
  const logs = [];
  const agent = createCustodyAgent({ state, release: home, chainKit: { coinsOf: async () => ({ tip: 157190, coins: [] }), broadcast: async () => 'aa'.repeat(32) }, reviveTunnel, followTunnel, log: (m) => logs.push(m),
    gw: { joinFederation: async () => ({ ok: false }), testGateway: async () => ({ ok: false }), depositAddress: async () => ({ ok: false }) },
    channels: async () => ({ ok: true, open: [], pending: [] }), lndInfo: async () => ({ ok: false }), ringMembers: async () => [] });
  const first = await agent.tick();
  assert.deepEqual([first.ok, first.did, followed], [true, 'tunnel-revive', 0], 'restarted, nothing followed yet');
  assert.match(logs.join('\n'), /the quick tunnel was dead \(Tunnel not found\): restarted for a new name/);
  const second = await agent.tick();
  assert.deepEqual([second.did, second.url, second.restarted, revived], ['tunnel-name', 'https://colors-marvel-mambo-gerald.trycloudflare.com', ['gateway', 'node'], 1]);
});

test('on Linux the dead tunnel is read from the journal, not tunnel.log (the 2026.1.9.25 install test: no tunnel.log there)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'revive-linux-'));
  nodeState(home).save({ roles: ['verify'], reach: { mode: 'quick', url: 'https://egg-gale-kerry-mustang.trycloudflare.com', port: 8770 } });
  const asked = [];
  const sh = async (cmd, args) => { asked.push([cmd, ...args].join(' ')); return { ok: true, out: [REG, ...Array(TUNNEL_DEAD_ERRORS).fill(GONE)].join('\n') }; };
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  const r = await reviveDeadTunnel({ home, platform: 'linux', env, sh });
  assert.equal(r.dead, true, 'the journal says Tunnel not found: dead');
  assert.match(asked[0] || '', /^journalctl --user -u \S+ -o cat --no-pager -n 300$/);
  const alive = await reviveDeadTunnel({ home, platform: 'linux', env, sh: async () => ({ ok: true, out: [GONE, GONE, GONE, REG].join('\n') }) });
  assert.deepEqual(alive, { dead: false }, 'registered after the errors: alive');
});
