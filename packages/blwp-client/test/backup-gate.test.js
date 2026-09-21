// §24B's gate, measured: what a client with no verified seed may and may not do.
//
// The lobby line is the warning and this is what makes it true. Free rounds stay open - they stake
// nothing, so a player with no backup cannot lose anything by driving one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPhrase, verifyAndRecord, isVerified, mayDeposit, mayPayStake,
  mayStartFreeRound, mayJoin, backupLine, NO_BACKUP_LINE, VERIFIED_KEY,
  digestOf } from '../src/backup-gate.js';

const PHRASE = 'ridge silent otter cabin maple frost harbor lantern meadow pebble willow anchor';
/** A browser's storage, as much of it as this needs. */
const tab = () => { const m = new Map(); return {
  getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }; };
/** The wallet's own 32 bytes. A new tab mints a new one - which is the whole point of the last test. */
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff);

test('before any verification: no deposit, no paid stake, and the lobby says there is no backup', () => {
  const s = tab();
  assert.equal(isVerified(s, SEED), false);
  assert.equal(mayDeposit(s, SEED).ok, false, 'a client with no verified seed could deposit');
  assert.equal(mayPayStake(s, SEED).ok, false, 'a client with no verified seed could pay a stake');
  assert.match(mayDeposit(s, SEED).why, /Settings/, 'the refusal does not say how to get past it');
  assert.equal(backupLine(s, SEED), NO_BACKUP_LINE, 'the lobby line did not warn');
});

test('a free round still starts with no backup and no wallet', () => {
  const s = tab();
  assert.equal(mayStartFreeRound().ok, true);
  assert.equal(mayJoin({ paying: false, storage: s, seed: SEED }).ok, true, 'a free round was gated on a backup');
  assert.equal(mayJoin({ paying: true, storage: s, seed: SEED }).ok, false, 'a PAID round was not gated');
});

test('after one full-phrase verify: deposit and paid join both work, and the warning goes', () => {
  const s = tab();
  const said = verifyAndRecord({ typed: PHRASE, phrase: PHRASE, storage: s, seed: SEED });
  assert.equal(said.ok, true, said.why);
  assert.equal(isVerified(s, SEED), true);
  assert.equal(s.map.get(VERIFIED_KEY), digestOf(SEED), 'the flag is not bound to the seed it verified');
  assert.equal(mayDeposit(s, SEED).ok, true, 'deposit still refused after a good verify');
  assert.equal(mayPayStake(s, SEED).ok, true, 'a paid stake still refused after a good verify');
  assert.equal(mayJoin({ paying: true, storage: s, seed: SEED }).ok, true);
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
  assert.equal(mayDeposit(s, SEED).ok, false, 'a wrong word opened the deposit gate');
});

test('three of twelve is not a verification - §23A.8\'s short check is withdrawn', () => {
  const s = tab();
  const three = PHRASE.split(' ').slice(0, 3).join(' ');
  const said = verifyAndRecord({ typed: three, phrase: PHRASE, storage: s, seed: SEED });
  assert.equal(said.ok, false, 'three words were taken as a backup');
  assert.match(said.why, /3 words and the phrase is 12/);
  assert.equal(mayDeposit(s, SEED).ok, false);
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
  assert.equal(mayDeposit(hostile, SEED).ok, false);
  assert.equal(verifyAndRecord({ typed: PHRASE, phrase: PHRASE, storage: hostile, seed: SEED }).recorded, false);
});

test('a new tab is a new wallet, and an old verification does not vouch for it', () => {
  // MEASURED, and it is why the flag carries a digest: `tabSeed` mints fresh bytes when sessionStorage
  // has none, so opening a second tab is opening a wallet nobody has written down. localStorage, where
  // the flag lives, outlives every tab - a bare "verified" would have opened the gate for it.
  const s = tab();
  assert.equal(verifyAndRecord({ typed: PHRASE, phrase: PHRASE, storage: s, seed: SEED }).ok, true);
  assert.equal(mayDeposit(s, SEED).ok, true, 'the seed that was verified cannot deposit');

  assert.equal(isVerified(s, OTHER_SEED), false, 'an older verification vouched for a new wallet');
  assert.equal(mayDeposit(s, OTHER_SEED).ok, false, 'a wallet nobody backed up could deposit');
  assert.equal(mayPayStake(s, OTHER_SEED).ok, false, 'a wallet nobody backed up could pay a stake');
  assert.equal(backupLine(s, OTHER_SEED), NO_BACKUP_LINE, 'the new wallet was told it had a backup');
  // And the free round is still free for it.
  assert.equal(mayJoin({ paying: false, storage: s, seed: OTHER_SEED }).ok, true);
});

test('no seed at all is unverified, never verified', () => {
  const s = tab();
  assert.equal(digestOf(undefined), null);
  assert.equal(digestOf(new Uint8Array(8)), null, 'a short seed was digested anyway');
  assert.equal(isVerified(s, undefined), false);
  assert.equal(mayDeposit(s, undefined).ok, false, 'a client with no seed could deposit');
  assert.equal(verifyAndRecord({ typed: PHRASE, phrase: PHRASE, storage: s, seed: undefined }).recorded, false);
});
