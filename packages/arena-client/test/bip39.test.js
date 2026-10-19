// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 32 BYTES -> 24 WORDS -> THE SAME 32 BYTES, and a phrase that does not check is not a seed.
//
// The player writes these words down and has to get this wallet back, here or in any other tool. So the
// wordlist is checked against its published digest on every run, the vectors are BIP-39's own, and a bad
// checksum is refused rather than decoded into plausible bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { BIP39_ENGLISH, BIP39_ENGLISH_SHA256 } from '../src/bip39-wordlist.js';
import { phraseFromSeed, seedFromPhrase, seedHexFromInput, PHRASE_WORDS } from '../src/bip39.js';

test('the wordlist is the published one, 2048 words, unedited', () => {
  assert.equal(BIP39_ENGLISH.length, 2048);
  assert.equal(BIP39_ENGLISH[0], 'abandon');
  assert.equal(BIP39_ENGLISH[2047], 'zoo');
  // The digest in the file's own header, recomputed from the words themselves - so a hand edit shows.
  const asFile = new TextEncoder().encode(`${BIP39_ENGLISH.join('\n')}\n`);
  assert.equal(toHex(sha256(asFile)), BIP39_ENGLISH_SHA256,
    'the wordlist no longer matches the checksum it was taken under');
  assert.equal(new Set(BIP39_ENGLISH).size, 2048, 'a word appears twice');
});

test('BIP-39\'s own 256-bit vectors, both ways', () => {
  // From the reference test vectors published with BIP-39 (trezor/python-mnemonic vectors.json).
  const vectors = [
    ['0000000000000000000000000000000000000000000000000000000000000000',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon '
      + 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'],
    ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
      'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth '
      + 'useful legal winner thank year wave sausage worth title'],
    ['8080808080808080808080808080808080808080808080808080808080808080',
      'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor '
      + 'acoustic avoid letter advice cage absurd amount doctor acoustic bless'],
    ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote'],
  ];
  for (const [hex, phrase] of vectors) {
    const made = phraseFromSeed(fromHex(hex));
    assert.equal(made.ok, true, made.why);
    assert.equal(made.phrase, phrase, `${hex.slice(0, 8)}... did not encode to its published phrase`);
    const back = seedFromPhrase(phrase);
    assert.equal(back.ok, true, back.why);
    assert.equal(toHex(back.seed), hex, 'the phrase did not decode to the seed it was made from');
  }
});

test('any seed round-trips, and every phrase is 24 words', () => {
  for (let n = 0; n < 200; n++) {
    const seed = sha256(new TextEncoder().encode(`round-trip ${n}`));
    const made = phraseFromSeed(seed);
    assert.equal(made.ok, true, made.why);
    assert.equal(made.words.length, PHRASE_WORDS);
    assert.equal(toHex(seedFromPhrase(made.phrase).seed), toHex(seed), `seed ${n} did not come back`);
  }
});

test('a bad checksum does not decode, and never hands back plausible bytes', () => {
  const seed = sha256(new TextEncoder().encode('checksum'));
  const words = phraseFromSeed(seed).words.slice();
  // Change the LAST word: the checksum lives there, so this is the mistyping that would otherwise
  // restore a different, empty wallet with no error anywhere.
  words[23] = BIP39_ENGLISH[(BIP39_ENGLISH.indexOf(words[23]) + 1) % 2048];
  const said = seedFromPhrase(words.join(' '));
  assert.equal(said.ok, false, 'a phrase with a bad checksum decoded');
  assert.equal(said.seed, undefined, 'it handed back bytes anyway');
  assert.match(said.why, /does not check out/);
});

test('a word outside the list is refused and named; a wrong count is refused', () => {
  const seed = sha256(new TextEncoder().encode('words'));
  const words = phraseFromSeed(seed).words.slice();
  words[4] = 'notaword';
  const said = seedFromPhrase(words.join(' '));
  assert.equal(said.ok, false);
  assert.equal(said.wrongAt, 4, 'it did not say which word');
  assert.match(said.why, /not in the wordlist/);
  assert.equal(seedFromPhrase(words.slice(0, 12).join(' ')).ok, false, 'twelve words passed as twenty-four');
  assert.equal(seedFromPhrase('').ok, false);
});

test('a seed that is not 32 bytes is refused rather than padded', () => {
  assert.equal(phraseFromSeed(new Uint8Array(16)).ok, false, 'a 16-byte seed was encoded');
  assert.equal(phraseFromSeed(undefined).ok, false);
});

// KANBAN: the restore inputs take the 24 words (checked) or the 64 hex digits, and hand importSeed the same 64 hex.
test('what the player types - the 24 words or the 64 hex - becomes the same seed hex; a wrong word is refused', () => {
  const words = 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth '
    + 'useful legal winner thank year wave sausage worth title';
  assert.deepEqual(seedHexFromInput(words), { ok: true, hex: '7f'.repeat(32), from: 'words' });
  assert.deepEqual(seedHexFromInput('  ' + words.toUpperCase().replace(/ /g, '   ') + '\n'), { ok: true, hex: '7f'.repeat(32), from: 'words' });
  assert.deepEqual(seedHexFromInput('7F'.repeat(32)), { ok: true, hex: '7f'.repeat(32), from: 'hex' });
  const wrong = seedHexFromInput(words.replace(/title$/, 'zoo'));
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /does not check out/);
  assert.match(seedHexFromInput('abandon art').why, /24 words/);
});
