// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3332 (audit 2 #3330; owner 2026-11-22 "Ja"): a run that is suspiciously strong or inhumanly precise is flagged and held; the list it would
// be paid from waits for the owner's decision (approve = POST /admin/review clear, or disqualify) - nobody below it moves up before that.
// Reference: test-4 and test-5 as the real players played them on the stage (fixtures/opr-live-runs-3332.json, players renamed), and the
// audit's searched run of test-5 (954 points; the best human 413), jittered so that the bot likelihood alone rates it 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as sim from '../src/sim/index.js';
import { createOpr } from '../server/opr-service.mjs';
import { runFeatures, scoreRun, strongRuns, HOLD_ABOVE, STRONG_RATIO, CEILING_SHARE } from '../server/opr-botscore.mjs';
import { ceilingInWorker } from '../server/opr-ceiling.mjs';
import { bestPerPlayer } from '../server/opr-payout.mjs';
import { openBountySeason } from '../../arena-node/src/bounty-season.js';
import { keypair, proveX } from './server-helpers.mjs';

const F = JSON.parse(fs.readFileSync(new URL('./fixtures/opr-live-runs-3332.json', import.meta.url)));
const levelOf = (id) => { const R = F.rounds[id]; return sim.buildLevel(R.candles, R.seed, R.version); };
const simOf = (v) => ({ GAME_VERSION: v, buildLevel: sim.buildLevel, runLog: sim.runLog, newWorld: sim.newWorld, stepWorld: sim.stepWorld, botInput: sim.botInput, MAX_STEPS: sim.MAX_STEPS });
const phone = { ua: 'Mozilla/5.0 (iPhone)', w: 390, h: 844, t: { src: { touch: 80, mouse: 0, pen: 0, key: 0 }, taps: 40, jit: 9.4, blur: 0, hidden: 0, hiddenMs: 0, first: 640, wd: false, auto: [], dc: 'phone', dpr: 3 } };
const boardOf = (runs) => bestPerPlayer(runs.map((r, i) => ({ player: r.player, attempt: `a${i}`, total: r.total, timeS: r.timeS, submittedMs: i })));

test('#3332 the fixture replays as played: test-4/test-5 humans and the searched 954 run', () => {
  for (const id of ['test-4', 'test-5']) { const L = levelOf(id); for (const r of F.rounds[id].runs) assert.equal(sim.runLog(L, r.log).total, r.total); }
  const s = sim.runLog(levelOf('test-5'), F.searched.log);
  assert.equal(s.total, 954); assert.equal(s.finished, true); assert.equal(s.deaths, 0);
});

// the level's ceiling, once per level for the whole file (the service runs the same search in a worker thread)
const ceilings = new Map();
const ceilingFor = (id) => { if (!ceilings.has(id)) { const R = F.rounds[id]; ceilings.set(id, ceilingInWorker(R.candles, R.seed, R.version)); } return ceilings.get(id); };

test('#3332 the level\'s ceiling: the service\'s search reaches 1034 on test-4 and 939 on test-5 (in a worker thread)', async () => {
  assert.deepEqual(await ceilingFor('test-4'), { total: 1034, timeS: 22.983, finished: true, steps: 163224 });
  const c5 = await ceilingFor('test-5');
  assert.equal(c5.total, 939);
});

test('#3332 strength: the searched run is near the level\'s ceiling and far above the field below it; no real player\'s best run on test-4 or test-5 is', async () => {
  const C = { 'test-4': (await ceilingFor('test-4')).total, 'test-5': (await ceilingFor('test-5')).total };
  const t5 = boardOf([...F.rounds['test-5'].runs, { player: 'searched', total: 954, timeS: 23.083 }]);
  const s5 = strongRuns(t5, { ceiling: C['test-5'] });
  assert.deepEqual([...s5.keys()], ['searched']);
  assert.equal(s5.get('searched').ref, 413);
  assert.equal(s5.get('searched').why, 'suspiciously strong: 954 points - 102 % of what a search of this level reaches (939), 2.3x the best unflagged run below it (413)');
  assert.ok(strongRuns(t5).has('searched'), 'the field alone holds it too');
  for (const id of ['test-4', 'test-5']) {
    assert.equal(strongRuns(boardOf(F.rounds[id].runs), { ceiling: C[id] }).size, 0, id);
    for (const r of F.rounds[id].runs) assert.ok(r.total < CEILING_SHARE * C[id] * 0.95, `${id} ${r.player} ${r.total} of ${C[id]}`);   // every real run, with room
  }
  // a ladder of searched keys lifts the field (954 over 700 over 413: neither gap is 2x) - the ceiling still holds the top one
  const ladder = boardOf([...F.rounds['test-5'].runs, { player: 'searched', total: 954, timeS: 23.1 }, { player: 'helper', total: 700, timeS: 26 }]);
  assert.equal(strongRuns(ladder).size, 0);
  assert.deepEqual([...strongRuns(ladder, { ceiling: C['test-5'] }).keys()], ['searched']);
  // a flagged-as-bot run below is not the field
  const t5c = boardOf([...F.rounds['test-5'].runs, { player: 'searched', total: 954, timeS: 23.1 }, { player: 'bot', total: 900, timeS: 24 }]);
  assert.ok(strongRuns(t5c, { flagged: (p) => p === 'bot' }).has('searched'));
  // the ratio needs a margin and a finished run below: 30 points over 3 is not strong, nor 198 over an unfinished 40
  assert.equal(strongRuns(boardOf([{ player: 'a', total: 30, timeS: 50 }, { player: 'b', total: 3, timeS: 50 }])).size, 0);
  assert.equal(strongRuns([{ player: 'a', total: 198, attempt: 'x' }, { player: 'b', total: 40, attempt: 'y', finished: false }]).size, 0);
  assert.equal(STRONG_RATIO, 2); assert.equal(CEILING_SHARE, 0.85);
});

