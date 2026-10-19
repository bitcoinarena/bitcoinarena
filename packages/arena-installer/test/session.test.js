// kanban #503: a remote session (ssh, or Linux without a display) gets the tunnelled setup link by itself; --local and --tunnel decide first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteSession, setupLinkMode } from '../src/session.js';

test('remote: an ssh session on Linux or macOS, or Linux without a display; a desktop is not', () => {
  assert.deepEqual(remoteSession({ env: { SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22', DISPLAY: ':0' }, platform: 'linux' }), { remote: true, why: 'this is a remote (ssh) session' });
  assert.equal(remoteSession({ env: { SSH_TTY: '/dev/ttys003' }, platform: 'darwin' }).remote, true, 'a macOS over ssh');
  assert.deepEqual(remoteSession({ env: {}, platform: 'linux' }), { remote: true, why: 'this machine has no display' });
  assert.equal(remoteSession({ env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' }).remote, false, 'a Linux desktop');
  assert.equal(remoteSession({ env: {}, platform: 'darwin' }).remote, false, 'a macOS at its own screen');
  assert.equal(remoteSession({ env: {}, platform: 'win32' }).remote, false);
});

test('the link: --local and --tunnel first, then the session', () => {
  const ssh = { env: { SSH_CLIENT: '10.0.0.2 51000 22' }, platform: 'linux' };
  assert.deepEqual(setupLinkMode([], ssh), { tunnel: true, why: 'this is a remote (ssh) session' });
  assert.deepEqual(setupLinkMode(['--local'], ssh), { tunnel: false, why: '--local' });
  assert.deepEqual(setupLinkMode(['--tunnel'], { env: { DISPLAY: ':0' }, platform: 'linux' }), { tunnel: true, why: '--tunnel' });
  assert.equal(setupLinkMode([], { env: { DISPLAY: ':0' }, platform: 'linux' }).tunnel, false);
});
