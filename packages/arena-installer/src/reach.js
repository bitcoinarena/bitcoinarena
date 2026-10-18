// HOW THE WORLD REACHES THE NODE (kanban #471 ruling 7, the owner 2026-10-18: "the other is direct connection, the installer automatically
// detects if outside connections are possible and if firewalls block it. If it succeeds that is the default option. Make up a default
// port for remote node connections. Other option is permanent tunnel with wrangler / cloud flare with installation help ... Anonymous
// temporary tunnel is the third option, permanent tunnel is the default option if no outside options are available. At the end that
// tunnel option is kept and the user is advised how to reach his node.").
//
//   direct      the node listens on DEFAULT_NODE_PORT (all interfaces); two Arena seats are asked to connect back (POST /reach-check,
//               arena-node/src/reach-check.js) before the node starts - a one-time responder answers their GET /reach-nonce
//   permanent   a named Cloudflare tunnel on the user's own account and domain: cloudflared installed if missing, `tunnel login`
//               (the user signs up / logs in in the browser; the installer waits for the certificate), the tunnel created, its DNS
//               name routed, a user service runs it; tested from outside (through Cloudflare's edge) before it is saved
//   quick       an anonymous trycloudflare.com tunnel as a user service: no account, but a new name at every restart
import http from 'node:http';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { quickTunnelName } from './tunnel.js';

/** The node's port for connections from outside (ruling 7: "make up a default port"). */
export const DEFAULT_NODE_PORT = 8470;
export const REACH_MODES = Object.freeze(['direct', 'permanent', 'quick']);

/** The seats asked to connect back: the testnet4 seats the Arena site lists (daily.json testnet.node), these when it cannot be read. */
export const REACH_SEATS = Object.freeze(['https://tn4.bitcoin-arena.io/guardian-1', 'https://tn4.bitcoin-arena.io/guardian-2',
  'https://tn4.bitcoin-arena.io/fed2-1', 'https://tn4.bitcoin-arena.io/guardian-3']);
