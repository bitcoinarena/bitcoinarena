// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TOR FOR THE NODE'S LIGHTNING (2026-10-18: "find a way to connect to it via a tunnel" / "connect via tor to the
// other nodes as well"): Lightning peers speak their own protocol over TCP, which no web tunnel carries, and most nodes take no
// connection (no open port, a dynamic address). So the node runs Tor and its LND runs hybrid: a permanent onion address others dial,
// clearnet peers still dialled directly. The federation's channel ring and the gateway's outside channel reach every node this way.
// The release carries the Tor Project's expert bundle (runtime/tor/); a linux-arm64 machine uses the system's tor (none is built).
import { port } from './instance.js';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { connect, createServer } from 'node:net';

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
  // its output into tor.log (kanban #670): what Tor says before its torrc's log is open - "Could not bind to 127.0.0.1:19051: Address
  // already in use", the loader's "error while loading shared libraries" - lands where the setup reads it (torComplaint)
  const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  writeFileSync(launcher, ['#!/bin/sh', '# Tor with its own libraries (libevent, libssl) - written by the installer.', 'TOR="$1"; shift',
    `LD_LIBRARY_PATH="$(dirname "$TOR")\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "$TOR" "$@" >> ${q(torLogOf(home))} 2>&1`, ''].join('\n'), { mode: 0o700 });
  return [launcher, tor];
}

/** The node's torrc in <home>/tor: SOCKS for LND's dialling, the control port LND makes its onion service with. Answers its path. */
export function writeTorrc({ home, ports = TOR_PORTS }) {
  const dir = join(home, 'tor');
  mkdirSync(join(dir, 'data'), { recursive: true, mode: 0o700 });
  const file = join(dir, 'torrc');
  // TOR'S OWN WORDS IN A FILE (kanban #670, 2026-10-26: "tor is not starting and could be the reason lnd also doesnt start"): on Linux
  // Tor's output went only to the journal, so setup could not say why it stopped; tor.log beside the torrc, started empty at every
  // install, holds its [warn] and [err] lines for the setup (torUp, torComplaint) and for `bitcoinarena logs tor`
  writeFileSync(torLogOf(home), '');
  writeFileSync(file, ['# The Arena node\'s Tor, written by the installer: LND dials and is dialled through it.',
    `SocksPort 127.0.0.1:${ports.socks}`, `ControlPort 127.0.0.1:${ports.control}`, 'CookieAuthentication 1',
    `DataDirectory ${join(dir, 'data')}`, `Log notice file ${torLogOf(home)}`, ''].join('\n'), { mode: 0o600 });
  return file;
}

/** Where the node's Tor writes its log, and where it keeps its control cookie (its DataDirectory). */
export const torLogOf = (home) => join(home, 'tor', 'tor.log');
export const torCookieOf = (home) => join(home, 'tor', 'data', 'control_auth_cookie');
/** Is `cookieFile` (as a Tor named it) this node's Tor's? The same path, or the same file behind a link (macOS /var is /private/var). */
export function ownTorCookie(home, cookieFile) {
  if (!cookieFile) return false;
  if (cookieFile === torCookieOf(home)) return true;
  try { return realpathSync(cookieFile) === realpathSync(torCookieOf(home)); } catch { return false; }
}

/**
 * WHOSE TOR ANSWERS ON A CONTROL PORT (kanban #670): PROTOCOLINFO, which Tor answers before any login, names the cookie file of the Tor
 * behind the port - this node's own when it is <home>/tor/data/control_auth_cookie. Measured 2026-10-26 with the release's tor 0.4.9.14
 * (expert bundle 15.0.25) in a scratch home: a port held by another program, Tor stopped at once - "Could not bind to 127.0.0.1:41051:
 * Address already in use. Is Tor already running?" - and the old check, "does the control port answer", said yes, so LND was told to
 * use a Tor that was not its own. Answers { answers, cookieFile } (answers false: nothing listens).
 */
export function torControlInfo(port, { timeoutMs = 3000 } = {}) {
  return new Promise((done) => {
    const c = connect(port, '127.0.0.1');
    let buf = '', settled = false;
    const end = (r) => { if (settled) return; settled = true; clearTimeout(timer); c.destroy(); done(r); };
    const timer = setTimeout(() => end({ answers: true, cookieFile: null }), timeoutMs);
    c.once('connect', () => c.write('PROTOCOLINFO 1\r\n'));
    c.on('data', (d) => {
      buf += d;
      if (!/^250 OK\r?$/m.test(buf) && !/^5\d\d /m.test(buf)) return;
      const m = buf.match(/COOKIEFILE="((?:[^"\\]|\\.)*)"/);
      end({ answers: true, cookieFile: m ? m[1].replace(/\\(.)/g, '$1') : null });
    });
    c.once('error', () => end({ answers: false, cookieFile: null }));
    c.once('close', () => end({ answers: buf.length > 0, cookieFile: null }));
  });
}

const portFree = (p) => new Promise((ok) => {
  const srv = createServer();
  srv.once('error', () => ok(false));
  srv.listen(p, '127.0.0.1', () => srv.close(() => ok(true)));
});

/**
 * THE TOR PORTS, FREE ONES (kanban #670, as Bitcoin Core's in kanban #635): the node's pair when they are free or this node's own Tor holds
 * them (an install again restarts it), else the next pair 10 up, checked on this machine before the torrc names them.
 */
export async function freeTorPorts({ home, base = TOR_PORTS, free = portFree, info = torControlInfo, tries = 50 } = {}) {
  for (let i = 0; i < tries; i++) {
    const ports = { socks: base.socks + 10 * i, control: base.control + 10 * i };
    if (await free(ports.socks) && await free(ports.control)) return ports;
    if (home && ownTorCookie(home, (await info(ports.control)).cookieFile)) return ports;   // this node's own Tor: restarted in place
  }
  throw new Error(`no free ports for Tor from ${base.socks} on`);
}

/**
 * What the node's Tor complains of: the last [warn] or [err] line of its log (and of the service's own output, <home>/tor.log on macOS and
 * Windows) without the time stamp - the warning, not the "[err] Reading config failed--see warnings above" after it, nor the loader's
 * line - and whether it stopped (an [err] line, or a line that is not Tor's own: the loader's or the shell's). null when it said nothing of
 * the kind.
 */
export function torComplaint(home, { read = (f) => readFileSync(f, 'utf8') } = {}) {
  let text = '';
  for (const f of [torLogOf(home), join(home, 'tor.log')]) { try { text += read(f) + '\n'; } catch { /* not written (yet) */ } }
  const torLine = (l) => /^\w{3} +\d+ [\d:.]+ \[\w+\]/.test(l);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && (!torLine(l) || /\[(warn|err)\]/.test(l)));
  if (!lines.length) return null;
  const pick = lines.filter((l) => !/see warnings above|Failed to parse\/validate config/i.test(l)).pop() || lines.pop();
  return { line: pick.replace(/^.*?\[(warn|err)\]\s*/, '').slice(0, 300), stopped: lines.some((l) => /\[err\]/.test(l) || !torLine(l)) };
}

/** LND's [Tor] section for a running Tor: hybrid - an onion address (v3) for others, clearnet peers dialled directly. */
export const lndTorLines = (ports = TOR_PORTS) => ['[Tor]', 'tor.active=true', 'tor.v3=true', `tor.socks=127.0.0.1:${ports.socks}`,
  `tor.control=127.0.0.1:${ports.control}`, 'tor.streamisolation=false', 'tor.skip-proxy-for-clearnet-targets=true'];
