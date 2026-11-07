// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1342 slice 1: player feedback kept for review. A report is a Nostr event the player's key signs; the store takes it once, scrubbed of keys;
// "My feedback" answers only a NIP-98 sign-in by that key; a human moves the state by the table, and the store survives a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND, HTTP_AUTH_KIND, STATES } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, { kind = FEEDBACK_KIND, tags = [], content = '', created_at = Math.floor(Date.now() / 1000) } = {}) => {
  const e = { pubkey: k.pubkey, created_at, kind, tags, content };
  e.id = eventId(e);
  e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret));
  return e;
};
const report = (k, happened, more = {}) => signed(k, { tags: [['t', more.type || 'bug'], ['game', 'rock-paper-scissors'], ['round', 'ab'.repeat(32)], ['build', 'UI 577']],
  content: JSON.stringify({ happened, expected: more.expected || 'it to work' }), ...(more.created_at ? { created_at: more.created_at } : {}) });
const URL_MINE = 'https://faucet.example/feedback/mine';
const auth = (k, over = {}) => signed(k, { kind: HTTP_AUTH_KIND, tags: [['u', over.u || URL_MINE], ['method', over.method || 'GET']], created_at: over.created_at || Math.floor(Date.now() / 1000) });

test('#1342 a signed report is kept once, scrubbed of keys; a forged, old, wrong-kind or empty one is refused', () => {
  const s = openFeedbackStore();
  const alice = key(1);
  const e = report(alice, 'The withdraw button did nothing. My seed was abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const first = s.take(e), again = s.take(e);
  const forged = { ...e, content: JSON.stringify({ happened: 'changed after signing', expected: '' }) };
  const otherKey = { ...e, pubkey: key(2).pubkey };
  const old = report(alice, 'old report', { created_at: Math.floor(Date.now() / 1000) - 2 * 86400 });
  const note = signed(alice, { kind: 1, content: 'hello' });
  const empty = report(alice, '  ');
  const badType = signed(alice, { tags: [['t', 'praise']], content: JSON.stringify({ happened: 'nice game' }) });
  const refused = Object.fromEntries(Object.entries({ forged, otherKey, old, note, empty, badType }).map(([k, x]) => [k, s.take(x).why]));
  const kept = s.report(e.id);
  console.log('  FACTS #1342 intake:', JSON.stringify({ first, again, refused, keptText: kept.happened, state: kept.state }));
  assert.deepEqual([first.ok, first.kept, again.ok, again.kept], [true, true, true, false]);
  for (const [k, why] of Object.entries(refused)) assert.ok(why, `${k} was taken`);
  assert.match(kept.happened, /\[removed\]/, 'the seed phrase is not kept');
  assert.doesNotMatch(kept.happened, /abandon abandon/);
  assert.equal(kept.state, STATES.NEW);
  assert.deepEqual([kept.game, kept.round.length, kept.build], ['rock-paper-scissors', 64, 'UI 577']);
});

test('#1342 "My feedback" answers only a fresh NIP-98 sign-in by the reporter, for this address and method', () => {
  const s = openFeedbackStore();
  const alice = key(1), bob = key(2);
  s.take(report(alice, 'first thing broke')); s.take(report(alice, 'second thing broke')); s.take(report(bob, 'bob found something'));
  const own = s.mine(auth(alice), { url: URL_MINE });
  const tries = {
    otherUrl: s.mine(auth(alice, { u: 'https://faucet.example/feedback/all' }), { url: URL_MINE }).why,
    post: s.mine(auth(alice, { method: 'POST' }), { url: URL_MINE }).why,
    stale: s.mine(auth(alice, { created_at: Math.floor(Date.now() / 1000) - 300 }), { url: URL_MINE }).why,
    aReport: s.mine(report(alice, 'not a sign-in'), { url: URL_MINE }).why,
    tampered: s.mine({ ...auth(alice), pubkey: bob.pubkey }, { url: URL_MINE }).why,
  };
  console.log('  FACTS #1342 mine:', JSON.stringify({ aliceSees: own.reports.map((r) => r.happened), refused: tries }));
  assert.equal(own.ok, true);
  assert.deepEqual(own.reports.map((r) => r.pubkey === alice.pubkey), [true, true], 'only her own reports');
  for (const [k, why] of Object.entries(tries)) assert.ok(why, `${k} was let in`);
});

test('#1342 a human moves the state by the table: a rejection says why, a duplicate names the earlier report; nothing else moves', () => {
  const s = openFeedbackStore();
  const alice = key(1), bob = key(2);
  const a = report(alice, 'the lobby froze after join', { created_at: Math.floor(Date.now() / 1000) - 60 });
  const b = report(bob, 'the lobby froze after I joined');
  s.take(a, { nowMs: Date.now() - 60000 }); s.take(b);
  const steps = {
    rejectNoReason: s.move(a.id, STATES.REJECTED).why,
    dupOfLater: s.move(a.id, STATES.DUPLICATE, { duplicateOf: b.id }).why,
    dupOfSelf: s.move(b.id, STATES.DUPLICATE, { duplicateOf: b.id }).why,
    newToPaid: s.move(a.id, STATES.PAID).why,
    dup: s.move(b.id, STATES.DUPLICATE, { duplicateOf: a.id, by: 'admin' }).ok,
    dupAgain: s.move(b.id, STATES.ACCEPTED).why,
    accept: s.move(a.id, STATES.ACCEPTED, { by: 'admin' }).ok,
  };
  console.log('  FACTS #1342 moves:', JSON.stringify(steps));
  assert.ok(steps.rejectNoReason && steps.dupOfLater && steps.dupOfSelf && steps.newToPaid && steps.dupAgain);
  assert.deepEqual([steps.dup, steps.accept], [true, true]);
  assert.deepEqual([s.report(a.id).state, s.report(b.id).state, s.report(b.id).duplicateOf], [STATES.ACCEPTED, STATES.DUPLICATE, a.id]);
  assert.deepEqual(s.list({ state: 'accepted' }).map((r) => r.id), [a.id]);
});

test('#1342 the reports outlive a restart: the same file reopened holds them with their states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-1342-'));
  try {
    const path = join(dir, 'feedback.db');
    const alice = key(1);
    const e = report(alice, 'kept across a restart');
    const s1 = openFeedbackStore(path); s1.take(e); s1.move(e.id, STATES.ACCEPTED, { by: 'admin' }); s1.close();
    const s2 = openFeedbackStore(path);
    const r = s2.report(e.id);
    console.log('  FACTS #1342 restart:', JSON.stringify({ kept: !!r, state: r && r.state }));
    assert.deepEqual([r.happened, r.state], ['kept across a restart', STATES.ACCEPTED]);
    s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
