#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER: start it, open the link it prints, finish in the browser.
//
//     arena-install [--tunnel] [--port 7800] [--seat-port 8470] [--home ~/.arena-node]
//     arena-install --update <arena-node-<version>-<os>-<arch>.tar.gz> [--home ~/.arena-node]
//     arena-install --update-self [--home ~/.arena-node]   (the node to this release, when it is newer: the desktop app)
//     arena-install --add-bond <sats> [--yes] [--home ~/.arena-node]
//     arena-install --rebond <sats> [--yes] [--home ~/.arena-node]
//     arena-install --join-federation <invite code> [--home ~/.arena-node]
//     arena-install --add-custody [--home ~/.arena-node]
//
// --tunnel     open a Cloudflare quick tunnel (no account) and print its https link instead - by itself in a remote session (ssh, or
//              Linux without a display: session.js)
// --local      the 127.0.0.1 link even in a remote session (an ssh port forward)
// --port       the wizard's local port (127.0.0.1 only)
// --seat-port  the node's port for connections from outside (8470, ruling 7)
// --home       where the node lives (ARENA_HOME; ~/.arena-node by default)
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
// --instances  how many nodes on this machine, 1 by default (testnet4 only; kanban #596): each its own seed, owner key and bond, in
//              <home>-b, -c, ... with its ports 100 apart (instance.js); from 10 they found their own federation. With more than 5:
//              --ram / --no-ram puts Fedimint on a RAM disk or not; neither given, the console asks "Enable RAM disk for Fedimint? [Y/n]"
//
// The release root is two directories up from this file's package (release/packages/arena-installer/bin).
import { port as offsetPort, INSTANCE, PORT_OFFSET } from '../src/instance.js';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createWizard } from '../src/wizard.js';
import { nodeState, defaultHome } from '../src/state.js';
import { openQuickTunnel } from '../src/tunnel.js';
import { setupLinkMode } from '../src/session.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('--port', offsetPort(7800)));   // + ARENA_PORT_OFFSET (instance.js)
const seatPort = Number(opt('--seat-port', offsetPort(8470)));   // + ARENA_PORT_OFFSET: a second node's seat on its own port (measured: 8470 was the first's)
const bridgePort = Number(opt('--bridge-port', offsetPort(8471)));
const home = resolve(opt('--home', defaultHome()));
const release = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const state = nodeState(home);
const cloudflared = process.env.ARENA_CLOUDFLARED || 'cloudflared';   // the release's own (arena-install sets it), else PATH

