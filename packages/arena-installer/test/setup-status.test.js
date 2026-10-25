// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The dashboards' setup status (kanban #635): the installer no longer waits for confirmations or for Bitcoin Core's sync, so the node says
// how far its bond, its peg-in and its Core are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupStatus, PEG_IN_FINALITY } from '../src/setup-status.js';

test('the bond\'s and the peg-in\'s confirmations, whether the bond counts, and Core\'s background sync', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arena-setup-status-'));
  try {
    writeFileSync(join(home, 'seed.hex'), 'cc'.repeat(32));
    const bond = { txid: 'b0'.repeat(32), sats: '50000', maturity: 157748 }, pegTx = 'c0'.repeat(32);
    writeFileSync(join(home, 'state.json'), JSON.stringify({ chain: { kind: 'electrum', host: 'h', port: 1 }, bond, custody: { pegIn: { txid: pegTx, sats: 50000, federationId: 'f1' } },
      core: { dir: '/disk2', interim: true, networks: { testnet4: {} } } }));
    writeFileSync(join(home, 'chain-switch.json'), JSON.stringify({ state: 'syncing', sync: { blocks: 80000, headers: 157560, progress: 0.41, etaMs: 7200000 }, atMs: 1 }));
    const heights = { [bond.txid]: 157550, [pegTx]: 0 };
    const reader = async () => ({ tip: 157559, heightOf: async (t) => (t in heights ? heights[t] : null), close: () => {} });
    const r = await setupStatus({ home, reader });
    assert.equal(r.ok, true, r.why);
    assert.deepEqual([r.bond.confirmations, r.bond.counts, r.bond.seen, r.bond.needed], [10, true, true, 6], 'confirmed at 157,550: 10 confirmations, inside its slack');
    assert.equal(r.bond.blocksToMaturity, 157748 - 157559);
    assert.ok(r.bond.confirmBy > 157550 && r.bond.confirmBy < 157748, 'the height it had to confirm by');
    assert.deepEqual([r.pegIn.confirmations, r.pegIn.seen, r.pegIn.credited, r.pegIn.needed], [0, true, false, PEG_IN_FINALITY], 'the peg-in in the mempool');
    assert.deepEqual([r.core.state, r.core.interim, r.core.dir, r.core.sync.progress], ['syncing', true, '/disk2', 0.41]);
    heights[pegTx] = 157460;
    assert.equal((await setupStatus({ home, reader })).pegIn.credited, true, '100 confirmations: credited');
    heights[bond.txid] = 157700;
    assert.equal((await setupStatus({ home, reader })).bond.counts, false, 'confirmed too late for its maturity: it does not count');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// EVERYTHING ELSE UNDER WAY (2026-10-25: "lnd status and everything else that may be in progress"): LND, the gateway and the address
// as their checks answer; the faucet's coins, advertisement updates and old bonds from the chain
test('LND, the gateway, the address, the faucet, advertisement updates and old bonds', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arena-setup-status-'));
  try {
    writeFileSync(join(home, 'seed.hex'), 'cc'.repeat(32));
    const faucet = { txid: 'fa'.repeat(32), sats: 52000 }, games = { txid: '9a'.repeat(32), atMs: 1 }, key = { from: 'aa', to: 'bb', bond: 'bb'.repeat(32), atMs: 2 };
    writeFileSync(join(home, 'state.json'), JSON.stringify({ chain: { kind: 'electrum', host: 'h', port: 1 }, faucet, gamesUpdate: games, keySwitch: key,
      oldBonds: [{ txid: '77'.repeat(32), sats: '50000', maturity: 157600 }] }));
    const heights = { [faucet.txid]: 157550, [games.txid]: 157557, [key.bond]: 0 };
    const reader = async () => ({ tip: 157559, heightOf: async (t) => (t in heights ? heights[t] : null), close: () => {} });
    const services = async () => ({ lnd: { ok: true, synced: true, height: 157559, channels: 1, pending: 0 }, gateway: { ok: false, syncing: true, why: 'syncing' }, address: { ok: true, url: 'https://n.example' } });
    const r = await setupStatus({ home, reader, services });
    assert.equal(r.ok, true, r.why);
    assert.deepEqual([r.faucet.confirmations, r.faucet.seen], [10, true]);
    assert.deepEqual(r.updates.map((u) => [u.kind, u.confirmations, u.counts]), [['gamesUpdate', 3, false], ['keySwitch', 0, false]]);
    assert.deepEqual(r.oldBonds.map((o) => [o.blocksLeft, o.back]), [[41, false]]);
    assert.deepEqual([r.lnd.synced, r.gateway.syncing, r.address.ok], [true, true, true]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the address check: this node answers there, another one does not count', async () => {
  const { servicesOf } = await import('../src/setup-status.js');
  const s = { reach: { url: 'https://n.example' }, service: { identity: 'ab'.repeat(32) } };
  const ok = await servicesOf(s, { fetcher: async () => new Response(Buffer.from('ab'.repeat(32), 'hex')) });
  assert.deepEqual(ok.address, { ok: true, url: 'https://n.example' });
  const other = await servicesOf(s, { fetcher: async () => new Response(Buffer.from('cd'.repeat(32), 'hex')) });
  assert.deepEqual([other.address.ok, other.address.why], [false, 'another node answers there']);
});

// HOW LONG IT STILL TAKES (the owner's playtest 2026-10-25: "Include an ETA how long it'll take ... If gateway is not started take that times
// the needed peg in blocks. If it's already started show that estimate. We need one big number on top until the node is ready, and for each
// item individual etas")
test('each part\'s ETA and the node\'s: Core\'s own, LND from its catch-up speed, confirmations and the peg-in from the block speed', async () => {
  const { setupEtas, TARGET_BLOCK_MS } = await import('../src/setup-status.js');
  const min = 60000, blockMs = 8 * min;
  const core = { interim: true, sync: { blocks: 148944, headers: 157605, progress: 0.945, etaMs: 10 * min } };
  const syncing = { core, tip: 157605, lnd: { ok: true, synced: false, height: 149091 }, gateway: { ok: false, syncing: true },
    bond: { confirmations: 0, seen: true, needed: 6 }, faucet: { confirmations: 0, seen: true }, address: { ok: true }, updates: [{ confirmations: 2, needed: 6, counts: false }] };
  const e = setupEtas(syncing, { blockMs, lndPerMs: null });
  assert.equal(e.core, 10 * min);
  assert.equal(e.lnd, 10 * min, 'LND reads its blocks from Core: no faster than Core, and no speed of its own measured yet');
  assert.equal(e.gateway, 10 * min + PEG_IN_FINALITY * blockMs, 'not started: LND, then the peg-in\'s 100 blocks');
  assert.deepEqual([e.bond, e.faucet, e.address, e.updates], [6 * blockMs, blockMs, 0, [4 * blockMs]], 'the bond counts at 6 confirmations, not 1');
  assert.equal(setupEtas({ ...syncing, bond: { confirmations: 4, seen: true, needed: 6 } }, { blockMs }).bond, 2 * blockMs);
  assert.equal(setupEtas({ ...syncing, bond: { confirmations: 9, seen: true, needed: 6, counts: true } }, { blockMs }).bond, 0);
  assert.equal(e.ready, e.gateway, 'the node is ready when its slowest part is');
  assert.equal(e.partial, false);
  // LND measured: 8,514 blocks to go at 10 blocks a second
  assert.equal(setupEtas(syncing, { blockMs, lndPerMs: 0.01 }).lnd, (157605 - 149091) / 0.01);
  // the gateway started, its peg-in sent: that peg-in's blocks
  const started = { ...syncing, core: { interim: false }, lnd: { ok: true, synced: true, height: 157605 }, gateway: { ok: true, federations: 0 },
    pegIn: { confirmations: 40, needed: PEG_IN_FINALITY, credited: false } };
  const s2 = setupEtas(started, { blockMs });
  assert.deepEqual([s2.core, s2.lnd, s2.pegIn, s2.gateway], [0, 0, 60 * blockMs, 60 * blockMs]);
  // LND not answering: no time for it, and `ready` says it is at least what the others take
  const broken = setupEtas({ ...syncing, lnd: { ok: false, why: 'x' } }, { blockMs });
  assert.deepEqual([broken.lnd, broken.gateway, broken.partial], [null, null, true]);
  assert.equal(setupEtas({ core: { interim: false }, gateway: { ok: true, federations: 1 } }).ready, 0, 'all done');
  assert.equal(TARGET_BLOCK_MS, 10 * min);
});

test('the block speed from the chain and LND\'s speed between two reads reach the status', async () => {
  const home = mkdtempSync(join(tmpdir(), 'arena-setup-status-'));
  try {
    writeFileSync(join(home, 'seed.hex'), 'cc'.repeat(32));
    writeFileSync(join(home, 'state.json'), JSON.stringify({ chain: { kind: 'electrum', host: 'h', port: 1 }, faucet: { txid: 'fa'.repeat(32), sats: 1 } }));
    const reader = async () => ({ tip: 157605, heightOf: async () => 0, blockMs: async () => 420000, close: () => {} });
    let height = 150000;
    const services = async () => ({ lnd: { ok: true, synced: false, height }, gateway: null, address: null });
    const first = await setupStatus({ home, reader, services, nowMs: 1_000_000 });
    assert.deepEqual([first.blockMs, first.blockMsMeasured, first.etas.faucet], [420000, true, 420000]);
    assert.equal(first.etas.lnd, null, 'one read: no speed yet');
    height = 150600;
    const second = await setupStatus({ home, reader, services, nowMs: 1_000_000 + 60000 });
    assert.equal(second.etas.lnd, (157605 - 150600) / (600 / 60000), '600 blocks in a minute');
    const unmeasured = await setupStatus({ home, reader: async () => ({ tip: 157605, heightOf: async () => 0, close: () => {} }), services });
    assert.deepEqual([unmeasured.blockMs, unmeasured.blockMsMeasured], [600000, false]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
