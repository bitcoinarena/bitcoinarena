// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1472 (hexbox #005), the kept event of a report a client signs: scrubDeep stops at depth 8 and never scrubs object KEYS,
// so a seed nested 9 deep in the content, or a seed that is a key of the debug object, stays raw in the stored event column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const secret = new Uint8Array(32).fill(7); const pubkey = hex(schnorr.getPublicKey(secret));
const signed = (tags, content) => { const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags, content }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret)); return e; };
const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const HAPPENED = 'The withdraw button did nothing after the round closed. Steps: opened the lobby, joined a round, watched the screen.';
const eventOf = (path, id) => { const db = new DatabaseSync(path); const ev = db.prepare('SELECT event FROM reports WHERE id = ?').get(id).event; db.close(); return ev; };
test('#1472 refute: a seed nested deep in the debug state is not kept raw in the stored event', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wf1489-62-s2-2-')), 'fb.sqlite');
  const s = openFeedbackStore(path);
  let deep = SEED; for (let i = 0; i < 9; i++) deep = { s: deep };
  const e = signed([['t', 'bug']], JSON.stringify({ happened: HAPPENED, expected: 'it to work', debug: deep }));
  assert.equal(s.take(e).ok, true);
  s.close();
  const ev = eventOf(path, e.id);
  assert.equal(ev.includes('abandon ability'), false, ev);
});
test('#1472 refute: a seed as a key of the debug object is not kept raw in the stored event', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wf1489-62-s2-2b-')), 'fb.sqlite');
  const s = openFeedbackStore(path);
  const e = signed([['t', 'bug']], JSON.stringify({ happened: HAPPENED, expected: 'it to work', debug: { [SEED]: 'wallet words' } }));
  assert.equal(s.take(e).ok, true);
  s.close();
  const ev = eventOf(path, e.id);
  assert.equal(ev.includes('abandon ability'), false, ev);
});
