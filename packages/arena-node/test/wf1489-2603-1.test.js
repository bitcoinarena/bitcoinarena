// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2603 (feedback #037, a regression of #2599): FOUR BONDED STRANGERS REFUSE A GENUINE HALTED RECORD, AND THE CLIENT ALLOWS EVERYTHING.
// #2599 made a record need thresholdOf(max(nominal, census nodes whose advert names the federation)). An advert's guardianOf is the node's own
// word, never held to the federation: seven real guardians sign a HALTED record (nominal 7, threshold 5), four census nodes advertise
// guardianOf [{ federationId: F, guardianKey: random }], and the record "needs 8" - refused. The client then reads the federation 'unverified',
// which FEDERATION_ALLOWS maps to deposit and join allowed. With five signers one stranger is enough; DRAINING the same. Honest guardians could not
// sign again either: the body every seat builds listed the strangers too.
// Safe: the federation's own config keys (broadcast_public_keys) decide who is a guardian (need = thresholdOf(max(nominal, keys))); without the
// config a record is held to its own threshold; the body a seat builds lists only config keys; a client whose records were all refused, one of
// them restrictive, allows no deposit or join. #2599's one-guardian record stays refused wherever the config is known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFederationRecord, joinSignedRecord, splitSignedRecord, federationRecordId, verifyFederationRecord, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { federationRecords, guardiansOf } from '../src/federation-records.js';
import { inviteForGuardians } from '../src/invite.js';
import { federationStatuses, inviteFederationId } from '../../arena-client/src/federations.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = inviteForGuardians(FED, Array.from({ length: 7 }, (_, i) => ({ peer: i, url: `wss://g${i}.example` })));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

/** Seven real guardians (each a bonded census node naming its config key) and `sybils` bonded strangers naming F under a random key. */
function world(sybils = 0, { seatsKeyed = true } = {}) {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const strangers = Array.from({ length: sybils }, (_, i) => { const secret = new Uint8Array(32).fill(0x90 + i); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([3, ...new Uint8Array(32).fill(0xc0 + i)]), endpoint: `wss://sybil-${i}.example` }; });
  const entry = (n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0x20 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } });
  const census = { ok: true, entries: [...nodes, ...strangers].map(entry) };
  const keys = nodes.map((n) => n.guardianKey);
  const seats = nodes.map((n) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET,
    ...(seatsKeyed ? { guardianKeysOf: async () => keys } : {}),
    fetcher: async (url) => {
      const i = nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0) return new Response('no', { status: 404 });
      const u = new URL(url);
      const body = await seats[i].mySignature(u.searchParams.get('federation'), null, u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  return { nodes, strangers, census, keys, seats };
}

/** The genuine body the guardians gathered, moved to `status` six blocks up, signed by the first `by` real guardians. */
function signed(w, genuine, status, by) {
  const body = { ...genuine, status: FEDERATION_STATUS[status], height: genuine.height + 6 };
  const id = federationRecordId(body);
  return joinSignedRecord(encodeFederationRecord(body), w.nodes.slice(0, by).map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })));
}

async function genuineOf(w) {
  const g = await w.seats[1].gather(FED, inviteFederationId);
  assert.equal(g.ok, true, `the guardians gathered no record: ${g.why}`);
  return splitSignedRecord(fromHex(w.seats[1].list()[0].record)).record;
}

/** The client's status of F, every seat serving `bytes`. */
async function clientStatus(w, bytes, opts = {}) {
  const hex = toHex(bytes);
  const fetcher = async () => new Response(JSON.stringify({ federations: [{ federation: toHex(FED), record: hex }] }), { status: 200 });
  const all = await federationStatuses({ nodes: ['https://a.example', 'https://b.example', 'https://c.example'], census: w.census.entries, verify, fetcher, ...opts });
  return all.get(toHex(FED));
}

for (const status of ['HALTED', 'DRAINING']) {
  for (const [by, sybils] of [[7, 4], [5, 1]]) {
    test(`a genuine ${status} record ${by} of 7 guardians signed stands beside ${sybils} bonded stranger(s) naming the federation`, async () => {
      const w = world(sybils);
      const genuine = await genuineOf(w);
      assert.equal(genuine.nominal, 7, `the body the seats built lists ${genuine.nominal} guardians, not the 7 of the config`);
      const bytes = signed(w, genuine, status, by);
      const keyed = verifyFederationRecord(bytes, { census: w.census.entries, verify, inviteFederationId, guardianKeys: w.keys });
      const bare = verifyFederationRecord(bytes, { census: w.census.entries, verify, inviteFederationId });
      const st = await clientStatus(w, bytes);
      console.log(`#2603 ${status} ${by}/7 + ${sybils} sybil(s): with the config ${keyed.ok ? `${keyed.status} (${keyed.signers})` : `refused: ${keyed.why}`}; without ${bare.ok ? `${bare.status} (${bare.signers})` : `refused: ${bare.why}`}; client ${st.status} deposit=${st.allows.deposit}`);
      assert.equal(keyed.ok, true, `refused with the config keys: ${keyed.why}`);
      assert.equal(keyed.status, status);
      assert.equal(bare.ok, true, `refused without the config keys: ${bare.why}`);
      assert.equal(st.status, status);
      assert.equal(st.allows.deposit, false);
    });
  }
}

