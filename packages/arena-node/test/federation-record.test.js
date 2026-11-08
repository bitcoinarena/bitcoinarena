// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FEDERATION RECORD (spec §23A.1 / §23A.4). The status bands exactly as §23A.1's table for 10, 7 and 4
// guardians; the record's bytes and id; and seven guardian seats (federation-records.js) signing one record over the
// census: all seated -> OPEN with 7 signatures; one guardian saying it leaves -> DRAINING; two -> CRITICAL; the seat then
// calls the federation draining. A record short of its threshold, signed by a non-guardian, or with a foreign invite is
// not believed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { statusFor, buildFederationRecord, encodeFederationRecord, decodeFederationRecord, federationRecordId, joinSignedRecord,
  splitSignedRecord, verifyFederationRecord, FEDERATION_STATUS, CAPACITY_BAND, GONE } from '../../arena-protocol/src/federation-record.js';
import { federationRecords, guardiansOf, MIRROR_PEERS } from '../src/federation-records.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { readFileSync } from 'node:fs';
import { decodeRoundContract, encodeRoundContract } from '../../arena-protocol/src/contracts.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0x37);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

test('the bands are §23A.1\'s table: 10, 7 and 4 guardians', () => {
  const bands = (n) => Array.from({ length: n + 1 }, (_, i) => n - i).map((s) => `${s}:${statusFor({ nominal: n, seated: s }).status}`).join(' ');
  assert.equal(bands(10).split(' ').slice(0, 5).join(' '), '10:OPEN 9:OPEN 8:DRAINING 7:CRITICAL 6:HALTED');
  assert.equal(bands(7).split(' ').slice(0, 4).join(' '), '7:OPEN 6:DRAINING 5:CRITICAL 4:HALTED');
  assert.equal(bands(4).split(' ').slice(0, 3).join(' '), '4:OPEN 3:CRITICAL 2:HALTED', 'no DRAINING band at four');
  assert.deepEqual([statusFor({ nominal: 7, seated: 7 }).threshold, statusFor({ nominal: 10, seated: 10 }).threshold, statusFor({ nominal: 4, seated: 4 }).threshold], [5, 7, 3]);
  assert.equal(statusFor({ nominal: 7, seated: 7, closed: true }).status, 'CLOSED');
});

/** Seven seats on one census: node keys, guardian keys, 50 000-sat bonds; `leaving` the ones whose owners left. */
function seven({ leaving = [], successor = null, closed = false, retiring = [], reserves = null, absencesOf = null, abandonBlocks = null, departureNotice = null, emergencyKeys = {}, heightOf = () => 156036, censusNow = null, bondLock = null, maturities = null } = {}) {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }],
      ...(maturities ? { bondMaturityHeight: maturities[i] } : {}),
      ...(emergencyKeys[i] ? { emergencyPubkey: emergencyKeys[i] } : {}) } })) };
  const seats = nodes.map((n, i) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: heightOf(), networkId: NET } }),
    roster: { censusFor: () => (censusNow ? censusNow(census) : census) }, inviteFor: () => INVITE, networkId: NET, leavingAtMs: () => (leaving.includes(i) ? 1 : null),
    successorOf: () => successor, closedOf: () => closed, retiringOf: () => retiring.includes(i), ...(bondLock ? { bondLock } : {}),
    ...(absencesOf ? { absences: absencesOf(i), abandonBlocks, departureNotice } : {}),
    ...(reserves ? { reserveOf: async () => (reserves[i] === null ? { ok: false, why: 'no answer' } : { ok: true, reserveSats: BigInt(reserves[i]) }) } : {}),
    fetcher: async (url) => {
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      const u = new URL(url); const gone = (u.searchParams.get('gone') || '').split(',').filter(Boolean);
      const rv = u.searchParams.get('reserve');
      const absent = (u.searchParams.get('absent') || '').split(',').filter(Boolean);
      const departed = (u.searchParams.get('departed') || '').split(',').filter(Boolean);
      const emergency = (u.searchParams.get('emergency') || '').split(',').filter(Boolean);
      const left = (u.searchParams.get('left') || '').split(',').filter(Boolean);
      const body = await (gone.length ? j.mySignatureWithGone(u.searchParams.get('federation'), gone, null, rv, absent, departed, emergency, { left }) : j.mySignature(u.searchParams.get('federation'), null, rv));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  return { nodes, census, seats };
}

test('seven guardians sign one record: OPEN with all seated, DRAINING with one leaving, CRITICAL with two; the seat calls it draining', async () => {
  const run = async (leaving) => { const s = seven({ leaving }); return { s, got: await s.seats[0].gather(FED, inviteFederationId) }; };
  const open = await run([]);
  assert.deepEqual([open.got.ok, open.got.status, open.got.signers, open.got.gone, open.got.of], [true, 'OPEN', 7, 0, 7], open.got.why);
  const listed = open.s.seats[0].list()[0];
  assert.equal(listed.status, 'OPEN');
  const v = verifyFederationRecord(fromHex(listed.record), { census: open.s.census.entries, verify, inviteFederationId });
  assert.equal(v.ok, true, v.why);
  assert.equal(v.record.exposureCapSats, 3n * 50000n, '(f+1) x the smallest seated bond');
  assert.equal(open.s.seats[0].draining(toHex(FED)), null);
  // THE CENSUS THE SEAT READS (GET /roles): its height and every entry, with the advert that names its roles
  const now = open.s.seats[0].censusNow();
  assert.deepEqual([now.ok, now.entries.length, now.entries.every((e) => e.pubkey && e.advert)], [true, open.s.census.entries.length, true], now.why);
  const one = await run([3]);
  assert.deepEqual([one.got.status, one.got.gone], ['DRAINING', 1]);
  assert.equal(one.s.seats[0].draining(toHex(FED)), 'DRAINING', 'no new round names it');
  const two = await run([3, 5]);
  assert.deepEqual([two.got.status, two.got.gone], ['CRITICAL', 2]);
});

test('a record is believed only at its threshold of bonded guardians, with its own invite', async () => {
  const s = seven();
  const r = buildFederationRecord({ federationId: FED, networkId: NET, invite: INVITE, nominal: 7, height: 156036,
    guardians: s.census.entries.map((e) => ({ peerKey: e.advert.guardianOf[0].guardianKey, nodePubkey: e.pubkey, operatorId: e.advert.operatorId, bondTxid: e.txid, bondVout: 0, endpoint: '', bondSats: 50000n })) });
  const body = encodeFederationRecord(r);
  assert.deepEqual(federationRecordId(decodeFederationRecord(body)), federationRecordId(r), 'the bytes and the id round-trip');
  const id = federationRecordId(r);
  const sig = (n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) });
  const check = (sigs, over = {}) => verifyFederationRecord(joinSignedRecord(body, sigs), { census: s.census.entries, verify, inviteFederationId, ...over });
  assert.equal(check(s.nodes.slice(0, 5).map(sig)).ok, true, 'five of seven');
  assert.match(check(s.nodes.slice(0, 4).map(sig)).why, /4 of its bonded guardians signed it, and a record needs 5/);
  const stranger = { secret: new Uint8Array(32).fill(0x55) }; stranger.pubkey = schnorr.getPublicKey(stranger.secret);
  assert.match(check([...s.nodes.slice(0, 4).map(sig), sig(stranger)]).why, /4 of its bonded guardians/, 'a stranger\'s signature counts for nothing');
  assert.match(check(s.nodes.slice(0, 5).map(sig), { inviteFederationId: () => new Uint8Array(32).fill(1) }).why, /its invite names another federation/);
  assert.equal(splitSignedRecord(joinSignedRecord(body, s.nodes.slice(0, 5).map(sig))).signatures.length, 5);
});

test('the seat\'s doors: GET /federations lists what it holds, GET /federation-record refuses a malformed id and a seat with no round', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const seat = await serve(openStore(), { plugins: [], port: 0 });
  try {
    const S = `http://127.0.0.1:${seat.port}`;
    const list = await (await fetch(`${S}/federations`)).json();
    assert.deepEqual(list.federations, []);
    assert.equal((await fetch(`${S}/federation-record?federation=zz`)).status, 400);
    // what a seat asks the others before a founding draw (kanban #993)
    const at = await (await fetch(`${S}/federation-records-at?height=188&federations=${toHex(FED)}`)).json();
    assert.deepEqual([at.height, at.records], [188, []]);
    assert.equal((await fetch(`${S}/federation-records-at?height=x&federations=${toHex(FED)}`)).status, 400);
    assert.equal((await fetch(`${S}/federation-record?federation=${toHex(FED)}&previous=zz`)).status, 400, 'a previous record is hex');
    assert.equal((await fetch(`${S}/federation-records-at?height=188&federations=zz`)).status, 400);
    const none = await fetch(`${S}/federation-record?federation=${toHex(FED)}`);
    assert.equal(none.status, 404);
    assert.match((await none.json()).why, /holds no round/);
    // GET /roles: a seat that reads no census yet says why, never an empty list
    const roles = await fetch(`${S}/roles`);
    assert.equal(roles.status, 503);
    assert.match(await roles.text(), /holds no round|no census/);
  } finally { await seat.close(); }
});

// SUCCESSION (§23A.6 steps 2, 4 and 5): the guardians sign the old federation's record DRAINING with the
// successor they were told of; its seated guardians are named for the successor's guardian pool until the record is CLOSED
test('a successor named: the seven sign DRAINING with successor_id, and the successor\'s rounds name the drain\'s seated guardians until CLOSED', async () => {
  const NEW = 'cd'.repeat(32);
  const s = seven({ successor: NEW });
  const got = await s.seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([got.ok, got.status, got.signers], [true, 'DRAINING', 7], got.why);
  const v = verifyFederationRecord(fromHex(s.seats[0].list()[0].record), { census: s.census.entries, verify, inviteFederationId });
  assert.equal(v.ok, true, v.why);
  assert.equal(toHex(v.record.successorId), NEW);
  assert.deepEqual(s.seats[0].predecessorGuardians(NEW).map(toHex).sort(), s.nodes.map((n) => toHex(n.pubkey)).sort(), 'all seven seated');
  assert.deepEqual(s.seats[0].predecessorGuardians('ef'.repeat(32)), [], 'another federation has no predecessor');

  const one = seven({ successor: NEW, leaving: [3] });
  const g1 = await one.seats[0].gather(FED, inviteFederationId);
  assert.equal(g1.status, 'DRAINING');
  assert.equal(one.seats[0].predecessorGuardians(NEW).length, 6, 'the one gone is not paid');

  // two gone of seven while draining: CRITICAL (reserve 0), and the five still seated are still paid until CLOSED
  const two = seven({ successor: NEW, leaving: [3, 4] });
  const gc = await two.seats[0].gather(FED, inviteFederationId);
  assert.equal(gc.status, 'CRITICAL');
  assert.equal(two.seats[0].predecessorGuardians(NEW).length, 5, 'a CRITICAL drain pays its five seated');
  assert.equal(two.seats[0].list()[0].successor, NEW, 'the record shows the successor it names');

  const done = seven({ successor: NEW, closed: true });
  const g2 = await done.seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([g2.ok, g2.status], [true, 'CLOSED'], g2.why);
  assert.deepEqual(done.seats[0].predecessorGuardians(NEW), [], 'CLOSED: the drain is over, nobody is named');

  const none = seven();
  await none.seats[0].gather(FED, inviteFederationId);
  assert.equal(none.seats[0].list()[0].status, 'OPEN', 'no successor named: OPEN as before');
});

