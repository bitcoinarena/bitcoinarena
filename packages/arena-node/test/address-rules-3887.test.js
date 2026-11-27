// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3887: a node's address is https on 443, a name with a certificate; the guardian's wss://<the same name>/guardian. Refused at input
// with the reason and a short how-to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressRefusal, guardianEndpointRefusal, ADDRESS_HOW_TO } from '../src/address-rules.js';
// 2.0: the outside check (#3886, GET /reach-probe of #3798) is not on this branch - its parts of this test stay on 1.9.

test('https names on 443 pass; Funnel\'s own ports on ts.net pass', () => {
  for (const u of ['https://arena.example.org', 'https://arena.example.org/', 'https://node-1.duckdns.org', 'https://op.tail1234.ts.net:8443', 'https://op.tail1234.ts.net:10000', 'https://arena.example.org:443'])
    assert.equal(addressRefusal(u), null, u);
});

test('http, a bare IP, another port, a local name: refused, each with its reason and the how-to', () => {
  const cases = [['http://arena.example.org', /not https.*mixed content/], ['http://203.0.113.9:8470', /not https/], ['https://203.0.113.9', /bare IP/],
    ['https://[2001:db8::1]', /bare IP/], ['https://arena.example.org:8470', /port 8470: .*port 443/], ['https://example.org:8443', /port 8443/],
    ['https://raspberrypi.local', /not a public name/], ['https://nodebox', /not a public name/], ['arena.example.org', /not an address/], ['', /no address/],
    ['https://u:p@arena.example.org', /login/]];
  for (const [u, why] of cases) { const r = addressRefusal(u); assert.ok(r, u); assert.match(r.why, why, u); assert.equal(r.howTo, ADDRESS_HOW_TO); }
  assert.match(ADDRESS_HOW_TO, /dynamic-DNS.*Caddy or nginx and Let's Encrypt.*named Cloudflare tunnel/);
});

test('the guardian endpoint: wss://<the public name>/guardian', () => {
  assert.equal(guardianEndpointRefusal('wss://arena.example.org/guardian', 'https://arena.example.org'), null);
  assert.match(guardianEndpointRefusal('ws://arena.example.org/guardian', 'https://arena.example.org').why, /not wss:/);
  assert.match(guardianEndpointRefusal('wss://old.example.org/guardian', 'https://arena.example.org').why, /another address than public_url/);
  assert.equal(guardianEndpointRefusal(null, 'https://arena.example.org'), null);
});
