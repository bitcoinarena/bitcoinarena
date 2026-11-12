// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute 8, skeptic 2 (fix #1818 d1df710da + #2270 8dcae9501): the mirror bound is MIRROR_CENSUS_PER_PASS "in a pass",
// but censusKept is made per mirror() call, i.e. per FEDERATION. One bonded census seat (the attacker role here: a seat, not a stranger)
// lists K made-up federation ids in its own advert's guardianOf; gatherAll mirrors every federation the census names and asks that seat
// (its only guardian) for GET /federations. For each fake id it answers records it signed itself as the sole guardian (nominal 1,
// threshold 1, a peer key other than its advert's, so the record fails the seat's census and passes its own guardian list), each at a new
// height. Every one of the K mirrors reads MIRROR_CENSUS_PER_ANSWER new chain census heights: 2K reads in one pass, not 8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { federationRecords } from '../src/federation-records.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const NET = new Uint8Array(32).fill(0x10);
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

test('one census seat guarding 40 made-up federations does not make one mirror pass read 80 chain census heights', async () => {
  const K = 40;
  const evil = { secret: new Uint8Array(32).fill(0x77) }; evil.pubkey = schnorr.getPublicKey(evil.secret);
  const me = { secret: new Uint8Array(32).fill(0x58) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const fids = Array.from({ length: K }, (_, i) => { const f = new Uint8Array(32).fill(0x20); f[0] = i; return f; });
  const advertKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x61)]);
  const recordKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x62)]);
  const census = { ok: true, entries: [
    { pubkey: evil.pubkey, txid: new Uint8Array(32).fill(0xe0), vout: 0, bondSats: 50000n,
      advert: { operatorId: 'evil', endpoint: 'wss://evil.example', guardianEndpoint: 'wss://gevil.example', guardianOf: fids.map((f) => ({ federationId: f, guardianKey: advertKey })) } },
    { pubkey: me.pubkey, txid: new Uint8Array(32).fill(0xe1), vout: 0, bondSats: 50000n, advert: { operatorId: 'me', endpoint: 'wss://me.example', guardianOf: [] } },
  ] };
  let h = 150000;
  const answer = () => {
    const out = [];
    for (const f of fids) for (let j = 0; j < 4; j++) {
      const rec = buildFederationRecord({ federationId: f, networkId: NET, invite: `fed:${toHex(f)}`, nominal: 1,
        guardians: [{ peerKey: recordKey, nodePubkey: evil.pubkey, operatorId: 'evil', bondTxid: new Uint8Array(32).fill(0xe0), bondVout: 0, endpoint: '', bondSats: 50000n }], height: h++ });
      const body = { federationId: rec.federationId, networkId: rec.networkId, invite: rec.invite, nominal: rec.nominal, threshold: rec.threshold, guardians: rec.guardians,
        status: rec.status, successorId: rec.successorId, gone: rec.gone, exposureCapSats: rec.exposureCapSats, reserveSats: rec.reserveSats, height: rec.height };
      const sig = schnorr.sign(federationRecordId(body), evil.secret);
      out.push({ federation: toHex(f), status: 'OPEN', record: toHex(joinSignedRecord(encodeFederationRecord(body), [{ nodePubkey: evil.pubkey, signature: sig }])) });
    }
    return out;
  };
  const asked = new Set();
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => null, networkId: NET,
    fetcher: async (url) => (url.startsWith('https://evil.example') && url.endsWith('/federations')
      ? new Response(JSON.stringify({ federations: answer() }), { status: 200 }) : new Response('no', { status: 404 })),
    censusAt: async (x) => { asked.add(x); return census.entries; } });
  await o.gatherAll(inviteFederationId);
  console.log(`one gather pass, one census seat with ${K} made-up federations: chain census reads at ${asked.size} distinct heights`);
  assert.ok(asked.size <= 8, `one census seat made one pass read the chain's census at ${asked.size} heights (MIRROR_CENSUS_PER_PASS is 8)`);
});