// THE GATHERER NAMES ITS CENSUS HEIGHT (measured on testnet4 2026-10-12): each seat took the newest round IT held,
// a round posted ahead whose census it could not read yet - seats 2-7 answered "no chain view for that round" and no record
// ever had more than 1 of its 5 signatures. Now a seat's own basis is the newest round whose census it reads, and a peer
// signs at the height the gatherer names, from a round it holds at that height.
test('a federation that holds nothing is retired (kanban #577): its guardians\' owners consent, the seven sign it CLOSED with no successor', async () => {
  const all = seven({ retiring: [0, 1, 2, 3, 4, 5, 6] });
  const got = await all.seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([got.ok, got.status, got.signers], [true, 'CLOSED', 7], got.why);
  const v = verifyFederationRecord(fromHex(all.seats[0].list()[0].record), { census: all.census.entries, verify, inviteFederationId });
  assert.equal(v.ok, true, v.why);
  assert.equal(v.status, 'CLOSED');
  assert.ok(v.record.successorId.every((x) => x === 0), 'no successor: a retirement, not a succession');
  // five of seven is the threshold: four consents make no record, and a gatherer that did not consent still builds it OPEN
  const four = seven({ retiring: [0, 1, 2, 3] });
  const g4 = await four.seats[0].gather(FED, inviteFederationId);
  assert.equal(g4.ok, false, 'four of seven do not retire it');
  const five = seven({ retiring: [0, 1, 2, 3, 4] });
  assert.deepEqual([(await five.seats[0].gather(FED, inviteFederationId)).status], ['CLOSED']);
  const other = seven({ retiring: [1, 2, 3, 4, 5] });
  const go = await other.seats[0].gather(FED, inviteFederationId);
  assert.notEqual(go.status, 'CLOSED', 'the gatherer whose owner did not consent signs no retirement');
});

test('seats holding rounds at different census heights sign one record: the newest readable for the gatherer, its height for the peers', async () => {
  const base = decodeRoundContract(fromHex(readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1]));
  const s0 = seven();
  const { nodes, census } = s0;
  // every seat: a round at 100 every seat reads and one at 300 nobody reads yet (posted ahead); seats 3, 4, 5 each one more
  // they alone read (150, 160, 170) - their own newest readable
  const own = { 3: 150, 4: 160, 5: 170 };
  const rowsOf = (i) => [100, 300, ...(own[i] ? [own[i]] : [])].map((h, k) => ({ rowid: k + 1, round_id: Buffer.from(new Uint8Array(32).fill(h % 251)), contract: Buffer.from(encodeRoundContract({ ...base, censusHeight: h })) }));
  const reads = (i, rid) => rid[0] === 100 % 251 || (own[i] !== undefined && rid[0] === own[i] % 251);
  const asked = [];
  const seats = nodes.map((n, i) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret }, db: { prepare: (sql) => ({
      // the seat reads its rounds newest first since: max(rowid), then rowid < ? DESC LIMIT ?, then rowid > ? for new ones
      get: () => ({ m: rowsOf(i).length ? Math.max(...rowsOf(i).map((r) => r.rowid)) : null }),
      all: (a, limit) => (/DESC/.test(sql) ? rowsOf(i).filter((r) => r.rowid < a).sort((x, y) => y.rowid - x.rowid).slice(0, limit) : rowsOf(i).filter((r) => r.rowid > a)) }) } },
    roster: { censusFor: (rid) => (reads(i, rid) ? census : { ok: false, why: 'this node has no chain view for that round, so it cannot say who is bonded' }) },
    inviteFor: () => INVITE, networkId: NET,
    fetcher: async (url) => {
      asked.push(url);
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      const u = new URL(url); const h = u.searchParams.get('height');
      const body = await j.mySignature(u.searchParams.get('federation'), h === null ? null : Number(h), u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  const got = await seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([got.ok, got.status, got.signers, got.height], [true, 'OPEN', 7, 100], got.why);
  assert.ok(asked.length === 6 && asked.every((u) => u.includes('&height=100')), 'every peer asked at the gatherer\'s height');
  // seat 3 gathers at its own newest readable height, 150: no other seat holds a round there, so no record - and it says why
  const at150 = await seats[3].gather(FED, inviteFederationId);
  assert.equal(at150.ok, false);
  assert.match(at150.why, /1 of its bonded guardians signed it, and a record needs 5/);
  assert.equal((await seats[1].mySignature(toHex(FED), 150)).why, 'this seat holds no round with census height 150');
  assert.match((await seats[1].mySignature(toHex(FED), 300)).why, /^census height 300: this node has no chain view/);
});

// THE RESERVE AND THE LOAD IN THE RECORD (§23A.3): the gatherer reads the federation's on-chain reserve and names
// it; a seat signs only on its own same reading; the listed load is the signed reserve over the signed exposure cap
test('the signed record carries the reserve the guardians name; the load is reserve over cap; a seat reading another reserve does not sign', async () => {
  const s = seven({ reserves: [650000, 650000, 650000, 650000, 650000, 650000, 650000] });
  const got = await s.seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([got.ok, got.status, got.signers], [true, 'OPEN', 7], got.why);
  const listed = s.seats[0].list()[0];
  assert.deepEqual([listed.reserveSats, listed.exposureCapSats, listed.load], ['650000', '150000', 4.3333]);
  const v = verifyFederationRecord(fromHex(listed.record), { census: s.census.entries, verify, inviteFederationId });
  assert.equal(v.ok, true, v.why);
  assert.equal(v.record.reserveSats, 650000n, 'the reserve is in the signed bytes');
  // two seats read another reserve (a peg-in confirmed between): they do not sign that body; five still do
  const split = seven({ reserves: [650000, 650000, 650000, 700000, 700000, 650000, 650000] });
  const g2 = await split.seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([g2.ok, g2.signers], [true, 5], g2.why);
  assert.match((await split.seats[3].mySignature(toHex(FED), null, '650000')).why, /^this seat reads a reserve of 700000 sat, not 650000$/);
  // the gatherer cannot read one: no record
  const none = seven({ reserves: [null, 650000, 650000, 650000, 650000, 650000, 650000] });
  const g3 = await none.seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([g3.ok, g3.why], [false, 'the reserve: no answer']);
});

