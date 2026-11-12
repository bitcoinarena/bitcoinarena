// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r11 nostr-2 (kanban #1489): A PLAYER'S OLD, PUBLIC ZAP REQUESTS LOCK THEM OUT. Every paid zap's receipt carries its zap
// request (the `description` tag) on public relays. The callback takes a request of any age (no created_at bound) and, without the
// optional `lnurl` query parameter, one made for any other Lightning address and recipient. A stranger replays ten of a player's old
// requests (ZAP_PENDING_PER_PAYER) - no payment, ten GETs - and every new zap that player signs is refused "too many open zaps from
// that key" for the invoices' hour, again and again. Safe: a stale request is refused, so the player's fresh zap is invoiced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveZapAddresses, signNostr, ZAP_PENDING_PER_PAYER } from '../src/zap-address.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { curve, keyPair, fakeLightning } from './wf1489-r11-nostr-zapfix.js';

test('replaying a player\'s old zap requests does not refuse that player\'s fresh zap', async () => {
  const ln = fakeLightning();
  const server = keyPair();
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice: ln.invoice,
    lookup: ln.lookup, publish: async () => {}, watchMs: 60000 });
  try {
    const victim = keyPair(), elsewhere = keyPair(), bob = keyPair();
    const nowS = Math.floor(Date.now() / 1000);
    const cb = (r, amount) => `http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=${amount}&nostr=${encodeURIComponent(JSON.stringify(r))}`;
    // the victim's zaps of last month, to somebody else's address, as their receipts show them on any relay
    let replayed = 0;
    for (let i = 0; i < ZAP_PENDING_PER_PAYER; i++) {
      const old = signNostr(zapRequestTemplate({ recipient: elsewhere.pubkey, amountMsat: BigInt(21000 + i * 1000), relays: ['wss://relay.damus.io'],
        payRequestUrl: 'https://other.example/.well-known/lnurlp/alice', comment: `old ${i}` }), { secret: victim.secret, curve, nowS: nowS - 30 * 86400 });
      if ((await (await fetch(cb(old, 21000 + i * 1000))).json()).pr) replayed++;
    }
    console.log(`stale zap requests of the victim invoiced by a stranger: ${replayed}`);
    const fresh = signNostr(zapRequestTemplate({ recipient: bob.pubkey, amountMsat: 21000n, relays: ['wss://relay.bitcoin-arena.io'],
      payRequestUrl: 'https://zap.example/.well-known/lnurlp/bob', comment: 'gg' }), { secret: victim.secret, curve, nowS });
    const said = await (await fetch(cb(fresh, 21000))).json();
    console.log('the victim\'s own fresh zap:', JSON.stringify(said).slice(0, 160));
    assert.ok(said.pr, `the victim's fresh zap was refused: ${said.reason}`);
  } finally { await z.close(); }
});
