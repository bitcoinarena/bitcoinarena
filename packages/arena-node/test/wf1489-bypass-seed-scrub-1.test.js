// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 bypass of #1472: common seed spellings the new scrubber still keeps (JSON array, wallet grid copy "1\nword", "1 word", "word. word")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, scrubKeys, FEEDBACK_KIND } from '../src/feedback-store.js';
import { feedbackDecide } from '../src/faucet.js';
import { eventId } from '../src/nostr-relay.js';
const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, content, tags = [['t', 'bug']]) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags, content }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const W = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const STEPS = ' Steps: opened the lobby, joined a round, watched the screen and waited.';
test('wf1489-1 a seed copied as a JSON array, from a numbered grid, numbered without a dot or period-separated is removed', () => {
  const forms = { json: JSON.stringify(W), grid: W.map((w, i) => `${i + 1}\n${w}`).join('\n'), numSpace: W.map((w, i) => `${i + 1} ${w}`).join(' '), dots: W.join('. ') };
  for (const [name, v] of Object.entries(forms)) {
    assert.ok(!scrubKeys(`my seed: ${v} lost`).includes('abstract absurd') && !/absorb\W+abstract\W+absurd/.test(scrubKeys(`my seed: ${v} lost`)), `scrubKeys kept the ${name} seed: ${scrubKeys(v).slice(0, 80)}`);
    const d = feedbackDecide({ text: `my seed: ${v} lost` }, []);
    assert.ok(!/absorb\W+abstract\W+absurd/.test(d.text), `the chat post kept the ${name} seed`);
  }
});
