// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2613 (feedback #042, the seat side of #2604): A KEYLESS MIRROR SEAT TRADED A GENUINE HALTED RECORD FOR EIGHT STRANGERS' OPEN ONE.
// A seat that is no guardian of F holds no config keys. Its mirror asks every census node whose advert names F; eight bonded strangers serve a
// self-consistent OPEN record (nominal 11, signed by their own 8, height genuine + 1). judge() refused the genuine 7 of 7 HALTED record (it needs
// thresholdOf(11) = 8), the forgery stood, recordStep took it as newer, keep() dropped the halt start and stored it: the seat served only OPEN,
// haltOf and GET /liquidations dropped F and the exchange's halted check passed - and the page's restrictive-word hold had nothing to hold.
// Safe: a keyless seat never replaces its kept record with a less restrictive one; it holds the newer one beside it and serves both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFederationRecord, joinSignedRecord, splitSignedRecord, federationRecordId, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { federationRecords } from '../src/federation-records.js';
import { createLiquidations } from '../src/liquidations.js';
import { inviteForGuardians } from '../src/invite.js';
import { federationStatuses, inviteFederationId } from '../../arena-client/src/federations.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = inviteForGuardians(FED, Array.from({ length: 7 }, (_, i) => ({ peer: i, url: `wss://g${i}.example` })));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

async function world() {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const strangers = Array.from({ length: 8 }, (_, i) => { const secret = new Uint8Array(32).fill(0x90 + i); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([3, ...new Uint8Array(32).fill(0xc0 + i)]), endpoint: `wss://sybil-${i}.example` }; });
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
  assert.equal((await seats[1].gather(FED, inviteFederationId)).ok, true);
  const genuine = splitSignedRecord(fromHex(seats[1].list()[0].record)).record;
  const sign = (body, by) => { const id = federationRecordId(body); return joinSignedRecord(encodeFederationRecord(body), by.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) }))); };
  const halted = sign({ ...genuine, status: FEDERATION_STATUS.HALTED, height: genuine.height + 6 }, nodes);
  const reopen = sign({ ...genuine, status: FEDERATION_STATUS.OPEN, height: genuine.height + 12 }, nodes);
  // #042: the eight strangers and three made-up nodes listed, nominal 11, signed by the eight, one block above the HALTED record
  const fake = Array.from({ length: 3 }, (_, i) => schnorr.getPublicKey(new Uint8Array(32).fill(0xe0 + i)));
  const rows = [...strangers.map((s) => ({ peerKey: s.guardianKey, nodePubkey: s.pubkey })), ...fake.map((k, i) => ({ peerKey: Uint8Array.from([3, ...new Uint8Array(32).fill(0xf0 + i)]), nodePubkey: k }))]
    .map((g) => ({ ...g, operatorId: '', bondTxid: new Uint8Array(32), bondVout: 0, endpoint: '' })).sort((a, b) => (toHex(a.nodePubkey) < toHex(b.nodePubkey) ? -1 : 1));
  const sybil = sign({ ...genuine, nominal: 11, threshold: 8, guardians: rows, gone: [], status: FEDERATION_STATUS.OPEN, successorId: new Uint8Array(32), height: genuine.height + 7 }, strangers);
  return { nodes, strangers, all, census, keys, genuine, halted, reopen, sybil };
}

/** A mirror seat (no invite: it gathers nothing); `serve(i, pass)` the records census node i serves; `keys` its config keys, if any. */
function mirrorSeat(w, n, serve, keys = null) {
  const me = { secret: new Uint8Array(32).fill(0x50 + n) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const state = { pass: 1 };
  const o = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => w.census }, inviteFor: () => null, networkId: NET, chainTip: async () => w.genuine.height + 100,
    ...(keys ? { guardianKeysOf: async () => keys } : {}),
    fetcher: async (url) => {
      const i = w.all.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0 || !url.endsWith('/federations')) return new Response('no', { status: 404 });
      return new Response(JSON.stringify({ federations: serve(i, state.pass).map((b) => ({ federation: toHex(FED), record: toHex(b) })) }), { status: 200 });
    },
    censusAt: async () => w.census.entries });
  return { o, state };
}

