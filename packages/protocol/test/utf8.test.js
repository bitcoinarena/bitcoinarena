// The UTF-8 codec, checked against the platform's and then past it.
//
// It exists because TextEncoder is a Web API rather than ECMAScript, and the
// engine shells do not have it - but the reason to keep it is stricter than
// portability: TextEncoder silently substitutes U+FFFD for an unpaired
// surrogate, and two implementations disagreeing about whether a substitution
// happened is a protocol fork.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8Encode, utf8Decode } from '../src/utf8.js';

const SAMPLES = ['', 'mempool', 'a b', 'Gruesse', 'Grüße', 'ß', 'é',
                 '日本語', '🚀', '🐋 x'];

test('it agrees with the platform encoder on well-formed input', () => {
  const platform = new TextEncoder();
  for (const s of SAMPLES) {
    const mine = utf8Encode(s), theirs = platform.encode(s);
    assert.deepEqual([...mine], [...theirs], JSON.stringify(s));
  }
});

test('every sample round-trips', () => {
  for (const s of SAMPLES) assert.equal(utf8Decode(utf8Encode(s)), s, JSON.stringify(s));
});

test('unpaired surrogates are refused, not replaced', () => {
  assert.throws(() => utf8Encode('\uD800'), /surrogate/);
  assert.throws(() => utf8Encode('\uD800a'), /surrogate/);
  assert.throws(() => utf8Encode('\uDC00'), /surrogate/);
  // and the platform's answer, for contrast: it substitutes silently
  assert.deepEqual([...new TextEncoder().encode('\uD800')], [0xef, 0xbf, 0xbd]);
});

test('malformed input is rejected rather than repaired', () => {
  const bad = {
    'overlong two-byte NUL': [0xc0, 0x80],
    'overlong three-byte': [0xe0, 0x80, 0x80],
    'surrogate encoded as UTF-8': [0xed, 0xa0, 0x80],
    'beyond U+10FFFF': [0xf5, 0x80, 0x80, 0x80],
    'lone continuation': [0x80],
    'truncated sequence': [0xe2, 0x82],
  };
  for (const [what, bytes] of Object.entries(bad))
    assert.throws(() => utf8Decode(new Uint8Array(bytes)), undefined, what + ' was accepted');
});