// A FEDERATION FOUND, NOT CONFIGURED (2026-10-12: "Make it happen automatically so we don't have to update
// nodes, it needs to find federations"): a seat with no invite for a federation its census knows mirrors the record its
// guardians' nodes hold - kept only when it stands against that seat's own census.
function outsider(census, guardianSeats, nodes) {
  const me = { secret: new Uint8Array(32).fill(0x55) }; me.pubkey = schnorr.getPublicKey(me.secret);
  return federationRecords({
    round: { pubkey: me.pubkey, identity: { secret: me.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => null, networkId: NET,
    fetcher: async (url) => {
      const i = nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (!url.endsWith('/federations') || i < 0) return new Response('no', { status: 404 });
      return new Response(JSON.stringify({ federations: guardianSeats[i].list() }), { status: 200 });
    },
  });
}

// A BOND SPENT WHILE SEATED (§23A.5, kanban #1054): the census drops the guardian, and a record used to shrink its nominal around him with nobody gone
const SPEND = 'cd'.repeat(32), H0 = 156036;
function spentAway({ who = 3, spendAt = H0 + 3, absencesOf = null, departureNotice = null, closed = false, keepOutput = false, maturities = null, bondLock = null } = {}) {
  let h = H0, spends = null;
  const s = seven({ maturities, bondLock, absencesOf, departureNotice, abandonBlocks: absencesOf ? 288 : null, retiring: closed ? [0, 1, 2, 3, 4, 5, 6] : [], heightOf: () => h, censusNow: (c) => {
    if (!spends) return c;
    const n = s.nodes[who];
    return { ok: true, entries: keepOutput ? c.entries.map((e) => (e.pubkey === n.pubkey ? { ...e, bondSats: 40000n } : e)) : c.entries.filter((e) => e.pubkey !== n.pubkey),
      excluded: spends.length ? [{ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + who), vout: 0, why: 'spent', spentBy: { txid: SPEND, height: spendAt }, ...(maturities ? { advert: { bondMaturityHeight: maturities[who] } } : {}) }] : [] };
  } });
  const everyone = async () => { let got = null; for (const seat of s.seats) got = await seat.gather(FED, inviteFederationId); return got; };
  const read = () => splitSignedRecord(fromHex(s.seats[0].list()[0].record)).record;
  return { s, everyone, read, next: (height, list) => { h = height; spends = list; }, spent: [{}] };
}

test('a guardian who spends his bond while seated is ABANDONED from that spend, under its txid, every seat signing the same record; nominal, threshold and the cap do not move around him', async () => {
  const t = spentAway();
  const first = await t.everyone();
  assert.deepEqual([first.ok, first.status, first.of], [true, 'OPEN', 7], first.why);
  t.next(H0 + 6, t.spent);
  const got = await t.everyone();
  assert.deepEqual([got.ok, got.status, got.signers, got.of], [true, 'DRAINING', 6, 6], got.why);
  const r = t.read();
  assert.deepEqual([r.nominal, r.threshold, r.guardians.length, r.height], [7, 5, 7, H0 + 6]);
  assert.deepEqual(r.gone.map((g) => [toHex(g.peerKey), g.sinceHeight, g.kind, toHex(g.proofRef)]), [[toHex(t.s.nodes[3].guardianKey), H0 + 3, 2, SPEND]]);
  assert.equal(r.exposureCapSats, 3n * 50000n, 'the cap counts him gone at once: (f + 1) of the seated bonds');
  // the spend leaves the census's window, and his row stays as it was
  t.next(H0 + 12, []);
  const later = await t.everyone();
  assert.deepEqual([later.ok, later.status], [true, 'DRAINING'], later.why);
  const r2 = t.read();
  assert.deepEqual([r2.nominal, r2.gone.length, r2.gone[0].sinceHeight, toHex(r2.gone[0].proofRef)], [7, 1, H0 + 3, SPEND]);
});

test('before this, the record shrank: with no record in force the census alone says nothing of who sat', async () => {
  const t = spentAway();
  t.next(H0, t.spent);
  const got = await t.everyone();
  assert.deepEqual([got.ok, got.status, got.gone, got.of], [true, 'OPEN', 0, 6], 'nobody is called gone on a census alone');
  assert.equal(t.read().nominal, 6);
});

test('still bonded by another output is still seated: nothing is filed, and the bond in the cap is what is left', async () => {
  const t = spentAway({ keepOutput: true });
  await t.everyone();
  t.next(H0 + 6, t.spent);
  const got = await t.everyone();
  assert.deepEqual([got.ok, got.status, got.gone, got.of], [true, 'OPEN', 0, 7], got.why);
  assert.deepEqual([t.read().gone.length, t.read().exposureCapSats], [0, 3n * 40000n]);
});

test('a notice served out first is no offence, a spend before leave_after is abandonment, and a CLOSED federation asks nothing', async () => {
  const { createAbsences } = await import('../src/absences.js');
  const { signDeparture } = await import('../../arena-protocol/src/absence.js');
  const NOTICE = 3;
  const run = async (leaveAfter, spendAt) => {
    const held = Array.from({ length: 7 }, () => createAbsences({ verify }));
    const t = spentAway({ absencesOf: (i) => held[i], departureNotice: NOTICE, spendAt });
    await t.everyone();
    const n = t.s.nodes[3];
    for (const a of held) a.offerDeparture(signDeparture({ federationId: FED, peerKey: n.guardianKey, leaveAfterHeight: leaveAfter, postedAt: H0, nodePubkey: n.pubkey }, (m) => schnorr.sign(m, n.secret)));
    t.next(H0 + 12, t.spent);
    const got = await t.everyone();
    return { got, r: t.read() };
  };
  const served = await run(H0 + 5, H0 + 8);
  assert.deepEqual([served.got.ok, served.r.gone.length, served.r.nominal], [true, 0, 6], served.got.why);
  const early = await run(H0 + 10, H0 + 8);
  assert.deepEqual([early.got.ok, early.r.gone.map((g) => [g.kind, g.sinceHeight]), early.r.nominal], [true, [[2, H0 + 8]], 7], early.got.why);
  const shut = spentAway({ closed: true });
  await shut.everyone();
  shut.next(H0 + 6, shut.spent);
  const got = await shut.everyone();
  assert.deepEqual([got.ok, shut.read().gone.length], [true, 0], got.why);
});

test('a seat with no round reads the spend from its chain\'s census (spendsAt), as it reads the census', async () => {
  const nodes = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(0x40 + i); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x70 + i)]), endpoint: `wss://chain-${i}.example` }; });
  const entry = (n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xb0 + i), vout: 0, bondSats: 50000n, advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } });
  let tip = 120;
  const entriesAt = (h) => (h >= 118 ? nodes.slice(1) : nodes).map((n) => entry(n, nodes.indexOf(n)));
  const seats = nodes.map((n) => federationRecords({ round: { pubkey: n.pubkey, identity: { secret: n.secret }, db: { prepare: () => ({ all: () => [], get: () => ({ m: 0 }) }) } }, roster: { censusFor: () => ({ ok: false, why: 'none' }) }, inviteFor: () => INVITE, networkId: NET,
    censusAt: async (h) => entriesAt(h), chainTip: async () => tip, spendsAt: async (h) => (h >= 118 ? [{ pubkey: nodes[0].pubkey, txid: new Uint8Array(32).fill(0xb0), vout: 0, spentBy: { txid: SPEND, height: 117 } }] : []),
    fetcher: async (url) => {
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      if (!j) throw new Error('no seat');
      const u = new URL(url), at = Number(u.searchParams.get('height'));
      const body = await j.mySignature(u.searchParams.get('federation'), at, u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    } }));
  for (const seat of seats) assert.equal((await seat.gatherAll(inviteFederationId))[0].ok, true);
  tip = 126;
  for (const seat of seats.slice(1)) { const [got] = await seat.gatherAll(inviteFederationId); assert.equal(got.ok, true, got.why); }
  const r = splitSignedRecord(fromHex(seats[1].list()[0].record)).record;
  assert.deepEqual([r.nominal, r.height, r.gone.length, r.gone[0].sinceHeight, toHex(r.gone[0].proofRef)], [4, 120, 1, 117, SPEND]);
});

test('a seat with no invite for a federation its census knows mirrors the record its guardians hold', async () => {
  const s = seven();
  for (const seat of s.seats) assert.equal((await seat.gather(FED, inviteFederationId)).ok, true);
  const o = outsider(s.census, s.seats, s.nodes);
  assert.deepEqual(o.list(), [], 'nothing before it asks');
  const got = await o.gatherAll(inviteFederationId);
  assert.deepEqual([got[0].ok, got[0].mirrored, got[0].status, got[0].signers], [true, true, 'OPEN', 7], got[0].why);
  const listed = o.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].federation, toHex(FED));
  assert.equal(verifyFederationRecord(fromHex(listed[0].record), { census: s.census.entries, verify, inviteFederationId }).ok, true);
});

test('a seat that holds the invite but whose gather no guardian signs keeps the record its guardians hold', async () => {
  const s = seven();
  for (const seat of s.seats) assert.equal((await seat.gather(FED, inviteFederationId)).ok, true);
  const me = { secret: new Uint8Array(32).fill(0x56) }; me.pubkey = schnorr.getPublicKey(me.secret);
  // node 15's case, measured live: it holds B's invite, its own basis is another census height, and B's guardians sign nothing for it
  const o = federationRecords({
    round: { pubkey: me.pubkey, identity: { secret: me.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => s.census }, inviteFor: () => 'an invite this seat holds', networkId: NET,
    fetcher: async (url) => {
      const i = s.nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0 || !url.endsWith('/federations')) return new Response('no basis at that height', { status: 404 });
      return new Response(JSON.stringify({ federations: s.seats[i].list() }), { status: 200 });
    },
  });
  const got = await o.gatherAll(inviteFederationId);
  assert.deepEqual([got[0].ok, got[0].mirrored, got[0].status, got[0].signers], [true, true, 'OPEN', 7], got[0].why);
  assert.ok(got[0].gathered, 'the gather\'s own refusal is kept beside the mirrored record');
  assert.equal(o.list().length, 1);
});

