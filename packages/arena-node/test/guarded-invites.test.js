// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT NAMES THE INVITE OF EVERY FEDERATION IT GUARDS (§23A.6 step 4). Measured 2026-10-19 ~22:15Z on testnet4: B's successor 4dc88be7,
// founded live on 10-15 and 7 of 7 in consensus, had no record on any seat ("none of its guardians holds a record") - a record is built
// and signed only by a seat that names the federation's invite, and the successor's guardians held its invite only in their guardian
// (node 15) and guardian-next (B1-B6) directories. The seat's invites now include those two directories' invite-code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('the invites a seat names include its guardian\'s and its guardian-next\'s invite-code', () => {
  const at = src.indexOf('const guardedInvites = () =>');
  assert.ok(at > 0, 'guardedInvites is defined');
  const body = src.slice(at, src.indexOf('\n  });', at));
  assert.match(body, /\[guardian, guardianNext\]/);
  assert.match(body, /joinPath\(g\.dataDir, 'invite-code'\)/);
  const inv = src.slice(src.indexOf('const inviteOfFed = (fidHex) => {'), src.indexOf('const inviteOfFed = (fidHex) => {') + 400);
  assert.match(inv, /federationInvite, \.\.\.\[\.\.\.networksHeld\.values\(\)\]\.map\(\(h\) => h\.pkg\.invite\), \.\.\.guardedInvites\(\)/,
    'the seat\'s own invite and its network packages first, then the guarded ones');
});

test('a missing or empty invite-code names nothing (a guardian before its ceremony)', async () => {
  const at = src.indexOf('const guardedInvites = () =>');
  const fn = new Function('guardian', 'guardianNext', 'readFileSync', 'joinPath', `${src.slice(at, src.indexOf('\n  });', at) + 6)}\nreturn guardedInvites;`);
  const files = { '/g/invite-code': 'fed11abc\n', '/n/invite-code': '' };
  const read = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
  const join = (a, b) => `${a}/${b}`;
  assert.deepEqual(fn({ dataDir: '/g' }, { dataDir: '/n' }, read, join)(), ['fed11abc', null]);
  assert.deepEqual(fn(null, { dataDir: '/missing' }, read, join)(), [null, null]);
});
