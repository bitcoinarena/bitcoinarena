// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FIND-ONLY audit (lens: bounty money). Each test asserts the rule; it fails while the hole is open.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as sim from '../src/sim/index.js';
import { checkLevel } from '../src/level-check.mjs';
import { createOpr } from '../server/opr-service.mjs';
import { openBountySeason } from '../../arena-node/src/bounty-season.js';
import { socialCheck } from '../../arena-node/src/bounty-social.js';
import { keypair, proveX, MIN } from './server-helpers.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/candles-30d.json', import.meta.url)));
const day = fx.days[fx.days.length - 1];
const SIM = { GAME_VERSION: sim.GAME_VERSION, buildLevel: sim.buildLevel, runLog: sim.runLog, newWorld: sim.newWorld, stepWorld: sim.stepWorld, botInput: sim.botInput, MAX_STEPS: sim.MAX_STEPS };
const ROUND = '2026-11-23';
const L = sim.buildLevel(day.candles, checkLevel(day.candles, ROUND).seed);
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const seesHazard = (W) => !!sim.botInput(W, { react: 0, jumpFrames: 2, billDist: 40 }).jump;
function humanLike(Lv, seed) {
  const r = rng(seed); let hold = 0, wait = -1, before = false;
  return sim.recordLog(Lv, (W) => {
    const s = seesHazard(W);
    if (s && !before && wait < 0 && hold <= 0 && r() > 0.08) wait = 6 + Math.floor(r() * 19);
    before = s;
    if (wait < 0 && hold <= 0 && r() < 0.004) wait = Math.floor(r() * 4);
    if (wait >= 0 && --wait < 0) hold = 4 + Math.floor(r() * 16);
    if (hold > 0) { hold--; return { jump: true }; }
    return { jump: false };
  }).log;
}
const phoneClient = (seed) => { const r = rng(seed); return { ua: 'Mozilla/5.0 (iPhone)', w: 375, h: 559, touch: true, v: sim.GAME_VERSION, hiddenMs: 0,
  t: { src: { touch: 60, mouse: 0, pen: 0, key: 0 }, taps: 60, jit: 30 + Math.round(r() * 200) / 10, blur: 0, hidden: 0, hiddenMs: 0, first: 900 + Math.round(r() * 900), wd: false, auto: [], dc: 'phone', dpr: 3 } }; };

async function realRound({ maxAttempts } = {}) {
  let t = Date.parse('2026-11-23T01:00:00Z');
  const s2 = openBountySeason(':memory:');
  const chain = { async post(hex) { return createHash('sha256').update(hex).digest('hex'); }, async status() { return { confirmations: 1, height: 5 }; } };
  const opr = createOpr({ now: () => t, sim: SIM, fetchCandles: async () => day.candles, checkLevel, invoices: null, chain, s2, log: () => {}, lnCheck: async (a) => ({ ok: true, address: a }),
    cfg: { showTest: true, daily: true, firstDay: ROUND, bountySats: 2000, entrySats: 0, ...(maxAttempts ? { maxAttempts } : {}), adminSha: createHash('sha256').update('x').digest('hex') } });
  await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.roundRow(ROUND);
  assert.equal(r.state, 'ready');
  const play = async (pk, log, client) => {
    const s = await opr.startAttempt(pk, { round: r.id });
    if (!s.ok) return s;
    t += 181000;
    return opr.submit(pk, { attempt: s.attempt, token: s.token, log, client });
  };
  const endAndList = async () => { t = r.end_ms; await opr.tick(); t += 61 * MIN; await opr.tick(); };
  return { opr, s2, r, play, endAndList, clock: { add: (ms) => { t += ms; }, now: () => t } };
}
const bountyOf = (w) => w.opr.listsOf(w.r.id).find((l) => l.kind === 'bounty');