// A RECORD NONE OF ITS GUARDIANS' NODES HOLDS (kanban #326, measured 2026-10-21): T2's census guardians are the T nodes, whose
// seats hold no T2 record, while T2's own seats do - so a seat asks the census seats it reads too, a few each pass, in turn.
test('a record none of its guardians\' nodes holds is mirrored from the census seats, in turn, and still checked against the census', async () => {
  const s = seven();
  for (const seat of s.seats) assert.equal((await seat.gather(FED, inviteFederationId)).ok, true);
  const me = { secret: new Uint8Array(32).fill(0x57) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const others = Array.from({ length: 12 }, (_, i) => `https://seat${i}.test`);
  const asked = [];
  const o = federationRecords({
    round: { pubkey: me.pubkey, identity: { secret: me.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => s.census }, inviteFor: () => null, networkId: NET, peerSeats: () => others,
    fetcher: async (url) => {
      asked.push(url.replace(/\/federations$/, ''));
      // the guardians' own nodes hold nothing; only seat11 (the federation's seat outside its census guardians) holds the record
      if (url === 'https://seat11.test/federations') return new Response(JSON.stringify({ federations: s.seats[0].list() }), { status: 200 });
      return new Response(JSON.stringify({ federations: [] }), { status: 200 });
    },
  });
  const first = await o.gatherAll(inviteFederationId);
  assert.equal(first[0].ok, false);
  assert.match(first[0].why, /^none of its guardians holds a record, nor 8 of the census seats asked$/);
  assert.deepEqual(asked.filter((u) => u.endsWith(".test")), others.slice(0, MIRROR_PEERS), 'eight seats on the first pass');
  asked.length = 0;
  const second = await o.gatherAll(inviteFederationId);
  assert.deepEqual([second[0].ok, second[0].mirrored, second[0].status, second[0].signers], [true, true, 'OPEN', 7], second[0].why);
  assert.deepEqual(asked.filter((u) => u.endsWith(".test")), [...others.slice(MIRROR_PEERS), ...others.slice(0, MIRROR_PEERS)].slice(0, MIRROR_PEERS), "the next eight, in turn");
  assert.equal(verifyFederationRecord(fromHex(o.list()[0].record), { census: s.census.entries, verify, inviteFederationId }).ok, true);
  // a census that bonds too few of its guardians keeps nothing, wherever the record came from
  const short = federationRecords({
    round: { pubkey: me.pubkey, identity: { secret: me.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => ({ ok: true, entries: s.census.entries.slice(0, 4) }) }, inviteFor: () => null, networkId: NET, peerSeats: () => ['https://seat11.test'],
    fetcher: async (url) => new Response(JSON.stringify({ federations: url === 'https://seat11.test/federations' ? s.seats[0].list() : [] }), { status: 200 }),
  });
  assert.equal((await short.gatherAll(inviteFederationId))[0].ok, false);
  assert.deepEqual(short.list(), []);
});

test('a mirrored record that does not stand against the seat\'s own census is not kept', async () => {
  const s = seven();
  for (const seat of s.seats) await seat.gather(FED, inviteFederationId);
  // this seat's census bonds only 4 of the 7 guardians: below the threshold of 5, the record signed by all 7 does not stand here
  const o = outsider({ ok: true, entries: s.census.entries.slice(0, 4) }, s.seats, s.nodes);
  const got = await o.gatherAll(inviteFederationId);
  assert.equal(got[0].ok, false);
  assert.deepEqual(o.list(), []);
});

test('a mirrored record that does not stand against the seat\'s older census stands against the census at its own height', async () => {
  const s = seven();
  for (const seat of s.seats) await seat.gather(FED, inviteFederationId);
  const me = { secret: new Uint8Array(32).fill(0x57) }; me.pubkey = schnorr.getPublicKey(me.secret);
  // node 15's case: its own basis (an older census) bonds only 4 of the 7 guardians; the record names its own census height
  const asked = [];
  // the basis lists the guardians (so they are asked), but bonds only 4 of them: the record does not stand against it
  const thin = { ok: true, entries: s.census.entries.map((e, i) => (i < 4 ? e : { ...e, advert: { ...e.advert, guardianOf: [] } })) };
  const o2 = federationRecords({ round: { pubkey: me.pubkey, identity: { secret: me.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => thin }, inviteFor: () => null, networkId: NET,
    fetcher: async (url) => {
      const i = s.nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (i < 0 || !url.endsWith('/federations')) return new Response('no', { status: 404 });
      return new Response(JSON.stringify({ federations: s.seats[i].list() }), { status: 200 });
    },
    censusAt: async (h) => { asked.push(h); return s.census.entries; } });
  const got = await o2.gatherAll(inviteFederationId);
  assert.deepEqual([got[0].ok, got[0].mirrored, got[0].signers], [true, true, 7], got[0].why);
  assert.ok(asked.length >= 1 && asked.every((h) => h === asked[0]), 'the census asked at the record\'s own height');
  assert.equal(o2.list().length, 1);
});

test('2f + 1 guardians\' absence attestations held by the gatherer make the peer ABANDONED in the record every guardian signs', async () => {
  const { createAbsences, absenceHex } = await import('../src/absences.js');
  const { signAbsence } = await import('../../arena-protocol/src/absence.js');
  const ABANDON = 288;
  const attestFrom = (nodes, k) => nodes.slice(0, k).map((n) => signAbsence({ federationId: FED, peerKey: nodes[6].guardianKey, lastSeenHeight: 1000, height: 1300, attester: n.pubkey }, (m) => schnorr.sign(m, n.secret)));
  const run = async (k) => {
    const held = createAbsences({ verify });
    const s = seven({ absencesOf: (i) => (i === 0 ? held : createAbsences({ verify })), abandonBlocks: ABANDON });
    for (const a of attestFrom(s.nodes, k)) assert.equal(held.offer(a).kept, true);
    return { s, got: await s.seats[0].gather(FED, inviteFederationId) };
  };
  const five = await run(5);
  assert.deepEqual([five.got.ok, five.got.status, five.got.gone, five.got.signers], [true, 'DRAINING', 1, 7], five.got.why);
  const v = verifyFederationRecord(fromHex(five.s.seats[0].list()[0].record), { census: five.s.census.entries, verify, inviteFederationId });
  assert.deepEqual([v.record.gone[0].kind, v.record.gone[0].sinceHeight, toHex(v.record.gone[0].peerKey)], [2, 1000, toHex(five.s.nodes[6].guardianKey)], 'ABANDONED since the proof');
  const four = await run(4);
  assert.deepEqual([four.got.status, four.got.gone], ['OPEN', 0], 'four of seven prove nothing');
  // a guardian seat handed a set that is no proof does not sign it ABANDONED
  const said = await four.s.seats[1].mySignatureWithGone(toHex(FED), [toHex(four.s.nodes[6].guardianKey)], null, null, attestFrom(four.s.nodes, 4).map(absenceHex));
  assert.match(said.why, /does not stand here: 4 guardian\(s\) attest the absence, the threshold is 5/);
});

test('a guardian\'s own departure notice, once due, makes it DEPARTED from leave_after in the record every guardian signs', async () => {
  const { createAbsences, departureHex } = await import('../src/absences.js');
  const { signDeparture } = await import('../../arena-protocol/src/absence.js');
  const NOTICE = 18;
  const notice = (nodes, leaveAfter) => signDeparture({ federationId: FED, peerKey: nodes[3].guardianKey, leaveAfterHeight: leaveAfter, postedAt: 156000, nodePubkey: nodes[3].pubkey }, (m) => schnorr.sign(m, nodes[3].secret));
  const run = async (leaveAfter) => {
    const held = createAbsences({ verify });
    const s = seven({ absencesOf: (i) => (i === 0 ? held : createAbsences({ verify })), abandonBlocks: 288, departureNotice: NOTICE });
    assert.equal(held.offerDeparture(notice(s.nodes, leaveAfter)).kept, true);
    return { s, got: await s.seats[0].gather(FED, inviteFederationId) };
  };
  const due = await run(156020);
  assert.deepEqual([due.got.status, due.got.gone, due.got.signers], ['DRAINING', 1, 7], due.got.why);
  const v = verifyFederationRecord(fromHex(due.s.seats[0].list()[0].record), { census: due.s.census.entries, verify, inviteFederationId });
  assert.deepEqual([v.record.gone[0].kind, v.record.gone[0].sinceHeight], [1, 156020], 'DEPARTED from leave_after');
  const later = await run(156100);
  assert.deepEqual([later.got.status, later.got.gone], ['OPEN', 0], 'a notice not yet due leaves it seated');
  const said = await later.s.seats[1].mySignatureWithGone(toHex(FED), [toHex(later.s.nodes[3].guardianKey)], null, null, [], [departureHex(notice(later.s.nodes, 156010))]);
  assert.match(said.why, /does not stand here: leave_after 156010 is less than departure_notice/);
});

test('a guardian with a due notice who stopped before its leave_after is ABANDONED, one gone from leave_after DEPARTED (§23A.5, rehearsal 14)', async () => {
  const { createAbsences } = await import('../src/absences.js');
  const { signDeparture, signAbsence } = await import('../../arena-protocol/src/absence.js');
  const NOTICE = 18; const ABANDON = 288; const LEAVE = 156020;
  const run = async (lastSeen) => {
    const held = createAbsences({ verify });
    const s = seven({ absencesOf: (i) => (i === 0 ? held : createAbsences({ verify })), abandonBlocks: ABANDON, departureNotice: NOTICE });
    const leaver = s.nodes[3];
    assert.equal(held.offerDeparture(signDeparture({ federationId: FED, peerKey: leaver.guardianKey, leaveAfterHeight: LEAVE, postedAt: 156000, nodePubkey: leaver.pubkey }, (m) => schnorr.sign(m, leaver.secret))).kept, true);
    for (const n of s.nodes.filter((x) => x !== leaver).slice(0, 5))
      assert.equal(held.offer(signAbsence({ federationId: FED, peerKey: leaver.guardianKey, lastSeenHeight: lastSeen, height: lastSeen + ABANDON, attester: n.pubkey }, (m) => schnorr.sign(m, n.secret))).kept, true);
    const got = await s.seats[0].gather(FED, inviteFederationId);
    const v = verifyFederationRecord(fromHex(s.seats[0].list()[0].record), { census: s.census.entries, verify, inviteFederationId });
    return { got, gone: v.record.gone };
  };
  const early = await run(LEAVE - 10);
  assert.deepEqual([early.got.gone, early.got.signers, early.gone[0].kind, early.gone[0].sinceHeight], [1, 7, 2, LEAVE - 10], 'ABANDONED since it stopped');
  const onTime = await run(LEAVE);
  assert.deepEqual([onTime.got.gone, onTime.got.signers, onTime.gone[0].kind, onTime.gone[0].sinceHeight], [1, 7, 1, LEAVE], 'DEPARTED from leave_after');
});

test('seats that hold no round build and sign the record from their chain\'s census (the new second-host seats held no record, so no seated guardians and no gateway seats)', async () => {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 21) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x70 + i)]); n.endpoint = `wss://nr-${i}.example`; }
  const entries = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xb0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `nr${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://ng${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } }));
  const asked = [];
  const seats = nodes.map((n) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => null,
    roster: { censusFor: () => ({ ok: false, why: 'no round' }) }, inviteFor: () => INVITE, networkId: NET,
    censusAt: async (h) => { asked.push(h); return entries; }, chainTip: async () => 157000,
    fetcher: async (url) => {
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      const u = new URL(url);
      if (!u.pathname.endsWith('/federation-record')) return new Response('{}', { status: 404 });
      const hp = u.searchParams.get('height');
      const body = await j.mySignature(u.searchParams.get('federation'), hp === null ? null : Number(hp), u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    },
  }));
  assert.match(seats[0].censusNow().why, /holds no round/, 'before: no census at all');
  for (const s of seats) await s.gatherAll(inviteFederationId);           // each reads its chain's census ahead
  const now = seats[0].censusNow();
  assert.deepEqual([now.ok, now.height, now.entries.length], [true, 156990, 7], 'the census 6 below the tip, at a multiple of 6: 156990');
  assert.ok(asked.every((h) => h === 156990), `every seat names the same height: ${[...new Set(asked)]}`);
  const got = await seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([got.ok, got.status, got.signers], [true, 'OPEN', 7], got.why);
  assert.equal(seats[0].list()[0].height, 156990);
  assert.equal(seats[0].seatedGuardians(toHex(FED)).length, 7, 'its seated guardians, for the gateway seats');
});

test('ARENA_RECORD_BASIS=chain: a seat holding only an old round takes the chain\'s newer census, which names the federation (T2\'s relay seats)', async () => {
  const nodes = Array.from({ length: 4 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 41) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x80 + i)]); n.endpoint = `wss://t2-${i}.example`; }
  const named = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xc0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `t2op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://tg${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } }));
  const old = { ok: true, entries: named.map((e) => ({ ...e, advert: { ...e.advert, guardianOf: [] } })) };   // before the bonds named it
  const make = (chainFirst) => nodes.map((n) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156768, networkId: NET } }),
    roster: { censusFor: () => old }, inviteFor: () => INVITE, networkId: NET, chainFirst,
    censusAt: async () => named, chainTip: async () => 156990,
    fetcher: async (url) => { const u = new URL(url); if (!u.pathname.endsWith('/federation-record')) return new Response('{}', { status: 404 });
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))]; const hp = u.searchParams.get('height');
      const body = await j.mySignature(u.searchParams.get('federation'), hp === null ? null : Number(hp), u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 }); } }));
  let seats = make(false);
  for (const s of seats) await s.gatherAll(inviteFederationId);
  for (const s of seats) await s.gatherAll(inviteFederationId);
  assert.equal(seats[0].censusNow().height, 156768, 'by default the held round\'s census');
  // kanban #549: a federation the held round's census does not name is read from the chain's census - with no setting
  const auto = seats[0].list().find((x) => x.federation === toHex(FED));
  assert.ok(auto, 'the federation only the chain\'s census names is gathered by default (kanban #549)');
  assert.deepEqual([auto.status, auto.signers], ['OPEN', 4]);
  assert.equal(Number(auto.height), 156984, 'from the chain\'s census, 6 below the tip at a multiple of 6');
  seats = make(true);
  for (const s of seats) await s.gatherAll(inviteFederationId);
  assert.equal(seats[0].censusNow().height, 156984, 'chain first: the census 6 below the tip at a multiple of 6');
  const got = await seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([got.ok, got.status, got.signers], [true, 'OPEN', 4], got.why);
});

test('the owner\'s emergency departure of a guardian (§23A.5a, protocol 17): in time DEPARTED from posted_at, bond untouched; late it is abandonment, slashed', async () => {
  const { createAbsences, emergencyHex } = await import('../src/absences.js');
  const { signAbsence } = await import('../../arena-protocol/src/absence.js');
  const { emergencyCodeBytes, emergencySecret, signEmergencyDeparture } = await import('../../arena-protocol/src/emergency.js');
  const ABANDON = 288; const POSTED = 156000;
  const secret = emergencySecret(emergencyCodeBytes(new Uint8Array(32).fill(0x44)));
  const pub = schnorr.getPublicKey(secret);
  const run = async (lastSeen, { key = pub } = {}) => {
    const stores = Array.from({ length: 7 }, () => createAbsences({ verify }));
    const held = stores[0];
    const s = seven({ absencesOf: (i) => stores[i], abandonBlocks: ABANDON, emergencyKeys: { 3: key } });
    const leaver = s.nodes[3];
    const req = signEmergencyDeparture({ nodePubkey: leaver.pubkey, emergencyPubkey: pub, postedAt: POSTED }, (m) => schnorr.sign(m, secret));
    // every seat took it (POST /emergency-departure passes it on); the attestations are the gatherer's alone, as in the tests above
    for (const st of stores) assert.equal(st.offerEmergency(req).kept, true);
    if (lastSeen !== null) for (const n of s.nodes.filter((x) => x !== leaver).slice(0, 5))
      assert.equal(held.offer(signAbsence({ federationId: FED, peerKey: leaver.guardianKey, lastSeenHeight: lastSeen, height: lastSeen + ABANDON, attester: n.pubkey }, (m) => schnorr.sign(m, n.secret))).kept, true);
    const got = await s.seats[0].gather(FED, inviteFederationId);
    const kept = s.seats[0].list()[0];
    const v = kept ? verifyFederationRecord(fromHex(kept.record), { census: s.census.entries, verify, inviteFederationId }) : null;
    return { s, req, got, gone: v ? v.record.gone : [] };
  };
  // IN TIME: last seen 155900, posted 156000 < 155900 + 288 - DEPARTED from posted_at, though 5 guardians attest the absence
  const inTime = await run(155900);
  assert.deepEqual([inTime.got.status, inTime.got.gone, inTime.got.signers, inTime.gone[0].kind, inTime.gone[0].sinceHeight], ['DRAINING', 1, 7, 1, POSTED], inTime.got.why);
  // and with no attestation at all (the owner was quicker than the guardians' daily attestation): DEPARTED too
  const noProof = await run(null);
  assert.deepEqual([noProof.got.gone, noProof.gone[0].kind, noProof.gone[0].sinceHeight], [1, 1, POSTED]);
  // LATE: last seen 155700, posted 156000 >= 155700 + 288 - nothing changes: ABANDONED since last seen, the slash stands ("Do not soften that case")
  const late = await run(155700);
  assert.deepEqual([late.got.gone, late.got.signers, late.gone[0].kind, late.gone[0].sinceHeight], [1, 7, 2, 155700], 'late: ABANDONED');
  // the last block in time: posted 156000 with last seen 155713 (155713 + 288 = 156001) is still in time
  const edge = await run(155713);
  assert.deepEqual([edge.gone[0].kind, edge.gone[0].sinceHeight], [1, POSTED]);
  // a request the node's advertisement does not name the key of stands nowhere: the guardian stays seated
  const foreign = await run(null, { key: new Uint8Array(32).fill(9) });
  assert.deepEqual([foreign.got.status, foreign.got.gone], ['OPEN', 0]);
  // a guardian seat handed a request it never took itself does not sign it DEPARTED (it could be dated back)
  const never = await inTime.s.seats[1].mySignatureWithGone(toHex(FED), [toHex(inTime.s.nodes[3].guardianKey)], null, null, [], [],
    [emergencyHex(signEmergencyDeparture({ nodePubkey: inTime.s.nodes[3].pubkey, emergencyPubkey: pub, postedAt: POSTED - 50 }, (m) => schnorr.sign(m, secret)))]);
  assert.match(never.why, /not one this seat took itself/);
  // a guardian seat handed a late request does not sign it DEPARTED when it holds the attestations itself
  const lateSeat = createAbsences({ verify });
  lateSeat.offerEmergency(late.req);
  const s2 = seven({ absencesOf: (i) => (i === 1 ? lateSeat : createAbsences({ verify })), abandonBlocks: ABANDON, emergencyKeys: { 3: pub } });
  for (const n of s2.nodes.filter((x) => x !== s2.nodes[3]).slice(0, 5))
    lateSeat.offer(signAbsence({ federationId: FED, peerKey: s2.nodes[3].guardianKey, lastSeenHeight: 155700, height: 155988, attester: n.pubkey }, (m) => schnorr.sign(m, n.secret)));
  const said = await s2.seats[1].mySignatureWithGone(toHex(FED), [toHex(s2.nodes[3].guardianKey)], null, null, [], [], [emergencyHex(late.req)]);
  assert.match(said.why, /emergency departure does not stand here, or came after abandon_blocks/);
});

// kanban #549 (2026-10-20 ~06:55Z: "federation shows as draining on b18947f085d4 but no new federation is created ... it may not be a
// manual step"): a DRAINING federation's successor, named in its guardians' adverts only after the held rounds' census froze, gets its own
// record from the chain's census by itself - and the drained one keeps the record its round census gives it
test('a draining federation\'s successor, unknown to the held rounds\' census, gets its record from the chain\'s census with no setting (kanban #549)', async () => {
  const SUCC = new Uint8Array(32).fill(0x4d);
  const nodes = Array.from({ length: 4 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 61) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.oldKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x90 + i)]); n.nextKey = Uint8Array.from([3, ...new Uint8Array(32).fill(0xa0 + i)]); n.endpoint = `wss://s549-${i}.example`; }
  const entry = (n, i, guardianOf) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xd0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op549-${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g549-${i}.example`, guardianOf } });
  const roundCensus = { ok: true, entries: nodes.map((n, i) => entry(n, i, [{ federationId: FED, guardianKey: n.oldKey }])) };
  const chainCensus = nodes.map((n, i) => entry(n, i, [{ federationId: FED, guardianKey: n.oldKey }, { federationId: SUCC, guardianKey: n.nextKey }]));
  const seats = nodes.map((n) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(7), contract: { censusHeight: 156873, networkId: NET } }),
    roster: { censusFor: () => roundCensus }, inviteFor: (fid) => `fed:${fid}`, networkId: NET,
    successorOf: (fid) => (fid === toHex(FED) ? toHex(SUCC) : null),
    censusAt: async () => chainCensus, chainTip: async () => 157090,
    fetcher: async (url) => { const u = new URL(url); if (!u.pathname.endsWith('/federation-record')) return new Response('{}', { status: 404 });
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))]; const hp = u.searchParams.get('height');
      const body = await j.mySignature(u.searchParams.get('federation'), hp === null ? null : Number(hp), u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 }); } }));
  for (let pass = 0; pass < 2; pass++) for (const s of seats) await s.gatherAll(inviteFederationId);
  const list = seats[0].list();
  const drained = list.find((x) => x.federation === toHex(FED)), succ = list.find((x) => x.federation === toHex(SUCC));
  assert.ok(drained && drained.successor === toHex(SUCC), 'the drained federation\'s record names its successor');
  assert.equal(Number(drained.height), 156873, 'from the held round\'s census, as before');
  assert.ok(succ, 'the successor has a record');
  assert.deepEqual([succ.signers, Number(succ.height)], [4, 157080], 'signed by its 4 guardians at the chain\'s census (157,090 - 6, down to a multiple of 6)');
});

// ADD TO BOND (kanban #544): a guardian with two bond outputs is one guardian of the record, its bond their sum, its outpoint the lowest
test('guardiansOf: a node with two bond outputs is one guardian, its bond their sum; two nodes stay two', () => {
  const fid = new Uint8Array(32).fill(0x33);
  const advert = (n) => ({ operatorId: `op-${n}`, guardianOf: [{ federationId: fid, guardianKey: Uint8Array.from([0x02, ...new Uint8Array(32).fill(n)]) }], guardianEndpoint: `wss://g${n}`, endpoint: `https://n${n}` });
  const e = (n, txidByte, sats) => ({ pubkey: new Uint8Array(32).fill(n), txid: new Uint8Array(32).fill(txidByte), vout: 0, bondSats: sats, advert: advert(n) });
  const rows = guardiansOf({ entries: [e(1, 0x90, 50000n), e(1, 0x10, 32000n), e(2, 0x50, 50000n), { pubkey: new Uint8Array(32).fill(3), txid: new Uint8Array(32).fill(0x60), vout: 0, bondSats: 90000n, advert: { operatorId: 'x', guardianOf: [] } }] }, fid);
  assert.deepEqual(rows.map((r) => [toHex(r.nodePubkey).slice(0, 2), r.bondSats, toHex(r.bondTxid).slice(0, 2)]), [['01', 82000n, '10'], ['02', 50000n, '50']]);
});

