// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3887: the Address card states the requirements at input - the name typed for a domain is checked as it is typed, the direct way
// says browsers block http://IP, and a public_url that cannot be used says why with the how-to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AddressPanel } from '../dist/test/address.mjs';

const base = { ok: true, mode: 'tailscale', url: 'https://op.tail1234.ts.net', stable: true, modes: { tailscale: 'Funnel', permanent: 'domain', direct: 'direct' }, follow: null };
const draw = (state) => renderToStaticMarkup(React.createElement(AddressPanel, { initial: { loaded: true, answer: base, ...state } }));

test('a name typed for the domain way: an IP or a port refused as typed, the switch button off; a good name passes', () => {
  let h = draw({ mode: 'permanent', hostname: '203.0.113.9' });
  assert.match(h, /data-check="hostname-refusal"[^>]*>203\.0\.113\.9 is a bare IP address/);
  assert.match(h, /<button[^>]*disabled=""[^>]*>Switch to Your own domain/);
  h = draw({ mode: 'permanent', hostname: 'node.example.com:8470' });
  assert.match(h, /port 8470/);
  h = draw({ mode: 'permanent', hostname: 'node.example.com' });
  assert.doesNotMatch(h, /hostname-refusal/);
  assert.doesNotMatch(h, /<button[^>]*disabled=""[^>]*>Switch to/);
});

test('the direct way says browsers block http://IP:port; a public_url that cannot be used says why and how', () => {
  assert.match(draw({ mode: 'direct' }), /data-check="direct-warning"[^>]*>Browsers on the https Arena page block an http:\/\/IP:port address.*Caddy or nginx/);
  const mm = { conf: 'http://203.0.113.9:8470', installer: base.url, advertised: [base.url], confDiffers: true, censusDiffers: true, adoptable: false, quick: false, bonded: true,
    refusal: { why: 'http://203.0.113.9:8470 is not https: browsers block it (mixed content)', howTo: 'Use a name with a valid certificate on port 443' } };
  const h = draw({ answer: { ...base, follow: { censusRead: true, advertised: [base.url], bonded: true, mismatch: mm } } });
  assert.match(h, /data-check="refusal"[^>]*>This address cannot be used: http:\/\/203\.0\.113\.9:8470 is not https/);
  assert.match(h, /Use a name with a valid certificate on port 443/);
  assert.doesNotMatch(h, /Post the advertisement update/);
});
