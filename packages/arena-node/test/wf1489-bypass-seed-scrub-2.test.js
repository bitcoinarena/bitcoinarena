// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 bypass of #1472: the store keeps the signed event as received (event column) - the seed the scrubber removed from 'happened' is still in the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openFeedbackStore, scrubKeys, FEEDBACK_KIND } from '../src/feedback-store.js';
import { feedbackDecide } from '../src/faucet.js';
import { eventId } from '../src/nostr-relay.js';
const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, content, tags = [['t', 'bug']]) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags, content }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const W = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const STEPS = ' Steps: opened the lobby, joined a round, watched the screen and waited.';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
test('wf1489-2 a lowercase seed the scrubber removes from happened is not kept in the stored report at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-2-')), file = join(dir, 'fb.sqlite');
  try {
    const s = openFeedbackStore(file);
    const e = signed(key(1), JSON.stringify({ happened: `Withdraw failed. My seed: ${W.join(' ')}.${STEPS}`, expected: 'it to work' }));
    const r = s.take(e); assert.equal(r.ok, true, r.why);
    assert.ok(!s.report(e.id).happened.includes('absorb abstract'), 'happened is scrubbed (the fix)');
    const db = new DatabaseSync(file);
    const raw = JSON.stringify(db.prepare('SELECT * FROM reports').all());
    db.close();
    assert.ok(!raw.includes('absorb abstract absurd'), 'the stored report file still holds the seed phrase (reports.event, unscrubbed)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('#1590 the kept event keeps id, sig, the read tags and the address; debug and odd fields scrubbed; an old file is rewritten on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1590-')), file = join(dir, 'fb.sqlite');
  const seed = W.join(' '), caps = W.map((w, i) => `${i + 1}. ${w[0].toUpperCase()}${w.slice(1)}`).join(', ');
  try {
    const s = openFeedbackStore(file);
    const e = signed(key(2), JSON.stringify({ happened: `Withdraw failed, nothing moved.${STEPS}`, expected: 'it to work', debug: `log line\n${caps}\nend`, lnAddress: 'me@example.com', extra: { note: seed } }),
      [['t', 'bug'], ['build', '1.9.27'], ['lud16', 'pay@example.com'], ['x', seed]]);
    assert.equal(s.take(e).ok, true);
    const got = s.report(e.id);
    assert.ok(got.debug.includes('log line') && !/Absorb|absorb/.test(got.debug));
    assert.equal(s.addressOf(e.id), 'pay@example.com');
    assert.equal(got.build, '1.9.27');
    s.close();
    // a file written before the fix: the raw event put back by hand, then the store opened again
    const db = new DatabaseSync(file);
    db.prepare('UPDATE reports SET event = ? WHERE id = ?').run(JSON.stringify(e), e.id);
    db.close();
    const s2 = openFeedbackStore(file);
    const kept = JSON.parse(new DatabaseSync(file).prepare('SELECT event FROM reports WHERE id = ?').get(e.id).event);
    assert.equal(kept.id, e.id); assert.equal(kept.sig, e.sig); assert.equal(kept.pubkey, e.pubkey);
    assert.equal(s2.addressOf(e.id), 'pay@example.com');
    s2.close();
    for (const f of [file, `${file}-wal`]) if (existsSync(f)) {
      const bytes = readFileSync(f).toString('latin1');
      assert.ok(!bytes.includes('absorb abstract absurd') && !bytes.includes('Absorb, 8. Abstract'), `${f} still holds the seed`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
