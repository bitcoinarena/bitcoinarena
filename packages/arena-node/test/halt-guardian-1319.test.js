// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN'S OWN HALT VIEW, THE NODE'S PART (spec §23A.5, RULED 2026-11-07 kanban #1289; kanban #1319): the node that runs a
// guardian signs, from its guardian's admin status, the peers it is connected to once the session has not moved for abandon_blocks;
// a seat takes such a view only when the record it holds binds the signer's node key to that guardian, and keeps it across restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { createHalts, createGuardianHaltSigner } from '../src/halts.js';
import { encodeGuardianHaltObservation, decodeGuardianHaltObservation } from '../../arena-protocol/src/halt-proof.js';

const key = (s) => { const secret = taggedHash('TEST/hg1319', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const peer = (i) => Uint8Array.from([3, ...taggedHash('TEST/hg1319-peer', Uint8Array.of(i))]);
const federationId = taggedHash('TEST/hg1319-fed', Uint8Array.of(1));
const fid = toHex(federationId);
const gnodes = [0, 1, 2, 3].map((i) => key(`gnode${i}`));
const record = { federationId, guardians: [0, 1, 2, 3].map((i) => ({ peerKey: peer(i), nodePubkey: gnodes[i].pub, endpoint: `wss://g${i}` })),
  gone: [{ peerKey: peer(3) }] };
const records = { list: () => [{ federation: fid }], recordOf: (f) => (f === fid ? { record, status: 'CRITICAL', height: 1 } : null) };
const statusOf = (world, own) => async () => ({ federation: { session_count: world.session, status_by_peer: Object.fromEntries([0, 1, 2, 3]
  .filter((x) => x !== own).map((x) => [String(x), { connection_status: world.connected.has(x) ? 'connected' : 'disconnected', last_contribution: world.session - 1 }])) } });
const asJson = (o) => ({ observation: toHex(encodeGuardianHaltObservation(o)), signature: toHex(o.signature) });

test('the signer starts the clock where the session moves, signs nothing before abandon_blocks, then names the peers its guardian is connected to', async () => {
  const world = { tip: 100, session: 40, connected: new Set([1, 2]) };
  let kept = null;
  const signer = createGuardianHaltSigner({ federationId: fid, peerKeyOf: (id) => (id <= 3 ? peer(id) : null), ownPeerId: 0, abandonBlocks: 10,
    status: statusOf(world, 0), height: async () => world.tip, sign: (h) => schnorr.sign(h, gnodes[0].secret), load: () => kept, save: (v) => { kept = v; } });
  assert.equal((await signer.pass()).signed, undefined);
  world.session = 41; world.tip = 105;
  const a = await signer.pass();
  assert.deepEqual([a.session, a.firstHeight, a.signed], [41, 105, undefined], 'a new session restarts the clock at the tip');
  assert.deepEqual(kept, { session: 41, firstHeight: 105 });
  world.tip = 114; assert.equal((await signer.pass()).signed, undefined, '9 blocks: not yet');
  world.tip = 115; world.connected = new Set([2]);
  const b = await signer.pass();
  assert.ok(b.signed, 'abandon_blocks without a new session: signed');
  assert.deepEqual([b.signed.session, b.signed.firstHeight, b.signed.height], [41, 105, 115]);
  assert.deepEqual(b.signed.peersSeen.map(toHex), [toHex(peer(2))], 'only the peers its guardian is connected to in P2P');
  assert.equal(toHex(b.signed.guardian), toHex(peer(0)));
  // kept across a restart: a new signer from the saved clock signs at once, from the same first_height
  const again = createGuardianHaltSigner({ federationId: fid, peerKeyOf: (id) => peer(id), ownPeerId: 0, abandonBlocks: 10,
    status: statusOf(world, 0), height: async () => world.tip, sign: (h) => schnorr.sign(h, gnodes[0].secret), load: () => kept });
  assert.equal((await again.pass()).signed.firstHeight, 105);
  const none = createGuardianHaltSigner({ federationId: fid, peerKeyOf: () => peer(0), ownPeerId: 0, abandonBlocks: 10, status: async () => ({ federation: null }),
    height: async () => 1, sign: () => new Uint8Array(64) });
  assert.match((await none.pass()).why, /no consensus/);
});

test('a seat takes a guardian\'s view only under the node key its record binds, never a departed guardian\'s; kept across a restart', async () => {
  let stored = null;
  const mk = () => createHalts({ records, censusSeats: () => [], clocks: { abandonBlocks: 10 }, verify, sign: () => new Uint8Array(64), ownKey: new Uint8Array(32),
    height: async () => 200, ask: async () => 41, load: () => stored, save: (v) => { stored = v; } });
  const seat = mk();
  const sign = (i, by = gnodes[i]) => asJson({ ...decodeGuardianHaltObservation(encodeGuardianHaltObservation({ federationId, session: 41, firstHeight: 105,
    height: 115, peersSeen: [peer(1)], guardian: peer(i) })), signature: schnorr.sign(
    taggedHash('ARENA/v1/GuardianHaltObservation', encodeGuardianHaltObservation({ federationId, session: 41, firstHeight: 105, height: 115, peersSeen: [peer(1)], guardian: peer(i) })),
    by.secret) });
  assert.equal(seat.takeGuardian(sign(0)).status, 201);
  assert.equal(seat.takeGuardian(sign(0)).status, 200, 'the same view again: kept once');
  assert.match(seat.takeGuardian(sign(2, gnodes[1])).why, /not signed by the guardian's node key/);
  assert.match(seat.takeGuardian(sign(3)).why, /not seated/, 'a guardian the record lists as gone');
  assert.match(seat.takeGuardian({ observation: 'zz', signature: '' }).why, /not a guardian halt observation/);
  assert.equal(seat.listGuardian(fid).length, 1);
  const back = mk();
  assert.equal(back.listGuardian(fid).length, 1, 'the view held survives a restart');
});