test('the body a keyed seat builds lists only the config keys; a census-only list would have taken the strangers', () => {
  const w = world(4);
  assert.equal(guardiansOf(w.census, FED, w.keys).length, 7);
  assert.equal(guardiansOf(w.census, FED).length, 11);
  // a stranger copying a real guardian's key does not add an eighth row either: one node per key
  const copy = { pubkey: w.strangers[0].pubkey, txid: new Uint8Array(32).fill(0xfe), vout: 0, bondSats: 50000n,
    advert: { operatorId: 'x', endpoint: 'wss://copy.example', guardianOf: [{ federationId: FED, guardianKey: w.nodes[3].guardianKey }] } };
  assert.equal(guardiansOf({ entries: [...w.census.entries.slice(0, 7), copy] }, FED, w.keys).length, 7);
});

/** #2599's forged record: guardian 0 alone, listing only itself (nominal 1), HALTED, six blocks up. */
function forged(w, genuine) {
  const me = w.nodes[0];
  const g0 = genuine.guardians.find((g) => toHex(g.nodePubkey) === toHex(me.pubkey));
  const body = { ...genuine, nominal: 1, threshold: 1, guardians: [g0], gone: [], status: FEDERATION_STATUS.HALTED, height: genuine.height + 6 };
  return joinSignedRecord(encodeFederationRecord(body), [{ nodePubkey: me.pubkey, signature: schnorr.sign(federationRecordId(body), me.secret) }]);
}

test('#2599 still: one guardian\'s record listing only itself is refused where the config is known, at a mirroring seat too', async () => {
  const w = world(4);
  for (const seat of w.seats) assert.equal((await seat.gather(FED, inviteFederationId)).ok, true);
  const genuine = splitSignedRecord(fromHex(w.seats[1].list()[0].record)).record;
  const evil = forged(w, genuine);
  const v = verifyFederationRecord(evil, { census: w.census.entries, verify, inviteFederationId, guardianKeys: w.keys });
  console.log(`#2603 #2599 forged record with the config: ${v.ok ? `verified (${v.status})` : `refused: ${v.why}`}`);
  assert.equal(v.ok, false);
  // guardian 0 with the four strangers it bonds: a record listing the five of them, all five signing - keys outside the config, refused
  const rows = guardiansOf(w.census, FED).filter((g) => toHex(g.nodePubkey) === toHex(w.nodes[0].pubkey) || w.strangers.some((s) => toHex(s.pubkey) === toHex(g.nodePubkey)));
  const body = { ...genuine, nominal: 5, threshold: 4, guardians: rows.map(({ peerKey, nodePubkey, operatorId, bondTxid, bondVout, endpoint }) => ({ peerKey, nodePubkey, operatorId, bondTxid, bondVout, endpoint }))
      .sort((a, b) => (toHex(a.nodePubkey) < toHex(b.nodePubkey) ? -1 : 1)),
    status: FEDERATION_STATUS.HALTED, height: genuine.height + 6 };
  const id = federationRecordId(body);
  const packed = joinSignedRecord(encodeFederationRecord(body), [w.nodes[0], ...w.strangers].map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })));
  assert.equal(verifyFederationRecord(packed, { census: w.census.entries, verify, inviteFederationId, guardianKeys: w.keys }).ok, false);
  // a mirroring seat that holds the config keeps the genuine OPEN record
  const me = { secret: new Uint8Array(32).fill(0x58) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => w.census }, inviteFor: () => null, networkId: NET, guardianKeysOf: async () => w.keys,
    fetcher: async (url) => {
      const i = w.nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0 || !url.endsWith('/federations')) return new Response('no', { status: 404 });
      return new Response(JSON.stringify({ federations: i === 0 ? [{ federation: toHex(FED), status: 'HALTED', record: toHex(evil) }] : w.seats[i].list() }), { status: 200 });
    },
    censusAt: async () => w.census.entries });
  await o.gatherAll(inviteFederationId);
  const held = o.recordOf(toHex(FED));
  console.log(`#2603 keyed mirror seat holds ${held ? `${held.status} at ${held.height}, ${held.record.guardians.length} listed` : 'nothing'}`);
  assert.ok(held);
  assert.equal(held.status, 'OPEN');
  assert.equal(held.record.guardians.length, 7);
  // and the client with the config keys
  const st = await clientStatus(w, evil, { guardianKeysOf: () => w.keys });
  assert.notEqual(st.status, 'HALTED');
});

test('the client does not fail open: every record refused, one of them HALTED, allows no deposit and no join; withdraw stays', async () => {
  const w = world(0);
  const genuine = await genuineOf(w);
  // four of seven signatures: below the threshold of 5, refused however it is counted
  const halted = await clientStatus(w, signed(w, genuine, 'HALTED', 4));
  console.log(`#2603 client, a refused HALTED record: ${halted.status} ${JSON.stringify(halted.allows)} (${halted.why})`);
  assert.equal(halted.status, 'unverified');
  assert.deepEqual({ ...halted.allows }, { deposit: false, join: false, withdraw: true, move: true });
  assert.equal(halted.refusedSays, 'HALTED');
  for (const s of ['DRAINING', 'CRITICAL', 'CLOSED']) assert.equal((await clientStatus(w, signed(w, genuine, s, 4))).allows.deposit, false, s);
  // a refused OPEN record says nothing restrictive: as before
  const open = await clientStatus(w, signed(w, genuine, 'OPEN', 4));
  assert.equal(open.status, 'unverified');
  assert.equal(open.allows.deposit, true);
});
