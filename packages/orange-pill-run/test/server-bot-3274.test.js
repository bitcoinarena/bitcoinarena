// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3274 the bot likelihood (0-100, top reasons) on the real sim: the scripted player and a frame-perfect script score high, a human-like run with
// jitter low; near-identical inputs of two players flag both; above 70 a list row is held until the run is cleared; nothing of it is public.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as sim from '../src/sim/index.js';
import { checkLevel } from '../src/level-check.mjs';
import { createOpr } from '../server/opr-service.mjs';
import { runFeatures, scoreRun, nearLogs, HOLD_ABOVE } from '../server/opr-botscore.mjs';
import { openBountySeason } from '../../arena-node/src/bounty-season.js';
import { keypair, signIn, proveX, gameLink } from './server-helpers.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/candles-30d.json', import.meta.url)));
const day = fx.days[fx.days.length - 1];
const SIM = { GAME_VERSION: sim.GAME_VERSION, buildLevel: sim.buildLevel, runLog: sim.runLog, newWorld: sim.newWorld, stepWorld: sim.stepWorld, botInput: sim.botInput, MAX_STEPS: sim.MAX_STEPS };
const ROUND = '2026-11-23';   // the first daily round: the bounty list is a daily round's
const L = sim.buildLevel(day.candles, checkLevel(day.candles, ROUND).seed);

/** A small seeded random source (mulberry32), so the human-like runs are the same on every machine. */
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const seesHazard = (W) => !!sim.botInput(W, { react: 0, jumpFrames: 2, billDist: 40 }).jump;
/** A frame-perfect script: down on the very step a hazard shows, always held 10 steps. */
function frameScript(Lv) {
  let hold = 0, before = false;
  return sim.recordLog(Lv, (W) => { const s = seesHazard(W); if (s && !before && hold <= 0) hold = 10; before = s; if (hold > 0) { hold--; return { jump: true }; } return { jump: false }; }).log;
}
/** A human-like run: a hazard answered after 6-24 steps (100-400 ms) or missed now and then, held 4-19 steps, a stray tap sometimes. */
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
const humanClient = (seed) => { const r = rng(seed); return { ua: 'Mozilla/5.0 (iPhone)', w: 375, h: 559, touch: true, v: sim.GAME_VERSION, hiddenMs: 0,
  t: { src: { touch: 60, mouse: 0, pen: 0, key: 0 }, taps: 60, jit: 30 + Math.round(r() * 200) / 10, blur: 0, hidden: 0, hiddenMs: 0, first: 900 + Math.round(r() * 900), wd: false, auto: [], dc: 'phone', dpr: 3 } }; };

test('#3274 the scripted player and a frame-perfect script score high; human-like runs with jitter score low', () => {
  for (const cfg of sim.BOT_CONFIGS) {
    const { log } = sim.recordLog(L, (W) => sim.botInput(W, cfg.__c || (cfg.__c = { ...cfg })));
    delete cfg.__c;
    const f = runFeatures(SIM, L, log);
    const s = scoreRun({ feat: f });
    assert.ok(s.score > HOLD_ABOVE, `${cfg.name}: ${s.score} ${JSON.stringify(f)} ${JSON.stringify(s.reasons)}`);
    assert.match(s.reasons[0].why, /exact step|held exactly/);
  }
  const fp = runFeatures(SIM, L, frameScript(L));
  const sf = scoreRun({ feat: fp });
  assert.ok(sf.score > HOLD_ABOVE, `frame-perfect: ${sf.score} ${JSON.stringify(fp)}`);
  assert.ok(fp.exact >= 0.6, JSON.stringify(fp));
  for (const seed of [1, 2, 3, 4, 5]) {
    const log = humanLike(L, seed), f = runFeatures(SIM, L, log);
    const s = scoreRun({ feat: f, client: humanClient(seed) });
    assert.ok(s.score < 30, `human ${seed}: ${s.score} ${JSON.stringify(f)} ${JSON.stringify(s.reasons)}`);
  }
});

