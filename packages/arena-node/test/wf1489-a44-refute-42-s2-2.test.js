// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #2468 (#1489 audit44 refute of #1677): a content lnAddress of any shape other than a string never hands the payout to the lud16 tag;
// the honest page (content lnAddress and the same lud16 tag) and a tag alone still name their address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const secret = new Uint8Array(32).fill(7), pubkey = hex(schnorr.getPublicKey(secret));
let n = 0;
function report(s, lnAddress, lud16) {
  const words = { happened: `The lobby shows a round as open after its entry close, and a join then fails with a refusal (${n++}).`, expected: '' };
  if (lnAddress !== undefined) words.lnAddress = lnAddress;
  const tags = [['t', 'bug']]; if (lud16) tags.push(['lud16', lud16]);
  const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags, content: JSON.stringify(words) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  assert.ok(s.take(e).ok, 'kept');
  return s.addressOf(e.id);
}

test('#2468 a non-string or malformed content lnAddress answers null, never the lud16 tag', () => {
  const s = openFeedbackStore();
  for (const v of [['a@good.example.com'], { a: 'a@good.example.com' }, 42, true, 'not an address']) {
    const got = report(s, v, 'other@unchecked.example.net');
    console.log('  MEASURED:', JSON.stringify({ content: v, paidTo: got }));
    assert.equal(got, null, `content ${JSON.stringify(v)} is paid at ${got}`);
  }
});

test('#2468 the honest page and a tag alone still name their address', () => {
  const s = openFeedbackStore();
  assert.equal(report(s, 'me@wallet.example.com', 'me@wallet.example.com'), 'me@wallet.example.com');
  assert.equal(report(s, 'me@wallet.example.com', 'other@unchecked.example.net'), 'me@wallet.example.com');
  assert.equal(report(s, undefined, 'tag@wallet.example.com'), 'tag@wallet.example.com');
  assert.equal(report(s, '', 'tag@wallet.example.com'), 'tag@wallet.example.com');
  assert.equal(report(s, undefined, undefined), null);
});
