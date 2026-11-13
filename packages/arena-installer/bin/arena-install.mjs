#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER: start it, open the link it prints, finish in the browser.
//
//     arena-install [--tunnel] [--port 7800] [--seat-port 8470] [--home ~/.bitcoinarena]
//     arena-install --update <arena-node-<version>-<os>-<arch>.tar.gz> [--home ~/.bitcoinarena] [--allow-older]
//     arena-install --update-self [--home ~/.bitcoinarena]   (the node to this release, when it is newer: the desktop app)
//     arena-install --add-bond <sats> [--yes] [--home ~/.bitcoinarena]
//     arena-install --rebond <sats> [--yes] [--home ~/.bitcoinarena]
//     arena-install --join-federation <invite code> [--home ~/.bitcoinarena]
//     arena-install --add-custody [--home ~/.bitcoinarena]
//
// --tunnel     open a Cloudflare quick tunnel (no account) and print its https link instead - by itself in a remote session (ssh, or
//              Linux without a display: session.js)
// --local      the 127.0.0.1 link even in a remote session (an ssh port forward)
// --port       the wizard's local port (127.0.0.1 only)
// --seat-port  the node's port for connections from outside (8470, ruling 7)
// --home       where the node lives (ARENA_HOME; ~/.bitcoinarena by default, ~/.arena-node for a node installed before 2026.1.9.8)
// --update     update this node to a downloaded release: SHA256SUMS and SHA256SUMS.sig beside the asset are checked against the Arena
//              release key, the asset unpacked into <home>/releases/, the node backed up, moved and checked - rolled back if it fails
// --add-bond   add <sats> to the bond as a second bond output beside the first, counted with it (the default way to raise a bond,
//              add-bond.js). Without --yes it only shows the plan.
// --rebond     a larger bond in one step, once the posted bond's lock has ended: that bond and the wallet's coins become a new bond
//              of <sats> with a new lock (rebond.js). Without --yes it only shows the plan.
// --add-custody  custody for a node installed without it: the wizard opens again at its roles step with custody chosen and shows the
//              custody steps (Lightning, federation, the bond's rules); the posted bond's advertisement is updated, no second bond
// --join-federation  the node's gateway (set up in the wizard's Lightning step) joins a federation by its invite code (gateway.js)
// --machine-name  this machine's name for the health page's machines (kanban #621); asked at a console when --instances is over 1
// --verbose    (-v) each step said in this terminal as it runs: the addresses, files, services and ports it checks, what answered, how long
// --debug      that and the insides: full errors, the status and start of a failed answer, every program it runs with its exit code (kanban #693)
// --instances  how many nodes on this machine, 1 by default (testnet4 only; kanban #596): each its own seed, owner key and bond, in
//              <home>-b, -c, ... with its ports 100 apart (instance.js); from 10 they found their own federation. With more than 5:
//              --ram / --no-ram puts Fedimint on a RAM disk or not; neither given, the console asks "Enable RAM disk for Fedimint? [Y/n]"
//
// The release root is two directories up from this file's package (release/packages/arena-installer/bin).
import { port as offsetPort, INSTANCE, PORT_OFFSET } from '../src/instance.js';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { existsSync as fileExists } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { createWizard } from '../src/wizard.js';
import { nodeServiceWords } from '../src/service.js';
import { nodeState, defaultHome } from '../src/state.js';
import { openQuickTunnel } from '../src/tunnel.js';
import { setupLinkMode } from '../src/session.js';
import { levelFlags, levelOf, createLog, traceRuntime } from '../../arena-node/src/log-level.js';

