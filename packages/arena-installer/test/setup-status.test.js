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
    assert.deepEqual([r.bond.confirmations, r.bond.counts, r.bond.seen], [10, true, true], 'confirmed at 157,550: 10 confirmations, inside its slack');
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
