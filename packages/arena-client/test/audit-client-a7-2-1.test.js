// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit client round 2, finding 1 (gap in the #3183 fix): the page's GET /gateway-seats lookup (src/arena-ui/index.html, useSeatedGateways)
// asks every distinct URL of the lobby's node list and hands each answer to seatedGatewaysOf, which seats a gateway once SEATED_AGREE (2)
// ANSWERS name it. Answers carry no seat identity and the URL list is deduped by exact spelling only, so one guardian seat named in a link
// under two paths of its box (https://evil.example/a and /b) is the two "seats" #3183 asks for: its own gateway (which its guardian added to
// the federation's union list, the #3183 premise) leads the deposit and the swap legs again. Safe behaviour: one host's answers are one vote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pl from '../src/page-lock.js';

const FID = 'a1'.repeat(32);
const OWN = 'https://evil-own-gateway.example/';
const HONEST = 'https://gw-a.example/';
const LISTED = [HONEST, 'https://gw-b.example/', OWN];   // the federation's union list: OWN only through the attacker's guardian

// the page's own lookup code, taken from index.html as BASE ships it
const html = readFileSync(fileURLToPath(new URL('../../../src/arena-ui/index.html', import.meta.url)), 'utf8');
const from = html.indexOf('if (ARENACLIENT.useSeatedGateways) {');
const to = html.indexOf('if (testnet) { findTheRoundsOwed', from);
const pageLookup = html.slice(from, to);

test('two paths of one guardian seat\'s box in a link do not seat that seat\'s own gateway (#3183 asks two seats)', async () => {
  assert.ok(from > 0 && to > from, 'the page\'s gateway-seats lookup was found in index.html');
  const honestSeats = ['https://seat-1.example', 'https://seat-2.example', 'https://seat-3.example'];
  const named = { nodes: ['https://evil.example/a', 'https://evil.example/b', ...honestSeats] };
  const view = (url) => ({ federationId: FID, seated: ['g'], gateways: { g: { url } } });
  const asked = [];
  const fetchStub = async (u) => {
    asked.push(u);
    const own = u.startsWith('https://evil.example/');
    return { ok: true, json: async () => view(own ? OWN : HONEST) };
  };
  new Function('ARENACLIENT', 'testnet', 'named', 'fetch', pageLookup)(pl, null, named, fetchStub);
  try {
    const dep = { gateways: async () => JSON.stringify(LISTED), asked: [],
      receive: async function (m, gw) { this.asked.push(gw); return JSON.stringify({ invoice: 'lntb1x', operation: 'op-d' }); },
      awaitReceive: () => new Promise(() => {}) };
    pl.noteClientFederation(dep, FID);
    const seated = await pl.seatedGatewaysOf(dep);
    const d = await pl.depositOffer({ client: dep, stakeMsat: 100000n }).invoice(100000n);
    console.log(`asked ${asked.length} URLs; seated ${JSON.stringify(seated)}; deposit through ${d.gateway}`);
    assert.ok(!seated.includes(OWN), `one box at two paths seated its own gateway: ${JSON.stringify(seated)}`);
    assert.notEqual(d.gateway, OWN, `the deposit went first through ${d.gateway}, named seated only by two paths of one box`);
  } finally { pl.useSeatedGateways(null); }
});
