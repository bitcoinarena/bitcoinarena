// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 bypass of #1472: a seed in another BIP39 wordlist (Italian, Spanish, Japanese - real BIP39 phrases other wallets make) stays in a report
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
const IT = ['andrea', 'anello', 'angelo', 'angolare', 'angusto', 'anima', 'annegare', 'annidato', 'anno', 'annuncio', 'anonimo', 'anticipo'];
const ES = ['caballo', 'cabeza', 'cabina', 'cabra', 'cacao', 'cadáver', 'cadena', 'caer', 'café', 'caída', 'caimán', 'caja'];
const JA = ['あいこくしん', 'あいさつ', 'あいだ', 'あおぞら', 'あかちゃん', 'あきる', 'あけがた', 'あける', 'あこがれる', 'あさい', 'あさひ', 'あしあと'];
test('wf1489-7 an Italian, Spanish or Japanese BIP39 seed is removed', () => {
  for (const [name, words, sep] of [['italian', IT, ' '], ['spanish', ES, ' '], ['japanese', JA, '　']]) {
    const { kept, post } = shown(`my seed: ${words.join(sep)} - restore failed`, name.length);
    const mark = words.slice(3, 6).join(sep);
    assert.ok(!kept.includes(mark), `the kept report shows the ${name} seed: ${kept.slice(0, 100)}`);
    assert.ok(!post.includes(mark), `the chat post shows the ${name} seed`);
  }
});