test('#042: three keyless mirror seats keep the genuine HALTED record, its halt start and the liquidation when strangers serve an OPEN one', async () => {
  const w = await world();
  const serve = (i, pass) => (i < 7 ? [w.halted] : pass === 2 ? [w.sybil] : []);
  const seats = [0, 1, 2].map((n) => mirrorSeat(w, n, serve));
  const F = toHex(FED);
  const before = [];
  for (const s of seats) {
    await s.o.gatherAll(inviteFederationId);
    assert.equal(s.o.recordOf(F).status, 'HALTED');
    before.push(s.o.haltOf(F));
  }
  for (const s of seats) { s.state.pass = 2; await s.o.gatherAll(inviteFederationId); }
  for (const [n, s] of seats.entries()) {
    const held = s.o.recordOf(F);
    const served = s.o.served().filter((x) => x.federation === F);
    const liq = createLiquidations({ records: s.o, clocks: { abandonBlocks: 4320 }, verify }).list();
    console.log(`#2613 seat ${n} after the strangers' OPEN record: keeps ${held.status} at ${held.height}; serves ${served.map((x) => `${x.status}@${x.height}${x.beside ? ' (beside)' : ''}`).join(', ')}; halt from ${s.o.haltOf(F) && s.o.haltOf(F).height}; liquidations ${liq.map((l) => l.federation.slice(0, 8)).join(',') || 'none'}`);
    assert.equal(held.status, 'HALTED');
    assert.ok(served.some((x) => x.status === 'HALTED' && !x.beside), 'the HALTED record is no longer served');
    assert.ok(served.some((x) => x.status === 'OPEN' && x.beside), 'the newer OPEN record is not served beside it');
    assert.equal(s.o.list().filter((x) => x.federation === F).length, 1, 'list() is one row a federation');
    assert.deepEqual(s.o.haltOf(F) && s.o.haltOf(F).height, before[n] && before[n].height);
    assert.equal(toHex(s.o.haltOf(F).bytes), toHex(before[n].bytes));
    assert.deepEqual(s.o.haltedFederations(), [F]);
    assert.ok(liq.some((l) => l.federation === F), 'GET /liquidations dropped the federation');
  }
  // a client reading what the seats serve: both words, and its restrictive-word hold applies (#2605/#2611)
  const fetcher = async (url) => { const i = Number(new URL(url).hostname.split('.')[0].slice(1)); return new Response(JSON.stringify({ federations: seats[i].o.served() }), { status: 200 }); };
  const st = (await federationStatuses({ nodes: ['https://s0.example', 'https://s1.example', 'https://s2.example'], census: w.census.entries, verify, fetcher })).get(F);
  console.log(`#2613 client over the seats' rows: ${st.status} deposit=${st.allows.deposit} join=${st.allows.join}`);
  assert.equal(st.allows.deposit, false);
  assert.equal(st.allows.join, false);
});

test('with the config keys the judged record decides: a genuine reopen moves a keyed seat to OPEN; a keyless seat stays HALTED', async () => {
  const w = await world();
  const serve = (i, pass) => (i < 7 ? (pass === 2 ? [w.halted, w.reopen] : [w.halted]) : pass === 2 ? [w.sybil] : []);
  const keyed = mirrorSeat(w, 5, serve, w.keys);
  const bare = mirrorSeat(w, 6, serve);
  const F = toHex(FED);
  for (const s of [keyed, bare]) await s.o.gatherAll(inviteFederationId);
  for (const s of [keyed, bare]) { s.state.pass = 2; await s.o.gatherAll(inviteFederationId); }
  console.log(`#2613 reopen: keyed seat ${keyed.o.recordOf(F).status}, keyless seat ${bare.o.recordOf(F).status} (beside: ${bare.o.besideOf(F) && bare.o.besideOf(F).status})`);
  assert.equal(keyed.o.recordOf(F).status, 'OPEN');
  assert.equal(keyed.o.haltOf(F), null);
  assert.equal(bare.o.recordOf(F).status, 'HALTED');
  assert.equal(bare.o.besideOf(F).status, 'OPEN');
});
