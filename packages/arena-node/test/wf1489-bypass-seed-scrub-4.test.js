// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 bypass of #1472: wallet secrets other than nsec/bare 64-hex (xprv, tprv, 0x-prefixed 64-hex, WIF) stay in a report
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
test('wf1489-4 an extended private key, a 0x private key and a WIF key are removed from a report', () => {
  const secrets = { xprv: 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
    hex0x: '0x' + '1f'.repeat(32), wif: 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn' };
  for (const [name, v] of Object.entries(secrets)) {
    assert.ok(!scrubKeys(`my key ${v} end`).includes(v.slice(-20)), `scrubKeys kept the ${name} secret`);
    assert.ok(!feedbackDecide({ text: `my key ${v} end` }, []).text.includes(v.slice(-20)), `the chat post kept the ${name} secret`);
  }
});
test('#2632 the honest words of a report stay: addresses, npub, a Lightning address, an xpub, a short hex and plain sentences', () => {
  const keep = ['Withdraw to tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx failed after the lock at block 91234.',
    'My npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m and pay@example.com, build 1.9.27.',
    'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8 is my watch-only key.',
    'The round 0xdeadbeef and color #ff0000 looked wrong; KindOfLongCamelCaseWordThatIsNotAKeyAtAll here.'];
  for (const t of keep) assert.equal(scrubKeys(t), t);
});