// F1: the X check that "places" a player for the 2,000 real sats accepts a link made by only TYPING someone else's handle (proof 'name').
test('F1 a key that typed a stranger\'s X handle is not placed and takes no real-sat bounty', async () => {
  const w = await realRound();
  const mallory = keypair(), alice = keypair();
  // the faucet's POST /feedback/social: the resolver finds the typed handle as a real @bitcoinarena follower (the victim's), nothing ties it to mallory
  const resolvers = { x: async (name) => ({ userId: '424242', username: name, member: true }) };
  const sc = await socialCheck(w.s2, mallory.pk, { x: 'alice_real_human' }, resolvers);
  assert.equal(sc.results.x.member, true);
  assert.equal(w.s2.links(mallory.pk)[0].proof, 'name');
  assert.equal((await w.opr.saveLnAddress(mallory.pk, 'mallory@walletofsatoshi.com')).ok, true);
  // mallory is a script with human-shaped noise: best of a few seeds
  for (const seed of [1, 2, 3]) assert.equal((await w.play(mallory.pk, humanLike(L, seed), phoneClient(seed))).ok, true);
  void alice;
  await w.endAndList();
  const b = bountyOf(w);
  const placed = w.opr.xOf(mallory.pk).placed;
  assert.equal(placed, false, 'an X link by typed name only (proof "name") must not place a player for real sats');
  assert.notEqual(b.rows[0] && b.rows[0].player, mallory.pk, `bounty row: ${JSON.stringify(b.rows[0] && { player: b.rows[0].player.slice(0, 8), x: b.rows[0].xAccount, sats: b.rows[0].sats })}`);
});

// F2: "He can still verify until 1 hour after the round ends" (#3250) - not enforced: any later POST /lnaddress rebuilds every waiting list with
// today's X links, so a player who linked X days after the round displaces the rightful winner on the waiting bounty list.
test('F2 an X account linked after end+1h does not take the bounty when a later /lnaddress rebuilds the waiting list', async () => {
  const w = await realRound();
  const late = keypair(), honest = keypair(), stranger = keypair();
  let xn = 0;
  const link = (pk) => { xn++; assert.equal(proveX(w.s2, pk, { userId: `u${xn}`, username: `user${xn}`, nowMs: w.clock.now() }).ok, true); w.s2.record(pk, 'x', { member: true, nowMs: w.clock.now() }); };
  link(honest.pk);
  for (const k of [late, honest]) assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  // late plays better (more seeds), but has no X account by the grace
  let lateBest = -1, honestBest = -1;
  for (const seed of [11, 12, 13, 14, 15]) { const o = await w.play(late.pk, humanLike(L, seed), phoneClient(seed)); assert.equal(o.ok, true); lateBest = Math.max(lateBest, o.score.total); }
  for (const seed of [21]) { const o = await w.play(honest.pk, humanLike(L, seed), phoneClient(seed)); assert.equal(o.ok, true); honestBest = Math.max(honestBest, o.score.total); }
  assert.ok(lateBest > honestBest, `${lateBest} > ${honestBest}`);
  await w.endAndList();
  assert.equal(bountyOf(w).rows[0].player, honest.pk);   // the list at end+1h: rightful winner
  // two days later: late links X, then anyone (a stranger) saves a Lightning address - every waiting list is rebuilt
  w.clock.add(2 * 24 * 60 * MIN);
  link(late.pk);
  assert.equal((await w.opr.saveLnAddress(stranger.pk, 'someone@walletofsatoshi.com')).ok, true);
  const b = bountyOf(w);
  assert.equal(b.rows[0].player, honest.pk, `after the rebuild the bounty row names ${b.rows[0].player === late.pk ? 'the player who linked X two days late' : 'someone else'}`);
});

