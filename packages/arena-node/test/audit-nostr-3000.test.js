// kanban #3000: the card's test (audit nostr r2-3)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr r2-3: ONE RELAY OF THE LIST VETOES A FOLLOW (OR AN ARMADA MEMBER) BY ECHOING ITS EVENT ID. bounty-armada.js wsQuery merges the
// relays' answers in `seen.set(e.id, e)` - keyed by the id the relay claims, before anything is verified, the last answer winning. The
// follow check (bounty-nostr.js nostrVerifier) verifies only afterwards, so one relay of the four (nos.lol, primal, damus or ours) that answers
// last with a copy of the player's genuine kind 3 under the same id but a broken signature (or other content) replaces the genuine copy the
// other relays sent; signedContactList then drops it and the player is "not a follower" - the Season 2 Nostr bonus (+20 %) is lost at the
// payout re-check. armadaMembers reads its wraps through the same map (a wrap's own signature is never checked), so the same relay drops any
// member's join, or the owner's community list.
// Safe: what one relay says cannot replace a genuine event another relay delivered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { wsQuery, signEvent, pubkeyOf } from '../src/bounty-armada.js';
import { nostrVerifier, ARENA_NOSTR_PUBKEY } from '../src/bounty-nostr.js';

const rnd = () => Buffer.from(schnorr.utils.randomSecretKey()).toString('hex');

// each relay url answers its own events, the "evil" one 50 ms later than the honest ones
function relaysWs(byUrl, delayOf) {
  return class FakeWs {
    constructor(url) { this.url = url; this.readyState = 1; setImmediate(() => this.onopen && this.onopen()); }
    send(text) {
      const m = JSON.parse(text); if (m[0] !== 'REQ') return;
      const [, sub, f] = m;
      const hit = (byUrl[this.url] || []).filter((e) => f.kinds.includes(e.kind) && (!f.authors || f.authors.includes(e.pubkey)));
      setTimeout(() => { for (const e of hit) this.onmessage && this.onmessage({ data: JSON.stringify(['EVENT', sub, e]) }); this.onmessage && this.onmessage({ data: JSON.stringify(['EOSE', sub]) }); }, delayOf(this.url));
    }
    close() { this.readyState = 3; }
  };
}

test('audit nostr r2-3: a relay echoing a follower\'s kind 3 id with a bad signature does not erase the genuine copy', async () => {
  const sk = rnd(), pk = pubkeyOf(sk);
  const list = signEvent({ kind: 3, content: '', tags: [['p', ARENA_NOSTR_PUBKEY]], created_at: 1763000000 }, sk);
  const forged = { ...list, sig: '00'.repeat(64) };   // same id, not the author's signature
  const byUrl = { 'wss://good.one': [list], 'wss://good.two': [list], 'wss://good.three': [list], 'wss://evil.relay': [forged] };
  const WebSocketImpl = relaysWs(byUrl, (u) => (u === 'wss://evil.relay' ? 50 : 1));
  const check = nostrVerifier({ relays: Object.keys(byUrl), query: wsQuery({ WebSocketImpl, timeoutMs: 2000, maxPages: 1 }) });
  // without the evil relay the key follows
  const fair = await nostrVerifier({ relays: ['wss://good.one'], query: wsQuery({ WebSocketImpl, timeoutMs: 2000, maxPages: 1 }) })({ userId: pk });
  assert.equal(fair.member, true);
  const r = await check({ userId: pk });
  console.log(`  FACTS: with three relays holding the genuine list and one echoing its id with a bad signature: ${JSON.stringify(r)}`);
  assert.equal(r.member, true, `one relay of four erased the genuine contact list three relays sent: ${JSON.stringify(r)}`);
});

