// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40 nostr-3: THE FAUCET'S NIP-98 SIGN-IN (feedback-store authOf, used by GET /feedback/mine and POST /feedback/social,
// /feedback/link, /feedback/verify in tools/faucet.mjs) IS NOT USED ONCE AND IS NOT BOUND TO THE BODY.
//
// The Orange Pill Run's authOf (opr-service.mjs) takes a kind 27235 once (auth_seen) and, on a POST, only for the body whose SHA-256 its
// `payload` tag names - as NIP-98 asks. The faucet's authOf checks kind, age (60 s), `u` and `method` only. So one sign-in header that is
// seen once (a log line, a proxy, a browser extension, a shared HAR) is good for any number of requests for its minute, with any body:
// POST /feedback/social with { x: '<a listed bot handle>' } or { nostr: <a squatted key> } links accounts to the reporter's key (bot rate,
// lost bonus), and GET /feedback/mine answers the reporter's open reward lnurl (a bearer secret) and duplicate-ticket tokens to the replayer.
//
// Safe behaviour: a sign-in is taken once; a POST sign-in that names no payload, or another body's, is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, HTTP_AUTH_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const secret = new Uint8Array(32).fill(7), pubkey = hex(schnorr.getPublicKey(secret));
const signed = (tags) => {
  const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: HTTP_AUTH_KIND, tags, content: '' };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  return e;
};
const SOCIAL = 'https://testnet-stage.bitcoinarena.io/api/faucet/feedback/social';
const MINE = 'https://bitcoinarena.io/api/faucet/feedback/mine';

test('r40 nostr-3: one seen faucet sign-in is not good for a second request', () => {
  const s = openFeedbackStore();
  const ev = signed([['u', MINE], ['method', 'GET']]);
  const first = s.mine(ev, { url: MINE, method: 'GET' });
  const again = s.mine(ev, { url: MINE, method: 'GET' });
  console.log(`  FACTS: first ${JSON.stringify({ ok: first.ok })}, the same header re-sent: ${JSON.stringify({ ok: again.ok, why: again.why })}`);
  assert.equal(first.ok, true);
  assert.equal(again.ok, false, 'the same NIP-98 sign-in was taken twice: whoever saw the header reads the reporter\'s reports, reward links and dup tokens for its minute');
});

test('r40 nostr-3: a POST sign-in for /feedback/social is bound to its body (payload tag)', () => {
  const s = openFeedbackStore();
  const honestBody = JSON.stringify({ x: 'honest_reporter' });
  const sha = createHash('sha256').update(honestBody).digest('hex');
  // the page's sign-in for its own body
  const ev = signed([['u', SOCIAL], ['method', 'POST'], ['payload', sha]]);
  // the faucet calls authOf through mine() with only url and method: the body never reaches the check
  const replayed = s.mine(ev, { url: SOCIAL, method: 'POST', body: JSON.stringify({ x: 'listed_bot_handle' }) });
  const noPayload = s.mine(signed([['u', SOCIAL], ['method', 'POST']]), { url: SOCIAL, method: 'POST', body: honestBody });
  console.log(`  FACTS: another body under the sign-in: ${JSON.stringify({ ok: replayed.ok })}; a POST sign-in with no payload tag: ${JSON.stringify({ ok: noPayload.ok })}`);
  assert.equal(noPayload.ok, false, 'a POST sign-in that names no payload was taken: the body is not what the reporter signed');
  assert.equal(replayed.ok, false, 'a sign-in made for one body was taken with another');
});
