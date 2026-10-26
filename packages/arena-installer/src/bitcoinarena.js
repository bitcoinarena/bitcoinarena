// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BITCOINARENA COMMAND (2026-10-19: "Take a look how openclaw is used using the openclaw command, ie openclaw status,
// openclaw gateway restart etc. no messing with command line parameters"). One word, then what to act on:
//
//   bitcoinarena status                     the node and every service: running, pid, what it answers
//   bitcoinarena start | stop | restart     all services, in order
//   bitcoinarena restart lnd                one: node, guardian, lnd, gateway, tor, tunnel, bitcoind, chain-bridge, custody, liquidity, workers
//   bitcoinarena doctor                     every check, each problem with the command that fixes it
//   bitcoinarena logs [service]             the last lines of its log
//   bitcoinarena config [get|set|unset]     arena.conf
//   bitcoinarena open                       the owner page
//   bitcoinarena version
//
// Any of them with --verbose (-v): each step said as it runs; with --debug: that and the insides - error stacks, failed answers, the
// child processes and their exit codes (kanban #693, log-level.js). Nothing secret is printed at either.
//
// The installer writes the command with this node's home in it (launchers.js writeCommand), so it takes no flags; a second node on the
// machine has its own, bitcoinarena-<instance>. ITS NAME UNTIL 2026.1.9.8 WAS arenanode (kanban #688, 2026-10-26: "Rename the directories
// and binaries to bitcoinarena, not arenanode everywhere"): arenanode stays, as a small script that runs bitcoinarena, so the old name,
// the old app helpers and an auto update service that names it keep working.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { overview, control, doctor, logsOf, nodeOf, SERVICES } from './node-services.js';
import { parseConf, setInConf, unsetInConf, CONF_KEYS } from '../../arena-node/src/arena-conf.js';
import { QUIET, levelWord, levelOf, LEVELS } from '../../arena-node/src/log-level.js';

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
  ${name} nodes [--json]            every Bitcoin Arena node on this machine: running or not, version, port, home
  ${name} add-nodes <n> [--ram]     set up <n> more nodes on this machine (testnet4), each with its own setup page
  ${name} sign-in-all               every node's owner page signed in, in this browser, at once; their links
  ${name} version

  Add --verbose (or -v) to any of them to see each step as it runs: which file, service, port or address it checks, what
  answered and how long it took. Add --debug to see that and more: full errors, failed answers, the programs it runs and
  how they ended. Passwords, keys, cookies and seed words are never shown.
  For the node itself: ${name} config set log_level verbose (or debug), then ${name} restart. Back to normal: ${name} config unset log_level
