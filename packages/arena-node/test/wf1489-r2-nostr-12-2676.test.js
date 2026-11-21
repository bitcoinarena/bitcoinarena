// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2676, #1489 round 2 (nostr / signed feedback, 2026-11-14), a way around #1472 (hexbox #005) and its refutes (#1737, #1799, #1843, #1858, #2003):
// a seed phrase is found only as ONE run of 12 BIP39 words, and every place a signed report lands looks at its fields one by one or with a
// non-BIP39 word between them:
//   - take() scrubs `happened` and `expected` each on its own: 6 words at the end of one and 6 at the start of the other are two runs of 6;
//   - keptEvent's whole-event check reads JSON.stringify([tags, content]): between the halves stands `","expected":"` - "expected" is a word
//     and no BIP39 word, so the run ends there too;
//   - the chat post (faucet.mjs -> feedbackDecide) is happened + "\nExpected: " + expected: "Expected" ends the run again.
// So a player who pastes the 24 words of a wallet split over the two boxes of the form has the whole phrase kept on disk in three columns
// and posted to the team chat. Safe: no kept column and no chat post holds the 12 seed words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { feedbackDecide } from '../src/faucet.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const secret = new Uint8Array(32).fill(9); const pubkey = hex(schnorr.getPublicKey(secret));
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const A = WORDS.slice(0, 6).join(' '), B = WORDS.slice(6).join(' ');

test('#1489-r2-nostr-12 a seed split over happened and expected is not kept or posted', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wf1489-r2n12-')), 'fb.sqlite');
  const s = openFeedbackStore(path);
  const happened = `My withdraw did not arrive after the round settled, I waited ten minutes. my words: ${A}`;
  const expected = `${B} and the money in my wallet`;
  const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug']], content: JSON.stringify({ happened, expected }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  const r = s.take(e);
  assert.equal(r.ok, true, JSON.stringify(r));
  s.close();
  const db = new DatabaseSync(path);
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(e.id);
  db.close();
  const all = Object.entries(row).filter(([, v]) => typeof v === 'string');
  const words = (v) => WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(v)).length;
  const inRow = WORDS.filter((w) => all.some(([, v]) => new RegExp(`\\b${w}\\b`).test(v))).length;
  const leaked = all.filter(([, v]) => words(v) >= 6).map(([k, v]) => `${k}(${words(v)})`);
  // the chat post, built as faucet.mjs builds it for a signed report
  const text = `${happened}${expected ? `\nExpected: ${expected}` : ''}`;
  const post = feedbackDecide({ text, ip: '203.0.113.9', signed: true }, []);
  const inPost = post.ok ? words(post.text) : 0;
  console.log(`  FACTS: ${inRow} of 12 seed words kept in the row (${leaked.join(', ')}); ${inPost} of 12 in the chat post`);
  assert.equal(inPost < 12, true, `the team chat post carries all ${inPost} seed words`);
  assert.equal(inRow < 12, true, `the kept report holds all 12 seed words: ${leaked.join(', ')}`);
});
