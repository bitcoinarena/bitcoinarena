// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2599 (attacker audit, custody): ONE GUARDIAN SIGNS A RECORD OF ITS FEDERATION THAT LISTS ONLY ITSELF, AND EVERY SEAT KEEPS IT.
// verifyFederationRecord counted the signatures against the record's own threshold, and the threshold is read off the record's own nominal
// (thresholdOf(nominal)). Nothing held nominal or the guardian list to the census: guardian 0 of seven built the body with guardians = [itself],
// nominal 1 (threshold 1), status HALTED, a height above the genuine record's, signed it alone and served it at GET /federations. Every mirroring
// seat kept it - the federation HALTED (liquidation clocks, the exchange refused), its guardian list one node long, so the spent-set quorum
// (n - t + 1) was that one guardian's own copy. Safe: a record needs the threshold of the guardians the census lists for the federation, not
// of the guardians the record chose to list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFederationRecord, joinSignedRecord, splitSignedRecord, federationRecordId, verifyFederationRecord, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { federationRecords } from '../src/federation-records.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

function seven() {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  const seats = nodes.map((n) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET,
    fetcher: async (url) => {
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      const u = new URL(url);
      const body = await j.mySignature(u.searchParams.get('federation'), null, u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  return { nodes, census, seats };
}

/** Guardian 0's forged record: only itself listed, nominal 1, HALTED, above the genuine height, signed by it alone. */
function forged(s, genuine) {
  const me = s.nodes[0];
  const g0 = genuine.guardians.find((g) => toHex(g.nodePubkey) === toHex(me.pubkey));
  const body = { ...genuine, nominal: 1, threshold: 1, guardians: [g0], gone: [], status: FEDERATION_STATUS.HALTED, height: genuine.height + 6 };
  const bytes = encodeFederationRecord(body);
  return joinSignedRecord(bytes, [{ nodePubkey: me.pubkey, signature: schnorr.sign(federationRecordId(body), me.secret) }]);
}

test('a record one guardian of seven signs listing only itself (nominal 1) does not verify against the census', async () => {
  const s = seven();
  assert.equal((await s.seats[1].gather(FED, inviteFederationId)).ok, true);
  const genuine = splitSignedRecord(fromHex(s.seats[1].list()[0].record)).record;
  const v = verifyFederationRecord(forged(s, genuine), { census: s.census.entries, verify, inviteFederationId });
  console.log(`#2599 forged one-guardian HALTED record: ${v.ok ? `verified (${v.status}, ${v.signers} signer)` : `refused: ${v.why}`}`);
  assert.equal(v.ok, false, 'one guardian of seven alone made a record that verifies');
  // the honest record still verifies
  assert.equal(verifyFederationRecord(fromHex(s.seats[1].list()[0].record), { census: s.census.entries, verify, inviteFederationId }).ok, true);
});

test('a mirroring seat keeps the genuine OPEN record, not one guardian\'s forged HALTED one', async () => {
  const s = seven();
  for (const seat of s.seats) assert.equal((await seat.gather(FED, inviteFederationId)).ok, true);
  const genuine = splitSignedRecord(fromHex(s.seats[1].list()[0].record)).record;
  const evil = toHex(forged(s, genuine));
  const me = { secret: new Uint8Array(32).fill(0x58) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => s.census }, inviteFor: () => null, networkId: NET,
    fetcher: async (url) => {
      const i = s.nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0 || !url.endsWith('/federations')) return new Response('no', { status: 404 });
      return new Response(JSON.stringify({ federations: i === 0 ? [{ federation: toHex(FED), status: 'HALTED', record: evil }] : s.seats[i].list() }), { status: 200 });
    },
    censusAt: async () => s.census.entries });
  await o.gatherAll(inviteFederationId);
  const held = o.recordOf(toHex(FED));
  console.log(`#2599 mirror seat holds ${held ? `${held.status} at ${held.height}, ${held.record.guardians.length} guardian(s) listed` : 'no record'}`);
  assert.ok(held, 'the mirroring seat holds no record at all');
  assert.equal(held.status, 'OPEN', 'one guardian halted its federation at a mirroring seat');
  assert.equal(held.record.guardians.length, 7);
});
