// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEW WAY IN REACHES THE CENSUS, AND THE OLD ONE STAYS UNTIL IT DID (kanban #3565, an outside node operator 2026-11-24: switched from a quick
// tunnel to Tailscale Funnel on the owner page; the quick tunnel was taken away at once, no advertisement update was posted, the census at
// 163098 still named the trycloudflare address hours later and the owner page through the site said "This node did not answer: Failed to
// fetch"). The switch keeps the old tunnel, the seat posts an advertisement update naming the new address (its bond's, from its wallet) and
// takes the old tunnel away only once the census names the new address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nodeState } from '../src/state.js';
import { installService, unitDir, TUNNEL_UNIT } from '../src/service.js';
import { refreshEndpoint } from '../src/change-roles.js';
import { switchPlan, followReach, CENSUS_TAKES_BLOCKS } from '../src/reach-follow.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const OLD = 'https://realistic-ecology-municipal-modified.trycloudflare.com';
const NEW = 'https://op-node.tail1234.ts.net:8443';

function node(reach) {
  const home = mkdtempSync(join(tmpdir(), 'reach3565-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(new Uint8Array(32).fill(6)); db.close();
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach,
    bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 163145 } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 163098, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 20000 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  return { home, state, sent, chainKit };
}

test('the switch from a quick tunnel to Funnel or direct keeps the old tunnel and remembers its address; tunnel to tunnel or a first install keeps nothing', () => {
  const p = switchPlan({ mode: 'quick', port: 8470, url: OLD }, 'tailscale', 1000);
  assert.deepEqual(p, { keepTunnel: true, previous: { mode: 'quick', url: OLD, atMs: 1000 } });
  assert.equal(switchPlan({ mode: 'permanent', url: 'https://n.example.com' }, 'direct', 1).keepTunnel, true);
  assert.deepEqual(switchPlan({ mode: 'quick', url: OLD }, 'permanent', 1), { keepTunnel: false, previous: null }, 'the tunnel unit becomes the new one');
  assert.deepEqual(switchPlan({ mode: 'tailscale', url: NEW }, 'direct', 1), { keepTunnel: false, previous: null }, 'no tunnel ran');
  assert.deepEqual(switchPlan(null, 'tailscale', 1), { keepTunnel: false, previous: null });
});

test('Install and start with keepTunnel leaves the old tunnel unit running (Linux and macOS)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reach3565-svc-'));
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'cfg'), USER: 'arena' };
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const healthy = async () => new Response(Buffer.from('ab'.repeat(32), 'hex'), { status: 200 });
  const calls = [];
  const sh = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true, out: '', err: '' }; };
  const unit = join(unitDir(env), TUNNEL_UNIT);
  await installService({ platform: 'linux', node: '/r/node', release: '/r', home, port: 8470, tunnel: '[Unit]\nDescription=quick tunnel\n', env, sh, fetcher: healthy, waitMs: 2000 });
  const r = await installService({ platform: 'linux', node: '/r/node', release: '/r', home, port: 8470, tunnel: null, keepTunnel: true, env, sh, fetcher: healthy, waitMs: 2000 });
  assert.equal(r.ok, true, r.why);
  assert.equal(existsSync(unit), true, 'the quick tunnel stays until the census names the new address');
  assert.equal(calls.some((c) => /disable --now .*tunnel/.test(c)), false, 'never stopped');
  calls.length = 0;
  const mac = join(root, 'Library/LaunchAgents'); mkdirSync(mac, { recursive: true });
  writeFileSync(join(mac, 'io.bitcoin-arena.node.tunnel.plist'), '<plist/>');
  await installService({ platform: 'darwin', node: '/r/node', release: '/r', home, port: 8470, tunnelArgs: null, keepTunnel: true, env: { HOME: root }, sh, fetcher: healthy, waitMs: 2000 });
  assert.equal(calls.some((c) => /bootout .*tunnel/.test(c)), false, 'the tunnel agent is not booted out');
});

test('refreshEndpoint: an advertisement update of the bond naming the address the node is reached at now - once per address', async () => {
  const n = node({ mode: 'tailscale', port: 8470, url: NEW });
  const plan = await refreshEndpoint({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit });
  assert.equal(plan.ok, true, plan.why);
  assert.equal(plan.plan.endpoint, NEW);
  assert.equal(plan.plan.countsAfter, CENSUS_TAKES_BLOCKS);
  assert.equal(n.sent.length, 0, 'the plan sends nothing');
  const r = await refreshEndpoint({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit, post: true });
  assert.equal(r.ok, true, r.why);
  assert.equal(n.sent.length, 2, 'the funding and the update');
  const read = readAdvertUpdate(fromHex(n.sent[1]), { network: 'testnet4' });
  assert.equal(read.ok, true, read.why);
  assert.equal(read.advert.endpoint, NEW);
  assert.deepEqual([...read.advert.roles].sort(), ['game', 'relay', 'settlement', 'verify'], 'the roles kept');
  const s = n.state.read();
  assert.equal(s.advertEndpoint, NEW);
  assert.equal(s.endpointUpdate.endpoint, NEW);
  assert.equal(s.endpointUpdate.txid, r.update.txid);
  const again = await refreshEndpoint({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit, post: true });
  assert.equal(again.ok, true); assert.equal(again.unchanged, true);
  assert.equal(n.sent.length, 2, 'never twice for one address');
  n.state.save({ bond: null, advertEndpoint: null });
  assert.match((await refreshEndpoint({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit, post: true })).why, /no bond/);
});