export async function reachSeats({ fetcher = fetch, url = 'https://testnet.bitcoin-arena.io/daily.json' } = {}) {
  try {
    const d = await (await fetcher(url, { signal: AbortSignal.timeout(8000) })).json();
    const list = d && d.testnet && Array.isArray(d.testnet.node) ? d.testnet.node.filter((u) => /^https:\/\//.test(u)) : [];
    if (list.length >= 2) return list;
  } catch { /* the built-in list */ }
  return [...REACH_SEATS];
}

/** This machine's own addresses, v4 and v6, not loopback. */
export const localAddresses = (ifaces = os.networkInterfaces()) => Object.values(ifaces).flat()
  .filter((a) => a && !a.internal).map((a) => a.address.replace(/%.*$/, ''));

/**
 * IS THE PORT REACHABLE FROM OUTSIDE? Listen on it (all interfaces) with a one-time nonce, ask seats to connect back, and say what
 * blocks it when none could. Answers { ok, reached, address, port, askedSeats, answers, diagnosis: { cause, advice } }.
 */
export async function checkDirect({ port = DEFAULT_NODE_PORT, seats, fetcher = fetch, ifaces = os.networkInterfaces(), want = 2, sh = run } = {}) {
  const nonce = randomBytes(18).toString('base64url');
  const server = http.createServer((q, s) => { s.writeHead(q.url === '/reach-nonce' ? 200 : 404, { 'content-type': 'text/plain' }); s.end(q.url === '/reach-nonce' ? nonce : ''); });
  const listening = await new Promise((ok) => { server.once('error', (e) => ok(e)); server.listen({ port, host: '::', ipv6Only: false }, () => ok(null)); });
  if (listening) return { ok: false, reached: false, port, diagnosis: { cause: 'port-busy', advice: listening.code === 'EADDRINUSE' ? `port ${port} is in use on this machine: choose another port, or stop what uses it` : `cannot listen on port ${port}: ${listening.message}` } };
  const answers = [];
  try {
    for (const seat of seats || await reachSeats({ fetcher })) {
      if (answers.filter((a) => a.ok).length >= want) break;
      try {
        const r = await fetcher(`${seat}/reach-check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port, nonce }), signal: AbortSignal.timeout(15000) });
        const j = await r.json().catch(() => ({}));
        answers.push({ seat, ok: r.status === 200 && j.ok === true, reached: Boolean(j.reached), address: j.address || null, status: r.status, why: j.why || null });
      } catch (e) { answers.push({ seat, ok: false, reached: false, why: e.message }); }
    }
  } finally { await new Promise((ok) => server.close(ok)); }
  const asked = answers.filter((a) => a.ok);
  const reached = asked.length > 0 && asked.every((a) => a.reached);
  const address = (asked[0] && asked[0].address) || (answers.find((a) => a.address) || {}).address || null;
  return { ok: true, reached, address, port, answers, diagnosis: reached ? { cause: 'reachable', advice: `reachable from outside at ${address}:${port}` }
    : await diagnose({ address, port, asked: asked.length, ifaces, answers, sh }) };
}

/** What blocks the port: no seat answered, the host's own firewall (the public address is this machine's), or NAT (it is not). */
export async function diagnose({ address, port, asked, ifaces, answers = [], sh = run }) {
  if (!asked) {
    const v4private = answers.find((a) => a.status === 400 && a.address);
    if (v4private) return { cause: 'no-public-address', advice: `the seats see this machine as ${v4private.address}, which is not a public address (a carrier NAT or a VPN): nothing outside can connect to it. Use a tunnel.` };
    return { cause: 'unknown', advice: 'no Arena seat could be asked (no internet, or the seats are down): the check could not run. Try again, or use a tunnel.' };
  }
  const mine = address && localAddresses(ifaces).includes(address);
  if (mine) {
    const fw = await firewallTool(sh);
    return { cause: 'host-firewall', advice: `this machine holds the public address ${address} itself, so its own firewall drops port ${port}.`
      + (fw ? ` Open it with: ${fw.replace('PORT', port)}` : ` Open TCP ${port} in its firewall (and in your hosting provider's firewall, if it has one).`) };
  }
  const lan = localAddresses(ifaces).find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
  return { cause: 'nat', advice: `this machine is behind a router (public address ${address}${lan ? `, this machine ${lan}` : ''}): forward TCP ${port} on the router to ${lan || 'this machine'}:${port}, then test again - or use a tunnel.` };
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 20000 }, (e, out, err) => resolve({ ok: !e, code: e && e.code, out: String(out), err: String(err) })));
async function firewallTool(sh) {
  if ((await sh('which', ['ufw'])).ok) return 'sudo ufw allow PORT/tcp';
  if ((await sh('which', ['firewall-cmd'])).ok) return 'sudo firewall-cmd --permanent --add-port=PORT/tcp && sudo firewall-cmd --reload';
  if ((await sh('which', ['nft'])).ok) return 'sudo nft add rule inet filter input tcp dport PORT accept';
  return null;
}

/** The default way, by ruling 7: direct when it was reached, else the permanent tunnel. */
export const defaultReach = (direct) => (direct && direct.reached ? 'direct' : 'permanent');

// ---- the permanent tunnel: a named Cloudflare tunnel on the user's account ----

/** Where cloudflared keeps its login certificate and tunnel credentials. */
export const cloudflaredDir = (home = os.homedir()) => join(home, '.cloudflared');

/**
 * Step 1, login: `cloudflared tunnel login` prints a dash.cloudflare.com link; the user opens it, signs up or logs in, and picks the
 * domain the node's name goes under. Answers { ok, url, wait() -> { ok, why } } - wait() resolves when cert.pem is written.
 */
export function cloudflareLogin({ bin = 'cloudflared', dir = cloudflaredDir(), spawner = spawn, waitMs = 15 * 60000 }) {
  if (existsSync(join(dir, 'cert.pem'))) return Promise.resolve({ ok: true, url: null, wait: async () => ({ ok: true, why: 'already logged in' }) });
  return new Promise((resolve) => {
    let child;
    try { child = spawner(bin, ['tunnel', 'login'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ ok: false, why: e.message }); return; }
    let log = '', sent = false;
    const done = new Promise((ok) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); ok({ ok: false, why: `no login within ${waitMs / 60000} min` }); }, waitMs);
      child.on('exit', (code) => { clearTimeout(timer); ok(existsSync(join(dir, 'cert.pem')) ? { ok: true } : { ok: false, why: `cloudflared login ended (${code}) without a certificate: ${log.trim().split('\n').pop()}` }); });
    });
    const read = (d) => { log += d; const m = /https:\/\/dash\.cloudflare\.com\/argotunnel\S+/.exec(log); if (m && !sent) { sent = true; resolve({ ok: true, url: m[0], wait: () => done }); } };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', (e) => { if (!sent) resolve({ ok: false, why: e.code === 'ENOENT' ? `${bin} is not installed` : e.message }); });
    setTimeout(() => { if (!sent) { sent = true; resolve({ ok: false, why: `cloudflared printed no login link: ${log.trim().split('\n').pop() || 'nothing'}` }); } }, 30000);
  });
}

