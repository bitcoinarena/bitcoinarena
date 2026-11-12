// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 6 (gossip): ONE PEER'S GET /federations ANSWER MAKES THE MIRRORING SEAT DERIVE A CHAIN CENSUS PER CLAIMED HEIGHT.
// federation-records.js mirror() reads every guardian's GET /federations whole and, for EVERY listed record of the federation that does not
// stand against this seat's census, decodes the record's own (unsigned, self-declared) height and calls censusAt(height) - in the seat
// main.js wires that to ballot.censusEntriesAt -> chainCensusKept, a census derivation from bitcoind at that height. The cache (censusKept) is
// per pass and per height, with no bound on how many heights. One guardian node (or one census seat asked in turn) lists the federation N
// times with N different heights and no signatures: N chain census derivations on every gather pass, at every seat that mirrors it.
// Safe behaviour: what one peer's answer makes the seat read off its chain is bounded (a few heights, not one per listed record).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFederationRecord, joinSignedRecord, splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { federationRecords } from '../src/federation-records.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

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

test('one guardian\'s /federations answer listing the federation at 2000 made-up heights does not cost 2000 chain census reads', async () => {
  const s = seven();
  for (const seat of s.seats) assert.equal((await seat.gather(FED, inviteFederationId)).ok, true);
  const genuine = splitSignedRecord(fromHex(s.seats[1].list()[0].record)).record;
  // the attacker (guardian 0's node): the record at made-up heights, no signatures at all
  const junk = Array.from({ length: 2000 }, (_, i) => ({ federation: toHex(FED), status: 'OPEN',
    record: toHex(joinSignedRecord(encodeFederationRecord({ ...genuine, height: 200000 + i }), [])) }));
  const me = { secret: new Uint8Array(32).fill(0x58) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const asked = new Set();
  let reads = 0;
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => s.census }, inviteFor: () => null, networkId: NET,
    fetcher: async (url) => {
      const i = s.nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0 || !url.endsWith('/federations')) return new Response('no', { status: 404 });
      return new Response(JSON.stringify({ federations: i === 0 ? junk : s.seats[i].list() }), { status: 200 });
    },
    censusAt: async (h) => { reads++; asked.add(h); return s.census.entries; } });
  const got = await o.gatherAll(inviteFederationId);
  console.log(`mirror pass: ${got[0].ok ? 'record kept' : got[0].why}; chain census reads ${reads} at ${asked.size} distinct heights from one guardian's answer`);
  assert.ok(asked.size <= 8, `one guardian's answer made the seat read the chain's census at ${asked.size} heights`);
});