// kanban #549 (measured 2026-10-20 07:37Z): right after a restart a guardian seat refused its gatherer's named height - "this seat holds
// no round with census height 157086" - having only started reading that census; now it reads it before it answers
test('a guardian seat asked at a chain census height it has not read yet reads it and signs on the first ask (kanban #549)', async () => {
  const SUCC = new Uint8Array(32).fill(0x4e);
  const n = { secret: new Uint8Array(32).fill(71) }; n.pubkey = schnorr.getPublicKey(n.secret);
  const entry = { pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xe1), vout: 0, bondSats: 50000n,
    advert: { operatorId: 'op549b', endpoint: 'wss://n549b.example', guardianEndpoint: 'wss://g549b.example', guardianOf: [{ federationId: SUCC, guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x91)]) }] } };
  let reads = 0;
  const seat = federationRecords({ round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => null, roster: { censusFor: () => ({ ok: false }) },
    inviteFor: (fid) => `fed:${fid}`, networkId: NET, censusAt: async () => { reads++; await new Promise((r) => setTimeout(r, 20)); return [entry]; }, chainTip: async () => 157092 });
  const first = await seat.mySignature(toHex(SUCC), 157086);
  assert.deepEqual([first.ok, first.height], [true, 157086], first.why);
  await seat.mySignature(toHex(SUCC), 157086);
  assert.equal(reads, 1, 'read once, kept');
});