// HOW MUCH IT SAYS (kanban #693, 2026-10-26: "add a --debug and --verbose flag that shows more info on what its doing, what is going wrong
// etc"): the flags taken out first, the level's lines on stderr; without them the installer prints what it always printed
const flags = levelFlags(process.argv.slice(2));
if (flags.bad) { console.error(flags.bad); process.exit(2); }
const args = flags.rest;
// --help / -h: this file's usage above, nothing started (feedback #021, kanban #2570: "./arena-install --help prints no usage. It starts the setup server")
if (args.includes('--help') || args.includes('-h')) {
  const { readFileSync } = await import('node:fs');
  const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const from = head.findIndex((l) => /^\/\/ THE INSTALLER/.test(l)), to = head.findIndex((l, i) => i > from && /^\/\/ The release root/.test(l));
  console.log(head.slice(from, to > from ? to : undefined).map((l) => l.replace(/^\/\/ ?/, '')).join('\n').trimEnd());
  process.exit(0);
}
const level = levelOf({ flag: flags.level, env: process.env });
if (level.bad) console.error(level.bad);
const log = createLog({ level: level.level });
traceRuntime(log);
log.tag('install').verbose(`log level ${level.level} (${level.from})`);
log.tag('install').env(['ARENA_HOME', 'ARENA_INSTANCE', 'ARENA_PORT_OFFSET', 'ARENA_CLOUDFLARED', 'ARENA_TAILSCALE', 'ARENA_NO_BROWSER', 'DISPLAY', 'WAYLAND_DISPLAY', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'],
  'the settings it reads from its environment (the home and ports, its programs, whether a browser opens, a remote session)');
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('--port', offsetPort(7800)));   // + ARENA_PORT_OFFSET (instance.js)
const seatPort = Number(opt('--seat-port', offsetPort(8470)));   // + ARENA_PORT_OFFSET: a second node's seat on its own port (measured: 8470 was the first's)
const bridgePort = Number(opt('--bridge-port', offsetPort(8471)));
const home = resolve(opt('--home', defaultHome()));
const release = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const state = nodeState(home);
// the release's own (the launcher sets ARENA_CLOUDFLARED), else the one beside this release, else PATH (kanban #765, measured in the Linux
// VM 2026-10-28: an installer started without the launcher wrote a second node's tunnel unit as a bare `cloudflared` - 203/EXEC on every
// start, "the quick tunnel gave no name")
const cloudflared = process.env.ARENA_CLOUDFLARED
  || [join(release, 'runtime', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')].find((f) => fileExists(f)) || 'cloudflared';

// THE END OF A COMMAND THAT TALKED TO THE NETWORK OR RAN PROGRAMS: process.exit after 1.5 s, so the handles still closing close first
// (measured in the Windows VM, rc.21 --update: after "Updated: ... the same node answers", an immediate process.exit aborted on
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76"). Awaited: nothing after the command runs.
const finish = (code) => new Promise(() => { setTimeout(() => process.exit(code), 1500); });

// MORE NODES, ASKED AT A CONSOLE (kanban #713, 2026-10-26: "When I update an existing node via the CLI ... There, I can setup additional
// nodes" - "If I execute the installer without updating the version, there is the option to Add Nodes"): after an update and on a node
// that is set up, a console asks how many more; testnet4 only. The answer runs this installer again with --add-nodes; 0 or Enter: none.
async function askMoreNodes() {
  const s = state.read();
  if (!process.stdin.isTTY || !(s.done && s.done.service) || (s.network && s.network !== 'testnet4') || args.includes('--from-home')) return 0;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('Add more nodes on this machine (testnet4)? How many (Enter: none): ')).trim(); rl.close();
  return /^\d+$/.test(a) ? Number(a) : 0;
}
const addMoreNodes = (n) => new Promise((ok) => {
  const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--home', home, '--add-nodes', String(n), ...['--ram', '--no-ram', '--tunnel', '--local'].filter((f) => args.includes(f))],
    { stdio: 'inherit', env: process.env });
  c.on('exit', (code) => ok(code ?? 0)); c.on('error', () => ok(1));
});

