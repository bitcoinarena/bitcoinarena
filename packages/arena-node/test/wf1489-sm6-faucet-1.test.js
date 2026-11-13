// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 sm6-faucet-1 (state machine audit, round 6): move(id, 'rejected') on an accepted report writes two rows apart, with no transaction:
// first its reward link open -> void, then the report accepted -> rejected. A faucet killed between the two (simulated here: the second write
// fails as a kill at that statement would leave it) restarts with an ACCEPTED report whose link is VOID - a pair SM-21/SM-22 never allow:
// the link can never pay (createReward answers the void one again), yet the report still counts as approved in the week's budget and the
// key's 3 a week. The two writes must land together or not at all.
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
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const report = (k, happened) => {
  const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug'], ['game', 'rock-paper-scissors']],
    content: JSON.stringify({ happened: `${happened} Steps: opened the lobby, joined a round, watched the screen.`, expected: 'it to work' }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e;
};

test('#1489 sm6-faucet-1: a kill inside a rejection never leaves an accepted report with a void reward link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm6-faucet-1-'));
  const file = join(dir, 'fb.db');
  const alice = key(7);
  let s = openFeedbackStore(file);
  const e = report(alice, 'The withdraw button did nothing at all after the round settled.');
  assert.equal(s.take(e).ok, true);
  assert.equal(s.approve(e.id, 2000, { played: () => true }).ok, true);
  const w = s.createReward(e.id, { network: 'mainnet' });
  assert.equal(w.ok, true);
  // THE KILL: the report's own write never lands (a process killed after the link's UPDATE and before the report's)
  const other = new DatabaseSync(file);
  other.exec(`CREATE TRIGGER kill_here BEFORE UPDATE OF state ON reports WHEN NEW.state = 'rejected' BEGIN SELECT RAISE(ABORT, 'killed'); END`);
  let threw = null; try { s.move(e.id, 'rejected', { reason: 'not a bug after all', by: 'admin' }); } catch (x) { threw = String(x.message); }
  other.exec('DROP TRIGGER kill_here'); other.close();
  s.close();
  // THE RESTART
  s = openFeedbackStore(file);
  const r = s.report(e.id), link = s.reward(w.reward.k1);
  const again = s.createReward(e.id, { network: 'mainnet' });
  const req = s.withdrawRequest(w.reward.k1, { base: 'https://faucet.example' });
  const b = s.budget();
  console.log('  MEASURED sm6-faucet-1:', JSON.stringify({ threw, report: r.state, link: link.state, again: again.reward && again.reward.state, withdraw: req.status || req.tag, weekApprovedSats: b.weekApprovedSats }));
  // SM-21/SM-22: a void link belongs to a rejected report; an accepted report's link pays
  assert.ok(!(r.state === 'accepted' && link.state === 'void'), `report ${r.state} with its link ${link.state}: approved, counted in the budget, and never payable`);
});
