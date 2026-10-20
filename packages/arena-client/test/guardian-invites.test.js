// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE GUARDIAN DOWN NO LONGER KEEPS A WALLET OUT (the owner 2026-10-20 18:0xZ): 4dc88be7's invite named only fed2-8, whose guardian had stopped,
// and every join failed "Failed to download client config". A join that cannot read the config is tried once more with an invite naming
// every guardian this client has seen named for the federation (each seat's record invite, verified or not; every invite it joined with).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteForGuardians, readInvite } from '../../arena-node/src/invite.js';
import { noteInvite, wholeInvite, forgetGuardianInvites } from '../src/guardian-invites.js';
import { openPlayerWallet } from '../src/page-lock.js';

const FID = '4dc88be70830d3619fd8742eaf639ab297774850cc68a203aad5b10a21e1fe98';
const id = Uint8Array.from(FID.match(/../g).map((x) => parseInt(x, 16)));
const url = (n) => `wss://seat.example.com/fed2-${n}/guardian`;
const ONE = inviteForGuardians(id, [{ peer: 6, url: url(8) }]);
const ALL = inviteForGuardians(id, [0, 1, 2, 3, 4, 5].map((p) => ({ peer: p, url: url(p + 1) })).concat([{ peer: 6, url: url(8) }]));

test('the whole invite: every peer seen, each once, in peer order; nothing more to add - null', () => {
  forgetGuardianInvites();
  assert.equal(wholeInvite(ONE), null, 'only the one guardian known');
  noteInvite(ALL);
  const w = readInvite(wholeInvite(ONE));
  assert.equal(w.federationId, FID);
  assert.deepEqual(w.guardians.map((g) => g.peer), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(wholeInvite(ALL), null, 'an invite naming them all needs nothing');
});

test('a join whose invite\'s guardian is down is tried once more with every guardian, and opens', async () => {
  forgetGuardianInvites(); noteInvite(ALL);
  const tried = [];
  const LockClient = { join: async (inv) => { tried.push(readInvite(inv).guardians.length); if (readInvite(inv).guardians.length === 1) throw new Error('Failed to download client config'); return { balanceMsat: async () => '0' }; } };
  const steps = [];
  const c = await openPlayerWallet({ federationId: id, invite: ONE, seed: new Uint8Array(32).fill(7), LockClient, storage: null, onStep: (s) => steps.push(s) });
  assert.ok(c);
  assert.deepEqual(tried, [1, 7]);
  assert.ok(steps.some((s) => /did not answer - reading its configuration from the others/.test(s)));
});

test('any other failure is not retried', async () => {
  forgetGuardianInvites(); noteInvite(ALL);
  let n = 0;
  const LockClient = { join: async () => { n++; throw new Error('invalid invite'); } };
  await assert.rejects(openPlayerWallet({ federationId: id, invite: ONE, seed: new Uint8Array(32).fill(8), LockClient, storage: null }), /invalid invite/);
  assert.equal(n, 1);
});