test('#3274 the page telemetry: an automated browser, presses with no input event, taps on one pixel', () => {
  const f = runFeatures(SIM, L, humanLike(L, 9));
  assert.ok(scoreRun({ feat: f, client: { t: { ...humanClient(9).t, wd: true } } }).score >= 60);
  const none = scoreRun({ feat: f, client: { t: { ...humanClient(9).t, src: { touch: 0, mouse: 0, pen: 0, key: 0 }, taps: 0, jit: null } } });
  assert.ok(none.score >= 50); assert.match(none.reasons[0].why, /no touch, mouse or key event/);
  const pixel = scoreRun({ feat: f, client: { t: { ...humanClient(9).t, jit: 0 } } });
  assert.match(pixel.reasons[0].why, /same pixel/);
  assert.ok(scoreRun({ feat: f, cross: { botX: true } }).score >= 80);
});

/** The first daily round on the real sim with X links: { opr, s2, link, r, play(kp, log, client, ip), clock }. */
async function realRound() {
  let t = Date.parse('2026-11-23T01:00:00Z');
  const s2 = openBountySeason(':memory:');
  const posts = [];
  const chain = { async post(hex) { posts.push(hex); return createHash('sha256').update(hex).digest('hex'); }, async status() { return { confirmations: 1, height: 5 }; } };
  const opr = createOpr({ now: () => t, sim: SIM, fetchCandles: async () => day.candles, checkLevel, invoices: null, chain, s2, log: () => {}, lnCheck: async (a) => ({ ok: true, address: a }),
    cfg: { showTest: true, daily: true, firstDay: ROUND, bountySats: 2500, adminSha: createHash('sha256').update('x').digest('hex') } });
  await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.roundRow(ROUND);
  assert.equal(r.state, 'ready');
  let xn = 0;
  const link = (pk) => { xn++; assert.equal(gameLink(opr, pk, { userId: `u${xn}`, username: `user${xn}`, nowMs: t }).ok, true); };   // the game's own link (#3381)
  const play = async (kp, log, client, ip = null) => {
    const s = await opr.startAttempt(kp.pk, { round: r.id, ip });
    assert.equal(s.ok, true, s.why);
    t += 181000;
    const out = opr.submit(kp.pk, { attempt: s.attempt, token: s.token, log, client }, { ip });
    assert.equal(out.ok, true, out.why);
    return s.attempt;
  };
  return { opr, s2, link, r, play, clock: { add: (ms) => { t += ms; }, set: (ms) => { t = ms; } } };
}

