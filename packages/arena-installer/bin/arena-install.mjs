#!/usr/bin/env node
// THE INSTALLER (kanban #471): start it, open the link it prints, finish in the browser.
//
//     arena-install [--tunnel] [--port 7800] [--seat-port 8470] [--home ~/.arena-node]
//
// --tunnel     the machine is remote: open a Cloudflare quick tunnel (no account) and print its https link instead
// --port       the wizard's local port (127.0.0.1 only)
// --seat-port  the node's port for connections from outside (8470, kanban #471 ruling 7)
// --home       where the node lives (ARENA_HOME; ~/.arena-node by default)
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
