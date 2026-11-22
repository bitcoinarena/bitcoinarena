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


const url = (s) => `http://127.0.0.1:${s.port}`, net = toHex(NETWORK_ID_REGTEST);
const inviteA = inviteForGuardians(TEST_FEDERATION_ID, [{ url: 'ws://127.0.0.1:1/', peer: 0 }]);
async function setup(answer) {
  const a1 = await serve(openStore(), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', federationInvite: inviteA, donationSets: [TEST_DONATION_SET_REGTEST] });
  const honest = await (await fetch(`${url(a1)}/network?network=${net}`)).json();
  const st = { asks: 0 };
  const x = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname === '/games') return res.end(JSON.stringify({ games: [] }));
    if (u.pathname === '/network') { st.asks++; return res.end(JSON.stringify(answer(st.asks, honest))); }
    res.end('{}');
  });
  await new Promise((ok) => x.listen(0, '127.0.0.1', ok));
  const X = `http://127.0.0.1:${x.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r1120b-16-s2-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const ownerOpt = { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } };
  return { a1, x, X, dir, secret, ownerOpt, st };
}
// SKEPTIC 2 (#3026, lens: a stranger/peer source seat + reload): the automatic update now compares the federation ID of the package taken,
// but a package naming the SAME federation id with the source seat's own guardian URLs in its invite passes every check (the package id
// does not hash the invite; a missing `id` passes the sweep's same-package skip). The held invite - what GET /network hands every other
// seat and the endpoints this seat reads its federation's config at (inviteOfFed) - becomes the attacker's, kept in package.json across
// restarts, with no owner act.
// SAFE: an automatic update does not replace the held federation's invite with guardian URLs no owner chose.
test('#3026 s2-2: an automatic update keeps the federation id but swaps the invite to the source seat\'s guardian URLs', async () => {
  const inviteEvil = inviteForGuardians(TEST_FEDERATION_ID, [{ url: 'ws://evil.example:9/', peer: 0 }]);
  const evil = networkPackageOf({ chain: 'bitcoin-regtest', networkId: NETWORK_ID_REGTEST, invite: inviteEvil, sets: [TEST_DONATION_SET_REGTEST] });
  const { id: _d, ...evilNoId } = evil; void _d;
  const { a1, x, X, dir, secret, ownerOpt, st } = await setup(() => evilNoId);
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], owner: ownerOpt });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  let b2 = null;
  try {
    const B = url(b);
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    let [s, j] = await post('/owner/network/install', req('network-install', { network: net, from: url(a1) }));
    assert.equal(s, 200, j.why);
    [s, j] = await post('/owner/settings', req('settings', { autoUpdate: true, sources: [X] }));
    assert.equal(s, 200);
    const pf = join(dir, 'networks', net, 'package.json');
    for (let i = 0; i < 40 && JSON.parse(readFileSync(pf, 'utf8')).invite !== inviteEvil; i++) await new Promise((r) => setTimeout(r, 100));
    await b.close();
    b2 = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], owner: ownerOpt });
    const served = await (await fetch(`${url(b2)}/network?network=${net}`)).json();
    console.log('  FACTS:', JSON.stringify({ asks: st.asks, heldInviteIsEvil: JSON.parse(readFileSync(pf, 'utf8')).invite === inviteEvil, servedAfterRestartIsEvil: served.invite === inviteEvil }));
    assert.equal(served.invite, inviteA, 'after a restart the seat hands out the source seat\'s guardian URLs as its federation\'s invite, taken by the automatic update');
  } finally { for (const s of [a1, b, b2]) if (s) await s.close().catch(() => {}); await new Promise((ok) => x.close(ok)); }
});
