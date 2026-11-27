// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 bypass of #1472: a seed's secret in hex other than exactly 64 digits - the BIP39 seed (128 hex, what wallets show as "BIP39 Seed") and a 12-word seed's 128-bit entropy (32 hex) - stays in a report
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
test('wf1489-5 a 128-hex BIP39 seed and a 32-hex entropy are removed from the kept report and the chat post', () => {
  const seed512 = '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4';
  const entropy = '00000000000000000000000000000000'.replace(/0/g, (_, i) => '7f3a9c'[i % 6]);
  for (const [name, secret] of [['bip39 seed', seed512], ['entropy', entropy]]) {
    const { kept, post } = shown(`my wallet ${name}: ${secret} - the withdraw failed`, name.length);
    assert.ok(!kept.includes(secret.slice(0, 32)), `the kept report shows the ${name}: ${kept.slice(0, 90)}`);
    assert.ok(!post.includes(secret.slice(0, 32)), `the chat post shows the ${name}`);
  }
});
