// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §24B's warning, measured: what a wallet with no backup is TOLD, and that nothing is refused.
//
// Ruled 2026-09-21 20:01: PLAY is always allowed, free or paid, and so is putting money in. The earlier
// gate on deposit and paid join is overridden, so the refusals are gone from the module and the tests
// that asserted them are gone with it - a test holding down a withdrawn rule is a rule somebody wires
// back up. What is left is the warning: is this seed backed up, and did the player type its phrase back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPhrase, verifyAndRecord, isVerified, backupLine, NO_BACKUP_LINE, VERIFIED_KEY,
  digestOf } from '../src/backup-gate.js';

const PHRASE = 'ridge silent otter cabin maple frost harbor lantern meadow pebble willow anchor';
/** A browser's storage, as much of it as this needs. */
const tab = () => { const m = new Map(); return {
  getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }; };
/** The wallet's own 32 bytes. A new tab mints a new one - which is the whole point of the last test. */
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff);

test('after one full-phrase verify the warning goes, and the flag is bound to that seed', () => {
  const s = tab();
  const said = verifyAndRecord({ typed: PHRASE, phrase: PHRASE, storage: s, seed: SEED });
  assert.equal(said.ok, true, said.why);
  assert.equal(isVerified(s, SEED), true);
  assert.equal(s.map.get(VERIFIED_KEY), digestOf(SEED), 'the flag is not bound to the seed it verified');
  assert.equal(backupLine(s, SEED), '', 'the lobby still says there is no backup after one succeeded');
});

test('a wrong word blocks, names where, and never opens the gate', () => {
  const s = tab();
  const words = PHRASE.split(' ');
  const wrong = [...words]; wrong[8] = 'harbour';
  const said = verifyAndRecord({ typed: wrong.join(' '), phrase: PHRASE, storage: s, seed: SEED });
  assert.equal(said.ok, false);
  assert.equal(said.wrongAt, 8, 'it did not say which word was wrong');
  assert.equal(isVerified(s, SEED), false, 'a wrong word set the verified flag');
  assert.equal(backupLine(s, SEED), NO_BACKUP_LINE, 'a wrong word cleared the warning');
});

test('three of twelve is not a verification - §23A.8\'s short check is withdrawn', () => {
  const s = tab();
  const three = PHRASE.split(' ').slice(0, 3).join(' ');
  const said = verifyAndRecord({ typed: three, phrase: PHRASE, storage: s, seed: SEED });
  assert.equal(said.ok, false, 'three words were taken as a backup');
  assert.match(said.why, /3 words and the phrase is 12/);
  assert.equal(backupLine(s, SEED), NO_BACKUP_LINE);
});

test('order is part of it, and case and spacing are not', () => {
  const s = tab();
  const words = PHRASE.split(' ');
  const swapped = [...words]; [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  assert.equal(verifyPhrase(swapped.join(' '), PHRASE).ok, false, 'a reordered phrase passed');
  // What a player actually types: capitals, double spaces, a trailing newline.
  const messy = `  ${words.map((w, i) => (i % 2 ? w.toUpperCase() : w)).join('   ')}\n`;
  assert.equal(verifyPhrase(messy, PHRASE).ok, true, 'capitals or spacing were treated as a wrong word');
});

test('a phrase of a different length is refused rather than half-checked', () => {
  assert.equal(verifyPhrase(`${PHRASE} extra`, PHRASE).ok, false);
  assert.equal(verifyPhrase('', PHRASE).ok, false);
  assert.equal(verifyPhrase(PHRASE, '').ok, false, 'a missing phrase was treated as a match');
});

test('storage that throws is treated as unverified, not as verified', () => {
  const hostile = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(isVerified(hostile, SEED), false, 'a browser that refuses storage was treated as backed up');
  assert.equal(verifyAndRecord({ typed: PHRASE, phrase: PHRASE, storage: hostile, seed: SEED }).recorded, false);
});

test('a new tab is a new wallet, and an old verification does not vouch for it', () => {
  // MEASURED, and it is why the flag carries a digest: `tabSeed` mints fresh bytes when sessionStorage
  // has none, so opening a second tab is opening a wallet nobody has written down. localStorage, where
  // the flag lives, outlives every tab - a bare "verified" would have opened the gate for it.
  const s = tab();
  assert.equal(verifyAndRecord({ typed: PHRASE, phrase: PHRASE, storage: s, seed: SEED }).ok, true);

  assert.equal(isVerified(s, OTHER_SEED), false, 'an older verification vouched for a new wallet');
  assert.equal(backupLine(s, OTHER_SEED), NO_BACKUP_LINE, 'the new wallet was told it had a backup');
});

test('no seed at all is unverified, never verified', () => {
  const s = tab();
  assert.equal(digestOf(undefined), null);
  assert.equal(digestOf(new Uint8Array(8)), null, 'a short seed was digested anyway');
  assert.equal(isVerified(s, undefined), false);
  assert.equal(verifyAndRecord({ typed: PHRASE, phrase: PHRASE, storage: s, seed: undefined }).recorded, false);
});
