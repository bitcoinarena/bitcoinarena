// kanban #2999: the card's test (audit nostr r2-2), held at the faucet's verifier: a read cut short keeps the members read before and calls
// the rest unknown (member: null), never 'not a member'
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr r2-2: THE ARMADA GUESTBOOK IS READ ONLY AS FAR AS ITS NEWEST 10,000 WRAPS. bounty-armada.js wsQuery pages the kind 1059 filter
// newest first, at most maxPages (20) x pageLimit (500) per relay, and armadaMembers folds only what those pages held. Every member of the
// community holds its root, so every member can sign wraps as the guestbook stream key: one member (a stranger who took the public invite)
// publishes 10,000 wraps newer than everybody else's (their content need not even open). From then on the faucet's armadaVerifier reads none
// of the older honest joins, answers member: false for every earlier member, and the Season 2 payout/draw re-check (faucet.mjs S2.verify
// before 'payable' and 'draw-entries') takes their community bonus away.
// Safe: a member who joined stays a member however many newer wraps another member publishes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { armadaMembers, armadaVerifier, wsQuery, pubkeyOf, conversationKey, nip44Encrypt, signEvent, eventId, guestbookStream, communityIdOf } from '../src/bounty-armada.js';

const hex = (b) => Buffer.from(b).toString('hex');
const rnd = () => hex(schnorr.utils.randomSecretKey());
const b64u = (h) => Buffer.from(h, 'hex').toString('base64url');
const T0 = 1762000000;
function rumor(pk, kind, content, tags, at) { const r = { kind, content, tags: [...tags, ['ms', '0']], created_at: at, pubkey: pk }; r.id = eventId(r); return r; }
function wrap(stream, memberSk, r) {
  const seal = signEvent({ kind: 20013, content: nip44Encrypt(JSON.stringify(r), stream.convKey), tags: [], created_at: r.created_at }, memberSk);
  return signEvent({ kind: 1059, content: nip44Encrypt(JSON.stringify(seal), stream.convKey), tags: [['p', pubkeyOf(rnd())]], created_at: r.created_at + 7 }, stream.sk);
}

// a relay as NIP-01 answers a REQ: matching events newest first, `until`, `limit`, then EOSE
function fakeRelayWs(events) {
  return class FakeWs {
    constructor() { this.readyState = 1; setImmediate(() => this.onopen && this.onopen()); }
    send(text) {
      const m = JSON.parse(text); if (m[0] !== 'REQ') return;
      const [, sub, f] = m;
      const hit = events.filter((e) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (f.until === undefined || e.created_at <= f.until))
        .sort((a, b) => b.created_at - a.created_at).slice(0, f.limit || 500);
      setImmediate(() => { for (const e of hit) this.onmessage && this.onmessage({ data: JSON.stringify(['EVENT', sub, e]) }); this.onmessage && this.onmessage({ data: JSON.stringify(['EOSE', sub]) }); });
    }
    close() { this.readyState = 3; }
  };
}

test('audit nostr r2-2: one member\'s flood of newer guestbook wraps does not unseat the earlier members', { timeout: 120000 }, async () => {
  const ownerSk = rnd(), owner = pubkeyOf(ownerSk), salt = rnd(), root = rnd(), id = communityIdOf(owner, salt);
  const frag = { frags: 1, entries: [{ community_id: b64u(id), current: { owner: b64u(owner), owner_salt: b64u(salt), community_root: b64u(root), root_epoch: 0, relays: [], name: 'Bitcoin Arena' }, added_at: T0 }] };
  const list = signEvent({ kind: 33302, content: nip44Encrypt(JSON.stringify(frag), conversationKey(ownerSk, owner)), tags: [['d', '0']], created_at: T0 }, ownerSk);
  const gb = guestbookStream(root, id, 0n);
  const alice = rnd(), mallory = rnd();
  const events = [list, wrap(gb, ownerSk, rumor(owner, 3306, 'join', [], T0)), wrap(gb, alice, rumor(pubkeyOf(alice), 3306, 'join', [], T0 + 10)),
    wrap(gb, mallory, rumor(pubkeyOf(mallory), 3306, 'join', [], T0 + 20))];
  // before the flood: alice is a member
  const q = () => wsQuery({ WebSocketImpl: fakeRelayWs(events), timeoutMs: 20000 });
  const before = await armadaMembers({ secretKeyHex: ownerSk, relays: ['wss://relay.one'], query: q() });
  assert.ok(before.has(pubkeyOf(alice)), 'alice joined');
  // mallory, a member, signs 10,000 wraps as the stream key (garbage inside: they only have to be the stream's events), each newer than the joins
  for (let i = 0; i < 10000; i++) events.push(signEvent({ kind: 1059, content: 'x', tags: [], created_at: T0 + 1000 + i }, gb.sk));
  const after = await armadaMembers({ secretKeyHex: ownerSk, relays: ['wss://relay.one'], query: q(), detail: true });
  console.log(`  FACTS: after the flood the reader saw ${after.wraps} wraps (${after.undecryptable} undecryptable) and ${after.members.size} members, truncated ${after.truncated}`);
  assert.equal(after.truncated, true, 'the read says it was cut short');
  // the faucet's verifier: read once before the flood (as it does on each check), then again after it
  const pre = events.slice(0, 4);
  let flooded = false;
  const verifier = armadaVerifier({ secretKeyHex: ownerSk, relays: ['wss://relay.one'], cacheMs: 0,
    members: (o) => armadaMembers({ ...o, query: wsQuery({ WebSocketImpl: fakeRelayWs(flooded ? events : pre), timeoutMs: 20000 }) }) });
  assert.equal((await verifier({ userId: pubkeyOf(alice) })).member, true, 'alice before the flood');
  flooded = true;
  const a = await verifier({ userId: pubkeyOf(alice) }), stranger = await verifier({ userId: pubkeyOf(rnd()) });
  console.log(`  FACTS: after the flood the verifier says alice ${JSON.stringify(a)}, an unknown key ${JSON.stringify(stranger)}`);
  assert.equal(a.member, true, `alice, who joined, is no longer read as a member: ${a.why}`);
  assert.equal(stranger.member, null, 'a key the cut-short read did not find is unknown, not "not a member"');
});