// THE END OF A COMMAND THAT TALKED TO THE NETWORK OR RAN PROGRAMS: process.exit after 1.5 s, so the handles still closing close first
// (measured in the Windows VM, rc.21 --update: after "Updated: ... the same node answers", an immediate process.exit aborted on
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76"). Awaited: nothing after the command runs.
const finish = (code) => new Promise(() => { setTimeout(() => process.exit(code), 1500); });

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
  else if (from === release || !mine || (have && !newerVersion(mine, have))) { console.log(`Up to date: the node runs ${have || from || 'this release'}`); await finish(0); }
  else {
    const { installUpdater, updaterLauncherStale } = await import('../src/launchers.js');
    const { installProgram } = await import('../src/service.js');
    const { serviceFile } = await import('../src/node-services.js');
    const installUpdaterFn = async (o) => { const file = serviceFile('updater', { home, platform: process.platform, env: process.env });
      return existsSync(file) && !updaterLauncherStale(file) ? { ok: true, already: true } : installUpdater({ ...o, installProgram }); };
    const r = await updateNode({ home, newRelease: release, port: (s.reach && s.reach.port) || (s.service && s.service.port) || seatPort,
      node: `${release}/runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`, installUpdaterFn });
    console.log(r.ok ? `Updated: ${have || r.from} -> ${mine}; the same node answers (${r.identity.slice(0, 16)}...)`
      : `${r.rolledBack ? 'Rolled back' : 'Not updated'}: ${r.why}`);
    await finish(r.ok ? 0 : 1);
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
  const c = checkAsset({ file: asset, sums, sig });
  if (!c.ok) { console.error(`Refused: ${c.why}`); process.exit(2); }
  const name = asset.split(/[\\/]/).pop().replace(/\.(tar\.gz|zip)$/, '');
  const dir = `${home}/releases`;
  mkdirSync(dir, { recursive: true });
  // the Windows asset is a .zip: Windows 10+ has tar (bsdtar), which reads zip too
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
    node: `${dir}/${name}/runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`, installUpdaterFn });
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
const wizard = createWizard({ state, release, seatPort, bridgePort, cloudflared, log: (l) => console.log(l),
  fundFrom: fromHome ? nodeState(resolve(fromHome)) : null,   // kanban #596: a further node's deposit paid from node 1's wallet
  onDone: () => {
  // the public address when the node has one (2026-10-18: "Always show the public address and not 127.0.0.1 when it's not localhost only")
  const pub = (state.read().reach || {}).url;
  console.log(`\nDone. Your node runs as the user service arena-node.\nIts owner page: ${pub || `http://127.0.0.1:${seatPort}`}/Dashboard/owner${pub ? '' : ' (this machine only)'}`);
  const l = state.read().launchers;
  if (l && l.command && l.command.name) console.log(`On the command line: ${l.command.name} status | doctor | restart <service> | logs | config${l.command.note ? ` (${l.command.note})` : ''}`);
  if (l) console.log(`To start it again: ${l.app ? `open "Bitcoin Arena" in Applications (${l.app})` : l.menu && /Start Menu/.test(l.menu) ? 'Start menu > Bitcoin Arena' : 'Arena Node in your desktop menu'}, or run ${l.start}`);
  if (tunnel) tunnel.close();
  server.close();
  // THE NEXT NODE OF A COUNT (kanban #596): its own wizard, in its own home with its own instance and ports, started here
  import('../src/instances.js').then(({ nextInstance }) => {
    const base = resolve(fromHome || home), plan = nodeState(base).read().instances || { count: 1 };
    const next = nextInstance(plan.count, base, home, plan.first || {});
    if (!next) { setTimeout(() => process.exit(0), 300); return; }
    console.log(`\nNext: node ${next.index} of ${next.count} (instance ${next.instance}, ports +${next.portOffset}).`);
    const pass = ['--tunnel', '--local'].filter((f) => args.includes(f));
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--home', next.home, '--instance', next.instance, '--port-offset', String(next.portOffset),
      '--from-home', base, '--node-of', String(next.index), ...pass], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => process.exit(code ?? 0));
  });
} });

// THE TUNNEL ENDS WITH THE INSTALLER (measured on the test host: an installer ended by a signal left its cloudflared running,
// holding a public link to nothing): Ctrl-C, a closed ssh session (SIGHUP) or a kill close the tunnel first
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { if (tunnel && tunnel.close) tunnel.close(); } catch { /* ending anyway */ } process.exit(130); });

server = http.createServer((req, res) => wizard.handle(req, res));
server.listen(port, '127.0.0.1', async () => {
  const local = `http://127.0.0.1:${port}/?t=${wizard.token}`;
  console.log(`Bitcoin Arena setup (testnet4). Node home: ${home}`);
  // A REMOTE SESSION: an ssh login or a Linux machine without a display gets no window and no browser here - the setup
  // page through a temporary Cloudflare link, to open on a phone or laptop (session.js); --local keeps the 127.0.0.1 link
  const mode = setupLinkMode(args);
  if (mode.tunnel) {
    if (mode.why !== '--tunnel') console.log(`\n${mode.why[0].toUpperCase()}${mode.why.slice(1)}, so the setup page opens on another device: through a temporary Cloudflare link (no account, nothing to set up). Open it on your phone or laptop; this terminal shows each step's progress. Keep this session open until the page says Done (or run the installer in tmux or screen). (--local keeps a link for this machine only.)\n`);
    console.log('Opening a Cloudflare quick tunnel (no account)...');
    tunnel = await openQuickTunnel({ port, bin: cloudflared });
    if (!tunnel.ok) { console.error(`No tunnel: ${tunnel.why}`); process.exit(1); }
    wizard.allowHost(new URL(tunnel.url).host);
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
