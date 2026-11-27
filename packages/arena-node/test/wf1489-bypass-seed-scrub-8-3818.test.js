// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 bypass of #1472: an English seed in full-width letters (a Japanese/Chinese IME in wide mode; NFKC reads it as abandon ability ...) or with the words run together (AbandonAbilityAble...) stays in a report
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
const wide = (s) => [...s].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).join('');
test('wf1489-8 a full-width or run-together seed is removed', () => {
  for (const [name, v] of [['full-width', W.map(wide).join(' ')], ['run together', W.map((w) => w[0].toUpperCase() + w.slice(1)).join('')]]) {
    const { kept, post } = shown(`my seed: ${v} - restore failed`, name.length);
    assert.ok(!kept.normalize('NFKC').toLowerCase().includes('absorbabstract') && !kept.normalize('NFKC').includes('absorb abstract'), `the kept report shows the ${name} seed: ${kept.slice(0, 100)}`);
    assert.ok(!post.normalize('NFKC').toLowerCase().includes('absorbabstract') && !post.normalize('NFKC').includes('absorb abstract'), `the chat post shows the ${name} seed`);
  }
});
