// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2745: a report rejected as a duplicate of a known ticket gets a secret link to the ticket's title and description - never its comments or
// history - scrubbed of keys, tokens, paths, cookies and addresses; only the report's own key sees the link in My feedback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { openFeedbackStore, FEEDBACK_KIND, HTTP_AUTH_KIND, scrubTicket } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const URL_ = 'https://stage.example/api/faucet/feedback/mine';

test('#2745 the snapshot: title and description only, scrubbed; a 128-bit token; only the owner\'s My feedback shows it; unknown tokens give nothing', () => {
  const s = openFeedbackStore();
  const [ann, bob] = [key(3), key(4)];
  const t = s.take(signed(ann, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'The payout page spins forever after the second round of next block.' })));
  assert.equal(t.ok, true, JSON.stringify(t));
  s.take(signed(bob, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'Another report from another key, long enough to be kept by the store.' })));
  assert.equal(s.move(t.id, 'rejected', { reason: 'Thanks for the report. This is a duplicate of a known issue (ticket #77).' }).ok, true);
  const task = { id: 77, title: 'Payout spins at 192.168.1.5', description: `Seen on /home/daniel/blwp/x.db with key ${'ab'.repeat(32)}; cookie: auth_token=abcdefghijk; FAUCET_ADMIN_CODE=hunter22 at 07:12 UTC`,
    comments: [{ body: 'INTERNAL COMMENT' }], events: [{ action: 'HISTORY-EVENT' }], tags: ['Bug'], assignee: 'someone' };
  const d = s.dupSnapshot(t.id, task); assert.deepEqual(d, { ok: true, report: t.id, ticket: 77 });
  const mineOf = (k) => s.mine(signed(k, HTTP_AUTH_KIND, [['u', URL_], ['method', 'GET']]), { url: URL_, method: 'GET' });
  const a = mineOf(ann); assert.equal(a.ok, true);
  const tok = a.reports.find((r) => r.id === t.id).dupToken; assert.match(tok, /^[0-9a-f]{32}$/);
  const b = mineOf(bob); assert.equal(b.reports.some((r) => 'dupToken' in r), false, 'another key never sees it');
  assert.equal(s.list ? JSON.stringify(s.list({})).includes(tok) : false, false, 'not in the admin list');
  const x = s.dupLink(tok);
  assert.deepEqual(Object.keys(x).sort(), ['body', 'madeMs', 'ticket', 'title']);
  assert.equal(x.ticket, 77); assert.equal(x.title, 'Payout spins at …');
  for (const bad of ['INTERNAL COMMENT', 'HISTORY-EVENT', '/home/daniel', 'ab'.repeat(32), 'abcdefghijk', 'hunter22', '192.168']) assert.equal(JSON.stringify(x).includes(bad), false, bad);
  assert.match(x.body, /07:12 UTC/, 'times stay');
  assert.equal(s.dupLink('0'.repeat(32)), null); assert.equal(s.dupLink('not a token'), null);
  assert.equal(s.dupSnapshot(t.id, { id: 78, title: 'later', description: 'again' }).ok, true);
  assert.equal(s.dupLink(tok).ticket, 78, 'a new snapshot keeps the report\'s one token');
  assert.equal(s.dupSnapshot('nope', task).ok, false);
  assert.equal(scrubTicket('npub1' + 'q'.repeat(58) + ' and fe80::1'), '… and …');
});
