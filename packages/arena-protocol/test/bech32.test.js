// BECH32 (BIP-173) AND LNURL (LUD-01), against their own published strings
// (M3.2 6e). Before this nothing in the repo could turn an LNURL into the URL a
// wallet asks; donation.js only folded their case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bech32Decode, bech32Encode, lnurlFor, urlOfLnurl } from '../src/bech32.js';

test('BIP-173\'s valid strings decode, and re-encode to themselves', () => {
  for (const s of ['A12UEL5L', 'a12uel5l', 'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
    'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w', '?1ezyfcl']) {
    const { hrp, words } = bech32Decode(s);
    assert.equal(bech32Encode(hrp, words), s.toLowerCase(), s);
  }
});

test('BIP-173\'s invalid strings are refused, each for its own reason', () => {
  for (const [s, why] of [
    ['pzry9x0s0muk', /human-readable part/],     // no separator
    ['1pzry9x0s0muk', /human-readable part/],    // empty hrp
    ['x1b4n0q5v', /not a bech32 character/],     // b is not in the charset
    ['li1dgmt3', /six-character checksum/],      // too short
    ['A1G7SGD8', /checksum/],                     // checksum made over an uppercase hrp
    ['A12uEL5L', /mixed case/],
  ]) assert.throws(() => bech32Decode(s), why, s);
});

test('LUD-01\'s own example: the LNURL is that URL, in both cases', () => {
  const url = 'https://service.com/api?q=3fc3645b439ce8e7f2553a69e5267081d96dcd340693afabe04be7b0ccd178df';
  const lnurl = 'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS';
  assert.equal(urlOfLnurl(lnurl), url);
  assert.equal(urlOfLnurl(lnurl.toLowerCase()), url);
  assert.equal(lnurlFor(url), lnurl.toLowerCase());
  assert.throws(() => urlOfLnurl('a12uel5l'), /not an LNURL/);
});
