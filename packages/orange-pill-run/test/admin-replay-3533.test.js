// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3533 (owner 2026-11-23): the admin panel's Replay link opened ?game=orange-pill-run#replay=<attempt> and nothing happened - the game
// never read the hash, and GET /replay/<id> is public only for each board row's best run (#3336). Now: the game plays #replay=<id>, and the
// admin watches ANY run with a stored log through GET /admin/replay/<id> (the admin code header), inside the admin page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { adminWorld, serveAdmin } from './admin-fake-3249.mjs';

test('#3533 GET /admin/replay/<id> answers any stored run to the admin code only; the public door stays as it was', async () => {
  const { w, id } = await adminWorld({ t0: Date.parse('2026-11-20T12:00:00Z') });
  const { srv, base } = await serveAdmin(w);
  const get = async (p, code) => { const r = await fetch(base + '/api/opr' + p, { headers: code ? { 'x-arena-admin': code } : {} }); return { status: r.status, json: await r.json() }; };
  try {
    const runs = (await get(`/admin/runs?round=${id}`, 'letmein')).json.runs;
    const board = (await get(`/board?round=${id}`)).json.board || [];
    const best = new Set(board.map((b) => b.attempt));
    const weak = runs.find((a) => a.state === 'scored' && !best.has(a.attempt));
    assert.ok(weak, 'a weaker run not on the board');
    assert.equal((await get(`/replay/${weak.attempt}`)).status, 403, 'public: still only the best run');
    assert.equal((await get(`/admin/replay/${weak.attempt}`)).status, 403, 'no code: refused');
    assert.equal((await get(`/admin/replay/${weak.attempt}`, 'wrong')).status, 403, 'a wrong code: refused');
    const ok = await get(`/admin/replay/${weak.attempt}`, 'letmein');
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.attempt, weak.attempt); assert.equal(ok.json.state, 'scored');
    assert.ok(Array.isArray(ok.json.log.presses) && ok.json.log.v);
    assert.equal(ok.json.score.total, weak.score.total);
    assert.equal(ok.json.level.round, id); assert.equal(ok.json.level.candles.length, 48); assert.ok(ok.json.level.gameVersion);
    // a refused run kept with its log (#3249 keepLog) and a run with no log
    w.opr.db.prepare("UPDATE attempts SET state = 'rejected', why = 'wrong game version' WHERE id = ?").run(weak.attempt);
    const rj = await get(`/admin/replay/${weak.attempt}`, 'letmein');
    assert.equal(rj.status, 200); assert.equal(rj.json.state, 'rejected'); assert.equal(rj.json.why, 'wrong game version');
    w.opr.db.prepare('UPDATE attempts SET log = NULL WHERE id = ?').run(weak.attempt);
    const none = await get(`/admin/replay/${weak.attempt}`, 'letmein');
    assert.equal(none.status, 404); assert.match(none.json.why, /no stored log/);
    assert.equal((await get('/admin/replay/' + '0'.repeat(32), 'letmein')).status, 404);
    assert.equal((await get('/admin/replay/nothex', 'letmein')).status, 404);
  } finally { srv.close(); }
});

test('#3533 the game reads #replay=<id> on load and on hashchange; the admin plays runs in its own page, the code never in a URL', () => {
  const main = fs.readFileSync(new URL('../client/src/main.js', import.meta.url), 'utf8');
  assert.match(main, /#replay=\(\[0-9a-f\]\{32\}\)/);
  assert.match(main, /addEventListener\("hashchange"/);
  assert.match(main, /watchReplay\("\/replay\/" \+/);
  assert.match(main, /watch\(j\) \{ watchRun\(j, "admin"\); \}/);
  const admin = fs.readFileSync(new URL('../client/admin.html', import.meta.url), 'utf8');
  assert.doesNotMatch(admin, /#replay=/, 'no link to the public replay door, which refuses most runs');
  assert.match(admin, /call\("GET", "\/admin\/replay\/" \+ a\.attempt\)/);
  assert.match(admin, /f\.src = "index\.html\?practice"/);
  assert.match(admin, /g\.watch\(j\)/);
  assert.doesNotMatch(admin, /[?&#](code|admin)=[^"]*"\s*\+\s*code/);
});
