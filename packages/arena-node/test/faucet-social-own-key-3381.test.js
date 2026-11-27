// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3381: can a caller attach a typed X handle to a key it does not hold? The faucet's /feedback/social (and /link, /verify) takes the key
// only from a NIP-98 sign-in that FEEDBACK.mine checks (feedback-store authOf: the event's id and BIP-340 signature, this exact URL and method,
// signed within a minute), and socialCheck links only that key - nothing in the body names a key. Held here: no sign-in, a sign-in naming key A
// but signed by key B, A's sign-in for another door, and a body naming another key all leave the other key's links untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { openFeedbackStore, HTTP_AUTH_KIND } from '../src/feedback-store.js';
import { openBountySeason } from '../src/bounty-season.js';
import { socialCheck } from '../src/bounty-social.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const URL_ = 'https://bitcoinarena.io/api/faucet/feedback/social';
const signIn = (as, by, url = URL_) => { const e = { pubkey: as.pubkey, created_at: Math.floor(Date.now() / 1000), kind: HTTP_AUTH_KIND, tags: [['u', url], ['method', 'POST'], ['payload', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']], content: '' };   // kanban #3881: a POST sign-in names its body's SHA-256 (payload) and each sign-in is taken once (an empty body's)
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), by.secret)); return e; };

test('#3381 the social link check links only the key that signed the sign-in', async () => {
  const F = openFeedbackStore(':memory:'), S2 = openBountySeason(':memory:');
  const victim = key(7), attacker = key(8);
  const who = (ev) => F.mine(ev, { url: URL_, method: 'POST' });
  assert.equal(who(null).ok, false, 'no sign-in');
  assert.equal(who(signIn(victim, attacker)).ok, false, "the victim's key, the attacker's signature");
  assert.equal(who(signIn(victim, victim, 'https://bitcoinarena.io/api/faucet/feedback/verify')).ok, false, 'signed for another door');
  { const e = signIn(attacker, attacker); e.pubkey = victim.pubkey; assert.equal(who(e).ok, false, 'the key swapped after signing'); }
  const ok = who(signIn(attacker, attacker));
  assert.equal(ok.ok, true); assert.equal(ok.pubkey, attacker.pubkey);
  // what the route does next: socialCheck for the signed-in key only; a body naming another key is not read
  const resolvers = { x: async (name) => ({ userId: '1507727616706584576', username: name, member: true }) };
  const r = await socialCheck(S2, ok.pubkey, { x: 'fexx_off', pubkey: victim.pubkey }, resolvers);
  assert.equal(r.results.x.member, true);
  assert.equal(S2.links(attacker.pubkey)[0].username, 'fexx_off');
  assert.deepEqual(S2.links(victim.pubkey), [], "the victim's key holds no link");
});
