// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN INSTALLED NODE BECOMES A LIQUIDITY PROVIDER FROM ITS OWNER PAGE (kanban #567): the plan (LND tested, the deposit against the node's
// wallet, a custody node's peg-in kept aside), then the provider service and the deposit's agent installed, the role and its settings
// written - as the wizard's bond step does; a node without LND gets it installed and started first (the confirm answers `waiting`
// until LND answers); refused without Bitcoin Core, when LND does not answer, and twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addLiquidityOnNode } from '../src/add-liquidity.js';
import { nodeState, LIQUIDITY_PROVIDER_PORT } from '../src/state.js';

function node(patch = {}) {
  const home = mkdtempSync(join(tmpdir(), 'liq-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(new Uint8Array(32).fill(6)); db.close();
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core', url: 'http://127.0.0.1:48332/' }, owner: { pubkey: 'ab'.repeat(32) },
    reach: { mode: 'permanent', url: 'https://node.example.com', port: 8570 }, lightning: { mode: 'own', restUrl: 'https://127.0.0.1:10080', lnddir: join(home, 'lnd'), pubkey: '03' + 'cd'.repeat(32) },
    custodyAgent: { installedMs: 1 }, ...patch });
  const installed = [];
  const kit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 312380 }] }), testLnd: async () => ({ ok: true, pubkey: '03' + 'cd'.repeat(32) }),
    installProgram: async (p) => { installed.push(p); return { ok: true }; } };
  return { home, state, kit, installed };
}

test('the plan sets nothing up; the confirm installs the provider on LND, adds the role and the claim file to the settings', async () => {
  const n = node();
  const p = await addLiquidityOnNode({ home: n.home, release: '/rel', state: n.state, kit: n.kit, node: '/node' });
  assert.equal(p.ok, true, p.why);
  assert.deepEqual([p.plan.depositSats, p.plan.walletSats, p.plan.reservedSats, p.plan.shortSats, p.plan.channelSats], [500000, 312380, 0, 188620, 100000]);
  assert.match(p.plan.address, /^tb1p/);
  assert.equal(n.installed.length, 0, 'the plan installs nothing');
  const r = await addLiquidityOnNode({ home: n.home, release: '/rel', state: n.state, kit: n.kit, node: '/node', post: true });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(n.installed.map((x) => x.id), ['liquidity'], 'the custody agent runs already: only the provider');
  assert.deepEqual(n.installed[0].args.slice(0, 2), ['/node', '/rel/packages/arena-installer/bin/liquidity-provider.mjs']);
  assert.ok(n.installed[0].args.includes(String(LIQUIDITY_PROVIDER_PORT)) && n.installed[0].args.includes(join(n.home, 'lnd')));
  assert.equal(readFileSync(join(n.home, 'liquidity.key'), 'utf8').trim(), '06'.repeat(32));
  assert.equal(statSync(join(n.home, 'liquidity.key')).mode & 0o077, 0, 'the key is the owner\'s alone');
  assert.deepEqual(n.state.read().roles, ['verify', 'settlement', 'liquidity']);
  const conf = readFileSync(join(n.home, 'arena.conf'), 'utf8');
  assert.match(conf, /liquidity-claim\.json/); assert.match(conf, /verify,settlement,liquidity/);
  assert.match((await addLiquidityOnNode({ home: n.home, release: '/rel', state: n.state, kit: n.kit })).why, /a liquidity provider already/);
});

test('a node with no agent gets it too; a custody node keeps its peg-in aside', async () => {
  const n = node({ custodyAgent: null });
  assert.equal((await addLiquidityOnNode({ home: n.home, release: '/rel', state: n.state, kit: n.kit, post: true })).ok, true);
  assert.deepEqual(n.installed.map((x) => x.id), ['liquidity', 'custody']);
  const c = node({ roles: ['verify', 'custody'], custody: { pegInSats: 50000 } });
  const p = await addLiquidityOnNode({ home: c.home, release: '/rel', state: c.state, kit: c.kit });
  assert.deepEqual([p.plan.reservedSats, p.plan.shortSats], [50000, 238620]);
  const sent = node({ roles: ['verify', 'custody'], custody: { pegInSats: 50000, pegIn: { txid: 'aa' } } });
  assert.equal((await addLiquidityOnNode({ home: sent.home, release: '/rel', state: sent.state, kit: sent.kit })).plan.reservedSats, 0, 'a peg-in sent is no longer kept aside');
});

test('refused: Electrum, LND not answering', async () => {
  const e = node({ chain: { kind: 'electrum' } });
  assert.match((await addLiquidityOnNode({ home: e.home, release: '/rel', state: e.state, kit: e.kit })).why, /your own Bitcoin Core/);
  const d = node();
  const r = await addLiquidityOnNode({ home: d.home, release: '/rel', state: d.state, kit: { ...d.kit, testLnd: async () => ({ ok: false, why: 'connection refused' }) }, post: true });
  assert.match(r.why, /LND does not answer: connection refused/);
  assert.equal(d.installed.length, 0);
});

test('no LND yet: the confirm installs it and waits; again while it starts; once it answers the provider is set up on it', async () => {
  const n = node({ lightning: null });
  const lnd = { mode: 'own', restUrl: 'https://127.0.0.1:10080', lnddir: join(n.home, 'lnd') };
  let starting = 2; const calls = [];
  const kit = { ...n.kit,
    setUpOwnLnd: async ({ state, release }) => { calls.push(['install', release]); state.save({ lightning: lnd }); return { ok: true, peers: 'not reachable from outside: Tor gives LND an onion address' }; },
    lndReady: async ({ state }) => { calls.push(['ready']); if (--starting > 0) return { ok: false, waiting: true, why: 'LND is not answering yet' }; state.save({ lightning: { ...lnd, pubkey: '02' + 'ef'.repeat(32) } }); return { ok: true, pubkey: '02' + 'ef'.repeat(32) }; } };
  const go = (post) => addLiquidityOnNode({ home: n.home, release: '/rel', state: n.state, kit, post });
  const p = await go(false);
  assert.deepEqual([p.ok, p.plan.lightning, p.plan.lightningPubkey], [true, 'install', null]);
  assert.equal(calls.length, 0, 'the plan installs nothing');
  const a = await go(true);
  assert.match(a.waiting, /LND is installed and starting \(not reachable from outside: Tor/);
  assert.deepEqual(n.installed, [], 'no provider before LND answers');
  const b = await go(true);
  assert.deepEqual([b.plan.lightning, b.waiting], ['starting', 'LND is starting: LND is not answering yet']);
  const c = await go(true);
  assert.equal(c.ok, true, c.why); assert.ok(c.done, 'set up');
  assert.equal(c.plan.lightningPubkey, '02' + 'ef'.repeat(32));
  assert.deepEqual(calls, [['install', '/rel'], ['ready'], ['ready']]);
  assert.deepEqual(n.installed.map((x) => x.id), ['liquidity']);
  assert.ok(n.installed[0].args.includes(join(n.home, 'lnd')), 'the provider on the new LND');
  assert.deepEqual(n.state.read().roles, ['verify', 'settlement', 'liquidity']);
});

test('an LND install that fails says why and sets nothing up', async () => {
  const n = node({ lightning: null });
  const r = await addLiquidityOnNode({ home: n.home, release: '/rel', state: n.state, post: true,
    kit: { ...n.kit, setUpOwnLnd: async () => ({ ok: false, why: 'the download\'s checksum does not match' }) } });
  assert.match(r.why, /LND could not be installed: the download's checksum does not match/);
  assert.deepEqual([n.installed.length, n.state.read().roles], [0, ['verify', 'settlement']]);
});