// THE APP'S OWN RELEASE OVER AN OLDER NODE (the owner's playtest 2026-10-25: "When I execute 2.9.2 it doesn't update the node, it just
// starts the 1.9.1"): `--update-self` moves the installed node to the release this installer runs from - the one the app copied out of
// itself - when it is newer than the node's; the same update as --update (update.js), without a download to check (the release is here)
if (args.includes('--update-self')) {
  const { updateNode } = await import('../src/update.js');
  const { newerVersion } = await import('../../arena-node/src/release-latest.js');
  const { readFileSync, existsSync } = await import('node:fs');
  const s = state.read();
  const versionOf = (dir) => { try { return readFileSync(`${dir}/VERSION`, 'utf8').trim(); } catch { return null; } };
  const from = s.release && s.release.path;
  const have = from ? versionOf(from) : null, mine = versionOf(release);
  if (!s.service) { console.log('Not updated: no node is installed here'); await finish(1); }
  else if (from === release || !mine || (have && !newerVersion(mine, have))) {
    console.log(`Up to date: the node runs ${have || from || 'this release'}`);
    const more = await askMoreNodes();
    await finish(more ? await addMoreNodes(more) : 0);
  }
  else {
    const { installUpdater, updaterLauncherStale } = await import('../src/launchers.js');
    const { installProgram } = await import('../src/service.js');
    const { serviceFile } = await import('../src/node-services.js');
    const installUpdaterFn = async (o) => { const file = serviceFile('updater', { home, platform: process.platform, env: process.env });
      return existsSync(file) && !updaterLauncherStale(file) ? { ok: true, already: true } : installUpdater({ ...o, installProgram }); };
    // its progress, one line per step (the desktop apps read them, update-progress.js); redrawn in place in a terminal
    const { progressBar } = await import('../src/update-progress.js');
    const r = await updateNode({ home, newRelease: release, port: (s.reach && s.reach.port) || (s.service && s.service.port) || seatPort,
      node: `${release}/runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`, installUpdaterFn, trace: log, progress: progressBar({ tty: !!process.stdout.isTTY }).report });
    console.log(r.ok ? `Updated: ${have || r.from} -> ${mine}; the same node answers (${r.identity.slice(0, 16)}...)`
      : `${r.rolledBack ? 'Rolled back' : 'Not updated'}: ${r.why}`);
    // then more nodes, at a console (kanban #713); the desktop apps offer it in their own window
    const more = r.ok ? await askMoreNodes() : 0;
    await finish(more ? await addMoreNodes(more) : r.ok ? 0 : 1);
  }
}

