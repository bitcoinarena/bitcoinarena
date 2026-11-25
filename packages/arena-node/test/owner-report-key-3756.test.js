// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3756: the owner page's Season 2 panel answered "that account is linked to another report key" with nothing saying which key the page reports
// with. It shows its key as an npub now, and a refused account gets a line saying what that means and the ways out. The page's own lines, run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bech32Encode } from '../src/bounty-armada.js';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const code = HTML.slice(HTML.indexOf('const B32 = '), HTML.indexOf('const S2_ROWS = ['));
const { npubOf, heldElsewhere } = new Function(`${code}\nreturn { npubOf, heldElsewhere };`)();
const NAMES = { x: 'X', telegram: 'Telegram', nostr: 'Nostr' };

test('#3756 npubOf is NIP-19: the spec\'s example and the faucet\'s own encoder agree', () => {
  assert.equal(npubOf('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'), 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6');
  for (let i = 0; i < 50; i++) {
    const b = Buffer.alloc(32); for (let j = 0; j < 32; j++) b[j] = (i * 37 + j * 101 + (i ^ j) * 7) & 255;
    if (i === 0) b.fill(0); if (i === 1) b.fill(255);
    assert.equal(npubOf(b.toString('hex')), bech32Encode('npub', b));
  }
});

test('#3756 npubOf gives nothing for what is no key', () => {
  for (const x of [undefined, null, '', 'ab', '3BF0C63FCB93463407AF97A5E5EE64FA883D107EF9E558472C4EB9AAAEFA459D', 'z'.repeat(64)]) assert.equal(npubOf(x), '');
});

test('#3756 a refused account gets a line naming it, the likely other key and the ways out', () => {
  const t = heldElsewhere({ x: { member: null, why: 'that account is linked to another report key' }, nostr: { member: true } }, NAMES);
  assert.match(t, /^X: that account is linked to another report key, not the one this page reports with/);
  assert.match(t, /key you play with on the game page/);
  assert.match(t, /link code from this page/);
  assert.match(t, /linked with a code, it stays with that key/);
  const two = heldElsewhere({ x: { why: 'that account is linked to another report key' }, telegram: { why: 'that account is linked to another report key' } }, NAMES);
  assert.match(two, /^X, Telegram: these accounts are linked/);
});

test('#3756 nothing to say when no account is held by another key', () => {
  assert.equal(heldElsewhere({ x: { member: false, why: 'not following' }, nostr: { member: true } }, NAMES), '');
  assert.equal(heldElsewhere(undefined, NAMES), '');
});

test('#3756 the panel shows the key line above the names and the explanation under the buttons', () => {
  const panel = HTML.slice(HTML.indexOf('function nodeSocialPanel('), HTML.indexOf('async function nodeBountyBlock('));
  assert.match(panel, /This page reports with your owner key: /);
  assert.match(panel, /wrap\.append\(head, rules, keyLine, rows, .*human, elsewhere, say, codeSay\)/);
  assert.match(panel, /const show = \(j\) => \{\n\s+showKey\(\);\n\s+if \(j && j\.results\) elsewhere\.textContent = heldElsewhere\(j\.results, names\);/);
  assert.match(panel, /npubOf\(me\.pubkey\)/);
});
