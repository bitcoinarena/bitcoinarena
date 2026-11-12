// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 / #1705 (refute of fix:attest:3): the attestor daemon takes a round's close from the round's own contract, never
// from one seat's unsigned listing. Seat 1 (listed first) names a shifted close for ever and answers a forged contract with that
// close; seat 2 serves the real contract. The daemon signs ONLY the round's real window - never the shifted one - and the seat's
// door takes it. And attestor.js roundCloseOf believes only bytes that hash to the round id, on the market's grid.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { attestorKey, roundCloseOf } from '../src/attestor.js';
import { encodeManifest, manifestBodyId, gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { decodeAttestation, attestationTimely } from '../../arena-protocol/src/attested.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DEV = generateKeyPairSync('ed25519').privateKey;
const SEED = b32(0x42);
const ME = attestorKey(SEED);
const P = 900000n;
const TERMS = { resolveAfterCloseMs: 0n, deadlineAfterResolveMs: 3600000n };   // the grid close may be up to 1300 s ago
const contractOf = (gameId, closeMs) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId, simCoreHash: b32(1),
  startTimeMs: closeMs - P, entryCloseMs: closeMs, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: closeMs - P - 600000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4), b32(7), b32(9)],
});

test('wf1489-v1-refute-15-s1-2: roundCloseOf believes only the round\'s own bytes, on the market\'s grid', () => {
  const g = b32(0x67);
  const real = encodeRoundContract(contractOf(g, 1788300000000n));
  const id = toHex(roundId(contractOf(g, 1788300000000n)));
  assert.deepEqual(roundCloseOf({ id, contract: real, periodMs: P }), { ok: true, closeMs: 1788300000000n, gameId: toHex(g) });
  const forged = encodeRoundContract(contractOf(g, 1788300000000n + P));
  assert.equal(roundCloseOf({ id, contract: forged }).ok, false, 'a contract with another close is another round');
  assert.equal(roundCloseOf({ id, contract: real, marketIds: new Set([toHex(b32(0x68))]) }).ok, false, 'a round of another game');
  const off = contractOf(g, 1788300000000n + 1000n);
  assert.equal(roundCloseOf({ id: toHex(roundId(off)), contract: encodeRoundContract(off), periodMs: P }).ok, false, 'a close off the grid');
  assert.equal(roundCloseOf({ id, contract: new Uint8Array([1, 2, 3]) }).ok, false, 'bytes that do not read');
});

test('wf1489-v1-refute-15-s1-2: a seat that lists a shifted close for ever cannot make the daemon sign another window', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-refute-15-s1-2-'));
  const body = { gameName: 'btc-updown-15m', gameDevPubkey: b32(0xde), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
    cores: [], runTicksMax: 0, roundPeriodMs: P, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
    clients: [], gameDonationSetId: b32(0xd0), outcomes: ['Up', 'Down'], attestors: [ME.pubkey], attestThreshold: 1 };
  const m = { ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), DEV)) };
  const gid = gameIdOf(m);
  const game = { id: toHex(gid), name: 'btc-updown-15m', manifest: toHex(encodeManifest(m)) };
  const now = BigInt(Date.now());
  const CLOSE = ((now - 400000n) / P) * P;     // on the grid, its window ended at least 400 s ago
  const SHIFT = P;                             // seat 1 lists the next grid close (still on the grid)
  const samples = [];
  for (let t = CLOSE - P - 120000n; t <= now; t += 10000n) samples.push({ atMs: String(t), price: String(t < CLOSE + 60000n ? 6000000 : 5900000), big: true });
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), JSON.stringify(samples));
  const real = contractOf(gid, CLOSE);
  const ROUND = toHex(roundId(real));
  const posts = [];
  const seatOf = (lies) => http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/games') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ games: [game] })); }
    if (url.pathname === '/rounds') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ rounds: [{ id: ROUND, game: { id: game.id, name: 'btc-updown-15m' }, entryCloseMs: String(lies ? CLOSE + SHIFT : CLOSE) }] }));
    }
    if (url.pathname === '/round') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(Buffer.from(encodeRoundContract(lies ? contractOf(gid, CLOSE + SHIFT) : real)));
    }
    if (url.pathname === '/outcome' && req.method === 'POST') {
      const parts = []; req.on('data', (c) => parts.push(c));
      return req.on('end', () => {
        const att = decodeAttestation(new Uint8Array(Buffer.concat(parts)));
        const t = attestationTimely(att, { entryCloseMs: CLOSE, nowMs: BigInt(Date.now()), terms: TERMS, window: { startMs: CLOSE - P, endMs: CLOSE } });
        posts.push({ seat: lies ? 1 : 2, observedAtMs: att.observedAtMs, outcome: att.outcome, taken: t.ok, why: t.why });
        res.writeHead(t.ok ? 201 : 409); res.end(t.ok ? 'held' : t.why);
      });
    }
    res.writeHead(404); res.end();
  });
  const s1 = seatOf(true), s2 = seatOf(false);
  await Promise.all([s1, s2].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const SEATS = [s1, s2].map((s) => `http://127.0.0.1:${s.address().port}`).join(',');
  const child = spawn(process.execPath, [new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m', '--game-id', game.id,
    '--seats', SEATS, '--attestors', toHex(ME.pubkey), '--threshold', '1', '--port', '0', '--samples-file', join(dir, 'samples'), '--log', join(dir, 'log.jsonl')],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  try {
    for (let i = 0; i < 300 && posts.filter((p) => p.taken).length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    console.log('  wf1489-v1-refute-15-s1-2:', JSON.stringify({ posts: posts.map((p) => ({ ...p, observedAtMs: String(p.observedAtMs) })), signed: lines.filter((l) => /"step":"(signed|signs again|contract not believed)"/.test(l)) }));
    assert.ok(posts.length >= 1, `the daemon posted nothing:\n${lines.join('\n')}`);
    assert.equal(posts.every((p) => p.observedAtMs === CLOSE), true, 'every word the daemon posted is the round\'s own window, never the shifted one');
    assert.equal(posts.filter((p) => p.taken).length, 2, 'both seats take the round\'s real outcome');
    assert.equal(posts[0].outcome, 0, 'flat through the real window: Up');
  } finally {
    child.kill();
    s1.close(); s2.close();
  }
});