// AN UPDATE: checked, unpacked beside the running release, the node moved to it (update.js)
if (args.includes('--update')) {
  const { updateNode } = await import('../src/update.js');
  const { checkAsset } = await import('../src/release-verify.js');
  const { readFileSync, mkdirSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const asset = resolve(opt('--update', ''));
  const at = dirname(asset);
  let sums, sig;
  try { sums = readFileSync(`${at}/SHA256SUMS`); sig = readFileSync(`${at}/SHA256SUMS.sig`, 'utf8'); }
  catch { console.error(`SHA256SUMS and SHA256SUMS.sig belong beside ${asset} (download them from the same release)`); process.exit(2); }
  const { progressBar, within } = await import('../src/update-progress.js');
  const bar = progressBar({ tty: !!process.stdout.isTTY });
  bar.report({ pct: 0, step: 'Checking the signature' });
  const c = checkAsset({ file: asset, sums, sig });
  log.tag('update').verbose(`${asset}: SHA256SUMS and its signature beside it against the Arena release key: ${c.ok ? 'ok' : c.why}`);
  if (!c.ok) { bar.report({ failed: true, pct: 0, step: 'Checking the signature', why: c.why }); console.error(`Refused: ${c.why}`); process.exit(2); }
  const name = asset.split(/[\\/]/).pop().replace(/\.(tar\.gz|zip)$/, '');
  const dir = `${home}/releases`;
  mkdirSync(dir, { recursive: true });
  // the Windows asset is a .zip: Windows 10+ has tar (bsdtar), which reads zip too
  bar.report({ pct: 3, step: 'Unpacking', detail: name });
  if (!existsSync(`${dir}/${name}`)) execFileSync('tar', [asset.endsWith('.zip') ? '-xf' : '-xzf', asset, '-C', dir]);
  const s = state.read();
  // the auto update service for a node that has none yet
  const { installUpdater } = await import('../src/launchers.js');
  const { installProgram } = await import('../src/service.js');
  const { serviceFile } = await import('../src/node-services.js');
  const { updaterLauncherStale } = await import('../src/launchers.js');
  const installUpdaterFn = async (o) => { const file = serviceFile('updater', { home, platform: process.platform, env: process.env });
    return existsSync(file) && !updaterLauncherStale(file) ? { ok: true, already: true } : installUpdater({ ...o, installProgram }); };
  const r = await updateNode({ home, newRelease: `${dir}/${name}`, port: (s.reach && s.reach.port) || (s.service && s.service.port) || seatPort,
    node: `${dir}/${name}/runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`, installUpdaterFn, trace: log, progress: within(bar.report, 10, 100),
    allowOlder: args.includes('--allow-older') });   // #2601: an older signed release only when the owner says so
  console.log(r.ok ? `Updated: ${r.from} -> ${r.to}; the same node answers (${r.identity.slice(0, 16)}...). Backup: ${r.backup}${r.notStarted ? `\nNot running: ${r.notStarted}` : ''}`
    : `${r.rolledBack ? 'Rolled back' : 'Not updated'}: ${r.why}${r.backup ? ` (backup ${r.backup})` : ''}`);
  await finish(r.ok ? 0 : 1);
}

// ADD TO BOND (kanban #544): a second bond output beside the first, counted with it - the plan, then with --yes the broadcast
if (args.includes('--add-bond')) {
  const { addBondOnNode } = await import('../src/add-bond.js');
  const r = await addBondOnNode({ state, release, addSats: opt('--add-bond', ''), post: args.includes('--yes') });
  if (!r.ok) { console.error(`Not possible: ${r.why}`); process.exit(1); }
  const p = r.plan;
  console.log(`Add ${Number(p.addSats).toLocaleString('en-US')} sat to the bond: a second output beside ${p.outputs.map((o) => `${o.txid.slice(0, 16)}...:${o.vout} (${Number(o.sats).toLocaleString('en-US')} sat)`).join(', ')}, which stay as they are.`
    + `\nThe bond becomes ${Number(p.totalSats).toLocaleString('en-US')} sat (now ${Number(p.bondSats).toLocaleString('en-US')} sat).`
    + `\nFees ${p.fees.funding} + ${p.fees.bond} = ${p.fees.total} sat${p.changeSats !== '0' ? `, ${p.changeSats} sat back to the wallet` : ''}.`
    + `\nThe added output is locked until block ${p.maturity} (${p.lock.blocks} blocks, about ${new Date(p.lock.estimatedMs).toUTCString()}) and counts after ${p.countsAfter} confirmations.`);
  console.log(r.bond ? `Posted: the added bond output is ${r.bond.txid}:0 (funding ${r.bond.fundingTxid}).` : 'Nothing sent. Run again with --yes to post it.');
  await finish(0);
}

// A LARGER BOND: the plan, then with --yes the broadcast
if (args.includes('--rebond')) {
  const { rebond } = await import('../src/rebond.js');
  const { readFileSync } = await import('node:fs');
  const { sha256 } = await import('../../arena-protocol/src/hash.js');
  let softwareHash; try { softwareHash = sha256(readFileSync(`${release}/COMMIT`)); } catch { softwareHash = new Uint8Array(32); }
  const { guardianSetupOf } = await import('../src/state.js');
  const r = await rebond({ state, bondSats: opt('--rebond', ''), post: args.includes('--yes'), softwareHash,
    guardianEndpoint: (guardianSetupOf(state.read(), { release }) || {}).endpoint || null });
  if (!r.ok) { console.error(`Not possible: ${r.why}`); process.exit(1); }
  const p = r.plan;
  console.log(`The bond of ${p.from.sats} sat (${p.from.txid}, free since block ${p.from.maturity})${p.coins.length ? ` and ${p.coins.reduce((a, c) => a + c.sats, 0)} sat from the wallet` : ''}`
    + `\nbecome a bond of ${p.bondSats} sat, locked until block ${p.maturity} (${p.lock.blocks} blocks, about ${new Date(p.lock.estimatedMs).toUTCString()}).`
    + `\nFees ${p.fees.funding} + ${p.fees.bond} sat${p.changeSats !== '0' ? `, ${p.changeSats} sat back to the wallet` : ''}.`);
  console.log(r.bond ? `Posted: the new bond is ${r.bond.txid}:0.` : 'Nothing sent. Run again with --yes to post it.');
  await finish(0);
}

// A FEDERATION FOR THE GATEWAY (ruling 3: by invite)
if (args.includes('--join-federation')) {
  const { joinFederation, testGateway } = await import('../src/gateway.js');
  const g = state.read().gateway;
  if (!g) { console.error('Not possible: this node has no gateway - set it up in the wizard\'s Lightning step'); process.exit(1); }
  const j = await joinFederation({ ...g, invite: opt('--join-federation', '') });
  if (!j.ok) { console.error(`Not joined: ${j.why}`); process.exit(1); }
  const t = await testGateway(g);
  if (t.ok) state.save({ gateway: { ...state.read().gateway, federations: t.federations } });
  console.log(`Joined ${j.federationId}. The gateway serves: ${t.ok ? t.federations.map((f) => f.name || f.federationId).join(', ') : '(its list could not be read now)'}`);
  await finish(0);
}

// MORE NODES ON A MACHINE THAT HAS SOME (kanban #713, 2026-10-26: "There, I can setup additional nodes (with the ramdisk option). This runs
// the steps that we already do run" - testnet only): the further nodes planned from this installed node (machine-nodes.js addNodesPlan),
// kept in its state as the count's plan, and the first one's wizard started here - each one starts the next when it is done, as a count's
// do; each takes this node's chain, roles and apps and is funded from its wallet (prefillFrom, fundFrom). The RAM disk: --ram / --no-ram,
// asked at a console from six nodes in all, else as a count's default
if (args.includes('--add-nodes')) {
  const { nodesHere, addNodesPlan } = await import('../src/machine-nodes.js');
  const { RAM_FROM, RAM_QUESTION, ramAnswer } = await import('../src/instances.js');
  const s = state.read();
  if (!(s.done && s.done.service)) { console.error(`No node is set up in ${home} yet: install it first, then add more.`); process.exit(1); }
  const here = nodesHere({ extra: [home] });
  const base = here.find((x) => x.home === home) || here[0];
  const ordered = [base, ...here.filter((x) => x !== base)];
  const plan = addNodesPlan(ordered, opt('--add-nodes', '1'));
  if (!plan.ok) { console.error(plan.why); process.exit(1); }
  const total = here.length + plan.nodes.length;
  let ram = args.includes('--no-ram') ? false : args.includes('--ram') ? true : undefined;
  if (ram === undefined && total >= RAM_FROM) {
    if (process.stdin.isTTY) {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      ram = ramAnswer(await rl.question(RAM_QUESTION)); rl.close();
    } else ram = true;
  }
  const was = s.instances || {};
  state.save({ instances: { ...was, count: total, ram: ram === undefined ? !!was.ram : ram, first: was.first || { instance: INSTANCE, portOffset: PORT_OFFSET }, adding: plan.nodes } });
  console.log(`${here.length} node(s) on this machine; adding ${plan.nodes.length}: ${plan.nodes.map((x) => `${x.home} (instance ${x.instance}, ports +${x.portOffset})`).join(', ')}${ram ? '. Fedimint on a RAM disk.' : ''}`);
  const first = plan.nodes[0];
  const pass = [...['--tunnel', '--local'].filter((f) => args.includes(f)), ...(flags.level ? [`--${flags.level}`] : [])];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--home', first.home, '--instance', first.instance, '--port-offset', String(first.portOffset),
    '--from-home', home, '--node-of', String(here.length + 1), ...pass], { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code ?? 0));
  await new Promise(() => {});   // the further nodes' wizards run in the child; this one only waits for it
}

