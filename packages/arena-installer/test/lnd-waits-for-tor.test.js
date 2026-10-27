// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LND WAITS FOR ITS TOR, AND TOR COMES BACK (kanban #720, the owner's LND log 2026-10-27: "dial proxy failed (connection refused)"):
//   NEW     an install writes the LND unit with an ExecStartPre that waits for Tor's SOCKS port, and Tor's unit with Restart=always
//   UPDATE  a node installed before gets the same two lines in its existing units, once; a node without Tor is left alone
//   SHELL   the wait line, as systemd hands it to bash ($$ -> $), ends 0 on a port that listens and 1 on one that does not
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { installProgram, waitPortLine, unitName } from '../src/service.js';
import { lndWaitsForTor } from '../src/update.js';

const OLD_LND = `# LND for Bitcoin Arena (custody), written by the installer.
[Unit]
Description=LND for Bitcoin Arena (custody)
After=network-online.target ${unitName('tor')}
Wants=network-online.target
PartOf=${unitName('tor')}

[Service]
ExecStart=/home/u/.bitcoinarena/lnd/lnd --lnddir=/home/u/.bitcoinarena/lnd
Restart=on-failure
RestartSec=30
`;
const OLD_TOR = OLD_LND.replace(/LND for Bitcoin Arena \(custody\)/g, 'Bitcoin Arena: Tor for Lightning').replace(/^PartOf=.*\n/m, '').replace(/lnd --lnddir.*/, 'tor -f torrc');

test('NEW: the LND unit waits for Tor\'s SOCKS port, the Tor unit restarts always', async () => {
  const cfg = mkdtempSync(join(tmpdir(), 'unit-')), home = mkdtempSync(join(tmpdir(), 'home-'));
  const env = { XDG_CONFIG_HOME: cfg, HOME: home };
  const sh = async () => ({ ok: true, out: '', err: '' });
  await installProgram({ id: 'tor', description: 'Tor', args: ['/x/tor'], home, env, sh, platform: 'linux', restart: 'always' });
  await installProgram({ id: 'lnd', description: 'LND', args: ['/x/lnd'], home, env, sh, platform: 'linux', partOf: 'tor', waitPort: 19050 });
  const lnd = readFileSync(join(cfg, 'systemd', 'user', unitName('lnd')), 'utf8');
  const tor = readFileSync(join(cfg, 'systemd', 'user', unitName('tor')), 'utf8');
  assert.ok(lnd.includes(`${waitPortLine(19050)}\nExecStart=/x/lnd`));
  assert.match(lnd, /^Restart=on-failure$/m);
  assert.match(tor, /^Restart=always$/m);
  assert.doesNotMatch(tor, /ExecStartPre/);
});

test('UPDATE: an older node\'s two units get the lines once; a node with no Tor is left alone', () => {
  const cfg = mkdtempSync(join(tmpdir(), 'unit-')), home = mkdtempSync(join(tmpdir(), 'home-'));
  const dir = join(cfg, 'systemd', 'user'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, unitName('lnd')), OLD_LND); writeFileSync(join(dir, unitName('tor')), OLD_TOR);
  const env = { XDG_CONFIG_HOME: cfg };
  assert.deepEqual(lndWaitsForTor(home, { env }), [], 'no state.json naming Tor: nothing');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ tor: { bin: '/x/tor', ports: { socks: 19060, control: 19061 } } }));
  assert.deepEqual(lndWaitsForTor(home, { env }), [unitName('lnd'), unitName('tor')]);
  const lnd = readFileSync(join(dir, unitName('lnd')), 'utf8');
  assert.ok(lnd.includes(`${waitPortLine(19060)}\nExecStart=`), 'the node\'s own SOCKS port');
  assert.match(readFileSync(join(dir, unitName('tor')), 'utf8'), /^Restart=always$/m);
  assert.deepEqual(lndWaitsForTor(home, { env }), [], 'a second update changes nothing');
});

test('SHELL: the wait line ends 0 once the port listens, 1 when it never does', async () => {
  const script = (p) => waitPortLine(p).replace(/^ExecStartPre=\/bin\/bash -c '/, '').replace(/'$/, '').replace(/\$\$/g, '$').replace('seq 1 90', 'seq 1 2');
  const bash = (code) => new Promise((ok) => execFile('/bin/bash', ['-c', code], (e) => ok(e ? e.code : 0)));
  const srv = createServer((c) => c.destroy()).listen(0, '127.0.0.1');
  await new Promise((ok) => srv.once('listening', ok));
  const port = srv.address().port;
  assert.equal(await bash(script(port)), 0, 'a port that listens');
  await new Promise((ok) => srv.close(ok));
  assert.equal(await bash(script(port)), 1, 'a port nothing listens on');
});
