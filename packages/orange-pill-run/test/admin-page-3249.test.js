// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3249: the admin panel is built beside the game, loads nothing from elsewhere, keeps the code out of URLs, and the admin routes
// answer the fields it reads (rounds, runs with the bot likelihood of #3274, lists with skip/held reasons).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { adminWorld, serveAdmin } from './admin-fake-3249.mjs';

test('#3249 client/build.mjs writes dist/admin.html: self-contained, the code only in a header and sessionStorage', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opr-admin-')), 'index.html');
  execFileSync(process.execPath, [new URL('../client/build.mjs', import.meta.url).pathname, '--out', out], { encoding: 'utf8' });
  const html = fs.readFileSync(path.join(path.dirname(out), 'admin.html'), 'utf8');
  assert.equal(html, fs.readFileSync(new URL('../client/admin.html', import.meta.url), 'utf8'));
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|@import|url\(http/i);
  for (const s of ['x-arena-admin', 'sessionStorage', '/admin/rounds', '/admin/runs?round=', '/admin/lists?round=', '/admin/review', '/admin/disqualify', '/admin/list"', '/admin/row', '/admin/test-round', '/admin/replay/', 'name="viewport"']) assert.ok(html.includes(s), s);
  assert.doesNotMatch(html, /console\.log|[?&](code|admin)=/);   // never logged, never in a URL
  const js = html.match(/<script>\n([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
});

test('#3249 the admin routes answer what the panel reads', async () => {
  const { w, id } = await adminWorld({ t0: Date.parse('2026-11-20T12:00:00Z') });
  const { srv, base } = await serveAdmin(w);
  const get = async (p, code = 'letmein') => { const r = await fetch(base + '/api/opr' + p, { headers: { 'x-arena-admin': code } }); return { status: r.status, json: await r.json() }; };
  try {
    assert.equal((await fetch(base + '/games/orange-pill-run/admin.html')).status, 200);
    assert.equal((await get('/admin/rounds', 'wrong')).status, 403);
    const rounds = (await get('/admin/rounds')).json.rounds;
    assert.equal(rounds[0].id, id);
    for (const k of ['id', 'number', 'test', 'state', 'phase', 'startMs', 'endMs', 'chartDay', 'players', 'maxAttempts', 'entrySats', 'free', 'potSats']) assert.ok(k in rounds[0], k);
    const runs = (await get(`/admin/runs?round=${id}`)).json;
    assert.equal(runs.runs.length, 8); assert.equal(runs.holdAbove, 70);
    for (const a of runs.runs) {
      for (const k of ['attempt', 'player', 'name', 'state', 'score', 'flags', 'bot', 'review', 'x', 'disqualified', 'startedMs', 'submittedMs']) assert.ok(k in a, k);
      assert.ok(Number.isInteger(a.bot.score) && Array.isArray(a.bot.reasons));
      assert.ok('placed' in a.x && Number.isFinite(a.score.total) && Number.isFinite(a.score.timeS));
    }
    assert.ok(runs.runs.some((a) => a.review === 'pending'));
    const l = (await get(`/admin/lists?round=${id}`)).json;
    assert.equal(l.lists[0].kind, 'pot'); assert.equal(l.lists[0].state, 'waiting');
    for (const k of ['round', 'kind', 'rows', 'sats', 'carrySats', 'state', 'by', 'atMs', 'madeMs', 'held']) assert.ok(k in l.lists[0], k);
    for (const r of l.lists[0].rows) for (const k of ['player', 'name', 'xAccount', 'rank', 'place', 'score', 'timeS', 'sats', 'pct', 'bot']) assert.ok(k in r, k);
    assert.ok(l.lists[0].held.every((h) => h.why && h.rank));
    assert.ok(Array.isArray(l.approvals));
  } finally { srv.close(); }
});
