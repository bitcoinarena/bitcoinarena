// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2604 (feedback #038, against #2603): WITHOUT THE CONFIG, ONE BONDED NODE'S OWN RECORD READ OPEN OVER A GENUINE HALTED OR CLOSED ONE.
// #2603 held a record to its own nominal when the caller holds no config keys - and the page holds none. One bonded node whose advert names the
// federation under a made-up key signed { guardians: [itself], nominal 1, threshold 1, OPEN, the same invite, height genuine + 1 }; one seat served
// it, federationStatuses took it as the newest, and the client read OPEN (deposit, join) over a genuine 7 of 7 HALTED or CLOSED record.
// Safe: without the config a federation's records are judged together (verifyFederationRecords): every record needs thresholdOf(N), N the largest
// nominal of a record signed by its own threshold; a less restrictive record over a restrictive one needs that record's guardians; and no record
// stands above the chain tip.
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

test('#038 at a seat without the config: the mirror keeps the genuine HALTED record, also when only the forgery is served later', async () => {
  const w = await world(1);
  const real = signed(w, 'HALTED');
  const evil = sybilOpen(w, real);
  let served = (i) => (i === 0 ? [evil] : [real]);
  const me = { secret: new Uint8Array(32).fill(0x58) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const all = [...w.nodes, ...w.strangers];
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => w.census }, inviteFor: () => null, networkId: NET, chainTip: async () => w.genuine.height + 100,
    fetcher: async (url) => {
      const i = all.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0 || !url.endsWith('/federations')) return new Response('no', { status: 404 });
      return new Response(JSON.stringify({ federations: served(i).map((b) => ({ federation: toHex(FED), record: toHex(b) })) }), { status: 200 });
    },
    censusAt: async () => w.census.entries });
  await o.gatherAll(inviteFederationId);
  let held = o.recordOf(toHex(FED));
  console.log(`#2604 mirror seat (no config) holds ${held ? `${held.status} at ${held.height}` : 'nothing'}`);
  assert.equal(held && held.status, 'HALTED');
  served = () => [evil];
  await o.gatherAll(inviteFederationId);
  held = o.recordOf(toHex(FED));
  assert.equal(held.status, 'HALTED', 'the forgery alone moved a seat that holds the genuine record');
});

for (const status of ['HALTED', 'DRAINING']) {
  for (const [by, sybils] of [[7, 4], [5, 1]]) {
    test(`#037 still: a genuine ${status} record ${by} of 7 signed stands beside ${sybils} bonded stranger(s), without the config`, async () => {
      const w = await world(sybils);
      const real = signed(w, status, by);
      const st = await client(w, [real]);
      assert.equal(st.status, status, st.why);
      assert.equal(st.allows.deposit, false);
    });
  }
}

test('#2599 still: one guardian\'s record listing only itself does not read over the genuine record without the config', async () => {
  const w = await world(0);
  const real = signed(w, 'OPEN');
  const evil = oneGuardian(w);
  const [, ve] = verifyFederationRecords([real, evil], { census: w.census.entries, verify, inviteFederationId });
  assert.equal(ve.ok, false, 'the one-guardian record stood');
  const st = await client(w, [real, real, evil]);
  assert.equal(st.status, 'OPEN');
});

test('a genuine reopen stands: HALTED 7 of 7, then OPEN 7 of 7 six blocks up', async () => {
  const w = await world(1);
  const halted = signed(w, 'HALTED', 7, 6);
  const reopen = signed(w, 'OPEN', 7, 12);
  const st = await client(w, [[halted, reopen]]);
  console.log(`#2604 reopen: ${st.status} at ${st.height}`);
  assert.equal(st.status, 'OPEN');
  assert.equal(st.height, w.genuine.height + 12);
  // a sybil set that lists more than the genuine record and signs its own threshold of it is judged too: its OPEN record needs the HALTED
  // record's guardians (rule 2), so with 8 strangers listing themselves it still does not reopen a genuine HALTED record
  const many = await world(8);
  const h = signed(many, 'HALTED', 7, 6);
  const rows = many.strangers.map((s) => ({ peerKey: s.guardianKey, nodePubkey: s.pubkey, operatorId: '', bondTxid: new Uint8Array(32), bondVout: 0, endpoint: '' }))
    .sort((a, b) => (toHex(a.nodePubkey) < toHex(b.nodePubkey) ? -1 : 1));
  const body = { ...many.genuine, nominal: 8, threshold: 6, guardians: rows, gone: [], status: FEDERATION_STATUS.OPEN, successorId: new Uint8Array(32), height: many.genuine.height + 7 };
  const id = federationRecordId(body);
  const sy = joinSignedRecord(encodeFederationRecord(body), many.strangers.map((s) => ({ nodePubkey: s.pubkey, signature: schnorr.sign(id, s.secret) })));
  const [vh, vs] = verifyFederationRecords([h, sy], { census: many.census.entries, verify, inviteFederationId });
  console.log(`#2604 8 strangers' OPEN over a genuine HALTED: genuine ${vh.ok ? vh.status : vh.why}; strangers ${vs.ok ? vs.status : vs.why}`);
  assert.equal(vs.ok, false);
  assert.equal(vh.ok, true);
});

test('a record above the chain tip is refused: at a tip, at the census height plus CENSUS_TIP_SLACK, at a seat\'s chain tip', async () => {
  const w = await world(0);
  const far = signed(w, 'HALTED', 7, 50);
  const tip = w.genuine.height + 10;
  const [v] = verifyFederationRecords([far], { census: w.census.entries, verify, inviteFederationId, tip });
  assert.equal(v.ok, false);
  assert.match(v.why, /above the chain tip/);
  const real = signed(w, 'OPEN', 7, 6);
  assert.equal((await client(w, [[real, far]], { tip })).status, 'OPEN');
  const farther = signed(w, 'HALTED', 7, CENSUS_TIP_SLACK + 1);
  assert.equal((await client(w, [[real, farther]], { censusHeight: w.genuine.height })).status, 'OPEN');
  assert.equal((await client(w, [[real, far]], { censusHeight: w.genuine.height })).status, 'HALTED', 'within the slack a record stands');
  // a seat's mirror with a chain tip below the record's height
  const me = { secret: new Uint8Array(32).fill(0x59) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => w.census }, inviteFor: () => null, networkId: NET, chainTip: async () => tip,
    fetcher: async (url) => (url.endsWith('/federations') ? new Response(JSON.stringify({ federations: [far, real].map((b) => ({ federation: toHex(FED), record: toHex(b) })) }), { status: 200 }) : new Response('no', { status: 404 })),
    censusAt: async () => w.census.entries });
  await o.gatherAll(inviteFederationId);
  const held = o.recordOf(toHex(FED));
  assert.equal(held && held.status, 'OPEN');
  assert.equal(held.height, w.genuine.height + 6);
});
