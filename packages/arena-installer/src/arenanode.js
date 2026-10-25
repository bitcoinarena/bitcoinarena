// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENANODE COMMAND (2026-10-19: "Take a look how openclaw is used using the openclaw command, ie openclaw status,
// openclaw gateway restart etc. no messing with command line parameters"). One word, then what to act on:
//
//   arenanode status                     the node and every service: running, pid, what it answers
//   arenanode start | stop | restart     all services, in order
//   arenanode restart lnd                one: node, guardian, lnd, gateway, tor, tunnel, bitcoind, chain-bridge, custody, liquidity, workers
//   arenanode doctor                     every check, each problem with the command that fixes it
//   arenanode logs [service]             the last lines of its log
//   arenanode config [get|set|unset]     arena.conf
//   arenanode open                       the owner page
//   arenanode version
//
// The installer writes the command with this node's home in it (launchers.js writeCommand), so it takes no flags; a second node on the
// machine has its own, arenanode-<instance>.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { overview, control, doctor, logsOf, nodeOf, SERVICES } from './node-services.js';
import { parseConf, setInConf, unsetInConf, CONF_KEYS } from '../../arena-node/src/arena-conf.js';

export const HELP = (name) => `${name}: your Bitcoin Arena node on this machine

  ${name} status                    every service: running, pid, what it answers
  ${name} start | stop | restart    all of them, in order
  ${name} restart <service>         one of: ${SERVICES.map((s) => s.id).join(', ')}
  ${name} doctor                    find problems; each comes with the command that fixes it
  ${name} logs [service]            the last lines of its log (the node's without a name)
  ${name} config                    the settings (arena.conf)
  ${name} config get <key>
  ${name} config set <key> <value>  then: ${name} restart
  ${name} config unset <key>
  ${name} update                    update this node now to the newest signed release (auto update does it by itself)
  ${name} open                      the owner page in the browser
  ${name} dashboard                 the node's dashboard in the browser
  ${name} state                     one line: running, or stopped and why (the desktop app's)
  ${name} version
`;

const mark = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '•');
const pad = (s, n) => { s = String(s ?? ''); return s.length >= n ? s : s + ' '.repeat(n - s.length); };

/** The status table's lines. */
export function statusLines(v) {
  const lines = [`Bitcoin Arena node ${v.version || '(version unknown)'}${v.instance ? `, instance ${v.instance}` : ''}`,
    `  home      ${v.home}`, `  settings  ${v.conf || (v.legacyEnv ? `${v.home}/node.env (an older release; an update moves it into arena.conf)` : 'arena.conf missing')}`,
    `  seat      ${v.port ? `127.0.0.1:${v.port}` : '-'}${v.publicUrl ? `   public ${v.publicUrl}` : ''}`, ...(v.roles ? [`  roles     ${v.roles}`] : []), ''];
  const w = Math.max(8, ...v.services.map((s) => s.title.length));
  lines.push(`  ${pad('', 2)}${pad('SERVICE', w)}  ${pad('STATE', 9)}${pad('PID', 8)}DETAIL`);
  for (const s of v.services) {
    const ok = s.running === null ? null : !s.running ? false : s.probe ? s.probe.ok : true;
    lines.push(`  ${mark(ok)} ${pad(s.title, w)}  ${pad(s.running === null ? 'unknown' : s.running ? 'running' : 'stopped', 9)}${pad(s.pid || '-', 8)}${s.probe && s.running !== null ? s.probe.says : s.detail}`);
  }
  const bad = v.services.filter((s) => s.running === false || (s.running && s.probe && !s.probe.ok)).length;
  lines.push('', bad ? `  ${bad} service(s) need attention: arenanode doctor` : '  All services run.');
  return lines;
}

const openUrl = (url, platform = process.platform) => new Promise((ok) => execFile(platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open',
  platform === 'win32' ? ['/c', 'start', '""', url] : [url], () => ok()));

/**
 * Run one command. `io`: { out(line), err(line) }; `deps` injectable for the tests ({ sh, fetcher, platform, env, latest, quickUrl }).
 * Answers the exit code.
 */
