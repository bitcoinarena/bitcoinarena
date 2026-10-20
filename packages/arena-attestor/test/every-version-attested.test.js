// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEW VERSION OF THE MARKET IS ATTESTED (the owner 2026-10-20: "Prediction market outcomes and balance changes were working last week,
// so something broke. Write tests to make sure it can never break again"): the live attestors named their markets by a hand-kept
// --game-id list (v1, v2); versions 3 to 14 went live, their rounds were never attested, and no order on them was decided or paid.
// The attestor now takes every version a seat hosts whose manifest names its key - here a daemon started with --game-id naming only
// an old version signs and posts the outcome of a round of a version it was never told about.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { attestorKey, marketsToAttest } from '../src/attestor.js';
import { encodeManifest, manifestBodyId, gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { decodeAttestation } from '../../arena-protocol/src/attested.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DEV = generateKeyPairSync('ed25519').privateKey;
const SEED = b32(0x41);
const ME = attestorKey(SEED);
const OTHER = attestorKey(b32(0x42));
const keysOf = (...ks) => ks.map((k) => k.pubkey).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
const market = ({ name = 'btc-updown-15m', version = 1, attestors = keysOf(ME), threshold = 1 } = {}) => {
  const body = {
    gameName: name, gameDevPubkey: b32(0xde), version, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
    cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
    clients: [], gameDonationSetId: b32(0xd0), outcomes: ['Up', 'Down'], attestors, attestThreshold: threshold,
  };
  const m = { ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), DEV)) };
  return { id: toHex(gameIdOf(m)), name, manifest: toHex(encodeManifest(m)) };
};

test('the markets to attest: the listed ids, and every version of the game whose manifest names this key - not another game, not one without the key, not a row whose id is not its manifest\'s', () => {
  const v1 = market({ version: 1 }), v14 = market({ version: 14 }), v15 = market({ version: 15, attestors: keysOf(ME, OTHER), threshold: 2 });
  const notMine = market({ version: 16, attestors: keysOf(OTHER) });
  const otherGame = market({ name: 'eth-updown-15m', version: 1 });
  const lying = { ...market({ version: 17 }), id: 'ab'.repeat(32) };
  const replay = { id: 'cd'.repeat(32), name: 'nextblock', manifest: 'zz' };
  const got = marketsToAttest({ games: [v1, v14, v15, notMine, otherGame, lying, replay], name: 'btc-updown-15m', key: toHex(ME.pubkey), ids: [v1.id] });
  assert.deepEqual([...got].sort(), [v1.id, v14.id, v15.id].sort());
  // a scalar attestor (--mode value) takes none of these outcome markets; an id given is always kept
  assert.deepEqual([...marketsToAttest({ games: [v14], name: 'btc-updown-15m', key: toHex(ME.pubkey), mode: 'value', ids: ['EE'.repeat(32)] })], ['ee'.repeat(32)]);
});

test('the daemon, told only of version 1, attests a round of version 14 the seat hosts and posts its outcome to the seat', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attestor-versions-'));
  const v1 = market({ version: 1 }), v14 = market({ version: 14 });
  const now = BigInt(Date.now());
  const closeMs = now - 20000n;                       // its window ended 20 s ago
  const startMs = closeMs - 900000n;
  // readings every 10 s from 2 min before the window to its end: 6,000,000 cents at the start, 6,100,000 at the end - Up
  const samples = [];
  for (let t = startMs - 120000n; t <= closeMs; t += 10000n) samples.push({ atMs: String(t), price: String(t < closeMs - 120000n ? 6000000 : 6100000), big: true });
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), JSON.stringify(samples));
  const ROUND = 'a1'.repeat(32);
  const posts = [];
  const seat = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/games') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ games: [v1, v14] })); }
    if (url.pathname === '/rounds') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ rounds: [{ id: ROUND, game: { id: v14.id, name: 'btc-updown-15m' }, entryCloseMs: String(closeMs) }] }));
    }
    if (url.pathname === '/outcome' && req.method === 'POST') {
      const parts = []; req.on('data', (c) => parts.push(c));
      return req.on('end', () => { posts.push({ round: url.searchParams.get('round'), bytes: Buffer.concat(parts) }); res.writeHead(201); res.end('held'); });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => seat.listen(0, '127.0.0.1', r));
  const SEAT = `http://127.0.0.1:${seat.address().port}`;
  const child = spawn(process.execPath, [new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m', '--game-id', v1.id,
    '--seats', SEAT, '--attestors', toHex(ME.pubkey), '--threshold', '1', '--port', '0', '--samples-file', join(dir, 'samples'), '--log', join(dir, 'log.jsonl')],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  try {
    for (let i = 0; i < 200 && !posts.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(posts.length >= 1, true, `no outcome posted; the daemon said:\n${lines.join('\n')}`);
    assert.equal(posts[0].round, ROUND);
    const att = decodeAttestation(new Uint8Array(posts[0].bytes));
    assert.deepEqual([toHex(att.roundId), att.outcome, att.signatures.length], [ROUND, 0, 1]);
    assert.equal(lines.some((l) => /"step":"markets"/.test(l) && l.includes(v14.id)), true);
  } finally {
    child.kill();
    seat.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
