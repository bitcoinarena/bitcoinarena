// A GUARDIAN'S OWN ABSENCE ATTESTATIONS (spec §23A.4, kanban #322), the producing slice: four guardians, peer 3 stops contributing
// at height 100; guardians 0, 1 and 2 each sign once at once and once a day, and three of them (2f + 1) prove it ABANDONED once the
// absence spans abandon_blocks. A restart keeps last_seen_height where it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { abandonmentProof } from '../../arena-protocol/src/absence.js';
import { createAbsenceProducer, guardianConfigOf } from '../src/absence-producer.js';
import { readAbsenceHex, absenceHex } from '../src/absences.js';

const key = (s) => { const secret = taggedHash('TEST/absence', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const nodes = [0, 1, 2, 3].map((i) => key(`node${i}`));
const peer = (i) => Uint8Array.from([2, ...taggedHash('TEST/peer', Uint8Array.of(i))]);
const fidBytes = taggedHash('TEST/fed', Uint8Array.of(1));
const fid = toHex(fidBytes);
const record = { federationId: fidBytes, threshold: 3, guardians: [0, 1, 2, 3].map((i) => ({ peerKey: peer(i), nodePubkey: nodes[i].pub })) };

function world() {
  const w = { tip: 100, session: 50, gone: new Set() };
  w.status = () => async () => ({ federation: { session_count: w.session, status_by_peer: Object.fromEntries([0, 1, 2, 3].map((i) =>
    [String(i), { connection_status: w.gone.has(i) ? 'Disconnected' : 'Connected', last_contribution: w.gone.has(i) ? w.goneAt : w.session }])) } });
  return w;
}
const producer = (w, i, extra = {}) => createAbsenceProducer({ federationId: fid, ownPeerId: i, peerKeyOf: peer, status: w.status(),
  height: async () => w.tip, attester: nodes[i].pub, sign: (h) => schnorr.sign(h, nodes[i].secret), every: 144, ...extra });

test('a peer seen in consensus is never attested', async () => {
  const w = world();
  const r = await producer(w, 0).pass();
  assert.equal(r.ok, true);
  assert.deepEqual(r.seen, [1, 2, 3]);
  assert.equal(r.signed.length, 0);
});

test('three guardians sign a gone peer once a day, and their attestations prove it ABANDONED', async () => {
  const w = world();
  const ps = [0, 1, 2].map((i) => producer(w, i));
  for (const p of ps) await p.pass();                    // all seen at 100
  w.gone.add(3); w.goneAt = 50; w.session = 52; w.tip = 110;
  const first = await Promise.all(ps.map((p) => p.pass()));
  for (const r of first) { assert.equal(r.signed.length, 1); assert.equal(r.signed[0].lastSeenHeight, 100); assert.equal(r.signed[0].height, 110); }
  w.tip = 200;                                           // under a day since: nothing new
  assert.equal((await ps[0].pass()).signed.length, 0);
  w.tip = 254;                                           // a day (144) after the first
  const day = await Promise.all(ps.map((p) => p.pass()));
  const atts = day.map((r) => r.signed[0]);
  for (const a of atts) assert.equal(a.lastSeenHeight, 100);
  // through the seat door as it travels (encoding + signature in hex)
  const carried = atts.map((a) => readAbsenceHex(absenceHex(a)));
  assert.equal(abandonmentProof(carried, { record, peerKey: peer(3), abandonBlocks: 200, verify }).ok, false);
  const p = abandonmentProof(carried, { record, peerKey: peer(3), abandonBlocks: 144, verify });
  assert.equal(p.ok, true, p.why);
  assert.equal(p.signers, 3);
  assert.equal(p.sinceHeight, 100);
});

test('a peer back in consensus ends its absence; a restart keeps last_seen_height', async () => {
  const w = world();
  let stored = null;
  const save = (v) => { stored = JSON.parse(JSON.stringify(v)); };
  const p = producer(w, 0, { save });
  await p.pass();
  w.gone.add(3); w.goneAt = 50; w.session = 52; w.tip = 120;
  assert.equal((await p.pass()).signed.length, 1);
  const again = producer(w, 0, { load: () => stored, save });   // the node restarts
  w.tip = 300;
  const r = await again.pass();
  assert.equal(r.signed.length, 1);
  assert.equal(r.signed[0].lastSeenHeight, 100);
  w.gone.delete(3); w.tip = 310;
  const back = await again.pass();
  assert.deepEqual(back.seen, [1, 2, 3]);
  assert.equal(back.signed.length, 0);
});

test('a guardian with no consensus to read signs nothing', async () => {
  const p = createAbsenceProducer({ federationId: fid, ownPeerId: 0, peerKeyOf: peer, status: async () => ({ server: 'awaiting_password' }),
    height: async () => 1, attester: nodes[0].pub, sign: () => new Uint8Array(64) });
  assert.equal((await p.pass()).ok, false);
});

test('the guardian config maps peer ids to the federation\'s broadcast keys', () => {
  const files = { '/g/local.json': JSON.stringify({ identity: 2 }), '/g/client.json': JSON.stringify({ global: { broadcast_public_keys: { 0: toHex(peer(0)), 3: toHex(peer(3)) } } }) };
  const c = guardianConfigOf('/g', (f) => files[f]);
  assert.equal(c.ownPeerId, 2);
  assert.equal(toHex(c.peerKeyOf(3)), toHex(peer(3)));
  assert.equal(c.peerKeyOf(5), null);
});

test('a leaving guardian\'s own departure notice stands and makes it DEPARTED from leave_after', async () => {
  const { departureStands } = await import('../../arena-protocol/src/absence.js');
  const { createAbsences, readDepartureHex, departureHex } = await import('../src/absences.js');
  const { ownDeparture } = await import('../src/absence-producer.js');
  const d = ownDeparture({ own: { federation: fid, peerKey: peer(2) }, tip: 156520, departureNotice: 1008, nodePubkey: nodes[2].pub, sign: (h) => schnorr.sign(h, nodes[2].secret) });
  assert.equal(d.leaveAfterHeight, 156520 + 1008);
  const carried = readDepartureHex(departureHex(d));
  assert.equal(departureStands(carried, { record, departureNotice: 1008, verify }).ok, true);
  const seat = createAbsences({ verify });
  assert.equal(seat.offerDeparture(carried).ok, true);
  assert.equal(seat.departureFor(record, peer(2), 1008, 157527).ok, false, 'not before leave_after');
  assert.equal(seat.departureFor(record, peer(2), 1008, 157528).ok, true);
  // another guardian's node key cannot leave for it
  const forged = ownDeparture({ own: { federation: fid, peerKey: peer(2) }, tip: 156520, departureNotice: 1008, nodePubkey: nodes[1].pub, sign: (h) => schnorr.sign(h, nodes[1].secret) });
  assert.match(departureStands(forged, { record, departureNotice: 1008, verify }).why, /another node key/);
});
