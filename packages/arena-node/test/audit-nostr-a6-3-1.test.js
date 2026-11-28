// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr a6-3-1: ONE RELAY OF THE FOLLOW-CHECK LIST IGNORES THE FILTER'S LIMIT AND THE FAUCET KEEPS AND VERIFIES EVERYTHING IT SENDS.
// bounty-armada.js wsQuery one() pushes every ['EVENT', sub, e] frame a relay sends into `got` until EOSE or the timeout - no count bound,
// no byte bound - and the caller (bounty-nostr.js nostrVerifier, the Season 2 Nostr follow check on POST /feedback/social and the payout
// re-check) runs eventId + a BIP-340 verify on each of them on the faucet's one event loop. A relay of the list (ours, nos.lol, primal, damus)
// asked for { kinds: [3], authors: [who], limit: 3 } answers with tens of thousands of kind 3 events under `who` (right ids, junk signatures):
// the faucet holds them all and then spends seconds of CPU verifying them, stalling every other faucet route meanwhile.
// Safe: a relay's answer to a REQ with `limit: n` is read for at most n events (the rest dropped unread), so the check stays cheap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { wsQuery, pubkeyOf, eventId } from '../src/nostr-read.js';   // kanban #3922: was bounty-armada.js
import { nostrVerifier } from '../src/bounty-nostr.js';

const rnd = () => Buffer.from(schnorr.utils.randomSecretKey()).toString('hex');
const FLOOD = 20000;

function floodWs(author) {
  return class FakeWs {
    constructor(url) { this.url = url; this.readyState = 1; setImmediate(() => this.onopen && this.onopen()); }
    send(text) {
      const m = JSON.parse(text); if (m[0] !== 'REQ') return;
      const [, sub] = m;
      setImmediate(() => {
        for (let i = 0; i < FLOOD; i++) {
          const e = { pubkey: author, created_at: 1763000000 + i, kind: 3, tags: [], content: '' };
          e.id = eventId(e); e.sig = 'ab'.repeat(64);
          this.onmessage && this.onmessage({ data: JSON.stringify(['EVENT', sub, e]) });
        }
        this.onmessage && this.onmessage({ data: JSON.stringify(['EOSE', sub]) });
      });
    }
    close() { this.readyState = 3; }
  };
}

test('audit nostr a6-3-1: a relay ignoring limit:3 cannot make the follow check keep and verify thousands of events', async () => {
  const pk = pubkeyOf(rnd());
  const WebSocketImpl = floodWs(pk);
  const q = wsQuery({ WebSocketImpl, timeoutMs: 6000, maxPages: 1 });
  const got = await q(['wss://evil.relay'], [{ kinds: [3], authors: [pk], limit: 3 }]);
  const check = nostrVerifier({ relays: ['wss://evil.relay'], query: q });
  const t0 = Date.now();
  const r = await check({ userId: pk });
  const ms = Date.now() - t0;
  console.log(`  FACTS: one relay answered limit:3 with ${FLOOD} events; wsQuery kept ${got.length}; the follow check took ${ms} ms on the loop (${JSON.stringify(r)})`);
  assert.ok(got.length <= 3, `one relay's answer to a limit:3 REQ was kept whole: ${got.length} events held by the faucet`);
  assert.ok(ms < 1000, `the follow check spent ${ms} ms verifying one relay's flood`);
});