export async function main(args, { home, name = 'arenanode', io = { out: (l) => console.log(l), err: (l) => console.error(l) }, deps = {} }) {
  const [cmd = 'status', a, b, ...rest] = args;
  const ctx = { home, ...deps };
  switch (cmd) {
    case 'help': case '-h': case '--help':
      io.out(HELP(name)); return 0;
    case 'version': {
      const n = nodeOf(home);
      io.out(`${n.version || 'unknown'}${n.release ? `  (${n.release})` : ''}`); return 0;
    }
    case 'status': {
      const v = await overview(ctx);
      if (a === 'json' || a === '--json') { io.out(JSON.stringify(v, null, 2)); return 0; }
      if (!v.services.length) { io.err(`No Bitcoin Arena node is installed for ${home}. Install one: arena-install`); return 1; }
      for (const l of statusLines(v)) io.out(l);
      return v.services.every((s) => s.running !== false) ? 0 : 1;
    }
    case 'start': case 'stop': case 'restart': {
      const r = await control(cmd, a, ctx);
      if (r.why) { io.err(r.why); return 2; }
      if (r.note) io.out(r.note);
      for (const d of r.done) io.out(`${mark(d.ok)} ${d.action} ${d.id}${d.followed ? ' (it names the tunnel\'s new address)' : ''}${d.ok ? '' : `: ${d.why}`}`);
      if (r.tunnel && r.tunnel.url) io.out(`  the tunnel answers as ${r.tunnel.url}${r.tunnel.changed && r.tunnel.changed.length ? `; ${r.tunnel.changed.length} file(s) follow it` : ''}`);
      if (cmd !== 'stop') io.out(`Check: ${name} status`);
      return r.ok ? 0 : 1;
    }
    case 'doctor': {
      const checks = await doctor({ ...ctx, name });
      const w = Math.max(...checks.map((c) => c.check.length));
      for (const c of checks) {
        io.out(`${mark(c.ok)} ${pad(c.check, w)}  ${c.says}`);
        if (c.fix && c.ok !== true) io.out(`  ${' '.repeat(w)}  fix: ${c.fix}`);
      }
      const bad = checks.filter((c) => c.ok === false).length;
      io.out(''); io.out(bad ? `${bad} problem(s).` : 'No problems found.');
      return bad ? 1 : 0;
    }
    case 'logs': {
      const r = await logsOf(a, { ...ctx, lines: Number(b) || 60 });
      if (!r.ok && !r.text) { io.err(r.why); return 1; }
      io.out(`--- ${r.file || r.unit}`); io.out(r.text); return 0;
    }
    case 'config': {
      const n = nodeOf(home);
      const file = n.conf.file;
      if (!a || a === 'show' || a === 'file') {
        if (!n.conf.present) { io.err(n.legacyEnv ? `This node still runs from ${home}/node.env (an older release): update it, and its settings move into ${file}` : `${file} does not exist`); return 1; }
        if (a === 'file') { io.out(file); return 0; }
        io.out(`# ${file}`); io.out(readFileSync(file, 'utf8').trimEnd()); return 0;
      }
      if (!n.conf.present) { io.err(`${file} does not exist`); return 1; }
      const text = readFileSync(file, 'utf8');
      if (a === 'get') {
        const v = parseConf(text).values[String(b || '').toLowerCase()];
        if (v === undefined) { io.err(`${b} is not set`); return 1; }
        io.out(v); return 0;
      }
      if (a === 'set') {
        if (!b || rest.length === 0) { io.err(`${name} config set <key> <value>`); return 2; }
        const key = b.toLowerCase(); const value = rest.join(' ');
        if (key === 'port' && !(Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) < 65536)) { io.err(`${value} is no port`); return 2; }
        const next = setInConf(text, key, value);
        const parsed = parseConf(next);
        if (parsed.errors.length) { io.err(parsed.errors.join('; ')); return 2; }
        writeFileSync(file, next, { mode: 0o600 });
        const known = CONF_KEYS.some(([k]) => k === key);
        io.out(`${key}=${value}${known ? '' : '  (not a setting this release lists; the seat reads it as ARENA_' + key.toUpperCase() + ')'}`);
        io.out(`Takes effect at the next start: ${name} restart node`); return 0;
      }
      if (a === 'unset') {
        writeFileSync(file, unsetInConf(text, String(b || '').toLowerCase()), { mode: 0o600 });
        io.out(`${b} unset. Takes effect at the next start: ${name} restart node`); return 0;
      }
      io.err(`${name} config [get <key> | set <key> <value> | unset <key> | file]`); return 2;
    }
    case 'update': {
      // NOW: the newest signed release fetched, checked and the node moved to it - whatever auto_update says
      const { checkOnce } = await import('./auto-update.js');
      if (!deps.latest) { io.err('this command reads no release list (run it from a release)'); return 1; }
      const r = await checkOnce({ home, latest: deps.latest, force: true, log: (l) => io.out(l), ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) });
      io.out(r.upToDate ? `Up to date: ${r.version} is the newest release.` : r.ok ? `Updated ${r.from} -> ${r.to}. Backup: ${r.backup}` : `Not updated: ${r.why}`);
      return r.ok ? 0 : 1;
    }
    case 'auto-update': {
      // THE SERVICE: a check every few hours; it ends after an update, and its service starts it again from the new release
      const { runAutoUpdate } = await import('./auto-update.js');
      if (!deps.latest) { io.err('this command reads no release list (run it from a release)'); return 1; }
      await runAutoUpdate({ home, latest: deps.latest });
      return 0;
    }
    // THE DESKTOP APP'S LINE (kanban #658, 2026-10-25: "show when it's installed \"Server running\""): the seat's own state in a word
    case 'state': {
      const v = await overview({ ...ctx, probes: false });
      const seat = v.services.find((s) => s.id === 'node');
      if (!seat) { io.out('none'); return 1; }
      const down = v.services.filter((s) => s.running === false).map((s) => s.title);
      io.out(seat.running === false ? `stopped${seat.detail ? `: ${seat.detail}` : ''}` : down.length ? `running; not running: ${down.join(', ')}` : 'running');
      return seat.running === false ? 1 : 0;
    }
    // THE LOCAL ADDRESS, NEVER THE TUNNEL'S (the owner's playtest 2026-10-25: "The owner page is no longer logged in" - a quick tunnel takes
    // a new name at every restart, and the browser keeps the owner's login per address): on this machine the node's own port never changes
    case 'dashboard': {
      const n = nodeOf(home);
      const url = `http://127.0.0.1:${n.port}/dashboard`;
      io.out(url);
      if (!deps.noOpen) await openUrl(url, deps.platform);
      return 0;
    }
    case 'open': {
      const n = nodeOf(home);
      const url = `http://127.0.0.1:${n.port}/dashboard/owner`;
      io.out(url);
      if (!deps.noOpen) await openUrl(url, deps.platform);
      return 0;
    }
    default:
      io.err(`No command "${cmd}".\n`); io.err(HELP(name)); return 2;
  }
}

