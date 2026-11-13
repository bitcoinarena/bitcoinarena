// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #2605, feedback #039: 8 bonded sybils sign their own OPEN record of nominal 11 (themselves + 3 made-up guardians), one block above a
// genuine 7 of 7 HALTED, CLOSED or DRAINING record. Without the config keys #2604 lifted N to 11, the genuine record fell under thresholdOf(11)
// and dropped out of the guard, and the page read OPEN (deposit, join). Now, without keys, any record of the federation that names a
// restrictive status keeps deposit and join off; with the keys the genuine record decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFederationRecord, joinSignedRecord, splitSignedRecord, federationRecordId, verifyFederationRecords, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { federationRecords } from '../src/federation-records.js';
import { inviteForGuardians } from '../src/invite.js';
import { federationStatuses, inviteFederationId, CENSUS_TIP_SLACK } from '../../arena-client/src/federations.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = inviteForGuardians(FED, Array.from({ length: 7 }, (_, i) => ({ peer: i, url: `wss://g${i}.example` })));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

/** Seven real guardians and `sybils` bonded strangers whose adverts name F under a made-up key; the guardians gather the genuine OPEN body. */
async function world(sybils = 1) {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const strangers = Array.from({ length: sybils }, (_, i) => { const secret = new Uint8Array(32).fill(0x90 + i); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([3, ...new Uint8Array(32).fill(0xc0 + i)]), endpoint: `wss://sybil-${i}.example` }; });
  const all = [...nodes, ...strangers];
  const census = { ok: true, entries: all.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0x20 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  const keys = nodes.map((n) => n.guardianKey);
  const seats = nodes.map((n) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, guardianKeysOf: async () => keys,
    fetcher: async (url) => {
      const i = nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0) return new Response('no', { status: 404 });
      const u = new URL(url);
      const body = await seats[i].mySignature(u.searchParams.get('federation'), null, u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  const g = await seats[1].gather(FED, inviteFederationId);
  assert.equal(g.ok, true, `the guardians gathered no record: ${g.why}`);
  const genuine = splitSignedRecord(fromHex(seats[1].list()[0].record)).record;
  return { nodes, strangers, census, keys, genuine };
}

/** The genuine body at `status`, `up` blocks above the gathered one, signed by the first `by` real guardians. */
function signed(w, status, by = 7, up = 6) {
  const body = { ...w.genuine, status: FEDERATION_STATUS[status], height: w.genuine.height + up };
  const id = federationRecordId(body);
  return joinSignedRecord(encodeFederationRecord(body), w.nodes.slice(0, by).map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })));
}
/** #038: a bonded stranger's own record - itself listed under its made-up key, nominal 1, OPEN, one block above `over`. */
function sybilOpen(w, over, s = w.strangers[0]) {
  const at = splitSignedRecord(over).record;
  const body = { ...w.genuine, nominal: 1, threshold: 1, guardians: [{ peerKey: s.guardianKey, nodePubkey: s.pubkey, operatorId: '', bondTxid: new Uint8Array(32), bondVout: 0, endpoint: '' }],
    gone: [], status: FEDERATION_STATUS.OPEN, successorId: new Uint8Array(32), height: at.height + 1 };
  return joinSignedRecord(encodeFederationRecord(body), [{ nodePubkey: s.pubkey, signature: schnorr.sign(federationRecordId(body), s.secret) }]);
}
/** #2599: guardian 0 alone, listing only itself, nominal 1, HALTED. */
function oneGuardian(w, up = 12) {
  const me = w.nodes[0];
  const g0 = w.genuine.guardians.find((g) => toHex(g.nodePubkey) === toHex(me.pubkey));
  const body = { ...w.genuine, nominal: 1, threshold: 1, guardians: [g0], gone: [], status: FEDERATION_STATUS.HALTED, height: w.genuine.height + up };
  return joinSignedRecord(encodeFederationRecord(body), [{ nodePubkey: me.pubkey, signature: schnorr.sign(federationRecordId(body), me.secret) }]);
}

