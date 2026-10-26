#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The bitcoinarena command: the installer writes a small script that runs this with the node's home, so the user types only
// `bitcoinarena status`, `bitcoinarena restart lnd`, `bitcoinarena doctor` (src/bitcoinarena.js). Until 2026.1.9.8 it was arenanode
// (kanban #688): bin/arenanode.mjs runs this file, and <home>/bin/arenanode runs <home>/bin/bitcoinarena (launchers.js writeCommand).
// --verbose (-v) and --debug anywhere on the line (kanban #693, 2026-10-26: "add a --debug and --verbose flag that shows more info on what
// its doing, what is going wrong etc"): taken out before the command is read; their lines go to stderr, so what a command prints stays as it was
const { levelFlags, levelOf, createLog, traceRuntime } = await import('../../arena-node/src/log-level.js');
const flags = levelFlags(process.argv.slice(2));
if (flags.bad) { console.error(flags.bad); process.exit(2); }
const args = flags.rest;
const at = args.indexOf('--home');
const home = at >= 0 ? args[at + 1] : null;
const name = (() => { const i = args.indexOf('--name'); return i >= 0 ? args[i + 1] : 'bitcoinarena'; })();
// only a --home that is there takes its two places (measured 2026-10-26, kanban #663: without one, `arenanode update` dropped "update"
// as the place after --home's -1 and showed the status instead)
const rest = args.filter((_, i) => !(at >= 0 && (i === at || i === at + 1)) && !(args[i] === '--name' || args[i - 1] === '--name'));
// the home's arena.conf names this node's instance: instance.js reads it from --home before the service names are made
const { main } = await import('../src/bitcoinarena.js');
const { defaultHome } = await import('../src/state.js');
const { latestReleaseReader, latestUrlFrom } = await import('../../arena-node/src/release-latest.js');
const { sumsSigned } = await import('../src/release-verify.js');
// the update source: production, or a test channel on the Arena testnet site named by ARENA_LATEST_URL or arena.conf latest_url (#546)
let conf = {};
try { const { readFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { parseConf } = await import('../../arena-node/src/arena-conf.js');
  conf = parseConf(readFileSync(join(home || defaultHome(), 'arena.conf'), 'utf8')).values || {}; } catch { conf = {}; }
// THE LEVEL: the flag, else ARENA_LOG_LEVEL, else - for the auto update service only, which runs this command - arena.conf log_level
const service = rest[0] === 'auto-update';
const lv = levelOf({ flag: flags.level, env: process.env, conf: service ? conf : null });
const log = createLog({ level: lv.level, write: service ? (l) => console.log(`${new Date().toISOString()} ${l}`) : undefined });
if (lv.bad) console.error(lv.bad);
traceRuntime(log, service ? { fetch: lv.level === 'debug' ? 'all' : lv.level === 'verbose' ? 'failed' : null } : {});
log.tag('bitcoinarena').verbose(`log level ${lv.level} (${lv.from})`);
log.tag('bitcoinarena').env(['ARENA_HOME', 'ARENA_INSTANCE', 'ARENA_PORT_OFFSET', 'ARENA_LATEST_URL', 'ARENA_RELEASE_LATEST_URL', 'XDG_CONFIG_HOME'], 'the settings this command reads from its environment');
const source = latestUrlFrom(process.env, conf);
if (source.why && service) console.log(`[update] ${source.why}`);
log.tag('update').debug(`the release list: ${source.url || '(none: release checks are off)'}${source.why ? ` - ${source.why}` : ` - the production one (neither ARENA_LATEST_URL nor arena.conf latest_url names a test channel)`}`);
// A NODE THE OLD RELEASE'S UPDATE MOVED HERE (kanban #688): its <home>/bin/arenanode is the full command, naming this release, and
// <home>/bin/bitcoinarena is missing - both are written now, once, from this release (launchers.js ensureCommand). Only from a release
// (its VERSION at the root), never from a checkout
if (home) {
  const { existsSync } = await import('node:fs'); const { join, resolve, dirname } = await import('node:path'); const { fileURLToPath } = await import('node:url');
  const own = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  if (existsSync(join(own, 'VERSION'))) {
    const { ensureCommand } = await import('../src/launchers.js');
    const c = ensureCommand({ home, release: own });
    if (c) log.tag('bitcoinarena').verbose(c.written ? `wrote ${c.written.file} and the old name ${c.written.legacy.file} for this release` : `the command was not written again: ${c.why}`);
  }
}
const reader = latestReleaseReader({ url: source.url, verify: sumsSigned });
const code = await main(rest, { home: home || defaultHome(), name, log, deps: { latest: (own) => reader.read(own) } });
// handles still closing close first (arena-install.mjs measured a libuv abort on Windows at an immediate exit)
setTimeout(() => process.exit(code), process.platform === 'win32' ? 1500 : 50);
