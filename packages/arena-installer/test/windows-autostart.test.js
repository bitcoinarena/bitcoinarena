import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsAutostart } from '../src/service.js';

test('a logon task that refuses to run is started by hand (kanban #964)', async () => {
  const calls = [];
  const sh = async (cmd, args) => { calls.push(cmd); return { ok: !(cmd === 'schtasks' && args[0] === '/run'), out: '', err: '' }; };
  const a = await windowsAutostart({ name: 'Arena node tunnel', file: 'C:\\h\\arena-tunnel.cmd', sh, env: {} });
  assert.equal(a.ok, true);
  assert.equal(a.started, 'direct');
  assert.deepEqual(calls, ['schtasks', 'schtasks', 'cmd']);
});

test('a task that runs is left alone', async () => {
  const calls = [];
  const a = await windowsAutostart({ name: 'Arena node', file: 'C:\\h\\arena-node.cmd', sh: async (cmd) => { calls.push(cmd); return { ok: true, out: '', err: '' }; }, env: {} });
  assert.equal(a.started, 'task');
  assert.deepEqual(calls, ['schtasks', 'schtasks']);
});
