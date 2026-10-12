// THE FEDERATION RECORD (spec §23A.1 / §23A.4, kanban #321). The status bands exactly as §23A.1's table for 10, 7 and 4
// guardians; the record's bytes and id; and seven guardian seats (federation-records.js) signing one record over the
// census: all seated -> OPEN with 7 signatures; one guardian saying it leaves -> DRAINING; two -> CRITICAL; the seat then
// calls the federation draining. A record short of its threshold, signed by a non-guardian, or with a foreign invite is
// not believed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { statusFor, buildFederationRecord, encodeFederationRecord, decodeFederationRecord, federationRecordId, joinSignedRecord,
  splitSignedRecord, verifyFederationRecord, FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { federationRecords } from '../src/federation-records.js';
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
function seven({ leaving = [], successor = null, closed = false, reserves = null } = {}) {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ secret: new Uint8Array(32).fill(i + 1) }));
  for (const [i, n] of nodes.entries()) { n.pubkey = schnorr.getPublicKey(n.secret); n.guardianKey = Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]); n.endpoint = `wss://seat-${i}.example`; }
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  const seats = nodes.map((n, i) => federationRecords({
    round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: 156036, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => INVITE, networkId: NET, leavingAtMs: () => (leaving.includes(i) ? 1 : null),
    successorOf: () => successor, closedOf: () => closed,
    ...(reserves ? { reserveOf: async () => (reserves[i] === null ? { ok: false, why: 'no answer' } : { ok: true, reserveSats: BigInt(reserves[i]) }) } : {}),
    fetcher: async (url) => {
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      const u = new URL(url); const gone = (u.searchParams.get('gone') || '').split(',').filter(Boolean);
      const rv = u.searchParams.get('reserve');
      const body = await (gone.length ? j.mySignatureWithGone(u.searchParams.get('federation'), gone, null, rv) : j.mySignature(u.searchParams.get('federation'), null, rv));
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
    const none = await fetch(`${S}/federation-record?federation=${toHex(FED)}`);
    assert.equal(none.status, 404);
    assert.match((await none.json()).why, /holds no round/);
  } finally { await seat.close(); }
});

// SUCCESSION (§23A.6 steps 2, 4 and 5; kanban #325): the guardians sign the old federation's record DRAINING with the
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

// THE GATHERER NAMES ITS CENSUS HEIGHT (kanban #321, measured on testnet4 2026-10-12): each seat took the newest round IT held,
// a round posted ahead whose census it could not read yet - seats 2-7 answered "no chain view for that round" and no record
// ever had more than 1 of its 5 signatures. Now a seat's own basis is the newest round whose census it reads, and a peer
// signs at the height the gatherer names, from a round it holds at that height.
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
    round: { pubkey: n.pubkey, identity: { secret: n.secret }, db: { prepare: () => ({ all: (after) => rowsOf(i).filter((r) => r.rowid > after) }) } },
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

// THE RESERVE AND THE LOAD IN THE RECORD (§23A.3, kanban #324): the gatherer reads the federation's on-chain reserve and names
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
