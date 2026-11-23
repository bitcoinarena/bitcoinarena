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
// SKEPTIC 2 (#3026, lens: another attacker role + the reload path): the fix closed the two-fetch gap only for the automatic update. The owner
// page (NetworkPanel.jsx) fetches the source's GET /network itself, checks it and shows its federation, and the owner signs only
// { network, from } - takeNetwork then FETCHES AGAIN from that source. A source seat answers the page's ask with the honest same-federation
// package and the seat's own ask with one naming ITS federation: the seat's federation goes DRAINING toward the attacker's, and stays
// draining across a restart (draining.json), though the owner never saw, never signed, any succession.
// SAFE: a package the owner did not see is not taken - the held federation is not drained toward a federation the owner never saw.
test('#3026 s2-1: the owner update re-fetches; the source seat swaps in its own federation after the owner page checked the honest one', async () => {
  const fedB = new Uint8Array(32).fill(0xbb);
  const evil = networkPackageOf({ chain: 'bitcoin-regtest', networkId: NETWORK_ID_REGTEST, invite: inviteForGuardians(fedB, [{ url: 'ws://127.0.0.1:2/', peer: 0 }]), sets: [TEST_DONATION_SET_REGTEST] });
  const { a1, x, X, dir, secret, ownerOpt, st } = await setup((n, honest) => (n === 1 ? honest : evil));
  const b = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], owner: ownerOpt });
  let b2 = null;
  try {
    const B = url(b);
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    let [s, j] = await post('/owner/network/install', req('network-install', { network: net, from: url(a1) }));
    assert.equal(s, 200, j.why);
    // the owner page reads the offer from X and shows it: federation A, the held one
    const seen = await (await fetch(`${X}/network?network=${net}`)).json();
    assert.equal(seen.manifest.federationId, toHex(TEST_FEDERATION_ID));
    [s, j] = await post('/owner/network/update', req('network-update', { network: net, from: X }));
    const drainFile = join(dir, 'networks', net, 'draining.json');
    await b.close();
    b2 = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], owner: ownerOpt });
    const after = await (await fetch(`${url(b2)}/network?network=${net}`)).json();
    console.log('  FACTS:', JSON.stringify({ asks: st.asks, updateStatus: s, why: j.why, draining: existsSync(drainFile) ? readFileSync(drainFile, 'utf8').slice(0, 200) : null, servedFedAfterRestart: after.manifest && after.manifest.federationId }));
    assert.equal(existsSync(drainFile), false, `the owner saw federation ${toHex(TEST_FEDERATION_ID).slice(0, 16)} and signed an update; the source seat's second answer made it DRAINING toward ${toHex(fedB).slice(0, 16)} (kept across the restart)`);
  } finally { for (const s of [a1, b, b2]) if (s) await s.close().catch(() => {}); await new Promise((ok) => x.close(ok)); }
});
// THE HONEST PATHS STAY (kanban #3164): a succession the owner signs by its federation id is taken; a package other than the one the owner
// signed by id is refused even when its federation is the held one
test('#3164 s2-1 honest: the owner signs the successor federation id and the succession is taken; another package than the signed id is not', async () => {
  const fedB = new Uint8Array(32).fill(0xbb);
  const next = networkPackageOf({ chain: 'bitcoin-regtest', networkId: NETWORK_ID_REGTEST, invite: inviteForGuardians(fedB, [{ url: 'ws://127.0.0.1:2/', peer: 0 }]), sets: [TEST_DONATION_SET_REGTEST] });
  const { a1, x, X, dir, secret, ownerOpt } = await setup(() => next);
  const b = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], owner: ownerOpt });
  try {
    const B = url(b);
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    let [s, j] = await post('/owner/network/install', req('network-install', { network: net, from: url(a1) }));
    assert.equal(s, 200, j.why);
    [s, j] = await post('/owner/network/update', req('network-update', { network: net, from: X, id: 'ab'.repeat(32), federationId: toHex(fedB) }));
    assert.equal(s, 422, 'a package other than the one signed by id is refused');
    assert.equal(existsSync(join(dir, 'networks', net, 'draining.json')), false);
    [s, j] = await post('/owner/network/update', req('network-update', { network: net, from: X, id: next.id, federationId: toHex(fedB), invite: next.invite }));
    assert.equal(s, 200, j.why);
    assert.equal(j.held.federationId, toHex(fedB));
    assert.ok(existsSync(join(dir, 'networks', net, 'draining.json')), 'the signed succession drains the old federation toward the new one');
  } finally { for (const s of [a1, b]) await s.close().catch(() => {}); await new Promise((ok) => x.close(ok)); }
});
