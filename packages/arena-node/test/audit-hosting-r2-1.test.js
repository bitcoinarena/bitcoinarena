// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit hosting r2-1: THE AUTOMATIC NETWORK UPDATE CHECKS THE FEDERATION ON ONE FETCH AND TAKES ANOTHER.
// autoUpdateSweep (server.js:1656-1665) fetches a source's GET /network, refuses it when it names another federation ("a succession
// is the owner's to take"), and then calls takeNetwork, which FETCHES GET /network AGAIN and checks only the package itself
// (checkOnSeat, checkNetworkUpdate, the #2845 owner-series guard) - never its federation against the held one. One source seat
// (role c) answers the first ask with the honest package (its `id` left out, so the same-package skip passes) and the second with
// a package of the same network and sets naming ITS OWN federation. activateNetwork then calls markDraining: the seat's own
// federation is DRAINING with the attacker's federation as successor, kept in draining.json across restarts - no new round or
// deposit names it, its paid series stop being written, and successorOf() names the attacker's federation in its records.
// SAFE: an automatic update never makes the held federation draining; the held package still names the owner's federation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { inviteForGuardians } from '../src/invite.js';
import { networkPackageOf } from '../src/network-check.js';
import { HOSTED } from './plugins/hosted.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';

test('audit hosting r2-1: one source seat gets a federation succession past the auto-update federation check (two fetches)', async () => {
  const inviteA = inviteForGuardians(TEST_FEDERATION_ID, [{ url: 'ws://127.0.0.1:1/', peer: 0 }]);
  const fedB = new Uint8Array(32).fill(0xbb);
  const inviteB = inviteForGuardians(fedB, [{ url: 'ws://127.0.0.1:2/', peer: 0 }]);
  // A1: the honest seat the owner installs the network from (its federation A, no series)
  const a1 = await serve(openStore(), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', federationInvite: inviteA, donationSets: [TEST_DONATION_SET_REGTEST] });
  const url = (s) => `http://127.0.0.1:${s.port}`, net = toHex(NETWORK_ID_REGTEST);
  const honest = await (await fetch(`${url(a1)}/network?network=${net}`)).json();
  const { id: _drop, ...honestNoId } = honest; void _drop;
  const evil = networkPackageOf({ chain: 'bitcoin-regtest', networkId: NETWORK_ID_REGTEST, invite: inviteB, sets: [TEST_DONATION_SET_REGTEST] });
  // X: the one source seat - the sweep's first ask gets the honest package, takeNetwork's ask the one naming federation B
  let asks = 0;
  const x = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname === '/games') return res.end(JSON.stringify({ games: [] }));
    if (u.pathname === '/network') { asks++; return res.end(JSON.stringify(asks % 2 === 1 ? honestNoId : evil)); }
    res.end('{}');
  });
  await new Promise((ok) => x.listen(0, '127.0.0.1', ok));
  const X = `http://127.0.0.1:${x.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'audit-hosting-r2-1-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const ownerOpt = { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], owner: ownerOpt });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const B = url(b);
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    let [st, j] = await post('/owner/network/install', req('network-install', { network: net, from: url(a1) }));
    assert.equal(st, 200, j.why);
    [st, j] = await post('/owner/settings', req('settings', { autoUpdate: true, sources: [X] }));
    assert.equal(st, 200);
    const drainFile = join(dir, 'networks', net, 'draining.json');
    for (let i = 0; i < 40 && !existsSync(drainFile); i++) await new Promise((r) => setTimeout(r, 100));
    const view = await (await fetch(`${B}/owner/network`, { method: 'GET' })).json().catch(() => null);
    const pkgNow = JSON.parse(readFileSync(join(dir, 'networks', net, 'package.json'), 'utf8'));
    console.log('  FACTS:', JSON.stringify({ asks, drainingFile: existsSync(drainFile) ? readFileSync(drainFile, 'utf8').slice(0, 200) : null,
      heldInviteIsB: pkgNow.invite === inviteB, ownerNetworkView: view && view.draining }));
    assert.equal(existsSync(drainFile), false, `one source seat made the seat's own federation ${toHex(TEST_FEDERATION_ID).slice(0, 16)} DRAINING with successor ${toHex(fedB).slice(0, 16)} (draining.json written) through the automatic update`);
    assert.equal(pkgNow.invite, inviteA, 'the held package still names the owner\'s federation');
  } finally { for (const s of [a1, b]) if (s) await s.close(); await new Promise((ok) => x.close(ok)); }
});

