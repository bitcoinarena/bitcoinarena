// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TOR FOR THE NODE'S LIGHTNING (2026-10-18: "find a way to connect to it via a tunnel" / "connect via tor to the
// other nodes as well"): Lightning peers speak their own protocol over TCP, which no web tunnel carries, and most nodes take no
// connection (no open port, a dynamic address). So the node runs Tor and its LND runs hybrid: a permanent onion address others dial,
// clearnet peers still dialled directly. The federation's channel ring and the gateway's outside channel reach every node this way.
// The release carries the Tor Project's expert bundle (runtime/tor/); a linux-arm64 machine uses the system's tor (none is built).
import { port } from './instance.js';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

export const TOR_PORTS = Object.freeze({ socks: port(19050), control: port(19051) });   // + ARENA_PORT_OFFSET (instance.js)

const runFile = (cmd, args) => new Promise((ok) => execFile(cmd, args, (e) => ok(!e)));

/**
 * MACOS RUNS NO UNSIGNED CODE ON ARM64 (measured on the test host, rc.12 2026-10-18: the expert bundle's tor and libevent carry no
 * signature, macOS killed tor at start - exit 137, launchd -9 - and LND shut down without its Tor control port): every Mach-O in the
 * bundle's tor directory that fails `codesign -v` gets an ad-hoc signature (`codesign --force -s -`, the system's own tool) before
 * it runs. The release is assembled on Linux, where there is no codesign. Answers the files signed here.
 */
export async function adhocSign(dir, { run = runFile } = {}) {
  const signed = [];
  for (const f of readdirSync(dir).filter((x) => x === 'tor' || x.endsWith('.dylib'))) {
    const path = join(dir, f);
    if (await run('/usr/bin/codesign', ['-v', path])) continue;
    if (await run('/usr/bin/codesign', ['--force', '-s', '-', path])) signed.push(f);
  }
  return signed;
}

/** The tor to run: the release's own (on macOS signed first), else one in PATH (`which`), else null. */
export async function torBin({ release, platform = process.platform, which = null, run = runFile }) {
  const own = join(release, 'runtime', 'tor', platform === 'win32' ? 'tor.exe' : 'tor');
  if (existsSync(own)) { if (platform === 'darwin') await adhocSign(join(release, 'runtime', 'tor'), { run }); return own; }
  if (which) { const w = await which('tor'); if (w) return w; }
  return null;
}

/**
 * HOW TOR IS STARTED (playtest 2026-10-25: "lnd and Tor fails on Linux, works on macOS"; measured in a fresh ubuntu:24.04 container:
 * the release's tor stopped at once - "error while loading shared libraries: libevent-2.1.so.7" - its own libevent, libssl and libcrypto
 * lie beside it, and the binary names no RUNPATH): on Linux a launcher in the node's home puts tor's own folder on the library path at
 * every start - worked out from tor's path, which an update rewrites in the service, so it follows every release. Answers the command
 * that comes before tor's own arguments.
 */
export function torCommand({ home, tor, platform = process.platform }) {
  if (platform !== 'linux') return [tor];
  const dir = join(home, 'tor');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const launcher = join(dir, 'run-tor.sh');
  writeFileSync(launcher, ['#!/bin/sh', '# Tor with its own libraries (libevent, libssl) - written by the installer.', 'TOR="$1"; shift',
    'LD_LIBRARY_PATH="$(dirname "$TOR")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "$TOR" "$@"', ''].join('\n'), { mode: 0o700 });
  return [launcher, tor];
}

/** The node's torrc in <home>/tor: SOCKS for LND's dialling, the control port LND makes its onion service with. Answers its path. */
export function writeTorrc({ home, ports = TOR_PORTS }) {
  const dir = join(home, 'tor');
  mkdirSync(join(dir, 'data'), { recursive: true, mode: 0o700 });
  const file = join(dir, 'torrc');
  writeFileSync(file, ['# The Arena node\'s Tor, written by the installer: LND dials and is dialled through it.',
    `SocksPort 127.0.0.1:${ports.socks}`, `ControlPort 127.0.0.1:${ports.control}`, 'CookieAuthentication 1',
    `DataDirectory ${join(dir, 'data')}`, ''].join('\n'), { mode: 0o600 });
  return file;
}

/** LND's [Tor] section for a running Tor: hybrid - an onion address (v3) for others, clearnet peers dialled directly. */
export const lndTorLines = (ports = TOR_PORTS) => ['[Tor]', 'tor.active=true', 'tor.v3=true', `tor.socks=127.0.0.1:${ports.socks}`,
  `tor.control=127.0.0.1:${ports.control}`, 'tor.streamisolation=false', 'tor.skip-proxy-for-clearnet-targets=true'];
