// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ADMIN PANEL ON A FAKE SERVICE (kanban #3249): a test round played by four players (three from one address: held for review, one a
// near copy), closed, its payout list waiting - served with client/admin.html on one origin, as the stage serves both.
//   node test/admin-fake-3249.mjs [port]     -> http://<host>:<port>/games/orange-pill-run/admin.html, admin code "letmein"
// The test (admin-page-3249.test.js) imports adminWorld; the page itself is driven in Chrome against it.
import fs from 'node:fs';
import { createServer } from 'node:http';
import { world, keypair, logOf, MIN } from './server-helpers.mjs';

/** The world: a closed test round with its list made; after that the fake clock follows the real one (so the page can make a new test round). */
export async function adminWorld({ realClock = false } = {}) {
  const t0 = Date.now() - 3 * 60 * MIN;
  const w = world({ start: new Date(t0).toISOString() });
  const chartDay = new Date(t0 - 86400000).toISOString().slice(0, 10);
  const made = w.opr.testRound({ startMs: t0 + MIN, minutes: 30, chartDay, by: 'owner', maxAttempts: 3 });
  if (!made.ok) throw new Error(made.why);
  const id = made.round.id;
  await w.opr.tick(); await w.opr.tick(); w.chain.confirm(); await w.opr.tick();
  w.clock.set(t0 + 2 * MIN);
  const ps = [keypair(), keypair(), keypair(), keypair()];
  const names = ['satoshi', 'hal', 'nick', 'adam'];
  for (const [i, p] of ps.entries()) {
    w.opr.db.prepare('INSERT INTO players (pubkey, name, seen_ms) VALUES (?, ?, ?) ON CONFLICT (pubkey) DO UPDATE SET name = excluded.name').run(p.pk, names[i], w.clock.now());
    if (i < 3) w.link(p.pk, true, names[i] + '_x');
    for (let k = 0; k < 2; k++) {
      const ip = i === 3 ? '10.0.0.9' : '10.0.0.1';
      const s = await w.opr.startAttempt(p.pk, { round: id, ip });
      if (!s.ok) throw new Error(s.why);
      w.lnd.pay(s.invoice);
      const c = await w.opr.checkAttempt(p.pk, s.attempt);
      w.clock.add(30000);
      const sub = await w.opr.submitChecked(p.pk, { attempt: s.attempt, token: c.token, log: logOf(10 + i * 3 + k) }, { ip });
      if (!sub.ok) throw new Error(sub.why);
    }
  }
  w.clock.set(t0 + 32 * MIN); await w.opr.tick();
  w.clock.add(61 * MIN); await w.opr.tick();
  if (realClock) { w.clock.set(Date.now()); setInterval(() => w.clock.set(Date.now()), 1000).unref(); }
  return { w, id, players: ps };
}

export function serveAdmin(w, { port = 0, host = '127.0.0.1', page = new URL('../client/admin.html', import.meta.url) } = {}) {
  const posts = [];
  const srv = createServer(async (q, s) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname === '/games/orange-pill-run/admin.html') { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return s.end(fs.readFileSync(page)); }
    if (u.pathname.startsWith('/api/opr/')) { if (q.method === 'POST') posts.push(u.pathname); return w.opr.handle(q, s); }
    s.writeHead(404); s.end('no');
  });
  return new Promise((r) => srv.listen(port, host, () => r({ srv, posts, base: `http://${host}:${srv.address().port}` })));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { w, id } = await adminWorld({ realClock: true });
  const { base, posts } = await serveAdmin(w, { port: +(process.argv[2] || 0), host: process.argv[3] || '127.0.0.1' });
  console.log(`admin fake: ${base}/games/orange-pill-run/admin.html  round ${id}`);
  setInterval(() => { if (posts.length) console.log('POSTs so far:', posts.join(' ')); }, 5000).unref();
  setInterval(() => {}, 1 << 30);   // keep serving until stopped
}
