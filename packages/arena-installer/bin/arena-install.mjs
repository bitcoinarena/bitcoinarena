#!/usr/bin/env node
// THE INSTALLER (kanban #471): start it, open the link it prints, finish in the browser.
//
//     arena-install [--tunnel] [--port 7800] [--seat-port 8470] [--home ~/.arena-node]
//     arena-install --update <arena-node-<version>-<os>-<arch>.tar.gz> [--home ~/.arena-node]
//     arena-install --rebond <sats> [--yes] [--home ~/.arena-node]
//     arena-install --join-federation <invite code> [--home ~/.arena-node]
//
// --tunnel     the machine is remote: open a Cloudflare quick tunnel (no account) and print its https link instead
// --port       the wizard's local port (127.0.0.1 only)
// --seat-port  the node's port for connections from outside (8470, kanban #471 ruling 7)
// --home       where the node lives (ARENA_HOME; ~/.arena-node by default)
// --update     update this node to a downloaded release: SHA256SUMS and SHA256SUMS.sig beside the asset are checked against the Arena
//              release key, the asset unpacked into <home>/releases/, the node backed up, moved and checked - rolled back if it fails
// --rebond     a larger bond in one step, once the posted bond's lock has ended: that bond and the wallet's coins become a new bond
//              of <sats> with a new lock (rebond.js). Without --yes it only shows the plan.
// --join-federation  the node's gateway (set up in the wizard's Lightning step) joins a federation by its invite code (gateway.js)
//
// The release root is two directories up from this file's package (release/packages/arena-installer/bin).
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { createWizard } from '../src/wizard.js';
import { nodeState, defaultHome } from '../src/state.js';
import { openQuickTunnel } from '../src/tunnel.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('--port', 7800));
const seatPort = Number(opt('--seat-port', 8470));
const bridgePort = Number(opt('--bridge-port', 8471));
const home = resolve(opt('--home', defaultHome()));
const release = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const state = nodeState(home);
const cloudflared = process.env.ARENA_CLOUDFLARED || 'cloudflared';   // the release's own (arena-install sets it), else PATH

// AN UPDATE (kanban #471 part E): checked, unpacked beside the running release, the node moved to it (update.js)
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
  const name = asset.split('/').pop().replace(/\.tar\.gz$/, '');
  const dir = `${home}/releases`;
  mkdirSync(dir, { recursive: true });
  if (!existsSync(`${dir}/${name}`)) execFileSync('tar', ['-xzf', asset, '-C', dir]);
  const s = state.read();
  const r = await updateNode({ home, newRelease: `${dir}/${name}`, port: (s.reach && s.reach.port) || (s.service && s.service.port) || seatPort,
    node: `${dir}/${name}/runtime/node` });
  console.log(r.ok ? `Updated: ${r.from} -> ${r.to}; the same node answers (${r.identity.slice(0, 16)}...). Backup: ${r.backup}`
    : `${r.rolledBack ? 'Rolled back' : 'Not updated'}: ${r.why}${r.backup ? ` (backup ${r.backup})` : ''}`);
  process.exit(r.ok ? 0 : 1);
}

// A LARGER BOND (kanban #471 part D): the plan, then with --yes the broadcast
if (args.includes('--rebond')) {
  const { rebond } = await import('../src/rebond.js');
  const { readFileSync } = await import('node:fs');
  const { sha256 } = await import('../../arena-protocol/src/hash.js');
  let softwareHash; try { softwareHash = sha256(readFileSync(`${release}/COMMIT`)); } catch { softwareHash = new Uint8Array(32); }
  const r = await rebond({ state, bondSats: opt('--rebond', ''), post: args.includes('--yes'), softwareHash });
  if (!r.ok) { console.error(`Not possible: ${r.why}`); process.exit(1); }
  const p = r.plan;
  console.log(`The bond of ${p.from.sats} sat (${p.from.txid}, free since block ${p.from.maturity})${p.coins.length ? ` and ${p.coins.reduce((a, c) => a + c.sats, 0)} sat from the wallet` : ''}`
    + `\nbecome a bond of ${p.bondSats} sat, locked until block ${p.maturity} (${p.lock.blocks} blocks, about ${new Date(p.lock.estimatedMs).toUTCString()}).`
    + `\nFees ${p.fees.funding} + ${p.fees.bond} sat${p.changeSats !== '0' ? `, ${p.changeSats} sat back to the wallet` : ''}.`);
  console.log(r.bond ? `Posted: the new bond is ${r.bond.txid}:0.` : 'Nothing sent. Run again with --yes to post it.');
  process.exit(0);
}

// A FEDERATION FOR THE GATEWAY (kanban #471 slice 5, ruling 3: by invite)
if (args.includes('--join-federation')) {
  const { joinFederation, testGateway } = await import('../src/gateway.js');
  const g = state.read().gateway;
  if (!g) { console.error('Not possible: this node has no gateway - set it up in the wizard\'s Lightning step'); process.exit(1); }
  const j = await joinFederation({ ...g, invite: opt('--join-federation', '') });
  if (!j.ok) { console.error(`Not joined: ${j.why}`); process.exit(1); }
  const t = await testGateway(g);
  if (t.ok) state.save({ gateway: { ...state.read().gateway, federations: t.federations } });
  console.log(`Joined ${j.federationId}. The gateway serves: ${t.ok ? t.federations.map((f) => f.name || f.federationId).join(', ') : '(its list could not be read now)'}`);
  process.exit(0);
}

let tunnel = null, server = null;
const wizard = createWizard({ state, release, seatPort, bridgePort, cloudflared, log: (l) => console.log(l), onDone: () => {
  console.log(`\nDone. Your node runs as the user service arena-node (systemctl --user status arena-node).\nIts owner page: http://127.0.0.1:${seatPort}/Dashboard/owner`);
  if (tunnel) tunnel.close();
  server.close(); setTimeout(() => process.exit(0), 300);
} });

server = http.createServer((req, res) => wizard.handle(req, res));
server.listen(port, '127.0.0.1', async () => {
  const local = `http://127.0.0.1:${port}/?t=${wizard.token}`;
  console.log(`Arena node installer (testnet4). Node home: ${home}`);
  if (args.includes('--tunnel')) {
    console.log('Opening a Cloudflare quick tunnel (no account)...');
    tunnel = await openQuickTunnel({ port, bin: cloudflared });
    if (!tunnel.ok) { console.error(`No tunnel: ${tunnel.why}`); process.exit(1); }
    wizard.allowHost(new URL(tunnel.url).host);
    console.log(`\nOpen this link in your browser (it works once and for 30 minutes):\n\n  ${tunnel.url}/?t=${wizard.token}\n`);
  } else {
    console.log(`\nOpen this link in your browser (it works once and for 30 minutes):\n\n  ${local}\n`);
    // a desktop: open it there; a server without one: the link above
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform !== 'linux') {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      execFile(cmd, [local], () => {});
    }
  }
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (tunnel && tunnel.close) tunnel.close(); process.exit(130); });
