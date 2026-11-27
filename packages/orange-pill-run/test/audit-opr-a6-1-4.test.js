// Audit opr round 6-1 finding 4: the #3283 fix bounds attempts per address (ipKey: one IPv4 or one IPv6 /64, 2 x the round's attempts) and stops
// storing junk logs - but a refused run whose log is WELL FORMED is still kept in full (reject keepLog: a wrong game version, too fast, not
// replaying), up to logPressesMost = 6,000 presses (5,000 here, ~60 KB) each, and an IPv6 /48 (or /56) that any VPS gets holds 65,536 (256) /64s, each
// a fresh address for the cap. One host fills the shared disk again. The safe behaviour: one network block cannot store more than a few MB
// of refused logs in a round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { world, keypair, MIN } from './server-helpers.mjs';

test('one IPv6 /48 stores refused full-size logs past the per-address cap of #3283', async () => {
  const w = world({ start: '2026-11-23T00:00:00Z', cfg: { entrySats: 0 } });
  w.clock.set(Date.parse('2026-11-23T00:00:00Z') + MIN);
  await w.opr.tick(); await w.opr.tick(); w.chain.confirm(); await w.opr.tick();
  const r = w.opr.currentRound();
  // a well-formed log at the size limit, of another game version: refused, kept
  const presses = Array.from({ length: 5000 }, (_, i) => [i * 2, i * 2 + 1]);   // 5,000 presses inside the run's 10,800 steps
  const big = { v: 'opr-9-not-this-one', presses };
  let refused = 0, kept = 0;
  for (let n = 0; n < 60; n++) {   // 60 of the /48's 65,536 /64s
    const ip = `2001:db8:77:${n.toString(16)}::${randomBytes(2).toString('hex')}`;
    for (let k = 0; k < 2; k++) {
      const kp = keypair();
      for (let a = 0; a < r.max_attempts; a++) {
        const s = await w.opr.startAttempt(kp.pk, { round: r.id, ip });
        if (!s.ok) break;
        const out = w.opr.submit(kp.pk, { attempt: s.attempt, token: s.token, log: big }, { ip });
        if (!out.ok) refused++;
      }
    }
  }
  const row = w.opr.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(log)), 0) AS bytes FROM attempts WHERE round = ? AND state = 'rejected' AND log IS NOT NULL").get(r.id);
  kept = row.n;
  const mb = row.bytes / 1e6;
  console.log(`one /48 (60 of its /64s): ${refused} refused runs, ${kept} logs kept, ${mb.toFixed(1)} MB - the whole /48 would keep ${(mb * 65536 / 60 / 1000).toFixed(0)} GB per daily round`);
  assert.ok(mb < 5, `one IPv6 /48 kept ${mb.toFixed(1)} MB of refused logs from 60 of its 65,536 /64s (${kept} logs of ~${(row.bytes / Math.max(1, kept) / 1000).toFixed(0)} KB) - the per-/64 cap of #3283 does not bound a network`);
});
