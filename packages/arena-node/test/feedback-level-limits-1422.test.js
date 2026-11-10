// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT 6 for 2026.1.9.27: KANBAN #1422 - an approved report's level stayed editable, so a note moved an accepted node bounty to "critical", freed the
// node for a second 20,000 sat bounty and took reports out of the week's budget; KANBAN #1424 - the report limit per address compared raw IPv6 addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, FEEDBACK_KIND } from '../src/feedback-store.js';
import { feedbackDecide, FEEDBACK_PER_IP_PER_DAY } from '../src/faucet.js';
import { eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const NODE = 'ee'.repeat(32);
const rep = (k, i) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000) - 10 + i, kind: FEEDBACK_KIND,
  tags: [['t', 'bug'], ['source', 'node'], ['node', NODE]], content: JSON.stringify({ happened: `${'x'.repeat(60)} ${i} Steps: opened the owner page.`, expected: 'y' }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };

test('#1422 an approved report keeps its level: no second node bounty for its node through a note; the level is stored normalised', () => {
  const s = openFeedbackStore();
  const a = s.take(rep(key(1), 0)), b = s.take(rep(key(2), 1)), c = s.take(rep(key(3), 2));
  const first = s.approve(a.id, null, { severity: 'Node', played: () => true });
  const note = s.note(a.id, { severity: 'critical' });
  const second = s.approve(b.id, null, { severity: 'node', played: () => true });
  console.log(`  MEASURED #1422: approve "Node" -> stored ${first.report && first.report.severity}; note to critical: ${note.ok ? 'taken' : note.why}; second node bounty for the node: ${second.ok ? 'APPROVED' : second.why}`);
  assert.equal(first.ok, true); assert.equal(first.report.severity, 'node');
  assert.equal(note.ok, false); assert.match(note.why, /level it was approved at stays/);
  assert.equal(second.ok, false); assert.match(second.why, /one node bounty per node/);
  assert.equal(s.note(c.id, { severity: 'high' }).ok, true, 'a new report\'s level can still be noted');
});

test('#1424 the report limit per address counts an IPv6 caller by its /64', () => {
  const log = [];
  let refusedAt = null;
  for (let i = 0; i < FEEDBACK_PER_IP_PER_DAY + 5; i++) {
    const d = feedbackDecide({ text: 'something broke here', ip: `2001:db8:77:1:${i.toString(16)}::1` }, log);
    if (!d.ok) { refusedAt = i; break; }
    log.push({ ip: `2001:db8:77:1:${i.toString(16)}::1`, atMs: Date.now() });
  }
  console.log(`  MEASURED #1424: one /64 with a fresh address each report: refused at report ${refusedAt + 1} (limit ${FEEDBACK_PER_IP_PER_DAY})`);
  assert.equal(refusedAt, FEEDBACK_PER_IP_PER_DAY);
});
