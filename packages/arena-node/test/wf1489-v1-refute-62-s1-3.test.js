// kanban #1489 refute of #1472 (hexbox #005): "a seed phrase never stays in a kept report" - take() scrubs happened/expected, but keeps the whole
// signed event (JSON.stringify(e)) in the reports table's `event` column, so the seed, in any spelling, stays on disk in the kept report (and in its
// `debug`, which is only scrubbed when read).
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
const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
test('#1472 refute: the kept report holds no seed phrase anywhere in its row', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wf1489-62-')), 'fb.sqlite');
  const s = openFeedbackStore(path);
  const e = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug']],
    content: JSON.stringify({ happened: `The withdraw button did nothing at all. My seed is ${SEED}. Steps: opened the lobby and pressed withdraw.`, expected: 'paid', debug: `seed ${SEED}` }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  const r = s.take(e);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!s.report(e.id).happened.includes('abandon'), 'the happened field is scrubbed (the fix)');
  s.close();
  const db = new DatabaseSync(path);
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(e.id);
  db.close();
  const leaked = Object.entries(row).filter(([, v]) => typeof v === 'string' && v.includes('abandon ability able')).map(([k]) => k);
  assert.deepEqual(leaked, [], `seed kept in column(s): ${leaked.join(', ')}`);
});
