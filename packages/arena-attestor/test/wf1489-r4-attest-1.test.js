// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit round 4 (attestations / markets): THE ATTESTOR DAEMON'S ROUNDS COME FROM ONE SEAT, TAKEN WHOLE.
// bin/arena-attestor.mjs roundsOfGame() asks the --seats in turn and RETURNS THE FIRST 200 answer: that one seat alone says which
// rounds exist. (a) A seat answering `{ rounds: [] }` hides every round the other seats hold - the attestor signs nothing, no
// attestation forms, and every market round of it goes VOID at its deadline. (b) The rows are not bounded (the daemon asks
// `?next=16` and takes any number back): every listed id gets a word kept in `words` forever (never pruned), and a peer pull each
// tick - a seat listing thousands of made-up ids grows the daemon's memory without end and starves the real rounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { attestorKey } from '../src/attestor.js';
import { encodeManifest, manifestBodyId, gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DEV = generateKeyPairSync('ed25519').privateKey;
const SEED = b32(0x41);
const ME = attestorKey(SEED);
const market = () => {
  const body = {
    gameName: 'btc-updown-15m', gameDevPubkey: b32(0xde), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
    cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
    clients: [], gameDonationSetId: b32(0xd0), outcomes: ['Up', 'Down'], attestors: [ME.pubkey], attestThreshold: 1,
  };
  const m = { ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), DEV)) };
  return { id: toHex(gameIdOf(m)), name: 'btc-updown-15m', manifest: toHex(encodeManifest(m)) };
};
const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const json = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

function setup(tag) {
  const dir = mkdtempSync(join(tmpdir(), `wf1489-r4-attest-3-${tag}-`));
  const closeMs = BigInt(Date.now()) - 20000n;
  const samples = [];
  for (let t = closeMs - 900000n - 120000n; t <= closeMs; t += 10000n) samples.push({ atMs: String(t), price: String(t < closeMs - 120000n ? 6000000 : 6100000), big: true });
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), JSON.stringify(samples));
  return { dir, closeMs };
}
const daemon = (dir, seats, port) => {
  const child = spawn(process.execPath, [new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m',
    '--seats', seats.join(','), '--attestors', toHex(ME.pubkey), '--threshold', '1', '--port', String(port),
    '--samples-file', join(dir, 'samples'), '--markets-every-ms', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  return { child, lines };
};

test('one seat answering an empty round list does not hide the round the other seat holds: it is attested and posted', { timeout: 60000 }, async () => {
  const { dir, closeMs } = setup('empty');
  const v1 = market();
  const ROUND = 'c1'.repeat(32);
  const posts = [];
  // THE ATTACKER'S SEAT, first on the attestor's list: it hosts the market and lists no round
  const liar = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/games') return json(res, { games: [v1] });
    if (url.pathname === '/rounds') return json(res, { rounds: [] });
    res.writeHead(404); res.end();
  });
  const honest = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/games') return json(res, { games: [v1] });
    if (url.pathname === '/rounds') return json(res, { rounds: [{ id: ROUND, game: { id: v1.id, name: 'btc-updown-15m' }, entryCloseMs: String(closeMs) }] });
    if (url.pathname === '/outcome' && req.method === 'POST') { req.resume(); return req.on('end', () => { posts.push(url.searchParams.get('round')); res.writeHead(201); res.end('held'); }); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => liar.listen(0, '127.0.0.1', r));
  await new Promise((r) => honest.listen(0, '127.0.0.1', r));
  const { child, lines } = daemon(dir, [`http://127.0.0.1:${liar.address().port}`, `http://127.0.0.1:${honest.address().port}`], await freePort());
  try {
    for (let i = 0; i < 150 && !posts.length; i++) await new Promise((r) => setTimeout(r, 100));
    console.log('  posts:', JSON.stringify(posts), 'signed:', lines.filter((l) => /"step":"signed"/.test(l)).length);
    // SAFE: the round the honest seat holds is attested and posted to it, whatever the first seat lists
    assert.ok(posts.includes(ROUND), `the attestor never attested round ${ROUND.slice(0, 16)}: the first seat's empty list hid it. The daemon said:\n${lines.slice(-5).join('\n')}`);
  } finally { child.kill(); liar.close(); honest.close(); }
});

test('one seat listing 5,000 made-up rounds does not make the attestor keep 5,000 words', { timeout: 60000 }, async () => {
  const { dir, closeMs } = setup('flood');
  const v1 = market();
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i.toString(16).padStart(64, '0'), game: { id: v1.id, name: 'btc-updown-15m' }, entryCloseMs: String(closeMs) }));
  const seat = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/games') return json(res, { games: [v1] });
    if (url.pathname === '/rounds') return json(res, { rounds: rows });
    if (url.pathname === '/outcome' && req.method === 'POST') { req.resume(); return req.on('end', () => { res.writeHead(404); res.end('this node holds no such round'); }); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => seat.listen(0, '127.0.0.1', r));
  const port = await freePort();
  const { child, lines } = daemon(dir, [`http://127.0.0.1:${seat.address().port}`], port);
  let words = 0;
  try {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { words = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()).words; } catch { /* not up yet */ }
      if (words >= 1000) break;
    }
    console.log('  words kept:', words, 'signed lines:', lines.filter((l) => /"step":"signed"/.test(l)).length);
    // SAFE: the daemon asked for the next 16 of each series; it keeps no more than a bounded number of words from one listing
    assert.ok(words < 1000, `one seat's listing of 5,000 made-up rounds made the attestor sign and keep ${words} words`);
  } finally { child.kill(); seat.close(); }
});
