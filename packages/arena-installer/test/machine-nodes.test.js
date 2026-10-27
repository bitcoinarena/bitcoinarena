// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY NODE ON THIS MACHINE, AND MORE OF THEM (kanban #713, 2026-10-26: "There, I can setup additional nodes (with the ramdisk option) ...
// The App shows the status of ALL OF OUR nodes in a grid with links to all owners dashboards" - testnet only): the nodes found by their
// seats' service files and the usual homes; the further ones named past every name, home and port taken; the chain over that plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodesHere, liveNodes, addNodesPlan } from '../src/machine-nodes.js';
import { nextInstance } from '../src/instances.js';
import { main } from '../src/bitcoinarena.js';

function machine() {
  const root = mkdtempSync(join(tmpdir(), 'machine-'));
  const env = { HOME: join(root, 'user'), XDG_CONFIG_HOME: join(root, 'user', '.config') };
  const units = join(env.XDG_CONFIG_HOME, 'systemd', 'user'); mkdirSync(units, { recursive: true });
  const node = (home, { instance = '', offset = 0, network = 'testnet4', key = null, unit = null } = {}) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'arena.conf'), `network=${network}\nport=${8470 + offset}\n${instance ? `instance=${instance}\nport_offset=${offset}\n` : ''}`);
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network, done: { service: 1 }, ...(key ? { service: { identity: key } } : {}) }));
    if (unit) writeFileSync(join(units, unit), `[Service]\nExecStart=/r/node src/run.js ${join(home, 'arena.conf')}\n`);
  };
  return { root, env, units, node };
}

