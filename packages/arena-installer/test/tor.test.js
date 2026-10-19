// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LND'S PEERS (2026-10-18: "Measure if lnd is accessible from the outside after installing if not install tor"):
// reached from outside - LND announces that address; not reached - Tor, and LND makes an onion address through it (hybrid).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { torBin, writeTorrc, TOR_PORTS } from '../src/tor.js';
import { configureLnd } from '../src/lnd.js';

test('the release\'s own tor, else one in PATH, else none; its torrc', async () => {
  const rel = mkdtempSync(join(tmpdir(), 'rel-'));
  assert.equal(await torBin({ release: rel, which: async () => null }), null);
  assert.equal(await torBin({ release: rel, which: async () => '/usr/bin/tor' }), '/usr/bin/tor', 'linux-arm64: the system\'s tor');
  mkdirSync(join(rel, 'runtime', 'tor'), { recursive: true }); writeFileSync(join(rel, 'runtime', 'tor', 'tor'), '');
  assert.equal(await torBin({ release: rel, platform: 'linux', which: async () => '/usr/bin/tor' }), join(rel, 'runtime', 'tor', 'tor'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const rc = writeTorrc({ home });
  assert.match(readFileSync(rc, 'utf8'), /SocksPort 127\.0\.0\.1:19050\nControlPort 127\.0\.0\.1:19051\nCookieAuthentication 1/);
  assert.equal(statSync(rc).mode & 0o777, 0o600);
});

test('lnd.conf: reached from outside - its address announced, no Tor; not reached - hybrid Tor', () => {
  const chain = { url: 'http://127.0.0.1:48332', cookiePath: '/c' };
  const reached = readFileSync(join(configureLnd({ home: mkdtempSync(join(tmpdir(), 'l-')), chain, externalIp: '198.51.100.4' }).lnddir, 'lnd.conf'), 'utf8');
  assert.match(reached, /externalip=198\.51\.100\.4:9735/); assert.doesNotMatch(reached, /tor\.active/);
  assert.doesNotMatch(reached, /nat=true/, 'an outside address is announced as it is: no router asked');
  const h = mkdtempSync(join(tmpdir(), 'l-'));
  const behind = readFileSync(join(configureLnd({ home: h, chain, tor: TOR_PORTS }).lnddir, 'lnd.conf'), 'utf8');
  assert.match(behind, /\[Tor\]\ntor\.active=true\ntor\.v3=true\ntor\.socks=127\.0\.0\.1:19050\ntor\.control=127\.0\.0\.1:19051/);
  assert.match(behind, /tor\.skip-proxy-for-clearnet-targets=true/, 'hybrid: clearnet peers still dialled directly');
  assert.doesNotMatch(behind, /externalip=/);
  assert.doesNotMatch(behind, /nat=true/, 'Tor: no NAT-PMP - LND stops when no router answers it');
  assert.match(behind, /^listen=127\.0\.0\.1:9735$/m, 'behind Tor the peer port is local only: no Windows Firewall prompt (inbound comes through the onion)');
  assert.match(reached, /^listen=0\.0\.0\.0:9735$/m, 'reached from outside: every interface');
});

test('Linux: LND\'s unit restarts with the node\'s Tor (its onion is gone when Tor restarts - measured on the test host)', async () => {
  const { installProgram } = await import('../src/service.js');
  const home = mkdtempSync(join(tmpdir(), 'svc-')); const cfg = mkdtempSync(join(tmpdir(), 'cfg-'));
  const ran = [];
  await installProgram({ id: 'lnd', description: 'LND', args: ['/x/lnd'], home, partOf: 'tor', platform: 'linux', env: { XDG_CONFIG_HOME: cfg }, sh: async (...a) => { ran.push(a); return { ok: true, out: '', err: '' }; } });
  const unit = readFileSync(join(cfg, 'systemd', 'user', 'arena-lnd.service'), 'utf8');
  assert.match(unit, /After=network-online\.target arena-tor\.service/); assert.match(unit, /\nPartOf=arena-tor\.service\n/);
  await installProgram({ id: 'gateway', description: 'gw', args: ['/x/gw'], home, platform: 'linux', env: { XDG_CONFIG_HOME: cfg }, sh: async () => ({ ok: true, out: '', err: '' }) });
  assert.doesNotMatch(readFileSync(join(cfg, 'systemd', 'user', 'arena-gateway.service'), 'utf8'), /PartOf/);
});

test('macOS: the bundle\'s unsigned tor and libevent are signed ad hoc before they run; signed ones and other systems untouched', async () => {
  const rel = mkdtempSync(join(tmpdir(), 'rel-')); const dir = join(rel, 'runtime', 'tor');
  mkdirSync(dir, { recursive: true }); for (const f of ['tor', 'libevent-2.1.7.dylib', 'torrc-defaults']) writeFileSync(join(dir, f), '');
  const ran = []; const signedAlready = new Set();
  const run = async (cmd, args) => { ran.push([cmd, ...args]); if (args[0] === '-v') return signedAlready.has(args[1]); signedAlready.add(args.at(-1)); return true; };
  assert.equal(await torBin({ release: rel, platform: 'darwin', run }), join(dir, 'tor'));
  assert.deepEqual(ran.filter((r) => r[1] === '--force').map((r) => r.at(-1).split('/').pop()).sort(), ['libevent-2.1.7.dylib', 'tor'], 'both signed with -s -');
  assert.ok(ran.every((r) => r[0] === '/usr/bin/codesign'));
  ran.length = 0; await torBin({ release: rel, platform: 'darwin', run });
  assert.deepEqual(ran.filter((r) => r[1] === '--force'), [], 'signed once: the next start only checks');
  ran.length = 0; await torBin({ release: rel, platform: 'linux', run });
  assert.deepEqual(ran, [], 'Linux: nothing to sign');
});
