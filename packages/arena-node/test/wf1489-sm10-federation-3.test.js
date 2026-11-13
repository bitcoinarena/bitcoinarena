// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit round 10, federation 3: the founding's no-show rule (§23A.2, founding.js advance) is decided by each seat
// alone from the codes it happens to hold at its own advance - not from anything every seat reads the same. A drawn node whose code goes out
// at the block that ends its fifth reaches the seats that advance after it and misses the ones that advanced before: the first replace it
// by the alternate (and refuse its code from then on, mayPost), the others keep it. The seats then hold two different seatings of one
// founding, the seated guardians add different peers to their DKG, and no federation can come out of it - the founding voids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { createFounding } from '../src/founding.js';

const key = (s) => { const secret = taggedHash('TEST/founding', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };
const keys = Array.from({ length: 8 }, (_, i) => key(`n${i}`));
const entries = keys.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/tx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
  advert: { operatorId: `op${i}`, guardianCapable: true, guardianEndpoint: `wss://g${i}` } }));
const seed = taggedHash('TEST/beacon', Uint8Array.of(1));
const idx = (hex) => keys.findIndex((k) => toHex(k.pub) === hex);

test('wf1489-sm10-federation-3: a code that arrives at the block ending its fifth splits the seats into two seatings of one founding', async () => {
  const log = [];
  const seats = [];
  const fake = (i) => ({ localParams: async () => `code-${i}`, addPeer: async (code) => { log.push(['add', i, code]); }, startDkg: async () => { log.push(['dkg', i]); },
    invite: async () => 'fed11invite', done: async () => false });
  for (let i = 0; i < keys.length; i++) {
    seats.push(createFounding({ seed, triggerHeight: 100, entries, nominal: 4, bondMinGuardian: 500000n, foundingWindow: 10,
      ownKey: keys[i].pub, sign: (h) => schnorr.sign(h, keys[i].secret), verify, setup: fake(i), post: async (m) => { for (const s of seats) s.take(m); } }));
  }
  const probe = seats[0].state();
  // the seated node with the highest index that is not 0: some seats advance at a height before it does, some after
  const late = probe.seated.map((x) => idx(x.node)).filter((i) => i > 0).sort((a, b) => b - a)[0];
  assert.ok(late > 0);
  // its guardian is slow to come up: offline at 101 and 102, its code goes out during its own advance at 103 (beacon 101 + fifth 2)
  for (const tip of [101, 102, 103, 104]) for (let i = 0; i < seats.length; i++) if (!(i === late && tip < 103)) await seats[i].advance(tip);
  const views = seats.map((s, i) => ({ i, seated: s.state().seated.map((x) => idx(x.node)).join(','), noShows: s.state().noShows.map(idx) }));
  const distinct = [...new Set(views.map((v) => v.seated))];
  const dkgPeers = [...new Set(log.filter((l) => l[0] === 'add').map((l) => l[1]))].map((i) => `${i}:[${log.filter((l) => l[0] === 'add' && l[1] === i).map((l) => l[2]).join(' ')}]`);
  console.log(`sm10-federation-3 measure: late node ${late}; seatings held: ${distinct.map((d) => `[${d}] at seats ${views.filter((v) => v.seated === d).map((v) => v.i).join(',')}`).join(' | ')}; DKG peers added: ${dkgPeers.join(' ')}`);
  assert.equal(distinct.length, 1, 'every seat holds one seating of the founding');
});

test('wf1489-sm10-federation-3 (kanban #2317): the late code goes out before the alternate\'s seat advances - the seats that replaced it seat it again, one seating', async () => {
  const log = [];
  const seats = [];
  const fake = (i) => ({ localParams: async () => `code-${i}`, addPeer: async (code) => { log.push(['add', i, code]); }, startDkg: async () => { log.push(['dkg', i]); },
    invite: async () => 'fed11invite', done: async () => false });
  for (let i = 0; i < keys.length; i++) {
    seats.push(createFounding({ seed, triggerHeight: 100, entries, nominal: 4, bondMinGuardian: 500000n, foundingWindow: 10,
      ownKey: keys[i].pub, sign: (h) => schnorr.sign(h, keys[i].secret), verify, setup: fake(i), post: async (m) => { for (const s of seats) s.take(m); } }));
  }
  const probe = seats[0].state();
  const late = idx(probe.seated[probe.seated.length - 1].node), alt = idx(probe.alternates[0]);
  // at 103 every other seat advances first (and replaces the late node by the alternate), then the late node posts, then the alternate's seat
  const order = [...[...Array(keys.length).keys()].filter((i) => i !== late && i !== alt), late, alt];
  for (const tip of [101, 102, 103, 104]) for (const i of order) if (!(i === late && tip < 103)) await seats[i].advance(tip);
  const views = [...new Set(seats.map((s) => s.state().seated.map((x) => idx(x.node)).join(',')))];
  console.log(`sm10-federation-3 measure (alternate after): late ${late}, alternate ${alt}; seatings held: ${views.map((v) => `[${v}]`).join(' | ')}; DKGs started: ${log.filter((l) => l[0] === 'dkg').map((l) => l[1]).join(',')}`);
  assert.equal(views.length, 1, 'every seat holds one seating');
  assert.ok(views[0].split(',').map(Number).includes(late), 'the late node, its code out before any alternate\'s, keeps its seat');
  assert.ok(!log.some((l) => l[0] === 'dkg' && l[1] === alt), 'the alternate starts no DKG');
});
