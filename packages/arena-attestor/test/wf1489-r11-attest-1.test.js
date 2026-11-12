// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit round 11 (attestations / markets): THE ATTESTOR DAEMON READS EVERY SEAT'S ANSWER WHOLE.
// bin/arena-attestor.mjs roundsOfGame() reads each --seats GET /rounds with `await r.json()` - no byte cap - every 5 s tick, and
// readMarkets() reads GET /games the same way (the node's own peer reads have been capped since #1540 / #1829; this daemon's not).
// One seat of the attestor's list answers a body of millions of `{}` rows: the daemon buffers it, decodes it into one string and
// JSON.parse builds every row before the 64-row cut, its heap runs out and the process dies on every tick. With every attestor
// reading every seat, one seat stops all attestations: every Up/Down round goes VOID at its deadline.
// The daemon is run with a 192 MB heap so the test needs a ~100 MB answer; a live daemon (default heap) dies the same way on a
// larger body, which one seat can send every 5 s.
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
const SEED = b32(0x43);
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

test('one seat answering GET /rounds with a huge body does not kill the attestor: the honest seat\'s round is attested and posted', { timeout: 110000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r11-attest-1-'));
  const closeMs = BigInt(Date.now()) - 20000n;
  const samples = [];
  for (let t = closeMs - 900000n - 120000n; t <= closeMs; t += 10000n) samples.push({ atMs: String(t), price: String(t < closeMs - 120000n ? 6000000 : 6100000), big: true });
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), JSON.stringify(samples));
  const v1 = market();
  const ROUND = 'c3'.repeat(32);
  const posts = [];
  // THE ATTACKER'S SEAT: it hosts the market and answers /rounds with ~100 MB of empty rows, streamed
  const CHUNK = Buffer.from('{},'.repeat(1 << 20));            // 3 MiB, a million rows
  const liar = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/games') return json(res, { games: [v1] });
    if (url.pathname === '/rounds') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"rounds":[');
      let n = 0;
      const more = () => { while (n < 34) { n++; if (!res.write(CHUNK)) return res.once('drain', more); } res.end('{}]}'); };
      return more();
    }
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
  const port = await freePort();
  const child = spawn(process.execPath, ['--max-old-space-size=192', new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m',
    '--seats', [`http://127.0.0.1:${liar.address().port}`, `http://127.0.0.1:${honest.address().port}`].join(','),
    '--attestors', toHex(ME.pubkey), '--threshold', '1', '--port', String(port),
    '--samples-file', join(dir, 'samples'), '--markets-every-ms', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; let errs = '';
  child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  child.stderr.on('data', (d) => { errs += String(d); });
  let exited = null; child.on('exit', (code, sig) => { exited = { code, sig }; });
  try {
    for (let i = 0; i < 900 && !posts.length && !exited; i++) await new Promise((r) => setTimeout(r, 100));
    console.log('  posts:', JSON.stringify(posts), 'exited:', JSON.stringify(exited), 'stderr:', errs.split('\n').filter((l) => /heap|FATAL|memory/i.test(l)).slice(0, 3).join(' | '));
    // SAFE: one seat's oversized answer is refused unread past a bound; the daemon stays up and attests the round the honest seat holds
    assert.equal(exited, null, `the attestor died on one seat's oversized GET /rounds answer: ${JSON.stringify(exited)} ${errs.split('\n').filter((l) => /heap|FATAL/i.test(l)).slice(0, 2).join(' | ')}`);
    assert.ok(posts.includes(ROUND), `the attestor never attested round ${ROUND.slice(0, 16)} the honest seat holds. The daemon said:\n${lines.slice(-5).join('\n')}`);
  } finally { child.kill(); liar.close(); honest.close(); }
});
