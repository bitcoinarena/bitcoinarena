// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION NO ENTRY CAN PAY INTO IS NOT OFFERED (the owner 2026-10-30, a table of federation A at UI 423: "Order not placed: this round pays the
// protocol reserves, and none of the round's 14 signer nodes names a reserve key"). GET /reserves as seat 1 answered it that minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keylessFederations, fetchKeylessFederations } from '../src/reserves-page.js';
import { unplayableWindowLine } from '../src/lobby.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32), key = `02${'cd'.repeat(32)}`;
const seat = { federations: [{ federationId: A, key: null, why: 'no reserve key for 0 guardian seats' }, { federationId: B, key }] };

test('a federation the seats list with no key is keyless, one with a key is not', () => {
  assert.deepEqual([...keylessFederations([seat, seat, seat])], [A]);
});

test('one seat naming a key is enough to keep it offered: the entry itself checks the key', () => {
  const late = { federations: [{ federationId: A, key }] };
  assert.deepEqual([...keylessFederations([seat, seat, seat, late])], []);
});

test('too few answers, or none, hold nothing back', () => {
  assert.equal(keylessFederations([seat, seat]).size, 0);
  assert.equal(keylessFederations([null, undefined, {}, seat]).size, 0);
  assert.equal(keylessFederations([]).size, 0);
});

test('the fetch asks each node once, survives one that fails, and never throws', async () => {
  const asked = [];
  const fetcher = async (u) => { asked.push(u); if (u.includes('bad')) throw new Error('down'); return new Response(JSON.stringify(seat)); };
  const k = await fetchKeylessFederations({ nodes: ['wss://a', 'https://b/', 'https://c', 'https://a', 'https://bad'], fetcher });
  assert.deepEqual([...k], [A]);
  assert.deepEqual(asked.sort(), ['https://a/reserves', 'https://b/reserves', 'https://bad/reserves', 'https://c/reserves']);
  assert.equal((await fetchKeylessFederations({ nodes: ['https://bad'], fetcher })).size, 0);
});

test('the line says why such a window is not playable', () => {
  const l = unplayableWindowLine({ unoffered: [{ id: 'x', entryCloseMs: 2000, startTimeMs: 1000, why: 'no reserve key' }], offered: [], nowMs: 0 });
  assert.match(l.text, /its federation has no reserve key yet/);
});

test('the lobby holds such tables back before the wallet\'s own federation is chosen', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(src, /if \(!keyless\.has\(f\) && holdsSatIn\(f\) >= stakeSatOf\(r\)\)/, 'a keyless federation is never the wallet\'s federation');
  assert.match(src, /if \(keyless\.has\(f\)\) \{[^\n]*why: 'no reserve key' \}\); return false; \}\n\s*const mineFeds/, 'and comes before the wallet rule');
});

test('the page can call it: the bundle exports it by name', () => {
  const src = readFileSync(new URL('../tools/bundle.js', import.meta.url), 'utf8');
  assert.match(src, /fetchKeylessFederations: fetchKeylessFederations/);
});

test('a seat that is no member names the key as reserveKey: that federation is playable (measured 12:50Z: UI 424 held back federation B too)', () => {
  const test-host = { federations: [{ federationId: A, key: null, reserveKey: null, why: 'no reserve key for 0 guardian seats' }, { federationId: B, key: null, reserveKey: key }] };
  assert.deepEqual([...keylessFederations([test-host, test-host, test-host])], [A]);
});

test('draw reads the keyless set from the page, not from a helper of paint: out of its scope no table is offered at all (measured 12:53Z, UI 424)', () => {
  const src = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const draw = src.slice(src.indexOf('const draw = (got, got2) =>'), src.indexOf('window.ARENA_LOBBY_ROWS = [...mine, ...theirs]'));
  assert.ok(draw.length > 1000);
  assert.doesNotMatch(draw, /reservesRead/);
  assert.match(draw, /window\.ARENA_RESERVES_READ && window\.ARENA_RESERVES_READ\.keyless/);
});
