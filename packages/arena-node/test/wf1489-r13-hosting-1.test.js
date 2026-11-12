// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r13 hosting-1: the automatic network update takes ONE source seat's network package and writes every series in it.
// Every other way a series reaches a seat is gated - POST /series needs a grid series that is funded here or whose publication this
// seat's own chain confirms (402 otherwise), the series pull (kanban #757) takes only a publication its chain confirms - but the
// auto-update sweep (server.js autoUpdateSweep -> takeNetwork(update) -> activateNetwork) holds and writes any series a single seat
// lists in its GET /network, as long as it is on the network, names the carried set in force and a hosted game. SAFE: a series
// nobody funded or published is not written by a seat because one source seat's network package names it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
// the attacker's own series: a paying nextblock series with a stake he picked, nobody funded or published it
const attackerSeries = (nodes) => seriesTemplate({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(SET2.recipients), censusHeight: 900100, censusRoot: new Uint8Array(32).fill(2), stakeMsat: 7777000n,
  bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
}, seriesIndexAt(NETWORK_ID_REGTEST, Date.now()) + 1);

test('r13 hosting-1: one source seat\'s network package does not make an auto-updating seat write a series nobody funded or published', async () => {
  const inviteF = inviteForGuardians(TEST_FEDERATION_ID, [{ url: 'ws://127.0.0.1:1/', peer: 0 }]);
  const nodes = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(8)];
  const evil = attackerSeries(nodes), evilId = toHex(seriesIdOf(evil));
  // A1: the honest network package (serial 1, no series). X: ONE seat of the network, running the same network and federation,
  // holding a series of its own making (an operator's series file - no funding, no publication needed for its own seat)
  const a1 = await serve(openStore(), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', federationInvite: inviteF, donationSets: [TEST_DONATION_SET_REGTEST] });
  const x = await serve(openStore(), { plugins: HOSTED, port: 0, chain: 'bitcoin-regtest', federationInvite: inviteF, donationSets: [TEST_DONATION_SET_REGTEST, SET2], series: [evil], seriesEveryMs: 100 });
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r13-h1-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: HOSTED, port: 0, pluginsDir: dir, chain: 'bitcoin-regtest', donationSets: [TEST_DONATION_SET_REGTEST], seriesEveryMs: 100,
    owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const url = (s) => `http://127.0.0.1:${s.port}`, B = url(b), net = toHex(NETWORK_ID_REGTEST);
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    // the owner installs the honest network package (as the store page does)
    let [st, j] = await post('/owner/network/install', req('network-install', { network: net, from: url(a1) }));
    assert.equal(st, 200, j.why);
    // B's own series door refuses the attacker's series (nobody funded or published it)
    const direct = await fetch(`${B}/series`, { method: 'POST', body: seriesLineOf(evil) });
    const directWhy = await direct.text();
    assert.notEqual(direct.status, 200, 'POST /series refuses it');
    // automatic updates: the sources are the network's seats (here named, as the default networkSeats() would list X)
    [st, j] = await post('/owner/settings', req('settings', { autoUpdate: true, sources: [url(x)] }));
    assert.equal(st, 200);
    const heldSeries = async () => (await (await fetch(`${B}/series`)).json()).series.map((s) => s.series);
    let held = [];
    for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); held = await heldSeries(); if (held.includes(evilId)) break; }
    console.log('  FACTS:', JSON.stringify({ directStatus: direct.status, directWhy: directWhy.slice(0, 120), heldAfterAutoUpdate: held.map((h) => h.slice(0, 16)), evil: evilId.slice(0, 16) }));
    assert.ok(!held.includes(evilId), `B writes series ${evilId.slice(0, 16)} that one seat's network package named, though its own doors refuse it`);
  } finally { for (const s of [a1, x, b]) await s.close(); }
});
