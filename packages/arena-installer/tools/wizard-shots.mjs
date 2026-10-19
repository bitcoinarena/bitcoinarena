// #471: the wizard, step by step, for screenshots. Real: the Bitcoin Core test (this machine's testnet4 node), the direct reach check
// (the live seats), the seed, the owner binding, a real seat process started from the settings the wizard wrote (on a one-block fake
// bitcoind, so no seat reads the real chain here), the owner login it checks. Faked so nothing is installed into this machine's
// systemd and no coin moves: the service install (the seat is started directly), the deposit and the broadcast.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWizard } from '../src/wizard.js';   // run: node tools/wizard-shots.mjs <port> <link file>; then tools/wizard-drive.mjs (headless Chrome on 9361)
import { nodeState } from '../src/state.js';
import { openQuickTunnel } from '../src/tunnel.js';
import * as lndReal from '../src/lnd.js';
import * as gwReal from '../src/gateway.js';
import { writeLaunchers } from '../src/launchers.js';
import { seatUnit, waitHealthy } from '../src/service.js';
import * as reachKit from '../src/reach.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { setInConf } from '../../arena-node/src/arena-conf.js';

const RELEASE = resolve(fileURLToPath(import.meta.url), '../../../..');
const G = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043';
const GH = '0100000000000000000000000000000000000000000000000000000000000000000000004e7b2b9128fe0291db0693af2ae418b767e657cd407e80cb1434221eaea7a07a046f3566ffff001dbb0c7817';
const GB = GH + '0101000000010000000000000000000000000000000000000000000000000000000000000000ffffffff5504ffff001d01044c4c30332f4d61792f323032342030303030303030303030303030303030303030303165626435386332343439373062336161396437383362623030313031316662653865613865393865303065ffffffff0100f2052a010000002321000000000000000000000000000000000000000000000000000000000000000000ac00000000';
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

const home = mkdtempSync(join(tmpdir(), 'arena-shots-'));
const cookie = '__cookie__:shots';
writeFileSync(join(home, 'fake.cookie'), cookie);
const fake = http.createServer((q, s) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => {
  const { id, method, params = [] } = JSON.parse(b);
  const r = { getblockchaininfo: { chain: 'testnet4', blocks: 0, headers: 0, bestblockhash: G, initialblockdownload: false }, getblockcount: 0,
    getblockhash: G, getblockheader: params[1] === false ? GH : { hash: G, height: 0, time: 1714777860, mediantime: 1714777860, confirmations: 1 }, getblock: GB }[method];
  s.end(JSON.stringify(r === undefined ? { result: null, error: { code: -32601, message: 'no' }, id } : { result: r, error: null, id })); }); });
await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
const seatPort = await freePort();
let child = null;
const install = async ({ release, home: h, port }) => {
  // the seat starts from arena.conf alone (kanban #499): the one-block fake chain goes into it
  const env = { PATH: process.env.PATH, HOME: h };
  let conf = readFileSync(join(h, 'arena.conf'), 'utf8');
  conf = setInConf(setInConf(conf, 'bitcoind_url', `http://127.0.0.1:${fake.address().port}/`), 'bitcoind_cookie', join(h, 'fake.cookie'));
  writeFileSync(join(h, 'arena.conf'), conf);
  const unit = seatUnit({ node: process.execPath, release, home: h, port });
  const exec = /ExecStart=(.*)/.exec(unit)[1].split(' ');
  child = spawn(exec[0], exec.slice(1), { cwd: /WorkingDirectory=(.*)/.exec(unit)[1], env, stdio: 'ignore' });
  const t0 = Date.now(); const w = await waitHealthy({ port, waitMs: 60000, everyMs: 300 });
  return { ...w, ms: Date.now() - t0, boot: true, linger: null };
};
let asked = 0;
const chainKit = { coinsOf: async () => ({ tip: 156905, coins: ++asked > 1 ? [{ txid: '5a'.repeat(32), vout: 1, sats: 110000, height: 156904 }] : [] }),
  broadcast: async (_c, hex) => Buffer.from(parseTransaction(Buffer.from(hex, 'hex')).txid).reverse().toString('hex') };
// the quick tunnel: a real one (cloudflared on this machine) to the seat, so the screens show the public address the node really has
const tunnels = [];
const reach = { ...reachKit, quickTunnelUrl: async () => { const t = await openQuickTunnel({ port: seatPort }); tunnels.push(t); return t.ok ? t.url : null; } };
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) process.on(sig, () => { for (const t of tunnels) if (t.close) t.close(); });
// LIGHTNING (slice 5): a real LND - the checked download, its config on this machine's Core, its wallet from the seed - on ports of its
// own (this machine runs other LNDs), started directly instead of as a service; stopped with the harness
const lndChildren = [];
const lndKit = { ...lndReal, configureLnd: (o) => lndReal.configureLnd({ ...o, ports: { rpc: 20109, rest: 20180, p2p: 20135 } }),
  installProgram: async ({ args: [bin, ...rest] }) => { lndChildren.push(spawn('nice', [bin, ...rest], { stdio: 'ignore' })); return { ok: true }; } };
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) process.on(sig, () => { for (const c of lndChildren) c.kill('SIGTERM'); if (sig !== 'exit') process.exit(0); });
// THE GATEWAY (slice 5): this machine's fork-built gatewayd when ARENA_SHOTS_GATEWAYD names it, on a port of its own, started directly;
// the custody agent likewise (it waits: no founding here)
const gwKit = { ...gwReal, findGatewayd: () => (process.env.ARENA_SHOTS_GATEWAYD ? { ok: true, gatewayd: process.env.ARENA_SHOTS_GATEWAYD } : gwReal.findGatewayd({ release: RELEASE })),
  configureGateway: (o) => gwReal.configureGateway({ ...o, port: 20176, lnd: { ...o.lnd, rpcHost: 'https://127.0.0.1:20109' } }),
  installProgram: async ({ args: [bin, ...rest], vars }) => { lndChildren.push(spawn('nice', [bin, ...rest], { stdio: 'ignore', env: { ...process.env, ...(vars || {}) } })); return { ok: true }; } };
const wizard = createWizard({ state: nodeState(home), release: RELEASE, seatPort, install, chainKit, reach, cloudflared: 'cloudflared', lndKit, gwKit,
  launch: (o) => writeLaunchers({ ...o, platform: 'linux', env: { XDG_DATA_HOME: join(home, 'xdg'), HOME: home } }) });
const server = http.createServer((q, s) => wizard.handle(q, s));
await new Promise((ok) => server.listen(Number(process.argv[2] || 31918), '127.0.0.1', ok));
writeFileSync(process.argv[3], `http://127.0.0.1:${server.address().port}/?t=${wizard.token}\n`);
console.log('wizard ready', home);
const stop = () => { if (child) child.kill('SIGTERM'); server.close(); fake.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
setTimeout(stop, 15 * 60000);
