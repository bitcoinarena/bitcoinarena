// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute 8, skeptic 3 (fix #1818 d1df710da + #2270 8dcae9501 + #2339/#2348 d2da124ca): the mirror's chain census
// budget is now "per gather pass" (MIRROR_CENSUS_PER_PASS 8, MIRROR_CENSUS_PER_ANSWER 2 per guardian node). But a gather pass is not
// only the seat's timer: GET /federations?fresh=1 (server.js) runs fedRecords.gatherAll for ANY caller, no rate limit, each call a new
// pass with a fresh budget. The comparable door GET /network-games?fresh=1 is bounded for strangers (NETWORK_APPS_FRESH_MS, kanban
// #1540); this one is not. One bonded census seat answering self-signed 1-of-1 records at fresh heights plus a stranger asking
// ?fresh=1 N times = 2N chain census derivations (ballot.censusEntriesAt -> chainCensusKept: ~2,017 bitcoind blocks and a census_kept
// row each). The #1818 cost through the per-pass budget, on request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { inviteForGuardians } from '../src/invite.js';

test('a stranger asking GET /federations?fresh=1 50 times does not make the seat derive a chain census per ask', async () => {
  const evil = { secret: new Uint8Array(32).fill(0x77) }; evil.pubkey = schnorr.getPublicKey(evil.secret);
  const fid = new Uint8Array(32).fill(0x2a);
  const advertKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x61)]);
  const recordKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x62)]);
  let h = 1000; let hits = 0;
  // the bonded seat: every ask, two fresh self-signed records (sole guardian, a peer key not its advert's: fails the census, passes its own list)
  const evilSeat = createServer((req, res) => {
    hits++;
    if (!req.url.startsWith('/federations')) { res.writeHead(404); return res.end('no'); }
    const out = [];
    for (let j = 0; j < 2; j++) {
      const rec = buildFederationRecord({ federationId: fid, networkId: NETWORK_ID_REGTEST, invite: inviteForGuardians(fid, [{ url: 'wss://g.example', peer: 0 }]), nominal: 1,
        guardians: [{ peerKey: recordKey, nodePubkey: evil.pubkey, operatorId: 'evil', bondTxid: new Uint8Array(32).fill(0xe0), bondVout: 0, endpoint: '', bondSats: 50000n }], height: h++ });
      const body = { federationId: rec.federationId, networkId: rec.networkId, invite: rec.invite, nominal: rec.nominal, threshold: rec.threshold, guardians: rec.guardians,
        status: rec.status, successorId: rec.successorId, gone: rec.gone, exposureCapSats: rec.exposureCapSats, reserveSats: rec.reserveSats, height: rec.height };
      const sig = schnorr.sign(federationRecordId(body), evil.secret);
      out.push({ federation: toHex(fid), status: 'OPEN', record: toHex(joinSignedRecord(encodeFederationRecord(body), [{ nodePubkey: evil.pubkey, signature: sig }])) });
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ federations: out }));
  }).listen(0);
  await new Promise((ok) => evilSeat.once('listening', ok));
  const entries = [{ pubkey: evil.pubkey, txid: new Uint8Array(32).fill(0xe0), vout: 0, bondSats: 50000n,
    advert: { operatorId: 'evil', endpoint: `http://127.0.0.1:${evilSeat.address().port}`, guardianOf: [{ federationId: fid, guardianKey: advertKey }] } }];
  const reads = []; const tip = 157092;
  const s = await serve(openStore(), { port: 0, chain: 'bitcoin-regtest', chainTip: async () => tip,
    ballot: { censusEntriesAt: async (_net, height) => { reads.push(height); return entries; } } });
  try {
    const S = `http://127.0.0.1:${s.port}`;
    // the seat's own basis read (chainAhead) is one height; let it settle
    await (await fetch(`${S}/federations?fresh=1`)).json();
    const before = new Set(reads.filter((x) => x < 100000)).size;
    for (let i = 0; i < 50; i++) await (await fetch(`${S}/federations?fresh=1`)).json();
    const recordHeights = new Set(reads.filter((x) => x < 100000)).size;
    console.log(`GET /federations?fresh=1 x51 from a stranger: chain census reads at ${recordHeights} record heights (${before} after the first ask), ${reads.length} reads in all, the bonded seat asked ${hits} times, reads ${JSON.stringify(reads.slice(0, 12))}`);
    assert.ok(recordHeights <= 8, `a stranger's ?fresh=1 asks made the seat derive the chain's census at ${recordHeights} record heights (MIRROR_CENSUS_PER_PASS is 8 a pass)`);
  } finally { await s.close(); evilSeat.close(); }
});

