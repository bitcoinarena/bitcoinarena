// kanban #2570 (feedback #021): --help prints the usage and starts nothing; a failed systemctl --user says how to fix it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { systemctlWhy } from '../src/service.js';

const bin = fileURLToPath(new URL('../bin/arena-install.mjs', import.meta.url));

test('--help and -h print the usage and exit 0 without starting the wizard', () => {
  for (const f of ['--help', '-h']) {
    const out = execFileSync(process.execPath, [bin, f], { encoding: 'utf8', timeout: 20000 });
    assert.match(out, /^THE INSTALLER/);
    assert.match(out, /arena-install --update /);
    assert.match(out, /--tunnel/);
    assert.doesNotMatch(out, /http:\/\/127\.0\.0\.1/);
  }
});

test('systemctl failures name the fix', () => {
  const a = ['--user', 'daemon-reload'];
  assert.match(systemctlWhy(a, { err: 'Failed to connect to bus: No medium found' }), /loginctl enable-linger/);
  assert.match(systemctlWhy(a, { err: 'spawn systemctl ENOENT' }), /no systemd/);
  assert.match(systemctlWhy(a, { err: 'System has not been booted with systemd as init system (PID 1).' }), /wsl\.conf/);
  assert.equal(systemctlWhy(['--user', 'restart', 'x'], { err: 'Unit x not found.' }), 'systemctl --user restart x failed: Unit x not found.');
});

test('a tunnel whose edge port 7844 is blocked says so, before and after it has a name', async () => {
  const { openQuickTunnel, edgeHint } = await import('../src/tunnel.js');
  const { EventEmitter } = await import('node:events');
  assert.equal(edgeHint('INF Requesting new quick Tunnel on trycloudflare.com...'), '');
  assert.match(edgeHint('ERR Failed to dial a quic connection error="timeout" connIndex=0 ip=198.41.192.7:7844'), /port 7844/);
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  const t = openQuickTunnel({ port: 7800, spawner: () => child, waitMs: 5000 });
  child.stderr.emit('data', 'INF |  https://brave-test-name.trycloudflare.com  |\n');
  const r = await t;
  assert.equal(r.ok, true);
  const heard = new Promise((res) => r.onEdgeTrouble(res));
  child.stderr.emit('data', 'ERR Failed to dial a quic connection error="timeout" ip=198.41.192.7:7844\n');
  assert.match(await heard, /Allow outgoing 7844/);
  // gives up without a name: the hint is in the refusal
  const c2 = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  const t2 = openQuickTunnel({ port: 7800, spawner: () => c2, waitMs: 5000 });
  c2.stderr.emit('data', 'ERR edge discovery: error looking up Cloudflare edge IPs\n'); c2.emit('exit', 1);
  assert.match((await t2).why, /port 7844/);
});

test('an Esplora API over HTTPS is a second source: it agrees on testnet4 and refuses another chain', async () => {
  const { probeEsplora, testConnection, TESTNET4_GENESIS } = await import('../src/chain-test.js');
  const h = (n) => n.toString(16).padStart(64, '0');
  const chain = (genesis) => async (url) => {
    const p = new URL(url).pathname.replace(/^\/api/, '');
    const body = p === '/block-height/0' ? genesis : p === '/blocks/tip/height' ? '1000' : p === '/blocks/tip/hash' ? h(1000)
      : p.startsWith('/block-height/') ? h(Number(p.split('/').pop())) : null;
    return new Response(body ?? 'not found', { status: body ? 200 : 404 });
  };
  const ok = await probeEsplora({ esplora: 'https://e.example/api' }, { fetcher: chain(TESTNET4_GENESIS), at: [998] });
  assert.equal(ok.ok, true); assert.equal(ok.height, 1000); assert.equal(ok.atHashes[998], h(998));
  const other = await probeEsplora({ esplora: 'https://e.example/api' }, { fetcher: chain(h(7)) });
  assert.equal(other.ok, false); assert.match(other.why, /not testnet4/);
  // the node's own source agrees with the Esplora second source when every Electrum server is out of reach
  const own = { ok: true, chain: 'testnet4', genesis: TESTNET4_GENESIS, height: 1000, tipHash: h(1000), atHashes: {} };
  const r = await testConnection({ kind: 'electrum', host: 'tn4.example', port: 443 }, {
    list: [{ host: 'unreachable.example', port: 40002 }, { esplora: 'https://e.example/api' }],
    probe: {
      electrum: async (c, o = {}) => (c.host === 'unreachable.example' ? { ok: false, why: 'connect ETIMEDOUT' }
        : { ...own, atHashes: Object.fromEntries((o.at || []).map((x) => [x, h(x)])) }),
      esplora: (c, o) => probeEsplora(c, { ...o, fetcher: chain(TESTNET4_GENESIS) }),
    } });
  assert.equal(r.ok, true, r.why); assert.equal(r.second.endpoint, 'https://e.example/api');
});
