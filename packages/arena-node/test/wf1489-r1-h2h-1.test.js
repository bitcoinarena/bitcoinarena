// kanban #1489 r1-find-h2h candidate 1: ONE SEAT STALLS EVERY HEAD-TO-HEAD CLOSE (P4, P5).
// Verifier.carryReveals pulls GET /reveals from every peer of the round with a bare fetch - no timeout, no size cap - and
// #headToHeadClose awaits it before deciding and signing anything. One committee seat that answers 200 and then trickles its
// body a byte at a time holds the pull forever (undici's body timeout restarts on every chunk), so no honest seat ever signs
// the round's results: the round goes nowhere, and the honest peer after it, which holds the missing reveal, is never asked.
// Safe behaviour: a peer is given a bounded time; the pull goes on to the next peer and returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Verifier } from '../src/verify.js';
import { headToHeadCommit } from '../../arena-protocol/src/head-to-head.js';

const hex = (b) => Buffer.from(b).toString('hex');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

test('#1489 r1-h2h-1: one trickling seat does not stall the reveal pull of a head-to-head close', async () => {
  const roundId = new Uint8Array(randomBytes(32)), sessionPubkey = new Uint8Array(randomBytes(32)), entryId = new Uint8Array(randomBytes(32));
  const salt = new Uint8Array(randomBytes(32)), move = 1;
  const commit = headToHeadCommit({ roundId, entryKey: sessionPubkey, move, salt });
  const entries = [{ entryId, entry: { roundId, sessionPubkey, commit } }];

  // the bad seat: answers 200 and sends one space every 300 ms, never ending the JSON
  const timers = new Set();
  const bad = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"reveals":[');
    const t = setInterval(() => res.write(' '), 300); timers.add(t);
    req.on('close', () => clearInterval(t));
  });
  // the honest seat: holds the player's reveal
  const good = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ reveals: [{ entry: hex(entryId), move, salt: hex(salt) }] }));
  });
  const badUrl = await listen(bad), goodUrl = await listen(good);

  const held = [];
  const round = { revealsOf: () => held.slice(), putReveal: (r) => { held.push(r); return true; } };
  const v = new Verifier(round, { peers: [badUrl, goodUrl] });

  const started = Date.now();
  const outcome = await Promise.race([
    v.carryReveals(roundId, entries, 3).then(() => 'returned'),
    new Promise((r) => { const t = setTimeout(() => r('stalled'), 20_000); timers.add(t); }),
  ]);
  for (const t of timers) { clearInterval(t); clearTimeout(t); }
  bad.closeAllConnections(); good.closeAllConnections(); bad.close(); good.close();
  assert.equal(outcome, 'returned', `carryReveals still waited on the trickling seat after ${Date.now() - started} ms: no head-to-head result is ever signed`);
  assert.equal(held.length, 1, 'the honest peer\'s reveal is carried');
});
