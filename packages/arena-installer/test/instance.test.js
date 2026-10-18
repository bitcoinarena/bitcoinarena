// SEVERAL NODES ON ONE MACHINE (kanban #495): ARENA_INSTANCE names a second node's services apart, ARENA_PORT_OFFSET moves its fixed
// ports; neither set, everything as before. The values are read when the installer starts, so each case runs in its own process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
  const [s, l, g, t, r, st] = await Promise.all(['service', 'lnd', 'gateway', 'tor', 'reach', 'state'].map((m) => import('./src/' + m + '.js')));
  console.log(JSON.stringify({ unit: s.UNIT, bridge: s.BRIDGE_UNIT, tunnel: s.TUNNEL_UNIT, lndUnit: s.unitName('lnd'), label: s.LAUNCHD_LABEL, task: s.WINDOWS_TASK,
    lnd: l.LND_PORTS, gateway: g.GATEWAY_PORT, tor: t.TOR_PORTS, seat: r.DEFAULT_NODE_PORT, liquidity: st.LIQUIDITY_PROVIDER_PORT }));`],
  { cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }));

test('one node: the names and ports as always', () => {
  assert.deepEqual(read({}), { unit: 'arena-node.service', bridge: 'arena-chain-bridge.service', tunnel: 'arena-tunnel.service', lndUnit: 'arena-lnd.service',
    label: 'io.bitcoin-arena.node', task: 'Arena node', lnd: { rpc: 10009, rest: 10080, p2p: 9735 }, gateway: 8476, tor: { socks: 19050, control: 19051 }, seat: 8470, liquidity: 8477 });
});

test('a second node: every service named apart, every fixed port moved; a bad name or offset refused', () => {
  assert.deepEqual(read({ ARENA_INSTANCE: 'b', ARENA_PORT_OFFSET: '100' }), { unit: 'arena-node--b.service', bridge: 'arena-chain-bridge--b.service', tunnel: 'arena-tunnel--b.service',
    lndUnit: 'arena-lnd--b.service', label: 'io.bitcoin-arena.node--b', task: 'Arena node b', lnd: { rpc: 10109, rest: 10180, p2p: 9835 }, gateway: 8576,
    tor: { socks: 19150, control: 19151 }, seat: 8570, liquidity: 8577 });
  assert.throws(() => read({ ARENA_INSTANCE: 'B/x' }), /ARENA_INSTANCE is a-z0-9/);
  assert.throws(() => read({ ARENA_PORT_OFFSET: '-5' }), /ARENA_PORT_OFFSET is a whole number/);
});
