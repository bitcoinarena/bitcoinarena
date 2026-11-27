// AUDIT (find-only, client lens): a board name is free text that any player can copy - another player's chosen name, or another player's
// default "player <pubkey8>" - and the game marks the player's own row, best and replay by NAME only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { eventId } from '../../arena-node/src/nostr-relay.js';
import { world, keypair, logOf, at, BASE, MIN } from './server-helpers.mjs';
import { introBoard, myBest } from '../client/src/screens.js';

function sign(kp, { path, method, body, createdAt }) {
  const tags = [['u', BASE + path], ['method', method]];
  if (method === 'POST') tags.push(['payload', createHash('sha256').update(body).digest('hex')]);
  tags.push(['nonce', randomBytes(12).toString('hex')]);
  const e = { pubkey: kp.pk, created_at: createdAt, kind: 27235, tags, content: '' };
  e.id = eventId(e); e.sig = Buffer.from(schnorr.sign(Buffer.from(e.id, 'hex'), kp.sk)).toString('hex');
  return `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`;
}

test('AUDIT a second player can take the leader\'s board name (chosen or default) - two rows read the same on the public board', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z' });
  const made = w.opr.testRound({ startMs: at('2026-11-22T10:00:00Z'), minutes: 60, chartDay: '2026-11-21', by: 'owner', maxAttempts: 99 });
  assert.equal(made.ok, true, made.why);
  await w.opr.tick(); await w.opr.tick(); w.chain.confirm(); await w.opr.tick();
  const id = made.round.id, alice = keypair(), mallory = keypair(), carol = keypair();
  const srv = createServer((q, s) => w.opr.handle(q, s)); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (kp, method, path, body) => { const raw = body === undefined ? '' : JSON.stringify(body);
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: sign(kp, { path: path.split('?')[0], method, body: raw, createdAt: Math.floor(w.clock.now() / 1000) }) }, body: method === 'POST' ? raw : undefined });
    return { status: r.status, json: await r.json() }; };
  const run = async (kp, n) => { const a = await call(kp, 'POST', '/attempt', { round: id }); assert.equal(a.status, 200, a.json.why); if (a.json.invoice) w.lnd.pay(a.json.invoice); w.clock.add(MIN);
    const s = await call(kp, 'POST', '/submit', { attempt: a.json.attempt, token: a.json.token, round: id, log: logOf(n) }); assert.equal(s.status, 200, s.json.why); };
  try {
    assert.equal((await call(alice, 'POST', '/name', { name: 'alice' })).status, 200);
    await run(alice, 3); await run(carol, 3);   // carol never picks a name: "player <pk8>"
    const taken = await call(mallory, 'POST', '/name', { name: 'alice' });
    const carolDefault = `player ${carol.pk.slice(0, 8)}`;
    const copy = await call(keypair(), 'POST', '/name', { name: carolDefault });
    await run(mallory, 3);
    const b = await (await fetch(base + `/board?round=${id}`)).json();
    const names = (b.board || b.rows || []).map((r) => r.name);
    assert.notEqual(taken.status, 200, 'another player\'s name "alice" was taken by a second key: ' + JSON.stringify(names));
    assert.notEqual(copy.status, 200, 'the default name ' + carolDefault + ' of another player was taken as a chosen name');
    assert.equal(new Set(names).size, names.length, 'two board rows read the same name: ' + JSON.stringify(names));
  } finally { srv.close(); }
});

test('AUDIT the game marks a copycat\'s row as "me" and can give the player the copycat\'s rank (match by name, not by pubkey)', () => {
  const me = { name: 'alice', pubkey: 'aa'.repeat(32), attempts: [{ attempt: 'a1', state: 'scored', score: { total: 500, timeS: 40 } }] };
  const board = [{ rank: 1, name: 'alice', player: 'bb'.repeat(32), score: 500, timeS: 39 }, { rank: 2, name: 'alice', player: 'aa'.repeat(32), score: 500, timeS: 40 }];
  const ib = introBoard(board, me);
  assert.deepEqual(ib.rows.map((r) => r.me), [false, true], 'the copycat\'s row is marked as the player\'s own: ' + JSON.stringify(ib.rows));
  assert.equal(myBest(me, board).rank, 2, 'the player is shown the copycat\'s rank');
});
