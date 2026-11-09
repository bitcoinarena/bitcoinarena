// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1387 (audit 2 #1204 CLIENT-15): a wallet client this tab opened for another phrase stayed cached after that phrase's lock went - another tab
// then used the phrase, and the next collect here got the old client back, its in-memory store blind to the other tab's notes. Now the page drops a
// phrase's clients in the finally that releases its lock (forgetPhraseWallets), and the next open reads the store afresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openPlayerWallet, forgetPhraseWallets } from '../src/page-lock.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };

test('#1387 a phrase\'s client is shared while cached; once forgotten, the next open is a fresh client on the store; the tab\'s own phrase is kept', async () => {
  let joins = 0;
  const LockClient = { join: async () => { joins += 1; return { n: joins, balanceMsat: async () => '0' }; } };
  const S = storage(), other = new Uint8Array(32).fill(0x31), own = new Uint8Array(32).fill(0x32);
  const open = (seed) => openPlayerWallet({ federationId: TEST_FEDERATION_ID, invite: 'fed11qgqzc2nhwden5te0vejkg6tdd9h8gepwvejkg6tdd9h8garhduhx6at5d9h8jmn9wshxxmmd9uqqzgxg6s3evnr6m9zdxr6hxkdkukexpcs3mn7mj3g5pc5dfh63l4tj6g9zk4er', seed, LockClient, storage: S });
  const a = await open(other), b = await open(other);
  assert.equal(a, b, 'cached: one client per wallet');
  const mine = await open(own);
  assert.equal(forgetPhraseWallets(Buffer.from(other).toString('hex')), 1);
  const c = await open(other);
  console.log(`  MEASURED #1387: joins ${joins}; before forget the same client (${a.n}), after it a fresh one (${c.n})`);
  assert.notEqual(c, a, 'the forgotten phrase\'s old client came back');
  assert.equal(await open(own), mine, 'the tab\'s own phrase was dropped too');
});

test('#1387 the page drops the phrase\'s clients in both places it releases another phrase\'s lock', () => {
  const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const wr = html.slice(html.indexOf('function withRecordPhrase('), html.indexOf('function withRecordPhrase(') + 2500);
  assert.match(wr, /finally \{[^}]*PHRASES_HELD_HERE\.delete[\s\S]{0,300}forgetPhraseWallets\(hex\)/);
  assert.match(html, /const hold = async \(\) => \{[^\n]*finally \{ PHRASES_TAKEN\.delete\(k\); try \{ if \(ARENACLIENT\.forgetPhraseWallets\) ARENACLIENT\.forgetPhraseWallets\(x\.hex\)/);
});