// A PLAIN RUN ON A NODE THAT IS SET UP (kanban #713): "Add more nodes?" first; none, and the setup page opens as before
if (!['--add-nodes', '--instances', '--add-custody'].some((f) => args.includes(f))) {
  const more = await askMoreNodes();
  if (more) await finish(await addMoreNodes(more));
}

// HOW MANY NODES (kanban #596): the count checked, the RAM disk asked from more than 5 when not given, both kept for the wizard
if (args.includes('--instances')) {
  const { instancesChoice, instancesNote, RAM_FROM, RAM_QUESTION, ramAnswer } = await import('../src/instances.js');
  const count = Number(opt('--instances', '1'));
  let ram = args.includes('--no-ram') ? false : args.includes('--ram') ? true : undefined;
  if (ram === undefined && count >= RAM_FROM) {
    if (process.stdin.isTTY) {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      ram = ramAnswer(await rl.question(RAM_QUESTION)); rl.close();
    } else { ram = true; console.log(`${RAM_QUESTION}yes (the default; no console to ask)`); }
  }
  // THE MACHINE'S NAME (kanban #621): --machine-name, else asked at a console when more than one node is installed
  let name = opt('--machine-name', '');
  if (!name && count > 1 && process.stdin.isTTY) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    name = await rl.question('A name for this machine, shown in the health page (empty: none): '); rl.close();
  }
  const c = instancesChoice({ count, ram, name, network: 'testnet4' });
  if (!c.ok) { console.error(c.why); process.exit(1); }
  state.save({ instances: { count: c.count, ram: c.ram, name: c.name, first: { instance: INSTANCE, portOffset: PORT_OFFSET } } });   // node 1's name and ports: the further nodes' come from them
  const note = instancesNote(c.count);
  if (note) console.log(note + (c.ram ? ' Fedimint on a RAM disk.' : ''));
}

