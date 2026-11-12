// #1489 v1-refute-18: variants of #1507 (carryReveals bounded in time and size) that the fix should hold against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Verifier } from '../src/verify.js';
import { headToHeadCommit } from '../../arena-protocol/src/head-to-head.js';

const hex = (b) => Buffer.from(b).toString('hex');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
function setup() {
  const roundId = new Uint8Array(randomBytes(32)), sessionPubkey = new Uint8Array(randomBytes(32)), entryId = new Uint8Array(randomBytes(32));
  const salt = new Uint8Array(randomBytes(32)), move = 1;
  const commit = headToHeadCommit({ roundId, entryKey: sessionPubkey, move, salt });
  return { roundId, entryId, salt, move, entries: [{ entryId, entry: { roundId, sessionPubkey, commit } }] };
}
async function run(badHandler, label, nBad = 1) {
  const s = setup();
  const bads = []; for (let i = 0; i < nBad; i++) bads.push(http.createServer(badHandler));
  const good = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ reveals: [{ entry: hex(s.entryId), move: s.move, salt: hex(s.salt) }] })); });
  const urls = []; for (const b of bads) urls.push(await listen(b)); const goodUrl = await listen(good);
  const held = [];
  const round = { revealsOf: () => held.slice(), putReveal: (r) => { held.push(r); return true; } };
  const v = new Verifier(round, { peers: [...urls, goodUrl] });
  const t0 = Date.now(); let to;
  const outcome = await Promise.race([v.carryReveals(s.roundId, s.entries, 3).then(() => 'returned'), new Promise((r) => { to = setTimeout(() => r('stalled'), 20_000); })]);
  clearTimeout(to);
  for (const b of [...bads, good]) { b.closeAllConnections(); b.close(); }
  assert.equal(outcome, 'returned', `${label}: stalled after ${Date.now() - t0} ms`);
  assert.equal(held.length, 1, `${label}: the honest reveal is carried`);
  return Date.now() - t0;
}

test('variant: a seat that never sends headers', async () => { await run(() => {}, 'no headers'); });
test('variant: headers then a huge fast body (64 MiB)', async () => {
  await run((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); const chunk = Buffer.alloc(1 << 20, 0x20); res.write('{"reveals":['); let n = 0; const go = () => { while (n < 64 && res.write(chunk)) n++; if (n < 64) res.once('drain', () => { n++; go(); }); else res.end(']}'); }; go(); }, 'huge body');
});
test('variant: three trickling seats before the honest one stay under 20 s', async () => {
  const ms = await run((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"reveals":['); const t = setInterval(() => res.write(' '), 200); req.on('close', () => clearInterval(t)); res.on('close', () => clearInterval(t)); }, 'three trickling', 3);
  assert.ok(ms < 12_000, `took ${ms} ms`);
});
test('variant: chunked trickle with a 307 redirect to a trickling path', async () => {
  await run((req, res) => {
    if (!req.url.startsWith('/slow')) { res.writeHead(307, { location: '/slow' + req.url }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"reveals":['); const t = setInterval(() => res.write(' '), 200); res.on('close', () => clearInterval(t));
  }, 'redirect trickle');
});
test('honest: a 2-entry round with identities from a seat holding 40 extra (void here) reveals still carries', async () => {
  const s = setup();
  const extra = Array.from({ length: 40 }, () => ({ entry: hex(randomBytes(32)), move: 1, salt: hex(randomBytes(32)), identity: { key: hex(randomBytes(32)), sig: hex(randomBytes(64)) } }));
  const good = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ round: hex(s.roundId), reveals: [...extra, { entry: hex(s.entryId), move: s.move, salt: hex(s.salt) }] })); });
  const u = await listen(good); const held = [];
  const v = new Verifier({ revealsOf: () => held.slice(), putReveal: (r) => { held.push(r); return true; } }, { peers: [u] });
  await v.carryReveals(s.roundId, s.entries, 3);
  good.closeAllConnections(); good.close();
  assert.equal(held.length, 1);
});
