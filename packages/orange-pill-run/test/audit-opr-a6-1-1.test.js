// Audit opr round 6-1 finding 1: the all-keys-together minute caps of #3333 (lnChecksPerMinAll, xChecksPerMinAll) are shared by every caller.
// A stranger with free fresh keys fills them each minute, so no honest player can save a Lightning address or link X: the bounty skips the
// honest best player and goes to the attacker (or lapses). The safe behaviour: a stranger's fresh keys cannot refuse an honest player's save.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { world, keypair, logOf, MIN } from './server-helpers.mjs';

const freshKey = () => randomBytes(32).toString('hex');

test('a stranger filling the global Lightning-address minute cannot keep the honest best player off the bounty', async () => {
  const xs = new Map([['honest', 'x-honest'], ['attacker', 'x-attacker']]);
  const w = world({ start: '2026-11-23T00:00:00Z', cfg: { entrySats: 0 }, xAccounts: xs });
  w.clock.set(Date.parse('2026-11-23T00:00:00Z') + MIN);
  await w.opr.tick(); await w.opr.tick(); w.chain.confirm(); await w.opr.tick();
  const r = w.opr.currentRound();
  const H = keypair().pk, A = keypair().pk;
  assert.equal((await w.opr.saveX(H, 'honest')).ok, true);
  w.clock.add(20000);
  assert.equal((await w.opr.saveX(A, 'attacker')).ok, true);
  w.clock.add(MIN);
  const sh = await w.opr.startAttempt(H, { round: r.id, ip: '203.0.113.5' });
  const sa = await w.opr.startAttempt(A, { round: r.id, ip: '198.51.100.7' });
  w.clock.add(70000);
  assert.ok(w.opr.submit(H, { attempt: sh.attempt, token: sh.token, log: logOf(30) }, {}).ok);
  assert.ok(w.opr.submit(A, { attempt: sa.attempt, token: sa.token, log: logOf(20) }, {}).ok);
  assert.equal((await w.opr.saveLnAddress(A, 'attacker@walletofsatoshi.com')).ok, true);   // the attacker saved its own address early
  w.clock.set(r.end_ms); await w.opr.tick();
  // the grace hour: each minute the attacker's fresh keys use the shared 60 wallet asks first, then the honest winner tries to save its address
  const refusals = [];
  for (let m = 0; m < 59; m++) {
    w.clock.set(r.end_ms + m * MIN + 1000);
    for (let i = 0; i < w.opr.cfg.lnChecksPerMinAll; i++) await w.opr.saveLnAddress(freshKey(), `junk${m}x${i}@example.com`);
    w.clock.add(1000);
    const h = await w.opr.saveLnAddress(H, 'honest@walletofsatoshi.com');
    if (h.ok) break;
    refusals.push(`${h.code} ${h.why}`);
  }
  w.clock.set(r.end_ms + 61 * MIN); await w.opr.tick();
  const bounty = w.opr.listsOf(r.id).find((x) => x.kind === 'bounty');
  assert.ok(bounty, 'the bounty list is written');
  assert.equal(bounty.rows[0] && bounty.rows[0].player, H,
    `the honest best player (score 300) lost the bounty to the attacker (score 200): its address save was refused ${refusals.length} times in the grace hour (${refusals[0]})`);
});

test('a stranger filling the global X-check minute cannot keep an honest player from linking X before its first run', async () => {
  const xs = new Map([['honest', 'x-honest']]);
  const w = world({ start: '2026-11-23T00:00:00Z', cfg: { entrySats: 0 }, xAccounts: xs });
  w.clock.set(Date.parse('2026-11-23T00:00:00Z') + MIN);
  await w.opr.tick(); await w.opr.tick(); w.chain.confirm(); await w.opr.tick();
  const H = keypair().pk;
  for (let i = 0; i < w.opr.cfg.xChecksPerMinAll; i++) await w.opr.saveX(freshKey(), `nobody${i}`);   // any well-formed name is counted, found or not
  w.clock.add(1000);
  const h = await w.opr.saveX(H, 'honest');
  assert.equal(h.ok, true, `the honest player's X link was refused by the strangers' fresh keys: ${h.code} ${h.why}`);
});