// A FURTHER NODE OF A COUNT (kanban #596): started by the node before it with --from-home, it takes over that node's first choices
const fromHome = opt('--from-home', '');
if (fromHome) {
  const { prefillFrom } = await import('../src/instances.js');
  const r = prefillFrom(nodeState(resolve(fromHome)), state);
  const plan = nodeState(resolve(fromHome)).read().instances || {};
  console.log(`\nNode ${opt('--node-of', '?')} of ${plan.count || '?'} on this machine, in ${home}` + (r.ok ? ` (its Bitcoin source, roles and apps as the first node's)` : ` (${r.why})`));
}

if (args.includes('--add-custody')) {
  const { beginAddCustody } = await import('../src/wizard.js');
  const r = beginAddCustody(state);
  if (!r.ok) { console.error(r.why); process.exit(1); }
}

// THE APPS (kanban #575): the release carries only their pins; each is downloaded from its repository and checked before the wizard
// lists them (app-fetch.js, the same the seat's start runs). An app that cannot be fetched stops here, with why.
{
  const { ensureApps } = await import('../../arena-node/src/app-fetch.js');
  const apps = await ensureApps({ release, home, log: (l) => console.log(l) });
  if (!apps.ok) { console.error(`The apps could not be downloaded: ${apps.why}\nCheck this computer's internet connection and start arena-install again.`); process.exit(1); }
}

let tunnel = null, server = null;
const wizard = createWizard({ state, release, seatPort, bridgePort, cloudflared, log: (l) => console.log(l), trace: log,
  fundFrom: fromHome ? nodeState(resolve(fromHome)) : null,   // kanban #596: a further node's deposit paid from node 1's wallet
  onDone: () => {
  // the public address when the node has one (2026-10-18: "Always show the public address and not 127.0.0.1 when it's not localhost only")
  const pub = (state.read().reach || {}).url;
  // its own service's name and the owner page's own spelling (the 2026.1.9.11 install test, kanban #704: "user service arena-node" on a macOS, and
  // /Dashboard/owner with a capital D)
  console.log(`\nDone. Your node runs as ${nodeServiceWords()}.\nIts owner page: ${pub || `http://127.0.0.1:${seatPort}`}/dashboard/owner${pub ? '' : ' (this machine only)'}`);
  const l = state.read().launchers;
  if (l && l.command && l.command.name) console.log(`On the command line: ${l.command.name} status | doctor | restart <service> | logs | config${l.command.note ? ` (${l.command.note})` : ''}`);
  if (l) console.log(`To start it again: ${l.app ? `open "Bitcoin Arena" in Applications (${l.app})` : l.menu && /Start Menu/.test(l.menu) ? 'Start menu > Bitcoin Arena' : 'Bitcoin Arena in your desktop menu'}, or run ${l.start}`);
  if (tunnel) tunnel.close();
  server.close();
  // THE NEXT NODE OF A COUNT (kanban #596): its own wizard, in its own home with its own instance and ports, started here
  import('../src/instances.js').then(({ nextInstance }) => {
    const base = resolve(fromHome || home), plan = nodeState(base).read().instances || { count: 1 };
    const next = nextInstance(plan.count, base, home, plan.first || {}, plan.adding || null);
    if (!next) { setTimeout(() => process.exit(0), 300); return; }
    console.log(`\nNext: node ${next.index} of ${next.count} (instance ${next.instance}, ports +${next.portOffset}).`);
    const pass = [...['--tunnel', '--local'].filter((f) => args.includes(f)), ...(flags.level ? [`--${flags.level}`] : [])];
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--home', next.home, '--instance', next.instance, '--port-offset', String(next.portOffset),
      '--from-home', base, '--node-of', String(next.index), ...pass], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => process.exit(code ?? 0));
  });
} });

