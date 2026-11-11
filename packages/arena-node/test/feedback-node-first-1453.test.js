// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1453 (Daniel 2026-11-11: the admin page shows that a node report gets the one-time 10,000 sat because it is the node's first, and fills it in) - based on #1342's helpers.
// KANBAN #1342 slice 1: player feedback kept for review. A report is a Nostr event the player's key signs; the store takes it once, scrubbed of keys;
// "My feedback" answers only a NIP-98 sign-in by that key; a human moves the state by the table, and the store survives a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, NODE_BOUNTY_BASE_SATS, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, { kind = FEEDBACK_KIND, tags = [], content = '', created_at = Math.floor(Date.now() / 1000) } = {}) => {
  const e = { pubkey: k.pubkey, created_at, kind, tags, content };
  e.id = eventId(e);
  e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret));
  return e;
};
// A REPORT SAYS ENOUGH (at least 50 characters, Daniel 2026-11-07): every test text gets its steps; an empty one stays empty
const STEPS = ' Steps: opened the lobby, joined a round, watched the screen.';
const report = (k, happened, more = {}) => signed(k, { tags: [['t', more.type || 'bug'], ['game', 'rock-paper-scissors'], ['round', 'ab'.repeat(32)], ['build', 'UI 577'], ...(more.tags || [])],
  content: JSON.stringify({ happened: happened.trim() ? happened + STEPS : happened, expected: more.expected || 'it to work' }), ...(more.created_at ? { created_at: more.created_at } : {}) });

test('#1453 nodeBountyFor: the first node report of a node gets the one-time bounty; the next one of the same node or the same person does not; a frontend report is not asked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-1453-'));
  const s = openFeedbackStore(join(dir, 'f.db'));
  try {
    const NODE = 'ee'.repeat(32), OTHER = 'dd'.repeat(32);
    const take = (n, words, node) => { const e = report(key(n), words + STEPS, { type: 'bug', tags: [['source', 'node'], ['node', node]] }); assert.equal(s.take(e).ok, true); return e.id; };
    const a = take(1, 'The owner page froze after the update and showed no round at all', NODE);
    const before = s.nodeBountyFor(s.report(a));
    assert.deepEqual([before.first, before.sats, before.takenBy, before.full], [true, NODE_BOUNTY_BASE_SATS, null, false]);
    assert.equal(s.approve(a, null, { played: () => false, severity: 'node' }).ok, true);
    assert.equal(s.nodeBountyFor(s.report(a)).held, true, 'the report that took it holds it');
    const b = take(2, 'The node list shows my node offline although it signed rounds today', NODE);
    const sameNode = s.nodeBountyFor(s.report(b));
    assert.deepEqual([sameNode.first, sameNode.takenBy && sameNode.takenBy.sameNode], [false, true], 'the same node: no second bounty');
    const c = take(1, 'The fee screen of my second node shows the wrong reserve share for today', OTHER);
    const samePerson = s.nodeBountyFor(s.report(c));
    assert.deepEqual([samePerson.first, samePerson.takenBy && samePerson.takenBy.sameNode], [false, false], 'the same person, another node: none');
    const f = report(key(3), 'A frontend report about the lobby that never loads its rounds' + STEPS); s.take(f);
    assert.equal(s.nodeBountyFor(s.report(f.id)), null);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});