test('#3274 near-identical inputs from two players flag both; a likely bot is held off the bounty list until its run is cleared', async () => {
  const w = await realRound();
  const a = keypair(), b = keypair(), c = keypair(), d = keypair();
  for (const k of [a, b, c, d]) { w.link(k.pk); assert.equal((await w.opr.saveLnAddress(k.pk, `p${k.pk.slice(0, 6)}@walletofsatoshi.com`)).ok, true); }
  const base = humanLike(L, 21);
  // a copy a step off here and there (every third press one step later where the next press leaves room)
  const copy = { v: base.v, presses: base.presses.map(([x, y], i, ps) => (i % 3 === 0 && (i + 1 === ps.length || ps[i + 1][0] > y + 1) && y + 1 <= sim.MAX_STEPS ? [x + 1, y + 1] : [x, y])) };
  assert.equal(nearLogs(base, copy), true);
  assert.equal(nearLogs(base, humanLike(L, 22)), false);
  const ra = await w.play(a, base, humanClient(1));
  const rb = await w.play(b, copy, humanClient(2));
  const rc = await w.play(c, humanLike(L, 23), humanClient(3));
  // the scripted player, in an automated browser
  const cfg = { ...sim.BOT_CONFIGS[2] };
  const botLog = sim.recordLog(L, (W) => sim.botInput(W, cfg)).log;
  const rd = await w.play(d, botLog, { ua: 'Mozilla/5.0 HeadlessChrome', w: 800, h: 600, v: sim.GAME_VERSION, t: { src: { touch: 0, mouse: 0, pen: 0, key: 0 }, taps: 0, jit: null, blur: 0, hidden: 0, hiddenMs: 0, first: 16, wd: true, auto: ['headless'], dc: 'desktop', dpr: 1 } });
  // the admin's runs view
  const res = await adminRuns(w.opr, w.r.id);
  const byId = new Map(res.runs.map((x) => [x.attempt, x]));
  for (const id of [ra, rb]) assert.ok(byId.get(id).bot.reasons.some((x) => /nearly the same inputs as 1 other player's run/.test(x)), JSON.stringify(byId.get(id).bot));
  assert.ok(byId.get(rc).bot.score < 30, JSON.stringify(byId.get(rc).bot));
  assert.equal(byId.get(rd).bot.score, 100);
  assert.equal(byId.get(rd).bot.reasons.length, 3);
  assert.equal(res.players[0].player, d.pk); assert.equal(res.players[0].bot.score, 100);
  assert.equal(res.holdAbove, 70);
  // the round ends: the bot (best score) is held, the bounty goes to the next player; the row names its likelihood
  w.clock.set(w.r.end_ms); await w.opr.tick(); w.clock.add(61 * 60000); await w.opr.tick();
  let bounty = w.opr.listsOf(w.r.id).find((l) => l.kind === 'bounty');
  assert.ok(bounty.held.some((h) => h.player === d.pk && /bot likelihood 100 - held for review/.test(h.why) && h.bot.score === 100), JSON.stringify(bounty.held));
  assert.notEqual(bounty.rows[0] && bounty.rows[0].player, d.pk);
  assert.ok(bounty.rows.every((x) => x.bot && Number.isInteger(x.bot.score) && Array.isArray(x.bot.reasons)));
  // cleared by the admin: back on the list (if it is the best placed)
  const board = w.opr.boardOf(w.r.id);
  assert.equal(w.opr.review({ attempt: board.find((x) => x.player === d.pk).attempt, action: 'clear', by: 'owner' }).ok, true);
  bounty = w.opr.listsOf(w.r.id).find((l) => l.kind === 'bounty');
  assert.ok(!bounty.held.some((h) => h.player === d.pk));
});

async function adminRuns(opr, round) {
  const res = await call(opr, 'GET', `/admin/runs?round=${round}`, { headers: { 'x-arena-admin': 'x' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json;
}
/** The service's handle() without a socket. */
async function call(opr, method, path, { headers = {}, body = '' } = {}) {
  const { Readable } = await import('node:stream');
  const req = Readable.from(method === 'POST' ? [body] : []);
  Object.assign(req, { method, url: path, headers, socket: { remoteAddress: '127.0.0.1' } });
  let status = 0, text = '';
  const res = { writeHead: (s) => { status = s; }, end: (x) => { text = x; } };
  await opr.handle(req, res);
  return { status, json: JSON.parse(text) };
}

test('#3274 nothing of it is public: the board, /me, the submit answer and the game page name no likelihood or rule', async () => {
  const w = await realRound();
  const a = keypair();
  const cfg = { ...sim.BOT_CONFIGS[0] };
  const s = await w.opr.startAttempt(a.pk, { round: w.r.id });
  w.clock.add(181000);
  const out = w.opr.submit(a.pk, { attempt: s.attempt, token: s.token, log: sim.recordLog(L, (W) => sim.botInput(W, cfg)).log, client: { t: { wd: true } } });
  assert.equal(out.ok, true);
  const pub = [JSON.stringify(out), JSON.stringify((await call(w.opr, 'GET', '/board')).json), JSON.stringify((await call(w.opr, 'GET', '/round')).json)];
  const nowS = Math.floor(Date.parse('2026-11-23T01:00:00Z') / 1000) + 181;
  const me = await call(w.opr, 'GET', '/me', { headers: { authorization: signIn(a, { path: '/me', method: 'GET', createdAt: nowS }) } });
  assert.equal(me.status, 200); pub.push(JSON.stringify(me.json));
  for (const p of pub) assert.ok(!/"bot"|likelihood|exact step|held for review|feat/i.test(p), p.slice(0, 300));
  const os = await import('node:os'), path = await import('node:path'), { execFileSync } = await import('node:child_process');
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opr-3274-')), 'index.html');
  execFileSync(process.execPath, [new URL('../client/build.mjs', import.meta.url).pathname, '--out', outFile]);
  const html = fs.readFileSync(outFile, 'utf8');
  assert.match(html, /webdriver/);   // the telemetry is sent; how it is weighed is not in the page
  for (const s2 of ['exact step', 'HOLD_ABOVE', 'scoreRun', 'likelihood', 'same pixel']) assert.ok(!html.includes(s2), s2);
});
