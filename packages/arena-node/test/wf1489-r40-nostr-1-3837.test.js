// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40 nostr-1: GAP IN #3262 (re-sent kept events are no longer fanned out) FOR EPHEMERAL EVENTS, made free by #3359.
//
// #3262 answers a re-sent KEPT event 'duplicate:' and does not fan it out again. Its own fix idea named the ephemeral kinds too ("keep a
// short TTL set of recently seen ephemeral ids (24133/23194/23195/22242) so the same ephemeral event is passed on once only"), but the
// duplicate check runs only inside `if (!isEphemeral(e.kind))`. And since #3359 a copy of an event whose (id, sig) the relay verified
// lately (checkedSigs) is not checked again - so a replayed ephemeral frame costs the stranger nothing and the relay no verify token,
// and it is passed on to every matching subscriber each time.
//
// Attack (role c/d, a stranger on the relay who signs nothing): subscribe to the public filter {kinds:[23194], '#p':[wallet]} (or 24133
// for a NIP-46 bunker), copy the player's NWC request (pay_invoice) or NIP-46 sign request as it passes, and re-send it - 60 frames per
// 10 s per free socket. Every copy reaches the player's wallet service / remote signer again as a NEW request: the wallet is asked to
// pay the same invoice again (an error answer for the second try may reach the page first: the page reads the wallet's own refusal as
// final - "the wallet refused" - although the first try paid), the bunker prompts again; with 60 KB frames the honest subscriber's
// backlog grows until fanOut/dropSlow and the relay-wide shed cut it off. No signature budget bounds it (the copies skip the check).
//
// Safe behaviour: the same ephemeral event (same id and sig) is passed on once; a re-sent copy is answered 'duplicate:' and not fanned out.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const keyOf = (n) => { const sk = new Uint8Array(32).fill(n); return { sk, pk: hex(schnorr.getPublicKey(sk)) }; };
const sign = (k, fields) => {
  const e = { pubkey: k.pk, created_at: Math.floor(Date.now() / 1000), tags: [], content: '', ...fields };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), k.sk));
  return e;
};
const open = async (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.on('open', r));
  const inbox = []; ws.on('message', (m) => inbox.push(JSON.parse(String(m))));
  return { ws, inbox, send: (m) => ws.send(JSON.stringify(m)) };
};
const until = async (f, ms = 3000) => { for (const t = Date.now(); !f() && Date.now() - t < ms;) await new Promise((r) => setTimeout(r, 5)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const player = keyOf(21), wallet = keyOf(22);

for (const [kind, what] of [[23194, 'NWC pay_invoice request'], [24133, 'NIP-46 sign request']]) {
  test(`r40 nostr-1: a re-sent ${what} (kind ${kind}) reaches the wallet / signer once, not once per copy`, async () => {
    // no shared verify budget and one clean token: the player's one frame is checked, nothing else could be - the copies need no check
    const r = await startRelay({ port: 0, limits: { verifyBurst: 1, verifyPerS: 0, verifyStandingBurst: 0, verifyStandingPerS: 0, verifyCleanBurst: 0, verifyCleanPerS: 0 } });
    try {
      // the wallet service (or bunker) listens for requests to its key
      const w = await open(r.port);
      w.send(['REQ', 'svc', { kinds: [kind], '#p': [wallet.pk] }]);
      await until(() => w.inbox.some((m) => m[0] === 'EOSE'));
      // a stranger listens on the same public filter
      const s = await open(r.port);
      s.send(['REQ', 'spy', { kinds: [kind], '#p': [wallet.pk] }]);
      await until(() => s.inbox.some((m) => m[0] === 'EOSE'));

      // the player's page sends ONE request (its content would be NIP-04/44 ciphertext)
      const p = await open(r.port);
      const req = sign(player, { kind, tags: [['p', wallet.pk]], content: 'ciphertext-of-pay_invoice?iv=AAAAAAAAAAAAAAAAAAAAAA==' });
      p.send(['EVENT', req]);
      await until(() => s.inbox.some((m) => m[0] === 'EVENT' && m[2].id === req.id));
      const copy = s.inbox.find((m) => m[0] === 'EVENT' && m[2].id === req.id)[2];

      // the stranger re-sends the copy it saw, 20 times
      for (let i = 0; i < 20; i++) s.send(['EVENT', copy]);
      await until(() => s.inbox.filter((m) => m[0] === 'OK' && m[1] === req.id).length >= 20);
      await sleep(200);
      const oks = s.inbox.filter((m) => m[0] === 'OK' && m[1] === req.id);
      const got = w.inbox.filter((m) => m[0] === 'EVENT' && m[2].id === req.id).length;
      console.log(`kind ${kind}: the wallet/signer received the request ${got} times; the stranger's re-sends were answered: ${[...new Set(oks.map((m) => `${m[2]} '${m[3]}'`))].join(', ')}`);
      w.ws.terminate(); s.ws.terminate(); p.ws.terminate();
      assert.equal(got, 1, `one signed ${what} was delivered to the wallet/signer ${got} times: every copy a stranger re-sent was passed on as a new request`);
    } finally { await r.close(); }
  });
}
