// kanban #3375: the card's test (audit opr a6-3-2)
// Audit opr round 6-3 finding 2: the #3277/#3280 fix (nameRefusal, opr-service.mjs:462-463) compares names with lower(name) = lower(?) and
// reserves the default label only as /^player [0-9a-f]{8}$/i. Names may hold any run of spaces inside (POST /name only trims the ends), and the
// board draws a name with textContent in a white-space: nowrap cell, which shows a run of spaces as one. So 'player  <8 hex>' (two spaces) is
// accepted and reads exactly as the victim's default label, and 'Satoshi  N' reads exactly as the leader's 'Satoshi N': two board rows read
// the same (the copy bypass #3277/#3280 meant to close).
// The safe behaviour: a name that reads as another player's name (spaces collapsed) is refused, and the default label cannot be taken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { world, keypair, signIn } from './server-helpers.mjs';

test('a name that reads as another player\'s chosen name or default label is refused', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z', cfg: { entrySats: 0 } });
  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (kp, path, body) => { const raw = JSON.stringify(body);
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: signIn(kp, { path, method: 'POST', body: raw, createdAt: Math.floor(w.clock.now() / 1000) }) }, body: raw });
    return { status: r.status, json: await r.json() }; };
  const shown = (n) => n.replace(/\s+/g, ' ');   // how the board cell (textContent, white-space: nowrap) draws it
  try {
    const leader = keypair(), carol = keypair(), m1 = keypair(), m2 = keypair();
    assert.equal((await post(leader, '/name', { name: 'Satoshi N' })).status, 200);
    const plain = await post(m1, '/name', { name: 'Satoshi N' });
    assert.equal(plain.status, 409, 'the #3277 check itself holds for the same spelling');
    const copy = await post(m1, '/name', { name: 'Satoshi  N' });
    const carolLabel = `player ${carol.pk.slice(0, 8)}`;   // carol never picked a name
    const copy2 = await post(m2, '/name', { name: `player  ${carol.pk.slice(0, 8)}` });
    assert.ok(!(copy.status === 200 && shown(copy.json.name) === 'Satoshi N'), `'Satoshi  N' was taken and reads as the leader's 'Satoshi N' on the board`);
    assert.ok(!(copy2.status === 200 && shown(copy2.json.name) === carolLabel), `'${copy2.json.name}' was taken and reads as another player's default label '${carolLabel}'`);
  } finally { srv.close(); }
});