test('#3332 precision: inputs on a fixed step grid (an unjittered search) are inhumanly precise; no real player\'s run is', () => {
  const L5 = levelOf('test-5');
  // the beam search's own output before the audit jittered it: every press goes down and up on a multiple of 4 steps
  const grid = { v: F.searched.log.v, presses: [] };
  for (const [d, u] of F.searched.log.presses) {
    const a = Math.round(d / 4) * 4, b = a + 4 * Math.max(1, Math.round((u - d) / 4)), last = grid.presses[grid.presses.length - 1];
    if (!last || a > last[1]) grid.presses.push([a, b]);
  }
  const fg = runFeatures(simOf('opr-3'), L5, grid);
  assert.equal(fg.gridK, 4); assert.equal(fg.gridShare, 1);
  const sg = scoreRun({ feat: fg, client: phone });
  assert.ok(sg.score > HOLD_ABOVE, JSON.stringify(sg));
  assert.match(sg.reasons[0].why, /inhumanly precise: .*4-step grid/);
  for (const id of ['test-4', 'test-5']) {
    const L = levelOf(id), S = simOf(F.rounds[id].version);
    for (const r of F.rounds[id].runs) {
      const f = runFeatures(S, L, r.log), s = scoreRun({ feat: f, client: phone });
      assert.ok(f.gridShare < 0.8, `${id} ${r.player} ${r.total}: ${JSON.stringify(f)}`);
      assert.ok(s.score <= HOLD_ABOVE, `${id} ${r.player} ${r.total}: ${JSON.stringify(s)}`);
    }
  }
});

/** A daily round on the level of a fixture round (its candles and seed, its game version), with X links and Lightning addresses. */
async function dailyOn(id) {
  const R = F.rounds[id], S = simOf(R.version);
  let t = Date.parse('2026-11-23T01:00:00Z');
  const s2 = openBountySeason(':memory:');
  const chain = { async post(hex) { return createHash('sha256').update(hex).digest('hex'); }, async status() { return { confirmations: 1, height: 5 }; } };
  const opr = createOpr({ now: () => t, sim: S, fetchCandles: async () => R.candles, checkLevel: async () => ({ ok: true, seed: R.seed, tries: 1, hash: 'h' }), ceilingOf: () => ceilingFor(id), invoices: null, chain, s2, log: () => {},
    lnCheck: async (a) => ({ ok: true, address: a }), cfg: { showTest: true, daily: true, firstDay: '2026-11-23', bountySats: 2500, adminSha: createHash('sha256').update('x').digest('hex') } });
  await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.roundRow('2026-11-23');
  assert.equal(r.state, 'ready');
  const keys = new Map();
  let xn = 0;
  const keyOf = async (name) => {
    if (keys.has(name)) return keys.get(name);
    const k = keypair(); keys.set(name, k); xn++;
    assert.equal(proveX(s2, k.pk, { userId: `u${xn}`, username: name, nowMs: t }).ok, true); s2.record(k.pk, 'x', { member: true, nowMs: t });
    assert.equal((await opr.saveLnAddress(k.pk, `${name}@walletofsatoshi.com`)).ok, true);
    return k;
  };
  const play = async (name, log) => {
    const k = await keyOf(name);
    const s = await opr.startAttempt(k.pk, { round: r.id });
    assert.equal(s.ok, true, s.why);
    t += 181000;
    const out = opr.submit(k.pk, { attempt: s.attempt, token: s.token, log, client: phone });
    assert.equal(out.ok, true, out.why);
    return s.attempt;
  };
  const end = async () => { t = r.end_ms; await opr.tick(); t += 61 * 60000; await opr.tick(); };
  const bounty = () => opr.listsOf(r.id).find((l) => l.kind === 'bounty');
  return { opr, r, play, end, bounty, pk: (n) => keys.get(n).pk };
}
/** The players' best runs (at most 5 each, as the round allows). */
const bestRuns = (id) => { const by = new Map(); for (const x of F.rounds[id].runs) { const b = by.get(x.player); if (!b || x.total > b.total) by.set(x.player, x); } return [...by.values()]; };
async function call(opr, method, path, body = null) {
  const { Readable } = await import('node:stream');
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(method === 'POST' ? [raw] : []);
  Object.assign(req, { method, url: path, headers: { 'x-arena-admin': 'x' }, socket: { remoteAddress: '127.0.0.1' } });
  let status = 0, text = '';
  await opr.handle(req, { writeHead: (s) => { status = s; }, end: (x) => { text = x; } });
  return { status, json: JSON.parse(text) };
}