/** The client's status of F (no config keys, as the page): seat i serves rows[i % rows.length]. */
async function client(w, rows, opts = {}) {
  const urls = ['https://a.example', 'https://b.example', 'https://c.example'];
  const fetcher = async (url) => {
    const i = urls.findIndex((u) => url.startsWith(u));
    const list = [].concat(rows[i % rows.length]).map((b) => ({ federation: toHex(FED), record: toHex(b) }));
    return new Response(JSON.stringify({ federations: list }), { status: 200 });
  };
  return (await federationStatuses({ nodes: urls, census: w.census.entries, verify, fetcher, ...opts })).get(toHex(FED));
}

for (const status of ['HALTED', 'CLOSED']) {
  test(`#038: one bonded node's own OPEN record does not read over a genuine 7 of 7 ${status} one without the config`, async () => {
    const w = await world(1);
    const real = signed(w, status);
    const evil = sybilOpen(w, real);
    const [vr, ve] = verifyFederationRecords([real, evil], { census: w.census.entries, verify, inviteFederationId });
    const st = await client(w, [real, real, evil]);
    console.log(`#2604 #038 over ${status}: genuine ${vr.ok ? vr.status : vr.why}; forgery ${ve.ok ? `verified ${ve.status}` : `refused: ${ve.why}`}; client ${st.status} deposit=${st.allows.deposit} join=${st.allows.join}`);
    assert.equal(vr.ok, true);
    assert.equal(ve.ok, false);
    assert.equal(st.status, status);
    assert.equal(st.allows.deposit, false);
    assert.equal(st.allows.join, false);
  });
}

for (const status of ['HALTED', 'CLOSED', 'DRAINING']) {
  test(`#039: 8 sybils' own OPEN record of nominal 11 does not open deposit or join over a genuine 7 of 7 ${status} without the config`, async () => {
    const w = await world(8);
    const real = signed(w, status);
    const at = splitSignedRecord(real).record;
    const madeUp = Array.from({ length: 3 }, (_, i) => { const sk = new Uint8Array(32).fill(0xe0 + i); return { peerKey: Uint8Array.from([3, ...new Uint8Array(32).fill(0xd0 + i)]), nodePubkey: schnorr.getPublicKey(sk), operatorId: '', bondTxid: new Uint8Array(32), bondVout: 0, endpoint: '' }; });
    const rows = [...w.strangers.map((s) => ({ peerKey: s.guardianKey, nodePubkey: s.pubkey, operatorId: '', bondTxid: new Uint8Array(32), bondVout: 0, endpoint: '' })), ...madeUp]
      .sort((a, b) => (toHex(a.nodePubkey) < toHex(b.nodePubkey) ? -1 : 1));
    const body = { ...w.genuine, nominal: 11, threshold: 8, guardians: rows, gone: [], status: FEDERATION_STATUS.OPEN, successorId: new Uint8Array(32), height: at.height + 1 };
    const id = federationRecordId(body);
    const evil = joinSignedRecord(encodeFederationRecord(body), w.strangers.map((s) => ({ nodePubkey: s.pubkey, signature: schnorr.sign(id, s.secret) })));
    const st = await client(w, [real, real, evil]);
    console.log(`#2605 #039 over ${status}: client ${st.status} deposit=${st.allows.deposit} join=${st.allows.join} withdraw=${st.allows.withdraw}`);
    assert.equal(st.allows.deposit, false);
    assert.equal(st.allows.join, false);
    assert.equal(st.allows.withdraw, true);
    const keyed = await client(w, [real, real, evil], { guardianKeysOf: () => w.keys });
    assert.equal(keyed.status, status);
  });
}

test('#039 without keys: a plain OPEN federation with no restrictive record still allows deposit and join', async () => {
  const w = await world(1);
  const st = await client(w, [signed(w, 'OPEN')]);
  assert.equal(st.status, 'OPEN');
  assert.equal(st.allows.deposit, true);
  assert.equal(st.allows.join, true);
});
