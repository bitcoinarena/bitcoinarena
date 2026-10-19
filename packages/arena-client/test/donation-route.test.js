// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LOOPBACK DONATION RECIPIENT GOES OVER ITS LISTED ROUTE (2026-10-03, option A): the paid rounds of 10-02..10-04
// name testnet4's test donation set at http://127.0.0.1:18777 - a player's browser reached nothing there and every share was
// UNPAID. The page's donation fetcher, run on a fake tab: a loopback recipient with a route in daily.json's testnet.alt goes
// there over https; one with no route, and every other host, go as named.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const from = html.indexOf('      const donationFetch = (u) => {');
const to = html.indexOf('      };', from) + '      };'.length;
const make = (routes) => {
  const asked = [];
  const f = pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['window', 'fetch'], html.slice(from, to), 'return donationFetch;')({ ARENA_ALT_ROUTES: routes }, (u) => { asked.push(u); return 'answer'; });
  return { f, asked };
};

test('the page passes its donation fetcher to both ways of paying', () => {
  assert.ok(from > 0 && to > from);
  assert.equal((html.match(/fetcher: donationFetch/g) || []).length, 2);
});

test('a loopback recipient with a route goes over it, over https; the callback on the route\'s host and other hosts go as named', () => {
  const { f, asked } = make({ '127.0.0.1:18777': 'present-computing.trycloudflare.com' });
  f('http://127.0.0.1:18777/lnurlp/blwp-test-a');
  f('https://present-computing.trycloudflare.com/lnurlp/blwp-test-a/cb?amount=1334');
  f('https://seat.example.com/lnurlp/blwp-donate-b');
  assert.deepEqual(asked, ['https://present-computing.trycloudflare.com/lnurlp/blwp-test-a',
    'https://present-computing.trycloudflare.com/lnurlp/blwp-test-a/cb?amount=1334',
    'https://seat.example.com/lnurlp/blwp-donate-b']);
});

test('no route listed: the loopback recipient is asked as named (and fails as before, reported unpaid)', () => {
  const { f, asked } = make({});
  f('http://127.0.0.1:18777/lnurlp/blwp-test-b');
  assert.deepEqual(asked, ['http://127.0.0.1:18777/lnurlp/blwp-test-b']);
});
