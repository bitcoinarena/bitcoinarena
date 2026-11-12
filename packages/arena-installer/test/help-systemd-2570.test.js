// kanban #2570 (feedback #021): --help prints the usage and starts nothing; a failed systemctl --user says how to fix it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { systemctlWhy } from '../src/service.js';

const bin = fileURLToPath(new URL('../bin/arena-install.mjs', import.meta.url));

test('--help and -h print the usage and exit 0 without starting the wizard', () => {
  for (const f of ['--help', '-h']) {
    const out = execFileSync(process.execPath, [bin, f], { encoding: 'utf8', timeout: 20000 });
    assert.match(out, /^THE INSTALLER/);
    assert.match(out, /arena-install --update /);
    assert.match(out, /--tunnel/);
    assert.doesNotMatch(out, /http:\/\/127\.0\.0\.1/);
  }
});

test('systemctl failures name the fix', () => {
  const a = ['--user', 'daemon-reload'];
  assert.match(systemctlWhy(a, { err: 'Failed to connect to bus: No medium found' }), /loginctl enable-linger/);
  assert.match(systemctlWhy(a, { err: 'spawn systemctl ENOENT' }), /no systemd/);
  assert.match(systemctlWhy(a, { err: 'System has not been booted with systemd as init system (PID 1).' }), /wsl\.conf/);
  assert.equal(systemctlWhy(['--user', 'restart', 'x'], { err: 'Unit x not found.' }), 'systemctl --user restart x failed: Unit x not found.');
});
