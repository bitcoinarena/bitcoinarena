// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 bypass of #1472: a seed with one word mistyped - one non-BIP39 word breaks the run, and the eleven right words plus the typo stay (2048 guesses, the checksum, and the wallet is found)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { feedbackDecide } from '../src/faucet.js';
import { eventId } from '../src/nostr-relay.js';
const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, content, tags = [['t', 'bug']]) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags, content }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const STEPS = ' Steps: opened the lobby, joined a round, watched the screen and waited.';
// the admin's view of the kept report (store.report, the row's happened) and the chat post (faucet.js feedbackDecide)
function shown(text, n) {
  const store = openFeedbackStore(':memory:');
  const e = signed(key(n), JSON.stringify({ happened: text + STEPS, expected: 'my funds stay mine' }));
  const r = store.take(e);
  assert.equal(r.ok, true, JSON.stringify(r));
  const kept = store.report(e.id).happened;
  const post = feedbackDecide({ text: text + STEPS }, []);
  return { kept, post: String(post.text || '') };
}
const W = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
test('wf1489-6 a 12-word seed with one typo, and a 24-word seed with two, are removed', () => {
  const one = [...W]; one[5] = 'absnet';
  const W24 = [...W, ...'account accuse achieve acid acoustic acquire across act action actor actress actual'.split(' ')];
  const two = [...W24]; two[8] = 'absrud'; two[16] = 'acros';
  for (const [name, words] of [['12 with a typo', one], ['24 with two typos', two]]) {
    const { kept, post } = shown(`my seed: ${words.join(' ')} - restore failed`, name.length);
    assert.ok(!/absorb abstract/.test(kept), `the kept report shows the seed (${name}): ${kept.slice(0, 100)}`);
    assert.ok(!/absorb abstract/.test(post), `the chat post shows the seed (${name})`);
  }
});
