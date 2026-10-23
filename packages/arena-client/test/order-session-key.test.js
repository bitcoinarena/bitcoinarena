// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ORDER'S SESSION KEY FROM THE WALLET (kanban #592: "orders follow the wallet, not the tab"): the page's
// ARENA_ORDER_SESSION_KEY makes the same Ed25519 key from the same seed, round and order number in any tab or device - one per
// order - and its signature verifies under the key the entry names; cancel and sell make it again when the tab kept none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const at = PAGE.indexOf('window.ARENA_ORDER_SESSION_KEY = async function');
const body = PAGE.slice(at, PAGE.indexOf('\n    };\n', at) + 7);
const hex = (b) => Buffer.from(b).toString('hex');
const ARENACLIENT = { fromHex: (h) => Uint8Array.from(Buffer.from(h, 'hex')), toHex: hex };
const window = {};
new Function('window', 'ARENACLIENT', 'crypto', 'atob', body)(window, ARENACLIENT, globalThis.crypto, globalThis.atob);

test('one key per seed, round and order, the same in every tab; its signature verifies; cancel and sell make it again', async () => {
  const seed = new Uint8Array(32).fill(7), R = 'ab'.repeat(32);
  const a = await window.ARENA_ORDER_SESSION_KEY(seed, R, 0), again = await window.ARENA_ORDER_SESSION_KEY(seed, R, 0);
  const other = await window.ARENA_ORDER_SESSION_KEY(seed, R, 1), otherRound = await window.ARENA_ORDER_SESSION_KEY(seed, 'cd'.repeat(32), 0);
  const otherSeed = await window.ARENA_ORDER_SESSION_KEY(new Uint8Array(32).fill(8), R, 0);
  assert.equal(a.pub.length, 32);
  assert.equal(hex(a.pub), hex(again.pub), 'the same seed, round and order make the same key');
  for (const k of [other, otherRound, otherSeed]) assert.notEqual(hex(k.pub), hex(a.pub));
  assert.equal(hex(ed25519.getPublicKey(Buffer.from(a.pkcs8Hex, 'hex').subarray(16))), hex(a.pub), 'the public key is the secret\'s');
  const key = await crypto.subtle.importKey('pkcs8', Buffer.from(a.pkcs8Hex, 'hex'), { name: 'Ed25519' }, false, ['sign']);
  const msg = new TextEncoder().encode('cancelId');
  assert.equal(ed25519.verify(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, msg)), msg, a.pub), true);
  // the join takes it for an order; cancel and sell make it again from the tab's seed when the order kept none
  assert.match(PAGE, /const k = await window\.ARENA_ORDER_SESSION_KEY\(seed, named\.roundIdHex, Number\(chosen\.orderIndex\) \|\| 0\);/);
  assert.match(PAGE, /if \(x\.order\.sessionKeyPkcs8\) return x\.order\.sessionKeyPkcs8;[\s\S]{0,400}ARENA_ORDER_SESSION_KEY\(seed, x\.roundIdHex, Number\(x\.order\.index\) \|\| 0\)/);
  assert.doesNotMatch(PAGE, /can be cancelled only in the tab that placed it|can be sold only in the tab that bought them/);
});