test('the nodes here: by the seats\' units and the usual homes, each once, the first installed first; a folder without arena.conf is none', () => {
  const m = machine();
  try {
    m.node(join(m.env.HOME, '.bitcoinarena'), { key: 'ab'.repeat(32), unit: 'arena-node.service' });
    m.node(join(m.env.HOME, '.bitcoinarena-b'), { instance: 'b', offset: 100 });                          // a count's, no unit read
    m.node(join(m.root, 'elsewhere'), { instance: 'x', offset: 3000, unit: 'arena-node--x.service' });   // its unit names it
    writeFileSync(join(m.units, 'arena-node--b.tor.service'), 'not a seat');
    mkdirSync(join(m.env.HOME, '.bitcoinarena-c'), { recursive: true });                                   // a setup not finished
    const list = nodesHere({ platform: 'linux', env: m.env });
    assert.deepEqual(list.map((x) => [x.home.slice(m.root.length), x.instance, x.port, x.portOffset]),
      [['/user/.bitcoinarena', '', 8470, 0], ['/user/.bitcoinarena-b', 'b', 8570, 100], ['/elsewhere', 'x', 11470, 3000]]);
    assert.equal(list[0].key, 'ab'.repeat(32));
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test('the further nodes: b, c ... from the first, past every name, home and port taken; testnet4 only; at most 20 in all', () => {
  const m = machine();
  try {
    m.node(join(m.env.HOME, '.bitcoinarena'), { unit: 'arena-node.service' });
    m.node(join(m.env.HOME, '.bitcoinarena-b'), { instance: 'b', offset: 100 });
    const here = nodesHere({ platform: 'linux', env: m.env });
    const free = () => [];
    const p = addNodesPlan(here, 3, { busy: free });
    assert.equal(p.ok, true);
    assert.deepEqual(p.nodes.map((x) => [x.instance, x.home.slice(m.root.length), x.portOffset]),
      [['c', '/user/.bitcoinarena-c', 200], ['d', '/user/.bitcoinarena-d', 300], ['e', '/user/.bitcoinarena-e', 400]]);
    // a port range in use is passed over
    const busyD = (ports) => (ports.includes(8770) ? [8770] : []);
    assert.deepEqual(addNodesPlan(here, 2, { busy: busyD }).nodes.map((x) => x.instance), ['c', 'e']);
    // the guardian's ports too (the 2026.1.9.11 install test): one in use passes that range over
    const busyG = (ports) => (ports.includes(10670) ? [10670] : []);
    assert.deepEqual(addNodesPlan(here, 2, { busy: busyG }).nodes.map((x) => x.instance), ['d', 'e'], 'c at +200 has its guardian P2P port on 10670 (8670 + 2000)');
    assert.match(addNodesPlan(here, 19, { busy: free }).why, /at most 20 nodes on one machine: 2 are here, so at most 18 more/);
    assert.match(addNodesPlan([], 1).why, /install one first/);
    assert.match(addNodesPlan([{ ...here[0], network: 'mainnet' }], 1, { busy: free }).why, /testnet4 only/);
    assert.match(addNodesPlan(here, 0, { busy: free }).why, /whole number from 1/);
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test('the chain over the plan: each added node starts the next, numbered after the nodes there were', () => {
  const adding = [{ instance: 'c', home: '/h-c', portOffset: 200 }, { instance: 'd', home: '/h-d', portOffset: 300 }];
  assert.deepEqual(nextInstance(4, '/h', '/h-c', {}, adding), { instance: 'd', home: '/h-d', portOffset: 300, index: 4, count: 4 });
  assert.equal(nextInstance(4, '/h', '/h-d', {}, adding), null);
  // without a plan: a count's as before
  assert.deepEqual(nextInstance(3, '/h', '/h', {}), { instance: 'b', home: '/h-b', portOffset: 100, index: 2, count: 3 });
});

test('bitcoinarena nodes: each node, running or not, as lines or JSON with its dashboard and owner page', async () => {
  const m = machine();
  const seat = await new Promise((ok) => { const s = http.createServer((req, res) => { res.writeHead(req.url === '/identity' ? 200 : 404); res.end(Buffer.from('cd'.repeat(32), 'hex')); }); s.listen(0, '127.0.0.1', () => ok(s)); });
  try {
    const port = seat.address().port;
    m.node(join(m.env.HOME, '.bitcoinarena'), { unit: 'arena-node.service' });
    writeFileSync(join(m.env.HOME, '.bitcoinarena', 'arena.conf'), `network=testnet4\nport=${port}\n`);
    m.node(join(m.env.HOME, '.bitcoinarena-b'), { instance: 'b', offset: 100 });
    writeFileSync(join(m.env.HOME, '.bitcoinarena-b', 'arena.conf'), 'network=testnet4\nport=1\ninstance=b\nport_offset=100\n');
    const out = [];
    const io = { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) };
    assert.equal(await main(['nodes', '--json'], { home: join(m.env.HOME, '.bitcoinarena'), io, deps: { platform: 'linux', env: m.env } }), 0);
    const j = JSON.parse(out.pop());
    assert.deepEqual(j.map((x) => [x.instance, x.running, x.key]), [['', true, 'cd'.repeat(32)], ['b', false, null]]);
    assert.equal(j[0].dashboard, `http://127.0.0.1:${port}/dashboard`);
    assert.equal(j[0].owner, `https://testnet.bitcoin-arena.io/owner/#node=${'cd'.repeat(32)}&local=${encodeURIComponent(`http://127.0.0.1:${port}`)}`);
    assert.equal(await main(['nodes'], { home: join(m.env.HOME, '.bitcoinarena'), io, deps: { platform: 'linux', env: m.env } }), 0);
    assert.match(out.join('\n'), /● running .* port \d+ .*\.bitcoinarena\n○ stopped .* b +port 1 /);
    // add-nodes: the installer's --add-nodes for this node's home
    const ran = [];
    assert.equal(await main(['add-nodes', '3', '--ram'], { home: '/h', io, deps: { platform: 'linux', env: m.env, runInstaller: async (a) => { ran.push(a); return 0; } } }), 0);
    assert.deepEqual(ran, [['--home', '/h', '--add-nodes', '3', '--ram']]);
    assert.equal(await main(['add-nodes', 'x'], { home: '/h', io, deps: {} }), 2);
  } finally { seat.close(); rmSync(m.root, { recursive: true, force: true }); }
});

// EVERY OWNER PAGE AT ONCE (2026-10-26: "You need to store credentials for *all* owner pages where its needed and provide links")
test('bitcoinarena sign-in-all: one hand-over for every node with a key, its links printed', async () => {
  const m = machine();
  try {
    const one = join(m.env.HOME, '.bitcoinarena'), two = join(m.env.HOME, '.bitcoinarena-b');
    m.node(one, { key: 'a1'.repeat(32), unit: 'arena-node.service' });
    m.node(two, { instance: 'b', offset: 100, key: 'b2'.repeat(32) });
    for (const h of [one, two]) {
      const st = JSON.parse(readFileSync(join(h, 'state.json'), 'utf8'));
      writeFileSync(join(h, 'state.json'), JSON.stringify({ ...st, owner: { mode: 'seed' } })); writeFileSync(join(h, 'seed.hex'), '11'.repeat(32));
    }
    const out = [], opened = [], handed = [];
    const code = await main(['sign-in-all'], { home: one, io: { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
      deps: { platform: 'linux', env: m.env, openUrl: async (u) => opened.push(u), handoff: async (o) => { handed.push(o); return 'http://127.0.0.1:41001/t'; } } });
    assert.equal(code, 0);
    assert.deepEqual(handed.map((h) => [h.all, h.target]), [[true, `https://testnet.bitcoin-arena.io/owner/#node=${'a1'.repeat(32)}&local=http%3A%2F%2F127.0.0.1%3A8470&owner-handoff`]]);
    assert.deepEqual(opened, ['http://127.0.0.1:41001/t']);
    assert.match(out.join('\n'), /Signing you in on 2 owner page\(s\) at once[\s\S]*Node 1: https:\/\/testnet\.bitcoin-arena\.io\/owner\/#node=a1a1[\s\S]*Node b: https:\/\/testnet\.bitcoin-arena\.io\/owner\/#node=b2b2/);
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test('liveNodes: a node whose port does not answer is not running', async () => {
  const l = await liveNodes([{ home: '/a', port: 1 }, { home: '/b', port: null }], { ms: 500 });
  assert.deepEqual(l.map((x) => x.running), [false, false]);
});
