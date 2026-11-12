// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1472 (hexbox #005), the kept event: keptEvent scrubs tag VALUES only - a tag's name (index 0) and any field beside the
// signed ones ({ ...e }: the id covers only pubkey, created_at, kind, tags, content) are kept as posted, so a seed there stays raw on disk.
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
const secret = new Uint8Array(32).fill(9); const pubkey = hex(schnorr.getPublicKey(secret));
const signed = (tags, content) => { const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags, content }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret)); return e; };
const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const HAPPENED = 'The withdraw button did nothing after the round closed. Steps: opened the lobby, joined a round, watched the screen.';
const eventOf = (path, id) => { const db = new DatabaseSync(path); const ev = db.prepare('SELECT event FROM reports WHERE id = ?').get(id).event; db.close(); return ev; };
test('#1472 refute: a seed as a tag name is not kept raw', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wf1489-62-s2-3-')), 'fb.sqlite');
  const s = openFeedbackStore(path);
  const e = signed([['t', 'bug'], [SEED, 'x']], JSON.stringify({ happened: HAPPENED, expected: 'it to work' }));
  assert.equal(s.take(e).ok, true);
  s.close();
  assert.equal(eventOf(path, e.id).includes('abandon ability'), false);
});
test('#1472 refute: a seed in a field beside the signed ones is not kept raw', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wf1489-62-s2-3b-')), 'fb.sqlite');
  const s = openFeedbackStore(path);
  const e = { ...signed([['t', 'bug']], JSON.stringify({ happened: HAPPENED, expected: 'it to work' })), note: SEED };
  assert.equal(s.take(e).ok, true);
  s.close();
  assert.equal(eventOf(path, e.id).includes('abandon ability'), false);
});
