// Audit opr a8-1-1: gap in #3283 / #3355 / #3582. The log of a run is bounded (refused junk keeps no log, every kept log counts against its
// network's budget), but the run's page telemetry (body.client) is stored for EVERY submit - a malformed refusal too - and clientText "cuts it to
// 2,000 chars" only for the fields outside `t`: a long t.src (or t.jit, t.dc, t.auto[0..5]) is kept whole, up to the 256 KB body limit. A junk
// submit right after the start stores ~250 KB per attempt; one address opens ~100 never-kept first attempts per round (ipUnplayedShare), and
// an IPv6 /48 holds 65,536 /64s: the shared disk fills through the client column, no budget counts it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, openRound, keypair, MIN } from './server-helpers.mjs';

test('a run\'s stored page telemetry stays within 2,000 chars, a malformed refusal\'s too (#3283, #3355 bound what a free key stores)', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z', cfg: { entrySats: 0, daily: false } });
  const made = w.opr.testRound({ minutes: 60, chartDay: '2026-11-21' });
  assert.equal(made.ok, true, made.why);
  const r = await openRound(w, made.round.id);
  assert.equal(r.state, 'ready');
  const big = 'x'.repeat(250 * 1024);
  let stored = 0, rows = 0;
  for (let i = 0; i < 20; i++) {
    const kp = keypair(), ip = `2001:db8:1:${(i + 1).toString(16)}::1`;   // one /48, a /64 each
    const s = await w.opr.startAttempt(kp.pk, { round: r.id, ip });
    assert.equal(s.ok, true, s.why);
    // junk log: refused at once as malformed, nothing of the log is kept - but the client is
    const out = w.opr.submit(kp.pk, { attempt: s.attempt, token: s.token, log: { junk: 1 }, client: { t: { src: big } } }, { ip });
    assert.equal(out.ok, false);
    const row = w.opr.db.prepare('SELECT state, log, LENGTH(client) AS n FROM attempts WHERE id = ?').get(s.attempt);
    assert.equal(row.log, null, 'the junk log is not kept');
    stored += row.n || 0; rows++;
  }
  const most = w.opr.db.prepare('SELECT MAX(LENGTH(client)) AS m FROM attempts WHERE round = ?').get(r.id).m;
  console.log(`one /48: ${rows} junk refusals stored ${stored} bytes of client telemetry (largest ${most})`);
  assert.ok(most <= 2000, `a refused junk submit stored ${most} chars of page telemetry (cut to 2,000 expected)`);
});

test('#3736 keeps what the bot pass reads: a long telemetry is cut, its t counts, automation hints and device class stay', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z', cfg: { entrySats: 0, daily: false } });
  const made = w.opr.testRound({ minutes: 60, chartDay: '2026-11-21' });
  const r = await openRound(w, made.round.id);
  const kp = keypair(), ip = '2001:db8:2:1::1';
  const s = await w.opr.startAttempt(kp.pk, { round: r.id, ip });
  const client = { ua: 'u'.repeat(5000), w: 390, h: 844, pad: 'p'.repeat(3000),
    t: { src: { touch: 3, mouse: 0, pen: 0, key: 0, more: 'm'.repeat(3000) }, taps: 9, jit: 0.4, wd: false, auto: ['headless', 'z'.repeat(3000)], dc: 'phone', dpr: 3, junk: 'j'.repeat(3000) } };
  assert.equal(w.opr.submit(kp.pk, { attempt: s.attempt, token: s.token, log: { junk: 1 }, client }, { ip }).ok, false);
  const text = w.opr.db.prepare('SELECT client FROM attempts WHERE id = ?').get(s.attempt).client;
  assert.ok(text.length <= 2000, `stored ${text.length} chars`);
  const c = JSON.parse(text);
  assert.deepEqual(c.t.src, { touch: 3, mouse: 0, pen: 0, key: 0 });
  assert.equal(c.t.taps, 9); assert.equal(c.t.jit, 0.4); assert.equal(c.t.dc, 'phone'); assert.equal(c.t.dpr, 3); assert.equal(c.t.wd, false);
  assert.equal(c.t.auto[0], 'headless'); assert.equal(c.t.auto[1].length, 40);
  assert.equal(c.t.junk, undefined);
  // a short telemetry is kept as sent
  const kp2 = keypair(), s2 = await w.opr.startAttempt(kp2.pk, { round: r.id, ip: '2001:db8:2:2::1' });
  const small = { ua: 'Mozilla/5.0', w: 390, h: 844, t: { src: { touch: 1, mouse: 0, pen: 0, key: 0 }, taps: 1, auto: [], dc: 'phone' } };
  w.opr.submit(kp2.pk, { attempt: s2.attempt, token: s2.token, log: { junk: 1 }, client: small }, { ip: '2001:db8:2:2::1' });
  assert.deepEqual(JSON.parse(w.opr.db.prepare('SELECT client FROM attempts WHERE id = ?').get(s2.attempt).client), small);
});
