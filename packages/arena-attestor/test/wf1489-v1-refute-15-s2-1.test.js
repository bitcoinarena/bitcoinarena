// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 (skeptic 2 of fix:attest:3 / 3285179cc): the daemon now reads EVERY seat's listing and, for every listed round whose
// close is past, asks the seats for its contract one round after another inside one tick (8 s timeout each, again every 30 s). One
// seat - not the first, any of them - lists fake round ids of this market with old closes and never answers GET /round for them.
// Each fake costs the tick 8 s, and the tick is single (ticking guard, `now` taken at its start): the real round's word is signed
// only a whole stall later. 450 fakes are an hour - past `window.endMs + 3600000n` the word is never signed and the round goes
// VOID, a refund the seat turns on after watching the price. The honest round must be posted within seconds of its window's end.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { attestorKey } from '../src/attestor.js';
import { encodeManifest, manifestBodyId, gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { decodeAttestation } from '../../arena-protocol/src/attested.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DEV = generateKeyPairSync('ed25519').privateKey;
const SEED = b32(0x42);
const ME = attestorKey(SEED);
const P = 60000n;
const contractOf = (gameId, closeMs) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId, simCoreHash: b32(1),
  startTimeMs: closeMs - P, entryCloseMs: closeMs, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: closeMs - P - 600000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4), b32(7), b32(9)],
});

const run = async (fakes) => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-refute-15-s2-1-'));
  const body = { gameName: 'btc-updown-15m', gameDevPubkey: b32(0xde), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
    cores: [], runTicksMax: 0, roundPeriodMs: P, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
    clients: [], gameDonationSetId: b32(0xd0), outcomes: ['Up', 'Down'], attestors: [ME.pubkey], attestThreshold: 1 };
  const m = { ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), DEV)) };
  const gid = gameIdOf(m);
  const game = { id: toHex(gid), name: 'btc-updown-15m', manifest: toHex(encodeManifest(m)) };
  const now = BigInt(Date.now());
  const CLOSE = ((now + 15000n + P - 1n) / P) * P;   // the next grid close at least 15 s ahead
  const samples = [];
  for (let t = CLOSE - P - 180000n; t <= CLOSE + 90000n; t += 2000n) samples.push({ atMs: String(t), price: '6000000', big: true });
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), JSON.stringify(samples));
  const real = contractOf(gid, CLOSE);
  const ROUND = toHex(roundId(real));
  const FAKES = Array.from({ length: fakes }, () => randomBytes(32).toString('hex'));
  const posts = [];
  const seatOf = (liar) => http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/games') return json({ games: [game] });
    if (url.pathname === '/rounds') {
      if (liar) return json({ rounds: FAKES.map((id) => ({ id, game: { id: game.id, name: 'btc-updown-15m' }, entryCloseMs: String(CLOSE - 10n * P) })) });
      return setTimeout(() => json({ rounds: [{ id: ROUND, game: { id: game.id, name: 'btc-updown-15m' }, entryCloseMs: String(CLOSE) }] }), 30);
    }
    if (url.pathname === '/round') {
      const id = url.searchParams.get('id');
      if (id === ROUND && !liar) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.from(encodeRoundContract(real))); }
      if (liar) return;                                  // never answers: the daemon waits its 8 s
      res.writeHead(404); return res.end('no such round');
    }
    if (url.pathname === '/outcome' && req.method === 'POST') {
      const parts = []; req.on('data', (c) => parts.push(c));
      return req.on('end', () => {
        const att = decodeAttestation(new Uint8Array(Buffer.concat(parts)));
        if (url.searchParams.get('round') === ROUND && !liar) posts.push({ atMs: Date.now(), observedAtMs: att.observedAtMs });
        res.writeHead(liar ? 404 : 201); res.end(liar ? 'no such round' : 'held');
      });
    }
    res.writeHead(404); res.end();
  });
  const honest = seatOf(false), liar = seatOf(true);
  await Promise.all([honest, liar].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const SEATS = [honest, liar].map((s) => `http://127.0.0.1:${s.address().port}`).join(',');   // the liar is NOT the first seat
  const child = spawn(process.execPath, [new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m', '--game-id', game.id,
    '--seats', SEATS, '--attestors', toHex(ME.pubkey), '--threshold', '1', '--port', '0', '--sample-ms', '2000',
    '--samples-file', join(dir, 'samples'), '--log', join(dir, 'log.jsonl')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  const DUE = Number(CLOSE) + 2000;
  try {
    while (Date.now() < DUE + 25000 && posts.length === 0) await new Promise((r) => setTimeout(r, 200));
    return { posts, DUE, CLOSE, lines };
  } finally {
    child.kill();
    for (const s of [honest, liar]) { s.closeAllConnections(); s.close(); }
  }
};

test('wf1489-v1-refute-15-s2-1 control: with no fakes the round is posted within seconds of its window end', { timeout: 120000 }, async () => {
  const { posts, DUE, CLOSE, lines } = await run(0);
  assert.ok(posts.length >= 1, `no post:\n${lines.slice(-20).join('\n')}`);
  assert.equal(posts[0].observedAtMs, CLOSE);
  console.log('  control: posted', posts[0].atMs - DUE, 'ms after due');
});

test('wf1489-v1-refute-15-s2-1: one seat listing fake rounds it never serves cannot hold the real round\'s word back', { timeout: 120000 }, async () => {
  const { posts, DUE, CLOSE, lines } = await run(8);
  console.log('  attack: due', new Date(DUE).toISOString(), 'posts', posts.map((p) => p.atMs - DUE), 'ms after due; steps:', JSON.stringify(lines.filter((l) => !/no reading/.test(l)).map((l) => { const j = JSON.parse(l); return `${j.at.slice(11, 19)} ${j.step} ${String(j.round || '').slice(0, 6)}`; })));
  assert.ok(posts.length >= 1, `the real round was not posted within 25 s of its due time (8 fake rows from one seat stall each tick ~64 s; 450 stall past the hour - VOID):\n${lines.slice(-8).join('\n')}`);
  assert.equal(posts[0].observedAtMs, CLOSE);
});