`;

const mark = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '•');
const pad = (s, n) => { s = String(s ?? ''); return s.length >= n ? s : s + ' '.repeat(n - s.length); };

/** The status table's lines. */
export function statusLines(v, name = 'bitcoinarena') {
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
  lines.push('', bad ? `  ${bad} service(s) need attention: ${name} doctor` : '  All services run.');
  return lines;
}

/** The Arena site's owner page (kanban #687), as the installer's FinishSteps names it. */
export const OWNER_SITE = 'https://testnet.bitcoin-arena.io/owner/';
// on Windows through the URL handler, not `cmd /c start`: cmd cuts a URL at its & (the owner page's #node=...&local=..., kanban #687)
// the one-time sign-in page (bin/owner-handoff.mjs) started apart, so this command returns at once; its address, or null
const startHandoff = ({ home, target, all = false }) => new Promise((ok) => {
  const c = spawn(process.execPath, [fileURLToPath(new URL('../bin/owner-handoff.mjs', import.meta.url))], { detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ARENA_HANDOFF_HOME: home, ARENA_HANDOFF_TARGET: target, ...(all ? { ARENA_HANDOFF_ALL: '1' } : {}) } });
  let out = '';
  const end = (v) => { try { c.stdout.destroy(); c.unref(); } catch { /* gone */ } ok(v); };
  c.stdout.on('data', (d) => { out += d; const line = out.split('\n')[0]; if (out.includes('\n')) end(/^http:\/\/127\.0\.0\.1:\d+\//.test(line) ? line : null); });
  c.on('error', () => end(null)); c.on('exit', () => end(null));
  setTimeout(() => end(null), 10000).unref();
});
const openUrl = (url, platform = process.platform) => new Promise((ok) => execFile(platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32' : 'xdg-open',
  platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url], () => ok()));

/** The site's owner page for the node at `home`: its key from state.json or the seat's /identity; the local page when neither answers. */
async function ownerUrlOf(home, deps) {
  const n = nodeOf(home);
  const local = `http://127.0.0.1:${n.port}`;
  let key = n.state && n.state.service && n.state.service.identity;
  if (!/^[0-9a-f]{64}$/.test(String(key || ''))) {
    try { const r = await (deps.fetch || fetch)(`${local}/identity`, { signal: AbortSignal.timeout(5000) }); const b = Buffer.from(await r.arrayBuffer()); key = r.status === 200 && b.length >= 32 ? b.subarray(0, 32).toString('hex') : null; }
    catch { key = null; }
  }
  return /^[0-9a-f]{64}$/.test(String(key || '')) ? `${OWNER_SITE}#node=${key}&local=${encodeURIComponent(local)}` : `${local}/dashboard/owner`;
}
/**
 * THE KEY HANDED TO THE SITE'S OWNER PAGE ONCE (the owner, 2026-10-26 on 2026.1.9.9: "The updater MUST fix my credentials in the browser so
 * it works. This is very important"): until this node's key was handed over (or with `force`), the one-time page on 127.0.0.1 opens the
 * site's owner page and posts it the key. Run after an update a person started and before the dashboard opens. The address it opened, or null.
 */
async function signInOnce(home, deps, io, { force = false } = {}) {
  if (deps.noOpen) return null;
  const url = await ownerUrlOf(home, deps);
  const { handedAt, ownerKeyOf } = await import('./owner-handoff.js');
  if (!url.startsWith(OWNER_SITE) || (handedAt(home) && !force) || !ownerKeyOf(home)) return null;
  const h = await (deps.handoff || startHandoff)({ home, target: `${url}&owner-handoff` });
  if (!h) return null;
  io.out(`Signing you in on your owner page once: ${h}`);
  await (deps.openUrl || openUrl)(h, deps.platform);
  return h;
}

/**
 * Run one command. `io`: { out(line), err(line) }; `deps` injectable for the tests ({ sh, fetcher, platform, env, latest, quickUrl }).
 * Answers the exit code.
 */