test('50 concurrent GET /federations?fresh=1 asks share one gather pass (kanban #2370)', async () => {
  const evil = { secret: new Uint8Array(32).fill(0x77) }; evil.pubkey = schnorr.getPublicKey(evil.secret);
  const fid = new Uint8Array(32).fill(0x2a);
  const advertKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x61)]);
  const recordKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x62)]);
  let h = 1000; let hits = 0;
  // the bonded seat: every ask, two fresh self-signed records (sole guardian, a peer key not its advert's: fails the census, passes its own list)
  const evilSeat = createServer((req, res) => {
    hits++;
    if (!req.url.startsWith('/federations')) { res.writeHead(404); return res.end('no'); }
    const out = [];
    for (let j = 0; j < 2; j++) {
      const rec = buildFederationRecord({ federationId: fid, networkId: NETWORK_ID_REGTEST, invite: inviteForGuardians(fid, [{ url: 'wss://g.example', peer: 0 }]), nominal: 1,
        guardians: [{ peerKey: recordKey, nodePubkey: evil.pubkey, operatorId: 'evil', bondTxid: new Uint8Array(32).fill(0xe0), bondVout: 0, endpoint: '', bondSats: 50000n }], height: h++ });
      const body = { federationId: rec.federationId, networkId: rec.networkId, invite: rec.invite, nominal: rec.nominal, threshold: rec.threshold, guardians: rec.guardians,
        status: rec.status, successorId: rec.successorId, gone: rec.gone, exposureCapSats: rec.exposureCapSats, reserveSats: rec.reserveSats, height: rec.height };
      const sig = schnorr.sign(federationRecordId(body), evil.secret);
      out.push({ federation: toHex(fid), status: 'OPEN', record: toHex(joinSignedRecord(encodeFederationRecord(body), [{ nodePubkey: evil.pubkey, signature: sig }])) });
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ federations: out }));
  }).listen(0);
  await new Promise((ok) => evilSeat.once('listening', ok));
  const entries = [{ pubkey: evil.pubkey, txid: new Uint8Array(32).fill(0xe0), vout: 0, bondSats: 50000n,
    advert: { operatorId: 'evil', endpoint: `http://127.0.0.1:${evilSeat.address().port}`, guardianOf: [{ federationId: fid, guardianKey: advertKey }] } }];
  const reads = []; const tip = 157092;
  const s = await serve(openStore(), { port: 0, chain: 'bitcoin-regtest', chainTip: async () => tip,
    ballot: { censusEntriesAt: async (_net, height) => { reads.push(height); return entries; } } });
  try {
    const S = `http://127.0.0.1:${s.port}`;
    // the seat's own basis read (chainAhead) is one height; let it settle
    const before = new Set(reads.filter((x) => x < 100000)).size;
    await Promise.all(Array.from({ length: 50 }, async () => (await fetch(`${S}/federations?fresh=1`)).json()));
    const recordHeights = new Set(reads.filter((x) => x < 100000)).size;
    console.log(`GET /federations?fresh=1 x50 at once from a stranger: chain census reads at ${recordHeights} record heights (${before} after the first ask), ${reads.length} reads in all, the bonded seat asked ${hits} times, reads ${JSON.stringify(reads.slice(0, 12))}`);
    assert.ok(recordHeights <= 8, `a stranger's ?fresh=1 asks made the seat derive the chain's census at ${recordHeights} record heights (MIRROR_CENSUS_PER_PASS is 8 a pass)`);
  } finally { await s.close(); evilSeat.close(); }
});
