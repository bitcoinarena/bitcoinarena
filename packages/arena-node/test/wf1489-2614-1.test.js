// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2614 (feedback #043, against #2613): A FRESH KEYLESS SEAT KEPT EIGHT STRANGERS' OPEN RECORD IN ITS FIRST PASS.
// #2613's guard in keep() acts only on a record already kept. A keyless seat with no record of F yet (new, an empty store, or one that learns of
// F after the halt) mirrored the genuine 7 of 7 HALTED record and the strangers' OPEN one (nominal 11, height genuine + 1) in one pass: judge()
// refused the genuine one (it needs 8), the forgery was picked, nothing was kept to hold, and the seat kept and served OPEN only - the page read
// OPEN with deposit and join on, and the liquidation was gone. Safe: a refused record signed by its own threshold, more restrictive than the pick
// and signed by more than f of the larger set, is kept first, and the pick is held beside it.
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


test('#043: a fresh keyless seat, one pass, genuine HALTED plus the strangers\' OPEN record - it keeps HALTED and serves both', async () => {
  const w = await world();
  const F = toHex(FED);
  const s = mirrorSeat(w, 0, (i) => (i < 7 ? [w.halted] : [w.sybil]));
  assert.equal(s.o.recordOf(F), null);
  await s.o.gatherAll(inviteFederationId);
  const held = s.o.recordOf(F);
  const served = s.o.served().filter((x) => x.federation === F);
  const liq = createLiquidations({ records: s.o, clocks: { abandonBlocks: 4320 }, verify }).list();
  const st = (await federationStatuses({ nodes: ['https://s0.example'], census: w.census.entries, verify,
    fetcher: async () => new Response(JSON.stringify({ federations: s.o.served() }), { status: 200 }) })).get(F);
  console.log(`#2614 fresh keyless seat: keeps ${held && held.status} at ${held && held.height}; serves ${served.map((x) => `${x.status}@${x.height}${x.beside ? ' (beside)' : ''}`).join(', ')}; halt from ${s.o.haltOf(F) && s.o.haltOf(F).height}; liquidations ${liq.map((l) => l.federation.slice(0, 8)).join(',') || 'none'}; client deposit=${st.allows.deposit} join=${st.allows.join}`);
  assert.equal(held.status, 'HALTED');
  assert.deepEqual(served.map((x) => x.status), ['HALTED', 'OPEN']);
  assert.equal(served[1].beside, true);
  assert.equal(s.o.haltOf(F).height, splitSignedRecord(w.halted).record.height);
  assert.equal(toHex(s.o.haltOf(F).bytes), toHex(w.halted));
  assert.ok(liq.some((l) => l.federation === F), 'the liquidation is not listed');
  assert.equal(st.allows.deposit, false);
  assert.equal(st.allows.join, false);
});

test('control: a fresh keyless seat with only the genuine OPEN record keeps OPEN; one stranger\'s own HALTED record beside it does not halt it', async () => {
  const w = await world();
  const F = toHex(FED);
  const open = (() => { const id = federationRecordId(w.genuine); return joinSignedRecord(encodeFederationRecord(w.genuine), w.nodes.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) }))); })();
  const a = mirrorSeat(w, 1, (i) => (i < 7 ? [open] : []));
  await a.o.gatherAll(inviteFederationId);
  assert.equal(a.o.recordOf(F).status, 'OPEN');
  assert.equal(a.o.haltOf(F), null);
  // one bonded stranger signs its own HALTED record (nominal 1): self-consistent, but signed by 1 <= f of 7 - it never counts
  const s0 = w.strangers[0];
  const body = { ...w.genuine, nominal: 1, threshold: 1, guardians: [{ peerKey: s0.guardianKey, nodePubkey: s0.pubkey, operatorId: '', bondTxid: new Uint8Array(32), bondVout: 0, endpoint: '' }],
    gone: [], status: FEDERATION_STATUS.HALTED, successorId: new Uint8Array(32), height: w.genuine.height - 1 };
  const lone = joinSignedRecord(encodeFederationRecord(body), [{ nodePubkey: s0.pubkey, signature: schnorr.sign(federationRecordId(body), s0.secret) }]);
  const b = mirrorSeat(w, 2, (i) => (i < 7 ? [open] : i === 7 ? [lone] : []));
  await b.o.gatherAll(inviteFederationId);
  console.log(`#2614 control: genuine OPEN alone -> ${a.o.recordOf(F).status}; with one stranger's HALTED -> ${b.o.recordOf(F).status}, halt ${b.o.haltOf(F) ? 'set' : 'none'}`);
  assert.equal(b.o.recordOf(F).status, 'OPEN');
  assert.equal(b.o.haltOf(F), null);
});