test('followReach, the seat after the switch: posts the update while the census names the old address, keeps the old tunnel, then takes it away once the census names the new one', async () => {
  const n = node({ mode: 'tailscale', port: 8470, url: NEW, previous: { mode: 'quick', url: OLD, atMs: 1 } });
  const posted = [], removed = [];
  const refresh = async (o) => { posted.push(o); n.state.save({ advertEndpoint: NEW, endpointUpdate: { txid: 'aa'.repeat(32), endpoint: NEW, atMs: 5 } }); return { ok: true, update: { txid: 'aa'.repeat(32) } }; };
  const removeTunnel = async () => { removed.push('tunnel'); return { ok: true, removed: true }; };
  const go = (own, extra = {}) => followReach({ home: n.home, state: n.state, publicEndpoint: NEW, censusRead: true, ownEndpoints: own, refresh, removeTunnel, nowMs: 10 * 60000, ...extra });
  let f = await go([OLD]);
  assert.equal(posted.length, 1, 'the update is posted');
  assert.equal(posted[0].post, true);
  assert.equal(removed.length, 0, 'the old tunnel stays while the census names it');
  assert.equal(f.view.censusNamesNew, false);
  assert.equal(f.view.previous.url, OLD);
  assert.equal(f.view.update.txid, 'aa'.repeat(32));
  assert.equal(f.view.takesBlocks, CENSUS_TAKES_BLOCKS);
  f = await go([OLD]);
  assert.equal(posted.length, 1, 'an update on its way is not posted again');
  f = await go([NEW]);
  assert.equal(removed.length, 1, 'the census names the new address: the old tunnel goes');
  assert.equal(n.state.read().reach.previous, undefined);
  assert.equal(n.state.read().reach.url, NEW, 'the address itself kept');
  assert.equal(f.view.censusNamesNew, true);
  await go([NEW]);
  assert.equal(removed.length + posted.length, 2, 'nothing more to do');
});

test('followReach: a failed update is said and tried again; a quick tunnel posts nothing on chain; no census read yet decides nothing', async () => {
  const n = node({ mode: 'direct', port: 8470, url: 'http://203.0.113.9:8470' });
  let tries = 0;
  const refresh = async () => { tries++; return { ok: false, why: 'the node\'s wallet holds no coins for the fee' }; };
  const removeTunnel = async () => assert.fail('no tunnel to remove');
  const at = (nowMs, o = {}) => followReach({ home: n.home, state: n.state, publicEndpoint: 'http://203.0.113.9:8470', censusRead: true, ownEndpoints: [OLD], refresh, removeTunnel, nowMs, ...o });
  let f = await at(1_000_000);
  assert.equal(tries, 1);
  assert.match(f.view.update.why, /no coins/);
  await at(1_000_000 + 60_000);
  assert.equal(tries, 1, 'not again within the retry wait');
  await at(1_000_000 + 11 * 60_000);
  assert.equal(tries, 2, 'again after it');
  await at(1_000_000 + 30 * 60_000, { censusRead: false });
  assert.equal(tries, 2, 'no census read: nothing decided');
  const q = node({ mode: 'quick', port: 8470, url: OLD });
  await followReach({ home: q.home, state: q.state, publicEndpoint: OLD, censusRead: true, ownEndpoints: ['https://older.trycloudflare.com'], refresh: async () => assert.fail('a quick tunnel changes at every restart: announced, not advertised'), removeTunnel, nowMs: 1 });
  const other = node({ mode: 'tailscale', port: 8470, url: NEW });
  await followReach({ home: other.home, state: other.state, publicEndpoint: OLD, censusRead: true, ownEndpoints: [OLD], refresh: async () => assert.fail('the seat does not run on the new address yet'), removeTunnel, nowMs: 1 });
});

test('followReach finishes a switch whose runner ended with the seat\'s restart (the progress said "running" for 15 minutes)', async () => {
  const n = node({ mode: 'tailscale', port: 8470, url: NEW });
  writeFileSync(join(n.home, 'reach-switch.json'), JSON.stringify({ state: 'running', mode: 'tailscale', atMs: 100 }) + '\n');
  await followReach({ home: n.home, state: n.state, publicEndpoint: NEW, censusRead: false, ownEndpoints: [], refresh: async () => ({ ok: true }), removeTunnel: async () => ({ ok: true }), nowMs: 200, startedMs: 150 });
  const p = JSON.parse(readFileSync(join(n.home, 'reach-switch.json'), 'utf8'));
  assert.equal(p.state, 'done');
  assert.equal(p.url, NEW);
  writeFileSync(join(n.home, 'reach-switch.json'), JSON.stringify({ state: 'running', mode: 'tailscale', atMs: 300 }) + '\n');
  await followReach({ home: n.home, state: n.state, publicEndpoint: NEW, censusRead: false, ownEndpoints: [], refresh: async () => ({ ok: true }), removeTunnel: async () => ({ ok: true }), nowMs: 400, startedMs: 150 });
  assert.equal(JSON.parse(readFileSync(join(n.home, 'reach-switch.json'), 'utf8')).state, 'running', 'a switch begun after this seat started is still running');
});