test('the records outlive a restart: a seat with a store keeps what it gathered, and a new seat on the same store restores it, checked again (kanban #557)', async () => {
  const SUCC = new Uint8Array(32).fill(0x4d);
  const nodes = Array.from({ length: 4 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 61) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.oldKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x90 + i)]); n.nextKey = Uint8Array.from([3, ...new Uint8Array(32).fill(0xa0 + i)]); n.endpoint = `wss://s549-${i}.example`; }
  const entry = (n, i, guardianOf) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xd0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op549-${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g549-${i}.example`, guardianOf } });
  const roundCensus = { ok: true, entries: nodes.map((n, i) => entry(n, i, [{ federationId: FED, guardianKey: n.oldKey }])) };
  const chainCensus = nodes.map((n, i) => entry(n, i, [{ federationId: FED, guardianKey: n.oldKey }, { federationId: SUCC, guardianKey: n.nextKey }]));
  const stores = nodes.map(() => { const m = new Map(); return { m, load: async () => [...m].map(([federation, record]) => ({ federation, record })), save: (f, r) => { m.set(f, r); } }; });
  const seats = nodes.map((n, si) => federationRecords({ store: stores[si],
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(7), contract: { censusHeight: 156873, networkId: NET } }),
    roster: { censusFor: () => roundCensus }, inviteFor: (fid) => `fed:${fid}`, networkId: NET,
    successorOf: (fid) => (fid === toHex(FED) ? toHex(SUCC) : null),
    censusAt: async () => chainCensus, chainTip: async () => 157090,
    fetcher: async (url) => { const u = new URL(url); if (!u.pathname.endsWith('/federation-record')) return new Response('{}', { status: 404 });
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))]; const hp = u.searchParams.get('height');
      const body = await j.mySignature(u.searchParams.get('federation'), hp === null ? null : Number(hp), u.searchParams.get('reserve'));
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 }); } }));
  for (let pass = 0; pass < 2; pass++) for (const s of seats) await s.gatherAll(inviteFederationId);
  assert.ok(stores[0].m.has(toHex(SUCC)) && stores[0].m.has(toHex(FED)), 'both records saved');
  const n0 = nodes[0];
  const fresh = federationRecords({ store: stores[0], round: { pubkey: n0.pubkey, identity: { secret: n0.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(7), contract: { censusHeight: 156873, networkId: NET } }),
    roster: { censusFor: () => roundCensus }, inviteFor: (fid) => `fed:${fid}`, networkId: NET, successorOf: (fid) => (fid === toHex(FED) ? toHex(SUCC) : null),
    censusAt: async () => chainCensus, chainTip: async () => 157090, fetcher: async () => { throw new Error('no network after the restart'); } });
  assert.equal(fresh.list().length, 0, 'nothing in memory after the restart');
  const r = await fresh.restore(inviteFederationId);
  assert.deepEqual([r.restored, r.of], [2, 2]);
  assert.deepEqual(fresh.list().map((x) => x.federation).sort(), [toHex(FED), toHex(SUCC)].sort());
  // THE RECORD IN FORCE AT A HEIGHT (kanban #559/#543, §23A.3a): the newest at or below it; before the first one, none
  const at = fresh.recordAt(toHex(SUCC), 9_999_999);
  assert.ok(at && Number(at.height) > 0, 'the record in force at a later height is the newest');
  assert.equal(fresh.recordAt(toHex(SUCC), Number(at.height) - 1), null, 'below its height this seat holds none');
  // a saved record altered is not taken back
  const orig = stores[0].m.get(toHex(SUCC));
  const bad = new Map([[toHex(SUCC), orig.slice(0, 80) + (orig[80] === '0' ? '1' : '0') + orig.slice(81)]]);   // one hex digit of the signed body
  const fresh2 = federationRecords({ store: { load: async () => [...bad].map(([federation, record]) => ({ federation, record })), save: () => {} }, round: { pubkey: n0.pubkey, identity: { secret: n0.secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(7), contract: { censusHeight: 156873, networkId: NET } }), roster: { censusFor: () => roundCensus }, inviteFor: (fid) => `fed:${fid}`, networkId: NET,
    censusAt: async () => chainCensus, chainTip: async () => 157090 });
  assert.equal((await fresh2.restore(inviteFederationId)).restored, 0);
  // NO CENSUS YET (2026-10-20, measured 12:48Z: six restarted seats held no record for minutes, their chain view not built): the
  // seat's own kept records come back at once, checked against their own guardian lists - every signature and the threshold
  const blind = (store) => federationRecords({ store, round: { pubkey: n0.pubkey, identity: { secret: n0.secret } }, newest: () => null,
    roster: { censusFor: () => ({ ok: false, why: 'no census yet' }) }, inviteFor: (fid) => `fed:${fid}`, networkId: NET,
    censusAt: () => new Promise(() => {}), chainTip: async () => 157090, fetcher: async () => { throw new Error('no network'); } });
  const early = blind(stores[0]);
  const t0 = Date.now();
  const e = await early.restore(inviteFederationId);
  assert.deepEqual([e.restored, e.of], [2, 2], 'both back with no census');
  assert.ok(Date.now() - t0 < 12000, 'a census that never answers holds the restore 5 s per record at most');
  assert.deepEqual(early.list().map((x) => x.federation).sort(), [toHex(FED), toHex(SUCC)].sort());
  assert.equal((await blind({ load: async () => [...bad].map(([federation, record]) => ({ federation, record })), save: () => {} }).restore(inviteFederationId)).restored, 0,
    'an altered record is refused here too: its signatures do not check');
});

// A CLOSED RECORD IS FINAL (kanban #577, measured 2026-10-22 on federation 89ce310e): one guardian's node held the CLOSED record (7 of 10
// signed it), set its guardian aside - and every other seat kept the OPEN record of the same height, one guardian short of ever signing
// the closed body. At the same height a CLOSED record wins a mirror pass and is never replaced by one that is not.
test('a CLOSED record of the same height wins the mirror and stays: an OPEN one of that height never replaces it (kanban #577)', async () => {
  const open = seven(), closed = seven({ retiring: [0, 1, 2, 3, 4, 5, 6] });
  for (const seat of [...open.seats, ...closed.seats]) assert.equal((await seat.gather(FED, inviteFederationId)).ok, true);
  assert.deepEqual([open.seats[0].list()[0].status, closed.seats[0].list()[0].status, open.seats[0].list()[0].height], ['OPEN', 'CLOSED', closed.seats[0].list()[0].height]);
  let lists = open.seats.map((x) => x.list());
  const me = { secret: new Uint8Array(32).fill(0x57) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const o = federationRecords({
    round: { pubkey: me.pubkey, identity: { secret: me.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => open.census }, inviteFor: () => null, networkId: NET,
    fetcher: async (url) => {
      const i = open.nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (!url.endsWith('/federations') || i < 0) return new Response('no', { status: 404 });
      return new Response(JSON.stringify({ federations: lists[i] }), { status: 200 });
    },
  });
  assert.equal((await o.gatherAll(inviteFederationId))[0].status, 'OPEN', 'every guardian holds it OPEN: OPEN');
  lists = open.seats.map((x, i) => (i === 3 ? closed.seats[3].list() : x.list()));
  assert.equal((await o.gatherAll(inviteFederationId))[0].status, 'CLOSED', 'one guardian holds it CLOSED at the same height: CLOSED');
  assert.equal(o.list()[0].status, 'CLOSED');
  lists = open.seats.map((x) => x.list());
  await o.gatherAll(inviteFederationId);
  assert.equal(o.list()[0].status, 'CLOSED', 'an OPEN record of the same height does not replace it');
});

test('how many of a federation\'s guardian seats hold it CLOSED: a retiring guardian waits for a threshold of them (kanban #577)', async () => {
  const closed = seven({ retiring: [0, 1, 2, 3, 4, 5, 6] });
  for (const seat of closed.seats) assert.equal((await seat.gather(FED, inviteFederationId)).ok, true);
  // the seats answer GET /federations from their own lists
  const ask = (s, list) => federationRecords({ round: { pubkey: s.nodes[0].pubkey, identity: { secret: s.nodes[0].secret } },
    newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }), roster: { censusFor: () => s.census }, inviteFor: () => INVITE, networkId: NET,
    fetcher: async (url) => { const i = s.nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:'))); return new Response(JSON.stringify({ federations: list(i) }), { status: 200 }); } });
  assert.deepEqual(await ask(closed, (i) => closed.seats[i].list()).closedAtGuardians(toHex(FED)), { closed: 6, of: 7 }, 'this seat itself holds no record yet: 6 of 7');
  const open = seven();
  for (const seat of open.seats) await seat.gather(FED, inviteFederationId);
  assert.deepEqual(await ask(open, (i) => (i < 4 ? closed.seats[i].list() : open.seats[i].list())).closedAtGuardians(toHex(FED)), { closed: 3, of: 7 },
    'seats 1-3 closed (seat 0 is this one, holding none): below the threshold of 5');
});

test('after a restart every stored height still answers: restore keeps the newest alone, recordAt reads the rest (kanban #993)', async () => {
  const { nodes, census } = seven();
  const signedAt = (height, reserveSats) => {
    const b = buildFederationRecord({ federationId: FED, networkId: NET, invite: INVITE, nominal: 7, guardians: guardiansOf(census, FED), height, reserveSats });
    const id = federationRecordId(b);
    return toHex(joinSignedRecord(encodeFederationRecord(b), nodes.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) }))));
  };
  const rows = [{ height: 100, record: signedAt(100, 1n) }, { height: 200, record: signedAt(200, 2n) }];
  const store = { load: () => [{ federation: toHex(FED), record: rows[1].record }], save: () => {}, saveAt: () => {}, loadAt: () => rows };
  const seat = federationRecords({ round: { pubkey: nodes[0].pubkey, identity: { secret: nodes[0].secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, store });
  assert.equal((await seat.restore(inviteFederationId)).restored, 1);
  assert.equal(seat.recordAt(toHex(FED), 150).height, 100, 'the height below the newest');
  assert.equal(seat.recordAt(toHex(FED), 250).height, 200);
  assert.equal(seat.recordAt(toHex(FED), 50), null);
  assert.equal(seat.recordAt(toHex(FED), 150).__hex, rows[0].record, 'as signed: what another seat is handed');
});

// THE BAND IN THE BYTES (kanban #997): after the height, only when a record names one
const bare = () => { const b = (n) => new Uint8Array(32).fill(n); return { federationId: b(1), networkId: b(2), invite: 'fed:x', nominal: 4, threshold: 3, status: 1, successorId: new Uint8Array(32), gone: [], exposureCapSats: 100000n, reserveSats: 75000n, height: 180,
  guardians: [1, 2, 3, 4].map((n) => ({ peerKey: new Uint8Array(33).fill(n), nodePubkey: b(n), operatorId: `op${n}`, bondTxid: b(0x40 + n), bondVout: 0, endpoint: `wss://g${n}` })) }; };

test('a record naming no band hashes as the code before it did, a hash from that code; one naming a band is one byte longer and signed over it', () => {
  const plain = bare();
  assert.equal(toHex(federationRecordId(plain)), 'e8bc7bbba80b07e913e2a42d48e113fa759dc394610a336601a567a051fa878f');
  const back = decodeFederationRecord(encodeFederationRecord(plain));
  assert.equal('capacityBand' in back, false, 'decoded as today');
  assert.deepEqual(encodeFederationRecord(back), encodeFederationRecord(plain));
  for (const capacityBand of Object.keys(CAPACITY_BAND)) {
    const r = { ...plain, capacityBand }, bytes = encodeFederationRecord(r);
    assert.equal(bytes.length, encodeFederationRecord(plain).length + 1);
    assert.equal(decodeFederationRecord(bytes).capacityBand, capacityBand);
    assert.notEqual(toHex(federationRecordId(r)), toHex(federationRecordId(plain)));
  }
});

test('a signed record splits with or without a band; an unknown band and a second trailing byte are refused', () => {
  const secret = new Uint8Array(32).fill(9), nodePubkey = schnorr.getPublicKey(secret);
  for (const r of [bare(), { ...bare(), capacityBand: 'CRITICAL' }]) {
    const body = encodeFederationRecord(r), sigs = [{ nodePubkey, signature: new Uint8Array(64).fill(3) }];
    for (const list of [[], sigs]) { const s = splitSignedRecord(joinSignedRecord(body, list)); assert.equal(s.record.capacityBand, r.capacityBand); assert.equal(s.signatures.length, list.length); assert.deepEqual(s.body, body); }
  }
  const body = encodeFederationRecord(bare());
  assert.throws(() => decodeFederationRecord(Uint8Array.from([...body, 9])), /not a capacity band/);
  assert.throws(() => decodeFederationRecord(Uint8Array.from([...body, 2, 2])), /trailing bytes/);
  assert.throws(() => encodeFederationRecord({ ...bare(), capacityBand: 'NOT_OPEN' }), /capacity band NOT_OPEN/);
});

test('a guardian\'s bond stays locked while it serves (kanban #1093 part 7): one maturing within drain_blocks takes one place out of the cap, all seven sign it, it stays seated', async () => {
  const maturities = [160000, 160000, 160000, 156100, 160000, 160000, 160000];   // the line is 156036 + 100
  const s = seven({ maturities, bondLock: { from: 0, drainBlocks: 100, bondMinGuardian: 50000n } });
  const got = await s.seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([got.ok, got.status, got.signers], [true, 'OPEN', 7], got.why);
  const v = verifyFederationRecord(fromHex(s.seats[0].list()[0].record), { census: s.census.entries, verify, inviteFederationId });
  assert.equal(v.ok, true, v.why);
  assert.deepEqual([v.record.exposureCapSats, v.record.gone.length], [2n * 50000n, 0], 'max(0, f + 1 - 1) x 50 000, nobody gone');
  const before = seven({ maturities, bondLock: { from: 200000, drainBlocks: 100, bondMinGuardian: 50000n } });
  await before.seats[0].gather(FED, inviteFederationId);
  assert.equal(verifyFederationRecord(fromHex(before.seats[0].list()[0].record), { census: before.census.entries, verify, inviteFederationId }).record.exposureCapSats, 3n * 50000n, 'below the lock height: as before');
});

// KANBAN #1157: A GUARDIAN IS SIGNED GONE ONLY ON A PROOF THE SIGNING SEAT CHECKS. Before, a body naming a guardian gone with no attestation,
// notice or emergency request was signed DEPARTED by every guardian seat asked (`if (!about.length) gone.push(...)`), so anyone could gather
// 5 of 7 honest signatures over a record naming 1 honest guardian gone (DRAINING: succession, the reserve moved) or 3 (HALTED: liquidation).
async function askedGone(s, goneIdx, { left = [] } = {}) {
  const fid = toHex(FED), goneHex = goneIdx.map((i) => toHex(s.nodes[i].guardianKey));
  const said = await Promise.all(s.seats.map((seat) => seat.mySignatureWithGone(fid, goneHex, null, null, [], [], [], { left })));
  const signed = said.filter((x) => x.ok);
  if (!signed.length) return { signed: 0, why: said.map((x) => x.why), status: null };
  const body = signed[0].body;
  const sigs = signed.filter((x) => x.body === body).map((x) => ({ nodePubkey: fromHex(x.nodePubkey), signature: fromHex(x.signature) }));
  const v = verifyFederationRecord(joinSignedRecord(fromHex(body), sigs), { census: s.census.entries, verify, inviteFederationId });
  return { signed: sigs.length, status: v.ok ? v.status : null, why: v.ok ? null : v.why, said };
}

test('#1157 a guardian named gone with no proof is not signed gone: no DRAINING, no HALTED record from the gatherer\'s word alone', async () => {
  const s = seven();
  const one = await askedGone(s, [3]);
  const three = await askedGone(s, [1, 3, 5]);
  console.log(`#1157 measure: 1 honest guardian named gone, no proof -> ${one.signed} of 7 sign, record ${one.status || 'none'}; 3 named gone -> ${three.signed} of 7 sign, record ${three.status || 'none'}`);
  assert.deepEqual([one.signed, one.status], [0, null], 'nobody signs DRAINING on no proof');
  assert.deepEqual([three.signed, three.status], [0, null], 'nobody signs HALTED on no proof');
  assert.match(String(one.why[0]), /named gone with no proof/);
});

test('#1157 a leaving guardian\'s own signed statement, handed along, is the proof: the gather still signs DRAINING; a forged or replayed one is refused', async () => {
  // the gather (as in the first test of this file) hands the statements along: one leaving -> DRAINING, signed by all seven
  const s = seven({ leaving: [3] });
  const got = await s.seats[0].gather(FED, inviteFederationId);
  assert.deepEqual([got.ok, got.status, got.signers, got.gone], [true, 'DRAINING', 7, 1], got.why);
  // the statement seat 3 signs over the plain body, read off its own GET /federation-record answer
  const own = await s.seats[3].mySignature(toHex(FED));
  const real = `${toHex(s.nodes[3].guardianKey)}${own.leaveSig}`;
  const withIt = await askedGone(s, [3], { left: [real] });
  assert.deepEqual([withIt.signed, withIt.status], [7, 'DRAINING'], 'the statement stands at every seat');
  // a statement by another node's key, or over "staying", proves nothing
  const forged = `${toHex(s.nodes[3].guardianKey)}${toHex(schnorr.sign(new Uint8Array(33), s.nodes[0].secret))}`;
  const bad = await askedGone(s, [3], { left: [forged] });
  assert.deepEqual([bad.signed, bad.status], [0, null]);
  // seat 3 no longer leaving: its old statement over the same body is refused BY ITSELF, the six others still check the signature
  const stayed = seven({ leaving: [] });
  const plain = await stayed.seats[3].mySignature(toHex(FED));
  const plainId = federationRecordId(decodeFederationRecord(fromHex(plain.body)));
  const replay = `${toHex(stayed.nodes[3].guardianKey)}${toHex(schnorr.sign(Uint8Array.from([...plainId, 1]), stayed.nodes[3].secret))}`;
  const self = await stayed.seats[3].mySignatureWithGone(toHex(FED), [toHex(stayed.nodes[3].guardianKey)], null, null, [], [], [], { left: [replay] });
  assert.deepEqual([self.ok, self.why], [false, 'this node is not leaving: it does not sign itself gone']);
  assert.equal((await stayed.seats[0].mySignatureWithGone(toHex(FED), [toHex(stayed.nodes[3].guardianKey)], null, null, [], [], [], { left: [replay] })).ok, true, 'its signature over this body stands at the others');
});

test('#1157 a mirror never takes a worse status at the height this seat holds, from one node or from all', async () => {
  const open = seven(), drain = seven({ leaving: [3] });
  for (const seat of [...open.seats, ...drain.seats]) assert.equal((await seat.gather(FED, inviteFederationId)).ok, true);
  assert.deepEqual([open.seats[0].list()[0].status, drain.seats[0].list()[0].status], ['OPEN', 'DRAINING']);
  let lists = open.seats.map((x) => x.list());
  const me = { secret: new Uint8Array(32).fill(0x58) }; me.pubkey = schnorr.getPublicKey(me.secret);
  const o = federationRecords({
    round: { pubkey: me.pubkey, identity: { secret: me.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => open.census }, inviteFor: () => null, networkId: NET,
    fetcher: async (url) => {
      const i = open.nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')));
      if (!url.endsWith('/federations') || i < 0) return new Response('no', { status: 404 });
      return new Response(JSON.stringify({ federations: lists[i] }), { status: 200 });
    },
  });
  assert.equal((await o.gatherAll(inviteFederationId))[0].status, 'OPEN');
  // one node serves a (validly signed) DRAINING body at the same height
  lists = open.seats.map((x, i) => (i === 3 ? drain.seats[3].list() : x.list()));
  await o.gatherAll(inviteFederationId);
  const mixed = o.list()[0].status;
  lists = drain.seats.map((x) => x.list());
  await o.gatherAll(inviteFederationId);
  const allWorse = o.list()[0].status;
  console.log(`#1157 measure: kept OPEN at one height, then a mirror serving DRAINING at that height -> kept ${mixed} (one node), ${allWorse} (every node)`);
  assert.equal(mixed, 'OPEN', 'one node serving a worse body sets nothing');
  assert.equal(allWorse, 'OPEN', 'a mirror does not worsen the status at the height held');
});

test('#1157 recordStep: older refused, CLOSED final, a mirror never worse at one height, a gather may', async () => {
  const { recordStep } = await import('../src/federation-records.js');
  assert.equal(recordStep(null, { height: 5, status: 'HALTED' }, 'mirror').take, true);
  assert.equal(recordStep({ height: 6, status: 'OPEN' }, { height: 5, status: 'OPEN' }).take, false);
  assert.equal(recordStep({ height: 5, status: 'CLOSED' }, { height: 5, status: 'OPEN' }).take, false);
  assert.equal(recordStep({ height: 5, status: 'OPEN' }, { height: 5, status: 'CLOSED' }, 'mirror').take, true);
  assert.equal(recordStep({ height: 5, status: 'OPEN' }, { height: 5, status: 'HALTED' }, 'mirror').take, false);
  assert.equal(recordStep({ height: 5, status: 'HALTED' }, { height: 5, status: 'OPEN' }, 'mirror').take, true);
  assert.equal(recordStep({ height: 5, status: 'OPEN' }, { height: 5, status: 'DRAINING' }, 'gather').take, true);
  assert.equal(recordStep({ height: 5, status: 'OPEN' }, { height: 6, status: 'HALTED' }, 'mirror').take, true);
});

// ---- KANBAN #1318 (RULED #1288, line #1343): A BOND'S MATURITY IS A STANDING NOTICE. A guardian absent, or whose bond is spent, from its bond's
// maturity on departed on schedule: DEPARTED, no offence. Before this both read as ABANDONED, and a bond spent by path A at its maturity was an
// offence in the same transaction as the spend. While the guardian bond lock is on (#1104's line, BOND_LOCK_HEIGHT); one block early, nothing changes.
const LOCK_1318 = { from: 0, drainBlocks: 144, bondMinGuardian: 1n };
test('#1318 a guardian absent from his bond\'s maturity on departed on schedule: DEPARTED in the record all seven sign; absent from a block before it, ABANDONED', async () => {
  const { createAbsences } = await import('../src/absences.js');
  const { signAbsence } = await import('../../arena-protocol/src/absence.js');
  const run = async (maturity6) => {
    const held = createAbsences({ verify });
    const s = seven({ absencesOf: (i) => (i === 0 ? held : createAbsences({ verify })), abandonBlocks: 288, departureNotice: 432, bondLock: LOCK_1318,
      maturities: [900000, 900000, 900000, 900000, 900000, 900000, maturity6] });
    for (const n of s.nodes.slice(0, 5)) assert.equal(held.offer(signAbsence({ federationId: FED, peerKey: s.nodes[6].guardianKey, lastSeenHeight: 1000, height: 1300, attester: n.pubkey }, (m) => schnorr.sign(m, n.secret))).kept, true);
    const got = await s.seats[0].gather(FED, inviteFederationId);
    const v = verifyFederationRecord(fromHex(s.seats[0].list()[0].record), { census: s.census.entries, verify, inviteFederationId });
    return { got, gone: v.record ? v.record.gone : [] };
  };
  const onTime = await run(1000), early = await run(1001);
  const kinds = { 1: 'DEPARTED', 2: 'ABANDONED' };
  console.log('  FACTS #1318 absence:', JSON.stringify({ maturity1000: { signers: onTime.got.signers, gone: onTime.gone.map((g) => [kinds[g.kind], g.sinceHeight]) },
    maturity1001: { signers: early.got.signers, gone: early.gone.map((g) => [kinds[g.kind], g.sinceHeight]) } }));
  assert.deepEqual([onTime.got.ok, onTime.got.signers, onTime.gone.length, onTime.gone[0].kind, onTime.gone[0].sinceHeight], [true, 7, 1, GONE.DEPARTED, 1000], onTime.got.why);
  assert.deepEqual([early.got.ok, early.got.signers, early.gone[0].kind], [true, 7, GONE.ABANDONED], 'a block before the maturity it is still abandonment');
});

test('#1318 a guardian whose bond is spent at its maturity left on schedule: no ABANDONED row; spent a block before it, ABANDONED as before', async () => {
  const run = async (maturity) => {
    const t = spentAway({ maturities: [900000, 900000, 900000, maturity, 900000, 900000, 900000], bondLock: LOCK_1318 });
    await t.everyone(); t.next(H0 + 6, t.spent);
    const got = await t.everyone();
    return { got, r: t.read() };
  };
  const onTime = await run(H0 + 3), early = await run(H0 + 4);
  console.log('  FACTS #1318 spend:', JSON.stringify({ spentAtMaturity: { ok: onTime.got.ok, gone: onTime.r.gone.map((g) => g.kind), nominal: onTime.r.nominal }, spentBeforeMaturity: { ok: early.got.ok, gone: early.r.gone.map((g) => g.kind), nominal: early.r.nominal } }));
  assert.equal(onTime.got.ok, true, onTime.got.why);
  assert.ok(!onTime.r.gone.some((g) => g.kind === GONE.ABANDONED), 'a path-A spend at the bond\'s maturity was filed as abandonment');
  assert.equal(early.got.ok, true, early.got.why);
  assert.deepEqual(early.r.gone.map((g) => [g.kind, g.sinceHeight]), [[GONE.ABANDONED, H0 + 3]], 'spent before maturity: abandonment, as before');
});

// GATEWAY_FEE_MAX (§23A.9, kanban #1310 / #1324): after the band, 8 bytes, only when a record names one
test('kanban #1324: a record names its gateway fee cap after its band; a gateway above it, or publishing no fee, is not taken', async () => {
  const { gatewayFeeWithin, GATEWAY_FEE_MAX_REFERENCE } = await import('../../arena-protocol/src/federation-record.js');
  const withBand = { ...bare(), capacityBand: 'CALM' };
  const r = { ...withBand, gatewayFeeMax: { ppm: 1000, baseMsat: 10000 } }, bytes = encodeFederationRecord(r);
  assert.equal(bytes.length, encodeFederationRecord(withBand).length + 8);
  assert.deepEqual(decodeFederationRecord(bytes).gatewayFeeMax, { ppm: 1000, baseMsat: 10000 });
  assert.equal('gatewayFeeMax' in decodeFederationRecord(encodeFederationRecord(withBand)), false, 'a record without one decodes as before');
  assert.equal(toHex(federationRecordId(bare())), 'e8bc7bbba80b07e913e2a42d48e113fa759dc394610a336601a567a051fa878f', 'and a plain one keeps its id');
  assert.throws(() => encodeFederationRecord({ ...bare(), gatewayFeeMax: { ppm: 1, baseMsat: 1 } }), /follows the capacity band/);
  const secret = new Uint8Array(32).fill(9), nodePubkey = schnorr.getPublicKey(secret);
  assert.deepEqual(splitSignedRecord(joinSignedRecord(bytes, [{ nodePubkey, signature: new Uint8Array(64).fill(3) }])).record.gatewayFeeMax, { ppm: 1000, baseMsat: 10000 });
  assert.deepEqual(GATEWAY_FEE_MAX_REFERENCE, { ppm: 1000, baseMsat: 10000 }, '0.1 % + 10 sat');
  const leg = (ppm, baseMsat) => ({ ppm, baseMsat });
  assert.equal(gatewayFeeWithin({ send: leg(1000, 10000), receive: leg(500, 0) }).ok, true, 'at the cap');
  assert.match(gatewayFeeWithin({ send: leg(1001, 0), receive: leg(0, 0) }).why, /send fee 0.1001 % \+ 0 sat is above the federation's cap of 0.1 % \+ 10 sat/);
  assert.match(gatewayFeeWithin({ send: leg(0, 0), receive: leg(0, 10001) }).why, /receive fee/);
  assert.match(gatewayFeeWithin({ send: leg(0, 0) }).why, /publishes no receive fee/);
  assert.equal(gatewayFeeWithin({ send: leg(2000, 0), receive: leg(0, 0) }, { ppm: 5000, baseMsat: 0 }).ok, true, 'a record\'s own cap');
});

// PLAYER_RESERVE (§23A.3a RULED 2026-11-07, kanban #1296 / #1322): after the gateway fee cap, 8 bytes; load and the band read it
test('kanban #1322: a federation holding only its two gateways\' mandatory peg-ins and no player reads load 0; it opens only if 2 x peg_in_min <= cap / 4', async () => {
  const { loadReserveOf, playerReserveOf, opensWith } = await import('../../arena-protocol/src/federation-record.js');
  const { bandOfRecord } = await import('../../arena-protocol/src/capacity.js');
  const pegInMin = 100000n, cap = 1000000n;
  const reserve = 2n * pegInMin;                                    // the two gateways' mandatory peg-ins, nothing else
  const player = playerReserveOf({ reserveSats: reserve, gatewayHeldSats: [pegInMin, pegInMin] });
  const withCap = { ...bare(), capacityBand: 'CALM', gatewayFeeMax: { ppm: 1000, baseMsat: 10000 }, exposureCapSats: cap, reserveSats: reserve };
  const r = { ...withCap, playerReserveSats: player }, bytes = encodeFederationRecord(r), back = decodeFederationRecord(bytes);
  const loadOf = (x) => Number((loadReserveOf(x) * 10000n) / BigInt(x.exposureCapSats)) / 10000;
  const got = { player: String(player), loadNow: loadOf(back), loadBefore: loadOf(withCap), bytes: bytes.length - encodeFederationRecord(withCap).length,
    bandBare: bandOfRecord({ reserveSats: reserve, exposureCapSats: cap, playerReserveSats: player }),
    opensAtCap1M: opensWith({ exposureCapSats: cap, pegInMinSats: pegInMin }).ok, opensAtCap700k: opensWith({ exposureCapSats: 700000n, pegInMinSats: pegInMin }).ok };
  console.log('  MEASURED #1322:', JSON.stringify(got));
  assert.equal(player, 0n);
  assert.equal(got.loadNow, 0); assert.equal(got.loadBefore, 0.2);
  assert.equal(got.bytes, 8);
  assert.equal(back.playerReserveSats, 0n);
  assert.equal('playerReserveSats' in decodeFederationRecord(encodeFederationRecord(withCap)), false, 'a record without one decodes as before');
  assert.throws(() => encodeFederationRecord({ ...bare(), capacityBand: 'CALM', playerReserveSats: 0n }), /follows the gateway fee cap/);
  assert.throws(() => encodeFederationRecord({ ...withCap, playerReserveSats: reserve + 1n }), /0 to the reserve/);
  assert.equal(got.opensAtCap1M, true);    // 200,000 <= 250,000
  assert.equal(got.opensAtCap700k, false); // 200,000 > 175,000
  assert.equal(toHex(federationRecordId(bare())), 'e8bc7bbba80b07e913e2a42d48e113fa759dc394610a336601a567a051fa878f', 'a plain record keeps its id');
});
