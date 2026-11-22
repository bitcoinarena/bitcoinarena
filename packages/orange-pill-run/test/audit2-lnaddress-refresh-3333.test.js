// #3333 (audit 2 #3330): a POST /lnaddress from a fresh key no longer rebuilds every waiting payout list - cost measured
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, keypair, logOf, MIN } from './server-helpers.mjs';

test('AUDIT2 one POST /lnaddress by a stranger rebuilds every waiting list: cost grows with all the listed rounds\' runs', async () => {
  const w = world({ start: '2026-11-23T00:00:00Z', cfg: { entrySats: 0, ipAttemptsShare: 1e9 } });
  const P = Number(process.env.AUDIT_PLAYERS || 1500), DAYS = Number(process.env.AUDIT_DAYS || 3);
  for (let d = 0; d < DAYS; d++) {
    w.clock.set(Date.parse('2026-11-23T00:00:00Z') + d * 86400000 + MIN);
    await w.opr.tick(); await w.opr.tick(); w.chain.confirm(); await w.opr.tick();
    const r = w.opr.currentRound();
    const open = [];
    for (let i = 0; i < P; i++) {
      const kp = keypair();
      const s = await w.opr.startAttempt(kp.pk, { round: r.id, ip: `198.51.${i >> 8}.${i & 255}` });
      assert.ok(s.ok, s.why);
      open.push([kp, s, i]);
    }
    w.clock.add(70000);
    for (const [kp, s, i] of open) { const sub = w.opr.submit(kp.pk, { attempt: s.attempt, token: s.token, log: logOf(12 + (i % 40)) }, {}); assert.ok(sub.ok, sub.why); }
  }
  w.clock.set(Date.parse('2026-11-23T00:00:00Z') + DAYS * 86400000 + 2 * 3600000);
  await w.opr.tick();
  const waiting = w.opr.db.prepare("SELECT COUNT(*) AS n FROM payout_lists WHERE state = 'waiting'").get().n;
  const N = 5, t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { const kp = keypair(); const r = await w.opr.saveLnAddress(kp.pk, `stranger${i}@example.com`); assert.ok(r.ok); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`#3330 ${DAYS} listed rounds x ${P} players, ${waiting} waiting lists: one stranger's POST /lnaddress holds the service ${ms.toFixed(0)} ms (synchronous)`);
  assert.ok(ms < 50, `a stranger's address save rebuilds every waiting list: ${ms.toFixed(0)} ms of blocked event loop per request, from free keys at 10 per key and hour`);
});

test('#3333 a save by a key on a waiting list still rebuilds that list; all keys together get at most lnChecksPerMinAll wallet asks a minute', async () => {
  const w = world({ start: '2026-11-23T00:00:00Z', cfg: { entrySats: 0, lnChecksPerMinAll: 3 } });
  w.clock.set(Date.parse('2026-11-23T00:00:00Z') + MIN);
  await w.opr.tick(); await w.opr.tick(); w.chain.confirm(); await w.opr.tick();
  const r = w.opr.currentRound(), kp = keypair();
  w.link(kp.pk);
  const s = await w.opr.startAttempt(kp.pk, { round: r.id }); w.clock.add(70000);
  assert.ok(w.opr.submit(kp.pk, { attempt: s.attempt, token: s.token, log: logOf(20) }, {}).ok);
  w.clock.set(r.end_ms); await w.opr.tick(); w.clock.add(60 * MIN); await w.opr.tick();   // lists written; the address still in time
  const bounty = () => w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  assert.equal(bounty().rows.length, 0, 'no address yet: nobody on the list');
  assert.equal((await w.opr.saveLnAddress(kp.pk, 'me@walletofsatoshi.com')).ok, true);
  assert.equal(bounty().rows[0].player, kp.pk, 'the saving key\'s own list is rebuilt');
  for (let i = 0; i < 2; i++) assert.equal((await w.opr.saveLnAddress(keypair().pk, `a${i}@walletofsatoshi.com`)).ok, true);
  const all = await w.opr.saveLnAddress(keypair().pk, 'b@walletofsatoshi.com');
  assert.equal(all.code, 429); assert.match(all.why, /right now/);
  w.clock.add(MIN + 1);
  assert.equal((await w.opr.saveLnAddress(keypair().pk, 'b@walletofsatoshi.com')).ok, true);
});