// F3: the approval binds to nothing the owner saw: POST /admin/list { round, kind, action } approves whatever the list holds at that moment, and
// the waiting list is rewritten by any player's /lnaddress (refreshLists of every waiting list). The owner reviews B, approves A.
test('F3 approving a list approves the rows the owner reviewed, not a rebuild made in between', async () => {
  const w = await realRound();
  const a = keypair(), b = keypair();
  let xn = 0;
  const link = (pk) => { xn++; assert.equal(proveX(w.s2, pk, { userId: `v${xn}`, username: `name${xn}`, nowMs: w.clock.now() }).ok, true); w.s2.record(pk, 'x', { member: true, nowMs: w.clock.now() }); };
  link(b.pk);
  for (const k of [a, b]) assert.equal((await w.opr.saveLnAddress(k.pk, `q${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  for (const seed of [31, 32, 33, 34, 35]) assert.equal((await w.play(a.pk, humanLike(L, seed), phoneClient(seed))).ok, true);
  assert.equal((await w.play(b.pk, humanLike(L, 41), phoneClient(41))).ok, true);
  await w.endAndList();
  const seen = bountyOf(w);   // what the admin page showed (GET /admin/lists)
  assert.equal(seen.rows[0].player, b.pk);
  // between view and click: a links X and re-saves its own address (allowed any time), the waiting list is rebuilt
  link(a.pk);
  assert.equal((await w.opr.saveLnAddress(a.pk, `q${a.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
  const late = w.opr.decideList({ round: w.r.id, kind: 'bounty', action: 'approve', by: 'owner', version: seen.version });   // the version the owner saw (#3287)
  const d = late.ok ? late : w.opr.decideList({ round: w.r.id, kind: 'bounty', action: 'approve', by: 'owner', version: bountyOf(w).version });
  assert.equal(d.ok, true);
  if (!late.ok) assert.match(late.why, /changed since you opened it/);
  assert.deepEqual(d.list.rows.map((x) => x.player), seen.rows.map((x) => x.player), 'the approved bounty row is not the one the owner reviewed');
});

// F4: the 5 attempts are per Nostr key, the bounty per X account: one human plays on N fresh keys (5 each) and binds the one X account to the
// best key within the hour after the round. 15 tries behind one X account, the best of them takes the 2,000 sats.
test('F4 one X account gets no more than the round\'s 5 attempts toward the bounty (keys made for free)', async () => {
  const w = await realRound();
  const keys = [keypair(), keypair(), keypair()];
  const best = new Map();
  let seed = 100;
  for (const k of keys) {
    assert.equal((await w.opr.saveLnAddress(k.pk, `s${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true);
    for (let i = 0; i < 5; i++) { const o = await w.play(k.pk, humanLike(L, seed), phoneClient(seed)); seed++; assert.equal(o.ok, true, o.why); best.set(k.pk, Math.max(best.get(k.pk) ?? -1, o.score.total)); }
  }
  const [top] = [...best].sort((x, y) => y[1] - x[1]);
  // the round ends; inside the grace the one X account is linked to the best key
  w.clock.add(0);
  const now = w.clock.now();
  void now;
  const r = w.r;
  // end, then 30 min into the grace: link, then the lists at end+1h
  w.clock.add(r.end_ms - w.clock.now() + 30 * MIN);
  await w.opr.tick();
  assert.equal(proveX(w.s2, top[0], { userId: 'one-human', username: 'one_human', nowMs: w.clock.now() }).ok, true); w.s2.record(top[0], 'x', { member: true, nowMs: w.clock.now() });
  w.clock.add(31 * MIN); await w.opr.tick();
  const b = bountyOf(w);
  // the attack wins when the best key, linked after all 15 runs, takes the bounty row (#3288 fix: a key is placed only with a link made before its first run)
  const triesBehindX = keys.reduce((n, k) => n + w.opr.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE round = ? AND player = ?').get(r.id, k.pk).n, 0);
  assert.ok(!(b.rows[0] && b.rows[0].player === top[0]), `the bounty winner's X account had ${triesBehindX} attempts (on ${keys.length} keys) - the round allows 5`);
  assert.match(w.opr.xOf(top[0], r).why || '', /after your first run/);
});