export async function main(args, { home, name = 'bitcoinarena', io = { out: (l) => console.log(l), err: (l) => console.error(l) }, deps = {}, log = QUIET }) {
  const [cmd = 'status', a, b, ...rest] = args;
  const ctx = { home, ...deps, log };
  log.tag('bitcoinarena').verbose(`${cmd}${a ? ` ${a}` : ''}: home ${home}, log level ${log.level}`);
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
      for (const l of statusLines(v, name)) io.out(l);
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
      io.out(`--- ${r.file || r.unit}`);
      // THE LEVEL THE SERVICES LOG AT, WHEN IT IS NOT THE DEFAULT (kanban #693): said above their lines, so a quiet log is not taken for a broken one
      { const lv = levelOf({ env: {}, conf: nodeOf(home).conf.values }); if (lv.level !== 'info') io.out(`--- log level ${lv.level} (${lv.from}; it applies from the service's next start)`); }
      io.out(r.text); return 0;
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
        if (key === 'log_level' && !levelWord(value)) { io.err(`${value} is no log level: ${LEVELS.join(', ')}`); return 2; }
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
      // ITS PROGRESS (kanban #706): one line redrawn in a terminal, one line per step otherwise (update-progress.js)
      const { progressBar } = await import('./update-progress.js');
      const bar = progressBar({ tty: deps.tty ?? !!process.stdout.isTTY, line: (l) => io.out(l) });
      const r = await checkOnce({ home, latest: deps.latest, force: true, log: bar.line, progress: bar.report, trace: log, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}) });
      io.out(r.upToDate ? `Up to date: ${r.version} is the newest release.` : r.ok ? `Updated ${r.from} -> ${r.to}. Backup: ${r.backup}` : `Not updated: ${r.why}`);
      // the owner page signed in once after the update (2026-10-26: "The updater MUST fix my credentials in the browser so it works")
      if (r.ok && !r.upToDate) await signInOnce(home, deps, io);
      // MORE NODES, ASKED AT A CONSOLE (kanban #713: "When I update an existing node via the CLI ... There, I can setup additional nodes"):
      // the new release's installer, which the update named in state.json, plans and sets them up
      if (r.ok && (deps.ask || process.stdin.isTTY) && (nodeOf(home).state || {}).network !== 'mainnet') {
        const ask = deps.ask || (async (q) => { const { createInterface } = await import('node:readline/promises'); const rl = createInterface({ input: process.stdin, output: process.stdout }); const x = await rl.question(q); rl.close(); return x; });
        const more = String(await ask('Add more nodes on this machine (testnet4)? How many (Enter: none): ')).trim();
        if (/^[1-9]\d*$/.test(more)) {
          const rel = ((nodeOf(home).state || {}).release || {}).path;
          const bin = rel ? join(rel, 'packages', 'arena-installer', 'bin', 'arena-install.mjs') : fileURLToPath(new URL('../bin/arena-install.mjs', import.meta.url));
          if (deps.runInstaller) return deps.runInstaller(['--home', home, '--add-nodes', more]);
          return new Promise((ok) => { const c = spawn(process.execPath, [bin, '--home', home, '--add-nodes', more], { stdio: 'inherit', env: process.env }); c.on('exit', (code) => ok(code ?? 0)); c.on('error', () => ok(1)); });
        }
      }
      return r.ok ? 0 : 1;
    }
    case 'auto-update': {
      // THE SERVICE: a check every 30 minutes; it ends after an update, and its service starts it again from the new release
      const { runAutoUpdate } = await import('./auto-update.js');
      if (!deps.latest) { io.err('this command reads no release list (run it from a release)'); return 1; }
      await runAutoUpdate({ home, latest: deps.latest, trace: log });
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
      // its "Owner area" opens the site's owner page: signed in once first (2026-10-26: "It works via owner page but not Open Dashboard")
      await signInOnce(home, deps, io);
      io.out(url);
      if (!deps.noOpen) await (deps.openUrl || openUrl)(url, deps.platform);
      return 0;
    }
    // THE OWNER PAGE ON THE ARENA SITE (kanban #687, the owner's playtest 2026-10-26 on 1.9.7: "the owner page still points to
    // http://127.0.0.1:8770/dashboard/owner which doesn't have my secret"): the installer hands the owner key to the site's page, kept there
    // per node key; the local page keeps a login per address and had none. The site finds the node by its key, else at local=
    case 'open': {
      const url = await ownerUrlOf(home, deps);
      // THE KEY HANDED OVER ONCE (the owner's playtest 2026-10-26 on 2026.1.9.8, a node from 1.9.7: the site's page asked for the 24 words):
      // until this node's key was handed to the site's page (or with --sign-in), a one-time page on 127.0.0.1 opens it and posts it the key
      if (await signInOnce(home, deps, io, { force: args.includes('--sign-in') })) { io.out(url); return 0; }
      io.out(url);
      if (!deps.noOpen) await (deps.openUrl || openUrl)(url, deps.platform);
      return 0;
    }
    // AFTER AN UPDATE THE DESKTOP APPS RAN (2026-10-26, "The updater MUST fix my credentials in the browser"): the key handed over once, if
    // it never was; nothing opens when it was
    // EVERY NODE ON THIS MACHINE (kanban #713, 2026-10-26: "The App shows the status of ALL OF OUR nodes in a grid with links to all owners
    // dashboards"): one line each - or JSON for the desktop apps - with whether it answers on its port
    case 'nodes': {
      const { nodesHere, liveNodes } = await import('./machine-nodes.js');
      const list = await liveNodes(nodesHere({ platform: deps.platform, env: deps.env, extra: [home] }), { fetcher: deps.fetch || fetch });
      if (args.includes('--json')) { io.out(JSON.stringify(list.map((n) => ({ ...n, dashboard: n.port ? `http://127.0.0.1:${n.port}/dashboard` : null,
        owner: n.key ? `${OWNER_SITE}#node=${n.key}${n.port ? `&local=${encodeURIComponent(`http://127.0.0.1:${n.port}`)}` : ''}` : null })))); return 0; }
      if (!list.length) { io.out('No Bitcoin Arena node is set up on this machine.'); return 1; }
      for (const n of list) io.out(`${n.running ? '●' : '○'} ${pad(n.running ? 'running' : 'stopped', 8)} ${pad(n.version || '?', 12)} ${pad(n.instance || '-', 6)} port ${pad(n.port || '-', 6)} ${n.home}`);
      return 0;
    }
    // MORE NODES ON THIS MACHINE (kanban #713, testnet only): the installer's --add-nodes, which plans them and runs each one's setup in turn
    case 'add-nodes': {
      const count = a;
      if (!/^\d+$/.test(String(count || ''))) { io.err(`${name} add-nodes <how many> [--ram | --no-ram]`); return 2; }
      const bin = fileURLToPath(new URL('../bin/arena-install.mjs', import.meta.url));
      const extra = ['--ram', '--no-ram', '--tunnel', '--local'].filter((f) => args.includes(f));
      if (deps.runInstaller) return deps.runInstaller(['--home', home, '--add-nodes', String(count), ...extra]);
      return new Promise((ok) => {
        const c = spawn(process.execPath, [bin, '--home', home, '--add-nodes', String(count), ...extra], { stdio: 'inherit', env: process.env });
        c.on('exit', (code) => ok(code ?? 0)); c.on('error', (e) => { io.err(e.message); ok(1); });
      });
    }
    // EVERY OWNER PAGE SIGNED IN AT ONCE (kanban #713, 2026-10-26: "You need to store credentials for *all* owner pages where its needed and
    // provide links"): one hand-over page carries every node's owner key to the site's page, which keeps each under its node; the links
    // to every owner page printed here and listed on that page
    case 'sign-in-all': {
      const { nodesHere } = await import('./machine-nodes.js');
      const { allOwnerKeys } = await import('./owner-handoff.js');
      const all = allOwnerKeys(nodesHere({ platform: deps.platform, env: deps.env, extra: [home] }), OWNER_SITE);
      if (!all.links.length) { io.out('No node here has an owner key the owner page takes (none set up with 24 words or a Nostr key).'); return 1; }
      if (!deps.noOpen) {
        const h = await (deps.handoff || startHandoff)({ home, target: `${all.links[0].url}&owner-handoff`, all: true });
        if (h) { io.out(`Signing you in on ${all.links.length} owner page(s) at once: ${h}`); await (deps.openUrl || openUrl)(h, deps.platform); }
        else io.out('The sign-in page did not start; the links still work, each asks for its node\'s words.');
      }
      for (const l of all.links) io.out(`${l.label}: ${l.url}`);
      return 0;
    }
    case 'sign-in-once': {
      const h = await signInOnce(home, deps, io);
      if (!h) io.out('Your owner page has your key already, or this node has none to hand over.');
      return 0;
    }
    default:
      io.err(`No command "${cmd}".\n`); io.err(HELP(name)); return 2;
  }
}

