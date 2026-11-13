// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2615 (feedback #044, against #2614): THREE BONDED STRANGERS HALTED A FEDERATION AT KEYLESS SEATS, AND IT STAYED HALTED.
// F has 7 genuine guardians (f = 2) and a genuine 7 of 7 OPEN record. Three census nodes advertising guardianOf F serve their own HALTED record
// (nominal 3, listing and signed by the three, height genuine + 1). Under #2614 it was self-consistent, more restrictive and signed by more than
// f, so a keyless seat kept it: haltOf(F), GET /liquidations, the draining gate - and after the strangers went silent and the guardians published
// OPEN at genuine + 9 it still kept HALTED. A seat that had kept OPEN flipped the same way.
// Safe: a refused restrictive record takes the halt's effects only when its signers reach thresholdOf(the pick's signers); below that it is only
// held - served for the page's hold, nothing else - and dropped once no one serves it and a newer record is kept.
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


/** The first `k` strangers' own record: themselves listed, nominal k, signed by all k, at `status`, `up` above the genuine body. */
function strangersOwn(w, k, status, up) {
  const by = w.strangers.slice(0, k);
  const rows = by.map((s) => ({ peerKey: s.guardianKey, nodePubkey: s.pubkey, operatorId: '', bondTxid: new Uint8Array(32), bondVout: 0, endpoint: '' }))
    .sort((a, b) => (toHex(a.nodePubkey) < toHex(b.nodePubkey) ? -1 : 1));
  const body = { ...w.genuine, nominal: k, threshold: k - Math.floor((k - 1) / 3), guardians: rows, gone: [], status: FEDERATION_STATUS[status], successorId: new Uint8Array(32), height: w.genuine.height + up };
  const id = federationRecordId(body);
  return joinSignedRecord(encodeFederationRecord(body), by.map((s) => ({ nodePubkey: s.pubkey, signature: schnorr.sign(id, s.secret) })));
}
const genuineAt = (w, status, up) => { const body = { ...w.genuine, status: FEDERATION_STATUS[status], height: w.genuine.height + up }; const id = federationRecordId(body);
  return joinSignedRecord(encodeFederationRecord(body), w.nodes.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) }))); };
const F = toHex(FED);

async function look(w, s) {
  const served = s.o.served().filter((x) => x.federation === F);
  const liq = createLiquidations({ records: s.o, clocks: { abandonBlocks: 4320 }, verify }).list();
  const st = (await federationStatuses({ nodes: ['https://s0.example'], census: w.census.entries, verify,
    fetcher: async () => new Response(JSON.stringify({ federations: s.o.served() }), { status: 200 }) })).get(F);
  return { kept: s.o.recordOf(F), served, halt: s.o.haltOf(F), draining: s.o.draining(F), liq: liq.filter((l) => l.federation === F), st,
    say: `keeps ${s.o.recordOf(F) && s.o.recordOf(F).status}@${s.o.recordOf(F) && s.o.recordOf(F).height}; serves ${served.map((x) => `${x.status}@${x.height}${x.held ? ' (held)' : x.beside ? ' (beside)' : ''}`).join(', ')}; haltOf ${s.o.haltOf(F) ? s.o.haltOf(F).height : 'null'}; draining ${s.o.draining(F)}; liquidations ${liq.length}; client deposit=${st.allows.deposit} join=${st.allows.join}` };
}

test('#044: three strangers\' own HALTED record is held for the page, never a halt - fresh seat, seat that kept OPEN, and after they go silent', async () => {
  const w = await world();
  const open = genuineAt(w, 'OPEN', 0);
  const evil = strangersOwn(w, 3, 'HALTED', 1);
  // step 1: a fresh keyless seat sees both in one pass
  const fresh = mirrorSeat(w, 0, (i, pass) => (i < 7 ? (pass === 3 ? [genuineAt(w, 'OPEN', 9)] : [open]) : i < 10 && pass < 3 ? [evil] : []));
  // step 2: a seat that kept OPEN first, then the strangers serve
  const had = mirrorSeat(w, 1, (i, pass) => (i < 7 ? (pass === 3 ? [genuineAt(w, 'OPEN', 9)] : [open]) : i < 10 && pass === 2 ? [evil] : []));
  fresh.state.pass = 2;
  await had.o.gatherAll(inviteFederationId);
  assert.equal(had.o.recordOf(F).status, 'OPEN');
  had.state.pass = 2;
  for (const s of [fresh, had]) await s.o.gatherAll(inviteFederationId);
  for (const [name, s] of [['fresh', fresh], ['had OPEN', had]]) {
    const l = await look(w, s);
    console.log(`#2615 #044 ${name} seat: ${l.say}`);
    assert.equal(l.kept.status, 'OPEN', 'the strangers\' record was kept');
    assert.deepEqual(l.served.map((x) => x.status).sort(), ['HALTED', 'OPEN']);
    assert.equal(l.served.find((x) => x.status === 'HALTED').held, true);
    assert.equal(l.halt, null);
    assert.equal(l.draining, null);
    assert.equal(l.liq.length, 0);
    assert.equal(l.st.allows.deposit, false, 'the page\'s hold does not see the HALTED word');
    assert.equal(l.st.allows.join, false);
  }
  // step 3: the strangers go silent and the guardians publish OPEN at genuine + 9 - the hold is dropped
  for (const s of [fresh, had]) { s.state.pass = 3; await s.o.gatherAll(inviteFederationId); }
  for (const s of [fresh, had]) {
    const l = await look(w, s);
    console.log(`#2615 after silence: ${l.say}`);
    assert.equal(l.kept.status, 'OPEN');
    assert.equal(l.kept.height, w.genuine.height + 9);
    assert.deepEqual(l.served.map((x) => x.status), ['OPEN']);
    assert.equal(l.halt, null);
    assert.equal(l.st.allows.deposit, true);
  }
});

test('#044 step 4: two strangers (not more than f) are neither held nor kept', async () => {
  const w = await world();
  const s = mirrorSeat(w, 2, (i) => (i < 7 ? [genuineAt(w, 'OPEN', 0)] : i < 9 ? [strangersOwn(w, 2, 'HALTED', 1)] : []));
  await s.o.gatherAll(inviteFederationId);
  const l = await look(w, s);
  console.log(`#2615 two strangers: ${l.say}`);
  assert.deepEqual(l.served.map((x) => x.status), ['OPEN']);
  assert.equal(l.halt, null);
});

test('#042/#043 still: the genuine 7 of 7 HALTED record under eight strangers\' OPEN keeps its halt, liquidation and the page\'s hold', async () => {
  const w = await world();
  // #043: a fresh seat, one pass
  const a = mirrorSeat(w, 3, (i) => (i < 7 ? [w.halted] : [w.sybil]));
  await a.o.gatherAll(inviteFederationId);
  // #042: HALTED first, the strangers' OPEN after
  const b = mirrorSeat(w, 4, (i, pass) => (i < 7 ? [w.halted] : pass === 2 ? [w.sybil] : []));
  await b.o.gatherAll(inviteFederationId); b.state.pass = 2; await b.o.gatherAll(inviteFederationId);
  for (const [name, s] of [['#043', a], ['#042', b]]) {
    const l = await look(w, s);
    console.log(`#2615 ${name}: ${l.say}`);
    assert.equal(l.kept.status, 'HALTED');
    assert.equal(l.halt && l.halt.height, splitSignedRecord(w.halted).record.height);
    assert.equal(l.liq.length, 1);
    assert.equal(l.st.allows.deposit, false);
    assert.equal(l.st.allows.join, false);
  }
});