/**
 * Step 2: the tunnel and its name. Creates (or reuses) tunnel `name`, routes `hostname` (under a domain of that account) to it, and
 * writes its config for the node's port. Answers { ok, id, config, why }.
 */
export async function cloudflareTunnel({ bin = 'cloudflared', name, hostname, port, home, dir = cloudflaredDir(), sh = run }) {
  let id = null;
  const list = await sh(bin, ['tunnel', 'list', '--output', 'json', '--name', name]);
  try { const l = JSON.parse(list.out || '[]'); if (l.length) id = l[0].id; } catch { /* none */ }
  if (!id) {
    const c = await sh(bin, ['tunnel', 'create', name]);
    const m = /with id ([0-9a-f-]{36})/.exec(c.out + c.err);
    if (!m) return { ok: false, why: `cloudflared tunnel create failed: ${(c.err || c.out).trim().slice(0, 300)}` };
    id = m[1];
  }
  const route = await sh(bin, ['tunnel', 'route', 'dns', '--overwrite-dns', id, hostname]);
  if (!route.ok) return { ok: false, why: `the name ${hostname} could not be routed (is its domain on this Cloudflare account?): ${(route.err || route.out).trim().slice(0, 300)}` };
  const creds = join(dir, `${id}.json`);
  if (!existsSync(creds)) return { ok: false, why: `no credentials for tunnel ${id} in ${dir} (${readdirSync(dir).join(', ')})` };
  const config = join(home, 'cloudflared.yml');
  writeFileSync(config, `# the node's permanent tunnel (kanban #471), written by the installer\ntunnel: ${id}\ncredentials-file: ${creds}\ningress:\n  - hostname: ${hostname}\n    service: http://127.0.0.1:${port}\n  - service: http_status:404\n`, { mode: 0o600 });
  return { ok: true, id, config };
}

/** The tunnel's unit: the permanent one by its config, the quick one by the node's port (its name is read from the journal). */
export function tunnelUnit({ bin, mode, config, port }) {
  const exec = mode === 'permanent' ? `${bin} tunnel --no-autoupdate --config ${config} run` : `${bin} tunnel --no-autoupdate --url http://127.0.0.1:${port}`;
  return `# The Arena node's ${mode} Cloudflare tunnel (kanban #471), written by the installer.
[Unit]
Description=Arena node ${mode} tunnel
After=network-online.target arena-node.service
Wants=network-online.target

[Service]
ExecStart=${exec}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** Read a quick tunnel's current name from its unit's journal. */
export async function quickTunnelUrl({ unit = 'arena-tunnel.service', sh = run, waitMs = 45000 }) {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const j = await sh('journalctl', ['--user', '-u', unit, '-o', 'cat', '--no-pager', '-n', '200']);
    const url = quickTunnelName(j.out);
    if (url) return url;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return null;
}

/**
 * Is the node reachable at a public https URL? Asked from here, through Cloudflare's edge and back: GET <url>/identity must be this
 * node's key. Answers { ok, ms, why }.
 */
export async function testPublicUrl({ url, identity, fetcher = fetch, tries = 10 }) {
  let why = 'not tried';
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    try {
      const r = await fetcher(`${url}/identity`, { signal: AbortSignal.timeout(10000) });
      const b = Buffer.from(await r.arrayBuffer()).toString('hex');
      if (r.status === 200 && b === identity) return { ok: true, ms: Date.now() - t0 };
      why = r.status === 200 ? 'another node answers there' : `HTTP ${r.status}`;
    } catch (e) { why = e.cause ? e.cause.code || e.message : e.message; }
    await new Promise((ok) => setTimeout(ok, 3000));   // a new name takes a few seconds in DNS
  }
  return { ok: false, why: `${url} does not answer as this node: ${why}` };
}
