// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2150): 1.9's attestor takes a listed close only while every listing seat agrees, and otherwise reads the
// round's own contract from a seat (GET /round, attestor.js roundCloseOf: the bytes must hash to the round id). The card's round id was
// made up (no contract could be served); here it is a real contract's id, which the honest seat serves and the liar does not.
// kanban #1489 refute of #1613 (audit44, 90d57151a): ONE LYING SEAT STILL HIDES AN HONEST ROUND FROM THE ATTESTOR.
// The fix reads every seat and joins the lists by round id, but "an id two seats list with different entry closes is dropped":
// a lying seat that lists the honest round's id with any other entryCloseMs makes roundsOfGame() drop it for every seat -
// no word, no attestation, no POST /outcome to the honest seats. The original effect (one seat hides the round) by another frame.
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
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

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
// a real round contract: 1.9's attestor settles a disagreement between seats' listings by the round's own bytes (GET /round, roundCloseOf)
const contractOf = (gameId, closeMs) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId, simCoreHash: b32(1),
  startTimeMs: closeMs - 900000n, entryCloseMs: closeMs, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: closeMs - 1500000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4), b32(7), b32(9)],
});
const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const json = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

function setup(tag) {
  const dir = mkdtempSync(join(tmpdir(), `wf1489-a44-refute-16-s1-${tag}-`));
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

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });

test('#2150 (1.9): a seat listing the honest round with another entry close does not hide it: it is attested and posted to the honest seat', { timeout: 60000 }, async () => {
  const { dir, closeMs } = setup('split');
  const v1 = market();
  const real = contractOf(fromHex(v1.id), closeMs);
  const ROUND = toHex(roundId(real));
  const posts = [];
  const liar = await serve((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/games') return json(res, { games: [v1] });
    // the same round id, its entry close one ms off
    if (url.pathname === '/rounds') return json(res, { rounds: [{ id: ROUND, game: { id: v1.id, name: 'btc-updown-15m' }, entryCloseMs: String(closeMs + 1n) }] });
    if (url.pathname === '/outcome' && req.method === 'POST') { req.resume(); return req.on('end', () => { res.writeHead(404); res.end('this node holds no such round'); }); }
    res.writeHead(404); res.end();
  });
  const honest = await serve((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/games') return json(res, { games: [v1] });
    if (url.pathname === '/rounds') return json(res, { rounds: [{ id: ROUND, game: { id: v1.id, name: 'btc-updown-15m' }, entryCloseMs: String(closeMs) }] });
    if (url.pathname === '/round') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.from(encodeRoundContract(real))); }
    if (url.pathname === '/outcome' && req.method === 'POST') { req.resume(); return req.on('end', () => { posts.push(url.searchParams.get('round')); res.writeHead(201); res.end('held'); }); }
    res.writeHead(404); res.end();
  });
  // the liar is LAST on --seats: its place in the list does not matter
  const { child, lines } = daemon(dir, [`http://127.0.0.1:${honest.address().port}`, `http://127.0.0.1:${liar.address().port}`], await freePort());
  try {
    for (let i = 0; i < 150 && !posts.length; i++) await new Promise((r) => setTimeout(r, 100));
    console.log('  posts:', JSON.stringify(posts), 'signed:', lines.filter((l) => /"step":"signed"/.test(l)).length);
    assert.ok(posts.includes(ROUND), `the attestor never attested round ${ROUND.slice(0, 16)}: one seat listing it with another entry close dropped it for every seat. The daemon said:\n${lines.slice(-5).join('\n')}`);
  } finally { child.kill(); liar.close(); honest.close(); }
});
