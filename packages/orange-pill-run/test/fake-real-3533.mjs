// kanban #3533 headless check: the real sim, a test round with three runs of one player (best, weaker, refused-with-log), the admin page and the game
// served on one origin. node test/fake-real-3533.mjs <port> <host>  -> prints JSON { round, best, weak, refused }
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import * as sim from '../src/sim/index.js';
import { checkLevel } from '../src/level-check.mjs';
import { createOpr } from '../server/opr-service.mjs';
import { fakeLnd, fakeChain, keypair } from './server-helpers.mjs';
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/candles-30d.json', import.meta.url)));
const day = fx.days[fx.days.length - 1];
let t = Date.parse(day.day + 'T00:00:00Z') + 86400000 + 36000000;
const lnd = fakeLnd(), chain = fakeChain();
const opr = createOpr({ now: () => t, sim: { GAME_VERSION: sim.GAME_VERSION, buildLevel: sim.buildLevel, runLog: sim.runLog }, fetchCandles: async () => day.candles,
  checkLevel, invoices: lnd, chain, log: () => {}, cfg: { showTest: true, entrySats: 100, adminSha: createHash('sha256').update('letmein').digest('hex') } });
const made = opr.testRound({ minutes: 60, chartDay: day.day, maxAttempts: 5 }); if (!made.ok) throw new Error(made.why + ' ' + day.day);
await opr.tick(); await opr.tick(); chain.confirm(); await opr.tick();
const r = opr.roundRow(made.round.id), c = checkLevel(day.candles, r.id), L = sim.buildLevel(day.candles, c.seed);
const p = keypair();
const run = async (log) => { const s = await opr.startAttempt(p.pk, { round: r.id }); lnd.pay(s.invoice); const a = await opr.checkAttempt(p.pk, s.attempt); t += 400000; const x = opr.submit(p.pk, { attempt: s.attempt, token: a.token, log }); return { id: s.attempt, x }; };
const best = await run(sim.recordLog(L, (w) => sim.botInput(w, { ...sim.BOT_CONFIGS[0] })).log);
const weakLog = sim.recordLog(L, (w) => sim.botInput(w, { ...sim.BOT_CONFIGS[sim.BOT_CONFIGS.length - 1] })).log;
const weak = await run({ v: weakLog.v, presses: weakLog.presses.slice(0, 3) });
const refused = await run({ v: 'opr-0', presses: [[10, 20]] });
const port = +(process.argv[2] || 0), host = process.argv[3] || '127.0.0.1';
const dist = new URL('../client/dist/', import.meta.url);
const srv = createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  const f = { '/games/orange-pill-run/admin.html': 'admin.html', '/games/orange-pill-run/index.html': 'index.html' }[u.pathname];
  if (f) { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return s.end(fs.readFileSync(new URL(f, dist))); }
  if (u.pathname.startsWith('/api/opr/')) return opr.handle(q, s);
  s.writeHead(404); s.end('no');
});
srv.listen(port, host, () => console.log(JSON.stringify({ base: `http://${host}:${srv.address().port}`, round: r.id, best: best.id, bestScore: best.x.score && best.x.score.total, weak: weak.id, weakOk: weak.x.ok, weakScore: weak.x.score && weak.x.score.total, refused: refused.id, refusedWhy: refused.x.why })));
