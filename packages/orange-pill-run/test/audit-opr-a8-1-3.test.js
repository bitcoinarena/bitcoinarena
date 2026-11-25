// Audit opr a8-1-3 (gap in the #3597 fix, the #3353 pattern again): the X lookups in flight are bounded per caller address (xInFlightPerCaller 1)
// AND for the whole service (xInFlightMost 5), first come first served, with no room kept for anyone (opr-service.mjs:785). The X client answers
// one call per 3 s (bounty-verify.js spaced(3000)), so a stranger with five addresses (five IPv6 /64s of one /48, or five IPv4s) who sends the
// next POST /x from a fresh key as soon as its last one is answered - about 4 a minute per address, far inside the per-caller minute cap of 15 -
// holds all five slots for as long as he likes. Every honest POST /x is refused 429 'X is being asked for others right now'. A key is placed
// only with an X link made before its first run of the round (#3281), so an honest newcomer cannot be placed for the bounty that day.
// The safe behaviour: a stranger's lookups never take every X slot - an honest player's POST /x is answered while they go on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createOpr } from '../server/opr-service.mjs';
import { xByName, spaced } from '../../arena-node/src/bounty-verify.js';
import { stubSim, candles48 } from './server-helpers.mjs';

test("five stranger addresses that keep one POST /x each in flight do not lock every honest player out of the X check", async () => {
  const t = Date.parse('2026-11-23T10:00:00Z');
  const ids = new Map();
  const fetchFn = async (url) => { const name = new URL(url).searchParams.get('target_screen_name'); if (!ids.has(name)) ids.set(name, String(1000 + ids.size));
    return { status: 200, json: async () => ({ relationship: { target: { id_str: ids.get(name), screen_name: name, following: true } } }) }; };
  const xLookup = xByName({ session: async () => ({ ct0: 'c', cookie: 'auth_token=a; ct0=c' }), fetchFn, gap: spaced(3000) });   // the production X client
  const opr = createOpr({ now: () => t, sim: stubSim, fetchCandles: async (d) => candles48(d), checkLevel: async () => ({ ok: true, seed: 7, tries: 1, hash: 'h' }),
    xLookup, lnCheck: async (a) => ({ ok: true, address: a }), log: () => {}, cfg: { entrySats: 0 } });
  await opr.tick(); await opr.tick();
  let stop = false, strangerDone = 0;
  // five stranger addresses (five /64s of one /48), each keeps one POST /x in flight: a fresh key per call
  const loops = Array.from({ length: 5 }, (_, k) => (async () => {
    let i = 0;
    while (!stop) { const r = await opr.saveX(randomBytes(32).toString('hex'), `s${k}_${i++}`, { ip: `2001:db8:7:${k + 1}::9` }); if (r.ok) strangerDone++; else await new Promise((ok) => setTimeout(ok, 50)); }
  })());
  await new Promise((ok) => setTimeout(ok, 100));
  // honest players, each from an address of its own, press Check every 2 s for 21 s
  const honest = [];
  const t0 = performance.now();
  for (let n = 0; performance.now() - t0 < 21000; n++) {
    const r = await opr.saveX(randomBytes(32).toString('hex'), `honest_${n}`, { ip: `198.51.100.${n + 1}` });
    honest.push(r.ok ? 'ok' : `${r.code} ${r.why}`);
    if (r.ok) break;
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  stop = true;
  await Promise.allSettled(loops);
  const okN = honest.filter((x) => x === 'ok').length;
  console.log(`21 s: strangers linked ${strangerDone} keys; honest checks: ${honest.length} tried, ${okN} answered - ${[...new Set(honest)].join(' | ')}`);
  assert.ok(okN >= 1, `no honest POST /x was answered in 21 s while five stranger addresses kept one lookup each in flight: ${honest.length} tries, every one '${honest[0]}'`);
});
