// kanban #3356: the card's test (audit opr a6-1-2)
// Audit opr round 6-1 finding 2: POST /name takes any fresh key from any address with no limit (a free NIP-98 key per request), writes a
// players row for it, and every save checks the name against ALL players with lower(name) = lower(?) - no index can serve it, a full scan
// on the one thread. One address grows the table without end, and each further /name (the attacker's and every honest player's) blocks
// the service longer. The safe behaviour: a name save costs about the same however many players the table holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, keypair, signIn } from './server-helpers.mjs';

async function serve(w) {
  const srv = createServer((q, s) => w.opr.handle(q, s));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const name = async (kp, n) => {
    const raw = JSON.stringify({ name: n });
    const authorization = signIn(kp, { path: '/name', method: 'POST', body: raw, createdAt: Math.floor(w.clock.now() / 1000) });
    const r = await fetch(base + '/name', { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: raw });
    return r.status;
  };
  return { srv, name };
}

test('POST /name from fresh keys: no per-address limit, and each save scans every player row', async () => {
  const w = world({ start: '2026-11-23T00:00:00Z', cfg: { entrySats: 0 } });
  const { srv, name } = await serve(w);
  try {
    // one address, 300 fresh keys: every one gets its row
    let ok = 0;
    for (let i = 0; i < 300; i++) if ((await name(keypair(), `bulk${i}`)) === 200) ok++;
    // the time one save holds the service, measured at the service itself (sign-in and HTTP cost are the same in both measurements)
    const keys = Array.from({ length: 40 }, () => keypair());
    const timeSaves = async (from) => { let ms = 0; for (let i = 0; i < 20; i++) { const t0 = performance.now(); await name(keys[from + i], `probe${from + i}`); ms += performance.now() - t0; } return ms / 20; };
    const small = await timeSaves(0);
    // the table as the same door leaves it after 300,000 such requests (rows written directly here only to keep the test short)
    const ins = w.opr.db.prepare('INSERT INTO players (pubkey, name, seen_ms) VALUES (?, ?, ?)');
    w.opr.db.exec('BEGIN'); for (let i = 0; i < 300000; i++) ins.run(i.toString(16).padStart(64, '0'), `b${i.toString(36)}`, w.clock.now()); w.opr.db.exec('COMMIT');
    const big = await timeSaves(20);
    console.log(`one address made ${ok} of 300 player rows; one POST /name: ${small.toFixed(2)} ms with few players, ${big.toFixed(2)} ms with 300,000`);
    assert.ok(ok < 300 || big - small < 5,
      `one address made ${ok} player rows with fresh keys and a name save grew from ${small.toFixed(2)} ms to ${big.toFixed(2)} ms of blocked service at 300,000 rows (lower(name) full scan)`);
  } finally { srv.close(); }
});