// THE TUNNEL ENDS WITH THE INSTALLER (measured on the test host: an installer ended by a signal left its cloudflared running,
// holding a public link to nothing): Ctrl-C, a closed ssh session (SIGHUP) or a kill close the tunnel first
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { if (tunnel && tunnel.close) tunnel.close(); } catch { /* ending anyway */ } process.exit(130); });

server = http.createServer((req, res) => wizard.handle(req, res));
// THE SETUP PORT TAKEN (kanban #762: a second installer, or the "add more nodes" child of one still open, threw an
// unhandled EADDRINUSE): say which port and what most likely holds it, then end without a stack trace
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\nPort ${port} on this machine is already in use, most likely by another Bitcoin Arena setup that is still running.`
      + `\nFinish or stop that setup first (Ctrl-C in its terminal), then run this one again. (--port <n> picks another setup port.)`);
    process.exit(1);
  }
  throw e;
});
server.listen(port, '127.0.0.1', async () => {
  const local = `http://127.0.0.1:${port}/?t=${wizard.token}`;
  log.tag('install').verbose(`the setup page listens on 127.0.0.1:${port} (--port, else 7800${port !== 7800 ? ' + this node\'s port offset' : ''}); the node's seat will be on port ${seatPort}, its home ${home}`);
  console.log(`Bitcoin Arena setup (testnet4). Node home: ${home}`);
  // A REMOTE SESSION: an ssh login or a Linux machine without a display gets no window and no browser here - the setup
  // page through a temporary Cloudflare link, to open on a phone or laptop (session.js); --local keeps the 127.0.0.1 link
  const mode = setupLinkMode(args);
  log.tag('install').verbose(`the setup link: ${mode.tunnel ? `through a Cloudflare quick tunnel (${mode.why})` : 'on this machine (127.0.0.1)'}`);
  if (mode.tunnel) {
    if (mode.why !== '--tunnel') console.log(`\n${mode.why[0].toUpperCase()}${mode.why.slice(1)}, so the setup page opens on another device: through a temporary Cloudflare link (no account, nothing to set up). Open it on your phone or laptop; this terminal shows each step's progress. Keep this session open until the page says Done (or run the installer in tmux or screen). (--local keeps a link for this machine only.)\n`);
    console.log('Opening a Cloudflare quick tunnel (no account)...');
    tunnel = await openQuickTunnel({ port, bin: cloudflared });
    if (!tunnel.ok) { console.error(`No tunnel: ${tunnel.why}`); process.exit(1); }
    wizard.allowHost(new URL(tunnel.url).host);
    tunnel.onEdgeTrouble?.((hint) => console.error(`\nThe tunnel link may not answer: ${hint}\n`));   // kanban #2570
    console.log(`\nOpen this link in your browser (it works once and for 30 minutes):\n\n  ${tunnel.url}/?t=${wizard.token}\n`);
  } else {
    console.log(`\nOpen this link in your browser (it works once and for 30 minutes):\n\n  ${local}\n`);
    // a desktop: open it there; a server without one: the link above. A launcher that opens the link itself (the test host app, the Windows
    // window, the Linux setup) sets ARENA_NO_BROWSER=1 (kanban #635, the owner's playtest 2026-10-25: "It opens two browser windows, one
    // that works and one that doesn't" - the second came with the link the first had used)
    if (process.env.ARENA_NO_BROWSER !== '1' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform !== 'linux')) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      execFile(cmd, [local], () => {});
    }
  }
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (tunnel && tunnel.close) tunnel.close(); process.exit(130); });
