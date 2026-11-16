// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r25 hosting-2: THE AUTOMATIC NETWORK UPDATE REPLACES THE OWNER'S PACKAGE WITH ONE SEAT'S STRIPPED COPY.
// A network package's manifest (its list of sets, rotations and series) is signed by nobody, and checkNetworkUpdate only asks that
// the update is the same network and that its top donation-set serial is not lower. So ANY seat of the network (role c: one seat,
// not even malicious - one that simply holds none of the owner's series) answering GET /network with a package that carries no
// series is taken by the auto-update sweep (takeNetwork update/auto) and written over <plugins>/networks/<id>/package.json. Nothing
// changes while the process runs (activateNetwork merges), but at the next start the seat loads only that stripped package:
// the series the OWNER installed (and named in owner-series.json) are no longer held or written - its rounds stop on this seat.
// SAFE: after an automatic update from one seat and a restart, a seat still holds the series its owner installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { inviteForGuardians } from '../src/invite.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID, TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { seriesTemplate, seriesIndexAt, seriesId as seriesIdOf } from '../../arena-protocol/src/series.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { decodeDonationSetBody } from '../../arena-protocol/src/authority.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { seriesLineOf } from '../src/series-line.js';

// the regtest serial-2 set (as plugin-store.test.js), signed by the regtest donation authority
const SET2 = { ...decodeDonationSetBody(Uint8Array.from(Buffer.from('1400019855e6790b51f0a6ec3ee1a4d83f4de9ad4be7bffb169f0525ad00a59ced5b380000000000000002000dbc040099100001000200466c6e75726c31647036386775726e3867686a376572306465736867656677763475787a6d747364336a6a376d7277773465786375703064656a68736170647679306e387265381a0b00466c6e75726c31647036386775726e3867686a376572306465736867656677763475787a6d747364336a6a376d7277773465786375703064656a687361706476673764706667710d05', 'hex'))),
  signature: Uint8Array.from(Buffer.from('f007229c5185a12eeed3310cd5722b576d39121927ef6cdf9624fb868ac61e200cdf60274fbb68cd6f46425d05ba611c989d06e4f606e9ef3b34f33244332e0b', 'hex')) };
// the series the owner installs with the honest network package
const ownerSeriesT = (nodes) => seriesTemplate({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(SET2.recipients), censusHeight: 900100, censusRoot: new Uint8Array(32).fill(2), stakeMsat: 7777000n,
  bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
}, seriesIndexAt(NETWORK_ID_REGTEST, Date.now()) + 1);

test('r25 hosting-2: one seat\'s stripped network package, auto-taken, drops the owner\'s installed series at the next start', async () => {
  const inviteF = inviteForGuardians(TEST_FEDERATION_ID, [{ url: 'ws://127.0.0.1:1/', peer: 0 }]);
  const nodes = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(8)];
  const S = ownerSeriesT(nodes), sid = toHex(seriesIdOf(S));
  // A1: the honest seat the owner installs from (holds series S); X: another seat of the network holding no series at all
  const a1 = await serve(openStore(), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', federationInvite: inviteF, donationSets: [TEST_DONATION_SET_REGTEST, SET2], series: [S], seriesEveryMs: 100 });
  const x = await serve(openStore(), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', federationInvite: inviteF, donationSets: [TEST_DONATION_SET_REGTEST, SET2] });
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r25-h2-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const ownerOpt = { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  let b = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], seriesEveryMs: 100, owner: ownerOpt });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  let b2 = null;
  try {
    const url = (s) => `http://127.0.0.1:${s.port}`, net = toHex(NETWORK_ID_REGTEST);
    const B = url(b);
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    let [st, j] = await post('/owner/network/install', req('network-install', { network: net, from: url(a1) }));
    assert.equal(st, 200, j.why);
    const heldAt = async (base) => (await (await fetch(`${base}/series`)).json()).series.map((s) => s.series);
    const before = await heldAt(B);
    assert.ok(before.includes(sid), 'the owner\'s install holds series S');
    // automatic updates from one other seat of the network (the default sources are the census seats)
    [st, j] = await post('/owner/settings', req('settings', { autoUpdate: true, sources: [url(x)] }));
    assert.equal(st, 200);
    const pkgFile = join(dir, 'networks', net, 'package.json');
    let kept = null;
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 100)); try { kept = JSON.parse(readFileSync(pkgFile, 'utf8')); } catch { kept = null; } if (kept && (kept.series || []).length === 0) break; }
    await b.close(); b = null;
    // the seat restarts on the same plugins directory
    b2 = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], seriesEveryMs: 100, owner: ownerOpt });
    const after = await heldAt(url(b2));
    console.log('  FACTS:', JSON.stringify({ heldBefore: before.map((h) => h.slice(0, 16)), keptPackageSeries: (kept?.series || []).length, ownerSeriesFile: readFileSync(join(dir, 'networks', net, 'owner-series.json'), 'utf8').slice(0, 80), heldAfterRestart: after.map((h) => h.slice(0, 16)) }));
    assert.ok(after.includes(sid), `after one seat's automatic update and a restart the seat no longer holds the owner's series ${sid.slice(0, 16)}`);
  } finally { for (const s of [a1, x, b, b2]) if (s) await s.close(); }
});
