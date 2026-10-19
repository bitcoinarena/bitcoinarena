// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEED THE PLAYER ALREADY HOLDS GOES BACK INTO THE PAGE (§24, v4.6.2, F2).
//
// Measured before this: `tabSeed` read the tab's own sessionStorage or minted a
// fresh seed, and the page had no way to take one in. A backup could be written
// down and never used, and the fingerprint only ever checked a seed the page
// itself had just invented - which a lying page can do and agree with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tabSeed, importSeed, seedOrigin, playerFor } from '../src/join.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const store = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};
const BACKUP = '5e'.repeat(32);
const ROUND = { id: new Uint8Array(32).fill(0x11) };
let minted = 0;
const random = (n) => { minted++; return new Uint8Array(n).fill(0x40 + minted); };
const keyOf = (seed, round = ROUND) => playerFor(round, { seed, curve: feldmanGroup });
const TOOL = fileURLToPath(new URL('../../arena-node/tools/refund-key.mjs', import.meta.url));
const lineOf = (out, name) => (out.match(new RegExp(`^${name}\\s+(\\S+)$`, 'm')) || [])[1];

test('1. an imported seed is what the tab uses, and nothing is minted over it', () => {
  const tab = store();
  importSeed(BACKUP, { storage: tab });
  const before = minted;
  assert.equal(toHex(tabSeed({ storage: tab, random })), BACKUP);
  assert.equal(minted, before, 'a fresh seed was drawn although the player imported one');
  assert.equal(seedOrigin({ storage: tab }), 'imported');

  // over a tab that had already minted its own: the import wins from then on
  const t2 = store();
  const own = tabSeed({ storage: t2, random });
  assert.equal(seedOrigin({ storage: t2 }), 'minted');
  importSeed(`  ${BACKUP.toUpperCase()}\n`, { storage: t2 });
  assert.equal(toHex(tabSeed({ storage: t2, random })), BACKUP);
  assert.notEqual(toHex(own), BACKUP);

  for (const bad of ['', 'zz'.repeat(32), '5e'.repeat(31), null])
    assert.throws(() => importSeed(bad, { storage: store() }), /64 hex digits/);
});

test('2. seed in, fingerprint out: the page and refund-key.mjs agree on the imported seed', () => {
  const tab = store();
  importSeed(BACKUP, { storage: tab });
  const page = keyOf(tabSeed({ storage: tab, random }));
  const out = execFileSync(process.execPath, [TOOL, BACKUP, toHex(ROUND.id)], { encoding: 'utf8' });
  assert.equal(lineOf(out, 'player key'), toHex(page.pubkey));
  assert.equal(lineOf(out, 'fingerprint'), page.fingerprint);
});

test('3. close and reopen: the earlier round\'s key comes back from the backed-up seed', () => {
  const first = store();
  importSeed(BACKUP, { storage: first });
  const was = keyOf(tabSeed({ storage: first, random })).pubkey;

  // the tab is closed and its storage with it; a new session pastes the backup
  const before = minted;
  const back = store();
  importSeed(BACKUP, { storage: back });
  assert.equal(toHex(keyOf(tabSeed({ storage: back, random })).pubkey), toHex(was));
  assert.equal(minted, before, 'a seed was minted although the backup was pasted');
  assert.equal(seedOrigin({ storage: back }), 'imported');

  // and a seed the page minted and nobody backed up does NOT come back
  const lost = store();
  const mintedKey = keyOf(tabSeed({ storage: lost, random })).pubkey;
  assert.notEqual(toHex(keyOf(tabSeed({ storage: store(), random })).pubkey), toHex(mintedKey));
});

test('5. two tabs that never imported are two players, and an import in one leaves the other alone', () => {
  const a = store(), b = store();
  const seedA = tabSeed({ storage: a, random });
  const seedB = tabSeed({ storage: b, random });
  assert.notEqual(toHex(seedA), toHex(seedB), 'two anonymous tabs were made one player');
  importSeed(BACKUP, { storage: a });
  assert.equal(toHex(tabSeed({ storage: b, random })), toHex(seedB), 'an import in one tab moved another');
  assert.equal(seedOrigin({ storage: b }), 'minted');
});

test('the page takes a pasted seed and says which kind of seed its fingerprint is for', () => {
  const page = readFileSync(
    new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url).pathname, 'utf8');
  // THE RESTORE IS SETTINGS' (kanban #154): restoreSeed takes the 24 words or the 64 hex and replaces this tab's seed
  for (const call of ['restoreSeed', 'seedOrigin', 'tabSeed'])
    assert.ok(new RegExp('BLWPCLIENT\\.' + call + '\\s*\\(').test(page), 'the page never calls ' + call);
});
