// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLIENT FILES NEXT BLOCK'S MANIFESTS PIN ARE THE APP'S OWN LIST (kanban #569: packages/nextblock/plugin/clients.json, what its signing
// tools and tests read in its own repository); the page's known-good list carries every one of them for nextblock, or a page would refuse
// what the app signed. THE ARENA MAY KNOW MORE (kanban #3544, owner's decision 2026-11-24): the app's list is a SUBSET of the Arena's -
// every list, file and hash the app names is on the Arena's; the Arena may hold more (clients an older or newer app build shipped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Where `app` is not contained in `arena`: arrays by membership (each of the app's entries is one of the Arena's), objects key by key. */
export function notContained(app, arena, at = 'nextblock') {
  if (Array.isArray(app)) {
    if (!Array.isArray(arena)) return [`${at}: the Arena has no list here`];
    return app.filter((x) => !arena.some((y) => JSON.stringify(y) === JSON.stringify(x))).map((x) => `${at}: ${JSON.stringify(x)} is not on the Arena's list`);
  }
  if (app && typeof app === 'object') {
    if (!arena || typeof arena !== 'object' || Array.isArray(arena)) return [`${at}: the Arena has no such entry`];
    return Object.keys(app).flatMap((k) => (k in arena ? notContained(app[k], arena[k], `${at}.${k}`) : [`${at}.${k}: missing on the Arena's list`]));
  }
  return app === arena ? [] : [`${at}: ${JSON.stringify(app)} here, ${JSON.stringify(arena)} on the Arena's list`];
}

test('the subset rule: more on the Arena\'s list passes, anything of the app\'s missing there is named', () => {
  const arena = { pinned: { 'a.js': ['h1', 'h2'], 'b.js': ['h3'] }, pinnedV5: { 'c.js': ['h4'] } };
  assert.deepEqual(notContained({ pinned: { 'a.js': ['h2'] } }, arena), []);
  assert.deepEqual(notContained({ pinned: { 'a.js': ['h1', 'h2'], 'b.js': ['h3'] }, pinnedV5: { 'c.js': ['h4'] } }, arena), []);
  assert.deepEqual(notContained({ pinned: { 'a.js': ['h9'] } }, arena), ['nextblock.pinned.a.js: "h9" is not on the Arena\'s list']);
  assert.deepEqual(notContained({ pinnedV7: { 'd.js': ['h5'] } }, arena), ['nextblock.pinnedV7: missing on the Arena\'s list']);
  assert.deepEqual(notContained({ pinned: { 'z.js': ['h1'] } }, arena), ['nextblock.pinned.z.js: missing on the Arena\'s list']);
});

test('every client file Next Block pins is on the Arena\'s known-good list (the Arena may know more)', () => {
  const arena = JSON.parse(readFileSync(new URL('../known-good-clients.json', import.meta.url), 'utf8')).games.nextblock;
  const { about, ...app } = JSON.parse(readFileSync(new URL('../../nextblock/plugin/clients.json', import.meta.url), 'utf8'));
  void about;
  assert.ok(Object.keys(app).length > 0, 'the app names its lists');
  assert.deepEqual(notContained(app, arena), []);
});