test('#3332 the audit\'s searched run is held as suspiciously strong; the bounty list waits (no row, no approve) until the owner decides', async () => {
  for (const decision of ['disqualify', 'approve']) {
    const w = await dailyOn('test-5');
    for (const x of bestRuns('test-5')) await w.play(x.player, x.log);
    const tas = await w.play('searcher', F.searched.log);
    await w.end();
    let b = w.bounty();
    assert.deepEqual(b.rows, [], JSON.stringify(b));
    assert.match(b.waiting, /waits for the owner's decision/);
    const h = b.held.find((x) => x.player === w.pk('searcher'));
    assert.ok(h && /^suspiciously strong: 954 points - 102 % of what a search of this level reaches \(939\), 2\.3x .* - held for the owner's decision$/.test(h.why) && h.flag === 'strong', JSON.stringify(b.held));
    assert.deepEqual(b.held.map((x) => x.player), [w.pk('searcher')], 'no real player is held');
    const ap = w.opr.decideList({ round: w.r.id, kind: 'bounty', action: 'approve', by: 'owner', version: b.version });
    assert.equal(ap.ok, false); assert.match(ap.why, /flagged run .* waits/);
    // the admin page's data: the flagged run with its reason
    const runs = await call(w.opr, 'GET', `/admin/runs?round=${w.r.id}`);
    assert.equal(runs.status, 200);
    assert.deepEqual(runs.json.flagged.map((f) => [f.attempt, f.kind, f.decision]), [[tas, 'strong', 'pending']]);
    if (decision === 'disqualify') {
      assert.equal((await call(w.opr, 'POST', '/admin/disqualify', { round: w.r.id, player: w.pk('searcher'), why: 'searched run' })).status, 200);
      b = w.bounty();
      assert.equal(b.waiting, null);
      assert.equal(b.rows[0].score, 413);   // the best human moves up only now
    } else {
      assert.equal((await call(w.opr, 'POST', '/admin/review', { attempt: tas, action: 'clear' })).status, 200);
      b = w.bounty();
      assert.equal(b.waiting, null);
      assert.equal(b.rows[0].player, w.pk('searcher'));
      assert.equal((await call(w.opr, 'GET', `/admin/runs?round=${w.r.id}`)).json.flagged[0].decision, 'approved');
    }
    assert.equal(w.opr.decideList({ round: w.r.id, kind: 'bounty', action: 'approve', by: 'owner', version: b.version }).ok, true);
  }
});

test("#3332 the real players of test-4 and test-5 (each player's best run) are not flagged; the best of them takes the bounty unheld", async () => {
  for (const id of ['test-4', 'test-5']) {
    const w = await dailyOn(id);
    const best = bestRuns(id);
    for (const x of best) await w.play(x.player, x.log);
    await w.end();
    const b = w.bounty();
    assert.equal(b.waiting, null, id);
    assert.deepEqual(b.held, [], `${id}: ${JSON.stringify(b.held)}`);
    assert.equal(b.rows[0].score, Math.max(...best.map((x) => x.total)));
    const runs = (await call(w.opr, 'GET', `/admin/runs?round=${w.r.id}`)).json;
    assert.deepEqual(runs.flagged, []);
    assert.ok(runs.runs.every((x) => x.bot.score <= HOLD_ABOVE), JSON.stringify(runs.runs.map((x) => x.bot)));
  }
});

test('#3332 the admin page lists the flagged runs with their reason, Approve (review clear) and Disqualify; a waiting list cannot be approved there', () => {
  const html = fs.readFileSync(new URL('../client/admin.html', import.meta.url), 'utf8');
  for (const s of ['Flagged runs', 'drawFlagged(runs)', 'suspiciously strong', 'inhumanly precise', '"/admin/review", { attempt: f.attempt, action: "clear" }', '"/admin/disqualify", { round: current, player: f.player',
    '"Waiting: " + l.waiting', 'disabled: l.waiting ? "" : null', 'level ceiling']) assert.ok(html.includes(s), s);
  const js = html.match(/<script>\n([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
});
